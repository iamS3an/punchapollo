#!/usr/bin/env bash
# Prints the settings in punch.conf and the schedule they lead to.
set -euo pipefail

project_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/config.sh
source "$project_directory/scripts/config.sh"

clock_time() {
  printf '%02d:%02d' $(($1 / 60)) $(($1 % 60))
}

shift_start=$(minutes_of "$SHIFT_START")
shift_length=$(($(minutes_of "$SHIFT_END") - shift_start))

printf 'Settings file: %s\n\n' "$config_file"
printf 'Site                  %s\n' "$SITE_URL"
printf 'Sign-in page          %s\n' "$SIGN_IN_URL"
if [[ "$AUTO_SSO" == "on" ]]; then
  printf 'Automatic sign-in     on\n'
  printf 'SSO provider          %s\n' "$SSO_PROVIDER"
  printf 'SSO domain            %s\n' "$SSO_DOMAIN"
  printf 'SSO account           %s\n' "$SSO_ACCOUNT"
else
  printf 'Automatic sign-in     off (an expired session waits for you to sign in)\n'
fi
printf 'Shift                 %s-%s (%d h %02d min)\n' "$SHIFT_START" "$SHIFT_END" $((shift_length / 60)) $((shift_length % 60))
printf 'Flexible clock-in     %s-%s\n' "$FLEX_CLOCK_IN_START" "$FLEX_CLOCK_IN_END"
printf 'Flexible clock-out    %s-%s\n' "$FLEX_CLOCK_OUT_START" "$FLEX_CLOCK_OUT_END"
printf 'Lunch break           %s-%s\n\n' "$LUNCH_START" "$LUNCH_END"
printf 'Regular clock-in      %s-%s\n' "$SHIFT_START" "$(clock_time $((shift_start + 29)))"
printf 'Regular clock-out     %s-%s\n' "$(clock_time $((shift_start + shift_length + 1)))" "$(clock_time $((shift_start + 29 + shift_length + 5)))"
printf 'Daily plan check      %s\n\n' "$(clock_time $(($(minutes_of "$FLEX_CLOCK_IN_START") - 30)))"
printf 'Installed schedule:\n'
crontab -l 2>/dev/null | sed -n '/# BEGIN PUNCHAPOLLO/,/# END PUNCHAPOLLO/p'
