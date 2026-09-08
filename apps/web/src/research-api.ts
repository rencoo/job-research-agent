import { DeepResearchViewSchema, SourceDocumentSchema, ResearchRunSchema } from "@job-research/contracts";
import { z } from "zod";
async function call<T>(url: string, schema: z.ZodType<T>, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options); const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "深研请求失败");
  return schema.parse(payload);
}
const receipt = z.object({ id: z.string(), resourceId: z.string(), created: z.boolean() });
export const fetchDeepResearch = (id: string) => call(`/api/opportunities/${encodeURIComponent(id)}/deep-research`, DeepResearchViewSchema);
export const startDeepResearch = (id: string, key: string, options: { refreshCompany?: boolean; parentRunId?: string } = {}) => call(`/api/opportunities/${encodeURIComponent(id)}/deep-research-runs`, receipt, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(options) });
export const respondToCompany = (id: string, input: unknown) => call(`/api/runs/${encodeURIComponent(id)}/attention-responses`, ResearchRunSchema, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
export const fetchSourceDocument = (id: string) => call(`/api/source-documents/${encodeURIComponent(id)}`, SourceDocumentSchema);
