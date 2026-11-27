import React from 'react';
import type { EditSuggestion } from '../lib/landLearning';
import { landAccuracyNote } from '../lib/landLearning';
import { InfoTip } from './InfoTip';

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};

/**
 * "Suggested" row in the editors: silence trims and a learned 0:00 for the
 * values the operator hasn't set. Nothing changes until a Use button is
 * pressed. `note` adds a hint (e.g. "Press Save edit to keep it").
 */
export function EditSuggestions({ s, onUse, note }: {
  s: EditSuggestion;
  onUse: (p: EditSuggestion) => void;
  note?: string;
}) {
  const parts: { label: string; p: EditSuggestion; tip: string }[] = [];
  if (s.startSec !== undefined) parts.push({ label: `Start at ${fmt(s.startSec)}`, p: { startSec: s.startSec }, tip: 'Silence before the music starts.' });
  if (s.endSec !== undefined) parts.push({ label: `End at ${fmt(s.endSec)}`, p: { endSec: s.endSec }, tip: 'Silence after the music stops.' });
  if (s.landSec !== undefined) parts.push({ label: `0:00 at ${fmt(s.landSec)}`, p: { landSec: s.landSec }, tip: `Where you usually put 0:00: the last big moment before the music falls away. ${landAccuracyNote()}` });
  if (parts.length === 0) return null;
  return (
    <div className="edit-suggestions">
      <span className="edit-suggestions-label">
        Suggested
        <InfoTip>Runway trims true silence at the ends and suggests a 0:00 from where you've placed it on other songs. Nothing changes until you press Use. {landAccuracyNote()}</InfoTip>
      </span>
      {parts.map(x => (
        <button key={x.label} type="button" className="edit-suggestion" title={x.tip} onClick={() => onUse(x.p)}>
          {x.label} <span className="edit-suggestion-use">Use</span>
        </button>
      ))}
      {parts.length > 1 && (
        <button type="button" className="btn-secondary" onClick={() => onUse(s)}>Use all</button>
      )}
      {note && <span className="edit-suggestions-note">{note}</span>}
    </div>
  );
}
