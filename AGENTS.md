# AGENTS.md

This file is a runbook for an AI assistant installing **punchapollo** for its
user on a new Windows + WSL2 computer. Follow it as a sequence of steps with
explicit commands and success checks, not as background reading. For prose
explanations, [README.md](README.md), [docs/install.md](docs/install.md) and
[docs/sign-in.md](docs/sign-in.md) are the human-facing versions of the same
material; link the user there if they want more context, but drive the
install from this file.

## What this does

Signs in to an attendance site through a dedicated Microsoft Edge
profile on Windows, and clocks in/out on a schedule from a `cron` job in WSL.
Edge is a GUI app and only runs on Windows; `cron` is driven from WSL/Linux.
That split is why the project needs Node.js installed on **both** sides —
Windows runs the scripts that talk to Edge, WSL runs `npm` and the schedule.
Do not try to remove either side; it is architectural, not a packaging
choice.

## Rules for you, the agent

- **Never** ask the user to paste their password or TOTP secret into chat.
  `npm run password:set` and `npm run totp:set` read hidden input directly in
  their own terminal — tell them to run those commands themselves and report
  only whether they succeeded.
- **Never** commit or display the contents of `punch.conf` — it is personal
  and gitignored. `npm run config:show` is the safe way to confirm it loaded.
- `npm run session:test` and the SSO sign-in flow have a capped number of
  password/TOTP attempts to avoid locking the account out. Don't loop it
  speculatively; run it once per real change and read the result.
- Ask the user (don't guess) for: their attendance site's `SITE_URL` and
  `SIGN_IN_URL`, and their shift hours. These are specific to their
  employer's site and account.
- `AUTO_SSO` defaults to off. Never enable it, suggest it, or run
  `password:set`/`totp:set`/`session:test` on your own initiative — only do
  so if the user explicitly asks for automatic sign-in.
- Treat `git push`, `npm install` at the system level, and any WSL-wide
  config change (e.g. `.wslconfig`) as approval-gated — this project's steps
  below (`npm install` inside the repo, `git clone`) are expected and fine.
- **Never run `wsl --shutdown` if you might be running inside the WSL
  instance you'd be shutting down.** It kills your own process before you
  can report back. See step 3 for the safe handling.

## Step-by-step

### 1. Check what's already there

```bash
node -v && npm -v                              # Node.js/npm in WSL
systemctl is-active cron                       # expect: active
date +%Z%z                                     # expect: CST+0800
powershell.exe -NoProfile -Command "node -v"   # Node.js on Windows
wsl.exe -l -v 2>/dev/null | cat                # Ubuntu should show VERSION 2
```

Anything that already succeeds, skip the matching step below.

### 2. WSL2 + Ubuntu (if step 1's `wsl -l -v` didn't show it)

PowerShell, as administrator: `wsl --install -d Ubuntu`, restart if asked,
open Ubuntu from the Start menu once to create the Linux user.

### 3. systemd, cron, timezone in WSL (if step 1's cron/date checks failed)

```bash
grep -q 'systemd=true' /etc/wsl.conf 2>/dev/null || printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf
```

**If that line was added, stop and check first: are you (the agent) running
inside this same WSL distro?** Many agent CLIs, including Claude Code, are
launched from inside WSL. `wsl --shutdown` tears down the whole WSL VM —
if you run it yourself from inside that VM, it kills your own process mid-task
before you can report anything back, and there is no "you" left to reopen
Ubuntu or continue the remaining steps.

- If you can tell you're running outside WSL (e.g. you were invoked from a
  Windows-side tool), you may run `wsl --shutdown` yourself, then reopen
  Ubuntu and continue.
- If you're running inside WSL, or you aren't sure: do **not** run it. Stop
  here and tell the user exactly this: `/etc/wsl.conf` now has
  `systemd=true`; close all WSL windows, run `wsl --shutdown` themselves from
  a plain Windows PowerShell/CMD window, reopen Ubuntu, and resume the
  install (either by re-running this file with you or asking you to
  continue) from step 3's `apt install` onward.

Most existing installs already have cron/systemd working — step 1's checks
catch that and skip this step entirely, so this only comes up on a genuinely
fresh WSL setup. Once past the restart:

```bash
sudo apt update && sudo apt install -y cron git curl
sudo timedatectl set-timezone Asia/Taipei
sudo systemctl enable --now cron
```

### 4. Node.js in WSL (if step 1's `node -v` failed)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Open a new Ubuntu terminal, then `nvm install --lts`.

### 5. Node.js on Windows (if step 1's `powershell.exe ... node -v` failed)

PowerShell: `winget install OpenJS.NodeJS.LTS`. If a Windows terminal was
already open before this install, the WSL-driven PowerShell calls in this
project re-read the Windows PATH from the registry on every run (see
`run-clock-in.ps1` etc.), so a fresh `node -v` check right after install
should already succeed — no `wsl --shutdown` needed just for this.

### 6. Get the project — clone it on the Windows side, not WSL's own filesystem

Windows' `node.exe` reads this project's files (`node_modules` especially) on
every run. When the project lives on WSL's own filesystem, Windows has to
reach it through `\\wsl.localhost\...`, which is dramatically slower for a
package with this many files — measured 13–25s per run there, versus under
1s when the project lives on a native Windows path. Clone onto the Windows
side and symlink it into the WSL home directory, so every command below and
every later `~/punchapollo` reference still works unchanged:

```bash
win_home="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"
project_dir="$(wslpath -u "$win_home")/punchapollo"
git clone https://github.com/iamS3an/punchapollo.git "$project_dir"
cd "$project_dir" && npm install
ln -s "$project_dir" ~/punchapollo
cd ~/punchapollo
```

From here on, `~/punchapollo` is a symlink to that native path. Both sides
resolve it correctly — WSL reads through it transparently, and `wslpath -w`
run on anything reached through it still returns the native `C:\...` form,
not a UNC path, so `$PSScriptRoot` in the `.ps1` scripts stays native too.
Treat `~/punchapollo` as the project directory for every step from here on.

### 7. Settings — ask the user for these

```bash
cp punch.conf.example punch.conf
```

Ask the user to open their attendance site in their everyday browser and get:
- `SITE_URL`: the page they land on after signing in, with the clock-in
  button (path is optional — `https://host` alone is fine if the site's API
  is reachable there).
- `SIGN_IN_URL`: the sign-in page's address, without its last path segment
  (e.g. without `/Login`).
- Their regular shift as `SHIFT_START`/`SHIFT_END` (`HH:MM`, Taipei time).
  This is what's actually punched by; it doesn't have to match what the
  attendance site has on file. If it differs, a run logs a warning but still
  punches by `punch.conf`'s times. The flexible clock-in hours are still a
  hard limit (a normal-day clock-in due after `FLEX_CLOCK_IN_END` is
  skipped); clock-out has no such limit — a full shift is always honored
  even past `FLEX_CLOCK_OUT_END`, which only caps how far the random delay
  after it can be pushed.

Edit `punch.conf` with those values (don't ask the user to paste the whole
file back to you — ask for the handful of values, or let them edit it
directly), then:

```bash
npm run config:show
```

This must pass with no error before continuing.

### 8. Sign in once, then set the punch location

```bash
npm run session:login
```

An Edge window opens on the sign-in page. The user signs in there by hand.
Expect `authenticated: true` in the output.

Run `npm run location:set` next, as a normal part of every install, not only
when asked — `punch.conf.example`'s default, `PUNCH_METHOD=auto`, already
sends the office's own registered position (like the phone app), falling
back to the network-address check (like the web page's own button) only on
a day the GPS punch was never sent or was refused; until a real location is
set it punches by the network-address check alone. `location:set` lists the
account's punch locations and asks which one to pick, writing only
`GPS_LOCATION_ID` into `punch.conf`: this is interactive input, and if your
shell can't forward it through to the command, ask the user to run
`npm run location:set` themselves and tell you which one they picked. If the
user would rather keep the network-address check only, or use plain `gps`
with no fallback, set `PUNCH_METHOD` to `ip` or `gps` yourself — raise it as
a choice only if they ask.

### 9. Automatic sign-in — default is to skip this

`AUTO_SSO` is off by default and the install is complete without it; move on
to step 10 unless the user explicitly asks for automatic sign-in. Do not
bring it up yourself, suggest it, or set it up on your own initiative — it
means storing the user's password and authenticator secret on disk, so it is
the user's call to make, not yours to offer. If they explicitly ask for it:

- Set `AUTO_SSO=on`, `SSO_DOMAIN`, `SSO_ACCOUNT` in `punch.conf`.
- Have the user prepare the Microsoft account per
  [docs/sign-in.md](docs/sign-in.md#microsoft-account-setup).
- Have the user run these themselves, in their own terminal (hidden input):
  `npm run password:set`, then `npm run totp:set`.
- Then run `npm run session:test` yourself — it tests `AUTO_SSO`
  specifically, from a clean throwaway browser profile — and report the
  result; it must end with `"authenticated": true`.

### 10. Verify and install the schedule

```bash
npm run clock:plan      # reads the site, punches nothing — check the plan makes sense
npm run cron:install    # installs the schedule; re-run after any punch.conf edit
npm run config:show     # confirm the installed schedule
```

### 11. Report to the user

Summarize: what was installed, what `clock:plan` showed for today, whether
`AUTO_SSO` is on, and that `logs/punch.log` records every scheduled run from
now on. Mention that a Windows notification also shows every punch result and
tells them when they need to sign in by hand. Point them at the README's
Troubleshooting table for symptoms like `Cannot connect to Edge` or
`Current IP is not allowed for web punching`.
