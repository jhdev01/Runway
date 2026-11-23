// Spotify waveforms (macOS 13+).
//
// While switched on, Runway listens to the Spotify app's audio output with
// a small helper (native/spotify-levels) that reports only loudness, never
// the sound. Each reading is placed on the song's timeline using Spotify's
// playhead, so any song that plays through (a test run, a service, an
// audition, or a scan) gets a waveform picture for the song editor.
//
// Read-only with respect to playback: nothing here starts, stops, seeks or
// changes the volume of Spotify. Waveforms are saved under userData, one
// small file per song.

import { app } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { osa, num } from './spotifyTimingTest';
import type { SpotifyWaveform, SpotifyWaveformStatus } from '../shared/types';

const BIN_SEC = 0.1;            // one waveform column per 0.1 s of song
const POLL_MS = 400;            // how often Spotify's playhead is read
const ANCHOR_MAX_AGE_MS = 1500; // readings older than this can't place audio
const AFTER_JUMP_MS = 700;      // ignore audio right after a jump
const MIN_VOLUME = 5;           // below this Spotify is too quiet to measure
const IDLE_STOP_MS = 20_000;    // stop listening after Spotify is idle this long
const SAVE_DEBOUNCE_MS = 3000;

interface Anchor { uri: string; posSec: number; at: number; volume: number; playing: boolean; durSec: number }
interface Wave { durationSec: number; peaks: number[] } // peaks: 0…1, -1 = not heard yet

let enabled = false;
let tap: ChildProcessWithoutNullStreams | null = null;
let tapState: SpotifyWaveformStatus['tap'] = 'off';
let tapReason: string | undefined;
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let anchor: Anchor | null = null;
let prevVolume: number | null = null;
let jumpedAt = 0;
let idleSince: number | null = null;
let retryAfter = 0;
const waves = new Map<string, Wave>();
// Songs with no saved waveform yet, so a live progress view doesn't re-read the disk.
const missing = new Set<string>();
const dirty = new Set<string>();
let saveTimer: NodeJS.Timeout | null = null;
let buf = '';

const dir = () => path.join(app.getPath('userData'), 'spotify-waveforms');
const idOf = (uri: string) => (uri.match(/^spotify:track:([A-Za-z0-9]+)$/) ?? [])[1] ?? null;

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'native', 'runway-spotify-levels')
    : path.join(app.getAppPath(), 'build', 'native', 'runway-spotify-levels');
}

function loadWave(uri: string): Wave | null {
  const cached = waves.get(uri);
  if (cached) return cached;
  if (missing.has(uri)) return null;
  const id = idOf(uri);
  if (!id) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir(), `${id}.json`), 'utf8')) as { durationSec?: number; peaks?: number[] };
    if (typeof raw.durationSec === 'number' && Array.isArray(raw.peaks)) {
      const w: Wave = { durationSec: raw.durationSec, peaks: raw.peaks.map(v => (v < 0 ? -1 : v / 1000)) };
      waves.set(uri, w);
      return w;
    }
  } catch { /* none yet */ }
  missing.add(uri);
  return null;
}

function saveSoon(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.mkdirSync(dir(), { recursive: true }); } catch { /* ignore */ }
    for (const uri of dirty) {
      const w = waves.get(uri);
      const id = idOf(uri);
      if (!w || !id) continue;
      const body = JSON.stringify({ v: 1, binSec: BIN_SEC, durationSec: w.durationSec, peaks: w.peaks.map(v => (v < 0 ? -1 : Math.round(v * 1000))) });
      try { fs.writeFileSync(path.join(dir(), `${id}.json`), body); } catch { /* disk full etc.: try next time */ }
    }
    dirty.clear();
  }, SAVE_DEBOUNCE_MS);
}

function coverage(w: Wave | null): number {
  if (!w || w.peaks.length === 0) return 0;
  let heard = 0;
  for (const v of w.peaks) if (v >= 0) heard++;
  return heard / w.peaks.length;
}

/** Places one audio buffer's peak on the song's timeline. */
function onLevel(wallMs: number, durMs: number, peak: number): void {
  const a = anchor;
  if (!a || !a.playing || !idOf(a.uri)) return;
  if (Date.now() - a.at > ANCHOR_MAX_AGE_MS) return;
  if (wallMs - jumpedAt < AFTER_JUMP_MS) return;
  // Only while the volume is steady (Runway's fades move it), and loud
  // enough to measure. Readings are scaled back up to full volume.
  if (a.volume < MIN_VOLUME || prevVolume !== a.volume) return;
  const startSec = a.posSec + (wallMs - a.at) / 1000;
  const endSec = startSec + durMs / 1000;
  if (startSec < 0 || endSec > a.durSec + 0.5) return;
  let w = loadWave(a.uri);
  const bins = Math.max(1, Math.ceil(a.durSec / BIN_SEC));
  if (!w || w.peaks.length !== bins) {
    w = { durationSec: a.durSec, peaks: new Array(bins).fill(-1) };
    waves.set(a.uri, w);
    missing.delete(a.uri);
  }
  const level = Math.min(1, peak / (a.volume / 100));
  const b0 = Math.max(0, Math.floor(startSec / BIN_SEC));
  const b1 = Math.min(bins - 1, Math.floor(endSec / BIN_SEC));
  for (let b = b0; b <= b1; b++) w.peaks[b] = Math.max(w.peaks[b], level);
  dirty.add(a.uri);
  saveSoon();
}

function startTap(): void {
  if (tap || Date.now() < retryAfter) return;
  const exe = helperPath();
  if (!fs.existsSync(exe)) {
    tapState = 'unavailable';
    tapReason = 'This build of Runway doesn’t include the waveform helper.';
    return;
  }
  tapState = 'starting';
  tapReason = undefined;
  buf = '';
  const child = spawn(exe, ['com.spotify.client'], { stdio: ['pipe', 'pipe', 'pipe'] });
  tap = child;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith('L ')) {
        const [, w, d, p] = line.split(' ');
        onLevel(Number(w), Number(d), Number(p));
      } else if (line === 'R') {
        tapState = 'on';
      } else if (line.startsWith('E ')) {
        const code = line.split(' ')[1];
        tapState = code === 'perm' ? 'denied' : 'error';
        tapReason = code === 'perm'
          ? 'macOS hasn’t allowed Runway to hear Spotify. Open System Settings › Privacy & Security › Screen & System Audio Recording, turn on Runway, then quit and reopen Runway.'
          : line.slice(2);
        console.warn('[spotify-waveform]', line);
      }
    }
  });
  child.stderr.on('data', () => { /* helper logs nothing useful there */ });
  child.on('exit', () => {
    if (tap === child) tap = null;
    if (tapState === 'on' || tapState === 'starting') tapState = 'off';
    // Don't hammer a helper that keeps failing (e.g. permission refused).
    retryAfter = Date.now() + (tapState === 'denied' ? 60_000 : 5_000);
  });
  child.on('error', e => {
    tapState = 'error';
    tapReason = e.message;
  });
}

function stopTap(): void {
  if (!tap) return;
  try { tap.stdin.end(); } catch { /* ignore */ }
  const t = tap;
  setTimeout(() => { try { t.kill(); } catch { /* ignore */ } }, 1000);
  tap = null;
  if (tapState === 'on' || tapState === 'starting') tapState = 'off';
}

async function poll(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const T = 'ASCII character 9';
    const sentAt = Date.now();
    // Checks it's running first: talking to a closed Spotify would open it.
    const out = await osa([
      'if application "Spotify" is running then',
      'tell application "Spotify"',
      `set T to ${T}`,
      'return (id of current track) & T & (player state as text) & T & (player position as text) & T & (sound volume as text) & T & (duration of current track as text)',
      'end tell',
      'end if',
      'return ""',
    ]);
    const at = (sentAt + Date.now()) / 2;
    const [uri, st, pos, vol, dur] = out.split('\t');
    if (!uri) { anchor = null; idleSince ??= Date.now(); }
    else {
      const next: Anchor = {
        uri, posSec: num(pos ?? ''), at, volume: Math.round(num(vol ?? '')), playing: st === 'playing',
        durSec: num(dur ?? '') / 1000,
      };
      if (!Number.isFinite(next.posSec) || !Number.isFinite(next.durSec) || next.durSec <= 0) { anchor = null; return; }
      // A jump (or a new song): the playhead isn't where it should be.
      if (anchor && (anchor.uri !== next.uri
        || Math.abs(anchor.posSec + (anchor.playing ? (at - anchor.at) / 1000 : 0) - next.posSec) > 0.4)) {
        jumpedAt = at;
      }
      prevVolume = anchor?.volume ?? null;
      anchor = next;
      if (next.playing) idleSince = null; else idleSince ??= Date.now();
    }
    if (anchor?.playing) startTap();
    else if (idleSince !== null && Date.now() - idleSince > IDLE_STOP_MS) stopTap();
  } catch {
    anchor = null;
  } finally {
    polling = false;
  }
}

export function spotifyWaveformEnable(on: boolean): SpotifyWaveformStatus {
  if (process.platform !== 'darwin') return spotifyWaveformStatus();
  enabled = on;
  if (on && !pollTimer) {
    retryAfter = 0;
    pollTimer = setInterval(() => { void poll(); }, POLL_MS);
    void poll();
  } else if (!on) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    stopTap();
    anchor = null;
    tapState = 'off';
  }
  return spotifyWaveformStatus();
}

export function spotifyWaveformStatus(): SpotifyWaveformStatus {
  if (process.platform !== 'darwin') return { enabled: false, tap: 'unavailable', reason: 'Waveforms need a Mac (macOS 13 or newer).' };
  return { enabled, tap: tapState, reason: tapReason };
}

export function spotifyWaveformGet(uri: string): SpotifyWaveform | null {
  const w = loadWave(uri);
  if (!w) return null;
  return { binSec: BIN_SEC, durationSec: w.durationSec, peaks: w.peaks, coverage: coverage(w) };
}

/** How much of each song has a waveform (0…1). */
export function spotifyWaveformCoverage(uris: string[]): Record<string, number> {
  const res: Record<string, number> = {};
  for (const u of uris.slice(0, 2000)) if (typeof u === 'string') res[u] = coverage(loadWave(u));
  return res;
}

export function spotifyWaveformShutdown(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  stopTap();
}
