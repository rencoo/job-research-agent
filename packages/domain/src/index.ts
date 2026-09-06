export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface JobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface JobState {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number;
  cancelRequested: boolean;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
}

export class JobInvariantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JobInvariantError";
  }
}

const transitions: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["queued", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const isTerminal = (status: JobStatus): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

export function transitionJob(job: JobState, target: JobStatus): JobState {
  if (!transitions[job.status].includes(target)) {
    throw new JobInvariantError(
      "invalid_job_transition",
      `Cannot transition job ${job.id} from ${job.status} to ${target}`,
    );
  }
  return { ...job, status: target };
}

export function canClaim(job: JobState, now: Date): boolean {
  return (
    job.status === "queued" &&
    !job.cancelRequested &&
    job.attempts < job.maxAttempts &&
    (job.leaseExpiresAt === null || job.leaseExpiresAt <= now)
  );
}

export function claimJob(
  job: JobState,
  owner: string,
  now: Date,
  leaseMs: number,
): JobState {
  if (!canClaim(job, now)) {
    throw new JobInvariantError("job_not_claimable", `Job ${job.id} is not claimable`);
  }
  return {
    ...transitionJob(job, "running"),
    attempts: job.attempts + 1,
    leaseOwner: owner,
    leaseExpiresAt: new Date(now.getTime() + leaseMs),
  };
}

export function assertLease(job: JobState, owner: string, now: Date): void {
  if (
    job.status !== "running" ||
    job.leaseOwner !== owner ||
    job.leaseExpiresAt === null ||
    job.leaseExpiresAt <= now
  ) {
    throw new JobInvariantError(
      "lease_not_owned",
      `Worker ${owner} does not own an active lease for job ${job.id}`,
    );
  }
}

export function requestCancellation(job: JobState): JobState {
  if (isTerminal(job.status)) return job;
  if (job.status === "queued") {
    return { ...transitionJob(job, "cancelled"), cancelRequested: true };
  }
  return { ...job, cancelRequested: true };
}

export function shouldRetry(
  error: JobError,
  attempts: number,
  maxAttempts: number,
): boolean {
  return error.retryable && attempts < maxAttempts;
}

export function retryDelayMs(attempts: number, baseMs = 1_000): number {
  return baseMs * 2 ** Math.max(0, attempts - 1);
}

export * from "./business";
