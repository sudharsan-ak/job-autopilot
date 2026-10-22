import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium, type Browser } from "playwright";
import { scanPage } from "../src/forms/pageScanner.js";
import { matchField } from "../src/forms/matcher.js";
import { executeAction } from "../src/forms/executor.js";
import { decideNavigation } from "../src/forms/navigationGuard.js";
import { enterApplicationForm } from "../src/browser/navigation.js";
import { valuesMatch } from "../src/forms/verifier.js";

let browser: Browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

test("scanner inventories common controls and executor verifies values", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <form>
      <label for="first">First name</label><input id="first" autocomplete="given-name" required>
      <label for="email">Email address</label><input id="email" type="email" autocomplete="email" required>
      <label for="state">State</label><select id="state"><option>Select</option><option>Texas</option></select>
      <fieldset><legend>Authorized to work?</legend>
        <label><input type="radio" name="auth" value="yes">Yes</label>
        <label><input type="radio" name="auth" value="no">No</label>
      </fieldset>
      <label><input id="updates" type="checkbox">Contact me about future roles</label>
      <button type="submit">Submit Application</button>
    </form>
  `);
  const fields = await scanPage(page);
  assert.equal(fields.length, 5);
  const first = fields.find((item) => item.id === "first")!;
  assert.equal(matchField(first).profileKey, "legal_first_name");
  assert.equal((await executeAction(page, first, { kind: "fill", value: "Test", profileKey: "legal_first_name" })).success, true);
  const state = fields.find((item) => item.id === "state")!;
  assert.equal((await executeAction(page, state, { kind: "select", value: "Texas", profileKey: "physical_state" })).success, true);
  const radio = fields.find((item) => item.controlType === "radio")!;
  assert.equal((await executeAction(page, radio, { kind: "select", value: "Yes", profileKey: "authorized_to_work_current" })).success, true);
  assert.equal((await decideNavigation(page)).kind, "FINAL_BOUNDARY");
  await page.close();
});

test("navigation guard distinguishes safe continue from deceptive submission", async () => {
  const page = await browser.newPage();
  await page.setContent(`<button type="button">Continue</button><button type="button" style="display:none">Submit</button>`);
  const decision = await decideNavigation(page);
  assert.equal(decision.kind, "ADVANCE");
  assert.match(decision.reason, /Continue/i);
  await page.setContent(`<button type="submit">Review and Submit</button><button type="button">Continue</button>`);
  assert.equal((await decideNavigation(page)).kind, "FINAL_BOUNDARY");
  await page.close();
});

test("React-style controlled input receives native input and change events", async () => {
  const page = await browser.newPage();
  await page.setContent(`<label for="city">City</label><input id="city"><output id="events">0</output><script>
    let count=0; const input=document.querySelector('#city');
    input.addEventListener('input',()=>document.querySelector('#events').textContent=String(++count));
  </script>`);
  const city = (await scanPage(page))[0]!;
  const result = await executeAction(page, city, { kind: "fill", value: "Dallas", profileKey: "physical_city" });
  assert.equal(result.success, true);
  assert.ok(Number(await page.locator("#events").textContent()) >= 1);
  await page.close();
});

test("executor detects a framework that asynchronously rejects a value", async () => {
  const page = await browser.newPage();
  await page.setContent(`<label for="city">City</label><input id="city"><script>
    const input=document.querySelector('#city');
    input.addEventListener('input',()=>setTimeout(()=>{ input.value=''; },40));
  </script>`);
  const city = (await scanPage(page))[0]!;
  const result = await executeAction(page, city, { kind: "fill", value: "Dallas", profileKey: "physical_city" });
  assert.equal(result.success, false);
  assert.equal(result.observed, "");
  await page.close();
});

test("scanner preserves field identity and discovers delayed conditional fields", async () => {
  const page = await browser.newPage();
  await page.setContent(`<div id="form"><label for="first">First name</label><input id="first"></div><script>
    const first=document.querySelector('#first');
    first.addEventListener('input',()=>setTimeout(()=>{
      if (!document.querySelector('#email')) document.querySelector('#form').insertAdjacentHTML('beforeend','<label for="email">Email</label><input id="email" type="email" required>');
    },40));
  </script>`);
  const firstScan = await scanPage(page);
  const first = firstScan[0]!;
  assert.equal((await executeAction(page, first, { kind: "fill", value: "Test", profileKey: "legal_first_name" })).success, true);
  await page.waitForTimeout(80);
  const secondScan = await scanPage(page);
  assert.equal(secondScan.find((item) => item.id === "first")?.fieldId, first.fieldId);
  assert.equal(secondScan.some((item) => item.id === "email" && item.required), true);
  await page.close();
});

test("open Shadow DOM fields and final actions are discoverable", async () => {
  const page = await browser.newPage();
  await page.setContent(`<div id="host"></div><script>
    document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<form><label for="email">Email address</label><input id="email" type="email" required><button type="submit">Submit Application</button></form>';
  </script>`);
  const fields = await scanPage(page);
  assert.equal(fields.length, 1);
  assert.equal(fields[0]?.label, "Email address");
  assert.equal((await executeAction(page, fields[0]!, { kind: "fill", value: "test@example.com", profileKey: "primary_email" })).success, true);
  assert.equal((await decideNavigation(page)).kind, "FINAL_BOUNDARY");
  await page.close();
});

test("same-URL iframes retain the correct frame identity", async () => {
  const page = await browser.newPage();
  await page.setContent(`
    <iframe srcdoc='<label for="value">First frame</label><input id="value">'></iframe>
    <iframe srcdoc='<label for="value">Second frame</label><input id="value">'></iframe>
  `);
  await page.waitForTimeout(100);
  const fields = await scanPage(page);
  const second = fields.find((field) => field.label === "Second frame")!;
  assert.equal((await executeAction(page, second, { kind: "fill", value: "second", profileKey: "fixture" })).success, true);
  assert.equal(await page.frames()[1]!.locator("#value").inputValue(), "");
  assert.equal(await page.frames()[2]!.locator("#value").inputValue(), "second");
  await page.close();
});

test("Review Application is treated as a final manual boundary", async () => {
  const page = await browser.newPage();
  await page.setContent(`<button type="button">Review Application</button>`);
  assert.equal((await decideNavigation(page)).kind, "FINAL_BOUNDARY");
  await page.close();
});

test("entry navigation clicks Apply when no application fields exist", async () => {
  const page = await browser.newPage();
  await page.setContent(`<button type="button" onclick="document.body.innerHTML='<form><label>First name<input required></label><label>Last name<input required></label><label>Email<input type=email required></label><button id=submit type=submit>Submit Application</button></form>'">Apply now</button>`);
  const result = await enterApplicationForm(page);
  assert.equal((await scanPage(result)).length, 3);
  assert.equal(await result.locator("#submit").isVisible(), true);
  await result.close();
});

test("entry navigation retains a form page and never clicks its Apply button", async () => {
  const page = await browser.newPage();
  await page.setContent(`<form><label>First name<input required></label><label>Last name<input required></label><label>Email<input type=email required></label><button id="apply" type="submit" onclick="window.clicked=true">Apply</button></form>`);
  const result = await enterApplicationForm(page);
  assert.equal(result, page);
  assert.equal(await page.evaluate(() => Boolean((window as Window & { clicked?: boolean }).clicked)), false);
  await page.close();
});

test("verification accepts site-formatted phone numbers", () => {
  assert.equal(valuesMatch("5551234567", "555-123-4567"), true);
});
