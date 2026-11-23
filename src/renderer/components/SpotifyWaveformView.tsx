import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SpotifyPlaylistTrack, SpotifyTrackEdit, SpotifyWaveform } from '@shared/types';
import { useAppStore } from '../state/store';
import { songBounds } from '../lib/spotifyTestRun';
import { waveformScanner, useWaveformScan } from '../lib/spotifyWaveformScan';

type Marker = 'trimStartSec' | 'trimEndSec' | 'landSec';
const HEIGHT = 84;
const GRAB_PX = 8;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * A Spotify song's waveform with its Start, End and 0:00 markers.
 * Drag a marker to move it; click anywhere else to play from there.
 * The waveform comes from Settings › Spotify › Draw waveforms; until a
 * song has played through it shows a plain timeline (markers still work).
 * Only edits marks: never changes how a service is timed by itself.
 */
export function SpotifyWaveformView({ track, edit, onChange }: {
  track: SpotifyPlaylistTrack;
  edit: SpotifyTrackEdit;
  onChange: (e: SpotifyTrackEdit) => void;
}) {
  const durSec = track.durationMs / 1000;
  const waveformsOn = useAppStore(s => !!s.config.spotify?.waveforms);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const [wave, setWave] = useState<SpotifyWaveform | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ marker: Marker; sec: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const scan = useWaveformScan();
  const scanningThis = scan.running && scan.total === 1 && scan.title === track.title;

  // Size to the panel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Waveform (refreshed while it's still filling in) and Spotify's playhead.
  useEffect(() => {
    let alive = true;
    let lastWave = 0;
    const tick = async () => {
      try {
        const st = await window.runway.spotify.player({ op: 'state' });
        if (!alive) return;
        const onThis = st.ok && st.trackUri === track.uri && st.positionSec !== undefined;
        setPlayhead(onThis ? st.positionSec! : null);
        const now = Date.now();
        if (now - lastWave > (onThis && st.playerState === 'playing' ? 2000 : 10_000)) {
          lastWave = now;
          const w = await window.runway.spotify.waveform(track.uri);
          if (alive) setWave(w);
        }
      } catch { /* Spotify closed: try again next tick */ }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 300);
    return () => { alive = false; window.clearInterval(t); };
  }, [track.uri]);

  const b = songBounds(durSec, edit);
  const markerSec = (m: Marker): number | null => {
    if (drag?.marker === m) return drag.sec;
    if (m === 'trimStartSec') return b.start;
    if (m === 'trimEndSec') return b.end;
    return edit.landSec ?? null;
  };
  const xOf = useCallback((sec: number) => (sec / durSec) * width, [durSec, width]);
  const secOf = useCallback((x: number) => Math.max(0, Math.min(durSec, (x / width) * durSec)), [durSec, width]);

  // Draw.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = HEIGHT * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(c);
    const accent = css.getPropertyValue('--accent-bright').trim() || '#2dd4bf';
    const faint = css.getPropertyValue('--text-faint').trim() || '#666';
    g.clearRect(0, 0, width, HEIGHT);
    const mid = HEIGHT / 2;

    const start = markerSec('trimStartSec') ?? 0;
    const end = markerSec('trimEndSec') ?? durSec;

    // Waveform columns (max of the bins under each pixel).
    let maxPeak = 0;
    if (wave) for (const v of wave.peaks) if (v > maxPeak) maxPeak = v;
    const scale = maxPeak > 0 ? 1 / maxPeak : 1;
    for (let x = 0; x < width; x++) {
      const s0 = secOf(x), s1 = secOf(x + 1);
      let v = -1;
      if (wave) {
        const i0 = Math.floor(s0 / wave.binSec), i1 = Math.max(i0, Math.floor(s1 / wave.binSec));
        for (let i = i0; i <= i1 && i < wave.peaks.length; i++) v = Math.max(v, wave.peaks[i]);
      }
      const inside = s1 >= start && s0 <= end;
      if (v < 0) {
        g.fillStyle = faint;
        g.globalAlpha = 0.35;
        g.fillRect(x, mid - 0.5, 1, 1);
      } else {
        const h = Math.max(1, Math.sqrt(v * scale) * (HEIGHT / 2 - 4));
        g.fillStyle = inside ? accent : faint;
        g.globalAlpha = inside ? 0.85 : 0.35;
        g.fillRect(x, mid - h, 1, h * 2);
      }
    }
    g.globalAlpha = 1;

    // Markers.
    const line = (sec: number, color: string, label: string) => {
      const x = Math.round(xOf(sec)) + 0.5;
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, HEIGHT); g.stroke();
      g.fillStyle = color;
      g.font = '600 10px IBM Plex Mono, monospace';
      const tw = g.measureText(label).width;
      const lx = Math.min(width - tw - 4, Math.max(2, x + 3));
      g.fillText(label, lx, 11);
    };
    line(start, '#22c55e', 'Start');
    line(end, '#ef4444', 'End');
    const land = markerSec('landSec');
    if (land !== null) line(land, '#f5a524', '0:00');
    if (playhead !== null) {
      const x = Math.round(xOf(playhead)) + 0.5;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, HEIGHT); g.stroke();
    }
  }, [wave, width, playhead, drag, edit, durSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const nearMarker = (x: number): Marker | null => {
    let best: Marker | null = null;
    let bestD = GRAB_PX + 1;
    for (const m of ['landSec', 'trimEndSec', 'trimStartSec'] as Marker[]) {
      const s = markerSec(m);
      if (s === null) continue;
      const d = Math.abs(xOf(s) - x);
      if (d < bestD) { best = m; bestD = d; }
    }
    return bestD <= GRAB_PX ? best : null;
  };

  const localX = (e: React.PointerEvent) => e.clientX - (canvasRef.current?.getBoundingClientRect().left ?? 0);

  const playFrom = async (sec: number) => {
    setNote(null);
    let st = await window.runway.spotify.player({ op: 'state' });
    if (!(st.ok && st.trackUri === track.uri)) {
      const r = await window.runway.spotify.player({ op: 'play', uri: track.uri });
      if (!r.ok) { setNote(r.reason ?? 'Couldn’t play in Spotify.'); return; }
      if (!r.wasFrontmost) window.setTimeout(() => { void window.runway.spotify.player({ op: 'background' }); }, 800);
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        st = await window.runway.spotify.player({ op: 'state' });
        if (st.ok && st.trackUri === track.uri && st.playerState === 'playing') break;
        await sleep(100);
      }
    } else if (st.playerState !== 'playing') {
      await window.runway.spotify.player({ op: 'resume' });
    }
    await window.runway.spotify.player({ op: 'seek', positionSec: sec });
  };

  const onDown = (e: React.PointerEvent) => {
    const x = localX(e);
    const m = nearMarker(x);
    if (m) {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDrag({ marker: m, sec: secOf(x) });
    } else {
      void playFrom(Math.round(secOf(x) * 10) / 10);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const x = localX(e);
    if (drag) {
      let s = secOf(x);
      if (drag.marker === 'trimStartSec') s = Math.min(s, b.end - 1);
      if (drag.marker === 'trimEndSec') s = Math.max(s, b.start + 1);
      setDrag({ ...drag, sec: s });
    } else if (canvasRef.current) {
      canvasRef.current.style.cursor = nearMarker(x) ? 'ew-resize' : 'pointer';
    }
  };
  const onUp = () => {
    if (!drag) return;
    const v = Math.round(drag.sec * 10) / 10;
    const next: SpotifyTrackEdit = { ...edit };
    // Start at 0 / End at the song's end are the defaults: store them as unset.
    if (drag.marker === 'trimStartSec') next.trimStartSec = v <= 0.05 ? undefined : v;
    else if (drag.marker === 'trimEndSec') next.trimEndSec = v >= durSec - 0.05 ? undefined : v;
    else next.landSec = v;
    setDrag(null);
    onChange(next);
  };

  const coverage = wave?.coverage ?? 0;
  return (
    <div ref={wrapRef} style={{ marginBottom: 10 }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT, display: 'block', borderRadius: 6, background: 'var(--bg-elev-2, rgba(255,255,255,0.03))', touchAction: 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => setDrag(null)}
      />
      <div className="settings-field-sub" style={{ display: 'flex', gap: 12, marginTop: 4 }}>
        <span>{drag ? `${drag.marker === 'trimStartSec' ? 'Start' : drag.marker === 'trimEndSec' ? 'End' : '0:00'} ${mmss(drag.sec)}` : 'Drag Start, End or 0:00. Click to play from there.'}</span>
        {waveformsOn && (scanningThis
          ? <button className="btn-secondary" onClick={() => waveformScanner.stop()}>Stop scan</button>
          : <button
              className="btn-secondary"
              disabled={scan.running}
              onClick={() => void waveformScanner.start([track], { force: true })}
              title={scan.running ? 'Another scan is running' : 'Plays this song start to finish to draw its waveform. You can mute your Mac.'}
            >
              {coverage >= 0.95 ? 'Re-scan this song' : 'Scan this song'}
            </button>)}
        <span style={{ marginLeft: 'auto' }}>
          {scanningThis ? 'Scanning: plays the song start to finish…'
            : !waveformsOn
            ? 'Turn on Settings › Spotify › Draw waveforms to see this song’s shape.'
            : coverage === 0 ? 'No waveform yet: play the song through, or use Scan waveforms.'
            : coverage < 0.95 ? `Waveform ${Math.round(coverage * 100)}% heard.` : ''}
        </span>
      </div>
      {note && <div className="pp-status err">{note}</div>}
    </div>
  );
}
