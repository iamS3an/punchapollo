const MINUTE = 60_000;
// On a normal day clock-in lands within this long after the shift start.
const NORMAL_CLOCK_IN_WINDOW_MS = 29 * MINUTE;
// Clock-in happens this long before work resumes on a leave day.
const ARRIVAL_LEAD_MS = { min: 5 * MINUTE, max: 25 * MINUTE };
// An exact punch is started this early so sign-in and checks finish first; the
// run then waits for the moment itself.
const EXACT_PUNCH_LEAD_MS = 2 * MINUTE;
export const EXACT_PUNCH_MAX_WAIT_MS = 3 * MINUTE;
// The site counts in minutes, so a clock-in this far past the planned start of
// the day still belongs to the leave plan.
const ON_TIME_TOLERANCE_MS = 1 * MINUTE;
// When leave ends the working day, you have left by the time it starts, so a
// clock-out later than this would record a time you were not there.
const LEAVE_CLOCK_OUT_WINDOW_MS = 30 * MINUTE;
// Clock-out happens this long after the working day ends.
const DEPARTURE_DELAY_MS = { min: 1 * MINUTE, max: 5 * MINUTE };

function merge(intervals) {
  const merged = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

// Leave sheets merged into continuous blocks. The lunch break is not working
// time, so leave that touches it absorbs it.
function leaveBlocks(leaves, lunch) {
  const blocks = merge(leaves.filter((leave) => leave.end > leave.start));
  if (!blocks.some((block) => block.start <= lunch.end && block.end >= lunch.start)) return blocks;
  return merge([...blocks, lunch]);
}

// Decides when to punch on a day with a shift. The working day is one
// continuous span as long as the shift, and leave inside it counts as worked:
// - leave that begins inside the flexible clock-in hours anchors the span to
//   the leave start;
// - leave that ends inside the flexible clock-out hours anchors the span to the
//   leave end;
// - otherwise the span starts at the actual clock-in.
// Leave that adds up to the working time of a shift makes the day "off".
// An existing clock-in is looked at first. One made before morning leave began
// keeps the span at clock-in plus the shift length, with the leave inside it.
// One made too late for leave that ends the day leaves no correct clock-out,
// so the plan is "leave-plan-missed" and the punches are left to be made by
// hand. A plan without clockIn (that one and "off") schedules nothing.
// All times are epoch milliseconds. clockOutEarliest is null until a normal
// day has a clock-in. The flexible hours are passed in as fixed clock times
// because the site moves the day's shift times to the actual clock-in minute.
export function computeDayPlan(day) {
  const plan = unboundedDayPlan(day);
  if (!plan.clockIn) return plan;

  // Random times stay inside both the flexible hours and the margins of the
  // rule. Where the two do not overlap, the punch is exact instead.
  const earliestPunch = day.flex.clockIn.start;
  const latestPunch = day.flex.clockOut.end;
  const bounded = { ...plan, latestPunch, latestNormalClockIn: day.flex.clockIn.end };
  if (plan.clockIn.earliest >= earliestPunch) return bounded;
  if (plan.clockIn.latest >= earliestPunch) {
    return { ...bounded, clockIn: { ...plan.clockIn, earliest: earliestPunch } };
  }

  // The usual lead does not fit; use whatever is left before work resumes.
  const lastMinute = plan.clockIn.deadline - MINUTE;
  if (lastMinute > earliestPunch) {
    return { ...bounded, clockIn: { ...plan.clockIn, earliest: earliestPunch, latest: lastMinute } };
  }
  return {
    ...bounded,
    clockIn: { ...plan.clockIn, earliest: earliestPunch, latest: earliestPunch, exact: true }
  };
}

// Leave time of the day, not counting the part that falls in the lunch break.
function leaveWorkingTime(leaves, lunch) {
  return merge(leaves.filter((leave) => leave.end > leave.start)).reduce((total, block) => {
    const inLunch = Math.max(0, Math.min(block.end, lunch.end) - Math.max(block.start, lunch.start));
    return total + (block.end - block.start) - inLunch;
  }, 0);
}

function unboundedDayPlan({ shiftStart, shiftEnd, leaves, lunch, flex, clockInAt = null }) {
  const span = shiftEnd - shiftStart;
  // Leave as long as the working time of a shift leaves nothing to work,
  // wherever its sheets fall in the day.
  if (leaveWorkingTime(leaves, lunch) >= span - (lunch.end - lunch.start)) return { type: "off" };
  const blocks = leaveBlocks(leaves, lunch);
  const opening = blocks.find(
    (block) => block.start < flex.clockIn.end && block.end > flex.clockIn.start
  );
  const closing = blocks.findLast(
    (block) => block !== opening && block.end >= flex.clockOut.start && block.start < flex.clockOut.end
  );

  const normal = {
    type: "normal",
    clockIn: {
      earliest: shiftStart,
      latest: shiftStart + NORMAL_CLOCK_IN_WINDOW_MS,
      deadline: shiftStart + NORMAL_CLOCK_IN_WINDOW_MS
    },
    clockOutEarliest: clockInAt === null ? null : clockInAt + span,
    clockOutLatest: null
  };

  if (opening) {
    const dayEnd = opening.start + span;
    if (opening.end >= dayEnd) return { type: "off" };
    if (clockInAt !== null && clockInAt < opening.start) return normal;

    const finalBlock = blocks.find(
      (block) => block !== opening && block.start < dayEnd && block.end >= dayEnd
    );
    const lateness = clockInAt === null ? 0 : Math.max(0, clockInAt - opening.end);
    return {
      type: "leave-at-start",
      clockIn: {
        earliest: opening.end - ARRIVAL_LEAD_MS.max,
        latest: opening.end - ARRIVAL_LEAD_MS.min,
        deadline: opening.end
      },
      clockOutEarliest: finalBlock ? finalBlock.start : dayEnd + lateness,
      clockOutLatest: finalBlock ? finalBlock.start + LEAVE_CLOCK_OUT_WINDOW_MS : null
    };
  }

  if (closing) {
    const dayStart = closing.end - span;
    if (closing.start <= dayStart) return { type: "off" };
    if (clockInAt !== null && clockInAt > dayStart + ON_TIME_TOLERANCE_MS) {
      return { type: "leave-plan-missed" };
    }
    return {
      type: "leave-at-end",
      clockIn: {
        earliest: dayStart - ARRIVAL_LEAD_MS.max,
        latest: dayStart - ARRIVAL_LEAD_MS.min,
        deadline: dayStart
      },
      clockOutEarliest: closing.start,
      clockOutLatest: closing.start + LEAVE_CLOCK_OUT_WINDOW_MS
    };
  }

  return normal;
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// When to start the clock-in: a random moment inside the window, or
// just ahead of an exact one. Never in the past.
export function pickClockInTime(plan, now) {
  const start = plan.clockIn.exact
    ? plan.clockIn.earliest - EXACT_PUNCH_LEAD_MS
    : randomBetween(plan.clockIn.earliest, plan.clockIn.latest);
  return Math.max(start, now + 2 * MINUTE);
}

// When to start the clock-out: a random delay after the working day
// ends, kept inside the flexible hours. With no room left it is the end
// itself, because a full working day takes priority over the limit.
export function pickClockOutTime(plan, now) {
  const earliest = plan.clockOutEarliest + DEPARTURE_DELAY_MS.min;
  const latest = Math.min(plan.clockOutEarliest + DEPARTURE_DELAY_MS.max, plan.latestPunch - MINUTE);
  const start = latest >= earliest ? randomBetween(earliest, latest) : plan.clockOutEarliest;
  return Math.max(start, now + 2 * MINUTE);
}
