import React, { useEffect, useState } from 'react';

interface Props {
  /** Target time in unix ms. */
  targetMs: number;
  /** Label shown before the countdown. */
  label: string;
  /** Optional class for color/state. */
  variant?: 'default' | 'amber' | 'green';
  /** Show .XXX milliseconds at the end. Drives display via rAF for smoother ticking. */
  showMs?: boolean;
}

/**
 * Compact sub-countdown. Uses rAF so the display ticks smoothly even when
 * the parent re-renders frequently.
 */
export function SubCountdown({ targetMs, label, variant = 'default', showMs = false }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setRemaining(Math.max(0, targetMs - Date.now()));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [targetMs]);

  const totalSec = Math.floor(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ms = Math.floor(remaining % 1000);
  const fired = remaining <= 0;
  const baseClock = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
  const display = fired
    ? 'now'
    : showMs
      ? `${baseClock}.${String(ms).padStart(3, '0')}`
      : baseClock;

  return (
    <div className={`sub-countdown sub-countdown-${variant}`}>
      <span className="sub-countdown-label">{label}</span>
      <span className="sub-countdown-value">{display}</span>
    </div>
  );
}
