#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runner_path="$(wslpath -w "$project_directory/set-secret.ps1")"
powershell_exe="${POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

"$powershell_exe" -NoProfile -ExecutionPolicy Bypass -File "$runner_path" \
  -Kind "${1:?Usage: set-secret.sh totp|password}"
