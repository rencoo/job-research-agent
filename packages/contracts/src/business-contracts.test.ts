import { describe, expect, it } from "vitest";
import { DIMENSION_IDS, ImportBatchInputSchema, ProfileInputSchema } from "./index";

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
});
