# Runway v0.9.16

Release date: 2026-05-16

Builds: `release/Runway-0.9.16-arm64.dmg` (macOS, Apple Silicon) · `release/Runway-Setup-0.9.16.exe` (Windows, x64)

## New

**Live audio level meters.** Two real-time bars in the Live view (Music and Pad) show RMS loudness with a peak-hold tick that floats up on transients and decays over ~3 seconds. The rightmost ~15% of the track shades into yellow/red so clipping is visible at a glance without the whole bar turning red on quiet signals. Meters tap the engine's existing analyser nodes in parallel — no added latency.

**Pad volume slider.** A second slider sits next to the Main volume in the Master panel and rides the pad output level (separate from the dB trim in Settings). Defaults to 60%.

**Double-click sliders to reset.** Main → 0 dB (unity), Pad → 60% (default). The standalone "0 dB" reset button is gone; double-click is the new convention for both.

**MIDI test-send.** Each MIDI output device in Settings has a Test button that fires a quick note-on/note-off so you can verify your routing without opening a DAW.

## Fixes

**Now Playing now clears when the playlist finishes.** The last track's title used to stay pinned in the "Now Playing" card after audio stopped — the engine was still reporting the last track's id past the schedule's end time. Fixed at the boundary so the card falls back to "— nothing playing —" within 100ms of the music ending.

**Quick Test button no longer flips to "Stop" during post-service.** The Live view's quick-test detection treated post-service runways as quick tests because both have no service id. Now requires the runway not to be in post-service mode.

**Audio meters were dead until you played something twice.** Routing buses (e.g. switching music output device) was severing the analyser tap. The meters now stay live across route changes.

## Behind the scenes

- Bus level reads from a parallel `AnalyserNode` (fftSize 512, smoothing 0.2) off each bus's master node — no added latency to the audible signal.
- Meter dB mapping: −60 dB → 0%, 0 dB → 100% (perceptual scale).
- Pad volume change pipeline: `defaults.padPlayerLevel` (config) → `engines.tsx` subscription → `audio.setPadLevel(volume × 10^(gainDb/20))`.

## On the horizon

- In-app update check (deferred from this release).
- Branded PDF rendering for reminder emails (Theory Print invoice tool — separate project).
- Xero multi-rate tax setup guide (separate project, pending state/county/city rate config).

---

# Older releases (highlights)

## v0.9.x — Remote control polish

- Press-and-hold to unlock the remote PWA with audio-wave bar animation
- Separate operator and viewer PINs; viewer can see status but can't trigger actions
- Locked-screen album art under the timer
- macOS mDNS publish via `dns-sd` subprocess (works around the Node multicast-dns library's port 5353 contention)

## v0.9.x — Runway timing accuracy

- `audibleDurationSec` subtracts `(N-1) × crossfadeSec` so playlist end time matches wall-clock service start
- Preload is awaited before arm completes, so the first crossfade timing isn't off by the load delay
- Web Audio scheduling uses `ctx.currentTime` offsets instead of reactive ticks

## v0.9.x — App polish

- Close-to-tray on Windows and macOS
- File / Edit menu items: About, Preferences, Reload, View Logs
- Header "Sync Now" button replaced the footer-only sync trigger
