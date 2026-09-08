import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";

export type ModelProvider = "local" | "deepseek";

export interface ModelDescriptor {
  provider: ModelProvider;
  model: string;
  label: string;
}

export interface ModelRequest<T> {
  task: string;
  promptVersion: string;
  instructions: string;
  input: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
  validate(value: unknown): T;
  signal?: AbortSignal;
}

export interface ModelGateway {
  readonly descriptor: ModelDescriptor;
  generateStructured<T>(request: ModelRequest<T>): Promise<T>;
}

export interface ModelValidationDetails {
  task: string;
  schemaName: string;
  issues: Array<{ path: Array<string | number>; code: string; expected?: string }>;
}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly httpStatus?: number,
    readonly validation?: ModelValidationDetails,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

function validationDetails(error: unknown, request: ModelRequest<unknown>): ModelValidationDetails {
  const fields = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const object = value as Record<string, unknown>;
    if (object.properties && typeof object.properties === "object") Object.keys(object.properties).forEach(key => fields.add(key));
    Object.values(object).forEach(visit);
  };
  visit(request.schema);
  const codes = new Set(["invalid_type", "invalid_value", "invalid_format", "too_small", "too_big", "invalid_union", "unrecognized_keys", "custom", "not_multiple_of", "invalid_key", "invalid_element"]);
  const types = new Set(["string", "number", "integer", "boolean", "array", "object", "null", "undefined"]);
  const raw = error && typeof error === "object" && "issues" in error && Array.isArray(error.issues) ? error.issues : [];
  return { task: request.task, schemaName: request.schemaName, issues: raw.slice(0, 20).map(issue => {
    const item = issue && typeof issue === "object" ? issue as Record<string, unknown> : {};
    return {
      path: Array.isArray(item.path) ? item.path.slice(0, 20).map(part => typeof part === "number" && Number.isSafeInteger(part) ? part : typeof part === "string" && fields.has(part) ? part : "[redacted]") : [],
      code: typeof item.code === "string" && codes.has(item.code) ? item.code : "validation_failed",
      ...(typeof item.expected === "string" && types.has(item.expected) ? { expected: item.expected } : {}),
    };
  }) };
}

function abortError(): DOMException {
  return new DOMException("The model request was aborted", "AbortError");
}

function modelTaskInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

export class LocalDemoModel implements ModelGateway {
  readonly descriptor: ModelDescriptor = {
    provider: "local",
    model: "local-demo",
    label: "本地演示模型",
  };
  readonly requests: Array<{ task: string; promptVersion: string }> = [];

  async generateStructured<T>(request: ModelRequest<T>): Promise<T> {
    if (request.signal?.aborted) throw abortError();
    this.requests.push({ task: request.task, promptVersion: request.promptVersion });
    if (request.task === "extract-job-draft") {
      return request.validate(extractJob(String(request.input ?? "")));
    }
    if (request.task === "screen-opportunity") {
      const input = request.input as { resumeText?: string; jobText?: string } | undefined;
      return request.validate(matchClaims(input?.resumeText ?? "", input?.jobText ?? ""));
    }
    throw new ModelGatewayError("unsupported_fake_task", `Unsupported local demo task: ${request.task}`, false);
  }
}

function extractJob(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const find = (label: string) => lines.find((line) => new RegExp(`^${label}[：:]`, "i").test(line))?.replace(new RegExp(`^${label}[：:]\\s*`, "i"), "") ?? null;
  const salary = text.match(/(\d+(?:\.\d+)?)\s*[kK千]?\s*[-~—至]\s*(\d+(?:\.\d+)?)\s*[kK千]?/);
  const money = (value: string | undefined) => value ? Number(value) * (Number(value) < 1_000 ? 1_000 : 1) : null;
  const payMonths = text.match(/(\d+)\s*薪/);
  return {
    title: find("(?:职位|岗位|Title)") ?? lines[0] ?? null,
    company: find("(?:公司|Company)"), location: find("(?:地点|工作地点|Location)"),
    salaryMinMonthly: money(salary?.[1]), salaryMaxMonthly: money(salary?.[2]),
    payMonths: payMonths ? Number(payMonths[1]) : null,
    responsibilities: find("(?:职责|岗位职责|Responsibilities)"),
    requirements: find("(?:要求|任职要求|Requirements)"),
    benefits: find("(?:福利|Benefits)"),
  };
}

function matchClaims(resumeText: string, jobText: string) {
  const tokens = [...new Set(jobText.toLowerCase().match(/[a-z][a-z0-9+#.-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [])];
  return tokens.filter((token) => resumeText.toLowerCase().includes(token)).slice(0, 8).map((token, index) => ({
    id: `candidate-${index + 1}`, dimension: index % 2 ? "career_growth" : "work_content",
    statement: `候选人经历与岗位关键词 ${token} 匹配`, polarity: "positive", confidence: "medium",
    status: "supported", resumeEvidence: token, jobEvidence: token,
  }));
}

export interface ResponsesClient {
  responses: {
    create(
      body: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<{ output_text: string }>;
  };
}

export interface DeepSeekModelOptions {
  apiKey: string;
  model?: string;
  client?: ResponsesClient;
}

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEEPSEEK_TIMEOUT_MS = 180_000;
const DEEPSEEK_STRUCTURED_REASONING = { effort: "none" } as const;

function deepSeekSchema(schema: Record<string, unknown>): Record<string, unknown> {
  // DeepSeek rejects format=uri (HTTP 400). The original validator still checks URLs.
  const adapt = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(adapt);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => !(key === "format" && item === "uri")).map(([key, item]) => [key, adapt(item)]));
  };
  return adapt(schema) as Record<string, unknown>;
}

export class DeepSeekModel implements ModelGateway {
  readonly descriptor: ModelDescriptor;
  private readonly client: ResponsesClient;

  constructor(options: DeepSeekModelOptions) {
    if (!options.apiKey.trim()) {
      throw new ModelGatewayError("deepseek_api_key_missing", "DeepSeek API Key 未配置", false);
    }
    const model = options.model?.trim() || "deepseek-v4-flash";
    this.descriptor = { provider: "deepseek", model, label: `DeepSeek · ${model}` };
    this.client = options.client ?? new OpenAI({
      apiKey: options.apiKey,
      baseURL: DEEPSEEK_BASE_URL,
      maxRetries: 0,
      timeout: DEEPSEEK_TIMEOUT_MS,
    });
  }

  async generateStructured<T>(request: ModelRequest<T>): Promise<T> {
    if (request.signal?.aborted) throw abortError();
    let response: { output_text: string };
    try {
      response = await this.client.responses.create({
        model: this.descriptor.model,
        instructions: request.instructions,
        input: modelTaskInput(request.input),
        reasoning: DEEPSEEK_STRUCTURED_REASONING,
        text: {
          format: {
            type: "json_schema",
            name: request.schemaName,
            schema: deepSeekSchema(request.schema),
            strict: true,
          },
        },
      }, request.signal ? { signal: request.signal } : undefined);
    } catch (error) {
      if (request.signal?.aborted || error instanceof APIUserAbortError) throw abortError();
      throw mapDeepSeekError(error);
    }

    const output = response.output_text?.trim();
    if (!output) throw new ModelGatewayError("deepseek_empty_response", "DeepSeek 返回空结果", false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new ModelGatewayError("deepseek_invalid_json", "DeepSeek 返回的 JSON 无法解析", false);
    }
    try {
      return request.validate(parsed);
    } catch (error) {
      throw new ModelGatewayError("deepseek_schema_invalid", "DeepSeek 返回结果不符合结构约束", false, undefined, validationDetails(error, request));
    }
  }
}

function mapDeepSeekError(error: unknown): ModelGatewayError {
  const status = error instanceof APIError
    ? error.status
    : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
  if (status === 400 || status === 422) {
    return new ModelGatewayError("deepseek_request_invalid", "DeepSeek 拒绝请求参数或输出结构", false, status);
  }
  if (status === 404) {
    return new ModelGatewayError("deepseek_not_found", "DeepSeek 模型或接口不存在", false, status);
  }
  const retryable = status === 408 || status === 429 || (status !== undefined && status >= 500)
    || error instanceof APIConnectionTimeoutError
    || error instanceof APIConnectionError;
  if (status === 401 || status === 403) {
    return new ModelGatewayError("deepseek_auth_failed", "DeepSeek 鉴权失败，请检查 API Key", false);
  }
  if (status === 429) return new ModelGatewayError("deepseek_rate_limited", "DeepSeek 请求受限，请稍后重试", true);
  if (error instanceof APIConnectionTimeoutError || status === 408) {
    return new ModelGatewayError("deepseek_timeout", "DeepSeek 请求超时", true);
  }
  if (retryable) return new ModelGatewayError("deepseek_unavailable", "DeepSeek 服务暂时不可用", true);
  return new ModelGatewayError("deepseek_request_failed", "DeepSeek 请求失败", false, status);
}

export class ModelGatewayResolver {
  private readonly gateways = new Map<string, ModelGateway>();

  constructor(gateways: ModelGateway[]) {
    for (const gateway of gateways) {
      this.gateways.set(`${gateway.descriptor.provider}:${gateway.descriptor.model}`, gateway);
    }
  }

  resolve(descriptor: Pick<ModelDescriptor, "provider" | "model">): ModelGateway {
    const gateway = this.gateways.get(`${descriptor.provider}:${descriptor.model}`);
    if (!gateway) {
      throw new ModelGatewayError(
        "model_configuration_unavailable",
        `当前运行时无法提供 ${descriptor.provider}/${descriptor.model}`,
        false,
      );
    }
    return gateway;
  }
}

export interface ModelRuntime {
  selected: ModelGateway;
  resolver: ModelGatewayResolver;
}

export function createModelRuntimeFromEnv(
  env: Record<string, string | undefined>,
  options: { deepSeekClient?: ResponsesClient } = {},
): ModelRuntime {
  const provider = env.JRA_MODEL_PROVIDER?.trim() || "local";
  const local = new LocalDemoModel();
  if (provider === "local") return { selected: local, resolver: new ModelGatewayResolver([local]) };
  if (provider !== "deepseek") {
    throw new ModelGatewayError("model_provider_invalid", `不支持的模型 provider：${provider}`, false);
  }
  const deepseek = new DeepSeekModel({
    apiKey: env.DEEPSEEK_API_KEY ?? "",
    ...(env.JRA_DEEPSEEK_MODEL ? { model: env.JRA_DEEPSEEK_MODEL } : {}),
    ...(options.deepSeekClient ? { client: options.deepSeekClient } : {}),
  });
  return { selected: deepseek, resolver: new ModelGatewayResolver([local, deepseek]) };
}

type FakeBehavior =
  | { type: "success"; value: unknown; delayMs?: number }
  | { type: "failure"; error: ModelGatewayError; delayMs?: number };

async function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class FakeModel implements ModelGateway {
  readonly descriptor: ModelDescriptor;
  readonly prompts: string[] = [];

  constructor(private readonly behavior: FakeBehavior, descriptor?: Partial<ModelDescriptor>) {
    this.descriptor = {
      provider: descriptor?.provider ?? "local",
      model: descriptor?.model ?? "fake-model",
      label: descriptor?.label ?? "FakeModel",
    };
  }

  async generateStructured<T>(request: ModelRequest<T>): Promise<T> {
    this.prompts.push(request.instructions);
    await abortableDelay(this.behavior.delayMs ?? 0, request.signal);
    if (request.signal?.aborted) throw abortError();
    if (this.behavior.type === "failure") throw this.behavior.error;
    return request.validate(this.behavior.value);
  }
}
