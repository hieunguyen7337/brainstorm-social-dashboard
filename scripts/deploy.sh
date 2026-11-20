#!/usr/bin/env bash
# Idempotent deploy to Fly.io (Sydney). Owner-only. Requires: flyctl auth login.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=pulse-hackathon
FLY=$(command -v flyctl || command -v fly || true)
[ -n "$FLY" ] || { echo "flyctl not found" >&2; exit 1; }

if ! "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  "$FLY" apps create "$APP" --org "$ORG"
fi
if ! "$FLY" volumes list -a "$APP" 2>/dev/null | grep -q pulse_data; then
  "$FLY" volumes create pulse_data --region syd --size 1 --yes -a "$APP"
fi
"$FLY" deploy --remote-only -a "$APP"
bash scripts/smoke.sh "${BASE_URL:-https://$APP.fly.dev}"
