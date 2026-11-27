/**
 * Tempo, beats and the last ringing note, from mono audio (any rate; ~11 kHz
 * is plenty). Pure functions, no I/O.
 *
 *  - Onsets: spectral flux (how much new energy appears, band by band) per
 *    ~23 ms frame.
 *  - Tempo: autocorrelation of the onset curve over 60–180 BPM, with a mild
 *    preference for 70–140 (where worship songs live) to settle half /
 *    double-time doubts.
 *  - Beats: the grid at that tempo whose phase lines up best with the
 *    onsets, each beat nudged to the nearest onset peak.
 *  - End note: after the last strong onset, which pitch classes ring
 *    longest (a chroma average of the tail), named as a note and, when a
 *    triad stands out, a chord.
 */
import type { KeyName } from './types';

export interface BeatInfo {
  bpm: number;
  /** 0…1: how clearly the tempo stands out. */
  confidence: number;
  /** Beat times in seconds (song time). Only the stretch that was analysed. */
  beats: number[];
  /** Strong onsets (note / hit starts), seconds, with strength 0…1. */
  onsets: { t: number; s: number }[];
  /** What rings out at the very end, when something tonal does. */
  endNote?: { note: string; chord?: KeyName; sec: number };
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
// Chord names as Runway stores keys (flats for the black-key majors).
const MAJOR_NAME: Record<number, KeyName> = { 0: 'C', 1: 'Db', 2: 'D', 3: 'Eb', 4: 'E', 5: 'F', 6: 'F#', 7: 'G', 8: 'Ab', 9: 'A', 10: 'Bb', 11: 'B' };
const MINOR_NAME: Record<number, KeyName> = { 0: 'Cm', 1: 'C#m', 2: 'Dm', 3: 'D#m', 4: 'Em', 5: 'Fm', 6: 'F#m', 7: 'Gm', 8: 'G#m', 9: 'Am', 10: 'Bbm', 11: 'Bm' };

const N = 1024;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const hann = (() => { const w = new Float64Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); return w; })();

/** Magnitude spectra, one per hop. */
function spectra(samples: Float32Array, hop: number): Float64Array[] {
  const out: Float64Array[] = [];
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let off = 0; off + N <= samples.length; off += hop) {
    for (let i = 0; i < N; i++) { re[i] = samples[off + i] * hann[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    out.push(mag);
  }
  return out;
}

/** Analyse `samples` (mono) that start at `offsetSec` in the song. */
export function analyzeBeats(samples: Float32Array, rate: number, offsetSec = 0): BeatInfo | null {
  const hop = Math.max(64, Math.round(rate * 0.0232));
  const hopSec = hop / rate;
  if (samples.length < rate * 6) return null;
  const spec = spectra(samples, hop);
  if (spec.length < 50) return null;

  // Onset strength: positive change in log magnitude, summed over bins.
  const onset = new Float64Array(spec.length);
  for (let f = 1; f < spec.length; f++) {
    let s = 0;
    const a = spec[f], b = spec[f - 1];
    for (let k = 2; k < N / 2; k++) {
      const d = Math.log1p(100 * a[k]) - Math.log1p(100 * b[k]);
      if (d > 0) s += d;
    }
    onset[f] = s;
  }
  // Remove the slow trend (local mean) so loud sections don't dominate.
  const w = Math.round(1 / hopSec);
  const flux = new Float64Array(onset.length);
  let acc = 0;
  for (let i = 0; i < onset.length; i++) {
    acc += onset[i];
    if (i >= w) acc -= onset[i - w];
    const mean = acc / Math.min(i + 1, w);
    flux[i] = Math.max(0, onset[i] - mean);
  }
  const maxFlux = flux.reduce((m, v) => Math.max(m, v), 0) || 1;

  // Tempo by autocorrelation, 60–180 BPM, gently preferring 70–140.
  let best = { bpm: 0, score: -1 };
  const scores: number[] = [];
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const lag = 60 / bpm / hopSec;
    const l0 = Math.floor(lag), fr = lag - l0;
    let s = 0;
    for (let i = 0; i + l0 + 1 < flux.length; i++) s += flux[i] * (flux[i + l0] * (1 - fr) + flux[i + l0 + 1] * fr);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 100) / 0.6, 2));
    const sc = s * prior;
    scores.push(sc);
    if (sc > best.score) best = { bpm, score: sc };
  }
  if (best.score <= 0) return null;
  const sorted = scores.slice().sort((a, b) => b - a);
  const confidence = Math.max(0, Math.min(1, 1 - (sorted[Math.min(10, sorted.length - 1)] / best.score)));

  // Beat grid: the phase that lines up best with the onsets, then each beat
  // nudged to the nearest onset peak (±70 ms).
  const period = 60 / best.bpm / hopSec;
  let bestPhase = 0, bestSum = -1;
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < flux.length; t += period) s += flux[Math.round(t)] ?? 0;
    if (s > bestSum) { bestSum = s; bestPhase = ph; }
  }
  const nudge = Math.round(0.07 / hopSec);
  // Flux rises when the window first takes in an attack, about 3/4 of a
  // window before the window's start time catches up: shift to match.
  const lead = (0.75 * N) / rate;
  const beats: number[] = [];
  for (let t = bestPhase; t < flux.length; t += period) {
    const c = Math.round(t);
    let bi = c;
    for (let i = Math.max(0, c - nudge); i <= Math.min(flux.length - 1, c + nudge); i++) if (flux[i] > flux[bi]) bi = i;
    beats.push(Math.round((offsetSec + bi * hopSec + lead) * 100) / 100);
  }

  // Strong onsets: local peaks above 30 % of the loudest.
  const onsets: { t: number; s: number }[] = [];
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i] > 0.3 * maxFlux && flux[i] >= flux[i - 1] && flux[i] > flux[i + 1]) {
      onsets.push({ t: Math.round((offsetSec + i * hopSec + lead) * 100) / 100, s: Math.round((flux[i] / maxFlux) * 100) / 100 });
    }
  }

  const lastOnset = onsets.length ? onsets[onsets.length - 1].t : Infinity;
  const beatSec = 60 / best.bpm;
  return {
    bpm: Math.round(best.bpm),
    confidence: Math.round(confidence * 100) / 100,
    beats: beats.filter(b => b <= lastOnset + beatSec * 0.5),
    onsets,
    endNote: endNoteOf(samples, rate, spec, hopSec, flux, maxFlux, offsetSec, lead),
  };
}

/** After the last strong onset: which notes ring out (fine-resolution chroma of the tail). */
function endNoteOf(samples: Float32Array, rate: number, spec: Float64Array[], hopSec: number, flux: Float64Array, maxFlux: number, offsetSec: number, lead: number): BeatInfo['endNote'] {
  const energy = spec.map(m => { let s = 0; for (let k = 2; k < m.length; k++) s += m[k] * m[k]; return s; });
  const peakE = energy.reduce((a, b) => Math.max(a, b), 0);
  if (peakE <= 0) return undefined;
  let lastSound = energy.length - 1;
  while (lastSound > 0 && energy[lastSound] < peakE * 1e-4) lastSound--;
  let lastHit = -1;
  for (let i = lastSound; i >= 0; i--) if (flux[i] > 0.3 * maxFlux) { lastHit = i; break; }
  if (lastHit < 0 || lastSound - lastHit < Math.round(0.8 / hopSec)) return undefined;   // nothing rings long enough
  const hop = Math.round(hopSec * rate);
  // Ringing tail in samples (skip the attack itself).
  const a = Math.round(lastHit * hop + lead * rate + 0.15 * rate);
  const b = Math.min(samples.length, Math.round(lastSound * hop + N));
  const NF = 8192;   // ~1.3 Hz bins at 11 kHz: low notes land in the right pitch class
  if (b - a < NF / 2) return undefined;
  const win = new Float64Array(NF);
  for (let i = 0; i < NF; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (NF - 1));
  const chroma = new Float64Array(12);
  const re = new Float64Array(NF), im = new Float64Array(NF);
  for (let off = a; off < b; off += NF / 4) {
    for (let i = 0; i < NF; i++) { const v = off + i < b ? samples[off + i] : 0; re[i] = v * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 3; k < NF / 2; k++) {
      const hz = (k * rate) / NF;
      if (hz < 55 || hz > 2000) continue;
      const pc = ((Math.round(12 * Math.log2(hz / 261.6256)) % 12) + 12) % 12;
      chroma[pc] += re[k] * re[k] + im[k] * im[k];
    }
  }
  const total = chroma.reduce((x, y) => x + y, 0);
  if (total <= 0) return undefined;
  // Root: the note whose triad (root + fifth, plus the stronger third) rings most,
  // so a chord isn't named after its loudest upper note.
  let root = 0, rootScore = -1;
  for (let r = 0; r < 12; r++) {
    const sc = chroma[r] + 0.6 * chroma[(r + 7) % 12] + 0.4 * Math.max(chroma[(r + 4) % 12], chroma[(r + 3) % 12]);
    if (sc > rootScore) { rootScore = sc; root = r; }
  }
  if (chroma[root] / total < 0.12) return undefined;      // no clear note
  const maj = chroma[(root + 4) % 12], min = chroma[(root + 3) % 12], fifth = chroma[(root + 7) % 12];
  const chordish = fifth > chroma[root] * 0.2 && Math.max(maj, min) > chroma[root] * 0.1;
  const chord = chordish ? (maj >= min ? MAJOR_NAME[root] : MINOR_NAME[root]) : undefined;
  return { note: NOTES[root], chord, sec: Math.round((offsetSec + lastHit * hopSec + lead) * 100) / 100 };
}

/** Nearest time in `times` to `t` within `maxSec`, or null. */
export function nearestWithin(times: number[], t: number, maxSec: number): number | null {
  let best: number | null = null;
  for (const x of times) if (Math.abs(x - t) <= maxSec && (best === null || Math.abs(x - t) < Math.abs(best - t))) best = x;
  return best;
}
