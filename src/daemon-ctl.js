// Starts, stops and inspects the daemon under pm2. Always runs on Windows
// node.exe (from PowerShell, or from WSL through interop), so pm2 and the
// daemon behave the same everywhere and keep one state directory.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PM2_JS = join(PROJECT_ROOT, "node_modules", "pm2", "bin", "pm2");
const NAME = "punchapollo";
const BEGIN_MARKER = "# BEGIN PUNCHAPOLLO";
const END_MARKER = "# END PUNCHAPOLLO";

// A project in WSL's home directory is seen from Windows as
// \\wsl.localhost\<distro>\...: it works, only more slowly.
const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\/i.exec(PROJECT_ROOT);
const WSL_DISTRO = WSL_SHARE ? WSL_SHARE[1] : null;

function pm2(...args) {
  const { status } = spawnSync(process.execPath, [PM2_JS, ...args], { stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}

// pm2's entry for this app, or null when it does not know it.
function appEntry() {
  const { stdout } = spawnSync(process.execPath, [PM2_JS, "jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const json = (stdout ?? "").split("\n").reverse().find((line) => line.startsWith("[{") || line === "[]");
    return JSON.parse(json ?? "[]").find((entry) => entry.name === NAME) ?? null;
  } catch {
    return null;
  }
}

// "online", "stopped", ... for this app, or null when pm2 does not know it.
function appStatus() {
  return appEntry()?.pm2_env.status ?? null;
}

// pm2 reads memory through wmic, which newer Windows no longer has, and shows
// 0b there; the daemon's real memory is asked of Windows directly.
function printMemory() {
  const pid = appEntry()?.pid;
  if (!pid) return;
  try {
    const mb = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `[math]::Round((Get-Process -Id ${Number(pid)}).WorkingSet64 / 1MB)`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, windowsHide: true }
    ).trim();
    if (/^\d+$/.test(mb)) console.log(`Daemon memory (pid ${pid}): ${mb} MB`);
  } catch {
    // Informational only.
  }
}

// Starts pm2's background process with no output attached, so a terminal or
// pipe is not held open by it afterwards.
function warmUp() {
  spawnSync(process.execPath, [PM2_JS, "ping"], { stdio: "ignore" });
}

// WSL distros, if WSL is installed. wsl.exe prints UTF-16.
function wslDistros() {
  try {
    const output = execFileSync("wsl.exe", ["-l", "-q"], { stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 });
    return output
      .toString("utf16le")
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name && !name.startsWith("docker-desktop"));
  } catch {
    return [];
  }
}

// Drops the "# BEGIN/END PUNCHAPOLLO" block an older install wrote into a
// distro's crontab, leaving every other entry alone. It would double-punch
// next to the daemon. Returns what happened.
function removeCrontabBlock(distro) {
  const wsl = (args, options = {}) =>
    execFileSync("wsl.exe", ["-d", distro, "--", ...args], { timeout: 30_000, ...options });
  let existing;
  try {
    existing = wsl(["crontab", "-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\r/g, "");
  } catch {
    return "no crontab";
  }
  if (!existing.includes(BEGIN_MARKER)) return "no PUNCHAPOLLO block";

  const kept = [];
  let skipping = false;
  let removed = 0;
  for (const line of existing.split("\n")) {
    if (line === BEGIN_MARKER) skipping = true;
    else if (line === END_MARKER) skipping = false;
    else if (skipping) removed += 1;
    else kept.push(line);
  }
  try {
    wsl(["crontab", "-"], { input: kept.join("\n"), stdio: ["pipe", "ignore", "ignore"] });
    return `removed the PUNCHAPOLLO block (${removed} entries)`;
  } catch {
    return "FAILED to rewrite the crontab; remove the PUNCHAPOLLO block with `crontab -e` by hand";
  }
}

// Cleans every WSL distro of an older install's cron block. Silent when
// there is nothing to do.
function migrate() {
  for (const distro of wslDistros()) {
    const result = removeCrontabBlock(distro);
    if (result.startsWith("removed") || result.startsWith("FAILED")) {
      console.log(`${distro}: ${result}`);
    }
  }
}

const quote = (text) => text.replace(/'/g, "''");

// Brings the saved pm2 processes back after a reboot: a logon task for the
// current Windows user, with no administrator rights. For a project inside
// WSL, the distro is started first and kept up (the project's files live in
// it), which is why that case is slower to come back.
function autostart() {
  const resurrect = `& '${quote(process.execPath)}' '${quote(PM2_JS)}' resurrect`;
  const inner = WSL_DISTRO
    ? `Start-Process wsl.exe -WindowStyle Hidden -ArgumentList '-d','${quote(WSL_DISTRO)}','--','sleep','infinity'; ` +
      `Start-Sleep -Seconds 10; ${resurrect}`
    : resurrect;
  const argument = `-NoProfile -WindowStyle Hidden -Command "${inner.replace(/"/g, '\\"')}"`;
  const script = [
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '${quote(argument)}'`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)",
    `Register-ScheduledTask -TaskName '${NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "inherit" });
  console.log(`Registered the "${NAME}" logon task${WSL_DISTRO ? ` (it starts WSL distro ${WSL_DISTRO} first)` : ""}.`);
}

const command = process.argv[2];
if (command === "start") {
  if (WSL_DISTRO) {
    console.error(
      `Note: this project is inside WSL (${WSL_DISTRO}), so Windows reads it over the network share and runs are slower. ` +
        "Cloning on the Windows side and symlinking it into WSL is faster (see docs/install.md)."
    );
  }
  migrate();
  warmUp();
  const status = appStatus();
  if (status === "online") {
    console.log(`${NAME} is already running; use "npm run daemon:restart" to reload it.`);
  } else if (status !== null) {
    pm2("restart", NAME);
  } else {
    pm2("start", join(PROJECT_ROOT, "src", "daemon.js"), "--name", NAME, "--cwd", PROJECT_ROOT, "--time");
  }
  pm2("save");
} else if (command === "autostart") {
  autostart();
} else if (command === "stop") {
  pm2("stop", NAME);
} else if (command === "restart") {
  pm2("restart", NAME);
} else if (command === "logs") {
  pm2("logs", NAME);
} else if (command === "status") {
  pm2("status");
  printMemory();
} else {
  console.error("Usage: daemon-ctl.js start | autostart | stop | restart | logs | status");
  process.exit(2);
}
