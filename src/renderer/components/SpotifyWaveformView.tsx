import React, { useEffect, useRef, useState } from 'react';
import type { SpotifyPlaylistTrack, SpotifyTrackEdit, SpotifyWaveform } from '@shared/types';
import { useAppStore } from '../state/store';
import { formatDuration } from '../lib/format';
import { waveformScanner, useWaveformScan } from '../lib/spotifyWaveformScan';
import { DragHandle, ServiceLandHandle, formatPreciseTime } from '../views/EditorView';

const HEIGHT = 150;
const ZOOM_MAX_X = 64;
const ZOOM_MAX_Y = 8;
const ZOOM_FACTOR = 1.4;
const COMMIT_MS = 350;   // save a drag shortly after it settles, not on every pixel

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Draft { start: number; end: number; fadeIn: number; fadeOut: number; land: number | null }

function draftOf(edit: SpotifyTrackEdit, dur: number): Draft {
  return {
    start: edit.trimStartSec ?? 0,
    end: edit.trimEndSec ?? dur,
    fadeIn: edit.fadeInSec ?? 0,
    fadeOut: edit.fadeOutSec ?? 0,
    land: edit.landSec ?? null,
  };
}

/**
 * The audio editor, for a Spotify song. Same controls as Editor for your own
 * tracks:
 *   - drag the Start / End handles; Shift+drag a handle to set its fade
 *   - Option-click the waveform to drop the 0:00 (timer end) marker; drag it
 *   - click to play from a spot; Space plays / pauses; Enter plays from Start
 *   - + / − / 0 zoom time, Shift with them zooms height; scroll when zoomed
 * Playback goes through the Spotify app, with the fades heard in the preview.
 * Saves the same Start / End / Fade / 0:00 fields as the boxes below it, so
 * nothing about service timing changes.
 */
export function SpotifyWaveformView({ track, edit, onChange }: {
  track: SpotifyPlaylistTrack;
  edit: SpotifyTrackEdit;
  onChange: (e: SpotifyTrackEdit) => void;
}) {
  const dur = track.durationMs / 1000;
  const waveformsOn = useAppStore(s => !!s.config.spotify?.waveforms);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [wave, setWave] = useState<SpotifyWaveform | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const scan = useWaveformScan();
  const scanningThis = scan.running && scan.total === 1 && scan.uri === track.uri;

  // ── Edits: local while dragging, saved shortly after ──────────────────
  const [d, setD] = useState<Draft>(() => draftOf(edit, dur));
  const committed = useRef(JSON.stringify(draftOf(edit, dur)));
  useEffect(() => {
    // Typed in the boxes below (or cleared): follow.
    const incoming = JSON.stringify(draftOf(edit, dur));
    if (incoming !== committed.current) { committed.current = incoming; setD(draftOf(edit, dur)); }
  }, [edit, dur]);
  useEffect(() => {
    const s = JSON.stringify(d);
    if (s === committed.current) return;
    const t = window.setTimeout(() => {
      committed.current = s;
      const r = (v: number) => Math.round(v * 10) / 10;
      onChange({
        ...edit,
        trimStartSec: d.start > 0.05 ? r(d.start) : undefined,
        trimEndSec: d.end < dur - 0.05 ? r(d.end) : undefined,
        fadeInSec: d.fadeIn > 0.05 ? r(d.fadeIn) : undefined,
        fadeOutSec: d.fadeOut > 0.05 ? r(d.fadeOut) : undefined,
        landSec: d.land !== null ? r(d.land) : undefined,
      });
    }, COMMIT_MS);
    return () => window.clearTimeout(t);
  }, [d]); // eslint-disable-line react-hooks/exhaustive-deps
  const patch = (p: Partial<Draft>) => setD(cur => ({ ...cur, ...p }));

  // ── Zoom ──────────────────────────────────────────────────────────────
  const [zoomX, setZoomX] = useState(1);
  const [scrollX, setScrollX] = useState(0);   // 0 … zoomX − 1
  const [zoomY, setZoomY] = useState(1);

  // ── Spotify playhead (polled, smoothed between polls) ─────────────────
  const [ph, setPh] = useState<{ pos: number; at: number; playing: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  const preview = useRef<{ origVol: number; lastVol: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let alive = true;
    let lastWave = 0;
    const tick = async () => {
      try {
        const st = await window.runway.spotify.player({ op: 'state' });
        if (!alive) return;
        const onThis = st.ok && st.trackUri === track.uri && st.positionSec !== undefined;
        setPh(onThis ? { pos: st.positionSec!, at: Date.now(), playing: st.playerState === 'playing' } : null);
        if (!onThis && preview.current) void endPreview(false);
        const t = Date.now();
        if (t - lastWave > (onThis && st.playerState === 'playing' ? 1000 : 10_000)) {
          lastWave = t;
          const w = await window.runway.spotify.waveform(track.uri);
          if (alive) setWave(w);
        }
      } catch { /* Spotify closed: try again */ }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 300);
    return () => { alive = false; window.clearInterval(t); };
  }, [track.uri]); // eslint-disable-line react-hooks/exhaustive-deps

  // Smooth playhead animation.
  useEffect(() => {
    if (!ph?.playing) return;
    let raf = 0;
    const loop = () => { setNow(Date.now()); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [ph?.playing]);
  const playhead = ph ? Math.min(dur, ph.pos + (ph.playing ? (now - ph.at) / 1000 : 0)) : null;

  // Preview: hear the fades, stop at End (like the audio editor's preview).
  useEffect(() => {
    const p = preview.current;
    if (!p || playhead === null || !ph?.playing) return;
    if (playhead >= d.end - 0.05) { void endPreview(true); return; }
    let g = 1;
    if (playhead >= d.start && d.fadeIn > 0) g = Math.min(g, Math.max(0, (playhead - d.start) / d.fadeIn));
    if (d.fadeOut > 0) g = Math.min(g, Math.max(0, (d.end - playhead) / d.fadeOut));
    const vol = Math.round(p.origVol * g);
    if (vol !== p.lastVol) {
      p.lastVol = vol;
      void window.runway.spotify.player({ op: 'volume', volume: vol });
    }
  }, [now, ph]); // eslint-disable-line react-hooks/exhaustive-deps

  const endPreview = async (pause: boolean) => {
    const p = preview.current;
    if (!p) return;
    preview.current = null;
    setPreviewing(false);
    if (pause) await window.runway.spotify.player({ op: 'pause' });
    await window.runway.spotify.player({ op: 'volume', volume: p.origVol });
  };
  // Leaving the editor mid-preview puts Spotify's volume back.
  useEffect(() => () => { void endPreview(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const playFrom = async (sec: number) => {
    setNote(null);
    let st = await window.runway.spotify.player({ op: 'state' });
    if (!preview.current) {
      const v = st.ok && st.volume !== undefined && st.volume > 0 ? st.volume : 70;
      preview.current = { origVol: v, lastVol: v };
    }
    setPreviewing(true);
    if (!(st.ok && st.trackUri === track.uri)) {
      const r = await window.runway.spotify.player({ op: 'play', uri: track.uri });
      if (!r.ok) { setNote(r.reason ?? 'Couldn’t play in Spotify.'); void endPreview(false); return; }
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
    await window.runway.spotify.player({ op: 'seek', positionSec: Math.max(0, sec) });
    setPh({ pos: sec, at: Date.now(), playing: true });
  };
  const pause = async () => {
    await window.runway.spotify.player({ op: 'pause' });
    await endPreview(false);
    setPh(p => (p ? { pos: p.pos + (p.playing ? (Date.now() - p.at) / 1000 : 0), at: Date.now(), playing: false } : p));
  };
  const isPlaying = !!ph?.playing;
  const togglePlay = () => {
    if (isPlaying) void pause();
    else void playFrom(playhead !== null && playhead >= d.start && playhead < d.end ? playhead : d.start);
  };

  // ── Keys: same as the audio editor ────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'BUTTON')) return;
      const k = e.key;
      if (k === '=' || k === '+' || k === '-' || k === '_' || k === '0') {
        e.preventDefault();
        const plus = k === '=' || k === '+';
        const minus = k === '-' || k === '_';
        if (e.shiftKey) {
          if (plus) setZoomY(z => Math.min(ZOOM_MAX_Y, +(z * ZOOM_FACTOR).toFixed(3)));
          else if (minus) setZoomY(z => Math.max(0.25, +(z / ZOOM_FACTOR).toFixed(3)));
          else setZoomY(1);
        } else if (plus) zoomTo(Math.min(ZOOM_MAX_X, +(zoomX * ZOOM_FACTOR).toFixed(3)));
        else if (minus) zoomTo(Math.max(1, +(zoomX / ZOOM_FACTOR).toFixed(3)));
        else { setZoomX(1); setScrollX(0); }
        return;
      }
      if (e.code === 'Space' || k === ' ') { e.preventDefault(); togglePlay(); return; }
      if (k === 'Enter') { e.preventDefault(); void playFrom(d.start); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const zoomTo = (next: number) => {
    setZoomX(next);
    if (next <= 1) { setScrollX(0); return; }
    const focus = (playhead ?? d.start) / dur;
    const vis = 1 / next;
    setScrollX(Math.max(0, Math.min(next - 1, (focus - vis / 2) * next)));
  };

  // ── Geometry (same mapping as the audio editor) ───────────────────────
  const secToPct = (sec: number) => ((sec / dur) * zoomX - scrollX) * 100;
  const pxToSec = (px: number, w: number) => Math.max(0, Math.min(dur, ((px / w + scrollX) / zoomX) * dur));

  // ── Draw ──────────────────────────────────────────────────────────────
  const [sizeTick, setSizeTick] = useState(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSizeTick(t => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const c = canvasRef.current;
    const box = containerRef.current;
    if (!c || !box) return;
    const w = box.clientWidth, h = HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const mid = h / 2;
    const x = (sec: number) => (secToPct(sec) / 100) * w;

    let maxPeak = 0;
    if (wave) for (const v of wave.peaks) if (v > maxPeak) maxPeak = v;
    const norm = maxPeak > 0 ? 1 / maxPeak : 1;
    const amp = (h / 2 - 4) * zoomY;
    for (let px = 0; px < w; px++) {
      const s0 = pxToSec(px, w), s1 = pxToSec(px + 1, w);
      let v = -1;
      if (wave) {
        const i0 = Math.floor(s0 / wave.binSec), i1 = Math.max(i0, Math.floor(s1 / wave.binSec));
        for (let i = i0; i <= i1 && i < wave.peaks.length; i++) v = Math.max(v, wave.peaks[i]);
      }
      const inside = s1 >= d.start && s0 <= d.end;
      if (v < 0) {
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fillRect(px, mid - 0.5, 1, 1);
        continue;
      }
      const hh = Math.min(h / 2, Math.max(0.5, v * norm * amp));
      g.fillStyle = inside ? '#14b8a6' : 'rgba(255,255,255,0.18)';
      g.fillRect(px, mid - hh, 1, hh * 2);
    }
    // Fade ramps (amber), as in the audio editor.
    g.strokeStyle = 'rgba(245, 158, 11, 0.7)';
    g.lineWidth = 1.5;
    if (d.fadeIn > 0) { g.beginPath(); g.moveTo(x(d.start), h - 1); g.lineTo(x(d.start + d.fadeIn), 1); g.stroke(); }
    if (d.fadeOut > 0) { g.beginPath(); g.moveTo(x(d.end - d.fadeOut), 1); g.lineTo(x(d.end), h - 1); g.stroke(); }
    g.fillStyle = '#14b8a6';
    g.fillRect(x(d.start) - 1, 0, 2, h);
    g.fillRect(x(d.end) - 1, 0, 2, h);
  }, [wave, d, zoomX, zoomY, scrollX, sizeTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const coverage = wave?.coverage ?? 0;
  const trimLen = Math.max(0, d.end - d.start);
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="pp-actions" style={{ marginBottom: 6 }}>
        <button className="btn-primary" onClick={togglePlay} style={{ minWidth: 120 }}>
          {isPlaying ? '◼ Stop' : '▶ Preview'}
        </button>
        {d.land === null ? (
          <button
            className="btn-secondary"
            onClick={() => patch({ land: playhead !== null && playhead >= d.start && playhead <= d.end ? playhead : d.end })}
            title="Mark where the countdown hits 0:00. Or Option-click the waveform."
          >
            + 0:00 marker
          </button>
        ) : (
          <button className="btn-secondary" onClick={() => patch({ land: null })} title="Remove the 0:00 marker">✕ Clear 0:00 marker</button>
        )}
        <div className="editor-zoom-group">
          <span className="editor-zoom-label">Time</span>
          <button className="editor-zoom-btn" onClick={() => zoomTo(Math.max(1, +(zoomX / ZOOM_FACTOR).toFixed(3)))} title="Zoom out (-)">−</button>
          <span className="editor-zoom-value">{zoomX.toFixed(1)}×</span>
          <button className="editor-zoom-btn" onClick={() => zoomTo(Math.min(ZOOM_MAX_X, +(zoomX * ZOOM_FACTOR).toFixed(3)))} title="Zoom in (+)">+</button>
          <button className="editor-zoom-btn" onClick={() => { setZoomX(1); setScrollX(0); }} title="Reset (0)">⟲</button>
        </div>
        <div className="editor-zoom-group">
          <span className="editor-zoom-label">Amp</span>
          <button className="editor-zoom-btn" onClick={() => setZoomY(z => Math.max(0.25, +(z / ZOOM_FACTOR).toFixed(3)))} title="Height zoom out (Shift+-)">−</button>
          <span className="editor-zoom-value">{zoomY.toFixed(1)}×</span>
          <button className="editor-zoom-btn" onClick={() => setZoomY(z => Math.min(ZOOM_MAX_Y, +(z * ZOOM_FACTOR).toFixed(3)))} title="Height zoom in (Shift++)">+</button>
          <button className="editor-zoom-btn" onClick={() => setZoomY(1)} title="Reset (Shift+0)">⟲</button>
        </div>
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
      </div>

      <div
        ref={containerRef}
        className="editor-canvas-frame"
        style={{ height: HEIGHT, flex: 'none' }}
        onClick={e => {
          const t = e.target as HTMLElement;
          if (t.closest('.editor-handle') || t.closest('.editor-marker')) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const sec = pxToSec(e.clientX - rect.left, rect.width);
          if (e.altKey) { patch({ land: Math.max(d.start, Math.min(d.end, sec)) }); return; }
          void playFrom(sec);
        }}
        onWheel={e => {
          if (zoomX <= 1) return;
          const delta = (e.deltaX !== 0 ? e.deltaX : e.deltaY) / 800;
          setScrollX(prev => Math.max(0, Math.min(zoomX - 1, prev + delta * zoomX)));
        }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        <DragHandle
          side="left"
          pct={secToPct(d.start)}
          container={containerRef}
          pxToSec={pxToSec}
          trimStart={d.start}
          trimEnd={d.end}
          fadeSec={d.fadeIn}
          onTrimChange={v => patch({ start: Math.max(0, Math.min(d.end - 0.1, v)) })}
          onFadeChange={v => patch({ fadeIn: Math.max(0, Math.min(20, v)) })}
          label={formatDuration(d.start)}
        />
        <DragHandle
          side="right"
          pct={secToPct(d.end)}
          container={containerRef}
          pxToSec={pxToSec}
          trimStart={d.start}
          trimEnd={d.end}
          fadeSec={d.fadeOut}
          onTrimChange={v => patch({ end: Math.max(d.start + 0.1, Math.min(dur, v)) })}
          onFadeChange={v => patch({ fadeOut: Math.max(0, Math.min(20, v)) })}
          label={formatDuration(d.end)}
        />
        {d.land !== null && (
          <ServiceLandHandle
            pct={secToPct(d.land)}
            container={containerRef}
            pxToSec={pxToSec}
            trimStart={d.start}
            trimEnd={d.end}
            onChange={v => patch({ land: Math.max(d.start, Math.min(d.end, v)) })}
            label={formatDuration(d.land)}
          />
        )}
        {playhead !== null && (
          <div className={`editor-playhead ${isPlaying ? 'playing' : ''}`} style={{ left: `${secToPct(playhead)}%` }}>
            <div className="editor-playhead-triangle" />
          </div>
        )}
        {isPlaying && playhead !== null && (
          <div className="editor-timecode">
            {formatPreciseTime(Math.max(0, playhead - d.start))} / {formatPreciseTime(trimLen)}
          </div>
        )}
        {(!wave || coverage === 0) && (
          <div className="editor-empty" style={{ pointerEvents: 'none' }}>
            {!waveformsOn ? 'Turn on Settings › Spotify › Draw waveforms to see this song’s shape'
              : 'No waveform yet: play the song through, or Scan this song'}
          </div>
        )}
      </div>

      <div className="settings-field-sub" style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
        <span>
          Drag Start / End. Shift+drag for fades. Option-click for 0:00. Click to play from there.
          Space play/stop, Enter from Start, + / − zoom.
        </span>
        <span style={{ marginLeft: 'auto' }}>
          Trim length · {formatDuration(trimLen)}{trimLen < dur - 0.05 ? ` / original ${formatDuration(dur)}` : ''}
          {scanningThis ? ' · scanning…' : coverage > 0 && coverage < 0.95 ? ` · waveform ${Math.round(coverage * 100)}% heard` : ''}
          {previewing ? ' · preview plays your fades' : ''}
        </span>
      </div>
      {note && <div className="pp-status err">{note}</div>}
    </div>
  );
}
