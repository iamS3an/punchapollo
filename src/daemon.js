// A long-lived process (kept alive by pm2) that decides when to clock in and
// out and runs the same launcher the manual npm commands use.
// It runs on Windows node.exe, under a pm2 that also runs on Windows.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { computeDayPlan, pickClockInTime, pickClockOutTime } from "./day-plan.js";
import { runClockIn } from "./launch.js";
import {
  PLAN_CHECK_LEAD_MS,
  dateText,
  isWeekday,
  nextDateText,
  nextPlanCheck,
  taipeiDateParts,
  taipeiTime,
  timeRange,
  writeSchedule
} from "./schedule-state.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(PROJECT_ROOT, "logs", "punch.log");
const HEARTBEAT_PATH = join(PROJECT_ROOT, ".daemon.json");
const HEARTBEAT_INTERVAL_MS = 10_000;
// A heartbeat this old means the daemon holding it is gone.
const HEARTBEAT_STALE_MS = 35_000;
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
// the dueAt it reports. `entry` is this action's line in the schedule file.
async function waitAndRun(action, dueAtMs, today, entry, save) {
  for (;;) {
    entry.state = "planned";
    entry.at = dueAtMs;
    entry.detail = undefined;
    save();
    await sleepUntil(dueAtMs);
    log(`Running scheduled ${action} for ${today}.`);
    const { json, error } = await runAction(action);
    if (json) {
      log(JSON.stringify(json));
      if (json.skipped && json.reason === "not-due" && json.dueAt) {
        dueAtMs = Date.parse(json.dueAt);
        continue;
      }
      if (json.skipped) {
        entry.state = "skipped";
        entry.detail = json.reason;
      } else {
        entry.state = "done";
        entry.at = json.punchDate ? Date.parse(json.punchDate) : Date.now();
      }
    } else {
      log(`Scheduled ${action} failed: ${error?.message ?? "no output was read"}`);
      entry.state = "failed";
      entry.detail = error?.message?.split("\n")[0];
    }
    save();
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
  const schedule = { date: today, type: "pending", clockIn: null, clockOut: null };
  const save = () => writeSchedule(schedule);
  let config;
  for (;;) {
    config = await currentConfig();
    schedule.checkAt = timeRange(today, config.flexClockIn).start - PLAN_CHECK_LEAD_MS;
    save();
    const wait = schedule.checkAt - Date.now();
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
    schedule.type = "unknown";
    schedule.reason = "the plan could not be read";
    schedule.nextCheckAt = nextPlanCheck(config);
    save();
    return;
  }

  if (plan.type === "off") {
    log(`${today}: ${plan.reason ?? "no work today"}; nothing to schedule.`);
    schedule.type = "off";
    schedule.reason = plan.reason;
    schedule.nextCheckAt = nextPlanCheck(config);
    save();
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
    schedule.type = "off";
    schedule.reason = `${plan.type}; punch by hand`;
    schedule.nextCheckAt = nextPlanCheck(config);
    save();
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

  schedule.type = plan.type;
  schedule.clockIn = plan.hasClockIn
    ? { state: "done", at: Date.parse(plan.clockInAt) }
    : clockInAt
      ? { state: "planned", at: clockInAt }
      : { state: "none", detail: "nothing to punch automatically" };
  schedule.clockOut = plan.hasClockOut
    ? { state: "done" }
    : clockOutAt
      ? { state: "planned", at: clockOutAt }
      : { state: "none", detail: "nothing to punch automatically" };
  save();

  if (clockInAt && !plan.hasClockIn) await waitAndRun("clock-in", clockInAt, today, schedule.clockIn, save);
  if (clockOutAt && !plan.hasClockOut) await waitAndRun("clock-out", clockOutAt, today, schedule.clockOut, save);
  schedule.nextCheckAt = nextPlanCheck(config);
  save();
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
      writeSchedule({
        date: dateText(today),
        type: "weekend",
        nextCheckAt: nextPlanCheck(await currentConfig())
      });
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
