import { describe, expect, it } from "vitest";
import {
  JobInvariantError,
  assertLease,
  claimJob,
  requestCancellation,
  shouldRetry,
  transitionJob,
  type JobState,
} from "./index";

const now = new Date("2026-09-05T00:00:00.000Z");
const queued = (overrides: Partial<JobState> = {}): JobState => ({
  id: "job-1",
  type: "test",
  status: "queued",
  attempts: 0,
  maxAttempts: 3,
  progress: 0,
  cancelRequested: false,
  leaseOwner: null,
  leaseExpiresAt: null,
  ...overrides,
});

describe("job state", () => {
  it("claims and completes a job", () => {
    const running = claimJob(queued(), "worker-1", now, 1_000);
    expect(running).toMatchObject({ status: "running", attempts: 1 });
    expect(transitionJob(running, "succeeded").status).toBe("succeeded");
  });

  it("prevents duplicate claims", () => {
    const running = claimJob(queued(), "worker-1", now, 1_000);
    expect(() => claimJob(running, "worker-2", now, 1_000)).toThrow(
      JobInvariantError,
    );
  });

  it("rejects a late lease owner", () => {
    const running = claimJob(queued(), "worker-1", now, 1_000);
    expect(() =>
      assertLease(running, "worker-1", new Date(now.getTime() + 1_001)),
    ).toThrowError(/does not own/);
  });

  it("cancels queued jobs and requests cancellation for running jobs", () => {
    expect(requestCancellation(queued()).status).toBe("cancelled");
    const running = claimJob(queued(), "worker-1", now, 1_000);
    expect(requestCancellation(running)).toMatchObject({
      status: "running",
      cancelRequested: true,
    });
  });

  it("retries only retryable errors before exhaustion", () => {
    expect(shouldRetry({ code: "timeout", message: "", retryable: true }, 2, 3)).toBe(
      true,
    );
    expect(shouldRetry({ code: "timeout", message: "", retryable: true }, 3, 3)).toBe(
      false,
    );
    expect(shouldRetry({ code: "invalid", message: "", retryable: false }, 1, 3)).toBe(
      false,
    );
  });
});
