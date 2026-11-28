import React from 'react';
import { keyColor, displayKey } from '@shared/music';
import type { KeyName } from '@shared/types';
import { formatDuration } from '../lib/format';

/**
 * The runway as a music-player track list (new look): one row per song,
 * the pad, and the actions that fire along the way, in time order.
 * Display only: rows are built by the Live view from the runway that's
 * armed; nothing here changes what plays or when.
 */
export type UpNextRow =
  | {
      kind: 'song';
      id: string;
      n: number;
      title: string;
      artist?: string;
      art?: string;
      keyName?: KeyName;
      startMs: number;
      durSec: number;
      state: 'played' | 'current' | 'next';
      progressPct?: number;
      lands?: boolean;
    }
  | { kind: 'pad'; id: string; keyName?: KeyName; startMs: number; durSec: number; state: 'played' | 'current' | 'next'; note?: string }
  | { kind: 'action'; id: string; icon: string; color: string; label: string; detail: string; atMs: number; past: boolean };

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

export function UpNextList({ rows, keyMode, showPlayed }: {
  rows: UpNextRow[];
  keyMode: 'sharp' | 'flat';
  showPlayed: boolean;
}) {
  const visible = rows.filter(r => showPlayed || (r.kind === 'action' ? !r.past : r.state !== 'played'));
  if (visible.length === 0) return <div className="timeline-empty">Nothing left in this runway.</div>;
  return (
    <div className="upnext" role="list">
      <div className="upnext-head" aria-hidden>
        <span>#</span><span>Title</span><span>Starts</span><span>Key</span><span className="upnext-right">Time</span>
      </div>
      {visible.map(r => {
        if (r.kind === 'action') {
          return (
            <div key={r.id} role="listitem" className={`upnext-action ${r.past ? 'past' : ''}`} title={r.detail}>
              <span className="upnext-action-icon" style={{ color: r.color, borderColor: r.color }}>{r.icon}</span>
              <span className="upnext-action-label">{r.label}</span>
              <span className="upnext-time">{timeOf(r.atMs)}</span>
            </div>
          );
        }
        const c = r.keyName ? keyColor(r.keyName) : null;
        const keyChip = r.keyName && c
          ? <span className="upnext-key" style={{ background: c.bg, color: c.fg }}>{displayKey(r.keyName, keyMode)}</span>
          : <span className="upnext-key none">—</span>;
        if (r.kind === 'pad') {
          return (
            <div key={r.id} role="listitem" className={`upnext-row pad ${r.state}`}>
              <span className="upnext-n">♫</span>
              <div className="upnext-title-cell">
                <div className="upnext-art pad" aria-hidden>Pad</div>
                <div className="upnext-titles">
                  <div className="upnext-title">Pad bridge</div>
                  <div className="upnext-artist">{r.note ?? (r.state === 'current' ? 'Holding' : 'Into the service')}</div>
                </div>
              </div>
              <span className="upnext-time">{timeOf(r.startMs)}</span>
              {keyChip}
              <span className="upnext-time upnext-right">{formatDuration(r.durSec)}</span>
            </div>
          );
        }
        return (
          <div key={r.id} role="listitem" className={`upnext-row ${r.state}`}>
            <span className="upnext-n">{r.state === 'current' ? '▶' : r.n}</span>
            <div className="upnext-title-cell">
              {r.art
                ? <img className="upnext-art" src={r.art} alt="" loading="lazy" />
                : <div className="upnext-art" aria-hidden>♪</div>}
              <div className="upnext-titles">
                <div className="upnext-title">{r.title}</div>
                <div className="upnext-artist">{r.artist ?? ''}{r.lands ? <span className="upnext-lands"> · lands on 0:00</span> : null}</div>
              </div>
            </div>
            <span className="upnext-time">{timeOf(r.startMs)}</span>
            {keyChip}
            <span className="upnext-time upnext-right">{formatDuration(r.durSec)}</span>
            {r.state === 'current' && (
              <span className="upnext-progress" aria-hidden><span style={{ width: `${Math.max(0, Math.min(100, r.progressPct ?? 0))}%` }} /></span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Waveform of the playing song for the now-playing card: the song's
 * loudness over time, played part in blue. Falls back to a plain bar
 * while the waveform isn't known yet.
 */
export function NpWaveform({ peaks, progressPct }: { peaks: number[] | null; progressPct: number }) {
  if (!peaks || peaks.length === 0) {
    return (
      <div className="np-progress-bar">
        <div className="np-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
    );
  }
  const n = peaks.length;
  // Scale from the song's quiet parts to its loudest (not from silence), so
  // a loud modern master shows its shape instead of a flat wall.
  const sorted = [...peaks].sort((x, y) => x - y);
  const lo = sorted[Math.floor(n * 0.05)] ?? 0;
  const hi = Math.max(sorted[Math.floor(n * 0.98)] ?? 0, lo + 0.0001);
  const scale = (p: number) => 0.1 + 0.9 * Math.pow(Math.min(1, Math.max(0, (p - lo) / (hi - lo))), 1.3);
  return (
    <div className="np-wave" aria-hidden>
      {peaks.map((p, i) => (
        <span
          key={i}
          className={(i + 0.5) / n * 100 <= progressPct ? 'on' : ''}
          style={{ height: `${Math.round(scale(p) * 100)}%` }}
        />
      ))}
    </div>
  );
}
