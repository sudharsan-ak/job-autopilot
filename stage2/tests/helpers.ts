import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export function withTempDir<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), "stage2-test-"));
  let failed = false;
  try {
    return callback(directory);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (!failed) throw error;
    }
  }
}

export async function withTempDirAsync<T>(callback: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(tmpdir(), "stage2-test-"));
  let failed = false;
  try {
    return await callback(directory);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      if (!failed) throw error;
    }
  }
}
