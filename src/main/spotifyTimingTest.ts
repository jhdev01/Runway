// Spotify timing test (experimental, macOS only).
//
// Measures how precisely Runway can make a song playing in the Spotify
// desktop app END at a planned moment. This is a standalone diagnostic:
// it does not touch Runway's audio engine, scheduling, or any service.
//
// Each run rehearses what a Spotify-driven "last song" would do:
//   1. Start the song silent and wait until Spotify reports it playing
//      (the load time). Then jump to the spot where it should end exactly
//      `TAIL_SEC` later, and fade Spotify's volume up.
//   2. Read Spotify's position to see how far off the landing would be
//      after that first jump (the "raw" error).
//   3. Nudge the position once to correct it, under the fade-in.
//   4. Keep reading to see how close the corrected landing is and how
//      steady Spotify's clock is.
//   5. Fade out and pause at the planned landing moment.
//
// Spotify is driven through AppleScript (osascript), which needs no
// Spotify developer app or login — just the desktop app running.

import { execFile } from 'child_process';

export interface SpotifyTimingRun {
  // Planned landing minus predicted landing right after starting, in ms.
  // Positive = the song would have ended LATE.
  rawErrorMs: number;
  // Same measurement after one corrective nudge.
  correctedErrorMs: number;
  // Spread (max − min) of the corrected readings — how steady they are.
  jitterMs: number;
  // Average time one command to Spotify took (round trip).
  commandMs: number;
  // How long Spotify took from "play" until it reported the song playing.
  loadMs: number;
  samples: number;
}

export interface SpotifyTimingResult {
  ok: boolean;
  reason?: string;
  track?: string;
  runs?: SpotifyTimingRun[];
}

const TAIL_SEC = 20;        // each run plays the last 20 s of the song
const FADE_SEC = 3;         // volume fade up / down
const CORRECT_AT_SEC = 4;   // when the corrective nudge is applied
const STEP_MS = 250;        // sampling / fade step
const RUNS = 3;
const LOAD_POLL_MS = 100;
const LOAD_TIMEOUT_MS = 5000;
const RESTART_MAX_SEC = 5;

let running = false;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function osa(lines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    for (const l of lines) args.push('-e', l);
    execFile('/usr/bin/osascript', args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

export const tell = (...body: string[]) => ['tell application "Spotify"', ...body, 'end tell'];

// AppleScript prints reals with a comma in some system locales ("12,5").
export const num = (s: string) => Number(s.trim().replace(',', '.'));
// AppleScript real literals must use a dot regardless of locale.
export const lit = (n: number) => n.toFixed(3);

/** Accepts a Spotify share link or URI; returns a spotify:track: URI or null. */
export function parseSpotifyTrack(input: string): string | null {
  const s = input.trim();
  const m = s.match(/^spotify:track:([A-Za-z0-9]+)$/)
    ?? s.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]+)/i);
  return m ? `spotify:track:${m[1]}` : null;
}

function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/-1743|not authori[sz]ed|not allowed/i.test(msg)) {
    return 'macOS blocked Runway from controlling Spotify. Open System Settings → Privacy & Security → Automation and allow Runway to control Spotify, then try again.';
  }
  if (/-600|isn.t running|not running/i.test(msg)) return 'Spotify isn’t open. Open the Spotify app and try again.';
  return msg;
}

export async function runSpotifyTimingTest(trackInput?: string): Promise<SpotifyTimingResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, reason: 'The Spotify timing test only works on a Mac for now.' };
  }
  if (running) return { ok: false, reason: 'A test is already running.' };
  running = true;
  let originalVolume: number | null = null;
  try {
    const isRunning = await osa(['application "Spotify" is running']);
    if (isRunning !== 'true') {
      return { ok: false, reason: 'Spotify isn’t open. Open the Spotify app and try again.' };
    }

    let uri: string;
    if (trackInput && trackInput.trim()) {
      const parsed = parseSpotifyTrack(trackInput);
      if (!parsed) return { ok: false, reason: 'That doesn’t look like a Spotify song link.' };
      uri = parsed;
      await osa(tell('set sound volume to 0', `play track "${uri}"`));
      await sleep(1500);
    } else {
      try {
        uri = await osa(tell('return id of current track'));
      } catch {
        return { ok: false, reason: 'Play a song in Spotify first, or paste a Spotify song link.' };
      }
      if (!/^spotify:track:/.test(uri)) {
        return { ok: false, reason: 'Play a song in Spotify first, or paste a Spotify song link.' };
      }
    }

    originalVolume = num(await osa(tell('return sound volume')));
    const info = await osa(tell(
      'return (duration of current track as text) & "|" & (name of current track) & " — " & (artist of current track)',
    ));
    const bar = info.indexOf('|');
    const durationSec = num(info.slice(0, bar)) / 1000;
    const track = info.slice(bar + 1);
    if (!(durationSec > TAIL_SEC + 10)) {
      return { ok: false, reason: 'That song is too short for the test. Pick one longer than 30 seconds.' };
    }
    // If the operator passed a link we zeroed the volume before reading
    // it; fall back to a sensible level so the test is audible.
    const peakVolume = originalVolume > 0 ? originalVolume : 60;
    if (trackInput && trackInput.trim()) originalVolume = peakVolume;

    const runs: SpotifyTimingRun[] = [];
    for (let i = 0; i < RUNS; i++) {
      await osa(tell('set sound volume to 0'));
      await sleep(700);

      // Start the song (silent) and wait until Spotify reports it playing.
      // A seek sent in the same breath as "play track" is ignored while
      // the song loads, so the jump has to come after this.
      const loadStart = Date.now();
      await osa(tell(`play track "${uri}"`));
      let loaded = false;
      while (Date.now() - loadStart < LOAD_TIMEOUT_MS) {
        // While a song loads Spotify briefly has no current track and
        // answers with error -1728; that just means "not yet", so ask again.
        let st = '';
        try {
          st = await osa(tell(
            'return (id of current track) & "|" & (player state as text) & "|" & (player position as text)',
          ));
        } catch (e) {
          if (!/-1728/.test(e instanceof Error ? e.message : String(e))) throw e;
        }
        const [id, state, posStr] = st.split('|');
        // Near the top of the song = the restart has actually happened
        // (replaying the current song can still report its old position).
        if (id === uri && state === 'playing' && num(posStr) < RESTART_MAX_SEC) { loaded = true; break; }
        await sleep(LOAD_POLL_MS);
      }
      const loadMs = Date.now() - loadStart;
      if (!loaded) {
        await osa(tell('pause'));
        return { ok: false, reason: 'Spotify didn’t start the song within 5 seconds. Check your connection and try again.' };
      }

      const plannedEnd = Date.now() + TAIL_SEC * 1000;
      // Where the song should be at wall-clock time t to end on plannedEnd.
      const targetPos = (t: number) => durationSec - (plannedEnd - t) / 1000;

      const cmdTimes: number[] = [];
      const t0 = Date.now();
      await osa(tell(`set player position to ${lit(targetPos(t0))}`));
      cmdTimes.push(Date.now() - t0);

      const raw: number[] = [];
      const corrected: number[] = [];
      let nudged = false;

      while (Date.now() < plannedEnd - 150) {
        const now = Date.now();
        const sinceStart = (now - (plannedEnd - TAIL_SEC * 1000)) / 1000;
        const untilEnd = (plannedEnd - now) / 1000;
        const gain = Math.max(0, Math.min(1, sinceStart / FADE_SEC, untilEnd / FADE_SEC));
        const vol = Math.round(peakVolume * gain);

        const a = Date.now();
        const out = await osa(tell(
          `set sound volume to ${vol}`,
          'return (player position as text) & "|" & (player state as text)',
        ));
        const b = Date.now();
        cmdTimes.push(b - a);
        const [posStr, state] = out.split('|');
        const pos = num(posStr);
        if (state === 'playing' && Number.isFinite(pos)) {
          // Attribute the reading to the middle of the round trip.
          const predictedEnd = (a + b) / 2 + (durationSec - pos) * 1000;
          const err = predictedEnd - plannedEnd;
          // Ignore the reading right after a seek while Spotify settles.
          if (!nudged) raw.push(err);
          else if (sinceStart > CORRECT_AT_SEC + 1 && untilEnd > FADE_SEC) corrected.push(err);
        }

        if (!nudged && sinceStart >= CORRECT_AT_SEC) {
          const lead = median(cmdTimes) / 2;
          await osa(tell(`set player position to ${lit(targetPos(Date.now() + lead))}`));
          nudged = true;
        }

        const spent = Date.now() - now;
        if (spent < STEP_MS) await sleep(STEP_MS - spent);
      }

      await osa(tell('set sound volume to 0', 'pause'));

      if (raw.length < 2 || corrected.length < 2) {
        return {
          ok: false,
          track,
          reason: 'Spotify didn’t report steady playback during the test (it may have been buffering or showing an ad). Try again.',
        };
      }
      // Skip the very first raw reading — it can land mid-seek.
      const rawUsable = raw.length > 2 ? raw.slice(1) : raw;
      runs.push({
        rawErrorMs: Math.round(median(rawUsable)),
        correctedErrorMs: Math.round(median(corrected)),
        jitterMs: Math.round(Math.max(...corrected) - Math.min(...corrected)),
        commandMs: Math.round(cmdTimes.reduce((s, x) => s + x, 0) / cmdTimes.length),
        samples: corrected.length,
        loadMs,
      });
    }
    return { ok: true, track, runs };
  } catch (e) {
    return { ok: false, reason: friendly(e) };
  } finally {
    if (originalVolume !== null) {
      try { await osa(tell(`set sound volume to ${Math.round(originalVolume)}`)); } catch { /* best effort */ }
    }
    running = false;
  }
}
