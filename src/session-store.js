// Persists the one cookie a direct request needs to act as a signed-in page,
// so routine runs can skip Edge entirely once this exists. Lower-stakes than
// the stored password/TOTP secret - it expires in days, not indefinitely -
// so a permission-locked plain file is enough; it does not need Windows
// DPAPI, which would tie it to the Windows side for no benefit here.
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const SESSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".session.json");
const COOKIE_NAME = "__ModuleSessionCookie";

export function loadSession() {
  if (!existsSync(SESSION_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(SESSION_PATH, "utf8"));
    if (!data.cookie || !data.userAgent) return null;
    if (data.expiresAt && Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

// Captures the session cookie and user agent from a page that just confirmed
// it is signed in - the only state a direct request needs to act as that
// page would.
export async function saveSessionFromPage(page) {
  const { siteOrigin } = loadConfig();
  const cookies = await page.context().cookies(siteOrigin);
  const sessionCookie = cookies.find((cookie) => cookie.name === COOKIE_NAME);
  if (!sessionCookie) {
    throw new Error(`No ${COOKIE_NAME} cookie was found after signing in.`);
  }
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const session = {
    cookie: `${COOKIE_NAME}=${sessionCookie.value}`,
    userAgent,
    expiresAt: sessionCookie.expires > 0 ? Math.round(sessionCookie.expires * 1000) : null
  };
  writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
  try {
    chmodSync(SESSION_PATH, 0o600);
  } catch {
    // Windows' node.exe writes this file too, where chmod has no real effect.
  }
  return session;
}

export function clearSession() {
  if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH);
}
