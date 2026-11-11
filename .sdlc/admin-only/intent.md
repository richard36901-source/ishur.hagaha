# admin-only · intent (11/11/26, Richard)

**Problem:** two control centers (admin family + ops.html). Richard: "רק אדמין! רק שם עובדים! תמחק את הקודמים לגמרי — לא ops ולא החדש (לייב)". Everything loads slowly (admin: 131 requests / 13 s; /api/ops/realtime 3.7–5.5 s per call, 5× on load).

**Outcome:** one admin family (admin.html style), every day-to-day action (client requests, date moves, cancel, paid, addons, call rounds, pause, finance) doable from the screens without Claude. ops.html, assets/ops, ops-manual, admin.new, center, hq deleted; worker links point to admin. Home paints < 1.5 s with ≤ 4 requests.

**Affected:** ishur-deploy site pages + assets, worker/ (ops.js, crm.js, index.js links, notify.js, slack-gate.js), ops-ui-smoke.

**Constraints:** keep admin look; ops-only capabilities (see plan.html §1/§2) move before deletion; no removal of API routes still used by client dashboard.

**Open questions (plan.html §6):** leads single backend (CRM into leads.html?); counter line on home instead of לייב; drop changes/revert; finance inside admin.

Artifact: https://claude.ai/artifact/ECvmTbWFKuK5umRg8F6LQw
