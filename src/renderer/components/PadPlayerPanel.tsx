import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import { MAJOR_KEYS, camelotOf, compatibleKeys, displayKey, keyColor } from '@shared/music';
import type { KeyName, PadFile } from '@shared/types';

const PAD_GRID_KEYS: KeyName[] = MAJOR_KEYS;

type PadState = 'armed' | 'playing' | 'stopped';

export function PadPlayerPanel() {
  const { audio } = useEngines();
  const padArmedKey = useAppStore(s => s.padArmedKey);
  const setPadArmedKey = useAppStore(s => s.setPadArmedKey);
  const pads = useAppStore(s => s.config.pads);
  const padPlayback = useAppStore(s => s.padPlayback);
  const defaults = useAppStore(s => s.config.defaults);
  const updateConfig = useAppStore(s => s.updateConfig);
  const openSettings = useAppStore(s => s.openSettings);

  const updateDefault = (key: 'padBridgeSec' | 'padFadeOutSec' | 'crossfadeSec', delta: number) => {
    const next = Math.max(0, Math.min(60, +(defaults[key] + delta).toFixed(1)));
    updateConfig({ defaults: { ...defaults, [key]: next } });
  };

  const [activeKey, setActiveKey] = useState<KeyName>(padArmedKey || 'D');
  const [state, setState] = useState<PadState>('armed');
  const [loopForever, setLoopForever] = useState(true);
  const meterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (padArmedKey) setActiveKey(padArmedKey);
  }, [padArmedKey]);

  useEffect(() => {
    if (padPlayback.isPlaying) setState('playing');
    else if (state === 'playing') setState('stopped');
  }, [padPlayback.isPlaying]);

  // Real-time pad progress meter — shows actual playback position within the buffer.
  // While looping, it wraps back to 0 each time the buffer cycles.
  useEffect(() => {
    let raf: number;
    const tick = () => {
      if (meterRef.current) {
        if (state === 'playing') {
          const pos = audio.getPadPosition();
          const pct = pos.durationSec > 0
            ? (pos.positionSec / pos.durationSec) * 100
            : 0;
          meterRef.current.style.width = pct + '%';
        } else {
          meterRef.current.style.width = '0%';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, audio]);

  const onKeyClick = (k: KeyName) => {
    setActiveKey(k);
    setPadArmedKey(k);
    if (state === 'playing') {
      // Switch to new key — keep current loop setting.
      const padFile = pads.find(p => p.key === k);
      if (padFile) {
        void audio.playPad(padFile.filePath, { fadeInSec: 1.5, loop: loopForever });
      }
    }
  };

  const onPlayPause = () => {
    if (state === 'playing') {
      audio.fadeOutPad(1.5);
      setState('stopped');
    } else {
      const padFile = pads.find(p => p.key === activeKey);
      if (padFile) {
        void audio.playPad(padFile.filePath, { fadeInSec: 1.5, loop: loopForever });
        setState('playing');
      } else {
        // No pad file mapped — just toggle visual state for now.
        setState('playing');
      }
    }
  };

  const onStop = () => {
    audio.fadeOutPad(2);
    setState('stopped');
  };

  const onAssignActiveKey = async () => {
    if (!window.runway) return;
    const paths = await window.runway.files.pickAudio(false);
    if (paths.length === 0) return;
    let filePath = paths[0];
    try {
      filePath = await window.runway.files.importPad(filePath);
    } catch (err) {
      console.warn('[importPad] failed', err);
    }
    const next: PadFile[] = [
      ...pads.filter(p => p.key !== activeKey),
      { key: activeKey, filePath, texture: 'warm' },
    ];
    updateConfig({ pads: next });
  };

  const activeHasPad = pads.some(p => p.key === activeKey);

  const compats = compatibleKeys(activeKey);
  const playIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
  );
  const pauseIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z" /></svg>
  );
  const stopIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z" /></svg>
  );

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">Pad Player</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div className="pad-status">
            {state.toUpperCase()} · {displayKey(activeKey, defaults.keyDisplayMode ?? 'sharp')}
          </div>
        </div>
      </div>

      {!activeHasPad && (
        <div
          style={{
            padding: '8px 10px',
            margin: '0 0 10px',
            border: '1px dashed var(--border, rgba(255,255,255,0.15))',
            borderRadius: 6,
            fontSize: 14,
            color: 'var(--text-dim)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>No pad mapped for {activeKey}.</span>
          <button
            className="pl-toggle-btn active"
            onClick={onAssignActiveKey}
            style={{ fontSize: 13, padding: '4px 8px' }}
          >
            + Assign file
          </button>
        </div>
      )}

      <div className="pad-grid">
        {PAD_GRID_KEYS.map(k => {
          const isActive = k === activeKey;
          const isCompat = compats.includes(k);
          const c = keyColor(k);
          // Background steps: active = full bg, compatible = soft, otherwise whisper.
          const bg = isActive ? c.bg : isCompat ? c.soft : c.whisper;
          const border = isActive ? c.fg : 'transparent';
          const text = isActive ? c.fg : isCompat ? c.fg : 'var(--text)';
          return (
            <button
              key={k}
              className={`pad-key ${isActive ? 'active' : ''} ${isCompat ? 'compatible' : ''}`}
              onClick={() => onKeyClick(k)}
              title={pads.find(p => p.key === k) ? 'Pad available' : 'No pad file mapped'}
              style={{
                background: bg,
                borderColor: border,
                color: text,
              }}
            >
              <div className="pad-key-name">{displayKey(k, defaults.keyDisplayMode ?? 'sharp')}</div>
              <div className="pad-key-num">{camelotOf(k)}</div>
            </button>
          );
        })}
      </div>

      <div className="pad-transport">
        <button className="pad-t-btn primary" onClick={onPlayPause} title="Play / Pause pad">
          {state === 'playing' ? pauseIcon : playIcon}
        </button>
        <button className="pad-t-btn" onClick={onStop} title="Stop with fade">
          {stopIcon}
        </button>
        <button
          className={`pad-t-btn ${loopForever ? 'active' : ''}`}
          onClick={() => setLoopForever(v => !v)}
          title={loopForever ? 'Looping forever — click to play once' : 'Plays once — click to loop forever'}
          data-loop={loopForever ? 'true' : 'false'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="17 1 21 5 17 9" />
            <path d="M3 11V9a4 4 0 0 1 4-4h14" />
            <polyline points="7 23 3 19 7 15" />
            <path d="M21 13v2a4 4 0 0 1-4 4H3" />
          </svg>
        </button>
        <button
          className="pad-t-btn pad-t-gear"
          onClick={() => openSettings('pads')}
          title="Open Pad Library settings — assign pads, adjust volume/gain, switch sharp/flat"
          aria-label="Pad settings"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div className="pad-meter">
        <div className="pad-meter-fill" ref={meterRef} />
      </div>

      <div className="pad-length-row">
        <span className="pad-length-label">Pad length</span>
        <div className="pad-length-fields">
          <div className="pad-length-field">
            <span className="pad-length-sub">Hold</span>
            <div className="pl-stepper">
              <button className="pl-stepper-btn" onClick={() => updateDefault('padBridgeSec', -0.5)}>−</button>
              <span className="pl-stepper-value">{defaults.padBridgeSec.toFixed(1)}s</span>
              <button className="pl-stepper-btn" onClick={() => updateDefault('padBridgeSec', 0.5)}>+</button>
            </div>
          </div>
          <div className="pad-length-field">
            <span className="pad-length-sub">Fade out</span>
            <div className="pl-stepper">
              <button className="pl-stepper-btn" onClick={() => updateDefault('padFadeOutSec', -0.5)}>−</button>
              <span className="pl-stepper-value">{defaults.padFadeOutSec.toFixed(1)}s</span>
              <button className="pl-stepper-btn" onClick={() => updateDefault('padFadeOutSec', 0.5)}>+</button>
            </div>
          </div>
        </div>
        <div className="pad-length-total">
          Pad audible · {((defaults.musicFadeToPadSec ?? 5) + (defaults.padBridgeSec ?? 0) + (defaults.padFadeOutSec ?? 0)).toFixed(1)}s
        </div>
      </div>

    </div>
  );
}
