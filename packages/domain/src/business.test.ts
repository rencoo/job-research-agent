import { describe, expect, it } from "vitest";
import {
  assertRunTransition, assertSalaryRange, compensationPackage, immutableSnapshot,
  createImportBatch, createOpportunity, createResearchRun, createScreeningReport,
  DIMENSIONS, normalizeWeights, recommend, updateUserProfile, upcastLegacyWeightState,
  upcastScreeningReportRecord,
} from "./business";

describe("business domain", () => {
  it("normalizes numeric and tier weights while retaining defaults", () => {
    const result = normalizeWeights({ work_content: "high", compensation_package: 2 });
    expect(Object.values(result.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(result.explicit).toEqual(["compensation_package", "work_content"]);
    expect(DIMENSIONS).toEqual(expect.arrayContaining(["work_content"]));
    expect(DIMENSIONS).not.toContain("ownership");
    expect(DIMENSIONS).not.toContain("product_interest");
    const careerOnly = normalizeWeights({ career_growth: "high" });
    expect(careerOnly.explicit).toEqual(["career_growth"]);
    expect(careerOnly.weights.work_content).toBeCloseTo(4 / 26);
    expect(careerOnly.weights.work_content).toBeCloseTo(normalizeWeights({}).weights.work_content * (25 / 26));
    expect(() => normalizeWeights({ work_content: -1 })).toThrowError(/Invalid weight/);
    expect(() => normalizeWeights({ ownership: "high" } as never)).toThrowError(/Invalid weight/);
  });

  it("validates salaries and calculates a visible 12-month assumption", () => {
    expect(() => assertSalaryRange({ minMonthly: 2, maxMonthly: 1 })).toThrow();
    expect(compensationPackage(20_000, 30_000)).toEqual({ min: 240_000, max: 360_000, months: 12, assumed: true });
  });

  it("versions the unique current profile without mutating snapshots", () => {
    const first = updateUserProfile(null, { resumeText: "resume", profileChanged: true });
    const snapshot = immutableSnapshot(first);
    const second = updateUserProfile(first, { resumeText: "resume 2", profileChanged: false });
    expect(second.resumeVersion).toBe(2);
    expect(snapshot.resumeText).toBe("resume");
  });

  it("enforces run transitions and deterministic recommendations", () => {
    expect(() => assertRunTransition("completed", "running")).toThrow();
    const weights = normalizeWeights({}).weights;
    expect(recommend({ requiredMisses: [], blockingFlags: ["996"], coreEvidenceCount: 3, verdicts: {}, weights }).recommendation).toBe("not_recommended");
    expect(recommend({ requiredMisses: [], blockingFlags: [], coreEvidenceCount: 0, verdicts: {}, weights }).recommendation).toBe("insufficient_information");
    expect(recommend({ requiredMisses: [], blockingFlags: [], coreEvidenceCount: 3, verdicts: { work_content: "positive" }, weights }).recommendation).toBe("strong_match");
  });

  it("upcasts legacy content weights without diluting the higher tier", () => {
    const ownershipOnly = upcastLegacyWeightState({ weightInputs: { ownership: "high" } });
    expect(ownershipOnly.weightInputs).toEqual({ work_content: "high" });
    expect(ownershipOnly.explicitWeightDimensions).toEqual(["work_content"]);
    const both = upcastLegacyWeightState({ weightInputs: { ownership: "high", product_interest: "low" } });
    expect(both.weightInputs.work_content).toBe("high");
    const existing = upcastLegacyWeightState({
      weights: { work_content: 0.2 },
      weightInputs: { work_content: "medium", ownership: "high" },
    });
    expect(existing.weightInputs).toEqual({ work_content: "medium" });
  });

  it("merges legacy report dimensions and keeps claim statements", () => {
    const upcasted = upcastScreeningReportRecord({
      dimensions: {
        ownership: { verdict: "positive", confidence: "medium", claimIds: ["c1"], risks: [], unknowns: [] },
        product_interest: { verdict: "negative", confidence: "low", claimIds: ["c2"], risks: ["切片执行"], unknowns: ["产品细节"] },
        career_growth: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [] },
      },
      claims: [
        { id: "c1", dimension: "ownership", statement: "能拿主导权" },
        { id: "c2", dimension: "product_interest", statement: "产品方向不对味" },
      ],
    });
    const dimensions = upcasted.dimensions as Record<string, { verdict: string; risks: string[]; unknowns: string[]; claimIds: string[] }>;
    expect(dimensions.work_content).toMatchObject({
      verdict: "mixed", risks: ["切片执行"], unknowns: ["产品细节"], claimIds: ["c1", "c2"],
    });
    expect(dimensions.ownership).toBeUndefined();
    expect(dimensions.product_interest).toBeUndefined();
    expect(upcasted.claims).toEqual([
      { id: "c1", dimension: "work_content", statement: "能拿主导权" },
      { id: "c2", dimension: "work_content", statement: "产品方向不对味" },
    ]);
    const unknownSide = upcastScreeningReportRecord({
      dimensions: {
        ownership: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: ["旧未知"] },
        product_interest: { verdict: "positive", confidence: "high", claimIds: ["c3"], risks: [], unknowns: [] },
      },
      claims: [{ id: "c3", dimension: "product_interest", statement: "产品对味" }],
    });
    expect((unknownSide.dimensions as Record<string, { verdict: string; unknowns: string[] }>).work_content).toMatchObject({
      verdict: "positive", unknowns: ["旧未知"],
    });
  });

  it("creates independent aggregate identities and immutable reports", () => {
    let sequence = 0;
    const batch = createImportBatch(["same JD", "same JD"], { next: () => `id-${++sequence}` });
    expect(batch.items[0]?.opportunityId).not.toBe(batch.items[1]?.opportunityId);
    expect(createOpportunity("o1").version).toBe(1);
    expect(createResearchRun("r1", "o1").status).toBe("queued");
    const report = createScreeningReport({ id: "x", runId: "r1", recommendation: "cautious", createdAt: new Date().toISOString() });
    expect(Object.isFrozen(report)).toBe(true);
  });
});
