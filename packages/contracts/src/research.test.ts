import { describe, expect, it } from "vitest";
import { ResearchStateSchema } from "./research";

describe("deep research state contract", () => {
  const legacy = {
    schemaVersion: 1,
    runId: "run-1",
    screeningReportId: "screen-1",
    mode: "demo",
    refreshCompany: false,
    resolution: { status: "pending", candidates: [], selectedId: null, hint: "", version: 1 },
    companyId: null,
    companySnapshotId: null,
    dependencyRunId: null,
    questions: [],
    documentIds: [],
    sourceFailures: [],
    calls: 0,
    elapsedMs: 0,
    activeSince: null,
    round: 0,
    emptyRounds: 0,
    stopReason: null,
    error: null,
  };

  it("parses legacy state without diagnostic fields", () => {
    const parsed = ResearchStateSchema.parse(legacy);
    expect(parsed.sourceReadSummary).toBeUndefined();
    expect(parsed.diagnostic).toBeUndefined();
  });

  it("accepts optional source read summary and diagnostic", () => {
    const parsed = ResearchStateSchema.parse({
      ...legacy,
      sourceReadSummary: { attempts: 3, successes: 1, failures: { restricted_page: 2 } },
      diagnostic: {
        stage: "resolve_company",
        message: "未能读取公开公司资料。",
        suggestedAction: "补充官网或跳过公司确认。",
      },
    });
    expect(parsed.sourceReadSummary?.successes).toBe(1);
    expect(parsed.diagnostic?.stage).toBe("resolve_company");
  });
});
