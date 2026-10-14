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

flex_clock_in_start=$(minutes_of "$FLEX_CLOCK_IN_START")
flex_clock_out_end=$(minutes_of "$FLEX_CLOCK_OUT_END")

plan_value() {
  sed -n "s/.*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" <<<"$plan" | head -n 1
}

# Installing in the middle of a working day would pair today's clock-out with a
# clock-in time that was never used, so today's clock-out follows what the day
# actually looks like: a full shift after the clock-in already made, or the
# day's leave. --next-day skips this; the wrapper passes it once the day's
# clock-out is done.
system_utc_offset="$(date +%z)"
export TZ=Asia/Taipei
current_weekday="$(date +%u)"
current_time=$(minutes_of "$(date +%H:%M)")
plan=""
if [[ "${1:-}" != "--next-day" ]] &&
  ((current_weekday <= 5 && current_time >= flex_clock_in_start && current_time <= flex_clock_out_end)); then
  printf 'Working day in progress; reading the plan for today.\n'
  if plan="$(PUNCH_ACTION=plan "$project_directory/scripts/run-clock-in.sh" 2>&1)"; then
    plan="${plan//$'\r'/}"
  else
    printf '%s\n' "$plan" >&2
    plan=""
  fi

  plan_type="$(plan_value type)"
  clock_out_earliest="$(plan_value clockOutEarliest)"
  clock_in_at="$(plan_value clockInAt)"
  # No effect on anything already made today, but keeps today's written
  # entry from looking unrelated to the clock-in that actually happened.
  if [[ -n "$clock_in_at" ]]; then
    clock_in_time=$(minutes_of "$(date -d "$clock_in_at" +%H:%M)")
  elif [[ "$plan_type" != "normal" ]]; then
    # Not clocked in yet, but it's a leave day: its clock-in is not at the
    # regular shift-start formula, so use the window the plan already
    # computed for it (e.g. shortly before a morning leave ends, or shortly
    # before an afternoon leave begins) instead of the generic default.
    clock_in_latest="$(plan_value latest)"
    if [[ -n "$clock_in_latest" ]]; then
      clock_in_time=$(minutes_of "$(date -d "$clock_in_latest" +%H:%M)")
    fi
  fi
  if [[ -z "$plan" ]]; then
    clock_out_time=$latest_clock_out_time
    printf 'WARNING: the plan could not be read; clock-out set to the latest time.\n' >&2
  elif [[ "$plan_type" == "off" ]] || grep -q '"hasClockOut": true' <<<"$plan"; then
    printf 'Nothing is left to punch today.\n'
  elif [[ -n "$clock_out_earliest" ]]; then
    # 1 to 5 minutes after clockOutEarliest (a full shift after the actual or
    # planned clock-in; on an afternoon leave, when it begins), inside the
    # flexible hours, and far enough ahead for cron to pick the entry up.
    earliest_epoch=$(date -d "$clock_out_earliest" +%s)
    due_epoch=$((earliest_epoch + 60 + RANDOM % 241))
    limit_epoch=$(($(date -d "$FLEX_CLOCK_OUT_END" +%s) - 60))
    if ((due_epoch > limit_epoch)); then
      due_epoch=$((limit_epoch > earliest_epoch ? limit_epoch : earliest_epoch))
    fi
    soonest_epoch=$(($(date +%s) + 120))
    if ((due_epoch < soonest_epoch)); then
      due_epoch=$soonest_epoch
    fi
    clock_out_time=$(minutes_of "$(date -d "@$((due_epoch + 59))" +%H:%M)")
    printf 'Clock-out set from today'"'"'s plan.\n'
  elif [[ "$plan_type" == "normal" ]] && ((current_time < clock_in_time)); then
    printf 'Not clocked in yet; the regular times apply.\n'
  else
    clock_out_time=$latest_clock_out_time
    printf 'Clock-out set to the latest time.\n'
  fi
fi

plan_time=$((flex_clock_in_start - 30))

# One-off entries for today and later (leave-day times) survive a reinstall.
one_off_entries="$(printf '%s\n' "$existing" | awk -v today="$(date +%F)" '
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

# Leave days are punched by one-off entries at the times the plan gives.
for plan_action in clock-in clock-out; do
  plan_key="clockInDueAt"
  [[ "$plan_action" == "clock-out" ]] && plan_key="clockOutDueAt"
  plan_due_at="$(plan_value "$plan_key")"
  if [[ -n "$plan_due_at" ]]; then
    "$project_directory/scripts/schedule-once.sh" "$plan_action" "$plan_due_at" || true
  fi
done

printf 'Installed the schedule for %s\n' "$project_directory"
crontab -l | sed -n "/$begin_marker/,/$end_marker/p"

# This cron runs on the system timezone only, and the times above are Taipei.
if [[ "$system_utc_offset" != "+0800" ]]; then
  printf 'WARNING: the system timezone is not UTC+8; punches will run at the wrong time.\n' >&2
fi

if ! systemctl is-active --quiet cron 2>/dev/null; then
  printf 'WARNING: cron is not active. Run: sudo systemctl enable --now cron\n' >&2
fi
