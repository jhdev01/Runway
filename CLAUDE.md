# Runway — Claude Code project notes

Worship audio control for macOS (and Windows). Schedules pre-service music so it lands exactly at service start in the first song's key, bridges with a sustained pad, hands cleanly to live worship, and accepts cues from ProPresenter over MIDI. A phone PWA remote-controls the runway over the LAN.

Current version: see `package.json`. Latest packaged installers on GitHub Releases: https://github.com/jhdev01/Runway/releases.

---

## Stack

- **Framework:** Electron 29 + React 18 + TypeScript + Vite 5.
- **State:** Zustand store (`src/renderer/state/store.ts`).
- **Audio:** Web Audio API, sample-accurate scheduling via `ctx.currentTime` offsets.
- **MIDI:** Web MIDI for input/output, with the action-binding system in `src/renderer/lib/midiEngine.ts`.
- **ProPresenter:** custom HTTP client in `src/renderer/lib/proPresenterClient.ts`. Triggers slides/playlist items and reads timer state.
- **Remote:** plain HTML/CSS/JS PWA under `src/remote/`, served from the Electron main process at `runway.local:7811` (mDNS) or the LAN IP.
- **Packaging:** electron-builder. Mac uses ad-hoc codesigning (see `build/make-dmg.sh`). Windows uses NSIS.
- **CI:** GitHub Actions (`.github/workflows/build.yml`). Builds Mac DMG + Windows EXE on every push to `main`; publishes a GitHub Release on `v*` tag pushes.

---

## Project layout

```
src/
├── main/                Electron main process (Node)
│   ├── main.ts          App entry, window setup, IPC, menu, tray, uncaughtException guard
│   ├── preload.ts       contextBridge surface (window.runway.*)
│   ├── configStore.ts   JSON persistence to ~/Library/Application Support/Runway
│   ├── fileScanner.ts   Audio metadata reader (music-metadata lib)
│   └── remoteServer.ts  HTTP/WS server + mDNS publish (multicast-dns + dns-sd subprocess)
├── renderer/            React UI
│   ├── App.tsx          Top-level router (Live, Schedule, Playlists, Editor, Library, Settings, Actions)
│   ├── views/           One per top-level tab
│   ├── components/      Reusable UI pieces
│   ├── lib/
│   │   ├── audioEngine.ts      Music + pad buses, scheduleRunway (precise), playMusic + crossfadeToMusic (reactive)
│   │   ├── midiEngine.ts       Web MIDI in/out, binding-match dispatcher
│   │   ├── serviceController.ts  Runway state machine — arming, tick, phase transitions, actions
│   │   ├── proPresenterClient.ts ProPresenter integration
│   │   ├── format.ts             todayISO(), formatDuration, parseTime, etc.
│   │   └── actionMeta.ts         Action sequence model + helpers
│   ├── state/
│   │   ├── store.ts            Zustand store (config persistence, currentRunway, midiLog, etc.)
│   │   └── engines.tsx         Wires audio/midi/pp engines to the store; remote-snapshot heartbeat
│   └── styles/
├── remote/              Phone PWA — index.html + main.js + main.css (vanilla; bundled as static)
└── shared/
    ├── types.ts         AppConfig, Track, Playlist, ServiceInstance, MidiBinding, ActionSequence
    ├── music.ts         Camelot wheel + key compatibility
    └── arrange.ts       Auto-arrange algorithm (pick tracks to land in target key at target time)
```

Config persists to `~/Library/Application Support/Runway/config.json` on macOS, `%APPDATA%\Runway\config.json` on Windows.

---

## Critical conventions

These have come up multiple times and breaking them causes real damage:

### 🛑 Never change timing without explicit operator OK

Joey treats "the music ends at the right moment" as sacred. Anything that touches scheduling (`musicStartMs`, `padStartMs`, `targetMs`, `firstTrackOffsetSec`, `scheduleRunway` timing args, `crossfadeSec`, `musicFadeInSec`, `editServiceLandSec`) is high-risk. Always:

- Verify the change you're making is to the **gain envelope** or **filter/selection** logic, not the timeline.
- When asked to change a fade, explicitly note that no timing is changed.
- If you're unsure whether something affects timing, ask before touching.

### Local date, not UTC

Service dates are stored as `YYYY-MM-DD` in the operator's **local** timezone. Anything that derives "today" should use `todayISO()` from `src/renderer/lib/format.ts`, NOT `new Date().toISOString().slice(0, 10)` (which is UTC and silently breaks the countdown in the evening on Pacific time).

### Audio engine paths

- **Pre-service runways** (real services, not Quick Test) use the **scheduled path**: `audioEngine.scheduleRunway()` commits every transition to `ctx.currentTime + N` up front. Sample-accurate.
- **Post-service, Quick Play, mid-runway operator skips** use the **reactive path**: `playMusic` + `crossfadeToMusic` + `advanceMusic` tick. Less precise but supports scrubbing.
- The choice is `useScheduled = runway.serviceId !== null && !runway.isPostService;` in `startTrack` / `beginMusic`.

### Fade rules

- **First-track fade-in** = `max(defaults.musicFadeInSec, track.editFadeInSec)`. Applied unconditionally — don't gate it on `trackOffset === 0` (that broke the action-driven swap; small offsets are normal due to preload/tick lag).
- **Anchor track's `editFadeOutSec`** applies as the audible fade at end-of-service. When set, the controller defers its own external `fadeOutMusic` so the two envelopes don't compound. Works for both pad-bridge and no-pad scenarios.
- **Inter-track transitions** within a runway use the playlist's `crossfadeSec`, not editFade* fields.

### mDNS error suppression

The multicast-dns library throws `EHOSTUNREACH 224.0.0.251:5353` (and similar) as uncaught exceptions when the host has no usable IPv4 interface. `src/main/main.ts` has a `process.prependListener('uncaughtException', ...)` that swallows just these. Don't remove it; don't broaden it to catch other errors.

### ad-hoc codesigning on macOS

`build/make-dmg.sh` runs `codesign --force --deep --sign - <app>` (NO `--options runtime`) to satisfy Apple Silicon's "needs a signature" check. Adding `--options runtime` enables hardened runtime, which requires signed entitlements — without them the app crashes with "Runway cannot be opened because of a problem."

### Cross-platform build scripts

The `build:remote` script went through `rm -rf && mkdir -p && cp` (Unix shell) and now uses `node build/copy-remote.js` so it works on Windows GitHub Actions runners. Any new build steps that touch the filesystem should use Node, not shell.

---

## Operator (Joey)

- Non-technical relative to the codebase. Knows the business (live worship audio) extremely well.
- Tests in the dev build constantly; iterates quickly via screenshots.
- Distributes to himself + a small church team. No Apple Developer ID, no Windows code-signing cert.
- Prefers operator-friendly defaults; gear icons should hide complexity.
- Works on a Mac for Runway dev; the app also targets Windows via packaging.

When proposing changes that visibly affect the UI:
- Lead with WHAT changes, not WHY in the source code (Joey reads diffs/screenshots, not code).
- Note explicitly when something does or doesn't affect timing.
- If a change is risky, offer the conservative path first.

---

## Known gotchas

- **`scheduleRunway` last track** previously had no fade-out applied (designed for pad-bridge handoff). Now the operator's `editFadeOutSec` *is* applied on the last track when set — see `audioEngine.ts`. Don't revert this.
- **`firstTrackOffsetSec` is preserved** during action-driven `arm_playlist` swaps — small offset is normal (preload + tick lag). Don't round it to 0 (that would shift timing).
- **`getActiveService()` in serviceController** returns upcoming/running services only. For end-of-service triggers (post-service), use `getMostRecentServiceToday()` so the right service's overrides apply after the service is past.
- **Auto-arm timing**: pre-service music materializes on the controller tick when `now >= musicStartMs`. Don't pre-schedule audio earlier than that.
- **`triggerPostService` guards**: refuses when an actively-playing pre-service runway (phase music or pad) exists. Queued is fine to clobber. Don't tighten the guard.
- **Settings → Engine → Auto-schedule services** has a configurable daily check time (`autoScheduleTime`). The materializer fires as a one-shot `setTimeout` to the next configured time, not on a heartbeat. Don't switch back to interval-based.

---

## Useful conventions

- API surface lives on `window.runway.*` (defined in preload).
- IPC channel names live in `shared/types.ts` under `IPC.*` — use the const, not a literal string.
- New fields added to `Track`, `Playlist`, `ServiceInstance`, etc. should go into `shared/types.ts` and default sensibly so old configs upgrade cleanly.
- New defaults go on `AppConfig.defaults` and ALSO update `DEFAULT_CONFIG` at the bottom of `shared/types.ts`. Load-time migration in `store.ts` reads `loaded?.defaults?.fieldName ?? DEFAULT_CONFIG.defaults.fieldName`.
- For ad-hoc Node migrations during config load, follow the pattern in `loadConfig` — defensive about `unknown` raw values, default-on-fail.
- New "remote" commands go in three places: `RemoteCommand` union + valid-list in `remoteServer.ts`, dispatch handler in `engines.tsx`, send-call in `src/remote/main.js`.

---

## Build / packaging

- `npm run dev` — Vite + Electron in dev mode (HMR for renderer; main needs restart on changes).
- `npm run package` — builds + ad-hoc signs + DMG (macOS only). Output: `release/Runway-<ver>-arm64.dmg`.
- `npm run package:win` — builds + NSIS EXE. Output: `release/Runway-Setup-<ver>.exe`.
- GitHub Actions builds both on every push to `main`. Tag pushes (`vX.Y.Z`) publish a GitHub Release with both installers attached.
- To cut a release: `git tag vX.Y.Z && git push origin vX.Y.Z` (version field in `package.json` is independent of the git tag — both should match).

---

## Where to start

If you're a Claude session picking this project up:

1. Skim `docs/HANDOFF.md` for current state and any in-flight work.
2. Read this file fully — the conventions are load-bearing.
3. Read the relevant source for whatever the operator's asking about. Don't grep wide.
4. Ask before changing timing-related code.
