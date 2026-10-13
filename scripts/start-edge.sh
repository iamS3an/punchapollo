#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
launcher_path="$(wslpath -w "$project_directory/start-edge.ps1")"
powershell_exe="${POWERSHELL_EXE:-/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe}"

# shellcheck source=scripts/config.sh
source "$project_directory/scripts/config.sh"

"$powershell_exe" -NoProfile -ExecutionPolicy Bypass -File "$launcher_path" -Url "$SITE_URL"
