#!/usr/bin/env bash
# Adds a one-off entry for a single date to the crontab block:
#   schedule-once.sh clock-in|clock-out <ISO time>
# It replaces an earlier one-off entry for the same action and date. The
# installer drops one-off entries once their date has passed.
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
end_marker="# END PUNCHAPOLLO"
action="${1:-}"
due_at="${2:-}"

if [[ "$action" != "clock-in" && "$action" != "clock-out" ]] || [[ -z "$due_at" ]]; then
  printf 'Usage: %s clock-in|clock-out <ISO time>\n' "$0" >&2
  exit 2
fi

export TZ=Asia/Taipei
# Cron fires on the minute, so round up to stay at or after the requested time.
due_epoch=$(($(date -d "$due_at" +%s) + 59))
fields="$(date -d "@$due_epoch" '+%-M %-H %-d %-m')"
tag="# once $(date -d "@$due_epoch" +%F) $action"
entry="$fields * $project_directory/scripts/cron-punch.sh $action $tag"

existing="$(crontab -l 2>/dev/null || true)"
if ! grep -qxF "$end_marker" <<<"$existing"; then
  printf 'The crontab block is missing. Run: npm run cron:install\n' >&2
  exit 1
fi

printf '%s\n' "$existing" | awk -v end="$end_marker" -v tag="$tag" -v entry="$entry" '
  index($0, tag) > 0 { next }
  $0 == end { print entry }
  { print }
' | crontab -

printf 'Scheduled one-off %s at %s.\n' "$action" "$(date -d "@$due_epoch" '+%F %H:%M')"
