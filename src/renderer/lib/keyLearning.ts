/**
 * Automatic key learning: whenever the operator's own key tags (or the
 * songs Runway has heard) change, Runway quietly re-learns its key
 * detector's settings from them in the background, and uses the learned
 * settings only when they clearly beat the standard ones on songs held out
 * of the learning. Learned from:
 *   - Library songs with a key the operator set (not ones the detector
 *     filled in) that have been through Detect keys
 *   - Spotify songs with a key the operator set (not ones Find keys set on
 *     its own) that Runway has heard
 * Never runs while a service is playing. Only changes which key the
 * detector suggests; nothing about playback or timing.
 */

import { useEffect } from 'react';
import { useAppStore } from '../state/store';
import { DEFAULT_KEY_SCORE_PARAMS, type KeyScoreParams } from '@shared/keyDetect';
import { rescoreProfile, MIN_EXAMPLES, type KeyExample, type KeyLearnResult } from '@shared/keyLearn';
import type { SpotifyKeyGuess } from '@shared/types';
import KeyLearnWorker from './keyLearn.worker?worker';

/** The learned settings when they're in use, else undefined (standard). */
export function learnedKeyParams(): KeyScoreParams | undefined {
  const l = useAppStore.getState().config.keyLearning;
  return l?.adopted ? l.params : undefined;
}

/** A heard Spotify key, re-scored with the learned settings when they're in use. */
export function effectiveGuess(g: SpotifyKeyGuess | undefined): SpotifyKeyGuess | undefined {
  const p = learnedKeyParams();
  if (!g || !p || !g.profile) return g;
  const r = rescoreProfile(g.profile, p);
  return { ...g, key: r.key, confidence: Math.round(r.confidence * 100) / 100, candidates: r.candidates.slice(0, 3).map(c => c.key) };
}

async function collectExamples(): Promise<KeyExample[]> {
  const cfg = useAppStore.getState().config;
  const ex: KeyExample[] = [];
  for (const t of cfg.tracks) {
    if (t.key && t.keySource !== 'detected' && t.keyProfile) ex.push({ profile: t.keyProfile, key: t.key });
  }
  const edits = cfg.spotify?.trackEdits ?? {};
  const tagged = Object.entries(edits).filter(([, e]) => e.key && !e.keyAuto);
  if (tagged.length && window.runway?.spotify?.waveformKeys) {
    const heard = await window.runway.spotify.waveformKeys(tagged.map(([u]) => u)).catch(() => ({} as Record<string, SpotifyKeyGuess>));
    for (const [uri, e] of tagged) {
      const p = heard[uri]?.profile;
      if (p) ex.push({ profile: p, key: e.key! });
    }
  }
  return ex;
}

function signatureOf(ex: KeyExample[]): string {
  // Order-independent: count + a cheap hash of key + a profile value per song.
  let h = 0;
  const parts = ex.map(e => `${e.key}:${e.profile.harm.slice(0, 3).join(',')}`).sort();
  for (const s of parts) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${ex.length}:${h}`;
}

let running = false;
async function learnNow(force = false): Promise<void> {
  if (running) return;
  const r = useAppStore.getState().currentRunway;
  if (r && (r.phase === 'music' || r.phase === 'pad')) return;  // never during a service
  running = true;
  try {
    const examples = await collectExamples();
    const sig = signatureOf(examples);
    const prev = useAppStore.getState().config.keyLearning;
    if (!force && prev?.signature === sig) return;
    if (examples.length < MIN_EXAMPLES) {
      if (prev?.signature !== sig) {
        useAppStore.getState().updateConfig({ keyLearning: {
          params: DEFAULT_KEY_SCORE_PARAMS, adopted: false, examples: examples.length, before: 0, after: 0, at: Date.now(), signature: sig,
        } });
      }
      return;
    }
    const result = await new Promise<KeyLearnResult | null>(resolve => {
      let w: Worker;
      try { w = new KeyLearnWorker(); } catch { resolve(null); return; }
      const t = window.setTimeout(() => { w.terminate(); resolve(null); }, 60_000);
      w.onmessage = (e: MessageEvent<KeyLearnResult | null>) => { window.clearTimeout(t); w.terminate(); resolve(e.data); };
      w.onerror = () => { window.clearTimeout(t); w.terminate(); resolve(null); };
      w.postMessage({ examples });
    });
    if (!result) return;
    console.log('[keylearn] learned', {
      examples: result.examples, standardRight: result.before, learnedRight: result.after, adopted: result.adopt, params: result.params,
    });
    useAppStore.getState().updateConfig({ keyLearning: {
      params: result.params, adopted: result.adopt, examples: result.examples,
      before: result.before, after: result.after, at: Date.now(), signature: sig,
    } });
    // Library songs: refresh the detector's suggestion with the settings
    // now in use. The operator's own `key` is never changed here.
    const params = result.adopt ? result.params : DEFAULT_KEY_SCORE_PARAMS;
    const st = useAppStore.getState();
    for (const t of st.config.tracks) {
      if (!t.keyProfile) continue;
      const res = rescoreProfile(t.keyProfile, params);
      const alts = res.candidates.slice(1, 3).map(c => c.key);
      if (res.key !== t.detectedKey || JSON.stringify(alts) !== JSON.stringify(t.detectedKeyAlts)) {
        st.updateTrack(t.id, { detectedKey: res.key, keyConfidence: res.confidence, detectedKeyAlts: alts });
      }
    }
  } finally {
    running = false;
  }
}

/** "Learn now" in Settings. */
export function relearnKeys(): Promise<void> { return learnNow(true); }

/**
 * Mount once (always on screen): re-learns 30 s after key tags change, a
 * little after startup, and every 30 minutes (to pick up songs Runway has
 * heard since).
 */
export function useAutoKeyLearning(): void {
  useEffect(() => {
    let timer: number | null = null;
    const soon = (ms: number) => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = null; void learnNow(); }, ms);
    };
    soon(20_000);
    const every = window.setInterval(() => void learnNow(), 30 * 60_000);
    let lastTracks = useAppStore.getState().config.tracks;
    let lastEdits = useAppStore.getState().config.spotify?.trackEdits;
    const unsub = useAppStore.subscribe(s => {
      const tr = s.config.tracks, ed = s.config.spotify?.trackEdits;
      if (tr !== lastTracks || ed !== lastEdits) { lastTracks = tr; lastEdits = ed; soon(30_000); }
    });
    return () => { unsub(); window.clearInterval(every); if (timer !== null) window.clearTimeout(timer); };
  }, []);
}
