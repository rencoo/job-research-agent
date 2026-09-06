import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobInvariantError } from "@job-research/domain";
import { openDatabase, type DatabaseConnection } from "./connection";
import { applyMigrations } from "./migrations";
import { JobRepository } from "./repository";

const start = new Date("2026-09-05T00:00:00.000Z");
let directory: string;
let connection: DatabaseConnection;
let repository: JobRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "job-research-repository-"));
  connection = openDatabase({ dataDirectory: directory });
  applyMigrations(connection.sqlite);
  repository = new JobRepository(connection.sqlite);
});

afterEach(() => {
  connection.close();
  rmSync(directory, { recursive: true, force: true });
});

const createJob = (id: string, maxAttempts = 3) =>
  repository.create({ id, type: "test", payload: { id }, now: start, maxAttempts });

describe("JobRepository", () => {
  it("allows only one claimant", () => {
    createJob("job-1");
    const first = repository.claimNext("worker-1", start, 1_000);
    const second = new JobRepository(connection.sqlite).claimNext(
      "worker-2",
      start,
      1_000,
    );
    expect(first).toMatchObject({ id: "job-1", leaseOwner: "worker-1", attempts: 1 });
    expect(second).toBeNull();
  });

  it("rejects a stale owner after recovery and reclaim", () => {
    createJob("job-1");
    repository.claimNext("worker-1", start, 100);
    const recoveredAt = new Date(start.getTime() + 101);
    expect(repository.recoverExpired(recoveredAt)).toEqual({ requeued: 1, failed: 0 });
    repository.claimNext("worker-2", recoveredAt, 1_000);
    expect(() => repository.complete("job-1", "worker-1", null, recoveredAt)).toThrow(
      JobInvariantError,
    );
  });

  it("persists ordered events and replays after a cursor", () => {
    createJob("job-1");
    repository.claimNext("worker-1", start, 1_000);
    repository.updateProgress("job-1", "worker-1", 25, start);
    repository.complete("job-1", "worker-1", "artifact-1", start);
    const events = repository.listEvents("job-1");
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(repository.listEvents("job-1", 2).map((event) => event.sequence)).toEqual([
      3, 4,
    ]);
  });

  it("keeps every attempt outcome across retries", () => {
    createJob("job-1");
    repository.claimNext("worker-1", start, 1_000);
    expect(
      repository.fail(
        "job-1",
        "worker-1",
        { code: "timeout", message: "temporary", retryable: true },
        start,
        10,
      ),
    ).toBe("queued");
    const retryAt = new Date(start.getTime() + 10);
    repository.claimNext("worker-2", retryAt, 1_000);
    repository.complete("job-1", "worker-2", null, retryAt);
    expect(repository.listAttempts("job-1").map((attempt) => attempt.outcome)).toEqual([
      "retrying",
      "succeeded",
    ]);
  });

  it("cancels queued jobs and leaves terminal jobs idempotent", () => {
    createJob("job-1");
    expect(repository.requestCancellation("job-1", start)?.status).toBe("cancelled");
    expect(repository.requestCancellation("job-1", start)?.status).toBe("cancelled");
    expect(repository.claimNext("worker-1", start, 1_000)).toBeNull();
  });
});
