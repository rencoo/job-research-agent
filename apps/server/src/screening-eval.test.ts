import { describe, expect, it } from "vitest";
import { runScreeningEvals, SCREENING_EVAL_CASES } from "./screening-eval";

describe("synthetic screening evals", () => {
  it("covers at least ten deterministic, offline scenarios", async () => {
    expect(SCREENING_EVAL_CASES).toHaveLength(10);
    const result = await runScreeningEvals();
    expect(result).toMatchObject({ total: 10, passed: 10, networkRequests: 0 });
  });
});
