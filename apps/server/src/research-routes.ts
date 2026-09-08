import type { FastifyInstance } from "fastify";
import type { UseCaseResult } from "@job-research/application";
import type { DeepResearchApplication } from "./deep-research";
export function registerResearchRoutes(app: FastifyInstance, research: DeepResearchApplication) {
  const send = <T>(reply: { code(n: number): { send(v: unknown): unknown }; send(v: unknown): unknown }, result: UseCaseResult<T>) => result.ok ? reply.send(result.value) : reply.code(({ validation: 400, not_found: 404, version_conflict: 409, domain_precondition: 422, infrastructure_unavailable: 503 })[result.error.code]).send({ error: result.error });
  app.post<{ Params: { id: string } }>("/api/opportunities/:id/deep-research-runs", async (request, reply) => send(reply, await research.start(request.params.id, String(request.headers["idempotency-key"] ?? ""), request.body)));
  app.post<{ Params: { id: string } }>("/api/runs/:id/attention-responses", async (request, reply) => send(reply, await research.respond(request.params.id, request.body)));
  const found = <T>(reply: { code(n: number): { send(v: unknown): unknown }; send(v: unknown): unknown }, value: T | null) => value === null ? send(reply, { ok: false, error: { code: "not_found", message: "研究资料不存在", retryable: false } }) : reply.send(value);
  app.get<{ Params: { id: string } }>("/api/opportunities/:id/deep-research", async (request, reply) => found(reply, research.repository.business.getOpportunity(request.params.id) ? research.repository.view(request.params.id) : null));
  app.get<{ Params: { id: string } }>("/api/deep-research-reports/:id", async (request, reply) => found(reply, research.repository.report(request.params.id)));
  app.get<{ Params: { id: string } }>("/api/source-documents/:id", async (request, reply) => found(reply, research.repository.source(request.params.id)));
  app.get<{ Params: { id: string } }>("/api/companies/:id/snapshots", async (request, reply) => found(reply, research.repository.company(request.params.id) ? research.repository.snapshots(request.params.id) : null));
}
