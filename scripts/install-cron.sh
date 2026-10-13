#!/usr/bin/env bash
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
begin_marker="# BEGIN PUNCHAPOLLO"
end_marker="# END PUNCHAPOLLO"
existing="$(crontab -l 2>/dev/null || true)"

# shellcheck source=scripts/config.sh
source "$project_directory/scripts/config.sh"

# Clock-in lands within the 30 minutes from the shift start; clock-out follows
# a full shift later plus 1 to 5 minutes, so the working day is never short.
# Times are minutes since midnight.
shift_start=$(minutes_of "$SHIFT_START")
shift_length=$(($(minutes_of "$SHIFT_END") - shift_start))
clock_in_time=$((shift_start + RANDOM % 30))
clock_out_time=$((clock_in_time + shift_length + 1 + RANDOM % 5))
latest_clock_out_time=$((shift_start + 29 + shift_length + 5))

# Installing in the middle of a working day would pair today's clock-out with a
# clock-in time that was never used, so fall back to the latest clock-out.
# --next-day skips this; the wrapper passes it once the day's clock-out is done.
current_weekday="$(TZ=Asia/Taipei date +%u)"
current_time=$(minutes_of "$(TZ=Asia/Taipei date +%H:%M)")
if [[ "${1:-}" != "--next-day" ]] &&
  ((current_weekday <= 5 && current_time >= shift_start && current_time <= latest_clock_out_time)); then
  clock_out_time=$latest_clock_out_time
  printf 'Working day in progress; clock-out set to the latest time.\n'
fi

plan_time=$(($(minutes_of "$FLEX_CLOCK_IN_START") - 30))

# One-off entries for today and later (leave-day times) survive a reinstall.
one_off_entries="$(printf '%s\n' "$existing" | awk -v today="$(TZ=Asia/Taipei date +%F)" '
  match($0, /# once [0-9-]+ /) && substr($0, RSTART + 7, 10) >= today { print }
')"

filtered="$(printf '%s\n' "$existing" | awk -v begin="$begin_marker" -v end="$end_marker" '
  $0 == begin { skip=1; next }
  $0 == end { skip=0; next }
  !skip { print }
')"

{
  printf '%s\n' "$filtered"
  printf '%s\n' "$begin_marker"
  printf '%s %s * * 1-5 %s/scripts/cron-punch.sh clock-in\n' \
    $((clock_in_time % 60)) $((clock_in_time / 60)) "$project_directory"
  printf '%s %s * * 1-5 %s/scripts/cron-punch.sh clock-out\n' \
    $((clock_out_time % 60)) $((clock_out_time / 60)) "$project_directory"
  # Reads the day's leave half an hour before the earliest possible clock-in
  # and adds one-off entries when the regular times do not fit.
  printf '%s %s * * 1-5 %s/scripts/cron-punch.sh plan\n' \
    $((plan_time % 60)) $((plan_time / 60)) "$project_directory"
  if [[ -n "$one_off_entries" ]]; then
    printf '%s\n' "$one_off_entries"
  fi
  printf '%s\n' "$end_marker"
} | crontab -

printf 'Installed the schedule for %s\n' "$project_directory"
crontab -l | sed -n "/$begin_marker/,/$end_marker/p"

# This cron runs on the system timezone only, and the times above are Taipei.
if [[ "$(date +%z)" != "+0800" ]]; then
  printf 'WARNING: the system timezone is not UTC+8; punches will run at the wrong time.\n' >&2
fi

if ! systemctl is-active --quiet cron 2>/dev/null; then
  printf 'WARNING: cron is not active. Run: sudo systemctl enable --now cron\n' >&2
fi
