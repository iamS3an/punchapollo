#!/usr/bin/env bash
# Usage: cron-punch.sh clock-in|clock-out|plan [YYYY-MM-DD]
# The date applies to plan only and defaults to today.
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_directory="$project_directory/logs"
lock_file="/tmp/punchapollo.lock"
action="${1:-}"

if [[ "$action" != "clock-in" && "$action" != "clock-out" && "$action" != "plan" ]]; then
  printf 'Usage: %s clock-in|clock-out|plan [YYYY-MM-DD]\n' "$0" >&2
  exit 2
fi

umask 077
mkdir -p "$log_directory"
exec 9>"$lock_file"

if ! flock -n 9; then
  exit 0
fi

exec >>"$log_directory/punch.log" 2>&1
printf '\n[%s] Scheduled %s started.\n' "$(date --iso-8601=seconds)" "$action"

json_value() {
  sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" <<<"$output" | head -n 1
}

schedule_once() {
  if [[ -n "$2" ]]; then
    "$project_directory/scripts/schedule-once.sh" "$1" "$2" || true
  fi
}

# Runs one action, leaving its output in $output and its exit code in $status.
run() {
  set +e
  output="$(PUNCH_ACTION="$1" PUNCH_PLAN_DATE="${2:-}" PUNCH_SCHEDULED=1 "$project_directory/scripts/run-clock-in.sh" 2>&1)"
  status=$?
  set -e
  output="${output//$'\r'/}"
  printf '%s\n' "$output"
}

# Adds one-off entries when the given day (today if empty) has leave that the
# regular times do not fit.
plan_day() {
  run plan "$1"
  if ((status == 0)); then
    schedule_once clock-in "$(json_value clockInDueAt)"
    schedule_once clock-out "$(json_value clockOutDueAt)"
  fi
}

next_weekday() {
  local offset=1
  while (($(TZ=Asia/Taipei date -d "+$offset day" +%u) > 5)); do
    offset=$((offset + 1))
  done
  TZ=Asia/Taipei date -d "+$offset day" +%F
}

if [[ "$action" == "plan" ]]; then
  plan_day "${2:-}"
else
  run "$action"
  if ((status == 0)); then
    # Too early for today's leave or clock-in time: come back when it is due.
    due_at="$(json_value dueAt)"
    schedule_once "$action" "$due_at"

    # The day is over after clock-out: pick new random times and plan the next
    # working day. The 06:30 plan run still catches leave filed after this.
    if [[ "$action" == "clock-out" && -z "$due_at" ]]; then
      "$project_directory/scripts/install-cron.sh" --next-day || true
      punch_status=$status
      plan_day "$(next_weekday)"
      status=$punch_status
    fi
  fi
fi

if ((status != 0)); then
  printf '[%s] Scheduled %s failed with exit code %s.\n' "$(date --iso-8601=seconds)" "$action" "$status"
  exit "$status"
fi

printf '[%s] Scheduled %s completed.\n' "$(date --iso-8601=seconds)" "$action"
