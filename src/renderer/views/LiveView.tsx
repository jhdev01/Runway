import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { CountdownClock } from '../components/CountdownClock';
import { SubCountdown } from '../components/SubCountdown';
import { MasterFaderPanel } from '../components/MasterFaderPanel';
import { BusLevelMeters } from '../components/BusLevelMeters';
import { PadPlayerPanel } from '../components/PadPlayerPanel';
import { MusicCrossfadePanel } from '../components/MusicCrossfadePanel';
import { MidiLogPanel } from '../components/MidiLogPanel';
import { ScheduleSummaryPanel } from '../components/ScheduleSummaryPanel';
import { AlbumArtLightbox } from '../components/AlbumArtLightbox';
import { Tooltip } from '../components/Tooltip';
import { RehearsePanel } from '../components/RehearsePanel';
import { Toggle } from '../components/Toggle';
import { ACTION_META, describeAction, resolveActionFireMs } from '../lib/actionMeta';
import { todayISO, formatTime12h, parseTime, formatDuration } from '../lib/format';
import { keyColor } from '@shared/music';
import { effectiveDuration, resolveServiceFirstSongKey } from '@shared/types';

/** Condense an arm-error message into a short chip label. Full message is the tooltip. */
function shortArmWarning(msg: string): string {
  if (/already passed/i.test(msg)) return 'Past start time';
  if (/no usable tracks/i.test(msg)) return 'No usable tracks';
  if (/no tracks/i.test(msg)) return 'Empty playlist';
  if (/missing/i.test(msg)) return 'Missing tracks';
  if (/no pre-service playlist/i.test(msg)) return 'No playlist set';
  if (/no track in this playlist is tagged/i.test(msg)) return 'Wrong key';
  return 'Arm failed';
}

export function LiveView() {
  const services = useAppStore(s => s.config.services);
  const tracks = useAppStore(s => s.config.tracks);
  const playlists = useAppStore(s => s.config.playlists);
  const musicPlayback = useAppStore(s => s.musicPlayback);
  const fadeToPadActive = useAppStore(s => s.fadeToPadActive);
  const currentRunway = useAppStore(s => s.currentRunway);
  const armService = useAppStore(s => s.armService);
  const disarmService = useAppStore(s => s.disarmService);
  const extendServiceStart = useAppStore(s => s.extendServiceStart);
  const autoArmEnabled = useAppStore(s => s.autoArmEnabled);
  const setAutoArmEnabled = useAppStore(s => s.setAutoArmEnabled);
  const showPlayedTracks = useAppStore(s => s.config.ui?.showPlayedTracks ?? false);
  const updateConfig = useAppStore(s => s.updateConfig);
  const actionSequences = useAppStore(s => s.config.actionSequences ?? []);
  const { audio, controller } = useEngines();
  const [armError, setArmError] = useState<string | null>(null);
  // Per-button confirm flags for the time-shift buttons. Two-click pattern
  // mirrors the disarm button — first click flashes red and waits 3 s for
  // a confirming second click before actually shifting the service start.
  const [confirmAddTime, setConfirmAddTime] = useState(false);
  const [confirmSubTime, setConfirmSubTime] = useState(false);
  const addTimeTimerRef = React.useRef<number | null>(null);
  const subTimeTimerRef = React.useRef<number | null>(null);
  // Ref on the runway section so the auto-scroll effect can scope its
  // querySelector to this surface (no global DOM scan).
  const runwaySectionRef = React.useRef<HTMLElement>(null);
  // Confirm-disarm flag lives in the store so MIDI arm_toggle and the UI
  // button share state — the button turns red whether the first press came
  // from a click or a MIDI controller.
  const confirmDisarm = useAppStore(s => s.armConfirmDisarm);

  const today = todayISO();
  const todayServices = useMemo(() =>
    services.filter(s => s.date === today)
      .sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [services, today]
  );

  // Auto-pick the active service:
  //  - Future-target services are candidates (status informational)
  //  - Past-target services with status 'live' or 'queued' stay active until
  //    they're explicitly marked 'completed' (services can run for hours)
  //  - 'scheduled' status with past time → 5-min grace then drop
  //  - 'completed' → drop, next service slides in
  const activeService = useMemo(() => {
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
  }, [todayServices]);

  // The remaining (still upcoming) services after the active one — shown as
  // a read-only "next up" line, not as clickable tabs.
  const upcomingAfterActive = useMemo(() => {
    if (!activeService) return [];
    const idx = todayServices.findIndex(s => s.id === activeService.id);
    return idx >= 0 ? todayServices.slice(idx + 1) : [];
  }, [todayServices, activeService]);

  // Compute the countdown target
  const targetMs = useMemo(() => {
    if (!activeService) return 0;
    const date = new Date(activeService.date + 'T00:00:00');
    const [h, m] = activeService.startTime.split(':').map(Number);
    date.setHours(h, m, 0, 0);
    return date.getTime();
  }, [activeService]);

  // When the pre-service music actually starts firing.
  // If armed, use the runway's planned music start; otherwise fall back to
  // service start - autoStartTarget.
  const musicFireMs = useMemo(() => {
    if (!activeService || targetMs === 0) return 0;
    if (currentRunway?.serviceId === activeService.id) return currentRunway.musicStartMs;
    return targetMs - activeService.autoStartTargetSec * 1000;
  }, [activeService, targetMs, currentRunway]);

  // Track whether the runway is a rehearsal service (or Quick Test). Both
  // unlock timeline click + test controls so transitions can be tested.
  const runwayService = currentRunway?.serviceId
    ? services.find(s => s.id === currentRunway.serviceId)
    : null;
  const isTestRunway = currentRunway
    && (currentRunway.serviceId === null || runwayService?.isRehearsal === true);

  // If the runway has a queued change_setlist or arm_playlist action, the
  // visible queue + "ends in" should be truncated at the swap point —
  // tracks scheduled after the swap will never play in this leg, so
  // showing them in the count or the timeline is misleading. Applies to
  // both pre-service and post-service runways. Returns null when there's
  // no swap in this runway's sequence.
  const runwayTruncation = useMemo(() => {
    if (!currentRunway) return null;
    // Mirror serviceController.resolveSequence so per-service overrides
    // (preActionSequenceIdOverride / postActionSequenceIdOverride / legacy
    // actionSequenceIdOverride) win over the playlist's default.
    const lookupServiceId = currentRunway.serviceId ?? currentRunway.originServiceId ?? null;
    const isPost = !!currentRunway.isPostService;
    let seqId: string | undefined;
    if (lookupServiceId) {
      const svc = services.find(s => s.id === lookupServiceId);
      const specific = isPost ? svc?.postActionSequenceIdOverride : svc?.preActionSequenceIdOverride;
      const ovr = specific !== undefined ? specific : (isPost ? undefined : svc?.actionSequenceIdOverride);
      if (ovr === '') return null;
      if (ovr) seqId = ovr;
    }
    if (!seqId) {
      const playlistId = currentRunway.sourcePlaylistId;
      const playlist = playlistId ? playlists.find(p => p.id === playlistId) : undefined;
      seqId = playlist?.actionSequenceId;
    }
    if (!seqId) return null;
    const seq = actionSequences.find(s => s.id === seqId);
    if (!seq) return null;
    // Both change_setlist (post-service swap) and arm_playlist (pre-service
    // arm with a different playlist) terminate the current runway at the
    // action's fire point. Even an action with no playlist configured
    // still truncates — it just ends the runway with no follow-on audio.
    let earliest: {
      fireMs: number;
      targetId: string;
      targetName: string;
      fadeOutSec: number;
      missing: boolean;
    } | null = null;
    for (const a of seq.actions) {
      if (!a.enabled) continue;
      if (a.payload.type !== 'change_setlist' && a.payload.type !== 'arm_playlist') continue;
      const payload = a.payload;
      const fireMs = resolveActionFireMs(a, seq.anchor, currentRunway, tracks);
      if (fireMs == null) continue;
      if (!earliest || fireMs < earliest.fireMs) {
        const target = payload.playlistId
          ? playlists.find(p => p.id === payload.playlistId)
          : undefined;
        const missing = !payload.playlistId || (!target && !payload.playlistName);
        earliest = {
          fireMs,
          targetId: payload.playlistId,
          targetName: target?.name ?? payload.playlistName ?? '(no playlist set in action)',
          fadeOutSec: payload.fadeOutSec,
          missing,
        };
      }
    }
    if (!earliest) return null;
    // Walk the runway's tracks and keep only those whose start time is
    // strictly before the swap fire time. Mirrors resolveActionFireMs's
    // first-track-trim accounting (startOffsetSec only applies to track
    // index >= 1).
    const startOff = currentRunway.startOffsetSec ?? 0;
    let cumSec = 0;
    const visibleTrackIds: string[] = [];
    for (let i = 0; i < currentRunway.trackIds.length; i++) {
      const t = tracks.find(tr => tr.id === currentRunway.trackIds[i]);
      const adj = i >= 1 ? startOff : 0;
      const startMs = currentRunway.musicStartMs + (cumSec - adj) * 1000;
      if (startMs >= earliest.fireMs) break;
      visibleTrackIds.push(currentRunway.trackIds[i]);
      cumSec += t ? effectiveDuration(t) : 0;
    }
    const effectiveTotalSec = Math.max(0, (earliest.fireMs - currentRunway.musicStartMs) / 1000);
    return {
      fireMs: earliest.fireMs,
      swapToPlaylistId: earliest.targetId,
      swapToPlaylistName: earliest.targetName,
      missing: earliest.missing,
      visibleTrackIds,
      effectiveTotalSec,
    };
  }, [currentRunway, playlists, actionSequences, tracks, services]);

  // Estimated time remaining in the post-service playlist — current track's
  // remaining duration plus any unplayed tracks after it. When a swap is
  // queued, end at the swap fire time so the operator sees how long the
  // *current* leg has, not the total of stuff that won't play.
  //
  // Stale-playback guard: just after a change_setlist swap, currentRunway
  // points at the NEW playlist but musicPlayback is briefly still showing
  // the OLD track (audio engine notify hasn't propagated yet). Detect
  // mismatch via trackId and fall back to the new track's full duration
  // so the pill doesn't display the wrong "ends in" for ~100 ms.
  const postServiceEndMs = useMemo(() => {
    if (!currentRunway?.isPostService) return 0;
    if (runwayTruncation) return runwayTruncation.fireMs;
    const idx = currentRunway.currentTrackIndex;
    const expectedTrackId = currentRunway.trackIds[idx];
    const isStale = !!musicPlayback.trackId && musicPlayback.trackId !== expectedTrackId;
    const currentTrack = tracks.find(t => t.id === expectedTrackId);
    let remainingSec = isStale
      ? (currentTrack ? effectiveDuration(currentTrack) : 0)
      : Math.max(0, musicPlayback.durationSec - musicPlayback.positionSec);
    for (let i = idx + 1; i < currentRunway.trackIds.length; i++) {
      const t = tracks.find(tr => tr.id === currentRunway.trackIds[i]);
      remainingSec += t?.durationSec ?? 0;
    }
    return Date.now() + remainingSec * 1000;
  }, [currentRunway, musicPlayback.positionSec, musicPlayback.durationSec, musicPlayback.trackId, tracks, runwayTruncation]);

  const playlistInUse = currentRunway
    ? playlists.find(p => p.id === currentRunway.sourcePlaylistId)
      ?? playlists.find(p => p.id === activeService?.preServicePlaylistId)
    : null;

  // Wall-clock when the pad fully fades out: targetMs + padBridgeSec (hold)
  // + padFadeOutSec (the fade itself). Used to drive a "Pad off in X"
  // countdown that's visible after the timer hits 0:00 so the operator
  // knows the pad's still on but about to clear.
  const padOffMs = useMemo(() => {
    if (!currentRunway || currentRunway.isPostService) return 0;
    if (currentRunway.skipPadBridge) return 0;
    const tail = (currentRunway.padBridgeSec || 0) + (currentRunway.padFadeOutSec || 0);
    if (tail <= 0) return 0;
    return currentRunway.targetMs + tail * 1000;
  }, [currentRunway]);

  // Drive the pad progress fill — ticks 5×/sec while the pad is in play.
  // Only mounted-active during the pad phase so we don't waste cycles
  // re-rendering during pre-service music.
  const padPhaseActive = currentRunway?.phase === 'pad' && padOffMs > Date.now();
  const [padTick, setPadTick] = useState(0);
  useEffect(() => {
    if (!padPhaseActive) return;
    const id = window.setInterval(() => setPadTick(t => t + 1), 200);
    return () => window.clearInterval(id);
  }, [padPhaseActive]);
  // Fraction (0..1) of the pad's total lifecycle that has elapsed.
  // Lifecycle = padLeadSec (fade-in) + padBridgeSec (hold) + padFadeOutSec
  // (fade-out). Calculated against wall-clock targetMs since that's the
  // anchor everything else lines up against. Returns 0 outside pad phase.
  const padProgressPct = useMemo(() => {
    void padTick; // dep — re-eval on tick
    if (!currentRunway || !padPhaseActive) return 0;
    const padLeadSec = useAppStore.getState().config.defaults.padLeadInSec ?? 5;
    const startMs = currentRunway.targetMs - padLeadSec * 1000;
    const totalMs = padOffMs - startMs;
    if (totalMs <= 0) return 0;
    const elapsedMs = Date.now() - startMs;
    return Math.max(0, Math.min(100, (elapsedMs / totalMs) * 100));
  }, [currentRunway, padOffMs, padPhaseActive, padTick]);

  // Resolve the Action Sequence the engine is firing for the current
  // runway + compute each action's wall-clock fire time. Mirrors the
  // controller's resolveSequence + fireDueActions logic so the markers
  // line up with what's actually scheduled to fire. Must stay in sync
  // with serviceController.resolveSequence — both must check the
  // per-service pre/post override fields, fall back to the legacy
  // single-field override (pre only), and finally to the playlist's
  // default sequence. Post-service runways look up the override on
  // originServiceId since their own serviceId is null.
  const armedActions = useMemo(() => {
    if (!currentRunway) return [];
    let seqId: string | undefined;
    let resolvedNone = false;
    const lookupServiceId = currentRunway.serviceId ?? currentRunway.originServiceId ?? null;
    if (lookupServiceId) {
      const svc = services.find(s => s.id === lookupServiceId);
      const isPost = !!currentRunway.isPostService;
      const specific = isPost
        ? svc?.postActionSequenceIdOverride
        : svc?.preActionSequenceIdOverride;
      const ovr = specific !== undefined
        ? specific
        : (isPost ? undefined : svc?.actionSequenceIdOverride);
      if (ovr === '') resolvedNone = true;
      else if (ovr) seqId = ovr;
    }
    if (resolvedNone) return [];
    if (!seqId) {
      const playlistId = currentRunway.sourcePlaylistId;
      const pl = playlistId ? playlists.find(p => p.id === playlistId) : undefined;
      seqId = pl?.actionSequenceId;
    }
    if (!seqId) return [];
    const seq = actionSequences.find(s => s.id === seqId);
    if (!seq) return [];
    return seq.actions
      .filter(a => a.enabled)
      .map(a => {
        const fireMs = resolveActionFireMs(a, seq.anchor, currentRunway, tracks);
        return fireMs == null ? null : { action: a, fireMs };
      })
      .filter((x): x is { action: import('@shared/types').Action; fireMs: number } => !!x)
      .sort((a, b) => a.fireMs - b.fireMs);
  }, [currentRunway, services, playlists, actionSequences, tracks]);

  // Keep the array aligned with runway.trackIds — don't filter out missing
  // tracks. Otherwise click indices shift out of sync with the controller.
  // When a change_setlist swap is queued in the current sequence, only
  // expose the tracks that will actually play before the swap. Tracks
  // scheduled after the swap point will never sound in this leg, so they
  // shouldn't appear in the timeline, count, or runway header.
  const queueTracks: any[] = currentRunway
    ? (runwayTruncation
        ? runwayTruncation.visibleTrackIds.map(id => tracks.find(t => t.id === id))
        : currentRunway.trackIds.map(id => tracks.find(t => t.id === id)))
    : [];

  const isPostServiceRolling = currentRunway?.isPostService === true;

  // Post-service playlist dropdown — always available so the operator can
  // fire a post-service even when no service is on the schedule. Defaults
  // from the active service's saved playlist; user can override per session.
  const postPlaylists = useMemo(() => playlists.filter(p => p.kind === 'post'), [playlists]);
  const [chosenPostId, setChosenPostId] = useState<string>('');
  const [postPickerOpen, setPostPickerOpen] = useState(false);
  // Auto-track the active service's post-service playlist so the
  // picker matches whichever service just finished. Without this the
  // picker stays pinned to whatever was alphabetically first at app
  // launch, and operators end up firing the wrong playlist after a
  // back-to-back service rotation.
  //
  // We respect a manual override: a ref remembers the last value we
  // auto-set, and we only auto-update again when chosenPostId still
  // matches that prior auto-set (i.e., the user hasn't deliberately
  // picked something different via the chevron).
  const lastAutoPostIdRef = React.useRef<string>('');
  // Fallback when activeService is gone (past 5-min grace): use the
  // most recent past service today. This way clicking Start
  // Post-Service after First Service ended uses *First Service*'s
  // configured post-playlist instead of just whichever post-playlist
  // happens to be first in the playlists array.
  const mostRecentPastService = useMemo(() => {
    const now = Date.now();
    return todayServices
      .map(s => {
        const d = new Date(s.date + 'T00:00:00');
        const [h, m] = s.startTime.split(':').map(Number);
        d.setHours(h, m, 0, 0);
        return { svc: s, targetMs: d.getTime() };
      })
      .filter(x => x.targetMs <= now)
      .sort((a, b) => b.targetMs - a.targetMs)[0]?.svc;
  }, [todayServices]);
  useEffect(() => {
    const target = activeService?.postServicePlaylistId
      ?? mostRecentPastService?.postServicePlaylistId
      ?? postPlaylists[0]?.id
      ?? '';
    if (!target) return;
    // First-load or after the user's pick was deleted: just init.
    if (!chosenPostId || !postPlaylists.some(p => p.id === chosenPostId)) {
      setChosenPostId(target);
      lastAutoPostIdRef.current = target;
      return;
    }
    // Active service's post is already what we have. Nothing to do.
    if (chosenPostId === target) {
      lastAutoPostIdRef.current = target;
      return;
    }
    // chosenPostId differs from active's post. If the current value
    // is the one WE auto-set last time, the user hasn't manually
    // picked anything since — safe to roll forward to the new
    // service's playlist. Otherwise leave their manual pick alone.
    if (chosenPostId === lastAutoPostIdRef.current) {
      setChosenPostId(target);
      lastAutoPostIdRef.current = target;
    }
  }, [activeService?.postServicePlaylistId, mostRecentPastService?.postServicePlaylistId, postPlaylists, chosenPostId]);
  // If the picked playlist gets deleted, fall back to the first available.
  useEffect(() => {
    if (chosenPostId && !postPlaylists.some(p => p.id === chosenPostId)) {
      setChosenPostId(postPlaylists[0]?.id ?? '');
    }
  }, [postPlaylists, chosenPostId]);

  const onStartPostService = () => {
    if (isPostServiceRolling) {
      if (!confirmStopPost) {
        setConfirmStopPost(true);
        window.setTimeout(() => setConfirmStopPost(false), 3000);
        return;
      }
      const fadeSec = useAppStore.getState().config.defaults.postServiceFadeInSec ?? 4;
      controller.stopPostService(fadeSec);
      setConfirmStopPost(false);
      return;
    }
    const post = chosenPostId || activeService?.postServicePlaylistId;
    if (!post) return;
    // Pass the active service id as origin only if its start time is
    // already in the past — i.e., it's the service that just ended.
    // When 2nd Service has been auto-armed before 1st Service's
    // post-service ends, activeService points at 2nd Service (still
    // future), and using it as origin would resolve the wrong
    // service's post-action override. Letting it fall through to
    // undefined hands off to the controller's "most recent past
    // service" inference instead.
    const activeStartedMs = (() => {
      if (!activeService) return null;
      const d = new Date(activeService.date + 'T00:00:00');
      const [h, m] = activeService.startTime.split(':').map(Number);
      d.setHours(h, m, 0, 0);
      return d.getTime();
    })();
    const originServiceId = (activeStartedMs != null && activeStartedMs <= Date.now())
      ? activeService?.id
      : undefined;
    // The controller now handles the queued-runway case internally:
    // queued pre-service is cleared, auto-arm stays ON and re-fires at
    // the next service's musicFireMs (deferred while post-service rolls).
    void controller.startPostServicePlay(post, originServiceId).then(res => {
      if (!res.ok) setArmError(res.reason ?? 'Could not start post-service');
      else if (res.warning) setArmError(res.warning);
    });
  };

  // Reset confirm if post-service ends another way.
  useEffect(() => {
    if (!isPostServiceRolling) setConfirmStopPost(false);
  }, [isPostServiceRolling]);

  const [panicFlash, setPanicFlash] = useState(false);
  const [confirmStopPost, setConfirmStopPost] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const onPanic = () => {
    if (!currentRunway && !musicPlayback.isPlaying) return;
    controller.panic();
    setPanicFlash(true);
    window.setTimeout(() => setPanicFlash(false), 1500);
  };

  const isArmed = !!activeService && currentRunway?.serviceId === activeService.id;

  const onArmToggle = () => {
    setArmError(null);
    void controller.armToggle({ onArmError: (msg) => setArmError(msg) });
  };

  // Auto-arm whenever the active service shifts (or on app load) — provided the
  // user hasn't manually flipped auto-arm off this session.
  //
  // Back-to-back-services case: if a previous service's post-service is
  // still rolling, we *defer* auto-arm until the next service's
  // musicFireMs so post-service music keeps playing right up to the
  // transition. At musicFireMs we override post-service: fade its audio
  // out, arm the next service. The pre-service runway then ticks
  // queued→music on its own (musicStartMs == now).
  //
  // Quick Test / Quick Play (currentRunway && !serviceId && !isPostService)
  // is still left alone — the operator launched it manually.
  useEffect(() => {
    if (!autoArmEnabled) return;
    if (!activeService) return;
    if (currentRunway?.serviceId === activeService.id) return; // already armed
    if (currentRunway && !currentRunway.serviceId && !currentRunway.isPostService) return;

    let cancelled = false;
    const doArm = async () => {
      if (cancelled) return;
      // Re-check the guards at FIRE time, not just when the deferred
      // timer was scheduled. An arm_playlist action (or any other path)
      // can arm this same service while the timer is pending; React's
      // effect cleanup usually clears the timer, but if the timer fires
      // in the same window, a redundant armService here would install a
      // second runway while the first one's scheduleRunway is still
      // decoding — the root of the "two songs at once, runway shows one"
      // incident.
      const live = useAppStore.getState();
      if (live.currentRunway?.serviceId === activeService.id) return; // already armed
      if (live.currentRunway && !live.currentRunway.serviceId && !live.currentRunway.isPostService) return; // operator-launched Quick Play/Test
      // armService overwrites currentRunway directly, but the audio
      // engine doesn't know — any audio left rolling from the previous
      // runway (post-service track OR an unfinished pad bridge from the
      // previous service) keeps playing into the new arm. The pad case
      // was the loud bug: pad-bridge cleanup keys on
      // currentRunway.serviceId === serviceId and bails when armService
      // swaps the runway, so the pad source kept looping forever.
      // Always fade *both* buses on a bridging arm.
      const cur = live.currentRunway;
      if (cur && (cur.isPostService || cur.serviceId !== activeService.id)) {
        const cfg = useAppStore.getState().config.defaults;
        const fade = cfg.postServiceFadeInSec ?? 4;
        audio.fadeOutMusic(fade);
        audio.fadeOutPad(cfg.padFadeOutSec ?? 2);
      }
      const result = await armService(activeService.id, (filePath) => audio.loadBuffer(filePath).then(() => undefined));
      if (cancelled) return;
      if (!result.ok) setArmError(result.reason ?? null);
      else if (result.warning) setArmError(result.warning);
      else setArmError(null);
    };

    // Defer when ANY audio is currently rolling: post-service music,
    // a previous service's pad bridge, anything in 'music' or 'pad'
    // phase. Schedule the arm for musicFireMs so that audio plays
    // right up to the transition. Without this, auto-arm fires the
    // moment the previous service is marked completed (potentially
    // 30+ minutes before the next service's music should begin) and
    // overwrites the previous runway — which broke pad-bridge
    // cleanup, leaving the pad playing indefinitely.
    const cur = currentRunway;
    const audibleNow = !!cur && (
      cur.isPostService === true
      || cur.phase === 'music'
      || cur.phase === 'pad'
    );
    if (audibleNow && musicFireMs > Date.now()) {
      const delay = Math.max(0, musicFireMs - Date.now());
      const id = window.setTimeout(() => { void doArm(); }, delay);
      return () => { cancelled = true; window.clearTimeout(id); };
    }

    void doArm();
    return () => { cancelled = true; };
    // currentRunway included so the effect re-runs when audio
    // starts/ends and re-evaluates whether to arm now or defer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoArmEnabled, activeService?.id, currentRunway?.isPostService, currentRunway?.phase, currentRunway?.serviceId, musicFireMs]);

  // Clear the shared confirm flag if the runway ends (panic, completion).
  const setArmConfirmDisarm = useAppStore(s => s.setArmConfirmDisarm);
  useEffect(() => {
    if (!isArmed) setArmConfirmDisarm(false);
  }, [isArmed, setArmConfirmDisarm]);

  // Subscribe to action-engine errors (e.g. change_setlist failures) so
  // the operator sees a console-level problem in the same toast that
  // surfaces arm errors. setActionErrorHandler is idempotent — registering
  // again just replaces the callback.
  useEffect(() => {
    controller.setActionErrorHandler?.((msg) => setArmError(msg));
    return () => controller.setActionErrorHandler?.(undefined);
  }, [controller]);

  // Clear stale arm/action errors when a fresh post-service starts. A
  // refused MIDI cue ("Service runway is armed…") otherwise leaves its
  // toast on screen even after a subsequent retry succeeds and post-
  // service is actually playing. The chip then sits on the post-service
  // card and reads as if the post-service itself failed.
  const isPostServicePlaying = currentRunway?.isPostService
    && (currentRunway.phase === 'music' || currentRunway.phase === 'pad');
  useEffect(() => {
    if (isPostServicePlaying) setArmError(null);
  }, [isPostServicePlaying]);

  // Auto-center the current runway chip horizontally whenever the
  // playing track changes — including when the operator clicks a
  // played-track chip in post-service. Without this the chip can
  // sit offscreen if past tracks are visible (or a long runway has
  // scrolled past the current). Trigger key includes both
  // currentTrackIndex AND musicPlayback.trackId so manual seeks
  // (clicking a played chip during post-service) re-center too.
  const currentChipKey = `${currentRunway?.currentTrackIndex ?? -1}|${musicPlayback.trackId ?? ''}`;
  useEffect(() => {
    const section = runwaySectionRef.current;
    if (!section) return;
    // Defer to next frame so the new `.current` class has been
    // applied by React before we query for it.
    const id = requestAnimationFrame(() => {
      const el = section.querySelector('.timeline-segment.current') as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [currentChipKey]);


  return (
    <div className="live-view">

      <main className="stage">

        {/* Active service header — automatically advances when one completes. */}
        <div className="service-header">
          {todayServices.length === 0 ? (
            <div className="service-header-active">
              <span style={{ color: 'var(--text-faint)', fontSize: 14 }}>
                No services scheduled today. Set one up in the Schedule tab.
              </span>
              <button
                className="arm-toggle arm-toggle-compact"
                onClick={onArmToggle}
                data-armed={autoArmEnabled ? 'true' : 'false'}
                title="Master auto-arm switch — when on, services auto-arm as they become active"
              >
                <span className="arm-toggle-dot" aria-hidden />
                Auto-arm: {autoArmEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ) : !activeService ? (
            <div className="service-header-active">
              <span style={{ color: 'var(--text-faint)', fontSize: 14 }}>
                All of today's services have completed.
              </span>
              <button
                className="arm-toggle arm-toggle-compact"
                onClick={onArmToggle}
                data-armed={autoArmEnabled ? 'true' : 'false'}
                title="Master auto-arm switch — when on, services auto-arm as they become active"
              >
                <span className="arm-toggle-dot" aria-hidden />
                Auto-arm: {autoArmEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ) : activeService ? (
            <>
              <div className="service-header-active">
                <span className="service-header-time">
                  {activeService.name
                    ? `${activeService.name} · ${formatTime12h(parseTime(activeService.startTime))}`
                    : formatTime12h(parseTime(activeService.startTime))}
                </span>
                {(() => {
                  const displayStatus = activeService.status === 'completed' && targetMs > Date.now()
                    ? 'scheduled'
                    : activeService.status;
                  const armed = currentRunway?.serviceId === activeService.id;
                  return (
                    <span className={`service-header-status ${displayStatus === 'queued' || displayStatus === 'live' ? 'queued' : ''}`}>
                      {armed ? 'ARMED' : displayStatus.toUpperCase()}
                      {activeService.isRehearsal ? ' · TEST' : ''}
                    </span>
                  );
                })()}
                <button
                  className="arm-toggle arm-toggle-compact"
                  onClick={onArmToggle}
                  data-armed={isArmed ? 'true' : 'false'}
                  data-confirm={confirmDisarm ? 'true' : 'false'}
                >
                  <span className="arm-toggle-dot" aria-hidden />
                  {confirmDisarm
                    ? 'Click again to disarm'
                    : isArmed
                      ? 'Disarm'
                      : 'Arm'}
                </button>
              </div>
              {upcomingAfterActive.length > 0 && (
                <div className="service-header-next">
                  <span className="service-header-next-label">Next up</span>
                  {upcomingAfterActive.map((svc, i) => (
                    <span key={svc.id} className="service-header-next-item">
                      {i > 0 ? ' · ' : ''}
                      {formatTime12h(parseTime(svc.startTime))}
                    </span>
                  ))}
                </div>
              )}
              {/* Right-side time-shift buttons. Uses margin-left:auto via
                  .time-shift-group so they hug the right edge of the
                  service header bar. Light-grey neutral tint keeps the
                  visual emphasis on Arm. Two-step confirm mirrors the
                  disarm pattern. */}
              {activeService && targetMs > Date.now() - 60_000 && (() => {
                const fireShift = (
                  sec: number,
                  confirmFlag: boolean,
                  setFlag: (b: boolean) => void,
                  timerRef: React.MutableRefObject<number | null>,
                ) => {
                  if (!confirmFlag) {
                    setFlag(true);
                    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
                    timerRef.current = window.setTimeout(() => {
                      setFlag(false);
                      timerRef.current = null;
                    }, 3000);
                    return;
                  }
                  extendServiceStart(activeService.id, sec);
                  setFlag(false);
                  if (timerRef.current !== null) {
                    window.clearTimeout(timerRef.current);
                    timerRef.current = null;
                  }
                };
                return (
                  <div className="time-shift-group">
                    <button
                      className="time-shift-btn"
                      type="button"
                      data-confirm={confirmSubTime ? 'true' : 'false'}
                      onClick={() => fireShift(-120, confirmSubTime, setConfirmSubTime, subTimeTimerRef)}
                      title="Pull service start IN by 2 minutes (also updates the ProPresenter timer). Two-click to confirm."
                    >
                      {confirmSubTime ? 'Confirm −2' : '−2 min'}
                    </button>
                    <button
                      className="time-shift-btn"
                      type="button"
                      data-confirm={confirmAddTime ? 'true' : 'false'}
                      onClick={() => fireShift(120, confirmAddTime, setConfirmAddTime, addTimeTimerRef)}
                      title="Push service start BACK by 2 minutes (also updates the ProPresenter timer). Two-click to confirm."
                    >
                      {confirmAddTime ? 'Confirm +2' : '+2 min'}
                    </button>
                  </div>
                );
              })()}
            </>
          ) : null}
        </div>

        {/* Big visible warning whenever a service is on deck but isn't
            armed — auto-arm normally handles this, but if the operator
            disabled it, panicked, or another runway took over, the
            service can sit unarmed without anyone noticing. The banner
            ramps from amber → red → pulsing red as the start time
            approaches. Hidden in three cases:
              1. Start time has already passed — focus shifts to post-service.
              2. Auto-arm is enabled AND post-service is rolling AND
                 we're before musicFireMs. Auto-arm defers in this exact
                 window so post-service plays into the next service; the
                 banner would just nag about something the system is
                 already handling.
              3. Auto-arm is enabled AND no post-service AND we're
                 before musicFireMs — auto-arm fires immediately, banner
                 redundant. */}
        {activeService && !isArmed && targetMs > 0 && targetMs > Date.now()
          && !(autoArmEnabled && musicFireMs > Date.now()) && (
          <NotArmedBanner
            targetMs={targetMs}
            onArm={onArmToggle}
            postServiceRolling={isPostServiceRolling}
          />
        )}

        {/* Reassuring counter-banner during the back-to-back gap: shows
            when auto-arm IS enabled, post-service is rolling, and the
            next service's music fire is still upcoming. Replaces the
            scary "not armed" banner with a calm "we've got this — arms
            at HH:MM" status. */}
        {activeService && !isArmed && targetMs > 0 && targetMs > Date.now()
          && autoArmEnabled && isPostServiceRolling && musicFireMs > Date.now() && (
          <div className="auto-arm-pending">
            <span className="auto-arm-pending-dot" aria-hidden />
            <span className="auto-arm-pending-text">
              Auto-arm scheduled for <strong>{new Date(musicFireMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</strong>
              {' '}— post-service will fade out and {activeService.name || 'next service'} will arm.
            </span>
          </div>
        )}

        {/* Hero — amber-tint everything in here while armed-but-waiting. */}
        <section
          className={`hero ${
            activeService
            && currentRunway?.serviceId === activeService.id
            && currentRunway?.phase === 'queued'
              ? 'is-pre-music'
              : ''
          }`}
        >
          {(() => {
            // Suppress the default header when the pad is in its
            // post-service finishing phase — the pad-finishing panel
            // renders its own header.
            const padFinishing = currentRunway?.phase === 'pad' && padOffMs > Date.now();
            if (padFinishing) return null;
            // Suppress when the post-service-ready prompt is rendering.
            // (active service exists but target has passed and we're not
            // in pad/post-service phase.)
            const targetPassed = activeService && targetMs > 0 && targetMs <= Date.now();
            const padHolding = currentRunway?.phase === 'pad' && padOffMs > Date.now();
            const postRolling = currentRunway?.isPostService && postServiceEndMs > Date.now();
            if (targetPassed && !padHolding && !postRolling) return null;
            return (
              <div className="hero-label">
                {activeService ? 'Service Starts In' : 'No Service Selected'}
              </div>
            );
          })()}
          {activeService && targetMs > Date.now() ? (
            <>
              <CountdownClock
                targetMs={targetMs}
                variant={
                  // While post-service music is the active audio, the
                  // countdown to the *next* service is supplementary —
                  // a soft purple harmonizes with the post-service pink
                  // pill below instead of fighting it.
                  isPostServiceRolling && postServiceEndMs > Date.now()
                    ? 'idle'
                    // No runway is armed for this service → red, matches
                    // the warning banner above. Otherwise amber while
                    // armed-but-waiting; flips to cyan once music starts.
                    : !isArmed
                      ? 'not-armed'
                      : currentRunway?.phase !== 'music' && currentRunway?.phase !== 'pad'
                        ? 'pre-music'
                        : 'music'
                }
              />
              {(() => {
                const armedHere = currentRunway?.serviceId === activeService.id;
                const phase = armedHere ? currentRunway?.phase : null;
                // Once the runway is past 'queued' the countdown chip's "fires in"
                // copy is wrong (music is already firing). Swap to a status chip
                // that reflects the current phase, or hide entirely.
                if (phase === 'music') {
                  return (
                    <div className="sub-countdown-row">
                      <div className="sub-countdown sub-countdown-amber">
                        <span className="sub-countdown-label">Music</span>
                        <span className="sub-countdown-value">Playing</span>
                      </div>
                    </div>
                  );
                }
                if (phase === 'pad') {
                  return (
                    <div className="sub-countdown-row">
                      <div className="sub-countdown sub-countdown-amber">
                        <span className="sub-countdown-label">Pad</span>
                        <span className="sub-countdown-value">Bridging</span>
                      </div>
                    </div>
                  );
                }
                if (musicFireMs > 0 && musicFireMs > Date.now()) {
                  return (
                    <div className="sub-countdown-row">
                      <SubCountdown
                        targetMs={musicFireMs}
                        label="Music fires in"
                        variant={armedHere ? 'amber' : 'default'}
                      />
                    </div>
                  );
                }
                return null;
              })()}
            </>
          ) : currentRunway?.phase === 'pad' && padOffMs > Date.now() ? (
            // Service has started; pad is still holding/fading. Render
            // regardless of activeService status — the service may have
            // already been marked completed, but the pad is still on.
            // Purely a visual indicator; no PP traffic.
            <MediumCountdown
              header="Service started · pad finishing"
              label="Pad off in"
              targetMs={padOffMs}
              showMs
            />
          ) : currentRunway?.isPostService && postServiceEndMs > Date.now() ? (
            <MediumCountdown
              header="Post-service playing"
              label="Ends in"
              targetMs={postServiceEndMs}
              showMs
            />
          ) : activeService ? (
            (() => {
              const post = postPlaylists.find(p => p.id === chosenPostId)
                ?? postPlaylists.find(p => p.id === activeService.postServicePlaylistId)
                ?? postPlaylists[0];
              return (
                <div className="post-ready-hero">
                  <div className="post-ready-eyebrow">Service in progress · post-service ready</div>
                  {post ? (
                    <>
                      <div className="post-ready-name">{post.name}</div>
                      <button
                        className="post-ready-cta"
                        onClick={onStartPostService}
                        disabled={!!currentRunway && !currentRunway.isPostService}
                      >
                        ▶ Start Post-Service
                      </button>
                      <div className="post-ready-hint">
                        Pick a different post-service playlist below if needed.
                      </div>
                    </>
                  ) : (
                    <div className="post-ready-hint">
                      No post-service playlists configured. Add one in the Playlists tab.
                    </div>
                  )}
                </div>
              );
            })()
          ) : (
            <div style={{ color: 'var(--text-faint)', fontSize: 14, padding: '40px 0' }}>
              Add a service in the Schedule tab to begin.
            </div>
          )}

          {activeService && (
            <div className="hero-meta">
              <div className="hero-meta-item">
                <span className="hero-meta-label">Target</span>
                <span className="hero-meta-value">{formatTime12h(parseTime(activeService.startTime))}</span>
              </div>
              <div className="hero-meta-item">
                <span className="hero-meta-label">Land in</span>
                <span className={`hero-meta-value key ${isPostServiceRolling ? 'idle' : ''}`}>
                  {resolveServiceFirstSongKey(activeService, services).value || '—'}
                </span>
              </div>
              {playlistInUse && !activeService.disablePadBridge && !currentRunway?.skipPadBridge && (
                <div
                  className="hero-meta-item"
                  title="How long the pad continues holding after service start (= padBridgeSec). The pre-service pad lead — when the pad fires before service start — is set in Music transitions on the right."
                >
                  <span className="hero-meta-label">Pad hold</span>
                  <span className="hero-meta-value">{playlistInUse.padBridgeSec.toFixed(1)}s</span>
                </div>
              )}
            </div>
          )}

          {/* Post-service status pill — sits at the *bottom* of the hero
              when a previous service's post-service is still rolling and
              a future service is being counted down to. Below the
              service-meta row so the next-service clock + target stay
              visually primary; the pill is the ancillary "this audio is
              still playing" status. */}
          {isPostServiceRolling && postServiceEndMs > Date.now() && targetMs > Date.now() && (
            <div className="post-service-pill-row post-service-pill-row-below">
              <PostServicePill
                endMs={postServiceEndMs}
                onStop={onStartPostService}
                confirmStop={confirmStopPost}
              />
            </div>
          )}

          {/* Start-music-early — only meaningful while armed and waiting. */}
          {activeService
            && currentRunway?.serviceId === activeService.id
            && currentRunway?.phase === 'queued'
            && targetMs > Date.now() + 5000
            && (
              <div className="hero-early">
                <div className="hero-early-buttons">
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      void controller.shuffleArrangement().then(res => {
                        if (!res.ok) setArmError(res.reason ?? 'Could not shuffle');
                        else if (res.warning) setArmError(res.warning);
                      });
                    }}
                    title="Re-roll the pre-service playlist order. The pinned last song stays put."
                  >
                    🔀 Shuffle
                  </button>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      void controller.startMusicEarly().then(res => {
                        if (!res.ok) setArmError(res.reason ?? 'Could not start music early');
                      });
                    }}
                    title="Re-arrange the playlist to fill the remaining time and start music now"
                  >
                    ▶ Start music early & fill
                  </button>
                </div>
                <span className="hero-early-sub">
                  Re-arranges the playlist for the new {Math.round((targetMs - Date.now()) / 60000)}-min window.
                </span>
              </div>
            )}

          {/* Cancel-early — show whenever the runway was started early. */}
          {activeService
            && currentRunway?.serviceId === activeService.id
            && currentRunway?.startedEarly
            && currentRunway?.phase === 'music'
            && (
              <div className="hero-early">
                <button
                  className="btn-secondary hero-early-cancel"
                  onClick={() => {
                    void controller.cancelMusicEarly().then(res => {
                      if (!res.ok) setArmError(res.reason ?? 'Could not cancel');
                    });
                  }}
                  title="Fade out music and return to the normal armed-and-waiting state"
                >
                  ✕ Cancel early music & wait
                </button>
                <span className="hero-early-sub">
                  Music fades out; service goes back to its scheduled lead time.
                </span>
              </div>
            )}
        </section>

        {/* Auto-start status */}
        <section className="auto-start">
          <div className={`auto-start-indicator ${musicPlayback.isPlaying ? '' : 'idle'}`} />
          <div className="auto-start-text">
            {musicPlayback.isPlaying ? (
              <>
                <div><strong>Music playing</strong> <span>· {playlistInUse ? playlistInUse.name : ''}</span></div>
                <div className="auto-start-detail">
                  {currentRunway
                    ? `${queueTracks.length} tracks · ${formatDuration(currentRunway.totalSec)} runway`
                    : 'manual playback'}
                </div>
              </>
            ) : (
              <>
                <div><strong>{isArmed ? 'Armed' : 'Idle'}</strong> <span>· {isArmed ? `${currentRunway?.trackIds.length} tracks loaded` : 'no music playing'}</span></div>
                <div className="auto-start-detail">
                  {isArmed && currentRunway
                    ? `Fires at ${new Date(currentRunway.musicStartMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                    : activeService
                      ? `Auto-start will fire ~${Math.round(activeService.autoStartTargetSec / 60)} min before service`
                      : 'Configure a service to enable auto-start'}
                </div>
              </>
            )}
          </div>
          {armError && (
            <button
              className="arm-warning-chip"
              title={armError}
              onClick={() => setArmError(null)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              </svg>
              <span>{shortArmWarning(armError)}</span>
            </button>
          )}
        </section>

        {/* Runway timeline */}
        <section className="runway" ref={runwaySectionRef}>
          <div className="runway-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <div className="runway-title">
                {currentRunway
                  ? `${currentRunway.isPostService ? 'Post-Service' : 'Runway'} · ${queueTracks.length} tracks · ${formatDuration(runwayTruncation?.effectiveTotalSec ?? currentRunway.totalSec)}`
                  : 'Runway · empty'}
              </div>
              {runwayTruncation && (
                <div className={`runway-swap-footer ${runwayTruncation.missing ? 'missing' : ''}`}>
                  <span className="runway-swap-arrow">{runwayTruncation.missing ? '⚠' : '↳'}</span>
                  <span className="runway-swap-label">
                    {runwayTruncation.missing ? 'runway ends here' : 'then swaps to'}
                  </span>
                  <span className="runway-swap-target">{runwayTruncation.swapToPlaylistName}</span>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto' }}>
              {/* Toggle whether already-played tracks stay visible. */}
              {currentRunway && (currentRunway.currentTrackIndex ?? 0) > 0 && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.06,
                    cursor: 'pointer',
                    userSelect: 'none',
                  }}
                  title="Keep already-played tracks visible in the list"
                >
                  <Toggle
                    checked={showPlayedTracks}
                    onChange={(next) => updateConfig({
                      ui: { ...useAppStore.getState().config.ui, showPlayedTracks: next },
                    })}
                    ariaLabel="Show played tracks"
                  />
                  Show played tracks
                </label>
              )}
              {/* Shuffle is only meaningful while a post-service runway is
                  rolling — the existing pre-service Shuffle lives in the
                  hero block since it re-arms the whole arrangement. */}
              {isPostServiceRolling && queueTracks.length - (currentRunway?.currentTrackIndex ?? 0) > 1 && (
                <button
                  className="btn-secondary"
                  onClick={() => {
                    void controller.shufflePostService().then(res => {
                      if (!res.ok) setArmError(res.reason ?? 'Could not shuffle');
                    });
                  }}
                  title="Re-roll the order of the unplayed tracks. The current song keeps playing."
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  🔀 Shuffle remaining
                </button>
              )}
            </div>
          </div>
          {(() => {
            const currentIdx = currentRunway?.currentTrackIndex ?? 0;
            const remainingCount = Math.max(0, queueTracks.length - currentIdx);
            // When the operator opts to keep played tracks on screen we
            // count the whole runway against the threshold so a long
            // played-out arrangement still gets the readable list.
            const displayedCount = showPlayedTracks ? queueTracks.length : remainingCount;
            // Below the threshold the proportional bar is wide enough to
            // read each segment's title; above it tiles get cramped and we
            // need the list. As tracks finish (and are hidden) the count
            // drops and the view can collapse back to the bar — unless the
            // operator pinned the vertical view in Settings.
            // The runway is the spine of the app — always horizontal,
            // chips roughly equal in width, scrolling sideways when there
            // are too many tracks to fit. Older "vertical when crowded"
            // fallback was removed: the row IS the runway, and a single
            // visual model is easier to reason about across services.
            void displayedCount; // (kept for the "displayed" derivation upstream)
            if (queueTracks.length === 0) {
              return (
                <div className="runway-list">
                  <div className="timeline-empty">
                    {activeService
                      ? 'Click Arm Service to load the runway'
                      : 'Add a service in the Schedule tab'}
                  </div>
                </div>
              );
            }
            // Compute marker positions in the same flex-unit space the
            // timeline segments live in. Each music segment is
            // `flex: effectiveDuration(t)` and the pad is
            // `flex: max(30, padBridgeSec)` — so a wall-clock fire time
            // has to be mapped through that same accounting or the
            // markers drift relative to the segments they sit over.
            // First-visible-track start time. Mirrors the engine
            // scheduling model: tracks play back-to-back, BUT track 0
            // is shortened by `startOffsetSec` (head trim) so every
            // track after it slides earlier in wall-clock by exactly
            // that amount. When the visible window starts at idx >= 1,
            // we compensate; when it includes track 0 (showPlayedTracks
            // on or fresh runway), no compensation needed because
            // visibleStartMs is musicStartMs.
            const musicStartMs = currentRunway?.musicStartMs ?? 0;
            const startOffsetSecRunway = currentRunway?.startOffsetSec ?? 0;
            const startIdx = showPlayedTracks ? 0 : currentIdx;
            let hiddenSec = 0;
            for (let i = 0; i < startIdx; i++) {
              const tr = queueTracks[i];
              hiddenSec += tr ? effectiveDuration(tr) : 60;
            }
            const visibleStartMs = startIdx >= 1
              ? musicStartMs + (hiddenSec - startOffsetSecRunway) * 1000
              : musicStartMs;

            // Each segment carries both a flex span (matches the
            // .timeline's flex:effDur visual sizing) and a wall-clock
            // window. Marker positions are computed by walking these.
            // Each chip occupies 1 unit of "flex space" regardless of song
            // length — the runway reads as a uniform sequence of chips, not
            // a duration-scaled bar. spanSec stays as the wall-clock window
            // (used for marker placement WITHIN a chip), but flexSpan = 1
            // so action markers convert to "i + within / N" positions
            // matching the equal chip widths.
            const segments: { startSec: number; spanSec: number; flexSpan: number; flexAcc: number; wallStartSec: number }[] = [];
            let cumSec = 0;
            let cumFlex = 0;
            for (let i = startIdx; i < queueTracks.length; i++) {
              const tr = queueTracks[i];
              const effDur = tr ? effectiveDuration(tr) : 60;
              segments.push({ startSec: cumSec, spanSec: effDur, flexSpan: 1, flexAcc: cumFlex, wallStartSec: cumSec });
              cumSec += effDur;
              cumFlex += 1;
            }
            const padBridgeSec = currentRunway && !currentRunway.isPostService
              && !(currentRunway.serviceId
                  && services.find(s => s.id === currentRunway.serviceId)?.disablePadBridge)
              && !currentRunway.skipPadBridge
              ? (currentRunway.padBridgeSec || 0)
              : 0;
            if (padBridgeSec > 0) {
              const lastMusicSeg = segments[segments.length - 1];
              const padWallStart = lastMusicSeg
                ? lastMusicSeg.wallStartSec + lastMusicSeg.spanSec
                : cumSec;
              // Pad chip occupies its own flex-1 slot at the end of the
              // strip — visually equivalent to a song chip, distinguished
              // by the .pad-segment class.
              segments.push({
                startSec: cumSec,
                spanSec: padBridgeSec,
                flexSpan: 1,
                flexAcc: cumFlex,
                wallStartSec: padWallStart,
              });
              cumSec += padBridgeSec;
              cumFlex += 1;
            }
            // Map a wall-clock fire time → flex-unit percentage for use
            // as `left: X%` on a marker over the .timeline container.
            // Walks segments by their crossfade-aware wall-clock window
            // and converts the in-segment proportion into flex-units
            // (which match the visual segment widths). Markers outside
            // the visible window get clamped to 0/100 and flagged so
            // they render with an "‹" / "›" decoration.
            const flexPctFor = (fireMs: number): { pct: number; clamped: 'before' | 'after' | null } => {
              if (cumFlex <= 0) return { pct: 0, clamped: null };
              const sec = (fireMs - visibleStartMs) / 1000;
              if (sec < 0) return { pct: 0, clamped: 'before' };
              // Iterate later→earlier so the incoming track wins inside
              // a crossfade overlap.
              for (let si = segments.length - 1; si >= 0; si--) {
                const seg = segments[si];
                if (sec >= seg.wallStartSec && sec <= seg.wallStartSec + seg.spanSec) {
                  const within = (sec - seg.wallStartSec) / seg.spanSec;
                  const flexPos = seg.flexAcc + within * seg.flexSpan;
                  return { pct: (flexPos / cumFlex) * 100, clamped: null };
                }
              }
              return { pct: 100, clamped: 'after' };
            };
            const markerData = armedActions.map(({ action, fireMs }) => {
              const { pct, clamped } = flexPctFor(fireMs);
              return { action, fireMs, pct, clamped };
            });
            return (
                <div className="timeline">
                  <TimelineActionMarkers markers={markerData} />
                  {queueTracks.map((t, i) => {
                    if (i < currentIdx && !showPlayedTracks) return null;
                    const isPlayed = i < currentIdx;
                    if (!t) {
                      return (
                        <div key={`missing-${i}`} className="timeline-segment" style={{ flex: '1 0 140px', opacity: 0.4 }}>
                          <div className="tl-seg-top">
                            <div className="tl-seg-name">— missing track —</div>
                          </div>
                          <div className="tl-seg-scrub" />
                        </div>
                      );
                    }
                    const isCurrent = t?.id === musicPlayback.trackId && currentRunway?.phase === 'music';
                    // Progress fill keeps running while the audio engine
                    // is still on this track — even during the music
                    // fade-out into the pad bridge — so the bar doesn't
                    // visibly snap back to 0 the moment phase flips.
                    const showProgress = t?.id === musicPlayback.trackId && musicPlayback.durationSec > 0;
                    const isLast = i === queueTracks.length - 1;
                    const showAnchor = isCurrent && isLast && !currentRunway?.isPostService && !!currentRunway?.serviceId;
                    const cls = `${isCurrent ? 'current' : ''} ${isPlayed ? 'played' : ''}`;
                    const playable = !!isTestRunway
                      && (currentRunway?.phase === 'music' || currentRunway?.phase === 'queued');
                    const progressPct = showProgress
                      ? (musicPlayback.positionSec / musicPlayback.durationSec) * 100
                      : 0;
                    const effDur = effectiveDuration(t);
                    // Equal-width chips: grow to fill, with a min so the
                    // strip overflows and scrolls horizontally instead of
                    // crushing chip content when there are many tracks.
                    // flex basis is a hard minimum (shrink=0) so chips never crush;
                    // when the total exceeds the row width the timeline scrolls.
                    // 140px keeps a 9-chip pre-service overflowing (and scrollable)
                    // while a 2-3 chip post-service fits comfortably without bars.
                    const segStyle: React.CSSProperties = { flex: '1 0 140px' };
                    if (t.key) {
                      const c = keyColor(t.key);
                      segStyle.background = isCurrent ? c.soft : c.whisper;
                      if (isCurrent) segStyle.borderTop = `2px solid ${c.fg}`;
                    }
                    return (
                      <div
                        key={`${t.id}-${i}`}
                        className={`timeline-segment ${cls} ${playable ? 'clickable' : ''}`}
                        style={segStyle}
                      >
                        <div
                          className="tl-seg-top"
                          onClick={() => { if (playable) void controller.clickTimeline(i, 0); }}
                          title={playable ? 'Click to play from start' : undefined}
                        >
                          <div className="tl-seg-name" title={t.title}>{t.title}</div>
                          {t.artist && <div className="tl-seg-artist" title={t.artist}>{t.artist}</div>}
                          <div className="tl-seg-meta">
                            {formatDuration(effDur)}
                            {effDur < t.durationSec && (
                              <span style={{ opacity: 0.6 }}> · trimmed</span>
                            )}
                          </div>
                          {t.key && (() => {
                            const c = keyColor(t.key);
                            return (
                              <div
                                className={`tl-seg-key ${showAnchor ? 'match' : ''}`}
                                style={{ background: c.bg, color: c.fg, borderColor: c.fg }}
                              >
                                {t.key}
                              </div>
                            );
                          })()}
                        </div>
                        <div
                          className="tl-seg-scrub"
                          onClick={(e) => {
                            if (!playable) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                            void controller.clickTimeline(i, pct * effDur);
                          }}
                          title={playable ? 'Click to seek to this point' : undefined}
                        >
                          <div
                            className="tl-seg-scrub-fill"
                            style={{
                              width: `${progressPct}%`,
                              background: t.key ? keyColor(t.key).fg : undefined,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  {currentRunway && !currentRunway.isPostService && (() => {
                    const sourceSvc = currentRunway.serviceId
                      ? services.find(s => s.id === currentRunway.serviceId)
                      : null;
                    if (sourceSvc?.disablePadBridge || currentRunway.skipPadBridge) return null;
                    const padClickable = !!isTestRunway && currentRunway.phase === 'music';
                    const padPlaying = currentRunway.phase === 'pad';
                    return (
                      <div
                        className={`timeline-segment pad-segment ${padPlaying ? 'current' : ''} ${padClickable ? 'clickable' : ''}`}
                        style={{ flex: '1 0 140px' }}
                      >
                        <div
                          className="tl-seg-top"
                          onClick={() => { if (padClickable) controller.skipToPad(); }}
                          title={padClickable ? 'Click to skip remaining music and fire pad' : 'Pad bridge'}
                        >
                          <div className="tl-seg-name">Pad</div>
                          <div className="tl-seg-meta">{padPlaying ? 'rolling' : padClickable ? 'click to fire' : 'on deck'}</div>
                          {currentRunway.landInKey && (() => {
                            const c = keyColor(currentRunway.landInKey);
                            return (
                              <div
                                className={`tl-seg-key ${padPlaying ? 'match' : ''}`}
                                style={{ background: c.bg, color: c.fg, borderColor: c.fg }}
                              >
                                {currentRunway.landInKey}
                              </div>
                            );
                          })()}
                        </div>
                        <div className="tl-seg-scrub">
                          {padPlaying && padProgressPct > 0 && (
                            <div
                              className="tl-seg-scrub-fill pad"
                              style={{ width: `${padProgressPct}%` }}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
          })()}
        </section>

        {/* Now playing */}
        <section className={`now-playing ${fadeToPadActive ? 'fade-holding' : ''}`}>
          {(() => {
            const t = tracks.find(t => t.id === musicPlayback.trackId);
            if (t?.albumArtUrl) {
              return (
                <button
                  type="button"
                  className="np-art-button"
                  onClick={() => setLightboxOpen(true)}
                  title="Click to view full size"
                >
                  <img className="np-art" src={t.albumArtUrl} alt="" />
                </button>
              );
            }
            return <div className="np-art np-art-placeholder" aria-hidden>♪</div>;
          })()}
          <div className="np-info">
            <div className={`np-label ${fadeToPadActive ? 'holding' : ''}`}>
              {fadeToPadActive ? 'Holding on Pad' : 'Now Playing'}
            </div>
            <div className="np-title">
              {(() => {
                const t = tracks.find(t => t.id === musicPlayback.trackId);
                return t ? t.title : (musicPlayback.isPlaying ? 'Untitled' : '— nothing playing —');
              })()}
            </div>
            <div className="np-progress">
              <span>{formatDuration(musicPlayback.positionSec)}</span>
              <div className="np-progress-bar">
                <div className="np-progress-fill" style={{
                  width: musicPlayback.durationSec > 0
                    ? `${(musicPlayback.positionSec / musicPlayback.durationSec) * 100}%`
                    : '0%'
                }} />
              </div>
              <span>{formatDuration(musicPlayback.durationSec)}</span>
            </div>
          </div>
          <div className="np-key">
            <div className="np-key-label">Key</div>
            <div className="np-key-value">
              {(() => {
                const t = tracks.find(t => t.id === musicPlayback.trackId);
                return t?.key || '—';
              })()}
            </div>
          </div>
        </section>

        {/* Transition test controls — Quick Test and rehearsal services. Hidden
            for real armed services and post-service so live ops can't accidentally
            skip tracks. */}
        {currentRunway
         && isTestRunway
         && !currentRunway.isPostService
         && currentRunway.phase === 'music' && (
          <section
            className="test-controls"
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '8px 12px',
              margin: '0 0 12px',
              border: '1px solid var(--border, rgba(255,255,255,0.1))',
              borderRadius: 6,
              fontSize: 14,
            }}
          >
            <span style={{ color: 'var(--text-dim)', marginRight: 4 }}>
              Test · track {currentRunway.currentTrackIndex + 1}/{currentRunway.trackIds.length}
            </span>
            <button className="pl-toggle-btn" onClick={() => controller.nudgeMusic(-10)} title="Back 10s">−10s</button>
            <button className="pl-toggle-btn" onClick={() => controller.nudgeMusic(30)} title="Forward 30s">+30s</button>
            <button className="pl-toggle-btn active" onClick={() => controller.jumpToTransition(1)} title="Jump to crossfade window">
              ⇥ transition
            </button>
            <button className="pl-toggle-btn" onClick={() => controller.skipToNextTrack()} title="Skip to next track">
              ⏭ next track
            </button>
            <button className="pl-toggle-btn" onClick={() => controller.skipToPad()} title="Skip remaining music and trigger pad bridge">
              ⏭ pad bridge
            </button>
          </section>
        )}

        {/* Action buttons — single horizontal row.
            Order: Start Post-Service → Fade to Pad → Stop All. */}
        <section className="actions">
          {(() => {
            // Only treat the pre-service runway as a hard lock when it's
            // actually producing audio (music or pad). A queued runway
            // (auto-armed for the next service but not yet playing) gets
            // automatically disarmed by onStartPostService — operators
            // need to be able to fire between-services post-service
            // music even after auto-arm has prepped the next service.
            const preServicePlaying =
              !!currentRunway?.serviceId
              && (currentRunway.phase === 'music' || currentRunway.phase === 'pad');
            const preServiceQueued =
              !!currentRunway?.serviceId && currentRunway.phase === 'queued';
            const hasAnyPostPlaylist = postPlaylists.length > 0;
            const disabled =
              !isPostServiceRolling
              && (preServicePlaying || !chosenPostId || !hasAnyPostPlaylist);
            const fadeSec = (useAppStore.getState().config.defaults.postServiceFadeInSec ?? 4).toFixed(1);
            const label = isPostServiceRolling
              ? confirmStopPost ? 'Click Again to Stop' : 'Stop Post-Service'
              : 'Start Post-Service';
            const chosenName = postPlaylists.find(p => p.id === chosenPostId)?.name;
            const subText = isPostServiceRolling
              ? confirmStopPost ? `Will fade out · ${fadeSec}s` : `Fades out · ${fadeSec}s`
              : preServicePlaying
                ? 'Locked — pre-service is rolling'
                : preServiceQueued
                  ? 'Will disarm next service · auto-arm off'
                  : !hasAnyPostPlaylist
                    ? 'No post-service playlists available'
                    : chosenName
                      ? `${chosenName} · fades in ${fadeSec}s`
                      : `Fades in over ${fadeSec}s`;
            return (
              <button
                className={`action-btn post ${confirmStopPost ? 'post-confirm' : ''}`}
                onClick={(e) => {
                  // Click on the chevron handle bubbles up; ignore those so
                  // tapping the chevron only opens the picker.
                  if ((e.target as HTMLElement).closest('.post-pick-chevron, .post-pick-pop')) return;
                  onStartPostService();
                }}
                disabled={disabled}
              >
                <div className="action-btn-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    {isPostServiceRolling
                      ? <rect x="6" y="6" width="12" height="12" />
                      : <path d="M8 5v14l11-7z" />}
                  </svg>
                </div>
                <div className="action-btn-text">
                  <div className="action-btn-label">{label}</div>
                  <div className="action-btn-sub">{subText}</div>
                </div>
                {/* Playlist picker chevron — span (not button) to keep us
                    out of nested-button-invalid-HTML territory. Click
                    handler stops propagation so it doesn't fire the
                    parent's onClick. */}
                {!isPostServiceRolling && hasAnyPostPlaylist && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="post-pick-chevron"
                    aria-label="Choose post-service playlist"
                    title="Choose post-service playlist"
                    onClick={(e) => { e.stopPropagation(); setPostPickerOpen(o => !o); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        setPostPickerOpen(o => !o);
                      }
                    }}
                  >▾</span>
                )}
                {postPickerOpen && (
                  <PostServicePicker
                    playlists={postPlaylists}
                    chosenId={chosenPostId}
                    onPick={(id) => { setChosenPostId(id); setPostPickerOpen(false); }}
                    onClose={() => setPostPickerOpen(false)}
                  />
                )}
              </button>
            );
          })()}

          {(() => {
            // Fade-to-pad toggle. When inactive: fade music to
            // silence (source still playing in background) and bring
            // up a key-matched pad. When active: pulses to signal
            // the engaged state, and clicking again reverses — music
            // back to unity, pad fades out.
            const fadeActive = fadeToPadActive;
            const padDisabled = (!musicPlayback.isPlaying && !fadeActive) || (useAppStore.getState().config.pads.length === 0);
            return (
              <button
                className={`action-btn fade-to-pad ${fadeActive ? 'engaged' : ''}`}
                onClick={() => { void controller.fadeToPad(); }}
                disabled={padDisabled}
                title={fadeActive
                  ? 'Bring music back and fade the pad out'
                  : 'Fade music to silence and hold on a key-matched pad. Music keeps playing in the background — click again to bring it back.'}
              >
                <div className="action-btn-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    {fadeActive ? (
                      <>
                        {/* Reversed arrow — music coming back up */}
                        <path d="M3 12 Q5 18 7 12 T11 12 T15 12 T19 12 T23 12" />
                        <path d="M8 6L4 10l4 4" />
                      </>
                    ) : (
                      <>
                        <path d="M3 12 Q5 6 7 12 T11 12 T15 12 T19 12 T23 12" />
                        <path d="M16 6l4 4-4 4" />
                      </>
                    )}
                  </svg>
                </div>
                <div className="action-btn-text">
                  <div className="action-btn-label">{fadeActive ? 'Music Back In' : 'Fade to Pad'}</div>
                  <div className="action-btn-sub">
                    {fadeActive
                      ? 'Holding on pad · click to recover'
                      : padDisabled
                        ? (musicPlayback.isPlaying ? 'No pads mapped' : 'Nothing playing')
                        : 'Fade music · hold on pad'}
                  </div>
                </div>
              </button>
            );
          })()}

          {(() => {
            const panicDisabled = !currentRunway && !musicPlayback.isPlaying;
            return (
              <button
                className={`action-btn panic ${panicFlash ? 'flashing' : ''}`}
                onClick={onPanic}
                disabled={panicDisabled}
              >
                <div className="action-btn-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 6h12v12H6z" />
                  </svg>
                </div>
                <div className="action-btn-text">
                  <div className="action-btn-label">Stop All</div>
                  <div className="action-btn-sub">
                    {panicDisabled ? 'Nothing playing' : 'Fades out · 1.5s'}
                  </div>
                </div>
              </button>
            );
          })()}
        </section>

      </main>

      <aside className="right-panel">
        <ScheduleSummaryPanel />
        <MasterFaderPanel />
        <BusLevelMeters />
        <MusicCrossfadePanel />
        <PadPlayerPanel />
        <MidiLogPanel />
        <RehearsePanel />
      </aside>
      {lightboxOpen && (() => {
        const t = tracks.find(t => t.id === musicPlayback.trackId);
        if (!t?.albumArtUrl) return null;
        const meta = [t.artist, t.album].filter(Boolean).join(' · ');
        return (
          <AlbumArtLightbox
            artUrl={t.albumArtUrl}
            title={t.title}
            meta={meta || undefined}
            onClose={() => setLightboxOpen(false)}
          />
        );
      })()}
    </div>
  );
}

/**
 * Mid-size countdown used for post-target hero states (pad finishing,
 * post-service playing). Bigger than a SubCountdown chip but smaller than
 * the main CountdownClock — and tinted with the app's accent teal so it
 * reads as part of the same visual family.
 */
/**
 * Slim status pill shown above the next-service countdown when a
 * previous service's post-service music is still rolling. Tells the
 * operator "post-service still playing, ends in X" without burying it
 * under the bigger pre-service clock.
 */
/**
 * Small popover that drops down from the post-service button's
 * chevron — lists every post-service playlist, click one to pick
 * it. Click outside or press Escape to close.
 */
function PostServicePicker({ playlists, chosenId, onPick, onClose }: {
  playlists: { id: string; name: string }[];
  chosenId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const popRef = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current && !popRef.current.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={popRef}
      className="post-pick-pop"
      onClick={(e) => e.stopPropagation()}
    >
      {playlists.length === 0 ? (
        <div className="post-pick-empty">No post-service playlists yet</div>
      ) : (
        playlists.map(p => (
          <button
            key={p.id}
            type="button"
            className={`post-pick-row ${p.id === chosenId ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onPick(p.id); }}
          >
            <span className="post-pick-check">{p.id === chosenId ? '✓' : ''}</span>
            <span className="post-pick-name">{p.name}</span>
          </button>
        ))
      )}
    </div>
  );
}

function PostServicePill({ endMs, onStop, confirmStop }: {
  endMs: number;
  onStop: () => void;
  confirmStop: boolean;
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, endMs - Date.now()));
  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining(Math.max(0, endMs - Date.now()));
    }, 250);
    return () => window.clearInterval(id);
  }, [endMs]);
  const totalSec = Math.floor(remaining / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const clock = `${m}:${String(s).padStart(2, '0')}`;
  return (
    <div className="post-service-pill">
      <span className="post-service-pill-dot" aria-hidden />
      <span className="post-service-pill-label">Post-Service Playing</span>
      <span className="post-service-pill-clock">ends in {clock}</span>
      <button
        type="button"
        className={`post-service-pill-stop ${confirmStop ? 'confirm' : ''}`}
        onClick={onStop}
        title="Fade out post-service music"
      >
        {confirmStop ? 'Click again to stop' : 'Stop'}
      </button>
    </div>
  );
}

function MediumCountdown({ header, label, targetMs, showMs = false }: {
  header: string;
  label: string;
  targetMs: number;
  showMs?: boolean;
}) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setRemaining(Math.max(0, targetMs - Date.now()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetMs]);

  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ms = Math.floor(remaining % 1000);
  const baseClock = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  const display = showMs ? `${baseClock}.${String(ms).padStart(3, '0')}` : baseClock;

  // Pink — matches the key-A pad color (Camelot hue 300). Distinct from
  // the teal pre-service timer so the operator can tell at a glance
  // which phase they're in. Same glowy treatment as CountdownClock.
  const ACCENT = 'hsl(300, 68%, 75%)';
  const GLOW_NEAR = 'hsla(300, 68%, 70%, 0.6)';
  const GLOW_FAR = 'hsla(300, 68%, 60%, 0.35)';
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '32px 0 24px',
      gap: 6,
    }}>
      <div style={{
        color: ACCENT,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: 0.16,
        textTransform: 'uppercase',
      }}>
        {header}
      </div>
      <div style={{
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.16,
        textTransform: 'uppercase',
        color: 'var(--text-faint)',
        fontFamily: 'IBM Plex Mono, monospace',
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 64,
        fontWeight: 700,
        letterSpacing: -0.02,
        color: ACCENT,
        textShadow: `0 0 14px ${GLOW_NEAR}, 0 0 30px ${GLOW_FAR}`,
        lineHeight: 1,
        fontFamily: 'IBM Plex Mono, monospace',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {display}
      </div>
    </div>
  );
}

/**
 * Big, hard-to-miss banner shown when a service is upcoming but the
 * runway isn't armed. Color ramps with urgency:
 *   > 30 min : neutral amber
 *   ≤ 30 min : strong amber
 *   ≤ 10 min : red
 *   ≤ 2 min  : red + pulse
 * Always shows the countdown to start and an inline Arm button.
 */
function NotArmedBanner({
  targetMs,
  onArm,
  postServiceRolling,
}: {
  targetMs: number;
  onArm: () => void;
  postServiceRolling: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, []);
  const remainingMs = targetMs - now;
  const remainingSec = Math.max(0, Math.floor(remainingMs / 1000));
  const past = remainingMs <= 0;
  const h = Math.floor(remainingSec / 3600);
  const m = Math.floor((remainingSec % 3600) / 60);
  const s = remainingSec % 60;
  const countdown = past
    ? 'NOW'
    : h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;

  // Pulse once we're within 10 minutes — caught attention without
  // strobing for the entire pre-service window.
  const pulse = past || remainingMs <= 10 * 60 * 1000;

  return (
    <div className={`not-armed-banner ${pulse ? 'pulse' : ''}`} role="alert">
      <div className="not-armed-icon" aria-hidden>⚠</div>
      <div className="not-armed-text">
        <div className="not-armed-title">
          {past ? 'Service start has passed — arm now' : 'Service is not armed'}
        </div>
        <div className="not-armed-sub">
          {past
            ? 'Music will not play until you arm the service.'
            : `Arm before ${countdown} or the pre-service music won't fire.`}
          {postServiceRolling
            ? ' Post-service is rolling — arming will fade it out.'
            : ' Need music playing now? Hit Start Post-Service below.'}
        </div>
      </div>
      <button className="not-armed-arm" onClick={onArm} type="button">
        Arm now
      </button>
    </div>
  );
}

// ─── Action markers on the Live timeline ────────────────────────────
// Two flavors, sharing the same data: vertical lines + icons over the
// horizontal proportional bar, and chip rows above the vertical list.
// The desktop tooltip shows label + offset + payload description so the
// operator can scan what's about to fire without leaving Live.

interface ArmedAction {
  action: import('@shared/types').Action;
  fireMs: number;
}

function TimelineActionMarkers({
  markers,
}: {
  markers: {
    action: import('@shared/types').Action;
    fireMs: number;
    pct: number;
    clamped: 'before' | 'after' | null;
  }[];
}) {
  if (markers.length === 0) return null;
  return (
    <div className="action-markers" aria-hidden={false}>
      {markers.map(({ action, pct, clamped }) => {
        const meta = ACTION_META[action.payload.type];
        const arrow = clamped === 'before' ? '‹ ' : clamped === 'after' ? ' ›' : '';
        const tipText = clamped
          ? `${describeAction(action)} — fires ${clamped === 'before' ? 'before' : 'after'} the visible window`
          : describeAction(action);
        // The vertical line sits at the exact fire-time pct. The icon
        // normally centers on the line, but at the runway edges we shift
        // it INWARD so it stays fully visible (otherwise contain: paint
        // would clip half of it). At pct≥95 the icon's right edge aligns
        // with the line (icon sits to the left of it); at pct≤5 the icon's
        // left edge aligns with the line.
        const iconShift = pct >= 95
          ? 'translateX(-50%)'
          : pct <= 5
          ? 'translateX(50%)'
          : undefined;
        return (
          <Tooltip key={action.id} text={tipText}>
            <div
              className={`action-marker ${clamped ? 'clamped' : ''}`}
              style={{ left: `${Math.max(0, Math.min(100, pct))}%`, color: meta.color }}
            >
              <span
                className="action-marker-icon"
                style={iconShift ? { transform: iconShift } : undefined}
              >{arrow}{meta.icon}</span>
              <span className="action-marker-line" />
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}

function ActionChipStrip({ actions }: { actions: ArmedAction[] }) {
  if (actions.length === 0) return null;
  return (
    <div className="action-chip-strip" role="list">
      {actions.map(({ action, fireMs }) => {
        const meta = ACTION_META[action.payload.type];
        const offsetSec = Math.round((fireMs - Date.now()) / 1000);
        const sign = offsetSec < 0 ? '−' : '+';
        const abs = Math.abs(offsetSec);
        const mm = Math.floor(abs / 60);
        const ss = abs % 60;
        const when = `${sign}${mm}:${String(ss).padStart(2, '0')}`;
        return (
          <Tooltip key={action.id} text={describeAction(action)}>
            <div
              className={`action-chip ${offsetSec < 0 ? 'past' : ''}`}
              style={{ borderColor: meta.color, color: meta.color }}
              role="listitem"
            >
              <span className="action-chip-icon">{meta.icon}</span>
              <span className="action-chip-label">{action.label || meta.label}</span>
              <span className="action-chip-when">{when}</span>
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
}
