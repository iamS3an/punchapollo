import { execFileSync } from "node:child_process";

// Secrets are stored by set-secret.ps1 as DPAPI-protected strings, readable
// only by the same Windows account on the same computer.
function readScript(name) {
  return `
$path = Join-Path $env:LOCALAPPDATA 'punchapollo\\${name}.dpapi'
if (-not (Test-Path $path)) { exit 3 }
$secure = (Get-Content -Raw $path).Trim() | ConvertTo-SecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
`;
}

// Returns the stored secret, or null when none has been configured.
function loadSecret(name) {
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", readScript(name)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    return output.trim() || null;
  } catch (error) {
    if (error.status === 3) return null;
    throw new Error(`Cannot read the stored ${name}: ${String(error.stderr ?? error.message).trim()}`);
  }
}

export function loadTotpSecret() {
  return loadSecret("totp-secret");
}

export function loadSsoPassword() {
  return loadSecret("sso-password");
}
