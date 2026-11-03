-- ishur.io ops center · CRM (docs/CRM-API-2026-11-03.md). Written by worker/store.js (d1Store).
-- Every table keeps the full row in data_json; the typed columns exist only to filter/sort/index.
-- Until OPS_DB is bound the same rows live in KV (crm:t:<table>, crm:n:*, crm:a:*) — see store.js.
CREATE TABLE IF NOT EXISTS leads (
  id               TEXT PRIMARY KEY,        -- 'L' + phone (972…): one lead per phone, by construction
  phone            TEXT NOT NULL,
  name             TEXT,
  source           TEXT,                    -- meta_form | whatsapp | web | manual | referral
  status           TEXT NOT NULL,           -- new | talking | quoted | closed | not_relevant | lost
  owner            TEXT,
  occasion         TEXT,
  event_date       TEXT,                    -- YYYY-MM-DD
  next_action_at   TEXT,                    -- ISO
  quote_id         TEXT,
  client_token     TEXT,
  monday_item_id   TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_inbound_at  TEXT,
  last_outbound_at TEXT,
  data_json        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_phone ON leads (phone);
CREATE INDEX IF NOT EXISTS leads_status ON leads (status, updated_at);
CREATE INDEX IF NOT EXISTS leads_quote ON leads (quote_id);
CREATE INDEX IF NOT EXISTS leads_next ON leads (next_action_at);

CREATE TABLE IF NOT EXISTS clients (
  id          TEXT PRIMARY KEY,             -- event token
  phone       TEXT,
  name        TEXT,
  status      TEXT,                         -- upcoming | live | done | cancelled | held
  event_date  TEXT,
  lead_id     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  data_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_phone ON clients (phone);

CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,               -- lead | client | hostess | event
  entity_id    TEXT NOT NULL,
  at           TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  author       TEXT,
  text         TEXT,
  data_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_entity ON notes (entity_type, entity_id, at);

CREATE TABLE IF NOT EXISTS activities (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  at           TEXT NOT NULL,
  kind         TEXT NOT NULL,               -- wa_in | wa_out | quote | send | status | payment | call | note | import | monday_sync
  dir          TEXT,                        -- in | out | ''
  data_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_entity ON activities (entity_type, entity_id, at);

CREATE TABLE IF NOT EXISTS hostesses (
  id          TEXT PRIMARY KEY,             -- 'H' + phone when there is one
  phone       TEXT,
  name        TEXT NOT NULL,
  city        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  data_json   TEXT NOT NULL                 -- + rate
);

CREATE TABLE IF NOT EXISTS hostess_assignments (
  id           TEXT PRIMARY KEY,
  hostess_id   TEXT NOT NULL,
  event_token  TEXT NOT NULL,
  date         TEXT NOT NULL,               -- YYYY-MM-DD
  status       TEXT NOT NULL,               -- proposed | confirmed | done | paid
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  data_json    TEXT NOT NULL                -- + hours, pay, start, end
);
CREATE INDEX IF NOT EXISTS ha_hostess_date ON hostess_assignments (hostess_id, date);
CREATE INDEX IF NOT EXISTS ha_event ON hostess_assignments (event_token);

CREATE TABLE IF NOT EXISTS reminders (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  due_at       TEXT NOT NULL,               -- ISO
  done         INTEGER NOT NULL DEFAULT 0,
  owner        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  data_json    TEXT NOT NULL                -- + text
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (done, due_at);
