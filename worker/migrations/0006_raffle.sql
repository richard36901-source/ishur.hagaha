-- ishur.io review raffle (worker/raffle.js, 03/11/2026). KV raffle:<id> + raffle:idx stays the
-- source of truth for ticket uniqueness (raffle:t:<n>); this table mirrors every entry when OPS_DB is bound.
CREATE TABLE IF NOT EXISTS raffle_entries (
  id                TEXT PRIMARY KEY,   -- <event token>.<phone> → one entry per phone per event
  token             TEXT NOT NULL,
  phone             TEXT NOT NULL,
  name              TEXT,
  who               INTEGER,            -- 1 host · 2 partner (p=2 link)
  nps               INTEGER,
  exp               INTEGER,
  text              TEXT,
  video_media       TEXT,
  video_link        TEXT,
  video_claimed_at  TEXT,
  video_verified    INTEGER DEFAULT 0,
  google_claimed_at TEXT,
  google_verified   INTEGER DEFAULT 0,
  tickets_json      TEXT NOT NULL,      -- {"t":["5124",...],"src":{"5124":"video"}}
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  ip                TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS raffle_token_phone ON raffle_entries (token, phone);
CREATE INDEX IF NOT EXISTS raffle_created ON raffle_entries (created_at);
