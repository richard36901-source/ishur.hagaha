#!/usr/bin/env node
/* ============================================================================
   build-info.mjs — writes worker/build-info.json before every deploy
   ----------------------------------------------------------------------------
   Run by wrangler's [build] command (wrangler.toml), by `npm run predeploy`
   and by deploy.sh. The Worker bundles the JSON; the doctor writes it into the
   change log as `deploy:<version>` (changes.js recordDeploy).

     { version_tag, commit, branch, date, by, commits: [{hash, subject}] }

   commits = the commits since the previously deployed commit:
     1. $DEPLOY_SINCE (a sha), else
     2. git ref refs/ishur/deployed (deploy.sh moves it after a good deploy), else
     3. the last 20 commits.
   The Worker also cuts the list at the commit it stored for the previous
   version (KV build:info), so a stale ref only makes the list longer, never wrong.
   Never fails the build: without git it writes {commit:"nogit"}.
   ========================================================================== */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => { try { return execFileSync('git', a, { cwd: W, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
export function parseLog(out) {
  return String(out || '').split('\n').filter(Boolean).map(l => { const i = l.indexOf('\t'); return { hash: l.slice(0, i), subject: l.slice(i + 1).slice(0, 140) }; });
}
export function buildInfo(env = process.env) {
  const commit = git('rev-parse', '--short=12', 'HEAD') || 'nogit';
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  const dirty = !!git('status', '--porcelain', '--untracked-files=no');
  let since = env.DEPLOY_SINCE || git('rev-parse', '--verify', '--quiet', 'refs/ishur/deployed');
  if (since && !git('rev-parse', '--verify', '--quiet', since + '^{commit}')) since = '';
  const range = since ? [`${since}..HEAD`] : ['-n', '20', 'HEAD'];
  const commits = commit === 'nogit' ? [] : parseLog(git('log', '--format=%h\t%s', '--no-merges', '-n', '200', ...range));
  const date = new Date().toISOString();
  return { version_tag: `${date.slice(0, 10).replace(/-/g, '')}-${commit.slice(0, 7)}${dirty ? '-dirty' : ''}`, commit, branch, date, by: env.DEPLOY_BY || git('config', 'user.name') || '', since: since || null, dirty, commits };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = buildInfo();
  writeFileSync(resolve(W, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log(`build-info.json · ${info.version_tag} · ${info.branch} · ${info.commits.length} commits since ${info.since || '(last 20)'}`);
}
