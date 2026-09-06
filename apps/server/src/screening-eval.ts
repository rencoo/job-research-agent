import { normalizeWeights, recommend, type Verdict } from "@job-research/domain";
import { LocalDemoModel } from "@job-research/model-gateway";
import { ClaimSchema, type Recommendation } from "@job-research/contracts";
import { z } from "zod";

export interface ScreeningEvalCase {
  name: string; resume: string; job: string; requiredMisses?: string[]; blockingFlags?: string[];
  verdicts?: Record<string, Verdict>; expected: Recommendation;
}

export const SCREENING_EVAL_CASES: ScreeningEvalCase[] = [
  { name: "strong agent match", resume: "TypeScript Agent ownership RAG", job: "TypeScript Agent ownership RAG", verdicts: { work_content: "positive", career_growth: "positive" }, expected: "strong_match" },
  { name: "worth exploring", resume: "TypeScript Agent", job: "TypeScript Agent Python", verdicts: { work_content: "positive", career_growth: "mixed" }, expected: "worth_exploring" },
  { name: "mixed fit", resume: "TypeScript Agent", job: "TypeScript Agent", verdicts: { work_content: "mixed", career_growth: "negative" }, expected: "cautious" },
  { name: "missing core evidence", resume: "design", job: "backend Java", expected: "insufficient_information" },
  { name: "required constraint", resume: "TypeScript", job: "Java", requiredMisses: ["未满足 required：TypeScript"], expected: "not_recommended" },
  { name: "blocking 996", resume: "TypeScript Agent", job: "TypeScript Agent 996", blockingFlags: ["命中 blocking 红旗：996"], expected: "not_recommended" },
  { name: "workload overload", resume: "Agent ownership", job: "Agent ownership 一人负责所有事情", verdicts: { workload_and_role_boundaries: "negative", work_content: "positive" }, expected: "cautious" },
  { name: "salary uncertain", resume: "TypeScript Agent", job: "TypeScript Agent 30k-40k", verdicts: { compensation_package: "mixed", work_content: "positive" }, expected: "worth_exploring" },
  { name: "evidence conflict", resume: "TypeScript Agent", job: "TypeScript Agent no ownership", verdicts: { work_content: "mixed", career_growth: "mixed" }, expected: "cautious" },
  { name: "unknown company commute", resume: "TypeScript Agent", job: "TypeScript Agent", verdicts: { work_content: "positive" }, expected: "strong_match" },
];

export async function runScreeningEvals(cases = SCREENING_EVAL_CASES) {
  const model = new LocalDemoModel(); const weights = normalizeWeights({}).weights;
  const results = [];
  for (const sample of cases) {
    const claims = await model.generateStructured({ prompt: "eval", metadata: { task: "screen-opportunity", input: { resumeText: sample.resume, jobText: sample.job } }, validate: (value) => z.array(ClaimSchema).parse(value) });
    const result = recommend({ requiredMisses: sample.requiredMisses ?? [], blockingFlags: sample.blockingFlags ?? [], coreEvidenceCount: claims.length, verdicts: sample.verdicts ?? {}, weights });
    results.push({ name: sample.name, expected: sample.expected, actual: result.recommendation, passed: result.recommendation === sample.expected });
  }
  return { total: results.length, passed: results.filter((result) => result.passed).length, results, networkRequests: 0 };
}
