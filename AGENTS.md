# AGENTS.md

This file is a runbook for an AI assistant installing **punchapollo** for its
user on a Windows computer, with or without WSL2. Follow it as a sequence of steps with
explicit commands and success checks, not as background reading. For prose
explanations, [README.md](README.md), [docs/install.md](docs/install.md) and
[docs/sign-in.md](docs/sign-in.md) are the human-facing versions of the same
material; link the user there if they want more context, but drive the
install from this file.

## What this does

Signs in to an attendance site through a dedicated Microsoft Edge
profile on Windows, and clocks in/out on a schedule from a long-running
process (`src/daemon.js`, kept alive by `pm2`). Everything — the daemon, pm2
itself, the scripts — runs on Windows' `node.exe`, because it has to talk to
Edge. The agent may itself be running in plain Windows (PowerShell) or in
WSL2: the commands below are identical, and in WSL the `npm run` commands
just hand over to Windows' `node.exe`. **Work out which one you are in
first** (`uname` succeeds in WSL; PowerShell has no `uname`) — steps marked
*WSL only* are skipped on plain Windows.

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

## Step-by-step

### 1. Check what's already there

```powershell
node -v; git --version                         # plain Windows: Node.js and Git
```

```bash
node -v && npm -v                              # WSL only: Node.js/npm in WSL
powershell.exe -NoProfile -Command "node -v"   # WSL only: Node.js on Windows
wsl.exe -l -v 2>/dev/null | cat                # WSL only: Ubuntu should show VERSION 2
```

Anything that already succeeds, skip the matching step below. On plain
Windows, only Node.js and Git matter (step 4 and, if missing, `winget install
Git.Git`).

### 2. WSL only: WSL2 + Ubuntu (if step 1's `wsl -l -v` didn't show it)

PowerShell, as administrator: `wsl --install -d Ubuntu`, restart if asked,
open Ubuntu from the Start menu once to create the Linux user.

### 3. WSL only: Node.js in WSL (if step 1's `node -v` failed)

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Open a new Ubuntu terminal, then `nvm install --lts`.

### 4. Node.js on Windows (if step 1's `powershell.exe ... node -v` failed)

PowerShell: `winget install OpenJS.NodeJS.LTS`. A terminal that was already
open before this install keeps its old PATH; open a new one (WSL: a new Ubuntu
terminal) before checking
`node -v` again.

### 5. Get the project

**Plain Windows:** clone anywhere and install, then treat that directory as
the project directory for every step from here on:

```powershell
git clone https://github.com/iamS3an/punchapollo.git
cd punchapollo
npm install
```

**WSL only — prefer cloning on the Windows side, but WSL's home works too.**
Windows' `node.exe` reads this project's files (`node_modules` especially) on
every run. When the project lives on WSL's own filesystem, Windows has to
reach it through `\\wsl.localhost\...`, which is dramatically slower for a
package with this many files — measured 13–25s per run there, versus under
1s when the project lives on a native Windows path. Default to cloning onto
the Windows side and symlinking it into the WSL home directory, so every
command below and every later `~/punchapollo` reference still works
unchanged. If the user would rather keep it entirely in WSL's home directory,
that is supported: plain `git clone` + `npm install` there, same commands,
just slower (`daemon:register` then also starts the distro at logon). Don't
insist on the symlink; mention the speed trade-off once and follow their
choice:

```bash
win_home="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"
project_dir="$(wslpath -u "$win_home")/punchapollo"
git clone https://github.com/iamS3an/punchapollo.git "$project_dir"
cd "$project_dir" && npm install
ln -s "$project_dir" ~/punchapollo
cd ~/punchapollo
```

From here on, `~/punchapollo` is a symlink to that native path, so Windows
still sees a native `C:\...` project and WSL reads through it transparently.
Treat `~/punchapollo` as the project directory for every step from here on.
Running `npm run daemon:start` again later is harmless.

### 6. Settings — ask the user for these

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

### 7. Sign in once, then set the punch location

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

### 8. Automatic sign-in — default is to skip this

`AUTO_SSO` is off by default and the install is complete without it; move on
to step 9 unless the user explicitly asks for automatic sign-in. Do not
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

### 9. Verify and start the daemon

```bash
npm run clock:plan      # reads the site, punches nothing — check the plan makes sense
npm run daemon:start    # starts src/daemon.js under pm2; restart it after any punch.conf edit
npm run config:show     # confirm the daemon shows as "online" and what it has scheduled
```

```bash
npm run daemon:register   # brings the daemon back after a reboot
```

`daemon:register` needs no administrator rights or `sudo`: it registers a
logon task for the Windows user, from either PowerShell or WSL.
`daemon:unregister` removes that task again (it leaves a running daemon alone).

If this machine had an older install with `npm run cron:install` already run
in WSL, `daemon:start` first removes that old crontab block from every WSL
distro (through `wsl.exe`), leaving unrelated entries alone, and prints a line
for each one it cleaned. There is no separate migration step.

### 10. Report to the user

Summarize: what was installed, what `clock:plan` showed for today, whether
`AUTO_SSO` is on, and that `logs/punch.log` records every scheduled run from
now on. Mention that a Windows notification also shows every punch result and
tells them when they need to sign in by hand, and that `npm run daemon:logs`
tails the daemon's own output live. Point them at the README's
Troubleshooting table for symptoms like `Cannot connect to Edge` or
`Current IP is not allowed for web punching`.
