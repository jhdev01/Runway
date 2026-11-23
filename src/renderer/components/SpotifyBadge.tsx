import React from 'react';

/** Small green tag marking something as coming from Spotify. */
export function SpotifyBadge({ title = 'Spotify playlist — plays through the Spotify app' }: { title?: string }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
        color: '#1ed760', background: 'rgba(30,215,96,0.12)', border: '1px solid rgba(30,215,96,0.35)',
        borderRadius: 999, padding: '1px 7px', lineHeight: '16px', verticalAlign: 'middle',
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: 999, background: '#1ed760' }} />
      Spotify
    </span>
  );
}
