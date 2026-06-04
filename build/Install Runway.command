#!/bin/bash
# Removes the macOS Gatekeeper quarantine flag from Runway.app so it can
# launch without the "Runway is damaged" error. Only needed because Runway
# isn't (yet) signed with an Apple Developer ID. Run this once per
# version after dragging Runway.app into your Applications folder.

set -e

APP="/Applications/Runway.app"

clear
echo "==========================="
echo "  Runway install helper"
echo "==========================="
echo

if [ ! -d "$APP" ]; then
  echo "Couldn't find Runway.app in /Applications."
  echo
  echo "Step 1: Drag Runway.app from the disk image window into the"
  echo "        Applications folder shortcut next to it."
  echo "Step 2: Run this script again."
  echo
  read -n 1 -s -r -p "Press any key to close this window..."
  exit 1
fi

echo "Found Runway at $APP"
echo "Removing quarantine flag..."
xattr -cr "$APP"

echo "Done."
echo "Launching Runway..."
open "$APP"

# Brief pause so the user sees the success message before Terminal closes.
sleep 1
