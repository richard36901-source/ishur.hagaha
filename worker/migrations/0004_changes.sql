-- ishur.io ops center · change log (docs/CHANGELOG-FEATURE-2026-11-03.md). Written by worker/changes.js
-- recordChange(); when OPS_DB is missing the same rows go to the KV ring chg:<inverted ms>:<id> (TTL 400 days).
CREATE TABLE IF NOT EXISTS changes (
  id            TEXT PRIMARY KEY,           -- c<base36 ms><rand>
  at            TEXT NOT NULL,              -- ISO 8601 UTC
  kind          TEXT NOT NULL,              -- deploy | registry | edit | hold | toggle | pause | template | brain | subevent | blast | revert
  actor         TEXT NOT NULL,              -- Richard | Claude | brain | system
  summary_he    TEXT NOT NULL,
  details_json  TEXT,                       -- kind-specific (before/after, commits, diff, …)
  revert_json   TEXT,                       -- {possible, how: toggle|edit|rollback|none, payload, confirm}
  reverted_at   TEXT,
  reverted_by   TEXT                        -- id of the 'revert' change that undid this one
);
CREATE INDEX IF NOT EXISTS changes_at ON changes (at);
CREATE INDEX IF NOT EXISTS changes_kind_at ON changes (kind, at);
CREATE INDEX IF NOT EXISTS changes_actor_at ON changes (actor, at);
