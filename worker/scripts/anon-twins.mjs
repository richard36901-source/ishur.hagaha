// node worker/scripts/anon-twins.mjs — writes the no-name copies (<name>_anon) of every guest template we have a record of
// into worker/templates/anon/ (NOT submitted: a record to submit through POST /api/meta-admin later) and prints the table
// rows for docs/GUEST-NAME-OPTION.md. Pure: reads the repo only, never Meta.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { anonPayload, nameFamily } from '../guest-name.js';
import { STYLES, OWN_TEMPLATE, templatePayload, tmplName } from '../invite-styles.js';

const dir = new URL('../templates/', import.meta.url), out = new URL('../templates/anon/', import.meta.url);
mkdirSync(out, { recursive: true });
const rows = [];
const first = t => String(t || '').split('\n')[0];
const write = (p, note) => {
  const a = anonPayload(p); if (!a) return null;
  writeFileSync(new URL(a.name + '.json', out), JSON.stringify({ _note: note, channel: 'guests', method: 'POST', path: '/1378764257421712/message_templates', payload: a }, null, 2) + '\n');
  return a;
};
for (const f of readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
  const p = JSON.parse(readFileSync(new URL(f, dir), 'utf8')).payload;
  if (!p || nameFamily(p.name) !== 'first') continue;
  const a = write(p, `26/11 guest-name: the no-name copy of ${p.name} (greeting without {{1}}, variables renumbered). NOT submitted. Used only once Meta approves it and /api/guest-name-twins {action:'check'} sets tmplanon:${p.name}.`);
  rows.push([p.name, p.category, first((p.components.find(c => c.type === 'BODY') || {}).text), a.name, first((a.components.find(c => c.type === 'BODY') || {}).text)]);
}
for (const s of Object.keys(STYLES).filter(OWN_TEMPLATE)) {
  const p = templatePayload(s, 'text', '');
  const a = write(p, `26/11 guest-name: the no-name copy of ${p.name}. NOT submitted. The _img / _vid forms need the same body with an IMAGE / VIDEO header sample (invite-styles.js submitAll pattern).`);
  rows.push([p.name + ' (+ _img, _vid)', p.category, first(STYLES[s].body), a.name + ' (+ ' + tmplName(s, 'img') + '_anon, ' + tmplName(s, 'vid') + '_anon)', first(a.components.find(c => c.type === 'BODY').text)]);
}
for (const r of rows) console.log('| ' + r.map(x => String(x).replace(/\|/g, '\\|')).join(' | ') + ' |');
