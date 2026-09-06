import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JobRepository,
  applyMigrations,
  openDatabase,
  type DatabaseConnection,
} from "@job-research/database";
import { HealthResponseSchema, JobSnapshotSchema } from "@job-research/contracts";
import { buildServer } from "./app";

let directory: string;
let connection: DatabaseConnection;
let repository: JobRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "job-research-server-"));
  connection = openDatabase({ dataDirectory: directory });
  applyMigrations(connection.sqlite);
  repository = new JobRepository(connection.sqlite);
});

afterEach(() => {
  connection.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("HTTP server", () => {
  it("reports healthy and degraded components", async () => {
    const healthy = buildServer({ repository });
    const healthyResponse = await healthy.inject({ method: "GET", url: "/api/health" });
    expect(HealthResponseSchema.parse(healthyResponse.json()).status).toBe("healthy");
    await healthy.close();

    const degraded = buildServer({ repository, workerHealth: () => false });
    const degradedResponse = await degraded.inject({ method: "GET", url: "/api/health" });
    expect(degradedResponse.statusCode).toBe(503);
    expect(HealthResponseSchema.parse(degradedResponse.json()).components.worker.status).toBe(
      "degraded",
    );
    await degraded.close();
  });

  it("returns existing and missing jobs", async () => {
    repository.create({ id: "job-1", type: "test", payload: {}, now: new Date() });
    const app = buildServer({ repository });
    const found = await app.inject({ method: "GET", url: "/api/jobs/job-1" });
    expect(JobSnapshotSchema.parse(found.json()).id).toBe("job-1");
    expect((await app.inject({ method: "GET", url: "/api/jobs/missing" })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it("cancels queued jobs and treats terminal cancellation as idempotent", async () => {
    repository.create({ id: "job-1", type: "test", payload: {}, now: new Date() });
    const app = buildServer({ repository });
    const first = await app.inject({ method: "POST", url: "/api/jobs/job-1/cancel" });
    expect(first.json()).toMatchObject({ status: "cancelled", outcome: "cancelled" });
    const second = await app.inject({ method: "POST", url: "/api/jobs/job-1/cancel" });
    expect(second.json()).toMatchObject({
      status: "cancelled",
      outcome: "already_terminal",
    });
    await app.close();
  });

  it("replays SSE after Last-Event-ID and closes for terminal jobs", async () => {
    const now = new Date();
    repository.create({ id: "job-1", type: "test", payload: {}, now });
    repository.claimNext("worker-1", now, 1_000);
    repository.updateProgress("job-1", "worker-1", 50, now);
    repository.complete("job-1", "worker-1", null, now);
    const app = buildServer({ repository });
    const response = await app.inject({
      method: "GET",
      url: "/api/jobs/job-1/events",
      headers: { "last-event-id": "2" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("id: 1\n");
    expect(response.body).not.toContain("id: 2\n");
    expect(response.body).toContain("id: 3\n");
    expect(response.body).toContain("id: 4\n");
    await app.close();
  });

  it("streams heartbeat and later live events in order", async () => {
    const now = new Date();
    repository.create({ id: "job-1", type: "test", payload: {}, now });
    repository.claimNext("worker-1", now, 5_000);
    const app = buildServer({ repository, ssePollMs: 5, sseHeartbeatMs: 10 });
    const responsePromise = app.inject({ method: "GET", url: "/api/jobs/job-1/events?after=2" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = new Date();
    repository.updateProgress("job-1", "worker-1", 75, later);
    repository.complete("job-1", "worker-1", null, later);
    const response = await responsePromise;
    expect(response.body).toContain(": heartbeat");
    expect(response.body.indexOf("id: 3\n")).toBeLessThan(
      response.body.indexOf("id: 4\n"),
    );
    await app.close();
  });
});
