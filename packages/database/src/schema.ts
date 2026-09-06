import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    inputJson: text("input_json").notNull(),
    status: text("status").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    resultRef: text("result_ref"),
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    errorRetryable: integer("error_retryable", { mode: "boolean" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("jobs_claim_idx").on(table.status, table.availableAt)],
);

export const jobAttempts = sqliteTable(
  "job_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    workerId: text("worker_id").notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    outcome: text("outcome").notNull().default("running"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
  },
  (table) => [uniqueIndex("job_attempt_unique").on(table.jobId, table.attempt)],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("job_event_sequence_unique").on(table.jobId, table.sequence),
    index("job_events_replay_idx").on(table.jobId, table.sequence),
  ],
);

export const schemaMigrations = sqliteTable("schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: integer("applied_at", { mode: "timestamp_ms" }).notNull(),
});

export const userProfile = sqliteTable("user_profile", {
  id: text("id").primaryKey(), resumeText: text("resume_text").notNull(),
  resumeVersion: integer("resume_version").notNull(), profileVersion: integer("profile_version").notNull(),
  version: integer("version").notNull(), profileJson: text("profile_json").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const profileSnapshots = sqliteTable("profile_snapshots", {
  id: text("id").primaryKey(), resumeVersion: integer("resume_version").notNull(),
  profileVersion: integer("profile_version").notNull(), dataJson: text("data_json").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const opportunities = sqliteTable("opportunities", {
  id: text("id").primaryKey(), sourceText: text("source_text").notNull(), version: integer("version").notNull(),
  currentReportId: text("current_report_id"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const importItems = sqliteTable("import_items", {
  id: text("id").primaryKey(), batchId: text("batch_id").notNull(), opportunityId: text("opportunity_id").notNull(),
  jobId: text("job_id"), status: text("status").notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const jobDrafts = sqliteTable("job_drafts", {
  opportunityId: text("opportunity_id").primaryKey(), status: text("status").notNull(), version: integer("version").notNull(),
  extractionRevision: integer("extraction_revision").notNull(), fieldsJson: text("fields_json").notNull(),
  assumptionsJson: text("assumptions_json").notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const draftConflicts = sqliteTable("draft_conflicts", {
  id: text("id").primaryKey(), opportunityId: text("opportunity_id").notNull(), field: text("field").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const jobSnapshots = sqliteTable("job_snapshots", {
  id: text("id").primaryKey(), opportunityId: text("opportunity_id").notNull(), jobRevision: integer("job_revision").notNull(), dataJson: text("data_json").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const researchRuns = sqliteTable("research_runs", {
  id: text("id").primaryKey(), opportunityId: text("opportunity_id").notNull(), jobId: text("job_id").notNull(), status: text("status").notNull(), currentStage: text("current_stage"), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(), updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
export const stageCheckpoints = sqliteTable("stage_checkpoints", {
  runId: text("run_id").notNull(), stage: text("stage").notNull(), resultJson: text("result_json").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const runEvents = sqliteTable("run_events", {
  id: integer("id").primaryKey({ autoIncrement: true }), runId: text("run_id").notNull(), sequence: integer("sequence").notNull(), type: text("type").notNull(), payloadJson: text("payload_json").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const researchClaims = sqliteTable("research_claims", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(), dimension: text("dimension").notNull(), status: text("status").notNull(), dataJson: text("data_json").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const screeningReports = sqliteTable("screening_reports", {
  id: text("id").primaryKey(), runId: text("run_id").notNull(), opportunityId: text("opportunity_id").notNull(), recommendation: text("recommendation").notNull(), status: text("status").notNull(), effective: integer("effective", { mode: "boolean" }).notNull(), dataJson: text("data_json").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
export const idempotencyKeys = sqliteTable("idempotency_keys", {
  key: text("key").primaryKey(), commandType: text("command_type").notNull(), aggregateId: text("aggregate_id").notNull(), payloadHash: text("payload_hash").notNull(), receiptJson: text("receipt_json").notNull(), createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
