import React, { useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import { todayISO, formatTime12h, parseTime } from '../lib/format';
import { resolveServiceFirstSongKey } from '@shared/types';
import type { ServiceInstance } from '@shared/types';

/**
 * Schedule › Day: the day drawn top to bottom like a calendar. Each
 * service shows its pre-service music (from its music start to the service
 * start) and the service itself; a red line marks now. Read-only: Edit
 * jumps to the service's card in the List view.
 */
const HOUR_PX = 120;

function dateAt(date: string, hhmm: string): number {
  const d = new Date(date + 'T00:00:00');
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function ScheduleDayView({ onEdit }: { onEdit: (serviceId: string) => void }) {
  const services = useAppStore(s => s.config.services);
  const playlists = useAppStore(s => s.config.playlists);
  const actionSequences = useAppStore(s => s.config.actionSequences ?? []);
  const today = todayISO();
  const [date, setDate] = useState(() => {
    // Open on the first day from today that has a service.
    const next = services.filter(s => s.date >= today).map(s => s.date).sort()[0];
    return next ?? today;
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i)), [today]);
  const dayServices = useMemo(
    () => services.filter(s => s.date === date).sort((a, b) => a.startTime.localeCompare(b.startTime)),
    [services, date],
  );

  const blocks = dayServices.map((s, i) => {
    const start = dateAt(s.date, s.startTime);
    const musicStart = start - Math.max(0, s.autoStartTargetSec) * 1000;
    const next = dayServices[i + 1];
    const nextMusic = next ? dateAt(next.date, next.startTime) - Math.max(0, next.autoStartTargetSec) * 1000 : Infinity;
    // The service itself: shown up to the next service's music, at most 75 min.
    const end = Math.min(start + 75 * 60_000, nextMusic);
    return { s, start, musicStart, end };
  });

  const nowMs = Date.now();
  const minMs = blocks.length ? Math.min(...blocks.map(b => b.musicStart)) : dateAt(date, '08:00');
  const maxMs = blocks.length ? Math.max(...blocks.map(b => b.end)) : dateAt(date, '12:00');
  const top = new Date(minMs); top.setMinutes(0, 0, 0); top.setHours(top.getHours() - (top.getTime() === minMs ? 1 : 0));
  const startMs = top.getTime();
  const endMs = Math.ceil((maxMs + 30 * 60_000 - startMs) / 3_600_000) * 3_600_000 + startMs;
  const y = (ms: number) => ((ms - startMs) / 3_600_000) * HOUR_PX;
  const hours: number[] = [];
  for (let t = startMs; t <= endMs; t += 3_600_000) hours.push(t);

  const sel = dayServices.find(s => s.id === selectedId) ?? dayServices[0];
  const musicName = (s: ServiceInstance) =>
    s.spotifyPlaylistId ? `${s.spotifyPlaylistName ?? 'Spotify playlist'} · Spotify` : playlists.find(p => p.id === s.preServicePlaylistId)?.name ?? '—';
  const postName = (s: ServiceInstance) => {
    const id = s.postServicePlaylistId;
    if (!id) return '—';
    if (id.startsWith('spotify:')) return 'Spotify playlist';
    return playlists.find(p => p.id === id)?.name ?? '—';
  };

  return (
    <div className="sched-day-view">
      <div className="sched-week" role="tablist" aria-label="Days">
        {week.map(d => {
          const n = services.filter(s => s.date === d).length;
          const dt = new Date(d + 'T00:00:00');
          return (
            <button key={d} type="button" role="tab" aria-selected={d === date}
              className={`sched-week-day ${d === date ? 'on' : ''}`} onClick={() => { setDate(d); setSelectedId(null); }}>
              <span className="sched-week-dow">{d === today ? 'Today' : dt.toLocaleDateString([], { weekday: 'short' })}</span>
              <span className="sched-week-num">{dt.getDate()}</span>
              <span className={`sched-week-count ${n ? '' : 'none'}`}>{n ? `${n} service${n === 1 ? '' : 's'}` : '—'}</span>
            </button>
          );
        })}
      </div>

      <div className="sched-day-body">
        <div className="sched-timeline" style={{ height: y(endMs) + 20 }}>
          {hours.map(h => (
            <div key={h} className="sched-hour" style={{ top: y(h) }}>
              <span>{clock(h)}</span>
            </div>
          ))}
          {dayServices.length === 0 && <div className="sched-day-empty">No services on this day.</div>}
          {blocks.map(({ s, start, musicStart, end }) => {
            const on = sel?.id === s.id;
            return (
              <button key={s.id} type="button" className={`sched-block-group ${on ? 'on' : ''}`} onClick={() => setSelectedId(s.id)}
                style={{ top: y(musicStart), height: y(end) - y(musicStart) }}>
                <div className="sched-block music" style={{ height: y(start) - y(musicStart) }}>
                  <strong>{musicName(s)}</strong>
                  <span>{clock(musicStart)} – {clock(start)}</span>
                </div>
                <div className="sched-block service" style={{ height: y(end) - y(start) }}>
                  <strong>{s.name || 'Service'} · {formatTime12h(parseTime(s.startTime))}</strong>
                  <span>Then post-service: {postName(s)}</span>
                </div>
              </button>
            );
          })}
          {date === today && nowMs >= startMs && nowMs <= endMs && (
            <div className="sched-now" style={{ top: y(nowMs) }}><span>{clock(nowMs)}</span></div>
          )}
        </div>

        {sel && (
          <aside className="sched-day-detail">
            <div className="sched-day-detail-eyebrow">Selected</div>
            <div className="sched-day-detail-title">{sel.name || 'Service'} · {formatTime12h(parseTime(sel.startTime))}</div>
            {[
              ['Music starts', clock(dateAt(sel.date, sel.startTime) - sel.autoStartTargetSec * 1000)],
              ['Pre-service', musicName(sel)],
              ['Land in key', resolveServiceFirstSongKey(sel, services).value ?? 'Auto'],
              ['Post-service', postName(sel)],
              ['Post-service actions', actionSequences.find(a => a.id === sel.postActionSequenceIdOverride)?.name ?? 'From the playlist'],
              ['Status', sel.status],
            ].map(([k, v]) => (
              <div key={k} className="sched-day-detail-row"><span>{k}</span><strong>{v}</strong></div>
            ))}
            <button type="button" className="btn-primary" onClick={() => onEdit(sel.id)}>Edit this service</button>
          </aside>
        )}
      </div>
    </div>
  );
}
