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
  const pad = (n: number) => String(n).padStart(2, '0');
  // Hours only when there are any: "34:31", "1:04:31".
  const groups = h > 0 ? [String(h), pad(m), pad(s)] : [pad(m), pad(s)];

  return (
    <div className={`midi-clock midi-clock-${variant}`} role="timer" aria-label={`${h > 0 ? `${h} hours ` : ''}${m} minutes ${s} seconds`}>
      {groups.map((g, gi) => (
        <React.Fragment key={gi}>
          {gi > 0 && <span className="midi-clock-sep" aria-hidden><i /><i /></span>}
          {g.split('').map((d, di) => <span key={di} className="midi-clock-digit">{d}</span>)}
        </React.Fragment>
      ))}
      <span className="midi-clock-ms" aria-hidden>.{String(ms).padStart(3, '0')}</span>
    </div>
  );
}
