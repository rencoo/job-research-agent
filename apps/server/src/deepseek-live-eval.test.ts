import { describe, expect, it } from "vitest";
import { assertLiveEvalEnabled } from "./deepseek-live-eval";

describe("DeepSeek live eval guard", () => {
  it("refuses to run without the explicit cost switch", () => {
    expect(() => assertLiveEvalEnabled({ JRA_MODEL_PROVIDER: "deepseek" })).toThrow("JRA_RUN_LIVE_EVAL=1");
  });

  it("requires the DeepSeek provider even when the switch is present", () => {
    expect(() => assertLiveEvalEnabled({ JRA_RUN_LIVE_EVAL: "1", JRA_MODEL_PROVIDER: "local" })).toThrow("JRA_MODEL_PROVIDER=deepseek");
  });
});
