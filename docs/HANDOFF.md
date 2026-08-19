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

## In flight

### MultiTracks.com key tagging (branch `claude/song-key-tagging-multitracks-cy6gyf`)

Library → **♪ Keys from MultiTracks** looks up the published *original master key*
for worship songs and proposes them for the library. Nothing is written until the
operator hits Apply in the review sheet.

- **Where the data comes from.** MultiTracks has no public API, but their own
  search box posts JSON to `https://api.multitracks.com/search/songs` and renders
  it client-side. `src/main/multitracksLookup.ts` makes the same unauthenticated
  request. No account, no scraping of rendered pages, no credentials to configure.
  `order` must be a number — the endpoint answers `{ result: 0 }` with no items
  when it's null.
- **What comes back.** `originalKey` per catalog entry (`"B"`, `"Gb"`, `"Ab"`).
  BPM is *not* in the search payload — it's fetched separately by the song page,
  so this path fills key only. GetSongBPM remains the BPM source.
- **Roots only.** MultiTracks does not mark major vs minor, so a lookup returns
  the major spelling. The review sheet has a dedicated "Relative major/minor"
  group: if the operator has `Em` and MultiTracks says `G`, that's the same
  Camelot position and is never auto-applied.
- **Matching.** Title + artist + duration scoring in `scoreCandidate()`. Duration
  is the strongest disambiguator between an album cut and a radio edit, which are
  frequently in different keys — `runMultitracksScan` passes `track.durationSec`
  for that reason. Below a 0.55 floor we report "no match" rather than guess.
  Search queries are progressively widened (cleaned title + artist → cleaned
  title → raw title); long `feat.` credit lists otherwise return zero rows.
- **Politeness.** Results cached for the process lifetime, requests serialized
  with a 350ms floor between them, 9s timeout, every failure returned as a
  `reason` string rather than thrown. The endpoint is undocumented and can change
  without notice — when it does, the feature degrades to "no match" and manual
  entry, it doesn't break the app.
- **Attribution.** "Key data from multitracks.com" sits in the review sheet footer.

Verified against real lookups (Elevation, Bethel, Hillsong, Phil Wickham, Chris
Tomlin, Maverick City, Cody Carnes) — 14/14 keys matched the published pages.
**No timing code touched.**

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
