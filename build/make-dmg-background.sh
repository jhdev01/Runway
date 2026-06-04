#!/bin/bash
# Generates build/dmg-background.png — the artwork shown behind the icons
# in the mounted DMG window. Uses AppleScript + Cocoa drawing primitives
# so we don't need ImageMagick / sharp / canvas as a build-time dep.
#
# Layout matches package.json's dmg.contents entries (see that file for
# canonical positions):
#   - Runway.app at (160, 200)
#   - Applications symlink at (480, 200)
#   - Install Runway.command at (320, 360)
#   - HOW TO INSTALL.txt at (320, 480)
# Window size 640 × 600.
#
# Cocoa's Y axis is flipped relative to electron-builder's (Cocoa = bottom-up,
# electron-builder = top-down). The script does the conversion inline.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/dmg-background.png"

/usr/bin/osascript - "$OUT" <<'OSA'
use framework "AppKit"
use framework "Foundation"

on run argv
  set posixOutPath to item 1 of argv

  set W to 640
  set H to 600

  set imgSize to current application's NSMakeSize(W, H)
  set img to current application's NSImage's alloc()'s initWithSize:imgSize
  img's lockFocus()

  -- background gradient (deep navy → near-black)
  set topColor to current application's NSColor's colorWithCalibratedRed:0.04 green:0.06 blue:0.10 alpha:1.0
  set botColor to current application's NSColor's colorWithCalibratedRed:0.02 green:0.03 blue:0.05 alpha:1.0
  set grad to current application's NSGradient's alloc()'s initWithStartingColor:botColor endingColor:topColor
  grad's drawInRect:(current application's NSMakeRect(0, 0, W, H)) angle:90

  -- top accent stripe in app teal
  set accent to current application's NSColor's colorWithCalibratedRed:0.08 green:0.72 blue:0.65 alpha:0.55
  accent's setFill()
  current application's NSRectFill(current application's NSMakeRect(0, H - 3, W, 3))

  -- attribute helpers
  set fontKey to (current application's NSFontAttributeName)
  set colorKey to (current application's NSForegroundColorAttributeName)

  set white to current application's NSColor's whiteColor
  set dim to current application's NSColor's colorWithCalibratedWhite:0.55 alpha:1.0
  set teal to current application's NSColor's colorWithCalibratedRed:0.4 green:0.92 blue:0.85 alpha:1.0

  -- title
  set titleFont to current application's NSFont's boldSystemFontOfSize:22
  set titleAttrs to current application's NSDictionary's dictionaryWithObjects:{titleFont, white} forKeys:{fontKey, colorKey}
  (current application's NSAttributedString's alloc()'s initWithString:"Install Runway" attributes:titleAttrs)'s drawAtPoint:(current application's NSMakePoint(244, H - 50))

  -- subtitle
  set subFont to current application's NSFont's systemFontOfSize:12
  set subAttrs to current application's NSDictionary's dictionaryWithObjects:{subFont, dim} forKeys:{fontKey, colorKey}
  (current application's NSAttributedString's alloc()'s initWithString:"Two steps. The Terminal command clears macOS Gatekeeper." attributes:subAttrs)'s drawAtPoint:(current application's NSMakePoint(140, H - 78))

  -- step labels (in app teal)
  set stepFont to current application's NSFont's boldSystemFontOfSize:13
  set stepAttrs to current application's NSDictionary's dictionaryWithObjects:{stepFont, teal} forKeys:{fontKey, colorKey}
  (current application's NSAttributedString's alloc()'s initWithString:"STEP 1   DRAG RUNWAY → APPLICATIONS" attributes:stepAttrs)'s drawAtPoint:(current application's NSMakePoint(146, H - 152))
  (current application's NSAttributedString's alloc()'s initWithString:"STEP 2   OPEN TERMINAL AND RUN:" attributes:stepAttrs)'s drawAtPoint:(current application's NSMakePoint(176, H - 282))

  -- the actual command, monospace + brighter
  set codeFont to current application's NSFont's userFixedPitchFontOfSize:14
  set codeColor to current application's NSColor's colorWithCalibratedRed:0.6 green:0.95 blue:0.92 alpha:1.0
  set codeAttrs to current application's NSDictionary's dictionaryWithObjects:{codeFont, codeColor} forKeys:{fontKey, colorKey}
  (current application's NSAttributedString's alloc()'s initWithString:"xattr -cr /Applications/Runway.app" attributes:codeAttrs)'s drawAtPoint:(current application's NSMakePoint(150, H - 308))

  -- caveat
  set caveatAttrs to current application's NSDictionary's dictionaryWithObjects:{(current application's NSFont's systemFontOfSize:11), dim} forKeys:{fontKey, colorKey}
  (current application's NSAttributedString's alloc()'s initWithString:"Open HOW TO INSTALL.txt below for details." attributes:caveatAttrs)'s drawAtPoint:(current application's NSMakePoint(192, H - 336))

  -- arrow from Runway → Applications (icons centered at y=200 top-down → H-200 bottom-up)
  set arrowColor to current application's NSColor's colorWithCalibratedRed:0.3 green:0.85 blue:0.78 alpha:0.9
  arrowColor's setStroke()
  arrowColor's setFill()
  set arrowPath to current application's NSBezierPath's bezierPath()
  arrowPath's setLineWidth:2.5
  arrowPath's moveToPoint:(current application's NSMakePoint(250, H - 200))
  arrowPath's lineToPoint:(current application's NSMakePoint(430, H - 200))
  arrowPath's stroke()
  set head to current application's NSBezierPath's bezierPath()
  head's moveToPoint:(current application's NSMakePoint(430, H - 200))
  head's lineToPoint:(current application's NSMakePoint(418, H - 194))
  head's lineToPoint:(current application's NSMakePoint(418, H - 206))
  head's closePath()
  head's fill()

  img's unlockFocus()

  -- write PNG
  set tiff to img's TIFFRepresentation()
  set rep to current application's NSBitmapImageRep's imageRepWithData:tiff
  set png to rep's representationUsingType:(current application's NSBitmapImageFileTypePNG) |properties|:(current application's NSDictionary's dictionary())
  png's writeToFile:posixOutPath atomically:true
end run
OSA

echo "[dmg-bg] wrote $OUT"
