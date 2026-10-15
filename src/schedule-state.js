// What the daemon has scheduled, written to .schedule.json so the npm
// commands can show it, plus the Taipei-time helpers both sides share.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEDULE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".schedule.json");

// Half an hour before the flexible clock-in hours open (06:30 by default):
// late enough that overnight leave is filed, well before the earliest punch.
export const PLAN_CHECK_LEAD_MS = 30 * 60_000;

export function taipeiDateParts(now = new Date()) {
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

export function dateText({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isWeekday(weekdayShort) {
  return weekdayShort !== "Sat" && weekdayShort !== "Sun";
}

// Taipei has no DST, but anchoring at noon before adding a day keeps this
// correct even if that ever changes.
export function nextDateText(today) {
  const noon = Date.parse(`${today}T12:00:00+08:00`);
  return dateText(taipeiDateParts(new Date(noon + 24 * 3_600_000)));
}

export function timeRange(today, { start, end }) {
  return { start: Date.parse(`${today}T${start}:00+08:00`), end: Date.parse(`${today}T${end}:00+08:00`) };
}

function taipeiFormat(milliseconds, options) {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hourCycle: "h23", ...options }).format(
    new Date(milliseconds)
  );
}

export function taipeiTime(milliseconds) {
  return taipeiFormat(milliseconds, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// The next plan check strictly after now, on the next weekday that has one.
export function nextPlanCheck(config, now = Date.now()) {
  let day = dateText(taipeiDateParts(new Date(now)));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const weekday = taipeiDateParts(new Date(Date.parse(`${day}T12:00:00+08:00`))).weekday;
    if (isWeekday(weekday)) {
      const at = timeRange(day, config.flexClockIn).start - PLAN_CHECK_LEAD_MS;
      if (at > now) return at;
    }
    day = nextDateText(day);
  }
  return null;
}

export function writeSchedule(schedule) {
  try {
    writeFileSync(SCHEDULE_PATH, JSON.stringify({ ...schedule, updatedAt: Date.now() }, null, 2));
  } catch {
    // A status file must never stop the daemon.
  }
}

export function readSchedule() {
  try {
    return JSON.parse(readFileSync(SCHEDULE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function describeEntry(entry) {
  if (!entry || typeof entry !== "object") return "nothing scheduled";
  const time = Number.isFinite(entry.at) ? taipeiTime(entry.at) : "";
  const detail = entry.detail ? ` (${entry.detail})` : "";
  return `${String(entry.state ?? "unknown").padEnd(10)}${time}${detail}`.trimEnd();
}

// Human-readable lines for config:show and clock:plan. The status file is
// only a convenience: a missing, empty or unreadable one never fails a command.
export function describeSchedule(config, now = Date.now()) {
  try {
    return describe(config, now);
  } catch {
    return ["Daemon schedule", "  Unavailable (the schedule file could not be read)."];
  }
}

function describe(config, now) {
  const schedule = readSchedule();
  const today = dateText(taipeiDateParts(new Date(now)));
  const lines = ["Daemon schedule"];
  const next = schedule?.nextCheckAt && schedule.nextCheckAt > now ? schedule.nextCheckAt : nextPlanCheck(config, now);

  if (!schedule || schedule.date !== today) {
    lines.push("  Nothing planned for today yet.");
  } else if (schedule.type === "weekend") {
    lines.push(`  ${today} is a weekend.`);
  } else if (schedule.type === "pending") {
    lines.push(`  ${today}: reading the plan at ${taipeiTime(schedule.checkAt).slice(0, 5)}.`);
  } else if (schedule.type === "off") {
    lines.push(`  ${today}: no work today${schedule.reason ? ` (${schedule.reason})` : ""}.`);
  } else {
    lines.push(`  ${today} (${schedule.type})`);
    lines.push(`    clock-in    ${describeEntry(schedule.clockIn)}`);
    lines.push(`    clock-out   ${describeEntry(schedule.clockOut)}`);
  }
  if (next) {
    lines.push(
      `  Next plan check   ${taipeiFormat(next, { year: "numeric", month: "2-digit", day: "2-digit" })} ${taipeiTime(next).slice(0, 5)}`
    );
  }
  return lines;
}
