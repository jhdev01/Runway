import React from 'react';
import type { PpTimer } from '../lib/proPresenterClient';

/**
 * Renders a ProPresenter playlist's items as <option>s for a native
 * <select>, with PP headers as non-selectable <optgroup> labels.
 *
 * Why optgroup: a header is a real playlist item (it occupies an index)
 * but triggering one does nothing visible — so an operator picking one by
 * accident gets a cue that silently "succeeds" and shows nothing. Nesting
 * the items that follow a header under an <optgroup> keeps the header
 * visible as a section label while making it impossible to select.
 *
 * Color: native <select> menus (especially on macOS) ignore CSS colors on
 * options and optgroup labels, so the header's PP color is shown as the
 * nearest colored-dot swatch in the label text instead. PP header colors
 * come from a small fixed palette, so the mapping is faithful in practice.
 *
 * Shared by the Actions editor, the per-service ProPresenter modal, and
 * Settings → ProPresenter so all three pickers behave identically.
 */

/** Nearest colored-dot emoji for a CSS rgb() string; '' if unparseable. */
export function colorSwatch(rgb: string | undefined): string {
  if (!rgb) return '';
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return '';
  const r = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  // Low saturation or extreme lightness → neutral dot.
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.2) return l < 0.35 ? '⚫' : '⚪';
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return '🔴';
  if (h < 45) return l < 0.35 ? '🟤' : '🟠';
  if (h < 70) return '🟡';
  if (h < 170) return '🟢';
  if (h < 260) return '🔵';
  return '🟣';
}

function isHeader(it: PpTimer): boolean {
  return it.type === 'header';
}

export function PpItemOptions({ items }: { items: PpTimer[] }) {
  // Walk in order; each header opens a new group that collects the items
  // after it. Items before the first header stay ungrouped.
  const groups: { header?: PpTimer; items: PpTimer[] }[] = [{ items: [] }];
  for (const it of items) {
    if (isHeader(it)) groups.push({ header: it, items: [] });
    else groups[groups.length - 1].items.push(it);
  }
  const renderItem = (i: PpTimer) => (
    <option key={i.uuid} value={i.index ?? ''}>
      {i.index !== undefined ? `${i.index + 1}. ` : ''}{i.name}
    </option>
  );
  return (
    <>
      {groups.map((g, gi) => {
        if (!g.header) return <React.Fragment key={`ungrouped-${gi}`}>{g.items.map(renderItem)}</React.Fragment>;
        const swatch = colorSwatch(g.header.headerColor);
        const label = `${swatch ? swatch + ' ' : ''}${g.header.name}`;
        return (
          <optgroup key={g.header.uuid} label={label}>
            {g.items.map(renderItem)}
          </optgroup>
        );
      })}
    </>
  );
}
