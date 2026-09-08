import { createHash } from "node:crypto";
import { CompanySchema, CompanySnapshotSchema, DeepReportSchema, ResearchStateSchema, SourceDocumentSchema, type Company, type CompanyCandidate, type CompanySnapshot, type DeepClaim, type DeepResearchReport, type EvidenceLink, type ResearchState, type SourceDocument } from "@job-research/contracts";
import { BusinessRepository } from "./business-repository";

export class ResearchRepository {
  constructor(readonly business: BusinessRepository) {}
  get db() { return this.business.sqlite; }
  transaction<T>(fn: () => T) { return this.business.transaction(fn); }
  state(id: string): ResearchState | null {
    const row = this.db.prepare("SELECT data_json FROM deep_research_state WHERE run_id=?").get(id) as { data_json: string } | undefined;
    return row ? ResearchStateSchema.parse(JSON.parse(row.data_json)) : null;
  }
  saveState(state: ResearchState) {
    this.db.prepare("INSERT INTO deep_research_state VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET data_json=excluded.data_json").run(state.runId, JSON.stringify(ResearchStateSchema.parse(state)));
  }
  source(id: string): SourceDocument | null {
    const row = this.db.prepare("SELECT data_json FROM source_documents WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? SourceDocumentSchema.parse(JSON.parse(row.data_json)) : null;
  }
  saveSource(doc: SourceDocument) {
    this.db.prepare("INSERT OR IGNORE INTO source_documents VALUES(?,?,?)").run(doc.id, doc.contentHash, JSON.stringify(SourceDocumentSchema.parse(doc)));
  }
  company(id: string): Company | null {
    const row = this.db.prepare("SELECT data_json FROM companies WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? CompanySchema.parse(JSON.parse(row.data_json)) : null;
  }
  confirm(candidate: CompanyCandidate, now: Date): Company {
    // Legal identity + website prevents merging brands or sibling employing entities by name alone.
    const identity = JSON.stringify([candidate.legalName ?? candidate.name, candidate.website ? new URL(candidate.website).hostname : "", candidate.location]);
    const key = createHash("sha256").update(identity).digest("hex");
    const row = this.db.prepare("SELECT id FROM companies WHERE identity_key=?").get(key) as { id: string } | undefined;
    if (row) return this.company(row.id)!;
    const company = CompanySchema.parse({ ...candidate, id: crypto.randomUUID(), confirmedAt: now.toISOString() });
    this.db.prepare("INSERT INTO companies VALUES(?,?,?)").run(company.id, key, JSON.stringify(company));
    return company;
  }
  snapshots(companyId: string): CompanySnapshot[] {
    return (this.db.prepare("SELECT data_json FROM company_snapshots WHERE company_id=? ORDER BY created_at DESC").all(companyId) as { data_json: string }[]).map(row => CompanySnapshotSchema.parse(JSON.parse(row.data_json)));
  }
  snapshot(id: string): CompanySnapshot | null {
    const row = this.db.prepare("SELECT data_json FROM company_snapshots WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? CompanySnapshotSchema.parse(JSON.parse(row.data_json)) : null;
  }
  acquireRefresh(companyId: string, runId: string): string {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT run_id FROM company_refreshes WHERE company_id=?").get(companyId) as { run_id: string } | undefined;
      if (existing && existing.run_id !== runId) {
        const run = this.business.getRun(existing.run_id);
        if (run && ["queued", "running", "waiting", "needs_attention", "cancelling"].includes(run.status)) return existing.run_id;
      }
      this.db.prepare("INSERT INTO company_refreshes VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET run_id=excluded.run_id").run(companyId, runId);
      return runId;
    });
  }
  releaseRefresh(runId: string) { this.db.prepare("DELETE FROM company_refreshes WHERE run_id=?").run(runId); }
  saveEvidence(claims: DeepClaim[], evidence: EvidenceLink[]) {
    for (const claim of claims) this.db.prepare("INSERT OR IGNORE INTO deep_claims VALUES(?,?,?,?)").run(claim.id, claim.ownerType, claim.ownerId, JSON.stringify(claim));
    for (const link of evidence) this.db.prepare("INSERT OR IGNORE INTO evidence_links VALUES(?,?,?,?)").run(link.id, link.claimId, link.documentId, JSON.stringify(link));
  }
  saveSnapshot(snapshot: CompanySnapshot) {
    this.transaction(() => {
      this.saveEvidence(snapshot.claims, snapshot.evidence);
      this.db.prepare("INSERT OR IGNORE INTO company_snapshots VALUES(?,?,?,?)").run(snapshot.id, snapshot.companyId, Date.parse(snapshot.createdAt), JSON.stringify(CompanySnapshotSchema.parse(snapshot)));
    });
  }
  isCurrent(runId: string): boolean {
    const ctx = this.business.getRunContext(runId); if (!ctx) return false;
    const profile = this.business.getProfile(); const draft = this.business.getDraft(ctx.run.opportunityId);
    return profile?.profileVersion === ctx.profileSnapshot.profile.profileVersion && profile?.resumeVersion === ctx.profileSnapshot.profile.resumeVersion && draft?.version === ctx.jobSnapshot.draft.version && draft?.status === "confirmed";
  }
  saveReport(report: DeepResearchReport) {
    this.transaction(() => {
      this.saveEvidence(report.claims, report.evidence);
      this.db.prepare("INSERT OR IGNORE INTO deep_reports VALUES(?,?,?,?,?)").run(report.id, report.runId, report.opportunityId, JSON.stringify(DeepReportSchema.parse(report)), Date.parse(report.createdAt));
      if (report.effective) this.db.prepare("UPDATE opportunities SET current_deep_report_id=? WHERE id=?").run(report.id, report.opportunityId);
    });
  }
  report(id: string): DeepResearchReport | null {
    const row = this.db.prepare("SELECT data_json FROM deep_reports WHERE id=?").get(id) as { data_json: string } | undefined;
    if (!row) return null;
    const report = DeepReportSchema.parse(JSON.parse(row.data_json));
    const opportunity = this.db.prepare("SELECT current_deep_report_id FROM opportunities WHERE id=?").get(report.opportunityId) as { current_deep_report_id: string | null } | undefined;
    report.effective = report.effective && opportunity?.current_deep_report_id === report.id;
    if (report.evidence.some(link => !this.source(link.documentId))) return { ...report, status: "invalidated", effective: false };
    const snapshot = report.companySnapshotId ? this.snapshot(report.companySnapshotId) : null;
    const newerSnapshot = snapshot ? this.snapshots(snapshot.companyId).some(s => s.mode === snapshot.mode && s.createdAt > snapshot.createdAt) : false;
    return report.status !== "invalidated" && (!this.isCurrent(report.runId) || newerSnapshot) ? { ...report, status: "stale", effective: false } : report;
  }
  view(opportunityId: string) {
    const reports = (this.db.prepare("SELECT id FROM deep_reports WHERE opportunity_id=? ORDER BY created_at DESC").all(opportunityId) as { id: string }[]).map(row => this.report(row.id)!);
    const row = this.db.prepare("SELECT current_deep_report_id FROM opportunities WHERE id=?").get(opportunityId) as { current_deep_report_id: string | null } | undefined;
    return { states: this.business.listRuns(opportunityId).flatMap(run => { const state = this.state(run.id); return state ? [state] : []; }), reports, currentReportId: reports.find(r => r.id === row?.current_deep_report_id && r.effective)?.id ?? null };
  }
}
