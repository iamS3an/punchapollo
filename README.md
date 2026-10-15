# Punchapollo

Clocks in and out of an attendance site on a schedule, through a dedicated
Microsoft Edge profile on Windows. Runs from plain Windows, or with WSL if you
prefer to type the commands there - the commands are the same.

- Clock-in lands at a random time each working day; clock-out follows a full
  shift later.
- Holidays, rest days and leave are read from the site, and the punch times
  move with partial-day leave.
- The saved sign-in session is reused directly, without opening Edge. Only
  once it expires does Edge open, to sign in by hand or through Microsoft SSO
  by itself if you turn that on.
- When the right time is in doubt, nothing is punched.
- A Windows notification shows every punch result, and tells you when you
  need to sign in by hand.

## Quick start

Needs Windows with Edge and Node.js. WSL2 is optional: if you type the
commands there, it needs Node.js too, only so `npm run` works. Starting from
nothing? Follow
[docs/install.md](docs/install.md). Setting this up with the help of an AI
assistant? Point it at [AGENTS.md](AGENTS.md) instead — it's the same steps
written for an agent to execute.

On plain Windows, clone anywhere and run these in PowerShell. From WSL, you
can clone straight into your home directory, or - faster - onto the Windows
side with a symlink into WSL; see
[docs/install.md](docs/install.md#5-get-the-project). `cd` there first, then:

```bash
git clone https://github.com/iamS3an/punchapollo.git && cd punchapollo
npm install
cp punch.conf.example punch.conf   # then fill in SITE_URL and SIGN_IN_URL
npm run session:login              # sign in once in the Edge window that opens
npm run location:set               # picks your office; punches by its position from now on
npm run clock:plan                 # shows today's plan, punches nothing
npm run daemon:start               # starts the scheduler, kept alive by pm2
npm run daemon:autostart           # brings it back after a reboot
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
| `PUNCH_METHOD` | How a punch is made: `ip` (the network address is checked, like the web page), `gps` (the office's registered position is sent, like the phone app; where this computer is, is not checked) or `auto` (`gps`, and `ip` whenever the `gps` punch was not made). Default and recommended: `auto` |
| `GPS_LOCATION_ID` | For `gps` and `auto`. Your office's punch location; `npm run location:set` picks it. Until it is set, `auto` punches by `ip`; `gps` needs a real one |
| `SHIFT_START`, `SHIFT_END` | Regular shift, e.g. `09:00` and `18:00` |
| `FLEX_CLOCK_IN_START`, `FLEX_CLOCK_IN_END` | Flexible clock-in hours |
| `FLEX_CLOCK_OUT_START`, `FLEX_CLOCK_OUT_END` | Flexible clock-out hours |
| `LUNCH_START`, `LUNCH_END` | Lunch break |

Run `npm run config:show` to check the file and `npm run daemon:restart` after
changing it. An invalid setting stops everything until it is fixed.

## Commands

### Every day

| Command | What it does |
|---|---|
| `npm run clock:plan` | Prints today's plan from the site, then what the daemon has scheduled (the times it picked); punches nothing |
| `npm run clock:in` / `clock:out` | Punches now, by hand |
| `npm run config:show` | Shows the settings, whether the daemon is running, and what it has scheduled |
| `npm run daemon:logs` | Tails the daemon's own output live |

### Setup

| Command | What it does |
|---|---|
| `npm run session:login` | Reuses the saved session, or signs in if it has expired |
| `npm run location:set` | Lists this account's punch locations and sets `GPS_LOCATION_ID` to the one you pick |
| `npm run daemon:start` / `stop` / `restart` | Starts, stops or restarts the scheduler under pm2; restart after any `punch.conf` edit. `start` is safe to repeat |
| `npm run daemon:autostart` | Registers a logon task that restores the daemon after a reboot |
| `npm run daemon:status` | Shows pm2's status for every app it manages, not just this one |

### Automatic sign-in (`AUTO_SSO=on` only)

| Command | What it does |
|---|---|
| `npm run password:set` / `totp:set` | Stores the Microsoft password / authenticator secret |
| `npm run session:test` | Tests automatic sign-in from a clean browser; punches nothing |

## What it does each day

| Day | Clock-in | Clock-out |
|---|---|---|
| Normal | Random, within 30 minutes of `SHIFT_START` | A full shift after the actual clock-in, plus 1-5 minutes |
| Holiday, rest day, typhoon closure, full-day leave | None | None |
| Leave in the morning | Shortly before the leave ends | A full shift after the leave started |
| Leave in the afternoon | Early enough for a full day | When the leave starts |

Scheduled runs skip the punch rather than guess: a punch is never made twice,
never overwritten, and a clock-in is never made outside the flexible hours.
A clock-out always honors a full shift even past them — only its small random
delay is capped there. The log says why a punch was skipped, and you punch by
hand.

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

Start with the end of `logs/punch.log` (`tail -40 logs/punch.log`, or
`Get-Content logs\punch.log -Tail 40` in PowerShell). A Windows notification
also shows every result, but the log is what persists.

| Symptom | Likely cause |
|---|---|
| `Cannot connect to Edge` | DevTools (F12) is open in the dedicated Edge window; close it |
| `Current IP is not allowed for web punching` | The computer is not on a network the site accepts |
| `Punch API returned ...` with `gps` | The site refused the GPS punch; with `auto` the IP punch is tried next |
| `Punch API returned ...` with a status and the start of a body | An unexpected response - often a WAF challenge page, not the attendance API itself |
| `Punch submission result is unknown ...` | The punch request itself failed (network/timeout); not retried automatically, since it may already be recorded |
| `The punch needs a reason ...` | The punch was too early or too late for the day's overtime limits, and the site offered no "no overtime" answer |
| `Login timed out` | The session expired and nobody signed in, or a stored value was rejected; run `npm run session:login` |
| No notification shown | Check Windows' notification settings haven't muted PowerShell/balloon tips, or Focus Assist is on |
| `node.exe: command not found` in WSL | Windows Node.js is missing, or WSL does not expose the Windows PATH (`appendWindowsPath` in `/etc/wsl.conf`) |
| `punch.conf: ...` | A setting is invalid; `npm run config:show` repeats the message |
| Nothing in the log | The computer was asleep, the Windows user was not signed in, or the daemon is not running - check `npm run daemon:status` (a project kept inside WSL also needs that distro running) |

## License

MIT. See [LICENSE](LICENSE).
