import React, { useEffect, useRef, useState } from 'react';
import { useEngines } from '../state/engines';

interface Level {
  peak: number;
  rms: number;
  // Peak-hold value that decays slowly so a brief spike stays visible
  // for a few hundred ms — matches the behaviour of a hardware VU.
  hold: number;
}

const ZERO_LEVEL: Level = { peak: 0, rms: 0, hold: 0 };
const HOLD_DECAY = 0.92;   // multiplicative per frame; ~30Hz → ~3s hold
const RMS_TO_DB_FLOOR = -60;

/**
 * Compact level meters for the three audio buses. Two bars per row:
 *   RMS (filled, teal)  → loudness, the "body" of the signal
 *   Peak hold (line)    → most recent sample, useful for clipping
 *
 * Polls audio.getBusLevels() at ~30Hz via rAF and keeps the result in
 * local state. The audio engine reads each bus's pre-existing
 * AnalyserNode (which sits in parallel off `master` so it doesn't add
 * latency to the audible signal).
 */
export function BusLevelMeters() {
  const { audio } = useEngines();
  const [levels, setLevels] = useState<{ music: Level; pad: Level }>({
    music: { ...ZERO_LEVEL }, pad: { ...ZERO_LEVEL },
  });
  const holdRef = useRef({ music: 0, pad: 0 });

  useEffect(() => {
    let rafId = 0;
    let lastPaint = 0;
    const FRAME_MS = 1000 / 30;
    const tick = (now: number) => {
      rafId = requestAnimationFrame(tick);
      if (now - lastPaint < FRAME_MS) return;
      lastPaint = now;
      const raw = audio.getBusLevels();
      // Decay hold values multiplicatively; bump them up whenever a
      // fresh peak exceeds the current decayed value.
      for (const bus of ['music', 'pad'] as const) {
        const decayed = holdRef.current[bus] * HOLD_DECAY;
        holdRef.current[bus] = Math.max(decayed, raw[bus].peak);
      }
      setLevels({
        music: { peak: raw.music.peak, rms: raw.music.rms, hold: holdRef.current.music },
        pad: { peak: raw.pad.peak, rms: raw.pad.rms, hold: holdRef.current.pad },
      });
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [audio]);

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">Audio levels</div>
      </div>
      <MeterRow label="Music" level={levels.music} />
      <MeterRow label="Pad" level={levels.pad} />
    </div>
  );
}

function MeterRow({ label, level }: { label: string; level: Level }) {
  // Map linear amplitude to a perceptual width. dB scale clamped to
  // -60dB..0dB so the visible bar grows quickly out of silence and
  // saturates near unity.
  const rmsPct = ampToPct(level.rms);
  const peakPct = ampToPct(level.hold);
  const clipping = level.peak >= 0.99;
  return (
    <div className="bus-meter-row" title={`${label} — RMS ${Math.round(rmsPct)}% / peak ${Math.round(peakPct)}%`}>
      <div className="bus-meter-label">{label}</div>
      <div className="bus-meter-track">
        <div
          className="bus-meter-fill"
          style={{ clipPath: `inset(0 ${100 - rmsPct}% 0 0)` }}
        />
        {peakPct > 0 && (
          <div
            className="bus-meter-peak"
            style={{ left: `${peakPct}%`, background: clipping ? 'var(--red-bright)' : undefined }}
          />
        )}
      </div>
    </div>
  );
}

function ampToPct(amp: number): number {
  if (amp <= 0.0001) return 0;
  const db = 20 * Math.log10(amp);
  if (db <= RMS_TO_DB_FLOOR) return 0;
  // -60dB → 0%, 0dB → 100%, linear mapping in dB-space.
  return Math.min(100, Math.max(0, ((db - RMS_TO_DB_FLOOR) / -RMS_TO_DB_FLOOR) * 100));
}
