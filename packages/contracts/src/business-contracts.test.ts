import { describe, expect, it } from "vitest";
import {
  DIMENSION_IDS,
  ImportBatchInputSchema,
  ModelInvocationConfigSchema,
  ProfileInputSchema,
  ScreeningReportSchema,
} from "./index";

describe("business contracts", () => {
  it("keeps the six stable dimensions", () => {
    expect(DIMENSION_IDS).toHaveLength(6);
    expect(DIMENSION_IDS).toContain("work_content");
    expect(DIMENSION_IDS).toContain("workload_and_role_boundaries");
    expect(DIMENSION_IDS).not.toContain("ownership");
    expect(DIMENSION_IDS).not.toContain("product_interest");
  });

  it("rejects inverted salary and invalid weights", () => {
    expect(ProfileInputSchema.safeParse({
      resumeText: "TypeScript engineer",
      targetRoles: ["AI engineer"],
      salary: { minMonthly: 40_000, maxMonthly: 30_000 },
      weights: {},
    }).success).toBe(false);
    expect(ProfileInputSchema.safeParse({
      resumeText: "TypeScript engineer",
      targetRoles: ["AI engineer"],
      weights: { work_content: -1 },
    }).success).toBe(false);
  });

  it("enforces the batch limit", () => {
    expect(ImportBatchInputSchema.safeParse({ items: [{ text: "JD" }] }).success).toBe(true);
    expect(ImportBatchInputSchema.safeParse({
      items: Array.from({ length: 21 }, () => ({ text: "JD" })),
    }).success).toBe(false);
  });

  it("rejects deleted dimension keys on profile write", () => {
    const base = { resumeText: "TypeScript engineer", targetRoles: ["AI engineer"] };
    expect(ProfileInputSchema.safeParse({ ...base, weights: { ownership: "high" } }).success).toBe(false);
    expect(ProfileInputSchema.safeParse({ ...base, weights: { product_interest: "low" } }).success).toBe(false);
  });

  it("accepts model provenance without allowing an API key", () => {
    const parsed = ModelInvocationConfigSchema.parse({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptVersions: {
        extractJobDraft: "extract-job-draft/v1",
        screenOpportunity: "screen-opportunity/v1",
      },
    });
    expect(parsed.provider).toBe("deepseek");
    expect(ModelInvocationConfigSchema.safeParse({ ...parsed, apiKey: "secret" }).data).not.toHaveProperty("apiKey");
  });

  it("keeps legacy local reports parseable", () => {
    const dimensions = Object.fromEntries(DIMENSION_IDS.map((dimension) => [dimension, {
      verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [],
    }]));
    const report = ScreeningReportSchema.parse({
      id: "report-1", runId: "run-1", opportunityId: "opportunity-1",
      recommendation: "insufficient_information", confidence: "low", status: "partial",
      effective: true, dimensions, matches: [], risks: [], unknowns: [], rules: [], claims: [],
      assumptions: [], modelLabel: "本地演示模型", createdAt: "2026-09-07T00:00:00.000Z",
    });
    expect(report.modelConfig).toBeUndefined();
  });
});
