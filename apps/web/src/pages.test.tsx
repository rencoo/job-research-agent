import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  vi.stubGlobal("fetch", (input: string | URL | Request, options?: RequestInit) => String(input).endsWith("/deep-research") ? json({ states: [], reports: [], currentReportId: null }) : String(input) === "/api/health" ? json({ status: "healthy", components: { api: { status: "healthy" }, database: { status: "healthy" }, worker: { status: "healthy" } } }) : fetcher(input, options));
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
    expect(await screen.findByRole("heading", { name: "判断这个岗位值不值得跟" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("JD 1"), { target: { value: "JD remains here" } });
    fireEvent.click(screen.getByRole("button", { name: "录入简历" }));
    expect(screen.getByRole("dialog", { name: "录入你的简历" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("弹窗当前简历"), { target: { value: "New resume" } });
    fireEvent.change(screen.getByLabelText("弹窗目标岗位"), { target: { value: "AI Engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并用于分析" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByLabelText("JD 1")).toHaveValue("JD remains here");
    expect(screen.getByRole("button", { name: "预览" })).toBeInTheDocument();
  });

  it("previews an existing resume as Markdown and edits preview fields on demand", async () => {
    const markdownProfile = { ...profile, resumeText: "# TypeScript 工程师\n\n- Agent Runtime", targetRoles: ["AI Engineer", "Agent Engineer"] };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === "/api/profile" ? json(markdownProfile) : String(input).startsWith("/api/opportunities") ? json([]) : json({})));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "预览" }));
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
    const importance = screen.getByRole("group", { name: "靠谱的公司和人重要程度" });
    fireEvent.click(within(importance).getByRole("radio", { name: "较高" }));
    expect(within(importance).getByRole("radio", { name: "较高" })).toBeChecked();
    expect(within(importance).getByRole("radio", { name: "一般" })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("当前简历"), { target: { value: "TypeScript engineer" } }); fireEvent.change(screen.getByLabelText("目标岗位"), { target: { value: "AI Engineer" } });
    fireEvent.click(screen.getByRole("button", { name: "保存画像" })); expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(screen.getAllByRole("group", { name: /重要程度$/ })).toHaveLength(6);
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

  it("renders recent analysis records as compact links on the analysis page", async () => {
    const recent = [{ id: "o1", title: "AIGC全栈工程师", company: "杭州默默发财动画", location: "杭州", importStatus: "ready", draftStatus: "confirmed", recommendation: null, currentReportId: null, updatedAt: now }];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === "/api/profile" ? json(profile) : String(input).startsWith("/api/opportunities") ? json(recent) : json({})));
    renderApp(); await router.navigate({ to: "/" });
    const item = await screen.findByRole("link", { name: /AIGC全栈工程师/ });
    expect(item).toHaveAttribute("href", "/opportunities/o1");
    expect(item).toHaveTextContent("杭州默默发财动画 · 杭州");
    expect(screen.getByRole("link", { name: "查看全部" })).toHaveAttribute("href", "/opportunities");
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

  it("opens opportunity detail when a history card is clicked", async () => {
    const listItem = { id: "o1", title: "AI Engineer", company: "Demo", location: "上海", importStatus: "ready", draftStatus: "confirmed", recommendation: "cautious", currentReportId: null, updatedAt: now };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("/api/opportunities/o1") ? json(detail) : String(input).startsWith("/api/opportunities") ? json([listItem]) : json({})));
    renderApp(); await router.navigate({ to: "/opportunities" });
    const card = await screen.findByRole("link", { name: /AI Engineer/ });
    expect(card).toHaveAttribute("href", "/opportunities/o1");
    expect(card).toHaveTextContent("Demo · 上海");
    expect(card).toHaveTextContent("需谨慎");
    expect(card).toHaveTextContent("已抽取 · 已确认");
    expect(screen.getByRole("option", { name: "需谨慎" })).toHaveValue("cautious");
    expect(screen.queryByText("查看详情")).not.toBeInTheDocument();
    fireEvent.click(card);
    expect(await screen.findByText("岗位草稿")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI Engineer" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "取消" })).toHaveClass("compact-button", "draft-cancel-button");
    expect(screen.getByRole("button", { name: "保存" })).toHaveClass("compact-button");
    expect(screen.queryByRole("button", { name: "编辑岗位草稿" })).not.toBeInTheDocument();
  });

  it("saves then confirms the returned version and restores saved values after reopening", async () => {
    let current = detail;
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        const body = JSON.parse(String(options.body));
        current = { ...current, draft: { ...current.draft, status: "draft", version: 3, fields: { ...current.draft.fields, company: { ...current.draft.fields.company, value: body.fields.company.value } } } };
        return json(current.draft);
      }
      if (String(input).endsWith("/confirm")) {
        expect(JSON.parse(String(options?.body))).toEqual({ expectedVersion: 3 });
        current = { ...current, draft: { ...current.draft, status: "confirmed", version: 4 } };
        return json(current.draft);
      }
      return json(current);
    });
    vi.stubGlobal("fetch", fetcher); const view = renderApp();
    await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    fireEvent.click(await screen.findByRole("button", { name: "编辑岗位草稿" }));
    fireEvent.change(screen.getByLabelText("公司"), { target: { value: "Changed" } });
    expect(screen.getByRole("button", { name: "开始初筛" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("button", { name: "编辑岗位草稿" });
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存草稿" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认草稿" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始初筛" })).toBeEnabled();
    view.unmount(); renderApp();
    expect(await screen.findByText("Changed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑岗位草稿" }));
    fireEvent.change(screen.getByLabelText("公司"), { target: { value: "Temp" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(fetcher.mock.calls.filter((call) => call[1]?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["save", "confirm"])("preserves input when %s fails and allows retry", async (stage) => {
    let fail = true;
    let version = 2;
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      if (options?.method === "PATCH") {
        expect(JSON.parse(String(options.body)).expectedVersion).toBe(version);
        if (fail && stage === "save") return json({ error: { code: "version_conflict", message: "保存失败", retryable: false } }, 409);
        version += 1;
        return json({ ...draft, status: "draft", version });
      }
      if (String(input).endsWith("/confirm")) {
        expect(JSON.parse(String(options?.body)).expectedVersion).toBe(version);
        if (fail) return json({ error: { code: "incomplete_draft", message: "信息不完整", retryable: false } }, 422);
        return json({ ...draft, version: ++version });
      }
      return json(detail);
    });
    vi.stubGlobal("fetch", fetcher); renderApp();
    await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    fireEvent.click(await screen.findByRole("button", { name: "编辑岗位草稿" }));
    fireEvent.change(screen.getByLabelText("公司"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("公司")).toHaveValue("Changed");
    expect(screen.getByRole("button", { name: "开始初筛" })).toBeDisabled();
    if (stage === "save") expect(fetcher.mock.calls.some((call) => String(call[0]).endsWith("/confirm"))).toBe(false);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("button", { name: "编辑岗位草稿" });
  });

  it("retries a failed import item independently", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => options?.method === "POST" && String(input).includes("retry") ? json({ id: "j2", resourceId: "i1", created: true }) : options?.method === "POST" ? json({ id: "b1", resourceId: "b1", created: true }) : json({ id: "b1", createdAt: now, items: [{ id: "i1", opportunityId: "o1", jobId: "j1", status: "failed", error: { code: "extraction_failed", message: "失败", retryable: true } }] })); vi.stubGlobal("fetch", fetcher);
    renderApp(); await router.navigate({ to: "/import" }); fireEvent.change(await screen.findByLabelText("JD 1"), { target: { value: "JD text" } }); fireEvent.click(screen.getByRole("button", { name: "识别岗位（1）" })); fireEvent.click(await screen.findByRole("button", { name: "重试" }));
    await waitFor(() => expect(fetcher.mock.calls.some((call) => String(call[0]).includes("/api/import-items/i1/retry"))).toBe(true));
  });

  it("offers cancel and child retry controls for Run states", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => String(input).endsWith("/retry") ? json({ id: "child", resourceId: "child", created: true }) : json({ id: "r", opportunityId: "o", jobId: "j", status: "cancelled", currentStage: null, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now })); vi.stubGlobal("fetch", fetcher); const changed = vi.fn(); const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const base = { id: "r", opportunityId: "o", jobId: "j", status: "queued" as const, currentStage: null, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now };
    const first = render(<QueryClientProvider client={client}><RunControls run={base} onChanged={changed} /></QueryClientProvider>); fireEvent.click(screen.getByRole("button", { name: "取消分析" })); await waitFor(() => expect(changed).toHaveBeenCalled()); first.unmount();
    render(<QueryClientProvider client={new QueryClient()}><RunControls run={{ ...base, id: "failed", status: "failed" }} onChanged={changed} /></QueryClientProvider>); fireEvent.click(screen.getByRole("button", { name: "重新分析" })); await waitFor(() => expect(changed).toHaveBeenCalledWith("child"));
  });

  it("switches the visible analysis to the child run after retry", async () => {
    class FakeSource { onmessage = null; onerror = null; constructor(_url: string) {} close() {} }
    vi.stubGlobal("EventSource", FakeSource);
    const failed = { id: "failed-run", opportunityId: "o1", jobId: "j1", status: "failed" as const, currentStage: "semantic_match" as const, parentRunId: null, successorRunId: null, reportId: null, createdAt: now, updatedAt: now };
    const child = { id: "child-run", opportunityId: "o1", jobId: "j2", status: "queued" as const, currentStage: null, parentRunId: "failed-run", successorRunId: null, reportId: null, createdAt: now, updatedAt: now };
    let retried = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/screening-runs")) return json({ id: "failed-run", resourceId: "failed-run", created: true });
      if (url.endsWith("/retry")) { retried = true; return json({ id: "child-run", resourceId: "child-run", created: true }); }
      if (url === "/api/runs/failed-run") return json(retried ? { ...failed, successorRunId: "child-run" } : failed);
      if (url === "/api/runs/child-run") return json(child);
      if (url.includes("/api/opportunities/o1")) return json({ ...detail, runs: retried ? [{ ...failed, successorRunId: "child-run" }, child] : [failed] });
      if (url === "/api/profile") return json(profile);
      return json({});
    });
    vi.stubGlobal("fetch", fetcher);
    renderApp();
    await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    fireEvent.click(await screen.findByRole("button", { name: "开始初筛" }));
    expect(await screen.findByText("执行失败")).toBeInTheDocument();
    expect(screen.getByText("分析编号：failed-r")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重新分析" }));
    await waitFor(() => expect(screen.getByText("分析编号：child-ru")).toBeInTheDocument());
    expect(screen.queryByText("执行失败")).not.toBeInTheDocument();
  });

  it("shows a user-readable five-stage screening progress", async () => {
    const running = { id: "run-semantic", opportunityId: "o", jobId: "j", status: "running" as const, currentStage: "semantic_match" as const, parentRunId: null, successorRunId: null, reportId: null, modelConfig: { provider: "deepseek" as const, model: "deepseek-v4-flash", promptVersions: { extractJobDraft: "extract-job-draft/v1", screenOpportunity: "screen-opportunity/v1" } }, createdAt: now, updatedAt: now };
    vi.stubGlobal("fetch", vi.fn(async () => json(running)));
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RunControls run={running} onChanged={vi.fn()} /></QueryClientProvider>);
    expect(await screen.findByRole("heading", { name: "正在分析简历与岗位" })).toBeInTheDocument();
    expect(screen.getByText("第 2 / 5 步")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "初筛进度" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("AI 正在提取简历和 JD 中可核验的匹配证据，这一步通常耗时最长。")).toBeInTheDocument();
    expect(screen.getByText("模型：DeepSeek · deepseek-v4-flash")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("renders recommendation, six dimensions, unknowns and report state", () => {
    const dimensions = Object.fromEntries(DIMENSION_IDS.map((id) => [id, { verdict: id === "life_radius" ? "unknown" as const : "positive" as const, confidence: "low" as const, claimIds: [], risks: [], unknowns: id === "life_radius" ? ["核对通勤"] : [] }])) as unknown as ScreeningReport["dimensions"];
    const report: ScreeningReport = { id: "rp", runId: "r", opportunityId: "o", recommendation: "worth_exploring", confidence: "medium", status: "stale", effective: false, dimensions, matches: ["Agent 匹配"], risks: ["职责过载"], unknowns: ["核对通勤"], rules: ["12 薪"], claims: [{ id: "c1", dimension: "work_content", statement: "工作内容匹配", polarity: "positive", confidence: "medium", status: "supported", resumeEvidence: "Agent", jobEvidence: "Agent" }], assumptions: ["按 12 薪估算"], modelLabel: "本地演示模型", createdAt: now };
    const rendered = render(<><ReportCard report={report} /><ReportCard report={{ ...report, id: "partial", status: "partial" }} /><ReportCard report={{ ...report, id: "invalid", status: "invalidated" }} /></>); expect(screen.getAllByText("值得深入")).toHaveLength(3); expect(screen.getByText(/已过期 · 置信度中/)).toBeInTheDocument(); expect(rendered.container.querySelectorAll("details.report[open]")).toHaveLength(0); expect(rendered.container.querySelectorAll(".report-chevron")).toHaveLength(3); for (const heading of screen.getAllByRole("heading", { name: "值得深入" })) fireEvent.click(heading.closest("summary")!); expect(rendered.container.querySelectorAll("details.report[open]")).toHaveLength(3); expect(screen.getAllByText("工作内容").length).toBeGreaterThan(0); expect(screen.queryByText("Ownership")).not.toBeInTheDocument(); expect(screen.queryByText("产品兴趣")).not.toBeInTheDocument(); expect(screen.queryByRole("heading", { name: "待核验项" })).not.toBeInTheDocument(); expect(screen.getAllByText("待核验：核对通勤")).toHaveLength(3); expect(screen.getAllByText("Agent 匹配")).toHaveLength(3); expect(screen.getAllByText("简历证据：Agent")).toHaveLength(3); expect(screen.queryByText("按 12 薪估算")).not.toBeInTheDocument(); expect(rendered.container.querySelectorAll(".claims")).toHaveLength(3); expect(rendered.container.querySelectorAll(".partial, .invalidated")).toHaveLength(2);
  });

  it("shows report assumptions once under the analysis section, not in each recommendation card", async () => {
    const dimensions = Object.fromEntries(DIMENSION_IDS.map((id) => [id, { verdict: "positive" as const, confidence: "high" as const, claimIds: [], risks: [], unknowns: [] }])) as unknown as ScreeningReport["dimensions"];
    const report = (id: string, recommendation: ScreeningReport["recommendation"]): ScreeningReport => ({
      id, runId: id, opportunityId: "o1", recommendation, confidence: "high", status: "stale", effective: false, dimensions,
      matches: ["Agent 匹配"], risks: [], unknowns: [], rules: [], claims: [], assumptions: ["发薪月数未注明，按 12 薪估算"],
      modelLabel: "DeepSeek · deepseek-v4-flash", createdAt: now,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input).includes("/api/opportunities/o1")
      ? json({ ...detail, reports: [report("rp-1", "cautious"), report("rp-2", "worth_exploring")] })
      : json({})));
    renderApp();
    await router.navigate({ to: "/opportunities/$opportunityId", params: { opportunityId: "o1" } });
    expect(await screen.findByRole("heading", { name: "分析报告" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "补充说明" })).toBeInTheDocument();
    expect(screen.getAllByText("发薪月数未注明，按 12 薪估算")).toHaveLength(1);
    expect(screen.getByText("发薪月数未注明，按 12 薪估算").closest("blockquote")).toBeTruthy();
    expect(screen.getAllByText(/已过期 · 置信度高 · DeepSeek · deepseek-v4-flash/)).toHaveLength(2);
    expect(document.querySelectorAll("details.report[open]")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "需谨慎" }).closest(".report")?.textContent).not.toContain("发薪月数未注明，按 12 薪估算");
    expect(screen.getByRole("heading", { name: "值得深入" }).closest(".report")?.textContent).not.toContain("发薪月数未注明，按 12 薪估算");
  });
});
