import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

function renderApp() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("uses job analysis as the home page and keeps healthy runtime status quiet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/profile") return new Response("null");
        if (String(input).startsWith("/api/opportunities")) return new Response("[]");
        return new Response(
          JSON.stringify({
            status: "healthy",
            components: {
              api: { status: "healthy" },
              database: { status: "healthy" },
              worker: { status: "healthy" },
            },
          }),
        );
      }),
    );
    renderApp();
    expect(await screen.findByRole("heading", { name: "分析一个岗位" })).toBeInTheDocument();
    expect(screen.queryByText("本地运行时正常")).not.toBeInTheDocument();
    expect(screen.queryByText("运行状态")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "历史记录" })).toBeInTheDocument();
  });

  it("shows degraded and connection error states", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === "/api/profile") return new Response("null");
        if (String(input).startsWith("/api/opportunities")) return new Response("[]");
        return new Response(
          JSON.stringify({
            status: "degraded",
            components: {
              api: { status: "healthy" },
              database: { status: "healthy" },
              worker: { status: "degraded", message: "Worker unavailable" },
            },
          }),
          { status: 503 },
        );
      }),
    );
    const first = renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("部分组件不可用");
    first.unmount();

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    renderApp();
    expect(await screen.findByRole("alert")).toHaveTextContent("无法连接本地服务");
  });
});
