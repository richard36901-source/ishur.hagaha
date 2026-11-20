-- the number a client committed to the venue (worker/venue-commit.js). In D1 so a save or a clear reads back at once.
CREATE TABLE IF NOT EXISTS venue_commits (
  token TEXT PRIMARY KEY,
  n     INTEGER NOT NULL,
  at    TEXT NOT NULL
);
