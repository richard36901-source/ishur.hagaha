#!/usr/bin/env node
/* ============================================================================
   registry-sync.mjs — every scheduled behaviour and every sending admin route
   has a node in automations-registry.js (Richard 03/11: "every new automation
   must appear in the ops center")
   ----------------------------------------------------------------------------
   Scans the code, not the registry:
     · ledger ids: withRun(env, '<id>'), manualRun(env, '<id>'), opsJob(env,
       '<job>') (mapped through JOB_TO_ID), step('<id>') in runPacer, and the
       brain's withRun ids (brain_fix:<playbook> → node brain_fix)
     · the brain's CHECKS and PLAYBOOKS ids → listed on brain_health / brain_fix
     · POST routes in index.js (`url.pathname === '/api/…'`, plus the
       /api/crm/* and /api/ops/* routers) whose block — or the handler it
       calls, one level deep — sends a WhatsApp / SMS / call or runs the
       engine. Covered when a node lists the path in `routes[]`, `trigger.via`
       or `source.symbol`; or the path is in EXEMPT with a reason.
   test/registry-sync.test.mjs fails on any gap. CLI prints the gaps:
     node worker/scripts/registry-sync.mjs
   ========================================================================== */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = f => readFileSync(resolve(W, f), 'utf8');

/* what "sends or acts on people" looks like in this codebase */
export const SEND_RE = /\bsend(Template|Client|Text|CtaUrl|Wave|Interactive|Media|Buttons|List|Image|Document|Guest)\w*\(|\bd\.sendText\(|api\.telnyx\.com\/v2\/messages|create-phone-call|createPhoneCall|\brunDailyEngine\(|\brunPacer\(|\bdrainCallRounds\(|\brunShir(Dispatch|Callbacks|LeadDial)\(|\bhandle(GiftBlast|SubeventSend|ShirDispatch|DailyRun|Resend|WaveRetry)\(|\bdialGuest\w*\(|\bplaceCall\w*\(/;

/* routes that match SEND_RE but are not automations, with the reason */
export const EXEMPT = {
  '/api/test-inbound': 'test harness: simulates an inbound message, sends only to the test number',
  '/api/linear-test': 'test: Linear API ping',
  '/api/staging-probe': 'dev-staging smoke: exists only when STAGING="1", one text to a phone so smoke.sh can prove the allowlist guard on the live staging worker',
  '/api/test-slack-queue': 'test: Slack quiet-hours queue',
  '/api/otp-send': 'login code to an admin/client phone (auth, not an automation)',
  '/api/admin-otp': 'login code to Richard (auth)',
  '/api/portfolio-otp': 'login code to a portfolio client (auth)',
  '/api/human': 'guest asked for a human: one reply in the same conversation (reaction, covered by t_wa_status)',
  '/api/noa-inbound': 'inbound 4499 webhook (reaction, covered by t_wa_status)',
  '/api/wa-webhook': 'Meta webhook (node t_wa_status)',
  '/api/shir-webhook': 'Retell webhook (call results, node reconcile_calls)',
  '/api/shir-inbound': 'inbound call to Shir (reaction)',
  '/api/grow-ipn': 'payment IPN (reaction: receipt to the paying client)',
  '/api/monday-hook': 'Monday webhook (reaction)',
  '/api/monday-won': 'Monday "won" webhook (reaction)',
};

/* ledger ids the code writes */
export function ledgerIds() {
  const ix = read('index.js'), br = read('brain.js');
  const out = new Map();
  const add = (id, where) => { if (!out.has(id)) out.set(id, where); };
  for (const [src, file] of [[ix, 'index.js'], [br, 'brain.js']]) {
    for (const m of src.matchAll(/\b(withRun|manualRun)\(env,\s*'([^']+)'/g)) add(m[2].endsWith(':') ? m[2].slice(0, -1) : m[2], `${file} ${m[1]}`);
    for (const m of src.matchAll(/\bopsJob\(env,\s*'([^']+)'/g)) add('job:' + m[1], `${file} opsJob`);
    for (const m of src.matchAll(/\bstep\('([^']+)'/g)) add(m[1], `${file} runPacer step`);
  }
  return out;
}

/* the brain's check + playbook ids */
export function brainIds() {
  const br = read('brain.js');
  const sect = (from, to) => { const a = br.indexOf(from), b = to ? br.indexOf(to, a + 1) : br.length; return br.slice(a, b); };
  const ids = s => [...s.matchAll(/^  \{ id: '([a-z0-9_]+)'/gm)].map(m => m[1]);
  return { checks: ids(sect('export const CHECKS', 'export const PLAYBOOKS')), playbooks: ids(sect('export const PLAYBOOKS', '\nconst PB')) };
}

/* function bodies by name across worker/*.js (top-level `function name(` → the next line that is just `}`) */
let FN = null;
function fnBodies() {
  if (FN) return FN;
  FN = new Map();
  for (const f of readdirSync(W).filter(f => f.endsWith('.js'))) {
    const lines = read(f).split('\n');
    lines.forEach((l, i) => {
      const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/.exec(l);
      if (!m) return;
      let j = i + 1; while (j < lines.length && lines[j] !== '}') j++;
      FN.set(m[1], { file: f, line: i + 1, body: lines.slice(i, j + 1).join('\n') });
    });
  }
  return FN;
}

/* POST route blocks in index.js: from the route's `if` to the next route `if` */
export function postRoutes() {
  const lines = read('index.js').split('\n');
  const starts = [];
  lines.forEach((l, i) => { const m = /^\s*if \(url\.pathname === '(\/api\/[^']+)'(.*)/.exec(l); if (m) starts.push({ i, path: m[1], post: /'POST'/.test(m[2]) || !/request\.method/.test(m[2]) }); });
  const nextIf = i => { for (let k = i + 1; k < lines.length; k++) if (/^\s*if \(url\.pathname/.test(lines[k]) || /^\s{4}\/\* /.test(lines[k]) && /^\s{4}if \(url/.test(lines[k + 1] || '')) return k; return Math.min(lines.length, i + 80); };
  return starts.filter(s => s.post).map(s => ({ path: s.path, line: s.i + 1, body: lines.slice(s.i, nextIf(s.i)).join('\n') }));
}
export function sends(body, depth = 1) {
  if (SEND_RE.test(body)) return (SEND_RE.exec(body) || [''])[0];
  if (depth <= 0) return '';
  for (const m of body.matchAll(/\b(handle\w+|run\w+|drain\w+)\(/g)) {
    const f = fnBodies().get(m[1]);
    if (f) { const hit = sends(f.body, depth - 1); if (hit) return `${m[1]} → ${hit}`; }
  }
  return '';
}
/* sending routes outside index.js's chain: /api/crm/* (crm.js) and /api/ops/* (ops.js) */
export function routerSends() {
  const out = [];
  const crm = read('crm.js');
  for (const m of crm.matchAll(/case '([a-z-]+)':/g)) {
    const blk = crm.slice(m.index, crm.indexOf("case '", m.index + 6) > 0 ? crm.indexOf("case '", m.index + 6) : m.index + 3000);
    for (const fm of blk.matchAll(/\b(\w+)\(env, d,/g)) { const f = fnBodies().get(fm[1]); if (f && /\bd\.send\w+\(/.test(f.body)) out.push({ path: '/api/crm/' + m[1], line: f.line, file: 'crm.js', via: fm[1] + ' → ' + (/\bd\.send\w+\(/.exec(f.body) || [''])[0] }); }
  }
  return out;
}

export function sendingRoutes() {
  const r = postRoutes().map(x => ({ ...x, hit: sends(x.body) })).filter(x => x.hit).map(({ body, ...x }) => x);
  return [...r, ...routerSends().map(x => ({ path: x.path, line: x.line, hit: x.via, file: x.file }))];
}

/* gaps against a registry */
export function gaps(reg) {
  const nodes = reg.AUTOMATIONS, byId = new Set(nodes.map(n => n.id));
  const routeCovered = p => nodes.some(n => (n.routes || []).includes(p) || String((n.trigger && n.trigger.via) || '').split(/[\s·,]+/).includes(p) || String((n.source && n.source.symbol) || '').includes(`'${p}'`));
  const missingIds = [];
  for (const [id, where] of ledgerIds()) {
    const real = id.startsWith('job:') ? reg.JOB_TO_ID[id.slice(4)] : id;
    if (!real) missingIds.push({ id, where, why: 'opsJob name not in JOB_TO_ID' });
    else if (!byId.has(real)) missingIds.push({ id: real, where, why: 'no registry node' });
  }
  const b = brainIds();
  const node = id => nodes.find(n => n.id === id) || {};
  const missingChecks = b.checks.filter(c => !(node('brain_health').checks || []).includes(c));
  const missingPlaybooks = b.playbooks.filter(p => !(node('brain_fix').playbooks || []).includes(p));
  const missingRoutes = sendingRoutes().filter(r => !EXEMPT[r.path] && !routeCovered(r.path));
  return { missingIds, missingChecks, missingPlaybooks, missingRoutes, ok: !missingIds.length && !missingChecks.length && !missingPlaybooks.length && !missingRoutes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const reg = await import(resolve(W, 'automations-registry.js'));
  const g = gaps(reg);
  console.log('sending routes found:', sendingRoutes().map(r => `${r.path} (${r.hit})`).join('\n  '));
  console.log(JSON.stringify({ missingIds: g.missingIds, missingChecks: g.missingChecks, missingPlaybooks: g.missingPlaybooks, missingRoutes: g.missingRoutes }, null, 2));
  process.exit(g.ok ? 0 : 1);
}
