import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIMENSION_IDS, LOCAL_MODEL_CONFIG, type DeepResearchReport } from "@job-research/contracts";
import { DeepResearchPanel, DeepReportCard } from "./deep-research-panel";

const json = (value: unknown) => new Response(JSON.stringify(value));
const now = "2026-09-08T00:00:00Z";
const run = { id: "r", opportunityId: "o", kind: "deep_research" as const, jobId: "j", status: "needs_attention" as const, currentStage: "resolve_company" as const, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now };
const state = {
  schemaVersion: 1, runId: "r", screeningReportId: "s", mode: "demo", refreshCompany: false,
  resolution: { status: "pending", selectedId: null, hint: "", version: 1, candidates: [{ id: "c", name: "示例公司", website: "https://example.com", legalName: null, location: "上海", aliases: [], basis: [{ documentId: "d", quote: "公司自述" }] }] },
  companyId: null, companySnapshotId: null, dependencyRunId: null, questions: [], documentIds: ["d"], sourceFailures: [],
  sourceReadSummary: { attempts: 2, successes: 0, failures: { restricted_page: 2 } },
  searchHits: [{ url: "https://example.com/about", title: "示例公司官网", snippet: "公司介绍页面", readStatus: "blocked" as const }],
  diagnostic: { stage: "resolve_company" as const, message: "找到了公开来源，但均无法安全读取，暂时无法自动识别公司。", suggestedAction: "补充公司官网或全名后重新识别，或跳过公司确认继续岗位研究。" },
  calls: 2, elapsedMs: 20, activeSince: null, round: 0, emptyRounds: 0, stopReason: null, error: null,
};
const failedRun = { ...run, status: "failed" as const, currentStage: "gather_sources" as const };
const failedState = {
  ...state,
  diagnostic: { stage: "gather_sources" as const, message: "搜索服务鉴权失败，请检查 Tavily API Key 配置。", suggestedAction: "更新 API Key 后重试深研。" },
  error: "搜索服务鉴权失败，请检查 Tavily API Key 配置。",
};

function wrap(component: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{component}</QueryClientProvider>);
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("deep research UI", () => {
  it("gates start on valid screening", async () => {
    vi.stubGlobal("fetch", async () => json({ states: [], reports: [], currentReportId: null }));
    wrap(<DeepResearchPanel opportunityId="o" canStart={false} runs={[]} />);
    expect(screen.getByRole("button", { name: "开始深度研究" })).toBeDisabled();
  });

  it("shows five-node flow, diagnostics, and submits typed skip response", async () => {
    const fetcher = vi.fn(async (input: string, options?: RequestInit) => input.endsWith("attention-responses") ? json({ ...run, status: "queued" }) : input.includes("/api/runs/") ? json(run) : json({ states: [state], reports: [], currentReportId: null }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("EventSource", class { close() {} });
    wrap(<DeepResearchPanel opportunityId="o" canStart runs={[run]} />);
    expect(await screen.findByText("核实公司")).toBeInTheDocument();
    expect(screen.getByText("搜索到的公开链接")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "示例公司官网" })).toHaveAttribute("href", "https://example.com/about");
    expect(screen.getByText("访问受限")).toBeInTheDocument();
    expect(screen.getByText(state.diagnostic!.message)).toBeInTheDocument();
    expect(screen.getByText(/已尝试读取 2 个来源/)).toBeInTheDocument();
    expect(screen.queryByText("tavily_authentication_failed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "跳过公司确认" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([url, options]) => url.endsWith("attention-responses") && JSON.parse(options!.body as string).action === "skip")).toBe(true));
  });

  it("shows failed node diagnostics and retry action", async () => {
    vi.stubGlobal("fetch", async (input: string) => input.includes("/api/runs/") ? json(failedRun) : json({ states: [failedState], reports: [], currentReportId: null }));
    vi.stubGlobal("EventSource", class { close() {} });
    wrap(<DeepResearchPanel opportunityId="o" canStart runs={[failedRun]} />);
    expect(await screen.findByText("深研未能完成")).toBeInTheDocument();
    expect(screen.getByText(failedState.diagnostic.message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试深研" })).toBeInTheDocument();
  });

  it("renders provenance, unknowns, and supporting original text", async () => {
    const dimensions = Object.fromEntries(DIMENSION_IDS.map(id => [id, { verdict: "unknown", confidence: "low", claimIds: id === "work_content" ? ["c"] : [], risks: [], unknowns: ["待核实工作安排"] }])) as unknown as DeepResearchReport["dimensions"];
    const report: DeepResearchReport = { schemaVersion: 1, id: "p", runId: "r", opportunityId: "o", companySnapshotId: null, status: "partial", effective: true, recommendation: "insufficient_information", dimensions, claims: [{ id: "c", ownerType: "run", ownerId: "r", dimension: "work_content", statement: "公司称从事 AI 产品研发", attribution: "官网自述", polarity: "mixed", confidence: "low", status: "supported" }], evidence: [{ id: "e", claimId: "c", documentId: "d", quote: "从事 AI 产品研发", start: 0, end: 11, relation: "supports" }], documentIds: ["d"], risks: [], unknowns: [], rules: [], stopReason: "no_new_evidence", mode: "demo", modelConfig: LOCAL_MODEL_CONFIG, createdAt: now };
    vi.stubGlobal("fetch", async () => json({ id: "d", kind: "web", text: "从事 AI 产品研发", title: "官网", url: "https://example.com", finalUrl: "https://example.com", contentHash: "h", retrievedAt: now, method: "http", sourceType: "official" }));
    wrap(<DeepReportCard report={report} />);
    expect(screen.getByText(/不代表目标公司的事实/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("查看判断与证据 · 1 条"));
    expect(await screen.findByRole("link", { name: "查看原网页" })).toHaveAttribute("href", "https://example.com");
  });
});
