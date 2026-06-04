# Runway

Worship audio control. Schedules pre-service music so it lands exactly at service start in the first song's key, bridges with a sustained pad, hands cleanly to live worship, and accepts cues from ProPresenter over MIDI.

macOS (Apple Silicon) and Windows (x64). Current version: **0.9.16** — see [RELEASE_NOTES.md](RELEASE_NOTES.md).

## Install

Download the latest from `release/`:

- **macOS:** `Runway-0.9.16-arm64.dmg` — drag Runway.app to Applications.
- **Windows:** `Runway-Setup-0.9.16.exe` — run the installer.

Config persists to:
- macOS: `~/Library/Application Support/Runway/config.json`
- Windows: `%APPDATA%\Runway\config.json`

Delete that file to reset the app.

## Develop

```bash
npm install
npm run dev       # Vite + Electron
npm run package   # build macOS DMG
npm run package:win  # build Windows installer
```

Output lands in `release/`.

## What it does

**Pre-service playlist.** Set a target service time and a target key (the key of the first worship song). Runway auto-arranges the playlist so the music lands at the service start, crossfading into the target key at the end. Manual playlists work too — auto-arrange is opt-in per playlist.

**Pad bridge.** When the last track ends, a sustained pad in the target key plays through service start, fading out over the configured duration. The pad library has one entry per Camelot key; the engine auto-picks the right one from the playlist's first/target key.

**Post-service.** A second runway with separate music + pad config runs after the service ends, so the room isn't silent during dismissal.

**Live view.** Big countdown, runway timeline showing every track and the pad bridge, Now Playing card with album art and progress, real-time RMS + peak meters per bus, Master volume + Pad volume sliders, EQ, Start Post-Service / Fade to Pad / Stop All action buttons, and a Quick Test panel for rehearsing transitions.

**MIDI in.** Configurable bindings (note, CC) → actions (Panic, Pad Play, Stop, Skip, etc.). ProPresenter sends notes via IAC on Mac or loopMIDI on Windows.

**MIDI out.** ProPresenter sync — fire a configured note when the runway reaches a given phase. Test button per device to verify routing without leaving the app.

**Remote control PWA.** Phone- or tablet-friendly remote at `http://<host>:<port>/` (the app advertises itself over mDNS / Bonjour). Press-and-hold to unlock, separate operator and viewer PINs, locked-screen album art.

**Pad player.** Standalone — pad pads in any key, triggered from the on-screen piano, MIDI, or the remote. Auto-armed to the currently-playing song's key so you can keep up during transitions.

## Layout

```
src/
├── main/                Electron main process (Node)
│   ├── main.ts          App entry, window setup, IPC, menu, tray
│   ├── preload.ts       contextBridge surface
│   ├── configStore.ts   JSON persistence
│   ├── fileScanner.ts   Audio metadata reader (music-metadata)
│   └── remoteServer.ts  Local HTTP server + mDNS publish
├── renderer/            React UI
│   ├── App.tsx          Top-level router
│   ├── views/           Live, Playlists, Schedule, Settings
│   ├── components/      Reusable UI (MasterFader, BusLevelMeters, etc.)
│   ├── lib/
│   │   ├── audioEngine.ts      Web Audio buses, crossfade, pad, analysers
│   │   ├── midiEngine.ts       Web MIDI in/out
│   │   ├── serviceController.ts  Runway state machine
│   │   └── format.ts
│   ├── state/
│   │   ├── store.ts            Zustand store
│   │   └── engines.tsx         Engines ↔ store wiring
│   └── styles/
├── remote/              Remote-control PWA (plain HTML/CSS/JS)
└── shared/
    ├── types.ts         AppConfig, Track, Playlist, Service, MidiBinding
    ├── music.ts         Camelot wheel + key compatibility
    └── arrange.ts       Auto-arrange algorithm
```

## Concepts

**Camelot wheel.** Used internally for key compatibility. Same number = relative major/minor. ±1 number = perfect 4th/5th. The auto-arrange algorithm picks tracks whose keys form a path that lands on the target.

**Runway.** A scheduled sequence of (music tracks → optional pad bridge) timed to a target end. Pre-service runways arm when their service time is within the configured lead window; post-service runways start when the operator hits "Start Post-Service".

**Phase.** A runway is in one of: `idle`, `music`, `pad`, `done`. The Live view and remote both read off the phase.

**Audible duration vs wall-clock.** Crossfades compress total duration. `audibleDurationSec - (N-1) × crossfadeSec = wallclockSec`. The auto-arranger uses this to make the playlist end exactly at service start.

## Conventions

- TypeScript on both main and renderer.
- Zustand for app state; the audio + MIDI engines push state into it via subscriptions.
- Web Audio scheduling uses `ctx.currentTime` offsets, not reactive ticks. The renderer reads position every 100ms for UI but the underlying schedule is sample-accurate.
- No tests are wired up yet.

## License

Private. Not for distribution.
