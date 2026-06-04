import React, { useEffect, useState } from 'react';

interface Props {
  targetMs: number;  // unix ms target
  /**
   * Visual mode.
   *  - 'music'      : default amber/gold, regular pre-service flow
   *  - 'pre-music'  : purple tint while armed-and-waiting
   *  - 'not-armed'  : red — service is upcoming but no runway is armed for it,
   *                   matches the alert banner shown above the countdown.
   *  - 'idle'       : soft purple/pink — used when post-service music
   *                   is the focus and the countdown is supplementary
   *                   info. Harmonizes with the post-service pink pill.
   */
  variant?: 'pre-music' | 'music' | 'not-armed' | 'idle';
}

/** Big countdown with milliseconds. Drives at 60fps. */
export function CountdownClock({ targetMs, variant = 'music' }: Props) {
  const [remaining, setRemaining] = useState(() => Math.max(0, targetMs - Date.now()));

  useEffect(() => {
    let raf: number;
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
  const str = [h, m, s].map(n => String(n).padStart(2, '0')).join('');

  return (
    <div className={`midi-clock midi-clock-${variant}`}>
      <span className="midi-clock-digit">{str[0]}</span>
      <span className="midi-clock-digit">{str[1]}</span>
      <span className="midi-clock-sep">:</span>
      <span className="midi-clock-digit">{str[2]}</span>
      <span className="midi-clock-digit">{str[3]}</span>
      <span className="midi-clock-sep">:</span>
      <span className="midi-clock-digit">{str[4]}</span>
      <span className="midi-clock-digit">{str[5]}</span>
      <span className="midi-clock-ms">.{String(ms).padStart(3, '0')}</span>
    </div>
  );
}
