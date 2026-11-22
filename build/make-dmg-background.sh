#!/bin/bash
# Generates build/dmg-background.png — the artwork shown behind the icons
# in the mounted DMG window. Uses AppleScript + Cocoa drawing primitives
# so we don't need ImageMagick / sharp / canvas as a build-time dep.
#
# Layout (top-down points, window content 640 wide). Must match the icon
# positions in make-dmg.sh:
#   - Runway.app            centre (160, 190)
#   - Applications symlink  centre (480, 190)
#   - Install Help.html     centre (320, 450)
# The image is 640 × 660 and the window is opened 660 tall, so the bottom
# icon still fits when Finder shows its path bar and status bar (~90 pt).
#
# Cocoa's Y axis is bottom-up; the T() helper converts top-down y values.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/dmg-background.png"

/usr/bin/osascript - "$OUT" <<'OSA'
use framework "AppKit"
use framework "Foundation"

on run argv
  set posixOutPath to item 1 of argv

  set W to 640
  set H to 660

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

  set fontKey to (current application's NSFontAttributeName)
  set colorKey to (current application's NSForegroundColorAttributeName)
  set white to current application's NSColor's whiteColor
  set soft to current application's NSColor's colorWithCalibratedWhite:0.78 alpha:1.0
  set dim to current application's NSColor's colorWithCalibratedWhite:0.55 alpha:1.0
  set teal to current application's NSColor's colorWithCalibratedRed:0.4 green:0.92 blue:0.85 alpha:1.0
  set codeColor to current application's NSColor's colorWithCalibratedRed:0.6 green:0.95 blue:0.92 alpha:1.0

  set titleAttrs to current application's NSDictionary's dictionaryWithObjects:{(current application's NSFont's boldSystemFontOfSize:22), white} forKeys:{fontKey, colorKey}
  set subAttrs to current application's NSDictionary's dictionaryWithObjects:{(current application's NSFont's systemFontOfSize:12), dim} forKeys:{fontKey, colorKey}
  set stepAttrs to current application's NSDictionary's dictionaryWithObjects:{(current application's NSFont's boldSystemFontOfSize:13), teal} forKeys:{fontKey, colorKey}
  set bodyAttrs to current application's NSDictionary's dictionaryWithObjects:{(current application's NSFont's systemFontOfSize:12), soft} forKeys:{fontKey, colorKey}
  set codeAttrs to current application's NSDictionary's dictionaryWithObjects:{(current application's NSFont's userFixedPitchFontOfSize:14), codeColor} forKeys:{fontKey, colorKey}

  -- text, centred horizontally; y = top of the text line, top-down
  my drawCentered("Install Runway", titleAttrs, 24, W, H)
  my drawCentered("Two steps, about a minute. Only needed once per new version.", subAttrs, 58, W, H)
  my drawCentered("STEP 1   DRAG RUNWAY ONTO APPLICATIONS", stepAttrs, 96, W, H)

  -- arrow from Runway → Applications at icon-centre height (190)
  set arrowColor to current application's NSColor's colorWithCalibratedRed:0.3 green:0.85 blue:0.78 alpha:0.9
  arrowColor's setStroke()
  arrowColor's setFill()
  set arrowPath to current application's NSBezierPath's bezierPath()
  arrowPath's setLineWidth:2.5
  arrowPath's moveToPoint:(current application's NSMakePoint(240, H - 190))
  arrowPath's lineToPoint:(current application's NSMakePoint(406, H - 190))
  arrowPath's stroke()
  set head to current application's NSBezierPath's bezierPath()
  head's moveToPoint:(current application's NSMakePoint(412, H - 190))
  head's lineToPoint:(current application's NSMakePoint(398, H - 183))
  head's lineToPoint:(current application's NSMakePoint(398, H - 197))
  head's closePath()
  head's fill()

  -- faint drop target behind the Applications icon, so the spot reads
  -- clearly even when Finder is slow to draw the folder icon
  set target to current application's NSBezierPath's bezierPathWithRoundedRect:(current application's NSMakeRect(480 - 62, H - 274, 124, 146)) xRadius:16 yRadius:16
  target's setLineWidth:1.5
  (current application's NSColor's colorWithCalibratedRed:0.3 green:0.85 blue:0.78 alpha:0.5)'s setStroke()
  target's stroke()

  -- divider between the steps
  (current application's NSColor's colorWithCalibratedWhite:1.0 alpha:0.08)'s setFill()
  current application's NSRectFill(current application's NSMakeRect(60, H - 286, W - 120, 1))

  my drawCentered("STEP 2   CLEAR THE DOWNLOAD BLOCK", stepAttrs, 304, W, H)
  my drawCentered("Open Install Help below and click Copy, then paste into Terminal:", bodyAttrs, 330, W, H)

  -- the command in a dark box
  set boxColor to current application's NSColor's colorWithCalibratedRed:0.01 green:0.02 blue:0.03 alpha:1.0
  boxColor's setFill()
  (current application's NSBezierPath's bezierPathWithRoundedRect:(current application's NSMakeRect(150, H - 386, 340, 32)) xRadius:7 yRadius:7)'s fill()
  my drawCentered("xattr -cr /Applications/Runway.app", codeAttrs, 362, W, H)

  img's unlockFocus()

  -- write PNG
  set tiff to img's TIFFRepresentation()
  set rep to current application's NSBitmapImageRep's imageRepWithData:tiff
  set png to rep's representationUsingType:(current application's NSBitmapImageFileTypePNG) |properties|:(current application's NSDictionary's dictionary())
  png's writeToFile:posixOutPath atomically:true
end run

-- Draws `str` centred horizontally with its top edge at top-down y `yTop`.
on drawCentered(str, attrs, yTop, W, H)
  set aStr to current application's NSAttributedString's alloc()'s initWithString:str attributes:attrs
  set sz to aStr's |size|()
  set w to width of sz
  set h to height of sz
  aStr's drawAtPoint:(current application's NSMakePoint((W - w) / 2, H - yTop - h))
end drawCentered
OSA

echo "[dmg-bg] wrote $OUT"
