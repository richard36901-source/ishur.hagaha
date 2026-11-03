# Ops center design + consolidation pass (03/11/2026)

Branch `ops-design` (from `integ-2026-11-02` 6eb0115, merged forward with p5-notify + raffle). Not deployed.
Sources: plan §8, §9 + §11 UI notes, design system artifact (tokens.json v1, bundle.css), skills apple-design, taste-skill, design-systems, clean-design.

## Nav map (§11)

| Section | Hash | Tabs (`?tab=`) | Former routes (still work) | Shortcuts |
|---|---|---|---|---|
| סקירה | `#/overview` | — (overview2 + bell) | overview | g o |
| לידים | `#/leads` | — (board / table segmented) | leads, `leads/<id>` | g e |
| לקוחות | `#/clients` | clients · hostesses · feedback | clients, hostesses, feedback, `clients/<token or tok8>` | g s · g t · g v |
| הודעות | `#/messages` | **inbox** (default) · sends · capacity · templates | inbox, messaging, capacity, templates, `inbox/<phone>` | g i · g m · g k · g n |
| שיחות | `#/calls` | own tabs: timeline · rounds · manual · shir · costs (`?tab=` or `/calls/<tab>`) | calls | g c |
| לוח שנה | `#/calendar` | calendar · capacity (rolled plan) | calendar | g d |
| כספים | `#/finance` | finance (P&L) · ads · balances | finance, ads, balances | g f · g p · g y |
| מערכת (bottom) | `#/system` | automations · runs · live · brain · changes · control · notify | all of them, `automations/<id>`, `runs/<id>`, `changes/<id>` | g a · g r · g l · g b · g h · g x · g q |

Old hashes are parsed as aliases (`parseHash` in app.js: an old screen id resolves to its home `[section, tab]`); shortcuts and ⌘K go to the canonical form (`#/<section>` for the first tab, `#/<section>?tab=<tab>` otherwise). Phone bar: סקירה / לידים / לקוחות / הודעות / עוד; the "עוד" sheet lists every section and every former screen as an indented sub-link. Nav badges are per screen and summed onto their section; tab badges show on the page tabs.

## Tokens (ops.css `:root`, light / dark)

- Color: green #0F4C35/#4CAF82, green-deep #0A3826/#7BC9A4, green-mid #2F6E52 (chart series), green-wash #F3F8F5/#132B20, gold #A8853C/#C7AE7A, gold-ink, cream #FBF8F1/#241F12, pine/pine-lift/pine-deep (sidebar stage), ink/ink-2/ink-3, surface, bg-2 (page), bg-3, border, border-muted, error/error-bg, warn/warn-bg, whatsapp, focus-ring, scrim, shadow-pop. Dark = "warm dark greens", every token redefined under `prefers-color-scheme` and `[data-theme=dark]`.
- Type: Heebo body (15px app base, tables 14px), Rubik for every number (tabular), Frank Ruhl Libre for page titles, modal titles, calendar month and change-log days only.
- Space 4/8/12/16/24/32/48 · radius xs 6 / sm 8 / md 10 / lg 12 / xl 16 / pill only `.is-sec-tag` · control 44px (sm 36 on desktop, 44 on phones) · row 48px.
- Legacy names (`--brand`, `--line`, `--crit`, `--s1`, `--r`…) are aliases onto the tokens, so crm.css, p4a.css and inline module CSS inherit the palette.

## What changed

- **Shell**: pine radial sidebar with paper text and a gold active marker; 64px translucent top bar with the display title; cards are border-only (no shadows inside the app); one highlighted cream/gold tile per tile row.
- **Shared Tabs** (`ui.js Tabs`, items with `href` → deep-link page tabs; without → segmented filter).
- **Tables**: sticky header, zebra, 48px rows, every labelled column sorts asc/desc with an arrow; the choice is saved per table id (`ops:sort:<id>`) and re-applied on every render (string `Table`, `mountVirtual` re-sorts data, hand-built tables via `data-sort-dom`). Clicks are handled lazily by `lazy/kit2.js`.
- **People and events**: `Phone()` cell = number (opens the person drawer: lead / client / guest with links) + WhatsApp + call icons; `EventLink()` opens the client card (tok8 resolves to the full token). Used in leads, clients, messages, live log, capacity meters, person drawer.
- **Lead details**: centered modal on desktop, full screen on phones. Leads table default columns: name, phone, status chip, occasion+date, records, source, last activity, next action.
- **Client card** (modal): editable names / phone (normalized IL) / occasion (Select) / date (DatePicker) with save + toast; copy buttons on links; all actions grouped (sends, add-ons, account, danger zone reset) behind typed confirm.
- **DatePicker** replaces every native date input (lead quick-close date, next action date+time, change-log range): Hebrew months, RTL, week starts Sunday, today / clear, arrows / PageUp/Down / Enter / Esc, bottom sheet on phones, writes ISO to a hidden input.
- **Capacity meters** (overview + הודעות › קיבולת + לוח שנה › תוכנית קיבולת): row per day, track = cap, fill = out, `X/230`, red hatched overflow with `+N נדחה`, closed days muted, row expands to the events (linked).
- **Live log**: insert-only on poll (200ms `row-in`, off under reduced motion), scroll kept, capped; "דפדפן ·" admin rows hidden behind "הצג פעילות אדמין" (saved); rows show kind chip, area, phone, event link, template/cost when present, status, 1-line preview.
- **Calendar**: soft green today with a filled day number, gold dot event titles, chips with icon + count + state colours, quiet meter, muted Shabbat/closed days.
- **Ads (כספים › פרסום)**: comparison table, 12 sortable columns (spend, impressions, clicks, leads, CPL, leads ← quoted ← closed, close rate, cost per closed client, avg deal, avg gross profit per client, ROAS), ad sets expand, totals footer. Worker `adsTree` now computes quoted / close rate / cost per closed / avg deal / avg gross (deal − WhatsApp + call + hostess cost of that client) per campaign and ad set (tests added).
- **Fixed costs**: recurring until removed. KV `fixedcosts` = `{id, name, ils, usd, from_month, to_month, approx, unknown}`; `/api/fixedcost {action: list|add|update|remove|telnyx}` (legacy `{month, items}` still works and still counts for its month). Prefilled: SIM 4499 ₪19.80, SIM 6673 ₪10, SIM 3089799 ₪10, Cloudflare Workers $5, Retell / Make / Monday / Anthropic as "לא ידוע"; "מספרי Telnyx" reads `GET /v2/phone_numbers` (monthly cost if present, else $1/number marked ≈). Edits go to the change log.
- **Notify / overview2 / bell** restyled to the tokens (squared chips, radii).
- CSS split: calendar rules → `cal.css` (loaded by lazy/calendar.js), CRM rules → `crm.css`; ops.css stays under its 40 KB budget.

## Budgets

- Counted JS 113.1 → 128.9 KB; budget raised 120 → **130 KB** (router + tabs, sortable Table, Phone/EventLink/DatePicker renderers, meters, live feed). Behaviour not needed at first paint is in `lazy/kit2.js`.
- CRM lazy total 108.1 KB; budget raised 100 → **110 KB** (client card edit + actions).
- ops.css 39.0 KB (< 40 KB).

## Not done / needs a backend

- Client card edits save through `POST /api/crm/clients/:token` (`crm.clientUpdate`), which the Worker does not have yet; `/api/event` event_setup overwrites the whole settings row and `/api/event-change` only does cancel/restore/postpone, so neither is safe for a partial edit. In mock the edit works; live shows the server's refusal in the toast.
- Client actions other than the existing hold / extra send / add hostess call `clientAction`, still "not yet" in crm/adapt.js.
- Live log rows can only show template / cost / per-message grouping where the audit rows carry them (today's `/api/ops/live` items are audit rows).

Screenshots: `docs/ops-screens/design/<screen>-{light,dark,mobile}.png` (26 screens, `node scripts/ops-design-shots.mjs`).
