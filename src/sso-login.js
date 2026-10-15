import { loadConfig } from "./config.js";
import { notifyWindows } from "./notify.js";
import { loadSsoPassword, loadTotpSecret } from "./secret-store.js";
import { generateTotp, totpSecondsRemaining } from "./totp.js";

const MICROSOFT_LOGIN = "https://login.microsoftonline.com/";
const MAX_TOTP_ATTEMPTS = 2;
const STALL_HELP_MS = 20_000;

// Microsoft Entra sign-in page elements.
const ACCOUNT_INPUT = 'input[name="loginfmt"]';
const TOTP_INPUT = 'input[name="otc"]';
const TOTP_SUBMIT = "#idSubmit_SAOTCC_Continue";
const TOTP_METHOD = '[data-value="PhoneAppOTP"]';
const OTHER_METHOD_LINK = "#signInAnotherWay";
const ACCOUNT_TILE = "#tilesHolder [data-test-id]";
const PASSWORD_INPUT = 'input[name="passwd"]';
const USE_PASSWORD_OPTION = /使用我的密碼|Use my password/i;
const STAY_SIGNED_IN = "#KmsiCheckboxField";
const PRIMARY_BUTTON = "#idSIButton9";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function isVisible(page, selector) {
  return page
    .locator(selector)
    .first()
    .isVisible()
    .catch(() => false);
}

function usePasswordOption(page) {
  return page.getByRole("button", { name: USE_PASSWORD_OPTION }).first();
}

export async function isAuthenticated(page) {
  if (!page.url().startsWith(loadConfig().siteOrigin)) return false;
  const status = await page
    .evaluate(async () => {
      const response = await fetch("/backend/platform-bff/api/clockInOut/useNew", {
        credentials: "include",
        headers: { accept: "*/*", actioncode: "Default", functioncode: "PunchCard" }
      });
      return response.status;
    })
    .catch(() => 0);
  return status === 200;
}

// With AUTO_SSO off: opens the sign-in page and waits for the sign-in to be
// made by hand. The site returns to the app afterwards, and the Edge profile
// keeps the new session.
async function waitForManualSignIn(page, config, deadline, timeoutMs) {
  console.error("The site needs a sign-in. Sign in in the Edge window; automation will resume.");
  notifyWindows(
    "Punchapollo needs you to sign in",
    `Open the dedicated Edge window and sign in within ${Math.round(timeoutMs / 60_000)} minutes, or this run times out.`,
    "Warning"
  );
  const target = encodeURIComponent(config.siteUrl);
  await page.goto(`${config.signInUrl}/Login?original_target=${target}`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000
  });
  await page.bringToFront().catch(() => {});

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("The sign-in window was closed before login completed.");
    if (await isAuthenticated(page)) return;
    await sleep(2_000);
  }

  throw new Error(`Login timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

// Establishes the session. With AUTO_SSO on it goes through Microsoft
// SSO: the Microsoft session saved in the Edge profile usually completes it
// silently, and the account name, password and TOTP prompts are answered from
// stored values. Anything else, or AUTO_SSO off, waits for manual input.
export async function signIn(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const config = loadConfig();
  const { sso } = config;
  if (!sso.auto) return waitForManualSignIn(page, config, deadline, timeoutMs);

  // ext is the provider button on the sign-in page; dn makes the page look
  // the domain up and go on to the provider without further input.
  const ssoUrl =
    `${config.signInUrl}/ExternalLogin?ext=${encodeURIComponent(sso.provider)}` +
    `&dn=${encodeURIComponent(sso.domain)}&original_target=${encodeURIComponent(config.siteUrl)}`;
  const secret = loadTotpSecret();
  const password = loadSsoPassword();
  let passwordSubmitted = false;
  let lastCode;
  let totpAttempts = 0;
  let accountSubmitted = false;
  let askedForHelp = false;
  let lastProgress = Date.now();
  let lastHost = "";

  const askForHelp = async (reason) => {
    if (askedForHelp) return;
    askedForHelp = true;
    console.error(`${reason} Complete the sign-in in Edge; automation will resume.`);
    const minutesLeft = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
    notifyWindows(
      "Punchapollo needs you to sign in",
      `${reason} Complete it in the dedicated Edge window within ${minutesLeft} minutes, or this run times out.`,
      "Warning"
    );
    await page.bringToFront().catch(() => {});
  };

  console.error("Signing in through Microsoft SSO.");
  await page.goto(ssoUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });

  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error("The sign-in window was closed before login completed.");
    if (await isAuthenticated(page)) return;

    const host = new URL(page.url()).host;
    if (host !== lastHost) {
      lastHost = host;
      lastProgress = Date.now();
      console.error(`Sign-in page: ${host}`);
    }

    if (page.url().startsWith(MICROSOFT_LOGIN)) {
      if (await isVisible(page, TOTP_INPUT)) {
        if (!secret) {
          await askForHelp("Microsoft asked for a verification code and no TOTP secret is stored.");
        } else if (totpAttempts >= MAX_TOTP_ATTEMPTS) {
          await askForHelp("Microsoft rejected the generated verification codes.");
        } else {
          // A code is single-use; never resubmit one, and avoid one about to expire.
          const code = generateTotp(secret);
          if (code !== lastCode && totpSecondsRemaining(secret) > 3) {
            lastCode = code;
            totpAttempts += 1;
            await page.fill(TOTP_INPUT, code);
            await page.click(TOTP_SUBMIT);
            lastProgress = Date.now();
            console.error("Submitted the generated Microsoft verification code.");
          }
        }
      } else if (secret && (await isVisible(page, TOTP_METHOD))) {
        await page.click(TOTP_METHOD);
        lastProgress = Date.now();
      } else if (secret && (await isVisible(page, OTHER_METHOD_LINK))) {
        await page.click(OTHER_METHOD_LINK);
        lastProgress = Date.now();
      } else if (!accountSubmitted && (await isVisible(page, ACCOUNT_INPUT))) {
        accountSubmitted = true;
        await page.fill(ACCOUNT_INPUT, sso.account);
        await page.click(PRIMARY_BUTTON);
        lastProgress = Date.now();
        console.error("Submitted the Microsoft account name.");
      } else if (await isVisible(page, STAY_SIGNED_IN)) {
        await page.click(PRIMARY_BUTTON);
      } else if (await isVisible(page, PASSWORD_INPUT)) {
        if (!password) {
          await askForHelp("Microsoft asked for the account password and none is stored.");
        } else if (!passwordSubmitted) {
          // Submitted once only; repeated wrong passwords would lock the account.
          passwordSubmitted = true;
          await page.fill(PASSWORD_INPUT, password);
          await page.click(PRIMARY_BUTTON);
          lastProgress = Date.now();
          console.error("Submitted the Microsoft account password.");
        } else if (Date.now() - lastProgress > 10_000) {
          await askForHelp("Microsoft rejected the stored password; update it with: npm run password:set.");
        }
      } else if (password && !passwordSubmitted && (await usePasswordOption(page).isVisible().catch(() => false))) {
        await usePasswordOption(page).click();
        lastProgress = Date.now();
      } else if ((await page.locator(ACCOUNT_TILE).count().catch(() => 0)) === 1) {
        await page.click(ACCOUNT_TILE);
      }
    }

    // Covers any page this flow does not recognize, such as a federated sign-in.
    if (Date.now() - lastProgress > STALL_HELP_MS) {
      await askForHelp("The sign-in is waiting for input.");
    }

    await sleep(2_000);
  }

  throw new Error(`Login timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}
