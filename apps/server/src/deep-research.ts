import { createHash } from "node:crypto";
import { z } from "zod";
import { AttentionResponseSchema, DeepStartSchema, DIMENSION_IDS, LOCAL_MODEL_CONFIG, type CompanySnapshot, type DeepClaim, type DeepResearchReport, type EvidenceLink, type ModelInvocationConfig, type ResearchQuestion, type ResearchRun, type ResearchState, type SourceDocument } from "@job-research/contracts";
import type { CommandReceipt, DeepResearchCommands, UseCaseResult } from "@job-research/application";
import { ResearchRepository, type JobRepository } from "@job-research/database";
import { aggregateVerdict, recommend, compensationPackage } from "@job-research/domain";
import { ModelGatewayResolver, type ModelGateway, type ModelRequest } from "@job-research/model-gateway";
import { type SearchPort, type PageReaderPort, type SearchResult, type PageResult, redactSearch } from "@job-research/research-tools";
import { ClaimProposalSchema, CompanyProposalSchema, VerificationSchema, materializeClaims, researchModel } from "./research-prompts";
import { redactResumeText } from "./model-prompts";
import { ambiguousCompanyDiagnostic, classifyResearchFailure, claimsModelFailedDiagnostic, emptySourceReadSummary, insufficientCompanySourcesDiagnostic, recordSourceRead, type DeepResearchStage } from "./research-diagnostics";
import type { JobHandlerContext } from "./worker";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const SNIPPET_SOURCE_PREFIX = "来源：搜索摘要（未能读取原网页，以下内容为搜索引擎索引摘要，未经逐字核验）\n\n";
const MIN_SNIPPET_SOURCE_CHARS = 20;
export function buildSnippetSourceText(result: SearchResult): string | null {
  const body = [result.title.trim(), result.snippet.trim()].filter(Boolean).join("\n\n");
  if (body.length < MIN_SNIPPET_SOURCE_CHARS) return null;
  return `${SNIPPET_SOURCE_PREFIX}${body.slice(0, 6_000)}`;
}
export function identityModelDocuments(documents: SourceDocument[]) {
  return documents.map(doc => ({ id: doc.id, title: doc.title, url: doc.finalUrl, text: doc.text.slice(0, doc.method === "search_snippet" ? 4_000 : 12_000) }));
}
const ok = <T>(value: T): UseCaseResult<T> => ({ ok: true, value });
const fail = <T>(code: "validation" | "not_found" | "version_conflict" | "domain_precondition" | "infrastructure_unavailable", message: string): UseCaseResult<T> => ({ ok: false, error: { code, message, retryable: false } });
const activeStatuses = ["queued", "running", "waiting", "needs_attention", "cancelling"];
const topics = ["主体与品牌", "产品业务", "团队", "融资经营", "公开招聘", "风险信息"];
export interface ResearchDependencies {
  repository: ResearchRepository; jobs: JobRepository; search: SearchPort; reader: PageReaderPort;
  models: ModelGateway | ModelGatewayResolver; mode: "demo" | "live"; modelConfig?: ModelInvocationConfig; now?: () => Date;
  maxCalls?: number; maxElapsedMs?: number;
}
export class DeepResearchApplication implements DeepResearchCommands {
  readonly repository: ResearchRepository;
  private readonly now: () => Date;
  constructor(readonly dependencies: ResearchDependencies) { this.repository = dependencies.repository; this.now = dependencies.now ?? (() => new Date()); }
  async start(opportunityId: string, key: string, raw: unknown = {}): Promise<UseCaseResult<CommandReceipt>> {
    const options = DeepStartSchema.safeParse(raw ?? {}); if (!key.trim() || !options.success) return fail("validation", "有效的幂等键及启动参数是必需的");
    const r = this.repository; const b = r.business;
    return r.transaction(() => {
      const payload = hash(JSON.stringify({ opportunityId, ...options.data })); const previous = b.getIdempotency(key);
      if (previous) return previous.commandType === "deep-research" && previous.payloadHash === payload ? ok(previous.receipt as CommandReceipt) : fail("version_conflict", "幂等键已用于其他请求");
      const opportunity = b.getOpportunity(opportunityId); if (!opportunity) return fail("not_found", "岗位不存在");
      const screening = opportunity.currentReportId ? b.getReport(opportunity.currentReportId) : null;
      if (!screening?.effective || ["stale", "invalidated"].includes(screening.status) || !r.isCurrent(screening.runId)) return fail("domain_precondition", "请先完成当前岗位与画像的有效初筛");
      const parent = options.data.parentRunId ? b.getRun(options.data.parentRunId) : null;
      if (options.data.parentRunId && (!parent || parent.kind !== "deep_research" || parent.opportunityId !== opportunityId || activeStatuses.includes(parent.status))) return fail("domain_precondition", "只能从此岗位已结束的深研继续");
      const active = opportunity.runs.find(run => run.kind === "deep_research" && activeStatuses.includes(run.status));
      if (active) return fail("domain_precondition", "已有正在执行或等待确认的深研");
      const now = this.now(); const runId = crypto.randomUUID(); const jobId = crypto.randomUUID();
      const context = b.getRunContext(screening.runId)!;
      const baseConfig = this.dependencies.modelConfig ?? LOCAL_MODEL_CONFIG;
      const config = { ...baseConfig, promptVersions: { ...baseConfig.promptVersions, deepResearch: "deep-research/v1" } };
      const run: ResearchRun = { id: runId, opportunityId, kind: "deep_research", jobId, status: "queued", currentStage: null, reportId: null, parentRunId: parent?.id ?? null, successorRunId: null, modelConfig: config, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.dependencies.jobs.create({ id: jobId, type: "deep-research", payload: { runId }, now });
      b.createRun(run, { profile: context.profileSnapshotId, job: context.jobSnapshotId });
      r.saveState({ schemaVersion: 1, runId, screeningReportId: screening.id, mode: this.dependencies.mode, refreshCompany: options.data.refreshCompany ?? false, resolution: { status: "pending", candidates: [], selectedId: null, hint: "", version: 1 }, companyId: null, companySnapshotId: null, dependencyRunId: null, questions: [], documentIds: [], sourceFailures: [], sourceReadSummary: emptySourceReadSummary(), policy: { version: 1, maxCalls: this.dependencies.maxCalls ?? 100, maxElapsedMs: this.dependencies.maxElapsedMs ?? 1_800_000 }, calls: 0, elapsedMs: 0, activeSince: null, round: 0, emptyRounds: 0, stopReason: null, error: null });
      const receipt = { id: runId, resourceId: runId, created: true }; b.saveIdempotency({ key, commandType: "deep-research", aggregateId: opportunityId, payloadHash: payload, receipt, now });
      return ok(receipt);
    });
  }
  async respond(runId: string, raw: unknown): Promise<UseCaseResult<ResearchRun>> {
    const parsed = AttentionResponseSchema.safeParse(raw); if (!parsed.success) return fail("validation", "请选择公司、补充线索或跳过");
    return this.repository.transaction(() => {
      const state = this.repository.state(runId); const run = this.repository.business.getRun(runId);
      if (!state || !run) return fail("not_found", "深研不存在");
      if (run.status !== "needs_attention" || state.resolution.version !== parsed.data.expectedVersion) return fail("version_conflict", "公司确认状态已更新，请刷新");
      if (!this.repository.isCurrent(runId)) return fail("domain_precondition", "输入已改变，请取消并重新初筛");
      const response = parsed.data;
      if (response.action === "select") {
        const candidate = state.resolution.candidates.find(c => c.id === response.candidateId); if (!candidate) return fail("validation", "候选公司不存在");
        const company = this.repository.confirm(candidate, this.now()); state.companyId = company.id; state.resolution.selectedId = candidate.id; state.resolution.status = "confirmed";
      } else if (response.action === "skip") state.resolution.status = "skipped";
      else { state.resolution.hint = redactSearch(response.hint); state.resolution.candidates = []; }
      state.resolution.version++; state.diagnostic = undefined; this.repository.saveState(state); this.enqueue(runId);
      return ok(this.repository.business.getRun(runId)!);
    });
  }
  enqueue(runId: string) {
    const jobId = crypto.randomUUID(); const now = this.now();
    this.dependencies.jobs.create({ id: jobId, type: "deep-research", payload: { runId }, now });
    this.repository.db.prepare("UPDATE research_runs SET job_id=? WHERE id=?").run(jobId, runId);
    this.repository.business.updateRun(runId, { status: "queued" }, now);
  }
  wakeWaiting() {
    // Job recovery can exhaust retries while no handler is alive to update its Run.
    const interrupted = this.repository.db.prepare("SELECT r.id,j.status FROM research_runs r JOIN jobs j ON j.id=r.job_id WHERE r.kind='deep_research' AND r.status IN ('running','queued','cancelling') AND j.status IN ('failed','cancelled')").all() as { id: string; status: "failed" | "cancelled" }[];
    for (const row of interrupted) this.repository.transaction(() => {
      const state = this.repository.state(row.id);
      if (state) { state.elapsedMs += Math.max(0, this.now().getTime() - (state.activeSince ?? this.now().getTime())); state.activeSince = null; state.error = row.status === "failed" ? "执行中断且重试次数已耗尽" : null; this.repository.saveState(state); }
      this.repository.business.updateRun(row.id, { status: row.status }, this.now()); this.repository.releaseRefresh(row.id);
    });
    const rows = this.repository.db.prepare("SELECT id FROM research_runs WHERE kind='deep_research' AND status='waiting'").all() as { id: string }[];
    for (const { id } of rows) this.repository.transaction(() => {
      const state = this.repository.state(id); if (!state) return;
      const dependency = state.dependencyRunId ? this.repository.business.getRun(state.dependencyRunId) : null;
      const refresh = state.companyId ? this.repository.db.prepare("SELECT run_id FROM company_refreshes WHERE company_id=?").get(state.companyId) : null;
      if (!refresh || !dependency || !activeStatuses.includes(dependency.status)) { state.dependencyRunId = null; state.refreshCompany = false; this.repository.saveState(state); this.enqueue(id); }
    });
  }
  async cancel(runId: string): Promise<UseCaseResult<ResearchRun>> {
    return this.repository.transaction(() => {
      const run = this.repository.business.getRun(runId); if (!run || run.kind !== "deep_research") return fail("not_found", "深研不存在");
      if (!activeStatuses.includes(run.status)) return ok(run);
      this.dependencies.jobs.requestCancellation(run.jobId, this.now());
      const running = run.status === "running" || run.status === "cancelling";
      this.repository.business.updateRun(runId, { status: running ? "cancelling" : "cancelled" }, this.now());
      if (!running) this.repository.releaseRefresh(runId);
      return ok(this.repository.business.getRun(runId)!);
    });
  }
  async retry(runId: string): Promise<UseCaseResult<CommandReceipt>> {
    return this.repository.transaction(() => {
      const run = this.repository.business.getRun(runId); const state = this.repository.state(runId);
      if (!run || !state) return fail("not_found", "深研不存在");
      if (run.status !== "failed") return fail("domain_precondition", "只有失败的深研可以重试");
      if (run.successorRunId) return ok({ id: run.successorRunId, resourceId: run.successorRunId, created: false });
      const childId = crypto.randomUUID(); const jobId = crypto.randomUUID(); const now = this.now(); const context = this.repository.business.getRunContext(runId)!;
      this.dependencies.jobs.create({ id: jobId, type: "deep-research", payload: { runId: childId }, now });
      this.repository.business.createRun({ ...run, id: childId, jobId, status: "queued", reportId: null, parentRunId: run.id, successorRunId: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }, { profile: context.profileSnapshotId, job: context.jobSnapshotId });
      this.repository.saveState({ ...state, runId: childId, dependencyRunId: null, activeSince: null, error: null, diagnostic: undefined, round: 0, emptyRounds: 0, questions: state.questions.map(q => ({ ...q, answered: false })) });
      // Completed I/O/model attempts are reusable, but final report and owner-bound claims are rebuilt.
      const rows = this.repository.db.prepare("SELECT stage,result_json FROM stage_checkpoints WHERE run_id=? AND stage LIKE 'io:%'").all(runId) as { stage: string; result_json: string }[];
      for (const row of rows) this.repository.business.saveCheckpoint(childId, row.stage, JSON.parse(row.result_json), now);
      this.repository.business.updateRun(runId, { successorRunId: childId }, now); return ok({ id: childId, resourceId: childId, created: true });
    });
  }
}
class BudgetReached extends Error {}
const questionText: Record<(typeof DIMENSION_IDS)[number], string> = {
  people_and_company_reliability: "主体、团队、产品与经营信息有哪些可靠依据？", life_radius: "实际办公地点和出勤安排是否明确？", compensation_package: "薪资结构、发薪月数和总包是否明确？", workload_and_role_boundaries: "工作时间、团队配置与职责边界是否明确？", work_content: "日常工作与产品方向是否匹配候选人经历？", career_growth: "岗位成长机会与候选人的发展方向是否匹配？",
};
export function createDeepResearchHandler(application: DeepResearchApplication) {
  const { repository: r, search, reader, models, mode } = application.dependencies; const b = r.business; const now = application.dependencies.now ?? (() => new Date());
  const execute = async ({ job, signal: parentSignal, reportProgress }: JobHandlerContext) => {
    const runId = (job.input as { runId: string }).runId; const ctx = b.getRunContext(runId); let state = r.state(runId);
    if (!ctx || !state) throw new Error("research_context_missing");
    if (["cancelled", "completed", "superseded"].includes(ctx.run.status)) return { resultRef: ctx.run.reportId };
    if (state.mode !== mode) throw new Error("research_mode_changed");
    const model = mode === "demo" ? new DemoResearchModel() : models instanceof ModelGatewayResolver ? models.resolve(ctx.run.modelConfig ?? LOCAL_MODEL_CONFIG) : models;
    const runState: ResearchState = state;
    if (!runState.sourceReadSummary) runState.sourceReadSummary = emptySourceReadSummary();
    let currentStage: DeepResearchStage | null = ctx.run.currentStage as DeepResearchStage | null;
    const interruptedMs = runState.activeSince === null ? 0 : Math.max(0, now().getTime() - runState.activeSince);
    const remainingMs = Math.max(1, (runState.policy?.maxElapsedMs ?? 1_800_000) - runState.elapsedMs - interruptedMs);
    let signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.ceil(remainingMs))]);
    const candidateProfile = ctx.profileSnapshot.profile;
    const save = () => { signal.throwIfAborted(); if (runState.activeSince !== null) { runState.elapsedMs += Math.max(0, now().getTime() - runState.activeSince); runState.activeSince = now().getTime(); } r.saveState(runState); };
    // A crashed process cannot reset its budget; conservative elapsed time includes the interruption.
    if (runState.activeSince !== null) runState.elapsedMs += Math.max(0, now().getTime() - runState.activeSince);
    runState.activeSince = now().getTime(); b.updateRun(runId, { status: "running", error: null }, now()); save();
    const check = () => { signal.throwIfAborted(); if (runState.calls >= (runState.policy?.maxCalls ?? 100) || runState.elapsedMs + (now().getTime() - (runState.activeSince ?? now().getTime())) >= (runState.policy?.maxElapsedMs ?? 1_800_000)) throw new BudgetReached(); };
    async function io<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const checkpoint = b.getCheckpoint(runId, `io:${key}`); if (checkpoint !== null) return checkpoint as T;
      check(); runState.calls++; save(); const value = await operation(); signal.throwIfAborted(); save(); b.saveCheckpoint(runId, `io:${key}`, value, now()); return value;
    }
    const stage = (name: DeepResearchStage, progress: number) => { signal.throwIfAborted(); currentStage = name; b.updateRun(runId, { currentStage: name }, now()); reportProgress(progress); };
    const docs = () => runState.documentIds.map(id => r.source(id)).filter((doc): doc is SourceDocument => doc !== null);
    const inputSource = (kind: "job" | "resume", text: string) => {
      const id = `input:${runId}:${kind}`; if (!r.source(id)) r.saveSource({ id, kind, title: kind === "job" ? "已确认岗位" : "候选人简历（已脱敏）", text, url: null, finalUrl: null, contentHash: hash(text), retrievedAt: now().toISOString(), method: "input", sourceType: "user_provided" });
      if (!runState.documentIds.includes(id)) runState.documentIds.push(id);
    };
    inputSource("job", redactResumeText(JSON.stringify({ fields: ctx.jobSnapshot.draft.fields, sourceText: ctx.jobSnapshot.sourceText }))); inputSource("resume", redactResumeText(ctx.profileSnapshot.profile.resumeText)); save();
    async function persistSource(doc: SourceDocument): Promise<SourceDocument> {
      r.saveSource(doc);
      if (!runState.documentIds.includes(doc.id)) runState.documentIds.push(doc.id);
      save();
      return r.source(doc.id)!;
    }
    function sourceFromPage(result: SearchResult, page: Extract<PageResult, { status: "ok" }>, retrievedAt: string): SourceDocument {
      const contentHash = hash(page.text);
      return { id: `web:${hash(page.url + contentHash)}`, kind: "web", url: result.url, finalUrl: page.url, title: page.title, text: page.text, contentHash, retrievedAt, method: page.method, sourceType: "unknown" };
    }
    function sourceFromSnippet(result: SearchResult, retrievedAt: string): SourceDocument | null {
      const text = buildSnippetSourceText(result);
      if (!text) return null;
      const contentHash = hash(text);
      return { id: `search:${hash(result.url + contentHash)}`, kind: "web", url: result.url, finalUrl: result.url, title: result.title || result.url, text, contentHash, retrievedAt, method: "search_snippet", sourceType: "third_party" };
    }
    async function ingestSearchResult(result: SearchResult, options?: { recordHit?: boolean }): Promise<SourceDocument | null> {
      const page = await io(`page:${hash(result.url)}`, () => reader.read(result.url, signal));
      if (page.status === "ok") {
        recordSourceRead(runState.sourceReadSummary!, "success");
        const doc = await persistSource(sourceFromPage(result, page, now().toISOString()));
        if (options?.recordHit) runState.searchHits!.push({ url: result.url, title: result.title, snippet: result.snippet, readStatus: "ok" });
        return doc;
      }
      recordSourceRead(runState.sourceReadSummary!, "failure", page.reason);
      if (!runState.sourceFailures.includes(page.reason)) runState.sourceFailures.push(page.reason);
      const snippetDoc = sourceFromSnippet(result, now().toISOString());
      const readStatus = snippetDoc ? "snippet" as const : page.status === "blocked" ? "blocked" as const : "failed" as const;
      if (options?.recordHit) runState.searchHits!.push({ url: result.url, title: result.title, snippet: result.snippet, readStatus });
      if (snippetDoc) return persistSource(snippetDoc);
      save();
      return null;
    }
    async function gather(query: string, key: string): Promise<SourceDocument[]> {
      const results = await io(`search:${key}`, () => search.search(redactSearch(query), signal));
      const found: SourceDocument[] = [];
      for (const result of results.slice(0, 5)) {
        const doc = await ingestSearchResult(result);
        if (doc) found.push(doc);
      }
      return found;
    }
    async function claimsFor(documents: SourceDocument[], ownerType: "company" | "run", ownerId: string, key: string, focus?: string) {
      // Search snippets are identity leads, not verified page evidence for report claims.
      const unique = [...new Map(documents.filter(doc => doc.method !== "search_snippet").map(doc => [doc.contentHash, doc])).values()];
      const company = runState.companyId ? r.company(runState.companyId) : null;
      const material = unique.map(doc => ({ id: doc.id, kind: doc.kind, title: doc.title, url: doc.finalUrl, sourceType: company?.website && doc.finalUrl && new URL(doc.finalUrl).hostname === new URL(company.website).hostname ? "official" : doc.sourceType, text: doc.text.slice(0, 12_000) })).slice(0, 12);
      if (!material.length) return { claims: [] as DeepClaim[], evidence: [] as EvidenceLink[] };
      const proposals = await io(`claims:${key}`, () => researchModel(model, "extract-research-claims", ClaimProposalSchema, { scope: ownerType, company, questions: ownerType === "company" ? [focus ?? topics.join("、")] : runState.questions, ...(ownerType === "run" ? { preferences: JSON.parse(redactResumeText(JSON.stringify({ targetRoles: candidateProfile.targetRoles, targetLocations: candidateProfile.targetLocations, highlights: candidateProfile.highlights, constraints: candidateProfile.constraints, redFlags: candidateProfile.redFlags, salary: candidateProfile.salary }))) } : {}), documents: material }, signal));
      const verification = await io(`verify:${key}`, () => researchModel(model, "verify-evidence", VerificationSchema, { claims: proposals.claims, documents: material, focus: focus ?? null }, signal));
      return materializeClaims(proposals.claims, unique, verification, ownerType, ownerId);
    }
    let allClaims: DeepClaim[] = []; let allEvidence: EvidenceLink[] = [];
    try {
      stage("resolve_company", 5);
      if (runState.resolution.status === "pending") {
        const companyText = String(ctx.jobSnapshot.draft.fields.company.value ?? "");
        const searchKey = `identity:${runState.resolution.version}`;
        let searchResults: Awaited<ReturnType<SearchPort["search"]>>;
        searchResults = await io(`search:${searchKey}`, () => search.search(redactSearch(`${companyText} ${ctx.jobSnapshot.draft.fields.location.value ?? ""} ${runState.resolution.hint} 官网 公司 主体`), signal));
        const documents: SourceDocument[] = [];
        runState.searchHits = [];
        for (const result of searchResults.slice(0, 5)) {
          const doc = await ingestSearchResult(result, { recordHit: true });
          if (doc) documents.push(doc);
        }
        if (documents.length === 0) {
          runState.diagnostic = searchResults.length > 0 ? insufficientCompanySourcesDiagnostic() : ambiguousCompanyDiagnostic();
          runState.activeSince = null; save(); b.updateRun(runId, { status: "needs_attention" }, now()); return {};
        }
        const proposed = await io(`identity-model:${runState.resolution.version}`, () => researchModel(model, "resolve-company", CompanyProposalSchema, { company: companyText, location: ctx.jobSnapshot.draft.fields.location.value, hint: runState.resolution.hint, documents: identityModelDocuments(documents) }, signal));
        runState.resolution.candidates = proposed.candidates.filter(candidate => candidate.basis.every(link => documents.some(doc => doc.id === link.documentId && doc.text.includes(link.quote))));
        const candidate = runState.resolution.candidates[0];
        // Only exact employing-entity name, website origin and literal name evidence allow automatic selection.
        const exact = candidate && runState.resolution.candidates.length === 1 && candidate.legalName === companyText && candidate.website && candidate.basis.some(link => { const doc = documents.find(d => d.id === link.documentId); return doc?.method !== "search_snippet" && doc?.finalUrl && new URL(doc.finalUrl).hostname === new URL(candidate.website!).hostname && link.quote.includes(companyText); });
        if (exact && mode === "live") { const company = r.confirm(candidate, now()); runState.companyId = company.id; runState.resolution.status = "confirmed"; runState.resolution.selectedId = candidate.id; save(); }
        else { runState.diagnostic = ambiguousCompanyDiagnostic(); runState.activeSince = null; save(); b.updateRun(runId, { status: "needs_attention" }, now()); return {}; }
      }
      if (!r.isCurrent(runId)) { runState.activeSince = null; save(); b.updateRun(runId, { status: "superseded" }, now()); r.releaseRefresh(runId); return {}; }
      stage("company_snapshot", 15);
      let snapshot: CompanySnapshot | null = runState.companySnapshotId ? r.snapshot(runState.companySnapshotId) : null;
      if (runState.companyId && !snapshot) {
        snapshot = !runState.refreshCompany ? r.snapshots(runState.companyId).find(s => s.mode === mode && Date.parse(s.expiresAt) > now().getTime() && topics.every(topic => s.topics.includes(topic))) ?? null : null;
        if (!snapshot) {
          const owner = r.acquireRefresh(runState.companyId, runId);
          if (owner !== runId) { runState.dependencyRunId = owner; runState.activeSince = null; save(); b.updateRun(runId, { status: "waiting" }, now()); return {}; }
          const company = r.company(runState.companyId)!;
          const companyDocs: SourceDocument[] = [];
          const snapshotId = `company-snapshot:${runId}`; const coveredTopics: string[] = [];
          const companyClaims: DeepClaim[] = []; const companyEvidence: EvidenceLink[] = [];
          for (const topic of topics) {
            const topicDocs = await gather(`${company.name} ${company.legalName ?? ""} ${topic}`, `company:${topic}`);
            companyDocs.push(...topicDocs);
            const collected = await claimsFor(topicDocs, "company", snapshotId, `company:${topic}`, topic);
            if (collected.claims.some(c => c.status === "supported")) coveredTopics.push(topic);
            const fresh = collected.claims.filter(c => !companyClaims.some(previous => previous.statement === c.statement));
            companyClaims.push(...fresh); companyEvidence.push(...collected.evidence.filter(e => fresh.some(c => c.id === e.claimId)));
            allClaims = [...companyClaims]; allEvidence = [...companyEvidence];
          }
          snapshot = { id: snapshotId, companyId: company.id, claims: companyClaims, evidence: companyEvidence, documentIds: [...new Set(companyDocs.map(d => d.id))], topics: coveredTopics, mode, createdAt: now().toISOString(), expiresAt: new Date(now().getTime() + 7 * 86400_000).toISOString() };
          signal.throwIfAborted();
          r.transaction(() => { r.saveSnapshot(snapshot!); runState.companySnapshotId = snapshot!.id; save(); r.releaseRefresh(runId); });
        }
        runState.companySnapshotId = snapshot.id; runState.documentIds = [...new Set([...runState.documentIds, ...snapshot.documentIds])]; save();
      }
      if (snapshot) { allClaims = [...snapshot.claims]; allEvidence = [...snapshot.evidence]; }
      stage("build_research_plan", 30);
      if (!runState.questions.length) runState.questions = DIMENSION_IDS.map(dimension => ({ id: dimension, dimension, question: questionText[dimension], query: `${runState.companyId ? r.company(runState.companyId)?.name : ""} ${ctx.jobSnapshot.draft.fields.title.value ?? ""} ${questionText[dimension]}`, answered: false }));
      save();
      const accumulated = b.getCheckpoint(runId, "accumulated-claims") as { claims: DeepClaim[]; evidence: EvidenceLink[] } | null;
      if (accumulated) { allClaims = accumulated.claims; allEvidence = accumulated.evidence; }
      while (runState.emptyRounds < 2 && runState.questions.some(q => !q.answered)) {
        check(); stage("gather_sources", Math.min(65, 35 + runState.round * 10));
        const pending = runState.questions.filter(q => !q.answered);
        if (runState.companyId) for (const question of pending) await gather(`${question.query}${runState.round > 0 ? " 核实 争议 最新" : ""}`, `round:${runState.round}:${question.id}`);
        stage("build_claims", 70);
        // Skipping identity excludes every unconfirmed company's web document.
        const material = docs().filter(doc => runState.companyId || doc.kind !== "web");
        const built = await claimsFor(material, "run", runId, `round:${runState.round}`);
        const fresh = built.claims.filter(claim => !allClaims.some(c => c.statement === claim.statement && c.ownerType === claim.ownerType));
        allClaims.push(...fresh); allEvidence.push(...built.evidence.filter(link => fresh.some(c => c.id === link.claimId)));
        const added = fresh.filter(c => c.status === "supported").length; runState.emptyRounds = added ? 0 : runState.emptyRounds + 1;
        runState.questions = runState.questions.map(q => ({ ...q, answered: allClaims.some(c => c.dimension === q.dimension && c.status === "supported") && (q.dimension !== "people_and_company_reliability" || !!runState.companyId) }));
        runState.round++;
        // Accumulation and loop cursor commit together; no claim loss or duplicated rounds after restart.
        r.transaction(() => { r.db.prepare("DELETE FROM stage_checkpoints WHERE run_id=? AND stage='accumulated-claims'").run(runId); b.saveCheckpoint(runId, "accumulated-claims", { claims: allClaims, evidence: allEvidence }, now()); save(); });
      }
      if (!runState.stopReason) runState.stopReason = runState.questions.every(q => q.answered) ? "coverage_met" : "no_new_evidence";
    } catch (error) {
      if (error instanceof BudgetReached || (signal.aborted && !parentSignal.aborted)) {
        signal = parentSignal;
        runState.stopReason = "budget_exhausted";
        if (runState.companyId && !runState.companySnapshotId && allClaims.some(c => c.ownerType === "company")) {
          const snapshot: CompanySnapshot = { id: `company-snapshot:${runId}`, companyId: runState.companyId, claims: allClaims.filter(c => c.ownerType === "company"), evidence: allEvidence.filter(e => allClaims.some(c => c.ownerType === "company" && c.id === e.claimId)), documentIds: [...new Set(allEvidence.map(e => e.documentId))].filter(id => r.source(id)?.kind === "web"), topics: [], mode, createdAt: now().toISOString(), expiresAt: new Date(now().getTime() + 7 * 86400_000).toISOString() };
          r.transaction(() => { r.saveSnapshot(snapshot); runState.companySnapshotId = snapshot.id; save(); });
        }
      }
      else throw error;
    }
    signal.throwIfAborted(); stage("assess_dimensions", 85);
    if (!runState.companyId) allClaims = allClaims.filter(c => c.dimension !== "people_and_company_reliability");
    allEvidence = allEvidence.filter(e => allClaims.some(c => c.id === e.claimId));
    const dimensions = Object.fromEntries(DIMENSION_IDS.map(dimension => {
      const claims = allClaims.filter(c => c.dimension === dimension && ["supported", "contested"].includes(c.status));
      const contested = claims.some(c => c.status === "contested"); const supported = claims.filter(c => c.status === "supported");
      return [dimension, { verdict: contested ? "mixed" : aggregateVerdict(supported.map(c => c.polarity)) ?? "unknown", confidence: supported.length ? "medium" : "low", claimIds: claims.map(c => c.id), risks: claims.filter(c => c.polarity === "negative" || c.status === "contested").map(c => c.statement), unknowns: supported.length ? [] : [`请向 HR 核实：${questionText[dimension]}`] }];
    })) as DeepResearchReport["dimensions"];
    const profile = ctx.profileSnapshot.profile;
    const pkg = compensationPackage(ctx.jobSnapshot.draft.fields.salaryMinMonthly.value as number | null, ctx.jobSnapshot.draft.fields.salaryMaxMonthly.value as number | null, ctx.jobSnapshot.draft.fields.payMonths.value as number | null);
    const supported = allClaims.filter(c => c.status === "supported");
    const blockingFlags = profile.redFlags.filter(f => f.level === "blocking" && supported.some(c => c.polarity === "negative" && c.statement.includes(f.text))).map(f => f.text);
    const requiredMisses = profile.constraints.filter(f => f.level === "required" && supported.some(c => c.polarity === "negative" && c.statement.includes(f.text))).map(f => f.text);
    const salaryMax = ctx.jobSnapshot.draft.fields.salaryMaxMonthly.value;
    if (typeof salaryMax === "number" && profile.salary != null && salaryMax < profile.salary.minMonthly) requiredMisses.push("岗位月薪上限低于期望底线");
    const decision = recommend({ requiredMisses, blockingFlags, coreEvidenceCount: supported.length, verdicts: Object.fromEntries(DIMENSION_IDS.map(d => [d, dimensions[d].verdict])), weights: profile.weights });
    stage("deep_research_report", 95);
    const effective = r.isCurrent(runId); const partial = runState.stopReason !== "coverage_met" || runState.sourceFailures.length > 0 || !runState.companyId || DIMENSION_IDS.some(d => dimensions[d].verdict === "unknown");
    const report: DeepResearchReport = { schemaVersion: 1, id: `deep-report:${runId}`, runId, opportunityId: ctx.run.opportunityId, companySnapshotId: runState.companySnapshotId, status: !effective ? "stale" : partial ? "partial" : "complete", effective, recommendation: decision.recommendation, dimensions, claims: allClaims, evidence: allEvidence, documentIds: [...new Set(allEvidence.map(e => e.documentId))], risks: DIMENSION_IDS.flatMap(d => dimensions[d].risks), unknowns: [...DIMENSION_IDS.flatMap(d => dimensions[d].unknowns), ...runState.sourceFailures.map(f => `部分来源未能读取：${f}`), ...(runState.stopReason === "model_degraded" ? [claimsModelFailedDiagnostic().message] : [])], rules: [...decision.rules, ...(pkg?.assumed ? ["发薪月数未注明，按 12 薪估算"] : [])], stopReason: runState.stopReason ?? "no_new_evidence", mode, modelConfig: ctx.run.modelConfig ?? LOCAL_MODEL_CONFIG, createdAt: now().toISOString() };
    reportProgress(100);
    r.transaction(() => { signal.throwIfAborted(); save(); runState.activeSince = null; r.saveState(runState); r.saveReport(report); r.releaseRefresh(runId); b.updateRun(runId, { status: "completed", reportId: report.id }, now()); b.appendRunEvent(runId, "run_completed", { reportId: report.id }, now()); });
    return { resultRef: report.id };
  };
  return async (context: JobHandlerContext) => {
    try { return await execute(context); }
    catch (error) {
      const runId = (context.job.input as { runId: string }).runId;
      const job = application.dependencies.jobs.get(context.job.id);
      // A worker that lost its lease must never overwrite a successor worker's results.
      if (job?.status === "running" && job.leaseOwner === context.job.leaseOwner && job.leaseExpiresAt && job.leaseExpiresAt.getTime() > now().getTime()) {
        const current = r.state(runId);
        if (current) {
          current.elapsedMs += Math.max(0, now().getTime() - (current.activeSince ?? now().getTime())); current.activeSince = null;
          const cancelled = application.dependencies.jobs.isCancellationRequested(job.id);
          const retryable = !cancelled && error instanceof Error && "retryable" in error && error.retryable === true && job.attempts < job.maxAttempts;
          const failedStage = (b.getRun(runId)?.currentStage ?? null) as DeepResearchStage | null;
          if (!cancelled) {
            const diagnostic = classifyResearchFailure(error, failedStage);
            current.diagnostic = diagnostic;
            current.error = diagnostic.message;
          } else current.error = null;
          r.transaction(() => { r.saveState(current); b.updateRun(runId, { status: cancelled ? "cancelled" : retryable ? "queued" : "failed", error: current.error ? { code: "deep_research_failed", message: current.error } : null }, now()); if (!retryable) r.releaseRefresh(runId); });
        }
      }
      throw error;
    }
  };
}

/** Deliberately synthetic: never presents guessed facts about the user's actual company. */
export class DemoResearchModel implements ModelGateway {
  readonly descriptor = { provider: "local" as const, model: "local-demo", label: "离线合成研究演示" };
  async generateStructured<T>(request: ModelRequest<T>): Promise<T> {
    request.signal?.throwIfAborted();
    const input = request.input as { documents?: { id: string; text: string }[]; claims?: unknown[]; scope?: string; questions?: string[] };
    if (request.task === "resolve-company") {
      const doc = input.documents?.find(d => d.text.includes("合成示例公司"));
      return request.validate({ candidates: doc ? [{ id: "demo-company", name: "合成示例公司（离线演示）", website: "https://demo.example", legalName: null, location: null, aliases: [], basis: [{ documentId: doc.id, quote: "合成示例公司" }] }] : [] });
    }
    if (request.task === "verify-evidence") return request.validate({ results: (input.claims ?? []).map((_, index) => ({ index, supported: true, contested: false })) });
    const topicQuotes: Record<string, string> = { "主体与品牌": "合成示例公司", "产品业务": "团队开发 AI 工作流产品", "团队": "合成团队包含工程与设计岗位", "融资经营": "融资与经营数据未公开", "公开招聘": "招聘岗位参与 TypeScript 产品开发", "风险信息": "工作时间需要向 HR 核实" };
    const quote = input.scope === "company" ? topicQuotes[input.questions?.[0] ?? ""] ?? "团队开发 AI 工作流产品" : "团队开发 AI 工作流产品";
    const doc = input.documents?.find(d => d.text.includes(quote));
    return request.validate({ claims: doc ? [{ dimension: input.scope === "company" ? "people_and_company_reliability" : "work_content", statement: `离线合成资料自述：${quote}`, polarity: "mixed", confidence: "low", attribution: "离线合成资料，不代表目标公司事实", evidence: [{ documentId: doc.id, quote, relation: "supports" }] }] : [] });
  }
}
