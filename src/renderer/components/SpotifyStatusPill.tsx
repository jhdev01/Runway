import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { useWaveformScan } from '../lib/spotifyWaveformScan';

type SpotifyLight = { state: 'on' | 'err' | 'unknown'; detail: string };

const POLL_MS = 5000;

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

  useEffect(() => {
    if (!clientId) return;
    let alive = true;
    const isMac = navigator.userAgent.includes('Mac');
    const check = async () => {
      try {
        const account = await window.runway.spotify.status();
        if (!alive) return;
        if (!account?.connected) {
          setLight({ state: 'err', detail: 'Not signed in to Spotify. Click to open Settings.' });
          return;
        }
        const who = account.displayName ? ` as ${account.displayName}` : '';
        if (!isMac) {
          setLight({ state: 'on', detail: `Signed in${who}.` });
          return;
        }
        const app = await window.runway.spotify.player({ op: 'check' });
        if (!alive) return;
        setLight(app?.ok
          ? { state: 'on', detail: `Signed in${who}. Spotify app is open.` }
          : { state: 'err', detail: `Signed in${who}, but ${app?.reason ?? 'the Spotify app isn’t answering.'}` });
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
