#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOOLCHAINS_DIR=${STACKCHAN_TOOLCHAINS_DIR:-"$ROOT/.toolchains"}
DOWNLOADS_DIR="$TOOLCHAINS_DIR/downloads"
JAVA_HOME="$TOOLCHAINS_DIR/temurin-17"
ANDROID_SDK_ROOT="$TOOLCHAINS_DIR/android-sdk"

JDK_ARCHIVE="$DOWNLOADS_DIR/OpenJDK17U-jdk_x64_linux_hotspot_17.0.19_10.tar.gz"
JDK_URL="https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.19%2B10/OpenJDK17U-jdk_x64_linux_hotspot_17.0.19_10.tar.gz"
JDK_SHA256="d8afc263758141a66e0e3aafc321e783f7016696f4eaea067d340a269037d331"

ANDROID_TOOLS_ARCHIVE="$DOWNLOADS_DIR/commandlinetools-linux-14742923_latest.zip"
ANDROID_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip"
ANDROID_TOOLS_SHA256="04453066b540409d975c676d781da1477479dde3761310f1a7eb92a1dfb15af7"

if [[ $(uname -s) != "Linux" || $(uname -m) != "x86_64" ]]; then
  echo "This bootstrap script supports Linux x86_64 only." >&2
  exit 1
fi
for command_name in curl tar unzip sha256sum; do
  command -v "$command_name" >/dev/null || {
    echo "Required command is missing: $command_name" >&2
    exit 1
  }
done

download() {
  local url=$1
  local destination=$2
  if [[ -f "$destination" ]]; then
    return
  fi
  curl --fail --location --retry 3 --retry-delay 2 "$url" --output "$destination.tmp"
  mv "$destination.tmp" "$destination"
}

verify_sha256() {
  local expected=$1
  local file=$2
  printf '%s  %s\n' "$expected" "$file" | sha256sum --check --status
}

mkdir -p "$DOWNLOADS_DIR"

if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  download "$JDK_URL" "$JDK_ARCHIVE"
  verify_sha256 "$JDK_SHA256" "$JDK_ARCHIVE" || {
    echo "JDK checksum verification failed: $JDK_ARCHIVE" >&2
    exit 1
  }
  rm -rf "$JAVA_HOME"
  mkdir -p "$JAVA_HOME"
  tar -xzf "$JDK_ARCHIVE" --strip-components=1 -C "$JAVA_HOME"
fi

export JAVA_HOME
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_SDK_ROOT
export PATH="$JAVA_HOME/bin:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools:$PATH"

if [[ ! -x "$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]]; then
  download "$ANDROID_TOOLS_URL" "$ANDROID_TOOLS_ARCHIVE"
  verify_sha256 "$ANDROID_TOOLS_SHA256" "$ANDROID_TOOLS_ARCHIVE" || {
    echo "Android command-line tools checksum verification failed: $ANDROID_TOOLS_ARCHIVE" >&2
    exit 1
  }
  rm -rf "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  mkdir -p "$ANDROID_SDK_ROOT/cmdline-tools/latest"
  unzip -q "$ANDROID_TOOLS_ARCHIVE" -d "$TOOLCHAINS_DIR/android-command-line-tools"
  cp -a "$TOOLCHAINS_DIR/android-command-line-tools/cmdline-tools/." \
    "$ANDROID_SDK_ROOT/cmdline-tools/latest/"
  rm -rf "$TOOLCHAINS_DIR/android-command-line-tools"
fi

set +o pipefail
yes | sdkmanager --licenses >/dev/null
set -o pipefail
sdkmanager \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;35.0.0"

mkdir -p "$ROOT/.gradle"
printf 'java.home=%s\n' "$JAVA_HOME" > "$ROOT/.gradle/config.properties"
printf 'sdk.dir=%s\n' "$ANDROID_SDK_ROOT" > "$ROOT/local.properties"

echo "Local development environment is ready."
echo "Run commands with: ./scripts/dev.sh <command>"
