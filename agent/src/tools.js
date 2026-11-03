/* ============================================================================
   ishur-agent · the tool table
   ----------------------------------------------------------------------------
   Every tool the model may call is declared HERE, with a fixed tier:
     green  = read/report. Runs for anyone in the channel.
     yellow = flags/holds/maintenance. Runs only when AGENT_WRITE === 'on',
              and the agent posts what it did.
     red    = sends to people, deletes, costs money, touches Meta assets.
              Never runs from the model. It becomes a Slack approval that only
              RICHARD_SLACK_ID can approve (see gate.js).
   The tier is a property of the tool, never of the arguments the model sends,
   so a tool that can do both (e.g. /api/event-flag) is split into a green
   reader, a yellow "hold on" and a red general setter.

   Every request shape below was copied from worker/index.js (01/11/2026):
   the line numbers are where each handler reads its body.
   ========================================================================== */

export const DEFAULT_BASE = 'https://go.ishur.io';
const UUID = /^[0-9a-f-]{36}$/;

class ToolInputError extends Error {}
export { ToolInputError };

const str = (v, max = 200) => String(v == null ? '' : v).slice(0, max);
function needToken(a) {
  const t = str(a.token).trim();
  if (!UUID.test(t)) throw new ToolInputError('token must be the full 36-char event token');
  return t;
}
function needPath(a) {
  const p = str(a.path, 600);
  if (!p.startsWith('/')) throw new ToolInputError('path must start with /');
  return p;
}
/* copy only the listed keys that were actually given (no invented params) */
function pick(a, keys) {
  const o = {};
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== '') o[k] = a[k];
  return o;
}

const S = {
  token: { type: 'string', description: 'Event token (36-char UUID)' },
  days: { type: 'number', description: 'How many days back' },
  limit: { type: 'number' },
  kind: { type: 'string', description: 'client|guest|lead|wa_out|wa_status|wa_in|call|pay|meta|cron|admin|slack|event' },
  phone: { type: 'string' },
  q: { type: 'string', description: 'free-text filter' },
  since: { type: 'number', description: 'epoch ms' },
};
const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });

/* tool: { name, tier, path, description, input_schema, body(args) -> object,
           admin (default true), sends (true = reaches guests/clients/leads) } */
export const TOOLS = [
  /* ── green ─────────────────────────────────────────────────────────────── */
  { name: 'audit_query', tier: 'green', path: '/api/audit', // index.js:9840
    description: 'Full audit log (JSON only), filtered. Use for "what happened" questions.',
    input_schema: obj({ days: S.days, from: { type: 'string' }, to: { type: 'string' }, kind: S.kind, token: S.token, phone: S.phone, q: S.q, limit: S.limit, since: S.since }),
    body: a => ({ ...pick(a, ['days', 'from', 'to', 'kind', 'token', 'phone', 'q', 'limit', 'since']) }) /* never format:'csv' — csv export writes a log row */ },
  { name: 'stream_query', tier: 'green', path: '/api/stream', // index.js:9809
    description: 'Live event stream, newest first (default 2 days, 600 rows).',
    input_schema: obj({ days: S.days, limit: S.limit, since: S.since, kind: S.kind, token: S.token, phone: S.phone, q: S.q }),
    body: a => pick(a, ['days', 'limit', 'since', 'kind', 'token', 'phone', 'q']) },
  { name: 'event_status', tier: 'green', path: '/api/status', admin: false, // index.js:11007 (token read, no admin key)
    description: 'Dashboard status of one event by token.',
    input_schema: obj({ token: S.token }, ['token']),
    body: a => ({ token: needToken(a) }) },
  { name: 'delivery_report', tier: 'green', path: '/api/delivery-report', // index.js:9816
    description: 'Per-guest last outgoing message status for an event.',
    input_schema: obj({ token: S.token, since: S.since }, ['token']),
    body: a => ({ token: needToken(a), ...pick(a, ['since']) }) },
  { name: 'cap_status', tier: 'green', path: '/api/cap-status', // index.js:9731
    description: 'Meta 24h conversation cap on the guests number: tier, used, left, frees_at.',
    input_schema: obj({}), body: () => ({}) },
  { name: 'wave_audit', tier: 'green', path: '/api/wave-audit', // index.js:9750
    description: 'Per active event: guests, sent (accepted by Meta), answered, dead, opt-out, missing.',
    input_schema: obj({}), body: () => ({}) },
  { name: 'automations', tier: 'green', path: '/api/automations', // Deliverable A (may not be deployed yet)
    description: 'Automations registry + live state + 7-day dry-run timeline. Primary source for "what goes out tomorrow".',
    input_schema: obj({}), body: () => ({}) },
  { name: 'call_board', tier: 'green', path: '/api/call-board', // index.js:9322
    description: 'Calls board: guests queued for Shir, abandoned leads for Noa, recent Retell calls.',
    input_schema: obj({}), body: () => ({}) },
  { name: 'daily_run_dry', tier: 'green', path: '/api/daily-run', // index.js:9393 → handleDailyRun:6407
    description: 'DRY run of the daily engine: what would be sent, nothing is sent. Optional today=YYYY-MM-DD to simulate another day.',
    input_schema: obj({ today: { type: 'string', description: 'YYYY-MM-DD' } }),
    body: a => ({ dry: true, ...pick(a, ['today']) }) },
  { name: 'event_day_dry', tier: 'green', path: '/api/event-day', // index.js:9718
    description: 'DRY: event-day blast recipients for an event.',
    input_schema: obj({ token: S.token }, ['token']),
    body: a => ({ token: needToken(a), action: 'dry' }) },
  { name: 'call_round_dry', tier: 'green', path: '/api/call-round', // index.js:9680 (drainCallRounds dry writes nothing)
    description: 'DRY: what an extra call round would flag for an event.',
    input_schema: obj({ token: S.token }, ['token']),
    body: a => ({ token: needToken(a), action: 'dry' }) },
  { name: 'event_flag_get', tier: 'green', path: '/api/event-flag', // handleEventFlag:975 (no "on" = read)
    description: 'Read an event flag (hold / extrasend).',
    input_schema: obj({ token: S.token, flag: { type: 'string', enum: ['hold', 'extrasend'] } }, ['token', 'flag']),
    body: a => {
      if (!['hold', 'extrasend'].includes(a.flag)) throw new ToolInputError('flag must be hold|extrasend');
      return { token: needToken(a), flag: a.flag };
    } },
  { name: 'meta_get', tier: 'green', path: '/api/meta-admin', // handleMetaAdmin:7700
    description: 'WhatsApp Cloud API GET (Graph). channel "guests" = Shir number system user; omit for 4499.',
    input_schema: obj({ channel: { type: 'string', enum: ['guests', 'old'] }, path: { type: 'string' } }, ['path']),
    body: a => ({ ...pick(a, ['channel']), path: needPath(a), method: 'GET' }) },
  { name: 'ads_get', tier: 'green', path: '/api/ads', // index.js:9354
    description: 'Meta Marketing API GET (ads/business).',
    input_schema: obj({ path: { type: 'string' } }, ['path']),
    body: a => ({ path: needPath(a), method: 'GET' }) },
  { name: 'monday_query', tier: 'green', path: '/api/lead-monday', // index.js:9399 (gql passthrough)
    description: 'Monday GraphQL QUERY (leads board 18432553641). Mutations are refused here.',
    input_schema: obj({ gql: { type: 'string' }, vars: { type: 'object' } }, ['gql']),
    body: a => {
      const gql = str(a.gql, 4000);
      if (/\bmutation\b/i.test(gql)) throw new ToolInputError('mutations go through monday_mutation');
      return { gql, vars: a.vars && typeof a.vars === 'object' ? a.vars : {} };
    } },
  { name: 'promo_list', tier: 'green', path: '/api/promo', // promo.js:211
    description: 'List site promo codes.',
    input_schema: obj({}), body: () => ({ action: 'list' }) },

  /* ── yellow ────────────────────────────────────────────────────────────── */
  { name: 'event_hold_on', tier: 'yellow', path: '/api/event-flag',
    description: 'PAUSE all sending for one event (hold on). Safe direction only; releasing a hold is red.',
    input_schema: obj({ token: S.token }, ['token']),
    body: a => ({ token: needToken(a), flag: 'hold', on: true }) },
  { name: 'event_day_clear', tier: 'yellow', path: '/api/event-day',
    description: 'Remove a scheduled event-day blast (stops it).',
    input_schema: obj({ token: S.token }, ['token']),
    body: a => ({ token: needToken(a), action: 'clear' }) },
  { name: 'call_round_clear', tier: 'yellow', path: '/api/call-round',
    description: 'Remove a scheduled extra call round (stops it).',
    input_schema: obj({ token: S.token }, ['token']),
    body: a => ({ token: needToken(a), action: 'clear' }) },
  { name: 'evlog_maintenance', tier: 'yellow', path: '/api/evlog', // index.js:8990
    description: 'Audit-log maintenance: audit-mirror | audit-root | audit-meta.',
    input_schema: obj({ action: { type: 'string', enum: ['audit-mirror', 'audit-root', 'audit-meta'] } }, ['action']),
    body: a => {
      if (!['audit-mirror', 'audit-root', 'audit-meta'].includes(a.action)) throw new ToolInputError('bad evlog action');
      return { action: a.action };
    } },
  { name: 'monday_mutation', tier: 'yellow', path: '/api/lead-monday',
    description: 'Monday GraphQL MUTATION (e.g. clear a lead status on instruction). Never deletes items.',
    input_schema: obj({ gql: { type: 'string' }, vars: { type: 'object' } }, ['gql']),
    body: a => {
      const gql = str(a.gql, 4000);
      if (!/\bmutation\b/i.test(gql)) throw new ToolInputError('not a mutation; use monday_query');
      if (/delete_|archive_/i.test(gql)) throw new ToolInputError('delete/archive is not allowed from the agent');
      return { gql, vars: a.vars && typeof a.vars === 'object' ? a.vars : {} };
    } },
  { name: 'pay_link', tier: 'yellow', path: '/api/pay-link', // index.js:9925 — creates a link, sends nothing
    description: 'Create a Grow payment link with a special price (nothing is sent to anyone).',
    input_schema: obj({ sum: { type: 'number' }, tier: { type: 'number' }, plan: { type: 'string', enum: ['basic', 'pro', 'premium'] }, hostess: { type: 'number' }, note: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, description: { type: 'string' } }, ['sum']),
    body: a => {
      if (!(Number(a.sum) > 0)) throw new ToolInputError('sum must be > 0');
      return pick(a, ['sum', 'tier', 'plan', 'hostess', 'note', 'name', 'phone', 'description']);
    } },
  { name: 'linear_create_issue', tier: 'yellow', linear: true,
    description: 'Create a Linear task (team from LINEAR_TEAM_ID).',
    input_schema: obj({ title: { type: 'string' }, description: { type: 'string' } }, ['title']),
    body: a => ({ title: str(a.title, 200), description: str(a.description, 4000) }) },

  /* ── red ───────────────────────────────────────────────────────────────── */
  { name: 'event_flag_set', tier: 'red', path: '/api/event-flag', sends: true,
    description: 'Set/clear hold, extrasend or cancel. Releasing hold or setting extrasend/cancel can trigger messages.',
    input_schema: obj({ token: S.token, flag: { type: 'string', enum: ['hold', 'extrasend', 'cancel'] }, on: { type: 'boolean' }, reason: { type: 'string' } }, ['token', 'flag', 'on']),
    body: a => {
      if (!['hold', 'extrasend', 'cancel'].includes(a.flag)) throw new ToolInputError('bad flag');
      if (typeof a.on !== 'boolean') throw new ToolInputError('on must be boolean');
      return { token: needToken(a), flag: a.flag, on: a.on, ...pick(a, ['reason']) };
    } },
  { name: 'wave_retry', tier: 'red', path: '/api/wave-retry', sends: true, // index.js:9566
    /* RED EVEN WITH dry:true — the handler deletes wfail/wdead/wferr/gday/wave
       keys and writes pacer:pending in RATE before it looks at dry. */
    description: 'Re-open a wave for undelivered guests and run the engine. Even dry:true mutates engine KV, so always red.',
    input_schema: obj({ token: S.token, wave: { type: 'string' }, dry: { type: 'boolean' }, budget: { type: 'number' } }, ['token', 'wave']),
    body: a => ({ token: needToken(a), wave: str(a.wave || '1', 2), ...pick(a, ['dry', 'budget']) }) },
  { name: 'daily_run', tier: 'red', path: '/api/daily-run', sends: true,
    description: 'REAL engine run (sends).',
    input_schema: obj({ budget: { type: 'number' } }),
    body: a => ({ dry: false, ...pick(a, ['budget']) }) },
  { name: 'event_day_blast', tier: 'red', path: '/api/event-day', sends: true,
    description: 'Schedule (set) or run an event-day blast.',
    input_schema: obj({ token: S.token, action: { type: 'string', enum: ['set', 'run'] }, at: { type: 'string' }, time: { type: 'string' }, what: { type: 'string' }, address: { type: 'string' }, nav: { type: 'string' }, template: { type: 'string' }, no_table: { type: 'boolean' }, params: { type: 'array', items: { type: 'string' } } }, ['token', 'action']),
    body: a => {
      if (!['set', 'run'].includes(a.action)) throw new ToolInputError('action must be set|run');
      return { token: needToken(a), action: a.action, ...pick(a, ['at', 'time', 'what', 'address', 'nav', 'template', 'no_table', 'params']) };
    } },
  { name: 'call_round', tier: 'red', path: '/api/call-round', sends: true,
    description: 'Schedule (set) or run an extra call round (real phone calls).',
    input_schema: obj({ token: S.token, action: { type: 'string', enum: ['set', 'run'] }, at: { type: 'string' }, guest_ids: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } }, ['token', 'action']),
    body: a => {
      if (!['set', 'run'].includes(a.action)) throw new ToolInputError('action must be set|run');
      return { token: needToken(a), action: a.action, ...pick(a, ['at', 'guest_ids', 'note']) };
    } },
  { name: 'guest_edit', tier: 'red', path: '/api/guest-edit', admin: false, // index.js:10382 (token-authenticated)
    description: 'Edit a guest (name / phone / seats) in the client sheet.',
    input_schema: obj({ token: S.token, guest_id: { type: 'string' }, name: { type: 'string' }, phone: { type: 'string' }, seats: { type: 'number' } }, ['token', 'guest_id', 'name']),
    body: a => ({ token: needToken(a), guest_id: str(a.guest_id, 60), name: str(a.name, 60), ...pick(a, ['phone', 'seats']) }) },
  { name: 'meta_write', tier: 'red', path: '/api/meta-admin',
    description: 'WhatsApp Cloud API write (POST/DELETE): templates, phone numbers, profile.',
    input_schema: obj({ channel: { type: 'string', enum: ['guests', 'old'] }, path: { type: 'string' }, method: { type: 'string', enum: ['POST', 'DELETE'] }, payload: { type: 'object' } }, ['path', 'method']),
    body: a => {
      if (!['POST', 'DELETE'].includes(a.method)) throw new ToolInputError('method must be POST|DELETE');
      return { ...pick(a, ['channel']), path: needPath(a), method: a.method, ...pick(a, ['payload']) };
    } },
  { name: 'ads_write', tier: 'red', path: '/api/ads',
    description: 'Meta Marketing API write (budgets, statuses) — costs money.',
    input_schema: obj({ path: { type: 'string' }, method: { type: 'string', enum: ['POST', 'DELETE'] }, payload: { type: 'object' }, note: { type: 'string' } }, ['path', 'method', 'note']),
    body: a => {
      if (!['POST', 'DELETE'].includes(a.method)) throw new ToolInputError('method must be POST|DELETE');
      return { path: needPath(a), method: a.method, ...pick(a, ['payload', 'note']) };
    } },
  { name: 'promo_create', tier: 'red', path: '/api/promo',
    description: 'Create a public promo code on the site (pricing).',
    input_schema: obj({ campaign: { type: 'string' }, cap: { type: 'number' }, price: { type: 'number' }, plan: { type: 'string' }, maxTier: { type: 'number' }, label: { type: 'string' }, greeting: { type: 'string' }, link: { type: 'string' }, overwrite: { type: 'boolean' } }, ['campaign']),
    body: a => ({ action: 'create', ...pick(a, ['campaign', 'cap', 'price', 'plan', 'maxTier', 'label', 'greeting', 'link', 'overwrite']) }) },
];

export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map(t => [t.name, t]));
export const TIERS = Object.fromEntries(TOOLS.map(t => [t.name, t.tier]));

/* the definitions handed to the Messages API (no tier info leaks into the model's
   ability to act — the gate decides, not the prompt) */
export function claudeToolDefs() {
  return TOOLS.map(t => ({
    name: t.name,
    description: `[${t.tier}] ${t.description}`,
    input_schema: t.input_schema,
  }));
}

/* Build the exact HTTP request a tool would make. Pure: no network. */
export function buildRequest(env, name, args = {}) {
  const t = TOOL_BY_NAME[name];
  if (!t) throw new ToolInputError('unknown tool ' + name);
  const body = t.body(args || {});
  if (t.linear) {
    return {
      url: 'https://api.linear.app/graphql',
      init: { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: String(env.LINEAR_API_KEY || '') },
        body: JSON.stringify({ query: 'mutation($i:IssueCreateInput!){issueCreate(input:$i){success issue{identifier url}}}',
          variables: { i: { teamId: String(env.LINEAR_TEAM_ID || ''), title: body.title, description: body.description } } }) },
    };
  }
  const full = t.admin === false ? body : { admin_key: String(env.AGENT_ADMIN_KEY || ''), ...body };
  return {
    url: String(env.ISHUR_BASE || DEFAULT_BASE).replace(/\/$/, '') + t.path,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'ishur-agent/1.0 (Claude Slack agent; node)' }, body: JSON.stringify(full) },
  };
}

/* Execute a tool's HTTP call (NO tier check here — gate.js is the only caller
   allowed to reach this for non-green tools). */
export async function callTool(env, name, args, fetchImpl = fetch) {
  const { url, init } = buildRequest(env, name, args);
  const r = await fetchImpl(url, init);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text.slice(0, 2000); }
  return { http_status: r.status, ok: r.ok, data };
}
