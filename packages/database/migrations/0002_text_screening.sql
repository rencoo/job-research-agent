CREATE TABLE user_profile (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  resume_text TEXT NOT NULL,
  resume_version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  profile_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE profile_snapshots (
  id TEXT PRIMARY KEY,
  resume_version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  current_report_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE import_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES jobs(id),
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX import_items_batch_idx ON import_items(batch_id, created_at);
CREATE INDEX import_items_status_idx ON import_items(status, updated_at);

CREATE TABLE job_drafts (
  opportunity_id TEXT PRIMARY KEY REFERENCES opportunities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1,
  extraction_revision INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT NOT NULL,
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  confirmed_at INTEGER,
  confirmed_version INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE draft_conflicts (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  current_value_json TEXT,
  proposed_value_json TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE TABLE job_snapshots (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  job_revision INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  profile_snapshot_id TEXT NOT NULL REFERENCES profile_snapshots(id),
  job_snapshot_id TEXT NOT NULL REFERENCES job_snapshots(id),
  status TEXT NOT NULL,
  current_stage TEXT,
  parent_run_id TEXT REFERENCES research_runs(id),
  successor_run_id TEXT REFERENCES research_runs(id),
  report_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX research_runs_opportunity_idx ON research_runs(opportunity_id, created_at DESC);
CREATE INDEX research_runs_status_idx ON research_runs(status, updated_at);

CREATE TABLE stage_checkpoints (
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, stage)
);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE INDEX run_events_replay_idx ON run_events(run_id, sequence);

CREATE TABLE research_claims (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES research_runs(id) ON DELETE CASCADE,
  dimension TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE screening_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES research_runs(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  recommendation TEXT NOT NULL,
  status TEXT NOT NULL,
  effective INTEGER NOT NULL,
  profile_version INTEGER NOT NULL,
  resume_version INTEGER NOT NULL,
  job_revision INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX screening_reports_opportunity_idx ON screening_reports(opportunity_id, created_at DESC);
CREATE INDEX screening_reports_recommendation_idx ON screening_reports(recommendation, effective);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  command_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX opportunities_updated_idx ON opportunities(updated_at DESC);
