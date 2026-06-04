import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { formatDuration } from '../lib/format';
import { filePathToUrl } from '../lib/audioEngine';
import type { Track } from '@shared/types';

/**
 * Non-destructive audio editor — pick a track, set trim points and fades,
 * preview, and save the edits to the track record. The source file is never
 * modified; trim/fade are applied at playback time.
 *
 * Decoded buffers come from the same audio engine that drives playback so we
 * don't decode twice and so format quirks behave consistently.
 */
type TrackFilter = 'inPlaylists' | 'library' | 'all';

export function EditorView() {
  const allTracks = useAppStore(s => s.config.tracks);
  const playlists = useAppStore(s => s.config.playlists);
  const updateTrack = useAppStore(s => s.updateTrack);
  const { audio } = useEngines();

  const [trackId, setTrackId] = useState<string>('');
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [audioDir, setAudioDir] = useState<string>('');
  const [filter, setFilter] = useState<TrackFilter>('inPlaylists');

  useEffect(() => {
    if (!window.runway?.files?.libraryPaths) return;
    window.runway.files.libraryPaths()
      .then(p => setAudioDir(p.audioDir))
      .catch(err => console.warn('[editor] libraryPaths IPC missing — restart app to filter:', err));
  }, []);

  // Consume any pending track id (set when user clicks Edit on a playlist row).
  const pendingEditorTrackId = useAppStore(s => s.pendingEditorTrackId);
  const consumePendingEditorTrackId = useAppStore(s => s.consumePendingEditorTrackId);
  useEffect(() => {
    const id = consumePendingEditorTrackId();
    if (id) {
      setTrackId(id);
      // openEditor is only called from the playlist track-row Edit button,
      // so the track is always in a playlist — no need to widen the filter.
      // Earlier we forced 'all' here, which surfaced every orphan track in
      // the library and made the picker unusable for users with big scans.
    }
  }, [pendingEditorTrackId, consumePendingEditorTrackId]);

  const tracks = useMemo(() => {
    if (filter === 'all') return allTracks;
    if (filter === 'library') {
      if (!audioDir) return allTracks;
      const sep = audioDir.endsWith('/') ? audioDir : audioDir + '/';
      return allTracks.filter(t => t.filePath.startsWith(sep));
    }
    // inPlaylists — only tracks referenced by at least one playlist
    const usedIds = new Set<string>();
    playlists.forEach(p => p.trackIds.forEach(id => usedIds.add(id)));
    return allTracks.filter(t => usedIds.has(t.id));
  }, [allTracks, audioDir, filter, playlists]);
  const hiddenCount = allTracks.length - tracks.length;

  const [startSec, setStartSec] = useState(0);
  const [endSec, setEndSec] = useState(0);
  const [fadeInSec, setFadeInSec] = useState(0);
  const [fadeOutSec, setFadeOutSec] = useState(0);
  // null = no marker (timer lands on trim end, current default).
  // A number = source-file position where the timer hits zero; track keeps
  // playing past it as a tail.
  const [landSec, setLandSec] = useState<number | null>(null);

  const previewSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const previewGainRef = useRef<GainNode | null>(null);
  const previewStartCtxTimeRef = useRef<number>(0);
  const previewStartBufferOffsetRef = useRef<number>(0);
  const [previewing, setPreviewing] = useState(false);
  const [playheadSec, setPlayheadSec] = useState<number>(0);

  // Zoom state. zoomX = horizontal (time) magnification, zoomY = vertical
  // (amplitude) magnification. scrollX is in unitless 0..1 (% of virtual width).
  const [zoomX, setZoomX] = useState(1);
  const [scrollX, setScrollX] = useState(0);
  const [zoomY, setZoomY] = useState(1);

  const ZOOM_MIN = 1;
  const ZOOM_MAX_X = 64;
  const ZOOM_MAX_Y = 8;
  const ZOOM_FACTOR = 1.4;

  // Re-center the visible window on the playhead after a zoom change.
  // Without this, zooming in always anchored to the left edge — when the
  // playhead was at, say, 2:30 in a 3:00 track and you zoomed in, the
  // playhead would scroll out of view immediately and you'd have to
  // hand-scroll back to it.
  const recenterOnPlayhead = (nextZoom: number) => {
    if (!buffer || buffer.duration <= 0) return;
    if (nextZoom <= 1) { setScrollX(0); return; }
    const playheadFrac = Math.max(0, Math.min(1, playheadSec / buffer.duration));
    const visibleFrac = 1 / nextZoom;
    const newScroll = Math.max(0, Math.min(1 - visibleFrac, playheadFrac - visibleFrac / 2));
    setScrollX(newScroll);
  };
  const zoomXIn = () => {
    const next = Math.min(ZOOM_MAX_X, +(zoomX * ZOOM_FACTOR).toFixed(3));
    setZoomX(next);
    recenterOnPlayhead(next);
  };
  const zoomXOut = () => {
    const next = Math.max(ZOOM_MIN, +(zoomX / ZOOM_FACTOR).toFixed(3));
    setZoomX(next);
    recenterOnPlayhead(next);
  };
  const zoomYIn = () => setZoomY(z => Math.min(ZOOM_MAX_Y, +(z * ZOOM_FACTOR).toFixed(3)));
  const zoomYOut = () => setZoomY(z => Math.max(0.25, +(z / ZOOM_FACTOR).toFixed(3)));
  const resetZoomX = () => { setZoomX(1); setScrollX(0); };
  const resetZoomY = () => setZoomY(1);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const selectedTrack = allTracks.find(t => t.id === trackId);

  // Load buffer when track changes — reuse the audio engine's cache.
  useEffect(() => {
    setBuffer(null);
    setError(null);
    setSaveStatus(null);
    if (!selectedTrack) {
      setStartSec(0); setEndSec(0); setFadeInSec(0); setFadeOutSec(0);
      return;
    }
    setLoading(true);
    let cancelled = false;
    (async () => {
      // Fetch the file directly so we can give a precise error if it's missing
      // or empty, before handing bytes to decodeAudioData.
      try {
        const url = filePathToUrl(selectedTrack.filePath);
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(
            `File not reachable (HTTP ${res.status}). The track may have been moved or deleted. Path: ${selectedTrack.filePath}`,
          );
        }
        const ab = await res.arrayBuffer();
        if (ab.byteLength < 1024) {
          throw new Error(`File appears empty or truncated (${ab.byteLength} bytes).`);
        }
        const ctx = audio.getContextForEditor();
        let buf: AudioBuffer;
        try {
          buf = await ctx.decodeAudioData(ab.slice(0));
        } catch (decodeErr) {
          throw new Error(
            `Web Audio can't decode this file. Some MP3 rips (especially YouTube/lyric video downloads) ` +
            `are container formats Chromium doesn't accept. Try re-encoding with ffmpeg: ` +
            `"ffmpeg -i source.mp3 -c:a libmp3lame -b:a 192k clean.mp3"`,
          );
        }
        if (cancelled) return;
        setBuffer(buf);
        setStartSec(selectedTrack.trimStartSec ?? 0);
        setEndSec(selectedTrack.trimEndSec ?? buf.duration);
        setFadeInSec(selectedTrack.editFadeInSec ?? 0);
        setFadeOutSec(selectedTrack.editFadeOutSec ?? 0);
        setLandSec(selectedTrack.editServiceLandSec ?? null);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setError(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Depend on filePath too — relinking the track to a different file
    // changes the path while keeping the same trackId, and we need the
    // buffer to reload from the new file.
  }, [trackId, selectedTrack?.filePath, audio]);

  // Draw waveform whenever buffer, trim, or zoom changes.
  useEffect(() => {
    drawWaveform(canvasRef.current, containerRef.current, buffer, {
      startSec,
      endSec,
      fadeInSec,
      fadeOutSec,
      zoomX,
      scrollX,
      zoomY,
    });
  }, [buffer, startSec, endSec, fadeInSec, fadeOutSec, zoomX, scrollX, zoomY]);

  // Redraw on container resize. Without this the waveform stays at
  // its old pixel width when the window resizes, only refreshing when
  // some other state change triggers the render effect above (like
  // grabbing a trim handle).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      drawWaveform(canvasRef.current, containerRef.current, buffer, {
        startSec,
        endSec,
        fadeInSec,
        fadeOutSec,
        zoomX,
        scrollX,
        zoomY,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [buffer, startSec, endSec, fadeInSec, fadeOutSec, zoomX, scrollX, zoomY]);

  // Stop preview if user changes track or unmounts.
  useEffect(() => () => stopPreview(), []);
  useEffect(() => stopPreview(), [trackId]);

  const stopPreview = () => {
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch {}
      previewSourceRef.current = null;
    }
    setPreviewing(false);
  };

  const startPreviewAt = async (atSec: number) => {
    if (!buffer) return;
    if (previewSourceRef.current) {
      try { previewSourceRef.current.stop(); } catch {}
      previewSourceRef.current = null;
    }
    const ctx = audio.getContextForEditor();
    if (ctx.state === 'suspended') await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const gain = ctx.createGain();
    // Route preview through the cue bus so it respects cue level + cue-bus
    // device routing (e.g. headphones) instead of the main FOH output.
    src.connect(gain).connect(audio.getCueOutputNode());

    const start = Math.max(startSec, Math.min(endSec - 0.05, atSec));
    const remaining = Math.max(0.05, endSec - start);
    const now = ctx.currentTime;
    const fullSegLen = Math.max(0.01, endSec - startSec);
    const fIn = Math.min(fadeInSec, fullSegLen / 2);
    const fOut = Math.min(fadeOutSec, fullSegLen / 2);

    // Apply fade-in only if we're starting before the fade-in window ends.
    const segOffset = start - startSec;
    if (fIn > 0 && segOffset < fIn) {
      const remainingFadeIn = fIn - segOffset;
      gain.gain.setValueAtTime(segOffset / fIn, now);
      gain.gain.linearRampToValueAtTime(1, now + remainingFadeIn);
    } else {
      gain.gain.setValueAtTime(1, now);
    }
    // Fade-out always at the end of the segment.
    if (fOut > 0) {
      const fadeStartFromNow = (endSec - fOut) - start;
      if (fadeStartFromNow > 0) {
        gain.gain.setValueAtTime(1, now + fadeStartFromNow);
        gain.gain.linearRampToValueAtTime(0, now + remaining);
      } else {
        // Already inside the fade-out region.
        const fadeProgress = (start - (endSec - fOut)) / fOut;
        gain.gain.setValueAtTime(Math.max(0, 1 - fadeProgress), now);
        gain.gain.linearRampToValueAtTime(0, now + remaining);
      }
    }

    src.start(now, start, remaining);
    src.stop(now + remaining + 0.05);
    src.onended = () => {
      if (previewSourceRef.current === src) {
        previewSourceRef.current = null;
        setPreviewing(false);
      }
    };

    previewSourceRef.current = src;
    previewGainRef.current = gain;
    previewStartCtxTimeRef.current = now;
    previewStartBufferOffsetRef.current = start;
    setPlayheadSec(start);
    setPreviewing(true);
  };

  const onPlayPreview = async () => {
    if (!buffer) return;
    if (previewing) { stopPreview(); return; }
    await startPreviewAt(startSec);
  };

  // Drive the playhead at 60Hz during preview.
  useEffect(() => {
    if (!previewing) return;
    let raf = 0;
    const tick = () => {
      const ctx = audio.getContextForEditor();
      const elapsed = ctx.currentTime - previewStartCtxTimeRef.current;
      const pos = previewStartBufferOffsetRef.current + elapsed;
      setPlayheadSec(Math.min(pos, endSec));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [previewing, audio, endSec]);

  // Spacebar / Enter shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
      if (!buffer) return;
      const isSpace = e.code === 'Space' || e.key === ' ';
      const isEnter = e.code === 'Enter' || e.key === 'Enter';
      const isPlus = e.key === '=' || e.key === '+';
      const isMinus = e.key === '-' || e.key === '_';
      const isZero = e.key === '0';

      if (isPlus || isMinus || isZero) {
        e.preventDefault();
        if (e.shiftKey) {
          // Vertical (amplitude) zoom
          if (isPlus) zoomYIn();
          else if (isMinus) zoomYOut();
          else if (isZero) resetZoomY();
        } else {
          if (isPlus) zoomXIn();
          else if (isMinus) zoomXOut();
          else if (isZero) resetZoomX();
        }
        return;
      }

      if (!isSpace && !isEnter) return;
      e.preventDefault();
      if (isEnter) {
        void startPreviewAt(startSec);
        return;
      }
      if (previewing) stopPreview();
      else void startPreviewAt(playheadSec >= startSec && playheadSec < endSec ? playheadSec : startSec);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewing, buffer, startSec, endSec, playheadSec]);

  // Keep the playhead inside the trim region as it changes.
  useEffect(() => {
    if (previewing) return;
    if (playheadSec < startSec || playheadSec > endSec) {
      setPlayheadSec(startSec);
    }
  }, [startSec, endSec, previewing]);

  // Keep the service-landing marker inside the trim region. If trim shrinks
  // past the marker, snap it back to the new trim end so it stays valid.
  useEffect(() => {
    if (landSec === null) return;
    if (landSec < startSec || landSec > endSec) {
      setLandSec(endSec);
    }
  }, [startSec, endSec, landSec]);

  // When loading a new track, place the playhead at the trim start.
  useEffect(() => {
    setPlayheadSec(startSec);
  }, [trackId, buffer]);

  const onSaveEdit = () => {
    if (!selectedTrack || !buffer) return;
    const start = startSec > 0.01 ? startSec : undefined;
    const end = endSec < buffer.duration - 0.01 ? endSec : undefined;
    const fIn = fadeInSec > 0.01 ? fadeInSec : undefined;
    const fOut = fadeOutSec > 0.01 ? fadeOutSec : undefined;
    // Save the landing marker only when meaningfully different from trimEnd
    // (otherwise it's redundant with the default).
    const land = landSec !== null && landSec < endSec - 0.01 ? landSec : undefined;
    updateTrack(selectedTrack.id, {
      trimStartSec: start,
      trimEndSec: end,
      editFadeInSec: fIn,
      editFadeOutSec: fOut,
      editServiceLandSec: land,
    });
    setSaveStatus('Edit saved · plays trimmed in playlists');
    window.setTimeout(() => setSaveStatus(null), 3000);
  };

  const onResetEdit = () => {
    if (!selectedTrack || !buffer) return;
    setStartSec(0);
    setEndSec(buffer.duration);
    setFadeInSec(0);
    setFadeOutSec(0);
    setLandSec(null);
    updateTrack(selectedTrack.id, {
      trimStartSec: undefined,
      trimEndSec: undefined,
      editFadeInSec: undefined,
      editFadeOutSec: undefined,
      editServiceLandSec: undefined,
    });
    setSaveStatus('Edit cleared · full track restored');
    window.setTimeout(() => setSaveStatus(null), 3000);
  };

  /**
   * Point this track entry at a different audio file. Used after the source
   * file is renamed, moved, or replaced with a re-encode. Copies the picked
   * file into userData/audio (no-op if already inside), refreshes metadata
   * (duration / sample rate), and updates the track. Existing trim / fade /
   * marker edits stay attached to the entry — but if the new file is a
   * different length, the user may need to revisit them.
   */
  const onRelinkFile = async () => {
    if (!selectedTrack || !window.runway) return;
    setError(null);
    try {
      const paths = await window.runway.files.pickAudio(false);
      if (paths.length === 0) return;
      setLoading(true);
      const managedPath = await window.runway.files.importFile(paths[0]);
      const meta = await window.runway.files.readMetadata(managedPath);
      updateTrack(selectedTrack.id, {
        filePath: managedPath,
        durationSec: meta.durationSec ?? selectedTrack.durationSec,
        sampleRate: meta.sampleRate,
      });
      // Buffer reload happens automatically because the load effect depends
      // on selectedTrack.filePath.
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Relink failed: ${msg}`);
      setLoading(false);
    }
  };

  const trimDuration = Math.max(0, endSec - startSec);
  const hasExistingEdit = !!selectedTrack && (
    selectedTrack.trimStartSec !== undefined ||
    selectedTrack.trimEndSec !== undefined ||
    selectedTrack.editFadeInSec !== undefined ||
    selectedTrack.editFadeOutSec !== undefined ||
    selectedTrack.editServiceLandSec !== undefined
  );

  // Map a buffer-second to canvas-percent considering zoom + scroll.
  // virtualWidth = canvasWidth * zoomX. The canvas shows a window of
  // canvasWidth pixels starting at scrollX (in pixels of the virtual width).
  const secToPct = (sec: number): number => {
    if (!buffer || buffer.duration <= 0) return 0;
    // Position in virtual width (0..1)
    const vPos = sec / buffer.duration;
    // Map to canvas-visible range
    return (vPos * zoomX - scrollX) * 100;
  };
  const pxToSec = (px: number, canvasWidth: number): number => {
    if (!buffer || buffer.duration <= 0) return 0;
    const fracOfCanvas = px / canvasWidth;
    return ((fracOfCanvas + scrollX) / zoomX) * buffer.duration;
  };

  const startPct = secToPct(startSec);
  const endPct = secToPct(endSec);
  const playheadPct = secToPct(playheadSec);
  const landPct = landSec !== null ? secToPct(landSec) : null;

  return (
    <div className="editor-view">
      <div className="editor-toolbar">
        <h2 className="editor-title">Audio Editor</h2>
        <span className="editor-subtitle">
          Non-destructive — trim and fades are saved on the track.
        </span>
        <select
          value={trackId}
          onChange={e => setTrackId(e.target.value)}
          className="editor-track-select"
        >
          <option value="">— pick a track —</option>
          {tracks.map(t => (
            <option key={t.id} value={t.id}>
              {t.title}{t.artist ? ` · ${t.artist}` : ''} · {formatDuration(t.durationSec)}
              {(t.trimStartSec !== undefined || t.trimEndSec !== undefined || t.editFadeInSec || t.editFadeOutSec) ? ' · edited' : ''}
            </option>
          ))}
        </select>
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as TrackFilter)}
          className="editor-filter"
          title="Which tracks to show in the picker"
        >
          <option value="inPlaylists">In playlists</option>
          <option value="library">Managed library</option>
          <option value="all">All tracks</option>
        </select>
        {hiddenCount > 0 && (
          <span className="editor-hidden-count">
            {hiddenCount} hidden
          </span>
        )}
        {loading && <span className="editor-status">Loading…</span>}
        {error && (
          <>
            <span className="editor-error">{error}</span>
            {selectedTrack && (
              <button
                className="btn-secondary"
                onClick={() => void onRelinkFile()}
                style={{ padding: '4px 10px', fontSize: 12 }}
                title="Pick a new audio file for this track entry. Use after renaming or moving the source file."
              >
                Relink file…
              </button>
            )}
          </>
        )}

        <div className="editor-zoom-group">
          <span className="editor-zoom-label">Time</span>
          <button className="editor-zoom-btn" onClick={zoomXOut} title="Zoom out (-)">−</button>
          <span className="editor-zoom-value">{zoomX.toFixed(1)}×</span>
          <button className="editor-zoom-btn" onClick={zoomXIn} title="Zoom in (+)">+</button>
          <button className="editor-zoom-btn" onClick={resetZoomX} title="Reset (0)">⟲</button>
        </div>
        <div className="editor-zoom-group">
          <span className="editor-zoom-label">Amp</span>
          <button className="editor-zoom-btn" onClick={zoomYOut} title="Vertical zoom out (Shift+-)">−</button>
          <span className="editor-zoom-value">{zoomY.toFixed(1)}×</span>
          <button className="editor-zoom-btn" onClick={zoomYIn} title="Vertical zoom in (Shift++)">+</button>
          <button className="editor-zoom-btn" onClick={resetZoomY} title="Reset (Shift+0)">⟲</button>
        </div>
      </div>

      <div className="editor-canvas-wrap">
        <div
          ref={containerRef}
          className="editor-canvas-frame"
          onClick={(e) => {
            if (!buffer) return;
            const t = e.target as HTMLElement;
            if (t.closest('.editor-handle') || t.closest('.editor-marker')) return;
            const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
            const px = e.clientX - rect.left;
            const sec = pxToSec(px, rect.width);
            // Alt/Option-click drops or moves the timer-end marker. Clamps
            // to the current trim region. Adds the marker if not yet set.
            if (e.altKey) {
              setLandSec(Math.max(startSec, Math.min(endSec, sec)));
              return;
            }
            void startPreviewAt(sec);
          }}
          onWheel={(e) => {
            // Horizontal scroll when zoomed in. Two-finger swipe / shift+wheel.
            if (!buffer || zoomX <= 1) return;
            const delta = (e.deltaX !== 0 ? e.deltaX : e.deltaY) / 800;
            setScrollX(prev => Math.max(0, Math.min(zoomX - 1, prev + delta * zoomX)));
          }}
        >
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
          {!buffer && (
            <div className="editor-empty">
              {selectedTrack ? (loading ? 'Loading…' : 'No waveform') : 'Select a track to begin'}
            </div>
          )}
          {buffer && (
            <>
              <DragHandle
                side="left"
                pct={startPct}
                container={containerRef}
                pxToSec={pxToSec}
                trimStart={startSec}
                trimEnd={endSec}
                fadeSec={fadeInSec}
                onTrimChange={v => setStartSec(Math.max(0, Math.min(endSec - 0.1, v)))}
                onFadeChange={v => setFadeInSec(Math.max(0, Math.min(20, v)))}
                label={formatDuration(startSec)}
              />
              <DragHandle
                side="right"
                pct={endPct}
                container={containerRef}
                pxToSec={pxToSec}
                trimStart={startSec}
                trimEnd={endSec}
                fadeSec={fadeOutSec}
                onTrimChange={v => setEndSec(Math.max(startSec + 0.1, Math.min(buffer.duration, v)))}
                onFadeChange={v => setFadeOutSec(Math.max(0, Math.min(20, v)))}
                label={formatDuration(endSec)}
              />
              {/* Service-landing marker — only meaningful when set; the
                  timer hits zero here, music continues to trim end. */}
              {landPct !== null && landSec !== null && (
                <ServiceLandHandle
                  pct={landPct}
                  container={containerRef}
                  pxToSec={pxToSec}
                  trimStart={startSec}
                  trimEnd={endSec}
                  onChange={v => setLandSec(Math.max(startSec, Math.min(endSec, v)))}
                  label={formatDuration(landSec)}
                />
              )}
              {/* Playhead — always visible, animates during preview */}
              <div
                className={`editor-playhead ${previewing ? 'playing' : ''}`}
                style={{ left: `${playheadPct}%` }}
              >
                <div className="editor-playhead-triangle" />
              </div>
              {/* Big timecode readout while previewing */}
              {previewing && (
                <div className="editor-timecode">
                  {formatPreciseTime(playheadSec - startSec)} / {formatPreciseTime(endSec - startSec)}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {buffer && (
        <div className="editor-footer">
          <div className="editor-fields">
            <SecField label="Start" value={startSec} max={endSec - 0.1} onChange={v => setStartSec(Math.max(0, Math.min(endSec - 0.1, v)))} />
            <SecField label="End" value={endSec} min={startSec + 0.1} max={buffer.duration} onChange={v => setEndSec(Math.max(startSec + 0.1, Math.min(buffer.duration, v)))} />
            <SecField label="Fade in" value={fadeInSec} max={Math.min(20, trimDuration / 2)} onChange={v => setFadeInSec(Math.max(0, v))} />
            <SecField label="Fade out" value={fadeOutSec} max={Math.min(20, trimDuration / 2)} onChange={v => setFadeOutSec(Math.max(0, v))} />
            {landSec !== null && (
              <SecField
                label="Timer end"
                value={landSec}
                min={startSec}
                max={endSec}
                onChange={v => setLandSec(Math.max(startSec, Math.min(endSec, v)))}
              />
            )}
          </div>

          <div className="editor-actions">
            <button className="btn-primary" onClick={onPlayPreview} style={{ minWidth: 130 }}>
              {previewing ? '◼ Stop preview' : '▶ Preview'}
            </button>
            <button className="btn-primary" onClick={onSaveEdit}>Save edit</button>
            {hasExistingEdit && (
              <button className="btn-danger" onClick={onResetEdit}>Reset to full</button>
            )}
            <button
              className="btn-secondary"
              onClick={() => void onRelinkFile()}
              title="Point this track entry at a different audio file. Useful after renaming, moving, or re-encoding the source."
            >
              Relink file…
            </button>
            {landSec === null ? (
              <button
                className="btn-secondary"
                onClick={() => setLandSec(playheadSec >= startSec && playheadSec <= endSec ? playheadSec : endSec)}
                title="Mark a position where the countdown timer should hit zero. The track keeps playing past it as a tail."
              >
                + Timer-end marker
              </button>
            ) : (
              <button
                className="btn-secondary"
                onClick={() => setLandSec(null)}
                title="Clear the timer-end marker — the timer will land on trim end again."
              >
                ✕ Clear timer marker
              </button>
            )}
            <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>
              Trim length · {formatDuration(trimDuration)}
              {trimDuration < buffer.duration && (
                <span style={{ color: 'var(--text-faint)' }}>
                  {' '}/ original {formatDuration(buffer.duration)}
                </span>
              )}
              {landSec !== null && landSec < endSec - 0.01 && (
                <span style={{ color: 'var(--purple, #a855f7)', marginLeft: 8 }}>
                  · timer ends {formatDuration(endSec - landSec)} before trim end
                </span>
              )}
            </span>
            {saveStatus && <span style={{ color: 'var(--accent-bright)', fontSize: 13 }}>{saveStatus}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Service-landing marker — a vertical purple line with a grabbable flag at
 * the top. Drag either the line or the flag to slide; clamps to the trim
 * region. Visually distinct from the trim handles so the operator can't
 * mistake it for a trim edge. Both elements carry the `editor-handle`
 * class so the canvas's click-to-preview ignores them.
 */
function ServiceLandHandle({ pct, container, pxToSec, trimStart, trimEnd, onChange, label }: {
  pct: number;
  container: React.RefObject<HTMLDivElement>;
  pxToSec: (px: number, canvasWidth: number) => number;
  trimStart: number;
  trimEnd: number;
  onChange: (sec: number) => void;
  label: string;
}) {
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cont = container.current;
    if (!cont) return;
    const rect = cont.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const cur = pxToSec(ev.clientX - rect.left, rect.width);
      onChange(Math.max(trimStart, Math.min(trimEnd, cur)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const tooltip = `Timer ends here (${label}). Drag to adjust, or Alt-click the waveform to reposition. The track keeps playing past it as a tail.`;
  const PURPLE = 'var(--purple, #a855f7)';
  const HANDLE_SIZE = 12;

  // NOTE: do NOT add `editor-handle` to these elements — that class carries
  // `width: 28px; margin-left: -14px` from the trim-handle styles, which
  // silently shifts our line. Use the marker-specific class for the
  // canvas's click-skip check (also updated below).
  return (
    <>
      {/* Thin vertical line through the canvas — drag from anywhere on it.
          Starts just under the top handle so the two read as one element. */}
      <div
        className="editor-marker editor-land-line"
        onMouseDown={startDrag}
        title={tooltip}
        style={{
          position: 'absolute',
          top: HANDLE_SIZE + 2,
          bottom: 0,
          left: `${pct}%`,
          marginLeft: -1,
          width: 2,
          background: PURPLE,
          boxShadow: '0 0 3px rgba(168, 85, 247, 0.55)',
          zIndex: 5,
          cursor: 'ew-resize',
        }}
      />
      {/* Small grabbable handle at the top of the line — primary drag target. */}
      <div
        className="editor-marker editor-land-flag"
        onMouseDown={startDrag}
        title={tooltip}
        style={{
          position: 'absolute',
          top: 4,
          left: `${pct}%`,
          marginLeft: -HANDLE_SIZE / 2,
          width: HANDLE_SIZE,
          height: HANDLE_SIZE,
          background: PURPLE,
          borderRadius: 2,
          cursor: 'ew-resize',
          boxShadow: '0 1px 4px rgba(168, 85, 247, 0.5)',
          zIndex: 6,
        }}
      />
      {/* Compact time label next to the handle, non-interactive. */}
      <div
        className="editor-marker"
        style={{
          position: 'absolute',
          top: 5,
          left: `${pct}%`,
          marginLeft: HANDLE_SIZE / 2 + 4,
          padding: '0 4px',
          fontSize: 10,
          fontFamily: 'IBM Plex Mono, monospace',
          fontWeight: 600,
          color: PURPLE,
          background: 'rgba(0, 0, 0, 0.55)',
          borderRadius: 3,
          whiteSpace: 'nowrap',
          userSelect: 'none',
          pointerEvents: 'none',
          zIndex: 6,
          lineHeight: '14px',
        }}
      >
        {label}
      </div>
    </>
  );
}

function DragHandle({ side, pct, container, pxToSec, trimStart, trimEnd, fadeSec, onTrimChange, onFadeChange, label }: {
  side: 'left' | 'right';
  pct: number;
  container: React.RefObject<HTMLDivElement>;
  pxToSec: (px: number, canvasWidth: number) => number;
  trimStart: number;
  trimEnd: number;
  fadeSec: number;
  onTrimChange: (sec: number) => void;
  onFadeChange: (sec: number) => void;
  label: string;
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const cont = container.current;
    if (!cont) return;
    const rect = cont.getBoundingClientRect();
    const startMouseX = e.clientX;
    const startSec = pxToSec(startMouseX - rect.left, rect.width);
    const isFadeDrag = e.shiftKey;
    const initialFade = fadeSec;

    const onMove = (ev: MouseEvent) => {
      if (isFadeDrag) {
        const curSec = pxToSec(ev.clientX - rect.left, rect.width);
        const dxSec = side === 'left' ? (curSec - startSec) : (startSec - curSec);
        const next = Math.max(0, initialFade + dxSec);
        const segLen = trimEnd - trimStart;
        onFadeChange(Math.min(next, segLen / 2));
      } else {
        const sec = pxToSec(Math.max(0, Math.min(rect.width, ev.clientX - rect.left)), rect.width);
        onTrimChange(sec);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return (
    <div
      className={`editor-handle editor-handle-${side}`}
      style={{ left: `${pct}%` }}
      onMouseDown={onMouseDown}
      title={`Drag to set ${side === 'left' ? 'start' : 'end'}.  Shift+drag to set fade ${side === 'left' ? 'in' : 'out'}.`}
    >
      <div className="editor-handle-grip" />
      <div className="editor-handle-label">{label}</div>
      {fadeSec > 0 && (
        <div className="editor-handle-fade-tag">{fadeSec.toFixed(1)}s fade</div>
      )}
    </div>
  );
}

function formatPreciseTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function SecField({ label, value, onChange, min = 0, max = 9999 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
        {label} (sec)
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={0.1}
        value={value.toFixed(2)}
        onChange={e => onChange(+e.target.value)}
        style={{ fontSize: 14, padding: 8, fontFamily: 'IBM Plex Mono, monospace' }}
      />
    </div>
  );
}

// ----------------- waveform drawing + drag handling -----------------

function drawWaveform(
  canvas: HTMLCanvasElement | null,
  container: HTMLDivElement | null,
  buffer: AudioBuffer | null,
  opts: {
    startSec: number;
    endSec: number;
    fadeInSec: number;
    fadeOutSec: number;
    zoomX: number;
    scrollX: number;
    zoomY: number;
  },
) {
  if (!canvas || !container || !buffer) {
    if (canvas) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = container?.clientWidth ?? 0;
      canvas.height = (container?.clientHeight ?? 0) * dpr;
      const ctx = canvas.getContext('2d');
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const w = container.clientWidth;
  const h = container.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const dur = buffer.duration;
  const zoomX = Math.max(1, opts.zoomX);
  const scrollX = Math.max(0, Math.min(zoomX - 1, opts.scrollX));
  const zoomY = Math.max(0.1, opts.zoomY);

  // Map a buffer second into canvas-pixel x-coordinate.
  const x = (sec: number) => ((sec / dur) * zoomX - scrollX) * w;
  const startPx = x(opts.startSec);
  const endPx = x(opts.endSec);
  ctx.fillStyle = 'rgba(20, 184, 166, 0.10)';
  ctx.fillRect(startPx, 0, endPx - startPx, h);

  // Waveform: use channel 0, peak per pixel of the visible window.
  const data = buffer.getChannelData(0);
  const visibleSec = dur / zoomX;
  const visibleStartSec = (scrollX / zoomX) * dur;
  const samplesPerPx = Math.max(1, (visibleSec * buffer.sampleRate) / w);
  const visibleStartSample = Math.floor(visibleStartSec * buffer.sampleRate);

  ctx.strokeStyle = 'rgba(180, 200, 220, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const mid = h / 2;
  const ampScale = h * 0.45 * zoomY;
  for (let px = 0; px < w; px++) {
    const sStart = visibleStartSample + Math.floor(px * samplesPerPx);
    const sEnd = Math.min(sStart + Math.ceil(samplesPerPx), data.length);
    let mn = 1, mx = -1;
    for (let i = sStart; i < sEnd; i++) {
      const s = data[i];
      if (s < mn) mn = s;
      if (s > mx) mx = s;
    }
    const yMin = Math.max(0, Math.min(h, mid + mn * ampScale));
    const yMax = Math.max(0, Math.min(h, mid + mx * ampScale));
    ctx.moveTo(px + 0.5, yMin);
    ctx.lineTo(px + 0.5, yMax);
  }
  ctx.stroke();

  // Highlight selected region waveform brighter.
  if (endPx > 0 && startPx < w) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(Math.max(0, startPx), 0, Math.min(w, endPx) - Math.max(0, startPx), h);
    ctx.clip();
    ctx.strokeStyle = '#14b8a6';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = Math.max(0, Math.floor(startPx)); px < Math.min(w, Math.ceil(endPx)); px++) {
      const sStart = visibleStartSample + Math.floor(px * samplesPerPx);
      const sEnd = Math.min(sStart + Math.ceil(samplesPerPx), data.length);
      let mn = 1, mx = -1;
      for (let i = sStart; i < sEnd; i++) {
        const s = data[i];
        if (s < mn) mn = s;
        if (s > mx) mx = s;
      }
      const yMin = Math.max(0, Math.min(h, mid + mn * ampScale));
      const yMax = Math.max(0, Math.min(h, mid + mx * ampScale));
      ctx.moveTo(px + 0.5, yMin);
      ctx.lineTo(px + 0.5, yMax);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Fade-in line
  const fInPx = x(opts.startSec + opts.fadeInSec);
  if (opts.fadeInSec > 0) {
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(startPx, h - 1);
    ctx.lineTo(fInPx, 1);
    ctx.stroke();
  }
  // Fade-out line
  const fOutPx = x(opts.endSec - opts.fadeOutSec);
  if (opts.fadeOutSec > 0) {
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(fOutPx, 1);
    ctx.lineTo(endPx, h - 1);
    ctx.stroke();
  }

  // Markers
  ctx.fillStyle = '#14b8a6';
  ctx.fillRect(startPx - 1, 0, 2, h);
  ctx.fillRect(endPx - 1, 0, 2, h);

  // Reset transform
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

