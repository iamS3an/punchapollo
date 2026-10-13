// Reads punch.conf, the same NAME=value file the cron scripts read.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "punch.conf");
const TIME_KEYS = [
  "SHIFT_START",
  "SHIFT_END",
  "FLEX_CLOCK_IN_START",
  "FLEX_CLOCK_IN_END",
  "FLEX_CLOCK_OUT_START",
  "FLEX_CLOCK_OUT_END",
  "LUNCH_START",
  "LUNCH_END"
];
// Sign-in providers the site offers; only the ones listed here are automated.
const SUPPORTED_PROVIDERS = ["Microsoft"];
const URL_VALUE = /^https:\/\/[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(\/[A-Za-z0-9._~\/-]*)?$/;
const URL_KEYS = ["SITE_URL", "SIGN_IN_URL"];
const TEXT_KEYS = {
  SSO_PROVIDER: /^[A-Za-z]+$/,
  SSO_DOMAIN: /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/,
  SSO_ACCOUNT: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
};
const TIME_VALUE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SWITCH_VALUE = /^(on|off)$/;

function minutesOf(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

// A wrong setting would move every punch, so anything doubtful is an error.
function parseConfig(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    const pattern =
      TEXT_KEYS[key] ??
      (TIME_KEYS.includes(key)
        ? TIME_VALUE
        : URL_KEYS.includes(key)
          ? URL_VALUE
          : key === "AUTO_SSO"
            ? SWITCH_VALUE
            : null);
    if (separator < 1 || !pattern || !pattern.test(value)) {
      throw new Error(`punch.conf: cannot read "${trimmed}".`);
    }
    values[key] = value;
  }

  // The SSO values are only needed, and only checked, for automatic sign-in.
  const autoSso = values.AUTO_SSO === "on";
  const required = [...URL_KEYS, "AUTO_SSO", ...(autoSso ? Object.keys(TEXT_KEYS) : []), ...TIME_KEYS];
  const missing = required.filter((key) => !(key in values));
  if (missing.length > 0) throw new Error(`punch.conf: missing ${missing.join(", ")}.`);
  if (URL_KEYS.some((key) => /^https:\/\/([^/]+\.)?example\.com(\/|$)/i.test(values[key]))) {
    throw new Error("punch.conf: set SITE_URL and SIGN_IN_URL to the addresses of your site.");
  }
  if (autoSso && !SUPPORTED_PROVIDERS.includes(values.SSO_PROVIDER)) {
    throw new Error(`punch.conf: SSO_PROVIDER must be ${SUPPORTED_PROVIDERS.join(" or ")}.`);
  }
  if (
    autoSso &&
    (/(^|[@.])example\.com$/i.test(values.SSO_DOMAIN) || /[@.]example\.com$/i.test(values.SSO_ACCOUNT))
  ) {
    throw new Error("punch.conf: set SSO_DOMAIN and SSO_ACCOUNT to your own values.");
  }

  const m = Object.fromEntries(TIME_KEYS.map((key) => [key, minutesOf(values[key])]));
  const ordered = [
    ["FLEX_CLOCK_IN_START", "SHIFT_START"],
    ["SHIFT_START", "FLEX_CLOCK_IN_END"],
    ["SHIFT_START", "LUNCH_START"],
    ["LUNCH_START", "LUNCH_END"],
    ["LUNCH_END", "SHIFT_END"],
    ["FLEX_CLOCK_OUT_START", "SHIFT_END"],
    ["SHIFT_END", "FLEX_CLOCK_OUT_END"]
  ];
  for (const [earlier, later] of ordered) {
    if (m[earlier] > m[later]) throw new Error(`punch.conf: ${earlier} must not be after ${later}.`);
  }

  if (m.SHIFT_START === m.SHIFT_END) throw new Error("punch.conf: the shift has no length.");

  return {
    siteUrl: values.SITE_URL,
    siteOrigin: `${new URL(values.SITE_URL).origin}/`,
    signInUrl: values.SIGN_IN_URL.replace(/\/+$/, ""),
    sso: autoSso
      ? {
          auto: true,
          provider: values.SSO_PROVIDER,
          domain: values.SSO_DOMAIN,
          account: values.SSO_ACCOUNT
        }
      : { auto: false },
    shift: { start: values.SHIFT_START, end: values.SHIFT_END },
    shiftLengthMs: (m.SHIFT_END - m.SHIFT_START) * 60_000,
    flexClockIn: { start: values.FLEX_CLOCK_IN_START, end: values.FLEX_CLOCK_IN_END },
    flexClockOut: { start: values.FLEX_CLOCK_OUT_START, end: values.FLEX_CLOCK_OUT_END },
    lunch: { start: values.LUNCH_START, end: values.LUNCH_END }
  };
}

export function loadConfig() {
  let text;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("punch.conf is missing. Copy punch.conf.example to punch.conf and fill it in.");
    }
    throw new Error(`Cannot read punch.conf: ${error.message}`);
  }
  return parseConfig(text);
}
