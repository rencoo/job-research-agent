import { z } from "zod";
export class ResearchToolError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = "ResearchToolError"; }
}
export interface SearchResult { url: string; title: string; snippet: string }
export interface SearchPort { search(query: string, signal: AbortSignal): Promise<SearchResult[]> }
export type PageResult = { status: "ok"; url: string; title: string; text: string; method: "http" | "browser" | "fixture" } | { status: "blocked" | "failed"; reason: string };
export interface PageReaderPort { read(url: string, signal: AbortSignal): Promise<PageResult> }
export function redactSearch(value: string): string { return value.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "").replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, "").slice(0, 500); }
const ResultsSchema = z.object({ results: z.array(z.object({ url: z.string().url(), title: z.string(), content: z.string().optional() })) });
export class TavilySearch implements SearchPort {
  constructor(private readonly key: string, private readonly fetcher: typeof fetch = fetch) { if (!key.trim()) throw new ResearchToolError("tavily_key_required"); }
  async search(query: string, signal: AbortSignal): Promise<SearchResult[]> {
    const response = await this.fetcher("https://api.tavily.com/search", { method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" }, body: JSON.stringify({ query: redactSearch(query), max_results: 5, search_depth: "basic", include_answer: false, include_raw_content: false, auto_parameters: false }) });
    if (!response.ok) throw new ResearchToolError(response.status === 401 || response.status === 403 ? "tavily_authentication_failed" : "tavily_unavailable", response.status === 429 || response.status >= 500);
    const reader = response.body?.getReader(); if (!reader) throw new ResearchToolError("tavily_empty_response");
    let body = ""; const decoder = new TextDecoder(); let bytes = 0;
    try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 2_000_000) throw new ResearchToolError("tavily_response_too_large"); body += decoder.decode(value, { stream: true }); } } finally { await reader.cancel(); }
    const parsed = ResultsSchema.safeParse(JSON.parse(body)); if (!parsed.success) throw new ResearchToolError("tavily_invalid_response");
    return parsed.data.results.filter(r => /^https?:\/\//.test(r.url)).map(r => ({ url: r.url, title: r.title, snippet: r.content ?? "" }));
  }
}
export class FakeSearch implements SearchPort {
  readonly queries: string[] = [];
  constructor(private readonly results: SearchResult[] = [{ url: "https://demo.example/about", title: "合成示例公司", snippet: "仅用于离线演示" }]) {}
  async search(query: string, signal: AbortSignal) { signal.throwIfAborted(); this.queries.push(query); return this.results; }
}
export class FakePageReader implements PageReaderPort {
  readonly urls: string[] = [];
  constructor(private readonly pages: Record<string, PageResult> = { "https://demo.example/about": { status: "ok", url: "https://demo.example/about", title: "合成示例公司", text: "合成示例公司（离线演示，并非真实公司）。官网介绍：团队开发 AI 工作流产品。招聘岗位参与 TypeScript 产品开发。合成团队包含工程与设计岗位。融资与经营数据未公开。工作时间需要向 HR 核实。具体薪资与办公地点需要向 HR 核实。", method: "fixture" } }) {}
  async read(url: string, signal: AbortSignal): Promise<PageResult> { signal.throwIfAborted(); this.urls.push(url); return this.pages[url] ?? { status: "failed", reason: "fixture_missing" }; }
}
export * from "./page-reader";
