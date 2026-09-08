import { lookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { chromium } from "playwright";
import type { PageReaderPort, PageResult } from "./index";

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const resolveDns: Resolver = hostname => lookup(hostname, { all: true, verbatim: true });
export function isPublicAddress(address: string): boolean {
  try { const parsed = ipaddr.process(address); return parsed.range() === "unicast"; } catch { return false; }
}
export async function resolvePublicUrl(raw: string, resolver: Resolver = resolveDns) {
  const url = new URL(raw); const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) throw new Error("blocked_address");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname);
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error("blocked_address");
  return { url, address: addresses[0]! };
}
export interface HttpPage { url: string; status: number; type: string; body: Buffer; location?: string }
export type SafeFetch = (url: string, signal: AbortSignal) => Promise<HttpPage>;
export type HttpTransport = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
const publicTransport: HttpTransport = (url, options, callback) => (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, callback);
export function createSafeFetch(resolver: Resolver = resolveDns, maxBytes = 2_000_000, transport: HttpTransport = publicTransport): SafeFetch {
  return async (raw, outerSignal) => {
    const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(15_000)]);
    let current = raw;
    for (let hop = 0; hop < 6; hop++) {
      signal.throwIfAborted();
      const { url, address } = await resolvePublicUrl(current, resolver); signal.throwIfAborted();
      const result = await new Promise<HttpPage>((resolve, reject) => {
        const request = transport(url, {
          signal, agent: false, headers: { "user-agent": "JobResearchAgent/0.1", accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.1", "accept-encoding": "identity" },
          // Pin the validated address for the actual socket, preventing DNS rebinding.
          lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
        }, response => {
          let size = 0; const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { response.destroy(new Error("response_too_large")); return; } chunks.push(chunk); });
          response.on("error", reject);
          response.on("end", () => resolve({ url: url.href, status: response.statusCode ?? 0, type: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks), ...(response.headers.location ? { location: response.headers.location } : {}) }));
        });
        request.on("error", reject); request.end();
      });
      if (result.status >= 300 && result.status < 400 && result.location) { current = new URL(result.location, result.url).href; continue; }
      return result;
    }
    throw new Error("too_many_redirects");
  };
}
export function extractHtml(html: string, url: string): { title: string; text: string } {
  const dom = new JSDOM(html, { url });
  try {
    const doc = dom.window.document;
    doc.querySelectorAll("script,style,nav,footer,header,noscript,iframe,form").forEach(node => node.remove());
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    const text = article?.textContent?.trim() || (doc.querySelector("main,article,[role=main]") ?? doc.body)?.textContent || "";
    return { title: article?.title ?? doc.title, text: text.replace(/[\t ]+/g, " ").replace(/\n\s*\n/g, "\n").trim().slice(0, 60_000) };
  } finally { dom.window.close(); }
}
function restricted(text: string): boolean { return /captcha|verify you are human|access denied|请完成验证|登录后查看|安全验证|验证码/i.test(text.slice(0, 2000)); }
export class PublicPageReader implements PageReaderPort {
  constructor(private readonly safeFetch: SafeFetch = createSafeFetch(), private readonly browserRead = readBrowserPage) {}
  async read(url: string, signal: AbortSignal): Promise<PageResult> {
    try {
      const response = await this.safeFetch(url, signal);
      if ([401, 403, 429].includes(response.status)) return { status: "blocked", reason: `http_${response.status}` };
      if (response.status < 200 || response.status >= 300) return { status: "failed", reason: `http_${response.status}` };
      if (!/text\/html|application\/xhtml/.test(response.type)) return { status: "blocked", reason: "unsupported_content_type" };
      const html = response.body.toString("utf8"); if (restricted(html)) return { status: "blocked", reason: "restricted_page" };
      const extracted = extractHtml(html, response.url);
      if (extracted.text.length >= 120 || !/<script\b/i.test(html)) return extracted.text ? { status: "ok", url: response.url, ...extracted, method: "http" } : { status: "failed", reason: "empty_page" };
      return await this.browserRead(response.url, signal, this.safeFetch);
    } catch (error) {
      signal.throwIfAborted();
      return { status: error instanceof Error && error.message === "blocked_address" ? "blocked" : "failed", reason: error instanceof Error && ["blocked_address", "response_too_large", "too_many_redirects"].includes(error.message) ? error.message : "page_unavailable" };
    }
  }
}
export async function readBrowserPage(url: string, outerSignal: AbortSignal, safeFetch: SafeFetch): Promise<PageResult> {
  const signal = AbortSignal.any([outerSignal, AbortSignal.timeout(20_000)]);
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-networking", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
  const abort = () => { void browser.close(); }; signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    await context.routeWebSocket(/.*/, route => route.close());
    let requests = 0;
    await context.route(/.*/, async route => {
      try {
        if (++requests > 30 || route.request().method() !== "GET" || ["image", "media", "font"].includes(route.request().resourceType())) { await route.abort(); return; }
        const response = await safeFetch(route.request().url(), signal);
        // No original Cookie/Authorization headers, no Set-Cookie, no direct browser network access.
        await route.fulfill({ status: response.status, contentType: response.type, body: response.body });
      } catch { await route.abort().catch(() => undefined); }
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });
    const html = await page.content(); signal.throwIfAborted();
    if (restricted(html)) return { status: "blocked", reason: "restricted_page" };
    const extracted = extractHtml(html, page.url());
    return extracted.text ? { status: "ok", url: page.url(), ...extracted, method: "browser" } : { status: "failed", reason: "empty_page" };
  } finally { signal.removeEventListener("abort", abort); await browser.close(); }
}
