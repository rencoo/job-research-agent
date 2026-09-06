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
import type { Clock } from "@job-research/domain";
import { FakeModel } from "@job-research/model-gateway";
import {
  HandlerRegistry,
  LocalJobWorker,
  WorkerExecutionError,
} from "./worker";

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const startedAt = new Date("2026-09-05T00:00:00.000Z");
let directory: string;
let connection: DatabaseConnection;
let repository: JobRepository;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "job-research-worker-"));
  connection = openDatabase({ dataDirectory: directory });
  applyMigrations(connection.sqlite);
  repository = new JobRepository(connection.sqlite);
});

afterEach(() => {
  connection.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("LocalJobWorker", () => {
  it("renews a short lease while a long handler runs", async () => {
    const now = new Date();
    repository.create({ id: "job-1", type: "slow", payload: {}, now });
    const registry = new HandlerRegistry().register("slow", async () => {
      await wait(120);
      return {};
    });
    const worker = new LocalJobWorker({
      repository,
      registry,
      workerId: "worker-1",
      leaseMs: 60,
    });
    const running = worker.runOnce();
    await wait(80);
    expect(
      new JobRepository(connection.sqlite).claimNext("worker-2", new Date(), 60),
    ).toBeNull();
    await running;
    expect(repository.get("job-1")?.status).toBe("succeeded");
  });

  it("retries retryable failures with backoff and stops at the limit", async () => {
    const clock = new FakeClock(startedAt);
    repository.create({
      id: "job-1",
      type: "fails",
      payload: {},
      now: clock.now(),
      maxAttempts: 3,
    });
    const registry = new HandlerRegistry().register("fails", async () => {
      throw new WorkerExecutionError("temporary", "try later", true);
    });
    const worker = new LocalJobWorker({
      repository,
      registry,
      clock,
      retryBaseDelayMs: 10,
      leaseMs: 1_000,
    });

    await worker.runOnce();
    expect(repository.get("job-1")?.status).toBe("queued");
    expect(await worker.runOnce()).toBe(false);
    clock.advance(10);
    await worker.runOnce();
    clock.advance(20);
    await worker.runOnce();
    expect(repository.get("job-1")).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails non-retryable errors immediately", async () => {
    const clock = new FakeClock(startedAt);
    repository.create({ id: "job-1", type: "invalid", payload: {}, now: clock.now() });
    const registry = new HandlerRegistry().register("invalid", async () => {
      throw new WorkerExecutionError("invalid_input", "bad input", false);
    });
    const worker = new LocalJobWorker({ repository, registry, clock });
    await worker.runOnce();
    expect(repository.get("job-1")).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("aborts a running FakeModel at a cancellation checkpoint", async () => {
    const now = new Date();
    repository.create({ id: "job-1", type: "model", payload: {}, now });
    const model = new FakeModel({ type: "success", value: { ok: true }, delayMs: 1_000 });
    const registry = new HandlerRegistry().register("model", async ({ signal }) => {
      await model.generateStructured({
        prompt: "work",
        signal,
        validate: (value) => value as { ok: boolean },
      });
      return {};
    });
    const worker = new LocalJobWorker({ repository, registry, leaseMs: 60 });
    const running = worker.runOnce();
    await wait(20);
    repository.requestCancellation("job-1", new Date());
    await running;
    expect(repository.get("job-1")?.status).toBe("cancelled");
  });

  it("recovers interrupted work and fails exhausted work", () => {
    repository.create({ id: "retry", type: "test", payload: {}, now: startedAt });
    repository.create({
      id: "exhausted",
      type: "test",
      payload: {},
      now: startedAt,
      maxAttempts: 1,
    });
    repository.claimNext("dead-1", startedAt, 10);
    repository.claimNext("dead-2", startedAt, 10);
    const clock = new FakeClock(new Date(startedAt.getTime() + 11));
    const worker = new LocalJobWorker({
      repository,
      registry: new HandlerRegistry(),
      clock,
    });
    expect(worker.recoverStaleJobs()).toEqual({ requeued: 1, failed: 1 });
    expect(repository.get("retry")?.status).toBe("queued");
    expect(repository.get("exhausted")?.status).toBe("failed");
  });

  it("stops without claiming newly queued work", async () => {
    const registry = new HandlerRegistry().register("test", async () => ({}));
    const worker = new LocalJobWorker({
      repository,
      registry,
      pollIntervalMs: 5,
    });
    worker.start();
    await worker.stop();
    repository.create({ id: "job-1", type: "test", payload: {}, now: new Date() });
    await wait(20);
    expect(repository.get("job-1")?.status).toBe("queued");
  });
});
