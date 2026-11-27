/**
 * Trim and 0:00 suggestions. Learns where the operator puts 0:00 from the
 * songs they've marked by hand (Library files and Spotify songs), in the
 * background, and offers suggestions in the editors and per playlist.
 * Suggestions are only applied when the operator clicks them, and only for
 * values they haven't set themselves. Never runs during a service.
 */
import { useEffect } from 'react';
import { useAppStore } from '../state/store';
import {
  DEFAULT_LAND_PARAMS, envelopeFromSamples, learnLandParams, predictLand, suggestSilenceTrim,
  type Envelope, type LandExample, type LandParams,
} from '@shared/landLearn';
import { decodeMono, DECODE_RATE } from './keyAnalysis';

// ── Envelopes (cached for the session) ───────────────────────────────
const envCache = new Map<string, Envelope>();

/** A Library file's loudness envelope (decodes the file once per session). */
export async function trackEnvelope(trackId: string, filePath: string): Promise<Envelope> {
  const key = `track:${trackId}:${filePath}`;
  const hit = envCache.get(key);
  if (hit) return hit;
  const env = envelopeFromSamples(await decodeMono(filePath), DECODE_RATE);
  envCache.set(key, env);
  return env;
}

/** A Library file's envelope straight from an already-decoded buffer (the editor has one). */
export function bufferEnvelope(buf: AudioBuffer): Envelope {
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) { const v = Math.abs(d[i]); if (v > mono[i]) mono[i] = v; }
  }
  return envelopeFromSamples(mono, buf.sampleRate);
}

/** A Spotify song's envelope from its scanned waveform, or null when it has none. */
export async function spotifyEnvelope(uri: string): Promise<Envelope | null> {
  const w = await window.runway.spotify.waveform(uri).catch(() => null);
  return w ? { binSec: w.binSec, peaks: w.peaks } : null;
}

// ── Suggestions ──────────────────────────────────────────────────────
export function landParams(): LandParams {
  const l = useAppStore.getState().config.landLearning;
  return l?.adopted ? l.params : DEFAULT_LAND_PARAMS;
}

export interface EditSuggestion {
  startSec?: number;
  endSec?: number;
  landSec?: number;
}

/**
 * Suggestions for the values the operator hasn't set: silence trims for
 * Start / End, and a 0:00. `current` is what's set now (undefined = not set).
 */
export function suggestEdits(env: Envelope, durationSec: number, current: { startSec?: number; endSec?: number; landSec?: number }): EditSuggestion {
  const out: EditSuggestion = {};
  const sil = suggestSilenceTrim(env);
  if (current.startSec === undefined && sil.startSec !== undefined) out.startSec = Math.round(sil.startSec * 10) / 10;
  if (current.endSec === undefined && sil.endSec !== undefined && sil.endSec < durationSec - 0.2) out.endSec = Math.round(sil.endSec * 10) / 10;
  if (current.landSec === undefined) {
    const end = current.endSec ?? out.endSec ?? durationSec;
    const t = predictLand(env, end, landParams());
    const start = current.startSec ?? out.startSec ?? 0;
    // Only when it means something: inside the song and not right at its end.
    if (t !== null && t > start + 5 && t < end - 0.3) out.landSec = t;
  }
  return out;
}

type Applied = { startSec?: number; endSec?: number; landSec?: number };
const same = (a: number | undefined, b: number | undefined) => a !== undefined && b !== undefined && Math.abs(a - b) < 0.05;

/** The suggested values still in place (not changed by hand since), or null. */
export function stillApplied(applied: Applied | undefined, cur: { startSec?: number; endSec?: number; landSec?: number }): Applied | null {
  if (!applied) return null;
  const out: Applied = {};
  if (same(applied.startSec, cur.startSec)) out.startSec = applied.startSec;
  if (same(applied.endSec, cur.endSec)) out.endSec = applied.endSec;
  if (same(applied.landSec, cur.landSec)) out.landSec = applied.landSec;
  return Object.keys(out).length ? out : null;
}

/** Merge newly accepted suggestion values into what a song already got. */
export function addApplied(prev: Applied | undefined, s: Applied): Applied {
  return { ...(prev ?? {}), ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) };
}

/** Remove a Library song's suggested trims / 0:00 that are still as suggested. */
export function removeTrackSuggestions(trackId: string): boolean {
  const st = useAppStore.getState();
  const t = st.config.tracks.find(x => x.id === trackId);
  if (!t) return false;
  const live = stillApplied(t.suggestApplied, { startSec: t.trimStartSec, endSec: t.trimEndSec, landSec: t.editServiceLandSec });
  st.updateTrack(trackId, {
    ...(live?.startSec !== undefined ? { trimStartSec: undefined } : {}),
    ...(live?.endSec !== undefined ? { trimEndSec: undefined } : {}),
    ...(live?.landSec !== undefined ? { editServiceLandSec: undefined, editServiceLandAuto: undefined } : {}),
    suggestApplied: undefined,
  });
  return !!live;
}

/** How sure the 0:00 suggestion is, for the operator. */
export function landAccuracyNote(): string {
  const l = useAppStore.getState().config.landLearning;
  if (!l || l.examples < 5) return `Standard settings (learns from your songs once 5 or more have a 0:00 you placed${l ? `; ${l.examples} so far` : ''}).`;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return l.adopted
    ? `Learned from ${l.examples} of your songs: within 1 s of where you put it on ${pct(l.within1s)} of songs it didn't learn from (standard settings: ${pct(l.within1sDefault)}).`
    : `Checked against ${l.examples} of your songs: the standard settings do as well (${pct(l.within1sDefault)} within 1 s).`;
}

// ── Learning ─────────────────────────────────────────────────────────
async function collectExamples(): Promise<LandExample[]> {
  const cfg = useAppStore.getState().config;
  const out: LandExample[] = [];
  for (const t of cfg.tracks) {
    if (t.editServiceLandSec === undefined || t.editServiceLandAuto || !t.filePath) continue;
    const r = useAppStore.getState().currentRunway;
    if (r && (r.phase === 'music' || r.phase === 'pad')) return out;   // a service started: stop
    try {
      const env = await trackEnvelope(t.id, t.filePath);
      out.push({ env, endSec: t.trimEndSec ?? t.durationSec, landSec: t.editServiceLandSec });
    } catch { /* missing file: skip */ }
  }
  const edits = cfg.spotify?.trackEdits ?? {};
  for (const [uri, e] of Object.entries(edits)) {
    if (e.landSec === undefined || e.landAuto) continue;
    const env = await spotifyEnvelope(uri);
    if (!env) continue;
    const durSec = env.peaks.length * env.binSec;
    out.push({ env, endSec: e.trimEndSec ?? durSec, landSec: e.landSec });
  }
  return out;
}

function signatureOf(): string {
  const cfg = useAppStore.getState().config;
  const parts: string[] = [];
  for (const t of cfg.tracks) if (t.editServiceLandSec !== undefined && !t.editServiceLandAuto) parts.push(`${t.id}:${t.editServiceLandSec}:${t.trimEndSec ?? ''}`);
  for (const [u, e] of Object.entries(cfg.spotify?.trackEdits ?? {})) if (e.landSec !== undefined && !e.landAuto) parts.push(`${u}:${e.landSec}:${e.trimEndSec ?? ''}`);
  parts.sort();
  let h = 0;
  for (const s of parts) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${parts.length}:${h}`;
}

let running = false;
async function learnNow(force = false): Promise<void> {
  if (running) return;
  const r = useAppStore.getState().currentRunway;
  if (r && (r.phase === 'music' || r.phase === 'pad')) return;
  const sig = signatureOf();
  const prev = useAppStore.getState().config.landLearning;
  if (!force && prev?.signature === sig) return;
  running = true;
  try {
    const examples = await collectExamples();
    // Learning is quick (a few hundred tries over the songs' endings), but
    // yield first so it never lands in the middle of a UI interaction.
    await new Promise(res => setTimeout(res, 50));
    const res = learnLandParams(examples);
    const adopted = res.examples >= 5 && res.within1s > res.within1sDefault + 0.05;
    console.log('[landlearn] learned', {
      examples: res.examples, within1s: res.within1s, within1sStandard: res.within1sDefault,
      medianMissSec: res.medianMissSec, adopted, params: res.params,
    });
    useAppStore.getState().updateConfig({ landLearning: {
      params: res.params, adopted, examples: res.examples, within1s: res.within1s,
      within1sDefault: res.within1sDefault, medianMissSec: res.medianMissSec, at: Date.now(), signature: sig,
    } });
  } finally {
    running = false;
  }
}

/** "Learn now". */
export function relearnLand(): Promise<void> { return learnNow(true); }

/** Mount once: learns a minute after startup and 30 s after 0:00 marks change. */
export function useAutoLandLearning(): void {
  useEffect(() => {
    let timer: number | null = null;
    const soon = (ms: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void learnNow(); }, ms);
    };
    soon(60_000);
    let lastTracks = useAppStore.getState().config.tracks;
    let lastEdits = useAppStore.getState().config.spotify?.trackEdits;
    const unsub = useAppStore.subscribe(s => {
      const tr = s.config.tracks, ed = s.config.spotify?.trackEdits;
      if (tr !== lastTracks || ed !== lastEdits) { lastTracks = tr; lastEdits = ed; soon(30_000); }
    });
    return () => { unsub(); if (timer !== null) window.clearTimeout(timer); };
  }, []);
}
