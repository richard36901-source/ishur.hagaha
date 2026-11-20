/* The number a client committed to the venue (Richard 20/11/2026): the sixth tile of the board's status grid.
   The client types what they promised the hall; next to it the board shows how many we would recommend, and a tick
   when the two agree. KV: venuecommit:<token> = the number.

   The recommendation is people, not records: everyone who confirmed, half of the undecided, and three in ten of
   those who have not answered. It is shown only once at least half of the invited people answered; before that it
   would be a guess. These three numbers are a first setting, to be tuned against real events. */
export const RATE_UNDECIDED = 0.5, RATE_PENDING = 0.3, MIN_ANSWERED = 0.5, MAX_COMMIT = 5000;

export function recommend(t = {}) {
  const num = v => Math.max(0, Number(v) || 0);
  const yes = num(t.confirmed_seats != null ? t.confirmed_seats : t.confirmed);
  const maybe = num(t.undecided_seats != null ? t.undecided_seats : t.undecided);
  const wait = num(t.pending_seats != null ? t.pending_seats : t.pending);
  const no = num(t.declined_seats != null ? t.declined_seats : t.declined);
  const all = yes + maybe + wait + no;
  const ready = all > 0 && (yes + no + maybe) / all >= MIN_ANSWERED;
  return { ready, n: ready ? Math.round(yes + maybe * RATE_UNDECIDED + wait * RATE_PENDING) : null };
}
/* agrees = within 5 people or 5%, whichever is larger */
export function fits(commit, rec) {
  if (!(commit > 0) || !(rec > 0)) return false;
  return Math.abs(commit - rec) <= Math.max(5, Math.round(rec * 0.05));
}
export function parseCommit(v) {
  if (v === '' || v == null) return 0;                       /* empty clears it */
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 && n <= MAX_COMMIT ? n : null;
}
/* storage: D1 (APP_DB, table venue_commits) when bound, so a save or a clear reads back at once (KV may serve a cached
   read for a minute); KV otherwise */
export async function readCommit(env, token) {
  try {
    if (env.APP_DB) { const r = await env.APP_DB.prepare('SELECT n FROM venue_commits WHERE token = ?').bind(token).first(); return r && r.n > 0 ? Number(r.n) : null; }
    const n = parseInt(await env.RATE.get('venuecommit:' + token), 10); return n > 0 ? n : null;
  } catch { return null; }
}
export async function writeCommit(env, token, n) {
  if (env.APP_DB) {
    if (n > 0) await env.APP_DB.prepare('INSERT INTO venue_commits (token, n, at) VALUES (?,?,?) ON CONFLICT(token) DO UPDATE SET n = excluded.n, at = excluded.at').bind(token, n, new Date().toISOString()).run();
    else await env.APP_DB.prepare('DELETE FROM venue_commits WHERE token = ?').bind(token).run();
    return;
  }
  if (n > 0) await env.RATE.put('venuecommit:' + token, String(n), { expirationTtl: 400 * 86400 });
  else await env.RATE.delete('venuecommit:' + token);
}
/* what /api/status hands the board */
export async function venueFor(env, token, totals) {
  const rec = recommend(totals), commit = await readCommit(env, token);
  const diff = commit && rec.n != null ? commit - rec.n : null;
  return { commit, recommended: rec.n, ready: rec.ready, ok: commit != null && rec.n != null ? fits(commit, rec.n) : null, diff };
}
