import React, { useEffect, useRef, useState } from 'react';
import type { PpTimer } from '../lib/proPresenterClient';

/**
 * Custom dropdown for picking a ProPresenter playlist item.
 *
 * Replaces the native <select> the three PP pickers used to share. The
 * native menu (macOS especially) strips background colors from its rows,
 * so it can't show a header's ProPresenter color as a fill — this
 * component renders its own list and can.
 *
 * Headers: a PP header is a real playlist item (it occupies an index) but
 * triggering one does nothing visible, so it must never be selectable.
 * Each header is a non-interactive section row filled with its PP color
 * (auto-contrast text), and the items that follow it sit indented beneath.
 *
 * The contract mirrors the <select> it replaces so call sites swap 1:1:
 *   value     '' or String(index)
 *   onChange  receives '' or String(index)  (same shape as e.target.value)
 *
 * Shared by the Actions editor, the per-service ProPresenter modal, and
 * Settings → ProPresenter so all three behave identically.
 */

/** Black-ish or white-ish text for legibility over an rgb() fill. */
export function contrastTextFor(rgb: string | undefined): string {
  const m = rgb?.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return 'var(--text)';
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(+m[1]) + 0.7152 * lin(+m[2]) + 0.0722 * lin(+m[3]);
  return L > 0.4 ? '#0b1016' : '#f4f7fa';
}

interface Props {
  items: PpTimer[];
  /** '' or String(index) — same as the native select's value. */
  value: string;
  /** Receives '' or String(index) — same as e.target.value did. */
  onChange: (raw: string) => void;
  disabled?: boolean;
  /** Shown when nothing is selected; also the top "clear" row of the menu. */
  placeholder: string;
  /** The saved pick, used to keep it representable if it's not in `items`.
   *  `null` accepted because the modal/Settings pickers hold it that way. */
  savedIndex?: number | null;
  savedName?: string | null;
  title?: string;
}

export function PpItemPicker({
  items, value, onChange, disabled, placeholder, savedIndex, savedName, title,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Items before the first header stay ungrouped; each header opens a group
  // that collects the items after it.
  const groups: { header?: PpTimer; items: PpTimer[] }[] = [{ items: [] }];
  for (const it of items) {
    if (it.type === 'header') groups.push({ header: it, items: [] });
    else groups[groups.length - 1].items.push(it);
  }

  const selectedIdx = value === '' ? null : Number(value);
  const selected = selectedIdx === null ? undefined : items.find(i => i.index === selectedIdx);
  const hasSaved = savedIndex !== null && savedIndex !== undefined && !!savedName;
  const savedIsStale = hasSaved && !items.some(i => i.index === savedIndex);
  const showingStale = savedIsStale && selectedIdx === savedIndex;

  const itemLabel = (i: PpTimer) => `${i.index !== undefined ? `${i.index + 1}. ` : ''}${i.name}`;
  const label = selected
    ? itemLabel(selected)
    : showingStale
      ? `${(savedIndex as number) + 1}. ${savedName} (not loaded)`
      : placeholder;
  const isPlaceholder = !selected && !showingStale;

  const pick = (raw: string) => { onChange(raw); setOpen(false); };

  return (
    <div className="pp-picker" ref={rootRef}>
      <button
        type="button"
        className={`pp-picker-trigger${isPlaceholder ? ' is-placeholder' : ''}`}
        onClick={() => { if (!disabled) setOpen(o => !o); }}
        disabled={disabled}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="pp-picker-label">{label}</span>
        <span className="pp-picker-chevron" aria-hidden>▾</span>
      </button>

      {open && (
        <div className="pp-picker-menu" role="listbox">
          {/* Top row clears the pick — mirrors the native placeholder option. */}
          <button
            type="button"
            role="option"
            aria-selected={selectedIdx === null}
            className={`pp-picker-item${selectedIdx === null ? ' is-selected' : ''}`}
            onClick={() => pick('')}
          >
            {placeholder}
          </button>

          {groups.map((g, gi) => (
            <React.Fragment key={g.header?.uuid ?? `ungrouped-${gi}`}>
              {g.header && (
                <div
                  className="pp-picker-header"
                  aria-disabled="true"
                  style={{
                    background: g.header.headerColor ?? 'var(--bg-elev-2)',
                    color: contrastTextFor(g.header.headerColor),
                  }}
                >
                  {g.header.name}
                </div>
              )}
              {g.items.map(i => (
                <button
                  type="button"
                  key={i.uuid}
                  role="option"
                  aria-selected={i.index === selectedIdx}
                  className={`pp-picker-item${g.header ? ' is-nested' : ''}${i.index === selectedIdx ? ' is-selected' : ''}`}
                  onClick={() => pick(i.index !== undefined ? String(i.index) : '')}
                >
                  {itemLabel(i)}
                </button>
              ))}
            </React.Fragment>
          ))}

          {savedIsStale && (
            <button
              type="button"
              role="option"
              aria-selected={selectedIdx === savedIndex}
              className={`pp-picker-item is-stale${selectedIdx === savedIndex ? ' is-selected' : ''}`}
              onClick={() => pick(String(savedIndex))}
            >
              {(savedIndex as number) + 1}. {savedName} (not loaded)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
