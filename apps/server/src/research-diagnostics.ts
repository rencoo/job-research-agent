import { ModelGatewayError } from "@job-research/model-gateway";
import { ResearchToolError } from "@job-research/research-tools";
import type { ResearchDiagnostic, SourceReadSummary } from "@job-research/contracts";

export type DeepResearchStage =
  | "resolve_company"
  | "company_snapshot"
  | "build_research_plan"
  | "gather_sources"
  | "build_claims"
  | "assess_dimensions"
  | "deep_research_report";

export function emptySourceReadSummary(): SourceReadSummary {
  return { attempts: 0, successes: 0, failures: {} };
}

export function mapSourceFailureReason(reason: string): string {
  if (["restricted_page", "http_401", "http_403", "blocked_address"].includes(reason)) return "restricted_page";
  if (reason === "unsupported_content_type") return "unsupported_content";
  if (reason.startsWith("tavily_")) return "search_unavailable";
  if (["page_unavailable", "empty_page", "fixture_missing", "response_too_large", "too_many_redirects"].includes(reason) || reason.startsWith("http_")) {
    return "network_error";
  }
  return "unknown";
}

export function recordSourceRead(summary: SourceReadSummary, outcome: "success" | "failure", reason?: string): void {
  summary.attempts++;
  if (outcome === "success") {
    summary.successes++;
    return;
  }
  const key = mapSourceFailureReason(reason ?? "unknown");
  summary.failures[key] = (summary.failures[key] ?? 0) + 1;
}

export function classifyResearchFailure(error: unknown, stage: DeepResearchStage | null): ResearchDiagnostic {
  if (error instanceof ModelGatewayError) {
    if (error.code === "deepseek_request_invalid") {
      return { stage, code: error.code, httpStatus: error.httpStatus, message: "模型服务拒绝请求参数或输出结构。", suggestedAction: "检查请求参数与模型支持的 JSON Schema；修正后重试深研。" };
    }
    if (error.code === "deepseek_not_found") {
      return { stage, code: error.code, httpStatus: error.httpStatus, message: "模型或接口不存在。", suggestedAction: "检查模型名称和接口地址后重试深研。" };
    }
    if (error.code === "deepseek_auth_failed") {
      return { stage, message: "模型鉴权失败，请检查 DeepSeek API Key 配置。", suggestedAction: "更新 API Key 后重试深研。" };
    }
    if (error.code === "deepseek_rate_limited") {
      return { stage, message: "模型请求过于频繁，请稍后再试。", suggestedAction: "等待片刻后重试深研。" };
    }
    if (["deepseek_unavailable", "deepseek_timeout"].includes(error.code)) {
      return { stage, message: "模型服务暂时不可用。", suggestedAction: "稍后重试，或检查网络连接。" };
    }
    if (["deepseek_schema_invalid", "deepseek_invalid_json", "deepseek_empty_response"].includes(error.code)) {
      return { stage, code: error.code, ...(error.validation ? { validation: error.validation } : {}), message: "模型返回结果无效，无法继续研究。", suggestedAction: "重试深研；若持续出现，请检查模型配置。" };
    }
    return { stage, message: "模型调用失败。", suggestedAction: "检查模型配置后重试。" };
  }
  if (error instanceof ResearchToolError) {
    if (["tavily_authentication_failed", "tavily_key_required"].includes(error.code)) {
      return { stage, message: "搜索服务鉴权失败，请检查 Tavily API Key 配置。", suggestedAction: "更新 API Key 后重试深研。" };
    }
    if (error.code === "tavily_unavailable" && error.retryable) {
      return { stage, message: "搜索服务暂时不可用。", suggestedAction: "稍后重试深研。" };
    }
    return { stage, message: "公开来源搜索或读取失败。", suggestedAction: "检查搜索与网络配置后重试。" };
  }
  return { stage, message: "研究执行遇到异常。", suggestedAction: "重试深研；若问题持续，请检查服务配置。" };
}

export function insufficientCompanySourcesDiagnostic(): ResearchDiagnostic {
  return {
    stage: "resolve_company",
    message: "找到了公开来源，但均无法安全读取，暂时无法自动识别公司。",
    suggestedAction: "补充公司官网或全名后重新识别，或跳过公司确认继续岗位研究。",
  };
}

export function ambiguousCompanyDiagnostic(): ResearchDiagnostic {
  return {
    stage: "resolve_company",
    message: "需要确认本次研究对应的公司主体。",
    suggestedAction: "从候选列表选择公司，补充线索，或跳过公司确认。",
  };
}

export function companyIdentityModelFailedDiagnostic(): ResearchDiagnostic {
  return {
    stage: "resolve_company",
    message: "已找到搜索摘要，但暂时未能自动识别公司主体。",
    suggestedAction: "请根据下方链接判断是否为本次研究的公司，补充官网或全名后重新识别，或跳过公司确认。",
  };
}

export function claimsModelFailedDiagnostic(): ResearchDiagnostic {
  return {
    stage: "build_claims",
    message: "部分研究结论未能自动生成，将基于已有证据输出部分报告。",
    suggestedAction: "可查看部分报告；如需完整结论请重试深研。",
  };
}
