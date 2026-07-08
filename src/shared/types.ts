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
  // Auto-detection metadata; set if auto-tagged
  keyConfidence?: number;
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
  postServicePlaylistId?: string;
  // The headliner: where the playlist must land. `undefined` means inherit
  // from the first service of this date (use resolveServiceFirstSongKey).
  // For the first service of the day, undefined just means "no key set".
  firstSongKey?: KeyName;
  // Optional pinned anchor — forces the pre-service playlist to end on this
  // exact track, regardless of key match. `undefined` means inherit from the
  // first service of the date; for the first service, undefined = Auto (let
  // arrange pick). Use resolveServiceLastSongTrackId.
  lastSongTrackId?: string;
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
  // Optional Spotify credentials — kept for forward-compat in case
  // Spotify restores audio-features access for new apps. Currently
  // (post-Nov-2024) only useful for the search + art endpoints.
  spotify?: {
    clientId?: string;
    clientSecret?: string;
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
    eqLowDb: 0,
    eqMidDb: 0,
    eqHighDb: 0,
    autoScheduleDaysAhead: 2,
    autoScheduleTime: '00:00',
  },
};

// IPC channel names — keeping a const enum for typo safety
export const IPC = {
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  CONFIG_EXPORT: 'config:export',
  CONFIG_IMPORT: 'config:import',
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
} as const;

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
