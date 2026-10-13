// Signs in from a clean InPrivate browser started by run-session-test.ps1, so
// every Microsoft prompt (account, password, verification code) is exercised.
import { chromium } from "playwright-core";
import { loadConfig } from "./config.js";
import { signIn } from "./sso-login.js";

const CDP_URL = process.env.EDGE_CDP_URL ?? "http://localhost:9223";
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS ?? 3 * 60 * 1000);

const browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15_000 });
const contexts = browser.contexts();
const context = contexts.find((candidate) => candidate.pages().length > 0) ?? contexts[0];
if (!context) throw new Error("Edge has no browser context.");
const page = context.pages()[0] ?? (await context.newPage());

let exitCode = 0;
try {
  if (!loadConfig().sso.auto) {
    throw new Error("session:test verifies automatic sign-in; set AUTO_SSO=on in punch.conf first.");
  }
  await signIn(page, LOGIN_TIMEOUT_MS);
  console.log(JSON.stringify({ authenticated: true, cleanSession: true }, null, 2));
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  exitCode = 1;
}

const session = await browser.newBrowserCDPSession();
await session.send("Browser.close").catch(() => {});
process.exit(exitCode);
