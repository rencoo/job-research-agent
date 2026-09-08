import type { ResearchRun, ResearchState } from "@job-research/contracts";

export const ACTIVE_DEEP_RUN_STATUSES = ["queued", "running", "waiting", "needs_attention", "cancelling"] as const;

export function isActiveDeepRunStatus(status: ResearchRun["status"]): boolean {
  return (ACTIVE_DEEP_RUN_STATUSES as readonly string[]).includes(status);
}

export const DEEP_RESEARCH_FLOW_NODES = [
  { id: "verify_company", label: "核实公司", stages: ["resolve_company"] },
  { id: "research_company", label: "研究公司", stages: ["company_snapshot", "build_research_plan"] },
  { id: "gather_evidence", label: "收集岗位证据", stages: ["gather_sources"] },
  { id: "verify_evidence", label: "核验证据与评估", stages: ["build_claims", "assess_dimensions"] },
  { id: "generate_report", label: "生成报告", stages: ["deep_research_report"] },
] as const;

export type DeepFlowNodeState = "complete" | "active" | "waiting" | "failed" | "pending";

export type DeepFlowNode = {
  id: string;
  label: string;
  state: DeepFlowNodeState;
};

function nodeIndexForStage(stage: string | null | undefined): number {
  if (!stage) return 0;
  const index = DEEP_RESEARCH_FLOW_NODES.findIndex((node) => node.stages.includes(stage as never));
  return index >= 0 ? index : 0;
}

export function projectDeepResearchFlow(run: Pick<ResearchRun, "status" | "currentStage">, state: Pick<ResearchState, "diagnostic">): DeepFlowNode[] {
  const stageIndex = nodeIndexForStage(run.currentStage);
  const failedIndex = run.status === "failed" ? nodeIndexForStage(state.diagnostic?.stage ?? run.currentStage) : -1;

  return DEEP_RESEARCH_FLOW_NODES.map((node, index) => {
    if (run.status === "completed") return { id: node.id, label: node.label, state: "complete" as const };
    if (run.status === "needs_attention" && node.id === "verify_company") return { id: node.id, label: node.label, state: "waiting" as const };
    if (run.status === "failed" && index === failedIndex) return { id: node.id, label: node.label, state: "failed" as const };
    if (run.status === "failed" && index < failedIndex) return { id: node.id, label: node.label, state: "complete" as const };
    if (run.status === "needs_attention" && index > 0) return { id: node.id, label: node.label, state: "pending" as const };
    if (index < stageIndex) return { id: node.id, label: node.label, state: "complete" as const };
    if (["queued", "running", "waiting", "cancelling"].includes(run.status) && index === stageIndex) {
      return { id: node.id, label: node.label, state: "active" as const };
    }
    return { id: node.id, label: node.label, state: "pending" as const };
  });
}

export const SOURCE_FAILURE_LABELS: Record<string, string> = {
  restricted_page: "页面访问受限",
  unsupported_content: "内容格式不支持",
  network_error: "网络或页面不可用",
  search_unavailable: "搜索服务不可用",
  unknown: "其他读取问题",
};

export function deepRunRefetchInterval(status: ResearchRun["status"] | undefined): number | false {
  return status && isActiveDeepRunStatus(status) ? 1000 : false;
}

export function deepViewRefetchInterval(hasActiveRun: boolean): number | false {
  return hasActiveRun ? 1500 : false;
}

export function formatSourceReadSummary(state: Pick<ResearchState, "sourceReadSummary">): string | null {
  const summary = state.sourceReadSummary;
  if (!summary) return null;
  if (summary.attempts === 0) return "暂无来源读取统计";
  const parts = [`已尝试读取 ${summary.attempts} 个来源，成功 ${summary.successes} 个`];
  for (const [key, count] of Object.entries(summary.failures)) {
    parts.push(`${SOURCE_FAILURE_LABELS[key] ?? "读取失败"} ${count} 次`);
  }
  return parts.join(" · ");
}
