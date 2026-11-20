-- the event-day schedule (worker/lineup.js). In D1 rather than KV: a client who saves and reopens at once must see
-- the new schedule, and KV may serve a cached read for up to 60 seconds.
CREATE TABLE IF NOT EXISTS lineups (
  token TEXT PRIMARY KEY,
  rec   TEXT NOT NULL,      -- JSON from lineup.clean()
  at    TEXT NOT NULL
);
