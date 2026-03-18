import fs from "fs";
import path from "path";
import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.compose"];
const DATA_DIR = path.join(process.cwd(), "data");
const TOKEN_PATH = path.join(DATA_DIR, "gmail-token.json");
const CREDENTIALS_PATH = path.join(DATA_DIR, "credentials.json");

type InstalledCredentials = {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
};

type CredentialsFile = {
  installed?: InstalledCredentials;
  web?: InstalledCredentials;
};

function readCredentialsFile(): CredentialsFile {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Missing credentials file at ${CREDENTIALS_PATH}`);
  }

  const raw = fs.readFileSync(CREDENTIALS_PATH, "utf8");
  return JSON.parse(raw) as CredentialsFile;
}

function getInstalledCredentials(credentials: CredentialsFile): InstalledCredentials {
  const installed = credentials.installed ?? credentials.web;
  if (!installed?.client_id || !installed.client_secret || !installed.redirect_uris?.length) {
    throw new Error("credentials.json is missing OAuth client fields.");
  }
  return installed;
}

async function loadSavedClient(): Promise<any | null> {
  if (!fs.existsSync(TOKEN_PATH)) {
    return null;
  }

  const raw = fs.readFileSync(TOKEN_PATH, "utf8");
  const token = JSON.parse(raw) as Record<string, string>;

  if (!token.client_id || !token.client_secret || !token.refresh_token) {
    return null;
  }

  return google.auth.fromJSON(token);
}

function deleteSavedToken() {
  if (fs.existsSync(TOKEN_PATH)) {
    fs.unlinkSync(TOKEN_PATH);
  }
}

async function saveClient(authClient: any) {
  const credentials = getInstalledCredentials(readCredentialsFile());
  const refreshToken = authClient.credentials.refresh_token;

  if (!refreshToken) {
    throw new Error("Google did not return a refresh token. Revoke access and retry consent if needed.");
  }

  const payload = {
    type: "authorized_user" as const,
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
    refresh_token: refreshToken
  };

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2), "utf8");
}

export async function authorizeGmail(): Promise<any> {
  const savedClient = await loadSavedClient();
  if (savedClient) {
    try {
      await savedClient.getAccessToken();
      return savedClient;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("invalid_grant")) {
        deleteSavedToken();
      } else {
        throw error;
      }
    }
  }

  const authClient = await authenticate({
    keyfilePath: CREDENTIALS_PATH,
    scopes: SCOPES
  });

  await saveClient(authClient);
  return authClient;
}

export function getGmailTokenPath() {
  return TOKEN_PATH;
}
