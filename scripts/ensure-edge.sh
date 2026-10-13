#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
powershell_exe="${POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"
edge_ready_timeout_seconds="${EDGE_READY_TIMEOUT_SECONDS:-60}"

edge_is_ready() {
  "$powershell_exe" -NoProfile -Command \
    'try { Invoke-RestMethod "http://localhost:9222/json/version" -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }' \
    >/dev/null 2>&1
}

if edge_is_ready; then
  exit 0
fi

printf 'Edge DevTools is unavailable; starting the dedicated Edge profile.\n' >&2
"$project_directory/scripts/start-edge.sh"

deadline=$((SECONDS + edge_ready_timeout_seconds))
while ((SECONDS < deadline)); do
  if edge_is_ready; then
    exit 0
  fi
  sleep 2
done

printf 'Edge did not become ready within %s seconds.\n' "$edge_ready_timeout_seconds" >&2
exit 1
