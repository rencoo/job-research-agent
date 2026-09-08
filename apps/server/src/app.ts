import type { DeepResearchApplication } from "./deep-research";
import { registerResearchRoutes } from "./research-routes";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CancelJobResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  JobEventSchema,
  JobSnapshotSchema,
  type JobEvent,
  type JobSnapshot,
} from "@job-research/contracts";
import type { JobRepository, PersistedJob, PersistedJobEvent } from "@job-research/database";
import type { BusinessRepository } from "@job-research/database";
import type { IngestionApplication, OpportunityApplication, ProfileApplication, ResearchApplication, UseCaseResult } from "@job-research/application";

export interface ServerDependencies {
  repository: JobRepository;
  deepResearch?: DeepResearchApplication;
  databaseHealth?: () => boolean;
  workerHealth?: () => boolean;
  ssePollMs?: number;
  sseHeartbeatMs?: number;
  business?: {
    repository: BusinessRepository;
    profile: ProfileApplication;
    ingestion: IngestionApplication;
    opportunities: OpportunityApplication;
    research: ResearchApplication;
  };
}

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

function toSnapshot(job: PersistedJob): JobSnapshot {
  return JobSnapshotSchema.parse({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    cancelRequested: job.cancelRequested,
    resultRef: job.resultRef,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  });
}

function toEvent(event: PersistedJobEvent): JobEvent {
  return JobEventSchema.parse({
    schemaVersion: 1,
    jobId: event.jobId,
    sequence: event.sequence,
    occurredAt: event.createdAt.toISOString(),
    type: event.type,
    payload: event.payload,
  });
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function buildServer(dependencies: ServerDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const databaseHealth = dependencies.databaseHealth ?? (() => true);
  const workerHealth = dependencies.workerHealth ?? (() => true);
  const pollMs = dependencies.ssePollMs ?? 100;
  const heartbeatMs = dependencies.sseHeartbeatMs ?? 15_000;

  app.get("/api/health", async (_request, reply) => {
    const databaseOk = databaseHealth();
    const workerOk = workerHealth();
    const response = HealthResponseSchema.parse({
      status: databaseOk && workerOk ? "healthy" : "degraded",
      components: {
        api: { status: "healthy" },
        database: databaseOk
          ? { status: "healthy" }
          : { status: "degraded", message: "Database unavailable" },
        worker: workerOk
          ? { status: "healthy" }
          : { status: "degraded", message: "Worker unavailable" },
      },
    });
    return reply.code(response.status === "healthy" ? 200 : 503).send(response);
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request, reply) => {
    const job = dependencies.repository.get(request.params.jobId);
    if (!job) {
      return reply.code(404).send(
        ErrorResponseSchema.parse({
          error: { code: "not_found", message: "Job not found", retryable: false },
        }),
      );
    }
    return reply.send(toSnapshot(job));
  });

  app.post<{ Params: { jobId: string } }>(
    "/api/jobs/:jobId/cancel",
    async (request, reply) => {
      const before = dependencies.repository.get(request.params.jobId);
      if (!before) {
        return reply.code(404).send(
          ErrorResponseSchema.parse({
            error: { code: "not_found", message: "Job not found", retryable: false },
          }),
        );
      }
      const job = dependencies.repository.requestCancellation(before.id, new Date())!;
      const outcome = terminalStatuses.has(before.status)
        ? "already_terminal"
        : before.status === "queued"
          ? "cancelled"
          : "cancellation_requested";
      return reply.send(
        CancelJobResponseSchema.parse({ jobId: job.id, status: job.status, outcome }),
      );
    },
  );

  app.get<{
    Params: { jobId: string };
    Querystring: { after?: string };
  }>("/api/jobs/:jobId/events", async (request, reply) => {
    const initialJob = dependencies.repository.get(request.params.jobId);
    if (!initialJob) {
      return reply.code(404).send(
        ErrorResponseSchema.parse({
          error: { code: "not_found", message: "Job not found", retryable: false },
        }),
      );
    }

    const headerCursor = request.headers["last-event-id"];
    const rawCursor = request.query.after ??
      (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ??
      "0";
    let cursor = Number.parseInt(rawCursor, 10);
    if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });

    let closed = false;
    request.raw.on("close", () => {
      closed = true;
    });
    let lastWrite = Date.now();

    while (!closed) {
      const events = dependencies.repository.listEvents(initialJob.id, cursor);
      for (const persistedEvent of events) {
        const event = toEvent(persistedEvent);
        cursor = event.sequence;
        reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
        lastWrite = Date.now();
      }

      const current = dependencies.repository.get(initialJob.id);
      if (!current || terminalStatuses.has(current.status)) break;
      if (Date.now() - lastWrite >= heartbeatMs) {
        reply.raw.write(": heartbeat\n\n");
        lastWrite = Date.now();
      }
      await sleep(pollMs);
    }

    if (!closed) reply.raw.end();
    return reply;
  });

  if (dependencies.business) registerBusinessRoutes(app, dependencies.business, pollMs, heartbeatMs, dependencies.deepResearch);

  if (dependencies.deepResearch) registerResearchRoutes(app, dependencies.deepResearch);
  return app;
}

const errorStatus: Record<string, number> = { validation: 400, not_found: 404, version_conflict: 409, domain_precondition: 422, infrastructure_unavailable: 503 };
function sendResult<T>(reply: { code(status: number): { send(value: unknown): unknown }; send(value: unknown): unknown }, result: UseCaseResult<T>) {
  return result.ok ? reply.send(result.value) : reply.code(errorStatus[result.error.code] ?? 500).send(ErrorResponseSchema.parse({ error: result.error }));
}

function registerBusinessRoutes(
  app: FastifyInstance,
  business: NonNullable<ServerDependencies["business"]>,
  pollMs: number,
  heartbeatMs: number,
  deepResearch?: DeepResearchApplication,
) {
  app.get("/api/profile", async (_request, reply) => sendResult(reply, await business.profile.getCurrent()));
  app.put("/api/profile", async (request, reply) => sendResult(reply, await business.profile.save(request.body)));
  app.post("/api/import-batches", async (request, reply) => sendResult(reply, await business.ingestion.importBatch(request.body, String(request.headers["idempotency-key"] ?? ""))));
  app.get<{ Params: { batchId: string } }>("/api/import-batches/:batchId", async (request, reply) => sendResult(reply, await business.ingestion.getBatch(request.params.batchId)));
  app.post<{ Params: { itemId: string } }>("/api/import-items/:itemId/retry", async (request, reply) => sendResult(reply, await business.ingestion.retryItem(request.params.itemId)));
  app.get<{ Querystring: { keyword?: string; status?: string; recommendation?: string } }>("/api/opportunities", async (request, reply) => sendResult(reply, await business.opportunities.list(request.query)));
  app.get<{ Params: { opportunityId: string } }>("/api/opportunities/:opportunityId", async (request, reply) => sendResult(reply, await business.opportunities.get(request.params.opportunityId)));
  app.patch<{ Params: { opportunityId: string } }>("/api/opportunities/:opportunityId/draft", async (request, reply) => sendResult(reply, await business.opportunities.updateDraft(request.params.opportunityId, request.body)));
  app.post<{ Params: { opportunityId: string } }>("/api/opportunities/:opportunityId/draft/confirm", async (request, reply) => sendResult(reply, await business.opportunities.confirmDraft(request.params.opportunityId, request.body)));
  app.post<{ Params: { opportunityId: string } }>("/api/opportunities/:opportunityId/screening-runs", async (request, reply) => sendResult(reply, await business.research.startScreening(request.params.opportunityId, String(request.headers["idempotency-key"] ?? ""))));
  app.get<{ Params: { runId: string } }>("/api/runs/:runId", async (request, reply) => sendResult(reply, await business.research.getRun(request.params.runId)));
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/cancel", async (request, reply) => sendResult(reply, await (business.repository.getRun(request.params.runId)?.kind === "deep_research" && deepResearch ? deepResearch.cancel(request.params.runId) : business.research.cancel(request.params.runId))));
  app.post<{ Params: { runId: string } }>("/api/runs/:runId/retry", async (request, reply) => sendResult(reply, await (business.repository.getRun(request.params.runId)?.kind === "deep_research" && deepResearch ? deepResearch.retry(request.params.runId) : business.research.retryFailed(request.params.runId))));

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/api/runs/:runId/events", async (request, reply) => {
    const run = business.repository.getRun(request.params.runId);
    if (!run) return reply.code(404).send(ErrorResponseSchema.parse({ error: { code: "not_found", message: "Run not found", retryable: false } }));
    const headerCursor = request.headers["last-event-id"];
    const raw = request.query.after ?? (Array.isArray(headerCursor) ? headerCursor[0] : headerCursor) ?? "0";
    let cursor = Number.parseInt(raw, 10); if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
    reply.hijack(); reply.raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    let closed = false; let lastWrite = Date.now(); request.raw.on("close", () => { closed = true; });
    while (!closed) {
      for (const event of business.repository.listRunEvents(run.id, cursor)) {
        cursor = event.sequence; reply.raw.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); lastWrite = Date.now();
      }
      const current = business.repository.getRun(run.id);
      if (!current || ["completed", "failed", "cancelled", "superseded"].includes(current.status)) break;
      if (Date.now() - lastWrite >= heartbeatMs) { reply.raw.write(": heartbeat\n\n"); lastWrite = Date.now(); }
      await sleep(pollMs);
    }
    if (!closed) reply.raw.end(); return reply;
  });
}
