/**
 * ServiceController — drives armed services through their auto-start lifecycle.
 *
 * Runs a 1-second tick. For the currently-armed service (currentRunway.serviceId)
 * it advances through phases:
 *   queued → music → pad → done
 *
 * Phase transitions:
 *   queued → music   when now >= musicStartMs
 *   within music     each tick checks if it's time to crossfade to the next track
 *                    (currentPos >= currentDuration - crossfadeSec)
 *                    last track plays through and triggers pad
 *   music → pad      when last track ends OR now >= padStartMs (whichever first)
 *   pad → done       when now >= targetMs (service start)
 *
 * Rehearsal services are deleted in the 'done' transition.
 */

import type { AudioEngine } from './audioEngine';
import type { MidiEngine } from './midiEngine';
import type { PpClient } from './proPresenterClient';
import type { useAppStore } from '../state/store';
import { compatibleKeys } from '@shared/music';
import type { Action, ActionPayload, ActionSequence, KeyName, PadFile, Track } from '@shared/types';
import { effectiveDuration } from '@shared/types';
import { resolveActionFireMs } from './actionMeta';

type Store = typeof useAppStore;

/** Optional engine refs the controller uses to fire Action Sequences. */
export interface ControllerEngineRefs {
  midi?: MidiEngine;
  pp?: PpClient;
}

export class ServiceController {
  private intervalHandle: number | null = null;
  // Guards against double-fire when the tick runs faster than playback state propagates.
  private startingTrackIndex: number | null = null;
  private padStarting = false;
  // Per-arm Set of fired action ids. Cleared whenever the runway pointer
  // changes so re-arming runs the sequence fresh.
  private firedActionIds: Set<string> = new Set();
  // Playlists whose track pool we've already kicked a background decode
  // for this arm cycle (look-ahead pre-warm before a runway-mutating
  // action fires). Cleared alongside firedActionIds so each new arm
  // re-warms fresh. Decoding a playlist the operator never reaches is
  // cheap and harmless — buffers just sit in the cache.
  private prewarmedPlaylistIds: Set<string> = new Set();
  // How far ahead of a runway-mutating action's fire time to start
  // decoding its target pool. Cold decode of a multi-track pool runs
  // ~5-15s, so 30s gives real headroom; if the postservice track is
  // shorter than that the prewarm just starts as soon as the runway
  // arms. Pure cache-warming — no timing math depends on this value.
  private static readonly PREWARM_LEAD_MS = 30_000;
  private lastRunwaySig: string = '';
  // Wall-clock failsafes installed when a real pre-service runway arms.
  // Independent of audio-engine timing — pure setTimeout against the
  // runway's known targetMs / padStartMs. If music timing drifts for
  // any reason (preload delay, scheduling miss, math bug we haven't
  // found yet), the watchdog at targetMs force-fades music and starts
  // the pad so service still gets clean handoff. Cleared whenever the
  // runway is replaced or the controller stops.
  private padFailsafeTimer: number | null = null;
  private serviceStartFailsafeTimer: number | null = null;
  private installedFailsafeKey: string = '';
  // Filled by the EnginesProvider after construction.
  private engines: ControllerEngineRefs = {};

  constructor(private audio: AudioEngine, private store: Store) {}

  /** Wire MIDI + PP engines so Action Sequences can dispatch through them. */
  setEngines(refs: ControllerEngineRefs) {
    this.engines = refs;
  }

  start() {
    if (this.intervalHandle !== null) return;
    // 100ms tick — transitions and music-start fire within ~50ms of their
    // scheduled time on average. The previous 500ms cadence accumulated
    // visible drift over multi-track runways: each track transition could
    // fire up to 500ms late, so an 8-track service ended ~2s past targetMs.
    this.intervalHandle = window.setInterval(() => this.tick(), 100);
  }

  stop() {
    if (this.intervalHandle !== null) {
      window.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.clearFailsafes();
  }

  /**
   * Install wall-clock failsafe timers for a freshly-armed pre-service
   * runway. Two watchdogs, both independent of audio-engine state:
   *
   *   1. Pad-fire watchdog at `padStartMs + 1s` (1s grace so the normal
   *      pad-bridge transition can fire first under normal conditions).
   *      If the pad isn't audibly playing by then, force `beginPad()`.
   *
   *   2. Service-start watchdog at `targetMs`. If music is still
   *      audible, fade it out over `musicFadeToPadSec` (default 5s). If
   *      the pad isn't playing, force-start it. Mark service completed
   *      so the schedule UI rolls forward.
   *
   * The failsafe respects `disablePadBridge` / `skipPadBridge` — if the
   * service was configured for music-fade-to-silence without a pad, the
   * watchdog only fires the music fade, not the pad start.
   *
   * Idempotent: re-calling with the same runway (same armEpoch +
   * serviceId + targetMs) is a no-op. Calling with a different runway
   * clears the prior timers and installs fresh ones.
   */
  private installFailsafes(state: ReturnType<Store['getState']>): void {
    const runway = state.currentRunway;
    // Only real pre-service runways (with a serviceId) get failsafes.
    // Post-service, Quick Play, and quick-test runways don't have a
    // service-start moment in the same sense.
    const key = runway && !runway.isPostService && runway.serviceId
      ? `${runway.armEpoch ?? 0}|${runway.serviceId}|${runway.targetMs}`
      : '';
    if (key === this.installedFailsafeKey) return;
    this.clearFailsafes();
    this.installedFailsafeKey = key;
    if (!key || !runway) return;

    const now = Date.now();
    const targetMs = runway.targetMs;
    const padStartMs = runway.padStartMs;
    const musicFadeSec = state.config.defaults.musicFadeToPadSec ?? 5;
    const service = runway.serviceId
      ? state.config.services.find(s => s.id === runway.serviceId)
      : undefined;
    const padBridgeEnabled = !service?.disablePadBridge && !runway.skipPadBridge;
    const armedServiceId = runway.serviceId;

    console.log('[failsafe] installing watchdogs', {
      serviceId: armedServiceId,
      targetMs,
      padStartMs,
      msUntilPad: padStartMs - now,
      msUntilService: targetMs - now,
      padBridgeEnabled,
    });

    // Watchdog 1: pad start. Only install if pad bridge is enabled AND
    // padStartMs+grace is in the future.
    if (padBridgeEnabled && padStartMs + 1000 > now) {
      const delay = padStartMs + 1000 - now;
      this.padFailsafeTimer = window.setTimeout(() => {
        this.padFailsafeTimer = null;
        const cur = this.store.getState();
        const curRunway = cur.currentRunway;
        // Bail if the runway changed (action swap, panic, re-arm).
        if (!curRunway || curRunway.serviceId !== armedServiceId) return;
        // Bail if we're already past music phase — pad is either
        // playing or done.
        if (curRunway.phase !== 'music' && curRunway.phase !== 'queued') return;
        const padPlaying = !!cur.padPlayback?.isPlaying;
        if (padPlaying) return;
        console.warn('[failsafe] pad bridge did not fire at padStartMs+1s — forcing pad start');
        void this.beginPad();
      }, delay) as unknown as number;
    }

    // Watchdog 2: service start. Always install if targetMs is in the
    // future. Force-fades music (5s) and force-starts pad regardless of
    // audio-engine state. Idempotent at the audio layer — fadeOutMusic
    // is a no-op when nothing is playing; beginPad has padStarting
    // guard.
    if (targetMs > now) {
      const delay = targetMs - now;
      this.serviceStartFailsafeTimer = window.setTimeout(() => {
        this.serviceStartFailsafeTimer = null;
        const cur = this.store.getState();
        const curRunway = cur.currentRunway;
        if (!curRunway || curRunway.serviceId !== armedServiceId) return;
        const musicPlaying = !!cur.musicPlayback?.isPlaying;
        const padPlaying = !!cur.padPlayback?.isPlaying;
        console.warn('[failsafe] service-start watchdog fired', {
          serviceId: armedServiceId,
          phase: curRunway.phase,
          musicPlaying,
          padPlaying,
        });
        if (musicPlaying) {
          this.audio.fadeOutMusic(musicFadeSec);
        }
        const curService = cur.config.services.find(s => s.id === armedServiceId);
        const curPadBridgeEnabled = !curService?.disablePadBridge && !curRunway.skipPadBridge;
        if (!padPlaying && curPadBridgeEnabled) {
          void this.beginPad();
        }
        if (curService && curService.status !== 'completed') {
          this.store.getState().setServiceStatus(armedServiceId, 'completed');
        }
      }, delay) as unknown as number;
    }
  }

  private clearFailsafes(): void {
    if (this.padFailsafeTimer !== null) {
      window.clearTimeout(this.padFailsafeTimer);
      this.padFailsafeTimer = null;
    }
    if (this.serviceStartFailsafeTimer !== null) {
      window.clearTimeout(this.serviceStartFailsafeTimer);
      this.serviceStartFailsafeTimer = null;
    }
    this.installedFailsafeKey = '';
  }

  /**
   * Test affordance: jump current track playback to `crossfadeSec + offsetSec`
   * before its end so the next-track transition fires naturally on the next tick.
   * No-op outside the music phase.
   */
  jumpToTransition(offsetSec = 1) {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.phase !== 'music') return;
    const pos = this.audio.getMusicPosition();
    if (pos.durationSec === 0) return;
    const fadeWindow = runway.transitionMode === 'crossfade' ? runway.crossfadeSec : 0.2;
    const target = Math.max(0, pos.durationSec - fadeWindow - offsetSec);
    void this.audio.seekMusic(target);
    this.reanchorMusicStart(runway.currentTrackIndex, target);
  }

  /**
   * Test affordance: skip the current track and start the next one immediately.
   * If we're on the last track, jump straight into the pad bridge.
   */
  skipToNextTrack() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.phase !== 'music') return;
    const isLast = runway.currentTrackIndex >= runway.trackIds.length - 1;
    if (isLast) {
      void this.beginPad();
      return;
    }
    const nextIndex = runway.currentTrackIndex + 1;
    state.patchCurrentRunway({ currentTrackIndex: nextIndex });
    this.reanchorMusicStart(nextIndex, 0);
    void this.startTrack(nextIndex);
  }

  /**
   * Step back one track. If we're on the first track, restart it from
   * the top instead of trying to go negative — matches what most
   * "previous" buttons do in audio apps.
   */
  prevTrack() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.phase !== 'music') return;
    const prevIndex = Math.max(0, runway.currentTrackIndex - 1);
    state.patchCurrentRunway({ currentTrackIndex: prevIndex });
    this.reanchorMusicStart(prevIndex, 0);
    void this.startTrack(prevIndex);
  }

  /**
   * Rewrite musicStartMs so that "natural-playback wall-clock" agrees
   * with the current audio position after a skip/jump. Without this,
   * actions resolved via resolveActionFireMs (which adds cumulative
   * effective duration to musicStartMs) keep waiting for wall-clock to
   * catch up to the original-schedule fire time — long after the audio
   * has musically passed it. The action engine's existing 30s-stale
   * grace then silently drops actions further than 30s back, while
   * actions just-barely behind the new musical position fire on the
   * next tick.
   *
   * Skip-targets within the 30s grace window get their cues fired
   * (intended: "I jumped here, fire the cue here"). Skip-targets that
   * leapfrog a cue by more than 30s mark it fired without dispatching
   * (intended: "I jumped past this cue in test, don't replay it").
   */
  private reanchorMusicStart(targetTrackIndex: number, segmentOffsetSec: number): void {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway) return;
    let cumSec = 0;
    for (let i = 0; i < targetTrackIndex; i++) {
      const t = state.config.tracks.find(tr => tr.id === runway.trackIds[i]);
      if (t) cumSec += effectiveDuration(t);
    }
    cumSec += Math.max(0, segmentOffsetSec);
    // Mirror resolveActionFireMs's startOffset accounting: track 0
    // is unaffected, tracks at index >= 1 start startOffsetSec earlier
    // in wall-clock than a naive sum would suggest.
    const startOff = runway.startOffsetSec ?? 0;
    const adj = targetTrackIndex >= 1 ? startOff : 0;
    const newMusicStartMs = Date.now() - (cumSec - adj) * 1000;
    state.patchCurrentRunway({ musicStartMs: newMusicStartMs });
    console.log('[reanchor] musicStartMs adjusted', {
      targetTrackIndex,
      segmentOffsetSec,
      cumSec,
      newMusicStartMs,
      armEpoch: runway.armEpoch,
    });
  }

  /**
   * Test affordance: skip the entire remaining music runway and trigger the pad bridge.
   * Quick Play uses its own pad bridge (timed by global defaults); service mode uses
   * the playlist's bridge timing scheduled to land at the service start.
   */
  skipToPad() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.phase !== 'music') return;
    if (runway.serviceId === null) {
      void this.beginQuickPlayPad();
    } else {
      void this.beginPad();
    }
  }

  /** Nudge music position by `deltaSec`, clamped to track length. */
  nudgeMusic(deltaSec: number) {
    const pos = this.audio.getMusicPosition();
    if (pos.durationSec === 0) return;
    const newPos = Math.max(0, Math.min(pos.durationSec, pos.positionSec + deltaSec));
    void this.audio.seekMusic(newPos);
    const idx = this.store.getState().currentRunway?.currentTrackIndex ?? 0;
    this.reanchorMusicStart(idx, newPos);
  }

  /**
   * Click on a timeline segment. Only enabled for Quick Test (no service) — for
   * a real armed service, the timeline is locked so we don't accidentally skew
   * the runway timing during a live event.
   *
   * If it's the currently-playing track, seek to `positionSec` within it.
   * Otherwise jump to that track and start at `positionSec`.
   */
  async clickTimeline(trackIndex: number, positionSec: number): Promise<void> {
    const state = this.store.getState();
    const runway = state.currentRunway;
    console.log('[clickTimeline]', {
      trackIndex,
      positionSec,
      runwayServiceId: runway?.serviceId ?? null,
      runwayPhase: runway?.phase,
      currentIdx: runway?.currentTrackIndex,
    });
    if (!runway) { console.warn('[clickTimeline] no runway'); return; }
    if (runway.serviceId !== null) {
      const svc = state.config.services.find(s => s.id === runway.serviceId);
      if (!svc?.isRehearsal) {
        console.warn('[clickTimeline] locked — armed real service, only rehearsals/test allowed');
        return;
      }
    }
    if (runway.phase !== 'music' && runway.phase !== 'queued') {
      console.warn('[clickTimeline] wrong phase', runway.phase);
      return;
    }
    if (trackIndex < 0 || trackIndex >= runway.trackIds.length) {
      console.warn('[clickTimeline] index out of range', trackIndex, runway.trackIds.length);
      return;
    }

    const trackId = runway.trackIds[trackIndex];
    const track = state.config.tracks.find(t => t.id === trackId);
    if (!track) {
      console.warn('[clickTimeline] track not found in library', trackId);
      return;
    }

    const trimStart = track.trimStartSec ?? 0;
    const trimEnd = track.trimEndSec ?? track.durationSec;
    const effDur = Math.max(0.01, trimEnd - trimStart);
    const segOffset = Math.max(0, Math.min(effDur - 0.05, positionSec));
    const trim = {
      startAtSec: trimStart + segOffset,
      endAtSec: track.trimEndSec,
      segmentStartSec: trimStart,
      fadeOutSec: track.editFadeOutSec,
    };

    state.patchCurrentRunway({ currentTrackIndex: trackIndex, phase: 'music' });
    this.reanchorMusicStart(trackIndex, segOffset);
    if (runway.serviceId) state.setServiceStatus(runway.serviceId, 'live');
    try {
      const musicCurrentlyPlaying = state.musicPlayback.isPlaying;
      const fadeSec = state.config.defaults.crossfadeSec ?? runway.crossfadeSec ?? 4;
      // Same track? Use a quick crossfade-to-self so the seek is smooth instead
      // of a hard cut. This also keeps the trim end + fade-out properly applied,
      // which the older seekMusic path didn't honor.
      const isSameTrack = runway.phase === 'music' && trackIndex === runway.currentTrackIndex;
      if (musicCurrentlyPlaying) {
        await this.audio.crossfadeToMusic(track.filePath, {
          crossfadeSec: isSameTrack ? Math.min(0.5, fadeSec) : fadeSec,
          trackId: track.id,
          ...trim,
        });
      } else {
        await this.audio.playMusic(track.filePath, {
          trackId: track.id,
          fadeInSec: fadeSec,
          ...trim,
        });
      }
    } catch (err) {
      console.error('[clickTimeline] playMusic failed', err);
    }
  }

  /**
   * Quick Play: walk a playlist's tracks from the top using its own transition
   * settings. No schedule, no pad bridge, no service. Stops cleanly at the end.
   */
  async quickPlayPlaylist(
    playlistId: string,
    opts?: { landInKey?: KeyName },
  ): Promise<{ ok: boolean; reason?: string; warning?: string }> {
    const state = this.store.getState();
    const playlist = state.config.playlists.find(p => p.id === playlistId);
    if (!playlist) return { ok: false, reason: 'Playlist not found' };
    if (playlist.trackIds.length === 0) return { ok: false, reason: 'Playlist has no tracks' };

    const pool = playlist.trackIds
      .map(tid => state.config.tracks.find(t => t.id === tid))
      .filter(Boolean) as Track[];
    if (pool.length === 0) return { ok: false, reason: 'No tracks resolved from the playlist — re-import.' };

    let trackIds: string[];
    let landInKey: KeyName | undefined;
    let warning: string | undefined;

    if (opts?.landInKey) {
      const requested = opts.landInKey;
      const matching = pool.filter(t => t.key === requested);
      if (matching.length > 0) {
        // Put one matching track last, the rest before it.
        const anchor = matching[matching.length - 1];
        const rest = pool.filter(t => t.id !== anchor.id);
        trackIds = [...rest.map(t => t.id), anchor.id];
        landInKey = requested;
      } else {
        // No anchor — keep playlist order and surface a warning.
        trackIds = pool.map(t => t.id);
        landInKey = pool[pool.length - 1].key;
        warning = `No track tagged "${requested}". Playing in order — last track lands on "${landInKey ?? '?'}".`;
      }
    } else {
      trackIds = pool.map(t => t.id);
      landInKey = pool[pool.length - 1].key;
    }

    const firstTrack = state.config.tracks.find(t => t.id === trackIds[0]);
    if (!firstTrack) {
      return { ok: false, reason: 'First track is missing from the library — re-import the playlist.' };
    }

    const totalSec = pool.reduce((acc, t) => acc + t.durationSec, 0);
    // Quick Play reads pad timing from the global defaults (Settings → Engine /
    // Pad Player panel) so the user has one lever for ad-hoc testing,
    // independent of any individual playlist's pad settings.
    state.setCurrentRunway({
      serviceId: null,
      trackIds,
      totalSec,
      landInKey,
      plannedStartTime: undefined,
      startOffsetSec: 0,
      targetMs: 0,
      musicStartMs: Date.now(),
      padStartMs: 0,
      transitionMode: playlist.transitionMode,
      // Quick Play uses the global default crossfade so the user can tweak it
      // from the Pad Player panel without editing each playlist.
      crossfadeSec: state.config.defaults.crossfadeSec,
      padBridgeSec: state.config.defaults.padBridgeSec,
      padFadeOutSec: state.config.defaults.padFadeOutSec,
      tailSec: 0,
      phase: 'music',
      currentTrackIndex: 0,
      sourcePlaylistId: playlist.id,
    });

    try {
      await this.audio.playMusic(firstTrack.filePath, {
        trackId: firstTrack.id,
        fadeInSec: firstTrack.editFadeInSec ?? 0,
        startAtSec: firstTrack.trimStartSec,
        endAtSec: firstTrack.trimEndSec,
        fadeOutSec: firstTrack.editFadeOutSec,
      });
    } catch (err) {
      console.error('[quickPlay] failed to start first track', err);
      state.setCurrentRunway(null);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Could not play "${firstTrack.title}": ${msg}` };
    }
    return { ok: true, warning };
  }

  /**
   * Post-service playback — sequentially walks a playlist with the configured
   * crossfade. No land-in-key, no pad bridge. Fades out when last track ends.
   */
  async startPostServicePlay(playlistId: string, originServiceId?: string): Promise<{ ok: boolean; reason?: string; warning?: string }> {
    const state = this.store.getState();
    const playlist = state.config.playlists.find(p => p.id === playlistId);
    if (!playlist) return { ok: false, reason: 'Playlist not found' };
    if (playlist.trackIds.length === 0) return { ok: false, reason: 'Playlist is empty' };
    // Infer which service triggered this post-service, in priority order:
    //   1. Explicit originServiceId from the caller
    //   2. Currently-armed pre-service runway's serviceId, BUT ONLY
    //      if that service's start time is in the past — auto-arm
    //      pre-stages 2nd Service before 1st Service's post-service
    //      ends, so currentRunway often points at a FUTURE service.
    //      Using that as origin would resolve 2nd Service's overrides
    //      when post-service is actually for 1st Service.
    //   3. Currently-running post-service's existing originServiceId
    //   4. Most recent today's service whose start time has passed.
    const now = Date.now();
    const todayStr = (() => {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    })();
    const serviceTargetMs = (id: string | null | undefined) => {
      if (!id) return null;
      const s = state.config.services.find(svc => svc.id === id);
      if (!s) return null;
      const d = new Date(s.date + 'T00:00:00');
      const [h, m] = s.startTime.split(':').map(Number);
      d.setHours(h, m, 0, 0);
      return d.getTime();
    };
    const runwayServiceId = state.currentRunway && !state.currentRunway.isPostService
      ? state.currentRunway.serviceId ?? undefined
      : undefined;
    const runwayServiceTargetMs = serviceTargetMs(runwayServiceId);
    // Only honor the runway's serviceId as origin if it represents a
    // service whose target has already passed (i.e., the one that
    // actually just ran). Otherwise it's a queued auto-arm for a
    // future service and shouldn't be treated as origin.
    const fromRunway = runwayServiceTargetMs != null && runwayServiceTargetMs <= now
      ? runwayServiceId
      : undefined;
    const fromPostRunway = state.currentRunway?.isPostService
      ? state.currentRunway.originServiceId
      : undefined;
    const mostRecentPastService = state.config.services
      .filter(s => s.date === todayStr)
      .map(s => ({ id: s.id, targetMs: serviceTargetMs(s.id) ?? Infinity }))
      .filter(x => x.targetMs <= now)
      .sort((a, b) => b.targetMs - a.targetMs)[0]?.id;
    const inferredOriginId = originServiceId
      ?? fromRunway
      ?? fromPostRunway
      ?? mostRecentPastService;
    // Refuse to clobber a pre-service runway that's actually producing
    // audio (music or pad). A queued pre-service runway (auto-armed but
    // waiting) gets quietly cleared so the operator can fire post-service
    // between back-to-back services without fighting auto-arm.
    if (state.currentRunway
        && !state.currentRunway.isPostService
        && (state.currentRunway.phase === 'music' || state.currentRunway.phase === 'pad')) {
      return { ok: false, reason: 'Service runway is playing — panic before starting post-service.' };
    }
    if (state.currentRunway
        && !state.currentRunway.isPostService
        && state.currentRunway.serviceId) {
      // Queued pre-service: revert it to scheduled and clear the runway.
      // The auto-arm effect will re-arm at the next service's musicFireMs
      // because post-service will be rolling at that point.
      state.disarmService(state.currentRunway.serviceId);
    }

    // Drop any track ids the library no longer has so the runway never holds
    // a "missing" placeholder. If the playlist references stale ids the user
    // may want to clean those up in Playlists view; the runway should just
    // skip them.
    let validTrackIds = playlist.trackIds.filter(
      id => state.config.tracks.some(t => t.id === id),
    );
    if (validTrackIds.length === 0) {
      return { ok: false, reason: 'Every track in this playlist is missing from the library — re-import.' };
    }
    const skipped = playlist.trackIds.length - validTrackIds.length;

    // Playlists pinned to playbackOrder='shuffle' get a fresh random
    // order every time post-service starts. Without this the "shuffle"
    // setting only mattered the first time and the same opening track
    // played week after week.
    if (playlist.playbackOrder === 'shuffle' && validTrackIds.length > 1) {
      validTrackIds = shuffleTrackIds(validTrackIds);
    }

    const firstTrack = state.config.tracks.find(t => t.id === validTrackIds[0]);
    if (!firstTrack) return { ok: false, reason: 'First track missing — re-import the playlist.' };

    const fadeInSec = state.config.defaults.postServiceFadeInSec ?? 4;
    const totalSec = validTrackIds
      .map(id => state.config.tracks.find(t => t.id === id))
      .reduce((acc, t) => acc + (t?.durationSec ?? 0), 0);

    if (skipped > 0) {
      console.warn(`[postService] skipped ${skipped} missing track id${skipped === 1 ? '' : 's'} from playlist "${playlist.name}"`);
    }

    state.setCurrentRunway({
      serviceId: null,
      trackIds: validTrackIds,
      totalSec,
      landInKey: undefined,
      plannedStartTime: undefined,
      startOffsetSec: 0,
      targetMs: 0,
      musicStartMs: Date.now(),
      padStartMs: 0,
      transitionMode: playlist.transitionMode,
      crossfadeSec: state.config.defaults.crossfadeSec ?? playlist.crossfadeSec,
      padBridgeSec: 0,
      padFadeOutSec: 0,
      tailSec: 0,
      phase: 'music',
      currentTrackIndex: 0,
      isPostService: true,
      sourcePlaylistId: playlist.id,
      originServiceId: inferredOriginId,
    });

    try {
      await this.audio.playMusic(firstTrack.filePath, {
        trackId: firstTrack.id,
        fadeInSec,
        startAtSec: firstTrack.trimStartSec,
        endAtSec: firstTrack.trimEndSec,
        fadeOutSec: firstTrack.editFadeOutSec,
      });
    } catch (err) {
      console.error('[postService] failed to start first track', err);
      state.setCurrentRunway(null);
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `Could not play "${firstTrack.title}": ${msg}` };
    }
    return {
      ok: true,
      warning: skipped > 0
        ? `Skipped ${skipped} track${skipped === 1 ? '' : 's'} missing from the library — re-import the playlist to fix.`
        : undefined,
    };
  }

  /** Stop a Quick Play (music or pad phase) and clear the runway. */
  stopQuickPlay(fadeSec = 0.8) {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.serviceId !== null) return;
    this.audio.fadeOutMusic(fadeSec);
    this.audio.fadeOutPad(fadeSec);
    state.setCurrentRunway(null);
  }

  /** Stop a post-service playback and clear the runway. */
  stopPostService(fadeSec = 1.5) {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || !runway.isPostService) return;
    this.audio.fadeOutMusic(fadeSec);
    state.setCurrentRunway(null);
  }

  /**
   * Pick the same "active service" the Live view does — the upcoming or
   * still-running service for today. Used by MIDI actions so a single
   * controller button targets the same service the operator sees.
   */
  private getActiveService() {
    const state = this.store.getState();
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const todayServices = state.config.services
      .filter(s => s.date === todayStr)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
    const now = Date.now();
    return todayServices.find(s => {
      const date = new Date(s.date + 'T00:00:00');
      const [h, m] = s.startTime.split(':').map(Number);
      date.setHours(h, m, 0, 0);
      const tMs = date.getTime();
      if (tMs > now) return true;
      if (s.status === 'completed') return false;
      if (s.status === 'live' || s.status === 'queued') return true;
      return tMs > now - 5 * 60 * 1000;
    });
  }

  /**
   * Shuffle a post-service playlist while it's running. Keeps the
   * currently-playing track in place — only the *unplayed* tail is
   * randomized. Past tracks stay where they are (they've already
   * played; reordering them just makes the timeline lie). Safe to call
   * multiple times.
   */
  async shufflePostService(): Promise<{ ok: boolean; reason?: string }> {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || !runway.isPostService) {
      return { ok: false, reason: 'No post-service playback running' };
    }
    const idx = runway.currentTrackIndex;
    const past = runway.trackIds.slice(0, idx + 1);  // includes currently-playing
    const future = runway.trackIds.slice(idx + 1);
    if (future.length < 2) {
      return { ok: false, reason: 'Nothing left to shuffle' };
    }
    const next = [...future];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    state.patchCurrentRunway({ trackIds: [...past, ...next] });
    return { ok: true };
  }

  /**
   * Pick the right shuffle path for the current runway state. Pre-service
   * (armed-not-playing) re-arms with a fresh arrangement; post-service
   * shuffles the unplayed tail without interrupting the current track.
   * Used by the remote's single shuffle button so the operator doesn't
   * have to know which mode they're in.
   */
  async smartShuffle(): Promise<{ ok: boolean; reason?: string; warning?: string }> {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway) return { ok: false, reason: 'Nothing playing' };
    if (runway.isPostService) {
      return this.shufflePostService();
    }
    return this.shuffleArrangement();
  }

  /**
   * Re-arm the currently-armed service with a freshly shuffled arrangement.
   * The pinned last-song (and key constraint) are still honored — only the
   * rotation order before the anchor changes. No-op if not armed or if
   * music has already started.
   */
  async shuffleArrangement(): Promise<{ ok: boolean; reason?: string; warning?: string }> {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || !runway.serviceId) return { ok: false, reason: 'No service armed' };
    if (runway.phase !== 'queued') return { ok: false, reason: 'Music has already started' };
    return state.armService(
      runway.serviceId,
      (filePath) => this.audio.loadBuffer(filePath).then(() => undefined),
      { shuffle: true },
    );
  }

  /**
   * Re-arm the currently-armed service so the pre-service music fills the
   * full remaining window (now → service start) and fire it immediately.
   * Used by the "Start music early" button. No-op if not armed, already
   * playing, or if the service has already started.
   */
  async startMusicEarly(): Promise<{ ok: boolean; reason?: string }> {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || !runway.serviceId) return { ok: false, reason: 'No service armed' };
    if (runway.phase !== 'queued') return { ok: false, reason: 'Music has already started' };
    const remainingSec = (runway.targetMs - Date.now()) / 1000;
    if (remainingSec <= 5) return { ok: false, reason: 'Service is too close — start manually with Quick Test' };
    const result = await state.armService(
      runway.serviceId,
      (filePath) => this.audio.loadBuffer(filePath).then(() => undefined),
      { leadOverrideSec: remainingSec },
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    // Mark this runway as a "started early" cycle so the UI can offer Cancel.
    state.patchCurrentRunway({ startedEarly: true });
    // armService set musicStartMs ≈ now; the next 500ms tick will fire
    // beginMusic. To make the press feel instant, kick it directly.
    void this.beginMusic();
    return { ok: true };
  }

  /**
   * Undo a startMusicEarly: fade the audio out, then re-arm with the
   * service's original autoStartTargetSec so the runway returns to a normal
   * "queued, waiting to fire" state.
   */
  async cancelMusicEarly(): Promise<{ ok: boolean; reason?: string }> {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || !runway.serviceId) return { ok: false, reason: 'No service armed' };
    if (!runway.startedEarly) return { ok: false, reason: 'Music was not started early' };
    this.audio.fadeOutMusic(state.config.defaults.panicFadeSec);
    const result = await state.armService(
      runway.serviceId,
      (filePath) => this.audio.loadBuffer(filePath).then(() => undefined),
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    return { ok: true };
  }

  /**
   * Delete a service safely. If the service has the currently-running
   * runway, fade audio out first so the user doesn't hear a hard cut, then
   * remove the service from config. Use this anywhere a service can be
   * deleted while a service might be live (Schedule's per-card Remove,
   * Clear all).
   */
  deleteServiceWithFade(serviceId: string): void {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (runway?.serviceId === serviceId) {
      this.audio.panicFadeAll(state.config.defaults.panicFadeSec);
    }
    state.deleteService(serviceId);
  }

  /**
   * Full panic — same behavior as the Panic button in the header. Fades all
   * audio, disarms a real service if one was armed, and clears any runway.
   */
  /**
   * "Soft panic" — fade music to silence (without stopping it; the
   * runway clock keeps advancing so the operator can bring volume
   * back up at any moment) and fire the pad in the currently armed
   * key. Doesn't disarm the service or clear the runway. Use case:
   * emergency hold where the operator wants to drop singing but keep
   * an atmospheric pad going so silence doesn't suddenly fall on the
   * room. Distinct from the full panic, which silences everything.
   */
  async fadeToPad(fadeSec?: number): Promise<void> {
    const state = this.store.getState();
    const cfg = state.config.defaults;
    const fade = fadeSec ?? Math.max(0.5, cfg.panicFadeSec ?? 1.5);
    // Toggle: if already engaged, reverse it — bring music back to
    // unity gain and fade the pad out. The music source has been
    // playing silently this whole time, so position is correct.
    if (state.fadeToPadActive) {
      this.audio.restoreMusicLevel(fade);
      this.audio.fadeOutPad(fade);
      state.setFadeToPadActive(false);
      return;
    }
    // Music down to silence — but keep the source playing so position
    // advances and the operator can bring it back up by clicking the
    // button again.
    this.audio.fadeMusicToSilence(fade);
    // Pick the pad to fire. Priority chain:
    //   1. Currently-armed key's pad (set by auto-track or the picker)
    //   2. The currently-playing track's key
    //   3. The runway's planned land-in key
    //   4. Compatible-key fallback
    //   5. First mapped pad
    const armed = state.padArmedKey;
    let padFile = armed ? state.config.pads.find(p => p.key === armed) : undefined;
    if (!padFile) {
      const playingTrack = state.musicPlayback.trackId
        ? state.config.tracks.find(t => t.id === state.musicPlayback.trackId)
        : undefined;
      const targetKey = playingTrack?.key ?? state.currentRunway?.landInKey;
      if (targetKey) {
        padFile = state.config.pads.find(p => p.key === targetKey);
        if (!padFile) {
          for (const k of compatibleKeys(targetKey)) {
            const m = state.config.pads.find(p => p.key === k);
            if (m) { padFile = m; break; }
          }
        }
      }
    }
    if (!padFile && state.config.pads.length > 0) padFile = state.config.pads[0];
    if (!padFile) {
      console.warn('[fadeToPad] no pads mapped — music faded but nothing to bridge with');
      return;
    }
    const fadeIn = Math.max(0.5, cfg.padLeadInSec ?? 2);
    await this.audio.playPad(padFile.filePath, { fadeInSec: fadeIn, loop: true });
    if (padFile.key) state.setPadArmedKey(padFile.key);
    state.setFadeToPadActive(true);
  }

  panic() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway && !state.musicPlayback.isPlaying) return;
    this.audio.panicFadeAll(state.config.defaults.panicFadeSec);
    state.setFadeToPadActive(false);
    const armedServiceId = runway?.serviceId ?? null;
    if (armedServiceId) {
      state.disarmService(armedServiceId);
      state.setAutoArmEnabled(false);
    } else if (runway) {
      state.setCurrentRunway(null);
    }
  }

  /**
   * MIDI-driven Start Post-Service — same as clicking the button. If post-
   * service is already running this is a no-op (use Panic to stop, or hit
   * the on-screen button which has the confirm-to-stop dance).
   *
   * Mirror the LiveView dropdown's resolution chain so MIDI fires whenever
   * the manual button would: prefer the active service's playlist, then
   * fall back to the first post-kind playlist. Without this fallback MIDI
   * silently fails after the service is marked completed (getActiveService
   * returns undefined past the 5-min grace), even though the on-screen
   * button still works because the dropdown remembers its last selection.
   */
  async triggerPostService(): Promise<{ ok: boolean; reason?: string }> {
    const state = this.store.getState();
    if (state.currentRunway?.isPostService) {
      const reason = 'Post-service already running';
      this.notifyActionError?.(reason);
      return { ok: false, reason };
    }
    // Refuse only when pre-service is actively producing audio (music or
    // pad phase). A merely-queued pre-service (e.g. auto-armed for the
    // next service) is fine to clobber — startPostServicePlay clears the
    // queued runway internally and auto-arm re-fires once post-service
    // ends. Original guard refused for all phases, but that broke the
    // expected ProPresenter end-of-service flow where the next service
    // is already queued when the post-service cue fires.
    if (state.currentRunway && !state.currentRunway.isPostService) {
      const phase = state.currentRunway.phase;
      if (phase === 'music' || phase === 'pad') {
        const reason = 'Pre-service is playing — panic before starting post-service.';
        this.notifyActionError?.(reason);
        return { ok: false, reason };
      }
    }
    // For an end-of-service post-service trigger (ProPresenter cue, MIDI,
    // remote), the relevant service is the one that JUST ENDED — not the
    // next one upcoming. getActiveService() returns the next upcoming /
    // running service, which is wrong as an origin when the trigger fires
    // between two services (e.g. 1st Service ended at 9-something, 2nd
    // Service is at 1:30 PM; the cue fires for 1st Service's post, not
    // 2nd Service's). Prefer the most recently started service today; if
    // somehow nothing has started yet today, fall back to active.
    const active = this.getMostRecentServiceToday() ?? this.getActiveService();
    const firstPost = state.config.playlists.find(p => p.kind === 'post');
    const playlistId = active?.postServicePlaylistId ?? firstPost?.id;
    if (!playlistId) {
      const reason = 'No post-service playlist available';
      this.notifyActionError?.(reason);
      return { ok: false, reason };
    }
    // Pass active service id so the post-service runway carries
    // originServiceId — needed for the resolver to find any
    // per-service post-service action override.
    return this.startPostServicePlay(playlistId, active?.id);
  }

  /** Most recent already-started service today, regardless of status.
   *  Fallback for post-service triggers that arrive after the last
   *  service of the day — so the trigger uses that service's configured
   *  post-service playlist + action sequence instead of falling through
   *  to the first kind:'post' playlist in the config. Today's services
   *  stay "addressable" until end of day, not just until they're marked
   *  completed. */
  private getMostRecentServiceToday() {
    const state = this.store.getState();
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;
    const now = Date.now();
    return state.config.services
      .filter(s => s.date === todayStr)
      .filter(s => {
        const d = new Date(s.date + 'T00:00:00');
        const [h, m] = s.startTime.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        return d.getTime() <= now;
      })
      .sort((a, b) => b.startTime.localeCompare(a.startTime))[0];
  }

  /**
   * MIDI-driven Pad Play — fires the pad for the currently armed key, or
   * falls back to the first available pad. Mirrors the Pad Player Play button.
   */
  async triggerPadPlay(): Promise<void> {
    const state = this.store.getState();
    const armed = state.padArmedKey;
    let pad = armed ? state.config.pads.find(p => p.key === armed) : undefined;
    if (!pad && state.config.pads.length > 0) pad = state.config.pads[0];
    if (!pad) return;
    const fadeIn = state.config.defaults.padLeadInSec ?? 1.0;
    await this.audio.playPad(pad.filePath, { fadeInSec: fadeIn, loop: true });
  }

  /** MIDI-driven Pad Stop — fade out the pad bus. */
  triggerPadStop() {
    const state = this.store.getState();
    const fadeSec = state.config.defaults.padFadeOutSec ?? 2;
    this.audio.fadeOutPad(fadeSec);
  }

  // Confirm-disarm window — first press while armed mid-playback sets the
  // store flag (which colors the UI button red and shows "Click again" copy),
  // a 3s timeout clears it, the second press inside that window does the
  // disarm. The flag lives in the store so the UI button and MIDI arm_toggle
  // share state and the button reflects MIDI-initiated confirms too.
  private armConfirmTimer: number | null = null;

  /**
   * Mirror of the header Arm button — for MIDI bindings. Single press toggles:
   *  - No active service → flip the auto-arm master switch.
   *  - Not armed → arm the active service.
   *  - Armed in queued phase → disarm immediately.
   *  - Armed mid-playback → first press starts a 3s confirm window; second
   *    press inside that window disarms (with audio panic-fade) and turns
   *    auto-arm off so the next service doesn't immediately re-arm.
   */
  async armToggle(opts: { onArmError?: (msg: string) => void; alwaysConfirmDisarm?: boolean } = {}): Promise<void> {
    const state = this.store.getState();
    const activeService = this.getActiveService();

    if (!activeService) {
      state.setAutoArmEnabled(!state.autoArmEnabled);
      return;
    }

    const isArmed = state.currentRunway?.serviceId === activeService.id;

    if (isArmed) {
      const phase = state.currentRunway?.phase;
      const isMidPlayback = phase === 'music' || phase === 'pad';
      // Confirm-disarm trips on second click. Default behavior gates by
      // mid-playback (desktop UX — bare-armed disarm is harmless and
      // shouldn't need a second tap). Remote callers pass
      // alwaysConfirmDisarm because phones are easy to fat-finger.
      const requireConfirm = isMidPlayback || !!opts.alwaysConfirmDisarm;
      console.log('[armToggle] armed', { phase, isMidPlayback, requireConfirm, confirmFlag: state.armConfirmDisarm });
      if (requireConfirm && !state.armConfirmDisarm) {
        console.log('[armToggle] entering confirm window — flag → true');
        state.setArmConfirmDisarm(true);
        if (this.armConfirmTimer !== null) window.clearTimeout(this.armConfirmTimer);
        this.armConfirmTimer = window.setTimeout(() => {
          console.log('[armToggle] confirm window expired — flag → false');
          this.store.getState().setArmConfirmDisarm(false);
          this.armConfirmTimer = null;
        }, 3000);
        return;
      }
      console.log('[armToggle] performing disarm');
      // Disarm must ALWAYS end with a silent music bus. A queued runway
      // "shouldn't" have audio, but historically could (e.g. Quick Play
      // music left rolling under a newly-armed runway) — so the queued
      // case fades the music bus too (music-only, so a manually fired
      // pad survives). An audibly-firing runway gets the full panic fade.
      if (state.currentRunway && state.currentRunway.phase !== 'queued') {
        this.audio.panicFadeAll(state.config.defaults.panicFadeSec);
      } else {
        this.audio.panicFadeMusic(state.config.defaults.panicFadeSec);
      }
      state.disarmService(activeService.id);
      state.setAutoArmEnabled(false);
      state.setArmConfirmDisarm(false);
      if (this.armConfirmTimer !== null) {
        window.clearTimeout(this.armConfirmTimer);
        this.armConfirmTimer = null;
      }
      return;
    }

    // Not armed — arm and re-enable auto-arm so subsequent services follow.
    state.setAutoArmEnabled(true);
    // If ANY audible runway is currently rolling (post-service playlist,
    // Quick Play/Test music, a lingering pad bridge), fade it out so
    // arming doesn't leave the old audio running concurrently with the
    // new pre-service runway. armService overwrites currentRunway but
    // never touches audio, so the bus must be silenced here. (Previously
    // only post-service was faded — arming over a playing Quick Play left
    // its music rolling under the queued runway, where disarm couldn't
    // reach it either.)
    const curPhase = state.currentRunway?.phase;
    if (state.currentRunway
        && (state.currentRunway.isPostService || curPhase === 'music' || curPhase === 'pad')) {
      this.audio.panicFadeAll(state.config.defaults.panicFadeSec);
    }
    const result = await state.armService(
      activeService.id,
      (filePath) => this.audio.loadBuffer(filePath).then(() => undefined),
    );
    if (!result.ok) opts.onArmError?.(result.reason ?? 'Failed to arm');
    else if (result.warning) opts.onArmError?.(result.warning);
  }

  private tick() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    // Reset fired-action set whenever the runway pointer is replaced
    // by setCurrentRunway (arm, disarm, post-service start, swap). Skip
    // operations and other patchCurrentRunway tweaks preserve armEpoch
    // so they don't trip the reset — otherwise a "skip forward" that
    // adjusts musicStartMs would re-arm cues that already fired.
    const sig = runway ? String(runway.armEpoch ?? 0) : '';
    if (sig !== this.lastRunwaySig) {
      this.firedActionIds.clear();
      this.prewarmedPlaylistIds.clear();
      this.lastRunwaySig = sig;
      // New arm or runway swap — reset bus levels so a prior run's
      // audio_fade actions can't bleed into the new arm. Only on actual
      // arm transitions (sig non-empty); skipping the disarm direction
      // keeps panic-fade silence intact.
      if (sig) {
        this.audio.resetBusLevels?.();
      }
    }
    // Failsafes are keyed off armEpoch + serviceId + targetMs, so any
    // material change (re-arm, action swap, +/- 2 min) reinstalls fresh
    // timers and clears stale ones. Idempotent on no-change ticks.
    this.installFailsafes(state);

    if (!runway) return;

    const now = Date.now();
    // Quick Play runs without a backing service.
    if (runway.serviceId !== null) {
      const service = state.config.services.find(s => s.id === runway.serviceId);
      if (!service) {
        // Service got deleted while armed — clear runway.
        state.setCurrentRunway(null);
        return;
      }
    }

    // Fire any due Action Sequence actions before the phase logic. Doing
    // it first means an action whose offset lands at exactly the music
    // start can fire on the same tick that flips queued→music.
    this.fireDueActions(state, runway, now);

    switch (runway.phase) {
      case 'queued':
        if (now >= runway.musicStartMs) {
          this.beginMusic();
        }
        break;
      case 'music':
        this.advanceMusic(now);
        break;
      case 'pad':
        // Pad lifecycle (status complete + fade-out + cleanup) is managed by
        // setTimeouts inside beginPad / beginQuickPlayPad. The tick just waits.
        break;
      case 'done':
        // Already wrapped up; clear runway if controller hasn't yet.
        state.setCurrentRunway(null);
        break;
    }
  }

  // ─── Action Sequence engine ────────────────────────────────────────

  /**
   * Resolve which Action Sequence (if any) is active for this runway and
   * fire any actions whose offset has passed but haven't fired yet.
   */
  private fireDueActions(
    state: ReturnType<Store['getState']>,
    runway: NonNullable<ReturnType<Store['getState']>['currentRunway']>,
    now: number,
  ): void {
    const seq = this.resolveSequence(state, runway);
    if (!seq || seq.actions.length === 0) return;
    for (const action of seq.actions) {
      if (!action.enabled) continue;
      if (this.firedActionIds.has(action.id)) continue;
      // Resolve wall-clock fire time for both time-based and song-based
      // anchors via the shared helper. null means the song reference is
      // out of bounds — mark fired so we don't keep checking each tick.
      const fireAtMs = resolveActionFireMs(action, seq.anchor, runway, state.config.tracks);
      if (fireAtMs == null) {
        this.firedActionIds.add(action.id);
        continue;
      }
      // Look-ahead pre-warm: a runway-mutating action (arm_playlist /
      // change_setlist) is about to install a NEW playlist's runway. As
      // it approaches its fire time, kick a background decode of that
      // playlist's WHOLE pool so the tracks are warm by the time the
      // action arms — even if shuffle picks songs the current service
      // never played. Without this, the next service's fill can hit a
      // cold decode (silence gap + late landing). Fires once per
      // playlist per arm cycle. Pure cache-warming via loadBuffer; the
      // in-flight dedup means it never double-decodes against the real
      // arm that follows.
      if (now >= fireAtMs - ServiceController.PREWARM_LEAD_MS) {
        const targetPlaylistId =
          action.payload.type === 'arm_playlist' || action.payload.type === 'change_setlist'
            ? action.payload.playlistId
            : undefined;
        if (targetPlaylistId && !this.prewarmedPlaylistIds.has(targetPlaylistId)) {
          this.prewarmedPlaylistIds.add(targetPlaylistId);
          this.prewarmPlaylistPool(targetPlaylistId);
        }
      }
      if (now < fireAtMs) continue;
      // Skip cues whose fire time was already missed by more than 30s
      // before this runway armed — keeps a service that arms 1h late
      // from machine-gunning every "fired in the past" cue. Within 30s
      // we still fire so a near-miss still hits the cue.
      if (now - fireAtMs > 30_000) {
        // Window expired — silently mark fired without dispatching.
        this.firedActionIds.add(action.id);
        continue;
      }
      this.firedActionIds.add(action.id);
      // Diagnostic: log the exact action payload the dispatcher will receive,
      // so a UI/storage mismatch (e.g. dropdown shows arm_playlist but
      // dispatcher sees change_setlist) is visible right at fire time.
      console.log('[actions] dispatching', {
        id: action.id,
        label: action.label,
        type: action.payload.type,
        payload: action.payload,
      });
      void this.dispatchAction(action, runway).catch(err =>
        console.warn('[actions] dispatch failed', action.label || action.id, err),
      );
    }
  }

  /**
   * Background-decode every track in a playlist's pool so an imminent
   * arm_playlist / change_setlist swap finds them warm. Fire-and-forget:
   * decode failures are swallowed (the real arm will surface any genuine
   * load error). Decodes the WHOLE pool, not a particular arrangement,
   * because shuffle/anchor selection can pick any subset at arm time.
   */
  private prewarmPlaylistPool(playlistId: string): void {
    const state = this.store.getState();
    const playlist = state.config.playlists.find(p => p.id === playlistId);
    if (!playlist) return;
    const paths = playlist.trackIds
      .map(id => state.config.tracks.find(t => t.id === id)?.filePath)
      .filter((p): p is string => !!p);
    if (paths.length === 0) return;
    console.log('[prewarm] decoding pool', {
      playlistId,
      playlistName: playlist.name,
      trackCount: paths.length,
    });
    for (const p of paths) {
      void this.audio.loadBuffer(p).catch(err =>
        console.warn('[prewarm] decode failed', p, err),
      );
    }
  }

  private resolveSequence(
    state: ReturnType<Store['getState']>,
    runway: NonNullable<ReturnType<Store['getState']>['currentRunway']>,
  ): ActionSequence | null {
    const sequences = state.config.actionSequences ?? [];
    if (sequences.length === 0) return null;
    // Per-service overrides win (string '' = explicit "no actions").
    // Pick the pre- or post-service field based on which playlist this
    // runway is rendering. Post-service runways set serviceId=null to
    // signal "no service is armed", but they carry originServiceId so
    // we can still find the service-level post-service override.
    // Falls back to the legacy single-field override for configs
    // created before the pre/post split (legacy = pre-service only).
    const lookupServiceId = runway.serviceId ?? runway.originServiceId ?? null;
    if (lookupServiceId) {
      const svc = state.config.services.find(s => s.id === lookupServiceId);
      const isPost = !!runway.isPostService;
      const specific = isPost
        ? svc?.postActionSequenceIdOverride
        : svc?.preActionSequenceIdOverride;
      const ovr = specific !== undefined
        ? specific
        : (isPost ? undefined : svc?.actionSequenceIdOverride);
      if (ovr === '') return null;
      if (ovr) {
        return sequences.find(s => s.id === ovr) ?? null;
      }
    }
    // Fall through to the playlist's default sequence.
    const playlistId = runway.sourcePlaylistId;
    if (!playlistId) return null;
    const pl = state.config.playlists.find(p => p.id === playlistId);
    if (!pl?.actionSequenceId) return null;
    return sequences.find(s => s.id === pl.actionSequenceId) ?? null;
  }

  private async dispatchAction(action: Action, _runway: unknown): Promise<void> {
    const p = action.payload;
    const log = (msg: string) =>
      console.log(`[actions] ${msg}`, action.label ? `(${action.label})` : '');
    switch (p.type) {
      case 'midi_send':
        if (!this.engines.midi) { log('midi_send skipped — no MIDI engine'); return; }
        this.engines.midi.send(p.portName, p.messageType, p.channel, p.data1, p.data2 ?? 0);
        log(`midi_send ${p.messageType} ch${p.channel} ${p.data1}`);
        return;
      case 'pp_trigger_slide':
        if (!this.engines.pp) return;
        // We don't currently have a slide-by-index method; PP's API uses
        // a presentation/group/slide tuple. For v1 we treat slideIndex as
        // an active-presentation slide trigger and rely on PP's
        // /v1/presentation/active/[index]/trigger.
        await this.engines.pp.triggerActiveSlide(p.slideIndex);
        log(`pp slide ${p.slideIndex}`);
        return;
      case 'pp_trigger_playlist_item':
        if (!this.engines.pp) return;
        // If a slide index is set the operator wants to drop straight
        // onto a specific slide of the item; otherwise we fire the item
        // from its first slide (the historical behavior).
        if (typeof p.slideIndex === 'number') {
          await this.engines.pp.triggerPlaylistSlide(p.playlistUuid, p.itemIndex, p.slideIndex);
          log(`pp playlist ${p.playlistName ?? p.playlistUuid}#${p.itemIndex} slide ${p.slideIndex}`);
        } else {
          await this.engines.pp.triggerPlaylistItem(p.playlistUuid, p.itemIndex);
          log(`pp playlist ${p.playlistName ?? p.playlistUuid}#${p.itemIndex}`);
        }
        return;
      case 'pp_set_timer':
        if (!this.engines.pp) return;
        if (p.mode === 'count_down_to_service') {
          const target = this.store.getState().currentRunway?.targetMs ?? 0;
          if (target > 0) await this.engines.pp.armCountdownToTime(p.timerUuid, target);
        } else if (p.durationSec) {
          await this.engines.pp.armCountdownDuration?.(p.timerUuid, p.durationSec);
        }
        log(`pp set timer ${p.timerName ?? p.timerUuid}`);
        return;
      case 'pp_timer_control':
        if (!this.engines.pp) return;
        if (p.op === 'start') await this.engines.pp.startTimer?.(p.timerUuid);
        else if (p.op === 'stop') await this.engines.pp.stopTimer(p.timerUuid);
        else if (p.op === 'reset') await this.engines.pp.resetTimer(p.timerUuid);
        log(`pp timer ${p.op} ${p.timerName ?? p.timerUuid}`);
        return;
      case 'audio_fade': {
        // Read targetGainPct primarily; fall back to legacy targetGainDb
        // if an old config still has it (silently capped at 100%).
        const legacyDb = (p as unknown as { targetGainDb?: number }).targetGainDb;
        const pct = p.targetGainPct ?? (
          typeof legacyDb === 'number'
            ? Math.min(100, Math.max(0, Math.pow(10, legacyDb / 20) * 100))
            : 100
        );
        this.audio.fadeBusToPct?.(p.bus, pct, p.durationSec);
        log(`fade ${p.bus} → ${Math.round(pct)}% over ${p.durationSec}s`);
        return;
      }
      case 'pad_action':
        if (p.op === 'arm_key' && p.key) this.store.getState().setPadArmedKey(p.key);
        else if (p.op === 'fire') void this.triggerPadPlay();
        else if (p.op === 'stop') this.triggerPadStop();
        log(`pad ${p.op}${p.key ? ` ${p.key}` : ''}`);
        return;
      case 'music_action':
        if (p.op === 'start_early') void this.startMusicEarly();
        else if (p.op === 'skip_to_next') this.skipToNextTrack();
        else if (p.op === 'jump_to_track' && p.trackId) this.jumpToTrack(p.trackId);
        log(`music ${p.op}`);
        return;
      case 'change_setlist':
        await this.swapToPlaylist(p.playlistId, p.fadeOutSec);
        log(`change_setlist → ${p.playlistName ?? p.playlistId}`);
        return;
      case 'arm_playlist':
        await this.armPlaylistFromAction(p.playlistId, p.fadeOutSec, p.fillWithMusic, p.playlistName);
        log(`arm_playlist → ${p.playlistName ?? p.playlistId}${p.fillWithMusic ? ' (fill)' : ' (once)'}`);
        return;
    }
  }

  /**
   * Action-driven playlist arm. Picks the next upcoming service from
   * the schedule and arms it using the chosen playlist as its pre-
   * service music — overriding service.preServicePlaylistId for this
   * run only. Overrides anything currently playing: queued pre-service
   * gets cleared, post-service music fades out.
   *
   * `fillWithMusic = true` ("Music to fill"):
   *   - Music starts NOW and fills the entire (now → service start)
   *     window. leadOverrideSec is the remaining time, and
   *     repeatToFill loops tracks to cover it.
   *   - Use case: "the previous service ran long, just start the next
   *     one's music right now and have it land on time."
   *
   * `fillWithMusic = false`:
   *   - Behave like a normal arm. Music starts at musicStartMs based
   *     on playlist length, runway sits queued until then.
   */
  private async armPlaylistFromAction(
    playlistId: string,
    fadeOutSec: number,
    fillWithMusic: boolean,
    playlistName: string | undefined,
  ): Promise<void> {
    const state = this.store.getState();
    console.log('[arm_playlist] requested', {
      playlistId,
      playlistName,
      fadeOutSec,
      fillWithMusic,
      currentRunwayServiceId: state.currentRunway?.serviceId ?? null,
      currentRunwayIsPostService: state.currentRunway?.isPostService ?? false,
    });
    const playlist = playlistId
      ? state.config.playlists.find(p => p.id === playlistId)
      : undefined;
    /**
     * Fail-out helper: notify the operator AND tear down the OLD
     * runway so its `advanceMusic` doesn't keep rolling into the
     * next OLD-playlist track. Used from every error branch — empty
     * playlist, deleted playlist, no upcoming service, etc. Without
     * this the regression returns: action no-ops cleanly but the OLD
     * playlist's song 3 starts because its tick-loop is still active.
     */
    const failAndEndRunway = (msg: string) => {
      console.warn('[actions]', msg);
      this.notifyActionError?.(msg);
      // Mirror the happy-path teardown so we never leak an OLD-runway
      // tick that fires the next track during/after the fade.
      this.swapInProgress = true;
      const fadeStop = Math.max(0.3, fadeOutSec);
      if (state.currentRunway) this.audio.fadeOutMusic(fadeStop);
      window.setTimeout(() => {
        this.swapInProgress = false;
        const cur = this.store.getState().currentRunway;
        if (cur && cur.armEpoch === state.currentRunway?.armEpoch) {
          this.store.getState().setCurrentRunway(null);
        }
      }, Math.max(300, fadeStop * 1000));
    };

    if (!playlistId || !playlist) {
      // No playlist set on the action (or it's been deleted).
      console.log('[arm_playlist] no playlist set — ending runway here');
      failAndEndRunway(
        playlistId
          ? `arm_playlist: playlist "${playlistName ?? playlistId}" missing — runway ended.`
          : `arm_playlist: no playlist set in action — runway ended.`,
      );
      return;
    }
    if (playlist.trackIds.length === 0) {
      failAndEndRunway(`arm_playlist: "${playlist.name}" is empty — runway ended.`);
      return;
    }
    // Find the next upcoming service so we have a target to arm against.
    // If nothing's upcoming, refuse — there's nothing to land at.
    const now = Date.now();
    const upcoming = state.config.services
      .map(s => {
        const d = new Date(s.date + 'T00:00:00');
        const [h, m] = s.startTime.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        return { service: s, targetMs: d.getTime() };
      })
      .filter(x => x.targetMs > now)
      .sort((a, b) => a.targetMs - b.targetMs);
    if (upcoming.length === 0) {
      // No upcoming service to land at — but the operator still
      // wants the chosen playlist to play. Fall back to a standalone
      // swap (like change_setlist) so the action does the obvious-
      // correct thing instead of going silent. Notify so they know
      // why we didn't actually arm anything.
      console.log('[arm_playlist] no upcoming service — falling back to standalone playlist swap');
      this.notifyActionError?.(
        `arm_playlist: no upcoming service in the schedule — playing "${playlist.name}" as a standalone runway. Schedule a future service if you want to arm one.`,
      );
      await this.swapToPlaylist(playlist.id, fadeOutSec);
      return;
    }
    const target = upcoming[0];
    console.log('[arm_playlist] target service', {
      serviceId: target.service.id,
      serviceName: target.service.name,
      serviceStartTime: target.service.startTime,
      targetMs: target.targetMs,
      msUntilTarget: target.targetMs - Date.now(),
      fillWithMusic,
    });
    // Fade the current audio (post-service or whatever) so it doesn't
    // stomp on the new pre-service music. armService overwrites
    // currentRunway via direct set, but the audio engine source from
    // the previous runway is independent and needs explicit fade-out.
    //
    // CRITICAL: set swapInProgress BEFORE the fade. Without it, the
    // controller's tick can run advanceMusic during the fade window,
    // notice the OLD playback wrapping up, and either advance to the
    // OLD playlist's next track or fire the post-service "song ended"
    // branch — both producing the regression where the OLD playlist
    // keeps playing instead of switching into the next service. This
    // mirrors the no-playlist branch above. Cleared in `finally` so a
    // rejection from armService doesn't leave the flag stuck on.
    this.swapInProgress = true;
    const fade = Math.max(0.1, fadeOutSec);
    if (this.audio && state.currentRunway) {
      this.audio.fadeOutMusic(fade);
    }
    // Clear any queued runway synchronously so armService doesn't see
    // a stale "already armed" state. Also clear post-service so the
    // tick doesn't try to advance it after we install the new runway.
    if (state.currentRunway) {
      state.setCurrentRunway(null);
    }
    try {
      // fillWithMusic = "fill the window with music starting now."
      // Compute lead = (now → service start) and force repeatToFill=true
      // so the playlist loops to cover the whole window.
      const leadOverrideSec = fillWithMusic
        ? Math.max(1, Math.floor((target.targetMs - Date.now()) / 1000))
        : undefined;
      const result = await state.armService(
        target.service.id,
        (filePath) => this.audio.loadBuffer(filePath).then(() => undefined),
        {
          playlistOverrideId: playlistId,
          leadOverrideSec,
          repeatToFill: fillWithMusic,
        },
      );
      if (!result.ok) {
        const msg = `arm_playlist refused: ${result.reason ?? 'unknown error'}`;
        console.warn('[actions]', msg);
        this.notifyActionError?.(msg);
        return;
      }
      console.log('[arm_playlist] armed →', target.service.name || target.service.startTime, 'with', playlist.name);
      if (result.warning) this.notifyActionError?.(result.warning);
    } finally {
      // Clear after the fade has had time to complete + a small
      // cushion so the tick that flips the new runway from queued →
      // music can run without the OLD-fade still in flight.
      window.setTimeout(() => {
        this.swapInProgress = false;
      }, Math.max(300, fade * 1000));
    }
  }

  /**
   * Tear down the current music, then start the chosen playlist as a
   * fresh post-service runway. Used by the change_setlist action so a
   * sequence can transition (e.g.) "prayer set → standard post-service"
   * mid-flow. The new runway has its own Action Sequence resolution, so
   * the operator can chain sequences if desired.
   */
  private async swapToPlaylist(playlistId: string, fadeOutSec: number): Promise<void> {
    const state = this.store.getState();
    const fromId = state.currentRunway?.sourcePlaylistId ?? null;
    const targetPlaylist = state.config.playlists.find(p => p.id === playlistId);
    console.log('[change_setlist] swap requested', {
      fromPlaylistId: fromId,
      toPlaylistId: playlistId,
      toPlaylistName: targetPlaylist?.name,
      fadeOutSec,
      currentPhase: state.currentRunway?.phase,
      isPostService: state.currentRunway?.isPostService,
    });

    if (!playlistId || !targetPlaylist) {
      // No playlist configured (or it's been deleted) — end the
      // current runway at the action's fire point. Matches the
      // "runway ends here" footer the live view shows for this case.
      console.log('[change_setlist] no playlist set — ending runway here');
      this.notifyActionError?.(
        playlistId
          ? `change_setlist: target playlist missing — runway ended.`
          : `change_setlist: no playlist set in action — runway ended.`,
      );
      // Set swapInProgress for the fade window so advanceMusic can't
      // race in and start the *next* OLD-playlist track during the
      // fade-out. (That was the visible bug: the action fired,
      // music started fading, but advanceMusic still kicked off track
      // N+1 because the runway was still set with the old trackIds.)
      this.swapInProgress = true;
      const fadeStop = Math.max(0.3, fadeOutSec);
      this.audio.fadeOutMusic(fadeStop);
      window.setTimeout(() => {
        this.swapInProgress = false;
        const cur = this.store.getState().currentRunway;
        if (cur && cur.armEpoch === state.currentRunway?.armEpoch) {
          this.store.getState().setCurrentRunway(null);
        }
      }, Math.max(300, fadeStop * 1000));
      return;
    }
    if (fromId === playlistId) {
      const msg = `change_setlist: already on "${targetPlaylist.name}" — no swap performed.`;
      console.warn('[actions]', msg);
      this.notifyActionError?.(msg);
      return;
    }

    // Pre-validate that the target resolves to playable tracks BEFORE
    // disturbing audio or the runway. A mid-swap "playlist empty" used
    // to leave audio dead and runway null. Now we either succeed or
    // refuse cleanly with the OLD playlist still rolling.
    let validTrackIds = targetPlaylist.trackIds.filter(
      id => state.config.tracks.some(t => t.id === id),
    );
    if (validTrackIds.length === 0) {
      const msg = `change_setlist: "${targetPlaylist.name}" has no playable tracks (all missing from library).`;
      console.warn('[actions]', msg);
      this.notifyActionError?.(msg);
      return;
    }
    // Honor the target playlist's playbackOrder='shuffle' setting on
    // every swap, same as a fresh post-service start.
    if (targetPlaylist.playbackOrder === 'shuffle' && validTrackIds.length > 1) {
      validTrackIds = shuffleTrackIds(validTrackIds);
    }
    const firstTrack = state.config.tracks.find(t => t.id === validTrackIds[0]);
    if (!firstTrack) {
      const msg = `change_setlist: first track of "${targetPlaylist.name}" missing from library`;
      console.warn('[actions]', msg);
      this.notifyActionError?.(msg);
      return;
    }
    const skipped = targetPlaylist.trackIds.length - validTrackIds.length;
    const totalSec = validTrackIds
      .map(id => state.config.tracks.find(t => t.id === id))
      .reduce((acc, t) => acc + (t?.durationSec ?? 0), 0);

    // Atomically install the new runway BEFORE any audio change. This
    // closes the bug where the renderer briefly saw a null runway
    // (live view cleared) while a stale `musicPlayback.positionSec`
    // tricked advanceMusic into either skipping a track or firing the
    // "post-service last track ended" branch on the new runway —
    // depending on how far the user had fast-forwarded the OLD playlist.
    //
    // Setting the runway first means every subsequent tick sees the
    // NEW playlist's trackIds + currentTrackIndex=0, and the playback
    // guard in advanceMusic ignores any lingering OLD playback state.
    // A change_setlist is a clean break — the new playlist is its
    // own context. Don't inherit originServiceId from the previous
    // runway, otherwise the per-service post-action override would
    // resolve again for the swapped-to playlist and re-fire the same
    // sequence's actions (anchored to the new musicStartMs). The
    // resolver falls back to whatever the new playlist itself defines.
    this.swapInProgress = true;
    state.setCurrentRunway({
      serviceId: null,
      originServiceId: undefined,
      trackIds: validTrackIds,
      totalSec,
      landInKey: undefined,
      plannedStartTime: undefined,
      startOffsetSec: 0,
      targetMs: 0,
      musicStartMs: Date.now(),
      padStartMs: 0,
      transitionMode: targetPlaylist.transitionMode,
      crossfadeSec: state.config.defaults.crossfadeSec ?? targetPlaylist.crossfadeSec,
      padBridgeSec: 0,
      padFadeOutSec: 0,
      tailSec: 0,
      phase: 'music',
      currentTrackIndex: 0,
      isPostService: true,
      sourcePlaylistId: targetPlaylist.id,
    });

    // Crossfade old → new. Uses a single audio path that ramps OLD's
    // gain to 0 while ramping NEW's from 0 to 1 over fadeOutSec, and
    // sets engine.currentMusic to the new source atomically. Falls back
    // to playMusic if there's no current source (e.g. audio was
    // already silent before the action fired).
    const fade = Math.max(0.1, fadeOutSec);
    try {
      await this.audio.crossfadeToMusic(firstTrack.filePath, {
        crossfadeSec: fade,
        trackId: firstTrack.id,
        startAtSec: firstTrack.trimStartSec,
        endAtSec: firstTrack.trimEndSec,
        fadeOutSec: firstTrack.editFadeOutSec,
      });
      console.log('[change_setlist] swap complete →', targetPlaylist.name);
      if (skipped > 0) {
        this.notifyActionError?.(
          `change_setlist: skipped ${skipped} track${skipped === 1 ? '' : 's'} missing from library — re-import "${targetPlaylist.name}".`,
        );
      }
    } catch (err) {
      console.error('[change_setlist] swap audio failed', err);
      this.notifyActionError?.(`change_setlist: audio failed to start "${targetPlaylist.name}"`);
      // Audio swap failed mid-flight — clear the runway so the UI
      // doesn't sit on a playlist that isn't actually playing.
      state.setCurrentRunway(null);
    } finally {
      this.swapInProgress = false;
    }
  }

  /** Set during a swapToPlaylist crossfade so advanceMusic skips its
   *  transition logic until the audio engine has caught up to the new
   *  runway. Without this guard, a stale `musicPlayback` pointing at
   *  the old track could trigger track-advance or post-service-end on
   *  the new runway in the same tick the swap completes. */
  private swapInProgress = false;

  /** Hook for surfacing action-firing errors to the LiveView toast. Set
   *  by LiveView via setActionErrorHandler so panic/post-service errors
   *  use the same surface. */
  private notifyActionError?: (msg: string) => void;
  setActionErrorHandler(fn: ((msg: string) => void) | undefined) {
    this.notifyActionError = fn;
  }

  private jumpToTrack(trackId: string): void {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.phase !== 'music') return;
    const idx = runway.trackIds.indexOf(trackId);
    if (idx < 0) return;
    void this.clickTimeline(idx, 0);
  }

  private async beginMusic() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway || runway.trackIds.length === 0) return;

    // Skip into the runway by `lateSec` wall-clock seconds. Two complications
    // the walk has to handle correctly so the anchor lands at its marker:
    //  - Head trim (startOffsetSec) shortens the FIRST track's wall-clock
    //    contribution by that many seconds.
    //  - Crossfade overlap shortens every non-last track's contribution by
    //    crossfadeSec (the next track starts that many seconds before this
    //    one ends). Walking by raw effDur (gapless arithmetic) skips too
    //    little into the runway and lands music N*crossfade seconds late.
    const lateSec = Math.max(0, (Date.now() - runway.musicStartMs) / 1000);
    const startOff = runway.startOffsetSec || 0;
    const xfade = runway.transitionMode === 'crossfade' ? (runway.crossfadeSec ?? 0) : 0;
    let trackIndex = 0;
    let trackOffset = 0;
    let cumWallclock = 0;
    for (let i = 0; i < runway.trackIds.length; i++) {
      const t = state.config.tracks.find(tr => tr.id === runway.trackIds[i]);
      if (!t) continue;
      const effDur = effectiveDuration(t);
      const isLast = i === runway.trackIds.length - 1;
      const headTrim = i === 0 ? startOff : 0;
      const tailCrossfade = isLast ? 0 : xfade;
      const wallclockContribution = Math.max(0, effDur - headTrim - tailCrossfade);
      if (cumWallclock + wallclockContribution > lateSec) {
        trackIndex = i;
        const wallclockInto = lateSec - cumWallclock;
        // Audible offset within this track:
        //  - First track: head-trim already skipped, plus wallclock-elapsed since start
        //  - Later tracks: started at audible 0, so offset = wallclock since start
        trackOffset = headTrim + wallclockInto;
        break;
      }
      cumWallclock += wallclockContribution;
    }

    state.patchCurrentRunway({ phase: 'music', currentTrackIndex: trackIndex });
    if (runway.serviceId) state.setServiceStatus(runway.serviceId, 'live');

    const startTrackId = runway.trackIds[trackIndex];
    const track = state.config.tracks.find(t => t.id === startTrackId);
    if (!track) return;

    console.log('[beginMusic] starting', {
      serviceId: runway.serviceId,
      lateSec: +lateSec.toFixed(2),
      trackIndex,
      trackOffset: +trackOffset.toFixed(2),
      trackCount: runway.trackIds.length,
      msUntilService: runway.targetMs - Date.now(),
      msUntilPad: runway.padStartMs - Date.now(),
    });

    // First-track fade-in. The configured `musicFadeInSec` is the canonical
    // value and applies to every fresh start (normal arm OR "start early &
    // fill"). Track-specific edit fade-ins still win when longer (the user
    // shaped the track's intro deliberately in the Editor).
    const configuredFadeIn = state.config.defaults.musicFadeInSec ?? 0;
    const trackEditFadeIn = track.editFadeInSec ?? 0;
    const fadeInSec = Math.max(configuredFadeIn, trackEditFadeIn);

    this.startingTrackIndex = trackIndex;
    try {
      // Pre-service runways (real services and rehearsals targeting a future
      // service time) use Web Audio's precise scheduling — every transition
      // is pre-committed to ctx.currentTime + N up front, so tick granularity
      // and decode latency can't drift the runway end. Post-service runways
      // and quick-play stay on the reactive playMusic + advanceMusic path
      // since the operator typically skips/scrubs in those modes.
      const useScheduled = runway.serviceId !== null && !runway.isPostService;
      if (useScheduled) {
        const tracksToSchedule = runway.trackIds.slice(trackIndex).map(id => {
          const t = state.config.tracks.find(tr => tr.id === id);
          if (!t) return null;
          return {
            filePath: t.filePath,
            trackId: t.id,
            trimStartSec: t.trimStartSec,
            trimEndSec: t.trimEndSec,
            fadeOutSec: t.editFadeOutSec,
          };
        }).filter((x): x is NonNullable<typeof x> => x !== null);
        await this.audio.scheduleRunway({
          tracks: tracksToSchedule,
          crossfadeSec: runway.transitionMode === 'crossfade' ? (runway.crossfadeSec ?? 0) : 0,
          firstTrackOffsetSec: trackOffset,
          // Pass the configured fade-in unconditionally. The previous
          // `trackOffset === 0 ? fadeInSec : 0` gate silently dropped
          // the fade whenever beginMusic kicked in even slightly late
          // (the action-driven arm_playlist swap is exactly this case:
          // preload + tick lag produces trackOffset ~0.2s). Timing of
          // when audio starts is unchanged — the engine still honors
          // firstTrackOffsetSec for where in the track to start; this
          // just stops bypassing the fade envelope.
          musicFadeInSec: fadeInSec,
        });
      } else {
        const trimStart = track.trimStartSec ?? 0;
        await this.audio.playMusic(track.filePath, {
          trackId: track.id,
          fadeInSec,
          startAtSec: trimStart + trackOffset,
          endAtSec: track.trimEndSec,
          segmentStartSec: trimStart,
          fadeOutSec: track.editFadeOutSec,
        });
      }
    } finally {
      this.startingTrackIndex = null;
    }
  }

  private async startTrack(index: number) {
    if (this.startingTrackIndex === index) return;
    this.startingTrackIndex = index;
    try {
      const state = this.store.getState();
      const runway = state.currentRunway;
      if (!runway) return;
      const trackId = runway.trackIds[index];
      const track = state.config.tracks.find(t => t.id === trackId);
      if (!track) return;

      const trim = {
        startAtSec: track.trimStartSec,
        endAtSec: track.trimEndSec,
        fadeOutSec: track.editFadeOutSec,
      };
      if (index === 0) {
        await this.audio.playMusic(track.filePath, {
          trackId: track.id,
          fadeInSec: track.editFadeInSec ?? 0,
          ...trim,
        });
      } else if (runway.transitionMode === 'crossfade') {
        await this.audio.crossfadeToMusic(track.filePath, {
          crossfadeSec: runway.crossfadeSec,
          trackId: track.id,
          ...trim,
        });
      } else {
        await this.audio.playMusic(track.filePath, {
          trackId: track.id,
          fadeInSec: track.editFadeInSec ?? 0,
          ...trim,
        });
      }
    } finally {
      this.startingTrackIndex = null;
    }
  }

  private advanceMusic(now: number) {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway) return;
    // Stay out of the way during a change_setlist crossfade — the new
    // runway is installed but the audio engine hasn't pushed its
    // notify yet, so musicPlayback still reflects the old track and
    // would fire spurious transitions on the new runway.
    if (this.swapInProgress) return;
    const playback = state.musicPlayback;
    const isQuickPlay = runway.serviceId === null;
    const musicFadeSec = state.config.defaults.musicFadeToPadSec ?? 5;
    const padLeadSec = state.config.defaults.padLeadInSec ?? 5;

    const isLastTrack = runway.currentTrackIndex >= runway.trackIds.length - 1;

    // Service mode: if we've crossed padStartMs while still in music, jump to pad.
    if (!isQuickPlay && now >= runway.padStartMs && isLastTrack) {
      this.beginPad();
      return;
    }

    // Pre-service runways use the precise-scheduled audio engine path —
    // every transition is committed to ctx.currentTime up front, so
    // advanceMusic should NOT trigger crossfadeToMusic here. We only sync
    // currentTrackIndex from the engine's reported current track so the UI
    // and resolveSequence keep up.
    const useScheduled = runway.serviceId !== null && !runway.isPostService;
    if (useScheduled) {
      const engineTrackId = playback.trackId;
      if (engineTrackId) {
        const engineIdx = runway.trackIds.indexOf(engineTrackId);
        if (engineIdx >= 0 && engineIdx !== runway.currentTrackIndex) {
          state.patchCurrentRunway({ currentTrackIndex: engineIdx });
        }
      }
      return;
    }

    if (!playback.isPlaying || playback.durationSec === 0) return;
    // Cross-check: the audio engine's reported trackId must match the
    // track the runway thinks is playing. A mismatch means we're
    // mid-swap or mid-startTrack and the position numbers belong to a
    // *different* track than the runway pointer — using them to make
    // transition decisions would either double-skip a track or mark
    // the runway "ended" against the wrong playlist's last index.
    const expectedTrackId = runway.trackIds[runway.currentTrackIndex];
    if (playback.trackId && expectedTrackId && playback.trackId !== expectedTrackId) {
      return;
    }

    const remaining = playback.durationSec - playback.positionSec;
    // Last-track fade window = padLeadSec + musicFadeSec so the pad starts pre-rolling
    // before the music begins fading and is up by the time the song ends.
    const fadeWindow = isLastTrack
      ? (padLeadSec + musicFadeSec)
      : (runway.transitionMode === 'crossfade' ? runway.crossfadeSec : 0.2);

    if (remaining <= fadeWindow) {
      if (isLastTrack) {
        if (runway.isPostService) {
          // If a runway-mutating action (arm_playlist / change_setlist)
          // is scheduled to fire at or near the natural end of this
          // last track, hold off — the action will take over the
          // runway transition (e.g. swap into the next service's pre-
          // service playlist as music-to-fill). Tearing down here
          // would clear currentRunway before fireDueActions can dispatch
          // the action, leaving the operator with silence + no follow-up
          // pre-service.
          if (this.isPostServiceActionImminent(state, runway, now, remaining)) {
            return;
          }
          // No follow-up action — fade out and clear.
          this.audio.fadeOutMusic(Math.max(1, runway.crossfadeSec || 2));
          state.setCurrentRunway(null);
        } else if (isQuickPlay) {
          void this.beginQuickPlayPad();
        } else {
          this.beginPad();
        }
      } else {
        const nextIndex = runway.currentTrackIndex + 1;
        // Don't advance into the next track if a change_setlist action
        // is queued to fire before that track's natural end. Otherwise
        // a sliver of the wrong-playlist next track audibly starts
        // before the swap kicks in. Holding here lets the OLD track
        // fade out naturally and the swap's crossfade ramp the new
        // playlist's first track in cleanly.
        if (this.isChangeSetlistImminent(state, runway, now, nextIndex)) {
          return;
        }
        state.patchCurrentRunway({ currentTrackIndex: nextIndex });
        void this.startTrack(nextIndex);
      }
    }
  }

  /**
   * Look-ahead for advanceMusic. Returns true if the resolved action
   * sequence has a runway-mutating action (change_setlist /
   * arm_playlist) that will fire before the natural end of
   * `prospectiveNextIndex`. Holding the current track until the action
   * fires keeps the OLD playlist from briefly bleeding the wrong
   * next-track audio before the swap.
   */
  /**
   * Look-ahead for the post-service end-of-playlist branch. Returns true
   * if the resolved action sequence has a runway-mutating action
   * (arm_playlist / change_setlist) scheduled to fire at or near the
   * natural end of the current (last) track. When true, advanceMusic
   * holds the runway alive instead of tearing it down so fireDueActions
   * can dispatch the action — typically swapping into the next service's
   * pre-service music as a "fill" runway between services.
   *
   * Without this, post-service's fade window (which starts seconds
   * before the natural end) tears down currentRunway before
   * fireDueActions sees the action's fire time, leaving the operator
   * with silence between services and no auto-transition.
   */
  private isPostServiceActionImminent(
    state: ReturnType<Store['getState']>,
    runway: NonNullable<ReturnType<Store['getState']>['currentRunway']>,
    now: number,
    remainingSec: number,
  ): boolean {
    const seq = this.resolveSequence(state, runway);
    if (!seq) return false;
    // Action's fireAt is at the playlist's natural end; remaining is
    // how much audio is left. Add a small grace (1s) so the action
    // counts as "imminent" even if fire-time lands a hair after the
    // computed end (rounding in cumDuration vs the engine's report).
    const horizonMs = now + Math.max(0, remainingSec * 1000) + 1000;
    for (const action of seq.actions) {
      if (!action.enabled) continue;
      if (this.firedActionIds.has(action.id)) continue;
      const isTruncator = action.payload.type === 'change_setlist' || action.payload.type === 'arm_playlist';
      if (!isTruncator) continue;
      const fireAt = resolveActionFireMs(action, seq.anchor, runway, state.config.tracks);
      if (fireAt == null) continue;
      if (fireAt <= horizonMs) return true;
    }
    return false;
  }

  private isChangeSetlistImminent(
    state: ReturnType<Store['getState']>,
    runway: NonNullable<ReturnType<Store['getState']>['currentRunway']>,
    now: number,
    prospectiveNextIndex: number,
  ): boolean {
    const seq = this.resolveSequence(state, runway);
    if (!seq) return false;
    const nextTrackId = runway.trackIds[prospectiveNextIndex];
    const nextTrack = state.config.tracks.find(t => t.id === nextTrackId);
    if (!nextTrack) return false;
    const nextDurMs = effectiveDuration(nextTrack) * 1000;
    const horizonMs = now + nextDurMs;
    for (const action of seq.actions) {
      if (!action.enabled) continue;
      if (this.firedActionIds.has(action.id)) continue;
      const isTruncator = action.payload.type === 'change_setlist' || action.payload.type === 'arm_playlist';
      if (!isTruncator) continue;
      const fireAt = resolveActionFireMs(action, seq.anchor, runway, state.config.tracks);
      if (fireAt == null) continue;
      if (fireAt <= horizonMs) {
        return true;
      }
    }
    return false;
  }

  /**
   * Quick Play pad bridge — bridges into the pad keyed off the last track's key.
   * Plays indefinitely until the user stops it (no scheduled fadeOut, no service target).
   */
  private async beginQuickPlayPad() {
    if (this.padStarting) return;
    this.padStarting = true;
    try {
      const state = this.store.getState();
      const runway = state.currentRunway;
      if (!runway) return;

      const lastIdx = runway.trackIds.length - 1;
      const lastTrackId = runway.trackIds[lastIdx];
      const lastTrack = state.config.tracks.find(t => t.id === lastTrackId);
      const padKey = lastTrack?.key;

      // Exact key → compatible (Camelot) → any mapped pad → silence.
      let padFile: PadFile | undefined;
      if (padKey) {
        padFile = state.config.pads.find(p => p.key === padKey);
        if (!padFile) {
          const compats = compatibleKeys(padKey);
          for (const k of compats) {
            const candidate = state.config.pads.find(p => p.key === k);
            if (candidate) { padFile = candidate; break; }
          }
        }
      }
      if (!padFile && state.config.pads.length > 0) padFile = state.config.pads[0];

      state.patchCurrentRunway({ phase: 'pad', landInKey: padKey });

      if (padFile) {
        // Quick Play pad layout:
        //   - padLeadSec: pad fades in BEFORE music starts fading
        //   - musicFadeSec: music fade-out (starts after pad lead-in)
        //   - holdSec (= padBridgeSec): pad sits at full level (after music end)
        //   - fadeOutSec (= padFadeOutSec): pad fades to silence
        const defaults = state.config.defaults;
        const padLeadSec = Math.max(0.5, defaults.padLeadInSec ?? 5);
        const musicFadeSec = Math.max(0.5, defaults.musicFadeToPadSec ?? 5);
        const holdSec = Math.max(0, runway.padBridgeSec || 0);
        const fadeOutSec = Math.max(0.5, runway.padFadeOutSec || 0);

        await this.audio.playPad(padFile.filePath, { fadeInSec: padLeadSec, loop: true });
        if (padKey && lastTrack?.key) {
          state.setPadArmedKey(lastTrack.key);
        }
        window.setTimeout(() => {
          const cur = this.store.getState().currentRunway;
          if (!cur || cur.serviceId !== null) return;
          this.audio.fadeOutMusic(musicFadeSec);
        }, padLeadSec * 1000);

        // Schedule pad fade-out + cleanup.
        const runwayId = lastTrackId;
        const fadeAtMs = (padLeadSec + musicFadeSec + holdSec) * 1000;
        window.setTimeout(() => {
          const cur = this.store.getState().currentRunway;
          if (!cur || cur.serviceId !== null || cur.trackIds[cur.trackIds.length - 1] !== runwayId) return;
          this.audio.fadeOutPad(fadeOutSec);
          window.setTimeout(() => {
            const cur2 = this.store.getState().currentRunway;
            if (cur2 && cur2.serviceId === null && cur2.trackIds[cur2.trackIds.length - 1] === runwayId) {
              this.store.getState().setCurrentRunway(null);
            }
          }, fadeOutSec * 1000 + 100);
        }, fadeAtMs);
      } else {
        // No pads mapped at all — just fade out music and stop.
        this.audio.fadeOutMusic(2);
        state.setCurrentRunway(null);
      }
    } finally {
      this.padStarting = false;
    }
  }

  private async beginPad() {
    if (this.padStarting) return;
    this.padStarting = true;
    try {
      const state = this.store.getState();
      const runway = state.currentRunway;
      if (!runway) return;

      console.log('[beginPad] starting', {
        serviceId: runway.serviceId,
        landInKey: runway.landInKey,
        msUntilService: runway.targetMs - Date.now(),
      });

      state.patchCurrentRunway({ phase: 'pad' });

      // Skip the pad bridge entirely when either:
      //   - the user has set disablePadBridge on the service, or
      //   - this arm auto-disabled it because the anchor's key didn't
      //     match the requested key (avoids a wrong-key pad).
      // In both cases, fade music to land at service start and mark complete.
      const sourceService = runway.serviceId
        ? state.config.services.find(s => s.id === runway.serviceId)
        : undefined;
      if (sourceService?.disablePadBridge || runway.skipPadBridge) {
        const targetMs = runway.targetMs;
        const serviceId = runway.serviceId;
        // Defer to the track's own editFadeOutSec when EITHER:
        //  - the anchor has a tail (editServiceLandSec) — song carries
        //    past timer-zero with its own fade tail
        //  - the anchor has an editFadeOutSec set — engine schedules it
        //    on the last track, controller skips its external fade so
        //    they don't compound.
        // Without either, pull the music down externally so it still
        // lands silent at targetMs (prior behaviour).
        const anchorTrackId = runway.trackIds[runway.trackIds.length - 1];
        const anchorTrack = anchorTrackId
          ? state.config.tracks.find(tr => tr.id === anchorTrackId)
          : undefined;
        const anchorHasOwnFade = (anchorTrack?.editFadeOutSec ?? 0) > 0;
        const skipControllerFade = (runway.tailSec ?? 0) > 0 || anchorHasOwnFade;
        if (!skipControllerFade) {
          const remainingSec = Math.max(0.5, (targetMs - Date.now()) / 1000);
          this.audio.fadeOutMusic(remainingSec);
        }
        const completeDelay = Math.max(0, targetMs - Date.now());
        window.setTimeout(() => {
          if (!serviceId) return;
          const cur = this.store.getState().currentRunway;
          if (cur?.serviceId !== serviceId) return;
          this.store.getState().setServiceStatus(serviceId, 'completed');
          const svc = this.store.getState().config.services.find(s => s.id === serviceId);
          if (svc?.isRehearsal) this.store.getState().deleteService(serviceId);
          this.store.getState().setCurrentRunway(null);
        }, completeDelay);
        return;
      }

      // Try exact match first, then any compatible key (Camelot-adjacent).
      let padFile: PadFile | undefined;
      if (runway.landInKey) {
        padFile = state.config.pads.find(p => p.key === runway.landInKey);
        if (!padFile) {
          const compats = compatibleKeys(runway.landInKey);
          for (const k of compats) {
            const candidate = state.config.pads.find(p => p.key === k);
            if (candidate) { padFile = candidate; break; }
          }
        }
      }
      // Last resort: any mapped pad rather than dead silence.
      if (!padFile && state.config.pads.length > 0) {
        padFile = state.config.pads[0];
      }

      const musicFadeSec = state.config.defaults.musicFadeToPadSec ?? 5;
      const padLeadSec = state.config.defaults.padLeadInSec ?? 5;
      const holdSec = Math.max(0, runway.padBridgeSec || 0);
      const fadeOutSec = Math.max(0.5, runway.padFadeOutSec || 0);
      const targetMs = runway.targetMs;
      const serviceId = runway.serviceId;

      if (padFile) {
        // 1) Pad fades in first, while music is still at full level.
        // 2) After padLeadSec the music starts fading out (over musicFadeSec).
        // 3) Both line up at music end (= service start).
        // Skip the controller's external music fade when EITHER:
        //   - the anchor has a tail (editServiceLandSec) — track plays
        //     past targetMs and its own editFadeOutSec handles the end
        //   - the anchor has an editFadeOutSec set — that operator
        //     fade is now scheduled at the engine level by
        //     scheduleRunway; layering an external fadeOutMusic on top
        //     would compound the gain ramps and alter the shape
        const anchorTrackId = runway.trackIds[runway.trackIds.length - 1];
        const anchorTrack = anchorTrackId
          ? state.config.tracks.find(tr => tr.id === anchorTrackId)
          : undefined;
        const anchorHasOwnFade = (anchorTrack?.editFadeOutSec ?? 0) > 0;
        const skipControllerFade = (runway.tailSec ?? 0) > 0 || anchorHasOwnFade;
        await this.audio.playPad(padFile.filePath, { fadeInSec: padLeadSec, loop: true });
        if (!skipControllerFade) {
          window.setTimeout(() => {
            if (this.store.getState().currentRunway?.serviceId !== serviceId) return;
            this.audio.fadeOutMusic(musicFadeSec);
          }, padLeadSec * 1000);
        }

        // At service start (= music end), mark the service completed so the
        // schedule UI advances. Pad continues to play past service start.
        const completeDelay = Math.max(0, targetMs - Date.now());
        window.setTimeout(() => {
          if (!serviceId) return;
          const cur = this.store.getState().currentRunway;
          if (cur?.serviceId !== serviceId) return;
          this.store.getState().setServiceStatus(serviceId, 'completed');
        }, completeDelay);

        // Pad holds for `holdSec` past service start, then fades out.
        const padFadeStartMs = targetMs + holdSec * 1000;
        const fadeDelay = Math.max(0, padFadeStartMs - Date.now());
        window.setTimeout(() => {
          if (!serviceId) return;
          const cur = this.store.getState().currentRunway;
          if (cur?.serviceId !== serviceId) return;
          this.audio.fadeOutPad(fadeOutSec);

          // Cleanup after the fade completes.
          window.setTimeout(() => {
            const cur2 = this.store.getState().currentRunway;
            if (cur2?.serviceId !== serviceId) return;
            const svc = this.store.getState().config.services.find(s => s.id === serviceId);
            if (svc?.isRehearsal) {
              this.store.getState().deleteService(serviceId);
            }
            this.store.getState().setCurrentRunway(null);
          }, fadeOutSec * 1000 + 100);
        }, fadeDelay);
      } else {
        // No pad mapped — fade music to land at service start, then complete.
        const remainingSec = Math.max(0.5, (targetMs - Date.now()) / 1000);
        this.audio.fadeOutMusic(remainingSec);
        const completeDelay = Math.max(0, targetMs - Date.now());
        window.setTimeout(() => {
          if (!serviceId) return;
          const cur = this.store.getState().currentRunway;
          if (cur?.serviceId !== serviceId) return;
          this.store.getState().setServiceStatus(serviceId, 'completed');
          const svc = this.store.getState().config.services.find(s => s.id === serviceId);
          if (svc?.isRehearsal) this.store.getState().deleteService(serviceId);
          this.store.getState().setCurrentRunway(null);
        }, completeDelay);
      }
    } finally {
      this.padStarting = false;
    }
  }

  private completeService() {
    const state = this.store.getState();
    const runway = state.currentRunway;
    if (!runway) return;

    state.patchCurrentRunway({ phase: 'done' });
    if (runway.serviceId) {
      state.setServiceStatus(runway.serviceId, 'completed');
      // Rehearsal services auto-clean so they don't pile up in the schedule.
      const service = state.config.services.find(s => s.id === runway.serviceId);
      if (service?.isRehearsal) {
        state.deleteService(runway.serviceId);
      }
    }

    state.setCurrentRunway(null);
  }
}

/** Fisher-Yates — copy then shuffle so the input array isn't mutated. */
function shuffleTrackIds(ids: string[]): string[] {
  const out = ids.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
