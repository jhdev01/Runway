import React, { useEffect, useRef, useState } from 'react';
import type { KeyName, KeyProfile, MultitracksCandidate } from '@shared/types';
import { parseKey, keyRelation } from '@shared/keyDetect';
import { rescoreProfile } from '@shared/keyLearn';
import { learnedKeyParams } from '../lib/keyLearning';
import { keyColor, displayKey, camelotOf, isMajor, MAJOR_KEYS, MINOR_KEYS } from '@shared/music';
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

/** The major key with the same notes (G for Em); majors map to themselves. */
export function signatureOf(key: KeyName): KeyName {
  if (isMajor(key)) return key;
  const i = MINOR_KEYS.indexOf(key);
  return i >= 0 ? MAJOR_KEYS[i] : key;
}
/** The minor key with the same notes (Em for G). */
function relativeMinorOf(major: KeyName): KeyName | undefined {
  const i = MAJOR_KEYS.indexOf(major);
  return i >= 0 ? MINOR_KEYS[i] : undefined;
}

export interface KeySpan { startSec: number; endSec: number; key: KeyName; strength: number }

/**
 * Splits a note map into stretches by the key they sound like (8-second
 * windows, scored with the same detector, neighbouring windows in the same
 * key merged, one-window blips smoothed away). Relative major/minor pairs
 * (G and Em: the same notes) count as one key, shown as the major.
 */
export function keyTimeline(noteMap: Array<number[] | null> | null | undefined, windowSec = 10): KeySpan[] {
  if (!noteMap || noteMap.length === 0) return [];
  const params = learnedKeyParams();
  const flat = Array(12).fill(1 / 12);
  const wins: Array<KeySpan | null> = [];
  for (let s = 0; s < noteMap.length; s += windowSec) {
    const sum = new Array(12).fill(0);
    let n = 0;
    for (let i = s; i < Math.min(noteMap.length, s + windowSec); i++) {
      const col = noteMap[i];
      if (!col) continue;
      n++;
      for (let pc = 0; pc < 12; pc++) sum[pc] += col[pc];
    }
    if (n < 4) { wins.push(null); continue; }
    const tot = sum.reduce((a, b) => a + b, 0) || 1;
    const harm = sum.map(v => v / tot);
    const r = rescoreProfile({ harm, bass: new Array(12).fill(0), intro: flat, outro: flat, tuning: 0 }, params);
    wins.push({ startSec: s, endSec: Math.min(noteMap.length, s + windowSec), key: signatureOf(r.key), strength: r.confidence });
  }
  // Smooth single-window blips between two windows in the same key
  // (looking past windows with too little heard to judge).
  const idx = wins.map((w, i) => (w ? i : -1)).filter(i => i >= 0);
  for (let j = 1; j < idx.length - 1; j++) {
    const a = wins[idx[j - 1]]!, b = wins[idx[j]]!, c = wins[idx[j + 1]]!;
    if (a.key === c.key && b.key !== a.key) wins[idx[j]] = { ...b, key: a.key };
  }
  const spans: KeySpan[] = [];
  for (const w of wins) {
    if (!w) continue;
    const last = spans[spans.length - 1];
    if (last && last.key === w.key && w.startSec - last.endSec <= windowSec * 3) {
      last.endSec = w.endSec;
      last.strength = Math.max(last.strength, w.strength);
    } else spans.push({ ...w });
  }
  // A real key change lasts longer than this; shorter stretches are noise
  // (a chord, a bridge passing note) and fold into the longer neighbour.
  const MIN_SPAN = 20;
  for (let guard = 0; guard < 50; guard++) {
    const i = spans.findIndex(sp => sp.endSec - sp.startSec < MIN_SPAN);
    if (i < 0 || spans.length < 2) break;
    const prev = spans[i - 1], next = spans[i + 1];
    const into = !prev ? next : !next ? prev : (prev.endSec - prev.startSec >= next.endSec - next.startSec ? prev : next);
    into.startSec = Math.min(into.startSec, spans[i].startSec);
    into.endSec = Math.max(into.endSec, spans[i].endSec);
    spans.splice(i, 1);
    // Join neighbours that are now the same key.
    for (let j = spans.length - 1; j > 0; j--) {
      if (spans[j].key === spans[j - 1].key) {
        spans[j - 1].endSec = spans[j].endSec;
        spans[j - 1].strength = Math.max(spans[j - 1].strength, spans[j].strength);
        spans.splice(j, 1);
      }
    }
  }
  return spans;
}

/**
 * A song's notes over time (like a DJ tool's "key and pitch" chart): one
 * row per note, C at the bottom, brighter = that note sounds stronger in
 * that second. Lines up with the waveform above it (same zoom / scroll).
 * Rows in `highlightKey`'s scale are tinted, its home note most.
 */
export function NoteMapStrip({ noteMap, durSec, zoomX, scrollX, height = 140, highlightKey }: {
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
    const TOTAL_W = 54;           // per-note totals at the right edge
    const plotW = w - LABEL - TOTAL_W - 6;
    const LANE = 20;              // "key over time" band on top
    const top = LANE + 2;
    const rowH = (height - top) / 12;
    const scale = scaleOf(highlightKey);
    // Row tints for the key's scale.
    for (const pc of scale) {
      g.fillStyle = pc === scale[0] ? 'rgba(245,165,36,0.16)' : 'rgba(255,255,255,0.05)';
      g.fillRect(LABEL, height - (pc + 1) * rowH, plotW, rowH);
    }
    const x = (sec: number) => LABEL + ((sec / durSec) * zoomX - scrollX) * plotW;
    // Key over time: each stretch of the song labelled with the key it sounds like.
    g.font = '700 10px IBM Plex Mono, monospace';
    g.textBaseline = 'middle';
    for (const span of keyTimeline(noteMap)) {
      const x0 = Math.max(LABEL, x(span.startSec)), x1 = Math.min(LABEL + plotW, x(span.endSec));
      if (x1 <= x0) continue;
      const c = keyColor(span.key);
      g.fillStyle = c.bg;
      g.globalAlpha = 0.45 + 0.55 * Math.min(1, span.strength * 1.4);
      g.fillRect(x0 + 0.5, 1, x1 - x0 - 1, LANE - 2);
      g.globalAlpha = 1;
      const rel = relativeMinorOf(span.key);
      const label = x1 - x0 > 70 && rel ? `${displayKey(span.key)} · ${displayKey(rel)}` : displayKey(span.key);
      if (x1 - x0 > 18) {
        g.fillStyle = c.fg;
        g.fillText(label, x0 + 5, LANE / 2);
      }
    }
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.font = '600 8px IBM Plex Mono, monospace';
    g.fillText('KEY', 1, LANE / 2);
    const plotEnd = LABEL + plotW;
    if (noteMap) {
      // Easier to read than the raw per-second map: each second becomes
      // its notes' share (so a busy second doesn't light every note), then
      // a few seconds are averaged (a passing note doesn't flash), and the
      // whole song shares one brightness scale.
      const shares: Array<number[] | null> = noteMap.map(col => {
        if (!col) return null;
        const sum = col.reduce((a, b) => a + b, 0);
        return sum > 0 ? col.map(v => v / sum) : null;
      });
      const SMOOTH = 2; // seconds each side
      const smooth: Array<number[] | null> = shares.map((_, s) => {
        const acc = new Array(12).fill(0);
        let n = 0;
        for (let k = Math.max(0, s - SMOOTH); k <= Math.min(shares.length - 1, s + SMOOTH); k++) {
          const c = shares[k];
          if (!c) continue;
          n++;
          for (let pc = 0; pc < 12; pc++) acc[pc] += c[pc];
        }
        return shares[s] && n ? acc.map(v => v / n) : null;
      });
      let maxShare = 0;
      for (const c of smooth) if (c) for (const v of c) if (v > maxShare) maxShare = v;
      const totals = new Array(12).fill(0);
      for (const c of shares) if (c) for (let pc = 0; pc < 12; pc++) totals[pc] += c[pc];
      for (let s = 0; s < smooth.length; s++) {
        const col = smooth[s];
        if (!col) continue;
        const x0 = Math.max(LABEL, x(s)), x1 = Math.min(plotEnd, x(s + 1));
        if (x1 <= x0) continue;
        for (let pc = 0; pc < 12; pc++) {
          let v = maxShare > 0 ? Math.min(1, col[pc] / maxShare) : 0;
          v = v * v;                       // more contrast: strong notes stand out
          if (v <= 0.03) continue;
          // Notes outside the key are drawn fainter, so the key's 7 rows read as stripes.
          const dim = scale.length && !scale.includes(pc) ? 0.4 : 1;
          const r = Math.round(20 + 60 * v), gg = Math.round(60 + 180 * v), b = Math.round(160 - 40 * v);
          g.fillStyle = `rgba(${r},${gg},${b},${(0.25 + 0.75 * v) * dim})`;
          g.fillRect(x0, height - (pc + 1) * rowH + 0.5, Math.max(1, x1 - x0), Math.max(1, rowH - 1));
        }
      }
      // Totals: how much each note is used over the whole song. The key's
      // 7 notes come out long, the 5 it leaves out short.
      const maxT = Math.max(...totals);
      if (maxT > 0) {
        const tx = plotEnd + 6;
        for (let pc = 0; pc < 12; pc++) {
          const len = (totals[pc] / maxT) * TOTAL_W;
          g.fillStyle = scale[0] === pc ? '#f5a524' : scale.includes(pc) ? 'rgba(45,212,191,0.9)' : 'rgba(255,255,255,0.22)';
          g.fillRect(tx, height - (pc + 1) * rowH + 1.5, Math.max(1, len), Math.max(1, rowH - 3));
        }
        g.fillStyle = 'rgba(255,255,255,0.5)';
        g.font = '600 8px IBM Plex Mono, monospace';
        g.textBaseline = 'middle';
        g.fillText('TOTAL', tx, LANE / 2);
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
      {noteMap && noteMap.some(c => c) && (
        <div className="settings-field-sub" style={{ marginTop: 3 }}>
          How to read it: a key uses 7 of the 12 notes. Rows that stay dark are notes the song leaves out; the bright
          rows that are left are the key. Right edge: each note’s total over the song (the key’s notes long, home note in
          orange). Top band: the key each part of the song sounds like (same-note keys like D and Bm share a band).
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
  // Most likely keys, best first, with how well each fits and what it means.
  const ranked = (() => {
    if (!heard) return [] as Array<{ key: KeyName; fit: number; note: string }>;
    let cands: Array<{ key: KeyName; score: number }> = [];
    if (heard.profile) {
      try { cands = rescoreProfile(heard.profile, learnedKeyParams()).candidates; } catch { /* fall through */ }
    }
    if (cands.length === 0) cands = [heard.key, ...(heard.candidates ?? [])].map((k, i) => ({ key: k, score: 1 - i * 0.1 }));
    const seen = new Set<KeyName>();
    cands = cands.filter(c => (seen.has(c.key) ? false : (seen.add(c.key), true))).slice(0, 4);
    const best = cands[0];
    const lo = Math.min(...cands.map(c => c.score));
    return cands.map((c, i) => {
      const fit = best.score > lo ? Math.round(35 + 65 * (c.score - lo) / (best.score - lo)) : 100;
      let note = i === 0 ? 'Most likely' : '';
      if (i > 0) {
        const rel = keyRelation(best.key, c.key);
        note = rel === 'relative' ? `Same notes as ${displayKey(best.key, keyMode)}: either works for the pad`
          : rel === 'fifth' ? `Next-door key to ${displayKey(best.key, keyMode)} (one note different)`
          : rel === 'parallel' ? `Same home note as ${displayKey(best.key, keyMode)}, ${isMajor(c.key) ? 'major' : 'minor'}`
          : 'Less likely';
      }
      return { key: c.key, fit, note };
    });
  })();

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
        {heard && ranked.length > 0 && (
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto auto minmax(80px, 160px) 1fr', gap: '4px 10px', alignItems: 'center' }}>
            {ranked.map((r, i) => (
              <React.Fragment key={r.key}>
                {chip(r.key, '', i === 0 ? 'Most likely key. Click to use it.' : 'Click to use this key.', r.key === currentKey)}
                <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 11, opacity: 0.7 }} title="Camelot number (the Pad player shows these)">{camelotOf(r.key)}</span>
                <div style={{ height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }} title={`${r.fit}% of the best fit`}>
                  <div style={{ width: `${r.fit}%`, height: '100%', background: i === 0 ? 'var(--accent-bright, #2dd4bf)' : 'rgba(255,255,255,0.35)' }} />
                </div>
                <span className="settings-field-sub">{r.note}</span>
              </React.Fragment>
            ))}
          </div>
        )}
        {heard?.endKey && (
          <div className="pp-actions" style={{ flexWrap: 'wrap', marginTop: 6 }}>
            {chip(heard.endKey, 'ends ', 'The last 30 seconds sound like this key (the song may change key). Click to use it for landing.')}
            <span className="settings-field-sub">The ending sounds like a different key; use it if the song modulates before it lands.</span>
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
