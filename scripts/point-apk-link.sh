#!/usr/bin/env bash
# Wait for an EAS Android build to finish, then point https://pulse-hackathon.fly.dev/download/android at its APK.
# Usage: scripts/point-apk-link.sh <eas-build-id>     (run from the repo root; needs eas-cli and flyctl logged in)
# A new APK should follow every batch of fixes: a fresh install runs the APK's own code first (2026-11-21).
set -euo pipefail
id="${1:?eas build id}"
cd "$(dirname "$0")/../apps/mobile"
for _ in $(seq 1 90); do
  out="$(npx eas-cli build:view "$id" 2>&1 || true)"
  status="$(printf '%s\n' "$out" | awk '/^Status/{print $2; exit}')"
  url="$(printf '%s\n' "$out" | awk '/^Application Archive URL/{print $4; exit}')"
  case "$status" in
    finished)
      case "$url" in https://*.apk) ;; *) echo "finished but no APK url"; exit 1 ;; esac
      flyctl secrets set "ANDROID_APK_URL=$url" -a pulse-hackathon >/dev/null
      echo "download link now points at build $id: $url"
      exit 0 ;;
    errored|canceled) echo "build $id $status"; exit 1 ;;
  esac
  sleep 30
done
echo "timed out waiting for build $id"; exit 1
