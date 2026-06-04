import { create } from 'zustand';
import type { AppConfig, Track, Playlist, ServiceInstance, MidiLogEntry, KeyName, PlaylistKind, ActionSequence, Action } from '@shared/types';
import {
  DEFAULT_CONFIG,
  effectiveDuration,
  resolveServiceFirstSongKey,
  resolveServiceLastSongTrackId,
} from '@shared/types';
import { compatibleKeys } from '@shared/music';
import { todayISO } from '../lib/format';

export type ViewName = 'live' | 'playlists' | 'library' | 'schedule' | 'actions' | 'editor' | 'settings';

interface PlaybackInfo {
  bus: 'music' | 'pad';
  isPlaying: boolean;
  trackId?: string;
  filePath?: string;
  positionSec: number;
  durationSec: number;
}

export type SettingsTab = 'audio' | 'midi' | 'propresenter' | 'pads' | 'remote' | 'engine' | 'display' | 'about';

interface AppStoreState {
  // UI
  view: ViewName;
  selectedPlaylistId: string | null;
  selectedServiceId: string | null;
  // When set, SettingsView will switch to this tab on next render then clear it.
  pendingSettingsTab: SettingsTab | null;
  midiConnected: boolean;
  // PP connection state — driven by a periodic heartbeat in engines.tsx.
  // 'disabled' = PP sync toggle is off; nothing else attempted.
  ppStatus: 'disabled' | 'unknown' | 'ok' | 'err';
  // Cached PP data fetched whenever connection comes up. Lives in the store
  // (not in component state) so the ProPresenter settings tab is populated
  // the moment the user navigates to it, instead of having to re-fetch on
  // every mount.
  ppTimers: { uuid: string; name: string; index?: number }[];
  ppPlaylists: { uuid: string; name: string; index?: number }[];
  midiEnabled: boolean;
  midiLog: MidiLogEntry[];

  // Audio playback state
  musicPlayback: PlaybackInfo;
  padPlayback: PlaybackInfo;
  padArmedKey: KeyName | null;
  // True while Fade-to-Pad is engaged: music has been faded to
  // silence (source still playing) and a pad is holding the room.
  // Toggle off (click the button again) to bring music back and fade
  // the pad out. Ephemeral — not persisted across app restarts.
  fadeToPadActive: boolean;

  // Auto-arrange runtime — set when a service is armed OR when Quick Play is running.
  // For Quick Play, serviceId is null and the pad/target fields are 0 (no bridge).
  currentRunway: {
    serviceId: string | null;
    trackIds: string[];
    totalSec: number;
    landInKey?: KeyName;
    plannedStartTime?: string;
    // When > 0, the controller skips this many seconds into the first track
    // when starting playback. Used to keep music end exactly at musicEnd time
    // when the runway content is longer than the target window.
    startOffsetSec: number;
    // Epoch ms target — the service start time, music auto-starts before this.
    targetMs: number;
    // Epoch ms when music should begin (= targetMs - totalSec - padBridge - padFade)
    musicStartMs: number;
    // Epoch ms when pad should begin
    padStartMs: number;
    // Snapshot of playlist behavior so the controller doesn't re-read.
    transitionMode: 'crossfade' | 'gapless';
    crossfadeSec: number;
    padBridgeSec: number;
    padFadeOutSec: number;
    // Seconds the anchor track will continue playing AFTER the timer hits
    // zero — set when the anchor has an editServiceLandSec marker. 0 means
    // music ends at service start (current default). UI surface only;
    // armService already factors this into musicStartMs.
    tailSec: number;
    // Per-arm override: skip the pad bridge for this run regardless of the
    // service's saved disablePadBridge setting. Set automatically when the
    // anchor's key doesn't match the requested first-song key, so the
    // operator never gets a wrong-key pad.
    skipPadBridge?: boolean;
    // True for post-service playback: walks the playlist sequentially with no
    // pad bridge at the end, just fades out when the last track ends.
    isPostService?: boolean;
    // Source playlist for status text — set by armService, quickPlay, post-service.
    sourcePlaylistId?: string;
    // For post-service / change_setlist runways (which set serviceId to
    // null because they don't run a service), this preserves the id of
    // the service the post-service was triggered from. The action-
    // sequence resolver uses it to find any per-service post-service
    // override the operator configured. Undefined when post-service
    // was started ad-hoc with no associated service.
    originServiceId?: string;
    // Phase tracking for the controller.
    phase: 'queued' | 'music' | 'pad' | 'done';
    currentTrackIndex: number;
    // Set by controller.startMusicEarly so the UI knows to show "Cancel
    // early music & wait" instead of treating this as a normal queued/music
    // transition. Cleared on cancel or natural completion.
    startedEarly?: boolean;
    // Monotonic id assigned in setCurrentRunway. Lets the action engine
    // distinguish a real arm/swap (new id → reset firedActionIds, reset
    // bus levels) from a position-only patch like a skip-forward (same id,
    // musicStartMs adjusted but no action-firing reset). Without this the
    // skip's musicStartMs change was triggering a sig change, which
    // cleared firedActionIds and re-armed already-fired cues.
    armEpoch?: number;
  } | null;

  // Persisted config
  config: AppConfig;
  configLoaded: boolean;

  // Actions
  setView: (v: ViewName) => void;
  setSelectedPlaylistId: (id: string | null) => void;
  setSelectedServiceId: (id: string | null) => void;
  // Master Auto-Arm switch — on by default at app load, flipped off when the
  // user explicitly disarms during a session. Not persisted; resets on restart.
  autoArmEnabled: boolean;
  setAutoArmEnabled: (b: boolean) => void;
  // True while the operator's first disarm press is awaiting confirmation —
  // shared between the Live view button and MIDI arm_toggle so both turn red
  // during the 3s window. Not persisted; cleared on app start.
  armConfirmDisarm: boolean;
  setArmConfirmDisarm: (b: boolean) => void;
  openSettings: (tab: SettingsTab) => void;
  consumePendingSettingsTab: () => SettingsTab | null;
  // Deep-link a specific track into the Editor view.
  pendingEditorTrackId: string | null;
  openEditor: (trackId: string) => void;
  consumePendingEditorTrackId: () => string | null;
  setMidiConnected: (b: boolean) => void;
  setPpStatus: (s: 'disabled' | 'unknown' | 'ok' | 'err') => void;
  setPpTimers: (t: { uuid: string; name: string; index?: number }[]) => void;
  setPpPlaylists: (p: { uuid: string; name: string; index?: number }[]) => void;
  setMidiEnabled: (b: boolean) => void;
  appendMidiLog: (entry: MidiLogEntry) => void;
  /** Wipe the in-memory MIDI activity log. Fired from the remote's
   *  Clear button (next to "View all"). UI-only — does not touch any
   *  device state or bindings. */
  clearMidiLog: () => void;
  setMusicPlayback: (p: Partial<PlaybackInfo>) => void;
  setPadPlayback: (p: Partial<PlaybackInfo>) => void;
  setPadArmedKey: (k: KeyName | null) => void;
  setFadeToPadActive: (active: boolean) => void;
  setCurrentRunway: (r: AppStoreState['currentRunway']) => void;
  patchCurrentRunway: (patch: Partial<NonNullable<AppStoreState['currentRunway']>>) => void;

  // Config setters (persist on every change)
  loadConfig: () => Promise<void>;
  saveConfig: () => Promise<void>;
  updateConfig: (patch: Partial<AppConfig>) => void;

  // Playlist actions
  createPlaylist: (name: string, kind: PlaylistKind) => string;
  duplicatePlaylist: (id: string) => string | null;
  updatePlaylist: (id: string, patch: Partial<Playlist>) => void;
  deletePlaylist: (id: string) => void;
  addTrackToPlaylist: (playlistId: string, trackId: string) => void;
  removeTrackFromPlaylist: (playlistId: string, trackId: string) => void;
  reorderPlaylistTracks: (playlistId: string, trackIds: string[]) => void;

  // Action sequences (timed automations applied per-playlist)
  createActionSequence: (name: string) => string;
  duplicateActionSequence: (id: string) => string | null;
  updateActionSequence: (id: string, patch: Partial<ActionSequence>) => void;
  deleteActionSequence: (id: string) => void;
  addAction: (sequenceId: string, partial?: Partial<Action>) => string;
  updateAction: (sequenceId: string, actionId: string, patch: Partial<Action>) => void;
  deleteAction: (sequenceId: string, actionId: string) => void;

  // Track actions
  // Returns a filePath → canonical trackId map so callers can add the right
  // ids to a playlist even when some files were already imported.
  addTracks: (tracks: Track[]) => Record<string, string>;
  updateTrack: (id: string, patch: Partial<Track>) => void;
  deleteTrack: (id: string) => void;

  // Schedule actions
  upsertService: (service: ServiceInstance) => void;
  deleteService: (id: string) => void;
  /**
   * Walk forward `daysAhead` days from today (inclusive) and materialize a
   * real service for every enabled WeeklyPatternEntry that doesn't already
   * have one at that date+time. Idempotent — running it twice is a no-op the
   * second time.
   *
   * `opts.respectTombstones`: when true (default), skips slots the user
   * deleted. When false (manual Load buttons), overrides tombstones — the
   * user is explicitly asking for those services back, so we clear the
   * relevant tombstones and recreate.
   *
   * Returns the number of services created.
   */
  generateServicesFromPattern: (daysAhead: number, opts?: { respectTombstones?: boolean }) => number;
  /** Wipe the entire skippedServiceDates list. Wired to the Settings →
   *  Auto-schedule "Reset all tombstones" button. After this, the next
   *  materializer pass will fill from the weekly pattern unobstructed. */
  clearAllTombstones: () => void;
  setServiceStatus: (id: string, status: ServiceInstance['status']) => void;

  // Arm / Disarm — computes the runway and primes for auto-start.
  // preloader is called for each filePath the controller will need; failures
  // don't block arming, the controller will retry at fire time.
  /** opts.leadOverrideSec lets callers (e.g. controller.startMusicEarly) ask
   *  arming to use a different lead window than the service's own
   *  `autoStartTargetSec`.
   *  opts.shuffle randomizes the rotation order before the anchor — used by
   *  the Shuffle button to re-roll a queued arrangement. The pinned anchor
   *  (and key constraint) are still honored. */
  armService: (
    serviceId: string,
    preloader?: (filePath: string) => Promise<void>,
    opts?: {
      leadOverrideSec?: number;
      shuffle?: boolean;
      // Use this playlist as the pre-service music instead of the
      // service's saved preServicePlaylistId. Used by the arm_playlist
      // action so a sequence can swap which playlist arms without
      // mutating the service's saved settings.
      playlistOverrideId?: string;
      // Override the global `repeatToFill` default for this arm only.
      repeatToFill?: boolean;
    },
  ) => Promise<{ ok: boolean; reason?: string; warning?: string }>;
  disarmService: (serviceId: string) => void;
  // Push the service's stored start time forward by `addSec`. If the
  // runway is currently armed for this service, also push runway.targetMs
  // and runway.padStartMs so the pad bridge extends and the PP timer
  // (driven from runway.targetMs) updates automatically.
  extendServiceStart: (serviceId: string, addSec: number) => void;

  // Rehearsal — creates a temp service starting `secondsFromNow` from now,
  // returns its id. Marks isRehearsal=true so the controller cleans it up.
  createRehearsalService: (opts: {
    preServicePlaylistId: string;
    postServicePlaylistId?: string;
    firstSongKey?: KeyName;
    secondsFromNow: number;
    autoStartTargetSec: number;
  }) => string;
}

const MAX_LOG_ENTRIES = 200;

// Monotonic counter for runway armEpoch — uniquely identifies each
// setCurrentRunway(non-null) call so the controller can distinguish
// real arms from position-only patches via patchCurrentRunway.
let _armEpochCounter = 0;
const nextArmEpoch = () => ++_armEpochCounter;

export const useAppStore = create<AppStoreState>((set, get) => ({
  view: 'live',
  selectedPlaylistId: null,
  selectedServiceId: null,
  pendingSettingsTab: null,
  midiConnected: false,
  ppStatus: 'disabled',
  ppTimers: [],
  ppPlaylists: [],
  midiEnabled: true,
  midiLog: [],

  musicPlayback: { bus: 'music', isPlaying: false, positionSec: 0, durationSec: 0 },
  padPlayback: { bus: 'pad', isPlaying: false, positionSec: 0, durationSec: 0 },
  padArmedKey: null,
  fadeToPadActive: false,

  currentRunway: null,

  config: DEFAULT_CONFIG,
  configLoaded: false,

  setView: (v) => set({ view: v }),
  setSelectedPlaylistId: (id) => set({ selectedPlaylistId: id }),
  setSelectedServiceId: (id) => set({ selectedServiceId: id }),
  autoArmEnabled: true,
  setAutoArmEnabled: (b) => set({ autoArmEnabled: b }),
  armConfirmDisarm: false,
  setArmConfirmDisarm: (b) => set({ armConfirmDisarm: b }),
  openSettings: (tab) => set({ view: 'settings', pendingSettingsTab: tab }),
  consumePendingSettingsTab: () => {
    const tab = get().pendingSettingsTab;
    if (tab) set({ pendingSettingsTab: null });
    return tab;
  },
  pendingEditorTrackId: null,
  openEditor: (trackId) => set({ view: 'editor', pendingEditorTrackId: trackId }),
  consumePendingEditorTrackId: () => {
    const id = get().pendingEditorTrackId;
    if (id) set({ pendingEditorTrackId: null });
    return id;
  },
  setMidiConnected: (b) => set({ midiConnected: b }),
  setPpStatus: (s) => set({ ppStatus: s }),
  setPpTimers: (t) => set({ ppTimers: t }),
  setPpPlaylists: (p) => set({ ppPlaylists: p }),
  setMidiEnabled: (b) => set({ midiEnabled: b }),

  appendMidiLog: (entry) => set(state => {
    const next = [...state.midiLog, entry];
    return { midiLog: next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next };
  }),
  clearMidiLog: () => set({ midiLog: [] }),

  setMusicPlayback: (p) => set(state => ({ musicPlayback: { ...state.musicPlayback, ...p } })),
  setPadPlayback: (p) => set(state => ({ padPlayback: { ...state.padPlayback, ...p } })),
  setPadArmedKey: (k) => set({ padArmedKey: k }),
  setFadeToPadActive: (active) => set({ fadeToPadActive: active }),
  setCurrentRunway: (r) => set({
    // Auto-attach a fresh armEpoch on every non-null assignment so the
    // controller can detect "real arm/swap" without colliding with
    // position-only patches that also pass through this state.
    currentRunway: r ? { ...r, armEpoch: nextArmEpoch() } : null,
  }),
  patchCurrentRunway: (patch) => set(state => ({
    currentRunway: state.currentRunway ? { ...state.currentRunway, ...patch } : state.currentRunway,
  })),

  loadConfig: async () => {
    if (!window.runway) {
      // Running in non-Electron (e.g. dev outside electron) — use defaults
      set({ configLoaded: true });
      return;
    }
    try {
      const loaded = await window.runway.config.get();
      // Merge any new default fields that weren't in the user's saved config.
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        ...loaded,
        defaults: { ...DEFAULT_CONFIG.defaults, ...(loaded?.defaults ?? {}) },
        weeklyPatternMode: (() => {
          const raw = (loaded as { weeklyPatternMode?: string } | undefined)?.weeklyPatternMode;
          if (raw === 'jit') return 'auto_rotate'; // older legacy key
          if (raw === 'rolling') return 'manual';  // older "pre-populate" key
          if (raw === 'manual' || raw === 'auto_rotate') return raw;
          return DEFAULT_CONFIG.weeklyPatternMode;
        })(),
        // Tombstones list — drop any entries whose date is already past so
        // the list doesn't grow forever, and ensure the field exists.
        // Operator can also wipe the whole list manually via Settings.
        skippedServiceDates: (() => {
          const raw = (loaded as { skippedServiceDates?: unknown } | undefined)?.skippedServiceDates;
          const list = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : [];
          // Local-date key — tombstones are stored as `YYYY-MM-DD|HH:MM`
          // in the operator's local timezone, so UTC-based comparison
          // would prune today's tombstones an hour after local midnight
          // (or keep yesterday's ones around an extra day on Pacific time).
          const todayKey = todayISO();
          return list.filter(entry => {
            const date = entry.split('|')[0];
            return date >= todayKey;
          });
        })(),
        // Remote: one-time migration off the legacy `0000` default. Pin
        // stays '0000' as long as that's literally what was on disk —
        // means the user never customised it, so we bump to a random
        // 4-digit so the remote isn't openly unlockable on the LAN.
        // Anyone who'd deliberately set '0000' would have to set it
        // back through Settings → Remote.
        remote: (() => {
          const merged = { ...DEFAULT_CONFIG.remote, ...(loaded?.remote ?? {}) };
          if (merged.pin === '0000') merged.pin = DEFAULT_CONFIG.remote.pin;
          return merged;
        })(),
        timecodeOutput: { ...DEFAULT_CONFIG.timecodeOutput, ...(loaded?.timecodeOutput ?? {}) },
        proPresenterSync: (() => {
          const merged: any = { ...DEFAULT_CONFIG.proPresenterSync, ...(loaded?.proPresenterSync ?? {}) };

          // v1: old `triggerMedia*` field names from the media-library era — drop.
          delete merged.triggerMediaUuid;
          delete merged.triggerMediaName;

          // v2: arm-trigger boolean + `trigger*` field prefix → musicStartAction
          // dropdown + `musicStart*` prefix. Migrate values forward so existing
          // setups don't lose their pick.
          if ('triggerOnMusicStart' in merged || 'triggerPlaylistUuid' in merged) {
            merged.musicStartAction =
              merged.triggerOnMusicStart && merged.triggerPlaylistUuid && merged.triggerItemIndex !== null
                ? 'trigger_item'
                : (merged.musicStartAction ?? 'none');
            merged.musicStartPlaylistUuid = merged.musicStartPlaylistUuid ?? merged.triggerPlaylistUuid ?? null;
            merged.musicStartPlaylistName = merged.musicStartPlaylistName ?? merged.triggerPlaylistName ?? null;
            merged.musicStartItemIndex = merged.musicStartItemIndex ?? merged.triggerItemIndex ?? null;
            merged.musicStartItemName = merged.musicStartItemName ?? merged.triggerItemName ?? null;
          }
          delete merged.triggerOnMusicStart;
          delete merged.triggerPlaylistUuid;
          delete merged.triggerPlaylistName;
          delete merged.triggerItemIndex;
          delete merged.triggerItemName;

          // Coerce missing fields on each hook to safe defaults.
          merged.musicStartAction = merged.musicStartAction ?? 'none';
          merged.musicStartPlaylistUuid = merged.musicStartPlaylistUuid ?? null;
          merged.musicStartPlaylistName = merged.musicStartPlaylistName ?? null;
          merged.musicStartItemIndex = merged.musicStartItemIndex ?? null;
          merged.musicStartItemName = merged.musicStartItemName ?? null;
          merged.disarmAction = merged.disarmAction ?? 'none';
          merged.disarmPlaylistUuid = merged.disarmPlaylistUuid ?? null;
          merged.disarmPlaylistName = merged.disarmPlaylistName ?? null;
          merged.disarmItemIndex = merged.disarmItemIndex ?? null;
          merged.disarmItemName = merged.disarmItemName ?? null;
          merged.serviceStartAction = merged.serviceStartAction ?? 'none';
          merged.serviceStartPlaylistUuid = merged.serviceStartPlaylistUuid ?? null;
          merged.serviceStartPlaylistName = merged.serviceStartPlaylistName ?? null;
          merged.serviceStartItemIndex = merged.serviceStartItemIndex ?? null;
          merged.serviceStartItemName = merged.serviceStartItemName ?? null;
          merged.postServiceStartAction = merged.postServiceStartAction ?? 'none';
          merged.postServiceStartPlaylistUuid = merged.postServiceStartPlaylistUuid ?? null;
          merged.postServiceStartPlaylistName = merged.postServiceStartPlaylistName ?? null;
          merged.postServiceStartItemIndex = merged.postServiceStartItemIndex ?? null;
          merged.postServiceStartItemName = merged.postServiceStartItemName ?? null;
          return merged;
        })(),
      };
      set({ config, configLoaded: true });
      // If we just bumped the legacy '0000' PIN to a fresh random,
      // persist immediately so the main process's RemoteServer picks
      // up the new value via its config-update IPC (it booted from
      // the raw on-disk file before this migration ran).
      if (loaded?.remote?.pin === '0000' && config.remote.pin !== '0000') {
        void get().saveConfig();
      }
      // Auto-rotate mode materializes services from the weekly pattern.
      // Lookahead is configurable in Settings → Engine → Auto-schedule
      // (autoScheduleDaysAhead, default 2 = today + tomorrow). Manual mode
      // is user-driven — no implicit generation.
      if (config.weeklyPatternMode === 'auto_rotate') {
        const daysAhead = Math.max(1, Math.min(60, config.defaults.autoScheduleDaysAhead ?? 2));
        get().generateServicesFromPattern(daysAhead);
      }
    } catch (err) {
      console.error('[store] loadConfig failed', err);
      set({ configLoaded: true });
    }
  },

  saveConfig: async () => {
    if (!window.runway) return;
    try {
      await window.runway.config.set(get().config);
    } catch (err) {
      console.error('[store] saveConfig failed', err);
    }
  },

  updateConfig: (patch) => {
    set(state => ({ config: { ...state.config, ...patch } }));
    // Async persist (don't block)
    void get().saveConfig();
  },

  createPlaylist: (name, kind) => {
    const id = generateId();
    const now = new Date().toISOString();
    const newPl: Playlist = {
      id, name, kind,
      trackIds: [],
      playbackOrder: 'smart',
      transitionMode: 'crossfade',
      crossfadeSec: get().config.defaults.crossfadeSec,
      autoArrangeToKey: kind === 'pre',
      padBridgeSec: kind === 'pre' ? get().config.defaults.padBridgeSec : 0,
      padFadeOutSec: get().config.defaults.padFadeOutSec,
      createdAt: now,
      updatedAt: now,
    };
    set(state => ({
      config: { ...state.config, playlists: [...state.config.playlists, newPl] },
    }));
    void get().saveConfig();
    return id;
  },

  duplicatePlaylist: (id) => {
    const source = get().config.playlists.find(p => p.id === id);
    if (!source) return null;
    const existingNames = new Set(get().config.playlists.map(p => p.name));
    let name = `${source.name} (copy)`;
    let counter = 2;
    while (existingNames.has(name)) {
      name = `${source.name} (copy ${counter})`;
      counter++;
    }
    const now = new Date().toISOString();
    const newId = generateId();
    const copy: Playlist = {
      ...source,
      id: newId,
      name,
      // Tracks are shared by id — duplicating doesn't clone the underlying audio.
      trackIds: [...source.trackIds],
      sourceFolder: source.sourceFolder,
      createdAt: now,
      updatedAt: now,
    };
    set(state => ({
      config: { ...state.config, playlists: [...state.config.playlists, copy] },
    }));
    void get().saveConfig();
    return newId;
  },

  updatePlaylist: (id, patch) => {
    set(state => ({
      config: {
        ...state.config,
        playlists: state.config.playlists.map(p =>
          p.id === id ? { ...p, ...patch, updatedAt: new Date().toISOString() } : p
        ),
      },
    }));
    void get().saveConfig();
  },

  deletePlaylist: (id) => {
    set(state => ({
      config: {
        ...state.config,
        playlists: state.config.playlists.filter(p => p.id !== id),
      },
      selectedPlaylistId: state.selectedPlaylistId === id ? null : state.selectedPlaylistId,
    }));
    void get().saveConfig();
  },

  createActionSequence: (name) => {
    const id = generateId();
    const now = new Date().toISOString();
    const seq: ActionSequence = {
      id,
      name: name || 'New sequence',
      anchor: 'service_start',
      actions: [],
      createdAt: now,
      updatedAt: now,
    };
    set(state => ({
      config: {
        ...state.config,
        actionSequences: [...(state.config.actionSequences ?? []), seq],
      },
    }));
    void get().saveConfig();
    return id;
  },

  duplicateActionSequence: (id) => {
    const src = get().config.actionSequences?.find(s => s.id === id);
    if (!src) return null;
    const newId = generateId();
    const now = new Date().toISOString();
    const copy: ActionSequence = {
      ...src,
      id: newId,
      name: `${src.name} (copy)`,
      // Re-id every action so the copy lives independently of the source.
      actions: src.actions.map(a => ({ ...a, id: generateId() })),
      createdAt: now,
      updatedAt: now,
    };
    set(state => ({
      config: {
        ...state.config,
        actionSequences: [...(state.config.actionSequences ?? []), copy],
      },
    }));
    void get().saveConfig();
    return newId;
  },

  updateActionSequence: (id, patch) => {
    set(state => ({
      config: {
        ...state.config,
        actionSequences: (state.config.actionSequences ?? []).map(s =>
          s.id === id ? { ...s, ...patch, updatedAt: new Date().toISOString() } : s,
        ),
      },
    }));
    void get().saveConfig();
  },

  deleteActionSequence: (id) => {
    set(state => ({
      config: {
        ...state.config,
        actionSequences: (state.config.actionSequences ?? []).filter(s => s.id !== id),
        // Detach the sequence from any playlist still pointing at it so
        // the engine doesn't try to fire a ghost.
        playlists: state.config.playlists.map(p =>
          p.actionSequenceId === id ? { ...p, actionSequenceId: undefined } : p,
        ),
        // Clear per-service overrides too — including the legacy
        // single-field override, in case any older configs still
        // reference the deleted sequence through it.
        services: state.config.services.map(s => {
          let next = s;
          if (next.actionSequenceIdOverride === id) next = { ...next, actionSequenceIdOverride: undefined };
          if (next.preActionSequenceIdOverride === id) next = { ...next, preActionSequenceIdOverride: undefined };
          if (next.postActionSequenceIdOverride === id) next = { ...next, postActionSequenceIdOverride: undefined };
          return next;
        }),
      },
    }));
    void get().saveConfig();
  },

  addAction: (sequenceId, partial) => {
    const id = generateId();
    const seq = get().config.actionSequences?.find(s => s.id === sequenceId);
    const newAction: Action = {
      id,
      // Default the per-action anchor to the sequence's default — so
      // sequences-of-similar-anchor stay simple, but each row can drift.
      anchor: seq?.anchor ?? 'service_start',
      offsetSec: 0,
      enabled: true,
      label: '',
      payload: { type: 'midi_send', portName: '', messageType: 'note_on', channel: 1, data1: 60, data2: 100 },
      ...partial,
    };
    set(state => ({
      config: {
        ...state.config,
        actionSequences: (state.config.actionSequences ?? []).map(s =>
          s.id !== sequenceId
            ? s
            : { ...s, actions: [...s.actions, newAction], updatedAt: new Date().toISOString() },
        ),
      },
    }));
    void get().saveConfig();
    return id;
  },

  updateAction: (sequenceId, actionId, patch) => {
    set(state => ({
      config: {
        ...state.config,
        actionSequences: (state.config.actionSequences ?? []).map(s =>
          s.id !== sequenceId
            ? s
            : {
                ...s,
                actions: s.actions.map(a => (a.id === actionId ? { ...a, ...patch } : a)),
                updatedAt: new Date().toISOString(),
              },
        ),
      },
    }));
    void get().saveConfig();
  },

  deleteAction: (sequenceId, actionId) => {
    set(state => ({
      config: {
        ...state.config,
        actionSequences: (state.config.actionSequences ?? []).map(s =>
          s.id !== sequenceId
            ? s
            : { ...s, actions: s.actions.filter(a => a.id !== actionId), updatedAt: new Date().toISOString() },
        ),
      },
    }));
    void get().saveConfig();
  },

  addTrackToPlaylist: (playlistId, trackId) => {
    set(state => ({
      config: {
        ...state.config,
        playlists: state.config.playlists.map(p =>
          p.id === playlistId && !p.trackIds.includes(trackId)
            ? { ...p, trackIds: [...p.trackIds, trackId], updatedAt: new Date().toISOString() }
            : p
        ),
      },
    }));
    void get().saveConfig();
  },

  removeTrackFromPlaylist: (playlistId, trackId) => {
    set(state => ({
      config: {
        ...state.config,
        playlists: state.config.playlists.map(p =>
          p.id === playlistId
            ? { ...p, trackIds: p.trackIds.filter(t => t !== trackId), updatedAt: new Date().toISOString() }
            : p
        ),
      },
    }));
    void get().saveConfig();
  },

  reorderPlaylistTracks: (playlistId, trackIds) => {
    set(state => ({
      config: {
        ...state.config,
        playlists: state.config.playlists.map(p =>
          p.id === playlistId ? { ...p, trackIds, updatedAt: new Date().toISOString() } : p
        ),
      },
    }));
    void get().saveConfig();
  },

  addTracks: (tracks) => {
    const idsByPath: Record<string, string> = {};
    set(state => {
      const byPath = new Map(state.config.tracks.map(t => [t.filePath, t.id]));
      const newOnes: Track[] = [];
      for (const t of tracks) {
        const existingId = byPath.get(t.filePath);
        if (existingId) {
          idsByPath[t.filePath] = existingId;
        } else {
          idsByPath[t.filePath] = t.id;
          byPath.set(t.filePath, t.id);
          newOnes.push(t);
        }
      }
      return {
        config: { ...state.config, tracks: [...state.config.tracks, ...newOnes] },
      };
    });
    void get().saveConfig();
    return idsByPath;
  },

  updateTrack: (id, patch) => {
    set(state => ({
      config: {
        ...state.config,
        tracks: state.config.tracks.map(t => t.id === id ? { ...t, ...patch } : t),
      },
    }));
    void get().saveConfig();
  },

  deleteTrack: (id) => {
    set(state => ({
      config: {
        ...state.config,
        tracks: state.config.tracks.filter(t => t.id !== id),
        playlists: state.config.playlists.map(p => ({
          ...p,
          trackIds: p.trackIds.filter(tid => tid !== id),
        })),
      },
    }));
    void get().saveConfig();
  },

  upsertService: (service) => {
    set(state => {
      const exists = state.config.services.some(s => s.id === service.id);
      const next = exists
        ? state.config.services.map(s => s.id === service.id ? service : s)
        : [...state.config.services, service];
      // After any change to a service, clean up pinned-last-song references
      // on same-day services whose effective key no longer matches the pin.
      // (User-stated requirement: a key change should clear the pin so we
      // never silently land on a wrong-key track.)
      const services = clearStalePinsForDate(next, state.config.tracks, service.date);
      // If the user just (re-)created a service for a date+time we previously
      // tombstoned, drop the tombstone — they clearly want this slot back.
      const slot = `${service.date}|${service.startTime}`;
      const skippedServiceDates = state.config.skippedServiceDates.filter(s => s !== slot);
      return { config: { ...state.config, services, skippedServiceDates } };
    });
    void get().saveConfig();
  },

  deleteService: (id) => {
    set(state => {
      const removed = state.config.services.find(s => s.id === id);
      const services = state.config.services.filter(s => s.id !== id);
      // Add a tombstone so the pattern generator doesn't immediately re-create
      // the service we just deleted. We tombstone any deletion (past or
      // future) — past entries get pruned on next app start, future entries
      // block recreation until the user manually re-adds the service.
      const skippedServiceDates = removed
        ? Array.from(new Set([...state.config.skippedServiceDates, `${removed.date}|${removed.startTime}`]))
        : state.config.skippedServiceDates;
      return {
        config: { ...state.config, services, skippedServiceDates },
        currentRunway: state.currentRunway?.serviceId === id ? null : state.currentRunway,
        selectedServiceId: state.selectedServiceId === id ? null : state.selectedServiceId,
      };
    });
    void get().saveConfig();
  },

  generateServicesFromPattern: (daysAhead, opts) => {
    const respectTombstones = opts?.respectTombstones ?? true;
    const state = get();
    const enabledPatterns = state.config.weeklyPattern.filter(p => p.enabled);
    if (enabledPatterns.length === 0) return 0;
    const defaults = state.config.defaults;
    const days = Math.max(1, Math.floor(daysAhead));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() + days);

    // Index existing services by date+startTime so we can skip duplicates.
    // When respectTombstones is true (default), deleted slots stay deleted;
    // when false, we ignore tombstones AND clear matching ones below so the
    // user's "Load…" button truly restores the slot.
    const existing = new Set(
      respectTombstones
        ? [
            ...state.config.services.map(s => `${s.date}|${s.startTime}`),
            ...state.config.skippedServiceDates,
          ]
        : state.config.services.map(s => `${s.date}|${s.startTime}`),
    );

    const additions: ServiceInstance[] = [];
    const cursor = new Date(today);
    while (cursor < cutoff) {
      const dow = cursor.getDay();
      const yyyy = cursor.getFullYear();
      const mm = String(cursor.getMonth() + 1).padStart(2, '0');
      const dd = String(cursor.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      for (const p of enabledPatterns) {
        if (p.dayOfWeek !== dow) continue;
        const key = `${dateStr}|${p.startTime}`;
        if (existing.has(key)) continue;
        existing.add(key);
        additions.push({
          id: generateId(),
          name: p.name,
          date: dateStr,
          startTime: p.startTime,
          preServicePlaylistId: p.preServicePlaylistId,
          postServicePlaylistId: p.postServicePlaylistId,
          firstSongKey: undefined,
          setlist: [],
          // Per-row override beats the global default.
          autoStartTargetSec: p.autoStartTargetSec ?? defaults.autoStartTargetSec,
          status: 'scheduled',
          proPresenterOverride: p.proPresenterOverride,
          disablePadBridge: p.disablePadBridge,
          // Carry pattern-level action-sequence overrides through to the
          // materialized service so the resolver picks them up. Only set
          // the field if the pattern explicitly defined one — leaving
          // undefined preserves the playlist's default sequence.
          preActionSequenceIdOverride: p.preActionSequenceIdOverride,
          postActionSequenceIdOverride: p.postActionSequenceIdOverride,
        });
      }
      cursor.setDate(cursor.getDate() + 1);
    }

    if (additions.length === 0) return 0;
    set(s => {
      const services = [...s.config.services, ...additions];
      // When the user explicitly requested generation (respectTombstones=false),
      // drop any tombstones for the slots we just filled so the timeline is
      // clean and a future Recurring tick won't re-create + skip-loop.
      const skippedServiceDates = respectTombstones
        ? s.config.skippedServiceDates
        : (() => {
            const filledKeys = new Set(additions.map(a => `${a.date}|${a.startTime}`));
            return s.config.skippedServiceDates.filter(t => !filledKeys.has(t));
          })();
      return { config: { ...s.config, services, skippedServiceDates } };
    });
    void get().saveConfig();
    return additions.length;
  },

  clearAllTombstones: () => {
    set(state => ({
      config: { ...state.config, skippedServiceDates: [] },
    }));
    void get().saveConfig();
  },

  setServiceStatus: (id, status) => {
    set(state => ({
      config: {
        ...state.config,
        services: state.config.services.map(s => s.id === id ? { ...s, status } : s),
      },
    }));
    void get().saveConfig();
  },

  armService: async (serviceId, preloader, opts) => {
    const state = get();
    const service = state.config.services.find(s => s.id === serviceId);
    if (!service) return { ok: false, reason: 'Service not found' };
    // playlistOverrideId lets the arm_playlist action swap which
    // playlist arms without mutating the service's saved
    // preServicePlaylistId.
    const playlistId = opts?.playlistOverrideId ?? service.preServicePlaylistId;
    const playlist = playlistId
      ? state.config.playlists.find(p => p.id === playlistId)
      : undefined;
    if (!playlist) return { ok: false, reason: 'No pre-service playlist on this service' };
    const pool = playlist.trackIds
      .map(tid => state.config.tracks.find(t => t.id === tid))
      .filter(Boolean) as Track[];
    if (pool.length === 0) return { ok: false, reason: 'Playlist has no tracks' };

    let trackIds: string[];
    let totalSec: number;
    let startOffsetSec = 0;
    // Tail = seconds the anchor track keeps playing past targetMs because
    // it has an editServiceLandSec marker before its trim end. Default 0.
    let tailSec = 0;
    // Per-arm override: set when the anchor's key doesn't match the
    // requested first-song key, so the controller skips the pad bridge.
    let skipPadBridgeAtArm = false;
    // Resolve effective key + pin via the inheritance chain (later services
    // on the same date inherit from the first service of that date).
    const { value: requestedKey } = resolveServiceFirstSongKey(service, state.config.services);
    const { value: pinnedTrackId } = resolveServiceLastSongTrackId(service, state.config.services);
    let landInKey: KeyName | undefined = requestedKey;
    let warning: string | undefined;

    // leadOverrideSec lets "Start music early" re-arm with a longer lead so
    // the playlist fills the new (now → service-start) window. Falls back
    // to the service's saved autoStartTargetSec when no override given.
    const targetSec = opts?.leadOverrideSec ?? service.autoStartTargetSec;

    if (playlist.autoArrangeToKey && targetSec > 0) {
      // Anchor selection chain:
      //   1. Pinned track (if it's in this playlist's pool)
      //   2. Exact key match
      //   3. Compatible (Camelot) key match — relative major/minor or fifth
      //   4. Random track from pool
      let anchor: Track | undefined;

      if (pinnedTrackId) {
        anchor = pool.find(t => t.id === pinnedTrackId);
        // If the pin references a track that isn't in this playlist's pool,
        // fall through to key-based selection. The pin survives, but for
        // this run it can't be honored.
      }

      if (!anchor && requestedKey) {
        const exact = pool.filter(t => t.key === requestedKey);
        if (exact.length > 0) anchor = exact[exact.length - 1];
      }

      if (!anchor && requestedKey) {
        for (const compat of compatibleKeys(requestedKey)) {
          const matches = pool.filter(t => t.key === compat);
          if (matches.length > 0) {
            anchor = matches[matches.length - 1];
            warning = `No track in ${requestedKey}. Landing on ${anchor.key} (compatible).`;
            break;
          }
        }
      }

      if (!anchor) {
        anchor = pool[Math.floor(Math.random() * pool.length)];
        if (requestedKey) {
          warning = `No track in ${requestedKey} or compatible keys. Landing on ${anchor.key ?? '?'} — tag tracks to fix.`;
        }
      }
      // The pad bridge follows the requested first-song key, not the
      // anchor's key. Without an explicit request we fall back to the
      // anchor's key so Quick Play / unkeyed services still work.
      landInKey = requestedKey ?? anchor.key;
      // Auto-skip the pad bridge when the anchor's key doesn't match the
      // requested key — covers both fallback (no exact track) and the
      // off-key-pin case. The service's saved disablePadBridge stays put;
      // this is a per-arm runtime override so the operator never gets a
      // pad-in-C-while-music-ends-in-F clash. The fallback warning above
      // already explains the situation; we extend it with a pad note.
      if (requestedKey && anchor.key !== requestedKey) {
        skipPadBridgeAtArm = true;
        warning = `${warning ?? ''}${warning ? ' ' : ''}Pad bridge skipped — no anchor in ${requestedKey}.`.trim();
      }

      // Build sequence: tracks before the anchor, looping if repeatToFill is on,
      // until total >= target. Anchor goes last. Per-arm override beats
      // the global default — used by the arm_playlist action's
      // "music to fill" toggle.
      const repeatToFill = opts?.repeatToFill ?? state.config.defaults.repeatToFill ?? true;
      const others = pool.filter(t => t.id !== anchor.id);
      const baseRotation: Track[] = others.length > 0 ? others : [anchor];
      // Shuffle the rotation either when the caller explicitly asked
      // (Shuffle button) or when the playlist itself is set to
      // playbackOrder='shuffle' — playlists pinned to shuffle should
      // get a fresh order on every arm so the same songs don't always
      // open Sunday morning.
      const shouldShuffle = opts?.shuffle || playlist.playbackOrder === 'shuffle';
      const rotation: Track[] = shouldShuffle
        ? shuffled(baseRotation)
        : baseRotation;
      const seq: Track[] = [];
      // The anchor's "landing duration" is how much of it plays BEFORE the
      // timer hits zero. Without a marker that's its full effectiveDuration;
      // with a marker, it's just up to the marker — the rest becomes a tail
      // that bleeds past service start.
      const anchorLanding = landingDuration(anchor);
      const anchorTail = effectiveDuration(anchor) - anchorLanding;
      // Auto-start target is a WALL-CLOCK lead window (e.g. "music fires
      // 30 minutes before service start"). With crossfade transitions the
      // audible content has to exceed the wall-clock window by
      // (numPushed * crossfadeSec) because each transition overlaps by
      // crossfadeSec — i.e. the playlist's audible total compresses by
      // that much when played back. Loop until the accumulated audible
      // content can fill the wall-clock window even after overlap savings.
      const xfade = playlist.transitionMode === 'crossfade' ? playlist.crossfadeSec : 0;
      let total = anchorLanding; // accumulating "audible up to landing"
      let numPushed = 0;
      let rotIdx = 0;
      let safety = 0;
      while (safety < 500) {
        const requiredAudible = targetSec + numPushed * xfade;
        if (total >= requiredAudible) break;
        if (!repeatToFill && rotIdx >= rotation.length) break;
        const t = rotation[rotIdx % rotation.length];
        seq.push(t);
        total += effectiveDuration(t);
        rotIdx++;
        numPushed++;
        safety++;
      }
      seq.push(anchor);

      trackIds = seq.map(t => t.id);
      // totalSec = full play duration (incl tail past service start). The
      // audio engine plays this much; only musicStartMs is shifted earlier
      // by audibleDurationSec so the marker lines up with targetMs.
      totalSec = total + anchorTail;
      tailSec = anchorTail;
      // Head-trim to exactly fit the wall-clock window. Overflow is computed
      // against (targetSec + savings) since the loop builds audible content
      // to that size, not raw targetSec.
      const audibleTarget = targetSec + numPushed * xfade;
      const overflowSec = Math.max(0, total - audibleTarget);
      const MAX_EXTRA_LEAD_SEC = 600;
      if (playlist.playFirstSongFromStart && overflowSec <= MAX_EXTRA_LEAD_SEC) {
        startOffsetSec = 0;
      } else {
        if (playlist.playFirstSongFromStart && overflowSec > MAX_EXTRA_LEAD_SEC) {
          warning = warning ?? `Playlist is ${Math.round(overflowSec / 60)} min longer than the lead window — head-trimming first song to keep music from firing too early. Shorten the playlist or extend the lead time.`;
        }
        startOffsetSec = overflowSec;
      }
      // `total` no longer represents play length; switch to using totalSec
      // (full play) for any subsequent calc that wants the engine duration.
      // Below, audibleDurationSec uses (totalSec - startOffsetSec - tailSec)
      // which equals (total - startOffsetSec) — i.e. audible up to landing.
    } else {
      // No-arrange path (typical for post / special playlists). When
      // repeatToFill is on AND the pool is shorter than targetSec, loop
      // through the pool to cover the window — matches the autoArrange
      // path's fill behavior. Without this, the arm_playlist action
      // with "Music to fill" couldn't actually fill anything when the
      // chosen playlist was shorter than the lead window.
      // Audible content target accounts for crossfade overlap savings so
      // the wall-clock window equals the user's targetSec.
      const xfade = playlist.transitionMode === 'crossfade' ? playlist.crossfadeSec : 0;
      const fillWithRepeats = (opts?.repeatToFill ?? state.config.defaults.repeatToFill ?? false)
        && targetSec > 0;
      if (fillWithRepeats && pool.length > 0) {
        const builtIds: string[] = [];
        let acc = 0;
        let pushed = 0;
        let i = 0;
        let safety = 0;
        const maxIterations = 1000;
        while (safety < maxIterations) {
          const requiredAudible = targetSec + Math.max(0, pushed - 1) * xfade;
          if (acc >= requiredAudible) break;
          const t = pool[i % pool.length];
          const dur = effectiveDuration(t);
          if (dur <= 0) {
            i += 1;
            safety += 1;
            if (i >= pool.length && acc === 0) break;
            continue;
          }
          builtIds.push(t.id);
          acc += dur;
          pushed += 1;
          i += 1;
          safety += 1;
        }
        trackIds = builtIds.length > 0 ? builtIds : pool.map(t => t.id);
      } else {
        trackIds = pool.map(t => t.id);
      }
      totalSec = trackIds.reduce(
        (a, id) => a + effectiveDuration(state.config.tracks.find(t => t.id === id)!),
        0,
      );
      // Head-trim so the wall-clock playback equals targetSec. With crossfade
      // savings the audible total can exceed targetSec by (N-1)*crossfade
      // and still fit the window, so subtract savings when computing overflow.
      const savingsForOverflow = Math.max(0, trackIds.length - 1) * xfade;
      const overflowSec = Math.max(0, totalSec - targetSec - savingsForOverflow);
      const MAX_EXTRA_LEAD_SEC = 600;
      if (targetSec > 0 && overflowSec > 0) {
        if (playlist.playFirstSongFromStart && overflowSec <= MAX_EXTRA_LEAD_SEC) {
          startOffsetSec = 0;
        } else {
          if (playlist.playFirstSongFromStart && overflowSec > MAX_EXTRA_LEAD_SEC) {
            warning = warning ?? `Playlist is ${Math.round(overflowSec / 60)} min longer than the lead window — head-trimming first song to keep music from firing too early. Shorten the playlist or extend the lead time.`;
          }
          startOffsetSec = overflowSec;
        }
      }
    }

    const padBridgeSec = playlist.padBridgeSec;
    const padFadeOutSec = playlist.padFadeOutSec;
    const musicFadeSec = state.config.defaults.musicFadeToPadSec ?? 5;
    const padLeadSec = state.config.defaults.padLeadInSec ?? 5;

    const date = new Date(service.date + 'T00:00:00');
    const [h, m] = service.startTime.split(':').map(Number);
    date.setHours(h, m, 0, 0);
    const targetMs = date.getTime();
    // Crossfade overlap savings accumulate across the playlist. With N
    // tracks and C-second crossfade, total wall-clock playback is
    // sum(effDur) - (N-1)*C, not sum(effDur). Subtracting that here keeps
    // musicStartMs in sync with the real wall-clock so the anchor's
    // landing point lines up with service start across long playlists.
    // Paired with awaited preload below (guarantees buffer cache is warm
    // before music starts, so transitions don't lose overlap to decode).
    const crossfadeSavingsSec = playlist.transitionMode === 'crossfade' && trackIds.length > 1
      ? Math.max(0, (trackIds.length - 1) * playlist.crossfadeSec)
      : 0;
    const audibleDurationSec = totalSec - startOffsetSec - tailSec - crossfadeSavingsSec;
    const musicStartMs = targetMs - audibleDurationSec * 1000;
    const padStartMs = targetMs - (padLeadSec + musicFadeSec) * 1000;

    // Reject only if the service start has already passed. If music-fire time
    // has passed but service hasn't, we still allow arming — the controller
    // will jump into the runway at the right offset so it lands on time.
    if (Date.now() >= targetMs) {
      return {
        ok: false,
        reason: `Service start time has already passed. Pick a later service or use Quick Test.`,
      };
    }

    set(s => ({
      currentRunway: {
        serviceId,
        trackIds,
        totalSec,
        landInKey,
        plannedStartTime: new Date(musicStartMs).toISOString(),
        startOffsetSec,
        targetMs,
        musicStartMs,
        padStartMs,
        transitionMode: playlist.transitionMode,
        crossfadeSec: playlist.crossfadeSec,
        padBridgeSec,
        padFadeOutSec,
        tailSec,
        skipPadBridge: skipPadBridgeAtArm || undefined,
        phase: 'queued',
        currentTrackIndex: 0,
        sourcePlaylistId: playlist.id,
        armEpoch: nextArmEpoch(),
      },
      config: {
        ...s.config,
        services: s.config.services.map(svc =>
          svc.id === serviceId
            ? { ...svc, status: 'queued', calculatedStartTime: new Date(musicStartMs).toISOString() }
            : svc
        ),
      },
    }));
    void get().saveConfig();

    // Await preload of every track buffer before returning. The
    // crossfade-savings subtraction above only matches reality if the
    // overlap actually happens at every transition. Overlap is eaten
    // by decode latency when the buffer cache is cold, so we wait here
    // until every track is decoded. Arms take a few extra seconds on
    // the first run after launch, then are instant on subsequent arms.
    if (preloader) {
      const tracks = state.config.tracks;
      const paths = trackIds
        .map(id => tracks.find(t => t.id === id)?.filePath)
        .filter(Boolean) as string[];
      await Promise.all(paths.map(p => preloader(p).catch(err => {
        console.warn('[arm] preload failed', p, err);
      })));
    }

    return { ok: true, warning };
  },

  disarmService: (serviceId) => {
    set(state => ({
      currentRunway: state.currentRunway?.serviceId === serviceId ? null : state.currentRunway,
      config: {
        ...state.config,
        services: state.config.services.map(s => {
          if (s.id !== serviceId) return s;
          // Queued → revert to scheduled so it can re-arm normally.
          // Live → mark completed so the schedule moves on. Without
          // this, panic mid-service left the service "live" forever
          // and activeService never rolled to the next one — auto-arm
          // for the next service couldn't fire.
          if (s.status === 'queued') {
            return { ...s, status: 'scheduled', calculatedStartTime: undefined };
          }
          if (s.status === 'live') {
            return { ...s, status: 'completed' };
          }
          return s;
        }),
      },
    }));
    void get().saveConfig();
  },

  extendServiceStart: (serviceId, addSec) => {
    if (addSec === 0) return;
    set(state => {
      const services = state.config.services.map(s => {
        if (s.id !== serviceId) return s;
        const [hStr, mStr] = s.startTime.split(':');
        const baseMin = (Number(hStr) || 0) * 60 + (Number(mStr) || 0);
        // Modulo 24h handles late-night services rolling past midnight.
        // Negative deltas wrap correctly via the +24h offset.
        const totalMin = ((baseMin + Math.round(addSec / 60)) % (24 * 60) + 24 * 60) % (24 * 60);
        const newH = Math.floor(totalMin / 60);
        const newM = totalMin % 60;
        return { ...s, startTime: `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}` };
      });
      const r = state.currentRunway;
      const shiftedRunway = r && r.serviceId === serviceId
        ? { ...r, targetMs: r.targetMs + addSec * 1000, padStartMs: r.padStartMs + addSec * 1000 }
        : r;
      return {
        config: { ...state.config, services },
        currentRunway: shiftedRunway,
      };
    });
    void get().saveConfig();
  },

  createRehearsalService: (opts) => {
    const id = generateId();
    const target = new Date(Date.now() + opts.secondsFromNow * 1000);
    const date = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const startTime = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
    const newSvc: ServiceInstance = {
      id,
      date,
      startTime,
      preServicePlaylistId: opts.preServicePlaylistId,
      postServicePlaylistId: opts.postServicePlaylistId,
      firstSongKey: opts.firstSongKey,
      setlist: [],
      autoStartTargetSec: opts.autoStartTargetSec,
      status: 'scheduled',
      isRehearsal: true,
    };
    set(state => ({
      config: { ...state.config, services: [...state.config.services, newSvc] },
    }));
    void get().saveConfig();
    return id;
  },
}));

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Audible duration up to the track's "service-landing" point. When a track
 * has `editServiceLandSec` set, the runway treats the song as ending at
 * that position for timing purposes (timer hits zero on the marker), but
 * the audio engine still plays through to trimEnd. Without the marker,
 * landing duration equals effectiveDuration.
 *
 * Defensive: clamps marker to [trimStart, trimEnd] so a stale value can
 * never produce a negative or oversized landing.
 */
function landingDuration(t: Track): number {
  const start = t.trimStartSec ?? 0;
  const end = t.trimEndSec ?? t.durationSec;
  if (t.editServiceLandSec === undefined) return Math.max(0, end - start);
  const marker = Math.max(start, Math.min(end, t.editServiceLandSec));
  return Math.max(0, marker - start);
}

/** Fisher-Yates shuffle, returns a new array (does not mutate input). */
function shuffled<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * For every service on `date`, drop its OWN pinned last-song track id when
 * the pin no longer matches its resolved firstSongKey (own or inherited).
 * Inherited pins are not touched here — they auto-track the source service.
 */
function clearStalePinsForDate(
  services: ServiceInstance[],
  tracks: Track[],
  date: string,
): ServiceInstance[] {
  return services.map(svc => {
    if (svc.date !== date) return svc;
    if (svc.lastSongTrackId === undefined) return svc;
    const { value: effectiveKey } = resolveServiceFirstSongKey(svc, services);
    if (effectiveKey === undefined) {
      return { ...svc, lastSongTrackId: undefined };
    }
    const pinned = tracks.find(t => t.id === svc.lastSongTrackId);
    if (!pinned || pinned.key !== effectiveKey) {
      return { ...svc, lastSongTrackId: undefined };
    }
    return svc;
  });
}
