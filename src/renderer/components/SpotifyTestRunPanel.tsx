import React, { useEffect, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { ALL_KEYS, displayKey } from '@shared/music';
import type { KeyName, SpotifyPlaylistResult } from '@shared/types';
import { formatDuration } from '../lib/format';
import { spotifyTestRun, type SpotifyRunState } from '../lib/spotifyTestRun';

const LENGTHS: Array<{ label: string; sec: number | null }> = [
  { label: '30 sec', sec: 30 },
  { label: '1 min', sec: 60 },
  { label: '2 min', sec: 120 },
  { label: '5 min', sec: 300 },
  { label: '10 min', sec: 600 },
  { label: 'Whole playlist', sec: null },
];

function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Experimental: rehearses a Spotify-driven pre-service runway. The
 * playlist's last song ends at the countdown's 0:00 and the pad takes
 * over. Runs only from this panel; never arms or changes a service.
 */
export function SpotifyTestRunPanel({ playlist }: { playlist: SpotifyPlaylistResult }) {
  const { audio } = useEngines();
  const pads = useAppStore(s => s.config.pads);
  const defaults = useAppStore(s => s.config.defaults);
  const serviceActive = useAppStore(s => {
    const r = s.currentRunway;
    return !!r && (r.phase === 'music' || r.phase === 'pad');
  });
  const [run, setRun] = useState<SpotifyRunState>(spotifyTestRun.getState());
  const [lengthIdx, setLengthIdx] = useState(0);
  const [padKey, setPadKey] = useState<KeyName | ''>('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => spotifyTestRun.subscribe(setRun), []);
  useEffect(() => {
    if (run.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [run.status]);

  const tracks = playlist.tracks ?? [];
  const padKeys = ALL_KEYS.filter(k => pads.some(p => p.key === k));
  const running = run.status === 'running';

  const start = () => {
    const pad = padKey ? pads.find(p => p.key === padKey) : undefined;
    void spotifyTestRun.start({
      tracks,
      lengthSec: LENGTHS[lengthIdx].sec,
      padKey: padKey || null,
      padFilePath: pad?.filePath ?? null,
      padLeadInSec: defaults.padLeadInSec,
      lastFadeSec: defaults.musicFadeToPadSec ?? 5,
      audio,
      edits: useAppStore.getState().config.spotify?.trackEdits ?? {},
      playlistId: playlist.playlistId,
    });
  };

  return (
    <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
      <div className="settings-section-title" style={{ fontSize: 14 }}>Test run (experimental)</div>
      <div className="settings-section-sub">
        Plays this playlist through the Spotify app so the last song ends exactly when the countdown hits 0:00,
        then the pad takes over. Spotify plays through its own output and its own volume. Test only: it never
        starts or changes a service.
      </div>

      <div className="pp-actions">
        <label className="settings-field-sub" htmlFor="sp-run-length">Length</label>
        <select id="sp-run-length" value={lengthIdx} onChange={e => setLengthIdx(Number(e.target.value))} disabled={running}>
          {LENGTHS.map((l, i) => <option key={l.label} value={i}>{l.label}</option>)}
        </select>
        <label className="settings-field-sub" htmlFor="sp-run-pad">Pad</label>
        <select id="sp-run-pad" value={padKey} onChange={e => setPadKey(e.target.value as KeyName | '')} disabled={running}>
          <option value="">No pad</option>
          {padKeys.map(k => <option key={k} value={k}>{displayKey(k)}</option>)}
        </select>
        {!running ? (
          <button className="btn-secondary" onClick={start} disabled={serviceActive || tracks.length === 0}>
            Start test run
          </button>
        ) : (
          <button className="btn-secondary" onClick={() => void spotifyTestRun.stop()}>Stop</button>
        )}
        {run.padPlaying && !running && (
          <button className="btn-secondary" onClick={() => spotifyTestRun.stopPad(defaults.padFadeOutSec)}>
            Fade out pad
          </button>
        )}
      </div>
      {serviceActive && (
        <div className="pp-status err">A service is playing. The test run is off until it’s done.</div>
      )}

      {run.status !== 'idle' && run.endAt !== null && (
        <div className="settings-section-sub" style={{ marginTop: 12 }}>
          {running && (
            <div style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 28, color: 'var(--text)', marginBottom: 6 }}>
              {clock(run.endAt - now)}
            </div>
          )}
          {run.segments.map((s, i) => {
            const playedFor = (s.stopAt - s.startAt) / 1000;
            const isCurrent = running && i === run.currentIndex;
            return (
              <div key={`${s.uri}-${i}`} style={{ display: 'flex', gap: 8, color: isCurrent ? 'var(--accent-bright)' : undefined }}>
                <span style={{ width: 16 }}>{isCurrent ? '▶' : ''}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.title}{s.artist ? ` — ${s.artist}` : ''}
                  {s.startPosSec > 0 ? ` (from ${formatDuration(s.startPosSec)})` : ''}
                  {s.endPosSec < s.songDurSec - 0.05 && i < run.segments.length - 1 ? ` (to ${formatDuration(s.endPosSec)})` : ''}
                </span>
                <span>{formatDuration(playedFor)}</span>
              </div>
            );
          })}
          {run.message && (
            <div className={`pp-status ${run.status === 'error' ? 'err' : 'ok'}`} style={{ marginTop: 8 }}>
              {run.message}
              {run.status === 'landed' && run.corrections > 0 ? ` The first song was re-placed ${run.corrections} time${run.corrections === 1 ? '' : 's'} before it faded in.` : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
