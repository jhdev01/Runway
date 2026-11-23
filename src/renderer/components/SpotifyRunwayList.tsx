import React, { useEffect, useState } from 'react';
import { formatDuration } from '../lib/format';
import { spotifyServiceRun, type SpotifyRunSegment, type SpotifyRunState } from '../lib/spotifyTestRun';

/**
 * Live-view runway for a service whose music comes from a Spotify
 * playlist: the planned songs, which one is playing, and the landing.
 */
export function SpotifyRunwayList({ playlistName, segments }: { playlistName: string; segments: SpotifyRunSegment[] }) {
  const [run, setRun] = useState<SpotifyRunState>(spotifyServiceRun.getState());
  useEffect(() => spotifyServiceRun.subscribe(setRun), []);
  const playing = run.status === 'running' ? run.currentIndex : -1;
  return (
    <div className="runway-list">
      <div className="settings-field-sub" style={{ marginBottom: 6 }}>
        Spotify · {playlistName}. Plays through the Spotify app (its own output and volume).
      </div>
      {segments.map((s, i) => (
        <div
          key={`${s.uri}-${i}`}
          style={{ display: 'flex', gap: 8, padding: '3px 0', color: i === playing ? 'var(--accent-bright)' : undefined, opacity: playing > i ? 0.5 : 1 }}
        >
          <span style={{ width: 14 }}>{i === playing ? '▶' : ''}</span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {s.title}{s.artist ? ` — ${s.artist}` : ''}
            {s.startPosSec > 0 ? ` (from ${formatDuration(s.startPosSec)})` : ''}
            {i === segments.length - 1 ? ' · lands at 0:00' : ''}
          </span>
          <span>{formatDuration((s.stopAt - s.startAt) / 1000)}</span>
        </div>
      ))}
      {run.message && (run.status === 'error' || run.status === 'landed') && (
        <div className={`pp-status ${run.status === 'error' ? 'err' : 'ok'}`} style={{ marginTop: 6 }}>{run.message}</div>
      )}
    </div>
  );
}
