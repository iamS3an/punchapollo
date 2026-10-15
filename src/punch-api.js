const ACTION_TYPES = {
  "clock-in": 1,
  "clock-out": 2
};

function apiError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A 200 with an unexpected shape could be a real API change or a WAF
// challenge page; without this, cookieTransport's POST would log a message
// that can't tell the two apart.
function describeResponse(result) {
  const detail = result.body?.raw ?? JSON.stringify(result.body);
  return `status ${result.status}: ${String(detail).slice(0, 200)}`;
}

function validateResponse(result, operation) {
  if (result.status === 401 || result.status === 403) {
    throw apiError(`${operation} requires authentication.`, "AUTH_REQUIRED");
  }

  if (result.status < 200 || result.status >= 300) {
    const error = apiError(
      `${operation} returned ${result.status}: ${result.body?.message ?? result.body?.raw ?? "Unknown error"}`,
      "API_ERROR"
    );
    error.status = result.status;
    throw error;
  }
}

// Both punch methods go through the same clockInOut API: it must be the one
// this account uses, and must expect this punch, before anything is sent.
async function clockInOut(transport, action, { method, functionCode, body }, timeoutMs) {
  const attendanceType = ACTION_TYPES[action];
  if (!attendanceType) {
    throw new Error(`Unsupported API punch action: ${action}`);
  }

  // The checks are the web page's own; only the punch itself carries the
  // function code of the method being used.
  const headers = {
    accept: "*/*",
    actioncode: "Default",
    "content-type": "application/json",
    functioncode: "PunchCard"
  };

  const useNew = await transport.fetch(
    "/backend/platform-bff/api/clockInOut/useNew",
    { method: "GET", headers },
    timeoutMs
  );
  validateResponse(useNew, "Clock API version check");
  if (useNew.body?.data !== true) {
    throw apiError("The account is not using the verified clockInOut API.", "UNSUPPORTED_API");
  }

  const location = await transport.fetch(
    "/backend/platform-bff/api/clockInOut/location",
    { method: "GET", headers },
    timeoutMs
  );
  validateResponse(location, "Clock availability check");

  // Only the web page's punch is checked against the network address.
  if (method === "ip" && location.body?.data?.ipNotPass) {
    throw apiError("Current IP is not allowed for web punching.", "IP_NOT_ALLOWED");
  }

  if (location.body?.data?.workType !== attendanceType) {
    throw apiError(
      `Clock API expected workType ${attendanceType}, received ${location.body?.data?.workType}.`,
      "ACTION_NOT_AVAILABLE"
    );
  }

  let punch;
  try {
    punch = await transport.fetch(
      `/backend/platform-bff/api/clockInOut/${method}`,
      {
        method: "POST",
        headers: { ...headers, functioncode: functionCode },
        body: JSON.stringify(body(attendanceType))
      },
      timeoutMs
    );
  } catch (error) {
    const uncertain = apiError(
      `Punch submission result is unknown and will not be retried automatically: ${error.message}`,
      "UNCERTAIN_SUBMISSION"
    );
    uncertain.submitted = true;
    throw uncertain;
  }

  // Errors from here on came back from the punch itself, so the caller can
  // tell them apart from a punch that was never sent.
  try {
    validateResponse(punch, "Punch API");
    if (punch.body?.data?.punchType !== attendanceType) {
      throw apiError(`Punch API returned an unexpected punch type (${describeResponse(punch)}).`, "INVALID_RESPONSE");
    }
  } catch (error) {
    error.submitted = true;
    throw error;
  }

  return {
    action,
    method,
    punchDate: punch.body.data.punchDate,
    punchType: punch.body.data.punchType,
    locationName: punch.body.data.locationName,
    note: punch.body.data.note ?? "",
    message: punch.body.message
  };
}

// The web page's punch. With a reason it switches to the same PascalCase
// fields as the phone app, keeping isOverride as it is.
export async function punchByApi(transport, action, timeoutMs) {
  const reason = await noOvertimeReason(transport, ACTION_TYPES[action], Date.now(), timeoutMs);
  const result = await clockInOut(
    transport,
    action,
    {
      method: "ip",
      functionCode: "PunchCard",
      body: (attendanceType) =>
        reason.CheckInPersonalReasonTypeId
          ? { AttendanceType: attendanceType, isOverride: false, ...reason }
          : { attendanceType, isOverride: false }
    },
    timeoutMs
  );
  return { ...result, reason: reason.CheckInPersonalReason ?? null };
}

// The account's configured punch locations, as the site's phone app would
// list them (one is the all-zero "other" id, and one is the web page's own
// location rather than a real office; exclude or recognize those yourself).
export async function fetchPunchLocations(transport, timeoutMs) {
  const locations = await transport.fetch(
    "/backend/pt/api/locations/EnableList",
    { method: "GET", headers: { accept: "*/*", "accept-language": "en-us" } },
    timeoutMs
  );
  validateResponse(locations, "Punch location list");
  if (!Array.isArray(locations.body?.Data)) {
    throw apiError(`Punch location list returned an unexpected structure (${describeResponse(locations)}).`, "INVALID_RESPONSE");
  }
  return locations.body.Data.map((item) => ({
    id: item.PunchesLocationId,
    code: item.LocationCode,
    name: String(item.LocationName ?? "").trim()
  }));
}

// The lookups the site's phone app makes before a GPS punch answer in
// {Meta, Data}; their labels are read in the language the app uses.
async function getAppData(transport, path, functionCode, operation, timeoutMs) {
  const result = await transport.fetch(
    path,
    {
      method: "GET",
      headers: {
        accept: "*/*",
        "accept-language": "zh-tw",
        actioncode: "Default",
        "content-type": "application/json",
        functioncode: functionCode
      }
    },
    timeoutMs
  );
  validateResponse(result, operation);
  if (result.body?.Data === undefined || result.body.Data === null) {
    throw apiError(`${operation} returned an unexpected structure (${describeResponse(result)}).`, "INVALID_RESPONSE");
  }
  return result.body.Data;
}

// The location as the phone app sees it, with the coordinates registered for it.
async function fetchGpsLocation(transport, locationId, timeoutMs) {
  const gpsType = await getAppData(
    transport,
    "/backend/pt/api/checkIn/mUseLocationType",
    "PunchCard",
    "GPS punch type",
    timeoutMs
  );
  if (typeof gpsType !== "string" || gpsType === "") {
    throw apiError("This account has no GPS punch.", "GPS_UNAVAILABLE");
  }

  const locations = await getAppData(
    transport,
    `/backend/pt/api/locations/AppEnableList?gpstype=${encodeURIComponent(gpsType)}`,
    "PunchCard",
    "GPS punch location list",
    timeoutMs
  );
  if (!Array.isArray(locations)) {
    throw apiError("GPS punch location list returned an unexpected structure.", "INVALID_RESPONSE");
  }
  const location = locations.find((item) => item.PunchesLocationId === locationId);
  if (!location) {
    const available = locations
      .map((item) => `${item.PunchesLocationId} ${String(item.LocationName ?? "").trim()}`)
      .join("; ");
    throw apiError(`GPS_LOCATION_ID is not one of your GPS punch locations: ${available}`, "UNKNOWN_LOCATION");
  }
  if (!Number.isFinite(location.Latitude) || !Number.isFinite(location.Longitude)) {
    throw apiError("The GPS punch location has no coordinates.", "INVALID_RESPONSE");
  }

  return {
    name: String(location.LocationName ?? "").trim(),
    latitude: location.Latitude,
    longitude: location.Longitude
  };
}

// The web page and the phone app both ask for a reason when a clock-in comes
// too early or a clock-out too late for the day's extend-work-hour rule, and
// send the answer with the punch. Overtime is always applied for separately,
// so the answer sent here is always the one meaning no overtime is applied for.
async function noOvertimeReason(transport, attendanceType, now, timeoutMs) {
  const rule = await getAppData(
    transport,
    "/backend/pt/api/CheckInExtendWorkHourRule/GetWithReason",
    "AttendanceRules",
    "Extend-work-hour rule",
    timeoutMs
  );
  const workOn = Date.parse(rule.WorkOnTime);
  const workOff = Date.parse(rule.WorkOffTime);
  if (!Number.isFinite(workOn) || !Number.isFinite(workOff)) {
    throw apiError("Extend-work-hour rule returned no working hours.", "INVALID_RESPONSE");
  }

  const early =
    attendanceType === ACTION_TYPES["clock-in"] &&
    rule.AdvanceWorkStatus === true &&
    now < workOn - rule.AdvanceWorkMinute * 60_000;
  const late =
    attendanceType === ACTION_TYPES["clock-out"] &&
    rule.PostponeWorkStatus === true &&
    now > workOff + rule.PostponeWorkMinute * 60_000;
  if (!early && !late) return {};

  const labels = await getAppData(
    transport,
    "/backend/pt/api/label/form/checkin-matter",
    "PunchCard",
    "Punch reason labels",
    timeoutMs
  );
  const answer = String(labels.PersonalMatter ?? "").trim();
  const reasons = early ? rule.AdvanceWorkReasonType : rule.PostponeWorkReasonType;
  const reason =
    answer !== "" && Array.isArray(reasons)
      ? reasons.find((item) => String(item.Name ?? "").trim() === answer)
      : undefined;
  if (!reason) {
    throw apiError("The punch needs a reason, and the no-overtime one was not found.", "REASON_NOT_FOUND");
  }

  return {
    CheckInPersonalReason: reason.Name,
    CheckInPersonalReasonTypeId: reason.CheckInPersonalReasonTypeId,
    CheckInTimeoutType: "Personal",
    ExtendWorkHourType: early ? "AdvanceWork" : "PostponeWork"
  };
}

// The punch the site's phone app makes: it is sent with the coordinates
// registered for the location, as the app does, instead of being checked
// against the network address like the web page's punch. Nothing here checks
// where this computer actually is.
export async function punchByGps(transport, action, locationId, timeoutMs) {
  const location = await fetchGpsLocation(transport, locationId, timeoutMs);
  const reason = await noOvertimeReason(transport, ACTION_TYPES[action], Date.now(), timeoutMs);

  const result = await clockInOut(
    transport,
    action,
    {
      method: "gps",
      functionCode: "APP-LocationCheckin",
      body: (attendanceType) => ({
        AttendanceType: attendanceType,
        IsOverride: false,
        Latitude: location.latitude,
        Longitude: location.longitude,
        LocationDetails: "",
        PunchesLocationId: locationId,
        ...reason
      })
    },
    timeoutMs
  );
  return { ...result, locationName: result.locationName ?? location.name, reason: reason.CheckInPersonalReason ?? null };
}
