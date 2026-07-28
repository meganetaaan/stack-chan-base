#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ANDROID_APP="$ROOT/apps/android-local-voice"
CODEX_APP="$ROOT/apps/codex-voice"
status=0

if ! (
  cd "$ANDROID_APP" || exit 1
  ./scripts/verify.sh
); then
  echo "Android dock app verification failed." >&2
  status=1
fi

if [[ ! -d "$CODEX_APP/node_modules" ]]; then
  echo "Codex dock app dependencies are missing. Run: cd apps/codex-voice && npm ci" >&2
  status=1
elif ! (
  cd "$CODEX_APP" || exit 1
  npm test
); then
  echo "Codex dock app verification failed." >&2
  status=1
fi

exit "$status"
