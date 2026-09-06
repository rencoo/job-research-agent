import { describe, expect, it } from "vitest";
import type { ProfileApplication, UseCaseResult } from "./ports";

describe("application ports", () => {
  it("keep use-case results explicit and transport independent", async () => {
    const application: ProfileApplication = {
      async getCurrent() { return { ok: true, value: null }; },
      async save(): Promise<UseCaseResult<never>> { return { ok: false, error: { code: "validation", message: "invalid", retryable: false } }; },
    };
    expect(await application.getCurrent()).toEqual({ ok: true, value: null });
    expect(await application.save({})).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});
