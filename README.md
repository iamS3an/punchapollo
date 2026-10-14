# Punchapollo

Clocks in and out of an attendance site on a schedule, from WSL, through a
dedicated Microsoft Edge profile on Windows.

- Clock-in lands at a random time each working day; clock-out follows a full
  shift later.
- Holidays, rest days and leave are read from the site, and the punch times
  move with partial-day leave.
- The saved sign-in session is reused. When it expires you sign in by hand, or
  the run signs in through Microsoft SSO by itself if you turn that on.
- When the right time is in doubt, nothing is punched.

## Quick start

Needs Windows with Edge and Node.js, and WSL2 Ubuntu with Node.js, `cron` and
the Asia/Taipei timezone. Starting from nothing? Follow
[docs/install.md](docs/install.md). Setting this up with the help of an AI
assistant? Point it at [AGENTS.md](AGENTS.md) instead — it's the same steps
written for an agent to execute.

Clone onto the Windows side and symlink it into WSL, not onto WSL's own
filesystem — see [docs/install.md](docs/install.md#6-get-the-project) for why
and how to find that directory and symlink it into WSL; `cd` there first,
then:

```bash
git clone https://github.com/iamS3an/punchapollo.git && cd punchapollo
npm install
cp punch.conf.example punch.conf   # then fill in SITE_URL and SIGN_IN_URL
npm run session:login              # sign in once in the Edge window that opens
npm run clock:plan                 # shows today's plan, punches nothing
npm run cron:install               # installs the schedule
```

Every scheduled run is recorded in `logs/punch.log`.

## Settings

`punch.conf`, as `NAME=value`; times are Taipei time as `HH:MM`.

| Setting | Meaning |
|---|---|
| `SITE_URL` | The page you land on after signing in, where the clock-in button is |
| `SIGN_IN_URL` | The address of the sign-in page, without its last part (`/Login`) |
| `AUTO_SSO` | When the session has expired: `off` waits for you to sign in, `on` signs in by itself |
| `SSO_PROVIDER`, `SSO_DOMAIN`, `SSO_ACCOUNT` | For `AUTO_SSO=on` only. The provider must be `Microsoft` |
| `SHIFT_START`, `SHIFT_END` | Regular shift, e.g. `09:00` and `18:00` |
| `FLEX_CLOCK_IN_START`, `FLEX_CLOCK_IN_END` | Flexible clock-in hours |
| `FLEX_CLOCK_OUT_START`, `FLEX_CLOCK_OUT_END` | Flexible clock-out hours |
| `LUNCH_START`, `LUNCH_END` | Lunch break |

Run `npm run config:show` to check the file and `npm run cron:install` after
changing it. An invalid setting stops everything until it is fixed.

## Commands

| Command | What it does |
|---|---|
| `npm run clock:plan` | Prints today's plan; punches nothing |
| `npm run clock:in` / `clock:out` | Punches now, by hand |
| `npm run cron:install` | Installs or refreshes the schedule |
| `npm run config:show` | Shows the settings and the installed schedule |
| `npm run session:login` | Reuses the saved session, or signs in if it has expired |
| `npm run password:set` / `totp:set` | Stores the Microsoft password / authenticator secret for `AUTO_SSO=on` |
| `npm run session:test` | Tests `AUTO_SSO` (automatic sign-in) from a clean browser; punches nothing |

## What it does each day

| Day | Clock-in | Clock-out |
|---|---|---|
| Normal | Random, within 30 minutes of `SHIFT_START` | A full shift after the actual clock-in, plus 1-5 minutes |
| Holiday, rest day, typhoon closure, full-day leave | None | None |
| Leave in the morning | Shortly before the leave ends | A full shift after the leave started |
| Leave in the afternoon | Early enough for a full day | When the leave starts |

Scheduled runs skip the punch rather than guess: a punch is never made twice,
never overwritten, and never made at a time that would leave the day short or
fall outside the flexible hours. The log says why, and you punch by hand.

Details, examples and the schedule itself: [docs/rules.md](docs/rules.md).

## Sign-in

- `AUTO_SSO=off` (the default): when the session has expired, the sign-in page
  opens in the dedicated Edge window and the run waits for you.
- `AUTO_SSO=on`: the run signs in through Microsoft SSO. Store the password and
  authenticator secret with `npm run password:set` and `npm run totp:set`; both
  are encrypted with Windows DPAPI and kept outside the project.

Setup, including the Microsoft account setting that automatic codes depend on:
[docs/sign-in.md](docs/sign-in.md).

## Troubleshooting

Start with `tail -40 logs/punch.log`. Nothing else notifies you of a missed
punch.

| Symptom | Likely cause |
|---|---|
| `Cannot connect to Edge` | DevTools (F12) is open in the dedicated Edge window; close it |
| `Current IP is not allowed for web punching` | The computer is not on a network the site accepts |
| `Login timed out` | The session expired and nobody signed in, or a stored value was rejected; run `npm run session:login` |
| `Windows Node.js was not found` | Node.js is missing on the Windows side |
| `punch.conf: ...` | A setting is invalid; `npm run config:show` repeats the message |
| Punches at the wrong hour | The WSL timezone is not UTC+8 |
| Nothing in the log | The computer was asleep, WSL was not running, or `cron` is not active |

## License

MIT. See [LICENSE](LICENSE).
