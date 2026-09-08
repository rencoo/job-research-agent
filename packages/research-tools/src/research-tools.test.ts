import { describe, expect, it, vi } from "vitest";
import { FakeSearch, PublicPageReader, TavilySearch, extractHtml, isPublicAddress, redactSearch, resolvePublicUrl } from "./index";
const signal = new AbortController().signal;
describe("research adapters", () => {
  it.each(["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1", "100.64.0.1", "0.0.0.0"])("rejects non-public %s", address => expect(isPublicAddress(address)).toBe(false));
  it("rejects mixed DNS answers and credentials", async () => {
    await expect(resolvePublicUrl("https://public.example", async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }])).rejects.toThrow("blocked_address");
    await expect(resolvePublicUrl("http://user:pass@example.com")).rejects.toThrow("blocked_address");
    await expect(resolvePublicUrl("file:///tmp/file")).rejects.toThrow();
  });
  it("keeps public targets and strips search PII", async () => { expect((await resolvePublicUrl("https://example.com", async () => [{ address: "8.8.8.8", family: 4 }])).address.address).toBe("8.8.8.8"); expect(redactSearch("Company a@b.com 13800138000")).toBe("Company  "); });
  it("passes search parameters and hides upstream errors", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ results: [{ url: "https://example.com", title: "Page", content: "snippet" }] })));
    expect(await new TavilySearch("secret", fetcher).search("company", signal)).toHaveLength(1);
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toMatchObject({ include_answer: false, include_raw_content: false });
    await expect(new TavilySearch("secret", async () => new Response("private key secret", { status: 401 })).search("q", signal)).rejects.toThrow("tavily_authentication_failed");
  });
  it("extracts text without executing scripts", () => { const doc = extractHtml("<html><title>Test</title><body><main>Company information</main><script>throw new Error('execute')</script></body></html>", "https://example.com"); expect(doc.text).toContain("Company information"); expect(doc.text).not.toContain("throw new Error"); });
  it("does not invoke browser to bypass blocked pages", async () => { const fallback = vi.fn(); const reader = new PublicPageReader(async () => ({ url: "https://example.com", status: 403, type: "text/html", body: Buffer.from("blocked") }), fallback); expect(await reader.read("https://example.com", signal)).toMatchObject({ status: "blocked" }); expect(fallback).not.toHaveBeenCalled(); });
  it("uses browser fallback only for sparse JS pages", async () => { const fallback = vi.fn(async () => ({ status: "ok" as const, url: "https://example.com", title: "rendered", text: "rendered content", method: "browser" as const })); const reader = new PublicPageReader(async () => ({ url: "https://example.com", status: 200, type: "text/html", body: Buffer.from('<div id="root"></div><script src="app.js"></script>') }), fallback); expect(await reader.read("https://example.com", signal)).toMatchObject({ method: "browser" }); expect(fallback).toHaveBeenCalledOnce(); });
  it("fake search honours cancellation", async () => { const controller = new AbortController(); controller.abort(); await expect(new FakeSearch().search("q", controller.signal)).rejects.toThrow(); });
});

// The socket adapter is replaced, while the real DNS/redirect/size policy executes.
import { createSafeFetch, type HttpTransport } from "./page-reader";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
describe("safe HTTP connection policy", () => {
  function transport(responses: { status: number; location?: string; body: string }[]) {
    const calls: string[] = [];
    const connect: HttpTransport = (url, options, callback) => {
      calls.push(url.href);
      const request = new EventEmitter() as ClientRequest;
      request.end = (() => { queueMicrotask(() => {
        const value = responses.shift()!; const response = new PassThrough() as unknown as IncomingMessage & PassThrough;
        response.statusCode = value.status; response.headers = { "content-type": "text/html", ...(value.location ? { location: value.location } : {}) };
        callback(response); response.end(value.body);
      }); return request; }) as ClientRequest["end"];
      expect(options.agent).toBe(false); expect(options.headers).not.toHaveProperty("cookie"); expect(options.lookup).toBeTypeOf("function");
      return request;
    };
    return { connect, calls };
  }
  it("blocks a public-to-private redirect before opening the next socket", async () => {
    const stub = transport([{ status: 302, location: "http://127.0.0.1/private", body: "" }]);
    await expect(createSafeFetch(async () => [{ address: "8.8.8.8", family: 4 }], 1000, stub.connect)("https://example.com", signal)).rejects.toThrow("blocked_address");
    expect(stub.calls).toEqual(["https://example.com/"]);
  });
  it("bounds response bodies", async () => {
    const stub = transport([{ status: 200, body: "body exceeds limit" }]);
    await expect(createSafeFetch(async () => [{ address: "8.8.8.8", family: 4 }], 3, stub.connect)("https://example.com", signal)).rejects.toThrow("response_too_large");
  });
});
