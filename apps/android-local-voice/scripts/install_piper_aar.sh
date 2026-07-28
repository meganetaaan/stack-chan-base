#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 ]]; then
  echo "usage: $0 /path/to/piper-plus-release.aar" >&2
  exit 2
fi
SOURCE=$1
[[ -f "$SOURCE" ]] || { echo "AAR not found: $SOURCE" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DESTINATION="$ROOT/app/libs/piper-plus-release.aar"
CHECKSUM_FILE="$ROOT/app/libs/piper-plus-release.aar.sha256"
python3 "$ROOT/scripts/isolate_piper_onnx.py" "$SOURCE" "$DESTINATION"
(
  cd "$ROOT"
  sha256sum "app/libs/piper-plus-release.aar" > "$CHECKSUM_FILE"
)
echo "Installed: $DESTINATION"
echo "Checksum: $CHECKSUM_FILE"
echo "Re-sync/rebuild the Android app so BuildConfig detects the AAR."
