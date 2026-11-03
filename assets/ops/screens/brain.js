/* Brain: findings, the self-healing agent's reasoning as a live typewriter stream, playbook status.
   Anything that would message a client/guest waits for Richard's tap (needs_approval). */
import { esc, fmtN, relTime, Table, Badge, Skeleton, Button, toast, busy, timeTag } from '../ui.js';

export const findingsView = (list) => Table({
  rows: list, rowKey: (f) => f.id, empty: 'אין ממצאים פתוחים',
  columns: [
    { label: 'מתי', render: (f) => timeTag(f.at) },
    { label: 'ממצא', render: (f) => `<b>${esc(f.title)}</b><br><span class="sub mono" dir="ltr">${esc(f.check_id)}</span>` },
    { label: 'חומרה', render: (f) => Badge(f.severity) },
    { label: 'מצב', render: (f) => Badge(f.status) },
    { label: 'פלייבוק', num: true, render: (f) => '#' + esc(f.playbook) },
    { label: '', render: (f) => (f.status === 'needs_approval' ? Button('לאשר', { variant: 'primary', size: 'sm', act: 'approve', attr: { 'data-id': f.id } }) + ' ' + Button('לדחות', { size: 'sm', act: 'reject', attr: { 'data-id': f.id } }) : '') },
  ],
});
export const playbooksView = (list) => `<ul class="tl" style="margin:0">${list.map((p) => `<li style="grid-template-columns:28px 14px 1fr"><span class="num muted" style="text-align:end">${esc(p.id)}</span><span class="ax" style="box-shadow:inset 0 0 0 2px var(--${p.status === 'active' ? 'good' : 'warn'})"></span><span><b>${esc(p.name)}</b> ${p.status === 'approval' ? Badge('needs_approval', 'דורש אישור') : ''}<br><span class="sub">${fmtN(p.runs_7d)} ריצות ב-7 ימים · אחרונה ${esc(relTime(p.last_run))}</span></span></li>`).join('')}</ul>`;
export const streamLine = (s) => `<div class="feed-row" data-id="${esc(s.id)}"><time datetime="${esc(s.at)}" class="num">צעד ${esc(s.step)}</time><span class="m" style="grid-column:2;grid-row:1">${esc(s.text)}</span></div>`;

export default {
  skeleton: () => `<div class="grid g-2">${Skeleton.card(8)}${Skeleton.card(8)}</div>${Skeleton.table(4)}`,
  async mount(el, ctx) {
    el.innerHTML = `<div class="grid g-2" style="align-items:start">
<section class="card flush"><div class="sec-h" style="padding:14px 16px 0"><span class="dot good pulse" aria-hidden="true"></span><h2 class="h2">מה המוח חושב עכשיו</h2><span class="sp"></span><span class="sub" id="br-run"></span></div><div id="br-stream" aria-live="polite" style="max-height:420px;overflow-y:auto;margin-top:10px">${Skeleton.lines(5)}</div></section>
<section class="card"><div class="sec-h"><h2 class="h2">פלייבוקים</h2><span class="sp"></span><span class="sub">קוד קבוע, בלי מודל שפה</span></div><div id="br-pb">${Skeleton.lines(8)}</div></section></div>
<section class="card flush"><div class="sec-h" style="padding:14px 16px 4px"><h2 class="h2">ממצאים</h2><span class="sp"></span><span class="sub">פעולה מול לקוח או אורח מחכה לאישור שלך</span></div><div id="br-find">${Skeleton.lines(4)}</div></section>
<p class="sub">ניהול הפרומפטים של נועה ושיר נשאר ב-<a href="brain.html">brain.html</a>.</p>`;
    const streamEl = el.querySelector('#br-stream');
    let cursor = null, queue = [], typing = false, first = true;
    const typeNext = () => {
      if (typing || !queue.length) return;
      typing = true;
      const s = queue.shift();
      streamEl.querySelector('.sk')?.parentElement === streamEl && (streamEl.innerHTML = '');
      streamEl.querySelectorAll('.sk').forEach((x) => x.remove());
      streamEl.insertAdjacentHTML('beforeend', streamLine({ ...s, text: '' }));
      const m = streamEl.lastElementChild.querySelector('.m'); m.classList.add('typer');
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      let i = 0;
      const step = () => { i = reduce ? s.text.length : Math.min(s.text.length, i + 2); m.textContent = s.text.slice(0, i); streamEl.scrollTop = streamEl.scrollHeight; if (i < s.text.length) setTimeout(step, 18); else { m.classList.remove('typer'); typing = false; typeNext(); } };
      step();
    };
    const paint = (d) => {
      el.querySelector('#br-find').innerHTML = findingsView(d.findings || []);
      el.querySelector('#br-pb').innerHTML = playbooksView(d.playbooks || []);
      ctx.setBadge('brain', (d.findings || []).filter((f) => f.status === 'needs_approval').length);
      const lines = d.stream || [];
      if (lines.length) el.querySelector('#br-run').textContent = 'ריצה ' + lines[lines.length - 1].run_id;
      if (first) { first = false; streamEl.innerHTML = lines.slice(0, -1).map(streamLine).join(''); queue.push(...lines.slice(-1)); } else queue.push(...lines);
      typeNext();
    };
    const load = async () => { const d = await ctx.api.get('brain', cursor != null ? { since: cursor } : {}, { cache: false }); cursor = d.cursor; paint(d); };
    try { await load(); } catch (e) { streamEl.innerHTML = ctx.errorBox(e, 'retry-route'); if (e.status === 404) return; /* no backend yet: don't poll a missing route */ }
    ctx.poll(load, 3000);
    ctx.on(el, 'click', (e) => {
      const b = e.target.closest('[data-act=approve],[data-act=reject]'); if (!b) return;
      const approve = b.dataset.act === 'approve';
      busy(b, () => ctx.api.post('brain-decision', { id: b.dataset.id, decision: approve ? 'approve' : 'reject' }))
        .then(() => toast(approve ? 'אושר. המוח ממשיך.' : 'נדחה. לא יבוצע.'))
        .catch((er) => toast(er.message, 'crit'));
    });
  },
};
