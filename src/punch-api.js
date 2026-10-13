const ACTION_TYPES = {
  "clock-in": 1,
  "clock-out": 2
};

function apiError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function browserFetch(page, path, options, timeoutMs) {
  return page.evaluate(
    async ({ path, options, timeoutMs }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(path, {
          ...options,
          credentials: "include",
          signal: controller.signal
        });
        const text = await response.text();
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 500) };
        }

        return {
          status: response.status,
          url: response.url,
          body
        };
      } finally {
        clearTimeout(timer);
      }
    },
    { path, options, timeoutMs }
  );
}

function validateResponse(result, operation) {
  if (result.status === 401 || result.status === 403) {
    throw apiError(`${operation} requires authentication.`, "AUTH_REQUIRED");
  }

  if (result.status < 200 || result.status >= 300) {
    throw apiError(
      `${operation} returned ${result.status}: ${result.body?.message ?? result.body?.raw ?? "Unknown error"}`,
      "API_ERROR"
    );
  }
}

export async function punchByApi(page, action, timeoutMs) {
  const attendanceType = ACTION_TYPES[action];
  if (!attendanceType) {
    throw new Error(`Unsupported API punch action: ${action}`);
  }

  const headers = {
    accept: "*/*",
    actioncode: "Default",
    "content-type": "application/json",
    functioncode: "PunchCard"
  };

  const useNew = await browserFetch(
    page,
    "/backend/platform-bff/api/clockInOut/useNew",
    { method: "GET", headers },
    timeoutMs
  );
  validateResponse(useNew, "Clock API version check");
  if (useNew.body?.data !== true) {
    throw apiError("The account is not using the verified clockInOut API.", "UNSUPPORTED_API");
  }

  const location = await browserFetch(
    page,
    "/backend/platform-bff/api/clockInOut/location",
    { method: "GET", headers },
    timeoutMs
  );
  validateResponse(location, "Clock availability check");

  if (location.body?.data?.ipNotPass) {
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
    punch = await browserFetch(
      page,
      "/backend/platform-bff/api/clockInOut/ip",
      {
        method: "POST",
        headers,
        body: JSON.stringify({ attendanceType, isOverride: false })
      },
      timeoutMs
    );
  } catch (error) {
    throw apiError(
      `Punch submission result is unknown and will not be retried automatically: ${error.message}`,
      "UNCERTAIN_SUBMISSION"
    );
  }

  validateResponse(punch, "Punch API");
  if (punch.body?.data?.punchType !== attendanceType) {
    throw apiError("Punch API returned an unexpected punch type.", "INVALID_RESPONSE");
  }

  return {
    action,
    punchDate: punch.body.data.punchDate,
    punchType: punch.body.data.punchType,
    locationName: punch.body.data.locationName,
    note: punch.body.data.note ?? "",
    message: punch.body.message
  };
}
