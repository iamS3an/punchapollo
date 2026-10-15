# Installation

A full setup starting from a computer with nothing installed. If Node.js is
already in place, the quick start in the [README](../README.md) is enough.

There are two ways to run it, with the same commands: from plain Windows
(PowerShell), or from WSL. WSL is optional; steps 2 and 3 are only for it.

Requirements:

- Windows 10 or 11 with Microsoft Edge, and Node.js and Git on Windows: the
  scripts and the scheduler always run there, because they talk to Edge
- Optional, to type the commands in WSL: WSL2 with Ubuntu and Node.js inside
  it, only so `npm run` works there - pm2 and everything it runs stay on
  Windows
- An account on the attendance site that may punch from the web from this
  computer's network

The Windows user must stay signed in at punch time.
Locking the screen is fine; sleep, hibernation and shutdown are not.

Steps 1 to 3 prepare the computer and can be skipped where it is already set
up. Commands marked PowerShell run in Windows PowerShell; the rest run in
whichever terminal you chose - PowerShell, or Ubuntu if you use WSL.

## 1. Node.js on Windows

PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell, then check that `node -v` prints a version (18 or
newer). Without `winget`, use the installer from <https://nodejs.org>.

## 2. Optional: WSL2 with Ubuntu

PowerShell, as administrator:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if asked, open **Ubuntu** from the Start menu, and create the
Linux user it asks for. `wsl -l -v` in PowerShell should list Ubuntu with
VERSION 2.

## 3. Optional: Node.js and npm in WSL

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Close and reopen the Ubuntu terminal, then:

```bash
nvm install --lts
```

## 4. Check the computer

```powershell
node -v; git --version            # Node.js (18 or newer) and Git on Windows
```

With WSL, also check, in Ubuntu:

```bash
node -v && npm -v                 # Node.js and npm in WSL
powershell.exe -NoProfile -Command "node -v"   # Node.js on Windows
```

Each must print a result without an error before going on.

## 5. Get the project

On plain Windows, clone it anywhere and install in PowerShell:

```powershell
git clone https://github.com/iamS3an/punchapollo.git
cd punchapollo
npm install
```

From WSL, there are two places to put it, and both work:

- **On the Windows side, symlinked into WSL (recommended).** Windows'
  `node.exe` reads this project's files on every run. From a native Windows
  path that takes under a second; reaching WSL's own filesystem from Windows
  (`\\wsl.localhost\...`) was 13-25 seconds per run in testing.
- **Directly in WSL's home directory.** Fine if you would rather keep
  everything in WSL: just `git clone` and `npm install` there. It is slower,
  and `npm run daemon:autostart` then also starts the WSL distro and keeps it
  up at logon, since the project's files live inside it.

The Windows-side install, with the symlink:

```bash
win_home="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"
project_dir="$(wslpath -u "$win_home")/punchapollo"
git clone https://github.com/iamS3an/punchapollo.git "$project_dir"
cd "$project_dir" && npm install
ln -s "$project_dir" ~/punchapollo
cd ~/punchapollo
```

From here on `~/punchapollo` is a symlink to that native path; every command
below and the scheduler started in step 9 work through it exactly as if it
were a normal directory (in a clone inside WSL's home directory, the same
commands work as they are). `npm install` downloads the one dependency,
`playwright-core`. It does not download a browser; the scripts use the Edge
already on Windows.

## 6. Create your settings

```bash
cp punch.conf.example punch.conf   # PowerShell: Copy-Item punch.conf.example punch.conf
nano punch.conf                   # or open it in any editor
npm run config:show
```

Fill in `SITE_URL` and `SIGN_IN_URL` with the addresses of your attendance
site: sign in to it in your everyday browser and copy them from the address
bar, the first from the page with the clock-in button and the second from the
sign-in page. The times in the example suit a 09:00-18:00 shift; change them to
yours. The [README](../README.md#settings) lists every setting and
[sign-in.md](sign-in.md) explains the sign-in choices. `config:show` repeats what it read
and reports anything it cannot accept.

## 7. Sign in and set your punch location

```bash
npm run session:login
```

An Edge window with a profile of its own opens on the site's sign-in page. Sign
in there the way you normally do. The command prints `authenticated: true` when
it sees the session, and that Edge profile keeps it from then on.

Punching defaults to `auto`: sending your office's registered position, like
the phone app, and falling back to checking this computer's network address,
like the web page's own button, on a day the GPS punch doesn't go through.
Until you pick an office, it punches by the network address alone:

```bash
npm run location:set
```

It lists your account's punch locations; pick your office. That sets
`GPS_LOCATION_ID` in `punch.conf` for you. The
[README](../README.md#settings) explains plain `gps`, with no such fallback,
if you'd rather have that instead.

## 8. Optional: automatic sign-in

Skip this to keep signing in by hand when the session expires. Otherwise set
`AUTO_SSO=on` with your `SSO_DOMAIN` and `SSO_ACCOUNT` in `punch.conf`, prepare
the Microsoft account as in [sign-in.md](sign-in.md#microsoft-account-setup),
and store the password and the authenticator secret. Run these in the
terminal itself, because the input is typed hidden:

```bash
npm run password:set
npm run totp:set
npm run session:test
```

`session:test` tests `AUTO_SSO` specifically: it signs in from a clean
browser and must end with `authenticated: true`.

## 9. Check the plan and start the daemon

```bash
npm run clock:plan      # reads the site and punches nothing
npm run daemon:start    # starts the scheduler, kept alive by pm2
```

`clock:plan` should describe today correctly: a normal day, a holiday, or your
leave. `npm run config:show` should then show the daemon as `online`. From
here on `logs/punch.log` records every scheduled run, and
`npm run daemon:logs` tails the daemon's own output live. Running
`daemon:start` again is harmless: it reports that the daemon is already
running (or restarts it if it was stopped).

To bring it back after a reboot, run `npm run daemon:autostart` once. It
registers a logon task for your Windows user, with no administrator rights
needed, from PowerShell or WSL alike.

If you ran an older version's `npm run cron:install` in WSL before,
`daemon:start` first removes that old crontab block from every WSL distro
(through `wsl.exe`) and prints a line for each one it cleaned. Unrelated
crontab entries are left alone, and there is no separate migration step.

## Moving to another computer

Copy or clone the project without `node_modules`, `logs`, `punch.conf` and
`.session.json`, then follow the steps above. Do not copy
`%LOCALAPPDATA%\punchapollo`, which holds the Edge profile and the stored
password and TOTP secret; they are protected
for the original Windows account and computer.
