import type Database from "better-sqlite3";
import {
  JobInvariantError,
  retryDelayMs,
  shouldRetry,
  type JobError,
  type JobStatus,
} from "@job-research/domain";

export interface PersistedJob {
  id: string;
  type: string;
  input: unknown;
  status: JobStatus;
  progress: number;
  resultRef: string | null;
  cancelRequested: boolean;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  error: JobError | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface PersistedJobEvent {
  jobId: string;
  sequence: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface PersistedAttempt {
  jobId: string;
  attempt: number;
  workerId: string;
  outcome: string;
  startedAt: Date;
  finishedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}

interface JobRow {
  id: string;
  type: string;
  input_json: string;
  status: JobStatus;
  progress: number;
  result_ref: string | null;
  cancel_requested: number;
  attempts: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  error_code: string | null;
  error_message: string | null;
  error_retryable: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const toDate = (value: number | null): Date | null =>
  value === null ? null : new Date(value);

function mapJob(row: JobRow): PersistedJob {
  return {
    id: row.id,
    type: row.type,
    input: JSON.parse(row.input_json) as unknown,
    status: row.status,
    progress: row.progress,
    resultRef: row.result_ref,
    cancelRequested: row.cancel_requested === 1,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: new Date(row.available_at),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: toDate(row.lease_expires_at),
    error:
      row.error_code && row.error_message
        ? {
            code: row.error_code,
            message: row.error_message,
            retryable: row.error_retryable === 1,
          }
        : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    startedAt: toDate(row.started_at),
    finishedAt: toDate(row.finished_at),
  };
}

export class JobRepository {
  constructor(private readonly sqlite: Database.Database) {}

  create(input: {
    id: string;
    type: string;
    payload: unknown;
    now: Date;
    maxAttempts?: number;
  }): PersistedJob {
    return this.immediateTransaction(() => {
      const maxAttempts = input.maxAttempts ?? 3;
      this.sqlite
        .prepare(`
          INSERT INTO jobs(
            id, type, input_json, status, progress, cancel_requested, attempts,
            max_attempts, available_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'queued', 0, 0, 0, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.type,
          JSON.stringify(input.payload),
          maxAttempts,
          input.now.getTime(),
          input.now.getTime(),
          input.now.getTime(),
        );
      this.appendEvent(input.id, "status_changed", { status: "queued" }, input.now);
      return this.get(input.id)!;
    });
  }

  get(id: string): PersistedJob | null {
    const row = this.sqlite.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      | JobRow
      | undefined;
    return row ? mapJob(row) : null;
  }

  claimNext(owner: string, now: Date, leaseMs: number, types?: readonly string[]): PersistedJob | null {
    return this.immediateTransaction(() => {
      const row = this.sqlite
        .prepare(`
          SELECT * FROM jobs
          WHERE status = 'queued'
            AND cancel_requested = 0
            AND attempts < max_attempts
            AND available_at <= ?
            ${types?.length ? `AND type IN (${types.map(() => '?').join(',')})` : ''}
          ORDER BY available_at, created_at
          LIMIT 1
        `)
        .get(now.getTime(), ...(types ?? [])) as JobRow | undefined;
      if (!row) return null;

      const attempt = row.attempts + 1;
      const result = this.sqlite
        .prepare(`
          UPDATE jobs
          SET status = 'running', attempts = ?, lease_owner = ?, lease_expires_at = ?,
              started_at = COALESCE(started_at, ?), updated_at = ?
          WHERE id = ? AND status = 'queued' AND cancel_requested = 0
        `)
        .run(
          attempt,
          owner,
          now.getTime() + leaseMs,
          now.getTime(),
          now.getTime(),
          row.id,
        );
      if (result.changes !== 1) return null;

      this.sqlite
        .prepare(`
          INSERT INTO job_attempts(job_id, attempt, worker_id, started_at, outcome)
          VALUES (?, ?, ?, ?, 'running')
        `)
        .run(row.id, attempt, owner, now.getTime());
      this.appendEvent(row.id, "status_changed", { status: "running" }, now);
      return this.get(row.id);
    });
  }

  renewLease(id: string, owner: string, now: Date, leaseMs: number): boolean {
    const result = this.sqlite
      .prepare(`
        UPDATE jobs SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_expires_at > ?
      `)
      .run(now.getTime() + leaseMs, now.getTime(), id, owner, now.getTime());
    return result.changes === 1;
  }

  updateProgress(id: string, owner: string, progress: number, now: Date): void {
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
      throw new JobInvariantError("invalid_progress", "Progress must be between 0 and 100");
    }
    this.withOwnedLease(id, owner, now, (job) => {
      this.sqlite
        .prepare("UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ?")
        .run(progress, now.getTime(), id);
      this.appendEvent(id, "progress_updated", { progress }, now);
      return job;
    });
  }

  requestCancellation(id: string, now: Date): PersistedJob | null {
    return this.immediateTransaction(() => {
      const job = this.get(id);
      if (!job) return null;
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        return job;
      }
      if (job.status === "queued") {
        this.sqlite
          .prepare(`
            UPDATE jobs SET status = 'cancelled', cancel_requested = 1,
              finished_at = ?, updated_at = ? WHERE id = ?
          `)
          .run(now.getTime(), now.getTime(), id);
        this.appendEvent(id, "status_changed", { status: "cancelled" }, now);
      } else {
        this.sqlite
          .prepare("UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?")
          .run(now.getTime(), id);
      }
      return this.get(id);
    });
  }

  isCancellationRequested(id: string): boolean {
    const row = this.sqlite
      .prepare("SELECT cancel_requested FROM jobs WHERE id = ?")
      .get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  complete(id: string, owner: string, resultRef: string | null, now: Date): void {
    this.withOwnedLease(id, owner, now, (job) => {
      this.sqlite
        .prepare(`
          UPDATE jobs SET status = 'succeeded', progress = 100, result_ref = ?,
            lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(resultRef, now.getTime(), now.getTime(), id);
      this.finishAttempt(id, job.attempts, "succeeded", now);
      this.appendEvent(id, "job_succeeded", { resultRef }, now);
    });
  }

  cancelRunning(id: string, owner: string, now: Date): void {
    this.withOwnedLease(id, owner, now, (job) => {
      this.sqlite
        .prepare(`
          UPDATE jobs SET status = 'cancelled', lease_owner = NULL,
            lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?
        `)
        .run(now.getTime(), now.getTime(), id);
      this.finishAttempt(id, job.attempts, "cancelled", now);
      this.appendEvent(id, "status_changed", { status: "cancelled" }, now);
    });
  }

  fail(
    id: string,
    owner: string,
    error: JobError,
    now: Date,
    baseDelayMs = 1_000,
  ): "queued" | "failed" {
    return this.withOwnedLease(id, owner, now, (job) => {
      const retry = shouldRetry(error, job.attempts, job.maxAttempts);
      const status = retry ? "queued" : "failed";
      const availableAt = retry
        ? now.getTime() + retryDelayMs(job.attempts, baseDelayMs)
        : job.availableAt.getTime();
      this.sqlite
        .prepare(`
          UPDATE jobs SET status = ?, available_at = ?, lease_owner = NULL,
            lease_expires_at = NULL, error_code = ?, error_message = ?,
            error_retryable = ?, finished_at = ?, updated_at = ? WHERE id = ?
        `)
        .run(
          status,
          availableAt,
          error.code,
          error.message,
          error.retryable ? 1 : 0,
          retry ? null : now.getTime(),
          now.getTime(),
          id,
        );
      this.finishAttempt(id, job.attempts, retry ? "retrying" : "failed", now, error);
      this.appendEvent(
        id,
        retry ? "status_changed" : "job_failed",
        retry ? { status: "queued" } : error,
        now,
      );
      return status;
    });
  }

  recoverExpired(now: Date): { requeued: number; failed: number } {
    return this.immediateTransaction(() => {
      const rows = this.sqlite
        .prepare(`
          SELECT * FROM jobs
          WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        `)
        .all(now.getTime()) as JobRow[];
      let requeued = 0;
      let failed = 0;
      for (const row of rows) {
        const canRetry = row.attempts < row.max_attempts;
        const status = canRetry ? "queued" : "failed";
        this.sqlite
          .prepare(`
            UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
              available_at = ?, error_code = 'worker_interrupted',
              error_message = 'Worker lease expired', error_retryable = 1,
              finished_at = ?, updated_at = ? WHERE id = ?
          `)
          .run(
            status,
            now.getTime(),
            canRetry ? null : now.getTime(),
            now.getTime(),
            row.id,
          );
        this.finishAttempt(
          row.id,
          row.attempts,
          canRetry ? "interrupted" : "failed",
          now,
          { code: "worker_interrupted", message: "Worker lease expired", retryable: true },
        );
        this.appendEvent(
          row.id,
          canRetry ? "job_recovered" : "job_failed",
          canRetry
            ? { attempt: row.attempts }
            : { code: "worker_interrupted", message: "Worker lease expired", retryable: true },
          now,
        );
        if (canRetry) requeued += 1;
        else failed += 1;
      }
      return { requeued, failed };
    });
  }

  listEvents(id: string, afterSequence = 0): PersistedJobEvent[] {
    const rows = this.sqlite
      .prepare(`
        SELECT job_id, sequence, type, payload_json, created_at
        FROM job_events WHERE job_id = ? AND sequence > ? ORDER BY sequence
      `)
      .all(id, afterSequence) as Array<{
      job_id: string;
      sequence: number;
      type: string;
      payload_json: string;
      created_at: number;
    }>;
    return rows.map((row) => ({
      jobId: row.job_id,
      sequence: row.sequence,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      createdAt: new Date(row.created_at),
    }));
  }

  listAttempts(id: string): PersistedAttempt[] {
    const rows = this.sqlite
      .prepare("SELECT * FROM job_attempts WHERE job_id = ? ORDER BY attempt")
      .all(id) as Array<{
      job_id: string;
      attempt: number;
      worker_id: string;
      outcome: string;
      started_at: number;
      finished_at: number | null;
      error_code: string | null;
      error_message: string | null;
    }>;
    return rows.map((row) => ({
      jobId: row.job_id,
      attempt: row.attempt,
      workerId: row.worker_id,
      outcome: row.outcome,
      startedAt: new Date(row.started_at),
      finishedAt: toDate(row.finished_at),
      errorCode: row.error_code,
      errorMessage: row.error_message,
    }));
  }

  private appendEvent(jobId: string, type: string, payload: unknown, now: Date): void {
    const next = this.sqlite
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = ?")
      .get(jobId) as { sequence: number };
    this.sqlite
      .prepare(`
        INSERT INTO job_events(job_id, sequence, type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(jobId, next.sequence, type, JSON.stringify(payload), now.getTime());
  }

  private finishAttempt(
    jobId: string,
    attempt: number,
    outcome: string,
    now: Date,
    error?: JobError,
  ): void {
    this.sqlite
      .prepare(`
        UPDATE job_attempts SET outcome = ?, finished_at = ?, error_code = ?, error_message = ?
        WHERE job_id = ? AND attempt = ?
      `)
      .run(outcome, now.getTime(), error?.code ?? null, error?.message ?? null, jobId, attempt);
  }

  private withOwnedLease<T>(
    id: string,
    owner: string,
    now: Date,
    operation: (job: PersistedJob) => T,
  ): T {
    return this.immediateTransaction(() => {
      const job = this.get(id);
      if (
        !job ||
        job.status !== "running" ||
        job.leaseOwner !== owner ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt <= now
      ) {
        throw new JobInvariantError(
          "lease_not_owned",
          `Worker ${owner} does not own an active lease for job ${id}`,
        );
      }
      return operation(job);
    });
  }

  private immediateTransaction<T>(operation: () => T): T {
    if (this.sqlite.inTransaction) return operation();
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
