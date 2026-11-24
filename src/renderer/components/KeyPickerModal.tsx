import React from 'react';
import { MAJOR_KEYS, MINOR_KEYS, altKeyName, displayKey } from '@shared/music';
import { useAppStore } from '../state/store';
import type { KeyName } from '@shared/types';

interface Props {
  open: boolean;
  selected?: KeyName;
  onSelect: (k: KeyName | null) => void;
  onClose: () => void;
}

export function KeyPickerModal({ open, selected, onSelect, onClose }: Props) {
  const keyMode = useAppStore(s => s.config.defaults.keyDisplayMode ?? 'sharp');
  if (!open) return null;
  const name = (k: KeyName) => {
    const alt = altKeyName(k, keyMode);
    return <>{displayKey(k, keyMode)}{alt && <span className="key-modal-key-alt">{alt}</span>}</>;
  };
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
              {name(k)}
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
              {name(k)}
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
