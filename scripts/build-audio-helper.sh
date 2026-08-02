#!/bin/zsh
set -euo pipefail

plugin_bin="com.lukas-bhm.fingertip.sdPlugin/bin"
temporary_dir="$(mktemp -d -t fingertip-audio-helper)"
trap 'rm -rf "$temporary_dir"' EXIT

mkdir -p "$plugin_bin"
swiftc -O -target arm64-apple-macosx13.0 \
  native/notification-audio.swift \
  -framework AVFoundation \
  -o "$temporary_dir/audio-notifier-arm64"
swiftc -O -target x86_64-apple-macosx13.0 \
  native/notification-audio.swift \
  -framework AVFoundation \
  -o "$temporary_dir/audio-notifier-x86_64"
lipo -create \
  "$temporary_dir/audio-notifier-arm64" \
  "$temporary_dir/audio-notifier-x86_64" \
  -output "$plugin_bin/audio-notifier"
