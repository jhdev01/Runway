// Offline musical-key detection from raw audio samples.
//
// Pure TypeScript, no DOM / Web Audio dependencies, so it runs the same in
// a Web Worker, the renderer, or plain Node (for tests).
//
// How it works, in order:
//   1. Short-time spectra (Hann window, ~0.75 s) across the whole song.
//   2. Spectral peaks → a fine-grained pitch-class histogram (10-cent bins),
//      one for the harmony band and one for the bass band.
//   3. Tuning estimate — recordings are rarely at exactly A=440, and a song
//      that sits 30 cents flat smears every note across two semitones unless
//      we re-centre the bins first.
//   4. Fold to 12 pitch classes, correct for overtone bias (every note
//      also sounds a fifth above itself, which drags a naive detector
//      toward the dominant), and score all 24 keys against tonal profiles. The harmony profile settles the key signature; the bass and
//      the song's first/last moments help settle which note is "home"
//      (which is what separates C major from A minor, or C from F).
//   5. Confidence from the margin over the best *unrelated* key.
//
// This touches nothing in the playback timeline — it only suggests a tag.

import type { KeyName } from './types';

export interface KeyCandidate {
  key: KeyName;
  score: number;
}

export interface KeyDetectResult {
  key: KeyName;
  /** 0..1 — how clearly this key beat the alternatives. */
  confidence: number;
  /** Top candidates, best first (includes the winner). */
  candidates: KeyCandidate[];
  /** Estimated tuning offset from A=440, in cents (-50..+50). */
  tuningCents: number;
  /** The note profiles the decision was made from (12 values each, C first). */
  chroma: { harm: number[]; bass: number[]; introBass: number[]; outroBass: number[] };
}

// Canonical KeyName per pitch class (0 = C), matching shared/types.ts.
const MAJOR_NAMES: KeyName[] = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES: KeyName[] = ['Cm', 'C#m', 'Dm', 'D#m', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];

// Tonal profiles (weight of each scale degree, tonic first). Three
// well-known sets — Krumhansl-Kessler (listener ratings), Temperley
// (corpus-derived), Sha'ath (tuned on recorded audio). Each has a
// different blind spot, so we z-score and average them.
const PROFILES_MAJOR = [
  [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400],
  [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
];
const PROFILES_MINOR = [
  [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
  [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330],
  [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
];

// Where the bass tends to sit, by scale degree. Root-position chords put
// the bass on I / IV / V / vi in major and i / VI / III / VII / iv / v in
// minor, with the tonic getting the most time.
const BASS_MAJOR = [1.0, 0.02, 0.30, 0.02, 0.28, 0.70, 0.02, 0.75, 0.02, 0.55, 0.05, 0.10];
const BASS_MINOR = [1.0, 0.02, 0.15, 0.60, 0.02, 0.50, 0.02, 0.55, 0.60, 0.05, 0.55, 0.05];

function zscore(v: number[]): number[] {
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length) || 1;
  return v.map(x => (x - mean) / sd);
}

function averageProfile(sets: number[][]): number[] {
  const out = new Array(12).fill(0);
  for (const s of sets) {
    const z = zscore(s);
    for (let i = 0; i < 12; i++) out[i] += z[i] / sets.length;
  }
  return out;
}

const PROFILE_MAJOR = averageProfile(PROFILES_MAJOR);
const PROFILE_MINOR = averageProfile(PROFILES_MINOR);

/** Pearson correlation of a 12-bin chroma against a profile rotated to `tonic`. */
function correlate(chroma: ArrayLike<number>, profile: number[], tonic: number): number {
  let mc = 0, mp = 0;
  for (let i = 0; i < 12; i++) { mc += chroma[i]; mp += profile[i]; }
  mc /= 12; mp /= 12;
  let num = 0, dc = 0, dp = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[(i + tonic) % 12] - mc;
    const p = profile[i] - mp;
    num += c * p; dc += c * c; dp += p * p;
  }
  const den = Math.sqrt(dc * dp);
  return den > 0 ? num / den : 0;
}

// ---- FFT (in-place iterative radix-2) ----

class FFT {
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;
  private readonly n: number;
  constructor(n: number) {
    this.n = n;
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        const t = re[i]; re[i] = re[j]; re[j] = t;
        const u = im[i]; im[i] = im[j]; im[j] = u;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = this.cos[t], wi = -this.sin[t];
          const a = start + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

// ---- Analysis constants ----

const FINE = 120;              // fine pitch-class bins per octave (10 cents each)
const PER_SEMI = FINE / 12;
const BASS_LO = 55, BASS_HI = 262;      // A1 .. C4 — bass fundamentals + first overtones

/** Front-end (listening) settings. Exposed so tests can sweep them. */
export interface KeyFrontEndParams {
  windowSec: number;   // analysis window length
  harmLo: number;      // harmony band, Hz
  harmHi: number;
  rollHz: number;      // above this, partials are progressively discounted
  compress: number;    // magnitude exponent (0.5 = square root)
  maxPeaks: number;    // partials kept per frame
  peakFloor: number;   // partials quieter than this × the frame's loudest are ignored
}
export const DEFAULT_KEY_FRONT_END: KeyFrontEndParams = {
  windowSec: 0.75,
  harmLo: 110,
  harmHi: 2000,
  rollHz: 1000,
  compress: 0.5,
  maxPeaks: 40,
  peakFloor: 0.01,
};
const EDGE_SEC = 10;           // how much of the start/end counts as "intro"/"outro"

/** Pick the window so it's ~0.75 s regardless of sample rate (power of two). */
function windowSizeFor(sampleRate: number, windowSec: number): number {
  const target = sampleRate * windowSec;
  let n = 1024;
  while (n * 2 <= target * 1.2) n *= 2;
  return n;
}

/**
 * Detect the musical key of a mono signal.
 *
 * @param samples     Mono PCM, any length. ~11 kHz is plenty (everything
 *                    above 2 kHz is ignored), and lower rates run faster.
 * @param sampleRate  Sample rate of `samples` in Hz.
 * @returns the detected key, or null when there isn't enough tonal audio
 *          to say anything (silence, pure percussion, a 2-second clip).
 */
export function detectKey(
  samples: Float32Array,
  sampleRate: number,
  params: KeyScoreParams = DEFAULT_KEY_SCORE_PARAMS,
): KeyDetectResult | null {
  const features = extractKeyFeatures(samples, sampleRate);
  return features ? scoreKeyFeatures(features, params) : null;
}

/** Pitch-class summaries of a song — everything scoring needs. */
export interface KeyFeatures {
  harm: Float64Array;       // 12-bin harmony chroma (whole song)
  bass: Float64Array;       // 12-bin bass chroma (whole song)
  introBass: Float64Array;  // normalised bass chroma, first few seconds
  outroBass: Float64Array;  // normalised bass chroma, last few seconds
  tuningCents: number;
  /** Per-frame tuned chroma (frame-major, 12 values per frame). */
  frames: { harm: Float32Array; bass: Float32Array; weight: Float32Array; hopSec: number };
}

/** Scoring weights. Exposed so tests can sweep them; the app uses defaults. */
export interface KeyScoreParams {
  /** Share of each note's energy credited to the note a fifth below (it may be that note's 3rd harmonic). */
  subFifth: number;
  /** Same, for the note a major third below (5th harmonic). */
  subThird: number;
  wBass: number;
  wEdge: number;
  introShare: number;
  majorLean: number;
}

// Chosen by sweeping against real recordings with known keys:
//   - 486 pop / rock / country / reggae / disco band clips (GTZAN + Lerch's
//     key annotations) — the closest public stand-in for worship recordings
//   - 48 solo-piano pieces, one per key (Bach's Well-Tempered Clavier)
//   - 324 synthesised pop/worship progressions with detuning and noise
// Findings worth keeping:
//   - The overtone correction is the big win (piano 36 → 46 of 48; nearly
//     all the earlier misses were "a fifth too high").
//   - A hand-made bass profile HURT on band recordings (73% → 77% exact
//     without it), so wBass is 0. Bass still feeds the intro/outro cue.
//   - A lean toward major didn't help either.
//   - Learned profiles, chord histograms and a small neural scorer were all
//     tried under cross-validation and landed within ~1 point of this, while
//     generalising worse to the piano set — so they aren't used.
// On the band clips this scores 77% exact, 90% exact-or-compatible, and the
// right key is in the top two 89% of the time. At confidence >= 0.5 it is
// 92% exact / 98% exact-or-compatible.
export const DEFAULT_KEY_SCORE_PARAMS: KeyScoreParams = {
  subFifth: 0.5,
  subThird: 0.2,
  wBass: 0,
  wEdge: 0.25,
  introShare: 0.4,
  majorLean: 0,
};

export function extractKeyFeatures(
  samples: Float32Array,
  sampleRate: number,
  frontEnd: Partial<KeyFrontEndParams> = {},
): KeyFeatures | null {
  const fe = { ...DEFAULT_KEY_FRONT_END, ...frontEnd };
  const HARM_LO = fe.harmLo, HARM_HI = fe.harmHi, MAX_PEAKS = fe.maxPeaks;
  const N = windowSizeFor(sampleRate, fe.windowSec);
  const hop = N >> 2;
  if (samples.length < N * 2) return null;

  const fft = new FFT(N);
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const binHz = sampleRate / N;
  const loBin = Math.max(2, Math.floor(BASS_LO / binHz));
  const hiBin = Math.min(N / 2 - 2, Math.ceil(HARM_HI / binHz));

  const frameCount = Math.floor((samples.length - N) / hop) + 1;
  // Per-frame fine chroma so we can (a) re-fold after the tuning estimate
  // and (b) look at the intro/outro separately.
  const harmFrames = new Float32Array(frameCount * FINE);
  const bassFrames = new Float32Array(frameCount * FINE);
  const frameEnergy = new Float32Array(frameCount);

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag = new Float32Array(N / 2);
  const peakBins: number[] = [];

  for (let f = 0; f < frameCount; f++) {
    const off = f * hop;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const s = samples[off + i];
      energy += s * s;
      re[i] = s * hann[i];
      im[i] = 0;
    }
    frameEnergy[f] = energy / N;
    if (energy <= 1e-9) continue;
    fft.transform(re, im);

    let frameMax = 0;
    for (let b = loBin - 1; b <= hiBin + 1; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      mag[b] = m;
      if (m > frameMax) frameMax = m;
    }
    if (frameMax <= 0) continue;

    // Local maxima within 40 dB of the frame's loudest partial.
    const floor = frameMax * fe.peakFloor;
    peakBins.length = 0;
    for (let b = loBin; b <= hiBin; b++) {
      const m = mag[b];
      if (m > floor && m > mag[b - 1] && m >= mag[b + 1]) peakBins.push(b);
    }
    if (peakBins.length > MAX_PEAKS) {
      peakBins.sort((a, b) => mag[b] - mag[a]);
      peakBins.length = MAX_PEAKS;
    }

    const base = f * FINE;
    for (const b of peakBins) {
      // Parabolic interpolation on log magnitude → sub-bin frequency.
      const l = Math.log(mag[b - 1] + 1e-12);
      const c = Math.log(mag[b] + 1e-12);
      const r = Math.log(mag[b + 1] + 1e-12);
      const denom = l - 2 * c + r;
      const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / denom)) : 0;
      const freq = (b + delta) * binHz;
      if (freq < BASS_LO || freq > HARM_HI) continue;

      // Fine pitch class: semitones above C, at 10-cent resolution.
      const midi = 69 + 12 * Math.log2(freq / 440);
      let fine = Math.round(midi * PER_SEMI) % FINE;
      if (fine < 0) fine += FINE;

      // Square-root compression so one loud instrument doesn't drown the rest.
      const w = Math.pow(mag[b], fe.compress);
      if (freq <= BASS_HI) bassFrames[base + fine] += w;
      if (freq >= HARM_LO) {
        // Roll off above 1 kHz — up there it's mostly overtones, which
        // carry the fifth/third of the note rather than the note itself.
        const roll = freq <= fe.rollHz ? 1 : fe.rollHz / freq;
        harmFrames[base + fine] += w * roll;
      }
    }
  }

  // ---- Gate out silence and normalise each frame ----
  let maxEnergy = 0;
  for (let f = 0; f < frameCount; f++) if (frameEnergy[f] > maxEnergy) maxEnergy = frameEnergy[f];
  if (maxEnergy <= 0) return null;
  const gate = maxEnergy * 1e-4; // -40 dB below the loudest frame

  const active: number[] = [];
  for (let f = 0; f < frameCount; f++) if (frameEnergy[f] > gate) active.push(f);
  if (active.length < 8) return null;

  // Each frame contributes its *shape*, weighted by a compressed loudness,
  // so a huge final chorus doesn't outvote two quiet verses.
  const frameWeight = (f: number): number => Math.pow(frameEnergy[f] / maxEnergy, 0.25);

  const sumFine = (frames: Float32Array, from: number, to: number): Float64Array => {
    const out = new Float64Array(FINE);
    for (let idx = from; idx < to; idx++) {
      const f = active[idx];
      const base = f * FINE;
      let total = 0;
      for (let i = 0; i < FINE; i++) total += frames[base + i];
      if (total <= 0) continue;
      const w = frameWeight(f) / total;
      for (let i = 0; i < FINE; i++) out[i] += frames[base + i] * w;
    }
    return out;
  };

  const harmFine = sumFine(harmFrames, 0, active.length);
  const bassFine = sumFine(bassFrames, 0, active.length);

  // ---- Tuning estimate ----
  // Circular mean of where energy falls *within* a semitone.
  let tx = 0, ty = 0;
  for (let i = 0; i < FINE; i++) {
    const phase = (2 * Math.PI * (i % PER_SEMI)) / PER_SEMI;
    const e = harmFine[i] + bassFine[i];
    tx += e * Math.cos(phase);
    ty += e * Math.sin(phase);
  }
  let tuneBins = (Math.atan2(ty, tx) / (2 * Math.PI)) * PER_SEMI; // -5..+5 fine bins
  if (tuneBins > PER_SEMI / 2) tuneBins -= PER_SEMI;
  const tuningCents = tuneBins * (100 / PER_SEMI);

  /** Fold a fine histogram to 12 pitch classes around the tuned centres. */
  const fold = (fineHist: ArrayLike<number>, offset = 0): Float64Array => {
    const out = new Float64Array(12);
    for (let i = 0; i < FINE; i++) {
      const v = fineHist[offset + i];
      if (v === 0) continue;
      const pos = (i - tuneBins) / PER_SEMI;       // in semitones, tuned
      const pc = Math.round(pos);
      const dev = pos - pc;                         // -0.5..0.5
      const w = Math.cos(Math.PI * dev) ** 2;       // 1 on-centre → 0 between notes
      out[((pc % 12) + 12) % 12] += v * w;
    }
    return out;
  };

  // Per-frame 12-bin chroma (tuned), for chord-level analysis.
  const frameHarm = new Float32Array(active.length * 12);
  const frameBass = new Float32Array(active.length * 12);
  const frameWeights = new Float32Array(active.length);
  for (let idx = 0; idx < active.length; idx++) {
    const f = active[idx];
    frameHarm.set(fold(harmFrames, f * FINE), idx * 12);
    frameBass.set(fold(bassFrames, f * FINE), idx * 12);
    frameWeights[idx] = frameWeight(f);
  }

  const harm = fold(harmFine);
  const bass = fold(bassFine);
  const harmTotal = harm.reduce((a, b) => a + b, 0);
  if (harmTotal <= 0) return null;

  // Intro / outro bass — songs overwhelmingly start and (especially) end
  // on the home chord. Only used as a tie-breaker.
  const frameSec = hop / sampleRate;
  const edgeFrames = Math.max(4, Math.min(Math.floor(active.length / 4), Math.round(EDGE_SEC / frameSec)));
  const normalise = (v: Float64Array): Float64Array => {
    const t = v.reduce((a, b) => a + b, 0);
    return t > 0 ? v.map(x => x / t) : v;
  };
  const introBass = normalise(fold(sumFine(bassFrames, 0, edgeFrames)));
  const outroBass = normalise(fold(sumFine(bassFrames, active.length - edgeFrames, active.length)));
  return {
    harm, bass, introBass, outroBass, tuningCents,
    frames: { harm: frameHarm, bass: frameBass, weight: frameWeights, hopSec: frameSec },
  };
}

/**
 * Undo some of the overtone bias. Every played note also sounds its 3rd
 * harmonic (a fifth up) and 5th (a major third up), which tilts the raw
 * chroma toward the dominant — the classic "detected G for a song in C"
 * error. Credit part of each bin back to the notes it may be an overtone of.
 */
function deOvertone(chroma: Float64Array, subFifth: number, subThird: number): Float64Array {
  const out = new Float64Array(12);
  for (let pc = 0; pc < 12; pc++) {
    out[pc] = chroma[pc] + subFifth * chroma[(pc + 7) % 12] + subThird * chroma[(pc + 4) % 12];
  }
  return out;
}

export function scoreKeyFeatures(
  features: KeyFeatures,
  params: KeyScoreParams = DEFAULT_KEY_SCORE_PARAMS,
): KeyDetectResult {
  const { introBass, outroBass, tuningCents } = features;
  const harm = deOvertone(features.harm, params.subFifth, params.subThird);
  const bass = deOvertone(features.bass, params.subFifth, params.subThird);
  const hasBass = features.bass.reduce((a, b) => a + b, 0) > 0;

  // ---- Score all 24 keys ----
  const scored: KeyCandidate[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      let s = correlate(harm, minor ? PROFILE_MINOR : PROFILE_MAJOR, tonic);
      if (hasBass) {
        s += params.wBass * correlate(bass, minor ? BASS_MINOR : BASS_MAJOR, tonic);
        // 1/12 is "no information", so centre on it.
        s += params.wEdge * (
          params.introShare * (introBass[tonic] - 1 / 12) +
          (1 - params.introShare) * (outroBass[tonic] - 1 / 12)
        );
      }
      if (!minor) s += params.majorLean; // congregational music is overwhelmingly major
      scored.push({ key: minor ? MINOR_NAMES[tonic] : MAJOR_NAMES[tonic], score: s });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // ---- Confidence ----
  // Margin over the runner-up, plus how well the winner fits at all. A
  // near-tie with a *related* key (relative, or a fifth away) is a softer
  // doubt than a near-tie with something unrelated, so both margins count.
  const best = scored[0];
  const runnerUp = scored[1];
  const bestUnrelated = scored.find(c => c !== best && !isRelated(best.key, c.key)) ?? runnerUp;
  const marginAny = best.score - runnerUp.score;
  const marginUnrelated = best.score - bestUnrelated.score;
  const fit = Math.max(0, Math.min(1, best.score / 1.0));
  const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
  const confidence = clamp01(
    0.45 * clamp01(marginAny / 0.25) +
    0.35 * clamp01(marginUnrelated / 0.5) +
    0.20 * fit,
  );

  return {
    key: best.key,
    confidence,
    candidates: scored.slice(0, 4),
    tuningCents,
    chroma: {
      harm: Array.from(features.harm),
      bass: Array.from(features.bass),
      introBass: Array.from(introBass),
      outroBass: Array.from(outroBass),
    },
  };
}

function parseKey(key: KeyName): { pc: number; minor: boolean } {
  const mi = MINOR_NAMES.indexOf(key);
  if (mi >= 0) return { pc: mi, minor: true };
  return { pc: MAJOR_NAMES.indexOf(key), minor: false };
}

/**
 * How two keys relate, in the terms a musician would use. Used to describe
 * a disagreement between a detected key and an existing tag.
 */
export type KeyRelation = 'same' | 'relative' | 'fifth' | 'parallel' | 'unrelated';

export function keyRelation(a: KeyName, b: KeyName): KeyRelation {
  if (a === b) return 'same';
  const ka = parseKey(a), kb = parseKey(b);
  const diff = (kb.pc - ka.pc + 12) % 12;
  if (ka.minor === kb.minor) return diff === 7 || diff === 5 ? 'fifth' : 'unrelated';
  if (diff === 0) return 'parallel';
  // Relative pair: the minor tonic sits 9 semitones above the major tonic.
  const majorToMinor = ka.minor ? (ka.pc - kb.pc + 12) % 12 : diff;
  return majorToMinor === 9 ? 'relative' : 'unrelated';
}

function isRelated(a: KeyName, b: KeyName): boolean {
  const r = keyRelation(a, b);
  return r === 'relative' || r === 'fifth';
}
