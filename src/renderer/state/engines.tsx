import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../lib/audioEngine';
import { MidiEngine } from '../lib/midiEngine';
import { ServiceController } from '../lib/serviceController';
import { PpClient } from '../lib/proPresenterClient';
import { useAppStore } from '../state/store';
import { todayISO } from '../lib/format';
import type { MidiAction } from '@shared/types';

interface EnginesContextValue {
  audio: AudioEngine;
  midi: MidiEngine;
  controller: ServiceController;
  pp: PpClient;
}

const EnginesContext = createContext<EnginesContextValue | null>(null);

export function EnginesProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<AudioEngine | null>(null);
  const midiRef = useRef<MidiEngine | null>(null);
  const controllerRef = useRef<ServiceController | null>(null);
  const ppRef = useRef<PpClient | null>(null);
  const [ready, setReady] = useState(false);

  if (!audioRef.current) audioRef.current = new AudioEngine();
  if (!midiRef.current) midiRef.current = new MidiEngine();
  if (!controllerRef.current) controllerRef.current = new ServiceController(audioRef.current, useAppStore);
  if (!ppRef.current) ppRef.current = new PpClient(useAppStore.getState().config.proPresenterSync);
  // Hand the controller refs to the MIDI + PP engines so Action Sequence
  // dispatch can route through them.
  controllerRef.current.setEngines({ midi: midiRef.current, pp: ppRef.current });

  useEffect(() => {
    const audio = audioRef.current!;
    const midi = midiRef.current!;
    const controller = controllerRef.current!;
    const pp = ppRef.current!;
    controller.start();

    let lastAutoArmedKey: string | null = null;
    const unsubAudio = audio.subscribe(state => {
      const store = useAppStore.getState();
      if (state.busName === 'music') {
        store.setMusicPlayback({
          isPlaying: state.isPlaying,
          trackId: state.currentTrackId,
          filePath: state.currentFilePath,
          positionSec: state.currentPositionSec,
          durationSec: state.currentDurationSec,
        });
        // Pad auto-tracks the currently-playing song's key. When the
        // music engine reports a new trackId, we look up its key and
        // arm the matching pad so an operator hitting Pad Play (live
        // or from the remote) gets a key-matched pad without having
        // to step through the picker. We only re-arm when the key
        // actually changed — otherwise dragging the position scrubber
        // would clobber an explicit operator pick. If the song has no
        // key tagged, leave the prior armed key alone.
        if (state.isPlaying && state.currentTrackId) {
          const t = store.config.tracks.find(tr => tr.id === state.currentTrackId);
          const key = t?.key ?? null;
          if (key && key !== lastAutoArmedKey) {
            lastAutoArmedKey = key;
            store.setPadArmedKey(key);
          }
        } else if (!state.isPlaying) {
          // Music stopped — let the next track's key take over again.
          lastAutoArmedKey = null;
        }
      } else {
        store.setPadPlayback({
          isPlaying: state.isPlaying,
          trackId: state.currentTrackId,
          filePath: state.currentFilePath,
          positionSec: state.currentPositionSec,
          durationSec: state.currentDurationSec,
        });
      }
    });

    const unsubLog = midi.subscribeLog(entry => {
      useAppStore.getState().appendMidiLog(entry);
    });

    const unsubAct = midi.subscribeActions(action => {
      handleMidiAction(action, audio, controller);
    });

    // ---- Remote-control commands ----
    // Each command dispatches into the same controller actions used by
    // the desktop UI buttons, so the runway behaves identically whether
    // the trigger came from the local UI, MIDI, or a phone on the LAN.
    const unsubRemote = window.runway?.remote?.onCommand?.((cmd) => {
      switch (cmd.type) {
        case 'arm_toggle':
          void controller.armToggle({
            onArmError: (msg) => console.warn('[remote] arm:', msg),
            // Remote needs the second-click warning even when the runway
            // is just queued — phones are easy to fat-finger.
            alwaysConfirmDisarm: true,
          });
          break;
        case 'panic':
          controller.panic();
          break;
        case 'fade_to_pad':
          void controller.fadeToPad();
          break;
        case 'start_music_early':
          void controller.startMusicEarly();
          break;
        case 'start_post_service':
          void controller.triggerPostService().then(res => {
            if (!res.ok) console.warn('[remote] start_post_service refused:', res.reason);
          });
          break;
        case 'pad_play':
          void controller.triggerPadPlay();
          break;
        case 'pad_stop':
          controller.triggerPadStop();
          break;
        case 'shuffle':
          // Picks pre-service re-arrange or post-service tail-shuffle
          // based on what's currently running, so the remote button
          // does the right thing in either mode.
          void controller.smartShuffle();
          break;
        case 'set_master_volume': {
          // Remote slider — payload.pct is 0..100. Smooth the change
          // through the existing audio engine so the desktop master
          // fader UI also moves.
          const pct = Math.max(0, Math.min(100, Number(cmd.pct ?? 100)));
          audio.setMasterLevel(pct / 100);
          break;
        }
        case 'set_master_mute': {
          audio.setMasterMuted(!!cmd.muted);
          break;
        }
        case 'prev_track':
          controller.prevTrack();
          break;
        case 'next_track':
          controller.skipToNextTrack();
          break;
        case 'set_pad_key': {
          // Arm the pad's currently-selected key. Doesn't fire pad —
          // operator hits Pad Play afterward (or it fires automatically
          // at the song-end pad bridge).
          const key = (cmd as { key?: unknown }).key;
          if (typeof key === 'string' && key) {
            useAppStore.getState().setPadArmedKey(key as never);
          }
          break;
        }
        case 'extend_back':
        case 'extend_forward': {
          // Mirror the desktop +2 / −2 behavior: bump the active
          // service's start time and the armed runway's target by ±2
          // minutes. The store action also updates padStartMs so PP
          // timer + pad bridge follow along automatically.
          const sec = cmd.type === 'extend_back' ? 120 : -120;
          const state = useAppStore.getState();
          // Pick the same "active service" the LiveView would.
          // Use local date — service.date is stored as YYYY-MM-DD in
          // the operator's local timezone, so a UTC-derived key would
          // mismatch after UTC midnight crosses local end-of-day.
          const today = todayISO();
          const candidates = state.config.services
            .filter(s => s.date === today)
            .sort((a, b) => a.startTime.localeCompare(b.startTime));
          const now = Date.now();
          const active = candidates.find(s => {
            const date = new Date(s.date + 'T00:00:00');
            const [h, m] = s.startTime.split(':').map(Number);
            date.setHours(h, m, 0, 0);
            const tMs = date.getTime();
            if (tMs > now) return true;
            if (s.status === 'completed') return false;
            if (s.status === 'live' || s.status === 'queued') return true;
            return tMs > now - 5 * 60 * 1000;
          });
          if (active) state.extendServiceStart(active.id, sec);
          break;
        }
        case 'clear_midi_log':
          useAppStore.getState().clearMidiLog();
          break;
        default:
          console.warn('[remote] unknown command', cmd.type);
      }
    }) ?? (() => undefined);

    midi.init().then(ok => {
      useAppStore.getState().setMidiConnected(ok);
      // Sync bindings + per-device prefs now that MIDI is up. Both keep in
      // sync via the store subscriber below.
      midi.setBindings(useAppStore.getState().config.midiBindings);
      midi.setDevicePrefs(useAppStore.getState().config.midiDevices ?? []);
    });

    // ---- ProPresenter timer sync ----
    // Watch the runway: push a fresh countdown to PP when a real service arms,
    // when the target time changes (e.g. user edits the schedule), or when PP
    // config changes (port/timer). Stop the PP timer on disarm/panic/complete.
    // The signature lets us detect "same service but different target" so
    // schedule-time edits propagate.
    let lastSig = '';
    let lastBindingsRef = useAppStore.getState().config.midiBindings;
    let lastDevicePrefsRef = useAppStore.getState().config.midiDevices;
    let lastPpEnabled = useAppStore.getState().config.proPresenterSync.enabled;
    let lastRoutingSig = '';
    let lastPadLevelSig = '';

    // Keep the audio engine's pad level in sync with config (volume × dB trim).
    const syncPadLevel = () => {
      const d = useAppStore.getState().config.defaults;
      const sig = `${d.padPlayerLevel ?? 0.6}|${d.padPlayerGainDb ?? 0}`;
      if (sig === lastPadLevelSig) return;
      lastPadLevelSig = sig;
      const vol = Math.max(0, Math.min(1, d.padPlayerLevel ?? 0.6));
      const gainDb = Math.max(-24, Math.min(12, d.padPlayerGainDb ?? 0));
      const effective = vol * Math.pow(10, gainDb / 20);
      audio.setPadLevel(effective);
    };
    syncPadLevel();

    // Apply current audioRouting → audio engine output device per bus, then
    // re-apply on every change. setOutputDevice early-returns when device is
    // unchanged, so this is cheap to call frequently.
    const syncAudioRouting = () => {
      const routes = useAppStore.getState().config.audioRouting;
      const sig = routes.map(r => `${r.bus}:${r.deviceId ?? ''}`).join('|');
      if (sig === lastRoutingSig) return;
      lastRoutingSig = sig;
      for (const r of routes) {
        if (r.bus === 'music' || r.bus === 'pad' || r.bus === 'cue') {
          void audio.setOutputDevice(r.bus, r.deviceId);
        }
      }
    };
    syncAudioRouting();
    // One-shot keys, scoped to a single arm cycle so the hook fires at most
    // once per arm. Cleared when the runway clears or the arm key changes.
    let lastMusicStartKey: string | null = null;
    let lastServiceStartKey: string | null = null;
    // One-shot guard for post-service start. We track whether the previous
    // store tick saw an isPostService runway; firing happens on the rising
    // edge (false → true).
    let lastPostServiceRunwayActive = false;

    // Defined here (before the subscriber) so the store listener can kick an
    // immediate ping when PP sync is enabled, instead of waiting up to 10s for
    // the next heartbeat tick.
    let lastConnectedAt = 0;
    const pingPp = async () => {
      const cfg = useAppStore.getState().config.proPresenterSync;
      if (!cfg.enabled) {
        useAppStore.getState().setPpStatus('disabled');
        return;
      }
      try {
        await pp.testConnection();
        const wasConnected = useAppStore.getState().ppStatus === 'ok';
        useAppStore.getState().setPpStatus('ok');
        // Pre-fetch timers + playlists on (re)connect so the Settings tab is
        // populated the instant it's opened — no manual Test press needed.
        // Throttle to once per minute on continuous-ok pings.
        if (!wasConnected || Date.now() - lastConnectedAt > 60_000) {
          lastConnectedAt = Date.now();
          try {
            const [timers, playlists] = await Promise.all([
              pp.listTimers(),
              pp.listPlaylists(),
            ]);
            useAppStore.getState().setPpTimers(timers);
            useAppStore.getState().setPpPlaylists(playlists);
          } catch (err) {
            console.warn('[pp] eager load failed', err);
          }
        }
      } catch {
        useAppStore.getState().setPpStatus('err');
      }
    };

    // Generic helper: runs whichever action a hook is configured to do.
    const runAction = (
      label: string,
      action: 'none' | 'clear_timer' | 'clear_all' | 'trigger_item',
      playlistUuid: string | null,
      itemIndex: number | null,
      timerUuid: string | null,
    ) => {
      if (action === 'clear_timer' && timerUuid) {
        console.log(`[pp] ${label}: clear timer`, { timerUuid });
        void pp.stopTimer(timerUuid).catch(err => console.warn(`[pp] ${label} stopTimer failed`, err));
        void pp.resetTimer(timerUuid).catch(err => console.warn(`[pp] ${label} resetTimer failed`, err));
      } else if (action === 'clear_all') {
        console.log(`[pp] ${label}: clear all layers`);
        void pp.clearAllLayers().catch(err => console.warn(`[pp] ${label} clearAllLayers failed`, err));
      } else if (action === 'trigger_item' && playlistUuid && itemIndex !== null) {
        console.log(`[pp] ${label}: trigger playlist item`, { playlistUuid, itemIndex });
        void pp.triggerPlaylistItem(playlistUuid, itemIndex).catch(err => {
          console.warn(`[pp] ${label} triggerPlaylistItem failed`, err);
        });
      }
    };

    const unsubStore = useAppStore.subscribe(() => {
      const state = useAppStore.getState();
      pp.updateConfig(state.config.proPresenterSync);

      if (state.config.midiBindings !== lastBindingsRef) {
        lastBindingsRef = state.config.midiBindings;
        midi.setBindings(lastBindingsRef);
      }

      if (state.config.midiDevices !== lastDevicePrefsRef) {
        lastDevicePrefsRef = state.config.midiDevices;
        midi.setDevicePrefs(lastDevicePrefsRef ?? []);
      }

      // Audio routing changes — push device assignments to the engine.
      syncAudioRouting();
      // Pad volume/gain — re-apply on every config change.
      syncPadLevel();

      // Auto-schedule: if the time, days-ahead, or mode changed, cancel
      // the pending one-shot timer and reschedule from scratch so the new
      // setting takes effect now (not at next launch).
      const nextSig = `${state.config.defaults.autoScheduleTime}|${state.config.defaults.autoScheduleDaysAhead}|${state.config.weeklyPatternMode}`;
      if (nextSig !== lastAutoScheduleSig) {
        scheduleNextMaterialize();
      }

      // PP sync just turned on — fire a ping now so the indicator resolves
      // immediately instead of sitting on "Checking…" until the next heartbeat.
      const ppEnabledNow = state.config.proPresenterSync.enabled;
      if (ppEnabledNow && !lastPpEnabled) {
        void pingPp();
      }
      lastPpEnabled = ppEnabledNow;

      const cfg = state.config.proPresenterSync;
      const runway = state.currentRunway;
      const armedServiceId = (runway && runway.serviceId && !runway.isPostService)
        ? runway.serviceId
        : null;

      // Resolve effective hook config: if the armed service has a per-service
      // override, use those fields; otherwise inherit the global PP config.
      const armedService = armedServiceId
        ? state.config.services.find(s => s.id === armedServiceId)
        : undefined;
      const ov = armedService?.proPresenterOverride;
      const effective = ov ? { ...cfg, ...ov } : cfg;

      // Sig only covers fields that should re-fire arm/disarm logic. The
      // music-start and service-start hooks are gated by their own one-shot
      // keys further down, so we don't need their config in the sig.
      const sig = armedServiceId
        ? `armed|${armedServiceId}|${runway?.targetMs ?? 0}|${cfg.enabled}|${effective.timerUuid ?? ''}`
        : `idle|${cfg.enabled}|${cfg.timerUuid ?? ''}`;
      const sigChanged = sig !== lastSig;
      const wasArmed = lastSig.startsWith('armed|');
      if (sigChanged) lastSig = sig;

      if (sigChanged) {
        if (armedServiceId && cfg.enabled && effective.timerUuid && runway) {
          // Don't arm the PP countdown here — that fires the moment a
          // service becomes armed (queued phase), so PP would start
          // showing the countdown well before pre-service music
          // actually plays. Arm is deferred to the music_start
          // one-shot below so the timer only appears when music is
          // audibly running.
        } else if (wasArmed && cfg.enabled) {
          // Was armed, now isn't — run any configured disarm action.
          // Use the effective hooks from the service that just disarmed.
          //
          // Each non-'none' disarm action handles its own timer
          // behaviour: 'clear_timer' stops + resets ONLY the timer,
          // 'clear_all' / 'trigger_item' also stop+reset the timer in
          // addition to their layer/playlist work (because clearing
          // layers without stopping the timer leaves a phantom
          // countdown ticking on stage). 'none' leaves the timer
          // running — useful when an outside system or the natural
          // service-start crossing is meant to take over.
          const disarmedHooks = effective; // close enough — runway has already cleared
          if (
            (disarmedHooks.disarmAction === 'clear_all' || disarmedHooks.disarmAction === 'trigger_item')
            && disarmedHooks.timerUuid
          ) {
            const uuid = disarmedHooks.timerUuid;
            console.log('[pp] disarming timer', uuid);
            void pp.stopTimer(uuid).catch(err => console.warn('[pp] stopTimer failed', err));
            void pp.resetTimer(uuid).catch(err => console.warn('[pp] resetTimer failed', err));
          }
          runAction(
            'disarm',
            disarmedHooks.disarmAction,
            disarmedHooks.disarmPlaylistUuid,
            disarmedHooks.disarmItemIndex,
            disarmedHooks.timerUuid,
          );
        }
      }

      // Post-service start — fires once when an isPostService runway begins.
      // No service id to scope per-service overrides; just uses global config.
      const postServiceActive = !!runway?.isPostService;
      if (postServiceActive && !lastPostServiceRunwayActive && cfg.enabled) {
        runAction(
          'post_service_start',
          cfg.postServiceStartAction,
          cfg.postServiceStartPlaylistUuid,
          cfg.postServiceStartItemIndex,
          cfg.timerUuid,
        );
      }
      lastPostServiceRunwayActive = postServiceActive;

      // One-shot hooks tied to runway phase / wall-clock progress. Both keyed
      // on serviceId+targetMs so a re-arm of the same service or a schedule
      // edit re-fires, but no internal tick within a single arm fires twice.
      const armKey = armedServiceId && runway
        ? `${armedServiceId}|${runway.targetMs}`
        : null;
      if (!armKey) {
        lastMusicStartKey = null;
        lastServiceStartKey = null;
      } else {
        // Music start: phase entered 'music'.
        if (runway?.phase === 'music' && lastMusicStartKey !== armKey) {
          lastMusicStartKey = armKey;
          // Arm the PP countdown to service start NOW that pre-service
          // music is actually playing — not back when the runway was
          // queued. PP starts displaying the countdown the moment we
          // PUT, so deferring until phase==='music' keeps the timer
          // off the on-stage screen during the auto-arm wait window.
          if (cfg.enabled && effective.timerUuid) {
            const uuid = effective.timerUuid;
            const target = runway.targetMs;
            console.log('[pp] arming on music_start', { uuid, target: new Date(target).toLocaleString(), override: !!ov });
            void pp.armCountdownToTime(uuid, target).catch(err => {
              console.warn('[pp] armCountdownToTime failed', err);
            });
          }
          runAction(
            'music_start',
            effective.musicStartAction,
            effective.musicStartPlaylistUuid,
            effective.musicStartItemIndex,
            effective.timerUuid,
          );
        }
        // Service start: wall clock crossed targetMs (PP timer hits 00:00).
        if (
          runway
          && Date.now() >= runway.targetMs
          && lastServiceStartKey !== armKey
        ) {
          lastServiceStartKey = armKey;
          runAction(
            'service_start',
            effective.serviceStartAction,
            effective.serviceStartPlaylistUuid,
            effective.serviceStartItemIndex,
            effective.timerUuid,
          );
        }
      }
    });

    // ---- PP connection heartbeat ----
    // Pings /version every 10s when sync is enabled so the TopBar indicator
    // reflects live state. The store subscriber above also kicks pingPp on
    // enable transitions so the user doesn't see "Checking…" hang.
    void pingPp(); // initial check
    const ppHeartbeat = window.setInterval(() => void pingPp(), 10000);

    // ---- Weekly pattern materialization ----
    // On app boot we always materialize today's services immediately so the
    // app is usable. After that, the next pass is scheduled as a one-shot
    // setTimeout to the exact configured time-of-day (`autoScheduleTime` in
    // Settings → Engine → Auto-schedule). When that fires, we re-run the
    // materializer with the configured `autoScheduleDaysAhead` window, then
    // schedule the NEXT one-shot to the same time on the following day.
    //
    // If the operator changes either setting (time or days-ahead), the store
    // subscription further down detects the signature change and reschedules
    // the next fire so the new value takes effect immediately.
    let scheduledMaterializeTimer: number | null = null;
    let lastAutoScheduleSig = '';
    const computeNextFireDelayMs = (): number => {
      const state = useAppStore.getState();
      const timeStr = state.config.defaults.autoScheduleTime ?? '00:00';
      const m = timeStr.match(/^(\d{1,2}):(\d{2})$/);
      const h = m ? Math.max(0, Math.min(23, Number(m[1]))) : 0;
      const min = m ? Math.max(0, Math.min(59, Number(m[2]))) : 0;
      const now = new Date();
      const target = new Date(now);
      target.setHours(h, min, 0, 0);
      // If today's target has already passed, schedule for the same time
      // tomorrow. Minimum 1s clamp so we don't accidentally re-fire in the
      // same tick.
      if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
      }
      return Math.max(1000, target.getTime() - now.getTime());
    };
    const runMaterializer = () => {
      const state = useAppStore.getState();
      if (state.config.weeklyPatternMode !== 'auto_rotate') return;
      const daysAhead = Math.max(1, Math.min(60, state.config.defaults.autoScheduleDaysAhead ?? 2));
      state.generateServicesFromPattern(daysAhead);
    };
    const scheduleNextMaterialize = () => {
      if (scheduledMaterializeTimer !== null) {
        window.clearTimeout(scheduledMaterializeTimer);
        scheduledMaterializeTimer = null;
      }
      const state = useAppStore.getState();
      if (state.config.weeklyPatternMode !== 'auto_rotate') return;
      const delayMs = computeNextFireDelayMs();
      const target = new Date(Date.now() + delayMs);
      console.log('[auto-schedule] next materialize at', target.toLocaleString(), `(in ${Math.round(delayMs / 60000)} min)`);
      scheduledMaterializeTimer = window.setTimeout(() => {
        scheduledMaterializeTimer = null;
        runMaterializer();
        scheduleNextMaterialize();
      }, delayMs) as unknown as number;
      // Track the signature so the store-subscription below knows when to
      // reschedule on a settings change.
      lastAutoScheduleSig = `${state.config.defaults.autoScheduleTime}|${state.config.defaults.autoScheduleDaysAhead}|${state.config.weeklyPatternMode}`;
    };
    // Boot: materialize today's services immediately so the app is usable,
    // then schedule the first one-shot for the configured time.
    runMaterializer();
    scheduleNextMaterialize();

    // ---- Remote-control snapshot push ----
    // Build a compact view of the runway + active service + now-playing
    // and ship it to main every 100ms. Main forwards to all WS clients.
    const remoteHeartbeat = window.setInterval(() => {
      if (!window.runway?.remote?.pushSnapshot) return;
      const state = useAppStore.getState();
      // Local-date key so today's services still match `service.date`
      // after UTC midnight has crossed local end-of-day. UTC-based key
      // caused the remote countdown to flip to 00:00:00 in the
      // evening (PT) because activeService dropped out of the snapshot.
      const todayKey = todayISO();
      const today = state.config.services
        .filter(s => s.date === todayKey)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      const now = Date.now();
      const activeSvc = today.find(s => {
        const date = new Date(s.date + 'T00:00:00');
        const [h, m] = s.startTime.split(':').map(Number);
        date.setHours(h, m, 0, 0);
        const tMs = date.getTime();
        if (tMs > now) return true;
        if (s.status === 'completed') return false;
        if (s.status === 'live' || s.status === 'queued') return true;
        return tMs > now - 5 * 60 * 1000;
      });
      const activeService = activeSvc ? (() => {
        const date = new Date(activeSvc.date + 'T00:00:00');
        const [h, m] = activeSvc.startTime.split(':').map(Number);
        date.setHours(h, m, 0, 0);
        return {
          id: activeSvc.id,
          name: activeSvc.name,
          date: activeSvc.date,
          startTime: activeSvc.startTime,
          status: activeSvc.status,
          targetMs: date.getTime(),
        };
      })() : null;

      const r = state.currentRunway;
      const runway = r ? {
        serviceId: r.serviceId,
        phase: r.phase,
        isPostService: r.isPostService,
        targetMs: r.targetMs,
        musicStartMs: r.musicStartMs,
        padStartMs: r.padStartMs,
        padBridgeSec: r.padBridgeSec,
        padFadeOutSec: r.padFadeOutSec,
        skipPadBridge: r.skipPadBridge,
        // Pre-computed convenience: when the pad fully clears (= service
        // start + hold + fade). 0 when there's no pad bridge or it was
        // skipped this arm.
        padOffMs: !r.skipPadBridge && !r.isPostService && (r.padBridgeSec + r.padFadeOutSec) > 0
          ? r.targetMs + (r.padBridgeSec + r.padFadeOutSec) * 1000
          : 0,
        // For post-service runways: end time = current song remaining +
        // every UNPLAYED following track in the playlist. Mirrors the
        // calc LiveView uses so the mobile remote agrees with the
        // desktop hero.
        postEndMs: r.isPostService
          ? Date.now() + (() => {
              let remainingSec = Math.max(0, state.musicPlayback.durationSec - state.musicPlayback.positionSec);
              for (let i = r.currentTrackIndex + 1; i < r.trackIds.length; i++) {
                const t = state.config.tracks.find(tr => tr.id === r.trackIds[i]);
                remainingSec += t?.durationSec ?? 0;
              }
              return remainingSec * 1000;
            })()
          : 0,
      } : null;

      const np = state.musicPlayback;
      const npTrack = np.trackId
        ? state.config.tracks.find(t => t.id === np.trackId)
        : undefined;
      const nowPlaying = np.isPlaying ? {
        title: npTrack?.title,
        artist: npTrack?.artist,
        positionSec: np.positionSec,
        durationSec: np.durationSec,
        albumArtUrl: npTrack?.albumArtUrl,
      } : null;

      // Next track in the runway after the current one. Falls through
      // gracefully when there is no runway, no next index, or the next
      // id no longer resolves to a track in the library.
      let nextTrack: { title?: string; artist?: string } | null = null;
      if (r && r.phase === 'music') {
        const nextId = r.trackIds[r.currentTrackIndex + 1];
        if (nextId) {
          const t = state.config.tracks.find(tr => tr.id === nextId);
          if (t) nextTrack = { title: t.title, artist: t.artist };
        }
      }

      const armed = !!(activeService && r && r.serviceId === activeService.id);

      const midiStatus: 'on' | 'off' | 'absent' = !state.midiConnected
        ? 'absent'
        : state.midiEnabled
          ? 'on'
          : 'off';
      // Audio = green when master is unmuted, red when the operator
      // has muted it (panic / mute button on the desktop top bar). Same
      // semantic as the MIDI / Pro7 lights — green is the healthy state.
      const audioStatus: 'on' | 'off' = audio.getMasterMuted() ? 'off' : 'on';

      // Recent MIDI log — last 50 entries, compact field names so the
      // payload stays small at 100ms tick rate.
      const recentMidi = state.midiLog.slice(-50).map(e => ({
        ts: e.timestamp,
        dir: e.direction,
        ch: e.channel,
        type: e.type,
        d1: e.data1,
        d2: e.data2,
        device: e.deviceName,
        action: e.matchedAction,
      }));

      void window.runway.remote.pushSnapshot({
        activeService,
        runway,
        nowPlaying,
        nextTrack,
        armed,
        armConfirmDisarm: !!state.armConfirmDisarm,
        padPlaying: !!state.padPlayback?.isPlaying,
        masterPct: Math.round(audio.getMasterLevel() * 100),
        masterMuted: audio.getMasterMuted(),
        padArmedKey: state.padArmedKey ?? null,
        padKeysAvailable: (state.config.pads ?? []).map(p => p.key as string).filter(k => !!k),
        fadeToPadActive: !!state.fadeToPadActive,
        status: {
          midi: midiStatus,
          pp: state.ppStatus,
          audio: audioStatus,
        },
        recentMidi,
        serverTimeMs: Date.now(),
      });
    }, 100);

    // ---- Tray menu snapshot push ----
    // Sends a compact, pre-formatted snapshot to main every second.
    // Main rebuilds the tray context menu from it so when the operator
    // opens the menu it reflects the current armed service, countdown,
    // upcoming services, and now-playing. 1s cadence is plenty for a
    // menu the operator opens occasionally; lighter than the remote's
    // 100ms loop.
    // Match the big Live-view countdown clock's format — always
    // `HH:MM:SS`, two-digit hours included even at zero. The tray
    // ticker (next to the menu bar icon) drops to MM:SS when hours
    // are zero to save horizontal space.
    const formatHhMmSs = (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    };
    const formatTicker = (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };
    const formatHHMM = (date: string, hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      const hr12 = ((h + 11) % 12) + 1;
      const am = h < 12 ? 'AM' : 'PM';
      return `${hr12}:${String(m).padStart(2, '0')} ${am}`;
    };
    const trayHeartbeat = window.setInterval(() => {
      if (!window.runway?.tray?.update) return;
      const state = useAppStore.getState();
      const now = Date.now();
      // Local-date key (same reason as remoteHeartbeat above).
      const todayKey = todayISO();
      const today = state.config.services
        .filter(s => s.date === todayKey)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
      const targetMs = (s: typeof today[number]) => {
        const d = new Date(s.date + 'T00:00:00');
        const [h, m] = s.startTime.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        return d.getTime();
      };
      const r = state.currentRunway;
      const armedSvc = r?.serviceId
        ? today.find(s => s.id === r.serviceId)
        : undefined;

      // Status header — what's currently happening.
      let statusLine = 'Idle · no service armed';
      if (armedSvc) {
        const label = armedSvc.name || formatHHMM(armedSvc.date, armedSvc.startTime);
        statusLine = `ARMED · ${label}`;
      } else if (r?.isPostService) {
        statusLine = 'Post-service playing';
      }

      // Countdown line + ticker (shown next to icon in menu bar).
      let countdownLabel: string | null = null;
      let tickerLabel: string | null = null;
      if (r) {
        if (r.phase === 'queued' && r.musicStartMs > now) {
          countdownLabel = `Music fires in  ${formatHhMmSs(r.musicStartMs - now)}`;
          tickerLabel = formatTicker(r.musicStartMs - now);
        } else if (r.phase === 'music' && !r.isPostService && r.targetMs > now) {
          countdownLabel = `Service starts in  ${formatHhMmSs(r.targetMs - now)}`;
          tickerLabel = formatTicker(r.targetMs - now);
        } else if (r.phase === 'pad' && r.targetMs > now) {
          countdownLabel = `Pad holding · service in  ${formatHhMmSs(r.targetMs - now)}`;
          tickerLabel = formatTicker(r.targetMs - now);
        } else if (r.isPostService && state.musicPlayback.isPlaying) {
          const remaining = Math.max(0, state.musicPlayback.durationSec - state.musicPlayback.positionSec);
          countdownLabel = `Post-service track · ${formatHhMmSs(remaining * 1000)} left`;
        }
      } else if (today.length > 0) {
        const next = today.find(s => targetMs(s) > now);
        if (next) {
          const label = next.name || formatHHMM(next.date, next.startTime);
          countdownLabel = `Next: ${label} in  ${formatHhMmSs(targetMs(next) - now)}`;
          tickerLabel = formatTicker(targetMs(next) - now);
        }
      }

      // Now-playing.
      let nowPlayingLabel: string | null = null;
      const np = state.musicPlayback;
      if (np.isPlaying && np.trackId) {
        const t = state.config.tracks.find(tr => tr.id === np.trackId);
        if (t) {
          nowPlayingLabel = t.artist ? `${t.title} · ${t.artist}` : t.title;
        }
      }

      // Upcoming services — show all today's, marking armed/done so the
      // operator can see the day's whole schedule from the menu bar.
      const upcomingLabels: string[] = today.slice(0, 6).map(s => {
        const when = formatHHMM(s.date, s.startTime);
        const name = s.name || when;
        let tag = '';
        if (r?.serviceId === s.id) tag = ' · armed';
        else if (s.status === 'completed') tag = ' · done';
        else if (s.status === 'live') tag = ' · live';
        return s.name ? `${when} — ${name}${tag}` : `${when}${tag}`;
      });

      window.runway.tray.update({
        isArmed: !!armedSvc,
        statusLine,
        countdownLabel,
        upcomingLabels,
        nowPlayingLabel,
        tickerLabel,
      });
    }, 1000);

    setReady(true);

    return () => {
      unsubAudio();
      unsubLog();
      unsubAct();
      unsubStore();
      unsubRemote();
      window.clearInterval(ppHeartbeat);
      if (scheduledMaterializeTimer !== null) window.clearTimeout(scheduledMaterializeTimer);
      window.clearInterval(remoteHeartbeat);
      window.clearInterval(trayHeartbeat);
      controller.stop();
    };
  }, []);

  if (!ready) return null;

  return (
    <EnginesContext.Provider value={{
      audio: audioRef.current!,
      midi: midiRef.current!,
      controller: controllerRef.current!,
      pp: ppRef.current!,
    }}>
      {children}
    </EnginesContext.Provider>
  );
}

export function useEngines(): EnginesContextValue {
  const ctx = useContext(EnginesContext);
  if (!ctx) throw new Error('useEngines must be used within EnginesProvider');
  return ctx;
}

function handleMidiAction(action: MidiAction, _audio: AudioEngine, controller: ServiceController) {
  const store = useAppStore.getState();
  if (typeof action === 'string') {
    switch (action) {
      case 'panic_fade':
        controller.panic();
        break;
      case 'start_post_service':
        void controller.triggerPostService().then(res => {
          if (!res.ok) console.warn('[midi] start_post_service:', res.reason);
        });
        break;
      case 'pad_play':
        void controller.triggerPadPlay();
        break;
      case 'pad_stop':
        controller.triggerPadStop();
        break;
      case 'arm_toggle':
        void controller.armToggle({
          onArmError: (msg) => console.warn('[midi] arm_toggle:', msg),
        });
        break;
    }
  } else if (action.type === 'pad_set_key') {
    store.setPadArmedKey(action.key);
  }
}
