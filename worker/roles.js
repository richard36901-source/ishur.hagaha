/* ============================================================================
   ishur.io · roles.js · who on the team does what (25/11/2026)
   ----------------------------------------------------------------------------
   The person behind an admin request is the Google user (auth.js: user:<email>,
   passed downstream as the x-ishur-user header). Hostesses live in staff:<phone>
   and are a different list; they never sign in to the back office.

   Roles (a set per person): dev, admin, sales, client_comms, staff.
     Richard = dev + admin · Shalev = sales + admin + client_comms (DEFAULT_ROLES).

   KV  staffrole:<email> = {roles:[...], by, at}   an explicit set; overrides the defaults.
   With no stored set: DEFAULT_ROLES, else from the user record as it is today
   (owner → dev+admin, pages 'all' → admin, else staff + the pages they hold now),
   so nobody loses a page they can open today.

   Page permission: the ids of auth.js PAGES. admin opens everything.
   PAGE_OF maps every back-office link (file + view/hash) to one page id; a link
   not in the map is open to everyone signed in (login, account, unknown pages).
   ========================================================================== */
import { PAGES, normEmail, getUser, listUsers, SEED_USERS } from './auth.js';

export const ROLES = ['dev', 'admin', 'sales', 'client_comms', 'staff'];
export const ROLE_HE = { dev: 'פיתוח', admin: 'ניהול', sales: 'מכירות', client_comms: 'תקשורת לקוחות', staff: 'צוות' };
export const DEFAULT_ROLES = {
  'richardtomskiy@gmail.com': ['dev', 'admin'],
  'shalevdrix3@gmail.com': ['sales', 'admin', 'client_comms'],
};
const PAGE_IDS = PAGES.map(p => p.id);
/* which page ids each role opens; 'all' = every page */
export const ROLE_PAGES = {
  admin: 'all',
  dev: ['data', 'sends', 'journal', 'control', 'system', 'clients'],
  sales: ['sales', 'clients', 'data'],
  client_comms: ['clients', 'sends', 'journal'],
  staff: ['journal'],
};
/* every back-office link → its page id (both menus: next/assets/adminbar.js and assets/adminbar.js) */
export const PAGE_OF = {
  'admin.html': 'data', 'admin.html?view=camp': 'data', 'ad-report.html': 'data',
  'admin.html?view=money': 'money', 'report.html': 'money', 'budget.html': 'money',
  'leads.html': 'sales', 'leads.html#script': 'sales', 'leads.html#paylink': 'sales', 'clients.html#referrals': 'sales', 'team.html': 'sales', 'outreach.html': 'sales', 'leads-new.html': 'sales',
  'clients.html': 'clients', 'clients.html#designs': 'clients', 'admin.html?view=feedback': 'clients',
  'admin.html?view=week': 'sends', 'inbox.html': 'sends', 'admin.html?view=calls': 'sends', 'floor.html': 'sends', 'answers.html': 'sends', 'calls.html': 'sends',
  'calendar.html': 'journal',
  'admin.html?view=ctl': 'control', 'brain.html': 'control', 'ops.html': 'control',
  'automations.html': 'system', 'live.html': 'system', 'users.html': 'system', 'templates.html': 'system', 'ops-manual.html': 'system',
};

export const cleanRoles = v => [...new Set((Array.isArray(v) ? v : []).map(String).filter(r => ROLES.includes(r)))];
const kvJson = async (env, k) => { try { return JSON.parse(await env.RATE.get(k)) || null; } catch { return null; } };

/* the roles a user record implies when nothing is stored (today's access, nothing taken away) */
export function fallbackRoles(user) {
  const e = normEmail(user && user.email);
  if (e && DEFAULT_ROLES[e]) return [...DEFAULT_ROLES[e]];
  if (!user || user.active === false) return [];
  if (user.role === 'owner') return ['dev', 'admin'];
  if (user.pages === 'all') return ['admin'];
  return ['staff'];
}
/* who = an email or a user record → the role set ([] for nobody) */
export async function rolesOf(env, who) {
  const email = normEmail(typeof who === 'string' ? who : who && who.email);
  if (!email) return [];
  const stored = env && env.RATE ? await kvJson(env, 'staffrole:' + email) : null;
  if (stored && Array.isArray(stored.roles)) return cleanRoles(stored.roles);
  if (DEFAULT_ROLES[email]) return [...DEFAULT_ROLES[email]];
  const user = typeof who === 'object' && who ? who : (env && env.RATE ? await getUser(env, email) : null);
  return fallbackRoles(user);
}
/* the page ids a person opens: the union of their roles, plus page grants they hold on the user record today */
export function pagesFor(roles, user = null) {
  const rs = cleanRoles(roles);
  if (rs.some(r => ROLE_PAGES[r] === 'all') || (user && (user.role === 'owner' || user.pages === 'all'))) return [...PAGE_IDS];
  const set = new Set();
  for (const r of rs) for (const p of ROLE_PAGES[r] || []) set.add(p);
  if (user && Array.isArray(user.pages)) for (const p of user.pages) if (PAGE_IDS.includes(p)) set.add(p);
  return PAGE_IDS.filter(p => set.has(p));
}
/* href (as the menu writes it, any folder prefix) → may this person open it? Unknown links stay open. */
export function pageIdOf(href) {
  const h = String(href || '').replace(/^https?:\/\/[^/]+/, '').replace(/^.*\//, '');
  if (PAGE_OF[h] !== undefined) return PAGE_OF[h];
  const base = h.split(/[?#]/)[0];
  const view = (h.match(/[?&]view=([a-z]+)/) || [])[1];
  if (view && PAGE_OF[base + '?view=' + view] !== undefined) return PAGE_OF[base + '?view=' + view];
  return PAGE_OF[base] !== undefined ? PAGE_OF[base] : null;
}
export function canOpen(roles, href, user = null) {
  const id = pageIdOf(href);
  return id === null || pagesFor(roles, user).includes(id);
}
export const isLead = roles => cleanRoles(roles).some(r => r === 'admin' || r === 'dev');

/* the team: every active Google user, with roles (the assignee list) */
export async function teamList(env) {
  let users = env && env.RATE ? await listUsers(env).catch(() => []) : [];
  if (!users.length) users = SEED_USERS.map(u => ({ ...u, active: true }));
  const out = [];
  for (const u of users) { if (u.active === false) continue; out.push({ email: u.email, name: u.name || u.email.split('@')[0], roles: await rolesOf(env, u) }); }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'he'));
}
/* set a person's roles: only an admin; an admin cannot take admin away from themselves (no self lock-out) */
export function planRoles(actorEmail, actorRoles, targetEmail, roles) {
  if (!cleanRoles(actorRoles).includes('admin')) return { ok: false, error: 'admin-only' };
  const email = normEmail(targetEmail);
  if (!email) return { ok: false, error: 'bad-email' };
  const next = cleanRoles(roles);
  if (!next.length) return { ok: false, error: 'no-roles' };
  if (email === normEmail(actorEmail) && !next.includes('admin')) return { ok: false, error: 'keep-own-admin' };
  return { ok: true, email, roles: next };
}
export async function setRoles(env, by, email, roles) {
  await env.RATE.put('staffrole:' + email, JSON.stringify({ roles, by: normEmail(by), at: new Date().toISOString() }));
}
