// Entry point of the npm commands: node src/cli.js <command> [argument].
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { describeSchedule } from "./schedule-state.js";
import { runClockIn, runLocationSet, runSessionLogin, runSessionTest, runSetSecret } from "./launch.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER_ID = /^[0-]+$/;

function minutesOf(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function clockTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// The daemon writes a heartbeat, so whether it is alive can be read without
// asking pm2.
function daemonStatus() {
  try {
    const { beatAt } = JSON.parse(readFileSync(join(PROJECT_ROOT, ".daemon.json"), "utf8"));
    return Date.now() - beatAt < 60_000 ? "online" : "not running (last seen " + new Date(beatAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }) + ")";
  } catch {
    return "not running";
  }
}

function showConfig() {
  const config = loadConfig();
  const start = minutesOf(config.shift.start);
  const length = config.shiftLengthMs / 60_000;
  const row = (label, value) => console.log(`${label.padEnd(22)}${value}`);

  console.log(`Settings file: ${join(PROJECT_ROOT, "punch.conf")}\n`);
  row("Site", config.siteUrl);
  row("Sign-in page", config.signInUrl);
  if (config.sso.auto) {
    row("Automatic sign-in", "on");
    row("SSO provider", config.sso.provider);
    row("SSO domain", config.sso.domain);
    row("SSO account", config.sso.account);
  } else {
    row("Automatic sign-in", "off (an expired session waits for you to sign in)");
  }
  if (config.punchMethod === "gps") {
    row("Punch method", `gps (location ${config.gpsLocationId}'s registered position)`);
  } else if (config.punchMethod === "auto" && !config.gpsLocationId) {
    row("Punch method", "auto (no location set yet; punching by ip - run: npm run location:set)");
  } else if (config.punchMethod === "auto") {
    row("Punch method", `auto (gps at location ${config.gpsLocationId}, ip when gps is not made)`);
  } else {
    row("Punch method", "ip (the site checks the network address)");
  }
  row("Shift", `${config.shift.start}-${config.shift.end} (${Math.floor(length / 60)} h ${String(length % 60).padStart(2, "0")} min)`);
  row("Flexible clock-in", `${config.flexClockIn.start}-${config.flexClockIn.end}`);
  row("Flexible clock-out", `${config.flexClockOut.start}-${config.flexClockOut.end}`);
  row("Lunch break", `${config.lunch.start}-${config.lunch.end}\n`);
  row("Regular clock-in", `${config.shift.start}-${clockTime(start + 29)}`);
  row("Regular clock-out", `${clockTime(start + length + 1)}-${clockTime(start + 29 + length + 5)}`);
  row("Daily plan check", `${clockTime(minutesOf(config.flexClockIn.start) - 30)}\n`);

  const status = daemonStatus();
  row("Automation (pm2)", status);
  if (status !== "online") console.log("  Run: npm run daemon:start");
  console.log(`\n${describeSchedule(config).join("\n")}`);
}

const [command, argument] = process.argv.slice(2);

try {
  let result;
  if (command === "config-show") {
    showConfig();
  } else if (command === "clock") {
    loadConfig();
    result = await runClockIn(argument, {
      scheduled: process.env.PUNCH_SCHEDULED === "1",
      planDate: process.argv[4] || process.env.PUNCH_PLAN_DATE || null
    });
    if (argument === "plan" && result.code === 0) {
      console.log(`\n${describeSchedule(loadConfig()).join("\n")}`);
    }
  } else if (command === "session-login") {
    loadConfig();
    result = await runSessionLogin();
  } else if (command === "location-set") {
    loadConfig();
    result = await runLocationSet();
  } else if (command === "session-test") {
    result = await runSessionTest();
  } else if (command === "set-secret" && ["password", "totp"].includes(argument)) {
    result = await runSetSecret(argument);
  } else {
    throw new Error(
      "Usage: cli.js config-show | clock <clock-in|clock-out|plan> | session-login | location-set | session-test | set-secret <password|totp>"
    );
  }
  if (result) process.exitCode = result.code;
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
