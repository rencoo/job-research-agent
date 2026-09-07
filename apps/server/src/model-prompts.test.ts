import { describe, expect, it } from "vitest";
import { DIMENSION_IDS } from "@job-research/contracts";
import {
  buildExtractionModelRequest,
  buildScreeningModelRequest,
  modelConfigFromDescriptor,
  redactResumeText,
} from "./model-prompts";

describe("model prompts", () => {
  it("builds versioned structured requests without assigning recommendation policy", () => {
    const extraction = buildExtractionModelRequest("岗位：AI 工程师");
    expect(extraction.promptVersion).toBe("extract-job-draft/v1");
    expect(extraction.schema).toMatchObject({ type: "object" });
    const screening = buildScreeningModelRequest(
      { resumeText: "TypeScript", jobText: "需要 TypeScript" },
      { provider: "local" },
    );
    expect(screening.promptVersion).toBe("screen-opportunity/v1");
    expect(screening.instructions).toContain(DIMENSION_IDS.join(", "));
    expect(screening.instructions).toContain("不得给出最终推荐");
  });

  it("redacts direct identifiers for DeepSeek without mutating technical content", () => {
    const original = "何周航 15652663008 rencoogle@outlook.com TypeScript Agent";
    const redacted = redactResumeText(original);
    expect(redacted).not.toContain("15652663008");
    expect(redacted).not.toContain("rencoogle@outlook.com");
    expect(redacted).toContain("TypeScript Agent");
    expect(original).toContain("15652663008");
    const request = buildScreeningModelRequest(
      { resumeText: original, jobText: "TypeScript" },
      { provider: "deepseek" },
    );
    expect(JSON.stringify(request.input)).not.toContain("15652663008");
  });

  it("creates API-key-free provenance", () => {
    expect(modelConfigFromDescriptor({
      provider: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek",
    })).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      promptVersions: {
        extractJobDraft: "extract-job-draft/v1",
        screenOpportunity: "screen-opportunity/v1",
      },
    });
  });
});
