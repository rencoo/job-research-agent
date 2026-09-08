import { describe, expect, it } from "vitest";
import type { ResearchState } from "@job-research/contracts";
import { formatSourceReadSummary, isActiveDeepRunStatus, projectDeepResearchFlow, deepRunRefetchInterval, deepViewRefetchInterval } from "./deep-research-flow";

const baseDiagnosticState: Pick<ResearchState, "diagnostic"> = {};
const baseSummaryState: Pick<ResearchState, "sourceReadSummary"> = {};

describe("deep research flow projection", () => {
  it("marks verify company as waiting during needs_attention", () => {
    const nodes = projectDeepResearchFlow({ status: "needs_attention", currentStage: "resolve_company" }, baseDiagnosticState);
    expect(nodes[0]?.state).toBe("waiting");
    expect(nodes.slice(1).every(node => node.state === "pending")).toBe(true);
  });

  it("marks the failed node and completed predecessors", () => {
    const nodes = projectDeepResearchFlow(
      { status: "failed", currentStage: "gather_sources" },
      { diagnostic: { stage: "gather_sources", message: "搜索失败", suggestedAction: "重试" } },
    );
    expect(nodes[0]?.state).toBe("complete");
    expect(nodes[1]?.state).toBe("complete");
    expect(nodes[2]?.state).toBe("failed");
    expect(nodes[3]?.state).toBe("pending");
  });

  it("completes all nodes when run is finished", () => {
    const nodes = projectDeepResearchFlow({ status: "completed", currentStage: "deep_research_report" }, baseDiagnosticState);
    expect(nodes.every(node => node.state === "complete")).toBe(true);
  });

  it("formats source read summary and polling guards", () => {
    expect(formatSourceReadSummary(baseSummaryState)).toBeNull();
    expect(formatSourceReadSummary({ sourceReadSummary: { attempts: 0, successes: 0, failures: {} } })).toBe("暂无来源读取统计");
    expect(formatSourceReadSummary({ sourceReadSummary: { attempts: 2, successes: 1, failures: { restricted_page: 1 } } })).toContain("成功 1 个");
    expect(isActiveDeepRunStatus("completed")).toBe(false);
    expect(isActiveDeepRunStatus("running")).toBe(true);
    expect(deepRunRefetchInterval("running")).toBe(1000);
    expect(deepRunRefetchInterval("completed")).toBe(false);
    expect(deepViewRefetchInterval(true)).toBe(1500);
    expect(deepViewRefetchInterval(false)).toBe(false);
  });
});
