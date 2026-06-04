import React from 'react';
import { useAppStore } from '../state/store';
import { todayISO, formatTime12h, parseTime } from '../lib/format';

export function ScheduleSummaryPanel() {
  const services = useAppStore(s => s.config.services);
  const today = todayISO();
  const todayServices = services
    .filter(s => s.date === today)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  return (
    <div className="panel-section">
      <div className="panel-header">
        <div className="panel-title">Today's Schedule</div>
      </div>
      {todayServices.length === 0 ? (
        <div className="schedule-item-empty">No services today</div>
      ) : (
        todayServices.map(svc => {
          const cls = svc.status === 'live' ? 'now'
                    : svc.status === 'queued' ? 'next' : '';
          return (
            <div key={svc.id} className={`schedule-item ${cls}`}>
              <span className="schedule-time">
                {svc.name
                  ? `${svc.name} · ${formatTime12h(parseTime(svc.startTime))}`
                  : formatTime12h(parseTime(svc.startTime))}
              </span>
              <span className="schedule-key">{svc.firstSongKey ?? '—'}</span>
              <span className="schedule-meta">{svc.status.toUpperCase()}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
