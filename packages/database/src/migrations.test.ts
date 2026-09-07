import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
