/**
 * App-wide Spotify alert (signed out, app logged out / on another account,
 * app closed before a Spotify service, playback not actually moving). Set
 * by the top-bar Spotify light (status) and the playback watchdog
 * (playback), shown as a banner under the top bar on every screen, and as
 * a system notification the first time each problem appears.
 */
import { useEffect, useState } from 'react';

export interface SpotifyAlert {
  /** Stable id of the problem, so the same one isn't re-notified. */
  kind: 'signed-out' | 'app-account' | 'app-closed' | 'not-playing';
  text: string;
  action?: 'settings' | 'open-spotify';
}

type Source = 'status' | 'playback';
const slots: Record<Source, SpotifyAlert | null> = { status: null, playback: null };
let dismissed: string | null = null;    // kind the operator closed; returns when the problem changes
const listeners = new Set<(a: SpotifyAlert | null) => void>();
const notified = new Set<string>();

// A playback problem (happening now) outranks a status one.
const current = () => slots.playback ?? slots.status;
const visible = () => { const c = current(); return c && c.kind !== dismissed ? c : null; };

export function setSpotifyAlert(a: SpotifyAlert | null, source: Source = 'status'): void {
  const before = current()?.kind;
  slots[source] = a;
  const now = current();
  if (!now) { notified.clear(); dismissed = null; }
  else if (now.kind !== before && !notified.has(now.kind)) {
    notified.add(now.kind);
    console.log('[spotify] alert', { kind: now.kind, text: now.text });
    try {
      // Reaches the operator even when Runway isn't the front app.
      if ('Notification' in window) new Notification('Runway: Spotify', { body: now.text, silent: false });
    } catch { /* notifications blocked: the banner still shows */ }
  }
  for (const fn of listeners) fn(visible());
}

export function dismissSpotifyAlert(): void {
  const c = current();
  if (c) dismissed = c.kind;
  for (const fn of listeners) fn(visible());
}

export function useSpotifyAlert(): SpotifyAlert | null {
  const [a, setA] = useState<SpotifyAlert | null>(visible());
  useEffect(() => {
    listeners.add(setA);
    return () => { listeners.delete(setA); };
  }, []);
  return a;
}
