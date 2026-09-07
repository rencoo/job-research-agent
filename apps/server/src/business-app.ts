import { createHash } from "node:crypto";
import {
  ConfirmDraftSchema, DIMENSION_IDS, DraftPatchSchema, ImportBatchInputSchema,
  LOCAL_MODEL_CONFIG,
  ProfileInputSchema, ProfileSchema, type DraftField, type ImportBatch, type JobDraft,
  type ExtractedJob, type ModelInvocationConfig, type OpportunityDetail, type Profile, type ResearchClaim,
  type ResearchRun, type ScreeningReport,
} from "@job-research/contracts";
import type {
  CommandReceipt, IngestionApplication, OpportunityApplication, ProfileApplication,
  ResearchApplication, UseCaseResult,
} from "@job-research/application";
import { aggregateVerdict, BusinessRuleError, canConfirmDraft, compensationPackage, normalizeWeights, recommend, type Verdict } from "@job-research/domain";
import { BusinessRepository, JobRepository, PersistenceConflictError } from "@job-research/database";
import {
  ModelGatewayError,
  ModelGatewayResolver,
  type ModelGateway,
} from "@job-research/model-gateway";
import {
  buildExtractionModelRequest,
  buildScreeningModelRequest,
} from "./model-prompts";

const ok = <T>(value: T): UseCaseResult<T> => ({ ok: true, value });
const fail = <T>(code: "validation" | "not_found" | "version_conflict" | "domain_precondition" | "infrastructure_unavailable", message: string, retryable = false): UseCaseResult<T> => ({ ok: false, error: { code, message, retryable } });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const id = () => crypto.randomUUID();

function translate<T>(operation: () => T): UseCaseResult<T> {
  try { return ok(operation()); }
  catch (error) {
    if (error instanceof PersistenceConflictError) return fail("version_conflict", error.message);
    if (error instanceof BusinessRuleError) return fail("domain_precondition", error.message);
    return fail("infrastructure_unavailable", error instanceof Error ? error.message : "Unexpected error", true);
  }
}

export class LocalProfileApplication implements ProfileApplication {
  constructor(private readonly repository: BusinessRepository, private readonly now = () => new Date()) {}
  async getCurrent(): Promise<UseCaseResult<Profile | null>> { return translate(() => this.repository.getProfile()); }
  async save(raw: unknown): Promise<UseCaseResult<Profile>> {
    const parsed = ProfileInputSchema.safeParse(raw);
    if (!parsed.success) return fail("validation", parsed.error.issues[0]?.message ?? "Invalid profile");
    return translate(() => this.repository.transaction(() => {
      const current = this.repository.getProfile();
      const normalized = normalizeWeights(parsed.data.weights);
      const resumeChanged = current?.resumeText !== parsed.data.resumeText;
      const now = this.now();
      const profile = ProfileSchema.parse({
        ...parsed.data, id: "current", weights: normalized.weights,
        weightInputs: parsed.data.weights,
        explicitWeightDimensions: normalized.explicit,
        resumeVersion: current ? current.resumeVersion + Number(resumeChanged) : 1,
        profileVersion: (current?.profileVersion ?? 0) + 1,
        version: (current?.version ?? 0) + 1, updatedAt: now.toISOString(),
      });
      this.repository.saveProfile(profile, parsed.data.expectedVersion);
      if (current && (current.resumeText !== profile.resumeText || current.profileVersion !== profile.profileVersion)) {
        const opportunities = this.repository.listOpportunities();
        for (const opportunity of opportunities) this.repository.markReportsStale(opportunity.id);
      }
      return profile;
    }));
  }
}

export class LocalIngestionApplication implements IngestionApplication {
  constructor(
    private readonly repository: BusinessRepository,
    private readonly jobs: JobRepository,
    private readonly now = () => new Date(),
    private readonly modelConfig: ModelInvocationConfig = LOCAL_MODEL_CONFIG,
  ) {}
  async importBatch(raw: unknown, idempotencyKey: string): Promise<UseCaseResult<CommandReceipt>> {
    const parsed = ImportBatchInputSchema.safeParse(raw);
    if (!parsed.success || !idempotencyKey.trim()) return fail("validation", parsed.success ? "Idempotency-Key is required" : parsed.error.issues[0]?.message ?? "Invalid batch");
    return translate(() => this.repository.transaction(() => {
      const payloadHash = hash(parsed.data);
      const existing = this.repository.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.commandType !== "import-batch" || existing.payloadHash !== payloadHash) throw new PersistenceConflictError("idempotency_conflict", "Idempotency key already used with different payload");
        return existing.receipt as CommandReceipt;
      }
      const now = this.now();
      const batchId = id();
      const items = parsed.data.items.map(({ text }) => {
        const itemId = id(); const opportunityId = id();
        const urlOnly = /^https?:\/\/\S+$/i.test(text.trim());
        const jobId = urlOnly ? null : id();
        return { id: itemId, opportunityId, text: text.trim(), status: urlOnly ? "needs_input" : "queued", jobId };
      });
      for (const item of items) if (item.jobId) this.jobs.create({ id: item.jobId, type: "extract-job-draft", payload: { importItemId: item.id, modelConfig: this.modelConfig }, now });
      this.repository.createImport({ batchId, now, items });
      const receipt = { id: batchId, resourceId: batchId, created: true };
      this.repository.saveIdempotency({ key: idempotencyKey, commandType: "import-batch", aggregateId: batchId, payloadHash, receipt, now });
      return receipt;
    }));
  }
  async getBatch(batchId: string): Promise<UseCaseResult<ImportBatch>> { const result = translate(() => this.repository.getImportBatch(batchId)); if (!result.ok) return result; return result.value ? ok(result.value) : fail<ImportBatch>("not_found", "Import batch not found"); }
  async retryItem(itemId: string): Promise<UseCaseResult<CommandReceipt>> {
    const item = this.repository.getImportItem(itemId);
    if (!item) return fail("not_found", "Import item not found");
    if (item.status !== "failed") return fail("domain_precondition", "Only failed items can be retried");
    return translate(() => this.repository.transaction(() => {
      const now = this.now(); const jobId = id();
      this.jobs.create({ id: jobId, type: "extract-job-draft", payload: { importItemId: item.id, modelConfig: this.modelConfig }, now });
      this.repository.updateImportItem(item.id, "queued", now, { jobId, error: null });
      return { id: jobId, resourceId: item.id, created: true };
    }));
  }
}

export class LocalOpportunityApplication implements OpportunityApplication {
  constructor(private readonly repository: BusinessRepository, private readonly now = () => new Date()) {}
  async list(query: { keyword?: string; status?: string; recommendation?: string }) { return translate(() => this.repository.listOpportunities(query)); }
  async get(opportunityId: string): Promise<UseCaseResult<OpportunityDetail>> { const result = translate(() => this.repository.getOpportunity(opportunityId)); if (!result.ok) return result; return result.value ? ok(result.value) : fail<OpportunityDetail>("not_found", "Opportunity not found"); }
  async updateDraft(opportunityId: string, raw: unknown) {
    const parsed = DraftPatchSchema.safeParse(raw);
    if (!parsed.success) return fail<JobDraft>("validation", parsed.error.issues[0]?.message ?? "Invalid draft");
    return translate(() => this.repository.transaction(() => {
      const current = this.repository.getDraft(opportunityId);
      if (!current) throw new BusinessRuleError("not_found", "Draft not found");
      if (current.version !== parsed.data.expectedVersion) throw new PersistenceConflictError("version_conflict", "Draft version changed");
      const nextFields = { ...current.fields, ...Object.fromEntries(Object.entries(parsed.data.fields).map(([key, field]) => [key, { ...(field as DraftField), source: "user", revision: (current.fields[key as keyof typeof current.fields].revision ?? 0) + 1 }])) };
      const next: JobDraft = { ...current, fields: nextFields, version: current.version + 1, status: "draft", confirmedAt: null, confirmedVersion: null };
      this.repository.saveDraft(next, current.version, this.now());
      this.repository.markReportsStale(opportunityId);
      return this.repository.getDraft(opportunityId)!;
    }));
  }
  async confirmDraft(opportunityId: string, raw: unknown) {
    const parsed = ConfirmDraftSchema.safeParse(raw);
    if (!parsed.success) return fail<JobDraft>("validation", parsed.error.issues[0]?.message ?? "Invalid confirmation");
    return translate(() => this.repository.transaction(() => {
      const current = this.repository.getDraft(opportunityId);
      if (!current) throw new BusinessRuleError("not_found", "Draft not found");
      if (current.version !== parsed.data.expectedVersion) throw new PersistenceConflictError("version_conflict", "Draft version changed");
      if (!canConfirmDraft({ title: current.fields.title.value, responsibilities: current.fields.responsibilities.value, requirements: current.fields.requirements.value })) throw new BusinessRuleError("incomplete_draft", "岗位名称及职责或要求不能为空");
      const now = this.now();
      const next: JobDraft = { ...current, status: "confirmed", version: current.version + 1, confirmedAt: now.toISOString(), confirmedVersion: current.version + 1 };
      this.repository.saveDraft(next, current.version, now);
      return this.repository.getDraft(opportunityId)!;
    }));
  }
}

type ModelSource = ModelGateway | ModelGatewayResolver;

function resolveModel(source: ModelSource, config: ModelInvocationConfig): ModelGateway {
  return source instanceof ModelGatewayResolver ? source.resolve(config) : source;
}

export function createExtractionHandler(repository: BusinessRepository, models: ModelSource, now = () => new Date()) {
  return async ({ job, signal, reportProgress }: { job: { id: string; input: unknown; attempts?: number; maxAttempts?: number }; signal: AbortSignal; reportProgress(value: number): void }) => {
    const payload = job.input as { importItemId?: string; modelConfig?: ModelInvocationConfig };
    const importItemId = payload.importItemId;
    if (!importItemId) throw new Error("Missing import item");
    const item = repository.getImportItem(importItemId);
    if (!item) throw new Error("Import item not found");
    const modelConfig = payload.modelConfig ?? LOCAL_MODEL_CONFIG;
    const model = resolveModel(models, modelConfig);
    repository.updateImportItem(item.id, "extracting", now()); reportProgress(20);
    try {
      const extracted = await model.generateStructured(buildExtractionModelRequest(
        item.sourceText,
        signal,
        modelConfig.promptVersions.extractJobDraft,
      ));
      repository.transaction(() => mergeExtraction(repository, item.opportunityId, extracted, modelConfig, now()));
      repository.updateImportItem(item.id, "ready", now()); reportProgress(100);
      return { resultRef: item.opportunityId };
    } catch (error) {
      const retryable = error instanceof ModelGatewayError ? error.retryable : false;
      const willRetry = retryable && (job.attempts ?? 1) < (job.maxAttempts ?? 3);
      repository.updateImportItem(item.id, willRetry ? "queued" : "failed", now(), { error: { code: "extraction_failed", message: "岗位抽取失败", retryable } });
      throw error;
    }
  };
}

function mergeExtraction(repository: BusinessRepository, opportunityId: string, extracted: ExtractedJob, modelConfig: ModelInvocationConfig, now: Date): void {
  const current = repository.getDraft(opportunityId)!;
  const baseRevision = current.extractionRevision;
  const fields = { ...current.fields };
  const assumptions = [...current.assumptions];
  for (const [key, rawValue] of Object.entries(extracted)) {
    let value = rawValue; let source: DraftField["source"] = "extracted";
    if (key === "payMonths" && value == null && extracted.salaryMinMonthly != null) { value = 12; source = "default"; assumptions.push("发薪月数未注明，按 12 薪估算"); }
    const currentField = fields[key as keyof typeof fields];
    if (currentField.revision > baseRevision && currentField.value !== value) {
      repository.addDraftConflict(opportunityId, { id: id(), field: key, currentValue: currentField.value, proposedValue: value }, now);
      continue;
    }
    fields[key as keyof typeof fields] = { value, source: value == null ? "unknown" : source, revision: baseRevision + 1 };
  }
  const next = { ...current, fields, assumptions: [...new Set(assumptions)], extractionModel: modelConfig, extractionRevision: baseRevision + 1, version: current.version + 1 };
  repository.saveDraft(next, current.version, now);
}

export class LocalResearchApplication implements ResearchApplication {
  constructor(
    private readonly repository: BusinessRepository,
    private readonly jobs: JobRepository,
    private readonly now = () => new Date(),
    private readonly modelConfig: ModelInvocationConfig = LOCAL_MODEL_CONFIG,
  ) {}
  async startScreening(opportunityId: string, idempotencyKey: string): Promise<UseCaseResult<CommandReceipt>> {
    if (!idempotencyKey.trim()) return fail("validation", "Idempotency-Key is required");
    return translate(() => this.repository.transaction(() => {
      const payloadHash = hash({ opportunityId });
      const existing = this.repository.getIdempotency(idempotencyKey);
      if (existing) {
        if (existing.commandType !== "start-screening" || existing.aggregateId !== opportunityId || existing.payloadHash !== payloadHash) throw new PersistenceConflictError("idempotency_conflict", "Idempotency key already used");
        return existing.receipt as CommandReceipt;
      }
      const profile = this.repository.getProfile(); const opportunity = this.repository.getOpportunity(opportunityId);
      if (!profile) throw new BusinessRuleError("profile_required", "请先保存简历与画像");
      if (!opportunity || opportunity.draft.status !== "confirmed") throw new BusinessRuleError("confirmed_draft_required", "请先确认岗位草稿");
      const now = this.now(); const profileSnapshotId = id(); const jobSnapshotId = id(); const runId = id(); const jobId = id();
      this.repository.createProfileSnapshot(profileSnapshotId, profile, now);
      this.repository.createJobSnapshot(jobSnapshotId, opportunityId, opportunity.draft, opportunity.sourceText, now);
      this.jobs.create({ id: jobId, type: "screen-opportunity", payload: { runId, modelConfig: this.modelConfig }, now });
      const run: ResearchRun = { id: runId, opportunityId, jobId, status: "queued", currentStage: null, parentRunId: null, successorRunId: null, reportId: null, modelConfig: this.modelConfig, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      this.repository.createRun(run, { profile: profileSnapshotId, job: jobSnapshotId });
      const receipt = { id: runId, resourceId: runId, created: true };
      this.repository.saveIdempotency({ key: idempotencyKey, commandType: "start-screening", aggregateId: opportunityId, payloadHash, receipt, now });
      return receipt;
    }));
  }
  async getRun(runId: string): Promise<UseCaseResult<ResearchRun>> { const result = translate(() => this.repository.getRun(runId)); if (!result.ok) return result; return result.value ? ok(result.value) : fail<ResearchRun>("not_found", "Run not found"); }
  async cancel(runId: string) {
    const run = this.repository.getRun(runId); if (!run) return fail<ResearchRun>("not_found", "Run not found");
    this.jobs.requestCancellation(run.jobId, this.now());
    const status = run.status === "queued" ? "cancelled" : run.status === "running" ? "cancelling" : run.status;
    this.repository.updateRun(run.id, { status }, this.now()); return ok(this.repository.getRun(run.id)!);
  }
  async retryFailed(runId: string): Promise<UseCaseResult<CommandReceipt>> {
    const run = this.repository.getRun(runId); if (!run) return fail("not_found", "Run not found");
    if (run.status !== "failed") return fail("domain_precondition", "Only failed runs can be retried");
    if (run.successorRunId) return ok({ id: run.successorRunId, resourceId: run.successorRunId, created: false });
    return translate(() => this.repository.transaction(() => {
      const current = this.repository.getRun(runId);
      if (current?.successorRunId) return { id: current.successorRunId, resourceId: current.successorRunId, created: false };
      const now = this.now(); const childId = id(); const jobId = id();
      const row = this.repository.sqlite.prepare("SELECT profile_snapshot_id,job_snapshot_id FROM research_runs WHERE id=?").get(runId) as { profile_snapshot_id: string; job_snapshot_id: string };
      const modelConfig = run.modelConfig ?? LOCAL_MODEL_CONFIG;
      this.jobs.create({ id: jobId, type: "screen-opportunity", payload: { runId: childId, modelConfig }, now });
      this.repository.createRun({ ...run, id: childId, jobId, status: "queued", currentStage: null, parentRunId: run.id, successorRunId: null, reportId: null, modelConfig, createdAt: now.toISOString(), updatedAt: now.toISOString() }, { profile: row.profile_snapshot_id, job: row.job_snapshot_id });
      this.repository.updateRun(run.id, { successorRunId: childId }, now);
      return { id: childId, resourceId: childId, created: true };
    }));
  }
  async getReport(reportId: string): Promise<UseCaseResult<ScreeningReport>> { const result = translate(() => this.repository.getReport(reportId)); if (!result.ok) return result; return result.value ? ok(result.value) : fail<ScreeningReport>("not_found", "Report not found"); }
}

const SCREENING_STAGES = ["constraint_check", "semantic_match", "claim_validation", "recommendation_policy", "screening_report"] as const;

export function createScreeningHandler(repository: BusinessRepository, models: ModelSource, now = () => new Date()) {
  return async ({ job, signal, reportProgress }: { job: { input: unknown; attempts?: number; maxAttempts?: number }; signal: AbortSignal; reportProgress(value: number): void }) => {
    const runId = (job.input as { runId?: string }).runId;
    if (!runId) throw new Error("Missing run id");
    const context = repository.getRunContext(runId);
    if (!context) throw new Error("Run context not found");
    const modelConfig = context.run.modelConfig ?? LOCAL_MODEL_CONFIG;
    const model = resolveModel(models, modelConfig);
    repository.updateRun(runId, { status: "running" }, now());
    try {
      const values: Record<string, unknown> = {};
      for (let index = 0; index < SCREENING_STAGES.length; index += 1) {
        if (signal.aborted) throw new DOMException("Run cancelled", "AbortError");
        const stage = SCREENING_STAGES[index]!;
        const checkpoint = repository.getCheckpoint(runId, stage);
        if (checkpoint !== null) values[stage] = checkpoint;
        else {
          repository.updateRun(runId, { currentStage: stage }, now());
          values[stage] = await executeStage(stage, context, values, model, modelConfig, repository, signal, now());
          repository.saveCheckpoint(runId, stage, values[stage], now());
        }
        reportProgress(Math.round(((index + 1) / SCREENING_STAGES.length) * 100));
      }
      const report = values.screening_report as ScreeningReport;
      repository.transaction(() => {
        repository.saveReport(report, { profile: context.profileSnapshot.profile.profileVersion, resume: context.profileSnapshot.profile.resumeVersion, job: context.jobSnapshot.draft.version });
        repository.updateRun(runId, { status: "completed", currentStage: "screening_report", reportId: report.id }, now());
        repository.appendRunEvent(runId, "run_completed", { reportId: report.id }, now());
      });
      return { resultRef: report.id };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        repository.updateRun(runId, { status: "cancelled" }, now());
      } else if (error instanceof ModelGatewayError && error.retryable && (job.attempts ?? 1) < (job.maxAttempts ?? 3)) {
        repository.updateRun(runId, { status: "queued", error: null }, now());
      } else {
        repository.updateRun(runId, { status: "failed", error: { code: "screening_failed", message: "初筛执行失败" } }, now());
        repository.appendRunEvent(runId, "run_failed", { code: "screening_failed", message: "初筛执行失败" }, now());
      }
      throw error;
    }
  };
}

async function executeStage(
  stage: (typeof SCREENING_STAGES)[number],
  context: NonNullable<ReturnType<BusinessRepository["getRunContext"]>>,
  values: Record<string, unknown>, model: ModelGateway, modelConfig: ModelInvocationConfig,
  repository: BusinessRepository, signal: AbortSignal, clock: Date,
): Promise<unknown> {
  const profile = context.profileSnapshot.profile;
  const jobText = context.jobSnapshot.sourceText;
  if (stage === "constraint_check") {
    return {
      requiredMisses: profile.constraints.filter((item) => item.level === "required" && !jobText.toLowerCase().includes(item.text.toLowerCase())).map((item) => `未满足 required：${item.text}`),
      blockingFlags: profile.redFlags.filter((item) => item.level === "blocking" && jobText.toLowerCase().includes(item.text.toLowerCase())).map((item) => `命中 blocking 红旗：${item.text}`),
      warnings: profile.redFlags.filter((item) => item.level === "warning" && jobText.toLowerCase().includes(item.text.toLowerCase())).map((item) => `命中 warning：${item.text}`),
    };
  }
  if (stage === "semantic_match") {
    const generated = await model.generateStructured(buildScreeningModelRequest(
      { resumeText: profile.resumeText, jobText },
      model.descriptor,
      signal,
      modelConfig.promptVersions.screenOpportunity,
    ));
    return generated.map((claim) => ({ ...claim, id: `${context.run.id}-${claim.id}` }));
  }
  if (stage === "claim_validation") {
    return validateClaims(values.semantic_match as ResearchClaim[], profile.resumeText, jobText);
  }
  if (stage === "recommendation_policy") {
    const claims = (values.claim_validation as ResearchClaim[]).filter((claim) => claim.status === "supported");
    const verdicts: Partial<Record<(typeof DIMENSION_IDS)[number], Verdict>> = {};
    for (const dimension of DIMENSION_IDS) {
      const related = claims.filter((claim) => claim.dimension === dimension);
      const verdict = aggregateVerdict(related.map((claim) => claim.polarity));
      if (verdict) verdicts[dimension] = verdict;
    }
    const draft = context.jobSnapshot.draft.fields;
    const calculatedPackage = compensationPackage(numberValue(draft.salaryMinMonthly.value), numberValue(draft.salaryMaxMonthly.value), numberValue(draft.payMonths.value));
    const pkg = calculatedPackage ? { ...calculatedPackage, assumed: calculatedPackage.assumed || draft.payMonths.source === "default" } : null;
    if (pkg && profile.salary) verdicts.compensation_package = pkg.max < profile.salary.minMonthly * 12 ? "negative" : pkg.min >= profile.salary.minMonthly * 12 ? "positive" : "mixed";
    return { ...recommend({ ...(values.constraint_check as { requiredMisses: string[]; blockingFlags: string[] }), coreEvidenceCount: claims.length, verdicts, weights: profile.weights }), verdicts, compensation: pkg };
  }
  const claims = (values.claim_validation as ResearchClaim[]).filter((claim) => claim.status !== "rejected");
  const policy = values.recommendation_policy as { recommendation: ScreeningReport["recommendation"]; verdicts: Partial<Record<(typeof DIMENSION_IDS)[number], Verdict>>; rules: string[]; compensation: ReturnType<typeof compensationPackage> };
  const dimensions = Object.fromEntries(DIMENSION_IDS.map((dimension) => {
    const related = claims.filter((claim) => claim.dimension === dimension);
    const unknown = dimension === "people_and_company_reliability" ? "需要公司深度研究" : dimension === "life_radius" ? "请核对实际通勤时间" : related.length ? null : "当前文本没有足够证据";
    return [dimension, { verdict: policy.verdicts[dimension] ?? "unknown", confidence: related.some((claim) => claim.confidence === "high") ? "high" : related.length ? "medium" : "low", claimIds: related.map((claim) => claim.id), risks: related.filter((claim) => claim.polarity === "negative").map((claim) => claim.statement), unknowns: unknown ? [unknown] : [] }];
  })) as ScreeningReport["dimensions"];
  const currentProfile = repository.getProfile();
  const currentDraft = repository.getDraft(context.run.opportunityId);
  const stale = currentProfile?.version !== profile.version || currentDraft?.version !== context.jobSnapshot.draft.version;
  const status = stale ? "stale" : "partial";
  const evidenceConfidence = claims.length >= 4 ? "high" : claims.length >= 2 ? "medium" : "low";
  const reportConfidence = policy.compensation?.assumed && evidenceConfidence === "high" ? "medium" : evidenceConfidence;
  return {
    id: crypto.randomUUID(), runId: context.run.id, opportunityId: context.run.opportunityId,
    recommendation: policy.recommendation, confidence: reportConfidence,
    status, effective: !stale, dimensions,
    matches: claims.filter((claim) => claim.polarity === "positive").map((claim) => claim.statement),
    risks: [...(values.constraint_check as { warnings: string[]; blockingFlags: string[] }).warnings, ...(values.constraint_check as { blockingFlags: string[] }).blockingFlags],
    unknowns: Object.values(dimensions).flatMap((item) => item.unknowns), rules: policy.rules,
    claims, assumptions: [...context.jobSnapshot.draft.assumptions, ...(policy.compensation?.assumed ? ["薪资总包按 12 薪估算，置信度已降低"] : [])],
    modelLabel: model.descriptor.label, modelConfig, createdAt: clock.toISOString(),
  } satisfies ScreeningReport;
}

function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

export function validateClaims(claims: ResearchClaim[], resumeText: string, jobText: string): ResearchClaim[] {
  return claims.map((claim) => {
    const resumeEvidence = claim.resumeEvidence.trim();
    const jobEvidence = claim.jobEvidence.trim();
    const placeholderEvidence = resumeEvidence.includes("[已移除") || jobEvidence.includes("[已移除");
    const supported = !placeholderEvidence
      && resumeEvidence.length > 0
      && jobEvidence.length > 0
      && resumeText.toLowerCase().includes(resumeEvidence.toLowerCase())
      && jobText.toLowerCase().includes(jobEvidence.toLowerCase());
    return { ...claim, status: supported ? "supported" : "rejected" };
  });
}
