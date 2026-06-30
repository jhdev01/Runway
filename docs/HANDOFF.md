# Handoff — current state

Living doc. Update when something material changes; replace the "Recent work" section when a new release ships.

---

## Current state (as of v10.1.2)

- **Latest release:** v10.1.2, with installers attached on the GitHub Release.
- **Repo:** https://github.com/jhdev01/Runway
- **CI:** push-to-main builds DMG + EXE artifacts (30-day retention). Pushing a `v*` tag publishes a permanent GitHub Release with both installers attached.
- **Signing:** macOS — ad-hoc only (`codesign --sign -`, no hardened runtime). Windows — unsigned. No paid certs.
- **Distribution:** small team, downloaded from GitHub Releases.

---

## Recent work (post-v10.1.2, unreleased)

### Look-ahead pre-warm before runway-mutating actions (10.2.1)
The between-service fill (post-service → `arm_playlist` "music to fill")
could hit a COLD decode whenever shuffle/anchor selection picked tracks the
current service never played — the buffer cache is keyed per-file and an arm
only decodes its own arrangement, not the whole pool. Cold decode there =
silence gap on the handoff + late landing. Fix: `fireDueActions` now starts a
background decode of a runway-mutating action's target playlist pool
(`PREWARM_LEAD_MS` = 30s before its fire time), whole pool not just one
arrangement, once per playlist per arm cycle (`prewarmedPlaylistIds`, cleared
with `firedActionIds`). Pure cache-warming via `loadBuffer`; the in-flight
dedup (below) means it never double-decodes against the real arm. Fix #3
still guarantees the landing if a decode is mid-flight when the action fires;
pre-warm removes the silence gap on top.

### Dual-audio + late-landing fixes (audio engine / auto-arm)
Root-caused the "two songs playing at once but the runway shows one" incident
(back-to-back services, post-service → arm_playlist "music to fill" action):

- **Music-bus claim token (`musicEpoch`)** — `playMusic` / `crossfadeToMusic` /
  `scheduleRunway` each take a token at entry and re-check it after their
  decode awaits; a stale call bails without starting sources. Previously two
  interleaved async starts could both complete, and the loser's sources kept
  playing — untracked, invisible in the UI, and unreachable by Panic.
  `fadeOutMusic` / `stopMusic` also bump the token so a panic cancels plays
  still decoding.
- **Panic safety net** — every music-bus source is registered in
  `liveMusicNodes` (auto-removed on end); `panicFadeAll` sweeps the set so
  no source can outlive a panic even if slot bookkeeping ever loses one.
- **`loadBuffer` in-flight dedup** — concurrent loads of the same file share
  one fetch+decode. armService's preloader and `scheduleRunway` used to
  decode every track twice in parallel on the fill-arm path.
- **`scheduleRunway` start-latency compensation** — decode time + lead-in is
  now skipped INTO the first track (same as the reactive path always did)
  instead of delaying the whole runway. Previously a cold-cache arm (the
  arm_playlist fill flow) shifted the entire runway — anchor landing
  included — late by ~2× the decode time, which is why the song didn't end
  at countdown 0:00. The schedule math itself (track order, transitions,
  landing) is unchanged; only the start-alignment error is removed.
- **Deferred auto-arm re-check** — LiveView's musicFireMs `setTimeout` re-runs
  its guards at fire time, so it can't double-arm a service the arm_playlist
  action already armed (the other half of the dual-audio race).

### Disarm always silences the music bus
Operator report: "disarming a service should stop music but didn't."
`armToggle`'s disarm only faded when the runway phase wasn't `queued`, and
its arm branch only faded post-service audio — so arming over a playing
Quick Play left that music rolling under the queued runway, where disarm
couldn't reach it. Now: disarm always fades the music bus (music-only via
`panicFadeMusic` in the queued case, so a manually fired pad survives;
full `panicFadeAll` when the runway is audibly firing), and arming fades
ANY audible runway (post-service, Quick Play music, lingering pad), not
just post-service.

### ProPresenter countdown delivery is now reconciled, not one-shot
The PP countdown was a one-shot at music start with no retry — if Pro7 was
launched after music started, crashed mid-service, or had its window closed
and reopened while its API stayed up (macOS keeps PP running with the
window closed, so the status light correctly stays green and there is no
offline→online transition to react to), the timer never appeared. The 10s
heartbeat now reconciles: while a service runway is in music/pad phase with
targetMs in the future, it re-sends the countdown arm until one PUT
succeeds, keyed by service|target|timer (so +2/−2 schedule edits
re-deliver). The key clears on any failed ping so a briefly-unreachable PP
gets the countdown again. Safe because the timer counts to an absolute
wall-clock time — re-arming mid-song shows the correct remaining time.
Only the timer re-arms; slide/playlist hooks do not re-fire.

---

## Recent work (lead-up to v10.1.2)

### Audio engine / runway
- **Action-driven playlist swap crossfade restored.** The `arm_playlist` action was dropping the fade-in because both the controller and `scheduleRunway` had `trackOffset === 0 ? fadeInSec : 0` gates that fired on any non-zero offset. Tiny preload/tick lag (~200ms) is normal — both gates removed.
- **Anchor track's `editFadeOutSec` is now honored** as the audible fade at end-of-service in both pad-bridge and no-pad scenarios. Controller defers its own external `fadeOutMusic` when the anchor has a set fade, so the two envelopes don't compound. No timing changed — only the gain envelope.

### Service / schedule resolver
- **`triggerPostService` uses `getMostRecentServiceToday()`** as fallback when `getActiveService()` returns nothing, so end-of-service triggers resolve to the right service's overrides after the service is past.
- **Auto-schedule moved from hourly heartbeat to one-shot `setTimeout`** to a configurable time-of-day. Settings → Engine → Auto-schedule services (days-ahead + daily check time). Settings changes reschedule the timer immediately.
- **UTC vs local date bug fixed in 4 places.** `engines.tsx` (remote snapshot push, tray heartbeat, extend command) and `store.ts` (tombstone pruning) now use `todayISO()` from `format.ts`. The bug caused the remote countdown to flip to 00:00:00 in the evening on Pacific time (UTC midnight) and made tombstones latch onto wrong-day services.
- **Tombstone management** in Settings → Engine — view list, per-row remove, reset all.

### Remote PWA
- **MIDI Activity Clear button** — sends `clear_midi_log` command; wipes the host's `midiLog` and snapshot push broadcasts the empty list.
- **MIDI log uses 12-hour AM/PM time** instead of 24-hour military.

### Schedule UI
- **Materialized service card** condensed: header shows time/date/key/status/gear/× inline; everything else lives behind the gear in a modal.
- **Weekly pattern row** uses the same gear → modal pattern.
- **Settings modal** lays out pre/post action sequences directly below their respective playlists.
- **Pattern row title input** sits to the right of the TIME box (matches materialized card).
- **Pattern rows sort chronologically.**

### Build / packaging
- **mDNS uncaughtException suppression** — `prependListener` on `process.on('uncaughtException')` swallows EHOSTUNREACH/ENETUNREACH/EADDRNOTAVAIL/ENETDOWN errors from multicast-dns. Also added an `error` listener on the mdns instance to prevent EventEmitter crashes.
- **Mac ad-hoc codesigning** added to `build/make-dmg.sh` (without `--options runtime`; that flag enables hardened runtime which kills Electron at launch).
- **Cross-platform `build:remote`** — now uses `node build/copy-remote.js` instead of `rm/mkdir/cp` shell incantation. Required for Windows GitHub Actions runners.
- **GitHub Actions workflow** — `.github/workflows/build.yml`. Matrix builds on every push to main; release-on-tag job creates GitHub Release with installers attached.

### Scrollbar styling
- Hardened against macOS's "Always show scroll bars" preference. Added standardized `scrollbar-color` alongside the existing `::-webkit-scrollbar-*` rules; explicit transparent track and corner cell so macOS can't paint its own inset background underneath.

---

## Open / deferred

- **In-app update check** — deferred multiple times. Now that releases auto-publish to GitHub, this could read the GitHub Releases API and surface "v10.1.3 is available" in the title bar or About menu.
- **Windows code-signing certificate** — skipped. A real CA cert ($200-500/yr) is the only way to silence SmartScreen warnings for end users. EV cert ($300-700/yr) gets instant SmartScreen reputation. Revisit when distribution grows beyond a handful of users.
- **Branded PDF rendering for reminder emails** — separate Theory Print project, not Runway. Keep them straight.
- **Multi-rate tax setup guide** — also Theory Print. Same reminder.
- **Universal Mac binary (arm64 + x64)** — currently only arm64. Some older Intel Macs might still be on the church team. Easy electron-builder config change if needed.

---

## Operator preferences to remember

- **Timing is sacred.** Never change scheduling math without explicit OK and an explicit note in the PR / commit that no timing changed.
- **Gear icons hide complexity.** When adding new per-service or per-pattern options, default to putting them behind the existing gear-modal, not inline.
- **Side-by-side TIME / DATE / KEY / status / gear / ×** is the established header pattern on schedule cards; keep that consistent.
- **Local date everywhere.** Use `todayISO()` from `format.ts`.
- **One-click safety buttons.** "Reset all tombstones" / "Clear MIDI log" / per-row "Remove" — always offer the safe path before doing anything destructive.

---

## Quick reference

| Want to … | Edit … |
|---|---|
| Add a remote command | `RemoteCommand` union + valid-list in `remoteServer.ts`, dispatch in `engines.tsx`, send-call in `src/remote/main.js` |
| Add a config default | `AppConfig.defaults` in `shared/types.ts`, `DEFAULT_CONFIG` at bottom, load-time migration in `store.ts` |
| Change something on the schedule UI | `src/renderer/views/ScheduleView.tsx`, styles in `src/renderer/styles/schedule.css` |
| Touch end-of-service music behaviour | `serviceController.ts` `beginPad` (pad branch + no-pad branch). Verify no timing change. |
| Touch action firing logic | `serviceController.ts` `fireDueActions`, `resolveSequence`, `dispatchAction`, `armPlaylistFromAction` |
| Cut a release | `git tag vX.Y.Z && git push origin vX.Y.Z` — workflow builds + publishes |

---

## How to pick up where we left off

1. Read `CLAUDE.md` (project root) — conventions and architecture.
2. Read this file.
3. Pull latest from `main`.
4. Run `npm install` then `npm run dev`.
5. Ask the operator what they want next.
