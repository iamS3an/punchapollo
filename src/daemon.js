// A long-lived process (kept alive by pm2) that decides when to clock in and
// out and runs the same launcher the manual npm commands use.
// It runs on Windows node.exe, under a pm2 that also runs on Windows.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { computeDayPlan, pickClockInTime, pickClockOutTime } from "./day-plan.js";
import { runClockIn } from "./launch.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(PROJECT_ROOT, "logs", "punch.log");
const HEARTBEAT_PATH = join(PROJECT_ROOT, ".daemon.json");
const HEARTBEAT_INTERVAL_MS = 10_000;
// A heartbeat this old means the daemon holding it is gone.
const HEARTBEAT_STALE_MS = 35_000;
// Half an hour before the flexible clock-in hours open (06:30 by default):
// late enough that overnight leave is filed, early enough to still be well before the earliest possible clock-in.
const PLAN_CHECK_LEAD_MS = 30 * 60_000;
// While waiting for the plan check, punch.conf is read again this often, so
// an edit made overnight still shapes the same day.
const CONFIG_RECHECK_MS = 10 * 60_000;
const CONFIG_RETRY_MS = 5 * 60_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sleepUntil(whenMs) {
  const wait = whenMs - Date.now();
  if (wait > 0) await sleep(wait);
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, stamped + "\n");
  } catch {
    // Logging is best-effort; a write failure must not stop the daemon.
  }
}

function taipeiDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), weekday: values.weekday };
}

function dateText({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function taipeiTime(milliseconds) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).format(new Date(milliseconds));
}

function isWeekday(weekdayShort) {
  return weekdayShort !== "Sat" && weekdayShort !== "Sun";
}

// Taipei has no DST, but anchoring at noon before adding a day keeps this
// correct even if that ever changes.
function nextDateText(today) {
  const noon = Date.parse(`${today}T12:00:00+08:00`);
  return dateText(taipeiDateParts(new Date(noon + 24 * 3_600_000)));
}

function timeRange(today, { start, end }) {
  return { start: Date.parse(`${today}T${start}:00+08:00`), end: Date.parse(`${today}T${end}:00+08:00`) };
}

function parseJson(text) {
  try {
    return JSON.parse((text ?? "").replace(/\r/g, ""));
  } catch {
    return null;
  }
}

// Runs one action through the same launcher as the npm commands and reads
// back the JSON it prints.
async function runAction(action, { planDate = null } = {}) {
  try {
    const { code, stdout, stderr } = await runClockIn(action, { scheduled: true, planDate, capture: true });
    const json = parseJson(stdout);
    if (code === 0) return { json };
    return { json, error: new Error(`exit code ${code}: ${stderr.trim()}`) };
  } catch (error) {
    return { json: null, error };
  }
}

// Waits for dueAtMs, runs the action, and follows a "not yet due" reply to
// the dueAt it reports.
async function waitAndRun(action, dueAtMs, today) {
  for (;;) {
    await sleepUntil(dueAtMs);
    log(`Running scheduled ${action} for ${today}.`);
    const { json, error } = await runAction(action);
    if (json) {
      log(JSON.stringify(json));
      if (json.skipped && json.reason === "not-due" && json.dueAt) {
        dueAtMs = Date.parse(json.dueAt);
        continue;
      }
    } else {
      log(`Scheduled ${action} failed: ${error?.message ?? "no output was read"}`);
    }
    return;
  }
}

// Figures out today's clock-in/clock-out times and waits each one out: a
// random time near the shift on a normal day, the plan's own
// clockInDueAt/clockOutDueAt on a leave day.
// punch.conf as it is right now. An invalid file is waited out rather than
// fatal: the daemon keeps trying until it has been fixed.
async function currentConfig() {
  for (;;) {
    try {
      return loadConfig();
    } catch (error) {
      log(`${error.message} Fix punch.conf; trying again in ${CONFIG_RETRY_MS / 60_000} minutes.`);
      await sleep(CONFIG_RETRY_MS);
    }
  }
}

async function processToday() {
  const today = dateText(taipeiDateParts());
  let config;
  for (;;) {
    config = await currentConfig();
    const checkAt = timeRange(today, config.flexClockIn).start - PLAN_CHECK_LEAD_MS;
    const wait = checkAt - Date.now();
    if (wait <= 0) break;
    await sleep(Math.min(wait, CONFIG_RECHECK_MS));
  }

  // A transient network blip here (seen in practice) would otherwise skip
  // the whole day, since there is no earlier time to fall back to; retry a
  // few times before actually giving up.
  log(`Reading today's plan (${today}).`);
  let plan = null;
  let lastError = null;
  for (let attempt = 1; attempt <= 3 && !plan; attempt += 1) {
    const result = await runAction("plan", { planDate: today });
    plan = result.json;
    lastError = result.error;
    if (!plan && attempt < 3) {
      log(`Reading today's plan failed (${lastError?.message ?? "no output"}); retrying in 60s.`);
      await sleep(60_000);
    }
  }
  if (!plan) {
    log(`Could not read today's plan (${lastError?.message ?? "no output"}); nothing scheduled for ${today}.`);
    return;
  }

  if (plan.type === "off") {
    log(`${today}: ${plan.reason ?? "no work today"}; nothing to schedule.`);
    return;
  }

  let clockInAt = null;
  let clockOutAt = null;

  if (plan.type === "leave-at-start" || plan.type === "leave-at-end") {
    clockInAt = plan.clockInDueAt ? Date.parse(plan.clockInDueAt) : null;
    clockOutAt = plan.clockOutDueAt ? Date.parse(plan.clockOutDueAt) : null;
  } else if (plan.type === "normal") {
    const flex = { clockIn: timeRange(today, config.flexClockIn), clockOut: timeRange(today, config.flexClockOut) };
    const lunch = timeRange(today, config.lunch);
    const shift = timeRange(today, config.shift);
    clockInAt = plan.hasClockIn
      ? Date.parse(plan.clockInAt)
      : pickClockInTime(
          computeDayPlan({ shiftStart: shift.start, shiftEnd: shift.end, leaves: [], lunch, flex, clockInAt: null }),
          Date.now()
        );
    if (!plan.hasClockOut) {
      clockOutAt = pickClockOutTime(
        computeDayPlan({ shiftStart: shift.start, shiftEnd: shift.end, leaves: [], lunch, flex, clockInAt }),
        Date.now()
      );
    }
  } else {
    // leave-plan-missed or anything unrecognized: clock-in.js's own guards
    // already leave these to be punched by hand.
    log(`${today}: plan type "${plan.type}" is left to punch by hand.`);
    return;
  }

  log(
    `${today} (${plan.type}): ` +
      (plan.hasClockIn ? `clock-in already done at ${taipeiTime(Date.parse(plan.clockInAt))}` : `clock-in planned for ${taipeiTime(clockInAt)}`) +
      "; " +
      (plan.hasClockOut
        ? "clock-out already done"
        : clockOutAt
          ? `clock-out planned for ${taipeiTime(clockOutAt)}`
          : "no clock-out planned")
  );

  if (clockInAt && !plan.hasClockIn) await waitAndRun("clock-in", clockInAt, today);
  if (clockOutAt && !plan.hasClockOut) await waitAndRun("clock-out", clockOutAt, today);
}

function readHeartbeat() {
  try {
    return JSON.parse(readFileSync(HEARTBEAT_PATH, "utf8"));
  } catch {
    return null;
  }
}

// Only one daemon may act, even if two get started (a second pm2 state, a
// stray manual run): the heartbeat file is the claim, and a second daemon
// stands by until the first one's heartbeat goes stale.
async function acquireLock(startedAt) {
  let announced = false;
  for (;;) {
    const current = readHeartbeat();
    if (!current || current.pid === process.pid || Date.now() - current.beatAt > HEARTBEAT_STALE_MS) {
      writeFileSync(HEARTBEAT_PATH, JSON.stringify({ pid: process.pid, startedAt, beatAt: Date.now() }));
      await sleep(2_000);
      if (readHeartbeat()?.pid === process.pid) return;
      continue;
    }
    if (!announced) {
      log(`Another daemon (pid ${current.pid}) is already running; standing by.`);
      announced = true;
    }
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
}

async function main() {
  const startedAt = Date.now();
  await acquireLock(startedAt);
  const beat = () => {
    const current = readHeartbeat();
    if (current && current.pid !== process.pid) {
      log("Another daemon took over; exiting.");
      process.exit(0);
    }
    writeFileSync(HEARTBEAT_PATH, JSON.stringify({ pid: process.pid, startedAt, beatAt: Date.now() }));
  };
  setInterval(beat, HEARTBEAT_INTERVAL_MS);
  const release = () => {
    if (readHeartbeat()?.pid === process.pid) rmSync(HEARTBEAT_PATH, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", release);
  process.on("SIGTERM", release);
  log("punchapollo daemon started.");
  for (;;) {
    const today = taipeiDateParts();
    if (isWeekday(today.weekday)) {
      await processToday();
    } else {
      log(`${dateText(today)} is a weekend; nothing to schedule.`);
    }
    const wakeAt = Date.parse(`${nextDateText(dateText(today))}T00:05:00+08:00`);
    await sleepUntil(wakeAt);
  }
}

// Anything unexpected ends the process outright (the heartbeat timer would
// otherwise keep a dead loop looking alive) and releases the claim, so pm2
// restarts it or a standby daemon takes over.
main().catch((error) => {
  log(`FATAL: ${error.stack ?? error.message}`);
  if (readHeartbeat()?.pid === process.pid) rmSync(HEARTBEAT_PATH, { force: true });
  process.exit(1);
});
