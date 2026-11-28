import React, { useEffect, useState } from 'react';
import type { KeyName, Track } from '@shared/types';
import { effectiveDuration } from '@shared/types';
import { keyColor, displayKey } from '@shared/music';
import { useAppStore } from '../state/store';
import { formatDuration } from '../lib/format';
import { trackEnvelope } from '../lib/landLearning';
import { NpWaveform } from './UpNextList';

/**
 * Library (new look): details of the clicked song on the right — artwork,
 * waveform, key / BPM / length, the playlists it's in, and Preview / Open
 * in Editor. Read-only; editing still happens in the Editor.
 */
export function LibrarySongPanel({ track, playlists, previewing, onPreview, onEdit, onClose }: {
  track: Track;
  playlists: { id: string; name: string; kind: string }[];
  previewing: boolean;
  onPreview: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const keyMode = useAppStore(s => s.config.defaults.keyDisplayMode ?? 'sharp');
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    let alive = true;
    setPeaks(null);
    void trackEnvelope(track.id, track.filePath).then(env => {
      if (!alive || !env?.peaks.length) return;
      const src = Array.from(env.peaks);
      const BARS = 90;
      const step = src.length / BARS;
      const out: number[] = [];
      for (let i = 0; i < BARS; i++) {
        let m = 0;
        for (let j = Math.floor(i * step); j < Math.floor((i + 1) * step); j++) m = Math.max(m, src[j] ?? 0);
        out.push(m);
      }
      setPeaks(out);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [track.id, track.filePath]);

  const k = track.key as KeyName | undefined;
  const c = k ? keyColor(k) : null;
  const edits = [
    (track.trimStartSec || track.trimEndSec) ? 'Trimmed' : null,
    typeof track.editServiceLandSec === 'number' ? '0:00 marker' : null,
    (track.editFadeInSec || track.editFadeOutSec) ? 'Fades' : null,
  ].filter(Boolean) as string[];

  return (
    <aside className="lib-panel" aria-label="Song details">
      <button type="button" className="lib-panel-close" aria-label="Close details" onClick={onClose}>✕</button>
      {track.albumArtUrl
        ? <img className="lib-panel-art" src={track.albumArtUrl} alt="" />
        : <div className="lib-panel-art placeholder" aria-hidden><span>{track.title}</span></div>}
      <div>
        <div className="lib-panel-title">{track.title}</div>
        <div className="lib-panel-artist">{[track.artist, track.album].filter(Boolean).join(' · ') || ' '}</div>
      </div>
      <div className="lib-panel-wave"><NpWaveform peaks={peaks} progressPct={0} /></div>
      <div className="lib-panel-tiles">
        <div><span>Key</span><strong style={c ? { color: c.fg } : undefined}>{k ? displayKey(k, keyMode) : '—'}</strong></div>
        <div><span>BPM</span><strong>{track.bpm ? Math.round(track.bpm) : '—'}</strong></div>
        <div><span>Length</span><strong>{formatDuration(effectiveDuration(track))}</strong></div>
      </div>
      {edits.length > 0 && <div className="lib-panel-edits">{edits.join(' · ')}</div>}
      <div className="lib-panel-section">In playlists</div>
      <div className="lib-panel-playlists">
        {playlists.length === 0 ? <span className="lib-panel-none">Not in a playlist</span> : playlists.map(p => <span key={p.id} className="lib-panel-chip">{p.name}</span>)}
      </div>
      <div className="lib-panel-buttons">
        <button type="button" className="btn-primary" onClick={onEdit}>Open in Editor</button>
        <button type="button" className="btn-secondary" onClick={onPreview}>{previewing ? 'Stop preview' : 'Preview'}</button>
      </div>
    </aside>
  );
}
