import React from 'react';
import { useAppStore } from '../state/store';

export function MidiLogPanel() {
  const log = useAppStore(s => s.midiLog);
  const recent = log.slice(-20).reverse();

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">MIDI Activity</div>
      </div>
      <div className="midi-log">
        {recent.length === 0 ? (
          <div className="midi-log-empty">No MIDI traffic yet. Send a note to verify connection.</div>
        ) : (
          recent.map((e, i) => {
            const t = new Date(e.timestamp);
            const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`;
            const label = e.type.toUpperCase();
            const arrow = e.direction === 'in' ? '←' : '→';
            return (
              <div key={`${e.timestamp}-${i}`} className="midi-log-entry">
                <span className="midi-log-time">{ts}</span>
                <span className={`midi-log-action ${e.direction}`}>
                  {arrow} {label} {e.data1}
                </span>
                <span>
                  ch{e.channel}{e.matchedAction ? ` → ${e.matchedAction}` : ''}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
