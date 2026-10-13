import { loadConfig } from "./config.js";

const TIME_ZONE = "Asia/Taipei";
const TIME_ZONE_OFFSET = "+08:00";

function taipeiDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(now);

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

function formatDate({ year, month, day }) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function containsExactString(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactString(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => containsExactString(item, expected));
}

function apiError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function timeRange(dateText, { start, end }) {
  return {
    start: Date.parse(`${dateText}T${start}:00${TIME_ZONE_OFFSET}`),
    end: Date.parse(`${dateText}T${end}:00${TIME_ZONE_OFFSET}`)
  };
}

// Why nobody works on this day at all, or null on a working day.
export function dayOffReason(schedule) {
  if (schedule.hasTyphoonClosure) return "typhoon-closure-detected";
  if (schedule.hasNationalHoliday) return "national-holiday-detected";
  if (schedule.hasWeeklyRestDay) return "weekly-rest-day-detected";
  return null;
}

// Reads the schedule of one day (YYYY-MM-DD, Taipei), today by default.
export async function getSchedule(page, timeoutMs, dateText = formatDate(taipeiDateParts())) {
  const [year, month] = dateText.split("-").map(Number);
  const result = await page.evaluate(
    async ({ year, month, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(
          `/backend/pt/api/EmployeeCalendars/scheduling?year=${year}&month=${month}`,
          {
            credentials: "include",
            headers: {
              accept: "*/*",
              actioncode: "Default",
              "content-type": "application/json",
              functioncode: "PersonalShiftSchedule"
            },
            signal: controller.signal
          }
        );

        return {
          status: response.status,
          body: await response.json()
        };
      } finally {
        clearTimeout(timer);
      }
    },
    { year, month, timeoutMs }
  );

  if (result.status === 401 || result.status === 403) {
    throw apiError("Shift schedule API requires authentication.", "AUTH_REQUIRED");
  }

  if (result.status < 200 || result.status >= 300) {
    throw apiError(`Shift schedule API returned ${result.status}.`, "API_ERROR");
  }

  const calendars = result.body?.Data?.Calendars;
  if (!Array.isArray(calendars)) {
    throw apiError("Shift schedule API returned an unexpected structure.", "INVALID_RESPONSE");
  }

  const calendar = calendars.find((item) => item.Date?.startsWith(dateText));
  if (!calendar) {
    throw apiError(`No shift schedule record exists for ${dateText}.`, "SCHEDULE_NOT_FOUND");
  }

  return scheduleFromCalendar(calendar, dateText);
}

// Reads one day's entry of the scheduling API into the facts the plan needs.
export function scheduleFromCalendar(calendar, dateText) {
  const config = loadConfig();
  const hasNationalHoliday = calendar.CalendarEvent != null;
  const hasTyphoonClosure = containsExactString(calendar.SpecialEvents, "颱風停班");
  const shiftStart = Date.parse(calendar.ShiftSchedule?.WorkOnTime);
  const shiftEnd = Date.parse(calendar.ShiftSchedule?.WorkOffTime);
  const hasShift = Number.isFinite(shiftStart) && Number.isFinite(shiftEnd) && shiftEnd > shiftStart;

  // The site moves a day's shift to the actual clock-in minute, so only its
  // length can be compared with the configured shift.
  if (hasShift && shiftEnd - shiftStart !== config.shiftLengthMs) {
    throw apiError("The site's shift is not as long as the shift in punch.conf.", "UNSUPPORTED_SHIFT");
  }
  const shift = timeRange(dateText, config.shift);

  // Any leave sheet counts, whatever its approval status.
  const leaves = (calendar.LeaveSheets ?? []).map((sheet) => ({
    start: Date.parse(sheet.LeaveStartDatetime),
    end: Date.parse(sheet.LeaveEndDatetime)
  }));
  if (leaves.some((leave) => !Number.isFinite(leave.start) || !Number.isFinite(leave.end))) {
    throw apiError("A leave sheet has an unreadable time range.", "INVALID_RESPONSE");
  }

  return {
    date: dateText,
    hasNationalHoliday,
    hasTyphoonClosure,
    hasWeeklyRestDay: !hasNationalHoliday && !hasShift,
    shiftStart: hasShift ? shift.start : null,
    shiftEnd: hasShift ? shift.end : null,
    leaves,
    lunch: timeRange(dateText, config.lunch),
    flex: {
      clockIn: timeRange(dateText, config.flexClockIn),
      clockOut: timeRange(dateText, config.flexClockOut)
    }
  };
}
