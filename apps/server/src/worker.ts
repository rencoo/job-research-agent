import type { Clock, JobError } from "@job-research/domain";
import type { JobRepository, PersistedJob } from "@job-research/database";

export interface JobHandlerContext {
  job: PersistedJob;
  signal: AbortSignal;
  reportProgress(progress: number): void;
}

export interface JobHandlerResult {
  resultRef?: string | null;
}

export type JobHandler = (context: JobHandlerContext) => Promise<JobHandlerResult>;

export class HandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(type: string, handler: JobHandler): this {
    if (this.handlers.has(type)) {
      throw new Error(`Handler already registered for job type: ${type}`);
    }
    this.handlers.set(type, handler);
    return this;
  }

  get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }
}

export class WorkerExecutionError extends Error implements JobError {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "WorkerExecutionError";
  }
}

export interface WorkerOptions {
  repository: JobRepository;
  registry: HandlerRegistry;
  clock?: Clock;
  workerId?: string;
  leaseMs?: number;
  pollIntervalMs?: number;
  retryBaseDelayMs?: number;
}

const systemClock: Clock = { now: () => new Date() };

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

function normalizeError(error: unknown): JobError {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: "unhandled_worker_error",
    message: error instanceof Error ? error.message : "Unknown worker error",
    retryable: false,
  };
}

export class LocalJobWorker {
  readonly workerId: string;
  private readonly repository: JobRepository;
  private readonly registry: HandlerRegistry;
  private readonly clock: Clock;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly retryBaseDelayMs: number;
  private accepting = false;
  private loopPromise: Promise<void> | null = null;
  private activePromise: Promise<boolean> | null = null;
  private wakePoll: (() => void) | null = null;

  constructor(options: WorkerOptions) {
    this.repository = options.repository;
    this.registry = options.registry;
    this.clock = options.clock ?? systemClock;
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.leaseMs = options.leaseMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000;
  }

  get isRunning(): boolean {
    return this.accepting;
  }

  recoverStaleJobs(): { requeued: number; failed: number } {
    return this.repository.recoverExpired(this.clock.now());
  }

  async runOnce(): Promise<boolean> {
    const job = this.repository.claimNext(
      this.workerId,
      this.clock.now(),
      this.leaseMs,
    );
    if (!job) return false;

    const handler = this.registry.get(job.type);
    const controller = new AbortController();
    let leaseLost = false;
    const heartbeatMs = Math.max(10, Math.floor(this.leaseMs / 3));
    const heartbeat = setInterval(() => {
      const now = this.clock.now();
      if (this.repository.isCancellationRequested(job.id)) {
        controller.abort();
        return;
      }
      if (!this.repository.renewLease(job.id, this.workerId, now, this.leaseMs)) {
        leaseLost = true;
        controller.abort();
      }
    }, heartbeatMs);
    heartbeat.unref();

    try {
      if (!handler) {
        throw new WorkerExecutionError(
          "handler_not_registered",
          `No handler registered for ${job.type}`,
          false,
        );
      }
      const result = await handler({
        job,
        signal: controller.signal,
        reportProgress: (progress) => {
          if (this.repository.isCancellationRequested(job.id)) {
            controller.abort();
            throw new DOMException("Job cancellation requested", "AbortError");
          }
          this.repository.updateProgress(job.id, this.workerId, progress, this.clock.now());
        },
      });

      if (leaseLost) return true;
      if (this.repository.isCancellationRequested(job.id)) {
        this.repository.cancelRunning(job.id, this.workerId, this.clock.now());
      } else {
        this.repository.complete(
          job.id,
          this.workerId,
          result.resultRef ?? null,
          this.clock.now(),
        );
      }
    } catch (error) {
      if (leaseLost) return true;
      if (isAbortError(error) && this.repository.isCancellationRequested(job.id)) {
        this.repository.cancelRunning(job.id, this.workerId, this.clock.now());
      } else {
        this.repository.fail(
          job.id,
          this.workerId,
          normalizeError(error),
          this.clock.now(),
          this.retryBaseDelayMs,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  start(): void {
    if (this.accepting) return;
    this.recoverStaleJobs();
    this.accepting = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.wakePoll?.();
    await this.activePromise;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async runLoop(): Promise<void> {
    while (this.accepting) {
      this.activePromise = this.runOnce();
      const handled = await this.activePromise;
      this.activePromise = null;
      if (!handled && this.accepting) await this.waitForNextPoll();
    }
  }

  private waitForNextPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakePoll = null;
        resolve();
      }, this.pollIntervalMs);
      this.wakePoll = () => {
        clearTimeout(timer);
        this.wakePoll = null;
        resolve();
      };
    });
  }
}
