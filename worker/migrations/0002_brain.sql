-- ishur.io ops center · brain (docs/BRAIN-2026-11-03.md). Written by worker/brain.js, best-effort:
-- KV (brain:finding:<id>, brain:pending:<id>, brain:log:<run_id>) stays the source the API reads.
CREATE TABLE IF NOT EXISTS findings (
  id            TEXT PRIMARY KEY,           -- <check_id>[:<subject>]
  check_id      TEXT NOT NULL,
  status        TEXT NOT NULL,              -- warn | fail
  severity      TEXT NOT NULL,              -- P1 | P2 | P3
  state         TEXT NOT NULL,              -- open | handling | needs_approval | resolved
  title         TEXT,
  detail        TEXT,
  evidence_json TEXT,
  playbook      TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  resolved_at   TEXT,
  history_json  TEXT
);
CREATE INDEX IF NOT EXISTS findings_state ON findings (state, last_seen);
CREATE INDEX IF NOT EXISTS findings_check ON findings (check_id);
CREATE TABLE IF NOT EXISTS pending_actions (
  id            TEXT PRIMARY KEY,           -- pa_<hash>_<ts36>
  finding_id    TEXT NOT NULL,
  playbook      TEXT NOT NULL,
  state         TEXT NOT NULL,              -- pending | running | done | failed | rejected | obsolete
  created_at    TEXT NOT NULL,
  preview_json  TEXT
);
CREATE TABLE IF NOT EXISTS run_logs (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  at            TEXT NOT NULL,
  text          TEXT NOT NULL,
  src           TEXT,                       -- worker | agent
  PRIMARY KEY (run_id, seq)
);
