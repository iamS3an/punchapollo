// A Windows notification, best-effort: a problem showing it is logged, never
// thrown, so it can never fail the punch itself.
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "notify.ps1");

export function taipeiClock(when = Date.now()) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(when);
}

// Every call gets a time prefix, so you always know when this happened
// without each caller having to add it itself.
export async function notifyWindows(title, message, icon = "Info") {
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SCRIPT_PATH,
      "-Title",
      title,
      "-Message",
      `[${taipeiClock()}] ${message}`,
      "-Icon",
      icon
    ], { windowsHide: true });
  } catch (error) {
    console.error(`Notification failed: ${error.message}`);
  }
}
