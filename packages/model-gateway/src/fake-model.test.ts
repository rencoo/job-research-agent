import { describe, expect, it } from "vitest";
import { FakeModel, LocalDemoModel, ModelGatewayError } from "./index";

const validateMessage = (value: unknown): { message: string } => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("message" in value) ||
    typeof value.message !== "string"
  ) {
    throw new Error("invalid model payload");
  }
  return { message: value.message };
};

describe("FakeModel", () => {
  it("returns deterministic validated data", async () => {
    const model = new FakeModel({ type: "success", value: { message: "ok" } });
    await expect(
      model.generateStructured({ prompt: "test", validate: validateMessage }),
    ).resolves.toEqual({ message: "ok" });
    expect(model.prompts).toEqual(["test"]);
  });

  it("throws configured structured failures", async () => {
    const error = new ModelGatewayError("rate_limited", "try later", true);
    const model = new FakeModel({ type: "failure", error });
    await expect(
      model.generateStructured({ prompt: "test", validate: validateMessage }),
    ).rejects.toBe(error);
  });

  it("supports delayed cancellation", async () => {
    const controller = new AbortController();
    const model = new FakeModel({
      type: "success",
      value: { message: "late" },
      delayMs: 1_000,
    });
    const promise = model.generateStructured({
      prompt: "test",
      validate: validateMessage,
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("LocalDemoModel", () => {
  it("emits work_content claims instead of legacy content dimensions", async () => {
    const claims = await new LocalDemoModel().generateStructured({
      prompt: "screen",
      metadata: { task: "screen-opportunity", input: { resumeText: "TypeScript Agent", jobText: "TypeScript Agent" } },
      validate: (value) => value as Array<{ dimension: string }>,
    });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.dimension !== "ownership" && claim.dimension !== "product_interest")).toBe(true);
    expect(claims.some((claim) => claim.dimension === "work_content")).toBe(true);
  });
});
