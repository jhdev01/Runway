import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small ⓘ that shows an explanation on hover or keyboard focus, instead
 * of a paragraph sitting next to the setting. The tip is drawn in a portal
 * with fixed positioning so scrolling panels never clip it, and it flips to
 * stay on screen near the right or bottom edge.
 */
export function InfoTip({ children, label = 'More info', width = 280 }: {
  children: React.ReactNode;
  label?: string;
  width?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos(null); return; }
    const r = ref.current.getBoundingClientRect();
    const h = boxRef.current?.offsetHeight ?? 80;
    const pad = 8;
    let left = r.right + 8;
    if (left + width > window.innerWidth - pad) left = Math.max(pad, r.left - 8 - width);
    let top = r.top - 6;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - pad - h);
    setPos({ left, top });
  }, [open, width]);

  return (
    <span
      ref={ref}
      className={`infotip ${open ? 'open' : ''}`}
      tabIndex={0}
      role="button"
      aria-label={label}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onClick={e => { e.preventDefault(); e.stopPropagation(); setOpen(o => !o); }}
      onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <circle cx="8" cy="8" r="6.5" />
        <path d="M8 7.2v3.8M8 5v.1" strokeLinecap="round" />
      </svg>
      {open && createPortal(
        <span
          ref={boxRef}
          className="infotip-box"
          role="tooltip"
          style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        >
          {children}
        </span>,
        document.body,
      )}
    </span>
  );
}
