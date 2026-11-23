/**
 * Scan waveforms: plays Spotify songs that don't have a waveform yet
 * straight through, one after another, so the waveform recorder (Settings ›
 * Spotify › Draw waveforms) hears them. Runs in the background: it keeps
 * going while the operator uses other screens and can be left alone.
 *
 * Safety: it never runs while a service, test run or post-service is
 * playing, and stops on its own when a service is armed to start music
 * within the next few minutes. It only plays songs; it never arms, changes
 * or times anything.
 */

import { useEffect, useState } from 'react';
import type { SpotifyPlaylistTrack } from '@shared/types';
import { useAppStore } from '../state/store';
import { spotifyServiceRun, spotifyTestRun } from './spotifyTestRun';
import { spotifyFreePlay } from './spotifyPost';

export interface WaveformScanState {
  running: boolean;
  idx: number;          // 1-based song being scanned
  total: number;
  title: string;
  note: string | null;  // last result / why it stopped
}

const DONE_AT = 0.95;              // a song counts as scanned at this coverage
const STOP_BEFORE_SERVICE_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Why scanning can't run right now, or null when it can. */
export function waveformScanBlocked(): string | null {
  if (spotifyServiceRun.isActive() || spotifyTestRun.isActive() || spotifyFreePlay.isActive()) {
    return 'Spotify is playing for a service or test.';
  }
  const r = useAppStore.getState().currentRunway;
  if (r && (r.phase === 'music' || r.phase === 'pad')) return 'A service is playing.';
  if (r && r.phase === 'queued' && r.musicStartMs - Date.now() < STOP_BEFORE_SERVICE_MS) {
    return 'A service’s music starts within 5 minutes.';
  }
  return null;
}

/** Every song in every imported Spotify playlist, once each. */
export function allImportedSpotifySongs(): SpotifyPlaylistTrack[] {
  const cache = useAppStore.getState().config.spotify?.playlistCache ?? {};
  const seen = new Set<string>();
  const out: SpotifyPlaylistTrack[] = [];
  for (const pl of Object.values(cache)) {
    for (const t of pl?.tracks ?? []) {
      if (seen.has(t.uri)) continue;
      seen.add(t.uri);
      out.push(t);
    }
  }
  return out;
}

class WaveformScanner {
  private state: WaveformScanState = { running: false, idx: 0, total: 0, title: '', note: null };
  private listeners = new Set<(s: WaveformScanState) => void>();
  private stopRequested = false;

  getState() { return this.state; }
  subscribe(fn: (s: WaveformScanState) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private set(p: Partial<WaveformScanState>) {
    this.state = { ...this.state, ...p };
    for (const fn of this.listeners) fn(this.state);
  }

  stop() { this.stopRequested = true; }

  async start(tracks: SpotifyPlaylistTrack[]): Promise<void> {
    if (this.state.running) return;
    const blocked = waveformScanBlocked();
    if (blocked) { this.set({ note: `${blocked} Scan when it’s done.` }); return; }
    const uris = [...new Set(tracks.map(t => t.uri))];
    const cov = await window.runway.spotify.waveformCoverage(uris);
    const todo = uris
      .filter(u => (cov[u] ?? 0) < DONE_AT)
      .map(u => tracks.find(t => t.uri === u)!)
      .filter(Boolean);
    if (todo.length === 0) { this.set({ note: 'Every song already has a waveform.' }); return; }

    const check = await window.runway.spotify.player({ op: 'check' });
    if (!check.ok) { this.set({ note: check.reason ?? 'Spotify isn’t open.' }); return; }
    // The recorder needs to hear something: Spotify's own volume can't be
    // (near) zero. The Mac itself can be muted.
    const origVol = check.volume ?? 70;
    const raised = origVol < 20;
    if (raised) await window.runway.spotify.player({ op: 'volume', volume: 50 });

    this.stopRequested = false;
    let done = 0;
    let why: string | null = null;
    this.set({ running: true, idx: 0, total: todo.length, title: '', note: null });
    try {
      for (const t of todo) {
        if (this.stopRequested) { why = 'Scan stopped.'; break; }
        const blocked2 = waveformScanBlocked();
        if (blocked2) { why = `Scan paused: ${blocked2}`; break; }
        this.set({ idx: done + 1, title: t.title });
        const r = await window.runway.spotify.player({ op: 'play', uri: t.uri });
        if (!r.ok) { why = r.reason ?? 'Couldn’t play in Spotify.'; break; }
        if (!r.wasFrontmost) window.setTimeout(() => { void window.runway.spotify.player({ op: 'background' }); }, 800);
        const limit = Date.now() + t.durationMs + 20_000;
        let started = false;
        while (Date.now() < limit) {
          await sleep(1500);
          if (this.stopRequested) break;
          if (waveformScanBlocked()) break;
          const st = await window.runway.spotify.player({ op: 'state' });
          if (st.ok && st.trackUri === t.uri) {
            started = true;
            // Someone paused Spotify: carry on rather than wait forever.
            if (st.playerState === 'paused') await window.runway.spotify.player({ op: 'resume' });
          } else if (started) break;  // song ended / moved on
          const c = await window.runway.spotify.waveformCoverage([t.uri]);
          if ((c[t.uri] ?? 0) >= 0.98) break;
        }
        done++;
      }
    } finally {
      // Don't touch Spotify if a service has taken it over meanwhile.
      const r = useAppStore.getState().currentRunway;
      const musicSoon = !!r && r.phase === 'queued' && r.musicStartMs - Date.now() < 8000;
      if (!musicSoon && !spotifyServiceRun.isActive() && !spotifyTestRun.isActive() && !spotifyFreePlay.isActive()) {
        await window.runway.spotify.player({ op: 'pause' });
        if (raised) await window.runway.spotify.player({ op: 'volume', volume: origVol });
      }
      const after = await window.runway.spotify.waveformCoverage(todo.map(t => t.uri)).catch(() => ({} as Record<string, number>));
      const ok = todo.filter(t => (after[t.uri] ?? 0) >= DONE_AT).length;
      this.set({
        running: false, idx: 0, title: '',
        note: `${why ? why + ' ' : ''}${ok} of ${todo.length} song${todo.length === 1 ? '' : 's'} now have a waveform.`,
      });
    }
  }
}

export const waveformScanner = new WaveformScanner();

/** Live scan progress for components. */
export function useWaveformScan(): WaveformScanState {
  const [st, setSt] = useState(waveformScanner.getState());
  useEffect(() => waveformScanner.subscribe(setSt), []);
  return st;
}
