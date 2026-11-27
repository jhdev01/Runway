/**
 * App-wide Spotify alert (signed out, app logged out / on another account,
 * app closed before a Spotify service). Set by the top-bar Spotify light,
 * shown as a banner under the top bar on every screen, and as a system
 * notification the first time each problem appears.
 */
import { useEffect, useState } from 'react';

export interface SpotifyAlert {
  /** Stable id of the problem, so the same one isn't re-notified. */
  kind: 'signed-out' | 'app-account' | 'app-closed';
  text: string;
  action?: 'settings' | 'open-spotify';
}

let current: SpotifyAlert | null = null;
let dismissed: string | null = null;    // kind the operator closed; returns when the problem changes
const listeners = new Set<(a: SpotifyAlert | null) => void>();
const notified = new Set<string>();

export function setSpotifyAlert(a: SpotifyAlert | null): void {
  const was = current?.kind;
  current = a;
  if (!a) { notified.clear(); dismissed = null; }
  else if (a.kind !== was && !notified.has(a.kind)) {
    notified.add(a.kind);
    console.log('[spotify] alert', { kind: a.kind, text: a.text });
    try {
      // Reaches the operator even when Runway isn't the front app.
      if ('Notification' in window) new Notification('Runway: Spotify', { body: a.text, silent: false });
    } catch { /* notifications blocked: the banner still shows */ }
  }
  for (const fn of listeners) fn(visible());
}

const visible = () => (current && current.kind !== dismissed ? current : null);

export function dismissSpotifyAlert(): void {
  if (current) dismissed = current.kind;
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
