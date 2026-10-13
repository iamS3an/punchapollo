#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_path="$(wslpath -w "$project_directory/run-clock-in.ps1")"
powershell_exe="${POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

arguments=(
  -CdpUrl "${EDGE_CDP_URL:-http://localhost:9222}"
  -LoginTimeoutMs "${LOGIN_TIMEOUT_MS:-600000}"
  -PageLoadTimeoutMs "${PAGE_LOAD_TIMEOUT_MS:-90000}"
  -SubmitTimeoutMs "${SUBMIT_TIMEOUT_MS:-60000}"
  -Action "${PUNCH_ACTION:?PUNCH_ACTION must be clock-in, clock-out or plan}"
)
if [[ "${PUNCH_SCHEDULED:-0}" == "1" ]]; then
  arguments+=(-Scheduled)
fi
if [[ -n "${PUNCH_PLAN_DATE:-}" ]]; then
  arguments+=(-PlanDate "$PUNCH_PLAN_DATE")
fi

"$project_directory/scripts/ensure-edge.sh"

"$powershell_exe" -NoProfile -ExecutionPolicy Bypass -File "$runner_path" "${arguments[@]}"
