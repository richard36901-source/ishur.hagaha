/* ============================================================================
   ishur.io · linear-task.js · an alert that needs Richard becomes a Linear task
   (Richard 22/11/2026: "if there's a problem that needs my attention or decision
   put it into my Linear so I won't miss it; Slack only the updates")
   ----------------------------------------------------------------------------
   slackSend calls actionTask() with the text it is about to post. When the text
   says "נדרשת פעולה ממך" (and not "לא נדרשת"), ONE issue is opened in Linear:
   team AutoScalehq, project Ishur.io, label Task, assigned to Richard. The same
   condition does not open a second issue for a week (lintask:<key>). When the
   condition resolves (slackResolve), the issue is closed with a note.
   Runs in the Worker, with the Worker's own LINEAR_API_KEY: no chat, no person.
   Never throws and never holds a Slack post back.
   ========================================================================== */
export const LINEAR_TASK = { team: '7d28da64-7486-4eeb-8d29-db3e9ed1a76e', project: '8aed9c67-63a4-44c9-9658-8ee54b2a3c20', assignee: 'fcc3d711-4830-484b-adb4-fc485f61ee50', label: 'Task' };
export const TASK_QUIET_S = 7 * 86400;
const MARK = key => 'lintask:' + key;

/* "נדרשת פעולה ממך" that is not "לא נדרשת פעולה ממך" */
export function needsAction(text) {
  return /(^|[^א-ת])נדרשת פעולה ממך/.test(String(text || '').replace(/לא נדרשת פעולה ממך/g, ''));
}
export function taskKey(text, opts = {}) {
  const head = String(text || '').split('\n')[0].replace(/[*_>`]/g, '').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  return String(opts.key ? String(opts.key) : head).replace(/[^\wא-ת#:.-]+/g, '_').slice(0, 120);
}
async function gql(env, query, variables, fetchFn) {
  const r = await fetchFn('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: env.LINEAR_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.errors) throw new Error('linear: ' + JSON.stringify((j && j.errors) || r.status).slice(0, 200));
  return j.data;
}
async function cached(env, key, ttl, make) {
  let v = await env.RATE.get(key).catch(() => null);
  if (!v) { v = await make(); if (v) await env.RATE.put(key, v, { expirationTtl: ttl }).catch(() => {}); }
  return v || '';
}

/* → { ok, created?, identifier?, why? } */
export async function actionTask(env, text, opts = {}, { fetchFn = fetch } = {}) {
  try {
    if (!env || !env.LINEAR_API_KEY || !env.RATE) return { ok: false, why: 'not-configured' };
    if (!needsAction(text)) return { ok: true, created: false, why: 'no-action' };
    const key = taskKey(text, opts);
    if (await env.RATE.get(MARK(key)).catch(() => null)) return { ok: true, created: false, why: 'open' };
    /* the marker goes in first: two alerts in the same second open one issue, not two */
    await env.RATE.put(MARK(key), JSON.stringify({ at: Date.now() }), { expirationTtl: TASK_QUIET_S });
    const labelId = await cached(env, 'linear:task-label', 90 * 86400, async () => {
      const d = await gql(env, `query($n:String!){ issueLabels(filter:{ name:{ eq:$n } }){ nodes{ id } } }`, { n: LINEAR_TASK.label }, fetchFn);
      return ((d.issueLabels.nodes || [])[0] || {}).id || '';
    });
    const clean = String(text || '').replace(/[*_>`]/g, '');
    const title = (clean.split('\n').map(s => s.trim()).filter(Boolean)[0] || 'נדרשת פעולה').replace(/^[^\wא-ת]+/, '').slice(0, 160);
    const input = { teamId: LINEAR_TASK.team, projectId: LINEAR_TASK.project, assigneeId: LINEAR_TASK.assignee, title, priority: 2,
      description: clean.slice(0, 3000) + '\n\n---\nנפתח אוטומטית מהתראה של המערכת (' + key + '). כשהבעיה נפתרת המשימה נסגרת לבד.' };
    if (labelId) input.labelIds = [labelId];
    const d = await gql(env, `mutation($i:IssueCreateInput!){ issueCreate(input:$i){ issue{ id identifier url } } }`, { i: input }, fetchFn);
    const issue = d.issueCreate.issue;
    await env.RATE.put(MARK(key), JSON.stringify({ at: Date.now(), id: issue.id, identifier: issue.identifier }), { expirationTtl: TASK_QUIET_S }).catch(() => {});
    return { ok: true, created: true, identifier: issue.identifier, url: issue.url };
  } catch (e) {
    /* a failed create must not leave the condition silenced for a week */
    try { await env.RATE.delete(MARK(taskKey(text, opts))); } catch {}
    return { ok: false, why: String(e && e.message).slice(0, 200) };
  }
}

/* the condition behind `key` is over → the task it opened is closed */
export async function resolveTask(env, key, note, { fetchFn = fetch } = {}) {
  try {
    if (!env || !env.LINEAR_API_KEY || !env.RATE || !key) return { ok: false, why: 'not-configured' };
    const k = taskKey('', { key });
    let rec = null; try { rec = JSON.parse(await env.RATE.get(MARK(k))); } catch {}
    if (!rec || !rec.id) return { ok: true, closed: false };
    const doneId = await cached(env, 'linear:done-state', 30 * 86400, async () => {
      const d = await gql(env, `query($t:String!){ team(id:$t){ states{ nodes{ id type } } } }`, { t: LINEAR_TASK.team }, fetchFn);
      return ((d.team.states.nodes || []).find(x => x.type === 'completed') || {}).id || '';
    });
    await gql(env, `mutation($c:CommentCreateInput!){ commentCreate(input:$c){ success } }`, { c: { issueId: rec.id, body: 'נפתר לבד: ' + String(note || 'המערכת זיהתה שהבעיה הסתיימה.').slice(0, 300) } }, fetchFn).catch(() => {});
    if (doneId) await gql(env, `mutation($id:String!,$i:IssueUpdateInput!){ issueUpdate(id:$id,input:$i){ success } }`, { id: rec.id, i: { stateId: doneId } }, fetchFn);
    await env.RATE.delete(MARK(k)).catch(() => {});
    return { ok: true, closed: !!doneId, identifier: rec.identifier };
  } catch (e) { return { ok: false, why: String(e && e.message).slice(0, 200) }; }
}
