// Learning the key detector's scoring settings from the operator's own
// tagged songs.
//
// Every detection keeps the song's note profile (how much of each of the
// 12 notes was heard overall, in the bass, and at the start and end). The
// profile is all scoreKeyFeatures() needs, so a song can be re-scored with
// different settings without its audio. Given songs whose key the operator
// set themselves, learnKeyParams() searches for settings that get more of
// them right — and only recommends them when they also do better on songs
// held out of the search (5-fold cross-validation), so a handful of odd
// songs can't talk it into something worse.
//
// Nothing here touches playback or timing; it only changes which key the
// detector suggests.

import type { KeyName, KeyProfile } from './types';
import {
  DEFAULT_KEY_SCORE_PARAMS, scoreKeyFeatures, keyRelation,
  type KeyDetectResult, type KeyFeatures, type KeyScoreParams,
} from './keyDetect';

export interface KeyExample { profile: KeyProfile; key: KeyName }

export interface KeyLearnResult {
  params: KeyScoreParams;
  examples: number;
  /** Held-out songs right with the standard settings / the learned ones. */
  before: number;
  after: number;
  /** True when the learned settings are worth using. */
  adopt: boolean;
}

/** Fewer tagged songs than this and learning just memorises them. */
export const MIN_EXAMPLES = 20;

const round = (v: number[]) => v.map(x => Math.round(x * 10000) / 10000);

/** The note profile of a detection, compact enough to save with the song. */
export function profileOf(r: KeyDetectResult): KeyProfile {
  return {
    harm: round(r.chroma.harm), bass: round(r.chroma.bass),
    intro: round(r.chroma.introBass), outro: round(r.chroma.outroBass),
    tuning: Math.round(r.tuningCents),
  };
}

function featuresOf(p: KeyProfile): KeyFeatures {
  return {
    harm: Float64Array.from(p.harm), bass: Float64Array.from(p.bass),
    introBass: Float64Array.from(p.intro), outroBass: Float64Array.from(p.outro),
    tuningCents: p.tuning ?? 0,
    frames: { harm: new Float32Array(0), bass: new Float32Array(0), weight: new Float32Array(0), hopSec: 0 },
  };
}

/** Re-score a saved profile with the given settings. */
export function rescoreProfile(p: KeyProfile, params: KeyScoreParams = DEFAULT_KEY_SCORE_PARAMS): KeyDetectResult {
  return scoreKeyFeatures(featuresOf(p), params);
}

/** Points for one song: exact = 1, relative major/minor (same pad family) = 0.5. */
function points(guess: KeyName, truth: KeyName): number {
  if (guess === truth) return 1;
  return keyRelation(guess, truth) === 'relative' ? 0.5 : 0;
}

function evaluate(ex: Array<{ f: KeyFeatures; key: KeyName }>, params: KeyScoreParams): number {
  let s = 0;
  for (const e of ex) s += points(scoreKeyFeatures(e.f, params).key, e.key);
  return s;
}

// Values tried for each setting (coordinate search). Ranges cover what the
// detector's original tuning explored.
const GRID: Record<keyof KeyScoreParams, number[]> = {
  subFifth: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
  subThird: [0, 0.1, 0.2, 0.3, 0.4],
  wBass: [0, 0.05, 0.1, 0.2, 0.3],
  wEdge: [0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6],
  introShare: [0, 0.2, 0.4, 0.6, 0.8, 1],
  majorLean: [0, 0.02, 0.04, 0.06, 0.1, 0.15],
};

function search(ex: Array<{ f: KeyFeatures; key: KeyName }>, start: KeyScoreParams): KeyScoreParams {
  let best = { ...start };
  let bestScore = evaluate(ex, best);
  for (let round = 0; round < 3; round++) {
    let improved = false;
    for (const k of Object.keys(GRID) as Array<keyof KeyScoreParams>) {
      for (const v of GRID[k]) {
        if (v === best[k]) continue;
        const cand = { ...best, [k]: v };
        const sc = evaluate(ex, cand);
        // Strictly better only, so ties keep the standard settings.
        if (sc > bestScore + 1e-9) { best = cand; bestScore = sc; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

/**
 * Learn settings from tagged songs. `before`/`after` are cross-validated:
 * each fifth of the songs is scored with settings learned from the other
 * four fifths, so they show how it does on songs it didn't learn from.
 */
export function learnKeyParams(examples: KeyExample[]): KeyLearnResult {
  const ex = examples.map(e => ({ f: featuresOf(e.profile), key: e.key }));
  const n = ex.length;
  if (n < MIN_EXAMPLES) {
    return { params: DEFAULT_KEY_SCORE_PARAMS, examples: n, before: 0, after: 0, adopt: false };
  }
  // Deterministic interleaved folds (no randomness: same songs, same answer).
  const FOLDS = 5;
  let before = 0, after = 0;
  for (let f = 0; f < FOLDS; f++) {
    const train = ex.filter((_, i) => i % FOLDS !== f);
    const test = ex.filter((_, i) => i % FOLDS === f);
    const p = search(train, DEFAULT_KEY_SCORE_PARAMS);
    before += evaluate(test, DEFAULT_KEY_SCORE_PARAMS);
    after += evaluate(test, p);
  }
  const params = search(ex, DEFAULT_KEY_SCORE_PARAMS);
  // Worth it only with a real margin: at least 2 more songs' worth and 5%.
  const adopt = after - before >= Math.max(2, n * 0.05);
  return { params, examples: n, before, after, adopt };
}

/**
 * A song's note map: for each second, how strongly each of the 12 notes
 * (C first) sounded, 0–99 relative to that second's loudest note; null for
 * seconds not analysed. `secOf` maps a time in the analysed audio to the
 * second of the song it came from (they differ when only parts of a song
 * were heard). Display only.
 */
export function noteMapOf(
  f: KeyFeatures,
  durSec: number,
  secOf: (tSec: number) => number | null = t => t,
): Array<number[] | null> {
  const n = Math.max(1, Math.ceil(durSec));
  const acc: Array<Float64Array | null> = new Array(n).fill(null);
  const { harm, weight, hopSec, index } = f.frames;
  const frames = weight.length;
  for (let i = 0; i < frames; i++) {
    const t = (index ? index[i] : i) * hopSec;
    const s = secOf(t);
    if (s === null) continue;
    const sec = Math.floor(s);
    if (sec < 0 || sec >= n) continue;
    const col = acc[sec] ?? (acc[sec] = new Float64Array(12));
    const w = weight[i] || 1;
    for (let pc = 0; pc < 12; pc++) col[pc] += harm[i * 12 + pc] * w;
  }
  return acc.map(col => {
    if (!col) return null;
    let mx = 0;
    for (const v of col) if (v > mx) mx = v;
    return mx > 0 ? Array.from(col, v => Math.round((v / mx) * 99)) : null;
  });
}
