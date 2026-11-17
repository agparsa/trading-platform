#!/usr/bin/env bash
# Switches forex and metals from the simulator to fastFOREX's real bid/ask, on
# a deployed host. One command, so it can be run from any terminal on the
# server — a cPanel terminal included — when SSH from elsewhere is blocked.
#
#   ./scripts/enable-live-prices.sh            # asks for the fastFOREX key
#
# What it does, in order, stopping at the first failure:
#  1. copies .env.production to /root/env.production.bak-<time>;
#  2. sets MARKET_LIVE_FASTFOREX, FASTFOREX_API_KEY and QUOTE_MAX_AGE_OVERRIDES
#     (replacing earlier values of the same names, adding them otherwise) —
#     the key is read without echo and never printed;
#  3. recreates api-ingest, api, api-ws and worker, which read those settings;
#  4. waits for /health and prints the gold quote the platform now holds.
# Every open position in these instruments moves to the real price at once:
# run ./scripts/price-switch-impact.sh first to see what that does.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=.env.production
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE is missing; run this on the deployed host." >&2; exit 1; }
COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml --env-file "$ENV_FILE")

SYMBOLS="${SYMBOLS:-EURUSD GBPUSD USDJPY AUDUSD XAUUSD XAGUSD}"
MAX_AGE_MS="${MAX_AGE_MS:-15000}"

if [ -z "${FASTFOREX_API_KEY:-}" ]; then
  read -r -s -p "fastFOREX API key: " FASTFOREX_API_KEY
  echo
fi
[ -n "$FASTFOREX_API_KEY" ] || { echo "No key given." >&2; exit 1; }

map=""; ages=""
for s in $SYMBOLS; do
  map="${map:+$map,}$s:$s"
  ages="${ages:+$ages,}$s:$MAX_AGE_MS"
done

backup="/root/env.production.bak-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$ENV_FILE" "$backup"
echo "Backed up $ENV_FILE to $backup"

set_var() {
  local name="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${name}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$name" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}
set_var MARKET_LIVE_FASTFOREX "$map"
set_var FASTFOREX_API_KEY "$FASTFOREX_API_KEY"
set_var QUOTE_MAX_AGE_OVERRIDES "$ages"
echo "Set MARKET_LIVE_FASTFOREX=$map and QUOTE_MAX_AGE_OVERRIDES=$ages (key not shown)"

"${COMPOSE[@]}" up -d --no-deps api-ingest api api-ws worker

for _ in $(seq 1 30); do
  if curl -fsS -m 5 http://127.0.0.1/health >/dev/null 2>&1 || "${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1; then
    break
  fi
  sleep 4
done
sleep 15
echo "Live sources as the ingester started them:"
"${COMPOSE[@]}" logs --since 3m api-ingest 2>&1 | grep -E "live sources|fastforex:" | tail -4 || true
echo "Gold as the platform now holds it:"
"${COMPOSE[@]}" exec -T redis redis-cli --raw get quote:XAUUSD || true
echo "To undo: cp $backup $ENV_FILE && ${COMPOSE[*]} up -d --no-deps api-ingest api api-ws worker"
