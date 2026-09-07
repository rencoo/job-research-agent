import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, BusinessRepository, JobRepository, openDatabase, type DatabaseConnection } from "@job-research/database";
import { FakeModel, LocalDemoModel, ModelGatewayError, ModelGatewayResolver, type ModelGateway } from "@job-research/model-gateway";
import { DIMENSION_IDS, LOCAL_MODEL_CONFIG, type ModelInvocationConfig, type ResearchClaim } from "@job-research/contracts";
import { HandlerRegistry, LocalJobWorker } from "./worker";
import { createExtractionHandler, createScreeningHandler, LocalIngestionApplication, LocalOpportunityApplication, LocalProfileApplication, LocalResearchApplication, validateClaims } from "./business-app";
import { modelConfigFromDescriptor } from "./model-prompts";

let directory: string; let connection: DatabaseConnection; let business: BusinessRepository; let jobs: JobRepository;
let profile: LocalProfileApplication; let ingestion: LocalIngestionApplication; let opportunities: LocalOpportunityApplication; let research: LocalResearchApplication; let worker: LocalJobWorker;
const now = new Date("2026-09-05T01:00:00.000Z");
const profileInput = { resumeText: "7 years TypeScript Agent ownership", targetRoles: ["AI Agent Engineer"], targetLocations: ["上海"], salary: { minMonthly: 25_000, maxMonthly: 40_000 }, commuteToleranceMinutes: 60, highlights: ["Agent"], constraints: [{ text: "TypeScript", level: "required" as const }], redFlags: [{ text: "996", level: "blocking" as const }], weights: { career_growth: "high" as const }, expectedVersion: null };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "business-app-")); connection = openDatabase({ dataDirectory: directory }); applyMigrations(connection.sqlite);
  business = new BusinessRepository(connection.sqlite); jobs = new JobRepository(connection.sqlite);
  profile = new LocalProfileApplication(business, () => now); ingestion = new LocalIngestionApplication(business, jobs, () => now);
  opportunities = new LocalOpportunityApplication(business, () => now); research = new LocalResearchApplication(business, jobs, () => now);
  const model = new LocalDemoModel();
  worker = new LocalJobWorker({ repository: jobs, registry: new HandlerRegistry().register("extract-job-draft", createExtractionHandler(business, model, () => now)).register("screen-opportunity", createScreeningHandler(business, model, () => now)), workerId: "test", leaseMs: 10_000, clock: { now: () => now } });
});
afterEach(() => { connection.close(); rmSync(directory, { recursive: true, force: true }); });

async function createReadyOpportunity(text = "职位：AI Agent Engineer\n公司：Demo AI\n地点：上海\n薪资：30k-40k\n职责：TypeScript Agent ownership\n要求：7 years TypeScript") {
  const imported = await ingestion.importBatch({ items: [{ text }] }, crypto.randomUUID());
  if (!imported.ok) throw new Error(imported.error.message);
  const batch = business.getImportBatch(imported.value.resourceId)!;
  await worker.runOnce();
  return batch.items[0]!.opportunityId;
}

describe("local business applications", () => {
  it("versions the unique current profile and validates optimistic concurrency", async () => {
    const first = await profile.save(profileInput); expect(first).toMatchObject({ ok: true, value: { resumeVersion: 1, profileVersion: 1, version: 1, weightInputs: { career_growth: "high" } } });
    expect(business.getProfile()?.weightInputs).toEqual({ career_growth: "high" });
    const stale = await profile.save({ ...profileInput, resumeText: "changed", expectedVersion: 0 }); expect(stale).toMatchObject({ ok: false, error: { code: "version_conflict" } });
    const second = await profile.save({ ...profileInput, resumeText: "changed", expectedVersion: 1 }); expect(second).toMatchObject({ ok: true, value: { resumeVersion: 2, version: 2 } });
  });

  it("imports duplicates independently and identifies URL-only input", async () => {
    const result = await ingestion.importBatch({ items: [{ text: "same JD" }, { text: "same JD" }, { text: "https://example.com/job" }] }, "batch-key");
    expect(result.ok).toBe(true);
    const repeat = await ingestion.importBatch({ items: [{ text: "same JD" }, { text: "same JD" }, { text: "https://example.com/job" }] }, "batch-key");
    expect(repeat).toEqual(result);
    const batch = business.getImportBatch(result.ok ? result.value.resourceId : "")!;
    expect(new Set(batch.items.map((item) => item.opportunityId)).size).toBe(3);
    expect(batch.items.some((item) => item.status === "needs_input")).toBe(true);
  });

  it("extracts fields, defaults to 12 months, and preserves a concurrent user edit", async () => {
    const imported = await ingestion.importBatch({ items: [{ text: "职位：AI Engineer\n薪资：30k-40k\n职责：Build Agent" }] }, "extract-key");
    const batch = business.getImportBatch(imported.ok ? imported.value.resourceId : "")!; const opportunityId = batch.items[0]!.opportunityId;
    const draft = business.getDraft(opportunityId)!;
    const edited = await opportunities.updateDraft(opportunityId, { expectedVersion: draft.version, fields: { title: { value: "User title", source: "user", revision: 1 } } }); expect(edited.ok).toBe(true);
    await worker.runOnce();
    const after = business.getDraft(opportunityId)!;
    expect(after.fields.title.value).toBe("User title"); expect(after.fields.payMonths).toMatchObject({ value: 12, source: "default" });
    expect(after.assumptions).toContain("发薪月数未注明，按 12 薪估算"); expect(after.conflicts).toHaveLength(1);
  });

  it("isolates an invalid extraction item and lets the user retry only that item", async () => {
    const invalid = new FakeModel({ type: "success", value: {} }, { provider: "local", model: "local-demo", label: "本地演示模型" });
    const invalidWorker = new LocalJobWorker({
      repository: jobs,
      registry: new HandlerRegistry().register("extract-job-draft", createExtractionHandler(business, invalid, () => now)),
      workerId: "invalid-extraction",
      leaseMs: 10_000,
      clock: { now: () => now },
    });
    const imported = await ingestion.importBatch({ items: [{ text: "职位：AI Engineer\n职责：Build Agent" }] }, "invalid-extraction");
    const batchId = imported.ok ? imported.value.resourceId : "";
    const item = business.getImportBatch(batchId)!.items[0]!;
    await invalidWorker.runOnce();
    expect(business.getImportBatch(batchId)!.items[0]).toMatchObject({ status: "failed", error: { retryable: false } });

    const retried = await ingestion.retryItem(item.id);
    expect(retried.ok).toBe(true);
    const retryWorker = new LocalJobWorker({
      repository: jobs,
      registry: new HandlerRegistry().register("extract-job-draft", createExtractionHandler(business, new LocalDemoModel(), () => now)),
      workerId: "valid-extraction",
      leaseMs: 10_000,
      clock: { now: () => now },
    });
    await retryWorker.runOnce();
    expect(business.getImportBatch(batchId)!.items[0]).toMatchObject({ status: "ready" });
  });

  it("requires a complete draft and returns confirmed drafts to draft after edits", async () => {
    const opportunityId = await createReadyOpportunity(); const current = business.getDraft(opportunityId)!;
    const confirmed = await opportunities.confirmDraft(opportunityId, { expectedVersion: current.version }); expect(confirmed).toMatchObject({ ok: true, value: { status: "confirmed" } });
    const value = confirmed.ok ? confirmed.value : current;
    const changed = await opportunities.updateDraft(opportunityId, { expectedVersion: value.version, fields: { company: { value: "Changed", source: "user", revision: 1 } } }); expect(changed).toMatchObject({ ok: true, value: { status: "draft" } });
  });

  it("freezes snapshots and completes a checkpointed screening report", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const started = await research.startScreening(opportunityId, "run-key"); expect(started.ok).toBe(true);
    const repeated = await research.startScreening(opportunityId, "run-key"); expect(repeated).toEqual(started);
    await worker.runOnce();
    const run = business.getRun(started.ok ? started.value.resourceId : "")!; expect(run.status).toBe("completed");
    expect(run.modelConfig).toEqual(LOCAL_MODEL_CONFIG);
    const report = business.getReport(run.reportId!)!;
    expect(Object.keys(report.dimensions)).toHaveLength(6);
    expect(report.dimensions).not.toHaveProperty("ownership");
    expect(report.dimensions).not.toHaveProperty("product_interest");
    expect(report.modelLabel).toBe("本地演示模型"); expect(report.dimensions.people_and_company_reliability.verdict).toBe("unknown"); expect(report.dimensions.life_radius.unknowns[0]).toContain("通勤");
    expect(report.assumptions.some((item) => item.includes("12 薪"))).toBe(true); expect(report.confidence).not.toBe("high");
    expect((connection.sqlite.prepare("SELECT COUNT(*) count FROM stage_checkpoints WHERE run_id=?").get(run.id) as { count: number }).count).toBe(5);
    expect(business.listRunEvents(run.id).every((event) => !JSON.stringify(event).includes(profileInput.resumeText))).toBe(true);
  });

  it("rejects claims whose excerpts are not present in both snapshots", () => {
    const claim = { id: "c", dimension: "work_content" as const, statement: "claim", polarity: "positive" as const, confidence: "high" as const, status: "supported" as const, resumeEvidence: "invented", jobEvidence: "Agent" };
    expect(validateClaims([claim], "TypeScript", "Agent")[0]?.status).toBe("rejected");
    expect(validateClaims([{ ...claim, resumeEvidence: "[已移除邮箱]", jobEvidence: "Agent" }], "[已移除邮箱] TypeScript", "Agent")[0]?.status).toBe("rejected");
  });

  it("keeps stale reports historical and does not adopt them", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const started = await research.startScreening(opportunityId, "stale-run");
    await profile.save({ ...profileInput, resumeText: "changed resume", expectedVersion: 1 });
    await worker.runOnce();
    const run = business.getRun(started.ok ? started.value.resourceId : "")!; const report = business.getReport(run.reportId!)!;
    expect(report).toMatchObject({ status: "stale", effective: false });
    expect(business.getOpportunity(opportunityId)?.currentReportId).toBeNull();
  });

  it("cancels queued runs and retries failed runs as immutable children", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const started = await research.startScreening(opportunityId, "cancel-run"); const runId = started.ok ? started.value.resourceId : "";
    expect(await research.cancel(runId)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    business.updateRun(runId, { status: "failed", error: { code: "test", message: "test" } }, now);
    const retried = await research.retryFailed(runId); expect(retried.ok).toBe(true);
    const child = business.getRun(retried.ok ? retried.value.resourceId : "")!;
    expect(child).toMatchObject({ parentRunId: runId, status: "queued", modelConfig: LOCAL_MODEL_CONFIG });
    expect(business.getRun(runId)).toMatchObject({ status: "failed", successorRunId: child.id });
    const repeated = await research.retryFailed(runId);
    expect(repeated).toEqual({ ok: true, value: { id: child.id, resourceId: child.id, created: false } });
  });

  it("resumes after an existing checkpoint without overwriting it", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const started = await research.startScreening(opportunityId, "resume-run"); const runId = started.ok ? started.value.resourceId : "";
    const checkpoint = { requiredMisses: [], blockingFlags: [], warnings: ["already committed"] };
    business.saveCheckpoint(runId, "constraint_check", checkpoint, now);
    await worker.runOnce();
    expect(business.getCheckpoint(runId, "constraint_check")).toEqual(checkpoint);
    expect((connection.sqlite.prepare("SELECT COUNT(*) count FROM stage_checkpoints WHERE run_id=?").get(runId) as { count: number }).count).toBe(5);
  });

  it("persists failed and in-flight cancelled workflow outcomes", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); let draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const failedStart = await research.startScreening(opportunityId, "failed-run"); const failedRunId = failedStart.ok ? failedStart.value.resourceId : "";
    const failingWorker = new LocalJobWorker({ repository: jobs, clock: { now: () => now }, workerId: "failing", leaseMs: 1000, registry: new HandlerRegistry().register("screen-opportunity", createScreeningHandler(business, new FakeModel({ type: "failure", error: new ModelGatewayError("fake_failure", "fake", false) }), () => now)) });
    await failingWorker.runOnce();
    expect(business.getRun(failedRunId)?.status).toBe("failed");
    expect(jobs.get(business.getRun(failedRunId)!.jobId)).toMatchObject({ status: "failed", attempts: 1 });

    const cancelledStart = await research.startScreening(opportunityId, "cancel-running"); const cancelledRunId = cancelledStart.ok ? cancelledStart.value.resourceId : "";
    const delayedWorker = new LocalJobWorker({ repository: jobs, clock: { now: () => now }, workerId: "delayed", leaseMs: 30, registry: new HandlerRegistry().register("screen-opportunity", createScreeningHandler(business, new FakeModel({ type: "success", value: [], delayMs: 50 }), () => now)) });
    const active = delayedWorker.runOnce(); await new Promise((resolve) => setTimeout(resolve, 5)); await research.cancel(cancelledRunId); await active;
    expect(business.getRun(cancelledRunId)?.status).toBe("cancelled"); expect(jobs.get(business.getRun(cancelledRunId)!.jobId)?.status).toBe("cancelled");
  });

  it("recovers a stale execution job and continues after its persisted checkpoint", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const started = await research.startScreening(opportunityId, "restart-run"); const runId = started.ok ? started.value.resourceId : "";
    business.saveCheckpoint(runId, "constraint_check", { requiredMisses: [], blockingFlags: [], warnings: [] }, now);
    jobs.claimNext("dead-process", now, 10);
    const recoveredAt = new Date(now.getTime() + 11); const recoveredWorker = new LocalJobWorker({ repository: jobs, clock: { now: () => recoveredAt }, workerId: "restarted", leaseMs: 1000, registry: new HandlerRegistry().register("screen-opportunity", createScreeningHandler(business, new LocalDemoModel(), () => recoveredAt)) });
    expect(recoveredWorker.recoverStaleJobs()).toEqual({ requeued: 1, failed: 0 }); await recoveredWorker.runOnce();
    expect(business.getRun(runId)?.status).toBe("completed"); expect(business.getCheckpoint(runId, "constraint_check")).toEqual({ requiredMisses: [], blockingFlags: [], warnings: [] });
  });

  it("filters opportunity history and returns all report revisions", async () => {
    await profile.save(profileInput); const opportunityId = await createReadyOpportunity(); const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    for (const key of ["history-1", "history-2"]) { await research.startScreening(opportunityId, key); await worker.runOnce(); }
    const reports = business.listReports(opportunityId); expect(reports).toHaveLength(2);
    const results = business.listOpportunities({ keyword: "Demo", status: "confirmed", recommendation: reports[0]!.recommendation });
    expect(results.map((item) => item.id)).toContain(opportunityId);
  });

  it("marks work_content mixed when product fits but ownership is missing", async () => {
    const report = await screenWith([
      workContentClaim("p", "产品方向匹配", "positive"),
      workContentClaim("o", "角色只是执行切片", "negative"),
    ], "mixed-content");
    expect(Object.keys(report.dimensions)).toEqual([...DIMENSION_IDS]);
    expect(report.dimensions.work_content.verdict).toBe("mixed");
    expect(report.claims.map((claim) => claim.statement)).toEqual(["产品方向匹配", "角色只是执行切片"]);
  });

  it("can judge work_content from daily-duty evidence alone", async () => {
    const report = await screenWith([workContentClaim("d", "日常职责匹配", "positive")], "duty-only");
    expect(report.dimensions.work_content.verdict).toBe("positive");
    expect(report.claims).toHaveLength(1);
  });

  it("uses a frozen DeepSeek configuration across extraction and screening without exposing PII", async () => {
    const capturedInputs: unknown[] = [];
    const demo = new LocalDemoModel();
    const deepSeekStub: ModelGateway = {
      descriptor: { provider: "deepseek", model: "deepseek-test", label: "DeepSeek test double" },
      generateStructured(request) {
        capturedInputs.push(request.input);
        if (request.task === "extract-job-draft") return demo.generateStructured(request);
        return Promise.resolve(request.validate([workContentClaim("deep", "TypeScript 匹配", "positive")]));
      },
    };
    const config = modelConfigFromDescriptor(deepSeekStub.descriptor);
    const resolver = new ModelGatewayResolver([deepSeekStub]);
    const deepProfile = new LocalProfileApplication(business, () => now);
    const deepIngestion = new LocalIngestionApplication(business, jobs, () => now, config);
    const deepResearch = new LocalResearchApplication(business, jobs, () => now, config);
    const deepWorker = new LocalJobWorker({
      repository: jobs,
      registry: new HandlerRegistry()
        .register("extract-job-draft", createExtractionHandler(business, resolver, () => now))
        .register("screen-opportunity", createScreeningHandler(business, resolver, () => now)),
      workerId: "deepseek-test",
      leaseMs: 10_000,
      clock: { now: () => now },
    });
    await deepProfile.save({ ...profileInput, resumeText: `${profileInput.resumeText} 15652663008 person@example.com` });
    const imported = await deepIngestion.importBatch({ items: [{ text: "职位：AI Agent Engineer\n职责：TypeScript Agent" }] }, "deep-import");
    const batch = business.getImportBatch(imported.ok ? imported.value.resourceId : "")!;
    await deepWorker.runOnce();
    const opportunityId = batch.items[0]!.opportunityId;
    const draft = business.getDraft(opportunityId)!;
    expect(draft.extractionModel).toEqual(config);
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const started = await deepResearch.startScreening(opportunityId, "deep-screen");
    const runId = started.ok ? started.value.resourceId : "";
    expect(business.getRun(runId)?.modelConfig).toEqual(config);
    await deepWorker.runOnce();
    const run = business.getRun(runId)!;
    const report = business.getReport(run.reportId!)!;
    expect(report).toMatchObject({ modelLabel: "DeepSeek test double", modelConfig: config });
    const sent = JSON.stringify(capturedInputs);
    expect(sent).not.toContain("15652663008");
    expect(sent).not.toContain("person@example.com");
    expect(sent).toContain("TypeScript");
  });

  it("keeps retryable model failures queued and persists only safe error summaries", async () => {
    await profile.save({ ...profileInput, resumeText: `${profileInput.resumeText} private@example.com` });
    const opportunityId = await createReadyOpportunity("职位：AI Engineer\n职责：TypeScript Agent private JD");
    const draft = business.getDraft(opportunityId)!;
    await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
    const failing = new FakeModel(
      { type: "failure", error: new ModelGatewayError("deepseek_rate_limited", "DeepSeek 请求受限，请稍后重试", true) },
      { provider: "deepseek", model: "deepseek-test", label: "DeepSeek test double" },
    );
    const config: ModelInvocationConfig = modelConfigFromDescriptor(failing.descriptor);
    const deepResearch = new LocalResearchApplication(business, jobs, () => now, config);
    const started = await deepResearch.startScreening(opportunityId, "retryable-deep");
    const runId = started.ok ? started.value.resourceId : "";
    const failingWorker = new LocalJobWorker({
      repository: jobs,
      registry: new HandlerRegistry().register("screen-opportunity", createScreeningHandler(business, new ModelGatewayResolver([failing]), () => now)),
      workerId: "retryable-deep",
      leaseMs: 10_000,
      clock: { now: () => now },
    });
    await failingWorker.runOnce();
    expect(business.getRun(runId)?.status).toBe("queued");
    const run = business.getRun(runId)!;
    expect(jobs.get(run.jobId)).toMatchObject({ status: "queued", attempts: 1, error: { code: "deepseek_rate_limited", retryable: true } });
    const persisted = JSON.stringify({ runEvents: business.listRunEvents(runId), job: jobs.get(run.jobId) });
    expect(persisted).not.toContain("private@example.com");
    expect(persisted).not.toContain("private JD");
  });
});

function workContentClaim(id: string, statement: string, polarity: "positive" | "negative"): ResearchClaim {
  return {
    id, dimension: "work_content", statement, polarity, confidence: "high", status: "supported",
    resumeEvidence: "TypeScript", jobEvidence: "TypeScript",
  };
}

function screeningModel(claims: ResearchClaim[]): ModelGateway {
  const demo = new LocalDemoModel();
  return {
    descriptor: { provider: "local", model: "local-demo", label: "本地演示模型" },
    generateStructured(request) {
      if (request.task === "extract-job-draft") return demo.generateStructured(request);
      return Promise.resolve(request.validate(claims));
    },
  };
}

async function screenWith(claims: ResearchClaim[], key: string) {
  await profile.save(profileInput);
  const opportunityId = await createReadyOpportunity();
  const draft = business.getDraft(opportunityId)!;
  await opportunities.confirmDraft(opportunityId, { expectedVersion: draft.version });
  const screeningWorker = new LocalJobWorker({
    repository: jobs,
    registry: new HandlerRegistry().register("screen-opportunity", createScreeningHandler(business, screeningModel(claims), () => now)),
    workerId: "custom-screen",
    leaseMs: 10_000,
    clock: { now: () => now },
  });
  const started = await research.startScreening(opportunityId, key);
  await screeningWorker.runOnce();
  const run = business.getRun(started.ok ? started.value.resourceId : "")!;
  return business.getReport(run.reportId!)!;
}
