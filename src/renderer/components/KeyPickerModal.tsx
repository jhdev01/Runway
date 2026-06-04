import React from 'react';
import { MAJOR_KEYS, MINOR_KEYS } from '@shared/music';
import type { KeyName } from '@shared/types';

interface Props {
  open: boolean;
  selected?: KeyName;
  onSelect: (k: KeyName | null) => void;
  onClose: () => void;
}

export function KeyPickerModal({ open, selected, onSelect, onClose }: Props) {
  if (!open) return null;
  return (
    <div className="key-modal-backdrop" onClick={onClose}>
      <div className="key-modal" onClick={e => e.stopPropagation()}>
        <div className="key-modal-title">Set key</div>
        <div className="key-modal-section-label">Major</div>
        <div className="key-modal-grid">
          {MAJOR_KEYS.map(k => (
            <button
              key={k}
              className={`key-modal-key ${selected === k ? 'selected' : ''}`}
              onClick={() => { onSelect(k); onClose(); }}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="key-modal-section-label">Minor</div>
        <div className="key-modal-grid">
          {MINOR_KEYS.map(k => (
            <button
              key={k}
              className={`key-modal-key ${selected === k ? 'selected' : ''}`}
              onClick={() => { onSelect(k); onClose(); }}
            >
              {k}
            </button>
          ))}
        </div>
        <div className="key-modal-actions">
          <button className="btn-danger" onClick={() => { onSelect(null); onClose(); }}>
            Clear
          </button>
          <button className="btn" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
