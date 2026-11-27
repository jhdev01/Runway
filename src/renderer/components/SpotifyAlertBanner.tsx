import React from 'react';
import { useAppStore } from '../state/store';
import { dismissSpotifyAlert, useSpotifyAlert } from '../lib/spotifyAlert';

/** Red strip under the top bar when Spotify needs attention (see lib/spotifyAlert). */
export function SpotifyAlertBanner() {
  const alert = useSpotifyAlert();
  if (!alert) return null;
  return (
    <div className="spotify-alert" role="alert">
      <span className="spotify-alert-dot" aria-hidden />
      <span className="spotify-alert-text">{alert.text}</span>
      {alert.action === 'settings' && (
        <button className="btn-secondary" onClick={() => useAppStore.getState().openSettings('spotify')}>
          Open Spotify settings
        </button>
      )}
      <button className="spotify-alert-close" onClick={dismissSpotifyAlert} aria-label="Hide this message">✕</button>
    </div>
  );
}
