import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Lightweight custom tooltip — Electron's native `title` attribute
 * tooltips were unreliable in this app (cursor would change but
 * nothing rendered). This component portals a positioned bubble
 * into <body> on hover, so parent overflow/stacking can never clip
 * it.
 *
 * Position is anchored to the CURSOR rather than the wrapped
 * element's bounding rect. That avoids a footgun: if the child is
 * `position: absolute` (e.g., a timeline action marker), the
 * wrapper's rect is 0×0 at the parent's origin and a rect-based
 * tooltip would land at the wrong spot. Cursor-based placement is
 * also how every modern app tooltip works.
 *
 * Usage:
 *   <Tooltip text="Full path here">
 *     <span>truncated…</span>
 *   </Tooltip>
 */
interface Props {
  text: string;
  children: React.ReactNode;
  /** "block" makes the wrapper a div instead of span; useful for row-style children. */
  display?: 'inline' | 'block';
  /** Delay in ms before the tooltip appears. Default 300. */
  delay?: number;
  /** Pass through className for custom styling on the wrapper. */
  className?: string;
}

export function Tooltip({ text, children, display = 'inline', delay = 300, className }: Props) {
  const [visible, setVisible] = useState(false);
  // Cursor position — set on enter, refined on move so the bubble
  // follows the mouse instead of locking to the entry point.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const timerRef = useRef<number | null>(null);
  const lastPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const arm = (e: React.MouseEvent) => {
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const { x, y } = lastPosRef.current;
      setPos({ left: x, top: y + 18 });
      setVisible(true);
    }, delay);
  };
  const move = (e: React.MouseEvent) => {
    lastPosRef.current = { x: e.clientX, y: e.clientY };
    if (visible) {
      setPos({ left: e.clientX, top: e.clientY + 18 });
    }
  };
  const hide = () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  };

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  // Clamp position so the bubble never escapes the viewport — pulls
  // it back from the right edge if the cursor is near it. Done in
  // CSS via max() / margin-clamp to keep this component pure.
  const Tag = display === 'block' ? 'div' : 'span';
  return (
    <>
      <Tag
        className={`rw-tip-anchor ${className ?? ''}`}
        onMouseEnter={arm}
        onMouseMove={move}
        onMouseLeave={hide}
      >
        {children}
      </Tag>
      {visible && text && createPortal(
        <div
          className="rw-tip"
          style={{ left: pos.left, top: pos.top }}
          role="tooltip"
        >
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}
