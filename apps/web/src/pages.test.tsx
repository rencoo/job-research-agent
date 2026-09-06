import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIMENSION_IDS, type ScreeningReport } from "@job-research/contracts";
import { App, router } from "./App";
import { ReportCard, RunControls } from "./pages";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const now = "2026-09-05T00:00:00.000Z";
const weights = Object.fromEntries(DIMENSION_IDS.map((id) => [id, 1 / 6]));
const profile = { id: "current", resumeText: "TypeScript engineer", targetRoles: ["AI Engineer"], targetLocations: [], salary: null, commuteToleranceMinutes: null, highlights: [], constraints: [], redFlags: [], weights, explicitWeightDimensions: [], resumeVersion: 1, profileVersion: 1, version: 1, updatedAt: now };
const field = (value: unknown = null, source = "unknown") => ({ value, source, revision: 0 });
const draft = { opportunityId: "o1", status: "confirmed", version: 2, extractionRevision: 1, fields: { title: field("AI Engineer", "extracted"), company: field("Demo", "extracted"), location: field("上海", "extracted"), salaryMinMonthly: field(30000, "extracted"), salaryMaxMonthly: field(40000, "extracted"), payMonths: field(12, "default"), responsibilities: field("Build Agent", "extracted"), requirements: field("TypeScript", "extracted"), benefits: field(), }, assumptions: ["按 12 薪估算"], conflicts: [], confirmedAt: now, confirmedVersion: 2 };
const detail = { id: "o1", title: "AI Engineer", company: "Demo", location: "上海", importStatus: "ready", draftStatus: "confirmed", recommendation: null, currentReportId: null, updatedAt: now, sourceText: "JD", draft, runs: [], reports: [] };

function renderApp() {
  const fetcher = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, options?: RequestInit) => String(input) === "/api/health" ? json({ status: "healthy", components: { api: { status: "healthy" }, database: { status: "healthy" }, worker: { status: "healthy" } } }) : fetcher(input, options));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

beforeEach(() => { vi.stubGlobal("scrollTo", vi.fn()); });
afterEach(() => { cleanup(); router.history.replace("/"); vi.unstubAllGlobals(); });

describe("business pages", () => {
  it("keeps JD entry on the home page while collecting the required resume in a dialog", async () => {
    const savedProfile = { ...profile, resumeText: "New resume" };
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input) === "/api/profile" && options?.method === "PUT") return json(savedProfile);
      if (String(input) === "/api/profile") return json(null);
      if (String(input).startsWith("/api/opportunities")) return json([]);
      return json({});
    });
    vi.stubGlobal("fetch", fetcher); renderApp();
    expect(await screen.findByRole("heading", { name: "分析一个岗位" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("JD 1"), { target: { value: "JD remains here" } });
    fireEvent.click(screen.getByRole("button", { name: "录入简历" }));
    expect(screen.getByRole("dialog", { name: "录入你的简历" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("弹窗当前简历"), { target: { value: "New resume" } });
    fireEvent.change(screen.getByLabelText("弹窗目标岗位"), { target: { value: "AI Engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并用于分析" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("JD 1")).toHaveValue("JD remains here");
    expect(screen.getByRole("button", { name: "预览与修改" })).toBeInTheDocument();
  });

  it("previews an existing resume as Markdown and edits preview fields on demand", async () => {
    const markdownProfile = { ...profile, resumeText: "# TypeScript 工程师\n\n- Agent Runtime", targetRoles: ["AI Engineer", "Agent Engineer"] };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === "/api/profile" ? json(markdownProfile) : String(input).startsWith("/api/opportunities") ? json([]) : json({})));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "预览与修改" }));
    expect(screen.getByRole("heading", { name: "TypeScript 工程师" })).toBeInTheDocument();
    expect(screen.getByText("Agent Runtime")).toBeInTheDocument();
    expect(screen.getByText("AI Engineer")).toBeInTheDocument();
    expect(screen.queryByLabelText("弹窗当前简历")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑当前简历" }));
    expect(screen.getByLabelText("弹窗当前简历")).toHaveValue(markdownProfile.resumeText);
    fireEvent.click(screen.getAllByRole("button", { name: "取消" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "编辑目标岗位" }));
    expect(screen.getByLabelText("弹窗目标岗位")).toHaveValue("AI Engineer, Agent Engineer");
  });

  it("loads a direct profile route and saves all profile dimensions", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => String(input) === "/api/profile" && options?.method === "PUT" ? json(profile) : json(null)); vi.stubGlobal("fetch", fetcher);
    renderApp(); await router.navigate({ to: "/profile" });
    expect(await screen.findByRole("heading", { name: "我的简历与画像" })).toBeInTheDocument();
    expect(screen.getByLabelText("当前简历")).toHaveAttribute("placeholder", "粘贴完整简历文本，建议包含工作经历、项目经历、技能与教育背景");
    expect(screen.getByRole("button", { name: "编辑分析偏好" })).toBeInTheDocument();
    expect(screen.queryByLabelText("期望地点")).not.toBeInTheDocument();
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "编辑分析偏好" }));
    expect(screen.getByLabelText("目标岗位")).toHaveAttribute("placeholder", "例如：AI 应用工程师, AI Product Engineer");
    expect(screen.getByText("支持 Markdown；将用于岗位匹配分析，每次分析都会保存当时的独立快照。")).toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("靠谱的公司和人重要程度"), { target: { value: "3" } });
    expect(screen.getByLabelText("靠谱的公司和人重要程度")).toHaveAttribute("aria-valuetext", "较高");
    fireEvent.change(screen.getByLabelText("当前简历"), { target: { value: "TypeScript engineer" } }); fireEvent.change(screen.getByLabelText("目标岗位"), { target: { value: "AI Engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存画像" })); expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/重要程度$/)).toHaveLength(6);
    expect(screen.getByText(/工作内容包含主导权和产品方向/)).toBeInTheDocument();
    const body = JSON.parse(String(fetcher.mock.calls.find((call) => call[1]?.method === "PUT")?.[1]?.body)); expect(Object.keys(body.weights)).toHaveLength(6); expect(body.weights.work_content).toBeDefined(); expect(body.weights.people_and_company_reliability).toBe("high"); expect(body.weights).not.toHaveProperty("ownership"); expect(body.weights).not.toHaveProperty("product_interest");
  });

  it("previews saved profile preferences and only shows inputs after edit", async () => {
    const existing = { ...profile, targetRoles: ["AI 应用工程师", "AI Agent 工程师"], targetLocations: ["杭州"], highlights: ["Agent", "Workflow"], redFlags: [{ text: "薪资低于 18000", level: "blocking" }] };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === "/api/profile" ? json(existing) : json({})));
    renderApp(); await router.navigate({ to: "/profile" });
    expect(await screen.findByText("AI 应用工程师")).toBeInTheDocument();
    expect(screen.getByText("杭州")).toBeInTheDocument();
    expect(screen.getByText("Agent、Workflow")).toHaveAttribute("title", "Agent、Workflow");
    expect(screen.getByText("薪资低于 18000")).toHaveAttribute("title", "薪资低于 18000");
    expect(screen.queryByLabelText("当前简历")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("期望地点")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑分析偏好" }));
    expect(screen.getByLabelText("目标岗位")).toHaveValue("AI 应用工程师, AI Agent 工程师");
    expect(screen.getByLabelText("期望地点")).toHaveValue("杭州");
    expect(screen.getByLabelText("直接排除")).toHaveValue("薪资低于 18000");
  });

  it("does not claim a failed profile save succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, options?: RequestInit) => options?.method === "PUT" ? json({ error: { code: "version_conflict", message: "请重新加载", retryable: false } }, 409) : json(null)));
    renderApp(); await router.navigate({ to: "/profile" }); fireEvent.change(await screen.findByLabelText("当前简历"), { target: { value: "resume" } }); fireEvent.click(screen.getByRole("button", { name: "编辑分析偏好" })); fireEvent.change(screen.getByLabelText("目标岗位"), { target: { value: "role" } }); fireEvent.click(screen.getByRole("button", { name: "保存画像" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("version_conflict"); expect(screen.queryByText("已保存")).not.toBeInTheDocument();
  });

  it("supports up to twenty JD inputs and shows per-item needs-input guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, options?: RequestInit) => options?.method === "POST" ? json({ id: "b1", resourceId: "b1", created: true }) : String(input).includes("/api/import-batches/b1") ? json({ id: "b1", createdAt: now, items: [{ id: "i1", opportunityId: "o1", jobId: null, status: "needs_input", error: null }] }) : json({})));
    renderApp(); await router.navigate({ to: "/import" }); const add = await screen.findByRole("button", { name: "+ 添加另一个 JD" }); for (let i = 1; i < 20; i += 1) fireEvent.click(add); expect(screen.getAllByLabelText(/^JD \d+$/)).toHaveLength(20); expect(add).toBeDisabled();
    for (const [index, textarea] of screen.getAllByLabelText(/^JD \d+$/).entries()) fireEvent.change(textarea, { target: { value: index === 0 ? "https://example.com" : `JD ${index}` } });
    fireEvent.click(screen.getByRole("button", { name: "识别岗位（20）" })); expect(await screen.findByText("该输入只有链接，请重新粘贴 JD 文本。")).toBeInTheDocument();
  });

  it("passes history filters and renders empty state without a board", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) => json([])); vi.stubGlobal("fetch", fetcher); renderApp(); await router.navigate({ to: "/opportunities" });
    expect(await screen.findByText("暂无匹配岗位。")).toBeInTheDocument(); fireEvent.change(screen.getByLabelText("关键词"), { target: { value: "Demo" } });
    await waitFor(() => expect(fetcher.mock.calls.some((call) => String(call[0]).includes("keyword=Demo"))).toBe(true)); expect(screen.queryByText("看板")).not.toBeInTheDocument();
  });

  it("previews a confirmed draft with wrapped long text until the user edits", async () => {
    const previewDetail = { ...detail, draft: { ...draft, fields: { ...draft.fields, responsibilities: field("构建 Agent\n维护工作流", "extracted") } } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("/api/opportunities/o1") ? json(previewDetail) : json({})));
    renderApp(); await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    expect(await screen.findByRole("button", { name: "编辑岗位草稿" })).toBeInTheDocument();
    expect(screen.queryByLabelText("公司")).not.toBeInTheDocument();
    expect(screen.getByText("岗位名称")).toBeInTheDocument();
    expect(screen.getByText("-")).toBeInTheDocument();
    const duties = screen.getByText((_, element) => element?.classList.contains("multiline") === true && (element.textContent ?? "").includes("构建 Agent") && (element.textContent ?? "").includes("维护工作流"));
    expect(duties).toHaveClass("multiline");
    expect(duties.textContent).toContain("\n");
  });

  it("opens an unconfirmed draft in edit mode", async () => {
    const unconfirmed = { ...detail, draftStatus: "draft", draft: { ...draft, status: "draft", confirmedAt: null, confirmedVersion: null } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("/api/opportunities/o1") ? json(unconfirmed) : json({})));
    renderApp(); await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    expect(await screen.findByLabelText("公司")).toHaveValue("Demo");
    expect(screen.queryByRole("button", { name: "编辑岗位草稿" })).not.toBeInTheDocument();
  });

  it("keeps confirmed draft edits local until save", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).includes("/api/opportunities/o1") ? json(detail) : json({}));
    vi.stubGlobal("fetch", fetcher); renderApp(); await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    fireEvent.click(await screen.findByRole("button", { name: "编辑岗位草稿" }));
    fireEvent.change(screen.getByLabelText("公司"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "完成" }));
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "编辑岗位草稿" }));
    fireEvent.change(screen.getByLabelText("公司"), { target: { value: "Temp" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.queryByText("Temp")).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(false);
  });

  it("edits a confirmed draft, starts screening, and subscribes to Run events", async () => {
    const urls: string[] = []; class FakeSource { onmessage = null; onerror = null; constructor(url: string) { urls.push(url); } close() {} } vi.stubGlobal("EventSource", FakeSource);
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => { const url = String(input); if (options?.method === "PATCH") return json({ ...draft, status: "draft", version: 3, confirmedAt: null, confirmedVersion: null }); if (url.endsWith("/screening-runs")) return json({ id: "r1", resourceId: "r1", created: true }); if (url === "/api/runs/r1") return json({ id: "r1", opportunityId: "o1", jobId: "j1", status: "queued", currentStage: null, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now }); return json(detail); }); vi.stubGlobal("fetch", fetcher);
    renderApp(); await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } }); expect(await screen.findByText("状态：confirmed · 版本 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑岗位草稿" })); fireEvent.change(screen.getByLabelText("公司"), { target: { value: "Changed" } }); fireEvent.click(screen.getByRole("button", { name: "保存草稿" })); await waitFor(() => expect(fetcher.mock.calls.some((call) => call[1]?.method === "PATCH")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "开始初筛" })); await waitFor(() => expect(urls).toContain("/api/runs/r1/events"));
  });

  it("reloads the Draft after an optimistic concurrency conflict", async () => {
    let gets = 0; const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => { if (options?.method === "PATCH") return json({ error: { code: "version_conflict", message: "reload", retryable: false } }, 409); if (String(input).includes("/api/opportunities/o1")) { gets += 1; return json(detail); } return json({}); }); vi.stubGlobal("fetch", fetcher);
    renderApp(); await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } }); await screen.findByText("状态：confirmed · 版本 2"); fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("version_conflict"); await waitFor(() => expect(gets).toBeGreaterThan(1));
  });

  it("retries a failed import item independently", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => options?.method === "POST" && String(input).includes("retry") ? json({ id: "j2", resourceId: "i1", created: true }) : options?.method === "POST" ? json({ id: "b1", resourceId: "b1", created: true }) : json({ id: "b1", createdAt: now, items: [{ id: "i1", opportunityId: "o1", jobId: "j1", status: "failed", error: { code: "extraction_failed", message: "失败", retryable: true } }] })); vi.stubGlobal("fetch", fetcher);
    renderApp(); await router.navigate({ to: "/import" }); fireEvent.change(await screen.findByLabelText("JD 1"), { target: { value: "JD text" } }); fireEvent.click(screen.getByRole("button", { name: "识别岗位（1）" })); fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/import-items/i1/retry"))).toBe(true));
  });

  it("offers cancel and child retry controls for Run states", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/retry") ? json({ id: "child", resourceId: "child", created: true }) : json({ id: "r", opportunityId: "o", jobId: "j", status: "cancelled", currentStage: null, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now })); vi.stubGlobal("fetch", fetcher); const changed = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const base = { id: "r", opportunityId: "o", jobId: "j", status: "queued" as const, currentStage: null, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now };
    const first = render(<QueryClientProvider client={client}><RunControls run={base} onChanged={changed} /></QueryClientProvider>); fireEvent.click(screen.getByRole("button", { name: "取消" })); await waitFor(() => expect(changed).toHaveBeenCalled()); first.unmount();
    render(<QueryClientProvider client={new QueryClient()}><RunControls run={{ ...base, id: "failed", status: "failed" }} onChanged={changed} /></QueryClientProvider>); fireEvent.click(screen.getByRole("button", { name: "重试为新 Run" })); await waitFor(() => expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith("/retry"))).toBe(true));
  });

  it("renders recommendation, six dimensions, unknowns and report state", () => {
    const dimensions = Object.fromEntries(DIMENSION_IDS.map((id) => [id, { verdict: id === "life_radius" ? "unknown" as const : "positive" as const, confidence: "low" as const, claimIds: [], risks: [], unknowns: id === "life_radius" ? ["核对通勤"] : [] }])) as unknown as ScreeningReport["dimensions"];
    const report: ScreeningReport = { id: "rp", runId: "r", opportunityId: "o", recommendation: "worth_exploring", confidence: "medium", status: "stale", effective: false, dimensions, matches: ["Agent 匹配"], risks: ["职责过载"], unknowns: ["核对通勤"], rules: ["12 薪"], claims: [{ id: "c1", dimension: "work_content", statement: "工作内容匹配", polarity: "positive", confidence: "medium", status: "supported", resumeEvidence: "Agent", jobEvidence: "Agent" }], assumptions: ["按 12 薪估算"], modelLabel: "本地演示模型", createdAt: now };
    const rendered = render(<><ReportCard report={report} /><ReportCard report={{ ...report, id: "partial", status: "partial" }} /><ReportCard report={{ ...report, id: "invalid", status: "invalidated" }} /></>); expect(screen.getAllByText("worth_exploring")).toHaveLength(3); expect(screen.getByText(/stale · medium/)).toBeInTheDocument(); expect(screen.getAllByText("工作内容").length).toBeGreaterThan(0); expect(screen.queryByText("Ownership")).not.toBeInTheDocument(); expect(screen.queryByText("产品兴趣")).not.toBeInTheDocument(); expect(screen.getAllByText("待核验：核对通勤").length).toBeGreaterThan(0); expect(screen.getAllByText("Agent 匹配")).toHaveLength(3); expect(screen.getAllByText("简历证据：Agent")).toHaveLength(3); expect(rendered.container.querySelectorAll(".partial, .invalidated")).toHaveLength(2);
  });
});
