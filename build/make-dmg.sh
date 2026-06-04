#!/bin/bash
# Builds release/Runway-<version>-arm64.dmg from the .app electron-builder
# already produced. Hand-rolled instead of relying on electron-builder's
# DMG step because that step's AppleScript-based background-image setup
# fails silently on Apple Silicon — the .DS_Store ends up referencing
# the image but Finder renders the window blank.
#
# This script:
#   1. Stages the contents (.app, .command, .txt, .background/) in a tmp dir
#   2. Creates a read-write HFS+ DMG large enough to hold them
#   3. Mounts it, uses AppleScript to set window background + icon
#      positions + view options
#   4. Unmounts, converts to compressed read-only UDZO
#   5. Replaces release/Runway-<version>-arm64.dmg

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="arm64"
VOLNAME="Runway $VERSION"
OUT="$ROOT/release/Runway-$VERSION-$ARCH.dmg"
APP_SRC="$ROOT/release/mac-$ARCH/Runway.app"
STAGE="$(mktemp -d)/runway-dmg-stage"
RW_DMG="$(dirname "$STAGE")/runway-rw.dmg"

if [[ ! -d "$APP_SRC" ]]; then
  echo "[make-dmg] Runway.app not found at $APP_SRC. Run electron-builder first."
  exit 1
fi

echo "[make-dmg] staging contents in $STAGE"
mkdir -p "$STAGE/.background"
cp -R "$APP_SRC" "$STAGE/Runway.app"
cp "$ROOT/build/HOW TO INSTALL.txt" "$STAGE/HOW TO INSTALL.txt"
cp "$ROOT/build/dmg-background.png" "$STAGE/.background/dmg-background.png"
ln -s /Applications "$STAGE/Applications"

echo "[make-dmg] creating read-write DMG"
# Size budget: app (~190MB) + slack. UDRW is read-write so the AppleScript
# below can mutate the .DS_Store.
hdiutil create -srcfolder "$STAGE" \
  -volname "$VOLNAME" \
  -fs HFS+ \
  -fsargs "-c c=64,a=16,e=16" \
  -format UDRW \
  -size 250m \
  "$RW_DMG" >/dev/null

echo "[make-dmg] mounting and configuring window"
MOUNT_OUT="$(hdiutil attach -readwrite -noverify -noautoopen "$RW_DMG")"
DEVICE="$(echo "$MOUNT_OUT" | egrep '^/dev/' | sed 1q | awk '{print $1}')"
MOUNT_POINT="$(echo "$MOUNT_OUT" | egrep -o '/Volumes/.*$' | sed 1q)"
# Ensure the mount is cleaned up even if the AppleScript below fails —
# otherwise a stuck volume blocks the next package run.
cleanup() {
  hdiutil detach "$DEVICE" >/dev/null 2>&1 || true
  rm -f "$RW_DMG" 2>/dev/null || true
  rm -rf "$STAGE" 2>/dev/null || true
}
trap cleanup EXIT
sleep 2

# AppleScript that drives Finder to set the window appearance. We have to
# `open` the volume so Finder reads .DS_Store, mutate icon view options,
# then close + sync so the .DS_Store changes flush before unmount.
osascript <<APPLESCRIPT
-- Finder can be very slow to respond to scripted window changes on
-- modern macOS, hence the long timeout. Each operation gets a small
-- delay so Finder has time to commit before the next mutation.
with timeout of 120 seconds
  tell application "Finder"
    activate
    tell disk "$VOLNAME"
      open
      delay 2
      set current view of container window to icon view
      set toolbar visible of container window to false
      set statusbar visible of container window to false
      set the bounds of container window to {200, 120, 840, 720}
      set viewOpts to the icon view options of container window
      set arrangement of viewOpts to not arranged
      set icon size of viewOpts to 96
      set background picture of viewOpts to file ".background:dmg-background.png"
      delay 1
      set position of item "Runway.app" of container window to {160, 200}
      set position of item "Applications" of container window to {480, 200}
      set position of item "HOW TO INSTALL.txt" of container window to {320, 460}
      delay 1
      update without registering applications
      delay 3
      close
    end tell
  end tell
end timeout
APPLESCRIPT

sync
hdiutil detach "$DEVICE" >/dev/null

echo "[make-dmg] converting to UDZO and replacing $OUT"
mkdir -p "$ROOT/release"
rm -f "$OUT"
hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -o "$OUT" >/dev/null
rm -f "$RW_DMG"
rm -rf "$STAGE"

echo "[make-dmg] done: $OUT"
ls -lh "$OUT"
