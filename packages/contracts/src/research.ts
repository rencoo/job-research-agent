import { z } from "zod";
import { DimensionIdSchema, DimensionAssessmentSchema, RecommendationSchema, ModelInvocationConfigSchema } from "./core";

export const PublicUrlSchema = z.string().url().refine((value) => /^https?:\/\//i.test(value), "Only HTTP(S) URLs are allowed");
export const SourceDocumentSchema = z.object({
  id: z.string(), kind: z.enum(["web", "job", "resume"]), url: PublicUrlSchema.nullable(), finalUrl: PublicUrlSchema.nullable(),
  title: z.string(), text: z.string(), contentHash: z.string(), retrievedAt: z.string().datetime(),
  method: z.enum(["http", "browser", "input", "fixture", "search_snippet"]), sourceType: z.enum(["official", "third_party", "user_provided", "unknown"]),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export const CandidateSchema = z.object({
  id: z.string(), name: z.string().min(1), website: PublicUrlSchema.nullable(), legalName: z.string().nullable(), location: z.string().nullable(),
  aliases: z.array(z.string()), basis: z.array(z.object({ documentId: z.string(), quote: z.string().min(1) })).min(1),
});
export type CompanyCandidate = z.infer<typeof CandidateSchema>;
export const CompanySchema = CandidateSchema.extend({ confirmedAt: z.string().datetime() });
export type Company = z.infer<typeof CompanySchema>;
export const ResolutionSchema = z.object({ status: z.enum(["pending", "confirmed", "skipped"]), candidates: z.array(CandidateSchema), selectedId: z.string().nullable(), hint: z.string(), version: z.number().int() });
export type CompanyResolution = z.infer<typeof ResolutionSchema>;
export const AttentionResponseSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("select"), candidateId: z.string(), expectedVersion: z.number().int() }),
  z.object({ action: z.literal("supplement"), hint: z.string().trim().min(1).max(500), expectedVersion: z.number().int() }),
  z.object({ action: z.literal("skip"), expectedVersion: z.number().int() }),
]);
export const EvidenceLinkSchema = z.object({
  id: z.string(), claimId: z.string(), documentId: z.string(), quote: z.string().min(1), start: z.number().int().nonnegative(), end: z.number().int().positive(), relation: z.enum(["supports", "refutes"]),
});
export type EvidenceLink = z.infer<typeof EvidenceLinkSchema>;
export const DeepClaimSchema = z.object({
  id: z.string(), ownerType: z.enum(["company", "run"]), ownerId: z.string(), dimension: DimensionIdSchema,
  statement: z.string().min(1), polarity: z.enum(["positive", "mixed", "negative"]), confidence: z.enum(["high", "medium", "low"]),
  status: z.enum(["supported", "contested", "unsupported", "unknown", "rejected"]), attribution: z.string(),
});
export type DeepClaim = z.infer<typeof DeepClaimSchema>;
export const ResearchQuestionSchema = z.object({ id: z.string(), dimension: DimensionIdSchema, question: z.string(), query: z.string(), answered: z.boolean() });
export type ResearchQuestion = z.infer<typeof ResearchQuestionSchema>;
export const CompanySnapshotSchema = z.object({
  id: z.string(), companyId: z.string(), createdAt: z.string().datetime(), expiresAt: z.string().datetime(), topics: z.array(z.string()),
  claims: z.array(DeepClaimSchema), evidence: z.array(EvidenceLinkSchema), documentIds: z.array(z.string()), mode: z.enum(["demo", "live"]),
});
export type CompanySnapshot = z.infer<typeof CompanySnapshotSchema>;
export const DeepReportSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), runId: z.string(), opportunityId: z.string(), companySnapshotId: z.string().nullable(),
  status: z.enum(["complete", "partial", "stale", "invalidated"]), effective: z.boolean(), recommendation: RecommendationSchema,
  dimensions: z.record(DimensionIdSchema, DimensionAssessmentSchema), claims: z.array(DeepClaimSchema), evidence: z.array(EvidenceLinkSchema),
  documentIds: z.array(z.string()), risks: z.array(z.string()), unknowns: z.array(z.string()), rules: z.array(z.string()),
  stopReason: z.string(), mode: z.enum(["demo", "live"]), modelConfig: ModelInvocationConfigSchema, createdAt: z.string().datetime(),
});
export type DeepResearchReport = z.infer<typeof DeepReportSchema>;
export const SourceReadSummarySchema = z.object({
  attempts: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  failures: z.record(z.string(), z.number().int().nonnegative()),
});
export type SourceReadSummary = z.infer<typeof SourceReadSummarySchema>;
export const SearchHitSchema = z.object({
  url: PublicUrlSchema,
  title: z.string(),
  snippet: z.string(),
  readStatus: z.enum(["ok", "blocked", "failed", "snippet"]),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
export const DeepResearchStageSchema = z.enum([
  "resolve_company", "company_snapshot", "build_research_plan", "gather_sources",
  "build_claims", "assess_dimensions", "deep_research_report",
]);
export const ResearchDiagnosticSchema = z.object({
  validation: z.object({
    task: z.string(), schemaName: z.string(),
    issues: z.array(z.object({ path: z.array(z.union([z.string(), z.number()])), code: z.string(), expected: z.string().optional() })).max(20),
  }).optional(),
  code: z.string().optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  stage: DeepResearchStageSchema.nullable(),
  message: z.string().min(1),
  suggestedAction: z.string().min(1),
});
export type ResearchDiagnostic = z.infer<typeof ResearchDiagnosticSchema>;
export const ResearchStateSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string(), screeningReportId: z.string(), mode: z.enum(["demo", "live"]), refreshCompany: z.boolean(),
  resolution: ResolutionSchema, companyId: z.string().nullable(), companySnapshotId: z.string().nullable(), dependencyRunId: z.string().nullable(),
  questions: z.array(ResearchQuestionSchema), documentIds: z.array(z.string()), sourceFailures: z.array(z.string()),
  sourceReadSummary: SourceReadSummarySchema.optional(),
  searchHits: z.array(SearchHitSchema).optional(),
  diagnostic: ResearchDiagnosticSchema.optional(),
  policy: z.object({ version: z.literal(1), maxCalls: z.number().int().positive(), maxElapsedMs: z.number().positive() }).optional(),
  calls: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), activeSince: z.number().nullable(),
  round: z.number().int(), emptyRounds: z.number().int(), stopReason: z.string().nullable(), error: z.string().nullable(),
});
export type ResearchState = z.infer<typeof ResearchStateSchema>;
export const DeepResearchViewSchema = z.object({ states: z.array(ResearchStateSchema), reports: z.array(DeepReportSchema), currentReportId: z.string().nullable() });
export const DeepStartSchema = z.object({ refreshCompany: z.boolean().optional(), parentRunId: z.string().optional() });
