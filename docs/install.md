# Installation

A full setup starting from a computer with nothing installed. If Node.js, WSL2,
`cron` and the Taipei timezone are already in place, the quick start in the
[README](../README.md) is enough.

Requirements:

- Windows 10 or 11 with Microsoft Edge
- WSL2 with Ubuntu
- Node.js on **both** sides: Windows runs the punch scripts, because they talk
  to Edge on Windows, and WSL runs `npm` and the schedule
- An account on the attendance site that may punch from the web from this
  computer's network

The Windows user must stay signed in and WSL must be running at punch time.
Locking the screen is fine; sleep, hibernation and shutdown are not.

Steps 1 to 4 prepare the computer and can be skipped where it is already set
up. Commands marked PowerShell run in Windows PowerShell; the rest run in the
Ubuntu (WSL) terminal.

## 1. Node.js on Windows

PowerShell:

```powershell
winget install OpenJS.NodeJS.LTS
```

Close and reopen PowerShell, then check that `node -v` prints a version (18 or
newer). Without `winget`, use the installer from <https://nodejs.org>.

## 2. WSL2 with Ubuntu

PowerShell, as administrator:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if asked, open **Ubuntu** from the Start menu, and create the
Linux user it asks for. `wsl -l -v` in PowerShell should list Ubuntu with
VERSION 2.

## 3. systemd, cron and the timezone in WSL

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

## 4. Node.js and npm in WSL

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
```

Close and reopen the Ubuntu terminal, then:

```bash
nvm install --lts
```

## 5. Check the computer

```bash
node -v && npm -v                 # Node.js and npm in WSL
systemctl is-active cron          # active
date +%Z%z                        # CST+0800
powershell.exe -NoProfile -Command "node -v"   # Node.js on Windows
```

All four must print a result without an error before going on.

## 6. Get the project

Clone it onto the Windows side, not onto WSL's own filesystem, and symlink it
into your WSL home directory. Windows' `node.exe` reads this project's files
on every run; reaching WSL's filesystem from Windows (`\\wsl.localhost\...`)
is dramatically slower for a package with this many files — 13-25 seconds
per run in testing, versus under 1 second from a native Windows path.

```bash
win_home="$(powershell.exe -NoProfile -Command '$env:USERPROFILE' | tr -d '\r')"
project_dir="$(wslpath -u "$win_home")/punchapollo"
git clone https://github.com/iamS3an/punchapollo.git "$project_dir"
cd "$project_dir" && npm install
ln -s "$project_dir" ~/punchapollo
cd ~/punchapollo
```

From here on `~/punchapollo` is a symlink to that native path; every command
below and the schedule installed in step 10 work through it exactly as if it
were a normal directory. `npm install` downloads the one dependency,
`playwright-core`. It does not download a browser; the scripts use the Edge
already on Windows.

## 7. Create your settings

```bash
cp punch.conf.example punch.conf
nano punch.conf
npm run config:show
```

Fill in `SITE_URL` and `SIGN_IN_URL` with the addresses of your attendance
site: sign in to it in your everyday browser and copy them from the address
bar, the first from the page with the clock-in button and the second from the
sign-in page. The times in the example suit a 09:00-18:00 shift; change them to
yours. The [README](../README.md#settings) lists every setting and
[sign-in.md](sign-in.md) explains the sign-in choices. `config:show` repeats what it read
and reports anything it cannot accept.

## 8. Sign in and set your punch location

```bash
npm run session:login
```

An Edge window with a profile of its own opens on the site's sign-in page. Sign
in there the way you normally do. The command prints `authenticated: true` when
it sees the session, and that Edge profile keeps it from then on.

Punching defaults to checking this computer's network address, like the web
page's own button, but sending your office's registered position instead,
like the phone app, is recommended — it doesn't depend on which network this
computer is on:

```bash
npm run location:set
```

It lists your account's punch locations; pick your office. That sets
`PUNCH_METHOD=gps` and `GPS_LOCATION_ID` in `punch.conf` for you. The
[README](../README.md#settings) explains `auto`, which also falls back to
`ip` on a day `gps` doesn't go through.

## 9. Optional: automatic sign-in

Skip this to keep signing in by hand when the session expires. Otherwise set
`AUTO_SSO=on` with your `SSO_DOMAIN` and `SSO_ACCOUNT` in `punch.conf`, prepare
the Microsoft account as in [sign-in.md](sign-in.md#microsoft-account-setup),
and store the password and the authenticator secret. Run these in the Ubuntu
terminal itself, because the input is typed hidden:

```bash
npm run password:set
npm run totp:set
npm run session:test
```

`session:test` tests `AUTO_SSO` specifically: it signs in from a clean
browser and must end with `authenticated: true`.

## 10. Check the plan and install the schedule

```bash
npm run clock:plan      # reads the site and punches nothing
npm run cron:install
```

`clock:plan` should describe today correctly: a normal day, a holiday, or your
leave. `cron:install` prints the schedule it installed. From here on
`logs/punch.log` records every scheduled run.

## Moving to another computer

Copy or clone the project without `node_modules`, `logs`, `punch.conf` and
`.session.json`, then follow the steps above. Do not copy
`%LOCALAPPDATA%\punchapollo`, which holds the Edge profile and the stored
password and TOTP secret; they are protected
for the original Windows account and computer.
