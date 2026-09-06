import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, BusinessRepository, JobRepository, openDatabase, type DatabaseConnection } from "@job-research/database";
import { LocalDemoModel } from "@job-research/model-gateway";
import { buildServer } from "./app";
import { HandlerRegistry, LocalJobWorker } from "./worker";
import { createExtractionHandler, createScreeningHandler, LocalIngestionApplication, LocalOpportunityApplication, LocalProfileApplication, LocalResearchApplication } from "./business-app";

let directory: string; let connection: DatabaseConnection; let app: ReturnType<typeof buildServer>; let worker: LocalJobWorker;
const now = new Date("2026-09-05T00:00:00.000Z");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "business-api-")); connection = openDatabase({ dataDirectory: directory }); applyMigrations(connection.sqlite);
  const repository = new JobRepository(connection.sqlite); const businessRepository = new BusinessRepository(connection.sqlite); const model = new LocalDemoModel();
  const profile = new LocalProfileApplication(businessRepository, () => now); const ingestion = new LocalIngestionApplication(businessRepository, repository, () => now);
  const opportunities = new LocalOpportunityApplication(businessRepository, () => now); const research = new LocalResearchApplication(businessRepository, repository, () => now);
  worker = new LocalJobWorker({ repository, clock: { now: () => now }, workerId: "api-test", leaseMs: 1000, registry: new HandlerRegistry().register("extract-job-draft", createExtractionHandler(businessRepository, model, () => now)).register("screen-opportunity", createScreeningHandler(businessRepository, model, () => now)) });
  app = buildServer({ repository, business: { repository: businessRepository, profile, ingestion, opportunities, research }, ssePollMs: 1 });
});
afterEach(async () => { await app.close(); try { connection.close(); } catch { /* already closed by an availability test */ } rmSync(directory, { recursive: true, force: true }); });

const profileBody = { resumeText: "TypeScript Agent ownership", targetRoles: ["AI Engineer"], constraints: [], redFlags: [], weights: {}, expectedVersion: null };

describe("business HTTP API", () => {
  it("maps profile validation and version conflicts", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/profile", payload: { resumeText: "", targetRoles: [] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/profile", payload: profileBody })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/api/profile", payload: { ...profileBody, expectedVersion: 0 } })).statusCode).toBe(409);
  });

  it("enforces import limits, marks URL-only items, and returns 422 for incomplete confirm", async () => {
    expect((await app.inject({ method: "POST", url: "/api/import-batches", headers: { "idempotency-key": "too-many" }, payload: { items: Array.from({ length: 21 }, () => ({ text: "JD" })) } })).statusCode).toBe(400);
    const imported = await app.inject({ method: "POST", url: "/api/import-batches", headers: { "idempotency-key": "url" }, payload: { items: [{ text: "https://example.com/job" }] } });
    const batchId = imported.json().resourceId; const batch = await app.inject({ method: "GET", url: `/api/import-batches/${batchId}` });
    expect(batch.json().items[0].status).toBe("needs_input");
    const opportunityId = batch.json().items[0].opportunityId;
    expect((await app.inject({ method: "POST", url: `/api/opportunities/${opportunityId}/draft/confirm`, payload: { expectedVersion: 1 } })).statusCode).toBe(422);
  });

  it("runs the full API flow and replays sanitized Run SSE events", async () => {
    await app.inject({ method: "PUT", url: "/api/profile", payload: profileBody });
    const imported = await app.inject({ method: "POST", url: "/api/import-batches", headers: { "idempotency-key": "flow" }, payload: { items: [{ text: "职位：AI Engineer\n公司：Demo\n职责：TypeScript Agent ownership\n要求：TypeScript" }] } });
    const batchId = imported.json().resourceId; const batch = (await app.inject({ method: "GET", url: `/api/import-batches/${batchId}` })).json(); const opportunityId = batch.items[0].opportunityId;
    await worker.runOnce(); const detail = (await app.inject({ method: "GET", url: `/api/opportunities/${opportunityId}` })).json();
    await app.inject({ method: "POST", url: `/api/opportunities/${opportunityId}/draft/confirm`, payload: { expectedVersion: detail.draft.version } });
    const started = await app.inject({ method: "POST", url: `/api/opportunities/${opportunityId}/screening-runs`, headers: { "idempotency-key": "screen" } }); const runId = started.json().resourceId;
    await worker.runOnce(); const run = await app.inject({ method: "GET", url: `/api/runs/${runId}` }); expect(run.json().status).toBe("completed");
    const events = await app.inject({ method: "GET", url: `/api/runs/${runId}/events?after=1` }); expect(events.body).toContain("stage_completed"); expect(events.body).not.toContain(profileBody.resumeText);
    const list = await app.inject({ method: "GET", url: "/api/opportunities?recommendation=strong_match" }); expect(list.statusCode).toBe(200);
  });

  it("maps infrastructure failures to 503", async () => {
    connection.close(); const response = await app.inject({ method: "GET", url: "/api/profile" });
    expect(response.statusCode).toBe(503); expect(response.json()).toMatchObject({ error: { code: "infrastructure_unavailable", retryable: true } });
  });

  it("accepts a 20-item batch with duplicates and completes the end-to-end report flow", async () => {
    await app.inject({ method: "PUT", url: "/api/profile", payload: profileBody });
    const duplicate = "职位：AI Engineer\n公司：Duplicate Co\n职责：TypeScript Agent ownership\n要求：TypeScript";
    const items = Array.from({ length: 20 }, (_, index) => ({ text: index < 2 ? duplicate : `职位：AI Engineer ${index}\n公司：Company ${index}\n职责：TypeScript Agent ownership\n要求：TypeScript` }));
    const imported = await app.inject({ method: "POST", url: "/api/import-batches", headers: { "idempotency-key": "twenty" }, payload: { items } }); expect(imported.statusCode).toBe(200);
    const batchId = imported.json().resourceId; let batch = (await app.inject({ method: "GET", url: `/api/import-batches/${batchId}` })).json();
    expect(batch.items).toHaveLength(20); expect(new Set(batch.items.map((item: { opportunityId: string }) => item.opportunityId)).size).toBe(20);
    for (let index = 0; index < 20; index += 1) expect(await worker.runOnce()).toBe(true);
    batch = (await app.inject({ method: "GET", url: `/api/import-batches/${batchId}` })).json(); expect(batch.items.every((item: { status: string }) => item.status === "ready")).toBe(true);
    const opportunityId = batch.items[0].opportunityId; let detail = (await app.inject({ method: "GET", url: `/api/opportunities/${opportunityId}` })).json();
    await app.inject({ method: "PATCH", url: `/api/opportunities/${opportunityId}/draft`, payload: { expectedVersion: detail.draft.version, fields: { benefits: { value: "成长空间", source: "user", revision: detail.draft.fields.benefits.revision } } } });
    detail = (await app.inject({ method: "GET", url: `/api/opportunities/${opportunityId}` })).json(); await app.inject({ method: "POST", url: `/api/opportunities/${opportunityId}/draft/confirm`, payload: { expectedVersion: detail.draft.version } });
    const started = await app.inject({ method: "POST", url: `/api/opportunities/${opportunityId}/screening-runs`, headers: { "idempotency-key": "twenty-screen" } }); expect(started.statusCode).toBe(200); await worker.runOnce();
    detail = (await app.inject({ method: "GET", url: `/api/opportunities/${opportunityId}` })).json(); expect(detail.reports).toHaveLength(1); expect(detail.reports[0]).toMatchObject({ modelLabel: "本地演示模型", effective: true });
  });
});
