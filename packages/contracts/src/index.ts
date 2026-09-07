import { z } from "zod";

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export type JobStatus = z.infer<typeof JobStatusSchema>;

const ComponentHealthSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  message: z.string().optional(),
});

export const HealthResponseSchema = z.object({
  status: z.enum(["healthy", "degraded"]),
  components: z.object({
    api: ComponentHealthSchema,
    database: ComponentHealthSchema,
    worker: ComponentHealthSchema,
  }),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const PublicJobErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const JobSnapshotSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  status: JobStatusSchema,
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().positive(),
  cancelRequested: z.boolean(),
  resultRef: z.string().nullable(),
  error: PublicJobErrorSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
});

export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;

export const CancelJobResponseSchema = z.object({
  jobId: z.string().min(1),
  status: JobStatusSchema,
  outcome: z.enum(["cancelled", "cancellation_requested", "already_terminal"]),
});

export type CancelJobResponse = z.infer<typeof CancelJobResponseSchema>;

const EventBaseSchema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().min(1),
  sequence: z.number().int().positive(),
  occurredAt: z.string().datetime(),
});

export const JobEventSchema = z.discriminatedUnion("type", [
  EventBaseSchema.extend({
    type: z.literal("status_changed"),
    payload: z.object({ status: JobStatusSchema }),
  }),
  EventBaseSchema.extend({
    type: z.literal("progress_updated"),
    payload: z.object({ progress: z.number().int().min(0).max(100) }),
  }),
  EventBaseSchema.extend({
    type: z.literal("job_succeeded"),
    payload: z.object({ resultRef: z.string().nullable() }),
  }),
  EventBaseSchema.extend({
    type: z.literal("job_failed"),
    payload: PublicJobErrorSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal("job_recovered"),
    payload: z.object({ attempt: z.number().int().positive() }),
  }),
]);

export type JobEvent = z.infer<typeof JobEventSchema>;

export const ApplicationErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});

export type ApplicationError = z.infer<typeof ApplicationErrorSchema>;

export const ErrorResponseSchema = z.object({ error: ApplicationErrorSchema });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const DimensionIdSchema = z.enum([
  "people_and_company_reliability",
  "life_radius",
  "compensation_package",
  "workload_and_role_boundaries",
  "work_content",
  "career_growth",
]);
export type DimensionId = z.infer<typeof DimensionIdSchema>;
export const DIMENSION_IDS = DimensionIdSchema.options;

export const ModelProviderSchema = z.enum(["local", "deepseek"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const ModelPromptVersionsSchema = z.object({
  extractJobDraft: z.string().min(1),
  screenOpportunity: z.string().min(1),
});

export const ModelInvocationConfigSchema = z.object({
  provider: ModelProviderSchema,
  model: z.string().min(1),
  promptVersions: ModelPromptVersionsSchema,
});
export type ModelInvocationConfig = z.infer<typeof ModelInvocationConfigSchema>;

export const LOCAL_MODEL_CONFIG: ModelInvocationConfig = {
  provider: "local",
  model: "local-demo",
  promptVersions: {
    extractJobDraft: "extract-job-draft/v1",
    screenOpportunity: "screen-opportunity/v1",
  },
};

export const WeightInputSchema = z.union([
  z.number().finite().nonnegative(),
  z.enum(["low", "medium", "high"]),
]);

export const ConstraintSchema = z.object({
  text: z.string().trim().min(1),
  level: z.enum(["required", "preferred"]),
});
export const RedFlagSchema = z.object({
  text: z.string().trim().min(1),
  level: z.enum(["warning", "blocking"]),
});

const ProfileInputBaseSchema = z.object({
    resumeText: z.string().trim().min(1),
    targetRoles: z.array(z.string().trim().min(1)).min(1),
    targetLocations: z.array(z.string().trim().min(1)).default([]),
    salary: z
      .object({ minMonthly: z.number().nonnegative(), maxMonthly: z.number().nonnegative() })
      .nullable()
      .default(null),
    commuteToleranceMinutes: z.number().int().positive().nullable().default(null),
    highlights: z.array(z.string().trim().min(1)).default([]),
    constraints: z.array(ConstraintSchema).default([]),
    redFlags: z.array(RedFlagSchema).default([]),
    weights: z.record(z.string(), WeightInputSchema).superRefine((weights, context) => {
      for (const key of Object.keys(weights)) {
        if (!DimensionIdSchema.safeParse(key).success) {
          context.addIssue({ code: "custom", path: [key], message: `未知评测维度：${key}` });
        }
      }
    }).default({}),
    expectedVersion: z.number().int().nonnegative().nullable().default(null),
  });
export const ProfileInputSchema = ProfileInputBaseSchema.superRefine((value, context) => {
    if (value.salary && value.salary.minMonthly > value.salary.maxMonthly) {
      context.addIssue({
        code: "custom",
        path: ["salary", "minMonthly"],
        message: "最低月薪不能高于最高月薪",
      });
    }
  });
export type ProfileInput = z.infer<typeof ProfileInputSchema>;

export const NormalizedWeightsSchema = z.record(DimensionIdSchema, z.number().min(0).max(1));
export const ProfileSchema = ProfileInputBaseSchema.omit({ expectedVersion: true, weights: true }).extend({
  id: z.string().min(1),
  resumeVersion: z.number().int().positive(),
  profileVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  weights: NormalizedWeightsSchema,
  weightInputs: z.partialRecord(DimensionIdSchema, WeightInputSchema).optional(),
  explicitWeightDimensions: z.array(DimensionIdSchema),
  updatedAt: z.string().datetime(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const DraftFieldSourceSchema = z.enum(["extracted", "user", "default", "unknown"]);
export const DraftFieldSchema = z.object({
  value: z.unknown().nullable(),
  source: DraftFieldSourceSchema,
  revision: z.number().int().nonnegative(),
});
export type DraftField = z.infer<typeof DraftFieldSchema>;

export const JobDraftDataSchema = z.object({
  title: DraftFieldSchema,
  company: DraftFieldSchema,
  location: DraftFieldSchema,
  salaryMinMonthly: DraftFieldSchema,
  salaryMaxMonthly: DraftFieldSchema,
  payMonths: DraftFieldSchema,
  responsibilities: DraftFieldSchema,
  requirements: DraftFieldSchema,
  benefits: DraftFieldSchema,
});
export type JobDraftData = z.infer<typeof JobDraftDataSchema>;

export const DraftConflictSchema = z.object({
  id: z.string().min(1),
  field: z.string().min(1),
  currentValue: z.unknown().nullable(),
  proposedValue: z.unknown().nullable(),
  createdAt: z.string().datetime(),
});

export const JobDraftSchema = z.object({
  opportunityId: z.string().min(1),
  status: z.enum(["draft", "confirmed"]),
  version: z.number().int().positive(),
  extractionRevision: z.number().int().nonnegative(),
  fields: JobDraftDataSchema,
  assumptions: z.array(z.string()),
  conflicts: z.array(DraftConflictSchema),
  confirmedAt: z.string().datetime().nullable(),
  confirmedVersion: z.number().int().positive().nullable(),
  extractionModel: ModelInvocationConfigSchema.nullable().optional(),
});
export type JobDraft = z.infer<typeof JobDraftSchema>;
export const ProfileSnapshotSchema = z.object({ schemaVersion: z.literal(1), profile: ProfileSchema });
export const JobInputSnapshotSchema = z.object({ schemaVersion: z.literal(1), draft: JobDraftSchema, sourceText: z.string() });

export const ImportItemStatusSchema = z.enum([
  "queued",
  "extracting",
  "needs_input",
  "ready",
  "failed",
]);
export const ImportItemSchema = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  jobId: z.string().min(1).nullable(),
  status: ImportItemStatusSchema,
  error: PublicJobErrorSchema.nullable(),
});
export const ImportBatchSchema = z.object({
  id: z.string().min(1),
  items: z.array(ImportItemSchema).min(1).max(20),
  createdAt: z.string().datetime(),
});
export const ImportBatchInputSchema = z.object({
  items: z.array(z.object({ text: z.string().trim().min(1) })).min(1).max(20),
});
export type ImportBatch = z.infer<typeof ImportBatchSchema>;

export const RecommendationSchema = z.enum([
  "strong_match",
  "worth_exploring",
  "cautious",
  "not_recommended",
  "insufficient_information",
]);
export type Recommendation = z.infer<typeof RecommendationSchema>;
export const DimensionAssessmentSchema = z.object({
  verdict: z.enum(["positive", "mixed", "negative", "unknown"]),
  confidence: z.enum(["high", "medium", "low"]),
  claimIds: z.array(z.string()),
  risks: z.array(z.string()),
  unknowns: z.array(z.string()),
});
export const ClaimSchema = z.object({
  id: z.string().min(1),
  dimension: DimensionIdSchema,
  statement: z.string().min(1),
  polarity: z.enum(["positive", "mixed", "negative"]),
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["supported", "contested", "unsupported", "unknown", "rejected"]),
  resumeEvidence: z.string().trim().min(1),
  jobEvidence: z.string().trim().min(1),
});
export type ResearchClaim = z.infer<typeof ClaimSchema>;

export const ScreeningReportSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  opportunityId: z.string().min(1),
  recommendation: RecommendationSchema,
  confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["complete", "partial", "stale", "invalidated"]),
  effective: z.boolean(),
  dimensions: z.record(DimensionIdSchema, DimensionAssessmentSchema),
  matches: z.array(z.string()),
  risks: z.array(z.string()),
  unknowns: z.array(z.string()),
  rules: z.array(z.string()),
  claims: z.array(ClaimSchema),
  assumptions: z.array(z.string()),
  modelLabel: z.string().min(1),
  modelConfig: ModelInvocationConfigSchema.nullable().optional(),
  createdAt: z.string().datetime(),
});
export type ScreeningReport = z.infer<typeof ScreeningReportSchema>;

export const RunStatusSchema = z.enum([
  "queued", "running", "waiting", "needs_attention", "cancelling", "cancelled",
  "completed", "failed", "superseded",
]);
export const ScreeningStageSchema = z.enum([
  "constraint_check", "semantic_match", "claim_validation", "recommendation_policy",
  "screening_report",
]);
export const ResearchRunSchema = z.object({
  id: z.string().min(1),
  opportunityId: z.string().min(1),
  jobId: z.string().min(1),
  status: RunStatusSchema,
  currentStage: ScreeningStageSchema.nullable(),
  parentRunId: z.string().nullable(),
  successorRunId: z.string().nullable(),
  reportId: z.string().nullable(),
  modelConfig: ModelInvocationConfigSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ResearchRun = z.infer<typeof ResearchRunSchema>;

export const RunEventSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.enum(["status_changed", "stage_completed", "run_completed", "run_failed"]),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: z.string().datetime(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const OpportunitySummarySchema = z.object({
  id: z.string().min(1),
  title: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  importStatus: ImportItemStatusSchema,
  draftStatus: z.enum(["draft", "confirmed"]),
  recommendation: RecommendationSchema.nullable(),
  currentReportId: z.string().nullable(),
  updatedAt: z.string().datetime(),
});
export const OpportunityDetailSchema = OpportunitySummarySchema.extend({
  sourceText: z.string(),
  draft: JobDraftSchema,
  runs: z.array(ResearchRunSchema),
  reports: z.array(ScreeningReportSchema),
});
export type OpportunitySummary = z.infer<typeof OpportunitySummarySchema>;
export type OpportunityDetail = z.infer<typeof OpportunityDetailSchema>;

export const DraftPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  fields: JobDraftDataSchema.partial(),
});
export const ConfirmDraftSchema = z.object({ expectedVersion: z.number().int().positive() });

export const ExtractedJobSchema = z.object({
  title: z.string().nullable(), company: z.string().nullable(), location: z.string().nullable(),
  salaryMinMonthly: z.number().nonnegative().nullable(), salaryMaxMonthly: z.number().nonnegative().nullable(),
  payMonths: z.number().int().positive().nullable(), responsibilities: z.string().nullable(),
  requirements: z.string().nullable(), benefits: z.string().nullable(),
});
export type ExtractedJob = z.infer<typeof ExtractedJobSchema>;
