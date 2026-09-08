import type {
  ImportBatch, JobDraft, OpportunityDetail, OpportunitySummary, Profile, ResearchRun,
  ScreeningReport,
} from "@job-research/contracts";

export type ApplicationErrorCode = "validation" | "not_found" | "version_conflict" | "domain_precondition" | "infrastructure_unavailable";
export interface ApplicationError { code: ApplicationErrorCode; message: string; retryable: boolean; details?: unknown }
export type UseCaseResult<T> = { ok: true; value: T } | { ok: false; error: ApplicationError };
export interface CommandReceipt { id: string; resourceId: string; created: boolean }

export interface ProfileApplication {
  getCurrent(): Promise<UseCaseResult<Profile | null>>;
  save(input: unknown): Promise<UseCaseResult<Profile>>;
}
export interface IngestionApplication {
  importBatch(input: unknown, idempotencyKey: string): Promise<UseCaseResult<CommandReceipt>>;
  getBatch(id: string): Promise<UseCaseResult<ImportBatch>>;
  retryItem(id: string): Promise<UseCaseResult<CommandReceipt>>;
}
export interface OpportunityApplication {
  list(query: { keyword?: string; status?: string; recommendation?: string }): Promise<UseCaseResult<OpportunitySummary[]>>;
  get(id: string): Promise<UseCaseResult<OpportunityDetail>>;
  updateDraft(id: string, input: unknown): Promise<UseCaseResult<JobDraft>>;
  confirmDraft(id: string, input: unknown): Promise<UseCaseResult<JobDraft>>;
}
export interface ResearchApplication {
  startScreening(opportunityId: string, idempotencyKey: string): Promise<UseCaseResult<CommandReceipt>>;
  getRun(id: string): Promise<UseCaseResult<ResearchRun>>;
  cancel(id: string): Promise<UseCaseResult<ResearchRun>>;
  retryFailed(id: string): Promise<UseCaseResult<CommandReceipt>>;
  getReport(id: string): Promise<UseCaseResult<ScreeningReport>>;
}

export interface JobCommand { id: string; type: string; payload: unknown; maxAttempts?: number }
export interface BusinessUnitOfWork {
  transaction<T>(operation: () => T): T;
}

/** Complete company/position research commands; transport adapters do not orchestrate stages. */
export interface DeepResearchCommands {
  start(opportunityId: string, idempotencyKey: string, input?: unknown): Promise<UseCaseResult<CommandReceipt>>;
  respond(runId: string, input: unknown): Promise<UseCaseResult<ResearchRun>>;
  cancel(runId: string): Promise<UseCaseResult<ResearchRun>>;
  retry(runId: string): Promise<UseCaseResult<CommandReceipt>>;
}
