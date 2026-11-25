-- ============================================================================
-- ishur.io · D1 schema (database ishur-staging / later ishur-main), 26/11/2026
-- docs/D1-PLAN.md. Phase 1 fills events, guests, leads, mirror_runs (d1mirror.js).
-- sends, calls, messages, answers_history, team_items are created now and
-- filled from phase 2 (dual-write). Apply with:
--   npx wrangler d1 migrations apply ishur-staging --remote --env staging
-- This file is the cumulative schema; d1/migrations/ holds the same SQL in steps.
-- ============================================================================

-- ── mirrors of the three sheet tabs (every sheet column typed + the raw row) ──
CREATE TABLE IF NOT EXISTS events (
  key TEXT PRIMARY KEY,                -- stable row key (d1mirror.js keyOf)
  c_a TEXT,
  token TEXT,
  client TEXT,
  phone TEXT,
  venue TEXT,
  occasion TEXT,
  event_date TEXT,
  paid TEXT,
  c_i TEXT,
  c_j TEXT,
  c_k TEXT,
  c_l TEXT,
  c_m TEXT,
  c_n TEXT,
  c_o TEXT,
  c_p TEXT,
  c_q TEXT,
  c_r TEXT,
  c_s TEXT,
  c_t TEXT,
  c_u TEXT,
  c_v TEXT,
  c_w TEXT,
  c_x TEXT,
  c_y TEXT,
  c_z TEXT,
  c_aa TEXT,
  cancelled TEXT,
  c_ac TEXT,
  c_ad TEXT,
  c_ae TEXT,
  plan TEXT,
  tier TEXT,
  style TEXT,
  hosts TEXT,
  c_aj TEXT,
  event_time TEXT,
  city TEXT,
  address TEXT,
  send_date_1 TEXT,
  send_date_2 TEXT,
  send_date_3 TEXT,
  c_aq TEXT,
  c_ar TEXT,
  c_as TEXT,
  c_at TEXT,
  c_au TEXT,
  c_av TEXT,
  c_aw TEXT,
  c_ax TEXT,
  c_ay TEXT,
  sheet_row INTEGER,                   -- sheet row at the last write (informational: not in the hash)
  raw TEXT NOT NULL,                   -- the row exactly as read, JSON array, trailing empties dropped
  hash TEXT NOT NULL,                  -- sha1 of raw
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT                      -- soft delete: the row left the sheet
);
CREATE TABLE IF NOT EXISTS guests (
  key TEXT PRIMARY KEY,                -- stable row key (d1mirror.js keyOf)
  c_a TEXT,
  c_b TEXT,
  guest_id TEXT,
  name TEXT,
  phone TEXT,
  invited INTEGER,
  c_g TEXT,
  c_h TEXT,
  sent TEXT,
  c_j TEXT,
  c_k TEXT,
  c_l TEXT,
  c_m TEXT,
  party INTEGER,
  c_o TEXT,
  rsvp TEXT,
  c_q TEXT,
  c_r TEXT,
  c_s TEXT,
  c_t TEXT,
  c_u TEXT,
  call_status TEXT,
  call_answer TEXT,
  c_x TEXT,
  notes TEXT,
  last_change TEXT,
  c_aa TEXT,
  c_ab TEXT,
  token TEXT,
  tries INTEGER,
  table_no TEXT,
  c_af TEXT,
  sheet_row INTEGER,                   -- sheet row at the last write (informational: not in the hash)
  raw TEXT NOT NULL,                   -- the row exactly as read, JSON array, trailing empties dropped
  hash TEXT NOT NULL,                  -- sha1 of raw
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT                      -- soft delete: the row left the sheet
);
CREATE TABLE IF NOT EXISTS leads (
  key TEXT PRIMARY KEY,                -- stable row key (d1mirror.js keyOf)
  c_a TEXT,
  name TEXT,
  phone TEXT,
  email TEXT,
  c_e TEXT,
  c_f TEXT,
  c_g TEXT,
  c_h TEXT,
  c_i TEXT,
  c_j TEXT,
  c_k TEXT,
  c_l TEXT,
  c_m TEXT,
  c_n TEXT,
  c_o TEXT,
  c_p TEXT,
  c_q TEXT,
  c_r TEXT,
  c_s TEXT,
  c_t TEXT,
  c_u TEXT,
  c_v TEXT,
  c_w TEXT,
  c_x TEXT,
  c_y TEXT,
  c_z TEXT,
  sheet_row INTEGER,                   -- sheet row at the last write (informational: not in the hash)
  raw TEXT NOT NULL,                   -- the row exactly as read, JSON array, trailing empties dropped
  hash TEXT NOT NULL,                  -- sha1 of raw
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT                      -- soft delete: the row left the sheet
);

CREATE INDEX IF NOT EXISTS events_live ON events(deleted_at);
CREATE INDEX IF NOT EXISTS events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS events_phone ON events(phone);
CREATE INDEX IF NOT EXISTS guests_token_rsvp ON guests(token, rsvp);   -- board counts, also serves "by token"
CREATE INDEX IF NOT EXISTS guests_phone ON guests(phone);
CREATE INDEX IF NOT EXISTS guests_updated ON guests(updated_at);       -- "what changed today"
CREATE INDEX IF NOT EXISTS leads_phone ON leads(phone);

-- ── per guest per wave: replaces KV wsent:/wferr:/wfail:/wdead: ──
CREATE TABLE IF NOT EXISTS sends (
  token TEXT NOT NULL,
  wave INTEGER NOT NULL,
  phone TEXT NOT NULL,                 -- 972… digits
  guest_id TEXT,
  status TEXT NOT NULL,                -- sent | failed (wfail) | error (wferr) | dead (wdead)
  code TEXT,                           -- Meta error code for failed/error/dead
  tries INTEGER NOT NULL DEFAULT 0,
  wa_id TEXT,                          -- Meta message id
  template TEXT,
  at TEXT NOT NULL,
  day TEXT NOT NULL,                   -- YYYY-MM-DD Israel
  PRIMARY KEY (token, wave, phone)
);
CREATE INDEX IF NOT EXISTS sends_day ON sends(day);
CREATE INDEX IF NOT EXISTS sends_phone ON sends(phone);

-- ── calls: replaces shirtry:<guest>:<day> and the call records in the audit stream ──
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  token TEXT,
  guest_id TEXT,
  phone TEXT,
  agent TEXT,
  kind TEXT,                           -- guest | lead | team
  started_at TEXT,
  day TEXT,
  duration_ms INTEGER,
  outcome TEXT,
  rsvp TEXT,
  party INTEGER,
  disconnection_reason TEXT,
  recording_key TEXT,                  -- R2 key rec/<call_id> (bytes stay in R2)
  summary TEXT,
  transcript TEXT
);
CREATE INDEX IF NOT EXISTS calls_day ON calls(day);
CREATE INDEX IF NOT EXISTS calls_token ON calls(token);
CREATE INDEX IF NOT EXISTS calls_guest_day ON calls(guest_id, day);
CREATE INDEX IF NOT EXISTS calls_phone ON calls(phone);

-- ── WhatsApp log: replaces log:<phone>:<ts> (and conv:<phone> becomes a query) ──
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                 -- Meta wamid, or <phone>:<ts> for legacy rows
  phone TEXT NOT NULL,
  token TEXT,
  line TEXT,                           -- guests | noa | client
  direction TEXT NOT NULL,             -- in | out | status
  kind TEXT,                           -- text | template | button | image | …
  body TEXT,
  status TEXT,                         -- sent | delivered | read | failed
  at TEXT NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_phone_at ON messages(phone, at);
CREATE INDEX IF NOT EXISTS messages_day ON messages(day);
CREATE INDEX IF NOT EXISTS messages_token ON messages(token);

-- ── every answer ever given: replaces rsvpfinal:<guest> and feeds answers-log.js ──
CREATE TABLE IF NOT EXISTS answers_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  rsvp TEXT,
  party INTEGER,
  method TEXT,                         -- call | wa | link | manual (answers-log.js METHODS)
  source_id TEXT,                      -- call_id or message id behind it
  who TEXT,
  at TEXT NOT NULL,
  day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS answers_guest ON answers_history(token, guest_id, at);
CREATE INDEX IF NOT EXISTS answers_day ON answers_history(day);

-- ── team notes + issues: replaces teamnote:* and teamissue:* ──
CREATE TABLE IF NOT EXISTS team_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                  -- note | issue
  type TEXT,
  title TEXT,
  text TEXT,
  status TEXT,                         -- open | done | …
  event_token TEXT,
  opener TEXT,
  assignee TEXT,
  at TEXT NOT NULL,
  done_at TEXT,
  raw TEXT                             -- the KV document as it was
);
CREATE INDEX IF NOT EXISTS team_items_status ON team_items(kind, status, at);

-- ── the mirror's own run log (one row per pass that changed something) ──
CREATE TABLE IF NOT EXISTS mirror_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- refresh | full
  upserted INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  ms INTEGER,
  note TEXT
);
