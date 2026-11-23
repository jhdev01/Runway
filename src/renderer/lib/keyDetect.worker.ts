// Runs key detection off the UI thread so analysing a long song never
// stalls the renderer (the controller tick and meters live there).
import { detectKey, extractKeyFeatures, scoreKeyFeatures, type KeyDetectResult, type KeyScoreParams } from '@shared/keyDetect';
import { noteMapOf } from '@shared/keyLearn';

export interface KeyWorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  /** Learned scoring settings (Settings › key learning); standard when absent. */
  params?: KeyScoreParams;
  /** Also return the per-second note map (editor display). */
  noteMap?: boolean;
}
export interface KeyWorkerResponse {
  id: number;
  result: KeyDetectResult | null;
  noteMap?: Array<number[] | null>;
  error?: string;
}

self.onmessage = (e: MessageEvent<KeyWorkerRequest>) => {
  const { id, samples, sampleRate, params, noteMap } = e.data;
  let response: KeyWorkerResponse;
  try {
    if (noteMap) {
      const f = extractKeyFeatures(samples, sampleRate);
      response = f
        ? { id, result: scoreKeyFeatures(f, params), noteMap: noteMapOf(f, samples.length / sampleRate) }
        : { id, result: null };
    } else {
      response = { id, result: detectKey(samples, sampleRate, params) };
    }
  } catch (err) {
    response = { id, result: null, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(response);
};
