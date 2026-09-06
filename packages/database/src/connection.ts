import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageDirectory, "../../..");

export interface DatabaseConnection {
  path: string;
  sqlite: Database.Database;
  orm: ReturnType<typeof drizzle<typeof schema>>;
  close(): void;
}

export function resolveDataDirectory(environment = process.env): string {
  const configured = environment.JRA_DATA_DIR?.trim();
  return configured ? resolve(configured) : resolve(repositoryRoot, ".data");
}

export function openDatabase(
  options: { dataDirectory?: string; filename?: string } = {},
): DatabaseConnection {
  const dataDirectory = options.dataDirectory ?? resolveDataDirectory();
  const filename = options.filename ?? "job-research-agent.sqlite";
  const path = filename === ":memory:" ? filename : resolve(dataDirectory, filename);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  return {
    path,
    sqlite,
    orm: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}
