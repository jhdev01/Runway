// Key detection for a library track: read the file, decode it at a low
// sample rate, and hand the samples to the detector in a Web Worker.
//
// Deliberately separate from audioEngine — it uses its own throwaway
// OfflineAudioContext and never touches the playback context, the buffer
// cache, or anything on the runway timeline.

import { detectKey, type KeyDetectResult } from '@shared/keyDetect';
import { filePathToUrl } from './audioEngine';
import { learnedKeyParams } from './keyLearning';
import type { KeyWorkerRequest, KeyWorkerResponse } from './keyDetect.worker';
// Vite's `?worker` import picks the right worker flavour for dev (module)
// and for the packaged app (classic script, which loads fine from file://).
import KeyDetectWorker from './keyDetect.worker?worker';

// The detector ignores everything above 2 kHz, so 11.025 kHz mono is all it
// needs — a quarter of the samples of a 44.1 k decode, and a 4-minute song
// is ~10 MB instead of ~85 MB.
const ANALYSIS_RATE = 11025;

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, {
  resolve: (r: KeyDetectResult | null) => void;
  reject: (e: Error) => void;
}>();

function failAllPending(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new KeyDetectWorker();
    worker.onmessage = (e: MessageEvent<KeyWorkerResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
    worker.onerror = () => {
      // Worker failed to load or crashed — fall back to in-thread analysis
      // for the rest of the session rather than leaving the batch hanging.
      workerBroken = true;
      worker = null;
      failAllPending('Key analysis worker failed');
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

async function decodeMono(filePath: string): Promise<Float32Array> {
  const res = await fetch(filePathToUrl(filePath));
  if (!res.ok) throw new Error(`File not found (HTTP ${res.status})`);
  const bytes = await res.arrayBuffer();
  // decodeAudioData resamples to the context's rate for us.
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  const buffer = await ctx.decodeAudioData(bytes);
  const n = buffer.length;
  const mono = new Float32Array(n);
  const chans = buffer.numberOfChannels;
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += data[i] / chans;
  }
  return mono;
}

/**
 * Analyse one audio file and return its detected key, or null when the
 * audio has no usable tonal content. Throws if the file can't be read or
 * decoded.
 */
export async function analyzeTrackKey(filePath: string): Promise<KeyDetectResult | null> {
  const samples = await decodeMono(filePath);
  const w = getWorker();
  if (w) {
    try {
      return await new Promise<KeyDetectResult | null>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const msg: KeyWorkerRequest = { id, samples, sampleRate: ANALYSIS_RATE, params: learnedKeyParams() };
        // Copy rather than transfer so the in-thread fallback below still
        // has the samples if the worker dies mid-job.
        w.postMessage(msg);
      });
    } catch (err) {
      if (!workerBroken) throw err;
      // fall through to in-thread
    }
  }
  return detectKey(samples, ANALYSIS_RATE, learnedKeyParams());
}

/**
 * For the Editor: the file's detected key plus its note map (per second,
 * 12 note strengths). Runs in its own worker so it never queues behind a
 * Library "Detect keys" batch. Cached per file for the session.
 */
const noteCache = new Map<string, { result: KeyDetectResult | null; noteMap: Array<number[] | null> | null }>();
export async function analyzeTrackNotes(filePath: string): Promise<{ result: KeyDetectResult | null; noteMap: Array<number[] | null> | null }> {
  const hit = noteCache.get(filePath);
  if (hit) return hit;
  const samples = await decodeMono(filePath);
  const out = await new Promise<{ result: KeyDetectResult | null; noteMap: Array<number[] | null> | null }>((resolve) => {
    let w: Worker;
    try { w = new KeyDetectWorker(); } catch { resolve({ result: detectKey(samples, ANALYSIS_RATE, learnedKeyParams()), noteMap: null }); return; }
    w.onmessage = (e: MessageEvent<KeyWorkerResponse>) => { w.terminate(); resolve({ result: e.data.result, noteMap: e.data.noteMap ?? null }); };
    w.onerror = () => { w.terminate(); resolve({ result: null, noteMap: null }); };
    const msg: KeyWorkerRequest = { id: 0, samples, sampleRate: ANALYSIS_RATE, params: learnedKeyParams(), noteMap: true };
    w.postMessage(msg);
  });
  noteCache.set(filePath, out);
  return out;
}
