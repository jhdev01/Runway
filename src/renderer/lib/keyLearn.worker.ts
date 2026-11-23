// Runs key-settings learning off the UI thread (it re-scores every tagged
// song many times over).
import { learnKeyParams, type KeyExample, type KeyLearnResult } from '@shared/keyLearn';

self.onmessage = (e: MessageEvent<{ examples: KeyExample[] }>) => {
  let result: KeyLearnResult | null = null;
  try { result = learnKeyParams(e.data.examples); } catch { result = null; }
  (self as unknown as Worker).postMessage(result);
};
