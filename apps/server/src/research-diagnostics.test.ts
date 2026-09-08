import { describe, expect, it } from "vitest";
import { ModelGatewayError } from "@job-research/model-gateway";
import { ResearchToolError } from "@job-research/research-tools";
import { ResearchDiagnosticSchema } from "@job-research/contracts";
import { claimsModelFailedDiagnostic, classifyResearchFailure, emptySourceReadSummary, mapSourceFailureReason, recordSourceRead } from "./research-diagnostics";

describe("research diagnostics", () => {
  it("preserves validation details through the response contract", () => {
    const validation = { task: "extract-research-claims", schemaName: "extract_research_claims", issues: [{ path: ["claims", 0, "confidence"], code: "invalid_value" }] };
    const error = new ModelGatewayError("deepseek_schema_invalid", "invalid", false, undefined, validation);
    const response = ResearchDiagnosticSchema.parse(classifyResearchFailure(error, "build_claims"));
    expect(response).toMatchObject({ code: "deepseek_schema_invalid", validation });
  });
  it("maps internal page reasons to safe buckets", () => {
    expect(mapSourceFailureReason("restricted_page")).toBe("restricted_page");
    expect(mapSourceFailureReason("http_403")).toBe("restricted_page");
    expect(mapSourceFailureReason("unsupported_content_type")).toBe("unsupported_content");
    expect(mapSourceFailureReason("tavily_unavailable")).toBe("search_unavailable");
    expect(mapSourceFailureReason("page_unavailable")).toBe("network_error");
  });

  it("records source read summary", () => {
    const summary = emptySourceReadSummary();
    recordSourceRead(summary, "success");
    recordSourceRead(summary, "failure", "http_403");
    expect(summary).toEqual({ attempts: 2, successes: 1, failures: { restricted_page: 1 } });
  });

  it("classifies model auth failures without leaking codes", () => {
    const diagnostic = classifyResearchFailure(new ModelGatewayError("deepseek_auth_failed", "secret", false), "gather_sources");
    expect(diagnostic.message).toContain("鉴权");
    expect(diagnostic.message).not.toContain("deepseek_auth_failed");
    expect(diagnostic.stage).toBe("gather_sources");
  });

  it("classifies search tool failures", () => {
    const diagnostic = classifyResearchFailure(new ResearchToolError("tavily_authentication_failed"), "resolve_company");
    expect(diagnostic.message).toContain("搜索服务鉴权失败");
    expect(diagnostic.suggestedAction).toContain("重试");
  });

  it("exposes safe request rejection details without the provider response body", () => {
    expect(classifyResearchFailure(new ModelGatewayError("deepseek_request_invalid", "private response", false, 400), "resolve_company")).toMatchObject({
      stage: "resolve_company", code: "deepseek_request_invalid", httpStatus: 400,
      message: "模型服务拒绝请求参数或输出结构。",
    });
  });

  it("describes claims degradation without sounding like a hard failure", () => {
    const diagnostic = claimsModelFailedDiagnostic();
    expect(diagnostic.stage).toBe("build_claims");
    expect(diagnostic.message).toContain("部分报告");
    expect(diagnostic.suggestedAction).toContain("重试");
  });
});
