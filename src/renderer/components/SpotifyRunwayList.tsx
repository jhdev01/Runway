import React, { useEffect, useState } from 'react';
import { formatDuration } from '../lib/format';
import { keyColor, displayKey } from '@shared/music';
import type { KeyName } from '@shared/types';
import { spotifyServiceRun, spotifyNowPlaying, type SpotifyRunSegment, type SpotifyRunState } from '../lib/spotifyTestRun';

/**
 * Live-view runway for a service whose music comes from a Spotify
 * playlist. Same chip strip as the Runway-track runway (title, artist,
 * length, key badge, progress bar, pad chip) plus album art.
 */
export function SpotifyRunwayList({ segments, landInKey, showPad, padPlaying, keyMode }: {
  segments: SpotifyRunSegment[];
  landInKey?: KeyName;
  showPad: boolean;
  padPlaying: boolean;
  keyMode: 'sharp' | 'flat';
}) {
  const [run, setRun] = useState<SpotifyRunState>(spotifyServiceRun.getState());
  const [now, setNow] = useState(Date.now());
  useEffect(() => spotifyServiceRun.subscribe(setRun), []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const live = run.status === 'running' ? spotifyNowPlaying(segments, now) : null;
  const lastIdx = segments.length - 1;

  return (
    <>
      <div className="timeline">
        {segments.map((s, i) => {
          const isCurrent = live?.index === i;
          const isPlayed = live ? i < live.index : now >= s.stopAt;
          const span = s.stopAt - s.startAt;
          const progressPct = isCurrent ? Math.min(100, ((now - s.startAt) / span) * 100) : isPlayed ? 100 : 0;
          const c = s.key ? keyColor(s.key) : null;
          const segStyle: React.CSSProperties = { flex: '1 0 220px' };
          if (c) {
            segStyle.background = isCurrent ? c.soft : c.whisper;
            if (isCurrent) segStyle.borderTop = `2px solid ${c.fg}`;
          }
          return (
            <div key={`${s.uri}-${i}`} className={`timeline-segment ${isCurrent ? 'current' : ''} ${isPlayed ? 'played' : ''}`} style={segStyle}>
              <div className="tl-seg-top" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 10, paddingRight: 28 }}>
                {s.albumArtUrl
                  ? <img src={s.albumArtUrl} alt="" loading="lazy" style={{ width: 52, height: 52, borderRadius: 4, objectFit: 'cover', flex: 'none' }} />
                  : <div aria-hidden style={{ width: 52, height: 52, borderRadius: 4, background: 'rgba(255,255,255,0.06)', display: 'grid', placeItems: 'center', flex: 'none' }}>♪</div>}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="tl-seg-name" title={s.title}>{s.title}</div>
                  {s.artist && <div className="tl-seg-artist" title={s.artist}>{s.artist}</div>}
                  <div className="tl-seg-meta">
                    {formatDuration(span / 1000)}
                    {s.startPosSec > 0 && <span style={{ opacity: 0.6 }}> · from {formatDuration(s.startPosSec)}</span>}
                    {i === lastIdx && <span style={{ opacity: 0.6 }}> · lands 0:00</span>}
                  </div>
                </div>
                {s.key && c && (
                  <div className={`tl-seg-key ${isCurrent && i === lastIdx ? 'match' : ''}`} style={{ background: c.bg, color: c.fg, borderColor: c.fg }}>
                    {displayKey(s.key, keyMode)}
                  </div>
                )}
              </div>
              <div className="tl-seg-scrub">
                <div className="tl-seg-scrub-fill" style={{ width: `${progressPct}%`, background: c ? c.fg : undefined }} />
              </div>
            </div>
          );
        })}
        {showPad && (
          <div className={`timeline-segment pad-segment ${padPlaying ? 'current' : ''}`} style={{ flex: '1 0 140px' }}>
            <div className="tl-seg-top" title="Pad bridge">
              <div className="tl-seg-name">Pad</div>
              <div className="tl-seg-meta">{padPlaying ? 'rolling' : 'on deck'}</div>
              {landInKey && (() => {
                const c = keyColor(landInKey);
                return <div className={`tl-seg-key ${padPlaying ? 'match' : ''}`} style={{ background: c.bg, color: c.fg, borderColor: c.fg }}>{displayKey(landInKey, keyMode)}</div>;
              })()}
            </div>
            <div className="tl-seg-scrub" />
          </div>
        )}
      </div>
      {run.message && (run.status === 'error' || run.status === 'landed') && (
        <div className={`pp-status ${run.status === 'error' ? 'err' : 'ok'}`} style={{ marginTop: 6 }}>{run.message}</div>
      )}
    </>
  );
}

/** Current song of a playing Spotify runway (re-renders 4× a second), or null. */
export function useSpotifyNow(segments: SpotifyRunSegment[] | undefined) {
  const [run, setRun] = useState<SpotifyRunState>(spotifyServiceRun.getState());
  const [now, setNow] = useState(Date.now());
  useEffect(() => spotifyServiceRun.subscribe(setRun), []);
  useEffect(() => {
    if (!segments) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [segments]);
  if (!segments || run.status !== 'running') return null;
  return spotifyNowPlaying(segments, now);
}
