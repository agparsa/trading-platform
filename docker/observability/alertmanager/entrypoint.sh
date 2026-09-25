#!/bin/sh
# Renders alertmanager.yml from the template and starts Alertmanager.
#
# Every placeholder must be set, and the password file must be there and not
# empty. Starting with an empty recipient would be an alerting system that
# accepts every alert and tells nobody — the failure this service exists to end.
set -eu

TEMPLATE=/etc/alertmanager/alertmanager.yml.template
OUT=/tmp/alertmanager.yml

for name in ALERT_SMTP_HOST ALERT_EMAIL_FROM ALERT_SMTP_USER ALERT_EMAIL_TO; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    echo "alertmanager: $name is not set; refusing to start an alerting system that tells nobody" >&2
    exit 1
  fi
  case "$value" in
    # A quote would end the YAML string; | & and \ mean something to sed.
    *\'*|*@@*|*'|'*|*'&'*|*'\'*)
      echo "alertmanager: $name contains a character this template cannot quote" >&2
      exit 1
      ;;
  esac
done
if [ ! -s /run/secrets/alert_smtp_password ]; then
  echo "alertmanager: /run/secrets/alert_smtp_password is missing or empty" >&2
  exit 1
fi

sed \
  -e "s|@@ALERT_SMTP_HOST@@|$ALERT_SMTP_HOST|" \
  -e "s|@@ALERT_EMAIL_FROM@@|$ALERT_EMAIL_FROM|" \
  -e "s|@@ALERT_SMTP_USER@@|$ALERT_SMTP_USER|" \
  -e "s|@@ALERT_EMAIL_TO@@|$ALERT_EMAIL_TO|" \
  "$TEMPLATE" > "$OUT"

exec /bin/alertmanager --config.file="$OUT" --storage.path=/alertmanager "$@"
