import type { SpotifyTrackEdit } from '@shared/types';
import { useAppStore } from '../state/store';
import { logSpotifyOperator } from './spotifyWaveformScan';

/**
 * Saves one Spotify song's edits (trims, fades, 0:00, key). Shared by the
 * Library song list and the Editor page so both behave the same: logged to
 * timing.log, a key changed by hand becomes the operator's own (key
 * learning may learn from it), empty edits are removed.
 */
export function saveSpotifyEdit(uri: string, e: SpotifyTrackEdit, title?: string): void {
  const st = useAppStore.getState();
  const before = st.config.spotify?.trackEdits?.[uri] ?? {};
  logSpotifyOperator('spotify song edited', { title, from: before, to: e });
  if (e.key !== before.key) e = { ...e, keyAuto: undefined };
  // 0:00 moved by hand (it was already set and changed): the operator's own mark.
  if (before.landSec !== undefined && e.landSec !== before.landSec) e = { ...e, landAuto: undefined };
  if (e.landSec === undefined) e = { ...e, landAuto: undefined };
  const clean = Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined)) as SpotifyTrackEdit;
  const latest = useAppStore.getState().config.spotify;
  const next = { ...(latest?.trackEdits ?? {}) };
  if (Object.keys(clean).length) next[uri] = clean; else delete next[uri];
  useAppStore.getState().updateConfig({ spotify: { ...latest, trackEdits: next } });
}
