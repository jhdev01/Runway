import React, { useEffect, useState } from 'react';
import type { Envelope } from '@shared/landLearn';
import { useAppStore } from '../state/store';
import { landAccuracyNote, suggestEdits, type EditSuggestion } from '../lib/landLearning';
import { InfoTip } from './InfoTip';

export interface SuggestItem {
  id: string;
  title: string;
  artist?: string;
  durationSec: number;
  /** What's set now (undefined = not set; only those get suggestions). */
  current: { startSec?: number; endSec?: number; landSec?: number };
  getEnv: () => Promise<Envelope | null>;
  apply: (s: EditSuggestion) => void;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/**
 * "Suggested trims & 0:00" for a whole playlist: works out silence trims
 * and a learned 0:00 for each song's unset values, lists them with a tick
 * box each, and applies only the ticked ones. Nothing changes until Apply.
 */
export function SuggestionsPanel({ items, title, onClose }: { items: SuggestItem[]; title: string; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ item: SuggestItem; s: EditSuggestion; on: boolean }>>([]);
  const [progress, setProgress] = useState({ done: 0, total: items.length, missing: 0 });
  const [note, setNote] = useState<string | null>(null);
  const servicePlaying = useAppStore(s => !!s.currentRunway && (s.currentRunway.phase === 'music' || s.currentRunway.phase === 'pad'));

  useEffect(() => {
    let alive = true;
    void (async () => {
      let missing = 0;
      const out: Array<{ item: SuggestItem; s: EditSuggestion; on: boolean }> = [];
      for (let i = 0; i < items.length; i++) {
        if (!alive) return;
        const it = items[i];
        try {
          const env = await it.getEnv();
          if (!env) missing++;
          else {
            const s = suggestEdits(env, it.durationSec, it.current);
            if (s.startSec !== undefined || s.endSec !== undefined || s.landSec !== undefined) {
              out.push({ item: it, s, on: true });
              if (alive) setRows([...out]);
            }
          }
        } catch { missing++; }
        if (alive) setProgress({ done: i + 1, total: items.length, missing });
      }
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const working = progress.done < progress.total;
  const chosen = rows.filter(r => r.on);
  const apply = () => {
    for (const r of chosen) r.item.apply(r.s);
    console.log('[operator] applied trim / 0:00 suggestions', { playlist: title, songs: chosen.length });
    setNote(`Applied to ${chosen.length} song${chosen.length === 1 ? '' : 's'}.`);
    setRows(rs => rs.filter(r => !r.on));
  };

  return (
    <div style={{ margin: '10px 0', padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-elev)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong>Suggested trims &amp; 0:00 · {title}</strong>
        <InfoTip width={320}>Only for values you haven't set: Start / End trim true silence at the ends; 0:00 is where you usually put it (the last big moment before the music falls away). Untick anything you don't want, then Apply. {landAccuracyNote()}</InfoTip>
        <span className="settings-field-sub">
          {working ? `Checking ${progress.done} of ${progress.total}…` : `${rows.length} song${rows.length === 1 ? '' : 's'} with suggestions`}
          {progress.missing ? ` · ${progress.missing} without a waveform or file` : ''}
        </span>
        <button className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      {rows.length > 0 && (
        <>
          <div style={{ marginTop: 8, maxHeight: 300, overflowY: 'auto' }}>
            {rows.map((r, i) => (
              <label key={r.item.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={r.on} onChange={e => setRows(rs => rs.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.item.title}{r.item.artist ? <span style={{ opacity: 0.6 }}> · {r.item.artist}</span> : null}
                </span>
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 12, color: 'var(--text-dim)' }}>
                  {[
                    r.s.startSec !== undefined ? `Start ${fmt(r.s.startSec)}` : null,
                    r.s.endSec !== undefined ? `End ${fmt(r.s.endSec)}` : null,
                    r.s.landSec !== undefined ? `0:00 ${fmt(r.s.landSec)}` : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </label>
            ))}
          </div>
          <div className="pp-actions" style={{ marginTop: 8 }}>
            <button className="btn-primary" disabled={chosen.length === 0 || servicePlaying} onClick={apply}>
              Apply {chosen.length} selected
            </button>
            {servicePlaying && <span className="settings-field-sub">A service is playing: apply when it's done.</span>}
          </div>
        </>
      )}
      {note && <div className="pp-status ok" style={{ marginTop: 6 }}>{note}</div>}
    </div>
  );
}
