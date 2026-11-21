// Runs key detection off the UI thread so analysing a long song never
// stalls the renderer (the controller tick and meters live there).
import { detectKey, type KeyDetectResult } from '@shared/keyDetect';

export interface KeyWorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
}
export interface KeyWorkerResponse {
  id: number;
  result: KeyDetectResult | null;
  error?: string;
}

self.onmessage = (e: MessageEvent<KeyWorkerRequest>) => {
  const { id, samples, sampleRate } = e.data;
  let response: KeyWorkerResponse;
  try {
    response = { id, result: detectKey(samples, sampleRate) };
  } catch (err) {
    response = { id, result: null, error: err instanceof Error ? err.message : String(err) };
  }
  (self as unknown as Worker).postMessage(response);
};
