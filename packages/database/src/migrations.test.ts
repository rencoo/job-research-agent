import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./connection";
import { applyMigrations } from "./migrations";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("creates an empty database and is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "job-research-migration-"));
    directories.push(directory);
    const connection = openDatabase({ dataDirectory: directory });
    try {
      expect(applyMigrations(connection.sqlite)).toEqual([
        "0001_initial.sql",
        "0002_text_screening.sql",
        "0003_model_provenance.sql",
        "0004_deep_research.sql",
      ]);
      expect(applyMigrations(connection.sqlite)).toEqual([]);
      const tables = connection.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "schema_migrations",
          "jobs",
          "job_attempts",
          "job_events",
          "user_profile",
          "profile_snapshots",
          "import_batches",
          "import_items",
          "opportunities",
          "job_drafts",
          "draft_conflicts",
          "job_snapshots",
          "research_runs",
          "stage_checkpoints",
          "run_events",
          "research_claims",
          "screening_reports",
          "idempotency_keys",
        ]),
      );
    } finally {
      connection.close();
    }
  });
});

it("backs up an existing database before adding migrations", () => {
  const directory = mkdtempSync(join(tmpdir(), "research-migration-backup-")); directories.push(directory);
  const legacy = join(directory, "legacy"); mkdirSync(legacy);
  copyFileSync(resolve(import.meta.dirname, "../migrations/0001_initial.sql"), join(legacy, "0001_initial.sql"));
  const connection = openDatabase({ dataDirectory: directory });
  try {
    applyMigrations(connection.sqlite, legacy); applyMigrations(connection.sqlite);
    const backups = readdirSync(join(directory, "backups")); expect(backups).toHaveLength(1);
    const backup = openDatabase({ dataDirectory: join(directory, "backups"), filename: backups[0]! });
    try { expect(backup.sqlite.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: "0001_initial.sql" }]); } finally { backup.close(); }
  } finally { connection.close(); }
});
