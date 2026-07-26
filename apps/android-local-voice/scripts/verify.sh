#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
python3 "$ROOT/scripts/check_project.py"
if command -v kotlinc >/dev/null; then
  "$ROOT/scripts/run_pure_kotlin_smoke.sh"
fi
"$ROOT/scripts/dev.sh" ./gradlew :app:testDebugUnitTest
