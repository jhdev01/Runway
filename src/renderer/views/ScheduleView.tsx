import { ScheduleDayView } from '../components/ScheduleDayView';
import React, { useMemo, useState } from 'react';
import { PreServicePlaylistSelect, PostServicePlaylistSelect } from '../components/PreServicePlaylistSelect';
import { useAppStore, generateId } from '../state/store';
import { useEngines } from '../state/engines';
import { KeyPickerModal } from '../components/KeyPickerModal';
import { ProPresenterServiceModal } from '../components/ProPresenterServiceModal';
import { formatTime12h, parseTime, dayName, formatDateLong, todayISO } from '../lib/format';
import type { KeyName, ServiceInstance, WeeklyPatternEntry } from '@shared/types';
import { resolveServiceFirstSongKey, resolveServiceLastSongTrackId, effectiveDuration } from '@shared/types';
import { keyColor, displayKey } from '@shared/music';
import { InfoTip } from '../components/InfoTip';

export function ScheduleView() {
  const services = useAppStore(s => s.config.services);
  const playlists = useAppStore(s => s.config.playlists);
  const weeklyPattern = useAppStore(s => s.config.weeklyPattern);
  const weeklyPatternMode = useAppStore(s => s.config.weeklyPatternMode);
  const actionSequences = useAppStore(s => s.config.actionSequences ?? []);
  const upsertService = useAppStore(s => s.upsertService);
  const updateConfig = useAppStore(s => s.updateConfig);
  const generateServicesFromPattern = useAppStore(s => s.generateServicesFromPattern);
  const { controller } = useEngines();
  // Delete via controller so a running service's audio fades out instead of
  // hard-cutting when the user removes it (or hits Clear all).
  const deleteService = (id: string) => controller.deleteServiceWithFade(id);

  const [keyEditingServiceId, setKeyEditingServiceId] = useState<string | null>(null);
  // List (cards, for editing) or Day (timeline). Remembered.
  const scheduleMode = useAppStore(s => s.config.ui?.scheduleView ?? 'list');
  const setScheduleMode = (m: 'list' | 'day') => updateConfig({ ui: { ...useAppStore.getState().config.ui, scheduleView: m } });
  const [activeDayOfWeek, setActiveDayOfWeek] = useState(0);
  const [generateMsg, setGenerateMsg] = useState<string | null>(null);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [ppPatternModalId, setPpPatternModalId] = useState<string | null>(null);
  // Pattern row's settings open in a modal (matches the materialized
  // service card's gear UX). One row's modal open at a time; closing
  // returns to null.
  const [patternSettingsId, setPatternSettingsId] = useState<string | null>(null);
  // List view (new look): one day at a time, picked from the week strip.
  const [pickedDate, setPickedDate] = useState<string | null>(null);
  const [patternOpen, setPatternOpen] = useState(() => (useAppStore.getState().config.weeklyPattern ?? []).length === 0);

  // Group services by date — show next 14 days
  const upcoming = useMemo(() => {
    const today = todayISO();
    const sorted = [...services]
      .filter(s => s.date >= today)
      .sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    const groups: Record<string, ServiceInstance[]> = {};
    for (const svc of sorted) {
      groups[svc.date] = groups[svc.date] || [];
      groups[svc.date].push(svc);
    }
    return groups;
  }, [services]);

  // Count of all upcoming (today and forward) services — controls whether the
  // Clear-all button is enabled and what its label says.
  const upcomingCount = useMemo(() => {
    const today = todayISO();
    return services.filter(s => s.date >= today).length;
  }, [services]);

  const onClearAll = () => {
    if (!confirmClearAll) {
      setConfirmClearAll(true);
      window.setTimeout(() => setConfirmClearAll(false), 3000);
      return;
    }
    setConfirmClearAll(false);
    // Delete each upcoming service via the existing action so tombstones
    // are written and prevent the pattern generator from immediately
    // re-creating them.
    const today = todayISO();
    const ids = services.filter(s => s.date >= today).map(s => s.id);
    for (const id of ids) deleteService(id);
  };

  const onAddService = (date?: string) => {
    const today = todayISO();
    const newSvc: ServiceInstance = {
      id: generateId(),
      date: date ?? (pickedDate && pickedDate !== 'later' && pickedDate >= today ? pickedDate : today),
      startTime: '09:00',
      preServicePlaylistId: playlists.find(p => p.kind === 'pre')?.id,
      postServicePlaylistId: playlists.find(p => p.kind === 'post')?.id,
      firstSongKey: undefined,
      setlist: [],
      autoStartTargetSec: useAppStore.getState().config.defaults.autoStartTargetSec,
      status: 'scheduled',
    };
    upsertService(newSvc);
  };

  const editingService = services.find(s => s.id === keyEditingServiceId);

  // Sort pattern rows chronologically — the operator scans by clock-time
  // order, not pattern-entry creation order. Pure UI sort; saved order
  // in config is preserved.
  const dayPattern = weeklyPattern
    .filter(p => p.dayOfWeek === activeDayOfWeek)
    .slice()
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const onAddPatternRow = () => {
    const newRow: WeeklyPatternEntry = {
      id: generateId(),
      dayOfWeek: activeDayOfWeek,
      startTime: '09:00',
      preServicePlaylistId: playlists.find(p => p.kind === 'pre')?.id,
      postServicePlaylistId: playlists.find(p => p.kind === 'post')?.id,
      enabled: true,
    };
    updateConfig({ weeklyPattern: [...weeklyPattern, newRow] });
  };

  const onRemovePatternRow = (id: string) => {
    updateConfig({ weeklyPattern: weeklyPattern.filter(p => p.id !== id) });
  };

  const onUpdatePatternRow = (id: string, patch: Partial<WeeklyPatternEntry>) => {
    updateConfig({
      weeklyPattern: weeklyPattern.map(p => p.id === id ? { ...p, ...patch } : p),
    });
  };

  const runGenerate = (
    days: number,
    windowLabel: string,
    opts?: { respectTombstones?: boolean },
  ) => {
    const added = generateServicesFromPattern(days, opts);
    setGenerateMsg(
      added === 0
        ? `No new services. ${windowLabel} is already scheduled.`
        : `Created ${added} service${added === 1 ? '' : 's'}.`,
    );
    window.setTimeout(() => setGenerateMsg(null), 4000);
  };
  // Recurring mode's automatic generation respects tombstones (so deleting
  // tomorrow's service doesn't immediately get re-created).
  // Recurring's manual button overrides tombstones so a previously-deleted
  // service can be restored on demand. Generates today only.
  const onGenerateRecurring = () => runGenerate(1, "today's services", { respectTombstones: false });
  // Manual Load buttons explicitly override tombstones — the operator is
  // clearly asking for those services back. Tombstones for the loaded window
  // are dropped inside generateServicesFromPattern.
  const onLoadToday = () => runGenerate(1, "today's services", { respectTombstones: false });
  const onLoadThisWeek = () => runGenerate(7, 'the next 7 days', { respectTombstones: false });
  const onLoadFourWeeks = () => runGenerate(28, 'the next 4 weeks', { respectTombstones: false });

  return (
    <div className="schedule-view">
      <div className={`sched-content ${scheduleMode === 'list' ? 'with-aside' : ''}`}>

        <section className="sched-section">
          <div className="sched-section-header">
            <div>
              <div className="sched-section-title">Upcoming services<InfoTip>The next two weeks. Each card sets its own first-song key.</InfoTip></div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {upcomingCount > 0 && (
                <button
                  className={`btn-secondary ${confirmClearAll ? 'btn-confirm-danger' : ''}`}
                  onClick={onClearAll}
                  title="Delete every upcoming service. The weekly pattern won't add them back."
                >
                  {confirmClearAll
                    ? `Click again to clear (${upcomingCount})`
                    : `Clear all (${upcomingCount})`}
                </button>
              )}
              <div className="runway-view-switch" role="group" aria-label="Schedule view">
                {(['list', 'day'] as const).map(m => (
                  <button key={m} type="button" className={scheduleMode === m ? 'on' : ''} onClick={() => setScheduleMode(m)}>
                    {m === 'list' ? 'List' : 'Day'}
                  </button>
                ))}
              </div>
              <button className="btn-primary" onClick={() => onAddService()}>+ Add service</button>
            </div>
          </div>

          {scheduleMode === 'day' ? (
            <ScheduleDayView onEdit={(id) => {
              setScheduleMode('list');
              window.setTimeout(() => document.querySelector(`[data-service-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
            }} />
          ) : (() => {
            const today = todayISO();
            const addDays = (iso: string, n: number) => {
              const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
              const p2 = (x: number) => String(x).padStart(2, '0');
              return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
            };
            const week = Array.from({ length: 7 }, (_, i) => addDays(today, i));
            const laterDates = Object.keys(upcoming).filter(d => d > week[6]);
            const firstWithServices = Object.keys(upcoming)[0];
            const sel = pickedDate && (pickedDate === 'later' || pickedDate >= today) ? pickedDate
              : firstWithServices && firstWithServices <= week[6] ? firstWithServices
              : firstWithServices ? 'later' : today;
            const dayList = sel === 'later'
              ? laterDates.flatMap(d => upcoming[d])
              : (upcoming[sel] ?? []);
            const relLabel = (d: string) => d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : null;
            const eyebrow = sel === 'later' ? 'Later' : [relLabel(sel), formatDateLong(sel)].filter(Boolean).join(' · ');
            return (
              <>
                <div className="sched-a-week" role="tablist" aria-label="Days">
                  {week.map(d => {
                    const n = upcoming[d]?.length ?? 0;
                    const dt = new Date(d + 'T00:00:00');
                    return (
                      <button key={d} type="button" role="tab" aria-selected={sel === d}
                        className={`sched-a-day ${sel === d ? 'on' : ''}`} onClick={() => setPickedDate(d)}>
                        <span className="dow">{d === today ? 'Today' : dt.toLocaleDateString([], { weekday: 'short' })}</span>
                        <span className="num">{dt.getDate()}</span>
                        <span className={`cnt ${n ? 'has' : ''}`}>{n ? `${n} service${n === 1 ? '' : 's'}` : '—'}</span>
                      </button>
                    );
                  })}
                  {laterDates.length > 0 && (
                    <button type="button" role="tab" aria-selected={sel === 'later'}
                      className={`sched-a-day ${sel === 'later' ? 'on' : ''}`} onClick={() => setPickedDate('later')}>
                      <span className="dow">Later</span>
                      <span className="num">+</span>
                      <span className="cnt has">{laterDates.reduce((t, d) => t + upcoming[d].length, 0)} more</span>
                    </button>
                  )}
                </div>
                <div className="sched-a-dayhead">
                  <div className="sched-a-eyebrow">{eyebrow}</div>
                  <div className="sched-a-title">{dayList.length === 0 ? 'No services' : `${dayList.length} service${dayList.length === 1 ? '' : 's'}`}</div>
                </div>
                {dayList.length === 0 ? (
                  <div className="sched-a-empty">
                    Nothing scheduled{sel === 'later' ? ' later' : ' on this day'}.
                    {sel !== 'later' && <button className="btn-secondary" onClick={() => onAddService(sel)}>+ Add a service on this day</button>}
                  </div>
                ) : dayList.map(svc => (
                  <div key={svc.id} data-service-id={svc.id}>
                    {sel === 'later' && <div className="sched-a-later-date">{formatDateLong(svc.date)}</div>}
                    <ServiceCard
                      service={svc}
                      onEditKey={() => setKeyEditingServiceId(svc.id)}
                      onUpdate={patch => upsertService({ ...svc, ...patch })}
                      onDelete={() => deleteService(svc.id)}
                    />
                  </div>
                ))}
              </>
            );
          })()}
        </section>

        {(patternOpen || scheduleMode !== 'list') && (
        <section className="sched-section sched-pattern-section">
          <div className="sched-section-header">
            <div>
              <div className="sched-section-title">
                Weekly pattern
                <InfoTip>
                  Service times that repeat every week. Checked rows become
                  services when Runway opens and every hour after.
                  {weeklyPatternMode === 'auto_rotate'
                    ? ' Recurring: today’s and tomorrow’s services appear on their own.'
                    : ' Manual: services appear only when you click a Load button.'}
                </InfoTip>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
              {generateMsg && (
                <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{generateMsg}</span>
              )}
              <select
                value={weeklyPatternMode}
                onChange={e => updateConfig({ weeklyPatternMode: e.target.value as 'manual' | 'auto_rotate' })}
                style={{
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  borderRadius: 5,
                  padding: '6px 10px',
                  fontSize: 13,
                }}
                title="How weekly pattern entries become real services"
              >
                <option value="auto_rotate">Recurring / Auto</option>
                <option value="manual">Manual</option>
              </select>
              {weeklyPatternMode === 'auto_rotate' ? (
                <button className="btn-secondary" onClick={onGenerateRecurring}>
                  Generate today
                </button>
              ) : (
                <>
                  <button className="btn-secondary" onClick={onLoadToday}>
                    Load today
                  </button>
                  <button className="btn-secondary" onClick={onLoadThisWeek}>
                    Load this week
                  </button>
                  <button className="btn-secondary" onClick={onLoadFourWeeks}>
                    Load next 4 weeks
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="pattern-card">
            <div className="pattern-day-list">
              {[0, 1, 2, 3, 4, 5, 6].map(d => {
                const count = weeklyPattern.filter(p => p.dayOfWeek === d).length;
                return (
                  <button
                    key={d}
                    className={`pattern-day ${activeDayOfWeek === d ? 'active' : ''}`}
                    onClick={() => setActiveDayOfWeek(d)}
                  >
                    <span>{dayName(d)}</span>
                    <span className="pattern-day-count">{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="pattern-services">
              {dayPattern.length === 0 ? (
                <div style={{ color: 'var(--text-faint)', fontSize: 14, padding: '8px 4px' }}>
                  No services for {dayName(activeDayOfWeek)}.
                </div>
              ) : (
                dayPattern.map(p => {
                  const defaultLeadMin = Math.round(
                    (useAppStore.getState().config.defaults.autoStartTargetSec ?? 900) / 60,
                  );
                  const leadMin = p.autoStartTargetSec !== undefined
                    ? Math.round(p.autoStartTargetSec / 60)
                    : null;
                  return (
                    <div
                      key={p.id}
                      className={`pattern-service-row ${p.enabled ? '' : 'pattern-service-disabled'} pattern-service-collapsed`}
                    >
                      <label
                        className="pattern-cell-check"
                        title={p.enabled ? 'On: adds services automatically' : 'Off: kept, but adds no services'}
                      >
                        <input
                          type="checkbox"
                          checked={p.enabled}
                          onChange={e => onUpdatePatternRow(p.id, { enabled: e.target.checked })}
                          style={{ accentColor: 'var(--accent)' }}
                        />
                      </label>
                      <div className="pattern-cell-time">
                        <label className="service-when-field service-when-time" title="Service start time">
                          <span className="service-when-tag">TIME</span>
                          <input
                            className="pattern-service-time"
                            type="time"
                            value={p.startTime}
                            onChange={e => onUpdatePatternRow(p.id, { startTime: e.target.value })}
                          />
                        </label>
                      </div>
                      <input
                        className="pattern-cell-title pattern-name-input"
                        type="text"
                        value={p.name ?? ''}
                        onChange={e => onUpdatePatternRow(p.id, { name: e.target.value || undefined })}
                        placeholder="Service name (optional)"
                      />
                      <button
                        className="pattern-cell-gear btn-secondary"
                        onClick={() => setPatternSettingsId(p.id)}
                        title="Show playlists, action sequences, lead time, ProPresenter, pad bridge"
                        aria-label="Open pattern row settings"
                      >
                        <span aria-hidden>⚙</span>
                      </button>
                      {false && (<>
                      <select
                        className="pattern-playlist-select pattern-cell-pre"
                        value={p.preServicePlaylistId || ''}
                        onChange={e => onUpdatePatternRow(p.id, { preServicePlaylistId: e.target.value || undefined })}
                      >
                        <option value="">— no pre-service playlist —</option>
                        {playlists.filter(pl => pl.kind === 'pre').map(pl => (
                          <option key={pl.id} value={pl.id}>Pre · {pl.name}</option>
                        ))}
                      </select>
                      <select
                        className="pattern-playlist-select pattern-cell-post"
                        value={p.postServicePlaylistId || ''}
                        onChange={e => onUpdatePatternRow(p.id, { postServicePlaylistId: e.target.value || undefined })}
                      >
                        <option value="">— no post-service playlist —</option>
                        {playlists.filter(pl => pl.kind === 'post').map(pl => (
                          <option key={pl.id} value={pl.id}>Post · {pl.name}</option>
                        ))}
                      </select>
                      {(() => {
                        // Inline action-sequence picker for the pattern row.
                        // Tri-state value: undefined = inherit, '' = no actions,
                        // any id = override. Mirrors the per-service picker so
                        // services materialized from this pattern carry the
                        // same override (see generateServicesFromPattern).
                        const INHERIT_PAT = '__inherit__';
                        const NONE_PAT = '__none__';
                        const renderPatternAction = (kind: 'pre' | 'post') => {
                          const playlistId = kind === 'pre' ? p.preServicePlaylistId : p.postServicePlaylistId;
                          const inheritedFrom = playlistId
                            ? playlists.find(pl => pl.id === playlistId)
                            : undefined;
                          const inheritedSeqId = inheritedFrom?.actionSequenceId;
                          const inheritedSeqName = inheritedSeqId
                            ? actionSequences.find(s => s.id === inheritedSeqId)?.name
                            : undefined;
                          const stored = kind === 'pre'
                            ? p.preActionSequenceIdOverride
                            : p.postActionSequenceIdOverride;
                          const currentValue = stored === undefined ? INHERIT_PAT : stored === '' ? NONE_PAT : stored;
                          const onPick = (raw: string) => {
                            const next = raw === INHERIT_PAT ? undefined : raw === NONE_PAT ? '' : raw;
                            if (kind === 'pre') onUpdatePatternRow(p.id, { preActionSequenceIdOverride: next });
                            else onUpdatePatternRow(p.id, { postActionSequenceIdOverride: next });
                          };
                          return (
                            <select
                              key={kind}
                              className={`pattern-playlist-select pattern-cell-${kind}-action`}
                              value={currentValue}
                              onChange={e => onPick(e.target.value)}
                              title={`${kind === 'pre' ? 'Pre' : 'Post'}-service action sequence for services created from this row.`}
                              disabled={!playlistId && !inheritedSeqId}
                            >
                              <option value={INHERIT_PAT}>
                                Inherit{inheritedSeqName ? ` (${inheritedSeqName})` : ''}
                              </option>
                              <option value={NONE_PAT}>— No actions —</option>
                              {actionSequences.length > 0 && (
                                <optgroup label="Override with">
                                  {actionSequences.map(s => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                  ))}
                                </optgroup>
                              )}
                            </select>
                          );
                        };
                        return <>{renderPatternAction('pre')}{renderPatternAction('post')}</>;
                      })()}
                      <div
                        className="pattern-cell-lead"
                        title={`Pre-service music starts this many minutes before service start. Leave blank to use the default (${defaultLeadMin} min).`}
                      >
                        <input
                          type="number"
                          min={0}
                          max={240}
                          step={1}
                          value={leadMin ?? ''}
                          placeholder={String(defaultLeadMin)}
                          onChange={e => {
                            const v = e.target.value;
                            if (v === '') {
                              onUpdatePatternRow(p.id, { autoStartTargetSec: undefined });
                            } else {
                              const mins = Math.max(0, Math.min(240, +v || 0));
                              onUpdatePatternRow(p.id, { autoStartTargetSec: mins * 60 });
                            }
                          }}
                          style={{
                            width: 52,
                            background: 'var(--bg-elev)',
                            border: '1px solid var(--border)',
                            borderRadius: 4,
                            color: 'var(--text)',
                            padding: '3px 6px',
                            fontSize: 13,
                            fontFamily: 'inherit',
                          }}
                        />
                        <span>Min before</span>
                      </div>
                      <div className="pattern-cell-pp">
                        <button
                          className={`pattern-pp-btn ${p.proPresenterOverride ? 'active' : ''}`}
                          onClick={() => setPpPatternModalId(p.id)}
                          title={p.proPresenterOverride
                            ? 'This row has its own ProPresenter setup'
                            : 'ProPresenter setup for services from this row'}
                        >
                          ProPresenter setup{p.proPresenterOverride ? ' ●' : ''}
                        </button>
                        <label
                          className="pattern-pad-toggle"
                          title="Off: music fades out at service start, no pad."
                        >
                          <input
                            type="checkbox"
                            checked={!p.disablePadBridge}
                            onChange={e => onUpdatePatternRow(p.id, { disablePadBridge: !e.target.checked || undefined })}
                            style={{ accentColor: 'var(--accent)' }}
                          />
                          <span>Pad bridge</span>
                        </label>
                      </div>
                      </>)}
                      <button
                        className="pattern-service-remove"
                        onClick={() => onRemovePatternRow(p.id)}
                        aria-label="Remove pattern row"
                      ><span aria-hidden style={{ fontSize: 28, lineHeight: 1 }}>×</span></button>
                    </div>
                  );
                })
              )}
              <button className="pattern-add-service" onClick={onAddPatternRow}>+ Add service time</button>
            </div>
          </div>
        </section>
        )}

      </div>
      {scheduleMode === 'list' && (
        <aside className="sched-a-aside">
          <div className="sched-a-aside-head">
            <span>Weekly pattern</span>
            <span className={`sched-a-mode ${weeklyPatternMode === 'auto_rotate' ? 'auto' : ''}`}>
              {weeklyPatternMode === 'auto_rotate' ? 'Adds services automatically' : 'Manual'}
            </span>
          </div>
          {weeklyPattern.length === 0 ? (
            <div className="sched-a-aside-note">No weekly times yet. Add the times you meet every week and Runway schedules them for you.</div>
          ) : (
            [...weeklyPattern]
              .sort((x, y) => x.dayOfWeek - y.dayOfWeek || x.startTime.localeCompare(y.startTime))
              .map(p => (
                <button key={p.id} type="button" className={`sched-a-pat ${p.enabled ? '' : 'off'}`}
                  onClick={() => { setActiveDayOfWeek(p.dayOfWeek); setPatternOpen(true); window.setTimeout(() => document.querySelector('.sched-pattern-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }}
                  title={p.enabled ? 'Edit this weekly time' : 'Off: kept, but adds no services. Click to edit'}>
                  <span className="d">{dayName(p.dayOfWeek).slice(0, 3)}</span>
                  <span className="t">
                    <strong>{formatTime12h(parseTime(p.startTime))}</strong>
                    <span>{p.name || playlists.find(pl => pl.id === p.preServicePlaylistId)?.name || (p.spotifyPlaylistName ? `${p.spotifyPlaylistName} · Spotify` : 'No playlist')}</span>
                  </span>
                  <span className="chev" aria-hidden>›</span>
                </button>
              ))
          )}
          <button type="button" className="sched-a-pat-edit" onClick={() => { setPatternOpen(o => !o); window.setTimeout(() => document.querySelector('.sched-pattern-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60); }}>
            {patternOpen ? 'Hide pattern editor' : 'Edit weekly pattern'}
          </button>
          <div className="sched-a-aside-foot">
            Services from the pattern appear in the schedule on their own. Deleting one blocks that time slot so it doesn’t come back.
          </div>
        </aside>
      )}

      {ppPatternModalId && (() => {
        const row = weeklyPattern.find(p => p.id === ppPatternModalId);
        if (!row) return null;
        return (
          <ProPresenterServiceModal
            title={row.name || `${dayName(row.dayOfWeek)} pattern`}
            subtitle={`${dayName(row.dayOfWeek)} · ${row.startTime}`}
            override={row.proPresenterOverride}
            onClose={() => setPpPatternModalId(null)}
            onSave={(override) => onUpdatePatternRow(row.id, { proPresenterOverride: override })}
          />
        );
      })()}

      {patternSettingsId && (() => {
        const row = weeklyPattern.find(p => p.id === patternSettingsId);
        if (!row) return null;
        const defaultLeadMin = Math.round(
          (useAppStore.getState().config.defaults.autoStartTargetSec ?? 900) / 60,
        );
        const leadMin = row.autoStartTargetSec !== undefined
          ? Math.round(row.autoStartTargetSec / 60)
          : null;
        const INHERIT_PAT = '__inherit__';
        const NONE_PAT = '__none__';
        const renderPatternAction = (kind: 'pre' | 'post') => {
          const playlistId = kind === 'pre' ? row.preServicePlaylistId : row.postServicePlaylistId;
          const inheritedFrom = playlistId
            ? playlists.find(pl => pl.id === playlistId)
            : undefined;
          const inheritedSeqId = inheritedFrom?.actionSequenceId;
          const inheritedSeqName = inheritedSeqId
            ? actionSequences.find(s => s.id === inheritedSeqId)?.name
            : undefined;
          const stored = kind === 'pre' ? row.preActionSequenceIdOverride : row.postActionSequenceIdOverride;
          const currentValue = stored === undefined ? INHERIT_PAT : stored === '' ? NONE_PAT : stored;
          const onPick = (raw: string) => {
            const next = raw === INHERIT_PAT ? undefined : raw === NONE_PAT ? '' : raw;
            if (kind === 'pre') onUpdatePatternRow(row.id, { preActionSequenceIdOverride: next });
            else onUpdatePatternRow(row.id, { postActionSequenceIdOverride: next });
          };
          return (
            <select
              className="select"
              value={currentValue}
              onChange={e => onPick(e.target.value)}
              disabled={!playlistId && !inheritedSeqId}
            >
              <option value={INHERIT_PAT}>Inherit{inheritedSeqName ? ` (${inheritedSeqName})` : ''}</option>
              <option value={NONE_PAT}>— No actions —</option>
              {actionSequences.length > 0 && (
                <optgroup label="Override with">
                  {actionSequences.map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </optgroup>
              )}
            </select>
          );
        };
        return (
          <div className="settings-modal-backdrop" onClick={() => setPatternSettingsId(null)}>
            <div className="settings-modal" onClick={e => e.stopPropagation()}>
              <div className="settings-modal-header">
                <div>
                  <div className="settings-modal-title">{row.name || `${dayName(row.dayOfWeek)} pattern`} · settings</div>
                  <div className="settings-modal-sub">{dayName(row.dayOfWeek)} · {row.startTime}</div>
                </div>
                <button className="settings-modal-close" onClick={() => setPatternSettingsId(null)} aria-label="Close settings">×</button>
              </div>
              <div className="service-card-body settings-modal-body">
                <div className="service-field">
                  <span className="service-field-label">Pre-service playlist</span>
                  <PreServicePlaylistSelect
                    value={row}
                    onChange={patch => onUpdatePatternRow(row.id, patch)}
                  />
                </div>
                <div className="service-field">
                  <span className="service-field-label">Post-service playlist</span>
                  <PostServicePlaylistSelect
                    value={row.postServicePlaylistId}
                    onChange={v => onUpdatePatternRow(row.id, { postServicePlaylistId: v })}
                  />
                </div>
                <div className="service-field">
                  <span className="service-field-label">Pre-service action sequence</span>
                  {renderPatternAction('pre')}
                </div>
                <div className="service-field">
                  <span className="service-field-label">Post-service action sequence</span>
                  {renderPatternAction('post')}
                </div>
                <div className="service-field">
                  <span className="service-field-label">Auto-start target</span>
                  <div className="service-field-control">
                    <input
                      type="number"
                      min={0}
                      max={240}
                      step={1}
                      value={leadMin ?? ''}
                      placeholder={String(defaultLeadMin)}
                      onChange={e => {
                        const v = e.target.value;
                        if (v === '') {
                          onUpdatePatternRow(row.id, { autoStartTargetSec: undefined });
                        } else {
                          const mins = Math.max(0, Math.min(240, +e.target.value || 0));
                          onUpdatePatternRow(row.id, { autoStartTargetSec: mins * 60 });
                        }
                      }}
                      style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: 'var(--text)', padding: 0, fontFamily: 'inherit', fontSize: 14 }}
                    />
                    <span style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.04em' }}>MIN BEFORE</span>
                  </div>
                </div>
                <div className="service-field">
                  <span className="service-field-label">Pad bridge</span>
                  <label
                    className="service-field-control"
                    style={{ cursor: 'pointer', justifyContent: 'flex-start', gap: 10 }}
                    title="Off: music fades out at service start, no pad."
                  >
                    <input
                      type="checkbox"
                      checked={!row.disablePadBridge}
                      onChange={e => onUpdatePatternRow(row.id, { disablePadBridge: !e.target.checked || undefined })}
                      style={{ accentColor: 'var(--accent)', margin: 0 }}
                    />
                    <span style={{ color: row.disablePadBridge ? 'var(--text-faint)' : 'var(--text)', fontSize: 14 }}>
                      {row.disablePadBridge ? 'Off' : 'On'}
                    </span>
                  </label>
                </div>
                <div className="service-field service-field-pp" style={{ gridColumn: '1 / -1' }}>
                  <span className="service-field-label">ProPresenter</span>
                  <button
                    className={`btn-secondary ${row.proPresenterOverride ? 'btn-active' : ''}`}
                    onClick={() => setPpPatternModalId(row.id)}
                    style={{ justifySelf: 'start' }}
                  >
                    ProPresenter setup{row.proPresenterOverride ? ' ●' : ''}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      <KeyPickerModal
        open={keyEditingServiceId !== null}
        selected={editingService?.firstSongKey}
        onSelect={(k) => {
          if (editingService) upsertService({ ...editingService, firstSongKey: k ?? undefined, firstSongKeyManual: k ? true : undefined });
        }}
        onClose={() => setKeyEditingServiceId(null)}
      />
    </div>
  );
}

function ServiceCard({ service, onEditKey, onUpdate, onDelete }: {
  service: ServiceInstance;
  onEditKey: () => void;
  onUpdate: (patch: Partial<ServiceInstance>) => void;
  onDelete: () => void;
}) {
  const playlists = useAppStore(s => s.config.playlists);
  const tracks = useAppStore(s => s.config.tracks);
  const allServices = useAppStore(s => s.config.services);
  const actionSequences = useAppStore(s => s.config.actionSequences ?? []);
  const isLive = service.status === 'live';

  // Resolve effective key + pin via the inheritance chain (later services on
  // the same date inherit from the first service of that date).
  const keyResolved = resolveServiceFirstSongKey(service, allServices);
  const pinResolved = resolveServiceLastSongTrackId(service, allServices);
  const effectiveKey = keyResolved.value;
  // Spotify music: the imported playlist's songs and their keys (Last song picker).
  const spotifyCache = useAppStore(s => s.config.spotify?.playlistCache);
  const spotifyEdits = useAppStore(s => s.config.spotify?.trackEdits);
  const effectivePin = pinResolved.value;
  const keyInheritFrom = keyResolved.inheritedFrom;
  const pinInheritFrom = pinResolved.inheritedFrom;

  // Tracks that could anchor this service: present in the service's
  // pre-service playlist AND tagged in the resolved key. Filtering by
  // playlist membership keeps the dropdown honest — library tracks
  // removed from this playlist no longer show as pin candidates.
  const tracksInKey = useMemo(() => {
    if (!effectiveKey) return [];
    const playlist = service.preServicePlaylistId
      ? playlists.find(p => p.id === service.preServicePlaylistId)
      : undefined;
    if (!playlist) return [];
    const inPlaylist = new Set(playlist.trackIds);
    return tracks
      .filter(t => inPlaylist.has(t.id) && t.key === effectiveKey)
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [tracks, effectiveKey, playlists, service.preServicePlaylistId]);

  // If a pin points to a track that's no longer in this playlist (or got
  // removed from the library), surface it explicitly so the dropdown
  // doesn't silently snap to "Auto" — the user can see what's stuck and
  // pick a fresh option.
  const stalePinTrack = useMemo(() => {
    if (!effectivePin) return null;
    if (tracksInKey.some(t => t.id === effectivePin)) return null;
    return tracks.find(t => t.id === effectivePin) ?? null;
  }, [effectivePin, tracksInKey, tracks]);

  const inheritHint = (from: ServiceInstance) => {
    const sec = parseTime(from.startTime);
    return `Matching ${formatTime12h(sec)}`;
  };

  const minutesUntil = (() => {
    const target = new Date(`${service.date}T${service.startTime}:00`).getTime();
    const diff = target - Date.now();
    if (diff < 0) return null;
    const min = Math.floor(diff / 60000);
    const h = Math.floor(min / 60);
    return h > 0 ? `T-${h}h ${min % 60}m` : `T-${min}m`;
  })();

  const [ppModalOpen, setPpModalOpen] = useState(false);
  // Gear-expanded state: when false, only the First song's key field
  // shows in the card body. All other fields (last song, playlists,
  // auto-start, pad bridge, action sequences, ProPresenter setup) live
  // behind the ⚙ gear button so the schedule reads as a clean roster of
  // (time, key) by default. The weekly pattern row is the source of
  // truth for the rest; the gear lets you override per-occurrence when
  // needed.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const keyMode = useAppStore(s => s.config.defaults.keyDisplayMode ?? 'sharp');

  return (
    <div className={`service-card ${isLive ? 'live' : ''} ${settingsOpen ? 'settings-open' : ''}`}>
      {(() => {
        const cfgAll = useAppStore.getState().config;
        const lead = Math.max(0, service.autoStartTargetSec);
        const fmtMin = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
        const spotifyName = (id: string) => cfgAll.spotify?.playlistCache?.[id]?.name ?? 'Spotify playlist';
        const prePl = service.preServicePlaylistId ? playlists.find(p => p.id === service.preServicePlaylistId) : undefined;
        const preName = service.spotifyPlaylistId
          ? `${service.spotifyPlaylistName ?? spotifyName(service.spotifyPlaylistId)} · Spotify`
          : prePl?.name;
        const postId = service.postServicePlaylistId;
        const postName = !postId ? undefined
          : postId.startsWith('spotify:') ? `${spotifyName(postId.slice(8))} · Spotify`
          : playlists.find(p => p.id === postId)?.name;
        const postSeqId = service.postActionSequenceIdOverride !== undefined
          ? service.postActionSequenceIdOverride
          : postId?.startsWith('spotify:')
            ? cfgAll.spotify?.playlistSettings?.[postId.slice(8)]?.actionSequenceId
            : playlists.find(p => p.id === postId)?.actionSequenceId;
        const postSeqName = postSeqId ? actionSequences.find(a => a.id === postSeqId)?.name : undefined;

        // Readiness (display only).
        const preTotal = service.spotifyPlaylistId
          ? (cfgAll.spotify?.playlistCache?.[service.spotifyPlaylistId]?.tracks ?? []).reduce((t, x) => t + x.durationMs / 1000, 0)
          : (prePl?.trackIds ?? []).reduce((t, id) => { const tr = tracks.find(x => x.id === id); return t + (tr ? effectiveDuration(tr) : 0); }, 0);
        const repeat = cfgAll.defaults.repeatToFill ?? true;
        const checks: { text: string; tone: 'ok' | 'warn' | 'off' }[] = [];
        if (!preName) checks.push({ text: 'No pre-service playlist', tone: 'warn' });
        else if (lead > 0 && preTotal >= lead) checks.push({ text: `Playlist fills ${fmtMin(lead)}`, tone: 'ok' });
        else if (lead > 0 && repeat) checks.push({ text: `Playlist repeats to fill ${fmtMin(lead)}`, tone: 'ok' });
        else if (lead > 0) checks.push({ text: `Playlist is ${fmtMin(lead - preTotal)} short, so music starts later`, tone: 'warn' });
        if (effectiveKey) {
          checks.push({ text: keyInheritFrom ? `Lands in ${effectiveKey} (${inheritHint(keyInheritFrom).toLowerCase()})` : `Lands in ${effectiveKey}`, tone: 'ok' });
          const hasPad = (cfgAll.pads ?? []).some(pd => pd.key === effectiveKey);
          checks.push({ text: hasPad ? `Pad for ${effectiveKey}` : `No pad for ${effectiveKey}`, tone: hasPad ? 'ok' : 'warn' });
        } else {
          checks.push({ text: 'No first-song key yet', tone: 'warn' });
        }
        const pp = cfgAll.proPresenterSync;
        checks.push(pp?.enabled && pp.timerUuid
          ? { text: 'ProPresenter countdown', tone: 'ok' }
          : { text: 'ProPresenter countdown off', tone: 'off' });

        const startMs = new Date(`${service.date}T${service.startTime}:00`).getTime();
        const musicMs = startMs - lead * 1000;
        const now = Date.now();
        const until = (ms: number) => {
          const min = Math.max(0, Math.floor((ms - now) / 60000));
          const h = Math.floor(min / 60), d = Math.floor(h / 24);
          return d >= 2 ? `${d} days` : h > 0 ? `${h}h ${min % 60}m` : `${min}m`;
        };
        const when = service.status === 'live' ? 'running now'
          : now < musicMs ? `music in ${until(musicMs)}`
          : now < startMs ? `service in ${until(startMs)}`
          : '';
        const statusLabel = service.status === 'queued' ? 'Armed' : service.status === 'live' ? 'Live' : service.status === 'completed' ? 'Done' : 'Scheduled';
        const musicPct = Math.max(45, Math.min(80, 40 + lead / 60));

        return (
          <>
            <div className="svc-a-top">
              <div className="svc-a-when">
                {editingTime ? (
                  <input
                    className="svc-a-time-input"
                    type="time"
                    autoFocus
                    defaultValue={service.startTime}
                    aria-label="Service start time"
                    onKeyDown={e => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') { (e.target as HTMLInputElement).value = service.startTime; setEditingTime(false); }
                    }}
                    onBlur={e => {
                      const v = e.target.value;
                      if (v && v !== service.startTime) onUpdate({ startTime: v, status: 'scheduled' });
                      setEditingTime(false);
                    }}
                  />
                ) : (
                  <button type="button" className="svc-a-time" onClick={() => setEditingTime(true)} title="Click to change the start time">
                    {formatTime12h(parseTime(service.startTime))}
                  </button>
                )}
                <input
                  className="svc-a-name"
                  type="text"
                  value={service.name ?? ''}
                  placeholder="Service name"
                  aria-label="Service name"
                  onChange={e => onUpdate({ name: e.target.value || undefined })}
                />
              </div>
              <div className="svc-a-info">
                <span className="svc-a-lbl">Before</span>
                <span className="svc-a-line">
                  <strong>{preName ?? 'No pre-service playlist'}</strong>
                  <button
                    type="button"
                    className={`svc-a-key ${effectiveKey ? '' : 'empty'}`}
                    style={effectiveKey ? { background: keyColor(effectiveKey).bg, color: keyColor(effectiveKey).fg } : undefined}
                    onClick={onEditKey}
                    title={keyInheritFrom ? 'Same key as the earlier service. Click to set this one’s own key' : 'First song’s key. Click to change'}
                  >{effectiveKey ? displayKey(effectiveKey, keyMode) : 'Set key'}</button>
                  {effectiveKey && <span className="svc-a-dim">lands in key</span>}
                </span>
                <span className="svc-a-lbl">After</span>
                <span className="svc-a-line">
                  <strong>{postName ?? 'No post-service playlist'}</strong>
                  {postName && <><span className="svc-a-dim">· actions:</span><span className={`svc-a-chip ${postSeqName ? 'seq' : ''}`}>{postSeqName ?? 'none'}</span></>}
                </span>
              </div>
              <div className="svc-a-side">
                <div className="svc-a-status">
                  <span className={`svc-a-pill ${service.status}`}>{statusLabel}</span>
                  {when && <span className="svc-a-until">{when}</span>}
                </div>
                <div className="svc-a-buttons">
                  <button type="button" className="btn-secondary" onClick={() => setSettingsOpen(true)} title="Time, name, playlists, actions, ProPresenter, pad bridge">Edit</button>
                  {(service.status === 'queued' || service.status === 'live') && (
                    <button type="button" className="btn-primary" onClick={() => useAppStore.getState().setView('live')}>Open Live</button>
                  )}
                  <button
                    type="button"
                    className={`svc-a-x ${confirmDelete ? 'confirm' : ''}`}
                    onClick={() => {
                      if (!confirmDelete) { setConfirmDelete(true); window.setTimeout(() => setConfirmDelete(false), 3000); return; }
                      onDelete();
                    }}
                    title="Remove this service"
                    aria-label="Remove service"
                  >{confirmDelete ? 'Remove?' : '×'}</button>
                </div>
              </div>
            </div>
            <div className="svc-a-bar" aria-hidden>
              <span className="music" style={{ width: `${musicPct}%` }}>{lead > 0 ? `Music ${fmtMin(lead)}` : 'Music'}</span>
              <span className="pad">Pad</span>
              <span className="svc">Service{postName ? ' · then post-service' : ''}</span>
            </div>
            <div className="svc-a-checks">
              {checks.map((c, i) => <span key={i} className={`svc-a-check ${c.tone}`}><i />{c.text}</span>)}
            </div>
          </>
        );
      })()}

      {settingsOpen && (
      <div className="settings-modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-modal-header">
          <div>
            <div className="settings-modal-title">{service.name || 'Service'} · settings</div>
            <div className="settings-modal-sub">{service.date} · {service.startTime}</div>
          </div>
          <button className="settings-modal-close" onClick={() => setSettingsOpen(false)} aria-label="Close settings">×</button>
        </div>
      <div className="service-card-body settings-modal-body">
        <div className="service-field">
          <span className="service-field-label">Name</span>
          <input
            className="select"
            type="text"
            value={service.name ?? ''}
            placeholder="Service name (e.g. “First Service”)"
            onChange={e => onUpdate({ name: e.target.value || undefined })}
          />
        </div>
        <div className="service-field">
          <span className="service-field-label">Date and start time</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="select"
              type="date"
              value={service.date}
              onChange={e => { if (e.target.value) onUpdate({ date: e.target.value, status: 'scheduled' }); }}
            />
            <input
              className="select"
              type="time"
              value={service.startTime}
              onChange={e => onUpdate({ startTime: e.target.value, status: 'scheduled' })}
            />
          </div>
        </div>

        {/* Row 1: Pre playlist | Post playlist
            Row 2: Pre action seq | Post action seq  (immediately under their playlists)
            Row 3: Last song | Auto-start target
            Row 4: Pad bridge | (empty)
            Row 5: ProPresenter (full width) */}
        <div className="service-field">
          <span className="service-field-label">Pre-service playlist</span>
          <PreServicePlaylistSelect value={service} onChange={patch => onUpdate(patch)} />
        </div>

        <div className="service-field">
          <span className="service-field-label">Post-service playlist</span>
          <PostServicePlaylistSelect
            value={service.postServicePlaylistId}
            onChange={v => onUpdate({ postServicePlaylistId: v })}
          />
        </div>

        {(() => {
          // Per-service action-sequence overrides. Rendered directly
          // under each playlist column (pre under pre, post under post)
          // via the 2-col grid's natural row flow.
          // Tri-state value: undefined = inherit, '' = explicit none,
          // any id = override.
          const INHERIT = '__inherit__';
          const NONE = '__none__';
          const renderActionRow = (kind: 'pre' | 'post') => {
            const playlistId = kind === 'pre' ? service.preServicePlaylistId : service.postServicePlaylistId;
            const inheritedFrom = playlistId
              ? playlists.find(p => p.id === playlistId)
              : undefined;
            const inheritedSeqId = inheritedFrom?.actionSequenceId;
            const inheritedSeqName = inheritedSeqId
              ? actionSequences.find(s => s.id === inheritedSeqId)?.name
              : undefined;
            const stored = kind === 'pre'
              ? (service.preActionSequenceIdOverride !== undefined
                  ? service.preActionSequenceIdOverride
                  : service.actionSequenceIdOverride) // legacy fallback
              : service.postActionSequenceIdOverride;
            const currentValue = stored === undefined ? INHERIT : stored === '' ? NONE : stored;
            const onPick = (raw: string) => {
              const next = raw === INHERIT ? undefined : raw === NONE ? '' : raw;
              // Clear the legacy single-field override on any explicit
              // pick — its presence would otherwise shadow the new
              // pre-specific value when the operator picks "Inherit".
              const legacyClear = service.actionSequenceIdOverride !== undefined
                ? { actionSequenceIdOverride: undefined }
                : {};
              if (kind === 'pre') onUpdate({ preActionSequenceIdOverride: next, ...legacyClear });
              else onUpdate({ postActionSequenceIdOverride: next, ...legacyClear });
            };
            return (
              <div className="service-field" key={kind}>
                <span className="service-field-label">{kind === 'pre' ? 'Pre' : 'Post'}-service action sequence</span>
                <select
                  className="select"
                  value={currentValue}
                  onChange={e => onPick(e.target.value)}
                  title={`Overrides any action sequence set on the ${kind}-service playlist for this service only.`}
                  disabled={!playlistId && !inheritedSeqId}
                >
                  <option value={INHERIT}>
                    Inherit from playlist{inheritedSeqName ? ` (${inheritedSeqName})` : ''}
                  </option>
                  <option value={NONE}>— No actions for this service —</option>
                  {actionSequences.length > 0 && (
                    <optgroup label="Override with">
                      {actionSequences.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            );
          };
          return <>{renderActionRow('pre')}{renderActionRow('post')}</>;
        })()}

        {service.spotifyPlaylistId && (() => {
          // Spotify playlist: pick the song the runway ends on. Songs in the
          // service's key are listed first.
          const pl = spotifyCache?.[service.spotifyPlaylistId];
          const songs = pl?.tracks ?? [];
          const keyOf = (uri: string) => spotifyEdits?.[uri]?.key;
          const seen = new Set<string>();
          const unique = songs.filter(t => (seen.has(t.uri) ? false : (seen.add(t.uri), true)));
          const inKey = effectiveKey ? unique.filter(t => keyOf(t.uri) === effectiveKey) : [];
          const others = unique.filter(t => !inKey.includes(t));
          const label = (t: typeof unique[number]) => `${t.title}${keyOf(t.uri) ? ` (${keyOf(t.uri)})` : ''}`;
          const pinned = service.spotifyLastSongUri;
          const stale = pinned && !unique.some(t => t.uri === pinned);
          return (
            <div className="service-field">
              <span className="service-field-label">Last song</span>
              <select
                className="select"
                value={pinned ?? ''}
                onChange={e => onUpdate({ spotifyLastSongUri: e.target.value || undefined })}
                title="The Spotify song the runway ends on at service start. Auto picks one in the service’s key."
              >
                <option value="">Auto{effectiveKey ? ` (a song in ${effectiveKey})` : ''}</option>
                {inKey.length > 0 && (
                  <optgroup label={`In ${effectiveKey}`}>
                    {inKey.map(t => <option key={t.uri} value={t.uri}>{label(t)}</option>)}
                  </optgroup>
                )}
                {others.length > 0 && (
                  <optgroup label={inKey.length > 0 ? 'Other songs (pad bridge skipped if not in the key)' : 'Songs'}>
                    {others.map(t => <option key={t.uri} value={t.uri}>{label(t)}</option>)}
                  </optgroup>
                )}
                {stale && <option value={pinned}>(no longer in the playlist)</option>}
              </select>
              {!pl && (
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>Import this playlist in Playlists › Spotify to pick a song.</span>
              )}
              {stale && (
                <span style={{ fontSize: 11, color: 'var(--red-bright)' }}>That song is no longer in the playlist. Pick another, or choose Auto.</span>
              )}
            </div>
          );
        })()}

        {!service.spotifyPlaylistId && (
        <div className="service-field">
          <span className="service-field-label">Last song</span>
          <select
            className="select"
            value={effectivePin ?? ''}
            disabled={!effectiveKey}
            onChange={e => {
              const val = e.target.value || undefined;
              onUpdate({ lastSongTrackId: val });
            }}
            title={!effectiveKey
              ? 'Set the first-song key first'
              : 'Pin the pre-service playlist to end on a specific track'}
          >
            {pinInheritFrom
              ? <option value="">Match first service</option>
              : <option value="">Auto</option>}
            {tracksInKey.map(t => {
              const sameTitle = tracksInKey.filter(o => o.title === t.title);
              let label = t.title;
              if (sameTitle.length > 1) {
                const sameArtist = sameTitle.filter(o => (o.artist ?? '') === (t.artist ?? ''));
                const mins = Math.floor((t.durationSec ?? 0) / 60);
                const secs = Math.round((t.durationSec ?? 0) % 60);
                const dur = `${mins}:${String(secs).padStart(2, '0')}`;
                if (sameArtist.length > 1 || !t.artist) {
                  label = `${t.title} (${dur})`;
                } else {
                  label = `${t.title} — ${t.artist}`;
                }
              }
              return <option key={t.id} value={t.id}>{label}</option>;
            })}
            {stalePinTrack && (
              <option value={stalePinTrack.id}>
                {stalePinTrack.title} (no longer in playlist)
              </option>
            )}
          </select>
          {pinInheritFrom && service.lastSongTrackId === undefined && (
            <span style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {inheritHint(pinInheritFrom)} — pick to override
            </span>
          )}
          {stalePinTrack && (
            <span style={{ fontSize: 11, color: 'var(--red-bright)' }}>
              This track is no longer in the playlist. Pick another, or choose Auto.
            </span>
          )}
          {effectiveKey && tracksInKey.length === 0 && !stalePinTrack && (
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              No tracks tagged {effectiveKey} in this playlist
            </span>
          )}
        </div>
        )}

        <div className="service-field">
          <span className="service-field-label">Auto-start target</span>
          <div className="service-field-control">
            <input
              type="number"
              min={0}
              max={240}
              step={1}
              value={Math.round(service.autoStartTargetSec / 60)}
              onChange={e => {
                const mins = Math.max(0, Math.min(240, +e.target.value || 0));
                onUpdate({ autoStartTargetSec: mins * 60 });
              }}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--text)',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: 14,
              }}
              title="Minutes before service start to begin pre-service music"
            />
            <span style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.04em' }}>MIN BEFORE</span>
          </div>
        </div>

        <div className="service-field">
          <span className="service-field-label">PCO key pull</span>
          <div className="service-field-control">
            <input
              type="number"
              min={1}
              max={1440}
              step={1}
              value={service.pcoKeyLeadSec !== undefined ? Math.round(service.pcoKeyLeadSec / 60) : ''}
              placeholder="default"
              onChange={e => {
                const raw = e.target.value.trim();
                if (raw === '') { onUpdate({ pcoKeyLeadSec: undefined }); return; }
                const mins = Math.max(1, Math.min(1440, +raw || 1));
                onUpdate({ pcoKeyLeadSec: mins * 60 });
              }}
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                color: 'var(--text)',
                padding: 0,
                fontFamily: 'inherit',
                fontSize: 14,
              }}
              title="How many minutes before this service to get the first-song key from Planning Center. Leave blank to use the Settings default."
            />
            <span style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.04em' }}>MIN BEFORE</span>
          </div>
        </div>

        <div className="service-field">
          <span className="service-field-label">Pad bridge</span>
          <label
            className="service-field-control"
            style={{ cursor: 'pointer', justifyContent: 'flex-start', gap: 10 }}
            title="Off: music fades out at service start, no pad."
          >
            <input
              type="checkbox"
              checked={!service.disablePadBridge}
              onChange={e => onUpdate({ disablePadBridge: !e.target.checked || undefined })}
              style={{ accentColor: 'var(--accent)', margin: 0 }}
            />
            <span style={{ color: service.disablePadBridge ? 'var(--text-faint)' : 'var(--text)', fontSize: 14 }}>
              {service.disablePadBridge ? 'Off' : 'On'}
            </span>
          </label>
        </div>

        <div className="service-field service-field-pp" style={{ gridColumn: '1 / -1' }}>
          <span className="service-field-label">ProPresenter</span>
          <button
            className={`btn-secondary ${service.proPresenterOverride ? 'btn-active' : ''}`}
            onClick={() => setPpModalOpen(true)}
            title={service.proPresenterOverride
              ? 'This service has its own ProPresenter setup'
              : 'ProPresenter setup for this service'}
            style={{ justifySelf: 'start' }}
          >
            ProPresenter setup{service.proPresenterOverride ? ' ●' : ''}
          </button>
        </div>
      </div>
      </div>
      </div>
      )}

      {ppModalOpen && (
        <ProPresenterServiceModal
          title={service.name || 'Service'}
          subtitle={`${service.date} · ${service.startTime}`}
          override={service.proPresenterOverride}
          onClose={() => setPpModalOpen(false)}
          onSave={(override) => onUpdate({ proPresenterOverride: override })}
        />
      )}
    </div>
  );
}
