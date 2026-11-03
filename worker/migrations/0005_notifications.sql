-- ishur.io ops center · notifications (docs/OPS-NOTIFY-2026-11-03.md). Written by worker/notify.js
-- storeNotification(); when OPS_DB is missing the same rows go to the KV ring ntf:r:<inverted ms>:<id>
-- (the whole notification lives in the key metadata, TTL 60 days).
CREATE TABLE IF NOT EXISTS notifications (
  id             TEXT PRIMARY KEY,          -- n<base36 ms><rand>
  at             TEXT NOT NULL,             -- ISO 8601 UTC
  severity       TEXT NOT NULL,             -- P0 | P1 | P2 | P3
  rule           TEXT NOT NULL,             -- RULES id (new_lead, payment, …)
  title_he       TEXT NOT NULL,             -- one plain line: what happened + what to do
  body_he        TEXT,
  deep_link      TEXT,                      -- #/screen?focus=…
  entity         TEXT,                      -- lead:L972…, event:<tok8>, vendor:retell, …
  read           INTEGER NOT NULL DEFAULT 0,
  snoozed_until  TEXT,
  channels_json  TEXT,                      -- where it actually went: ["app","slack","push","whatsapp"]
  data_json      TEXT
);
CREATE INDEX IF NOT EXISTS notifications_at ON notifications (at);
CREATE INDEX IF NOT EXISTS notifications_read_at ON notifications (read, at);
CREATE INDEX IF NOT EXISTS notifications_rule_at ON notifications (rule, at);
