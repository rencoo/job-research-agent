import type Database from "better-sqlite3";
import {
  ImportBatchSchema, JobDraftSchema, OpportunityDetailSchema, OpportunitySummarySchema,
  JobInputSnapshotSchema, LOCAL_MODEL_CONFIG, ProfileSchema, ProfileSnapshotSchema, ResearchRunSchema, RunEventSchema, ScreeningReportSchema,
  type ImportBatch, type JobDraft, type OpportunityDetail, type OpportunitySummary,
  type Profile, type ResearchClaim, type ResearchRun, type RunEvent, type ScreeningReport,
} from "@job-research/contracts";
import { upcastProfileRecord, upcastScreeningReportRecord } from "@job-research/domain";

const parse = <T>(value: string): T => JSON.parse(value) as T;
const encode = (value: unknown): string => JSON.stringify(value);
const iso = (value: number): string => new Date(value).toISOString();
const parseProfile = (value: string): Profile => ProfileSchema.parse(upcastProfileRecord(parse(value)));
const parseReport = (value: string): ScreeningReport => {
  const record = upcastScreeningReportRecord(parse<Record<string, unknown>>(value));
  return ScreeningReportSchema.parse({
    ...record,
    modelConfig: record.modelConfig ?? LOCAL_MODEL_CONFIG,
  });
};

export class PersistenceConflictError extends Error {
  constructor(readonly code: "version_conflict" | "idempotency_conflict", message: string) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class BusinessRepository {
  constructor(readonly sqlite: Database.Database) {}

  transaction<T>(operation: () => T): T {
    if (this.sqlite.inTransaction) return operation();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getProfile(): Profile | null {
    const row = this.sqlite.prepare("SELECT profile_json FROM user_profile WHERE id = 'current'").get() as { profile_json: string } | undefined;
    return row ? parseProfile(row.profile_json) : null;
  }

  saveProfile(profile: Profile, expectedVersion: number | null): void {
    const current = this.getProfile();
    if ((current?.version ?? null) !== expectedVersion) throw new PersistenceConflictError("version_conflict", "Profile version changed");
    this.sqlite.prepare(`
      INSERT INTO user_profile(id, resume_text, resume_version, profile_version, version, profile_json, updated_at)
      VALUES ('current', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET resume_text=excluded.resume_text, resume_version=excluded.resume_version,
        profile_version=excluded.profile_version, version=excluded.version, profile_json=excluded.profile_json,
        updated_at=excluded.updated_at
    `).run(profile.resumeText, profile.resumeVersion, profile.profileVersion, profile.version, encode(profile), Date.parse(profile.updatedAt));
  }

  createProfileSnapshot(id: string, profile: Profile, now: Date): void {
    this.sqlite.prepare(`INSERT INTO profile_snapshots(id,resume_version,profile_version,data_json,created_at) VALUES(?,?,?,?,?)`)
      .run(id, profile.resumeVersion, profile.profileVersion, encode({ schemaVersion: 1, profile }), now.getTime());
  }

  getProfileSnapshot(id: string): { schemaVersion: 1; profile: Profile } | null {
    const row = this.sqlite.prepare("SELECT data_json FROM profile_snapshots WHERE id=?").get(id) as { data_json: string } | undefined;
    if (!row) return null;
    const raw = parse<{ schemaVersion: 1; profile: Record<string, unknown> }>(row.data_json);
    return ProfileSnapshotSchema.parse({ ...raw, profile: upcastProfileRecord(raw.profile) });
  }

  createImport(input: {
    batchId: string; now: Date; items: Array<{ id: string; opportunityId: string; text: string; status: string; jobId: string | null }>;
  }): void {
    this.sqlite.prepare("INSERT INTO import_batches(id,created_at) VALUES(?,?)").run(input.batchId, input.now.getTime());
    const insertOpportunity = this.sqlite.prepare("INSERT INTO opportunities(id,source_text,version,created_at,updated_at) VALUES(?,?,1,?,?)");
    const insertItem = this.sqlite.prepare("INSERT INTO import_items(id,batch_id,opportunity_id,job_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)");
    const insertDraft = this.sqlite.prepare("INSERT INTO job_drafts(opportunity_id,status,version,extraction_revision,fields_json,assumptions_json,updated_at) VALUES(?,'draft',1,0,?,'[]',?)");
    for (const item of input.items) {
      insertOpportunity.run(item.opportunityId, item.text, input.now.getTime(), input.now.getTime());
      insertItem.run(item.id, input.batchId, item.opportunityId, item.jobId, item.status, input.now.getTime(), input.now.getTime());
      insertDraft.run(item.opportunityId, encode(emptyDraftFields()), input.now.getTime());
    }
  }

  getImportBatch(id: string): ImportBatch | null {
    const batch = this.sqlite.prepare("SELECT * FROM import_batches WHERE id=?").get(id) as { id: string; created_at: number } | undefined;
    if (!batch) return null;
    const rows = this.sqlite.prepare("SELECT * FROM import_items WHERE batch_id=? ORDER BY created_at,id").all(id) as Array<Record<string, unknown>>;
    return ImportBatchSchema.parse({
      id: batch.id, createdAt: iso(batch.created_at),
      items: rows.map((row) => ({
        id: row.id, opportunityId: row.opportunity_id, jobId: row.job_id, status: row.status,
        error: row.error_code ? { code: row.error_code, message: row.error_message, retryable: row.error_retryable === 1 } : null,
      })),
    });
  }

  getImportItem(id: string): { id: string; batchId: string; opportunityId: string; jobId: string | null; status: string; sourceText: string } | null {
    const row = this.sqlite.prepare(`SELECT i.*,o.source_text FROM import_items i JOIN opportunities o ON o.id=i.opportunity_id WHERE i.id=?`).get(id) as Record<string, unknown> | undefined;
    return row ? { id: String(row.id), batchId: String(row.batch_id), opportunityId: String(row.opportunity_id), jobId: row.job_id ? String(row.job_id) : null, status: String(row.status), sourceText: String(row.source_text) } : null;
  }

  updateImportItem(id: string, status: string, now: Date, options: { jobId?: string | null; error?: { code: string; message: string; retryable: boolean } | null } = {}): void {
    this.sqlite.prepare(`UPDATE import_items SET status=?,job_id=COALESCE(?,job_id),error_code=?,error_message=?,error_retryable=?,updated_at=? WHERE id=?`)
      .run(status, options.jobId ?? null, options.error?.code ?? null, options.error?.message ?? null, options.error ? Number(options.error.retryable) : null, now.getTime(), id);
  }

  findImportItemByJob(jobId: string): ReturnType<BusinessRepository["getImportItem"]> {
    const row = this.sqlite.prepare("SELECT id FROM import_items WHERE job_id=?").get(jobId) as { id: string } | undefined;
    return row ? this.getImportItem(row.id) : null;
  }

  getDraft(opportunityId: string): JobDraft | null {
    const row = this.sqlite.prepare("SELECT * FROM job_drafts WHERE opportunity_id=?").get(opportunityId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const conflicts = this.sqlite.prepare("SELECT * FROM draft_conflicts WHERE opportunity_id=? AND resolved_at IS NULL ORDER BY created_at").all(opportunityId) as Array<Record<string, unknown>>;
    return JobDraftSchema.parse({
      opportunityId, status: row.status, version: row.version, extractionRevision: row.extraction_revision,
      fields: parse(String(row.fields_json)), assumptions: parse(String(row.assumptions_json)),
      extractionModel: row.extraction_model_json == null ? null : parse(String(row.extraction_model_json)),
      confirmedAt: row.confirmed_at == null ? null : iso(Number(row.confirmed_at)),
      confirmedVersion: row.confirmed_version,
      conflicts: conflicts.map((conflict) => ({
        id: conflict.id, field: conflict.field,
        currentValue: conflict.current_value_json == null ? null : parse(String(conflict.current_value_json)),
        proposedValue: conflict.proposed_value_json == null ? null : parse(String(conflict.proposed_value_json)),
        createdAt: iso(Number(conflict.created_at)),
      })),
    });
  }

  saveDraft(draft: JobDraft, expectedVersion: number, now: Date): void {
    const result = this.sqlite.prepare(`UPDATE job_drafts SET status=?,version=?,extraction_revision=?,fields_json=?,assumptions_json=?,extraction_model_json=?,confirmed_at=?,confirmed_version=?,updated_at=? WHERE opportunity_id=? AND version=?`)
      .run(draft.status, draft.version, draft.extractionRevision, encode(draft.fields), encode(draft.assumptions), draft.extractionModel ? encode(draft.extractionModel) : null, draft.confirmedAt ? Date.parse(draft.confirmedAt) : null, draft.confirmedVersion, now.getTime(), draft.opportunityId, expectedVersion);
    if (result.changes !== 1) throw new PersistenceConflictError("version_conflict", "Draft version changed");
    this.sqlite.prepare("UPDATE opportunities SET version=version+1,updated_at=? WHERE id=?").run(now.getTime(), draft.opportunityId);
  }

  addDraftConflict(opportunityId: string, conflict: { id: string; field: string; currentValue: unknown; proposedValue: unknown }, now: Date): void {
    this.sqlite.prepare("INSERT INTO draft_conflicts(id,opportunity_id,field,current_value_json,proposed_value_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(conflict.id, opportunityId, conflict.field, encode(conflict.currentValue), encode(conflict.proposedValue), now.getTime());
  }

  createJobSnapshot(id: string, opportunityId: string, draft: JobDraft, sourceText: string, now: Date): void {
    this.sqlite.prepare("INSERT INTO job_snapshots(id,opportunity_id,job_revision,data_json,created_at) VALUES(?,?,?,?,?)")
      .run(id, opportunityId, draft.version, encode({ schemaVersion: 1, draft, sourceText }), now.getTime());
  }

  getJobSnapshot(id: string): { schemaVersion: 1; draft: JobDraft; sourceText: string } | null {
    const row = this.sqlite.prepare("SELECT data_json FROM job_snapshots WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? JobInputSnapshotSchema.parse(parse(row.data_json)) : null;
  }

  createRun(run: ResearchRun, snapshotIds: { profile: string; job: string }): void {
    this.sqlite.prepare(`INSERT INTO research_runs(id,opportunity_id,job_id,profile_snapshot_id,job_snapshot_id,status,current_stage,parent_run_id,successor_run_id,report_id,model_config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(run.id, run.opportunityId, run.jobId, snapshotIds.profile, snapshotIds.job, run.status, run.currentStage, run.parentRunId, run.successorRunId, run.reportId, run.modelConfig ? encode(run.modelConfig) : null, Date.parse(run.createdAt), Date.parse(run.updatedAt));
    this.sqlite.prepare("UPDATE research_runs SET kind=? WHERE id=?").run(run.kind ?? "screening", run.id);
    this.appendRunEvent(run.id, "status_changed", { status: run.status }, new Date(run.createdAt));
  }

  getRun(id: string): ResearchRun | null {
    const row = this.sqlite.prepare("SELECT * FROM research_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  getRunContext(id: string): {
    run: ResearchRun; profileSnapshotId: string; jobSnapshotId: string;
    profileSnapshot: { schemaVersion: 1; profile: Profile };
    jobSnapshot: { schemaVersion: 1; draft: JobDraft; sourceText: string };
  } | null {
    const row = this.sqlite.prepare("SELECT * FROM research_runs WHERE id=?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const profileSnapshotId = String(row.profile_snapshot_id);
    const jobSnapshotId = String(row.job_snapshot_id);
    const profileSnapshot = this.getProfileSnapshot(profileSnapshotId);
    const jobSnapshot = this.getJobSnapshot(jobSnapshotId);
    if (!profileSnapshot || !jobSnapshot) return null;
    return { run: mapRun(row), profileSnapshotId, jobSnapshotId, profileSnapshot, jobSnapshot };
  }

  listRuns(opportunityId: string): ResearchRun[] {
    return (this.sqlite.prepare("SELECT * FROM research_runs WHERE opportunity_id=? ORDER BY created_at DESC").all(opportunityId) as Array<Record<string, unknown>>).map(mapRun);
  }

  updateRun(id: string, patch: { status?: string; currentStage?: string | null; reportId?: string | null; successorRunId?: string | null; error?: { code: string; message: string } | null }, now: Date): void {
    const current = this.getRun(id);
    if (!current) return;
    this.sqlite.prepare(`UPDATE research_runs SET status=?,current_stage=?,report_id=?,successor_run_id=?,error_code=?,error_message=?,updated_at=? WHERE id=?`)
      .run(patch.status ?? current.status, patch.currentStage === undefined ? current.currentStage : patch.currentStage, patch.reportId === undefined ? current.reportId : patch.reportId, patch.successorRunId === undefined ? current.successorRunId : patch.successorRunId, patch.error?.code ?? null, patch.error?.message ?? null, now.getTime(), id);
    if (patch.status && patch.status !== current.status) this.appendRunEvent(id, "status_changed", { status: patch.status }, now);
  }

  getCheckpoint(runId: string, stage: string): unknown | null {
    const row = this.sqlite.prepare("SELECT result_json FROM stage_checkpoints WHERE run_id=? AND stage=?").get(runId, stage) as { result_json: string } | undefined;
    return row ? parse(row.result_json) : null;
  }

  saveCheckpoint(runId: string, stage: string, result: unknown, now: Date): void {
    const inserted = this.sqlite.prepare("INSERT OR IGNORE INTO stage_checkpoints(run_id,stage,result_json,created_at) VALUES(?,?,?,?)").run(runId, stage, encode(result), now.getTime());
    if (inserted.changes === 1) this.appendRunEvent(runId, "stage_completed", { stage }, now);
  }

  appendRunEvent(runId: string, type: string, payload: Record<string, unknown>, now: Date): void {
    const next = this.sqlite.prepare("SELECT COALESCE(MAX(sequence),0)+1 sequence FROM run_events WHERE run_id=?").get(runId) as { sequence: number };
    this.sqlite.prepare("INSERT INTO run_events(run_id,sequence,type,payload_json,created_at) VALUES(?,?,?,?,?)").run(runId, next.sequence, type, encode(payload), now.getTime());
  }

  listRunEvents(runId: string, after = 0): RunEvent[] {
    const rows = this.sqlite.prepare("SELECT * FROM run_events WHERE run_id=? AND sequence>? ORDER BY sequence").all(runId, after) as Array<Record<string, unknown>>;
    return rows.map((row) => RunEventSchema.parse({ schemaVersion: 1, runId, sequence: row.sequence, type: row.type, payload: parse(String(row.payload_json)), occurredAt: iso(Number(row.created_at)) }));
  }

  saveReport(report: ScreeningReport, versions: { profile: number; resume: number; job: number }): void {
    this.sqlite.prepare(`INSERT INTO screening_reports(id,run_id,opportunity_id,recommendation,status,effective,profile_version,resume_version,job_revision,data_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(report.id, report.runId, report.opportunityId, report.recommendation, report.status, Number(report.effective), versions.profile, versions.resume, versions.job, encode(report), Date.parse(report.createdAt));
    const claimInsert = this.sqlite.prepare("INSERT INTO research_claims(id,run_id,dimension,status,data_json,created_at) VALUES(?,?,?,?,?,?)");
    for (const claim of report.claims) claimInsert.run(claim.id, report.runId, claim.dimension, claim.status, encode(claim), Date.parse(report.createdAt));
    if (report.effective && report.status !== "invalidated" && report.status !== "stale") {
      this.sqlite.prepare("UPDATE opportunities SET current_report_id=?,updated_at=? WHERE id=?").run(report.id, Date.parse(report.createdAt), report.opportunityId);
    }
  }

  getReport(id: string): ScreeningReport | null {
    const row = this.sqlite.prepare("SELECT data_json FROM screening_reports WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? parseReport(row.data_json) : null;
  }

  listReports(opportunityId: string): ScreeningReport[] {
    return (this.sqlite.prepare("SELECT data_json FROM screening_reports WHERE opportunity_id=? ORDER BY created_at DESC").all(opportunityId) as Array<{ data_json: string }>).map((row) => parseReport(row.data_json));
  }

  markReportsStale(opportunityId: string): void {
    const rows = this.sqlite.prepare("SELECT id,data_json FROM screening_reports WHERE opportunity_id=?").all(opportunityId) as Array<{ id: string; data_json: string }>;
    const update = this.sqlite.prepare("UPDATE screening_reports SET status='stale',effective=0,data_json=? WHERE id=?");
    for (const row of rows) {
      const raw = parse<Record<string, unknown>>(row.data_json);
      if (raw.status === "invalidated") continue;
      update.run(encode({ ...raw, status: "stale", effective: false }), row.id);
    }
    this.sqlite.prepare("UPDATE opportunities SET current_report_id=NULL WHERE id=?").run(opportunityId);
  }

  getIdempotency(key: string): { commandType: string; aggregateId: string; payloadHash: string; receipt: unknown } | null {
    const row = this.sqlite.prepare("SELECT * FROM idempotency_keys WHERE key=?").get(key) as Record<string, unknown> | undefined;
    return row ? { commandType: String(row.command_type), aggregateId: String(row.aggregate_id), payloadHash: String(row.payload_hash), receipt: parse(String(row.receipt_json)) } : null;
  }

  saveIdempotency(input: { key: string; commandType: string; aggregateId: string; payloadHash: string; receipt: unknown; now: Date }): void {
    this.sqlite.prepare("INSERT INTO idempotency_keys(key,command_type,aggregate_id,payload_hash,receipt_json,created_at) VALUES(?,?,?,?,?,?)")
      .run(input.key, input.commandType, input.aggregateId, input.payloadHash, encode(input.receipt), input.now.getTime());
  }

  listOpportunities(query: { keyword?: string; status?: string; recommendation?: string } = {}): OpportunitySummary[] {
    const rows = this.sqlite.prepare(`SELECT o.*,d.status draft_status,d.fields_json,i.status import_status,r.recommendation FROM opportunities o JOIN job_drafts d ON d.opportunity_id=o.id JOIN import_items i ON i.opportunity_id=o.id LEFT JOIN screening_reports r ON r.id=o.current_report_id ORDER BY o.updated_at DESC`).all() as Array<Record<string, unknown>>;
    const keyword = query.keyword?.toLowerCase();
    return rows.map((row) => {
      const fields = parse<Record<string, { value: unknown }>>(String(row.fields_json));
      return OpportunitySummarySchema.parse({ id: row.id, title: fields.title?.value ?? null, company: fields.company?.value ?? null, location: fields.location?.value ?? null, importStatus: row.import_status, draftStatus: row.draft_status, recommendation: row.recommendation, currentReportId: row.current_report_id, updatedAt: iso(Number(row.updated_at)) });
    }).filter((item) => (!keyword || [item.title,item.company,item.location].some((v) => v?.toLowerCase().includes(keyword))) && (!query.status || item.importStatus === query.status || item.draftStatus === query.status) && (!query.recommendation || item.recommendation === query.recommendation));
  }

  getOpportunity(id: string): OpportunityDetail | null {
    const row = this.sqlite.prepare(`SELECT o.*,i.status import_status FROM opportunities o JOIN import_items i ON i.opportunity_id=o.id WHERE o.id=?`).get(id) as Record<string, unknown> | undefined;
    const draft = this.getDraft(id);
    if (!row || !draft) return null;
    const fields = draft.fields as Record<string, { value: unknown }>;
    return OpportunityDetailSchema.parse({ id, title: fields.title?.value ?? null, company: fields.company?.value ?? null, location: fields.location?.value ?? null, importStatus: row.import_status, draftStatus: draft.status, recommendation: this.getCurrentRecommendation(row.current_report_id), currentReportId: row.current_report_id, updatedAt: iso(Number(row.updated_at)), sourceText: row.source_text, draft, runs: this.listRuns(id), reports: this.listReports(id) });
  }

  private getCurrentRecommendation(reportId: unknown): string | null {
    return typeof reportId === "string" ? this.getReport(reportId)?.recommendation ?? null : null;
  }
}

export function emptyDraftFields() {
  const field = () => ({ value: null, source: "unknown" as const, revision: 0 });
  return { title: field(), company: field(), location: field(), salaryMinMonthly: field(), salaryMaxMonthly: field(), payMonths: field(), responsibilities: field(), requirements: field(), benefits: field() };
}

function mapRun(row: Record<string, unknown>): ResearchRun {
  return ResearchRunSchema.parse({
    id: row.id, opportunityId: row.opportunity_id, jobId: row.job_id, status: row.status,
    kind: row.kind ?? "screening", currentStage: row.current_stage, parentRunId: row.parent_run_id,
    successorRunId: row.successor_run_id, reportId: row.report_id,
    modelConfig: row.model_config_json == null ? LOCAL_MODEL_CONFIG : parse(String(row.model_config_json)),
    createdAt: iso(Number(row.created_at)), updatedAt: iso(Number(row.updated_at)),
  });
}
