import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Profile, ResearchRun, ScreeningReport } from "@job-research/contracts";
import { normalizeWeights } from "@job-research/domain";
import { applyMigrations } from "./migrations";
import { openDatabase, type DatabaseConnection } from "./connection";
import { BusinessRepository, PersistenceConflictError } from "./business-repository";
import { JobRepository } from "./repository";

let directory: string;
let connection: DatabaseConnection;
let repository: BusinessRepository;
const now = new Date("2026-09-05T00:00:00.000Z");
const weights = normalizeWeights({}).weights;
const profile: Profile = {
  id: "current", resumeText: "TypeScript Agent engineer", targetRoles: ["AI engineer"], targetLocations: [],
  salary: null, commuteToleranceMinutes: null, highlights: [], constraints: [], redFlags: [], weights,
  explicitWeightDimensions: [], resumeVersion: 1, profileVersion: 1, version: 1, updatedAt: now.toISOString(),
};

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "business-repository-"));
  connection = openDatabase({ dataDirectory: directory });
  applyMigrations(connection.sqlite);
  repository = new BusinessRepository(connection.sqlite);
});
afterEach(() => { connection.close(); rmSync(directory, { recursive: true, force: true }); });

describe("BusinessRepository", () => {
  it("round-trips profile and immutable snapshots with optimistic concurrency", () => {
    repository.saveProfile(profile, null);
    expect(repository.getProfile()).toEqual(profile);
    repository.createProfileSnapshot("ps-1", profile, now);
    const next = { ...profile, resumeText: "changed", resumeVersion: 2, version: 2 };
    repository.saveProfile(next, 1);
    expect(repository.getProfileSnapshot("ps-1")?.profile.resumeText).toBe(profile.resumeText);
    expect(() => repository.saveProfile(next, 1)).toThrow(PersistenceConflictError);
  });

  it("rolls back imports and preserves field revisions/conflicts", () => {
    expect(() => repository.transaction(() => {
      repository.createImport({ batchId: "b0", now, items: [{ id: "i0", opportunityId: "o0", text: "JD", status: "queued", jobId: null }] });
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(repository.getImportBatch("b0")).toBeNull();

    repository.transaction(() => repository.createImport({ batchId: "b1", now, items: [{ id: "i1", opportunityId: "o1", text: "JD", status: "queued", jobId: null }] }));
    const draft = repository.getDraft("o1")!;
    const edited = { ...draft, version: 2, fields: { ...draft.fields, title: { value: "AI Engineer", source: "user" as const, revision: 1 } } };
    repository.saveDraft(edited, 1, now);
    repository.addDraftConflict("o1", { id: "c1", field: "title", currentValue: "AI Engineer", proposedValue: "Frontend" }, now);
    expect(repository.getDraft("o1")).toMatchObject({ version: 2, fields: { title: { value: "AI Engineer", source: "user", revision: 1 } }, conflicts: [{ id: "c1" }] });
  });

  it("keeps run checkpoints/events unique and detects idempotency reuse", () => {
    repository.saveProfile(profile, null);
    repository.createProfileSnapshot("ps", profile, now);
    repository.createImport({ batchId: "b", now, items: [{ id: "i", opportunityId: "o", text: "JD", status: "ready", jobId: null }] });
    const draft = repository.getDraft("o")!;
    repository.createJobSnapshot("js", "o", draft, "JD", now);
    new JobRepository(connection.sqlite).create({ id: "j", type: "screen-opportunity", payload: { runId: "r" }, now });
    const run: ResearchRun = { id: "r", opportunityId: "o", jobId: "j", status: "queued", currentStage: null, parentRunId: null, successorRunId: null, reportId: null, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    repository.createRun(run, { profile: "ps", job: "js" });
    repository.saveCheckpoint("r", "constraint_check", { ok: true }, now);
    repository.saveCheckpoint("r", "constraint_check", { ok: false }, now);
    expect(repository.getCheckpoint("r", "constraint_check")).toEqual({ ok: true });
    expect(repository.listRunEvents("r").map((event) => event.sequence)).toEqual([1, 2]);
    repository.saveIdempotency({ key: "key", commandType: "start", aggregateId: "o", payloadHash: "hash", receipt: { id: "r" }, now });
    expect(repository.getIdempotency("key")).toMatchObject({ payloadHash: "hash", receipt: { id: "r" } });
  });

  it("commits business run and execution job atomically", () => {
    repository.saveProfile(profile, null);
    repository.createImport({ batchId: "b", now, items: [{ id: "i", opportunityId: "o", text: "JD", status: "ready", jobId: null }] });
    const jobs = new JobRepository(connection.sqlite);
    expect(() => repository.transaction(() => {
      jobs.create({ id: "j", type: "screen-opportunity", payload: {}, now });
      throw new Error("stop");
    })).toThrow("stop");
    expect(jobs.get("j")).toBeNull();
  });

  it("upcasts seven-dimension rows on read without rewriting stored JSON", () => {
    const legacyWeights = {
      people_and_company_reliability: 1 / 7, life_radius: 1 / 7, compensation_package: 1 / 7,
      workload_and_role_boundaries: 1 / 7, ownership: 1 / 7, career_growth: 1 / 7, product_interest: 1 / 7,
    };
    const legacyProfile = {
      ...profile,
      weights: legacyWeights,
      weightInputs: { ownership: "high" },
      explicitWeightDimensions: ["ownership"],
    };
    connection.sqlite.prepare(`
      INSERT INTO user_profile(id, resume_text, resume_version, profile_version, version, profile_json, updated_at)
      VALUES ('current', ?, 1, 1, 1, ?, ?)
    `).run(legacyProfile.resumeText, JSON.stringify(legacyProfile), now.getTime());
    const loaded = repository.getProfile();
    expect(loaded?.weightInputs).toEqual({ work_content: "high" });
    expect(loaded?.weights).not.toHaveProperty("ownership");
    expect(JSON.parse(String((connection.sqlite.prepare("SELECT profile_json FROM user_profile WHERE id='current'").get() as { profile_json: string }).profile_json)).weightInputs).toEqual({ ownership: "high" });

    repository.createImport({ batchId: "b-legacy", now, items: [{ id: "i-legacy", opportunityId: "o-legacy", text: "JD", status: "ready", jobId: null }] });
    const draft = repository.getDraft("o-legacy")!;
    repository.createProfileSnapshot("ps-legacy", profile, now);
    repository.createJobSnapshot("js-legacy", "o-legacy", draft, "JD", now);
    new JobRepository(connection.sqlite).create({ id: "j-legacy", type: "screen-opportunity", payload: { runId: "r-legacy" }, now });
    repository.createRun({
      id: "r-legacy", opportunityId: "o-legacy", jobId: "j-legacy", status: "completed", currentStage: null,
      parentRunId: null, successorRunId: null, reportId: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }, { profile: "ps-legacy", job: "js-legacy" });
    const legacyReport: Record<string, unknown> = {
      id: "rp", runId: "r-legacy", opportunityId: "o-legacy", recommendation: "worth_exploring", confidence: "medium",
      status: "complete", effective: true, matches: [], risks: ["切片"], unknowns: [], rules: [],
      dimensions: {
        people_and_company_reliability: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [] },
        life_radius: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [] },
        compensation_package: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [] },
        workload_and_role_boundaries: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [] },
        ownership: { verdict: "positive", confidence: "medium", claimIds: ["c1"], risks: [], unknowns: [] },
        career_growth: { verdict: "unknown", confidence: "low", claimIds: [], risks: [], unknowns: [] },
        product_interest: { verdict: "negative", confidence: "low", claimIds: ["c2"], risks: ["切片"], unknowns: [] },
      },
      claims: [
        { id: "c1", dimension: "ownership", statement: "能拿主导权", polarity: "positive", confidence: "medium", status: "supported", resumeEvidence: "Agent", jobEvidence: "Agent" },
        { id: "c2", dimension: "product_interest", statement: "产品不对味", polarity: "negative", confidence: "low", status: "supported", resumeEvidence: "Agent", jobEvidence: "Agent" },
      ],
      assumptions: [], modelLabel: "本地演示模型", createdAt: now.toISOString(),
    };
    connection.sqlite.prepare(`
      INSERT INTO screening_reports(id,run_id,opportunity_id,recommendation,status,effective,profile_version,resume_version,job_revision,data_json,created_at)
      VALUES ('rp','r-legacy','o-legacy','worth_exploring','complete',1,1,1,1,?,?)
    `).run(JSON.stringify(legacyReport), now.getTime());
    const report = repository.getReport("rp") as ScreeningReport;
    expect(Object.keys(report.dimensions)).toEqual(expect.arrayContaining(["work_content"]));
    expect(report.dimensions).not.toHaveProperty("ownership");
    expect(report.dimensions.work_content.verdict).toBe("mixed");
    expect(JSON.parse(String((connection.sqlite.prepare("SELECT data_json FROM screening_reports WHERE id='rp'").get() as { data_json: string }).data_json)).dimensions).toHaveProperty("ownership");
  });
});
