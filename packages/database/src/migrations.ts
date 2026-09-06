import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "better-sqlite3";

const defaultMigrationsDirectory = resolve(import.meta.dirname, "../migrations");

export function applyMigrations(
  sqlite: Database.Database,
  migrationsDirectory = defaultMigrationsDirectory,
): string[] {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = sqlite
    .prepare("SELECT version FROM schema_migrations")
    .all()
    .map((row) => (row as { version: string }).version);
  const appliedSet = new Set(applied);
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const newlyApplied: string[] = [];

  for (const version of migrationFiles) {
    if (appliedSet.has(version)) continue;
    const sql = readFileSync(resolve(migrationsDirectory, version), "utf8");
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite
        .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(version, Date.now());
    })();
    newlyApplied.push(version);
  }

  return newlyApplied;
}
