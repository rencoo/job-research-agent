import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, BusinessRepository, JobRepository, openDatabase, ResearchRepository, type DatabaseConnection } from "@job-research/database";
import { LocalDemoModel, ModelGatewayError } from "@job-research/model-gateway";
import { FakeSearch, FakePageReader, ResearchToolError } from "@job-research/research-tools";
import { LocalProfileApplication, LocalIngestionApplication, LocalOpportunityApplication, LocalResearchApplication, createExtractionHandler, createScreeningHandler } from "./business-app";
import { DeepResearchApplication, createDeepResearchHandler, buildSnippetSourceText, identityModelDocuments } from "./deep-research";
import * as researchPrompts from "./research-prompts";
import { HandlerRegistry, LocalJobWorker } from "./worker";
import { materializeClaims } from "./research-prompts";
import { buildServer } from "./app";
let connection: DatabaseConnection; let b: BusinessRepository; let jobs: JobRepository; let r: ResearchRepository;
let deep: DeepResearchApplication; let worker: LocalJobWorker; let profile: LocalProfileApplication; let ingestion: LocalIngestionApplication; let opportunities: LocalOpportunityApplication; let screening: LocalResearchApplication;
let search: FakeSearch; let reader: FakePageReader;
const time = new Date("2026-09-08T00:00:00Z");
beforeEach(() => {
  connection = openDatabase({ filename: ":memory:" }); applyMigrations(connection.sqlite); b = new BusinessRepository(connection.sqlite); jobs = new JobRepository(connection.sqlite); r = new ResearchRepository(b);
  search = new FakeSearch(); reader = new FakePageReader(); profile = new LocalProfileApplication(b, () => time); ingestion = new LocalIngestionApplication(b, jobs, () => time); opportunities = new LocalOpportunityApplication(b, () => time); screening = new LocalResearchApplication(b, jobs, () => time);
  deep = new DeepResearchApplication({ repository: r, jobs, search, reader, models: new LocalDemoModel(), mode: "demo", now: () => time });
  worker = makeWorker();
});
afterEach(() => { vi.restoreAllMocks(); connection.close(); });
function makeWorker() { return new LocalJobWorker({ repository: jobs, registry: new HandlerRegistry().register("extract-job-draft", createExtractionHandler(b, new LocalDemoModel(), () => time)).register("screen-opportunity", createScreeningHandler(b, new LocalDemoModel(), () => time)).register("deep-research", createDeepResearchHandler(deep)), clock: { now: () => time } }); }
async function ready() {
  if (!b.getProfile()) await profile.save({ resumeText: "TypeScript Agent experience", targetRoles: ["AI Engineer"], targetLocations: [], salary: null, commuteToleranceMinutes: null, highlights: [], constraints: [], redFlags: [], weights: {}, expectedVersion: null });
  const result = await ingestion.importBatch({ items: [{ text: "职位：AI Engineer\n公司：Demo\n职责：TypeScript Agent\n要求：TypeScript" }] }, crypto.randomUUID());
  if (!result.ok) throw new Error(result.error.message); const id = b.getImportBatch(result.value.id)!.items[0]!.opportunityId;
  await worker.runOnce(); await opportunities.confirmDraft(id, { expectedVersion: b.getDraft(id)!.version }); await screening.startScreening(id, crypto.randomUUID()); await worker.runOnce(); return id;
}
async function waiting() {
  const id = await ready(); const started = await deep.start(id, "deep-key"); if (!started.ok) throw new Error(started.error.message); await worker.runOnce(); return { opportunityId: id, runId: started.value.id };
}
async function select(runId: string) { const state = r.state(runId)!; return deep.respond(runId, { action: "select", candidateId: state.resolution.candidates[0]!.id, expectedVersion: state.resolution.version }); }

describe("deep research closed loop", () => {
  it("requires current screening and deduplicates start commands", async () => {
    expect(await deep.start("missing", "k")).toMatchObject({ ok: false }); const { runId, opportunityId } = await waiting();
    expect(await deep.start(opportunityId, "deep-key")).toMatchObject({ ok: true, value: { id: runId } });
    expect(await deep.start(opportunityId, "another-key")).toMatchObject({ ok: false, error: { code: "domain_precondition" } });
    expect(b.getRun(runId)?.status).toBe("needs_attention"); expect(jobs.get(b.getRun(runId)!.jobId)?.status).toBe("succeeded");
  });
  it("confirms company, reads evidence, completes partial six-dimension report", async () => {
    const { runId, opportunityId } = await waiting(); expect(await select(runId)).toMatchObject({ ok: true }); await worker.runOnce();
    expect(b.getRun(runId)?.status).toBe("completed"); const report = r.view(opportunityId).reports[0]!;
    expect(report.status).toBe("partial"); expect(report.mode).toBe("demo"); expect(report.companySnapshotId).toBeTruthy(); expect(report.evidence.length).toBeGreaterThan(0);
    for (const evidence of report.evidence) expect(r.source(evidence.documentId)?.text.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    expect(reader.urls).toHaveLength(1); expect(r.snapshot(report.companySnapshotId!)?.documentIds.every(id => r.source(id)?.kind === "web")).toBe(true);
  });
  it("skips ambiguous identity without using unrelated company sources", async () => {
    const { runId, opportunityId } = await waiting(); await deep.respond(runId, { action: "skip", expectedVersion: 1 }); await worker.runOnce();
    const report = r.view(opportunityId).reports[0]!; expect(report.dimensions.people_and_company_reliability.verdict).toBe("unknown"); expect(report.companySnapshotId).toBeNull(); expect(report.evidence.every(e => r.source(e.documentId)?.kind !== "web")).toBe(true);
  });
  it("rejects stale confirmation and permits a new identity search after supplement", async () => {
    const { runId } = await waiting(); expect(await deep.respond(runId, { action: "skip", expectedVersion: 0 })).toMatchObject({ ok: false, error: { code: "version_conflict" } });
    await deep.respond(runId, { action: "supplement", hint: "Some brand", expectedVersion: 1 }); await worker.runOnce(); expect(search.queries.some(q => q.includes("Some brand"))).toBe(true); expect(b.getRun(runId)?.status).toBe("needs_attention");
  });
  it("cancels paused research without creating a report", async () => { const { runId } = await waiting(); await deep.cancel(runId); expect(b.getRun(runId)?.status).toBe("cancelled"); expect(await select(runId)).toMatchObject({ ok: false }); });
  it("conserves tool budget and produces a partial report", async () => {
    const { runId, opportunityId } = await waiting(); await select(runId); const state = r.state(runId)!; state.calls = 100; r.saveState(state); await worker.runOnce();
    expect(r.view(opportunityId).reports[0]?.stopReason).toBe("budget_exhausted"); expect(r.state(runId)?.calls).toBe(100);
  });
  it("marks historical report stale after profile changes", async () => {
    const { runId, opportunityId } = await waiting(); await select(runId); await worker.runOnce(); const current = b.getProfile()!;
    await profile.save({ ...current, resumeText: "changed TypeScript", expectedVersion: current.version });
    expect(r.view(opportunityId)).toMatchObject({ currentReportId: null, reports: [{ status: "stale", effective: false }] });
  });
  it("recovers successful reads after a restart", async () => {
    const { runId } = await waiting(); worker = makeWorker(); await select(runId); await worker.runOnce(); expect(b.getRun(runId)?.status).toBe("completed"); expect(reader.urls).toHaveLength(1);
  });
  it("creates a deep child on failure and preserves spent budget", async () => {
    const { runId } = await waiting(); await select(runId);
    deep.dependencies.search.search = async () => { throw new ResearchToolError("auth_failed"); };
    await worker.runOnce(); expect(b.getRun(runId)?.status).toBe("failed"); const calls = r.state(runId)!.calls;
    const retry = await deep.retry(runId); expect(retry.ok).toBe(true); if (!retry.ok) return;
    expect(r.state(retry.value.id)?.calls).toBe(calls); expect(b.getRun(retry.value.id)?.kind).toBe("deep_research"); expect(jobs.get(b.getRun(retry.value.id)!.jobId)?.type).toBe("deep-research");
    expect(await deep.retry(runId)).toMatchObject({ ok: true, value: { id: retry.value.id, created: false } });
  });
  it("records diagnostics for tool failures without leaking internal codes", async () => {
    const { runId } = await waiting(); await select(runId);
    deep.dependencies.search.search = async () => { throw new ResearchToolError("tavily_authentication_failed"); };
    await worker.runOnce();
    const state = r.state(runId)!;
    expect(b.getRun(runId)?.status).toBe("failed");
    expect(state.diagnostic?.stage).toBeTruthy();
    expect(state.error).toContain("搜索服务鉴权失败");
    expect(state.error).not.toContain("tavily_authentication_failed");
  });
  it("turns unreadable company sources into needs_attention without calling identity model", async () => {
    reader = new FakePageReader({ "https://demo.example/about": { status: "blocked", reason: "restricted_page" } });
    deep = new DeepResearchApplication({ repository: r, jobs, search, reader, models: new LocalDemoModel(), mode: "demo", now: () => time });
    worker = makeWorker();
    const { runId, opportunityId } = await waiting();
    const state = r.state(runId)!;
    expect(b.getRun(runId)?.status).toBe("needs_attention");
    expect(state.diagnostic?.message).toContain("无法安全读取");
    expect(state.sourceReadSummary).toMatchObject({ attempts: 1, successes: 0, failures: { restricted_page: 1 } });
    expect(state.searchHits).toEqual([{ url: "https://demo.example/about", title: "合成示例公司", snippet: "仅用于离线演示", readStatus: "blocked" }]);
    expect(b.getCheckpoint(runId, "io:identity-model:1")).toBeNull();
    expect(await deep.respond(runId, { action: "skip", expectedVersion: 1 })).toMatchObject({ ok: true });
    await worker.runOnce();
    expect(r.view(opportunityId).reports[0]?.companySnapshotId).toBeNull();
  });
  it("falls back to Tavily snippets when page reads fail", async () => {
    search = new FakeSearch([{ url: "https://demo.example/about", title: "合成示例公司", snippet: "合成示例公司是一家 AI 工作流产品公司，团队开发 TypeScript Agent 平台。" }]);
    reader = new FakePageReader({ "https://demo.example/about": { status: "blocked", reason: "restricted_page" } });
    deep = new DeepResearchApplication({ repository: r, jobs, search, reader, models: new LocalDemoModel(), mode: "demo", now: () => time });
    worker = makeWorker();
    const { runId } = await waiting();
    const state = r.state(runId)!;
    expect(state.searchHits?.[0]?.readStatus).toBe("snippet");
    expect(b.getCheckpoint(runId, "io:identity-model:1")).toBeTruthy();
    expect(state.resolution.candidates.length).toBeGreaterThan(0);
    expect(state.documentIds.some(id => r.source(id)?.method === "search_snippet")).toBe(true);
    const modelCalls = vi.spyOn(researchPrompts, "researchModel");
    await select(runId);
    await worker.runOnce();
    expect(b.getRun(runId)?.status).toBe("completed");
    const report = r.report(b.getRun(runId)!.reportId!);
    expect(report?.evidence.every(e => r.source(e.documentId)?.method !== "search_snippet")).toBe(true);
    for (const [, task, , input] of modelCalls.mock.calls) {
      if (task === "extract-research-claims" || task === "verify-evidence") {
        expect((input as { documents: { id: string }[] }).documents.every(doc => r.source(doc.id)?.method !== "search_snippet")).toBe(true);
      }
    }
  });
  it("fails with a diagnostic when claims model fails mid-loop", async () => {
    const original = researchPrompts.researchModel;
    let runExtracts = 0;
    vi.spyOn(researchPrompts, "researchModel").mockImplementation(async (model, task, schema, input, signal) => {
      if (task === "extract-research-claims" && (input as { scope?: string }).scope === "run") {
        runExtracts++;
        if (runExtracts >= 1) throw new ModelGatewayError("deepseek_schema_invalid", "invalid", false);
      }
      return original(model, task, schema, input, signal);
    });
    const { runId, opportunityId } = await waiting();
    await select(runId);
    await worker.runOnce();
    expect(b.getRun(runId)?.status).toBe("failed");
    expect(r.view(opportunityId).reports).toHaveLength(0);
    expect(r.state(runId)?.error).toContain("模型返回结果无效");
    vi.restoreAllMocks();
  });
  it.each([
    ["deepseek_request_failed", "模型调用失败"],
    ["deepseek_auth_failed", "模型鉴权失败"],
    ["deepseek_schema_invalid", "模型返回结果无效"],
  ])("preserves identity failure %s and retries with cached snippets", async (code, message) => {
    const original = researchPrompts.researchModel;
    vi.spyOn(researchPrompts, "researchModel").mockImplementation(async (model, task, schema, input, signal) => {
      if (task === "resolve-company") throw new ModelGatewayError(code, "failed", false);
      return original(model, task, schema, input, signal);
    });
    search = new FakeSearch([{ url: "https://demo.example/about", title: "合成示例公司", snippet: "合成示例公司是一家 AI 工作流产品公司，团队开发 TypeScript Agent 平台。" }]);
    reader = new FakePageReader({ "https://demo.example/about": { status: "blocked", reason: "restricted_page" } });
    deep = new DeepResearchApplication({ repository: r, jobs, search, reader, models: new LocalDemoModel(), mode: "demo", now: () => time });
    worker = makeWorker();
    const { runId } = await waiting();
    expect(b.getRun(runId)?.status).toBe("failed");
    expect(r.state(runId)?.diagnostic?.message).toContain(message);
    expect(r.state(runId)?.error).toContain(message);
    expect(r.state(runId)?.searchHits?.[0]?.readStatus).toBe("snippet");
    vi.restoreAllMocks();
    const queries = search.queries.length;
    const reads = reader.urls.length;
    const retry = await deep.retry(runId);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    await worker.runOnce();
    expect(b.getRun(retry.value.id)?.status).toBe("needs_attention");
    expect(r.state(retry.value.id)?.resolution.candidates.length).toBeGreaterThan(0);
    expect(r.state(retry.value.id)?.error).toBeNull();
    expect(search.queries).toHaveLength(queries);
    expect(reader.urls).toHaveLength(reads);
  });
  it("requires confirmation even when an official URL snippet matches the legal name", async () => {
    const id = await ready();
    const company = String(b.getDraft(id)!.fields.company.value);
    search = new FakeSearch([{ url: "https://demo.example/about", title: company, snippet: `${company} 是一家开发人工智能工作流与企业软件的公司。` }]);
    reader = new FakePageReader({ "https://demo.example/about": { status: "blocked", reason: "restricted_page" } });
    deep = new DeepResearchApplication({ repository: r, jobs, search, reader, models: new LocalDemoModel(), mode: "live", now: () => time });
    worker = makeWorker();
    vi.spyOn(researchPrompts, "researchModel").mockImplementation(async (_model, _task, schema, input) => {
      const documents = (input as { documents: { id: string }[] }).documents;
      return schema.parse({ candidates: [{ id: "candidate", name: company, legalName: company, website: "https://demo.example", location: null, aliases: [], basis: [{ documentId: documents[0]!.id, quote: company }] }] });
    });
    const started = await deep.start(id, "snippet-identity");
    if (!started.ok) throw new Error(started.error.message);
    await worker.runOnce();
    expect(b.getRun(started.value.id)?.status).toBe("needs_attention");
    expect(r.state(started.value.id)?.resolution.candidates).toHaveLength(1);
    expect(r.state(started.value.id)?.companyId).toBeNull();
  });
  it("allows supplement after unreadable company sources", async () => {
    reader = new FakePageReader({ "https://demo.example/about": { status: "blocked", reason: "restricted_page" } });
    deep = new DeepResearchApplication({ repository: r, jobs, search, reader, models: new LocalDemoModel(), mode: "demo", now: () => time });
    worker = makeWorker();
    const { runId } = await waiting();
    await deep.respond(runId, { action: "supplement", hint: "Acme Labs", expectedVersion: 1 });
    await worker.runOnce();
    expect(search.queries.some(q => q.includes("Acme Labs"))).toBe(true);
    expect(b.getRun(runId)?.status).toBe("needs_attention");
  });
  it("shares company refresh ownership and wakes failed dependencies", async () => {
    const first = await waiting(); const secondId = await ready(); await select(first.runId); const companyId = r.state(first.runId)!.companyId!;
    // Another Run waits on the same company without keeping an execution job busy.
    const second = await deep.start(secondId, "second"); if (!second.ok) throw new Error(second.error.message);
    const secondState = r.state(second.value.id)!; secondState.companyId = companyId; secondState.resolution.status = "confirmed"; secondState.dependencyRunId = first.runId; r.saveState(secondState);
    b.updateRun(second.value.id, { status: "waiting" }, time); expect(r.acquireRefresh(companyId, first.runId)).toBe(first.runId); expect(r.acquireRefresh(companyId, second.value.id)).toBe(first.runId);
    b.updateRun(first.runId, { status: "failed" }, time); deep.wakeWaiting(); expect(b.getRun(second.value.id)?.status).toBe("queued");
  });
  it("exposes API validation, progress and confirmation", async () => {
    const { runId, opportunityId } = await waiting(); const app = buildServer({ repository: jobs, deepResearch: deep, business: { repository: b, profile, ingestion, opportunities, research: screening } });
    expect((await app.inject({ method: "GET", url: `/api/opportunities/${opportunityId}/deep-research` })).json().states[0].runId).toBe(runId);
    const response = await app.inject({ method: "POST", url: `/api/runs/${runId}/attention-responses`, payload: { action: "skip", expectedVersion: 1 } }); expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe("evidence integrity", () => {
  it("builds snippet fallback text only when search content is long enough", () => {
    expect(buildSnippetSourceText({ url: "https://example.com", title: "Demo", snippet: "short" })).toBeNull();
    expect(buildSnippetSourceText({ url: "https://example.com", title: "合成示例公司", snippet: "合成示例公司是一家 AI 工作流产品公司。" })).toContain("搜索摘要");
    expect(buildSnippetSourceText({ url: "https://example.com", title: "Demo", snippet: "x".repeat(10_000) })!.length).toBeLessThan(10_000);
  });
  it("trims snippet documents before identity model input", () => {
    const docs = identityModelDocuments([{ id: "s", kind: "web", url: "https://example.com", finalUrl: "https://example.com", title: "Demo", text: "a".repeat(10_000), contentHash: "h", retrievedAt: time.toISOString(), method: "search_snippet", sourceType: "third_party" }]);
    expect(docs[0]?.text.length).toBe(4_000);
  });
  const documents = [{ id: "d", kind: "web" as const, text: "The company reports 10 employees. Other sources report 5 employees.", title: "source", url: "https://example.com", finalUrl: "https://example.com", contentHash: "hash", retrievedAt: time.toISOString(), method: "http" as const, sourceType: "third_party" as const }];
  const proposal = { dimension: "people_and_company_reliability" as const, statement: "The company reports 10 employees.", confidence: "high" as const, polarity: "mixed" as const, attribution: "company statement", evidence: [{ documentId: "d", quote: "10 employees", relation: "supports" as const }] };
  it("rejects invented quotes even when model claims support", () => { expect(materializeClaims([{ ...proposal, evidence: [{ documentId: "d", quote: "500 employees", relation: "supports" }] }], documents, { results: [{ index: 0, supported: true, contested: false }] }, "run", "r").claims[0]?.status).toBe("rejected"); });
  it("does not equate a literal substring with semantic support", () => { expect(materializeClaims([proposal], documents, { results: [{ index: 0, supported: false, contested: false }] }, "run", "r").claims[0]?.status).toBe("unsupported"); });
  it("retains contradictory evidence as contested", () => { const result = materializeClaims([{ ...proposal, evidence: [...proposal.evidence, { documentId: "d", quote: "5 employees", relation: "refutes" }] }], documents, { results: [{ index: 0, supported: true, contested: false }] }, "run", "r"); expect(result.claims[0]?.status).toBe("contested"); expect(result.evidence).toHaveLength(2); });
});

import { runResearchLiveSmoke } from "./research-live-smoke";
it("refuses network smoke without explicit opt-in", async () => { await expect(runResearchLiveSmoke({})).rejects.toThrow("JRA_RUN_RESEARCH_LIVE=1"); });
it("reuses a covered company snapshot across separate opportunities", async () => {
  const first = await waiting(); await select(first.runId); await worker.runOnce(); const snapshotId = r.state(first.runId)!.companySnapshotId;
  const secondId = await ready(); const started = await deep.start(secondId, "reuse"); if (!started.ok) throw new Error(started.error.message); await worker.runOnce(); await select(started.value.id);
  const before = search.queries.length; await worker.runOnce(); expect(r.state(started.value.id)?.companySnapshotId).toBe(snapshotId);
  expect(search.queries.slice(before).some(q => q.includes("主体与品牌"))).toBe(false);
});
it("does not allow a stale input result to become current", async () => {
  const { runId, opportunityId } = await waiting(); await select(runId);
  const current = b.getProfile()!; await profile.save({ ...current, resumeText: "Different resume", expectedVersion: current.version }); await worker.runOnce();
  expect(b.getRun(runId)?.status).toBe("superseded"); expect(r.view(opportunityId).currentReportId).toBeNull();
});
it("cancels an in-flight tool and releases the company refresh lock", async () => {
  const { runId, opportunityId } = await waiting(); await select(runId);
  deep.dependencies.search.search = (_query, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
  const runningWorker = new LocalJobWorker({ repository: jobs, registry: new HandlerRegistry().register("deep-research", createDeepResearchHandler(deep)), clock: { now: () => time }, leaseMs: 60 });
  const running = runningWorker.runOnce(); await new Promise(resolve => setTimeout(resolve, 5)); await deep.cancel(runId); await running;
  expect(b.getRun(runId)?.status).toBe("cancelled"); expect(r.view(opportunityId).reports).toHaveLength(0); expect(r.db.prepare("SELECT * FROM company_refreshes").all()).toHaveLength(0);
});
it("reconciles a job that exhausted recovery attempts", async () => {
  const { runId } = await waiting(); await select(runId); const jobId = b.getRun(runId)!.jobId;
  r.db.prepare("UPDATE jobs SET status='failed' WHERE id=?").run(jobId); b.updateRun(runId, { status: "running" }, time); deep.wakeWaiting();
  expect(b.getRun(runId)?.status).toBe("failed"); expect(r.state(runId)?.error).toContain("重试次数已耗尽");
});
it("preserves report integrity when a required source disappears", async () => {
  const { runId, opportunityId } = await waiting(); await select(runId); await worker.runOnce(); const report = r.view(opportunityId).reports[0]!;
  r.db.pragma("foreign_keys=OFF"); r.db.prepare("DELETE FROM source_documents WHERE id=?").run(report.evidence[0]!.documentId); r.db.pragma("foreign_keys=ON");
  expect(r.report(report.id)).toMatchObject({ status: "invalidated", effective: false });
});
it("turns an in-flight deadline into a partial report rather than a tool failure", async () => {
  const { runId, opportunityId } = await waiting(); await select(runId);
  const state = r.state(runId)!; state.policy = { version: 1, maxCalls: 100, maxElapsedMs: 30 }; r.saveState(state);
  deep.dependencies.search.search = (_query, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await worker.runOnce(); expect(b.getRun(runId)?.status).toBe("completed"); expect(r.view(opportunityId).reports[0]?.stopReason).toBe("budget_exhausted");
});
