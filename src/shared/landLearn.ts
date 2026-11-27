/**
 * Suggested trims and 0:00 (service landing) marks, from a song's loudness
 * envelope (peak level per short bin, 0…1; -1 = not heard, for Spotify
 * waveforms that were only scanned at the start and end).
 *
 *  - Silence: where sound actually starts and stops. Only near-digital
 *    silence counts, never quiet music or a fade.
 *  - 0:00: learned from the marks the operator placed by hand. The model
 *    finds "the last big moment before the music falls away": the last
 *    point where the smoothed level is still at least `level` × the song's
 *    loud level, optionally moved back to the peak just before it, plus a
 *    learned offset. Its few settings are tuned on the operator's own
 *    marks and checked on songs it didn't learn from.
 *
 * Pure functions: no I/O, no timing side effects. Suggestions are only
 * applied when the operator clicks them.
 */

export interface Envelope {
  binSec: number;
  /** Peak level per bin, 0…1; -1 where the song wasn't heard. */
  peaks: number[];
}

export interface LandParams {
  /** Smoothing window in seconds (moving average of the envelope). */
  smoothSec: number;
  /** Share of the song's loud level that still counts as "big". */
  level: number;
  /** 'edge': the moment the level drops under the threshold; 'peak': the loudest point in the few seconds before it. */
  mode: 'edge' | 'peak';
  /** Seconds added to the found point (learned: where the operator puts it relative to it). */
  offsetSec: number;
}

export const DEFAULT_LAND_PARAMS: LandParams = { smoothSec: 0.5, level: 0.55, mode: 'peak', offsetSec: 0 };

/** Near-digital silence (about -50 dBFS). */
const SILENCE = 0.003;
/** Don't bother suggesting a trim smaller than this. */
const MIN_TRIM_SEC = 0.3;
/** How far back from the end the 0:00 search looks. */
const SEARCH_BACK_SEC = 90;
/** 'peak' mode looks this far back from the drop for the peak. */
const PEAK_BACK_SEC = 4;

/** Peak level per `binSec` from raw samples (mono, -1…1). */
export function envelopeFromSamples(samples: Float32Array, rate: number, binSec = 0.1): Envelope {
  const per = Math.max(1, Math.round(rate * binSec));
  const n = Math.ceil(samples.length / per);
  const peaks = new Array<number>(n).fill(0);
  for (let b = 0; b < n; b++) {
    let m = 0;
    const end = Math.min(samples.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) { const v = Math.abs(samples[i]); if (v > m) m = v; }
    peaks[b] = Math.min(1, m);
  }
  return { binSec, peaks };
}

/**
 * Where sound starts and stops. Returns only the ends that have more than
 * `MIN_TRIM_SEC` of silence (and were actually heard).
 */
export function suggestSilenceTrim(env: Envelope): { startSec?: number; endSec?: number } {
  const { peaks, binSec } = env;
  const out: { startSec?: number; endSec?: number } = {};
  if (peaks.length === 0) return out;
  // Start: leading bins must be heard and silent.
  let i = 0;
  while (i < peaks.length && peaks[i] >= 0 && peaks[i] < SILENCE) i++;
  if (i < peaks.length && peaks[i] >= 0 && i * binSec >= MIN_TRIM_SEC) {
    out.startSec = Math.max(0, i * binSec - 0.05);
  }
  // End: trailing bins must be heard and silent.
  let j = peaks.length - 1;
  while (j >= 0 && peaks[j] >= 0 && peaks[j] < SILENCE) j--;
  if (j >= 0 && peaks[j] >= 0 && (peaks.length - 1 - j) * binSec >= MIN_TRIM_SEC) {
    out.endSec = Math.min(peaks.length * binSec, (j + 1) * binSec + 0.2);
  }
  return out;
}

/** The song's loud level: 95th percentile of what was heard. */
function loudLevel(peaks: number[]): number {
  const heard = peaks.filter(v => v >= 0).sort((a, b) => a - b);
  if (heard.length === 0) return 0;
  return heard[Math.min(heard.length - 1, Math.floor(heard.length * 0.95))];
}

function smooth(peaks: number[], bins: number): number[] {
  if (bins <= 1) return peaks.slice();
  const out = new Array<number>(peaks.length).fill(-1);
  const half = Math.floor(bins / 2);
  for (let i = 0; i < peaks.length; i++) {
    let s = 0, n = 0;
    for (let k = i - half; k <= i + half; k++) {
      if (k < 0 || k >= peaks.length || peaks[k] < 0) continue;
      s += peaks[k]; n++;
    }
    out[i] = n ? s / n : -1;
  }
  return out;
}

/**
 * Predicted 0:00 in seconds, or null when the end of the song wasn't heard
 * or nothing qualifies. `endSec` is where the song stops playing (its trim
 * end, or its length).
 */
export function predictLand(env: Envelope, endSec: number, p: LandParams): number | null {
  const { peaks, binSec } = env;
  const ref = loudLevel(peaks);
  if (ref <= SILENCE) return null;
  const sm = smooth(peaks, Math.max(1, Math.round(p.smoothSec / binSec)));
  const last = Math.min(sm.length - 1, Math.floor(endSec / binSec) - 1);
  const first = Math.max(0, last - Math.round(SEARCH_BACK_SEC / binSec));
  // The end has to have been heard for a guess to mean anything.
  const heardEnd = sm.slice(Math.max(first, last - Math.round(20 / binSec)), last + 1).filter(v => v >= 0).length;
  if (heardEnd < 10 / binSec * 0.5) return null;
  const thr = p.level * ref;
  let k = -1;
  for (let i = last; i >= first; i--) { if (sm[i] >= thr) { k = i; break; } }
  if (k < 0) return null;
  if (p.mode === 'peak') {
    const lo = Math.max(first, k - Math.round(PEAK_BACK_SEC / binSec));
    let best = k;
    for (let i = k; i >= lo; i--) if (peaks[i] > peaks[best]) best = i;
    k = best;
  }
  const t = (k + 0.5) * binSec + p.offsetSec;
  return Math.max(0, Math.min(endSec, Math.round(t * 10) / 10));
}

export interface LandExample { env: Envelope; endSec: number; landSec: number }

export interface LandLearnResult {
  params: LandParams;
  examples: number;
  /** Share of songs (not learned from) where the guess lands within 1 s of the hand mark. */
  within1s: number;
  /** Same, with the standard settings, for comparison. */
  within1sDefault: number;
  /** Median miss in seconds (held-out). */
  medianMissSec: number;
}

export const MIN_LAND_EXAMPLES = 5;

const GRID: Omit<LandParams, 'offsetSec'>[] = (() => {
  const out: Omit<LandParams, 'offsetSec'>[] = [];
  for (const smoothSec of [0.2, 0.5, 1, 2]) {
    for (let lv = 0.2; lv <= 0.91; lv += 0.05) {
      for (const mode of ['edge', 'peak'] as const) out.push({ smoothSec, level: Math.round(lv * 100) / 100, mode });
    }
  }
  return out;
})();

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Best settings on `train` (offset = median leftover miss). */
function fit(train: LandExample[]): LandParams {
  let best: { p: LandParams; cost: number } | null = null;
  for (const g of GRID) {
    const res: number[] = [];
    for (const ex of train) {
      const t = predictLand(ex.env, ex.endSec, { ...g, offsetSec: 0 });
      if (t !== null) res.push(ex.landSec - t);
    }
    if (res.length < Math.max(2, train.length * 0.6)) continue;
    const off = median(res);
    // Cost: capped misses (a wild miss counts as 5 s), unanswered songs as 5 s.
    const misses = res.map(r => Math.min(5, Math.abs(r - off)));
    const cost = (misses.reduce((a, b) => a + b, 0) + (train.length - res.length) * 5) / train.length;
    if (!best || cost < best.cost) best = { p: { ...g, offsetSec: Math.round(off * 10) / 10 }, cost };
  }
  return best?.p ?? DEFAULT_LAND_PARAMS;
}

function score(test: LandExample[], p: LandParams): { within1: number; misses: number[] } {
  let within1 = 0;
  const misses: number[] = [];
  for (const ex of test) {
    const t = predictLand(ex.env, ex.endSec, p);
    const miss = t === null ? 99 : Math.abs(t - ex.landSec);
    misses.push(miss);
    if (miss <= 1) within1++;
  }
  return { within1, misses };
}

/**
 * Learns 0:00 settings from hand-placed marks, with 5-fold cross-checking
 * so the reported accuracy is on songs the settings didn't see.
 */
export function learnLandParams(examples: LandExample[]): LandLearnResult {
  const n = examples.length;
  if (n < MIN_LAND_EXAMPLES) {
    const d = score(examples, DEFAULT_LAND_PARAMS);
    const share = n ? d.within1 / n : 0;
    return { params: DEFAULT_LAND_PARAMS, examples: n, within1s: share, within1sDefault: share, medianMissSec: median(d.misses) };
  }
  const folds = Math.min(5, n);
  let within1 = 0, within1Def = 0;
  const allMiss: number[] = [];
  for (let f = 0; f < folds; f++) {
    const test = examples.filter((_, i) => i % folds === f);
    const train = examples.filter((_, i) => i % folds !== f);
    const p = fit(train);
    const s = score(test, p);
    within1 += s.within1;
    allMiss.push(...s.misses);
    within1Def += score(test, DEFAULT_LAND_PARAMS).within1;
  }
  return {
    params: fit(examples),
    examples: n,
    within1s: within1 / n,
    within1sDefault: within1Def / n,
    medianMissSec: Math.round(median(allMiss) * 10) / 10,
  };
}
