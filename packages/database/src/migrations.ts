import { readdirSync, readFileSync, mkdirSync, unlinkSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
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
  if (applied.length && migrationFiles.some(file => !appliedSet.has(file)) && sqlite.name !== ":memory:") {
    const backupDir = resolve(dirname(sqlite.name), "backups"); mkdirSync(backupDir, { recursive: true });
    const prefix = `${basename(sqlite.name)}.`;
    const backupPath = resolve(backupDir, `${prefix}${Date.now()}.sqlite`);
    sqlite.prepare("VACUUM INTO ?").run(backupPath);
    const backups = readdirSync(backupDir).filter(file => file.startsWith(prefix) && file.endsWith(".sqlite")).sort().reverse();
    for (const file of backups.slice(5)) unlinkSync(resolve(backupDir, file));
  }


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
