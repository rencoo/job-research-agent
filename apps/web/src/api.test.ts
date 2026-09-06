import { describe, expect, it } from "vitest";
import { JobEventClient, RunEventClient, type EventSourceFactory } from "./api";

class FakeEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  close(): void {
    this.closed = true;
  }
  emit(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

describe("JobEventClient", () => {
  it("reconnects after the last accepted sequence", () => {
    const urls: string[] = [];
    const sources: FakeEventSource[] = [];
    const factory: EventSourceFactory = (url) => {
      urls.push(url);
      const source = new FakeEventSource();
      sources.push(source);
      return source;
    };
    const client = new JobEventClient("job 1", factory);
    const events: number[] = [];
    client.connect((event) => events.push(event.sequence), () => undefined);
    sources[0]!.emit({
      schemaVersion: 1,
      jobId: "job 1",
      sequence: 3,
      occurredAt: "2026-09-05T00:00:00.000Z",
      type: "progress_updated",
      payload: { progress: 20 },
    });
    client.connect((event) => events.push(event.sequence), () => undefined);
    expect(urls).toEqual([
      "/api/jobs/job%201/events",
      "/api/jobs/job%201/events?after=3",
    ]);
    expect(sources[0]?.closed).toBe(true);
    expect(events).toEqual([3]);
  });

  it("forwards connection errors", () => {
    const source = new FakeEventSource();
    const client = new JobEventClient("job-1", () => source);
    let received = false;
    client.connect(() => undefined, () => {
      received = true;
    });
    source.onerror?.(new Event("error"));
    expect(received).toBe(true);
  });

  it("reconnects Run SSE after the last accepted sequence", () => {
    const urls: string[] = []; const sources: FakeEventSource[] = [];
    const client = new RunEventClient("run 1", (url) => { urls.push(url); const source = new FakeEventSource(); sources.push(source); return source; });
    client.connect(() => undefined, () => undefined); sources[0]!.emit({ schemaVersion: 1, runId: "run 1", sequence: 2, type: "stage_completed", payload: { stage: "constraint_check" }, occurredAt: "2026-09-05T00:00:00.000Z" }); client.connect(() => undefined, () => undefined);
    expect(urls).toEqual(["/api/runs/run%201/events", "/api/runs/run%201/events?after=2"]); expect(sources[0]?.closed).toBe(true);
  });
});
