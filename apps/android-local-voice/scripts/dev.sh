#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOOLCHAINS_DIR=${STACKCHAN_TOOLCHAINS_DIR:-"$ROOT/.toolchains"}
JAVA_HOME="$TOOLCHAINS_DIR/temurin-17"
ANDROID_SDK_ROOT="$TOOLCHAINS_DIR/android-sdk"

if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "JDK is not installed. Run ./scripts/bootstrap-dev.sh first." >&2
  exit 1
fi
if [[ ! -x "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]]; then
  echo "Android SDK is not installed. Run ./scripts/bootstrap-dev.sh first." >&2
  exit 1
fi

export JAVA_HOME
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT
export GRADLE_USER_HOME=${STACKCHAN_GRADLE_USER_HOME:-"$ROOT/.gradle-user-home"}
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

if [[ $# -eq 0 ]]; then
  exec "${SHELL:-/bin/bash}" --noprofile --norc
fi

exec "$@"
