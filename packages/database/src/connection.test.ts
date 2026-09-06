import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, resolveDataDirectory } from "./connection";

const directories: string[] = [];
const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "job-research-db-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database connection", () => {
  it("honors an explicit data directory", () => {
    const directory = temporaryDirectory();
    expect(resolveDataDirectory({ JRA_DATA_DIR: directory })).toBe(resolve(directory));
  });

  it("enables required SQLite pragmas", () => {
    const connection = openDatabase({ dataDirectory: temporaryDirectory() });
    try {
      expect(connection.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(connection.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(connection.sqlite.pragma("busy_timeout", { simple: true })).toBe(5_000);
    } finally {
      connection.close();
    }
  });
});
