import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  computeDayPlan,
  EXACT_PUNCH_MAX_WAIT_MS,
  pickClockInTime,
  pickClockOutTime
} from "./day-plan.js";
import { loadConfig } from "./config.js";
import { dayOffReason, getSchedule } from "./leave-check.js";
import { notifyWindows, taipeiClock } from "./notify.js";
import { punchByApi, punchByGps } from "./punch-api.js";
import { clearSession, loadSession, saveSessionFromPage } from "./session-store.js";
import { isAuthenticated, signIn } from "./sso-login.js";
import { cookieTransport } from "./transport.js";
import { getTodayWorkRecord } from "./work-record-check.js";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDP_URL = process.env.EDGE_CDP_URL ?? "http://localhost:9222";
const { siteUrl: APP_URL, siteOrigin: APP_ORIGIN, punchMethod: PUNCH_METHOD, gpsLocationId } = loadConfig();
const LOGIN_TIMEOUT_MS = numberFromEnv("LOGIN_TIMEOUT_MS", 10 * 60 * 1000);
const PAGE_LOAD_TIMEOUT_MS = numberFromEnv("PAGE_LOAD_TIMEOUT_MS", 90_000);
const SUBMIT_TIMEOUT_MS = numberFromEnv("SUBMIT_TIMEOUT_MS", 60_000);
const EDGE_READY_TIMEOUT_MS = numberFromEnv("EDGE_READY_TIMEOUT_MS", 60_000);
const REQUESTED_ACTION = process.env.PUNCH_ACTION;
// Scheduled runs wait for the planned time; manual runs punch immediately.
const SCHEDULED = process.env.PUNCH_SCHEDULED === "1";
// The plan action can look at another day (YYYY-MM-DD); empty means today.
const PLAN_DATE = process.env.PUNCH_PLAN_DATE || null;

if (PLAN_DATE !== null && !/^\d{4}-\d{2}-\d{2}$/.test(PLAN_DATE)) {
  throw new Error(`Invalid PUNCH_PLAN_DATE: ${PLAN_DATE}`);
}

if (!["clock-in", "clock-out", "plan"].includes(REQUESTED_ACTION)) {
  throw new Error(`Invalid PUNCH_ACTION: ${REQUESTED_ACTION}`);
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function edgeIsReady() {
  try {
    const response = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// Starts the dedicated Edge profile if it is not already running. This is
// the only reason signing in ever needs the browser.
async function ensureEdgeRunning() {
  if (await edgeIsReady()) return;
  console.error("Edge DevTools is unavailable; starting the dedicated Edge profile.");
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(PROJECT_ROOT, "start-edge.ps1"),
    "-Url",
    APP_URL
  ]);
  const deadline = Date.now() + EDGE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await edgeIsReady()) return;
    await sleep(2_000);
  }
  throw new Error(`Edge did not become ready within ${Math.round(EDGE_READY_TIMEOUT_MS / 1000)} seconds.`);
}

async function connectToEdge() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await chromium.connectOverCDP(CDP_URL, { timeout: 15_000 });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 2_000);
    }
  }
  throw new Error(`Cannot connect to Edge at ${CDP_URL}: ${lastError.message}`);
}

async function loadApp(page) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.goto(APP_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(attempt * 3_000);
    }
  }
  throw new Error(`The site did not load after 3 attempts: ${lastError.message}`);
}

// The only path that ever opens Edge: makes sure it is running, reuses or
// makes the sign-in, and saves the cookie a direct request needs to act as
// that page from then on.
async function signInAndSaveSession() {
  await ensureEdgeRunning();
  const browser = await connectToEdge();
  try {
    const context = browser.contexts()[0];
    if (!context) throw new Error("Edge has no browser context.");
    const page =
      context.pages().find((candidate) => candidate.url().startsWith(APP_ORIGIN)) ??
      (await context.newPage());
    if (!page.url().startsWith(APP_ORIGIN)) await loadApp(page);
    if (!(await isAuthenticated(page))) await signIn(page, LOGIN_TIMEOUT_MS);
    return await saveSessionFromPage(page);
  } finally {
    // Disconnects this CDP connection only; Edge itself keeps running.
    await browser.close().catch(() => {});
  }
}

// A cookie-only transport, signing in through Edge first when there is no
// saved session yet.
async function getTransport() {
  const saved = loadSession();
  return cookieTransport(saved ?? (await signInAndSaveSession()));
}

// A GPS punch that was never sent, or that the site refused outright, leaves
// nothing recorded; anything less certain must not be followed by another punch.
function gpsPunchNotMade(error) {
  if (error.code === "AUTH_REQUIRED") return false;
  if (!error.submitted) return true;
  return error.code === "API_ERROR" && error.status >= 400 && error.status < 500;
}

function printSkipped(action, date, reason, details = {}) {
  console.log(JSON.stringify({ action, skipped: true, reason, date, ...details }, null, 2));
  const extra = Object.entries(details)
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  notifyWindows(`Punchapollo: ${action} skipped`, `${reason} (${date})${extra ? " - " + extra : ""}`);
}

// Taipei time with its offset, e.g. 2026-01-05T09:00:00+08:00. Rounded up to
// the whole second so a one-off entry never fires before the time is due.
function isoTime(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  return `${new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 19)}+08:00`;
}

async function main() {
  let transport = await getTransport();

  // A 401/403 means the saved cookie has expired: sign in again through
  // Edge, save the fresh cookie, and retry only the operation that failed -
  // every call after that reuses the new transport too.
  async function withAuth(operation) {
    try {
      return await operation(transport);
    } catch (error) {
      if (error.code !== "AUTH_REQUIRED") throw error;
      clearSession();
      transport = cookieTransport(await signInAndSaveSession());
      return operation(transport);
    }
  }

  const workRecord = await withAuth((t) => getTodayWorkRecord(t, PAGE_LOAD_TIMEOUT_MS));
  // Punch records only exist for today; another day is planned from scratch.
  const planDate = PLAN_DATE ?? workRecord.date;
  const punches =
    planDate === workRecord.date ? workRecord : { hasClockIn: false, hasClockOut: false, clockInAt: null };
  const loadPlan = async () => {
    const schedule = await withAuth((t) => getSchedule(t, PAGE_LOAD_TIMEOUT_MS, planDate));
    const offReason = dayOffReason(schedule);
    const plan = offReason ? { type: "off" } : computeDayPlan({ ...schedule, clockInAt: punches.clockInAt });
    return { plan, offReason: offReason ?? (plan.type === "off" ? "leave-detected" : null) };
  };
  const now = Date.now();

  if (REQUESTED_ACTION === "plan") {
    const { plan, offReason } = await loadPlan();
    const special = plan.type === "leave-at-start" || plan.type === "leave-at-end";
    const clockInMissed = special && now > plan.clockIn.deadline;
    const clockOutMissed = special && plan.clockOutLatest !== null && now > plan.clockOutLatest;
    console.log(
      JSON.stringify(
        {
          action: "plan",
          date: planDate,
          type: plan.type,
          reason: offReason,
          scheduled: SCHEDULED,
          hasClockIn: punches.hasClockIn,
          hasClockOut: punches.hasClockOut,
          clockInAt: punches.hasClockIn ? isoTime(punches.clockInAt) : null,
          clockInWindow: plan.clockIn
            ? {
                earliest: isoTime(plan.clockIn.earliest),
                latest: isoTime(plan.clockIn.latest),
                exact: plan.clockIn.exact === true
              }
            : null,
          clockOutEarliest: plan.clockOutEarliest ? isoTime(plan.clockOutEarliest) : null,
          // Only leave days need entries beyond the regular schedule.
          clockInDueAt:
            special && !punches.hasClockIn && !clockInMissed ? isoTime(pickClockInTime(plan, now)) : null,
          clockOutDueAt:
            special && !punches.hasClockOut && !clockOutMissed && plan.clockOutEarliest <= plan.latestPunch
              ? isoTime(pickClockOutTime(plan, now))
              : null
        },
        null,
        2
      )
    );
    return;
  }

  if (REQUESTED_ACTION === "clock-in") {
    if (workRecord.hasClockIn) {
      printSkipped(REQUESTED_ACTION, workRecord.date, "already-clocked-in");
      return;
    }
    const { plan, offReason } = await loadPlan();
    if (offReason) {
      printSkipped(REQUESTED_ACTION, workRecord.date, offReason);
      return;
    }
    // On a leave day a clock-in after the planned time would make the day
    // short, so it is left to be made by hand.
    if (SCHEDULED && plan.type !== "normal" && now > plan.clockIn.deadline) {
      printSkipped(REQUESTED_ACTION, workRecord.date, "planned-time-missed", {
        plannedBefore: isoTime(plan.clockIn.deadline)
      });
      return;
    }
    if (SCHEDULED && plan.type === "normal" && now > plan.latestNormalClockIn) {
      printSkipped(REQUESTED_ACTION, workRecord.date, "outside-flexible-hours");
      return;
    }
    if (SCHEDULED && now < plan.clockIn.earliest) {
      const wait = plan.clockIn.earliest - Date.now();
      if (!plan.clockIn.exact || wait > EXACT_PUNCH_MAX_WAIT_MS) {
        printSkipped(REQUESTED_ACTION, workRecord.date, "not-due", {
          dueAt: isoTime(pickClockInTime(plan, now))
        });
        return;
      }
      console.error(`Waiting ${Math.ceil(wait / 1000)} seconds to clock in exactly on time.`);
      await sleep(Math.max(0, wait));
    }
  }

  if (REQUESTED_ACTION === "clock-out") {
    if (!workRecord.hasClockIn) {
      printSkipped(REQUESTED_ACTION, workRecord.date, "no-clock-in-record");
      return;
    }
    if (workRecord.hasClockOut) {
      printSkipped(REQUESTED_ACTION, workRecord.date, "already-clocked-out");
      return;
    }
    if (SCHEDULED) {
      // Without a rule that gives the right time, no clock-out is made.
      const { plan } = await loadPlan();
      if (!plan.clockIn) {
        printSkipped(REQUESTED_ACTION, workRecord.date, "no-plan-for-day", { type: plan.type });
        return;
      }
      // Leave ended the day earlier; a punch now would record a wrong time.
      if (plan.clockOutLatest !== null && now > plan.clockOutLatest) {
        printSkipped(REQUESTED_ACTION, workRecord.date, "planned-time-missed", {
          plannedBefore: isoTime(plan.clockOutLatest)
        });
        return;
      }
      // No upper bound here: a full shift is always honored even past
      // FLEX_CLOCK_OUT_END. The flexible hours only shape pickClockOutTime's
      // random delay, which already clamps itself to that end.
      if (now < plan.clockOutEarliest) {
        printSkipped(REQUESTED_ACTION, workRecord.date, "not-due", {
          dueAt: isoTime(pickClockOutTime(plan, now))
        });
        return;
      }
    }
  }

  const punchByIp = () => withAuth((t) => punchByApi(t, REQUESTED_ACTION, SUBMIT_TIMEOUT_MS));
  let result;
  if (PUNCH_METHOD === "ip" || !gpsLocationId) {
    result = await punchByIp();
  } else {
    try {
      result = await withAuth((t) => punchByGps(t, REQUESTED_ACTION, gpsLocationId, SUBMIT_TIMEOUT_MS));
    } catch (error) {
      if (PUNCH_METHOD !== "auto" || !gpsPunchNotMade(error)) throw error;
      console.error(`GPS punch was not made (${error.message}); punching by IP instead.`);
      // A refused punch records nothing, but a second punch is only made
      // once the record confirms it.
      const record = await withAuth((t) => getTodayWorkRecord(t, PAGE_LOAD_TIMEOUT_MS));
      if (REQUESTED_ACTION === "clock-in" ? record.hasClockIn : record.hasClockOut) {
        printSkipped(REQUESTED_ACTION, record.date, `already-${REQUESTED_ACTION === "clock-in" ? "clocked-in" : "clocked-out"}`);
        return;
      }
      result = await punchByIp();
    }
  }
  console.log(JSON.stringify({ ...result, skipped: false }, null, 2));
  const punchTime = Date.parse(result.punchDate);
  // The API's own locationName already says "web punch" or the real office
  // for ip and gps alike - no need to also spell out the method.
  const label = result.locationName || "網頁打卡";
  const primary = `${Number.isFinite(punchTime) ? taipeiClock(punchTime) : taipeiClock()}/${label}`;
  // A clock-out's own time means little without when the day started.
  const extra = [
    result.reason,
    REQUESTED_ACTION === "clock-out" && workRecord.hasClockIn ? `clocked in ${taipeiClock(workRecord.clockInAt)}` : null
  ]
    .filter(Boolean)
    .join(", ");
  notifyWindows(`Punchapollo: ${REQUESTED_ACTION} succeeded`, extra ? `${primary} (${extra})` : primary);
}

// A safety net: nothing here is expected to leave a handle open once main()
// settles, but if one ever does, cron must not hang forever behind it.
// Armed only now, not at module load, so it can never cut off main() itself
// still running (a leave day's exact-time wait, a slow sign-in, a slow
// punch). Unref'd, so it never keeps the process alive by itself, and 15s is
// long past undici's own idle-socket timeout, so it can't race the same way
// process.exit() did.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 15_000).unref();
}

main().then(
  () => finish(0),
  (error) => {
    console.error(`ERROR: ${error.message}`);
    if (REQUESTED_ACTION !== "plan") {
      notifyWindows(`Punchapollo: ${REQUESTED_ACTION} error`, error.message, "Error");
    }
    finish(1);
  }
);
