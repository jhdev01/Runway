import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { useWaveformScan } from '../lib/spotifyWaveformScan';
import { setSpotifyAlert } from '../lib/spotifyAlert';
import { startSpotifyWatchdog } from '../lib/spotifyWatchdog';
import type { SpotifyHealth } from '@shared/types';

type SpotifyLight = { state: 'on' | 'err' | 'unknown'; detail: string };

const POLL_MS = 5000;
const HEALTH_MS = 60_000;

/** A service using a Spotify playlist starts within the next hour (or started in the last 90 min). */
function spotifyServiceSoon(): boolean {
  const st = useAppStore.getState();
  const now = Date.now();
  if (st.currentRunway?.spotify && st.currentRunway.phase !== 'done') return true;
  return (st.config.services ?? []).some(s => {
    if (!s.spotifyPlaylistId) return false;
    const t = new Date(`${s.date}T${s.startTime}:00`).getTime();
    return Number.isFinite(t) && t - now < 60 * 60_000 && now - t < 90 * 60_000;
  });
}

/**
 * Top-bar light for Spotify, next to MIDI / Pro7 / Audio. Green when the
 * account is signed in and the Spotify app is open; red when either isn't.
 * Only shown once Spotify has been set up (a Client ID is saved), so
 * churches that don't use Spotify never see it. Clicking opens Settings.
 * Read-only: it never starts, stops or changes anything in Spotify.
 */
export function SpotifyStatusPill() {
  const clientId = useAppStore(s => s.config.spotify?.clientId);
  const [light, setLight] = useState<SpotifyLight>({ state: 'unknown', detail: 'Checking Spotify…' });
  // The top bar is always on screen, so this is where the waveform
  // recorder (Settings › Spotify › Draw waveforms) is switched on and off.
  const waveforms = useAppStore(s => !!s.config.spotify?.waveforms);
  const scan = useWaveformScan();
  useEffect(() => {
    void window.runway?.spotify?.waveformEnable?.(waveforms);
  }, [waveforms]);

  // Playback watchdog: catches "playing" that isn't (e.g. Spotify logged out).
  useEffect(() => (clientId ? startSpotifyWatchdog() : undefined), [clientId]);

  useEffect(() => {
    if (!clientId) { setSpotifyAlert(null); return; }
    let alive = true;
    const isMac = navigator.userAgent.includes('Mac');
    let lastHealthAt = 0;
    let health: SpotifyHealth | null = null;
    let appMisses = 0;   // the app must be missing from the account twice in a row before we say so
    const check = async () => {
      try {
        const account = await window.runway.spotify.status();
        if (!alive) return;
        if (!account?.connected) {
          setLight({ state: 'err', detail: 'Not signed in to Spotify. Click to open Settings.' });
          setSpotifyAlert(spotifyServiceSoon()
            ? { kind: 'signed-out', text: 'Runway isn’t signed in to Spotify, and a Spotify service is coming up.', action: 'settings' }
            : null);
          return;
        }
        const who = account.displayName ? ` as ${account.displayName}` : '';
        const app = isMac ? await window.runway.spotify.player({ op: 'check' }) : { ok: true };
        if (!alive) return;
        // Sign-in check about once a minute (Spotify's sign-in and device list).
        if (Date.now() - lastHealthAt > HEALTH_MS || account.signInLost) {
          lastHealthAt = Date.now();
          health = await window.runway.spotify.health(isMac && !!app?.ok).catch(() => null);
          if (!alive) return;
          appMisses = health?.appOnAccount === false ? appMisses + 1 : 0;
        }
        if (account.signInLost || health?.account === 'expired') {
          setLight({ state: 'err', detail: 'Spotify signed Runway out. Sign in again in Settings › Spotify.' });
          setSpotifyAlert({
            kind: 'signed-out',
            text: 'Spotify signed Runway out, so it can’t read playlists or start songs quietly. Sign in again in Settings › Spotify.',
            action: 'settings',
          });
          return;
        }
        if (isMac && app?.ok && appMisses >= 2) {
          const others = health?.accountComputers?.length ? ` Computers on the account right now: ${health.accountComputers.join(', ')}.` : '';
          setLight({ state: 'err', detail: `The Spotify app on this Mac isn’t on ${account.displayName ?? 'Runway’s'} account.${others}` });
          setSpotifyAlert({
            kind: 'app-account',
            text: `The Spotify app on this Mac looks logged out, or signed in to a different account than ${account.displayName ?? 'Runway’s'}. Songs won’t play until it’s logged in. Open Spotify and log in.${others}`,
          });
          return;
        }
        if (isMac && !app?.ok) {
          setLight({ state: 'err', detail: `Signed in${who}, but ${app?.reason ?? 'the Spotify app isn’t answering.'}` });
          setSpotifyAlert(spotifyServiceSoon()
            ? { kind: 'app-closed', text: 'The Spotify app isn’t open, and a Spotify service is coming up. Open Spotify on this Mac.' }
            : null);
          return;
        }
        setLight({ state: 'on', detail: isMac ? `Signed in${who}. Spotify app is open.` : `Signed in${who}.` });
        setSpotifyAlert(null);
      } catch {
        if (alive) setLight({ state: 'err', detail: 'Couldn’t reach Spotify.' });
      }
    };
    void check();
    const t = window.setInterval(() => void check(), POLL_MS);
    return () => { alive = false; window.clearInterval(t); };
  }, [clientId]);

  if (!clientId) return null;
  return (
    <button
      className="midi-status midi-status-button"
      onClick={() => useAppStore.getState().openSettings('spotify')}
      data-state={light.state}
      title={scan.running ? `Scanning waveforms: ${scan.idx} of ${scan.total} (${scan.title}). ${light.detail}` : light.detail}
    >
      <div className={`midi-dot ${light.state === 'on' ? '' : light.state === 'err' ? 'disabled' : 'off'}`} />
      <span>{scan.running ? `Spotify · scan ${scan.idx}/${scan.total}` : 'Spotify'}</span>
    </button>
  );
}
