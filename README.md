# punchapollo

Clocks in and out of an attendance site on a schedule, from WSL, through a
dedicated Microsoft Edge profile on Windows.

- Punches go through the same API calls the site's own page makes; no buttons
  are clicked.
- Clock-in lands at a random time each working day, and clock-out follows a
  full shift later.
- Holidays, rest days, typhoon closures and leave are read from the site, and the
  punch times move with partial-day leave.
- The saved sign-in session is reused. When it has expired, the run either
  waits for you to sign in or, if you turn that on, signs in through Microsoft
  SSO by itself, including the password and authenticator code.
- When the right time is in doubt, nothing is punched.

Automatic sign-in supports Microsoft SSO only. Signing in by hand works with
whatever the site's sign-in page offers.

## Requirements

- Windows 10 or 11 with Microsoft Edge
- WSL2 with Ubuntu
- Node.js on **both** sides: Windows runs the punch scripts, because they talk
  to Edge on Windows, and WSL runs `npm` and the schedule
- An account on the attendance site that may punch from the web from this
  computer's network

The Windows user must stay signed in and WSL must be running at punch time.
Locking the screen is fine; sleep, hibernation and shutdown are not.

## Installation

Steps 1 to 4 prepare the computer and can be skipped where it is already set
up. Commands marked PowerShell run in Windows PowerShell; the rest run in the
Ubuntu (WSL) terminal.

### 1. Node.js on Windows

PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell, then check that `node -v` prints a version (18 or
newer). Without `winget`, use the installer from <https://nodejs.org>.

### 2. WSL2 with Ubuntu

PowerShell, as administrator:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if asked, open **Ubuntu** from the Start menu, and create the
Linux user it asks for. `wsl -l -v` in PowerShell should list Ubuntu with
VERSION 2.

### 3. systemd, cron and the timezone in WSL

The schedule needs `cron`, which needs systemd:

```bash
printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
```

Skip that command if `/etc/wsl.conf` already has `systemd=true`. Then restart
WSL from PowerShell and open Ubuntu again:

```powershell
wsl --shutdown
```

Back in Ubuntu:

```bash
sudo apt update
sudo apt install -y cron git curl
sudo timedatectl set-timezone Asia/Taipei
sudo systemctl enable --now cron
```

The timezone matters: this `cron` only follows the system timezone, and all
punch times are Taipei time.

### 4. Node.js and npm in WSL

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Close and reopen the Ubuntu terminal, then:

```bash
nvm install --lts
```

### 5. Check the computer

```bash
node -v && npm -v                 # Node.js and npm in WSL
systemctl is-active cron          # active
date +%Z%z                        # CST+0800
powershell.exe -NoProfile -Command "node -v"   # Node.js on Windows
```

All four must print a result without an error before going on.

### 6. Get the project

```bash
git clone <repository-url> ~/punchapollo
cd ~/punchapollo
npm install
```

`npm install` downloads the one dependency, `playwright-core`. It does not
download a browser; the scripts use the Edge already on Windows.

### 7. Create your settings

```bash
cp punch.conf.example punch.conf
nano punch.conf
npm run config:show
```

Fill in `SITE_URL` and `SIGN_IN_URL` with the addresses of your attendance
site: sign in to it in your everyday browser and copy them from the address
bar, the first from the page with the clock-in button and the second from the
sign-in page. The times in the example suit a 09:00-18:00 shift; change them to
yours, and see [Settings](#settings) and
[Sign-in](#sign-in) for the sign-in choices. `config:show` repeats what it read
and reports anything it cannot accept.

### 8. Sign in once

```bash
npm run session:login
```

An Edge window with a profile of its own opens on the site's sign-in page. Sign
in there the way you normally do. The command prints `authenticated: true` when
it sees the session, and that Edge profile keeps it from then on.

### 9. Optional: automatic sign-in

Skip this to keep signing in by hand when the session expires. Otherwise set
`AUTO_SSO=on` with your `SSO_DOMAIN` and `SSO_ACCOUNT` in `punch.conf`, prepare
the Microsoft account as in [Microsoft account setup](#microsoft-account-setup),
and store the password and the authenticator secret. Run these in the Ubuntu
terminal itself, because the input is typed hidden:

```bash
npm run password:set
npm run totp:set
npm run session:test
```

`session:test` signs in from a clean browser and must end with
`authenticated: true`.

### 10. Check the plan and install the schedule

```bash
npm run clock:plan      # reads the site and punches nothing
npm run cron:install
```

`clock:plan` should describe today correctly: a normal day, a holiday, or your
leave. `cron:install` prints the schedule it installed. From here on
`logs/punch.log` records every scheduled run.

## Settings

`punch.conf` holds your settings as `NAME=value`. It is not committed; start
from `punch.conf.example`.

| Setting | Example | Meaning |
|---|---|---|
| `SITE_URL` | `https://hr.example.com/ta` | The page you land on after signing in, where the clock-in button is |
| `SIGN_IN_URL` | `https://auth.example.com/HRM/Account` | The address of the sign-in page, without its last part (`/Login`) |
| `AUTO_SSO` | `off` | What happens when the saved session has expired: `off` waits for you to sign in, `on` signs in through SSO by itself |
| `SSO_PROVIDER` | `Microsoft` | With `AUTO_SSO=on`: the sign-in button on the sign-in page. Only `Microsoft` is supported |
| `SSO_DOMAIN` | `contoso.com` | With `AUTO_SSO=on`: the domain typed on the page that follows |
| `SSO_ACCOUNT` | `you@contoso.com` | With `AUTO_SSO=on`: the account at that provider |
| `SHIFT_START`, `SHIFT_END` | `09:00`, `18:00` | Regular shift; clock-in lands in the 30 minutes after the start, and a full day is the shift length |
| `FLEX_CLOCK_IN_START`, `FLEX_CLOCK_IN_END` | `07:00`, `11:00` | Flexible clock-in hours |
| `FLEX_CLOCK_OUT_START`, `FLEX_CLOCK_OUT_END` | `16:00`, `20:00` | Flexible clock-out hours |
| `LUNCH_START`, `LUNCH_END` | `12:00`, `13:00` | Lunch break, which is not working time |

Times are Taipei time as `HH:MM`.

```bash
npm run config:show    # the settings, the times they lead to, the installed schedule
npm run cron:install   # apply changed settings to the schedule
```

The punch scripts read the file on every run, so the rules change at once;
`cron:install` is what moves the regular clock-in and clock-out times. A
setting that cannot be read, is misspelled, or contradicts another one is an
error, and nothing is punched or installed until it is fixed. `SITE_URL` and
`SIGN_IN_URL` are always required and may not be left at the example values.
With `AUTO_SSO=on` the three `SSO_` settings are required and may not be left at the
example values; with `AUTO_SSO=off` they are ignored.

The shift comes from this file rather than from the site's shift times, because
the site moves a day's shift to the actual clock-in minute once you have clocked
in. Only the shift length is compared, and a different length is refused.

## Commands

| Command | What it does |
|---|---|
| `npm run clock:plan` | Prints today's plan; punches nothing. `PUNCH_PLAN_DATE=2026-10-23 npm run clock:plan` looks at another day |
| `npm run clock:in` | Clocks in now, unless the day is a holiday, rest day or full-day leave, or a clock-in exists |
| `npm run clock:out` | Clocks out now, if there is a clock-in and no clock-out |
| `npm run config:show` | Shows the settings and the installed schedule |
| `npm run cron:install` | Installs or refreshes the schedule |
| `npm run session:login` | Makes sure the dedicated Edge profile is signed in: reports the saved session if it is still valid, otherwise signs in |
| `npm run session:test` | With `AUTO_SSO=on`: signs in from a clean InPrivate browser to verify the stored password and TOTP secret; punches nothing and leaves the saved session untouched |
| `npm run password:set` | Stores or replaces the Microsoft password |
| `npm run totp:set` | Stores or replaces the TOTP secret and prints the current code |
| `npm run edge:start` | Starts the dedicated Edge profile |

`clock:in` and `clock:out` are the manual entry points: they punch immediately
and ignore the planned times. Scheduled runs wait for the planned time.

## When it punches

### Normal day

Clock-in lands at a random minute in the 30 minutes after `SHIFT_START`.
Clock-out is 1 to 5 minutes after the actual clock-in time plus the shift
length, so a day is never short.

### Days without a punch

Read from the site's schedule for the day:

- a calendar event (national holiday);
- no shift (weekend or rest day);
- a special event named 颱風停班 (typhoon closure);
- leave that covers the whole working day.

### Leave

The working day is one continuous span as long as the shift (9 hours for
09:00-18:00), and leave inside it counts as worked. Leave sheets count whatever
their approval status, adjoining sheets are merged, and leave that touches the
lunch break absorbs it.

| Leave | Clock-in | Clock-out |
|---|---|---|
| None, or only in the middle of the day | 30 minutes after `SHIFT_START` | Shift length after the actual clock-in |
| Begins inside the flexible clock-in hours | 5-25 minutes before the leave ends | Shift length after the leave started |
| Ends inside the flexible clock-out hours | 5-25 minutes before (leave end - shift length) | When the leave starts |
| Covers the whole span | Skipped | Skipped |

Examples with the default settings:

| Leave | Clock-in | Clock-out |
|---|---|---|
| 09:00-13:00 | 12:35-12:55 | 18:01-18:05 |
| 09:00-12:00 | 12:35-12:55 (lunch absorbed) | 18:01-18:05 |
| 13:00-17:00 | 07:35-07:55 | 12:01-12:05 (lunch absorbed) |
| 14:00-18:00 | 08:35-08:55 | 14:01-14:05 |
| 13:00-15:00 | 09:00-09:29 | clock-in + 9 hours |

Random times stay inside both the flexible hours and the margins above:

- A clock-in is never planned before the flexible clock-in hours open. If the
  5-25 minute lead does not fit, the time is random between the opening and the
  minute before work resumes. If nothing is left, the run starts 2 minutes
  early, finishes its checks, and punches exactly as the hours open.
- A clock-out delay is cut short where the flexible clock-out hours close.

Leave that reaches into the flexible hours means you are away for that half of
the day, and an existing clock-in is looked at first:

- A clock-in made before morning leave began is treated as a normal one:
  clock-out is the shift length after it, with the leave inside.
- When leave ends the day, clock-out is only made within 30 minutes of the
  leave starting. A later one would record a time you were not there.
- When leave ends the day and the clock-in was later than planned, no clock-out
  is made at all.

### When in doubt, no punch

Scheduled runs skip, or fail without punching, when:

| Situation | Log reason |
|---|---|
| The punch already exists | `already-clocked-in`, `already-clocked-out` |
| Clock-out without a clock-in | `no-clock-in-record` |
| A leave-day punch comes after its planned time | `planned-time-missed` |
| A normal-day clock-in would come after the flexible clock-in hours; the full day would end after the flexible clock-out hours; a clock-out is triggered after they close | `outside-flexible-hours` |
| Holiday or full-day leave with a clock-in already made; clock-in too late for leave that ends the day | `no-plan-for-day` |
| The schedule cannot be read, the shift length differs from `punch.conf`, a leave sheet has an unreadable time range, or the settings are invalid | `ERROR` |
| The site reports the current IP is not allowed, or expects the other punch type | `ERROR` |

A punch that is only too early is not made either (`not-due`), but it is
rescheduled for the time it is due. A submission whose result is unknown is
never sent again automatically, because that could create a duplicate record.
An existing punch is never overwritten.

Punch by hand in those cases, with `npm run clock:in` / `npm run clock:out` or
the site's own app.

## Schedule

`npm run cron:install` writes a marked block into your crontab and leaves other
entries untouched:

```cron
# BEGIN PUNCHAPOLLO
17 9 * * 1-5 ~/punchapollo/scripts/cron-punch.sh clock-in
20 18 * * 1-5 ~/punchapollo/scripts/cron-punch.sh clock-out
30 6 * * 1-5 ~/punchapollo/scripts/cron-punch.sh plan
# END PUNCHAPOLLO
```

- The clock-in and clock-out minutes are random. After each scheduled clock-out
  the wrapper installs new ones for the next working day.
- Running `cron:install` by hand during a working day sets clock-out to the
  latest regular time, because the new clock-in minute no longer matches when
  the day actually started.
- The `plan` entry runs half an hour before the flexible clock-in hours open.

When the regular times do not fit a day, a one-off entry for that date is added
to the block, for example
`48 12 20 8 * .../cron-punch.sh clock-in # once 2026-08-20 clock-in`:

- After each scheduled clock-out the wrapper plans the next working day, so
  leave filed in advance is scheduled the evening before.
- The morning `plan` run plans the day again, which covers leave filed
  overnight and evenings when the computer was off.
- A scheduled punch that fires too early adds one for the time it is due.

The installer drops one-off entries once their date has passed. To plan a
specific day by hand, run `scripts/cron-punch.sh plan 2026-10-23`.

Only one scheduled run works at a time; a run that starts while another is
still going exits without doing anything.

## Sign-in

The scripts use an Edge profile of their own, kept in
`%LOCALAPPDATA%\punchapollo\edge-profile` and started with remote debugging
on port `9222` whenever a run needs it. It is separate from your everyday Edge.

Every run first uses the session saved in that profile. Nothing below happens
while the session is valid. When the site answers that authentication is
required, `AUTO_SSO` decides what comes next, and the run then retries what it
was doing.

### AUTO_SSO=off: sign in by hand

The sign-in page is opened, the Edge window is brought to the foreground,
and the run waits: 10 minutes for a scheduled run, 15 for
`npm run session:login`. Sign in the way you normally do. Nothing is filled in
for you, and nothing about the sign-in is stored except the session Edge keeps.

A scheduled punch that nobody signs in for is not made and logs
`Login timed out`.

### AUTO_SSO=on: sign in through Microsoft SSO

The run opens the site's external sign-in for `SSO_PROVIDER` and `SSO_DOMAIN`,
which hands over to Microsoft:

- On a computer signed in to Windows with the same work account, Edge usually
  completes the Microsoft sign-in silently, and nothing more is needed.
- If Microsoft asks for the account name, `SSO_ACCOUNT` is filled in.
- If Microsoft asks for the password, the stored password is submitted once.
- If Microsoft asks for a verification code, it is generated from the stored
  TOTP secret. A code is never submitted twice and at most two are tried.
- If a value is not stored, is rejected, or Microsoft shows a page the script
  does not recognize, Edge is brought to the foreground and the run waits for
  manual input, as with `AUTO_SSO=off`.

The password and the TOTP secret are optional; what is missing is simply asked
of you. They are saved under `%LOCALAPPDATA%\punchapollo\`, encrypted with
Windows DPAPI for the current Windows account on this computer, never in the
project. Run `password:set` again whenever the Microsoft password changes.

### Microsoft account setup

The automatic verification code only works if Microsoft asks for a code. Set
this up once at <https://mysignins.microsoft.com/security-info>:

1. Add a sign-in method of the kind "Authenticator app". When the QR code is
   shown, open the "can't scan the QR code" link and copy the secret key; that
   base32 key (or the whole `otpauth://` URI) is what `npm run totp:set` asks
   for. Finish the setup by entering a code; `totp:set` prints the current one.
2. Change the default sign-in method, shown as "the sign-in method used when
   the most advisable one is unavailable" (當最推薦的方法無法使用時，所使用的
   登入方法), to **Authenticator app or hardware token - code**
   (Authenticator 應用程式或硬體 Token - 代碼).

Without step 2 Microsoft keeps offering a push notification or another method
first, the code prompt never appears, and the sign-in waits for manual input.

`npm run session:test` signs in from a clean InPrivate browser with a throwaway
profile on port `9223`, where Microsoft asks for everything, to confirm the
stored values and this setup work.

## Logs and troubleshooting

```bash
tail -40 logs/punch.log
```

Each scheduled run logs when it started, the JSON result or the error, and
whether it completed. Nothing else notifies you, so check the log when a punch
is missing.

| Symptom | Likely cause |
|---|---|
| `Cannot connect to Edge` or a connection timeout | DevTools (F12) is open in the dedicated Edge window; close it. Use your everyday browser to inspect the site |
| `Current IP is not allowed for web punching` | The computer is not on a network the site accepts for web punching |
| `Login timed out` | The session expired and nobody signed in (`AUTO_SSO=off`), or Microsoft asked for something that is not stored or was rejected; run `npm run session:login`, and `npm run password:set` if the password changed |
| `Windows Node.js was not found` | Node.js is missing on the Windows side; see step 1 of the installation |
| `session:test` stops at a push notification or a method chooser | The default sign-in method is not the authenticator code; see [Microsoft account setup](#microsoft-account-setup) |
| `punch.conf: ...` | A setting is invalid; `npm run config:show` repeats the message |
| Punches happen at the wrong hour | The WSL system timezone is not UTC+8 |
| Nothing in the log at punch time | The computer was asleep or off, WSL was not running, or `cron` is not active |

## Security

- Use only the dedicated Edge profile, not your everyday browser profile, and
  treat its directory as a credential.
- The stored password and TOTP secret together are a complete sign-in for the
  Microsoft account. Enter them only through `npm run password:set` and
  `npm run totp:set`; change the password and re-register the authenticator if
  either has been exposed.
- While the dedicated Edge is running, any program on the computer can drive it
  through the debugging port.
- Never commit `punch.conf`, cookies or authentication headers. `punch.conf`
  and `logs/` are ignored by git.

## Moving to another computer

Copy or clone the project without `node_modules`, `logs` and `punch.conf`, then
follow [Installation](#installation). Do not copy
`%LOCALAPPDATA%\punchapollo`, which holds the Edge profile and the stored
password and TOTP secret; they are protected for the original Windows account
and computer.

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

## License

MIT. See [LICENSE](LICENSE).
