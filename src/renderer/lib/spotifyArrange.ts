/**
 * Arranges a Spotify playlist for a service's pre-service runway, following
 * the same rules as armService's auto-arrange for Runway playlists:
 *
 *   anchor (the song that lands at service start):
 *     1. a song in the service's first-song key (the last one in playlist order)
 *     2. a song in a compatible (Camelot) key
 *     3. the playlist's last song
 *   before it: the other songs in playlist order (or shuffled), repeated if
 *   needed so the music fills the auto-start window; the first one starts
 *   partway in so the anchor lands exactly at service start.
 *
 * When the anchor isn't in the requested key the pad bridge is skipped for
 * this arm (same as Runway playlists) so the pad doesn't clash with the music.
 */

import { compatibleKeys } from '@shared/music';
import type { KeyName, SpotifyPlaylistSettings, SpotifyPlaylistTrack, SpotifyTrackEdit } from '@shared/types';
import { planSpotifyRun, songBounds, type SpotifyRunSegment } from './spotifyTestRun';

export interface SpotifyArrangement {
  segments: SpotifyRunSegment[];
  landInKey?: KeyName;
  anchorTitle: string;
  skipPadBridge: boolean;
  warning?: string;
}

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function arrangeSpotifyRunway(opts: {
  tracks: SpotifyPlaylistTrack[];
  edits: Record<string, SpotifyTrackEdit>;
  requestedKey?: KeyName;
  targetSec: number;        // auto-start window (music start → service start)
  targetMs: number;         // service start, wall clock
  repeatToFill: boolean;
  shuffle: boolean;
  lastFadeSec: number;      // Runway's Music fade, for the anchor's fade after 0:00
  pinnedUri?: string;       // the service's chosen last song (Spotify)
}): SpotifyArrangement {
  const { tracks, edits, requestedKey } = opts;
  const keyOf = (t: SpotifyPlaylistTrack) => edits[t.uri]?.key;
  let warning: string | undefined;

  let anchor: SpotifyPlaylistTrack | undefined;
  // 1. The last song chosen in the service's settings, if it's in the playlist.
  if (opts.pinnedUri) {
    anchor = tracks.find(t => t.uri === opts.pinnedUri);
    if (!anchor) warning = 'The chosen last song isn’t in this Spotify playlist any more. Picking by key instead.';
  }
  if (!anchor && requestedKey) {
    const exact = tracks.filter(t => keyOf(t) === requestedKey);
    if (exact.length) anchor = exact[exact.length - 1];
    if (!anchor) {
      for (const k of compatibleKeys(requestedKey)) {
        const m = tracks.filter(t => keyOf(t) === k);
        if (m.length) {
          anchor = m[m.length - 1];
          warning = `No Spotify song in ${requestedKey}. Landing on ${k} (compatible).`;
          break;
        }
      }
    }
  }
  if (!anchor) {
    anchor = tracks[tracks.length - 1];
    if (requestedKey) {
      warning = `No Spotify song in ${requestedKey} or a compatible key. Landing on “${anchor.title}”${keyOf(anchor) ? ` (${keyOf(anchor)})` : ''} — set song keys to fix.`;
    }
  }
  const anchorKey = keyOf(anchor);
  const landInKey = requestedKey ?? anchorKey;
  const skipPadBridge = !!requestedKey && anchorKey !== requestedKey;
  if (skipPadBridge) {
    warning = opts.pinnedUri && anchor.uri === opts.pinnedUri
      ? `${warning ?? ''} The chosen last song is ${anchorKey ? `in ${anchorKey}` : 'not tagged with a key'}, not ${requestedKey}: pad bridge skipped.`.trim()
      : `${warning ?? ''} Pad bridge skipped — no song in ${requestedKey}.`.trim();
  }

  const span = (t: SpotifyPlaylistTrack, isAnchor: boolean) => {
    const b = songBounds(t.durationMs / 1000, edits[t.uri]);
    return (isAnchor ? b.land : b.end) - b.start;
  };
  const others = tracks.filter(t => t !== anchor);
  const rotation = others.length ? (opts.shuffle ? shuffle(others) : others) : [anchor];
  const seq: SpotifyPlaylistTrack[] = [];
  let total = span(anchor, true);
  for (let i = 0; total < opts.targetSec && i < 500; i++) {
    if (!opts.repeatToFill && i >= rotation.length) break;
    const t = rotation[i % rotation.length];
    seq.push(t);
    total += span(t, false);
  }
  seq.push(anchor);

  const segments = planSpotifyRun(seq, opts.targetSec, opts.targetMs, edits, opts.lastFadeSec);
  return { segments, landInKey, anchorTitle: anchor.title, skipPadBridge, warning };
}

/**
 * A Spotify playlist's settings applied to a planned run. Only the fades and
 * (with "Don't trim opening song") how early the first song starts change:
 * every song still starts and ends where the plan put it, so the landing on
 * 0:00 doesn't move.
 */
export function applySpotifyPlaylistSettings(
  segs: SpotifyRunSegment[],
  ps: SpotifyPlaylistSettings | undefined,
  edits: Record<string, SpotifyTrackEdit>,
  defaultCrossfadeSec: number,
): SpotifyRunSegment[] {
  if (!ps || segs.length === 0) return segs;
  let out = segs.map(x => ({ ...x }));
  if (ps.transitionMode === 'crossfade') {
    const half = Math.max(0, ps.crossfadeSec ?? defaultCrossfadeSec) / 2;
    const last = out.length - 1;
    out = out.map((x, i) => ({
      ...x,
      // A song's own fades (Editor) win.
      fadeInSec: i > 0 ? (x.fadeInSec ?? half) : x.fadeInSec,
      fadeOutSec: i < last ? (x.fadeOutSec ?? half) : x.fadeOutSec,
    }));
  }
  if (ps.playFirstSongFromStart) {
    const f = out[0];
    const top = songBounds(f.songDurSec, edits[f.uri]).start;
    if (f.startPosSec > top + 0.5) {
      out[0] = { ...f, startAt: f.startAt - (f.startPosSec - top) * 1000, startPosSec: top };
    }
  }
  return out;
}
