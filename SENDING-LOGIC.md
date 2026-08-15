# ishur.io · sending logic

Everything about when a message goes out and who gets it. This is the spec the
Make scenarios should implement; the site already enforces the parts a customer
can see.

All of it is driven by `SCHEDULE` and `SEND_RULES` in `config.js`. Change it
there and the calendar, the timeline and the copy all follow.

---

## 1. The messages

Four messages per event. Two the customer schedules, two derived from the event
date.

| # | Message | When | Goes to | Chosen by |
|---|---|---|---|---|
| 1 | ההזמנה ואישור הגעה | ~30 days before the event | the whole list | customer |
| 2 | תזכורת | ~7 days before the event | whoever has not answered | customer |
| 3 | תזכורת עם הכתובת | event day, or the evening before (see §3) | whoever confirmed | derived |
| 4 | הודעת תודה | the day after the event | whoever confirmed | derived |

Message 1 and 2 default to 30 and 7 days before and can be moved. Messages 3
and 4 cannot be moved; they hang off the event date.

**Optional extra send.** A third chase can be bought as an add-on. It targets
whoever is still silent and sits between messages 2 and 3.

---

## 2. Recommended spacing

Prefilled when the customer picks an event date, then editable.

```
invitation   = event − 30 days
reminder     = event − 7 days       (never less than 7 days after the invitation)
```

Both are pulled backwards onto the nearest sendable day if they land on a
Saturday or inside the cutoff window (§4). If pulling backwards would put the
reminder less than 7 days after the invitation, the reminder moves forward
instead.

---

## 3. The address reminder depends on the reception hour

Message 3 carries the venue address, so it only works if it arrives before
people leave the house.

| Reception starts | Address reminder goes out |
|---|---|
| 16:00 or later | the morning of the event |
| before 16:00 | the evening before |

A reception at 19:00 gets it that morning. One at 12:00 gets it the day before,
because the same morning is already too late to be useful.

Set by `earlyBefore: '16:00'` on the `event_day` entry in `SCHEDULE.auto`.

---

## 4. When sending is allowed

Three rules, enforced inside the calendar so an impossible date cannot be
picked rather than being rejected afterwards.

**Daily batch at 06:00.** To go out on a given day, the event has to be fully
set up before 06:00 that morning. Tomorrow stays available until 06:00 tonight;
from 06:00 the earliest possible send becomes the day after.

**No Saturday.** Never, no exceptions. Saturdays are struck through in the
calendar.

**Friday before 15:00.** Friday sends leave in the morning batch and are done
well before the cutoff. Fridays are marked with a dot, not blocked.

These apply to sends only. **The event itself may be any future day, Saturday
included**, since plenty of events are on מוצאי שבת.

---

## 5. Events that are too close to spread

When the event is 3 days away or fewer there is no room for a schedule, so it
is fixed rather than offered. The invitation takes the first sendable morning,
and only the derived messages still ahead of it survive.

| Event is | What goes out |
|---|---|
| tomorrow | invitation on the morning of the event, thank-you the day after |
| in 2 days | invitation tomorrow, address reminder on the event day, thank-you after |
| in 3 days | invitation tomorrow, address reminder on the event day, thank-you after |
| 4+ days | full schedule, customer picks messages 1 and 2 |

An event cannot be set up for today. Tomorrow is the closest.

---

## 6. Volume

Per 100 invitations, assuming 55% answer the first send, 25% of the rest answer
the reminder, and 72% of responders confirm:

| Message | Recipients |
|---|---|
| invitation | 100 |
| reminder | 45 |
| address reminder | 53 |
| thank-you | 53 |
| **total** | **251** |

So roughly **2.5 messages per invitation**. At 600 invitations that is about
1,500 messages against a ₪599 package.

Adding a third send takes it to about 2.85 per invitation.

**Why this matters beyond cost.** WhatsApp scores the number on how recipients
react. Blocks and reports lower the quality rating, and a lowered rating
throttles throughput for every event on the number, not just the one that
caused it. The reason there is one address reminder rather than a day-before
*and* a same-day is precisely this: a second message carrying no new
information is what earns a block.

---

## 7. Counting

**A tier counts phone numbers, not people.** עד 300 הזמנות means 300 rows in
the file. One family on one number is one invitation, whatever column C says.

Column C (כמות מוזמנים) is seats, and is what makes the totals mean chairs:
`משפחת כהן / 0521234567 / 4` is one message covering four seats. The guest's
reply is capped at that number. Blank defaults to 1.

So an event can be 300 invitations and 700 seats. Pricing follows invitations
because that is what drives cost; the caterer number is seats.

---

## 8. What every message carries

Appended to all four, from `MESSAGE_FOOTER` in `config.js`:

```
נשלח עבור {names} · ishur.io
הגיע בטעות? השיבו "הסר" ולא נכתוב שוב.
```

It is part of the same message, not a second one. The customer sees it in the
preview during setup.

A reply of "הסר" must suppress that number for this event and any future one.
This is what the anti-spam law expects and what keeps recipients from reporting
the number instead of opting out.

---

## 9. Tone

Four tones, picked by the customer from a live preview of the exact text:
`happy`, `serious`, `respectful`, `playful`. Wording per event type lives in
`assets/messages.js` and is shared with the landing page, so what they were
shown is what goes out.

`postponed` and `canceled` are separate, situational, and only sent when
something changes. They are a הכל כלול feature; on other packages they are an
add-on bought from the dashboard.

---

## 10. Changes after setup

The customer can move a send date themselves, without going through support,
as long as it is before 06:00 on the day that send was due. Past that the send
has already left the batch.

Everything else (extra sends, call rounds, raising the invitation count,
postpone and cancel messages) is handled in the dashboard.

---

## Open

- [ ] The optional third send is priced per tier; prices and Grow links are not
      set yet, so the button routes to WhatsApp.
- [ ] Call rounds stop being offered inside 14 days of the event. Confirm that
      window matches how far ahead the call centre actually needs.
- [ ] Confirm the 06:00 batch time matches what the Make scenario actually runs.
