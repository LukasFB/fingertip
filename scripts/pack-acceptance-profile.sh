#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
STAGE=$(mktemp -d)
PROFILE="$STAGE/Profiles/C05B153D-326A-4B17-A30C-CB37BD455B64.sdProfile"
OUTPUT="$ROOT/dist/Fingertip Acceptance.streamDeckProfile"

cleanup() {
  rm -rf "$STAGE"
}
trap cleanup EXIT

mkdir -p \
  "$PROFILE/Profiles/8CAA7626-AE32-4D84-8A66-78BA153340A3" \
  "$PROFILE/Profiles/920FF240-DBED-4DBA-93FF-233BFCD7C16C" \
  "$ROOT/dist"
cp "$ROOT/acceptance/package.json" "$STAGE/package.json"
cp "$ROOT/acceptance/FINGERTIP-ACCEPTANCE.sdProfile/manifest.json" "$PROFILE/manifest.json"
cp \
  "$ROOT/acceptance/FINGERTIP-ACCEPTANCE.sdProfile/Profiles/8caa7626-ae32-4d84-8a66-78ba153340a3/manifest.json" \
  "$PROFILE/Profiles/8CAA7626-AE32-4D84-8A66-78BA153340A3/manifest.json"
cp \
  "$ROOT/acceptance/FINGERTIP-ACCEPTANCE.sdProfile/Profiles/920ff240-dbed-4dba-93ff-233bfcd7c16c/manifest.json" \
  "$PROFILE/Profiles/920FF240-DBED-4DBA-93FF-233BFCD7C16C/manifest.json"

rm -f "$OUTPUT"
(cd "$STAGE" && /usr/bin/zip -qr "$OUTPUT" package.json Profiles)
/usr/bin/unzip -t "$OUTPUT"
