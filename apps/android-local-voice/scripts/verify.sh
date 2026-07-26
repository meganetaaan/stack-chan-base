#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
python3 "$ROOT/scripts/check_project.py"
"$ROOT/scripts/run_pure_kotlin_smoke.sh"
