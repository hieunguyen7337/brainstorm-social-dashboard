#!/usr/bin/env bash
# Smoke test against a running Pulse. Usage: scripts/smoke.sh [BASE_URL]
set -euo pipefail
BASE_URL="${1:-${BASE_URL:-http://localhost:8000}}"
BASE_URL="${BASE_URL%/}"
ok() { echo "ok   $*"; }
die() { echo "FAIL $*" >&2; exit 1; }
py() { python3 -c "$@"; }

curl -fsS "$BASE_URL/api/health" | grep -q '"ok"' || die health
ok health

ws=$(curl -fsS -X POST "$BASE_URL/api/workspaces" -H 'Content-Type: application/json' -d '{}')
token=$(printf '%s' "$ws" | py 'import sys,json; print(json.load(sys.stdin)["token"])')
[ -n "$token" ] || die "workspace token"
ok "create workspace"
AUTH=(-H "Authorization: Bearer $token")

curl -fsS "${AUTH[@]}" "$BASE_URL/api/dashboard?days=30" >/dev/null || die dashboard
ok dashboard

trends=$(curl -fsS "${AUTH[@]}" "$BASE_URL/api/trends?limit=5") || die trends
ok "trends ($(printf '%s' "$trends" | py 'import sys,json; print(len(json.load(sys.stdin)))') items)"

gen=$(curl -fsS "${AUTH[@]}" -X POST "$BASE_URL/api/generate" -H 'Content-Type: application/json' \
  -d '{"platforms":["x","linkedin"],"brief":"smoke test"}') || die generate
ok generate

# find a tracked link code in the generated posts
code=$(curl -fsS "${AUTH[@]}" "$BASE_URL/api/posts?limit=100" | py '
import sys,json,re
d=json.load(sys.stdin)
for p in d:
    m=re.search(r"/r/([A-Za-z0-9_-]+)", json.dumps(p))
    if m: print(m.group(1)); break
')
[ -n "$code" ] || die "no tracked link code found in posts"
posts_clicks() { curl -fsS "${AUTH[@]}" "$BASE_URL/api/dashboard?days=30" | py '
import sys,json
print(int(json.load(sys.stdin).get("real_clicks",0) or 0))'; }
before=$(posts_clicks)
curl -fsS -o /dev/null "$BASE_URL/r/$code" || die "click /r/$code"
after=$(posts_clicks)
[ "$after" -gt "$before" ] || die "real_clicks did not increment ($before -> $after)"
ok "tracked click ($before -> $after)"

tools=$(curl -fsS -X POST "$BASE_URL/mcp" "${AUTH[@]}" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}') || die "mcp tools/list"
printf '%s' "$tools" | grep -q 'get_dashboard' || die "mcp tools/list missing get_dashboard"
ok "mcp tools/list"
echo "smoke passed: $BASE_URL"
