import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.js";

export class Stage2Database {
  readonly path: string;
  readonly connection: DatabaseSync;

  constructor(dataDir: string, options: { readOnly?: boolean } = {}) {
    mkdirSync(dataDir, { recursive: true });
    this.path = path.join(dataDir, "stage2.db");
    this.connection = new DatabaseSync(this.path, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
    });
    if (!options.readOnly) runMigrations(this.connection);
  }

  close(): void {
    this.connection.close();
  }
}
