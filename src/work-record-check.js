const TIME_ZONE = "Asia/Taipei";

function taipeiDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function apiError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export async function getTodayWorkRecord(page, timeoutMs) {
  const date = taipeiDate();
  const queryDate = date.replaceAll("-", "/");
  const result = await page.evaluate(
    async ({ queryDate, timeoutMs }) => {
      const url = new URL("/backend/pt/api/checkinRecords/onOffWork", location.origin);
      url.search = new URLSearchParams({
        attendanceDateEnd: queryDate,
        attendanceDateStart: queryDate,
        attendanceType: "",
        checkInWay: "workOnOff",
        departmentId: "",
        employeeId: "",
        pageNumber: "1",
        pageSize: "30",
        punchesLocationId: ""
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          credentials: "include",
          headers: {
            accept: "*/*",
            actioncode: "Default",
            "content-type": "application/json",
            functioncode: "PersonalWorkRecords"
          },
          signal: controller.signal
        });

        return {
          status: response.status,
          body: await response.json()
        };
      } finally {
        clearTimeout(timer);
      }
    },
    { queryDate, timeoutMs }
  );

  if (result.status === 401 || result.status === 403) {
    throw apiError("Work records API requires authentication.", "AUTH_REQUIRED");
  }

  if (result.status < 200 || result.status >= 300) {
    throw apiError(`Work records API returned ${result.status}.`, "API_ERROR");
  }

  if (!Array.isArray(result.body?.Data)) {
    throw apiError("Work records API returned an unexpected structure.", "INVALID_RESPONSE");
  }

  const records = result.body.Data.filter((item) => item.AttendanceDate?.startsWith(date));
  const clockInTimes = records
    .filter((record) => record.InAttendanceOn && record.InAttendanceHistoryId)
    .map((record) => Date.parse(record.InAttendanceOn))
    .filter(Number.isFinite);
  return {
    date,
    exists: records.length > 0,
    clockInAt: clockInTimes.length > 0 ? Math.min(...clockInTimes) : null,
    hasClockIn: records.some(
      (record) => Boolean(record.InAttendanceOn && record.InAttendanceHistoryId)
    ),
    hasClockOut: records.some(
      (record) => Boolean(record.OutAttendanceOn && record.OutAttendanceHistoryId)
    )
  };
}
