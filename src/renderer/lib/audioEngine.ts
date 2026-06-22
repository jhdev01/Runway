/**
 * AudioEngine — handles all audio playback for the app.
 *
 * Two main buses:
 *  - Music bus: plays the playlist queue with crossfade or gapless transitions
 *  - Pad bus: plays a single sustained pad in a chosen key
 *
 * Each bus has its own GainNode (the "fader") for fades.
 *
 * Note: Web Audio's standard output cannot select specific channels of a
 * multi-channel device — that requires a more advanced setup using
 * AudioContext destination + ChannelMergerNode, or in v2 we'd move to a
 * native module. For v1, we use the OS default output device but architect
 * the engine so swapping the backend later is easy.
 */

export type BusName = 'music' | 'pad';

/**
 * Convert an absolute file system path to a URL the renderer can fetch.
 * Uses the runway-audio:// custom protocol registered by the main process,
 * because Electron blocks the renderer from fetching file:// URLs directly.
 */
export function filePathToUrl(filePath: string): string {
  // Strip any existing file:// prefix and ensure leading slash
  let p = filePath.replace(/^file:\/\//, '');
  if (!p.startsWith('/')) p = '/' + p;
  // Encode each path segment (preserves slashes)
  const encoded = p.split('/').map(s => encodeURIComponent(s)).join('/');
  return `runway-audio://localhost${encoded}`;
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  buffer: AudioBuffer;
  startedAt: number;       // ctx.currentTime when started
  startedFromSec: number;  // offset within the buffer where playback began
  endAtSec?: number;       // absolute buffer offset where playback should stop (defaults to buffer.duration)
  // Where the trimmed segment starts in the buffer. Used to report segment-
  // relative position so seeks don't reset the progress bar to 0.
  segmentStartSec: number;
  trackId?: string;
  filePath: string;
  isLooping?: boolean;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTrackId?: string;
  currentFilePath?: string;
  currentPositionSec: number;
  currentDurationSec: number;
  busName: BusName;
}

export type PlaybackListener = (state: PlaybackState) => void;

interface ScheduledTrack {
  source: AudioBufferSourceNode;
  gain: GainNode;
  buffer: AudioBuffer;
  trackId: string;
  filePath: string;
  scheduledStartCtx: number; // ctx time when this track starts playing
  scheduledEndCtx: number;   // ctx time when this track is scheduled to stop
  startedFromSec: number;    // audio buffer offset (= trimStart + headTrim/skip)
  segmentStartSec: number;   // trim start of the buffer
  endAtSec: number;          // trim end of the buffer
}

interface ScheduledRunway {
  tracks: ScheduledTrack[];
  // All scheduled tracks route through this mute gain so fade-to-pad /
  // fade-to-silence can affect the whole runway without touching the
  // per-track crossfade envelopes.
  muteGain: GainNode;
  startedAtCtx: number;
  endsAtCtx: number;
}

export interface ScheduledTrackInput {
  filePath: string;
  trackId: string;
  trimStartSec?: number;
  trimEndSec?: number;
  fadeOutSec?: number;
}

export type RoutableBus = 'music' | 'pad' | 'cue';

/**
 * Per-bus output chain. Each bus has its own master + 3-band EQ mirror nodes
 * (so master/EQ slider changes apply to every bus simultaneously) and its
 * own MediaStreamAudioDestinationNode + HTMLAudioElement so the bus can be
 * routed to a specific output device via `audio.setSinkId(deviceId)`.
 *
 * Pre-bus gain (`inputGain`) is the public connect target — playMusic/playPad
 * connect their per-source faders here. Editor preview connects to the cue
 * bus's inputGain.
 */
interface BusChain {
  inputGain: GainNode;       // music/pad/cue level
  master: GainNode;          // master fader mirror (shared value)
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  streamDest: MediaStreamAudioDestinationNode;
  audioEl: HTMLAudioElement;
  currentDeviceId: string | null;
  // Analyser sits in parallel off the master output so the live UI can
  // read post-fader peak levels for the Live-view meters. Parallel
  // (not in-line) so the analyser's processing can't add latency to
  // the audible chain.
  analyser: AnalyserNode;
  analyserBuf: Float32Array<ArrayBuffer>;
}

export class AudioEngine {
  private ctx: AudioContext;
  private buses: Record<RoutableBus, BusChain>;

  // Convenience back-pointers so existing code reads natural names.
  private get musicGain() { return this.buses.music.inputGain; }
  private get padGain() { return this.buses.pad.inputGain; }

  private currentMusic: ActiveSource | null = null;
  private currentPad: ActiveSource | null = null;
  // Set when the music bus is playing a precise-scheduled runway (every
  // source.start, source.stop, and crossfade gain ramp pre-scheduled at exact
  // ctx times). Mutually exclusive with currentMusic — operations on the music
  // bus check musicScheduled first and fall back to currentMusic when null.
  private musicScheduled: ScheduledRunway | null = null;

  private bufferCache = new Map<string, AudioBuffer>();
  private listeners: Set<PlaybackListener> = new Set();
  private rafHandle: number | null = null;

  // Settings
  private musicLevel = 1.0; // post-fade base level
  private padLevel = 0.6;
  private cueLevel = 1.0;
  private masterLevel = 1.0;
  private eqValues = { low: 0, mid: 0, high: 0 };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.buses = {
      music: this.buildBus(this.musicLevel),
      pad: this.buildBus(this.padLevel),
      cue: this.buildBus(this.cueLevel),
    };
    this.startTicker();
  }

  /**
   * Build one bus chain. The "static" segment never changes:
   *   inputGain → master, eqLow → eqMid → eqHigh
   * The "variable" segment is master's downstream — either:
   *   master → destination          (EQ bypass, all bands at 0 dB)
   *   master → eqLow → ... → eqHigh → destination  (EQ active)
   * and the destination itself is either ctx.destination (system default)
   * or streamDest (when a custom output device is selected via setSinkId).
   * `routeBus()` is the single place the variable segment is rewired.
   *
   * Why bypass at 0 dB: three biquads in series introduce a small but
   * audible phase response at peaks/troughs even with flat gain. A
   * revealing system reads it as "muddy." Bypassing entirely guarantees
   * a transparent path for users who never touch the EQ sliders.
   */
  private buildBus(initialInputLevel: number): BusChain {
    const inputGain = this.ctx.createGain();
    inputGain.gain.value = initialInputLevel;

    const master = this.ctx.createGain();
    master.gain.value = this.masterLevel;

    const eqLow = this.ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 200;
    eqLow.gain.value = this.eqValues.low;

    const eqMid = this.ctx.createBiquadFilter();
    eqMid.type = 'peaking';
    eqMid.frequency.value = 1000;
    eqMid.Q.value = 1;
    eqMid.gain.value = this.eqValues.mid;

    const eqHigh = this.ctx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = 5000;
    eqHigh.gain.value = this.eqValues.high;

    const streamDest = this.ctx.createMediaStreamDestination();

    // Static wiring — the EQ trio stays wired internally; only master's
    // output and eqHigh's output are rewired by routeBus().
    inputGain.connect(master);
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);

    // Audio element exists but is paused; only used when a custom device
    // is selected via setOutputDevice.
    const audioEl = new Audio();
    audioEl.srcObject = streamDest.stream;
    audioEl.style.display = 'none';

    // Level meter tap. Hangs off the master node in PARALLEL — feeding
    // an AnalyserNode in-line would add 1024 samples of latency to the
    // audible signal. The analyser doesn't need to be connected to the
    // ctx destination since AnalyserNode reads samples passed through
    // it regardless of downstream connections (it's effectively a
    // passthrough that also records the most recent frame). 512-sample
    // window gives ~10ms resolution at 48k — plenty for a UI meter.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.2;
    master.connect(analyser);
    const analyserBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));

    const chain: BusChain = {
      inputGain, master, eqLow, eqMid, eqHigh,
      streamDest, audioEl,
      currentDeviceId: null,
      analyser, analyserBuf,
    };
    // Initial wiring: default destination, EQ state determined by current
    // eqValues (typically all zero on first launch → bypass path).
    this.routeBus(chain, this.ctx.destination);
    return chain;
  }

  /** True when any EQ band is non-zero. Drives the bypass decision. */
  private isEqActive(): boolean {
    return this.eqValues.low !== 0 || this.eqValues.mid !== 0 || this.eqValues.high !== 0;
  }

  /**
   * (Re)wire master's downstream + eqHigh's downstream to land at
   * `target`. Handles both default-destination and stream-destination
   * targets, and EQ-on / EQ-off states.
   */
  private routeBus(chain: BusChain, target: AudioNode): void {
    // Disconnect everything master and eqHigh currently feed.
    try { chain.master.disconnect(); } catch {}
    try { chain.eqHigh.disconnect(); } catch {}
    if (this.isEqActive()) {
      chain.master.connect(chain.eqLow);
      chain.eqHigh.connect(target);
    } else {
      chain.master.connect(target);
    }
    // The analyser tap also hangs off master, so it gets blown away by
    // the disconnect above. Reattach it here so the level meters keep
    // reading post-fader after every routing change (output device
    // swap, EQ bypass toggle, etc.). buildBus may call routeBus before
    // chain.analyser is fully assigned, so guard against that.
    if (chain.analyser) chain.master.connect(chain.analyser);
  }

  /** What's the current target for this bus (destination or stream)? */
  private currentTargetFor(chain: BusChain): AudioNode {
    return chain.currentDeviceId ? chain.streamDest : this.ctx.destination;
  }

  /**
   * Route a bus to a specific output device. Pass null/empty to fall back
   * to the AudioContext destination (system default — no MediaStream chain).
   * Safe to call repeatedly; no-op when device unchanged.
   */
  async setOutputDevice(bus: RoutableBus, deviceId: string | null): Promise<void> {
    const chain = this.buses[bus];
    const target = deviceId || '';
    if (chain.currentDeviceId === target) return;

    if (target === '') {
      // Switch back to default route: ctx.destination, pause the audio
      // element so it stops driving the MediaStream.
      chain.currentDeviceId = '';
      this.routeBus(chain, this.ctx.destination);
      try { chain.audioEl.pause(); } catch {}
      return;
    }

    // Switch to custom-device route via MediaStreamAudioDestinationNode +
    // HTMLAudioElement.setSinkId.
    this.routeBus(chain, chain.streamDest);
    try {
      await (chain.audioEl as any).setSinkId(target);
      chain.currentDeviceId = target;
      if (chain.audioEl.paused) void chain.audioEl.play().catch(() => {});
    } catch (err) {
      console.warn(`[audio] setSinkId failed for ${bus} → ${deviceId}, reverting to default`, err);
      chain.currentDeviceId = '';
      this.routeBus(chain, this.ctx.destination);
      try { chain.audioEl.pause(); } catch {}
    }
  }

  /**
   * Public node the editor connects its preview source to. Plays through the
   * cue bus so preview audio is routed independently from the main FOH outs.
   */
  getCueOutputNode(): AudioNode {
    return this.buses.cue.inputGain;
  }

  /** Set EQ band gains in dB across every bus mirror. Range ±24, typical ±12. */
  setEq(low: number, mid: number, high: number): void {
    const now = this.ctx.currentTime;
    const clamp = (v: number) => Math.max(-24, Math.min(24, v));
    const wasActive = this.isEqActive();
    this.eqValues = { low: clamp(low), mid: clamp(mid), high: clamp(high) };
    for (const bus of Object.values(this.buses)) {
      bus.eqLow.gain.cancelScheduledValues(now);
      bus.eqLow.gain.linearRampToValueAtTime(this.eqValues.low, now + 0.03);
      bus.eqMid.gain.cancelScheduledValues(now);
      bus.eqMid.gain.linearRampToValueAtTime(this.eqValues.mid, now + 0.03);
      bus.eqHigh.gain.cancelScheduledValues(now);
      bus.eqHigh.gain.linearRampToValueAtTime(this.eqValues.high, now + 0.03);
    }
    // If the active/bypass state flipped, re-route every bus so the EQ
    // chain gets switched in or out of the signal path entirely.
    const nowActive = this.isEqActive();
    if (wasActive !== nowActive) {
      for (const bus of Object.values(this.buses)) {
        this.routeBus(bus, this.currentTargetFor(bus));
      }
    }
  }

  getEq(): { low: number; mid: number; high: number } {
    return { ...this.eqValues };
  }

  // ---- Buffer loading ----

  async loadBuffer(filePath: string): Promise<AudioBuffer> {
    if (this.bufferCache.has(filePath)) {
      return this.bufferCache.get(filePath)!;
    }
    // Use the custom runway-audio:// scheme registered in the main process.
    // Electron blocks fetching file:// URLs from the renderer for security.
    const url = filePathToUrl(filePath);
    const res = await fetch(url);
    const arrayBuf = await res.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(arrayBuf);
    this.bufferCache.set(filePath, buffer);
    return buffer;
  }

  evictBuffer(filePath: string) {
    this.bufferCache.delete(filePath);
  }

  // ---- Music bus playback ----

  async playMusic(filePath: string, opts?: {
    fadeInSec?: number;
    trackId?: string;
    startAtSec?: number;
    endAtSec?: number;
    fadeOutSec?: number;
    /** Buffer offset where the segment begins (= trimStart). Defaults to startAtSec. */
    segmentStartSec?: number;
  }): Promise<void> {
    // playMusic owns the music bus via the reactive path. If a precise
    // schedule is currently in charge, tear it down first so the two
    // can't fight over the bus.
    if (this.musicScheduled) {
      const now = this.ctx.currentTime;
      for (const t of this.musicScheduled.tracks) {
        try { t.source.stop(now); } catch {}
      }
      this.musicScheduled = null;
    }
    const callEntryMs = Date.now();
    await this.ensureRunning();
    const buffer = await this.loadBuffer(filePath);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    source.connect(gain).connect(this.musicGain);

    let startOffset = Math.max(0, opts?.startAtSec ?? 0);
    const endOffset = Math.min(buffer.duration, opts?.endAtSec ?? buffer.duration);
    const segmentStart = Math.max(0, Math.min(opts?.segmentStartSec ?? startOffset, endOffset));
    // Compensate ONLY for time spent inside this function (ensureRunning +
    // loadBuffer awaits) — the caller is expected to have computed
    // startAtSec for the wall-clock moment they invoked playMusic. Skipping
    // ahead by the measured await delay keeps audible content lined up
    // with the caller's schedule despite decode/context-resume latency.
    // (We deliberately don't accept an external scheduleClockMs here —
    // doing so was double-counting against beginMusic's existing lateSec
    // adjustment and pushing playback minutes ahead.)
    const internalLateSec = Math.max(0, (Date.now() - callEntryMs) / 1000);
    if (internalLateSec > 0.02) {
      startOffset = Math.min(endOffset - 0.05, startOffset + internalLateSec);
    }
    const playDuration = Math.max(0.01, endOffset - startOffset);
    const fadeIn = Math.max(0, Math.min(opts?.fadeInSec ?? 0, playDuration / 2));
    const fadeOut = Math.max(0, Math.min(opts?.fadeOutSec ?? 0, playDuration / 2));
    const now = this.ctx.currentTime;

    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + fadeIn);
    } else {
      gain.gain.value = 1;
    }
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(1, now + playDuration - fadeOut);
      gain.gain.linearRampToValueAtTime(0, now + playDuration);
    }

    source.start(now, startOffset);
    // Hard stop at the trim end (if any).
    if (opts?.endAtSec !== undefined) {
      source.stop(now + playDuration + 0.05);
    }

    // Stop the previous source
    if (this.currentMusic) {
      this.stopSource(this.currentMusic, 0);
    }

    this.currentMusic = {
      source, gain, buffer,
      startedAt: now,
      startedFromSec: startOffset,
      endAtSec: endOffset,
      segmentStartSec: segmentStart,
      trackId: opts?.trackId,
      filePath,
    };
    this.notify();
  }

  async crossfadeToMusic(filePath: string, opts: {
    crossfadeSec: number;
    trackId?: string;
    startAtSec?: number;
    endAtSec?: number;
    fadeOutSec?: number;
    segmentStartSec?: number;
  }): Promise<void> {
    // A swap-to-playlist mid-runway (or post-service starting after a
    // pre-service) calls crossfadeToMusic. If a precise schedule owns the
    // bus, fall back to playMusic — the schedule needs to be torn down
    // anyway, and playMusic does that. The next track plays via the
    // reactive path from here on.
    if (this.musicScheduled) {
      return this.playMusic(filePath, {
        fadeInSec: opts.crossfadeSec,
        trackId: opts.trackId,
        startAtSec: opts.startAtSec,
        endAtSec: opts.endAtSec,
        fadeOutSec: opts.fadeOutSec,
        segmentStartSec: opts.segmentStartSec,
      });
    }
    await this.ensureRunning();
    if (!this.currentMusic) {
      return this.playMusic(filePath, {
        fadeInSec: opts.crossfadeSec,
        trackId: opts.trackId,
        startAtSec: opts.startAtSec,
        endAtSec: opts.endAtSec,
        fadeOutSec: opts.fadeOutSec,
        segmentStartSec: opts.segmentStartSec,
      });
    }

    const buffer = await this.loadBuffer(filePath);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const gain = this.ctx.createGain();
    source.connect(gain).connect(this.musicGain);

    const now = this.ctx.currentTime;
    const fade = opts.crossfadeSec;
    const startOffset = Math.max(0, opts.startAtSec ?? 0);
    const endOffset = Math.min(buffer.duration, opts.endAtSec ?? buffer.duration);
    const segmentStart = Math.max(0, Math.min(opts.segmentStartSec ?? startOffset, endOffset));
    const playDuration = Math.max(0.01, endOffset - startOffset);
    const fadeOut = Math.max(0, Math.min(opts.fadeOutSec ?? 0, playDuration / 2));

    // crossfadeToMusic is the reactive path — used by post-service runways,
    // quick-play, action-driven swaps, and clickTimeline seeks. All of these
    // want the new track to start NOW, fading in over `fade`, with the old
    // track ramping out over the same window. (Pre-service runways use
    // scheduleRunway instead, which is deterministic by construction.)
    // Ramp new track up
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + fade);
    if (fadeOut > 0) {
      gain.gain.setValueAtTime(1, now + playDuration - fadeOut);
      gain.gain.linearRampToValueAtTime(0, now + playDuration);
    }
    source.start(now, startOffset);
    if (opts.endAtSec !== undefined) {
      source.stop(now + playDuration + 0.05);
    }

    // Ramp old track down and stop
    const old = this.currentMusic;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + fade);
    old.source.stop(now + fade + 0.05);

    this.currentMusic = {
      source, gain, buffer,
      startedAt: now,
      startedFromSec: startOffset,
      endAtSec: endOffset,
      segmentStartSec: segmentStart,
      trackId: opts.trackId,
      filePath,
    };
    this.notify();
  }

  fadeOutMusic(durationSec: number): void {
    if (this.musicScheduled) {
      const now = this.ctx.currentTime;
      const g = this.musicScheduled.muteGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + durationSec);
      // Stop any source still playing at end of fade so the buffer cache
      // doesn't leak silent buffer sources.
      for (const t of this.musicScheduled.tracks) {
        if (t.scheduledEndCtx > now + durationSec) {
          try { t.source.stop(now + durationSec + 0.05); } catch {}
        }
      }
      this.musicScheduled = null;
      setTimeout(() => this.notify(), durationSec * 1000 + 100);
      return;
    }
    if (!this.currentMusic) return;
    const now = this.ctx.currentTime;
    const old = this.currentMusic;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + durationSec);
    old.source.stop(now + durationSec + 0.05);
    this.currentMusic = null;
    setTimeout(() => this.notify(), durationSec * 1000 + 100);
  }

  /**
   * Fade the currently-playing music to silence WITHOUT stopping the
   * source. Used by fadeToPad — the song keeps advancing in the
   * background (so the runway timeline stays accurate and the
   * operator can bring volume back up at any moment), but is
   * inaudible while the pad covers the room. Distinct from
   * fadeOutMusic, which hard-stops the source at the end of the fade.
   */
  fadeMusicToSilence(durationSec: number): void {
    if (this.musicScheduled) {
      const now = this.ctx.currentTime;
      const g = this.musicScheduled.muteGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + Math.max(0.05, durationSec));
      return;
    }
    if (!this.currentMusic) return;
    const now = this.ctx.currentTime;
    const m = this.currentMusic;
    m.gain.gain.cancelScheduledValues(now);
    m.gain.gain.setValueAtTime(m.gain.gain.value, now);
    m.gain.gain.linearRampToValueAtTime(0, now + Math.max(0.05, durationSec));
  }

  /**
   * Reverse of fadeMusicToSilence — ramp the per-source music gain
   * back to unity. Used by the Fade-to-Pad toggle to bring music
   * back without restarting the source (preserving position).
   */
  restoreMusicLevel(durationSec: number): void {
    if (this.musicScheduled) {
      const now = this.ctx.currentTime;
      const g = this.musicScheduled.muteGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(1, now + Math.max(0.05, durationSec));
      return;
    }
    if (!this.currentMusic) return;
    const now = this.ctx.currentTime;
    const m = this.currentMusic;
    m.gain.gain.cancelScheduledValues(now);
    m.gain.gain.setValueAtTime(m.gain.gain.value, now);
    m.gain.gain.linearRampToValueAtTime(1, now + Math.max(0.05, durationSec));
  }

  stopMusic(): void {
    if (this.musicScheduled) {
      const now = this.ctx.currentTime;
      for (const t of this.musicScheduled.tracks) {
        try { t.source.stop(now); } catch {}
      }
      this.musicScheduled = null;
      this.notify();
      return;
    }
    if (!this.currentMusic) return;
    this.stopSource(this.currentMusic, 0);
    this.currentMusic = null;
    this.notify();
  }

  /**
   * Schedule a complete runway up front using Web Audio's precise
   * timing. Every source.start, source.stop, and crossfade gain ramp
   * is committed to ctx.currentTime + N at the moment of this call,
   * so playback timing is immune to tick granularity, decode latency,
   * and JS event-loop jitter. Used for pre-service runways where the
   * operator doesn't skip/scrub mid-play. Post-service and quick-play
   * still use the reactive playMusic/crossfadeToMusic path.
   *
   * The schedule routes all per-track gains through a single muteGain
   * so fade-to-pad / fade-to-silence can mute the runway without
   * disturbing the per-track crossfade envelopes.
   */
  async scheduleRunway(opts: {
    tracks: ScheduledTrackInput[];
    crossfadeSec: number;
    /** Skip this many seconds of audible content from the FIRST track. */
    firstTrackOffsetSec: number;
    /** Fade in for the first track. Only applied if firstTrackOffsetSec === 0. */
    musicFadeInSec?: number;
  }): Promise<void> {
    // Tear down any previous music — scheduleRunway is the new authoritative
    // source on the music bus.
    if (this.currentMusic) {
      this.stopSource(this.currentMusic, 0);
      this.currentMusic = null;
    }
    if (this.musicScheduled) {
      const now = this.ctx.currentTime;
      for (const t of this.musicScheduled.tracks) {
        try { t.source.stop(now); } catch {}
      }
      this.musicScheduled = null;
    }

    await this.ensureRunning();

    const callEntryMs = Date.now();
    const buffers = await Promise.all(opts.tracks.map(t => this.loadBuffer(t.filePath)));
    const loadElapsed = (Date.now() - callEntryMs) / 1000;

    // Tiny lead-in so the first source.start is reliably in the future
    // even after the loadBuffer await microtask.
    const leadIn = Math.max(0.05, loadElapsed + 0.02);
    const ctxStart = this.ctx.currentTime + leadIn;
    const fade = opts.crossfadeSec;

    const muteGain = this.ctx.createGain();
    muteGain.gain.setValueAtTime(1, this.ctx.currentTime);
    muteGain.connect(this.musicGain);

    const scheduled: ScheduledTrack[] = [];
    let cumWallclock = 0;

    for (let i = 0; i < opts.tracks.length; i++) {
      const t = opts.tracks[i];
      const buffer = buffers[i];
      const isFirst = i === 0;
      const isLast = i === opts.tracks.length - 1;

      const trimStart = Math.max(0, t.trimStartSec ?? 0);
      const trimEnd = Math.min(buffer.duration, t.trimEndSec ?? buffer.duration);
      const offsetInTrack = isFirst ? Math.max(0, opts.firstTrackOffsetSec) : 0;
      const startOffset = Math.min(trimEnd - 0.05, trimStart + offsetInTrack);
      const playDuration = Math.max(0.01, trimEnd - startOffset);

      const trackStartCtx = ctxStart + cumWallclock;
      const trackEndCtx = trackStartCtx + playDuration;

      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      const gain = this.ctx.createGain();
      source.connect(gain).connect(muteGain);

      // Gain envelope. First scheduled track gets the caller's
      // `musicFadeInSec` (no offset gate — the controller decides when
      // to pass 0 vs a value; engine just respects it). Subsequent
      // tracks: crossfade-in from 0 over `fade` seconds.
      const fadeIn = isFirst
        ? Math.max(0, opts.musicFadeInSec ?? 0)
        : fade;

      if (fadeIn > 0) {
        const actualFadeIn = Math.min(fadeIn, playDuration / 2);
        gain.gain.setValueAtTime(0, trackStartCtx);
        gain.gain.linearRampToValueAtTime(1, trackStartCtx + actualFadeIn);
      } else {
        gain.gain.setValueAtTime(1, trackStartCtx);
      }

      // Fade-out at end. Non-last tracks use the playlist's crossfade
      // duration. The LAST track applies its operator-set
      // `editFadeOutSec` (if any) so the editor's non-destructive fade
      // is honored on the anchor — previously the engine skipped this,
      // since the controller historically managed an external fade-out
      // for the pad-bridge transition.
      //
      // CRITICAL: this only schedules the gain ramp INSIDE the existing
      // play window. trackEndCtx and trackStartCtx are NOT touched, so
      // when music ends is unchanged — only how it fades out at that
      // moment. When the controller also runs its own external fade
      // (e.g. fadeOutMusic during a pad bridge with no service-land
      // tail), both gain stages multiply; that case is the operator's
      // own choice when they set editFadeOutSec on top of a pad-bridge
      // service. Default behaviour with editFadeOutSec=0/undefined
      // matches the prior (no engine-level fade on last track).
      const perTrackFadeOut = !isLast
        ? fade
        : Math.max(0, t.fadeOutSec ?? 0);
      if (perTrackFadeOut > 0) {
        const fadeOutStart = trackEndCtx - perTrackFadeOut;
        const earliestSafe = trackStartCtx + (fadeIn > 0 ? Math.min(fadeIn, playDuration / 2) : 0);
        if (fadeOutStart > earliestSafe) {
          gain.gain.setValueAtTime(1, fadeOutStart);
          gain.gain.linearRampToValueAtTime(0, trackEndCtx);
        }
      }

      source.start(trackStartCtx, startOffset);
      source.stop(trackEndCtx + 0.05);

      scheduled.push({
        source, gain, buffer,
        trackId: t.trackId,
        filePath: t.filePath,
        scheduledStartCtx: trackStartCtx,
        scheduledEndCtx: trackEndCtx,
        startedFromSec: startOffset,
        segmentStartSec: trimStart,
        endAtSec: trimEnd,
      });

      // Wall-clock contribution: every non-last track is shortened by
      // `fade` because the next track starts that many seconds before
      // this one ends.
      cumWallclock += isLast ? playDuration : (playDuration - fade);
    }

    this.musicScheduled = {
      tracks: scheduled,
      muteGain,
      startedAtCtx: ctxStart,
      endsAtCtx: scheduled[scheduled.length - 1].scheduledEndCtx,
    };
    // Diagnostic — captures the engine-side wall-clock schedule so any
    // discrepancy between "scheduled to end" and "actually ended"
    // surfaces in console logs.
    const ctxNow = this.ctx.currentTime;
    const endsAtCtx = scheduled[scheduled.length - 1].scheduledEndCtx;
    console.log('[scheduleRunway] scheduled', {
      trackCount: opts.tracks.length,
      crossfadeSec: opts.crossfadeSec,
      firstTrackOffsetSec: +opts.firstTrackOffsetSec.toFixed(2),
      musicFadeInSec: +(opts.musicFadeInSec ?? 0).toFixed(2),
      loadElapsedSec: +loadElapsed.toFixed(3),
      leadInSec: +leadIn.toFixed(3),
      ctxStartFromNowSec: +(ctxStart - ctxNow).toFixed(2),
      cumWallclockSec: +cumWallclock.toFixed(2),
      endsAtCtxFromNowSec: +(endsAtCtx - ctxNow).toFixed(2),
    });
    this.notify();
  }

  /**
   * Resolve which scheduled track is "current" for state-reporting
   * purposes. During a crossfade window two tracks overlap; we pick
   * the newer (later-starting) one since the listener perceives it
   * taking over. Falls back to the most recently ended track if the
   * schedule is exhausted but we haven't torn it down yet.
   */
  private currentScheduledTrack(): ScheduledTrack | null {
    if (!this.musicScheduled) return null;
    const now = this.ctx.currentTime;
    const tracks = this.musicScheduled.tracks;
    let current: ScheduledTrack | null = null;
    for (const t of tracks) {
      if (t.scheduledStartCtx <= now && t.scheduledEndCtx > now) {
        current = t;
      }
    }
    if (!current) {
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i].scheduledStartCtx <= now) {
          current = tracks[i];
          break;
        }
      }
    }
    return current;
  }

  /**
   * Jump to `toSec` within the current segment (segment-relative — 0 is the
   * start of the trimmed region). Preserves trimEnd so trimmed-off audio
   * (e.g. applause) doesn't play after a seek.
   */
  async seekMusic(toSec: number): Promise<void> {
    const cur = this.currentMusic;
    if (!cur) return;
    const segLen = Math.max(0, (cur.endAtSec ?? cur.buffer.duration) - cur.segmentStartSec);
    const targetInSegment = Math.max(0, Math.min(segLen, toSec));
    await this.playMusic(cur.filePath, {
      startAtSec: cur.segmentStartSec + targetInSegment,
      endAtSec: cur.endAtSec,
      segmentStartSec: cur.segmentStartSec,
      trackId: cur.trackId,
      fadeInSec: 0,
    });
  }

  /**
   * Music position relative to the current segment (post-trim). 0 = segment
   * start, durationSec = segment length. Returns 0 if nothing is playing.
   */
  getMusicPosition(): { positionSec: number; durationSec: number } {
    if (this.musicScheduled) {
      const t = this.currentScheduledTrack();
      if (!t) return { positionSec: 0, durationSec: 0 };
      const elapsed = this.ctx.currentTime - t.scheduledStartCtx;
      const segLen = Math.max(0, t.endAtSec - t.segmentStartSec);
      const posInSegment = (t.startedFromSec - t.segmentStartSec) + elapsed;
      return {
        positionSec: Math.max(0, Math.min(posInSegment, segLen)),
        durationSec: segLen,
      };
    }
    const cur = this.currentMusic;
    if (!cur) return { positionSec: 0, durationSec: 0 };
    const elapsed = this.ctx.currentTime - cur.startedAt;
    const effectiveEnd = cur.endAtSec ?? cur.buffer.duration;
    const segLen = Math.max(0, effectiveEnd - cur.segmentStartSec);
    const posInSegment = (cur.startedFromSec - cur.segmentStartSec) + elapsed;
    return {
      positionSec: Math.max(0, Math.min(posInSegment, segLen)),
      durationSec: segLen,
    };
  }

  // ---- Pad bus ----

  async playPad(filePath: string, opts?: {
    fadeInSec?: number;
    loop?: boolean;
  }): Promise<void> {
    await this.ensureRunning();
    const buffer = await this.loadBuffer(filePath);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts?.loop ?? true;
    const gain = this.ctx.createGain();
    source.connect(gain).connect(this.padGain);

    const now = this.ctx.currentTime;
    const fadeIn = opts?.fadeInSec ?? 1.0;
    if (fadeIn > 0) {
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(1, now + fadeIn);
    } else {
      gain.gain.value = 1;
    }
    source.start(now);

    if (this.currentPad) {
      this.stopSource(this.currentPad, 0.2);
    }

    this.currentPad = {
      source, gain, buffer,
      startedAt: now,
      startedFromSec: 0,
      segmentStartSec: 0,
      filePath,
      isLooping: source.loop,
    };
    this.notify();
  }

  /**
   * Pad position in seconds within the current loop. Returns 0 if nothing is playing.
   * If looping, position wraps modulo the buffer's duration.
   */
  getPadPosition(): { positionSec: number; durationSec: number; isLooping: boolean } {
    const cur = this.currentPad;
    if (!cur) return { positionSec: 0, durationSec: 0, isLooping: false };
    const elapsed = this.ctx.currentTime - cur.startedAt;
    let pos = cur.startedFromSec + elapsed;
    if (cur.isLooping && cur.buffer.duration > 0) {
      pos = pos % cur.buffer.duration;
    } else {
      pos = Math.min(pos, cur.buffer.duration);
    }
    return { positionSec: pos, durationSec: cur.buffer.duration, isLooping: !!cur.isLooping };
  }

  fadeOutPad(durationSec: number): void {
    if (!this.currentPad) return;
    const now = this.ctx.currentTime;
    const old = this.currentPad;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + durationSec);
    old.source.stop(now + durationSec + 0.05);
    this.currentPad = null;
    setTimeout(() => this.notify(), durationSec * 1000 + 100);
  }

  stopPad(): void {
    if (!this.currentPad) return;
    this.stopSource(this.currentPad, 0);
    this.currentPad = null;
    this.notify();
  }

  // ---- Master controls ----

  panicFadeAll(durationSec: number): void {
    this.fadeOutMusic(durationSec);
    this.fadeOutPad(durationSec);
  }

  /**
   * Fade a bus's input gain to a target percentage of unity (0..100,
   * where 100 = no boost, matches the bus's natural level). Capped at
   * 100% — actions can't push past unity so an accidental high value
   * can't clip downstream. durationSec=0 = instant.
   */
  fadeBusToPct(bus: 'music' | 'pad' | 'cue', percent: number, durationSec: number): void {
    const node = this.buses[bus]?.inputGain;
    if (!node) return;
    const target = Math.max(0, Math.min(1, percent / 100));
    const now = this.ctx.currentTime;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(node.gain.value, now);
    if (durationSec <= 0) {
      node.gain.setValueAtTime(target, now);
    } else {
      node.gain.linearRampToValueAtTime(target, now + durationSec);
    }
    // Keep level cache in sync so the master fader UI reads correctly.
    if (bus === 'music') this.musicLevel = target;
    else if (bus === 'pad') this.padLevel = target;
    else if (bus === 'cue') this.cueLevel = target;
  }

  /**
   * Reset all per-bus input gains to unity. Called on every fresh arm
   * so a previous run's audio_fade actions can't carry their state
   * forward — the operator gets a clean slate without having to touch
   * the master fader.
   */
  resetBusLevels(): void {
    this.fadeBusToPct('music', 100, 0);
    this.fadeBusToPct('pad', 100, 0);
    this.fadeBusToPct('cue', 100, 0);
  }

  setMusicLevel(level: number): void {
    this.musicLevel = Math.max(0, Math.min(1, level));
    this.smoothGain(this.musicGain, this.musicLevel);
  }

  setPadLevel(level: number): void {
    // Allow boost above unity for trim (up to +12 dB ≈ 4×) — the engine's
    // master + master output device clip protection still applies downstream.
    this.padLevel = Math.max(0, Math.min(4, level));
    this.smoothGain(this.padGain, this.padLevel);
  }

  /** Master output level (rides everything). 0 = silence, 1 = unity.
   *  Updates the per-bus master mirror nodes so every output respects it.
   *  When muted, the slider value is stored but the actual gain is forced to 0. */
  setMasterLevel(level: number): void {
    this.masterLevel = Math.max(0, Math.min(1, level));
    const effective = this.masterMuted ? 0 : this.masterLevel;
    for (const bus of Object.values(this.buses)) {
      this.smoothGain(bus.master, effective);
    }
  }

  getMasterLevel(): number {
    return this.masterLevel;
  }

  // Mute is a separate concern from level so we can flip silence on/off
  // without losing where the user had the slider.
  private masterMuted = false;
  setMasterMuted(muted: boolean): void {
    this.masterMuted = muted;
    const effective = muted ? 0 : this.masterLevel;
    for (const bus of Object.values(this.buses)) {
      this.smoothGain(bus.master, effective);
    }
  }
  getMasterMuted(): boolean {
    return this.masterMuted;
  }

  /** Independent cue level (e.g. headphone preview). Doesn't affect music/pad. */
  setCueLevel(level: number): void {
    this.cueLevel = Math.max(0, Math.min(1, level));
    this.smoothGain(this.buses.cue.inputGain, this.cueLevel);
  }

  getCueLevel(): number {
    return this.cueLevel;
  }

  /**
   * Read live post-fader peak + RMS levels from each bus analyser, in
   * linear amplitude (0..1). Called by the renderer's level-meter
   * heartbeat (~30 Hz) so the Live view can paint VU bars without each
   * paint having to set up its own time-domain reader.
   */
  getBusLevels(): Record<RoutableBus, { peak: number; rms: number }> {
    const read = (bus: BusChain) => {
      bus.analyser.getFloatTimeDomainData(bus.analyserBuf);
      let peak = 0;
      let sumSq = 0;
      const buf = bus.analyserBuf;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
        sumSq += buf[i] * buf[i];
      }
      return { peak, rms: Math.sqrt(sumSq / buf.length) };
    };
    return {
      music: read(this.buses.music),
      pad: read(this.buses.pad),
      cue: read(this.buses.cue),
    };
  }

  /** Expose the audio context for components like the Editor that want to
   * play back an isolated source (bypassing the music/pad bus). */
  getContextForEditor(): AudioContext {
    return this.ctx;
  }

  /** Smoothly ramp a gain node to `target` over ~30ms to avoid zipper noise. */
  private smoothGain(node: GainNode, target: number) {
    const now = this.ctx.currentTime;
    const cur = node.gain.value;
    node.gain.cancelScheduledValues(now);
    node.gain.setValueAtTime(cur, now);
    node.gain.linearRampToValueAtTime(target, now + 0.03);
  }

  // ---- State ----

  getState(bus: BusName): PlaybackState {
    if (bus === 'music' && this.musicScheduled) {
      const t = this.currentScheduledTrack();
      const now = this.ctx.currentTime;
      if (!t) {
        return {
          isPlaying: false,
          currentPositionSec: 0,
          currentDurationSec: 0,
          busName: bus,
        };
      }
      // Schedule has run past its end — playback is over, but we keep
      // the schedule object around briefly for crossfade tail handling.
      // Return the empty state so Now Playing clears instead of pinning
      // the last track's info on screen.
      if (now >= this.musicScheduled.endsAtCtx) {
        return {
          isPlaying: false,
          currentPositionSec: 0,
          currentDurationSec: 0,
          busName: bus,
        };
      }
      const elapsed = now - t.scheduledStartCtx;
      const segLen = Math.max(0.01, t.endAtSec - t.segmentStartSec);
      const posInSegment = (t.startedFromSec - t.segmentStartSec) + elapsed;
      return {
        isPlaying: true,
        currentTrackId: t.trackId,
        currentFilePath: t.filePath,
        currentPositionSec: Math.max(0, Math.min(posInSegment, segLen)),
        currentDurationSec: segLen,
        busName: bus,
      };
    }
    const active = bus === 'music' ? this.currentMusic : this.currentPad;
    if (!active) {
      return {
        isPlaying: false,
        currentPositionSec: 0,
        currentDurationSec: 0,
        busName: bus,
      };
    }
    const elapsed = this.ctx.currentTime - active.startedAt;
    const effectiveEnd = active.endAtSec ?? active.buffer.duration;
    const segLen = Math.max(0.01, effectiveEnd - active.segmentStartSec);
    // Position is reported relative to the segment start, so seeks within the
    // segment don't reset the progress bar to 0.
    const posInSegment = (active.startedFromSec - active.segmentStartSec) + elapsed;
    return {
      isPlaying: true,
      currentTrackId: active.trackId,
      currentFilePath: active.filePath,
      currentPositionSec: Math.max(0, Math.min(posInSegment, segLen)),
      currentDurationSec: segLen,
      busName: bus,
    };
  }

  subscribe(listener: PlaybackListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- Internals ----

  private async ensureRunning(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private stopSource(active: ActiveSource, fadeSec: number) {
    const now = this.ctx.currentTime;
    if (fadeSec > 0) {
      active.gain.gain.cancelScheduledValues(now);
      active.gain.gain.setValueAtTime(active.gain.gain.value, now);
      active.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      try { active.source.stop(now + fadeSec + 0.05); } catch {}
    } else {
      try { active.source.stop(now); } catch {}
    }
  }

  private notify() {
    const stateMusic = this.getState('music');
    const statePad = this.getState('pad');
    this.listeners.forEach(l => l(stateMusic));
    this.listeners.forEach(l => l(statePad));
  }

  private startTicker() {
    const tick = () => {
      // Throttle to ~10 Hz for state updates
      this.notify();
      this.rafHandle = window.setTimeout(tick, 100) as unknown as number;
    };
    tick();
  }

  destroy() {
    if (this.rafHandle !== null) clearTimeout(this.rafHandle);
    this.stopMusic();
    this.stopPad();
    this.ctx.close();
  }
}
