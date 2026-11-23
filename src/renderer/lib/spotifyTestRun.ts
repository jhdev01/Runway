/**
 * Spotify test run (experimental, macOS).
 *
 * Plays a Spotify playlist through the Spotify desktop app so its LAST
 * song ends exactly at a countdown's 0:00, then starts the pad in the
 * chosen key and holds it — a rehearsal of a Spotify-driven pre-service
 * runway. It only runs from the Test run button: it never arms, starts or
 * changes a service, and it doesn't use Runway's music bus or scheduling.
 *
 * Method (measured with the Spotify timing test, ~0.06 s worst case):
 *   - start each song silent a little early (Spotify takes ~0.45 s to
 *     load), wait until it reports playing, then jump to where it should
 *     be, aiming slightly ahead because jumps land ~0.1 s late;
 *   - Runway only ever jumps while Spotify is silent. A jump is a small
 *     audible skip, so there are no corrections mid-song. The first song
 *     starts silent well early so its placement can be checked and redone
 *     before the fade-in;
 *   - while each song plays, the playhead is only read (volume is sent
 *     only when a fade changes it), and how far that song landed from plan
 *     tunes the aim for the next song's jump.
 */

import type { AudioEngine } from './audioEngine';
import type { KeyName, SpotifyPlaylistTrack, SpotifyPlayerCommand, SpotifyPlayerReply, SpotifyTrackEdit } from '@shared/types';

const PREROLL_MS = 4000;          // gap between pressing Start and the first song
const LOAD_LEAD_MS = 700;         // start each song this early, silent
const LOAD_TIMEOUT_MS = 5000;
const RESTART_MAX_SEC = 5;        // "loaded" = playing near the top of the song
const SEEK_AIM_AHEAD_SEC = 0.1;   // starting aim: jumps landed ~0.07–0.13 s late in testing
const AIM_MIN_SEC = 0;
const AIM_MAX_SEC = 0.25;
const FIRST_SONG_LEAD_MS = 2600;  // first song starts this early, silent, to check its placement
const PLACE_TOLERANCE_MS = 40;    // re-place the first song (still silent) if further off than this
const STEP_MS = 250;              // volume step / playhead reading interval
const FIRST_FADE_IN_SEC = 4;
// Song changes are back to back, like Spotify's own playback: a song that
// starts at its beginning only gets a click-free ramp (its intro does the
// rest), and one that plays to its natural ending gets no fade at all (its
// own ending does). Real fades only where a song is cut: a trimmed start or
// end, the first song, or a fade the operator set.
const TRANSITION_FADE_IN_SEC = 1.5;   // song starting mid-way (trimmed / joined)
const TRANSITION_FADE_OUT_SEC = 2.5;  // song cut before its natural ending
const NATURAL_START_RAMP_SEC = 0.3;   // song starting at 0:00
const SETTLE_AFTER_SEEK_MS = 600; // ignore readings right after a jump
// Right after a jump Spotify can still report the old position for a
// moment. The first-song check waits longer, and only readings that agree
// with each other and are plausibly small tune the aim; a big but steady
// offset is fixed by jumping again, without moving the aim.
const VERIFY_SETTLE_MS = 900;
const AIM_TRUST_MS = 300;         // offsets bigger than this don't teach the aim
const AIM_STEP_MAX_SEC = 0.08;    // most the aim may move per lesson
const MIN_FIRST_SEGMENT_SEC = 8;  // drop a first song that would only play a few seconds
const LANDING_WINDOW_MS = 8000;   // landing error = readings in the last 8 s
// Spotify paused or switched songs by accident: after this long, Runway
// restarts the right song (silent), jumps it back to where the plan says
// it should be, and fades it back in.
const RECOVER_AFTER_MS = 1500;
const RECOVER_FADE_MS = 1500;
const MAX_RECOVERIES_PER_SONG = 5;
// Silence Spotify this long before the last song's end, so it can't roll
// into whatever it would play next before the pause arrives. The song's
// own ending covers it.
const END_MUTE_MS = 300;

export interface SpotifyRunSegment {
  uri: string;
  title: string;
  artist: string;
  songDurSec: number;
  startPosSec: number;   // where in the song this segment starts
  endPosSec: number;     // song position at endAt (trim end, or the landing marker for the last song)
  startAt: number;       // wall-clock ms
  endAt: number;         // for the last song: the countdown's 0:00
  stopAt: number;        // when the song goes silent (after endAt only if a landing marker is set)
  fadeInSec?: number;    // operator's per-song fades (undefined = Runway's defaults)
  fadeOutSec?: number;
  trimmedEnd: boolean;   // stops before the song's natural end
  albumArtUrl?: string;
  key?: KeyName;         // operator-set key, for the Live runway chips
}

/** Playable range of a song after the operator's trims, clamped to sane values. */
export function songBounds(durSec: number, e: SpotifyTrackEdit | undefined) {
  const start = Math.min(Math.max(0, e?.trimStartSec ?? 0), Math.max(0, durSec - 1));
  // A 0:00 marker with no End: the marker is where the song's playable range
  // ends for planning; the planner then lets it fade out AFTER 0:00. With an
  // End after the marker, it plays on to that End.
  const landIn = e?.landSec !== undefined && e.landSec > start && e.landSec <= durSec ? e.landSec : undefined;
  const end = Math.min(durSec, Math.max(start + 1, e?.trimEndSec ?? landIn ?? durSec));
  const land = landIn !== undefined && landIn <= end ? landIn : end;
  return { start, end, land };
}

export type SpotifyRunStatus = 'idle' | 'running' | 'landed' | 'stopped' | 'error';

export interface SpotifyRunState {
  status: SpotifyRunStatus;
  segments: SpotifyRunSegment[];
  endAt: number | null;
  currentIndex: number;          // -1 before the first song
  message: string | null;        // latest warning / error / result line
  landingErrorMs: number | null; // + = last song ended late
  corrections: number;           // silent re-placements of the first song
  padKey: KeyName | null;
  padPlaying: boolean;
}

const IDLE: SpotifyRunState = {
  status: 'idle', segments: [], endAt: null, currentIndex: -1, message: null,
  landingErrorMs: null, corrections: 0, padKey: null, padPlaying: false,
};

/**
 * How long the last song keeps sounding after 0:00. With an End later than
 * the marker it plays on to that End. With only a marker it stays at full
 * volume to 0:00 and then fades out over its Fade out (or Runway's Music
 * fade), never past the song's real end.
 */
function afterZeroSec(
  durSec: number,
  b: { start: number; end: number; land: number },
  e: SpotifyTrackEdit | undefined,
  lastFadeSec: number,
): number {
  if (b.land < b.end) return b.end - b.land;
  if (e?.landSec !== undefined && e.trimEndSec === undefined) {
    return Math.max(0, Math.min(e.fadeOutSec ?? lastFadeSec, durSec - b.land));
  }
  return 0;
}

/**
 * Plans the playlist so its last song reaches its landing point (its trim
 * end, or its landing marker) at `endAt` (ms). Songs before it play their
 * trimmed range in full; the first one starts partway in to fit `lengthSec`.
 */
export function planSpotifyRun(
  tracks: SpotifyPlaylistTrack[],
  lengthSec: number | null,
  endAt: number,
  edits: Record<string, SpotifyTrackEdit> = {},
  /** Fade for a last song that stops at its 0:00 marker (Runway's Music fade). */
  lastFadeSec = 5,
): SpotifyRunSegment[] {
  const last = tracks.length - 1;
  const info = tracks.map((t, i) => {
    const dur = t.durationMs / 1000;
    const b = songBounds(dur, edits[t.uri]);
    const endPos = i === last ? b.land : b.end;
    return { t, dur, b, endPos, span: endPos - b.start };
  });
  const total = info.reduce((s, x) => s + x.span, 0);
  let remaining = lengthSec === null ? total : Math.min(lengthSec, total);
  const picked: Array<{ x: typeof info[number]; startPosSec: number; isLast: boolean }> = [];
  for (let i = last; i >= 0 && remaining > 0; i--) {
    const x = info[i];
    if (x.span >= remaining) {
      picked.unshift({ x, startPosSec: x.endPos - remaining, isLast: i === last });
      remaining = 0;
    } else {
      picked.unshift({ x, startPosSec: x.b.start, isLast: i === last });
      remaining -= x.span;
    }
  }
  // A first song that would only play a few seconds just sounds like a glitch.
  if (picked.length > 1 && picked[0].x.endPos - picked[0].startPosSec < MIN_FIRST_SEGMENT_SEC) picked.shift();

  const segs: SpotifyRunSegment[] = [];
  let cursor = endAt;
  for (let i = picked.length - 1; i >= 0; i--) {
    const { x, startPosSec, isLast } = picked[i];
    const e = edits[x.t.uri];
    const startAt = cursor - (x.endPos - startPosSec) * 1000;
    segs.unshift({
      uri: x.t.uri, title: x.t.title, artist: x.t.artist, songDurSec: x.dur,
      startPosSec, endPosSec: x.endPos, startAt, endAt: cursor,
      stopAt: isLast ? cursor + afterZeroSec(x.dur, x.b, e, lastFadeSec) * 1000 : cursor,
      fadeInSec: e?.fadeInSec, fadeOutSec: e?.fadeOutSec,
      trimmedEnd: x.b.end < x.dur - 0.05,
      albumArtUrl: x.t.albumArtUrl,
      key: e?.key,
    });
    cursor = startAt;
  }
  return segs;
}

/** Moves the jump aim by a learned offset (ms), in small capped steps. */
function learnAim(aim: number, offMs: number): number {
  const step = Math.max(-AIM_STEP_MAX_SEC, Math.min(AIM_STEP_MAX_SEC, offMs / 1000));
  return Math.min(AIM_MAX_SEC, Math.max(AIM_MIN_SEC, aim + step));
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

export class SpotifyTestRunner {
  private state: SpotifyRunState = IDLE;
  private listeners = new Set<(s: SpotifyRunState) => void>();
  private runId = 0;
  private originalVolume = 70;
  private audio: AudioEngine | null = null;
  private lastFadeSec = 5;
  private firstFadeInSec = FIRST_FADE_IN_SEC;
  // Operator's Fade to Pad: 0 = Spotify pulled down, 1 = normal. Multiplies
  // the planned envelope so the song keeps its position underneath.
  private manualGain = 1;
  private lastSentVolume = 0;
  // Playlist the songs come from, so Spotify stays in it (not the album).
  private contextUri: string | undefined;
  // Set while stop() is fading Spotify out; a new start waits for it.
  private stopping: Promise<void> | null = null;

  getState(): SpotifyRunState { return this.state; }
  subscribe(fn: (s: SpotifyRunState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private set(patch: Partial<SpotifyRunState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }
  isActive(): boolean { return this.state.status === 'running'; }

  private async cmd(c: SpotifyPlayerCommand): Promise<SpotifyPlayerReply> {
    return window.runway.spotify.player(c);
  }

  async start(opts: {
    tracks: SpotifyPlaylistTrack[];
    lengthSec: number | null;
    padKey: KeyName | null;
    padFilePath: string | null;
    padLeadInSec: number;
    /** Fade for a last song that stops before its natural end (Runway's Music fade). */
    lastFadeSec: number;
    audio: AudioEngine;
    edits?: Record<string, SpotifyTrackEdit>;
    playlistId?: string;
  }): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.isActive()) return;
    const id = ++this.runId;
    this.audio = opts.audio;
    this.contextUri = opts.playlistId ? `spotify:playlist:${opts.playlistId}` : undefined;
    this.lastFadeSec = opts.lastFadeSec;
    this.firstFadeInSec = FIRST_FADE_IN_SEC;
    const check = await this.cmd({ op: 'check' });
    if (!check.ok) { this.set({ ...IDLE, status: 'error', message: check.reason ?? 'Spotify isn’t available.' }); return; }
    this.originalVolume = check.volume && check.volume > 0 ? check.volume : 70;
    await this.cmd({ op: 'volume', volume: 0 });

    // Plan once against a zero end time to learn how long the music runs,
    // then for real so the first song starts PREROLL_MS from now.
    const dry = planSpotifyRun(opts.tracks, opts.lengthSec, 0, opts.edits, opts.lastFadeSec);
    const runMs = dry.length ? -dry[0].startAt : 0;
    const endAt = Date.now() + PREROLL_MS + runMs;
    const segments = planSpotifyRun(opts.tracks, opts.lengthSec, endAt, opts.edits, opts.lastFadeSec);
    if (segments.length === 0) { this.set({ ...IDLE, status: 'error', message: 'Nothing to play in that playlist.' }); return; }
    this.set({ ...IDLE, status: 'running', segments, endAt, padKey: opts.padKey });

    try {
      await this.run(id, segments, endAt, opts);
    } catch (e) {
      if (id !== this.runId) return;
      await this.silence();
      this.set({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Runs an already-planned set of songs (a service's Spotify runway): the
   * last one lands at `endAt` (the service start). No pad here — the
   * service controller brings the pad in as it does for any service.
   * Joins late if called after the first song's start: songs already over
   * are skipped and the current one is placed where it should be by now.
   */
  async startPlanned(opts: {
    segments: SpotifyRunSegment[];
    endAt: number;
    lastFadeSec: number;
    firstFadeInSec: number;
    playlistId?: string;
  }): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.isActive() || opts.segments.length === 0) return;
    const id = ++this.runId;
    this.contextUri = opts.playlistId ? `spotify:playlist:${opts.playlistId}` : undefined;
    this.lastFadeSec = opts.lastFadeSec;
    this.firstFadeInSec = opts.firstFadeInSec;
    const check = await this.cmd({ op: 'check' });
    if (!check.ok) { this.set({ ...IDLE, status: 'error', message: check.reason ?? 'Spotify isn’t available.' }); return; }
    this.originalVolume = check.volume && check.volume > 0 ? check.volume : 70;
    await this.cmd({ op: 'volume', volume: 0 });
    this.manualGain = 1;
    this.set({ ...IDLE, status: 'running', segments: opts.segments, endAt: opts.endAt });
    try {
      await this.run(id, opts.segments, opts.endAt, { padFilePath: null, padLeadInSec: 0 });
    } catch (e) {
      if (id !== this.runId) return;
      await this.silence();
      this.set({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private envelope(seg: SpotifyRunSegment, isFirst: boolean, isLast: boolean, now: number, fadeFrom = seg.startAt): number {
    const fadeIn = seg.fadeInSec ?? (isFirst
      ? this.firstFadeInSec
      : seg.startPosSec < 0.5 ? NATURAL_START_RAMP_SEC : TRANSITION_FADE_IN_SEC);
    let g = fadeIn > 0 ? Math.min(1, Math.max(0, (now - fadeFrom) / 1000 / fadeIn)) : (now >= fadeFrom ? 1 : 0);
    let fadeOut = 0;
    let fadeOutEnd = seg.stopAt;
    if (!isLast) {
      // Played to its natural ending: no fade, the song ends itself.
      fadeOut = seg.fadeOutSec ?? (seg.trimmedEnd ? TRANSITION_FADE_OUT_SEC : 0);
      fadeOutEnd = seg.endAt - LOAD_LEAD_MS;
    } else if (seg.fadeOutSec !== undefined || seg.trimmedEnd || seg.stopAt > seg.endAt) {
      // Last song stopping before its natural end: fade so it doesn't cut off.
      // A fade that would start before 0:00 is shortened so the song stays at
      // full volume up to 0:00 whenever it sounds past it.
      fadeOutEnd = seg.stopAt - END_MUTE_MS;
      fadeOut = seg.fadeOutSec ?? this.lastFadeSec;
      if (seg.stopAt > seg.endAt) fadeOut = Math.min(fadeOut, (fadeOutEnd - seg.endAt) / 1000);
    }
    if (fadeOut > 0) g = Math.min(g, Math.max(0, (fadeOutEnd - now) / 1000 / fadeOut));
    return Math.round(this.originalVolume * g * this.manualGain);
  }

  private async run(
    id: number,
    segments: SpotifyRunSegment[],
    endAt: number,
    opts: { padFilePath: string | null; padLeadInSec: number },
  ): Promise<void> {
    const live = () => id === this.runId;
    const last = segments.length - 1;
    const cmdTimes: number[] = [];
    const landing: number[] = [];
    // Like Runway's own runway: the pad fades in over its lead-in so it's up
    // before the last song starts fading out by 0:00.
    const lastSeg = segments[last];
    // Only when the song stops right at 0:00 (End set at the marker) does it
    // fade before 0:00; then the pad starts earlier so it's up first.
    const fadesByZero = lastSeg.stopAt <= lastSeg.endAt
      && (lastSeg.trimmedEnd || lastSeg.fadeOutSec !== undefined);
    const lastFade = fadesByZero ? (lastSeg.fadeOutSec ?? this.lastFadeSec) : 0;
    const padAt = endAt - (opts.padLeadInSec + lastFade) * 1000;

    let aim = SEEK_AIM_AHEAD_SEC;
    let firstPlayed = true;
    for (let i = 0; i <= last; i++) {
      const seg = segments[i];
      // Joining late (a service armed after its music should have started):
      // skip songs that are already over, or nearly so.
      if (i < last && seg.endAt - LOAD_LEAD_MS < Date.now() + 2000) continue;
      const joiningLate = Date.now() > seg.startAt;
      const lead = i === 0 && seg.startPosSec > 0 ? FIRST_SONG_LEAD_MS : LOAD_LEAD_MS;
      await sleep(seg.startAt - lead - Date.now());
      if (!live()) return;
      this.set({ currentIndex: i });

      // 1. Start the song silently and wait until Spotify reports it playing.
      const play = await this.cmd({ op: 'play', uri: seg.uri, contextUri: this.contextUri });
      if (!play.ok) throw new Error(play.reason ?? 'Spotify didn’t respond.');
      const loadStart = Date.now();
      let loaded = false;
      while (Date.now() - loadStart < LOAD_TIMEOUT_MS) {
        const st = await this.cmd({ op: 'state' });
        if (st.ok && st.trackUri === seg.uri && st.playerState === 'playing'
          && (st.positionSec ?? 99) < RESTART_MAX_SEC) { loaded = true; break; }
        await sleep(80);
        if (!live()) return;
      }
      if (!loaded) throw new Error(`Spotify didn’t start “${seg.title}” within 5 seconds. Check the connection and try again.`);
      // Starting a song pulls Spotify to the front; put it back unless the
      // operator already had it in front.
      if (!play.wasFrontmost) void this.cmd({ op: 'background' });

      // Where the song should be at wall-clock time t.
      const targetPos = (t: number) => seg.startPosSec + (t - seg.startAt) / 1000;
      const halfCmd = () => (cmdTimes.length ? median(cmdTimes) : 120) / 2;
      // + = Spotify is behind the plan = the song would end late. Only
      // pure reads are used: a read that also sets the volume answers late.
      const readErr = async (): Promise<number | null> => {
        const r = await this.cmd({ op: 'state' });
        if (!r.ok) throw new Error(r.reason ?? 'Lost contact with Spotify.');
        if (!r.sentAt || !r.answeredAt) return null;
        cmdTimes.push(r.answeredAt - r.sentAt);
        if (cmdTimes.length > 20) cmdTimes.shift();
        if (r.playerState !== 'playing' || r.trackUri !== seg.uri || r.positionSec === undefined) return null;
        return (targetPos((r.sentAt + r.answeredAt) / 2) - r.positionSec) * 1000;
      };

      // If the song loaded before its start time, let it sit silent until then.
      if (Date.now() < seg.startAt && seg.startPosSec === 0) await sleep(seg.startAt - Date.now());
      const jump = async () => {
        const at = Date.now() + halfCmd();
        await this.cmd({ op: 'seek', positionSec: Math.max(0, targetPos(at) + aim) });
        return Date.now();
      };
      let lastSeekAt = await jump();
      // Some Spotify versions come forward a beat after the song starts.
      if (!play.wasFrontmost) setTimeout(() => { void this.cmd({ op: 'background' }); }, 1200);

      // Joined mid-song: fade in from now rather than snapping to full volume.
      const fadeFrom = joiningLate && firstPlayed ? Date.now() : seg.startAt;
      const isFirst = firstPlayed;
      firstPlayed = false;

      // 2. First song only: there's silent time before its fade-in, so check
      // where the jump landed and redo it until it's close.
      if (i === 0 && seg.startPosSec > 0) {
        let tries = 0;
        while (live() && tries < 3 && Date.now() < seg.startAt - 700) {
          await sleep(lastSeekAt + VERIFY_SETTLE_MS - Date.now());
          const reads: number[] = [];
          for (let k = 0; k < 3; k++) {
            const e = await readErr();
            if (e !== null) reads.push(e);
          }
          if (reads.length === 0) break;
          const off = median(reads);
          const steady = Math.max(...reads) - Math.min(...reads) < 80;
          if (steady && Math.abs(off) < AIM_TRUST_MS) aim = learnAim(aim, off * 0.7);
          console.log('[spotify] first-song check', { off: Math.round(off), steady, aim: +aim.toFixed(3) });
          if (!steady && tries < 2) { tries++; lastSeekAt = Date.now() - VERIFY_SETTLE_MS + 300; continue; }
          if (Math.abs(off) <= PLACE_TOLERANCE_MS || Date.now() > seg.startAt - 400) break;
          lastSeekAt = await jump();
          tries++;
          this.set({ corrections: this.state.corrections + 1 });
        }
      }

      // 3. Play it through: step the volume only when a fade changes it,
      // otherwise just read the playhead. No jumps while it's audible.
      const stopAt = i < last ? seg.endAt - LOAD_LEAD_MS : seg.stopAt - END_MUTE_MS;
      const songErrs: number[] = [];
      let sentVolume = -1;
      let notPlayingSince: number | null = null;
      let recoveries = 0;
      let resumedAt: number | null = null;
      while (Date.now() < stopAt) {
        if (!live()) return;
        const loopStart = Date.now();

        if (opts.padFilePath && !this.state.padPlaying && loopStart >= padAt) {
          void this.audio?.playPad(opts.padFilePath, { fadeInSec: opts.padLeadInSec, loop: true });
          this.set({ padPlaying: true });
        }

        let vol = this.envelope(seg, isFirst, i === last, loopStart, fadeFrom);
        // Just put back after an accidental pause: fade in rather than snap.
        if (resumedAt !== null) vol = Math.round(vol * Math.min(1, (loopStart - resumedAt) / RECOVER_FADE_MS));
        this.lastSentVolume = this.manualGain > 0 ? Math.round(vol / this.manualGain) : this.lastSentVolume;
        if (vol !== sentVolume) {
          const r = await this.cmd({ op: 'volume', volume: vol });
          if (!r.ok) throw new Error(r.reason ?? 'Lost contact with Spotify.');
          sentVolume = vol;
        } else {
          const e = await readErr();
          if (e === null) {
            notPlayingSince ??= loopStart;
            const timeLeft = (i === last ? seg.stopAt : seg.endAt) - loopStart;
            if (loopStart - notPlayingSince > RECOVER_AFTER_MS && timeLeft > 3000
              && recoveries < MAX_RECOVERIES_PER_SONG) {
              // Spotify got paused, or someone picked another song in it.
              // Put the planned song back exactly where it should be by now.
              recoveries++;
              this.set({ message: `Spotify was paused or changed. Putting “${seg.title}” back in place…` });
              await this.cmd({ op: 'volume', volume: 0 });
              sentVolume = 0;
              const rp = await this.cmd({ op: 'play', uri: seg.uri, contextUri: this.contextUri });
              const t0 = Date.now();
              let back = false;
              while (rp.ok && Date.now() - t0 < LOAD_TIMEOUT_MS) {
                const st = await this.cmd({ op: 'state' });
                if (st.ok && st.trackUri === seg.uri && st.playerState === 'playing') { back = true; break; }
                await sleep(80);
                if (!live()) return;
              }
              if (rp.ok && !rp.wasFrontmost) void this.cmd({ op: 'background' });
              if (back) {
                lastSeekAt = await jump();
                resumedAt = Date.now();
                sentVolume = -1;
                this.set({
                  message: `Spotify was paused or changed. Runway put “${seg.title}” back at the right spot.`,
                  corrections: this.state.corrections + 1,
                });
              } else {
                this.set({ message: 'Spotify was paused or changed and didn’t come back. Press play in Spotify; Runway will line it up again.' });
              }
              notPlayingSince = null;
            } else if (loopStart - notPlayingSince > 2000 && recoveries >= MAX_RECOVERIES_PER_SONG) {
              this.set({ message: 'Spotify keeps stopping (an ad, or someone touching it). The landing may be off.' });
            }
          } else {
            notPlayingSince = null;
            if (loopStart - lastSeekAt > SETTLE_AFTER_SEEK_MS) {
              songErrs.push(e);
              if (i === last && Math.abs(seg.endAt - loopStart) < LANDING_WINDOW_MS) landing.push(e);
            }
          }
        }
        await sleep(STEP_MS - (Date.now() - loopStart));
      }
      // Learn from this song: aim the next jump by however far this one was off.
      const songOff = songErrs.length >= 4 ? median(songErrs) : null;
      if (songOff !== null && Math.abs(songOff) < AIM_TRUST_MS) aim = learnAim(aim, songOff * 0.5);
      console.log('[spotify] song', {
        index: i, title: seg.title, offMs: songOff === null ? null : Math.round(songOff),
        readings: songErrs.length, nextAim: +aim.toFixed(3),
      });
      // The fade's last step lands up to STEP_MS early; make sure Spotify is
      // fully silent before the next song is started.
      if (i < last) await this.cmd({ op: 'volume', volume: 0 });
    }

    // 4. Landed: Spotify off, its volume back, pad holds.
    if (!live()) return;
    await this.cmd({ op: 'volume', volume: 0 });
    await sleep(segments[last].stopAt - Date.now());
    await this.cmd({ op: 'pause' });
    await this.cmd({ op: 'volume', volume: this.originalVolume });
    const landingErrorMs = landing.length ? Math.round(median(landing)) : null;
    console.log('[spotify] landed', { landingErrorMs, readings: landing.length });
    this.set({
      status: 'landed',
      landingErrorMs,
      message: landingErrorMs === null
        ? 'Landed. Not enough readings near the end to measure how close.'
        : `Last song landed ${(Math.abs(landingErrorMs) / 1000).toFixed(2)}s ${landingErrorMs >= 0 ? 'late' : 'early'}.`,
    });
  }

  private async silence(): Promise<void> {
    try {
      await this.cmd({ op: 'volume', volume: 0 });
      await this.cmd({ op: 'pause' });
      await this.cmd({ op: 'volume', volume: this.originalVolume });
    } catch { /* best effort */ }
  }

  /** Stops the run: Spotify fades out and pauses, the pad fades out. */
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const wasRunning = this.isActive();
    this.runId++;
    this.stopping = (async () => {
      if (wasRunning) {
        // Fade from wherever Spotify is now (it may already be pulled down
        // by Fade to Pad), never back up from full.
        const v = Math.round(this.lastSentVolume * this.manualGain);
        for (const f of [0.6, 0.3, 0]) {
          await this.cmd({ op: 'volume', volume: Math.round(v * f) });
          await sleep(200);
        }
        await this.silence();
      }
      if (this.state.padPlaying) this.audio?.fadeOutPad(2);
      this.set({ status: wasRunning ? 'stopped' : this.state.status, padPlaying: false,
        message: wasRunning ? 'Stopped.' : this.state.message });
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }

  /**
   * Fade to Pad for a Spotify runway: ramps Spotify down (gain 0) or back
   * up (gain 1) over `fadeSec`, without moving the song. The planned fades
   * keep running underneath, so bringing it back lands where the plan is.
   */
  async setManualGain(gain: number, fadeSec: number): Promise<void> {
    if (!this.isActive()) { this.manualGain = gain; return; }
    const from = this.manualGain;
    const steps = Math.max(1, Math.round(fadeSec / 0.25));
    for (let k = 1; k <= steps; k++) {
      this.manualGain = from + (gain - from) * (k / steps);
      await this.cmd({ op: 'volume', volume: Math.round(this.lastSentVolume * this.manualGain) });
      await sleep(fadeSec * 1000 / steps);
    }
  }

  /** Fades out the pad that holds after a landing. */
  stopPad(fadeSec: number): void {
    if (this.state.padPlaying) this.audio?.fadeOutPad(fadeSec);
    this.set({ padPlaying: false });
  }
}

export const spotifyTestRun = new SpotifyTestRunner();
/** Separate runner for services, so a test run and a service never share state. */
export const spotifyServiceRun = new SpotifyTestRunner();

/** Where a planned Spotify runway is right now, from the wall clock. */
export function spotifyNowPlaying(segments: SpotifyRunSegment[], now: number):
  { index: number; seg: SpotifyRunSegment; positionSec: number } | null {
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (now >= s.startAt && now < s.stopAt) {
      return { index: i, seg: s, positionSec: s.startPosSec + (now - s.startAt) / 1000 };
    }
  }
  return null;
}
