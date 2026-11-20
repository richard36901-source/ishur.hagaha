-- ishur client app · usage data (worker/app-events.js). D1, binding APP_DB.
-- One row per event. uid is a keyed hash of the client's phone; no phone, no guest name, no free text is stored.
CREATE TABLE IF NOT EXISTS app_events (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,          -- when it happened on the device (ms), clamped by the Worker
  day   TEXT    NOT NULL,          -- YYYYMMDD, Israel time, the day the Worker received it
  uid   TEXT    NOT NULL,
  sid   TEXT    NOT NULL DEFAULT '',   -- one run of the app
  name  TEXT    NOT NULL,          -- one of NAMES in app-events.js
  plat  TEXT    NOT NULL DEFAULT 'web',
  ver   TEXT    NOT NULL DEFAULT '',
  tab   TEXT, page TEXT, ctl TEXT, msg TEXT,   -- the props reports group by
  props TEXT    NOT NULL DEFAULT '{}'          -- every kept prop, JSON
);
CREATE INDEX IF NOT EXISTS app_events_day  ON app_events (day, name);
CREATE INDEX IF NOT EXISTS app_events_uid  ON app_events (uid, day);
CREATE TABLE IF NOT EXISTS app_users (
  uid       TEXT PRIMARY KEY,
  first_day TEXT NOT NULL,
  last_day  TEXT NOT NULL,
  plat      TEXT NOT NULL DEFAULT 'web',
  ver       TEXT NOT NULL DEFAULT '',
  events    INTEGER NOT NULL DEFAULT 0
);
