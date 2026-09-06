export const DIMENSIONS = [
  "people_and_company_reliability", "life_radius", "compensation_package",
  "workload_and_role_boundaries", "work_content", "career_growth",
] as const;
export type DimensionId = (typeof DIMENSIONS)[number];
export type WeightInput = number | "low" | "medium" | "high";
export type NormalizedWeights = Record<DimensionId, number>;
export const LEGACY_CONTENT_DIMENSIONS = ["ownership", "product_interest"] as const;

const DEFAULT_WEIGHTS: Record<DimensionId, number> = {
  people_and_company_reliability: 5,
  life_radius: 4,
  compensation_package: 3,
  workload_and_role_boundaries: 5,
  work_content: 4,
  career_growth: 4,
};
const TIERS = { low: 1, medium: 3, high: 5 } as const;
const isDimensionId = (value: string): value is DimensionId =>
  (DIMENSIONS as readonly string[]).includes(value);
const isLegacyContentDimension = (value: string): value is (typeof LEGACY_CONTENT_DIMENSIONS)[number] =>
  (LEGACY_CONTENT_DIMENSIONS as readonly string[]).includes(value);

export class BusinessRuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BusinessRuleError";
  }
}

export function normalizeWeights(input: Partial<Record<string, WeightInput>>): {
  weights: NormalizedWeights;
  explicit: DimensionId[];
} {
  for (const key of Object.keys(input)) {
    if (!isDimensionId(key)) throw new BusinessRuleError("invalid_weight", `Invalid weight for ${key}`);
  }
  const raw = { ...DEFAULT_WEIGHTS };
  const explicit: DimensionId[] = [];
  for (const dimension of DIMENSIONS) {
    const value = input[dimension];
    if (value === undefined) continue;
    const numeric = typeof value === "number" ? value : TIERS[value];
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new BusinessRuleError("invalid_weight", `Invalid weight for ${dimension}`);
    }
    raw[dimension] = numeric;
    explicit.push(dimension);
  }
  const total = Object.values(raw).reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new BusinessRuleError("invalid_weight", "At least one weight must be positive");
  return {
    weights: Object.fromEntries(DIMENSIONS.map((key) => [key, raw[key] / total])) as NormalizedWeights,
    explicit,
  };
}

export function assertSalaryRange(salary: { minMonthly: number; maxMonthly: number } | null): void {
  if (!salary) return;
  if (salary.minMonthly < 0 || salary.maxMonthly < 0 || salary.minMonthly > salary.maxMonthly) {
    throw new BusinessRuleError("invalid_salary_range", "Invalid salary range");
  }
}

export interface UserProfileState {
  id: string; resumeText: string; resumeVersion: number; profileVersion: number; version: number;
}
export function updateUserProfile(
  current: UserProfileState | null,
  input: { resumeText: string; profileChanged: boolean },
): UserProfileState {
  if (!input.resumeText.trim()) throw new BusinessRuleError("invalid_resume", "Resume is required");
  return {
    id: current?.id ?? crypto.randomUUID(),
    resumeText: input.resumeText.trim(),
    resumeVersion: current ? current.resumeVersion + (current.resumeText === input.resumeText.trim() ? 0 : 1) : 1,
    profileVersion: current ? current.profileVersion + (input.profileChanged ? 1 : 0) : 1,
    version: (current?.version ?? 0) + 1,
  };
}

export type DraftStatus = "draft" | "confirmed";
export function canConfirmDraft(fields: { title: unknown; responsibilities: unknown; requirements: unknown }): boolean {
  const present = (value: unknown) => typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0;
  return present(fields.title) && (present(fields.responsibilities) || present(fields.requirements));
}

export type RunStatus = "queued" | "running" | "waiting" | "needs_attention" | "cancelling" | "cancelled" | "completed" | "failed" | "superseded";
const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelling"], running: ["waiting", "needs_attention", "completed", "failed", "cancelling"],
  waiting: ["queued", "cancelling", "superseded"], needs_attention: ["queued", "cancelled", "superseded"],
  cancelling: ["cancelled"], cancelled: [], completed: [], failed: [], superseded: [],
};
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!RUN_TRANSITIONS[from].includes(to)) throw new BusinessRuleError("invalid_run_transition", `${from} -> ${to}`);
}

export type Verdict = "positive" | "mixed" | "negative" | "unknown";
export type Recommendation = "strong_match" | "worth_exploring" | "cautious" | "not_recommended" | "insufficient_information";
export interface PolicyInput {
  requiredMisses: string[]; blockingFlags: string[]; coreEvidenceCount: number;
  verdicts: Partial<Record<DimensionId, Verdict>>; weights: NormalizedWeights;
}
export function recommend(input: PolicyInput): { recommendation: Recommendation; score: number; rules: string[] } {
  if (input.requiredMisses.length || input.blockingFlags.length) {
    return { recommendation: "not_recommended", score: 0, rules: [...input.requiredMisses, ...input.blockingFlags] };
  }
  if (input.coreEvidenceCount < 2) return { recommendation: "insufficient_information", score: 0, rules: ["核心证据不足"] };
  const scores = { positive: 1, mixed: 0.5, negative: 0, unknown: 0 } as const;
  let value = 0;
  let knownWeight = 0;
  for (const dimension of DIMENSIONS) {
    const verdict = input.verdicts[dimension] ?? "unknown";
    if (verdict === "unknown") continue;
    value += scores[verdict] * input.weights[dimension];
    knownWeight += input.weights[dimension];
  }
  const score = knownWeight ? value / knownWeight : 0;
  return {
    recommendation: score >= 0.8 ? "strong_match" : score >= 0.6 ? "worth_exploring" : "cautious",
    score,
    rules: [],
  };
}

export function aggregateVerdict(polarities: Array<"positive" | "mixed" | "negative">): Verdict | undefined {
  if (!polarities.length) return undefined;
  const values = new Set(polarities);
  if (values.has("mixed") || (values.has("positive") && values.has("negative"))) return "mixed";
  if (values.has("negative")) return "negative";
  return "positive";
}

function weightRank(value: WeightInput): number {
  return typeof value === "number" ? value : TIERS[value];
}

function pickHigherWeight(values: WeightInput[]): WeightInput {
  return values.reduce((best, current) => (weightRank(current) > weightRank(best) ? current : best));
}

export function upcastLegacyWeightState(input: {
  weights?: Record<string, number>;
  weightInputs?: Record<string, WeightInput>;
  explicitWeightDimensions?: string[];
}): {
  weights: NormalizedWeights;
  weightInputs: Partial<Record<DimensionId, WeightInput>>;
  explicitWeightDimensions: DimensionId[];
} {
  const rawInputs = { ...(input.weightInputs ?? {}) };
  const ignoreLegacy = "work_content" in rawInputs || "work_content" in (input.weights ?? {});
  if (!ignoreLegacy) {
    const legacyValues = LEGACY_CONTENT_DIMENSIONS
      .map((key) => rawInputs[key])
      .filter((value): value is WeightInput => value !== undefined);
    if (legacyValues.length) rawInputs.work_content = pickHigherWeight(legacyValues);
  }
  for (const key of LEGACY_CONTENT_DIMENSIONS) delete rawInputs[key];
  const knownInputs = Object.fromEntries(
    Object.entries(rawInputs).filter(([key]) => isDimensionId(key)),
  ) as Partial<Record<DimensionId, WeightInput>>;
  const normalized = normalizeWeights(knownInputs);
  return {
    weights: normalized.weights,
    weightInputs: knownInputs,
    explicitWeightDimensions: normalized.explicit,
  };
}

export function upcastProfileRecord(value: Record<string, unknown>): Record<string, unknown> {
  const upcasted = upcastLegacyWeightState({
    ...(isRecord(value.weights) ? { weights: asNumberRecord(value.weights) } : {}),
    ...(isRecord(value.weightInputs) ? { weightInputs: asWeightInputRecord(value.weightInputs) } : {}),
    ...(Array.isArray(value.explicitWeightDimensions)
      ? { explicitWeightDimensions: value.explicitWeightDimensions.filter((item): item is string => typeof item === "string") }
      : {}),
  });
  const next: Record<string, unknown> = {
    ...value,
    weights: upcasted.weights,
    explicitWeightDimensions: value.explicitWeightDimensions === undefined && upcasted.explicitWeightDimensions.length === 0
      ? value.explicitWeightDimensions
      : upcasted.explicitWeightDimensions,
  };
  if (value.weightInputs !== undefined || Object.keys(upcasted.weightInputs).length > 0) {
    next.weightInputs = upcasted.weightInputs;
  }
  return next;
}

type AssessmentLike = {
  verdict?: string;
  confidence?: string;
  claimIds?: unknown[];
  risks?: unknown[];
  unknowns?: unknown[];
};

export function upcastScreeningReportRecord(value: Record<string, unknown>): Record<string, unknown> {
  const dimensions = isRecord(value.dimensions) ? { ...value.dimensions } : {};
  const legacy = LEGACY_CONTENT_DIMENSIONS
    .map((key) => dimensions[key])
    .filter((item): item is AssessmentLike => isRecord(item));
  if (legacy.length || LEGACY_CONTENT_DIMENSIONS.some((key) => key in dimensions)) {
    const current = isRecord(dimensions.work_content) ? dimensions.work_content as AssessmentLike : undefined;
    const assessments = [...(current ? [current] : []), ...legacy];
    dimensions.work_content = {
      verdict: mergeLegacyVerdicts(assessments.map((item) => item.verdict)),
      confidence: mergeConfidence(assessments.map((item) => item.confidence)),
      claimIds: uniqueStrings(assessments.flatMap((item) => item.claimIds ?? [])),
      risks: uniqueStrings(assessments.flatMap((item) => item.risks ?? [])),
      unknowns: uniqueStrings(assessments.flatMap((item) => item.unknowns ?? [])),
    };
    for (const key of LEGACY_CONTENT_DIMENSIONS) delete dimensions[key];
  }
  const claims = Array.isArray(value.claims)
    ? value.claims.map((claim) => {
      if (!isRecord(claim) || typeof claim.dimension !== "string" || !isLegacyContentDimension(claim.dimension)) return claim;
      return { ...claim, dimension: "work_content" };
    })
    : value.claims;
  return { ...value, dimensions, claims };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumberRecord(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
}

function asWeightInputRecord(value: Record<string, unknown>): Record<string, WeightInput> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, WeightInput] => {
      const candidate = entry[1];
      return typeof candidate === "number" || candidate === "low" || candidate === "medium" || candidate === "high";
    }),
  );
}

function mergeLegacyVerdicts(values: Array<string | undefined>): Verdict {
  const known = values.filter((value): value is "positive" | "mixed" | "negative" =>
    value === "positive" || value === "mixed" || value === "negative");
  return aggregateVerdict(known) ?? "unknown";
}

function mergeConfidence(values: Array<string | undefined>): "high" | "medium" | "low" {
  if (values.includes("high")) return "high";
  if (values.includes("medium")) return "medium";
  return "low";
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string"))];
}

export function compensationPackage(minMonthly: number | null, maxMonthly: number | null, payMonths?: number | null) {
  if (minMonthly === null || maxMonthly === null) return null;
  const months = payMonths ?? 12;
  return { min: minMonthly * months, max: maxMonthly * months, months, assumed: payMonths == null };
}

export function immutableSnapshot<T extends object>(value: T): Readonly<T> {
  return Object.freeze(structuredClone(value));
}

export interface DomainIds { next(): string }
export interface ImportItemState { id: string; opportunityId: string; text: string; status: "queued" | "needs_input" }
export interface ImportBatchState { id: string; items: ImportItemState[] }
const URL_ONLY = /^https?:\/\/\S+$/i;
export function createImportBatch(texts: string[], ids: DomainIds): ImportBatchState {
  if (texts.length < 1 || texts.length > 20 || texts.some((text) => !text.trim())) {
    throw new BusinessRuleError("invalid_import_batch", "A batch requires 1 to 20 non-empty items");
  }
  return {
    id: ids.next(),
    items: texts.map((text) => ({
      id: ids.next(), opportunityId: ids.next(), text: text.trim(),
      status: URL_ONLY.test(text.trim()) ? "needs_input" : "queued",
    })),
  };
}

export interface OpportunityState { id: string; version: number; draftStatus: DraftStatus; currentReportId: string | null }
export function createOpportunity(id: string): OpportunityState {
  return { id, version: 1, draftStatus: "draft", currentReportId: null };
}
export interface ResearchRunState { id: string; opportunityId: string; status: RunStatus; parentRunId: string | null }
export function createResearchRun(id: string, opportunityId: string, parentRunId: string | null = null): ResearchRunState {
  return { id, opportunityId, status: "queued", parentRunId };
}
export interface ScreeningReportState { id: string; runId: string; recommendation: Recommendation; createdAt: string }
export function createScreeningReport(input: ScreeningReportState): Readonly<ScreeningReportState> {
  return immutableSnapshot(input);
}
