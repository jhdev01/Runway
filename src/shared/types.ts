// Music keys — using both major and minor flavors
export type KeyName =
  | 'C' | 'G' | 'D' | 'A' | 'E' | 'B' | 'F#' | 'Db' | 'Ab' | 'Eb' | 'Bb' | 'F'
  | 'Am' | 'Em' | 'Bm' | 'F#m' | 'C#m' | 'G#m' | 'D#m' | 'Bbm' | 'Fm' | 'Cm' | 'Gm' | 'Dm';

export interface Track {
  id: string;
  filePath: string;        // absolute path on disk
  title: string;
  artist?: string;
  album?: string;
  durationSec: number;
  // Native sample rate from the file's metadata (Hz). Used only to display
  // a small tech tag in the playlist UI. Optional because tracks imported
  // before this field existed don't have it; UI hides the kHz when absent.
  sampleRate?: number;
  // Tech metadata for the Library "details" row. All optional because old
  // imports were captured before these fields existed; Library backfills
  // them lazily by re-reading the file when first opened.
  bitrateBps?: number;       // e.g. 1411000 for 16-bit/44.1k stereo WAV
  codec?: string;            // music-metadata's `format.codec` ("MPEG 1 Layer 3", "PCM", ...)
  container?: string;        // music-metadata's `format.container` ("MPEG", "WAVE", "M4A", ...)
  channels?: number;         // 1 = mono, 2 = stereo, etc.
  lossless?: boolean;
  // Album artwork as a `data:image/...` URL. Populated from the file's
  // embedded ID3 picture on import; null/undefined when no artwork is
  // embedded. (A future iTunes Search fallback can fill in missing art
  // — Phase 2.)
  albumArtUrl?: string;
  key?: KeyName;
  bpm?: number;
  addedAt: string;          // ISO timestamp
  // Key detected from the audio itself (Library → "Detect keys"). Kept
  // separate from `key` so the operator's own tag is never overwritten —
  // `key` is only auto-filled when it was blank. `keyConfidence` is 0..1
  // for `detectedKey`.
  detectedKey?: KeyName;
  keyConfidence?: number;
  // The detector's next-best guesses, best first. The right key is in the
  // top two far more often than it is the top pick, so the Key cell offers
  // these as one-click alternatives.
  detectedKeyAlts?: KeyName[];
  // The detector's note profile for this file, so the key can be re-scored
  // when the detector learns from the operator's tags. And where `key` came
  // from: 'detected' = filled in automatically by the detector (so it isn't
  // learned from); unset = set by the operator / their review.
  keyProfile?: KeyProfile;
  keySource?: 'detected';
  // Non-destructive edits — applied at playback time. The source file is
  // never modified.
  trimStartSec?: number;    // play starts at this offset in the buffer
  trimEndSec?: number;      // play stops at this offset
  editFadeInSec?: number;   // applied at the start of the trimmed segment
  editFadeOutSec?: number;  // applied at the end of the trimmed segment
  // Optional "service-landing" marker. When set, and this track is the
  // runway's anchor (last track), the countdown timer hits zero at this
  // position in the source file — but the track keeps playing past it
  // until trimEndSec. Lets a song land on a beat with its natural fade
  // continuing as a tail past service start. Position must satisfy
  // trimStart < editServiceLandSec <= trimEnd; out-of-range values are
  // clamped at arm time. Undefined = land on trimEnd (current behavior).
  editServiceLandSec?: number;
  // True while editServiceLandSec is a suggestion the operator accepted
  // unchanged. 0:00 learning skips these (it would only be learning its own
  // guesses); moving the mark by hand clears it.
  editServiceLandAuto?: boolean;
  // Values that came from accepted suggestions (so they can be removed
  // again). A value changed by hand since no longer matches and is kept.
  suggestApplied?: { startSec?: number; endSec?: number; landSec?: number };
}

/** Effective playback duration of a track after applying trim points. */
export function effectiveDuration(t: { durationSec: number; trimStartSec?: number; trimEndSec?: number }): number {
  const start = t.trimStartSec ?? 0;
  const end = t.trimEndSec ?? t.durationSec;
  return Math.max(0, end - start);
}

export type PlaybackOrder = 'smart' | 'sequential' | 'shuffle';
export type TransitionMode = 'crossfade' | 'gapless';
export type PlaylistKind = 'pre' | 'post' | 'special';

export interface Playlist {
  id: string;
  name: string;
  kind: PlaylistKind;
  trackIds: string[];
  sourceFolder?: string;    // watched folder, optional
  // Behavior settings
  playbackOrder: PlaybackOrder;
  transitionMode: TransitionMode;
  crossfadeSec: number;     // ignored if gapless
  autoArrangeToKey: boolean;
  // When true, the runway plays the first song from the start instead
  // of head-trimming it to fit the lead window. Music starts earlier
  // (= targetMs − full audible duration) but still lands on time at
  // service start. Default false: head-trim mid-song so the runway
  // begins at the lead-time mark on the dot.
  playFirstSongFromStart?: boolean;
  // Optional editor-only target used to gauge how many songs are needed.
  // Falls back to any scheduled service's target, then the global default.
  targetLeadSec?: number;
  padBridgeSec: number;     // 0 = no pad bridge
  padFadeOutSec: number;
  // Optional Action Sequence to fire alongside this playlist's runway.
  // Stored by id so editing the sequence in the library propagates to
  // every playlist using it. Services can override this on a per-arm
  // basis via ServiceInstance.actionSequenceIdOverride.
  actionSequenceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetlistSong {
  id: string;
  title: string;
  key: KeyName;
}

export type ServiceStatus = 'scheduled' | 'queued' | 'live' | 'completed';

export interface ServiceInstance {
  id: string;
  // Optional human-readable label like "9 AM Service" or "Christmas Eve".
  // Falls back to time-of-day in UI when blank.
  name?: string;
  date: string;             // ISO date (YYYY-MM-DD)
  startTime: string;        // 'HH:MM' 24h
  preServicePlaylistId?: string;
  // Spotify playlist as the pre-service music source (experimental, macOS).
  // When set it wins over preServicePlaylistId. Optional: old configs load
  // unchanged and keep using their Runway playlist.
  spotifyPlaylistId?: string;
  spotifyPlaylistName?: string;
  postServicePlaylistId?: string;
  // The headliner: where the playlist must land. `undefined` means inherit
  // from the first service of this date (use resolveServiceFirstSongKey).
  // For the first service of the day, undefined just means "no key set".
  firstSongKey?: KeyName;
  // True when the operator picked firstSongKey by hand in Schedule. The
  // scheduled Planning Center pull leaves these services alone.
  firstSongKeyManual?: boolean;
  // Optional per-service override for how many seconds before start the
  // Planning Center key auto-pull fires for THIS service. `undefined`
  // inherits the global default (pcoSync.pullLeadSec).
  pcoKeyLeadSec?: number;
  // Optional pinned anchor — forces the pre-service playlist to end on this
  // exact track, regardless of key match. `undefined` means inherit from the
  // first service of the date; for the first service, undefined = Auto (let
  // arrange pick). Use resolveServiceLastSongTrackId.
  lastSongTrackId?: string;
  // Same, when the music is a Spotify playlist: the spotify:track: URI the
  // runway should end on. Kept separate from lastSongTrackId (which only
  // holds Runway tracks). undefined = Auto (pick by key).
  spotifyLastSongUri?: string;
  // Optional: full setlist
  setlist: SetlistSong[];
  // Auto-start mode
  autoStartTargetSec: number;  // aim for N seconds before start, 0 = manual
  status: ServiceStatus;
  // Calculated at runtime
  calculatedStartTime?: string;
  // Rehearsal services are temporary — created via the Rehearse panel for
  // a dry run. They auto-clean themselves after completion.
  isRehearsal?: boolean;
  // When true, the pad bridge is skipped entirely. Music fades out to land
  // at service start with no pad in between. Useful for services that don't
  // need a sustained transition (e.g. simple announcement-only events).
  disablePadBridge?: boolean;
  // Optional per-service override of the global PP sync hooks. When set,
  // the controller uses these values instead of `config.proPresenterSync`
  // for arm/music-start/service-start/disarm. Connection (host/port/etc.)
  // is always global. Undefined = inherit everything.
  proPresenterOverride?: ProPresenterServiceOverride;
  // Per-service overrides of the Action Sequences inherited from the
  // pre-service / post-service playlists. Empty string = "no actions
  // for this service"; undefined = inherit playlist's default; any
  // other id = use that sequence specifically for this service.
  preActionSequenceIdOverride?: string;
  postActionSequenceIdOverride?: string;
  /**
   * Legacy single-field override. Predates the pre/post split — kept
   * so older configs still resolve correctly. Treated as the
   * pre-service override when the new specific field is absent.
   */
  actionSequenceIdOverride?: string;
}

// ─── Action Sequences ────────────────────────────────────────────────
// Reusable timed automations that fire alongside a playlist's runway.
// Sequences live in their own library (config.actionSequences) and get
// linked to a playlist via Playlist.actionSequenceId. A service can
// override the inherited sequence via actionSequenceIdOverride.

/**
 * Reference frame for the sequence's offset clock.
 *  - service_start  : zero point = the service's scheduled start time
 *                     (= runway.targetMs). Negative offsets fire before
 *                     the service starts; positive after.
 *  - playlist_start : zero point = when the playlist's music begins
 *                     (= runway.musicStartMs for pre-service, or the
 *                     post-service trigger time). Use this for "fire
 *                     2 minutes after music starts."
 */
export type ActionAnchor = 'service_start' | 'playlist_start';

/**
 * Discriminated union of every action type the engine can fire.
 * Each variant carries the params it needs and nothing more — keeps the
 * editor's per-row form trivially derivable from `type`.
 */
export type ActionPayload =
  // MIDI message out on a configured port. matchPortName matches what
  // MidiDevicePref uses, so a single name resolves the same device
  // across MIDI port re-assignment between sessions.
  | {
      type: 'midi_send';
      portName: string;
      messageType: 'note_on' | 'note_off' | 'cc' | 'program_change';
      channel: number;        // 1..16
      data1: number;          // note number / cc number / program
      data2?: number;         // velocity / cc value (ignored for PC)
    }
  // ProPresenter actions. Sub-discriminated so the editor can show the
  // matching params block.
  | {
      type: 'pp_trigger_slide';
      slideIndex: number;     // zero-based
    }
  | {
      type: 'pp_trigger_playlist_item';
      playlistUuid: string;
      playlistName?: string;  // human-readable cache for the editor
      itemIndex: number;
      itemName?: string;
      // Optional: drill into a specific slide of the item. When set, the
      // engine triggers slide N of the item rather than firing the item
      // from its first slide. Zero-based.
      slideIndex?: number;
    }
  | {
      type: 'pp_set_timer';
      timerUuid: string;
      timerName?: string;
      // Either a fixed countdown duration in seconds OR a target time
      // anchored to the service's start. The editor surfaces just one
      // picker at a time.
      mode: 'duration' | 'count_down_to_service';
      durationSec?: number;   // present when mode === 'duration'
    }
  | {
      type: 'pp_timer_control';
      timerUuid: string;
      timerName?: string;
      op: 'start' | 'stop' | 'reset';
    }
  // Audio bus fade — instant change at duration=0, or graceful ramp.
  // Volume is expressed as a percentage where 100% = unity (no boost,
  // matches the bus's natural level) and 0% = silence. Capped at 100
  // so an accidental high value can't clip downstream gear.
  | {
      type: 'audio_fade';
      bus: 'music' | 'pad' | 'cue';
      targetGainPct: number;  // 0..100
      durationSec: number;    // 0 = instant
    }
  // Pad player control.
  | {
      type: 'pad_action';
      op: 'arm_key' | 'fire' | 'stop';
      key?: KeyName;          // required for arm_key
    }
  // App-internal music transport. Mostly useful for advanced flows like
  // "skip the warm-up at +5:00".
  | {
      type: 'music_action';
      op: 'start_early' | 'skip_to_next' | 'jump_to_track';
      trackId?: string;       // required for jump_to_track
    }
  // Swap the currently-playing playlist for a different one. Use case:
  // "prayer set plays for 10 min, then transition to the standard
  // post-service playlist." Implemented as a clean handoff — the
  // current runway's audio fades out and a fresh post-service runway
  // starts on the chosen playlist. Combine with pp_trigger_slide to
  // change the slide at the same moment.
  | {
      type: 'change_setlist';
      playlistId: string;
      playlistName?: string;  // human-readable cache for the editor
      // How long to fade the current music before the new playlist starts.
      // 0 = hard cut. Default 2 sec.
      fadeOutSec: number;
    }
  // Arm the current/upcoming service with a chosen playlist as its
  // pre-service music. Overrides anything currently playing — queued
  // pre-service is replaced, post-service music is faded out, quick
  // test runways are clobbered. Use case: chain the 1st service's
  // post-service end into auto-arming the 2nd service with a specific
  // playlist (e.g. the prayer-focused open) without manually flipping
  // the service's saved playlist setting.
  //
  // `fillWithMusic` (default true) controls whether the runway loops
  // tracks to fill the full lead-time window. With it OFF, the
  // playlist plays once through and ends — handy when the playlist is
  // already long enough or you want a hard ending before the service.
  | {
      type: 'arm_playlist';
      playlistId: string;
      playlistName?: string;  // human-readable cache for the editor
      // Cross-fade the previous music out over this many seconds while
      // the new pre-service music fades in. 0 = hard cut. Default 2 sec.
      fadeOutSec: number;
      // True → loop the playlist's tracks until the lead window is
      // full. False → play once through; if the playlist is shorter
      // than the lead window the runway just ends short.
      fillWithMusic: boolean;
    }
  // Spotify (experimental, macOS): play a playlist from the top, or one
  // song from it, in the Spotify app with a fade-in. Optionally fades
  // Runway's own music out at the same time. Skipped while a service's
  // Spotify runway is playing (it would knock the landing off).
  | {
      type: 'spotify_play';
      playlistId: string;
      playlistName?: string;  // human-readable cache for the editor
      trackUri?: string;      // set = this one song (inside the playlist)
      trackTitle?: string;
      fadeInSec: number;
      fadeOutRunwaySec: number; // 0 = leave Runway's music alone
    }
  // Spotify: fade out and pause whatever an action or post-service started.
  | {
      type: 'spotify_stop';
      fadeOutSec: number;
    };

/**
 * Song-relative anchor. When set on an Action, it overrides the
 * time-based anchor: the action fires at the *start* of a song picked
 * by stepping N positions away from the first or last track in the
 * runway. Useful for "fire 1 song before the last song" or "2 songs
 * after the first song" — sequences that should track playlist
 * changes regardless of the wall-clock duration.
 */
export type SongAnchor = 'first_song' | 'last_song';

export interface Action {
  id: string;
  // Reference frame for this action's offset. When undefined the engine
  // falls back to the sequence-level anchor (so old configs migrate
  // silently). Set per-row to mix anchors within one sequence — e.g.
  // most actions anchored to service_start, but one fade anchored to
  // playlist_start so it fires "30 s after music begins."
  anchor?: ActionAnchor;
  // Signed offset in seconds from this action's anchor point.
  offsetSec: number;
  // Optional song-relative anchor. When set, takes precedence over the
  // time-based anchor + offsetSec — engine picks track[firstIdx +
  // songOffset] (or track[lastIdx + songOffset]) and fires at its
  // start. songOffset is signed: e.g. last_song + (-1) = the song
  // before the last; first_song + 2 = two songs after the first.
  songAnchor?: SongAnchor;
  songOffset?: number;
  // Per-row enable. Disabled actions stay in the list (so they round-
  // trip through edits) but the engine skips them.
  enabled: boolean;
  // Free-form label shown in the editor — operator-readable name like
  // "Welcome slide" or "Mic ducking on."
  label: string;
  payload: ActionPayload;
}

export interface ActionSequence {
  id: string;
  name: string;
  anchor: ActionAnchor;
  actions: Action[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The first service of a given date, by start time. The "source of truth"
 * later services on the same date inherit from for firstSongKey and
 * lastSongTrackId. Returns undefined if no service is scheduled on that date.
 */
export function firstServiceOfDay(
  services: ServiceInstance[],
  date: string,
): ServiceInstance | undefined {
  return services
    .filter(s => s.date === date)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
}

export interface ResolvedServiceField<T> {
  value: T | undefined;
  // Non-null when the resolved value came from a different service (a later
  // service on the same date inheriting from the first). Null when the value
  // is the service's own (or no value is set anywhere).
  inheritedFrom: ServiceInstance | null;
}

/**
 * Resolve a service's effective land-in-key, walking the inheritance chain:
 * own value → first service of the same date. The first service of the day
 * never inherits.
 */
export function resolveServiceFirstSongKey(
  service: ServiceInstance,
  allServices: ServiceInstance[],
): ResolvedServiceField<KeyName> {
  if (service.firstSongKey !== undefined) {
    return { value: service.firstSongKey, inheritedFrom: null };
  }
  const first = firstServiceOfDay(allServices, service.date);
  if (!first || first.id === service.id) {
    return { value: undefined, inheritedFrom: null };
  }
  return {
    value: first.firstSongKey,
    inheritedFrom: first.firstSongKey !== undefined ? first : null,
  };
}

/**
 * Resolve a service's effective pinned last-song track id, walking the
 * inheritance chain: own value → first service of the same date.
 */
export function resolveServiceLastSongTrackId(
  service: ServiceInstance,
  allServices: ServiceInstance[],
): ResolvedServiceField<string> {
  if (service.lastSongTrackId !== undefined) {
    return { value: service.lastSongTrackId, inheritedFrom: null };
  }
  const first = firstServiceOfDay(allServices, service.date);
  if (!first || first.id === service.id) {
    return { value: undefined, inheritedFrom: null };
  }
  return {
    value: first.lastSongTrackId,
    inheritedFrom: first.lastSongTrackId !== undefined ? first : null,
  };
}

export interface WeeklyPatternEntry {
  id: string;
  // Carried into materialized services as ServiceInstance.name. Optional.
  name?: string;
  dayOfWeek: number;        // 0=Sun, 6=Sat
  startTime: string;        // 'HH:MM' 24h
  preServicePlaylistId?: string;
  // Spotify playlist as the pre-service music source (experimental, macOS).
  // When set it wins over preServicePlaylistId. Optional: old configs load
  // unchanged and keep using their Runway playlist.
  spotifyPlaylistId?: string;
  spotifyPlaylistName?: string;
  postServicePlaylistId?: string;
  // Action sequence overrides carried into every service materialized
  // from this pattern. Same semantics as
  // ServiceInstance.preActionSequenceIdOverride /
  // postActionSequenceIdOverride: undefined = inherit from playlist,
  // empty string = "no actions for this service", id = specific override.
  preActionSequenceIdOverride?: string;
  postActionSequenceIdOverride?: string;
  // Lead window for the pre-service music. When set, materialized services
  // use this instead of `defaults.autoStartTargetSec` — lets you run a longer
  // window for first service and a shorter one for the next.
  autoStartTargetSec?: number;
  // PP override carried into every service materialized from this pattern.
  // Same shape as ServiceInstance.proPresenterOverride.
  proPresenterOverride?: ProPresenterServiceOverride;
  // When true, services materialized from this pattern have the pad bridge
  // skipped (music just fades out to land at service start).
  disablePadBridge?: boolean;
  enabled: boolean;
}

// Pad presets
export type PadTexture = 'warm' | 'bright' | 'cinematic';

export interface PadFile {
  key: KeyName;
  filePath: string;
  texture: PadTexture;
}

// Audio routing
export interface AudioBusConfig {
  bus: 'music' | 'pad' | 'cue';
  deviceId: string | null;     // OS device ID, null = system default
  channelPair: [number, number]; // 0-indexed [left, right]
  gainDb: number;
}

// MIDI mapping — incoming notes → app actions
export type MidiAction =
  | 'panic_fade'
  | 'start_post_service'
  | 'pad_play'
  | 'pad_stop'
  | 'arm_toggle'
  | 'add_song'
  | { type: 'pad_set_key'; key: KeyName };

export interface MidiBinding {
  id: string;
  channel: number;          // 1-16
  noteOrCc: number;         // 0-127
  type: 'note' | 'cc';
  action: MidiAction;
  description?: string;
  // Last captured velocity (note) or CC value. Stored for UI display only —
  // matching still uses channel + noteOrCc + type so a fixed-velocity hardware
  // button isn't required.
  velocity?: number;
}

export type MidiMessageType =
  | 'note'
  | 'note_off'
  | 'cc'
  | 'pc'
  | 'pitchbend'
  | 'aftertouch'
  | 'poly_aftertouch'
  | 'system'
  | 'other';

export interface MidiLogEntry {
  timestamp: number;
  direction: 'in' | 'out';
  channel: number;
  type: MidiMessageType;
  data1: number;
  data2: number;
  deviceName?: string;
  matchedAction?: string;
}

/**
 * Per-device MIDI preferences. Keyed by `name` because the Web MIDI API's
 * `id` field is per-session and changes across reboots / hub re-orders.
 * Devices without a pref entry default to both directions enabled, so
 * existing setups keep working until the user explicitly toggles something.
 */
export interface MidiDevicePref {
  name: string;
  manufacturer?: string;
  inputEnabled: boolean;
  outputEnabled: boolean;
}

/**
 * LAN remote-control server. Always on whenever the app runs. The PIN
 * gates *commands*; viewing is open to anyone on the network. Auto-relock
 * idle timeout returns the remote UI to read-only after this many seconds
 * of no command activity (0 disables auto-relock).
 */
export interface RemoteConfig {
  port: number;
  pin: string;
  autoRelockSec: number;
  // Network interface to bind the WS/HTTP server to. Empty string or
  // '0.0.0.0' = listen on every interface (the historical behaviour).
  // A specific IPv4 address (e.g. '192.168.1.42') restricts the server
  // to one NIC, which is needed on machines that have Wi-Fi + Ethernet
  // + a VPN tunnel up at once: the phone otherwise grabs the wrong IP
  // off the QR and reconnects fail when that interface flaps.
  bindHost?: string;
}

export interface RemoteNetworkInterface {
  name: string;     // e.g. 'en0'
  address: string;  // IPv4
}

export type MtcFrameRate = 24 | 25 | 30;
export type TimecodeMode = 'off' | 'countdown_to_service';

export interface TimecodeOutputConfig {
  enabled: boolean;
  // Match by name across runs because MIDIPort.id varies by browser session.
  outputPortName: string | null;
  frameRate: MtcFrameRate;
  mode: TimecodeMode;
}

/**
 * Subset of PP sync that can be overridden on a per-service basis. Excludes
 * connection (host/port/password/enabled) — those always stay global.
 */
export interface ProPresenterServiceOverride {
  timerUuid: string | null;
  timerName: string | null;
  musicStartAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  musicStartPlaylistUuid: string | null;
  musicStartPlaylistName: string | null;
  musicStartItemIndex: number | null;
  musicStartItemName: string | null;
  disarmAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  disarmPlaylistUuid: string | null;
  disarmPlaylistName: string | null;
  disarmItemIndex: number | null;
  disarmItemName: string | null;
  serviceStartAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  serviceStartPlaylistUuid: string | null;
  serviceStartPlaylistName: string | null;
  serviceStartItemIndex: number | null;
  serviceStartItemName: string | null;
  // Fires once when Start Post-Service is pressed. No timer involvement —
  // purely a slide/clear action.
  postServiceStartAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  postServiceStartPlaylistUuid: string | null;
  postServiceStartPlaylistName: string | null;
  postServiceStartItemIndex: number | null;
  postServiceStartItemName: string | null;
}

export interface ProPresenterSyncConfig {
  enabled: boolean;
  host: string;            // e.g. 'localhost' or '192.168.1.42'
  port: number;            // PP Network API port (configured in PP preferences)
  password: string;        // empty if PP has no API password set
  // Selected timer — by uuid for reliability, name kept for display.
  timerUuid: string | null;
  timerName: string | null;
  // Optional: fire a specific playlist item once when the pre-service music
  // begins playing (e.g. so PP advances to the first slide of the pre-service
  // loop in sync with audio). PP's playlist API triggers by item INDEX, not
  // UUID — we save the name too so the UI can show what was picked even if
  // the playlist re-orders.
  // Three lifecycle hooks Runway can drive in PP:
  //   musicStart  — fires when pre-service music begins (runway phase → music)
  //   disarm      — fires on panic / manual disarm (NOT on natural completion)
  //   serviceStart — fires when the PP timer reaches 0 (service begin)
  // Each hook supports the same 3-mode action: none / clear_all / trigger_item.
  musicStartAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  musicStartPlaylistUuid: string | null;
  musicStartPlaylistName: string | null;
  musicStartItemIndex: number | null;
  musicStartItemName: string | null;
  disarmAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  disarmPlaylistUuid: string | null;
  disarmPlaylistName: string | null;
  disarmItemIndex: number | null;
  disarmItemName: string | null;
  serviceStartAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  serviceStartPlaylistUuid: string | null;
  serviceStartPlaylistName: string | null;
  serviceStartItemIndex: number | null;
  serviceStartItemName: string | null;
  // Fires once when Start Post-Service is pressed. No timer involvement —
  // purely a slide/clear action.
  postServiceStartAction: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  postServiceStartPlaylistUuid: string | null;
  postServiceStartPlaylistName: string | null;
  postServiceStartItemIndex: number | null;
  postServiceStartItemName: string | null;
}

/**
 * Planning Center Services sync. Weekly, Runway reads the next upcoming
 * plan for the chosen service type and sets the first song's key on that
 * date's service(s) — so the pad-bridge key is correct even when nobody
 * remembers to set it. Read-only; auth is a Personal Access Token.
 */
export interface PcoSyncConfig {
  enabled: boolean;
  // Personal Access Token from PCO (Developer → Personal Access Tokens).
  // Sent as HTTP Basic auth (appId:secret). Read-only is sufficient.
  appId: string;
  secret: string;
  // Which Services "service type" to read plans from (e.g. "Sunday
  // Morning"). id drives API calls; name is kept for display.
  serviceTypeId: string | null;
  serviceTypeName: string | null;
  // Default: pull the key this many seconds before a service starts. The
  // pull always reads the NEXT upcoming PCO plan and applies its first
  // song's key to the service whose lead window opened — the plan date and
  // the Runway service date do NOT need to match (so a day-early test still
  // pulls the coming Sunday's key). Per-service override: pcoKeyLeadSec.
  pullLeadSec?: number;
  // Snapshot of the last successful/attempted fetch, for the Settings
  // status line. All optional so old configs upgrade cleanly.
  lastFetchedKey?: string | null;       // Runway KeyName that was applied
  lastFetchedRawKey?: string | null;    // exact key string PCO returned
  lastFetchedSong?: string | null;      // first song title in the plan
  lastFetchedPlanDate?: string | null;  // YYYY-MM-DD of the plan
  lastFetchedAt?: number | null;        // epoch ms of the last attempt
  lastError?: string | null;            // populated when the last fetch failed
}

/**
 * One MultiTracks.com catalog hit, scored against a local track.
 * `key` is already normalized to a canonical KeyName.
 */
export interface MultitracksCandidate {
  key: KeyName;
  /** Song title as MultiTracks spells it. */
  title: string;
  /** Primary artist as MultiTracks spells it. */
  artist: string;
  album: string;
  /** Absolute multitracks.com URL, so the operator can verify a match. */
  url: string;
  /** Track length in seconds, per MultiTracks. Used for disambiguation. */
  durationSec?: number;
  /** 0..1 match confidence. See scoreCandidate() in main/multitracksLookup.ts. */
  score: number;
}

export interface MultitracksResult {
  /** Best candidate, or undefined when nothing cleared the match floor. */
  best?: MultitracksCandidate;
  /**
   * Other plausible matches whose key DISAGREES with `best`, best-first.
   * Live/radio/acoustic cuts often sit in different keys, so the UI
   * offers a choice instead of guessing.
   */
  alternates: MultitracksCandidate[];
  /** Set when there's no usable match. Human-readable, safe to display. */
  reason?: string;
}

export interface AppConfig {
  version: 1;
  playlists: Playlist[];
  tracks: Track[];
  services: ServiceInstance[];
  weeklyPattern: WeeklyPatternEntry[];
  pads: PadFile[];
  audioRouting: AudioBusConfig[];
  midiBindings: MidiBinding[];
  // Library of reusable Action Sequences. Linked to playlists by id;
  // the engine fires the resolved sequence each tick once the runway is
  // armed. Empty list = no sequences (default state for new configs).
  actionSequences: ActionSequence[];
  // Per-device MIDI prefs. Empty = every detected device acts as both input
  // and output (backwards-compatible default). When the user disables a
  // device an entry is added; the engine attaches handlers selectively.
  midiDevices: MidiDevicePref[];
  // LAN remote-control server. Lets a phone or iPad on the same network
  // view the timer (and, after entering a PIN, fire actions) via
  // http://<this-mac-ip>:<port>.
  remote: RemoteConfig;
  timecodeOutput: TimecodeOutputConfig;
  proPresenterSync: ProPresenterSyncConfig;
  // Optional Planning Center Services sync — auto-sets the pad-bridge key
  // from the week's plan. Optional so old configs upgrade cleanly.
  pcoSync?: PcoSyncConfig;
  // Optional Spotify credentials — kept for forward-compat in case
  // Spotify restores audio-features access for new apps. Currently
  // (post-Nov-2024) only useful for the search + art endpoints.
  spotify?: {
    clientId?: string;
    clientSecret?: string;
    // Per-song edits for Spotify songs, keyed by spotify:track: URI. Used
    // by the Spotify test run. Optional so old configs upgrade cleanly.
    trackEdits?: Record<string, SpotifyTrackEdit>;
    // Last playlist read in Settings, kept so it's still there after
    // leaving Settings or restarting. Refreshed by "Read playlist".
    lastPlaylistLink?: string;
    lastPlaylist?: SpotifyPlaylistResult;
    // Every playlist read, by playlist id: lets a service arm from the
    // saved song list if Spotify's web API is unreachable at arm time.
    playlistCache?: Record<string, SpotifyPlaylistResult>;
    // Downloaded album art (data URLs) by spotify:track: URI, so art shows
    // without internet. Filled by Library › Spotify › Download artwork.
    artCache?: Record<string, string>;
    // Draw waveforms of Spotify songs as they play (Mac). Off until the
    // operator turns it on, since macOS asks for a permission first.
    waveforms?: boolean;
    // Scans hear just the first and last `waveformScanSec` seconds of each
    // song ('edges', the default: the parts trims and landings use) or the
    // whole song.
    waveformScan?: 'edges' | 'whole';
    waveformScanSec?: number;   // default 30
    // When each song was last scanned (by spotify:track: URI). A song scanned
    // in the last few days that still came out incomplete isn't re-queued by
    // Scan all / Scan this playlist (Re-scan this song still works).
    waveformScanTried?: Record<string, number>;
    // Buy list: Spotify song URI → the Library track that is its bought copy.
    ownedLinks?: Record<string, string>;
    // When Downloads was last checked for bought songs.
    purchaseScanAt?: number;
  };
  // Key detector settings learned from the operator's own tagged songs
  // (see shared/keyLearn.ts). Only used when `adopted`; absent = standard.
  // 0:00 (service landing) suggestions learned from the marks the operator
  // placed by hand. Only used to suggest; never applied on its own.
  landLearning?: {
    params: { smoothSec: number; level: number; mode: 'edge' | 'peak'; offsetSec: number };
    adopted: boolean;      // learned settings beat the standard ones on held-out songs
    examples: number;
    within1s: number;      // share of held-out songs within 1 s (learned)
    within1sDefault: number;
    medianMissSec: number;
    at: number;
    signature: string;
  };
  keyLearning?: {
    params: { subFifth: number; subThird: number; wBass: number; wEdge: number; introShare: number; majorLean: number };
    adopted: boolean;
    examples: number;
    before: number;      // held-out songs right with standard settings
    after: number;       // ... with learned settings
    at: number;
    signature: string;   // what it learned from, to know when to learn again
  };
  // GetSongBPM API key — free tier (5k/day, attribution required)
  // returns tempo + key for searched songs. The realistic working
  // alternative now that Spotify locked down audio-features.
  getsongbpm?: {
    apiKey?: string;
  };
  // UI preferences. Small bag of toggles that affect display only.
  ui?: {
    // When false (default), the Live runway hides tracks that have already
    // finished playing — keeps the visible list focused on what's still
    // ahead. Toggle on to keep the full runway visible (useful for
    // post-mortem during a service or just personal preference).
    showPlayedTracks?: boolean;
    // Shows testing tools meant for development (e.g. the Library "Key
    // test" that scores key detection against the operator's own tags).
    developerMode?: boolean;
  };
  // Engine
  sampleRate: number;
  bufferSize: number;
  // Library folders
  libraryRoots: { kind: PlaylistKind; path: string }[];
  // How weekly pattern entries become real services:
  //   'manual'      — user-driven: nothing auto-generates; the operator clicks
  //                   "Load this week" or "Load next 4 weeks" when they want
  //                   services to appear in the schedule.
  //   'auto_rotate' — recurring: today's + tomorrow's services materialize
  //                   automatically, refreshing on midnight rollover.
  weeklyPatternMode: 'manual' | 'auto_rotate';
  // Tombstones for services the user explicitly deleted. Each entry is
  // `YYYY-MM-DD|HH:MM`. The pattern generator skips these so a deleted
  // service doesn't immediately get re-created on the next tick.
  // Past entries are auto-pruned on app start to keep this list small.
  // Operator can also wipe the whole list manually via Settings →
  // Auto-schedule → "Reset all tombstones" if a test-delete or
  // accidental "Clear all" has stuck.
  skippedServiceDates: string[];
  // Default fade times
  defaults: {
    crossfadeSec: number;
    padBridgeSec: number;
    padFadeOutSec: number;
    panicFadeSec: number;
    postServiceFadeInSec: number;
    // Fade-in length for the very first pre-service track. Used both for
    // normal scheduled arms and the "Start music early & fill" path so the
    // music doesn't slam in cold.
    musicFadeInSec: number;
    // Pad player level (0..1, where 1 = unity gain) and an additional dB
    // trim (-12..+12). Applied multiplicatively when playing any pad.
    padPlayerLevel: number;
    padPlayerGainDb: number;
    // 'sharp' shows C#/D#/G#/A#/A#m on labels; 'flat' shows Db/Eb/Ab/Bb/Bbm.
    // Internal storage stays flat regardless. Default sharp.
    keyDisplayMode: 'sharp' | 'flat';
    autoStartTargetSec: number;
    // How long music fades out when bridging to the pad (Quick Play).
    musicFadeToPadSec: number;
    // How long the pad fades in BEFORE the music starts fading. So the pad
    // is already up when the music begins fading out.
    padLeadInSec: number;
    // When the pre-service playlist runtime is shorter than the auto-start lead
    // time, loop tracks to fill the time. When false, music starts late and
    // still ends exactly at the right time.
    repeatToFill: boolean;
    // On import, look up each new track's key on MultiTracks.com and
    // apply it when the match is confident and unambiguous. Tracks that
    // arrive with a key already in their tags are left alone, and
    // anything the catalog is unsure about is held for review rather
    // than guessed. Off = the Library button is the only way in.
    autoKeyTagOnImport: boolean;
    // 3-band EQ — gains in dB. 0 = flat.
    eqLowDb: number;
    eqMidDb: number;
    eqHighDb: number;
    // Auto-schedule: how many days ahead the weekly pattern materializes
    // services. Default 2 = today + tomorrow. Operator can extend if they
    // want more lookahead (e.g. 7 = always have a full week scheduled).
    autoScheduleDaysAhead: number;
    // Auto-schedule daily check time (HH:MM, 24h). The hourly heartbeat
    // only re-runs the materializer once the local clock has crossed this
    // time on a new calendar day — so the operator can pin the
    // create-tomorrow's-services moment (e.g. "03:00" so services appear
    // overnight, not mid-afternoon). Default '00:00' = first hourly tick
    // after midnight.
    autoScheduleTime: string;
  };
}

/**
 * Generate a random 4-digit PIN. Used to seed the remote-control PIN on
 * a fresh install so first-time users don't ship with a guessable
 * default — anyone on the LAN could otherwise unlock the remote.
 */
function randomPin(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

export const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  playlists: [],
  actionSequences: [],
  tracks: [],
  services: [],
  weeklyPattern: [],
  pads: [],
  audioRouting: [
    { bus: 'music', deviceId: null, channelPair: [0, 1], gainDb: 0 },
    { bus: 'pad', deviceId: null, channelPair: [0, 1], gainDb: 0 },
    { bus: 'cue', deviceId: null, channelPair: [0, 1], gainDb: 0 },
  ],
  midiBindings: [],
  midiDevices: [],
  remote: {
    port: 7811,
    pin: randomPin(),
    autoRelockSec: 60,
    bindHost: '',
  },
  timecodeOutput: {
    enabled: false,
    outputPortName: null,
    frameRate: 30,
    mode: 'countdown_to_service',
  },
  proPresenterSync: {
    enabled: false,
    host: 'localhost',
    port: 1025,
    password: '',
    timerUuid: null,
    timerName: null,
    musicStartAction: 'none',
    musicStartPlaylistUuid: null,
    musicStartPlaylistName: null,
    musicStartItemIndex: null,
    musicStartItemName: null,
    disarmAction: 'none',
    disarmPlaylistUuid: null,
    disarmPlaylistName: null,
    disarmItemIndex: null,
    disarmItemName: null,
    serviceStartAction: 'none',
    serviceStartPlaylistUuid: null,
    serviceStartPlaylistName: null,
    serviceStartItemIndex: null,
    serviceStartItemName: null,
    postServiceStartAction: 'none',
    postServiceStartPlaylistUuid: null,
    postServiceStartPlaylistName: null,
    postServiceStartItemIndex: null,
    postServiceStartItemName: null,
  },
  pcoSync: {
    enabled: false,
    appId: '',
    secret: '',
    serviceTypeId: null,
    serviceTypeName: null,
    pullLeadSec: 14400, // 4 hours before service by default
  },
  ui: {
    showPlayedTracks: false,
  },
  sampleRate: 48000,
  bufferSize: 256,
  libraryRoots: [],
  weeklyPatternMode: 'auto_rotate',
  skippedServiceDates: [],
  defaults: {
    crossfadeSec: 6,
    padBridgeSec: 10,
    padFadeOutSec: 5,
    panicFadeSec: 1.5,
    postServiceFadeInSec: 4,
    musicFadeInSec: 6,
    padPlayerLevel: 0.6,
    padPlayerGainDb: 0,
    keyDisplayMode: 'sharp',
    autoStartTargetSec: 900, // 15 min
    musicFadeToPadSec: 5,
    padLeadInSec: 5,
    repeatToFill: true,
    autoKeyTagOnImport: true,
    eqLowDb: 0,
    eqMidDb: 0,
    eqHighDb: 0,
    autoScheduleDaysAhead: 2,
    autoScheduleTime: '00:00',
  },
};

/**
 * Result of a re-link pass. Re-linking repoints each track's / pad's
 * `filePath` to where the file actually lives on THIS computer (matched
 * by filename), without touching the track id, key, trims, fades, or any
 * playlist membership. It's how a config exported from another machine —
 * where absolute paths embed the old username / library location — gets
 * reconnected to the local files after a migration.
 */
export interface RelinkReport {
  tracksOk: number;         // already pointed at a file that exists
  tracksRelinked: number;   // repointed to a newly-found file
  tracksMissing: number;    // no matching file found anywhere searched
  padsOk: number;
  padsRelinked: number;
  padsMissing: number;
  // Filenames still unresolved after the pass (tracks + pads), for the UI.
  missingNames: string[];
  // Ids of tracks still unresolved — lets the UI show which playlists are
  // affected. Optional so older callers keep compiling.
  missingTrackIds?: string[];
  // True when at least one path changed (so the caller knows to persist).
  changed: boolean;
}

// ---- Playlist + audio bundles (Settings → Backup & restore) ----

/** library.json inside an exported "Runway Library" folder. File paths in
 *  tracks/pads are relative to the bundle folder (audio/…, pads/…). */
export interface LibraryBundleManifest {
  format: 'runway-library';
  version: number;
  exportedAt: string;
  appVersion: string;
  playlists: Playlist[];
  tracks: Track[];
  pads: PadFile[];
}

/** add = import as new copies; merge = add missing songs to same-named
 *  playlists; replace = overwrite same-named playlists. */
export type LibraryImportMode = 'add' | 'merge' | 'replace';

export interface LibraryBundlePreview {
  bundleDir: string;
  exportedAt: string;
  playlists: Array<{ name: string; trackCount: number; existsAlready: boolean }>;
  trackCount: number;
  padCount: number;
}

export interface LibraryImportReport {
  mode: LibraryImportMode;
  playlistsAdded: number;
  playlistsMerged: number;
  playlistsReplaced: number;
  tracksAdded: number;
  tracksReused: number;
  filesCopied: number;
  padsAdded: number;
  padsReplaced: number;
  missingFiles: string[];
}

// IPC channel names — keeping a const enum for typo safety
export const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_EXPORT: 'config:export',
  CONFIG_IMPORT: 'config:import',
  CONFIG_RELINK: 'config:relink',
  LIBRARY_EXPORT: 'library:export',
  LIBRARY_PREVIEW: 'library:preview',
  LIBRARY_IMPORT: 'library:import',
  FILE_PICK: 'file:pick',
  FOLDER_PICK: 'folder:pick',
  FOLDER_SCAN: 'folder:scan',
  TRACK_METADATA: 'track:metadata',
  FILE_IMPORT: 'file:import',
  PAD_IMPORT: 'pad:import',
  LIBRARY_PATHS: 'library:paths',
  REVEAL_FOLDER: 'shell:revealFolder',
  TRAY_UPDATE: 'tray:update',
  TRAY_SHOW_WINDOW: 'tray:showWindow',
  AUDIO_DEVICES_LIST: 'audio:devicesList',
  AUDIO_WRITE_WAV: 'audio:writeWav',
  PP_REQUEST: 'pp:request',
  PAD_FOLDER_SCAN: 'pad:folderScan',
  REMOTE_SNAPSHOT: 'remote:snapshot',
  REMOTE_LAN_URLS: 'remote:lanUrls',
  REMOTE_COMMAND: 'remote:command',
  REMOTE_NETWORK_INTERFACES: 'remote:networkInterfaces',
  OPEN_CHANGELOG: 'app:openChangelog',
  ITUNES_ART_LOOKUP: 'track:itunesArt',
  ITUNES_CANDIDATES_LOOKUP: 'track:itunesCandidates',
  SPOTIFY_LOOKUP: 'track:spotify',
  GETSONGBPM_LOOKUP: 'track:getsongbpm',
  // Persistent service-timing diagnostics. The renderer mirrors its
  // timing-tagged console logs to a timing.log file next to config.json
  // (one-way append); REVEAL opens that file in the OS file browser.
  TIMING_LOG_APPEND: 'timing:logAppend',
  TIMING_LOG_REVEAL: 'timing:logReveal',
  // Planning Center forwarded HTTPS GET (proxied through main for auth/CORS).
  PCO_REQUEST: 'pco:request',
  // Experimental: measure how precisely the Spotify desktop app can be
  // made to land a song on a planned moment (macOS, AppleScript).
  SPOTIFY_TIMING_TEST: 'spotify:timingTest',
  // Experimental: Spotify account link (PKCE sign-in) + playlist reader.
  SPOTIFY_CONNECT: 'spotify:connect',
  SPOTIFY_STATUS: 'spotify:status',
  SPOTIFY_HEALTH: 'spotify:health',
  SPOTIFY_DISCONNECT: 'spotify:disconnect',
  SPOTIFY_PLAYLIST_READ: 'spotify:playlistRead',
  // Experimental: one remote-control command to the Spotify desktop app.
  SPOTIFY_PLAYER: 'spotify:player',
  // Experimental: list the signed-in user's own/collaborative playlists.
  SPOTIFY_PLAYLISTS_LIST: 'spotify:playlistsList',
  // Experimental: download a Spotify album image as a data URL.
  SPOTIFY_FETCH_ART: 'spotify:fetchArt',
  SPOTIFY_WAVEFORM_ENABLE: 'spotify:waveformEnable',
  SPOTIFY_WAVEFORM_STATUS: 'spotify:waveformStatus',
  SPOTIFY_WAVEFORM_GET: 'spotify:waveformGet',
  SPOTIFY_WAVEFORM_COVERAGE: 'spotify:waveformCoverage',
  SPOTIFY_WAVEFORM_KEYS: 'spotify:waveformKeys',
  STORE_OPEN: 'purchases:openStore',
  APPLE_STORE_LOOKUP: 'purchases:appleLookup',
  PURCHASES_FIND: 'purchases:find',
  MULTITRACKS_LOOKUP: 'track:multitracks',
} as const;

// ── Spotify (experimental) ────────────────────────────────────────────
export interface SpotifyStatus {
  connected: boolean;
  displayName?: string;
  reason?: string;
  /** The sign-in allows starting songs through Spotify Connect. */
  canControl?: boolean;
  /** Quiet start is switched on (songs start without showing Spotify). */
  quietStart?: boolean;
  /** Spotify refused the saved sign-in: sign in again in Settings › Spotify. */
  signInLost?: boolean;
}
/** Result of the periodic Spotify sign-in check. */
export interface SpotifyHealth {
  /** ok; expired: Spotify refused Runway's sign-in; none: never signed in; offline: couldn't reach Spotify. */
  account: 'ok' | 'expired' | 'none' | 'offline';
  /** False when the Spotify app is open here but isn't on the account (logged out, or another account). */
  appOnAccount?: boolean;
  accountComputers?: string[];
}
/** A song's note profile from the key detector (12 values each, C first); enough to re-score it. */
export interface KeyProfile { harm: number[]; bass: number[]; intro: number[]; outro: number[]; tuning: number }

/** A key Runway worked out by listening to a Spotify song (its own detector). */
export interface SpotifyKeyGuess {
  key: KeyName;
  confidence: number;      // 0…1: how clearly it beat other keys
  candidates: KeyName[];   // best first
  heardSec: number;        // seconds of the song it was based on
  endKey?: KeyName;        // the last 30 s, when that's a different key
  endConfidence?: number;
  at: number;
  /** For re-scoring with learned settings (Settings › key learning). */
  profile?: KeyProfile;
  /** Note map: per second of the song, 12 note strengths 0–99 (C first); null = not heard. Display only. */
  noteMap?: Array<number[] | null>;
}
/** Why a Spotify song has a waveform but no key reading yet. */
export interface SpotifyKeyMiss {
  at: number;
  heardSec: number;
  /** no-sound: loudness came through but no sound to listen to; too-short: under 15 s heard. */
  why: 'no-sound' | 'too-short';
}
export interface SpotifyWaveform {
  key?: SpotifyKeyGuess;
  keyMiss?: SpotifyKeyMiss;
  /** Tempo, beats and the ringing last note, from the ending Runway heard. */
  beats?: import('./beats').BeatInfo;
  binSec: number;          // seconds per column
  durationSec: number;
  peaks: number[];         // 0…1 per column; -1 = that part hasn't been heard yet
  coverage: number;        // share of the song heard, 0…1
}
export interface SpotifyWaveformStatus {
  enabled: boolean;
  tap: 'off' | 'starting' | 'on' | 'denied' | 'unavailable' | 'error';
  reason?: string;
}
export interface SpotifyPlaylistTrack {
  uri: string;             // spotify:track:…
  title: string;
  artist: string;
  durationMs: number;
  albumArtUrl?: string;
}
/**
 * Trim / fade / landing edits for one Spotify song, like the Editor's
 * fields for imported tracks. All in seconds of the song; all optional.
 */
export interface SpotifyTrackEdit {
  trimStartSec?: number;
  trimEndSec?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  /** When this song is last, the countdown hits 0:00 here (see songBounds). */
  landSec?: number;
  /** landSec is an accepted suggestion, not moved since (0:00 learning skips it). */
  landAuto?: boolean;
  /** Values that came from accepted suggestions (so they can be removed again). */
  suggestApplied?: { startSec?: number; endSec?: number; landSec?: number };
  /** Song key, set by the operator or looked up. Spotify no longer gives keys to apps. */
  key?: KeyName;
  /** True when Find keys set `key` on its own (not learned from; any hand edit clears it). */
  keyAuto?: boolean;
}

/** One command to the Spotify desktop app (macOS, experimental). */
export type SpotifyPlayerCommand =
  | { op: 'check' }
  | { op: 'play'; uri: string; contextUri?: string; /** start the usual way, not through Spotify Connect */ noQuiet?: boolean }
  | { op: 'stateWithLength' }
  | { op: 'launch' }
  | { op: 'background' }
  | { op: 'nowPlaying' }
  | { op: 'seek'; positionSec: number }
  | { op: 'volume'; volume: number }
  | { op: 'pause' }
  | { op: 'resume' }
  | { op: 'tuck' }
  | { op: 'accessibility'; prompt?: boolean }
  | { op: 'state' }
  | { op: 'volumeAndState'; volume: number }
  | { op: 'quietStart'; on: boolean }
  | { op: 'macOutput' }
  | { op: 'macUnmute' };

export interface SpotifyPlayerReply {
  ok: boolean;
  reason?: string;
  /** macOutput: the Mac's own output volume (0–100) and mute. */
  macVolume?: number;
  macMuted?: boolean;
  /** play: started through Spotify Connect (Spotify stayed in the background). */
  quiet?: boolean;
  /** Date.now() when the command was sent / when Spotify answered. */
  sentAt?: number;
  answeredAt?: number;
  trackUri?: string;
  playerState?: 'playing' | 'paused' | 'stopped';
  positionSec?: number;
  volume?: number;
  /** 'play' only: Spotify was already the front app before the song started. */
  wasFrontmost?: boolean;
  /** 'tuck' / 'accessibility': whether Runway may close Spotify's window (macOS Accessibility). */
  accessibilityAllowed?: boolean;
  /** 'nowPlaying' only: details of the current song. */
  title?: string;
  artist?: string;
  /** 'nowPlaying' / 'stateWithLength': the current song's length. */
  durationSec?: number;
  artworkUrl?: string;
}

export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  imageUrl?: string;
  songCount?: number;
}
export interface SpotifyPlaylistList {
  ok: boolean;
  reason?: string;
  playlists?: SpotifyPlaylistSummary[];
}
export interface SpotifyPlaylistResult {
  ok: boolean;
  reason?: string;
  playlistId?: string;
  name?: string;
  tracks?: SpotifyPlaylistTrack[];
  // Entries Runway can't play by link (podcast episodes, local files).
  skipped?: number;
}


/**
 * Compact snapshot the renderer pushes to main on each store change.
 * Drives the menu-bar tray icon's context menu — currently armed
 * service, countdown line, list of upcoming services, now-playing
 * line. Renderer pre-formats all strings so main doesn't have to
 * track wall-clock for label updates; main just rebuilds the menu
 * whenever a fresh snapshot arrives.
 */
export interface TraySnapshot {
  isArmed: boolean;
  statusLine: string;
  countdownLabel: string | null;
  upcomingLabels: string[];
  nowPlayingLabel: string | null;
  /** Optional short string (e.g. "12:34") to show as the tray title next to the icon. */
  tickerLabel: string | null;
}

/** Single iTunes match returned by ITUNES_ART_LOOKUP. */
export interface ITunesMatch {
  artworkUrl: string;   // 600x600 cover image, base64 data URL
  albumName: string;    // collectionName from the API; empty string if missing
}

/** One candidate row in the artwork picker. */
export interface ITunesCandidate {
  artworkUrl: string;
  albumName: string;
  artistName: string;
  trackName: string;
}

// ProPresenter sync — forwarded HTTP request shape used over IPC. The renderer
// can't fetch PP directly because the API doesn't return CORS headers; main
// proxies the call through Node's http module.
export interface PpRequest {
  host: string;
  port: number;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;            // e.g. '/v1/timers'
  password?: string;       // bearer token if PP has Network API password set
  body?: unknown;          // JSON-serialized into the request
  timeoutMs?: number;      // default 4000
}

export interface PpResponse {
  ok: boolean;
  status: number;          // 0 if the connection itself failed
  body: string;            // raw body text — caller decides whether to JSON.parse
  error?: string;          // populated when status === 0
}

// Planning Center forwarded HTTPS request. Same reason as PpRequest — the
// renderer can't call api.planningcenteronline.com directly (CORS), so main
// proxies the GET through Node's https module with HTTP Basic auth built
// from the Personal Access Token (appId:secret).
export interface PcoRequest {
  appId: string;
  secret: string;
  path: string;            // e.g. '/services/v2/service_types'
  timeoutMs?: number;      // default 8000
}

export interface PcoResponse {
  ok: boolean;
  status: number;          // 0 if the connection itself failed
  body: string;            // raw body text — caller JSON.parses
  error?: string;          // populated when status === 0
}
