-- ishur.io ops center · runs ledger (docs/OPS-CENTER-PLAN-2026-11-03.md §3b)
-- One row per execution of an automation. Written by worker/ops-run.js withRun().
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,           -- r<base36 ms><rand>
  automation_id TEXT NOT NULL,              -- registry id (automations-registry.js)
  parent_id     TEXT,                       -- the pacer tick a sub-step belongs to
  started_at    TEXT NOT NULL,              -- ISO 8601 UTC
  ended_at      TEXT,
  status        TEXT NOT NULL,              -- running | ok | partial | failed | skipped
  triggered_by  TEXT,                       -- cron | manual | parent:<automation_id>
  counts_json   TEXT,                       -- {"ms":…, "skip_reason":…, …}
  cost_usd      REAL DEFAULT 0,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  summary       TEXT,                       -- the job's return value, JSON, ≤1000 chars
  error         TEXT,
  logs_ref      TEXT                        -- audit:cron:<job> (the audit.js row carries data.run_id)
);
CREATE INDEX IF NOT EXISTS runs_auto_started ON runs (automation_id, started_at);
CREATE INDEX IF NOT EXISTS runs_status_started ON runs (status, started_at);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_parent ON runs (parent_id);
