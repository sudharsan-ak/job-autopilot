import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("stdio MCP starts, exposes both tools, and serves isolated diagnostics", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "stage2-mcp-test-"));
  const root = path.resolve(process.cwd());
  const manifestPath = path.join(dataDir, "jobs.json");
  writeFileSync(manifestPath, JSON.stringify({ batch_date: "2026-10-17", jobs: [
    { classification: "APPLY", title: "Engineer", company: "Example", application_url: "https://example.com/apply", resume_path: "resume.pdf" },
  ] }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "src", "mcp", "server.js")],
    cwd: root,
    env: {
      ...process.env,
      STAGE2_ROOT: root,
      STAGE2_DATA_DIR: dataDir,
      STAGE2_PROFILE_PATH: path.join(root, "tests", "fixtures", "applicant_profile.json"),
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "stage2-test-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["batch_application_process", "batch_application_process_test"]);
    const result = await client.callTool({ name: "batch_application_process_test", arguments: { mode: "dry_run_fixture" } });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as { ok?: boolean } | undefined)?.ok, true);
    const databaseCheck = await client.callTool({ name: "batch_application_process_test", arguments: { mode: "database_check" } });
    assert.equal((databaseCheck.structuredContent as { ok?: boolean } | undefined)?.ok, true);
    const loaded = await client.callTool({ name: "batch_application_process", arguments: { mode: "load", batch_path: manifestPath } });
    assert.equal((loaded.structuredContent as { ok?: boolean } | undefined)?.ok, true);
    assert.equal((loaded.structuredContent as { browser_opened?: boolean } | undefined)?.browser_opened, false);
  } finally {
    await client.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
