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
 *     be right now, aiming slightly ahead because jumps land ~0.1 s late;
 *   - keep reading the playhead while stepping the volume for fades, and
 *     jump again whenever it drifts more than CORRECT_THRESHOLD_MS.
 */

import type { AudioEngine } from './audioEngine';
import type { KeyName, SpotifyPlaylistTrack, SpotifyPlayerCommand, SpotifyPlayerReply } from '@shared/types';

const PREROLL_MS = 4000;          // gap between pressing Start and the first song
const LOAD_LEAD_MS = 700;         // start each song this early, silent
const LOAD_TIMEOUT_MS = 5000;
const RESTART_MAX_SEC = 5;        // "loaded" = playing near the top of the song
const SEEK_AIM_AHEAD_SEC = 0.1;   // jumps landed ~0.07–0.13 s late in testing
const STEP_MS = 250;              // volume step / playhead reading interval
const FIRST_FADE_IN_SEC = 4;
const TRANSITION_FADE_IN_SEC = 1.5;
const TRANSITION_FADE_OUT_SEC = 2.5;
const SETTLE_AFTER_SEEK_MS = 1200; // ignore readings right after a jump
const CORRECT_THRESHOLD_MS = 60;
const CORRECT_MIN_GAP_MS = 4000;
const MIN_FIRST_SEGMENT_SEC = 8;  // drop a first song that would only play a few seconds
const LANDING_WINDOW_MS = 8000;   // landing error = readings in the last 8 s
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
  startAt: number;       // wall-clock ms
  endAt: number;
}

export type SpotifyRunStatus = 'idle' | 'running' | 'landed' | 'stopped' | 'error';

export interface SpotifyRunState {
  status: SpotifyRunStatus;
  segments: SpotifyRunSegment[];
  endAt: number | null;
  currentIndex: number;          // -1 before the first song
  message: string | null;        // latest warning / error / result line
  landingErrorMs: number | null; // + = last song ended late
  corrections: number;
  padKey: KeyName | null;
  padPlaying: boolean;
}

const IDLE: SpotifyRunState = {
  status: 'idle', segments: [], endAt: null, currentIndex: -1, message: null,
  landingErrorMs: null, corrections: 0, padKey: null, padPlaying: false,
};

/** Plans the playlist so its last song ends at `endAt` (ms). */
export function planSpotifyRun(
  tracks: SpotifyPlaylistTrack[],
  lengthSec: number | null,
  endAt: number,
): SpotifyRunSegment[] {
  const total = tracks.reduce((s, t) => s + t.durationMs / 1000, 0);
  let remaining = lengthSec === null ? total : Math.min(lengthSec, total);
  const picked: Array<{ t: SpotifyPlaylistTrack; startPosSec: number }> = [];
  for (let i = tracks.length - 1; i >= 0 && remaining > 0; i--) {
    const dur = tracks[i].durationMs / 1000;
    if (dur >= remaining) {
      picked.unshift({ t: tracks[i], startPosSec: dur - remaining });
      remaining = 0;
    } else {
      picked.unshift({ t: tracks[i], startPosSec: 0 });
      remaining -= dur;
    }
  }
  // A first song that would only play a few seconds just sounds like a glitch.
  if (picked.length > 1) {
    const first = picked[0];
    if (first.t.durationMs / 1000 - first.startPosSec < MIN_FIRST_SEGMENT_SEC) picked.shift();
  }
  const segs: SpotifyRunSegment[] = [];
  let cursor = endAt;
  for (let i = picked.length - 1; i >= 0; i--) {
    const { t, startPosSec } = picked[i];
    const songDurSec = t.durationMs / 1000;
    const startAt = cursor - (songDurSec - startPosSec) * 1000;
    segs.unshift({ uri: t.uri, title: t.title, artist: t.artist, songDurSec, startPosSec, startAt, endAt: cursor });
    cursor = startAt;
  }
  return segs;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));
const median = (xs: number[]) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

class SpotifyTestRunner {
  private state: SpotifyRunState = IDLE;
  private listeners = new Set<(s: SpotifyRunState) => void>();
  private runId = 0;
  private originalVolume = 70;
  private audio: AudioEngine | null = null;

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
    audio: AudioEngine;
  }): Promise<void> {
    if (this.isActive()) return;
    const id = ++this.runId;
    this.audio = opts.audio;
    const check = await this.cmd({ op: 'check' });
    if (!check.ok) { this.set({ ...IDLE, status: 'error', message: check.reason ?? 'Spotify isn’t available.' }); return; }
    this.originalVolume = check.volume && check.volume > 0 ? check.volume : 70;
    await this.cmd({ op: 'volume', volume: 0 });

    const endAt = Date.now() + PREROLL_MS + (opts.lengthSec === null
      ? opts.tracks.reduce((s, t) => s + t.durationMs, 0)
      : Math.min(opts.lengthSec * 1000, opts.tracks.reduce((s, t) => s + t.durationMs, 0)));
    const segments = planSpotifyRun(opts.tracks, opts.lengthSec, endAt);
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

  private envelope(seg: SpotifyRunSegment, idx: number, last: number, now: number): number {
    const fadeIn = idx === 0 ? FIRST_FADE_IN_SEC : TRANSITION_FADE_IN_SEC;
    let g = Math.min(1, Math.max(0, (now - seg.startAt) / 1000 / fadeIn));
    if (idx < last) {
      const fadeOutEnd = seg.endAt - LOAD_LEAD_MS;
      g = Math.min(g, Math.max(0, (fadeOutEnd - now) / 1000 / TRANSITION_FADE_OUT_SEC));
    }
    return Math.round(this.originalVolume * g);
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

    for (let i = 0; i <= last; i++) {
      const seg = segments[i];
      await sleep(seg.startAt - LOAD_LEAD_MS - Date.now());
      if (!live()) return;
      this.set({ currentIndex: i });

      // 1. Start the song silently and wait until Spotify reports it playing.
      const play = await this.cmd({ op: 'play', uri: seg.uri });
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

      // Where the song should be at wall-clock time t.
      const targetPos = (t: number) => seg.startPosSec + (t - seg.startAt) / 1000;
      const halfCmd = () => (cmdTimes.length ? median(cmdTimes) : 120) / 2;

      // If the song loaded before its start time, let it sit silent until then.
      if (Date.now() < seg.startAt && seg.startPosSec === 0) await sleep(seg.startAt - Date.now());
      const jump = async () => {
        const at = Date.now() + halfCmd();
        await this.cmd({ op: 'seek', positionSec: Math.max(0, targetPos(at) + SEEK_AIM_AHEAD_SEC) });
        return Date.now();
      };
      let lastSeekAt = await jump();

      // 2. Step the volume and watch the playhead until this song's turn ends.
      const stopAt = i < last ? seg.endAt - LOAD_LEAD_MS : seg.endAt - END_MUTE_MS;
      let errs: number[] = [];
      let notPlayingSince: number | null = null;
      while (Date.now() < stopAt) {
        if (!live()) return;
        const loopStart = Date.now();

        if (opts.padFilePath && !this.state.padPlaying && loopStart >= endAt - opts.padLeadInSec * 1000) {
          void this.audio?.playPad(opts.padFilePath, { fadeInSec: opts.padLeadInSec, loop: true });
          this.set({ padPlaying: true });
        }

        const r = await this.cmd({ op: 'volumeAndState', volume: this.envelope(seg, i, last, loopStart) });
        if (!r.ok) throw new Error(r.reason ?? 'Lost contact with Spotify.');
        if (r.sentAt && r.answeredAt) cmdTimes.push(r.answeredAt - r.sentAt);
        if (cmdTimes.length > 20) cmdTimes.shift();

        if (r.playerState !== 'playing' || r.trackUri !== seg.uri) {
          notPlayingSince ??= loopStart;
          if (loopStart - notPlayingSince > 2000) {
            this.set({ message: 'Spotify stopped or switched songs (an ad, or someone touched it). The landing may be off.' });
          }
        } else if (r.positionSec !== undefined && r.sentAt && r.answeredAt) {
          notPlayingSince = null;
          const mid = (r.sentAt + r.answeredAt) / 2;
          // + = Spotify is behind the plan = the song would end late.
          const err = (targetPos(mid) - r.positionSec) * 1000;
          if (mid - lastSeekAt > SETTLE_AFTER_SEEK_MS) {
            errs.push(err);
            if (errs.length > 6) errs.shift();
            if (i === last && seg.endAt - mid < LANDING_WINDOW_MS) landing.push(err);
            if (errs.length >= 4 && Math.abs(median(errs)) > CORRECT_THRESHOLD_MS
              && mid - lastSeekAt > CORRECT_MIN_GAP_MS) {
              lastSeekAt = await jump();
              errs = [];
              this.set({ corrections: this.state.corrections + 1 });
            }
          }
        }
        await sleep(STEP_MS - (Date.now() - loopStart));
      }
      // The fade's last step lands up to STEP_MS early; make sure Spotify is
      // fully silent before the next song is started.
      if (i < last) await this.cmd({ op: 'volume', volume: 0 });
    }

    // 3. Landed: Spotify off, its volume back, pad holds.
    if (!live()) return;
    await this.cmd({ op: 'volume', volume: 0 });
    await sleep(endAt - Date.now());
    await this.cmd({ op: 'pause' });
    await this.cmd({ op: 'volume', volume: this.originalVolume });
    const landingErrorMs = landing.length ? Math.round(median(landing)) : null;
    this.set({
      status: 'landed',
      landingErrorMs,
      message: landingErrorMs === null
        ? 'Landed. Not enough readings near the end to measure how close.'
        : `Last song ended ${(Math.abs(landingErrorMs) / 1000).toFixed(2)}s ${landingErrorMs >= 0 ? 'late' : 'early'}.`,
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
    const wasRunning = this.isActive();
    this.runId++;
    if (wasRunning) {
      const v = this.originalVolume;
      for (const f of [0.6, 0.3, 0]) {
        await this.cmd({ op: 'volume', volume: Math.round(v * f) });
        await sleep(200);
      }
      await this.silence();
    }
    if (this.state.padPlaying) this.audio?.fadeOutPad(2);
    this.set({ status: wasRunning ? 'stopped' : this.state.status, padPlaying: false,
      message: wasRunning ? 'Stopped.' : this.state.message });
  }

  /** Fades out the pad that holds after a landing. */
  stopPad(fadeSec: number): void {
    if (this.state.padPlaying) this.audio?.fadeOutPad(fadeSec);
    this.set({ padPlaying: false });
  }
}

export const spotifyTestRun = new SpotifyTestRunner();
