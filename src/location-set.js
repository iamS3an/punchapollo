// Lists the account's punch locations and writes the one you pick into
// punch.conf as GPS_LOCATION_ID, with PUNCH_METHOD=gps unless it is auto.
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { saveSessionFromPage } from "./session-store.js";
import { isAuthenticated, signIn } from "./sso-login.js";
import { fetchPunchLocations } from "./punch-api.js";
import { edgeTransport } from "./transport.js";

const CDP_URL = process.env.EDGE_CDP_URL ?? "http://localhost:9222";
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);
const SUBMIT_TIMEOUT_MS = Number(process.env.SUBMIT_TIMEOUT_MS ?? 60_000);
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "punch.conf");
const OTHER_LOCATION_ID = "00000000-0000-0000-0000-000000000000";

const { siteUrl: APP_URL, siteOrigin: APP_ORIGIN } = loadConfig();

const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15_000 });
const context = browser.contexts()[0];
if (!context) throw new Error("Edge has no browser context.");

const page =
  context.pages().find((candidate) => candidate.url().startsWith(APP_ORIGIN)) ??
  context.pages()[0] ??
  (await context.newPage());

if (!page.url().startsWith(APP_ORIGIN)) {
  await page.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
}

if (!(await isAuthenticated(page))) await signIn(page, LOGIN_TIMEOUT_MS);
// Saved here so clock:plan/in/out can skip Edge entirely until it expires.
await saveSessionFromPage(page);

const locations = (await fetchPunchLocations(edgeTransport(page), SUBMIT_TIMEOUT_MS)).filter(
  (location) => location.id !== OTHER_LOCATION_ID
);
if (locations.length === 0) {
  throw new Error("No punch locations were returned for this account.");
}

console.log("Punch locations for this account:");
locations.forEach((location, index) => {
  console.log(`  ${index + 1}. ${location.code}  ${location.name}`);
});
console.log(
  "One of these may be the site's own web-punch location rather than a real office; skip it if so."
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
let chosen;
try {
  for (;;) {
    const answer = (await rl.question(`Pick a location (1-${locations.length}): `)).trim();
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= locations.length) {
      chosen = locations[index - 1];
      break;
    }
    console.log("Enter a number from the list above.");
  }
} finally {
  rl.close();
}

const lines = readFileSync(CONFIG_PATH, "utf8").split(/\r?\n/);
function setValue(key, value) {
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}
// auto already punches by GPS at this location, falling back to IP.
const method = lines.includes("PUNCH_METHOD=auto") ? "auto" : "gps";
setValue("PUNCH_METHOD", method);
setValue("GPS_LOCATION_ID", chosen.id);
writeFileSync(CONFIG_PATH, lines.join("\n"));

console.log(`Set PUNCH_METHOD=${method} and GPS_LOCATION_ID for "${chosen.name}" in punch.conf.`);
process.exit(0);
