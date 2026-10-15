// Two ways to run the site's own API calls: through a live Edge page (the
// only one that can sign in), or as a plain request carrying a saved session
// cookie. Every call site in src/*.js takes a transport instead of a page,
// so swapping one for the other is the only thing that changes.
import { lookup } from "node:dns/promises";
import { loadConfig } from "./config.js";

const { siteOrigin: SITE_ORIGIN } = loadConfig();
// A real signed-in page always sends this itself; confirmed by testing a
// direct request without it, which some endpoints answer with a 500
// "Culture is not supported" instead of the auth error you would expect.
const DEFAULT_ACCEPT_LANGUAGE = "zh-TW,zh;q=0.9,en;q=0.8";

// The first lookup after Windows has dropped the name from its cache can take
// longer than a request's connect timeout (about 12 s was measured), which
// fails the request as a plain "fetch failed". Waiting for the lookup on its
// own, outside any timeout, leaves the answer cached for the request.
let nameResolved;
function resolveSiteName() {
  nameResolved ??= lookup(new URL(SITE_ORIGIN).hostname).catch(() => {});
  return nameResolved;
}

function parseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

// Runs every request inside the Edge page itself, bound by that page's real
// cookies exactly as the site's own web page would be.
export function edgeTransport(page) {
  return {
    kind: "edge",
    page,
    async fetch(path, options, timeoutMs) {
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
            return { status: response.status, url: response.url, body };
          } finally {
            clearTimeout(timer);
          }
        },
        { path, options, timeoutMs }
      );
    }
  };
}

// A plain request carrying the saved session cookie - no browser involved.
// Only signing in, which produces that cookie, ever needs Edge.
export function cookieTransport(session) {
  return {
    kind: "cookie",
    async fetch(path, options, timeoutMs) {
      await resolveSiteName();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(new URL(path, SITE_ORIGIN), {
          ...options,
          headers: {
            "accept-language": DEFAULT_ACCEPT_LANGUAGE,
            ...options.headers,
            cookie: session.cookie,
            "user-agent": session.userAgent
          },
          signal: controller.signal
        });
        const text = await response.text();
        return { status: response.status, url: response.url, body: parseBody(text) };
      } finally {
        clearTimeout(timer);
      }
    }
  };
}
