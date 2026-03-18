import { google } from "googleapis";
import { authorizeGmail, getGmailTokenPath } from "../utils/gmailAuth";

async function main() {
  const auth = await authorizeGmail();
  const token = await auth.getAccessToken();
  if (!token?.token) {
    throw new Error("Gmail auth succeeded but no access token was returned.");
  }

  console.log("Gmail auth complete.");
  console.log(`Saved token to: ${getGmailTokenPath()}`);
  console.log("Scope granted: gmail.compose");
}

main().catch((error) => {
  console.error("Gmail auth failed:", error);
  process.exit(1);
});
