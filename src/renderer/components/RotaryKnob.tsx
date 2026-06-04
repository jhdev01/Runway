import React, { useEffect, useRef, useState } from 'react';

interface Props {
  /** Current value. */
  value: number;
  /** Allowed range. */
  min: number;
  max: number;
  /** Where on the dial 0 sits — useful for bipolar gain knobs (-24…+12 with 0 at 12 o'clock). */
  zero?: number;
  /** Pixels of vertical drag = full range. Default 200. Lower = touchier. */
  pxFullRange?: number;
  /** Step (snap) when dragging while holding shift, or 0 for free. */
  shiftStep?: number;
  /** Diameter in px. */
  size?: number;
  onChange: (v: number) => void;
  onDoubleClick?: () => void;
  label?: string;
  formatValue?: (v: number) => string;
}

/**
 * Rotary knob — click and drag vertically to turn (mouse-up anywhere ends).
 * Visual: dark dial with a colored arc from `zero` to current value, plus a
 * tick indicator showing absolute position. Modeled after a soundboard trim
 * pot with a 270° travel arc (-135° at min to +135° at max).
 */
const ARC_START_DEG = -135;
const ARC_END_DEG = 135;
const ARC_RANGE_DEG = ARC_END_DEG - ARC_START_DEG;

function valueToDeg(v: number, min: number, max: number): number {
  if (max <= min) return ARC_START_DEG;
  const t = Math.max(0, Math.min(1, (v - min) / (max - min)));
  return ARC_START_DEG + t * ARC_RANGE_DEG;
}

function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const toRad = (d: number) => (d - 90) * Math.PI / 180;
  const startX = cx + r * Math.cos(toRad(startDeg));
  const startY = cy + r * Math.sin(toRad(startDeg));
  const endX = cx + r * Math.cos(toRad(endDeg));
  const endY = cy + r * Math.sin(toRad(endDeg));
  const sweep = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const dir = endDeg > startDeg ? 1 : 0;
  return `M ${startX} ${startY} A ${r} ${r} 0 ${sweep} ${dir} ${endX} ${endY}`;
}

export function RotaryKnob({
  value, min, max,
  zero = (min + max) / 2,
  pxFullRange = 200,
  shiftStep = 1,
  size = 56,
  onChange,
  onDoubleClick,
  label,
  formatValue,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ startY: number; startVal: number } | null>(null);

  // Global mousemove / mouseup so the user can drag past the knob bounds.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const ds = dragStateRef.current;
      if (!ds) return;
      const dy = ds.startY - e.clientY; // up = increase
      const range = max - min;
      let next = ds.startVal + (dy / pxFullRange) * range;
      if (e.shiftKey && shiftStep > 0) {
        next = Math.round(next / shiftStep) * shiftStep;
      }
      next = Math.max(min, Math.min(max, next));
      onChange(next);
    };
    const onUp = () => {
      setDragging(false);
      dragStateRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, max, min, pxFullRange, shiftStep, onChange]);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragStateRef.current = { startY: e.clientY, startVal: value };
    setDragging(true);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const range = max - min;
    // 100px scroll = full range; deltaY positive = scroll down = decrease.
    const dy = -e.deltaY;
    let next = value + (dy / 600) * range;
    next = Math.max(min, Math.min(max, next));
    onChange(next);
  };

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const valDeg = valueToDeg(value, min, max);
  const zeroDeg = valueToDeg(zero, min, max);

  // Tick indicator endpoint — short line from center pointing at valDeg.
  const tickRad = (valDeg - 90) * Math.PI / 180;
  const tickInner = r * 0.45;
  const tickOuter = r * 0.85;
  const tickX1 = cx + tickInner * Math.cos(tickRad);
  const tickY1 = cy + tickInner * Math.sin(tickRad);
  const tickX2 = cx + tickOuter * Math.cos(tickRad);
  const tickY2 = cy + tickOuter * Math.sin(tickRad);

  return (
    <div
      className={`rotary-knob ${dragging ? 'dragging' : ''}`}
      style={{ width: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        style={{ cursor: dragging ? 'grabbing' : 'grab', display: 'block' }}
      >
        {/* Outer dial */}
        <circle cx={cx} cy={cy} r={r}
          fill="var(--bg-elev-2)"
          stroke="var(--border-bright)"
          strokeWidth="1.5"
        />
        {/* Background arc — full travel */}
        <path
          d={describeArc(cx, cy, r - 3, ARC_START_DEG, ARC_END_DEG)}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Foreground arc — from zero to current value */}
        <path
          d={describeArc(
            cx, cy, r - 3,
            Math.min(valDeg, zeroDeg),
            Math.max(valDeg, zeroDeg),
          )}
          fill="none"
          stroke="var(--accent-bright)"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* Indicator tick */}
        <line
          x1={tickX1} y1={tickY1}
          x2={tickX2} y2={tickY2}
          stroke="var(--text)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      {(label || formatValue) && (
        <div className="rotary-knob-labels">
          {label && <div className="rotary-knob-label">{label}</div>}
          {formatValue && <div className="rotary-knob-value">{formatValue(value)}</div>}
        </div>
      )}
    </div>
  );
}
