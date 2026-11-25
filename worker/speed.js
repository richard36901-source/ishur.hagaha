/* ============================================================================
   ishur.io · speed.js · 26/11/2026 track-speed (Richard: "our dashboards load a
   few seconds, sometimes a full minute — make it much faster")
   ----------------------------------------------------------------------------
   §1 clientFlags   /api/client-flags for the clients page: the same reads per
                    event as before (9 keys + the client-stop record), but up to
                    CONC events at a time instead of one after another. With
                    ~200 events that was ~400 KV round trips in a row (several
                    seconds); now ~16. Same answer, same key order, same reads.
   ========================================================================== */
export const CONC = 24;

/* deps: { clientStopOf(env, t), publicStop(cs) } → { [token]: flags } in the order of `toks` */
export async function clientFlags(env, toks, deps, conc = CONC) {
  const one = async t => {
    const [inactive, addon, extra, calls, wave, vid, hold, holdtill, wpos] = await Promise.all(['inactive:' + t, 'addon:' + t, 'extrasend:' + t, 'callsaddon:' + t, 'wave:' + t + ':1', 'vidok:' + t, 'hold:' + t, 'holdtill:' + t, 'wpos:' + t + ':1'].map(k => env.RATE.get(k).catch(() => null)));
    /* 08/11 (Richard): a hold is a pause, not a cancellation — holdtill = the day it lifts; wpos = wave 1 under way */
    const f = { active: !inactive, addon: addon ? (JSON.parse(addon).n || 0) : 0, extrasend: !!extra, calls: !!calls, sent: !!wave, sending: !wave && (parseInt(wpos, 10) || 0) > 0, video: !!vid, hold: !!hold, hold_till: holdtill || '' };
    /* 25/11 track-board: the client pressed the stop button — the team sees it and lifts it from here */
    const cs = await deps.clientStopOf(env, t); if (cs) f.client_stop = deps.publicStop(cs);
    return f;
  };
  const res = new Array(toks.length); let next = 0;
  const lane = async () => { while (next < toks.length) { const i = next++; res[i] = await one(toks[i]); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(conc, toks.length)) }, lane));
  const out = {}; toks.forEach((t, i) => { out[t] = res[i]; });
  return out;
}
