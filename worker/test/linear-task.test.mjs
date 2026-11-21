// 22/11/2026 · an alert that needs Richard opens ONE task in his Linear; a resolved condition closes it
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionTask, resolveTask, needsAction, taskKey, LINEAR_TASK } from '../linear-task.js';

const kv = () => { const m = new Map(); return { m, get: async k => (m.has(k) ? m.get(k) : null), put: async (k, v) => { m.set(k, String(v)); }, delete: async k => { m.delete(k); } }; };
const linear = (fail = false) => {
  const calls = [];
  const fetchFn = async (url, init) => {
    const b = JSON.parse(init.body); calls.push(b);
    if (fail) return { ok: false, status: 500, json: async () => null };
    let data = {};
    if (/issueLabels/.test(b.query)) data = { issueLabels: { nodes: [{ id: 'label-task' }] } };
    else if (/issueCreate/.test(b.query)) data = { issueCreate: { issue: { id: 'iss-1', identifier: 'AUT-9001', url: 'https://linear.app/x/AUT-9001' } } };
    else if (/states/.test(b.query)) data = { team: { states: { nodes: [{ id: 's-todo', type: 'unstarted' }, { id: 's-done', type: 'completed' }] } } };
    else if (/commentCreate/.test(b.query)) data = { commentCreate: { success: true } };
    else if (/issueUpdate/.test(b.query)) data = { issueUpdate: { success: true } };
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  return { calls, fetchFn };
};
const ALERT = '⚠️ *בדיקת יתרות וחיוב*\n\nיתרת Retell: 3$\n\n───\n🔴 *נדרשת פעולה ממך:* לטעון יתרה.';

test('needsAction: only a real "action needed", never "no action needed"', () => {
  assert.equal(needsAction(ALERT), true);
  assert.equal(needsAction('✅ *לא נדרשת פעולה ממך.* המערכת תנסה שוב לבד.'), false);
  assert.equal(needsAction('💰 תשלום התקבל · 990 ₪'), false);
  assert.equal(needsAction(''), false);
});

test('an alert that needs him opens one task: his project, label Task, assigned to him; the same condition does not open a second', async () => {
  const env = { LINEAR_API_KEY: 'k', RATE: kv() }; const L = linear();
  const a = await actionTask(env, ALERT, { key: 'billing:retell' }, L);
  assert.equal(a.created, true); assert.equal(a.identifier, 'AUT-9001');
  const create = L.calls.find(c => /issueCreate/.test(c.query)).variables.i;
  assert.equal(create.teamId, LINEAR_TASK.team); assert.equal(create.projectId, LINEAR_TASK.project); assert.equal(create.assigneeId, LINEAR_TASK.assignee);
  assert.deepEqual(create.labelIds, ['label-task']); assert.equal(create.title, 'בדיקת יתרות וחיוב'); assert.match(create.description, /לטעון יתרה/);
  const n = L.calls.length;
  const b = await actionTask(env, ALERT.replace('3$', '1$'), { key: 'billing:retell' }, L);
  assert.equal(b.created, false); assert.equal(b.why, 'open'); assert.equal(L.calls.length, n, 'no second call to Linear');
  /* without a key the title line is the condition, digits ignored */
  assert.equal(taskKey('⚠️ *27 נכשלו*'), taskKey('⚠️ *31 נכשלו*'));
});

test('no task for an update, without a key in the Worker, or when Linear fails (and a failure does not silence the condition)', async () => {
  const L = linear();
  assert.equal((await actionTask({ LINEAR_API_KEY: 'k', RATE: kv() }, '🆕 ליד חדש · דנה', {}, L)).created, false);
  assert.equal((await actionTask({ RATE: kv() }, ALERT, {}, L)).ok, false);
  assert.equal(L.calls.length, 0);
  const env = { LINEAR_API_KEY: 'k', RATE: kv() }; const F = linear(true);
  const r = await actionTask(env, ALERT, { key: 'billing:retell' }, F);
  assert.equal(r.ok, false); assert.equal(env.RATE.m.size, 0, 'nothing left behind, the next alert tries again');
  const ok = await actionTask(env, ALERT, { key: 'billing:retell' }, linear());
  assert.equal(ok.created, true);
});

test('a resolved condition closes its task with a note; nothing happens when there was none', async () => {
  const env = { LINEAR_API_KEY: 'k', RATE: kv() }; const L = linear();
  assert.deepEqual(await resolveTask(env, 'billing:retell', 'היתרה נטענה', L), { ok: true, closed: false });
  await actionTask(env, ALERT, { key: 'billing:retell' }, L);
  const r = await resolveTask(env, 'billing:retell', 'היתרה נטענה', L);
  assert.equal(r.closed, true); assert.equal(r.identifier, 'AUT-9001');
  const upd = L.calls.find(c => /issueUpdate/.test(c.query)).variables;
  assert.equal(upd.id, 'iss-1'); assert.equal(upd.i.stateId, 's-done');
  assert.match(L.calls.find(c => /commentCreate/.test(c.query)).variables.c.body, /היתרה נטענה/);
  assert.equal((await actionTask(env, ALERT, { key: 'billing:retell' }, L)).created, true, 'the same problem coming back later opens a new task');
});
