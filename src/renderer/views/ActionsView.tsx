import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import type { Action, ActionPayload, ActionSequence, ActionAnchor, KeyName } from '@shared/types';
import type { PpTimer } from '../lib/proPresenterClient';
import { ALL_KEYS } from '@shared/music';
import { Toggle } from '../components/Toggle';
import {
  ACTION_META,
  ANCHOR_DIRECTION_LABEL,
  directionFromAction,
  isSongDirection,
  patchForDirection,
  type AnchorDirection,
} from '../lib/actionMeta';

/**
 * Top-level "Actions" tab. Two-pane layout:
 *   sidebar  → sequence library (one row per sequence, "+" to add)
 *   editor   → currently selected sequence's actions (one row per action,
 *              "+" to add)
 *
 * Action sequences are reusable bundles of timed automations that fire
 * alongside a playlist's runway. They live in config.actionSequences and
 * are linked to playlists via Playlist.actionSequenceId.
 */
export function ActionsView() {
  const sequences = useAppStore(s => s.config.actionSequences ?? []);
  const playlists = useAppStore(s => s.config.playlists);
  const createActionSequence = useAppStore(s => s.createActionSequence);
  const duplicateActionSequence = useAppStore(s => s.duplicateActionSequence);
  const updateActionSequence = useAppStore(s => s.updateActionSequence);
  const deleteActionSequence = useAppStore(s => s.deleteActionSequence);
  const addAction = useAppStore(s => s.addAction);
  const updateAction = useAppStore(s => s.updateAction);
  const deleteAction = useAppStore(s => s.deleteAction);

  const [selectedId, setSelectedId] = useState<string | null>(sequences[0]?.id ?? null);
  const [examplesOpen, setExamplesOpen] = useState(false);
  // Per-id confirm-flag for the sidebar's X delete button — first click
  // arms the deletion (X turns red), second click within 3s commits.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = window.setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => window.clearTimeout(t);
  }, [confirmDeleteId]);
  // Auto-select the first sequence whenever the current selection
  // disappears (deleted) or the user just landed on the tab with one
  // already in the library.
  useEffect(() => {
    if (selectedId && sequences.some(s => s.id === selectedId)) return;
    setSelectedId(sequences[0]?.id ?? null);
  }, [selectedId, sequences]);

  const selected = useMemo(
    () => sequences.find(s => s.id === selectedId) ?? null,
    [sequences, selectedId],
  );

  // Sort actions chronologically so the operator sees firing order top-down.
  const sortedActions = useMemo(() => {
    if (!selected) return [];
    return [...selected.actions].sort((a, b) => a.offsetSec - b.offsetSec);
  }, [selected]);

  const onCreate = () => {
    const id = createActionSequence('New sequence');
    setSelectedId(id);
  };

  const onAddAction = () => {
    if (!selected) return;
    addAction(selected.id);
  };

  // Surface every playlist that points at the selected sequence so the
  // operator sees what their edits will affect.
  const linkedPlaylists = useMemo(() => {
    if (!selected) return [];
    return playlists.filter(p => p.actionSequenceId === selected.id);
  }, [playlists, selected]);

  return (
    <div className="actions-view">
      <aside className="actions-sidebar">
        <div className="actions-sidebar-header">
          <span>Sequences</span>
          <button className="actions-add-btn" onClick={onCreate} title="New sequence">+</button>
        </div>
        {sequences.length === 0 ? (
          <div className="actions-empty">
            No sequences yet. Click + to create one.
          </div>
        ) : (
          <div className="actions-sidebar-list">
            {sequences.map(s => {
              const isConfirm = confirmDeleteId === s.id;
              return (
                <div
                  key={s.id}
                  className={`actions-sidebar-row ${s.id === selectedId ? 'active' : ''}`}
                >
                  <button
                    className="actions-sidebar-item"
                    onClick={() => setSelectedId(s.id)}
                  >
                    <div className="actions-sidebar-name">{s.name}</div>
                    <div className="actions-sidebar-meta">
                      {s.actions.length} {s.actions.length === 1 ? 'action' : 'actions'}
                    </div>
                  </button>
                  <button
                    className={`actions-sidebar-x ${isConfirm ? 'confirm' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isConfirm) {
                        setConfirmDeleteId(s.id);
                        return;
                      }
                      deleteActionSequence(s.id);
                      setConfirmDeleteId(null);
                    }}
                    title={isConfirm
                      ? `Click again to delete "${s.name}"`
                      : `Delete "${s.name}"`}
                  >×</button>
                </div>
              );
            })}
          </div>
        )}
      </aside>

      <main className="actions-main">
        {!selected ? (
          <div className="actions-empty-main">
            Select or create a sequence on the left.
          </div>
        ) : (
          <>
            <header className="actions-main-header">
              <input
                className="actions-name-input"
                value={selected.name}
                onChange={e => updateActionSequence(selected.id, { name: e.target.value })}
              />
              <div className="actions-main-actions">
                <label className="actions-anchor-picker" title="Default anchor for new actions added to this sequence. Each action can override its own anchor on its row.">
                  <span>Default anchor</span>
                  <select
                    value={selected.anchor}
                    onChange={e => updateActionSequence(selected.id, { anchor: e.target.value as ActionAnchor })}
                  >
                    <option value="service_start">Service start (0:00 = service begins)</option>
                    <option value="playlist_start">Music start (0:00 = music begins)</option>
                  </select>
                </label>
                <button
                  className="btn-secondary"
                  onClick={() => duplicateActionSequence(selected.id)}
                >Duplicate</button>
              </div>
            </header>

            {linkedPlaylists.length > 0 && (
              <div className="actions-linked">
                Applied to: {linkedPlaylists.map(p => p.name).join(', ')}
              </div>
            )}

            <div className="actions-rows">
              {sortedActions.map(a => (
                <ActionRow
                  key={a.id}
                  action={a}
                  sequenceAnchor={selected.anchor}
                  onChange={patch => updateAction(selected.id, a.id, patch)}
                  onDelete={() => deleteAction(selected.id, a.id)}
                />
              ))}
            </div>

            <button className="actions-add-action-btn" onClick={onAddAction}>
              <span className="actions-add-icon" aria-hidden>+</span>
              <span>Add action</span>
            </button>
          </>
        )}
      </main>
      <button
        type="button"
        className="actions-examples-btn"
        onClick={() => setExamplesOpen(true)}
        title="See example use cases for actions"
      >
        <span aria-hidden>?</span>
        <span>What can I do with actions?</span>
      </button>
      {examplesOpen && <ActionExamplesModal onClose={() => setExamplesOpen(false)} />}
    </div>
  );
}

/**
 * Practical patterns the operator can copy. The list is intentionally
 * worship-team-shaped — pre-service ramp, anchor-track cues, post-
 * service flow, between-services arming. Pure-content modal; no logic
 * touches the store.
 */
function ActionExamplesModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  type Example = { title: string; cues: { when: string; what: string }[]; note?: string };
  const examples: Example[] = [
    {
      title: 'Lighting + presentation cues at service start',
      cues: [
        { when: 'service_start − 60s', what: 'midi_send → lighting console: house lights to 30%' },
        { when: 'service_start − 30s', what: 'pp_trigger_playlist_item → "Welcome" slide' },
        { when: 'service_start + 0', what: 'midi_send → lighting scene "Worship low"' },
      ],
    },
    {
      title: 'Anchor-track ramp (last song)',
      cues: [
        { when: 'last_song offset 0', what: 'pad_action → arm_key in the song\'s key' },
        { when: 'last_song + 30s', what: 'audio_fade music → 60% (singer-focused mix)' },
        { when: 'last_song − 5s', what: 'midi_send → lighting "Worship intense"' },
      ],
    },
    {
      title: 'ProPresenter timer sync',
      cues: [
        { when: 'music_start + 0', what: 'pp_set_timer → count down to service start' },
        { when: 'music_start + 0', what: 'pp_timer_control → start the timer' },
      ],
    },
    {
      title: 'Post-service playlist flow',
      cues: [
        { when: 'after song 3 of "Reflection"', what: 'change_setlist → "Standard Post-Service" (transition out of the prayer feel)' },
        { when: '~30 min before next service', what: 'arm_playlist with "Music to fill" ON → forces next service to arm now, music fills the gap' },
      ],
    },
    {
      title: 'End cleanly between services',
      cues: [
        { when: 'last_song of post-service', what: 'change_setlist with NO playlist set → fade out and clear the runway' },
      ],
      note: 'When a target playlist is missing, the action just stops the runway at its fire point. No follow-on audio.',
    },
    {
      title: 'Quick-test compression for rehearsal',
      cues: [
        { when: 'music_start + 30s', what: 'music_action → skip_to_next (jump straight into the second song)' },
      ],
      note: 'Useful for rehearsing transitions without sitting through every opener.',
    },
    {
      title: 'Bus duck for an announcement',
      cues: [
        { when: 'manual / song-anchored', what: 'audio_fade music → 40% (operator triggers when host speaks)' },
        { when: '+ a few seconds later', what: 'audio_fade music → 100% (back to full)' },
      ],
    },
  ];

  return (
    <div className="actions-examples-backdrop" onClick={onClose}>
      <div className="actions-examples-modal" onClick={e => e.stopPropagation()}>
        <header className="actions-examples-header">
          <div>
            <h2>Action sequences — what they're for</h2>
            <p>
              An action sequence runs alongside a playlist's runway and fires cues
              at specific moments — anchored either to a wall-clock offset
              (service_start / music_start) or to a song position (first_song /
              last_song). Use them to coordinate audio, MIDI, ProPresenter, and
              playlist swaps that all need to happen at the same musical moment.
            </p>
          </div>
          <button type="button" className="actions-examples-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="actions-examples-body">
          {examples.map((ex, i) => (
            <section key={i} className="actions-example-card">
              <div className="actions-example-title">{ex.title}</div>
              <ul className="actions-example-list">
                {ex.cues.map((c, j) => (
                  <li key={j}>
                    <span className="actions-example-when">{c.when}</span>
                    <span className="actions-example-arrow" aria-hidden>→</span>
                    <span className="actions-example-what">{c.what}</span>
                  </li>
                ))}
              </ul>
              {ex.note && <div className="actions-example-note">{ex.note}</div>}
            </section>
          ))}
          <div className="actions-examples-footnote">
            The most common shape: anchor on <code>last_song</code> or <code>service_start</code>,
            then chain 2–3 actions a few seconds apart so audio, lighting, and slides
            all hit the same beat.
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ActionRow ─────────────────────────────────────────────────────────

function ActionRow({
  action,
  sequenceAnchor,
  onChange,
  onDelete,
}: {
  action: Action;
  sequenceAnchor: ActionAnchor;
  onChange: (patch: Partial<Action>) => void;
  onDelete: () => void;
}) {
  const setPayload = (next: ActionPayload) => onChange({ payload: next });
  const effectiveAnchor: ActionAnchor = action.anchor ?? sequenceAnchor;
  const direction = directionFromAction(
    effectiveAnchor,
    action.offsetSec,
    action.songAnchor,
    action.songOffset,
  );
  const songMode = isSongDirection(direction);
  // For song directions the magnitude is the song count (always
  // positive in the UI); for time it's MM:SS.
  const magnitudeSec = Math.abs(action.offsetSec);
  const songCount = Math.abs(action.songOffset ?? 0);
  const meta = ACTION_META[action.payload.type];

  const onChangeDirection = (next: AnchorDirection) => {
    const mag = isSongDirection(next) ? songCount : magnitudeSec;
    onChange(patchForDirection(next, mag));
  };
  const onChangeMagnitude = (mag: number) => {
    onChange(patchForDirection(direction, mag));
  };

  return (
    <div
      className={`action-row ${action.enabled ? '' : 'disabled'}`}
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div className="action-row-left">
        <Toggle
          checked={action.enabled}
          onChange={(b) => onChange({ enabled: b })}
          ariaLabel="Enable action"
        />
        <span
          className="action-row-icon"
          style={{ color: meta.color }}
          aria-hidden
          title={meta.label}
        >{meta.icon}</span>
        {songMode ? (
          <SongCountInput value={songCount} onChange={onChangeMagnitude} />
        ) : (
          <MagnitudeInput valueSec={magnitudeSec} onChange={onChangeMagnitude} />
        )}
        <select
          className="action-anchor-select"
          value={direction}
          onChange={e => onChangeDirection(e.target.value as AnchorDirection)}
          title="When this action fires. Time-based options use minutes:seconds; song-based options use a song count (e.g. '1 song before the last song')."
        >
          <optgroup label="Time-based">
            <option value="before_music">{ANCHOR_DIRECTION_LABEL.before_music}</option>
            <option value="after_music">{ANCHOR_DIRECTION_LABEL.after_music}</option>
            <option value="before_service">{ANCHOR_DIRECTION_LABEL.before_service}</option>
            <option value="after_service">{ANCHOR_DIRECTION_LABEL.after_service}</option>
          </optgroup>
          <optgroup label="Song-based">
            <option value="after_first_song">{ANCHOR_DIRECTION_LABEL.after_first_song}</option>
            <option value="before_last_song">{ANCHOR_DIRECTION_LABEL.before_last_song}</option>
          </optgroup>
        </select>
      </div>
      <div className="action-row-mid">
        <select
          className="action-type-select"
          value={action.payload.type}
          onChange={e => setPayload(defaultPayloadFor(e.target.value as ActionPayload['type']))}
        >
          <option value="midi_send">MIDI send</option>
          <option value="pp_trigger_slide">ProPresenter — trigger slide</option>
          <option value="pp_trigger_playlist_item">ProPresenter — trigger playlist item</option>
          <option value="pp_set_timer">ProPresenter — set timer</option>
          <option value="pp_timer_control">ProPresenter — timer control</option>
          <option value="audio_fade">Audio bus fade</option>
          <option value="pad_action">Pad player</option>
          <option value="music_action">Music transport</option>
          <option value="change_setlist">Change setlist</option>
          <option value="arm_playlist">Arm playlist</option>
        </select>
        <PayloadEditor payload={action.payload} onChange={setPayload} />
        <input
          className="action-label-input"
          value={action.label}
          placeholder="Label (e.g. Welcome slide)"
          onChange={e => onChange({ label: e.target.value })}
        />
      </div>
      <div className="action-row-right">
        <button
          className="action-row-delete"
          onClick={onDelete}
          title="Delete action"
        >×</button>
      </div>
    </div>
  );
}

// ─── Magnitude input (positive MM:SS) ─────────────────────────────────
// Direction is handled by the anchor picker ("before/after music start"
// etc.), so this input only deals with the absolute time. Operator never
// has to type a minus sign.

function MagnitudeInput({
  valueSec,
  onChange,
}: {
  valueSec: number;
  onChange: (sec: number) => void;
}) {
  const abs = Math.max(0, Math.abs(valueSec));
  const mm = Math.floor(abs / 60);
  const ss = abs % 60;
  const [text, setText] = useState(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
  useEffect(() => {
    setText(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
  }, [valueSec]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = () => {
    // Accept "MM:SS", bare "SS" (assumes :SS), or "M" (assumes M minutes).
    const m = text.trim().match(/^(\d+)(?::(\d{1,2}))?$/);
    if (!m) {
      setText(`${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`);
      return;
    }
    const minutes = Number(m[1]);
    const seconds = m[2] ? Number(m[2]) : 0;
    onChange(minutes * 60 + seconds);
  };

  return (
    <input
      className="action-offset-input"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      placeholder="MM:SS"
      title="Time as minutes:seconds (e.g. 2:00 = two minutes, 0:30 = thirty seconds). Use the dropdown to pick before or after the anchor."
    />
  );
}

// ─── Song-count input (positive integer) ──────────────────────────────
// Used in place of MagnitudeInput when the direction is song-based.
// Operator types a count (1 = "1 song", 2 = "2 songs", etc.); 0 means
// the reference song itself.

function SongCountInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="action-song-count">
      <input
        className="action-offset-input"
        type="number"
        min={0}
        max={99}
        value={value}
        onChange={e => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isNaN(n)) onChange(Math.max(0, n));
        }}
        title="Number of songs (e.g. 1 = one song, 2 = two songs). 0 = the reference song itself."
      />
      <span className="action-song-count-label">{value === 1 ? 'song' : 'songs'}</span>
    </div>
  );
}

// ─── PayloadEditor ─────────────────────────────────────────────────────

function defaultPayloadFor(type: ActionPayload['type']): ActionPayload {
  switch (type) {
    case 'midi_send':
      return { type: 'midi_send', portName: '', messageType: 'note_on', channel: 1, data1: 60, data2: 100 };
    case 'pp_trigger_slide':
      return { type: 'pp_trigger_slide', slideIndex: 0 };
    case 'pp_trigger_playlist_item':
      return { type: 'pp_trigger_playlist_item', playlistUuid: '', itemIndex: 0 };
    case 'pp_set_timer':
      return { type: 'pp_set_timer', timerUuid: '', mode: 'count_down_to_service' };
    case 'pp_timer_control':
      return { type: 'pp_timer_control', timerUuid: '', op: 'start' };
    case 'audio_fade':
      return { type: 'audio_fade', bus: 'music', targetGainPct: 100, durationSec: 1 };
    case 'pad_action':
      return { type: 'pad_action', op: 'fire' };
    case 'music_action':
      return { type: 'music_action', op: 'skip_to_next' };
    case 'change_setlist':
      return { type: 'change_setlist', playlistId: '', fadeOutSec: 2 };
    case 'arm_playlist':
      return { type: 'arm_playlist', playlistId: '', fadeOutSec: 2, fillWithMusic: true };
  }
}

function PayloadEditor({
  payload,
  onChange,
}: {
  payload: ActionPayload;
  onChange: (next: ActionPayload) => void;
}) {
  const ppTimers = useAppStore(s => s.ppTimers);
  const ppPlaylists = useAppStore(s => s.ppPlaylists);
  const midiDevices = useAppStore(s => s.config.midiDevices);
  const appPlaylists = useAppStore(s => s.config.playlists);
  const outputPorts = useMemo(
    () => midiDevices.filter(d => d.outputEnabled).map(d => d.name),
    [midiDevices],
  );

  switch (payload.type) {
    case 'midi_send':
      return (
        <div className="payload-row">
          <select
            value={payload.portName}
            onChange={e => onChange({ ...payload, portName: e.target.value })}
            title="MIDI output port"
          >
            <option value="">— port —</option>
            {outputPorts.map(p => <option key={p} value={p}>{p}</option>)}
            {payload.portName && !outputPorts.includes(payload.portName) && (
              <option value={payload.portName}>(offline) {payload.portName}</option>
            )}
          </select>
          <select
            value={payload.messageType}
            onChange={e => onChange({ ...payload, messageType: e.target.value as 'note_on' | 'note_off' | 'cc' | 'program_change' })}
          >
            <option value="note_on">Note on</option>
            <option value="note_off">Note off</option>
            <option value="cc">CC</option>
            <option value="program_change">Program change</option>
          </select>
          <NumberField
            label="Ch"
            value={payload.channel}
            min={1}
            max={16}
            onChange={n => onChange({ ...payload, channel: n })}
          />
          <NumberField
            label={payload.messageType === 'cc' ? 'CC' : payload.messageType === 'program_change' ? 'PC' : 'Note'}
            value={payload.data1}
            min={0}
            max={127}
            onChange={n => onChange({ ...payload, data1: n })}
          />
          {payload.messageType !== 'program_change' && (
            <NumberField
              label={payload.messageType === 'cc' ? 'Val' : 'Vel'}
              value={payload.data2 ?? 0}
              min={0}
              max={127}
              onChange={n => onChange({ ...payload, data2: n })}
            />
          )}
        </div>
      );
    case 'pp_trigger_slide':
      return (
        <div className="payload-row">
          <NumberField
            label="Slide #"
            value={payload.slideIndex}
            min={0}
            max={9999}
            onChange={n => onChange({ ...payload, slideIndex: n })}
          />
          <span className="payload-hint">(zero-based)</span>
        </div>
      );
    case 'pp_trigger_playlist_item':
      return (
        <PpPlaylistItemEditor
          payload={payload}
          ppPlaylists={ppPlaylists}
          onChange={onChange}
        />
      );
    case 'pp_set_timer':
      return (
        <div className="payload-row">
          <select
            value={payload.timerUuid}
            onChange={e => {
              const t = ppTimers.find(x => x.uuid === e.target.value);
              onChange({ ...payload, timerUuid: e.target.value, timerName: t?.name });
            }}
          >
            <option value="">— timer —</option>
            {ppTimers.map(t => <option key={t.uuid} value={t.uuid}>{t.name}</option>)}
            {payload.timerUuid && !ppTimers.some(t => t.uuid === payload.timerUuid) && (
              <option value={payload.timerUuid}>(offline) {payload.timerName ?? payload.timerUuid}</option>
            )}
          </select>
          <select
            value={payload.mode}
            onChange={e => onChange({ ...payload, mode: e.target.value as 'duration' | 'count_down_to_service' })}
          >
            <option value="count_down_to_service">Count down to service</option>
            <option value="duration">Fixed duration</option>
          </select>
          {payload.mode === 'duration' && (
            <NumberField
              label="Sec"
              value={payload.durationSec ?? 60}
              min={1}
              max={36000}
              onChange={n => onChange({ ...payload, durationSec: n })}
            />
          )}
        </div>
      );
    case 'pp_timer_control':
      return (
        <div className="payload-row">
          <select
            value={payload.timerUuid}
            onChange={e => {
              const t = ppTimers.find(x => x.uuid === e.target.value);
              onChange({ ...payload, timerUuid: e.target.value, timerName: t?.name });
            }}
          >
            <option value="">— timer —</option>
            {ppTimers.map(t => <option key={t.uuid} value={t.uuid}>{t.name}</option>)}
            {payload.timerUuid && !ppTimers.some(t => t.uuid === payload.timerUuid) && (
              <option value={payload.timerUuid}>(offline) {payload.timerName ?? payload.timerUuid}</option>
            )}
          </select>
          <select
            value={payload.op}
            onChange={e => onChange({ ...payload, op: e.target.value as 'start' | 'stop' | 'reset' })}
          >
            <option value="start">Start</option>
            <option value="stop">Stop</option>
            <option value="reset">Reset</option>
          </select>
        </div>
      );
    case 'audio_fade': {
      // Backward compat: legacy actions stored targetGainDb. If the new
      // pct field is missing, derive it from the dB value so the slider
      // shows something sensible until the operator saves over it.
      const legacyDb = (payload as unknown as { targetGainDb?: number }).targetGainDb;
      const pctValue = payload.targetGainPct ?? (
        typeof legacyDb === 'number'
          ? Math.min(100, Math.max(0, Math.pow(10, legacyDb / 20) * 100))
          : 100
      );
      return (
        <div className="payload-row">
          <select
            value={payload.bus}
            onChange={e => onChange({ ...payload, bus: e.target.value as 'music' | 'pad' | 'cue' })}
          >
            <option value="music">Music</option>
            <option value="pad">Pad</option>
            <option value="cue">Cue</option>
          </select>
          <label className="action-volume-slider">
            <span>Vol</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(pctValue)}
              onChange={e => onChange({
                ...payload,
                targetGainPct: Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0)),
              })}
            />
            <span className="action-volume-readout">{Math.round(pctValue)}%</span>
          </label>
          <NumberField
            label="Fade s"
            value={payload.durationSec}
            min={0}
            max={120}
            step={0.1}
            onChange={n => onChange({ ...payload, durationSec: n })}
          />
        </div>
      );
    }
    case 'pad_action':
      return (
        <div className="payload-row">
          <select
            value={payload.op}
            onChange={e => onChange({ ...payload, op: e.target.value as 'arm_key' | 'fire' | 'stop' })}
          >
            <option value="arm_key">Arm key</option>
            <option value="fire">Fire</option>
            <option value="stop">Stop</option>
          </select>
          {payload.op === 'arm_key' && (
            <select
              value={payload.key ?? ''}
              onChange={e => onChange({ ...payload, key: (e.target.value || undefined) as KeyName | undefined })}
            >
              <option value="">— key —</option>
              {ALL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
        </div>
      );
    case 'music_action':
      return (
        <div className="payload-row">
          <select
            value={payload.op}
            onChange={e => onChange({ ...payload, op: e.target.value as 'start_early' | 'skip_to_next' | 'jump_to_track' })}
          >
            <option value="start_early">Start music early</option>
            <option value="skip_to_next">Skip to next track</option>
            <option value="jump_to_track">Jump to specific track</option>
          </select>
          {payload.op === 'jump_to_track' && (
            <input
              className="action-id-input"
              placeholder="Track ID"
              value={payload.trackId ?? ''}
              onChange={e => onChange({ ...payload, trackId: e.target.value || undefined })}
            />
          )}
        </div>
      );
    case 'change_setlist':
      return (
        <div className="payload-row">
          <select
            value={payload.playlistId}
            onChange={e => {
              const pl = appPlaylists.find(p => p.id === e.target.value);
              onChange({ ...payload, playlistId: e.target.value, playlistName: pl?.name });
            }}
            title="Playlist to swap to. Current music fades out, then this playlist starts as a post-service runway."
          >
            <option value="">— playlist —</option>
            {appPlaylists.map(p => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind === 'pre' ? 'Pre' : p.kind === 'post' ? 'Post' : 'Special'})
              </option>
            ))}
            {payload.playlistId && !appPlaylists.some(p => p.id === payload.playlistId) && (
              <option value={payload.playlistId}>(missing) {payload.playlistName ?? payload.playlistId}</option>
            )}
          </select>
          <NumberField
            label="Fade s"
            value={payload.fadeOutSec}
            min={0}
            max={30}
            step={0.5}
            onChange={n => onChange({ ...payload, fadeOutSec: n })}
          />
        </div>
      );
    case 'arm_playlist':
      return <ArmPlaylistEditor payload={payload} onChange={onChange as (p: Extract<ActionPayload, { type: 'arm_playlist' }>) => void} />;
  }
}

function ArmPlaylistEditor({
  payload,
  onChange,
}: {
  payload: Extract<ActionPayload, { type: 'arm_playlist' }>;
  onChange: (next: Extract<ActionPayload, { type: 'arm_playlist' }>) => void;
}) {
  const playlists = useAppStore(s => s.config.playlists);
  return (
    <div className="payload-row">
      <select
        value={payload.playlistId}
        onChange={e => {
          const pl = playlists.find(p => p.id === e.target.value);
          onChange({ ...payload, playlistId: e.target.value, playlistName: pl?.name });
        }}
        title="Playlist to arm as the upcoming service's pre-service music. Overrides anything currently playing — post-service fades out, queued pre-service is cleared, this playlist arms in."
      >
        <option value="">— playlist —</option>
        {playlists.map(p => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.kind === 'pre' ? 'Pre' : p.kind === 'post' ? 'Post' : 'Special'})
          </option>
        ))}
        {payload.playlistId && !playlists.some(p => p.id === payload.playlistId) && (
          <option value={payload.playlistId}>(missing) {payload.playlistName ?? payload.playlistId}</option>
        )}
      </select>
      <NumberField
        label="Fade s"
        value={payload.fadeOutSec}
        min={0}
        max={30}
        step={0.5}
        onChange={n => onChange({ ...payload, fadeOutSec: n })}
      />
      <label
        className="action-toggle-field"
        title="When ON, the runway loops tracks to fill the entire lead-time window. When OFF, plays once through and ends — useful when the playlist is already long enough."
      >
        <input
          type="checkbox"
          checked={payload.fillWithMusic}
          onChange={e => onChange({ ...payload, fillWithMusic: e.target.checked })}
        />
        <span>Music to fill</span>
      </label>
    </div>
  );
}

function NumberField({
  label, value, onChange, min, max, step,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="action-num-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        onChange={e => {
          const n = step && step < 1 ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
          if (!isNaN(n)) onChange(n);
        }}
        min={min}
        max={max}
        step={step ?? 1}
      />
    </label>
  );
}

// ─── PP playlist-item editor ───────────────────────────────────────────
// Mirrors the Settings → ProPresenter hooks dropdowns so the operator
// gets the same Action / Playlist / Item drill-in surface here. Items
// are fetched from PP on playlist change, so the dropdown shows real
// names instead of asking for a numeric index.

function PpPlaylistItemEditor({
  payload,
  ppPlaylists,
  onChange,
}: {
  payload: Extract<ActionPayload, { type: 'pp_trigger_playlist_item' }>;
  ppPlaylists: { uuid: string; name: string }[];
  onChange: (next: ActionPayload) => void;
}) {
  const { pp } = useEngines();
  const [items, setItems] = useState<PpTimer[]>([]);
  const [busy, setBusy] = useState(false);
  // Fetch items whenever the chosen playlist changes. Cancel in-flight
  // fetches via the cancelled flag so a fast playlist swap doesn't
  // commit stale items.
  useEffect(() => {
    if (!payload.playlistUuid) {
      setItems([]);
      return;
    }
    let cancelled = false;
    setBusy(true);
    pp.listPlaylistItems(payload.playlistUuid)
      .then(loaded => {
        if (cancelled) return;
        setItems(loaded);
        setBusy(false);
      })
      .catch(err => {
        console.warn('[actions] listPlaylistItems failed', err);
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [payload.playlistUuid, pp]);

  const onPickPlaylist = (uuid: string) => {
    const pl = ppPlaylists.find(p => p.uuid === uuid);
    onChange({
      ...payload,
      playlistUuid: uuid,
      playlistName: pl?.name,
      // Reset item when the playlist changes — the old index is now
      // pointing at a different presentation.
      itemIndex: 0,
      itemName: undefined,
      slideIndex: undefined,
    });
  };

  const onPickItem = (raw: string) => {
    if (raw === '') {
      onChange({ ...payload, itemIndex: 0, itemName: undefined });
      return;
    }
    const idx = parseInt(raw, 10);
    if (Number.isNaN(idx)) return;
    const item = items.find(i => i.index === idx);
    onChange({ ...payload, itemIndex: idx, itemName: item?.name });
  };

  const slideEnabled = typeof payload.slideIndex === 'number';

  return (
    <div className="payload-row">
      <select
        value={payload.playlistUuid}
        onChange={e => onPickPlaylist(e.target.value)}
        title="Pick a ProPresenter playlist"
      >
        <option value="">— playlist —</option>
        {ppPlaylists.map(p => (
          <option key={p.uuid} value={p.uuid}>{p.name}</option>
        ))}
        {payload.playlistUuid && !ppPlaylists.some(p => p.uuid === payload.playlistUuid) && (
          <option value={payload.playlistUuid}>(offline) {payload.playlistName ?? payload.playlistUuid}</option>
        )}
      </select>
      <select
        value={payload.itemIndex !== undefined ? String(payload.itemIndex) : ''}
        onChange={e => onPickItem(e.target.value)}
        disabled={!payload.playlistUuid || busy}
        title="Item within the chosen playlist"
      >
        <option value="">
          {!payload.playlistUuid
            ? '— pick a playlist first —'
            : busy
              ? '— loading items… —'
              : items.length === 0
                ? '— playlist has no items —'
                : '— select an item —'}
        </option>
        {items.map(i => (
          <option key={i.uuid} value={i.index ?? ''}>
            {i.index !== undefined ? `${i.index + 1}. ` : ''}{i.name}
          </option>
        ))}
        {payload.itemIndex !== undefined && payload.itemName
          && !items.some(i => i.index === payload.itemIndex) && (
            <option value={String(payload.itemIndex)}>
              {payload.itemIndex + 1}. {payload.itemName} (not loaded)
            </option>
          )}
      </select>
      <label className="action-num-field" title="Drill into a specific slide of the item — leave off to fire the item from its first slide.">
        <span>Slide</span>
        <Toggle
          checked={slideEnabled}
          onChange={(b) => onChange({
            ...payload,
            slideIndex: b ? (payload.slideIndex ?? 0) : undefined,
          })}
          ariaLabel="Drill to specific slide"
        />
      </label>
      {slideEnabled && (
        <NumberField
          label="#"
          value={payload.slideIndex ?? 0}
          min={0}
          max={999}
          onChange={n => onChange({ ...payload, slideIndex: n })}
        />
      )}
    </div>
  );
}
