import { createModelRuntimeFromEnv } from "@job-research/model-gateway";
import { buildExtractionModelRequest, buildScreeningModelRequest } from "./model-prompts";

export function assertLiveEvalEnabled(env: Record<string, string | undefined>): void {
  if (env.JRA_RUN_LIVE_EVAL !== "1") {
    throw new Error("真实 DeepSeek Eval 未启用；如确认产生外部请求与费用，请设置 JRA_RUN_LIVE_EVAL=1");
  }
  if (env.JRA_MODEL_PROVIDER !== "deepseek") {
    throw new Error("真实 DeepSeek Eval 要求 JRA_MODEL_PROVIDER=deepseek");
  }
}

export async function runDeepSeekLiveEval(env: Record<string, string | undefined> = process.env) {
  assertLiveEvalEnabled(env);
  const runtime = createModelRuntimeFromEnv(env);
  const jd = "职位：AI Agent Engineer\n公司：示例科技\n地点：上海\n薪资：30k-40k\n职责：使用 TypeScript 构建 Agent 工作流\n要求：三年前端与 AI 应用经验";
  const resume = "七年前端经验，使用 TypeScript 构建 AI Agent 与工作流产品。";
  const draft = await runtime.selected.generateStructured(buildExtractionModelRequest(jd));
  const claims = await runtime.selected.generateStructured(buildScreeningModelRequest(
    { resumeText: resume, jobText: jd },
    runtime.selected.descriptor,
  ));
  return {
    provider: runtime.selected.descriptor.provider,
    model: runtime.selected.descriptor.model,
    extractedTitle: draft.title,
    claimCount: claims.length,
  };
}
