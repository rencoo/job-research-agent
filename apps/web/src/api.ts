import {
  HealthResponseSchema,
  JobEventSchema,
  JobSnapshotSchema,
  ImportBatchSchema,
  OpportunityDetailSchema,
  OpportunitySummarySchema,
  ProfileSchema,
  ResearchRunSchema,
  RunEventSchema,
  type ImportBatch,
  type OpportunityDetail,
  type OpportunitySummary,
  type Profile,
  type ResearchRun,
  type RunEvent,
  type HealthResponse,
  type JobEvent,
  type JobSnapshot,
} from "@job-research/contracts";
import { z } from "zod";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ApiError"; }
}

async function request<T>(url: string, schema: z.ZodType<T>, options?: RequestInit, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(url, options); const payload = await response.json();
  if (!response.ok) { const error = payload as { error?: { code?: string; message?: string } }; throw new ApiError(response.status, error.error?.code ?? "request_failed", error.error?.message ?? `Request failed: ${response.status}`); }
  return schema.parse(payload);
}

export async function fetchHealth(fetcher: typeof fetch = fetch): Promise<HealthResponse> {
  const response = await fetcher("/api/health");
  const payload = await response.json();
  return HealthResponseSchema.parse(payload);
}

export async function fetchJob(
  jobId: string,
  fetcher: typeof fetch = fetch,
): Promise<JobSnapshot> {
  const response = await fetcher(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!response.ok) throw new Error(`Failed to load job: ${response.status}`);
  return JobSnapshotSchema.parse(await response.json());
}

interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export class JobEventClient {
  private lastSequence = 0;
  private source: EventSourceLike | null = null;

  constructor(
    private readonly jobId: string,
    private readonly createEventSource: EventSourceFactory = (url) => new EventSource(url),
  ) {}

  get cursor(): number {
    return this.lastSequence;
  }

  connect(onEvent: (event: JobEvent) => void, onError: (event: Event) => void): void {
    this.disconnect();
    const query = this.lastSequence > 0 ? `?after=${this.lastSequence}` : "";
    this.source = this.createEventSource(
      `/api/jobs/${encodeURIComponent(this.jobId)}/events${query}`,
    );
    this.source.onmessage = (message) => {
      const event = JobEventSchema.parse(JSON.parse(message.data));
      if (event.sequence <= this.lastSequence) return;
      this.lastSequence = event.sequence;
      onEvent(event);
    };
    this.source.onerror = onError;
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }
}

export const fetchProfile = (fetcher: typeof fetch = fetch) => request("/api/profile", ProfileSchema.nullable(), undefined, fetcher);
export const saveProfile = (input: unknown, fetcher: typeof fetch = fetch) => request("/api/profile", ProfileSchema, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, fetcher);
const ReceiptSchema = z.object({ id: z.string(), resourceId: z.string(), created: z.boolean() });
export const importJobTexts = (items: Array<{ text: string }>, key = crypto.randomUUID(), fetcher: typeof fetch = fetch) => request("/api/import-batches", ReceiptSchema, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ items }) }, fetcher);
export const fetchImportBatch = (id: string, fetcher: typeof fetch = fetch): Promise<ImportBatch> => request(`/api/import-batches/${encodeURIComponent(id)}`, ImportBatchSchema, undefined, fetcher);
export const retryImportItem = (id: string, fetcher: typeof fetch = fetch) => request(`/api/import-items/${encodeURIComponent(id)}/retry`, ReceiptSchema, { method: "POST" }, fetcher);
export const fetchOpportunities = (query: { keyword?: string; status?: string; recommendation?: string } = {}, fetcher: typeof fetch = fetch): Promise<OpportunitySummary[]> => {
  const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value) params.set(key, value);
  return request(`/api/opportunities${params.size ? `?${params}` : ""}`, z.array(OpportunitySummarySchema), undefined, fetcher);
};
export const fetchOpportunity = (id: string, fetcher: typeof fetch = fetch): Promise<OpportunityDetail> => request(`/api/opportunities/${encodeURIComponent(id)}`, OpportunityDetailSchema, undefined, fetcher);
export const patchDraft = (id: string, input: unknown, fetcher: typeof fetch = fetch) => request(`/api/opportunities/${encodeURIComponent(id)}/draft`, OpportunityDetailSchema.shape.draft, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, fetcher);
export const confirmDraft = (id: string, expectedVersion: number, fetcher: typeof fetch = fetch) => request(`/api/opportunities/${encodeURIComponent(id)}/draft/confirm`, OpportunityDetailSchema.shape.draft, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion }) }, fetcher);
export const startScreening = (id: string, key = crypto.randomUUID(), fetcher: typeof fetch = fetch) => request(`/api/opportunities/${encodeURIComponent(id)}/screening-runs`, ReceiptSchema, { method: "POST", headers: { "idempotency-key": key } }, fetcher);
export const fetchRun = (id: string, fetcher: typeof fetch = fetch): Promise<ResearchRun> => request(`/api/runs/${encodeURIComponent(id)}`, ResearchRunSchema, undefined, fetcher);
export const cancelRun = (id: string, fetcher: typeof fetch = fetch) => request(`/api/runs/${encodeURIComponent(id)}/cancel`, ResearchRunSchema, { method: "POST" }, fetcher);
export const retryRun = (id: string, fetcher: typeof fetch = fetch) => request(`/api/runs/${encodeURIComponent(id)}/retry`, ReceiptSchema, { method: "POST" }, fetcher);

export class RunEventClient {
  private lastSequence = 0; private source: EventSourceLike | null = null;
  constructor(private readonly runId: string, private readonly createEventSource: EventSourceFactory = (url) => new EventSource(url)) {}
  get cursor() { return this.lastSequence; }
  connect(onEvent: (event: RunEvent) => void, onError: (event: Event) => void) {
    this.disconnect(); const query = this.lastSequence ? `?after=${this.lastSequence}` : "";
    this.source = this.createEventSource(`/api/runs/${encodeURIComponent(this.runId)}/events${query}`);
    this.source.onmessage = (message) => { const event = RunEventSchema.parse(JSON.parse(message.data)); if (event.sequence <= this.lastSequence) return; this.lastSequence = event.sequence; onEvent(event); };
    this.source.onerror = onError;
  }
  disconnect() { this.source?.close(); this.source = null; }
}

export { fetchDeepResearch, startDeepResearch, respondToCompany, fetchSourceDocument } from "./research-api";
