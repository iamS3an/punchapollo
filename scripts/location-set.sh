#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_path="$(wslpath -w "$project_directory/run-location-set.ps1")"
powershell_exe="${POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

"$project_directory/scripts/ensure-edge.sh"
"$powershell_exe" -NoProfile -ExecutionPolicy Bypass -File "$runner_path" \
  -CdpUrl "${EDGE_CDP_URL:-http://localhost:9222}" \
  -LoginTimeoutMs "${LOGIN_TIMEOUT_MS:-900000}"
