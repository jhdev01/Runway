/**
 * Spotify free play (experimental, macOS): post-service music and Spotify
 * actions. Unlike the pre-service runway there's no landing time, so the
 * Spotify app simply plays the playlist (or song) itself, in order, while
 * Runway fades it in and out and reports what's playing.
 */

import type { SpotifyPlayerCommand, SpotifyPlayerReply } from '@shared/types';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));
const LOAD_TIMEOUT_MS = 6000;

export interface SpotifyFreePlayNow {
  title?: string;
  artist?: string;
  positionSec?: number;
  durationSec?: number;
  artworkUrl?: string;
  playing: boolean;
}

export interface SpotifyFreePlayState {
  active: boolean;
  label: string | null;         // playlist / song name, for the UI
  now: SpotifyFreePlayNow | null;
  error: string | null;
}

class SpotifyFreePlayer {
  private state: SpotifyFreePlayState = { active: false, label: null, now: null, error: null };
  private listeners = new Set<(s: SpotifyFreePlayState) => void>();
  private runId = 0;
  private volume = 70;          // Spotify's own volume before we started
  private poll: number | null = null;
  private stopping: Promise<void> | null = null;
  private pausedPolls = 0;

  getState() { return this.state; }
  subscribe(fn: (s: SpotifyFreePlayState) => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  isActive() { return this.state.active; }
  private set(p: Partial<SpotifyFreePlayState>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }
  private cmd(c: SpotifyPlayerCommand): Promise<SpotifyPlayerReply> {
    return window.runway.spotify.player(c);
  }

  /**
   * Plays a Spotify playlist (spotify:playlist:…) from the top, or one song
   * (spotify:track:…, optionally inside a playlist), fading in from silence.
   */
  async play(opts: { uri: string; contextUri?: string; label: string; fadeInSec: number }): Promise<{ ok: boolean; reason?: string }> {
    if (this.stopping) await this.stopping;
    if (this.isActive()) await this.stop(0.5);
    const id = ++this.runId;
    const check = await this.cmd({ op: 'check' });
    if (!check.ok) { this.set({ error: check.reason ?? 'Spotify isn’t available.' }); return { ok: false, reason: check.reason }; }
    this.volume = check.volume && check.volume > 0 ? check.volume : 70;
    await this.cmd({ op: 'volume', volume: 0 });
    const play = await this.cmd({ op: 'play', uri: opts.uri, contextUri: opts.contextUri });
    if (!play.ok) { await this.cmd({ op: 'volume', volume: this.volume }); return { ok: false, reason: play.reason }; }
    // Wait for Spotify to actually start before fading up.
    const t0 = Date.now();
    let started = false;
    while (Date.now() - t0 < LOAD_TIMEOUT_MS) {
      const st = await this.cmd({ op: 'state' });
      if (st.ok && st.playerState === 'playing' && st.trackUri) { started = true; break; }
      await sleep(100);
    }
    if (id !== this.runId) return { ok: false, reason: 'Stopped.' };
    if (!started) {
      await this.cmd({ op: 'volume', volume: this.volume });
      return { ok: false, reason: 'Spotify didn’t start playing within 6 seconds. Check the connection and try again.' };
    }
    if (!play.wasFrontmost) {
      void this.cmd({ op: 'background' });
      setTimeout(() => { void this.cmd({ op: 'background' }); }, 1200);
    }
    this.set({ active: true, label: opts.label, error: null });
    this.startPolling(id);
    const steps = Math.max(1, Math.round(opts.fadeInSec / 0.25));
    for (let k = 1; k <= steps; k++) {
      if (id !== this.runId) break;
      await this.cmd({ op: 'volume', volume: Math.round(this.volume * k / steps) });
      await sleep(opts.fadeInSec * 1000 / steps);
    }
    return { ok: true };
  }

  private startPolling(id: number) {
    if (this.poll !== null) window.clearInterval(this.poll);
    this.poll = window.setInterval(async () => {
      if (id !== this.runId) return;
      const r = await this.cmd({ op: 'nowPlaying' });
      if (id !== this.runId || !r.ok) return;
      // Paused by accident (two readings in a row): press play again. There's
      // no landing time here, so carrying on from where it paused is right.
      if (r.playerState !== 'playing') {
        this.pausedPolls++;
        if (this.pausedPolls >= 2 && !this.stopping) {
          this.pausedPolls = 0;
          void this.cmd({ op: 'resume' });
        }
      } else this.pausedPolls = 0;
      this.set({ now: {
        title: r.title, artist: r.artist, positionSec: r.positionSec, durationSec: r.durationSec,
        artworkUrl: r.artworkUrl, playing: r.playerState === 'playing',
      } });
    }, 1000);
  }

  /** Fades Spotify out, pauses it and puts its volume back. */
  async stop(fadeSec: number): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.isActive()) return;
    this.runId++;
    if (this.poll !== null) { window.clearInterval(this.poll); this.poll = null; }
    this.stopping = (async () => {
      const cur = await this.cmd({ op: 'state' });
      const from = cur.ok && cur.volume !== undefined ? cur.volume : this.volume;
      const steps = Math.max(1, Math.round(fadeSec / 0.25));
      for (let k = steps - 1; k >= 0; k--) {
        await this.cmd({ op: 'volume', volume: Math.round(from * k / steps) });
        await sleep(fadeSec * 1000 / steps);
      }
      await this.cmd({ op: 'pause' });
      await this.cmd({ op: 'volume', volume: this.volume });
      this.set({ active: false, now: null });
    })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}

export const spotifyFreePlay = new SpotifyFreePlayer();
