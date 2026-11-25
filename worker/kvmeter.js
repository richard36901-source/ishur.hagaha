/* ============================================================================
   kvmeter.js · 25/11/2026 — the KV bill can never hide again
   ----------------------------------------------------------------------------
   215.7M KV reads in 30 days (≈ $100) went unseen for three weeks because
   nothing in the Worker counted them. This module counts every KV call the
   Worker makes, by key prefix, and adds NO KV reads of its own:

   · per invocation — one console.log line ("kvmeter …") only when the
     invocation read more than KV_METER_LOG keys (default 500). Visible in
     `wrangler tail` / the dashboard's real-time logs.
   · per isolate — the running totals are written (put only, never read) to
     kvm:<day>:<isolate> with the numbers in the key's METADATA, at most once
     every FLUSH_MS. A list() returns metadata without a read.
   · per day — dailyRollup() (the 07:00 heartbeat cron) lists kvm:<yesterday>:,
     sums the metadata and writes ONE key, kvmeter:<yesterday>.

   The wrapped namespace keeps the same object for the life of the isolate:
   several modules memoise by env.RATE identity (cfg.js, snapshot.js), and a
   fresh wrapper per request would have turned every memo into a miss.
   Concurrent invocations in one isolate share the counters, so a per-
   invocation line can include a neighbour's calls (over-, never under-count).
   ========================================================================== */

export const KVM_PREFIX = 'kvm:';
export const KVMETER_KEY = day => 'kvmeter:' + day;
export const FLUSH_MS = 120000;
const ISO_TTL = 4 * 86400;
const DAY_TTL = 400 * 86400;
const RAW = Symbol('kvmeter-raw');

const ilDay = (t = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date(t));
/* 'wsent:<uuid>:1:9725…' → 'wsent'; 'cfg:x' → 'cfg' */
export const prefixOf = k => String(k || '').split(':')[0].slice(0, 24) || '(empty)';

const WRAPS = new WeakMap();

function newTotals(day) { return { day, get: 0, list: 0, put: 0, del: 0, pre: {} }; }

function makeMeter(raw) {
  const st = {
    iso: Math.random().toString(36).slice(2, 10),
    tot: newTotals(ilDay()),
    frames: new Set(),
    lastFlush: Date.now(), dirty: false,
  };
  const bump = (op, key) => {
    const p = prefixOf(key);
    const add = t => { t[op]++; if (op === 'get' || op === 'list') { const pk = (op === 'list' ? 'L:' : '') + p; t.pre[pk] = (t.pre[pk] || 0) + 1; } };
    add(st.tot); for (const f of st.frames) add(f);
    st.dirty = true;
  };
  const proxy = {
    [RAW]: raw,
    get(k, o) { bump('get', k); return raw.get(k, o); },
    getWithMetadata(k, o) { bump('get', k); return raw.getWithMetadata(k, o); },
    list(o) { bump('list', o && o.prefix); return raw.list(o); },
    put(k, v, o) { bump('put', k); return raw.put(k, v, o); },
    delete(k) { bump('del', k); return raw.delete(k); },
  };
  return { st, proxy };
}

/* env with RATE wrapped (same wrapper for the whole isolate). No RATE, or already wrapped → env unchanged. */
export function meterEnv(env) {
  if (!env || !env.RATE || env.RATE[RAW]) return env;
  let m = WRAPS.get(env.RATE);
  if (!m) { m = makeMeter(env.RATE); WRAPS.set(env.RATE, m); WRAPS.set(m.proxy, m); }
  return { ...env, RATE: m.proxy };
}
export const meterOf = env => (env && env.RATE ? WRAPS.get(env.RATE) || null : null);
export const rawKv = env => (env && env.RATE && env.RATE[RAW]) || (env && env.RATE) || null;

/* one invocation: begin() … end(). end() logs one line when the reads pass the threshold and flushes the isolate totals when due. */
export function beginInvocation(env, what) {
  const m = meterOf(env); if (!m) return null;
  const f = { what: String(what || '').slice(0, 80), get: 0, list: 0, put: 0, del: 0, pre: {}, t0: Date.now() };
  m.st.frames.add(f);
  return f;
}
export function topPrefixes(pre, n = 6) {
  return Object.entries(pre || {}).sort((a, b) => b[1] - a[1]).slice(0, n).map(([p, c]) => p + '=' + c).join(' ');
}
export async function endInvocation(env, f, { log = console.log, now = Date.now(), force = false } = {}) {
  const m = meterOf(env); if (!m || !f) return null;
  m.st.frames.delete(f);
  const threshold = Number(env.KV_METER_LOG) > 0 ? Number(env.KV_METER_LOG) : 500;
  let line = null;
  if (f.get + f.list > threshold) {
    line = `kvmeter ${f.what} get=${f.get} list=${f.list} put=${f.put} del=${f.del} ms=${now - f.t0} top: ${topPrefixes(f.pre)}`;
    try { log(line); } catch {}
  }
  /* a cron isolate can be evicted right after its one heavy run: flush at once after every cron and every heavy invocation */
  await flushIsolate(env, { now, force: force || !!line }).catch(() => {});
  return line;
}

/* the isolate's totals → kvm:<day>:<iso> (metadata only; a put, never a read) */
export async function flushIsolate(env, { now = Date.now(), force = false } = {}) {
  const m = meterOf(env); if (!m) return false;
  const st = m.st; const day = ilDay(now);
  const rolled = day !== st.tot.day;
  if (!st.dirty && !rolled) return false;
  if (!force && !rolled && now - st.lastFlush < FLUSH_MS) return false;
  const t = st.tot;
  const meta = { g: t.get, l: t.list, p: t.put, d: t.del, top: Object.entries(t.pre).sort((a, b) => b[1] - a[1]).slice(0, 12) };
  while (JSON.stringify(meta).length > 900 && meta.top.length) meta.top.pop();   /* KV metadata cap is 1024 bytes */
  st.lastFlush = now; st.dirty = false;
  if (rolled) st.tot = newTotals(day);
  await m.proxy[RAW].put(KVM_PREFIX + t.day + ':' + st.iso, '1', { expirationTtl: ISO_TTL, metadata: meta });
  return true;
}

/* once a day: sum every isolate's last flush for `day` into kvmeter:<day>. Lists only (no reads). */
export async function dailyRollup(env, day) {
  const kv = rawKv(env); if (!kv || !day) return null;
  const sum = { day, get: 0, list: 0, put: 0, del: 0, isolates: 0, top: {} };
  let cursor;
  for (let i = 0; i < 20; i++) {
    const page = await kv.list({ prefix: KVM_PREFIX + day + ':', cursor, limit: 1000 });
    for (const k of page.keys || []) {
      const md = k.metadata; if (!md) continue;
      sum.isolates++; sum.get += md.g || 0; sum.list += md.l || 0; sum.put += md.p || 0; sum.del += md.d || 0;
      for (const [p, n] of md.top || []) sum.top[p] = (sum.top[p] || 0) + n;
    }
    if (page.list_complete) break; cursor = page.cursor;
  }
  sum.top = Object.fromEntries(Object.entries(sum.top).sort((a, b) => b[1] - a[1]).slice(0, 25));
  sum.note = 'lower bound: an isolate that ended within ' + FLUSH_MS / 1000 + ' s of its last flush is missing its tail; the Cloudflare dashboard has the exact total';
  await kv.put(KVMETER_KEY(day), JSON.stringify(sum), { expirationTtl: DAY_TTL });
  return sum;
}
