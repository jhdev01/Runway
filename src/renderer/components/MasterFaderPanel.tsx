import React, { useEffect, useState } from 'react';
import { useEngines } from '../state/engines';
import { useAppStore } from '../state/store';

/**
 * Master output level + 3-band EQ.
 * Sits between music + pad gains and the destination.
 */
export function MasterFaderPanel() {
  const { audio } = useEngines();
  const defaults = useAppStore(s => s.config.defaults);
  const updateConfig = useAppStore(s => s.updateConfig);
  const [level, setLevel] = useState<number>(() => audio.getMasterLevel());
  const [showEq, setShowEq] = useState(false);

  // If something else changes the level externally, keep slider in sync.
  useEffect(() => {
    const id = window.setInterval(() => {
      const cur = audio.getMasterLevel();
      setLevel(prev => (Math.abs(prev - cur) > 0.001 ? cur : prev));
    }, 500);
    return () => window.clearInterval(id);
  }, [audio]);

  // Apply EQ values to the audio graph whenever they change in config.
  const eqLow = defaults.eqLowDb ?? 0;
  const eqMid = defaults.eqMidDb ?? 0;
  const eqHigh = defaults.eqHighDb ?? 0;
  useEffect(() => {
    audio.setEq(eqLow, eqMid, eqHigh);
  }, [audio, eqLow, eqMid, eqHigh]);

  // Pad volume is owned by config (defaults.padPlayerLevel) — engines.tsx
  // already subscribes to changes and pushes them into audio.setPadLevel().
  const padLevel = defaults.padPlayerLevel ?? 0.6;
  const setPadLevel = (next: number) => {
    const v = Math.max(0, Math.min(1, next));
    updateConfig({ defaults: { ...defaults, padPlayerLevel: v } });
  };

  const onChange = (next: number) => {
    const v = Math.max(0, Math.min(1, next));
    setLevel(v);
    audio.setMasterLevel(v);
  };

  const setEqBand = (key: 'eqLowDb' | 'eqMidDb' | 'eqHighDb', value: number) => {
    const v = Math.max(-12, Math.min(12, value));
    updateConfig({ defaults: { ...defaults, [key]: v } });
  };

  const resetEq = () => {
    updateConfig({ defaults: { ...defaults, eqLowDb: 0, eqMidDb: 0, eqHighDb: 0 } });
  };

  const pct = Math.round(level * 100);
  const db = level <= 0.001 ? '−∞' : (20 * Math.log10(level)).toFixed(1);
  const padPct = Math.round(padLevel * 100);
  const eqActive = eqLow !== 0 || eqMid !== 0 || eqHigh !== 0;

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">Master</div>
        <div className="pad-status">{pct}%</div>
      </div>
      <div className="master-fader-row">
        <div className="master-fader-labeled">
          <span className="master-fader-channel">Main</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct}
            onChange={e => onChange(+e.target.value / 100)}
            onDoubleClick={() => onChange(1)}
            className="master-fader-slider"
            title="Double-click to reset to 0 dB"
          />
          <span className="master-fader-readout">{db} dB</span>
        </div>
        <div className="master-fader-labeled">
          <span className="master-fader-channel">Pad</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={padPct}
            onChange={e => setPadLevel(+e.target.value / 100)}
            onDoubleClick={() => setPadLevel(0.6)}
            className="master-fader-slider"
            title="Double-click to reset to default (60%)"
          />
          <span className="master-fader-readout">{padPct}%</span>
        </div>

        <button
          className={`eq-toggle ${eqActive ? 'active' : ''}`}
          onClick={() => setShowEq(s => !s)}
        >
          <span>EQ</span>
          {eqActive && <span className="eq-toggle-dot" />}
          <span style={{ marginLeft: 'auto', color: 'var(--text-faint)' }}>
            {showEq ? '−' : '+'}
          </span>
        </button>

        {showEq && (
          <div className="eq-panel">
            <EqBand label="Low" hz="200 Hz" value={eqLow} onChange={v => setEqBand('eqLowDb', v)} />
            <EqBand label="Mid" hz="1 kHz" value={eqMid} onChange={v => setEqBand('eqMidDb', v)} />
            <EqBand label="High" hz="5 kHz" value={eqHigh} onChange={v => setEqBand('eqHighDb', v)} />
            <button className="master-fader-unity" onClick={resetEq} style={{ alignSelf: 'flex-end' }}>
              Flat
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function EqBand({ label, hz, value, onChange }: {
  label: string; hz: string; value: number; onChange: (v: number) => void;
}) {
  return (
    <div className="eq-band">
      <div className="eq-band-label">
        <span>{label}</span>
        <span className="eq-band-hz">{hz}</span>
      </div>
      <input
        type="range"
        min={-12}
        max={12}
        step={0.5}
        value={value}
        onChange={e => onChange(+e.target.value)}
        className="eq-band-slider"
      />
      <div className="eq-band-value">{value > 0 ? '+' : ''}{value.toFixed(1)} dB</div>
    </div>
  );
}
