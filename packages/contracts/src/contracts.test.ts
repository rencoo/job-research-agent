import { describe, expect, it } from "vitest";
import { HealthResponseSchema, JobEventSchema, JobSnapshotSchema } from "./index";

const now = "2026-09-05T00:00:00.000Z";

describe("shared contracts", () => {
  it("parses a healthy response", () => {
    const parsed = HealthResponseSchema.parse({
      status: "healthy",
      components: {
        api: { status: "healthy" },
        database: { status: "healthy" },
        worker: { status: "healthy" },
      },
    });
    expect(parsed.status).toBe("healthy");
  });

  it("accepts a valid job snapshot", () => {
    const parsed = JobSnapshotSchema.parse({
      id: "job-1",
      type: "test",
      status: "queued",
      progress: 0,
      attempts: 0,
      maxAttempts: 3,
      cancelRequested: false,
      resultRef: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    });
    expect(parsed.id).toBe("job-1");
  });

  it.each([
    [{ status: "paused" }, "invalid status"],
    [{ progress: 101 }, "invalid progress"],
  ])("rejects %s (%s)", (override, _description) => {
    expect(() =>
      JobSnapshotSchema.parse({
        id: "job-1",
        type: "test",
        status: "queued",
        progress: 0,
        attempts: 0,
        maxAttempts: 3,
        cancelRequested: false,
        resultRef: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        ...override,
      }),
    ).toThrow();
  });

  it("rejects a non-positive event sequence", () => {
    expect(() =>
      JobEventSchema.parse({
        schemaVersion: 1,
        jobId: "job-1",
        sequence: 0,
        occurredAt: now,
        type: "progress_updated",
        payload: { progress: 10 },
      }),
    ).toThrow();
  });
});
