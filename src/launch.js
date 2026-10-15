// Runs on Windows node.exe. Spawns the other node scripts directly, and
// PowerShell only for what needs it (Edge profile, DPAPI secrets).
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CDP_URL = process.env.EDGE_CDP_URL ?? "http://localhost:9222";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Interactive by default (the terminal is passed through, so hidden-input
// prompts work); with capture, output is returned instead.
function run(command, args, { env = {}, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      // Captured runs come from the daemon, which has no console of its own;
      // without this each one flashes a window. Interactive runs keep theirs.
      windowsHide: capture
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function runPowerShell(script, args = []) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(PROJECT_ROOT, script), ...args]);
}

async function edgeIsReady() {
  try {
    return (await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(3_000) })).ok;
  } catch {
    return false;
  }
}

async function ensureEdge() {
  if (await edgeIsReady()) return;
  console.error("Edge DevTools is unavailable; starting the dedicated Edge profile.");
  await runPowerShell("start-edge.ps1", ["-Url", loadConfig().siteUrl]);
  const timeoutMs = Number(process.env.EDGE_READY_TIMEOUT_SECONDS ?? 60) * 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await edgeIsReady()) return;
    await sleep(2_000);
  }
  throw new Error(`Edge did not become ready within ${timeoutMs / 1000} seconds.`);
}

export function runClockIn(action, { scheduled = false, planDate = null, capture = false } = {}) {
  return run(process.execPath, ["src/clock-in.js"], {
    capture,
    env: {
      PUNCH_ACTION: action,
      PUNCH_SCHEDULED: scheduled ? "1" : "0",
      PUNCH_PLAN_DATE: planDate ?? ""
    }
  });
}

export async function runSessionLogin() {
  await ensureEdge();
  return run(process.execPath, ["src/session-login.js"]);
}

export async function runLocationSet() {
  await ensureEdge();
  return run(process.execPath, ["src/location-set.js"]);
}

export function runSessionTest() {
  return runPowerShell("run-session-test.ps1", ["-LoginTimeoutMs", process.env.LOGIN_TIMEOUT_MS ?? "180000"]);
}

export function runSetSecret(kind) {
  return runPowerShell("set-secret.ps1", ["-Kind", kind]);
}
