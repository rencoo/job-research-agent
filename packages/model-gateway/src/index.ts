export interface ModelRequest<T> {
  prompt: string;
  validate(value: unknown): T;
  signal?: AbortSignal;
  metadata?: { task: string; input?: unknown };
}

export class LocalDemoModel implements ModelGateway {
  readonly requests: Array<{ task: string; prompt: string }> = [];

  async generateStructured<T>(request: ModelRequest<T>): Promise<T> {
    if (request.signal?.aborted) throw abortError();
    const task = request.metadata?.task ?? "unknown";
    this.requests.push({ task, prompt: request.prompt });
    if (task === "extract-job-draft") {
      return request.validate(extractJob(String(request.metadata?.input ?? "")));
    }
    if (task === "screen-opportunity") {
      const input = request.metadata?.input as { resumeText?: string; jobText?: string } | undefined;
      return request.validate(matchClaims(input?.resumeText ?? "", input?.jobText ?? ""));
    }
    throw new ModelGatewayError("unsupported_fake_task", `Unsupported local demo task: ${task}`, false);
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

export interface ModelGateway {
  generateStructured<T>(request: ModelRequest<T>): Promise<T>;
}

export class ModelGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

type FakeBehavior =
  | { type: "success"; value: unknown; delayMs?: number }
  | { type: "failure"; error: ModelGatewayError; delayMs?: number };

function abortError(): DOMException {
  return new DOMException("The model request was aborted", "AbortError");
}

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
  readonly prompts: string[] = [];

  constructor(private readonly behavior: FakeBehavior) {}

  async generateStructured<T>(request: ModelRequest<T>): Promise<T> {
    this.prompts.push(request.prompt);
    await abortableDelay(this.behavior.delayMs ?? 0, request.signal);
    if (request.signal?.aborted) throw abortError();
    if (this.behavior.type === "failure") throw this.behavior.error;
    return request.validate(this.behavior.value);
  }
}
