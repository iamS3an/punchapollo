# Punch rules

What the scheduled runs do, day by day. All times come from `punch.conf`; the
examples use its defaults (shift 09:00-18:00, flexible hours 07:00-11:00 and
16:00-20:00, lunch 12:00-13:00).

## Normal day

Clock-in lands at a random minute in the 30 minutes after `SHIFT_START`.
Clock-out is 1 to 5 minutes after the actual clock-in time plus the shift
length, so a day is never short.

## Days without a punch

Read from the site's schedule for the day:

- a calendar event (national holiday);
- no shift (weekend or rest day);
- a special event named 颱風停班 (typhoon closure);
- leave that adds up to a full working day.

## Leave

The working day is one continuous span as long as the shift (9 hours for
09:00-18:00), and leave inside it counts as worked. Leave sheets count whatever
their approval status, adjoining sheets are merged, and leave that touches the
lunch break absorbs it.

| Leave | Clock-in | Clock-out |
|---|---|---|
| None, or only in the middle of the day | 30 minutes after `SHIFT_START` | Shift length after the actual clock-in |
| Begins inside the flexible clock-in hours | 5-25 minutes before the leave ends | Shift length after the leave started |
| Ends inside the flexible clock-out hours | 5-25 minutes before (leave end - shift length) | When the leave starts |
| Adds up to the working time of a shift (8 hours), or covers the whole span | Skipped | Skipped |

Examples with the default settings:

| Leave | Clock-in | Clock-out |
|---|---|---|
| 09:00-13:00 | 12:35-12:55 | 18:01-18:05 |
| 09:00-12:00 | 12:35-12:55 (lunch absorbed) | 18:01-18:05 |
| 13:00-17:00 | 07:35-07:55 | 12:01-12:05 (lunch absorbed) |
| 14:00-18:00 | 08:35-08:55 | 14:01-14:05 |
| 13:00-15:00 | 09:00-09:29 | clock-in + 9 hours |
| 07:00-11:00 and 14:00-17:00 | 10:35-10:55 | 14:01-14:05 |
| 07:00-11:00 and 14:00-18:00 | Skipped (8 hours of leave) | Skipped |

Random times stay inside both the flexible hours and the margins above:

- A clock-in is never planned before the flexible clock-in hours open. If the
  5-25 minute lead does not fit, the time is random between the opening and the
  minute before work resumes. If nothing is left, the run starts 2 minutes
  early, finishes its checks, and punches exactly as the hours open.
- A clock-out is never skipped for landing after the flexible clock-out hours
  close — a full shift is always honored. Only the random 1-5 minute delay
  added after it is cut short there; with no room left, clock-out happens
  right at the full-shift moment with no added delay.

Leave that reaches into the flexible hours means you are away for that half of
the day, and an existing clock-in is looked at first:

- A clock-in made before morning leave began is treated as a normal one:
  clock-out is the shift length after it, with the leave inside.
- When leave ends the day, clock-out is only made within 30 minutes of the
  leave starting. A later one would record a time you were not there.
- When leave ends the day and the clock-in was later than planned, no clock-out
  is made at all.

## When in doubt, no punch

Scheduled runs skip, or fail without punching, when:

| Situation | Log reason |
|---|---|
| The punch already exists | `already-clocked-in`, `already-clocked-out` |
| Clock-out without a clock-in | `no-clock-in-record` |
| A leave-day punch comes after its planned time | `planned-time-missed` |
| A normal-day clock-in would come after the flexible clock-in hours close | `outside-flexible-hours` |
| Holiday or full-day leave with a clock-in already made; clock-in too late for leave that ends the day | `no-plan-for-day` |
| The schedule cannot be read, a leave sheet has an unreadable time range, or the settings are invalid | `ERROR` |
| The site reports the current IP is not allowed, or expects the other punch type | `ERROR` |

A punch that is only too early is not made either (`not-due`), but it is
rescheduled for the time it is due. A submission whose result is unknown is
never sent again automatically, because that could create a duplicate record.
An existing punch is never overwritten.

Punch by hand in those cases, with `npm run clock:in` / `npm run clock:out` or
the site's own app.

## Schedule

`npm run daemon:start` runs `src/daemon.js` under pm2, a single process kept
alive on Windows instead of a crontab. Each weekday it:

- Waits until half an hour before the flexible clock-in hours open, then
  reads the day's plan (the same `clock:plan` logic).
- On a normal day with no clock-in yet, picks a random clock-in minute within
  30 minutes of `SHIFT_START` itself (not from the plan), then waits for it.
  Already clocked in - for example after a restart partway through the day -
  it uses that actual time instead of rolling a new one.
- On a leave day, uses the window the plan computes for it (shortly before a
  morning leave ends, or shortly before an afternoon leave begins) instead of
  the regular shift-start formula.
- Either way, once a clock-in time is set, picks the clock-out time 1 to 5
  minutes after a full shift from it, and waits for that too.
- A punch that comes back "not due yet" (too early) is retried at the time it
  reports.
- After a clock-out, or a day with nothing to punch, it moves on to the next
  weekday and reads that day's plan fresh - so leave filed overnight, or
  while the computer was off, is still picked up before the day's clock-in.

To look at a specific day's plan, run `npm run clock:plan -- 2026-10-23`.
`npm run daemon:logs` tails the daemon's own output; `logs/punch.log` keeps
the scheduled-run entries.

Only one scheduled run works at a time; the daemon waits for each one to
finish before starting the next.

## Why the shift comes from punch.conf

The site moves a day's shift to the actual clock-in minute once you have
clocked in, so its shift times cannot be relied on; `punch.conf`'s shift is
used instead. Its length is compared with the site's for a sanity check, but
a difference only logs a warning — `punch.conf` is always what's actually
punched by, whether its shift is longer or shorter than the site's.

## Limitations

- Automatic sign-in supports Microsoft SSO only.
- The schedule covers Monday to Friday; a make-up working day on a weekend is
  not punched.
- A typhoon closure skips the whole day even if it covers only part of it.
- Leave filed after the fact is not known in the morning, so the clock-in is
  made as on a normal day.
- A punch made by mistake by hand cannot be told from a deliberate one; the
  scheduled run sees it and skips its own.
- A failed or skipped punch is only written to the log.
