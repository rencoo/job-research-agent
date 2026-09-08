import { describe, expect, it } from "vitest";
import {
  DeepSeekModel,
  FakeModel,
  LocalDemoModel,
  ModelGatewayError,
  ModelGatewayResolver,
  createModelRuntimeFromEnv,
  type ModelRequest,
  type ResponsesClient,
} from "./index";

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

const request = (overrides: Partial<ModelRequest<{ message: string }>> = {}): ModelRequest<{ message: string }> => ({
  task: "test",
  promptVersion: "test/v1",
  instructions: "test instructions",
  input: "test input",
  schemaName: "test_message",
  schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  validate: validateMessage,
  ...overrides,
});

describe("FakeModel", () => {
  it("returns deterministic validated data", async () => {
    const model = new FakeModel({ type: "success", value: { message: "ok" } });
    await expect(
      model.generateStructured(request()),
    ).resolves.toEqual({ message: "ok" });
    expect(model.prompts).toEqual(["test instructions"]);
  });

  it("throws configured structured failures", async () => {
    const error = new ModelGatewayError("rate_limited", "try later", true);
    const model = new FakeModel({ type: "failure", error });
    await expect(
      model.generateStructured(request()),
    ).rejects.toBe(error);
  });

  it("supports delayed cancellation", async () => {
    const controller = new AbortController();
    const model = new FakeModel({
      type: "success",
      value: { message: "late" },
      delayMs: 1_000,
    });
    const promise = model.generateStructured(request({ signal: controller.signal }));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("LocalDemoModel", () => {
  it("emits work_content claims instead of legacy content dimensions", async () => {
    const claims = await new LocalDemoModel().generateStructured({
      task: "screen-opportunity", promptVersion: "screen-opportunity/v1",
      instructions: "screen", input: { resumeText: "TypeScript Agent", jobText: "TypeScript Agent" },
      schemaName: "claims", schema: { type: "array" },
      validate: (value) => value as Array<{ dimension: string }>,
    });
    expect(claims.length).toBeGreaterThan(0);
    expect(claims.every((claim) => claim.dimension !== "ownership" && claim.dimension !== "product_interest")).toBe(true);
    expect(claims.some((claim) => claim.dimension === "work_content")).toBe(true);
  });
});

describe("DeepSeekModel", () => {
  const client = (implementation: ResponsesClient["responses"]["create"]): ResponsesClient => ({
    responses: { create: implementation },
  });

  it("requests JSON Schema output and validates the parsed response", async () => {
    let body: Record<string, unknown> | undefined;
    const model = new DeepSeekModel({
      apiKey: "test-key",
      client: client(async (value) => {
        body = value;
        return { output_text: JSON.stringify({ message: "ok" }) };
      }),
    });
    await expect(model.generateStructured(request())).resolves.toEqual({ message: "ok" });
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      instructions: "test instructions",
      reasoning: { effort: "none" },
      text: { format: { type: "json_schema", name: "test_message", strict: true } },
    });
  });

  it.each([
    ["", "deepseek_empty_response"],
    ["not-json", "deepseek_invalid_json"],
    [JSON.stringify({ nope: true }), "deepseek_schema_invalid"],
  ])("rejects invalid structured output %#", async (output, code) => {
    const model = new DeepSeekModel({ apiKey: "test", client: client(async () => ({ output_text: output })) });
    await expect(model.generateStructured(request())).rejects.toMatchObject({ code, retryable: false });
  });

  it("adapts nested URI formats without weakening local validation or mutating the schema", async () => {
    const schema = { type: "object", properties: { website: { anyOf: [{ type: "string", format: "uri" }, { type: "null" }] }, email: { type: "string", format: "email" } } };
    const original = structuredClone(schema);
    const model = new DeepSeekModel({ apiKey: "test", client: client(async body => {
      const sent = (body.text as { format: { schema: typeof schema } }).format.schema;
      expect(sent.properties.website.anyOf[0]).toEqual({ type: "string" });
      expect(sent.properties.email.format).toBe("email");
      return { output_text: JSON.stringify({ website: "not-a-url" }) };
    }) });
    await expect(model.generateStructured(request({ schema, validate: value => {
      new URL((value as { website: string }).website);
      return { message: "valid" };
    } }))).rejects.toMatchObject({ code: "deepseek_schema_invalid" });
    expect(schema).toEqual(original);
  });

  it("keeps bounded validation paths and codes without leaking values or custom messages", async () => {
    const model = new DeepSeekModel({ apiKey: "test", client: client(async () => ({ output_text: "{}" })) });
    const error = await model.generateStructured(request({
      schema: { type: "object", properties: { claims: { type: "array", items: { type: "object", properties: { confidence: { type: "string" } } } } } },
      validate: () => { throw { issues: [
        { path: ["claims", 0, "confidence"], code: "invalid_type", expected: "string", input: "private JD", message: "secret response" },
        { path: ["private key"], code: "custom", message: "private resume" },
      ] }; },
    })).catch(value => value);
    expect(error.validation).toEqual({ task: "test", schemaName: "test_message", issues: [
      { path: ["claims", 0, "confidence"], code: "invalid_type", expected: "string" },
      { path: ["[redacted]"], code: "custom" },
    ] });
    expect(JSON.stringify(error)).not.toMatch(/private|secret/);
  });

  it.each([
    [400, "deepseek_request_invalid", false],
    [422, "deepseek_request_invalid", false],
    [404, "deepseek_not_found", false],
    [401, "deepseek_auth_failed", false],
    [429, "deepseek_rate_limited", true],
    [500, "deepseek_unavailable", true],
    [408, "deepseek_timeout", true],
  ])("maps status %i to a safe model error", async (status, code, retryable) => {
    const model = new DeepSeekModel({
      apiKey: "secret-not-in-error",
      client: client(async () => { throw { status, responseBody: "private JD" }; }),
    });
    const error = await model.generateStructured(request()).catch((value: unknown) => value);
    expect(error).toMatchObject({ code, retryable });
    expect(String(error)).not.toContain("secret-not-in-error");
    expect(String(error)).not.toContain("private JD");
  });

  it("propagates cancellation as AbortError", async () => {
    const controller = new AbortController();
    const model = new DeepSeekModel({
      apiKey: "test",
      client: client((_body, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      })),
    });
    const promise = model.generateStructured(request({ signal: controller.signal }));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("model runtime configuration", () => {
  it("defaults to local without reading a DeepSeek key", () => {
    expect(createModelRuntimeFromEnv({}).selected.descriptor).toMatchObject({ provider: "local" });
  });

  it("requires a key when DeepSeek is explicitly selected", () => {
    expect(() => createModelRuntimeFromEnv({ JRA_MODEL_PROVIDER: "deepseek" })).toThrowError(
      expect.objectContaining({ code: "deepseek_api_key_missing" }),
    );
  });

  it("rejects unknown providers instead of silently falling back", () => {
    expect(() => createModelRuntimeFromEnv({ JRA_MODEL_PROVIDER: "other" })).toThrowError(
      expect.objectContaining({ code: "model_provider_invalid" }),
    );
  });

  it("uses the current DeepSeek model default", () => {
    const runtime = createModelRuntimeFromEnv(
      { JRA_MODEL_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test" },
      { deepSeekClient: { responses: { create: async () => ({ output_text: "{}" }) } } },
    );
    expect(runtime.selected.descriptor).toMatchObject({
      provider: "deepseek", model: "deepseek-v4-flash",
    });
  });

  it("resolves only the exact frozen provider and model", () => {
    const local = new LocalDemoModel();
    const resolver = new ModelGatewayResolver([local]);
    expect(resolver.resolve({ provider: "local", model: "local-demo" })).toBe(local);
    expect(() => resolver.resolve({ provider: "deepseek", model: "missing" })).toThrowError(
      expect.objectContaining({ code: "model_configuration_unavailable" }),
    );
  });
});
