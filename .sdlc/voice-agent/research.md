# ishur.io AI Call Agent — Synthesis & Recommendation

## 1. Ranked recommendation (top 2)

### #1 — Retell AI + ElevenLabs Hebrew voice + Israeli 055 mobile DID (Telnyx or DIDWW) via BYO-SIP

**Why it wins on the four axes:**

- **Hebrew quality:** Retell is the managed platform with Hebrew (he-IL) explicitly in its documented language/provider matrix (docs.retellai.com/build/language-support) — ASR via Azure, Soniox, or AssemblyAI (Soniox is the current accuracy leader on the ivrit.ai Hebrew leaderboard at 4.8% WER on eval-d1, and Soniox specifically handles Hebrew-English code-switching), TTS via ElevenLabs v3 Conversational (~280ms, Hebrew confirmed, best "not a bot" naturalness). Verified caveat: Retell is *not* the only Hebrew-official platform (ElevenLabs Agents and even GHL Voice AI list Hebrew too), but it has the best Hebrew *engine choice*.
- **Answer rates:** Verified correction to the original research: real Israeli **055 mobile DIDs are purchasable as VoIP numbers** — DIDWW sells +972-55 mobile DIDs with SIP trunking (didww.com/phone-numbers/mobile-numbers/Israel/Mobile/972-55), Telnyx sells Israeli mobile numbers with light KYC (name+email; support.telnyx.com article 5466651), and even Twilio's Israel pricing page lists mobile numbers at $15/mo. A local 05x caller ID is the single biggest answer-rate lever in Israel (police/Cyber Directorate actively tell people not to answer foreign numbers). No SIM box needed.
- **Cleanest fit to the existing call_result contract:** Retell's mid-call **custom function** is a near 1:1 mapping: define `record_rsvp_outcome` with an enum param {מגיע, לא מגיע, מתלבט}, endpoint = a new Worker route; payload arrives HMAC-signed (X-Retell-Signature) with `call.metadata` echoing your guest/event ID from `create-phone-call` — the Worker just translates and POSTs to the existing `/api/event` with `event_type=call_result`. `לא ענה` comes free from `disconnection_reason: dial_no_answer | dial_busy | voicemail_reached` on the `call_ended`/`call_analyzed` webhook, and `call_analysis.custom_analysis_data` gives a post-call LLM extraction as a backup outcome path. Your Worker keeps owning the max-3-tries logic by re-POSTing `/v2/create-phone-call` off the `/api/status` queue. Nothing in the existing contract changes.
- **Cost:** ~$0.20–0.24/min all-in with the Hebrew-quality stack (see §3). No subscription minimum; $10 free credits to pilot.

**Trade-off accepted:** Retell charges $0.095/min voice when using ElevenLabs TTS (vs $0.07 standard voices), and Israel is absent from Retell-managed telephony — BYO-SIP is mandatory, not optional. That's fine: it's exactly what forces the good caller-ID setup anyway.

### #2 — ElevenLabs Agents (v3 Conversational + Scribe) + same 055 DID via native SIP trunking

- **Why:** Highest raw voice-naturalness ceiling — Hebrew is officially in v3 Conversational (74 langs, ~280ms) and Scribe ASR lists Hebrew in its top accuracy band; official help doc confirms all v3C languages work with Agents. Native Twilio/generic SIP trunking, server tools (mid-call webhooks → same Worker-adapter pattern), and post-call webhooks with user-defined structured data-collection fields. Pricing is attractive at low volume: Creator $22/mo covers 275 min; overage $0.08/min.
- **Why #2 not #1:** locked to ElevenLabs' own STT/TTS (no Soniox/AssemblyAI escape hatch if Scribe underperforms on phone-quality Israeli Hebrew), documented residual Hebrew weaknesses (milra/mile'el stress errors, Hebrew-English code-switching — nisai.dev 2026), and the "native Israeli accent" claim is voice-selection-dependent, not a model guarantee. Webhook ergonomics are good but Retell's metadata-echo + disconnection_reason taxonomy maps more directly onto the retry loop.

**Not recommended for v1:** Vapi (Hebrew exists in its API enums since Apr 2025, but Vapi support itself said Hebrew is unsupported and it's not first-class — verified both ways), Bland (no Hebrew in the language enum, closed stack), Synthflow (Hebrew listed but engine matrix opaque), self-hosted LiveKit/Pipecat + ivrit.ai (best long-term quality/cost ceiling at ~$0.10–0.15/min, but weeks of engineering — the right *migration path* once volume justifies it, not the v1).

**In both cases run a bake-off first:** record 10–20 real "נדרשת שיחה" call snippets and test STT (Soniox vs AssemblyAI vs Scribe) and TTS voices on them. No vendor publishes Hebrew phone-audio (8kHz) WER — this is the one thing you can't get from docs.

## 2. Decisions only Richard can make

1. **Agent gender + persona.** Female (he-IL female voice speaking as רוצָה/מתקשרת) vs male; and whether the agent uses a human-style name. Gender agreement is the #1 bot-tell in Hebrew — the persona must be locked in the system prompt with example conjugations.
2. **Bot disclosure wording.** Compliance says disclose it's an automated call (see §4). How up-front vs soft ("שיחה אוטומטית מטעם משפחת כהן לגבי החתונה") is a brand/UX call — it trades a little "human feel" for legal safety. Recommendation: disclose; a great voice + disclosure still beats an IVR.
3. **Caller ID strategy:** one 055 mobile DID per client/brand, a small rotating pool, or a 07x business number. Mobile = max pickup; 07x = "legit business" reading, cheaper, zero WhatsApp/reputation questions. Also: register the number on Truecaller for Business or not.
4. **Voicemail behavior:** hang up silently (burns an attempt? counts as לא ענה?) vs leave a short message. Affects the 3-tries semantics in the Sheet.
5. **Escalation rule:** what the agent does with מתלבט or a hostile/confused guest — mark and move on, or offer "אדם יחזור אליך" (human callback keeps the Cohen v. Ramat Gan human-in-the-loop standard clean).
6. **Budget/platform posture:** pay-per-min Retell flexibility vs ElevenLabs plan bundling; and whether to invest later in self-hosted (LiveKit + ivrit.ai) once monthly minutes exceed ~5–10k.
7. **Calling window per event** (default Sun–Thu 10:00–20:30, Fri till 13:00, never Shabbat/chag — but hosts may want tighter).

## 3. Cost per 100 calls (realistic)

Assumptions: 100 *connected* calls × ~2 min avg = 200 min; +3-attempt retry overhead means ~150–180 dial attempts extra, but unanswered attempts cost only ring-time telephony (small). All USD.

| Component | Retell stack | ElevenLabs stack |
|---|---|---|
| Voice engine | $0.055 infra + $0.04 ElevenLabs TTS = $0.095/min → $19 | bundled in plan credits (~$0.08/min effective) → $16 |
| LLM | $0.006–0.05/min → $1–10 | ~$0.01–0.04/min pass-through → $2–8 |
| Telephony (Israeli mobile) | Twilio $0.0646/min → $13; Telnyx est. $6–10 | same |
| Failed-attempt/ring overhead (~15%) | ~$3–5 | ~$3–5 |
| Number rental (055 DID, amortized) | ~$5–15/mo | same |
| **Total per 100 calls** | **~$40–55 (≈ ₪135–185, ~₪1.4–1.9/call)** | **~$35–50** |

At 500 calls/mo: ~$150–240/mo. Verified anchor rates: Twilio outbound Israel mobile $0.0646/min (twilio.com/en-us/voice/pricing/il, live 2026-08-29); Retell voice/LLM ranges from retellai.com/pricing. Telephony is ~30% of cost — a Telnyx rate-sheet quote is the cheapest single optimization. Self-hosted later: ~$0.10–0.15/min (~$20–30 per 100 calls) but with real engineering cost.

## 4. Compliance to bake in (Israel)

All verified against current law as of 2026-08:

1. **Stay out of sec. 30A (Spam Law):** a pure RSVP call is not davar pirsomet — **zero promotional content**, no ishur.io branding beyond functional identification, no "get your own invite", and no call-back-bait patterns (Amendment 72 catches "dial us back" messages even without promo). Violation exposure: exemplary damages up to ₪1,000/call + class actions. Identify in the **hosts'** name in the first sentence.
2. **DNC registry:** not required for pure RSVP calls (not a pniya shivukit) — but the exemption dies the moment any upsell/benefit/offer enters the script. Keep the script 100% event-logistics.
3. **Bot self-identification:** no general statute yet (narrow election-law exception since 7/2026), but the PPA draft AI directive requires informing people they're talking to an automated system where it materially affects consent, and Cohen v. Ramat Gan (Supreme Court, 22.3.2026) sets a human-oversight standard. Build the disclosure into the opening line + keep a human callback path + log full transcripts.
4. **Recording:** one-party consent (Secret Monitoring Law) — legal to record; still announce "השיחה מוקלטת" (supports sec. 11 informed-consent and the bot-as-party edge case). Store under Data Security Regs; Amendment 13 (in force 8/2025) fines are real.
5. **Hours & retries:** no statutory clock, but harassment law backstops. Enforce in the Worker: Sun–Thu 10:00–20:30, Fri 09:30–13:00, hard-block Shabbat/chagim; max 3 attempts on **separate days** (matches the existing max-3 field).
6. **Opt-out:** "לא להתקשר יותר" honored immediately, logged, and excluded from retries.
7. **Guest data = host's data:** processing agreement with each host, use only for the event, delete/return after; real dialable callback number on the caller ID (no spoofing).

## 5. "I'll supply a phone" — what it maps to, and the verdict

Technically it maps to **GSM-to-SIP bridging**: either the open-source gsm2sip route (rooted Android + Magisk audio patch + Asterisk, X-GSM-Forward header dialing) or a hardware GoIP GSM gateway — bridging a real 05x SIM's audio into the AI stack so calls present a genuine mobile caller ID.

**Talk him out of it for production, gently — the reason he wants it is now solvable legitimately.** The motivation (local mobile caller ID = pickup) is met by **real 055 mobile VoIP DIDs from Telnyx/DIDWW** (verified purchasable, light KYC) with none of the downsides. The phone-bridge path is: one concurrent call per handset, rooted-Android/WiFi fragility, echo from shared mic, breaks on OS updates, carrier T&Cs prohibit gateway use (SIMs get deactivated on machine-dialing patterns), and at scale it drifts into SIM-box/interconnect-bypass territory — legally hazardous and reputationally fatal for a SaaS.

**Where his phone IS useful:** (a) as the **callback/identity anchor** — forward inbound calls on the outbound DID to his supplied phone so missed guests reach a human, which also builds number reputation via two-way traffic; (b) as a **week-one pilot rig** (5–10 calls/day through gsm2sip to validate the Hebrew agent before buying DIDs) if he insists — his own SIM, his own consented guests, human-plausible volume. Not as the production trunk.

**Concrete v1:** Retell agent (Soniox or AssemblyAI ASR + ElevenLabs v3C Hebrew voice, gender-locked prompt) → Telnyx BYO-SIP with a 055 DID → new Cloudflare Worker route that (1) polls `/api/status` for the נדרשת-שיחה queue inside the compliant calling window, (2) POSTs `/v2/create-phone-call` with guest/event in `metadata` + `retell_llm_dynamic_variables`, (3) receives the signed `record_rsvp_outcome` function call and `call_analyzed` webhook and writes `/api/event` `call_result` (מגיע/לא מגיע/מתלבט from the tool, לא ענה from disconnection_reason), (4) enforces max-3-attempts-on-separate-days. The existing calls.html/Sheet flow needs zero changes and remains the human fallback.