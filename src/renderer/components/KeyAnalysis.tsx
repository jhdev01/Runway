import React, { useEffect, useRef, useState } from 'react';
import type { KeyName, KeyProfile, MultitracksCandidate } from '@shared/types';
import { parseKey } from '@shared/keyDetect';
import { keyColor, displayKey } from '@shared/music';
import { useAppStore } from '../state/store';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

/** Pitch classes in a key's scale (tonic first), or [] for an unknown key. */
export function scaleOf(key: KeyName | undefined): number[] {
  if (!key) return [];
  try {
    const { pc, minor } = parseKey(key);
    if (pc < 0) return [];
    return (minor ? MINOR_STEPS : MAJOR_STEPS).map(s => (pc + s) % 12);
  } catch { return []; }
}

/**
 * A song's notes over time (like a DJ tool's "key and pitch" chart): one
 * row per note, C at the bottom, brighter = that note sounds stronger in
 * that second. Lines up with the waveform above it (same zoom / scroll).
 * Rows in `highlightKey`'s scale are tinted, its home note most.
 */
export function NoteMapStrip({ noteMap, durSec, zoomX, scrollX, height = 120, highlightKey }: {
  noteMap: Array<number[] | null> | null | undefined;
  durSec: number;
  zoomX: number;
  scrollX: number;   // same units as the editors: 0 … zoomX − 1
  height?: number;
  highlightKey?: KeyName;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(100, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = height * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, height);
    const LABEL = 22;
    const plotW = w - LABEL;
    const rowH = height / 12;
    const scale = scaleOf(highlightKey);
    // Row tints for the key's scale.
    for (const pc of scale) {
      g.fillStyle = pc === scale[0] ? 'rgba(245,165,36,0.16)' : 'rgba(255,255,255,0.05)';
      g.fillRect(LABEL, height - (pc + 1) * rowH, plotW, rowH);
    }
    const x = (sec: number) => LABEL + ((sec / durSec) * zoomX - scrollX) * plotW;
    if (noteMap) {
      for (let s = 0; s < noteMap.length; s++) {
        const col = noteMap[s];
        if (!col) continue;
        const x0 = x(s), x1 = x(s + 1);
        if (x1 < LABEL || x0 > w) continue;
        for (let pc = 0; pc < 12; pc++) {
          const v = col[pc] / 99;
          if (v <= 0.02) continue;
          // dark blue → teal → bright green, like a heat map
          const r = Math.round(20 + 60 * v), gg = Math.round(60 + 180 * v), b = Math.round(160 - 40 * v);
          g.fillStyle = `rgba(${r},${gg},${b},${0.25 + 0.75 * v})`;
          g.fillRect(Math.max(LABEL, x0), height - (pc + 1) * rowH + 0.5, Math.max(1, x1 - Math.max(LABEL, x0)), rowH - 1);
        }
      }
    }
    // Note labels.
    g.font = '600 9px IBM Plex Mono, monospace';
    g.textBaseline = 'middle';
    for (let pc = 0; pc < 12; pc++) {
      g.fillStyle = scale[0] === pc ? '#f5a524' : scale.includes(pc) ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)';
      g.fillText(NOTE_NAMES[pc], 2, height - (pc + 0.5) * rowH);
    }
  }, [noteMap, durSec, zoomX, scrollX, height, highlightKey, w]);
  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height, display: 'block', borderRadius: 6, background: 'var(--bg-elev-2, rgba(255,255,255,0.03))' }} />
      {(!noteMap || noteMap.every(c => !c)) && (
        <div className="settings-field-sub" style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          No note map yet
        </div>
      )}
    </div>
  );
}

export interface KeyHeard {
  key: KeyName;
  confidence: number;
  candidates?: KeyName[];
  endKey?: KeyName;
  heardSec?: number;
  profile?: KeyProfile;
  source: string;     // e.g. "Runway heard" / "Detected from the file"
}

/**
 * Key analysis: the key you've set, what the detector found (and how sure),
 * the next likeliest keys and the ending's key as one-click choices, the
 * song's overall note profile as bars (the key's notes highlighted), and an
 * optional MultiTracks check. Setting a key here teaches key learning.
 */
export function KeyAnalysisPanel({ currentKey, heard, onSetKey, lookupMultitracks, analysing }: {
  currentKey?: KeyName;
  heard?: KeyHeard | null;
  onSetKey: (k: KeyName) => void;
  lookupMultitracks?: () => Promise<{ best?: MultitracksCandidate; alternates?: MultitracksCandidate[]; reason?: string }>;
  analysing?: boolean;
}) {
  const keyMode = useAppStore(s => s.config.defaults.keyDisplayMode ?? 'sharp');
  const learned = useAppStore(s => !!s.config.keyLearning?.adopted);
  const [mt, setMt] = useState<{ busy: boolean; list: MultitracksCandidate[]; note: string | null }>({ busy: false, list: [], note: null });
  const chip = (k: KeyName, label: string, title: string, active = false) => {
    const c = keyColor(k);
    return (
      <button
        key={label + k}
        type="button"
        onClick={() => onSetKey(k)}
        title={title}
        style={{
          minWidth: 40, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
          fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: 12,
          background: c.bg, color: c.fg, border: active ? `2px solid ${c.fg}` : '1px dashed var(--border-bright)',
        }}
      >
        {label}{displayKey(k, keyMode)}
      </button>
    );
  };
  // Profile bars (harmony; key's scale highlighted).
  const prof = heard?.profile?.harm;
  const maxP = prof ? Math.max(...prof) : 0;
  const scale = scaleOf(heard?.key);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) auto', gap: 18, alignItems: 'start' }}>
      <div>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-faint)', fontWeight: 600, marginBottom: 6 }}>Key</div>
        <div className="pp-actions" style={{ flexWrap: 'wrap' }}>
          <span className="settings-field-sub">Yours:</span>
          {currentKey
            ? chip(currentKey, '', 'The key set for this song', true)
            : <span className="settings-field-sub">not set</span>}
        </div>
        <div className="settings-field-sub" style={{ marginTop: 6 }}>
          {analysing ? 'Analysing…'
            : heard
              ? `${heard.source}: ${displayKey(heard.key, keyMode)} (${Math.round(heard.confidence * 100)}% sure${heard.heardSec ? `, from ${heard.heardSec} s` : ''})${learned ? ' · using settings learned from your songs' : ''}`
              : 'No analysis yet. Play or scan the song (Spotify), or run Detect keys (Library).'}
        </div>
        {heard && (
          <div className="pp-actions" style={{ flexWrap: 'wrap', marginTop: 6 }}>
            {chip(heard.key, '', `${heard.source}. Click to use it.`)}
            {(heard.candidates ?? []).filter(k => k !== heard.key).slice(0, 3).map(k => chip(k, '', 'Next likeliest. Click to use it.'))}
            {heard.endKey && chip(heard.endKey, 'ends ', 'The last 30 seconds sound like this key (the song may change key). Click to use it for landing.')}
          </div>
        )}
        {lookupMultitracks && (
          <div className="pp-actions" style={{ flexWrap: 'wrap', marginTop: 6 }}>
            <button
              className="btn-secondary"
              disabled={mt.busy}
              onClick={async () => {
                setMt({ busy: true, list: [], note: null });
                try {
                  const r = await lookupMultitracks();
                  const list = r.best ? [r.best, ...(r.alternates ?? [])] : [];
                  setMt({ busy: false, list, note: list.length ? null : (r.reason ?? 'Not on MultiTracks.') });
                } catch { setMt({ busy: false, list: [], note: 'MultiTracks didn’t answer.' }); }
              }}
            >
              {mt.busy ? 'Checking…' : 'Check MultiTracks'}
            </button>
            {mt.list.map(c => chip(c.key, '', `MultiTracks: ${c.title}${c.artist ? ` — ${c.artist}` : ''}${c.album ? ` (${c.album})` : ''}`))}
            {mt.note && <span className="settings-field-sub">{mt.note}</span>}
          </div>
        )}
      </div>
      {prof && maxP > 0 && (
        <div title="How much of each note the song has overall. Highlighted: the notes of the detected key (home note in orange).">
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-faint)', fontWeight: 600, marginBottom: 6 }}>Notes in the song</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70 }}>
            {prof.map((v, pc) => (
              <div key={pc} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div style={{
                  width: 14, height: Math.max(2, (v / maxP) * 56), borderRadius: 2,
                  background: scale[0] === pc ? '#f5a524' : scale.includes(pc) ? 'var(--accent-bright, #2dd4bf)' : 'rgba(255,255,255,0.18)',
                }} />
                <span style={{ fontSize: 9, fontFamily: 'IBM Plex Mono, monospace', opacity: scale.includes(pc) ? 0.9 : 0.45 }}>{NOTE_NAMES[pc]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
