// Makes sure the dedicated Edge profile holds a session: reuses the
// saved one, and signs in only when it has expired.
import { chromium } from "playwright-core";
import { loadConfig } from "./config.js";
import { isAuthenticated, signIn } from "./sso-login.js";

const CDP_URL = process.env.EDGE_CDP_URL ?? "http://localhost:9222";
const { siteUrl: APP_URL, siteOrigin: APP_ORIGIN } = loadConfig();
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS ?? 15 * 60 * 1000);

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

const sessionReused = await isAuthenticated(page);
if (!sessionReused) await signIn(page, LOGIN_TIMEOUT_MS);

console.log(JSON.stringify({ authenticated: true, sessionReused, cdpUrl: CDP_URL }, null, 2));
process.exit(0);
