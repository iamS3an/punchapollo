#!/usr/bin/env bash
# Sourced by the cron scripts: reads punch.conf into variables of the same
# names and provides minutes_of. src/config.js validates the same file.

config_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/punch.conf"

if [[ ! -r "$config_file" ]]; then
  printf 'punch.conf is missing. Copy punch.conf.example to punch.conf and fill it in.\n' >&2
  exit 1
fi

config_time_keys='SHIFT_START|SHIFT_END|FLEX_CLOCK_IN_START|FLEX_CLOCK_IN_END|FLEX_CLOCK_OUT_START|FLEX_CLOCK_OUT_END|LUNCH_START|LUNCH_END'
config_time='([01][0-9]|2[0-3]):[0-5][0-9]'
config_host='[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+'

while IFS= read -r config_line || [[ -n "$config_line" ]]; do
  config_line="${config_line%$'\r'}"
  [[ -z "${config_line// /}" || "$config_line" == \#* ]] && continue
  if [[ "$config_line" =~ ^($config_time_keys)=($config_time)$ ]] ||
    [[ "$config_line" =~ ^(SITE_URL|SIGN_IN_URL)=(https://$config_host(/[A-Za-z0-9._~/-]*)?)$ ]] ||
    [[ "$config_line" =~ ^(AUTO_SSO)=(on|off)$ ]] ||
    [[ "$config_line" =~ ^(SSO_PROVIDER)=([A-Za-z]+)$ ]] ||
    [[ "$config_line" =~ ^(SSO_DOMAIN)=($config_host)$ ]] ||
    [[ "$config_line" =~ ^(SSO_ACCOUNT)=([A-Za-z0-9._%+-]+@$config_host)$ ]]; then
    printf -v "${BASH_REMATCH[1]}" '%s' "${BASH_REMATCH[2]}"
  else
    printf 'punch.conf: cannot read "%s".\n' "$config_line" >&2
    exit 1
  fi
done <"$config_file"

# The SSO values are only needed, and only checked, for automatic sign-in.
config_sso_keys=""
if [[ "${AUTO_SSO:-}" == "on" ]]; then
  config_sso_keys="SSO_PROVIDER SSO_DOMAIN SSO_ACCOUNT"
fi

config_missing=""
for config_key in SITE_URL SIGN_IN_URL AUTO_SSO $config_sso_keys ${config_time_keys//|/ }; do
  if [[ -z "${!config_key:-}" ]]; then
    config_missing+="${config_missing:+, }$config_key"
  fi
done
if [[ -n "$config_missing" ]]; then
  printf 'punch.conf: missing %s.\n' "$config_missing" >&2
  exit 1
fi

shopt -s nocasematch
for config_key in SITE_URL SIGN_IN_URL; do
  if [[ "${!config_key}" =~ ^https://([^/]+\.)?example\.com(/|$) ]]; then
    printf 'punch.conf: set SITE_URL and SIGN_IN_URL to the addresses of your site.\n' >&2
    exit 1
  fi
done
shopt -u nocasematch

# Only the Microsoft sign-in is automated.
if [[ "$AUTO_SSO" == "on" && "$SSO_PROVIDER" != "Microsoft" ]]; then
  printf 'punch.conf: SSO_PROVIDER must be Microsoft.\n' >&2
  exit 1
fi

shopt -s nocasematch
if [[ "$AUTO_SSO" == "on" ]] &&
  [[ "$SSO_DOMAIN" =~ (^|\.)example\.com$ || "$SSO_ACCOUNT" =~ [@.]example\.com$ ]]; then
  printf 'punch.conf: set SSO_DOMAIN and SSO_ACCOUNT to your own values.\n' >&2
  exit 1
fi
shopt -u nocasematch

# Minutes since midnight of an HH:MM time.
minutes_of() {
  printf '%s' $((10#${1%%:*} * 60 + 10#${1##*:}))
}

# A wrong setting would move every punch, so the order is checked here too.
for config_pair in FLEX_CLOCK_IN_START:SHIFT_START SHIFT_START:FLEX_CLOCK_IN_END \
  SHIFT_START:LUNCH_START LUNCH_START:LUNCH_END LUNCH_END:SHIFT_END \
  FLEX_CLOCK_OUT_START:SHIFT_END SHIFT_END:FLEX_CLOCK_OUT_END; do
  config_earlier="${config_pair%%:*}"
  config_later="${config_pair##*:}"
  if (($(minutes_of "${!config_earlier}") > $(minutes_of "${!config_later}"))); then
    printf 'punch.conf: %s must not be after %s.\n' "$config_earlier" "$config_later" >&2
    exit 1
  fi
done

if [[ "$SHIFT_START" == "$SHIFT_END" ]]; then
  printf 'punch.conf: the shift has no length.\n' >&2
  exit 1
fi
