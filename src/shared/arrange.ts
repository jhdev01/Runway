import type { Track, KeyName } from './types';
import { effectiveDuration } from './types';

export interface ArrangeOptions {
  // Pool of available tracks
  tracks: Track[];
  // Target total runway in seconds (e.g. 900 = 15 min)
  targetSec: number;
  // Last track must be in this key (or compatible, depending on strict)
  landInKey?: KeyName;
  // Strict = must match exactly. Relaxed = compatible keys (Camelot) acceptable.
  keyStrict?: boolean;
  // Allow tracks to repeat? Default false.
  allowRepeats?: boolean;
  // Tolerance: try to land within ±N seconds of target.
  toleranceSec?: number;
}

export interface ArrangeResult {
  trackIds: string[];
  totalSec: number;
  finalKey?: KeyName;
  // 0 = perfect, larger = worse fit
  score: number;
}

/**
 * Picks a subset of tracks from the pool whose total duration is as close
 * as possible to `targetSec`, ending on a track in `landInKey` if specified.
 *
 * This is a constrained subset-sum problem. For typical pre-service playlists
 * (10-30 tracks, 15-min target), brute-forcing combinations works fine.
 *
 * Strategy:
 * 1. If landInKey set: find candidate "anchor" tracks in that key.
 * 2. For each anchor, try filling the time before it with other tracks.
 * 3. Pick the best (closest to target, plus key variety).
 */
export function arrangePlaylist(opts: ArrangeOptions): ArrangeResult {
  const {
    tracks,
    targetSec,
    landInKey,
    keyStrict = true,
    toleranceSec = 30,
  } = opts;

  if (tracks.length === 0) {
    return { trackIds: [], totalSec: 0, score: 99999 };
  }

  // Pool of valid anchor tracks (the "last" one in the queue)
  let anchors: Track[];
  if (landInKey && keyStrict) {
    anchors = tracks.filter(t => t.key === landInKey);
  } else if (landInKey && !keyStrict) {
    anchors = tracks.filter(t => t.key === landInKey);
    // Could also allow compatible keys here; for v1 we keep it strict-ish.
  } else {
    anchors = tracks;
  }

  // If we asked for a key match but have nothing matching, fall back to all.
  if (anchors.length === 0) {
    anchors = tracks;
  }

  let best: ArrangeResult = { trackIds: [], totalSec: 0, score: 99999 };

  for (const anchor of anchors) {
    const others = tracks.filter(t => t.id !== anchor.id);
    const filled = greedyFill(others, targetSec - effectiveDuration(anchor));
    const totalSec = filled.totalSec + effectiveDuration(anchor);
    const drift = Math.abs(totalSec - targetSec);
    // Score: drift in seconds — lower is better. We always keep the best,
    // even when drift is large (e.g. very short rehearsal lead times where
    // a single track is already longer than the requested runway).
    const score = drift;

    if (score < best.score) {
      best = {
        trackIds: [...filled.ids, anchor.id],
        totalSec,
        finalKey: anchor.key,
        score,
      };
    }
  }

  // Failsafe: never return empty if there were tracks to choose from.
  if (best.trackIds.length === 0 && anchors.length > 0) {
    const anchor = anchors.reduce((shortest, t) =>
      effectiveDuration(t) < effectiveDuration(shortest) ? t : shortest, anchors[0]);
    best = {
      trackIds: [anchor.id],
      totalSec: effectiveDuration(anchor),
      finalKey: anchor.key,
      score: Math.abs(effectiveDuration(anchor) - targetSec),
    };
  }

  return best;
}

/**
 * Greedy: pick tracks one at a time to fill `targetSec` without going over by much.
 * Shuffles candidates per call so successive runs vary.
 */
function greedyFill(
  pool: Track[],
  targetSec: number
): { ids: string[]; totalSec: number } {
  if (targetSec <= 0) return { ids: [], totalSec: 0 };

  const candidates = [...pool].sort(() => Math.random() - 0.5);
  const picked: Track[] = [];
  let total = 0;

  for (const t of candidates) {
    if (total + effectiveDuration(t) <= targetSec + 30) {
      picked.push(t);
      total += effectiveDuration(t);
    }
    if (total >= targetSec - 30) break;
  }

  return { ids: picked.map(t => t.id), totalSec: total };
}

/**
 * Given the auto-arrange result, returns when the playlist must START
 * (in seconds before service start) so it lands at service start exactly.
 *
 *   start_offset = total_runway + pad_bridge + pad_fade_out
 *
 * If pad bridge is 10s and pad fade is 5s, the music must end 15s before service.
 */
export function calcAutoStartOffset(
  totalSec: number,
  padBridgeSec: number,
  padFadeOutSec: number
): number {
  return totalSec + padBridgeSec + padFadeOutSec;
}
