// node scripts/security-xss-check.mjs — 12/11 security audit: the sinks that rendered guest / client / lead text
// as markup stay escaped. Static check: each pattern below is a raw interpolation that was exploitable.
import fs from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(root + f, 'utf8');
const BAD = {
  'admin.html': [/'<td>' \+ u\[0\] \+/, /String\(f\.note\)\.slice\(0, 80\) \+/, /'<td>' \+ \(f\.name \|\|/, /'<td>' \+ \(f\.client \|\|/, /'<td>' \+ \(e\.name \|\| e\.client/, /'<td>' \+ \(e\.plan \|\|/, /data-token="' \+ e\.token \+/],
  'next/admin.html': [/'<td>' \+ u\[0\] \+/, /String\(f\.note\)\.slice\(0, 80\) \+/, /'<td>' \+ \(f\.name \|\|/, /'<td>' \+ \(f\.client \|\|/, /'<td>' \+ \(e\.name \|\| e\.client/, /'<td>' \+ \(e\.plan \|\|/, /data-token="' \+ e\.token \+/],
  'admin.new.html': [/'<td>' \+ u\[0\] \+/, /'<td>' \+ \(e\.name \|\| e\.client/, /'<td>' \+ \(e\.plan \|\|/],
  'calls.html': [/' \+ g\.name \+ '/, /\+ g\.event_name [:+]/, /\+ g\.last_answer \+/, /\+ g\.venue_city [:+]/, /<b>' \+ where \+/, /href="tel:\+' \+ g\.phone/],
  'dashboard.html': [/'>' \+ \(g\.name \|\| '<span/, /<span class="row-p">' \+ \(g\.phone/, /src="' \+ m\.(video|image)_url \+/],
  'seating.html': [/' \+ g\.name \+ '/, /' \+ t\.name \+ '/, /' \+ g\.table \+ '/, /">' \+ n \+ '/, /g\.name\.replace\(\/<\/g/],
};
const MUST = {
  'calls.html': [/function esc\(v\)/], 'seating.html': [/function esc\(v\)/],
  'worker/index.js': [/const name = String\(b\.name \|\| ''\)\.replace\(\/\[<>\]\/g, ''\)/, /utm_content\]\.map\(x => String\(x \|\| ''\)\.replace\(\/\[<>"\]\/g, ''\)/],
};
let fail = 0, n = 0;
for (const [f, res] of Object.entries(BAD)) { const s = read(f); for (const re of res) { n++; if (re.test(s)) { fail++; console.log('✗ raw interpolation still present  ' + f + '  ' + re); } } }
for (const [f, res] of Object.entries(MUST)) { const s = read(f); for (const re of res) { n++; if (!re.test(s)) { fail++; console.log('✗ expected guard missing  ' + f + '  ' + re); } } }
console.log(`${n - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
