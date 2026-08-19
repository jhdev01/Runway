import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, generateId } from '../state/store';
import { useEngines } from '../state/engines';
import { ALL_KEYS, MAJOR_KEYS, MINOR_KEYS, keyColor, displayKey } from '@shared/music';
import type { AudioBusConfig, MidiAction, MidiBinding, KeyName, PadFile, ProPresenterSyncConfig, MidiDevicePref } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/types';
import type { MidiDeviceSnapshot } from '../lib/midiEngine';
import type { PpTimer } from '../lib/proPresenterClient';
import { RotaryKnob } from '../components/RotaryKnob';
import { Toggle } from '../components/Toggle';
import runwayIconUrl from '../assets/runway-icon.png';

type SettingsTab = 'audio' | 'midi' | 'propresenter' | 'pads' | 'remote' | 'engine' | 'display' | 'about';

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('audio');
  const consumePendingSettingsTab = useAppStore(s => s.consumePendingSettingsTab);
  const pendingSettingsTab = useAppStore(s => s.pendingSettingsTab);

  useEffect(() => {
    const next = consumePendingSettingsTab();
    if (next) setTab(next);
  }, [pendingSettingsTab, consumePendingSettingsTab]);

  return (
    <div className="settings-view">
      <aside className="settings-nav">
        {([
          { id: 'audio', label: 'Audio Routing' },
          { id: 'midi', label: 'MIDI' },
          { id: 'propresenter', label: 'ProPresenter' },
          { id: 'pads', label: 'Pad Library' },
          { id: 'remote', label: 'Remote' },
          { id: 'engine', label: 'Engine' },
          { id: 'display', label: 'Display' },
          { id: 'about', label: 'About' },
        ] as const).map(item => (
          <button
            key={item.id}
            className={`settings-nav-item ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <div className="settings-content">
        {tab === 'audio' && <AudioSettings />}
        {tab === 'midi' && <MidiSettings />}
        {tab === 'propresenter' && <ProPresenterSettings />}
        {tab === 'pads' && <PadSettings />}
        {tab === 'remote' && <RemoteSettings />}
        {tab === 'engine' && <EngineSettings />}
        {tab === 'display' && <DisplaySettings />}
        {tab === 'about' && <AboutSection />}
      </div>
    </div>
  );
}

function AudioSettings() {
  const audioRouting = useAppStore(s => s.config.audioRouting);
  const updateConfig = useAppStore(s => s.updateConfig);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    // Need permission to enumerate audio outputs with labels
    navigator.mediaDevices.enumerateDevices()
      .then(list => {
        const audioOuts = list.filter(d => d.kind === 'audiooutput');
        setDevices(audioOuts);
        // If none have labels, request permission first
        if (audioOuts.every(d => !d.label)) {
          navigator.mediaDevices.getUserMedia({ audio: true })
            .then(() => navigator.mediaDevices.enumerateDevices())
            .then(list2 => setDevices(list2.filter(d => d.kind === 'audiooutput')))
            .catch(() => { /* user denied */ });
        }
      })
      .catch(err => console.warn('[settings] enumerateDevices failed', err));
  }, []);

  const updateBus = (bus: AudioBusConfig['bus'], patch: Partial<AudioBusConfig>) => {
    updateConfig({
      audioRouting: audioRouting.map(b => b.bus === bus ? { ...b, ...patch } : b),
    });
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Detected output devices</div>
        <div className="settings-section-sub">
          {devices.length === 0
            ? 'No output devices found. macOS may need microphone permission to enumerate audio devices.'
            : `${devices.length} device${devices.length === 1 ? '' : 's'} detected`}
        </div>
        {devices.map(d => (
          <div key={d.deviceId} className="device-card">
            <div
              className="device-icon"
              style={{ color: 'var(--accent-bright)' }}
              title="Audio output device"
            >
              {/* Stylized waveform — meter bars rising/falling like a level
                  meter, suggesting an audio output device. */}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="5"  y1="14" x2="5"  y2="10" />
                <line x1="9"  y1="17" x2="9"  y2="7" />
                <line x1="12" y1="13" x2="12" y2="11" />
                <line x1="15" y1="18" x2="15" y2="6" />
                <line x1="19" y1="15" x2="19" y2="9" />
              </svg>
            </div>
            <div className="device-info">
              <div className="device-name">
                {d.label || '(unnamed device)'}
                {d.deviceId === 'default' && <span className="device-badge">Default</span>}
              </div>
              <div className="device-meta">{d.deviceId}</div>
            </div>
          </div>
        ))}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Bus routing</div>
        <div className="settings-section-sub">
          Each bus can be sent to its own output device (stereo). For
          channel-pair routing within a multi-channel interface (e.g. MOTU
          outs 3-4 vs 5-6), create separate Aggregate Devices in macOS Audio
          MIDI Setup so each pair shows here as its own device — true in-app
          channel-pair selection requires a native driver and is on the
          roadmap.
        </div>

        <div className="routing-table">
          <div className="routing-row header">
            <div>Bus</div>
            <div>Output device</div>
            <div>Channels</div>
            <div>Gain</div>
          </div>
          {audioRouting.map(bus => (
            <div key={bus.bus} className="routing-row">
              <div className="routing-bus">
                <div className={`routing-bus-dot ${bus.bus}`} />
                <div>
                  <div className="routing-bus-name">{labelForBus(bus.bus)}</div>
                  <div className="routing-bus-sub">{subForBus(bus.bus)}</div>
                </div>
              </div>
              <select
                className="select"
                value={bus.deviceId || ''}
                onChange={e => updateBus(bus.bus, { deviceId: e.target.value || null })}
              >
                <option value="">System default</option>
                {devices.map(d => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
                ))}
              </select>
              <div
                style={{
                  fontFamily: 'IBM Plex Mono, monospace',
                  fontSize: 14,
                  color: 'var(--text-faint)',
                }}
                title="Channel-pair routing within a device requires a native driver — coming"
              >
                1-2 (stereo)
              </div>
              <div style={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 14, color: 'var(--text-dim)' }}>
                {bus.gainDb >= 0 ? '+' : ''}{bus.gainDb.toFixed(1)} dB
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function labelForBus(bus: string): string {
  if (bus === 'music') return 'Music';
  if (bus === 'pad') return 'Pad';
  if (bus === 'cue') return 'Cue / Headphones';
  return bus;
}

function subForBus(bus: string): string {
  if (bus === 'music') return 'Pre/post-service music';
  if (bus === 'pad') return 'Sustained pad bridge';
  if (bus === 'cue') return 'Pre-listen / monitoring';
  return '';
}

type AssignableItem = {
  id: string;
  label: string;
  action: MidiAction;
};

function actionsEqual(a: MidiAction, b: MidiAction): boolean {
  if (typeof a === 'string') return a === b;
  if (typeof b === 'string') return false;
  if (a.type === 'pad_set_key' && b.type === 'pad_set_key') return a.key === b.key;
  return false;
}

function formatBinding(b: MidiBinding | undefined): string {
  if (!b) return 'Not assigned';
  const kind = b.type === 'note' ? 'Note' : 'CC';
  const vel = b.velocity !== undefined ? ` · vel ${b.velocity}` : '';
  return `Ch ${b.channel} · ${kind} ${b.noteOrCc}${vel}`;
}

const STATIC_ASSIGNABLE: AssignableItem[] = [
  { id: 'arm_toggle', label: 'Arm / Disarm service', action: 'arm_toggle' },
  { id: 'panic_fade', label: 'Panic / Fade all', action: 'panic_fade' },
  { id: 'start_post_service', label: 'Start post-service', action: 'start_post_service' },
  { id: 'pad_play', label: 'Pad — Play', action: 'pad_play' },
  { id: 'pad_stop', label: 'Pad — Stop', action: 'pad_stop' },
];

function MidiSettings() {
  const { midi } = useEngines();
  const bindings = useAppStore(s => s.config.midiBindings);
  const pads = useAppStore(s => s.config.pads);
  const midiDevices = useAppStore(s => s.config.midiDevices);
  const updateConfig = useAppStore(s => s.updateConfig);

  // Device snapshot is owned by the engine (it's the source of truth for
  // what's currently connected). Subscribe so the list refreshes when
  // devices come and go without a manual reload.
  const [devices, setDevices] = useState<MidiDeviceSnapshot[]>(() => midi.getDevices());
  useEffect(() => midi.subscribeDevices(setDevices), [midi]);

  const setDevicePref = (name: string, manufacturer: string | undefined, patch: Partial<MidiDevicePref>) => {
    const existing = midiDevices.find(p => p.name === name);
    const next: MidiDevicePref = existing
      ? { ...existing, ...patch }
      : { name, manufacturer, inputEnabled: true, outputEnabled: true, ...patch };
    const others = midiDevices.filter(p => p.name !== name);
    updateConfig({ midiDevices: [...others, next] });
  };

  // Toggle both directions in a single config write. Calling setDevicePref
  // twice in a row would race against the same stale closure of midiDevices
  // and the second write would silently undo the first.
  const setBothDirections = (name: string, manufacturer: string | undefined, next: boolean) => {
    setDevicePref(name, manufacturer, { inputEnabled: next, outputEnabled: next });
  };

  const clearDevicePref = (name: string) => {
    updateConfig({ midiDevices: midiDevices.filter(p => p.name !== name) });
  };

  const [learningId, setLearningId] = useState<string | null>(null);
  const cancelLearnRef = useRef<(() => void) | null>(null);
  // Pad-set-key rows are split out from the main assignable list since they
  // can be 12+ rows of mostly-unused entries; collapsed by default.
  const [showPadSetKeys, setShowPadSetKeys] = useState(false);

  const assignable: AssignableItem[] = useMemo(() => STATIC_ASSIGNABLE, []);
  const padSetKeyAssignable: AssignableItem[] = useMemo(() => {
    const padKeys = Array.from(new Set(pads.map(p => p.key)));
    return padKeys.map(k => ({
      id: `pad_set_key:${k}`,
      label: `Pad set key — ${k}`,
      action: { type: 'pad_set_key' as const, key: k },
    }));
  }, [pads]);

  const onAddBinding = () => {
    const newBinding: MidiBinding = {
      id: generateId(),
      channel: 1,
      noteOrCc: 60,
      type: 'note',
      action: 'panic_fade',
      description: '',
    };
    updateConfig({ midiBindings: [...bindings, newBinding] });
  };

  const onUpdateBinding = (id: string, patch: Partial<MidiBinding>) => {
    updateConfig({ midiBindings: bindings.map(b => b.id === id ? { ...b, ...patch } : b) });
  };

  const onDeleteBinding = (id: string) => {
    updateConfig({ midiBindings: bindings.filter(b => b.id !== id) });
  };

  const startLearn = (item: AssignableItem) => {
    cancelLearnRef.current?.();
    setLearningId(item.id);
    cancelLearnRef.current = midi.startLearn(capture => {
      cancelLearnRef.current = null;
      setLearningId(null);
      // Read the freshest bindings list, not the closure's snapshot.
      const latest = useAppStore.getState().config.midiBindings;
      const existing = latest.find(b => actionsEqual(b.action, item.action));
      if (existing) {
        useAppStore.getState().updateConfig({
          midiBindings: latest.map(b =>
            b.id === existing.id
              ? {
                  ...b,
                  channel: capture.channel,
                  type: capture.type,
                  noteOrCc: capture.noteOrCc,
                  velocity: capture.velocity,
                }
              : b,
          ),
        });
      } else {
        const newBinding: MidiBinding = {
          id: generateId(),
          channel: capture.channel,
          type: capture.type,
          noteOrCc: capture.noteOrCc,
          velocity: capture.velocity,
          action: item.action,
        };
        useAppStore.getState().updateConfig({ midiBindings: [...latest, newBinding] });
      }
    });
  };

  const cancelLearn = () => {
    cancelLearnRef.current?.();
    cancelLearnRef.current = null;
    setLearningId(null);
  };

  const clearAssignment = (item: AssignableItem) => {
    const existing = bindings.find(b => actionsEqual(b.action, item.action));
    if (existing) onDeleteBinding(existing.id);
  };

  // Cancel any in-flight learn when the panel unmounts (e.g. tab switch).
  // Binding-to-engine sync now lives in engines.tsx so it works regardless of
  // which view is mounted.
  useEffect(() => () => cancelLearnRef.current?.(), []);

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">MIDI devices</div>
        <div className="settings-section-sub">
          Toggle which devices send MIDI to Runway and which can be used for
          outgoing MIDI. Disabled inputs stop appearing in the activity log
          and stop firing bindings — useful when one device is flooding the
          channel. Devices without a saved pref default to both directions on.
        </div>
        {devices.length === 0 ? (
          <div className="empty-state">No MIDI devices detected.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {devices.map(d => (
              <MidiDeviceRow
                key={d.name}
                device={d}
                onToggleInput={(v) => setDevicePref(d.name, d.manufacturer, { inputEnabled: v })}
                onToggleOutput={(v) => setDevicePref(d.name, d.manufacturer, { outputEnabled: v })}
                onToggleBoth={(v) => setBothDirections(d.name, d.manufacturer, v)}
                onForget={!d.connected ? () => clearDevicePref(d.name) : undefined}
              />
            ))}
          </div>
        )}
      </section>


      <section className="settings-section">
        <div className="settings-section-title">MIDI activity</div>
        <div className="settings-section-sub">
          Live log of every incoming MIDI message. Most recent at the top. Use this
          to verify your controller is reaching Runway and to see what notes/CCs
          its buttons send.
        </div>
        <MidiActivityLog />
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Quick assign</div>
        <div className="settings-section-sub">
          Click Learn next to an action, then press the button or key on your MIDI
          controller. Runway will capture the channel and note (or CC) and assign
          it to that action.
        </div>

        <div className="midi-bindings-table">
          {assignable.map(item => {
            const existing = bindings.find(b => actionsEqual(b.action, item.action));
            const isListening = learningId === item.id;
            return (
              <div key={item.id} className="midi-learn-row">
                <div className="midi-learn-label">{item.label}</div>
                <div className={`midi-learn-binding ${existing ? '' : 'unassigned'}`}>
                  {formatBinding(existing)}
                </div>
                <button
                  className={`midi-learn-btn ${isListening ? 'listening' : ''}`}
                  onClick={() => isListening ? cancelLearn() : startLearn(item)}
                >
                  {isListening ? 'Listening… cancel' : 'Learn'}
                </button>
                <button
                  className="midi-learn-clear"
                  onClick={() => clearAssignment(item)}
                  disabled={!existing}
                  title="Clear assignment"
                >×</button>
              </div>
            );
          })}
        </div>

        {/* Per-pad-key Set-armed-key bindings — usually 12+ rows, collapsed
            so the section doesn't dominate the view. */}
        {padSetKeyAssignable.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                cursor: 'pointer',
                userSelect: 'none',
                padding: '8px 4px',
              }}
              onClick={() => setShowPadSetKeys(v => !v)}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-dim)' }}>
                {showPadSetKeys ? '▾' : '▸'} Pad set key bindings ({padSetKeyAssignable.length})
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                One per mapped key — assigns which pad key the player is armed to.
              </div>
            </div>
            {showPadSetKeys && (
              <div className="midi-bindings-table" style={{ marginTop: 6 }}>
                {padSetKeyAssignable.map(item => {
                  const existing = bindings.find(b => actionsEqual(b.action, item.action));
                  const isListening = learningId === item.id;
                  return (
                    <div key={item.id} className="midi-learn-row">
                      <div className="midi-learn-label">{item.label}</div>
                      <div className={`midi-learn-binding ${existing ? '' : 'unassigned'}`}>
                        {formatBinding(existing)}
                      </div>
                      <button
                        className={`midi-learn-btn ${isListening ? 'listening' : ''}`}
                        onClick={() => isListening ? cancelLearn() : startLearn(item)}
                      >
                        {isListening ? 'Listening… cancel' : 'Learn'}
                      </button>
                      <button
                        className="midi-learn-clear"
                        onClick={() => clearAssignment(item)}
                        disabled={!existing}
                        title="Clear assignment"
                      >×</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

    </>
  );
}

// Field-key tuple per hook so HookActionRow can read/write the right slice.
type HookKey = 'musicStart' | 'serviceStart' | 'postServiceStart' | 'disarm';
interface HookKeys {
  action: keyof ProPresenterSyncConfig;
  playlistUuid: keyof ProPresenterSyncConfig;
  playlistName: keyof ProPresenterSyncConfig;
  itemIndex: keyof ProPresenterSyncConfig;
  itemName: keyof ProPresenterSyncConfig;
}
const HOOK_KEYS: Record<HookKey, HookKeys> = {
  musicStart: {
    action: 'musicStartAction', playlistUuid: 'musicStartPlaylistUuid',
    playlistName: 'musicStartPlaylistName', itemIndex: 'musicStartItemIndex',
    itemName: 'musicStartItemName',
  },
  serviceStart: {
    action: 'serviceStartAction', playlistUuid: 'serviceStartPlaylistUuid',
    playlistName: 'serviceStartPlaylistName', itemIndex: 'serviceStartItemIndex',
    itemName: 'serviceStartItemName',
  },
  postServiceStart: {
    action: 'postServiceStartAction', playlistUuid: 'postServiceStartPlaylistUuid',
    playlistName: 'postServiceStartPlaylistName', itemIndex: 'postServiceStartItemIndex',
    itemName: 'postServiceStartItemName',
  },
  disarm: {
    action: 'disarmAction', playlistUuid: 'disarmPlaylistUuid',
    playlistName: 'disarmPlaylistName', itemIndex: 'disarmItemIndex',
    itemName: 'disarmItemName',
  },
};

function ProPresenterSettings() {
  const { pp } = useEngines();
  const cfg = useAppStore(s => s.config.proPresenterSync);
  const ppStatus = useAppStore(s => s.ppStatus);
  // Eager-loaded data from engines.tsx — already populated at app start when
  // PP is reachable, so the dropdowns render with values on first mount.
  const cachedTimers = useAppStore(s => s.ppTimers);
  const cachedPlaylists = useAppStore(s => s.ppPlaylists);
  const updateConfig = useAppStore(s => s.updateConfig);

  const [timers, setTimers] = useState<PpTimer[]>(() =>
    cachedTimers.map(t => ({ ...t, raw: t })));
  const [playlists, setPlaylists] = useState<PpTimer[]>(() =>
    cachedPlaylists.map(p => ({ ...p, raw: p })));
  // Keep local state in sync if the cache updates while we're already mounted.
  useEffect(() => {
    setTimers(cachedTimers.map(t => ({ ...t, raw: t })));
  }, [cachedTimers]);
  useEffect(() => {
    setPlaylists(cachedPlaylists.map(p => ({ ...p, raw: p })));
  }, [cachedPlaylists]);
  // One items list per hook so each hook can target a different playlist.
  const [itemsByHook, setItemsByHook] = useState<Record<HookKey, PpTimer[]>>({
    musicStart: [], serviceStart: [], postServiceStart: [], disarm: [],
  });
  const [busyByHook, setBusyByHook] = useState<Record<HookKey, boolean>>({
    musicStart: false, serviceStart: false, postServiceStart: false, disarm: false,
  });
  const [testStatus, setTestStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  const update = (patch: Partial<ProPresenterSyncConfig>) => {
    updateConfig({ proPresenterSync: { ...cfg, ...patch } });
  };

  const loadItemsForHook = async (hook: HookKey, playlistUuid: string | null) => {
    if (!playlistUuid) {
      setItemsByHook(s => ({ ...s, [hook]: [] }));
      return;
    }
    setBusyByHook(s => ({ ...s, [hook]: true }));
    try {
      const items = await pp.listPlaylistItems(playlistUuid);
      setItemsByHook(s => ({ ...s, [hook]: items }));
    } catch (err) {
      console.warn(`[pp] listPlaylistItems (${hook}) failed`, err);
    } finally {
      setBusyByHook(s => ({ ...s, [hook]: false }));
    }
  };

  const onTest = async () => {
    setTestStatus({ kind: 'busy' });
    try {
      pp.updateConfig(cfg);
      const res = await pp.testConnection();
      setTestStatus({ kind: 'ok', msg: res.version ? `Connected — PP ${res.version}` : 'Connected' });
      const [tList, pList] = await Promise.all([pp.listTimers(), pp.listPlaylists()]);
      setTimers(tList);
      setPlaylists(pList);
      if (cfg.timerUuid && !tList.some(t => t.uuid === cfg.timerUuid)) {
        update({ timerUuid: null, timerName: null });
      }
      // Pre-load each hook's saved playlist so its items dropdown is populated.
      await Promise.all((['musicStart', 'serviceStart', 'postServiceStart', 'disarm'] as const).map(async hook => {
        const k = HOOK_KEYS[hook];
        const savedUuid = cfg[k.playlistUuid] as string | null;
        if (savedUuid && !pList.some(p => p.uuid === savedUuid)) {
          // Saved playlist no longer exists — clear that hook's selection.
          update({ [k.playlistUuid]: null, [k.playlistName]: null, [k.itemIndex]: null, [k.itemName]: null } as Partial<ProPresenterSyncConfig>);
        } else if (savedUuid) {
          await loadItemsForHook(hook, savedUuid);
        }
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestStatus({ kind: 'err', msg });
      setTimers([]);
      setPlaylists([]);
      setItemsByHook({ musicStart: [], serviceStart: [], postServiceStart: [], disarm: [] });
    }
  };

  const onPickTimer = (uuid: string) => {
    const timer = timers.find(t => t.uuid === uuid);
    update({ timerUuid: uuid || null, timerName: timer?.name ?? null });
  };

  // Auto-load timers + playlists whenever PP transitions to a connected state
  // (initial connect, reconnect after PP restart, or returning from an err
  // state). Skip while the user is mid-test to avoid stomping their request.
  const lastAutoLoadStatus = useRef<typeof ppStatus | null>(null);
  useEffect(() => {
    const wasConnected = lastAutoLoadStatus.current === 'ok';
    lastAutoLoadStatus.current = ppStatus;
    if (ppStatus !== 'ok' || wasConnected) return;
    if (testStatus.kind === 'busy') return;
    void onTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ppStatus]);

  // Live connection indicator dot in the connection card header.
  const connDotClass =
    ppStatus === 'ok' ? 'on' :
    ppStatus === 'err' ? 'err' :
    ppStatus === 'unknown' ? 'unknown' :
    'off';
  const connText =
    ppStatus === 'ok' ? 'Connected' :
    ppStatus === 'err' ? 'Connection error' :
    ppStatus === 'unknown' ? 'Checking…' :
    'Disabled';

  return (
    <section className="settings-section">
      <div className="settings-section-title">ProPresenter sync</div>
      <div className="settings-section-sub">
        Drive a ProPresenter timer and trigger PP actions at moments in
        Runway's lifecycle. When you arm a service, Runway pushes a fresh
        countdown to the chosen PP timer; the four hooks below let you
        also fire a slide or clear PP at specific moments. Enable
        Network API in PP under <em>Preferences → Network</em>.
      </div>

      {/* Connection card */}
      <div className="pp-card">
        <div className="pp-card-head">
          <span className="pp-card-icon" aria-hidden>⌁</span>
          <div className="pp-card-text">
            <div className="pp-card-title">Connection</div>
            <div className="pp-card-sub">
              ProPresenter Network API — the bridge Runway talks to.
            </div>
          </div>
          <span className={`pp-card-status ${connDotClass}`} title={connText}>
            <span className="pp-card-status-dot" aria-hidden /> {connText}
          </span>
        </div>
        <div className="pp-grid">
          <div className="pp-field" style={{ gridColumn: 'span 2' }}>
            <label className="pp-label">Host</label>
            <input
              type="text"
              value={cfg.host}
              placeholder="localhost or 192.168.1.42"
              onChange={e => update({ host: e.target.value })}
            />
          </div>
          <div className="pp-field">
            <label className="pp-label">Port</label>
            <input
              type="number" min={1} max={65535}
              value={cfg.port}
              onChange={e => update({ port: Math.max(1, Math.min(65535, +e.target.value || 1025)) })}
            />
          </div>
          <div className="pp-field">
            <label className="pp-label">Password</label>
            <input
              type="password"
              value={cfg.password}
              placeholder="(blank if none)"
              onChange={e => update({ password: e.target.value })}
            />
          </div>

          <div className="pp-field" style={{ gridColumn: 'span 3' }}>
            <label className="pp-label">Timer</label>
            <select
              value={cfg.timerUuid ?? ''}
              onChange={e => onPickTimer(e.target.value)}
            >
              <option value="">{timers.length === 0 ? '— Test connection to load timers —' : '— Select a timer —'}</option>
              {timers.map(t => (
                <option key={t.uuid} value={t.uuid}>{t.name}</option>
              ))}
              {cfg.timerUuid && cfg.timerName && !timers.some(t => t.uuid === cfg.timerUuid) && (
                <option value={cfg.timerUuid}>{cfg.timerName} (not found in PP)</option>
              )}
            </select>
          </div>
          <div className="pp-field">
            <label className="pp-label">Sync</label>
            <button
              className={`pp-toggle ${cfg.enabled ? 'on' : 'off'}`}
              onClick={() => update({ enabled: !cfg.enabled })}
              disabled={!cfg.timerUuid}
              title={!cfg.timerUuid ? 'Pick a timer first' : ''}
            >
              {cfg.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </div>

        <div className="pp-actions">
          <button className="btn-secondary" onClick={onTest} disabled={testStatus.kind === 'busy'}>
            {testStatus.kind === 'busy' ? 'Testing…' : 'Test connection & reload timers'}
          </button>
          {testStatus.kind === 'ok' && <span className="pp-status ok">{testStatus.msg}</span>}
          {testStatus.kind === 'err' && <span className="pp-status err">{testStatus.msg}</span>}
        </div>
      </div>

      {/* Hooks — each gets its own colored card so the operator can scan
          the four moments at a glance. Functionality is identical to the
          old flat layout. */}
      <div className="pp-hooks">
        <HookCard
          hook="musicStart" label="When music starts" icon="♪" tone="music"
          description="Fires the moment Runway's pre-service music actually begins playing."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.musicStart} busy={busyByHook.musicStart}
          loadItems={loadItemsForHook}
        />
        <HookCard
          hook="serviceStart" label="When service starts" icon="▶" tone="service"
          description="Fires the moment the PP timer hits 00:00 — the scheduled service start time."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.serviceStart} busy={busyByHook.serviceStart}
          loadItems={loadItemsForHook}
        />
        <HookCard
          hook="postServiceStart" label="When post-service starts" icon="✦" tone="post"
          description="Fires when Start Post-Service is pressed. No timer involvement."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.postServiceStart} busy={busyByHook.postServiceStart}
          loadItems={loadItemsForHook}
        />
        <HookCard
          hook="disarm" label="When disarmed" icon="◯" tone="disarm"
          description="Fires when Runway is panicked or manually disarmed before service start. Pick 'Do nothing' to leave the PP timer running."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.disarm} busy={busyByHook.disarm}
          loadItems={loadItemsForHook}
        />
      </div>
    </section>
  );
}

interface HookCardProps {
  hook: HookKey;
  label: string;
  description: string;
  icon: string;
  tone: 'music' | 'service' | 'post' | 'disarm';
  cfg: ProPresenterSyncConfig;
  update: (patch: Partial<ProPresenterSyncConfig>) => void;
  playlists: PpTimer[];
  items: PpTimer[];
  busy: boolean;
  loadItems: (hook: HookKey, playlistUuid: string | null) => Promise<void>;
}

function HookCard({ hook, label, description, icon, tone, cfg, update, playlists, items, busy, loadItems }: HookCardProps) {
  const k = HOOK_KEYS[hook];
  const action = cfg[k.action] as 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
  const playlistUuid = cfg[k.playlistUuid] as string | null;
  const playlistName = cfg[k.playlistName] as string | null;
  const itemIndex = cfg[k.itemIndex] as number | null;
  const itemName = cfg[k.itemName] as string | null;

  const onPickPlaylist = (uuid: string) => {
    const playlist = playlists.find(p => p.uuid === uuid);
    update({
      [k.playlistUuid]: uuid || null,
      [k.playlistName]: playlist?.name ?? null,
      [k.itemIndex]: null,
      [k.itemName]: null,
    } as Partial<ProPresenterSyncConfig>);
    void loadItems(hook, uuid || null);
  };

  const onPickItem = (raw: string) => {
    if (raw === '') {
      update({ [k.itemIndex]: null, [k.itemName]: null } as Partial<ProPresenterSyncConfig>);
      return;
    }
    const idx = parseInt(raw, 10);
    if (Number.isNaN(idx)) return;
    const item = items.find(i => i.index === idx);
    update({ [k.itemIndex]: idx, [k.itemName]: item?.name ?? null } as Partial<ProPresenterSyncConfig>);
  };

  // "Do nothing" reads as inactive — drop the card's accent saturation
  // so the eye skips past to cards that are actually configured.
  const inactive = action === 'none';

  return (
    <div className={`pp-card pp-hook tone-${tone} ${inactive ? 'inactive' : ''}`}>
      <div className="pp-card-head">
        <span className="pp-card-icon" aria-hidden>{icon}</span>
        <div className="pp-card-text">
          <div className="pp-card-title">{label}</div>
          <div className="pp-card-sub">{description}</div>
        </div>
      </div>

      <div className="pp-grid">
        <div className="pp-field" style={{ gridColumn: action === 'trigger_item' ? 'span 1' : 'span 4' }}>
          <label className="pp-label">Action</label>
          <select
            value={action}
            onChange={e => update({ [k.action]: e.target.value } as Partial<ProPresenterSyncConfig>)}
          >
            <option value="none">Do nothing</option>
            <option value="clear_timer">Clear PP timer only</option>
            <option value="clear_all">Clear all PP layers</option>
            <option value="trigger_item">Trigger playlist item</option>
          </select>
        </div>
        {action === 'trigger_item' && (
          <>
            <div className="pp-field" style={{ gridColumn: 'span 1' }}>
              <label className="pp-label">Playlist</label>
              <select
                value={playlistUuid ?? ''}
                onChange={e => onPickPlaylist(e.target.value)}
              >
                <option value="">{playlists.length === 0 ? '— Test connection to load —' : '— Select a playlist —'}</option>
                {playlists.map(p => (
                  <option key={p.uuid} value={p.uuid}>{p.name}</option>
                ))}
                {playlistUuid && playlistName && !playlists.some(p => p.uuid === playlistUuid) && (
                  <option value={playlistUuid}>{playlistName} (not found)</option>
                )}
              </select>
            </div>
            <div className="pp-field" style={{ gridColumn: 'span 2' }}>
              <label className="pp-label">Item</label>
              <select
                value={itemIndex !== null ? String(itemIndex) : ''}
                onChange={e => onPickItem(e.target.value)}
                disabled={!playlistUuid || busy}
              >
                <option value="">
                  {!playlistUuid ? '— Pick a playlist first —'
                    : busy ? '— Loading items… —'
                    : items.length === 0 ? '— Playlist has no items (or not loaded) —'
                    : '— Select an item —'}
                </option>
                {items.map(i => (
                  <option key={i.uuid} value={i.index ?? ''}>
                    {i.index !== undefined ? `${i.index + 1}. ` : ''}{i.name}
                  </option>
                ))}
                {itemIndex !== null && itemName && !items.some(i => i.index === itemIndex) && (
                  <option value={String(itemIndex)}>
                    {itemIndex + 1}. {itemName} (not loaded)
                  </option>
                )}
              </select>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MidiDeviceRow({ device, onToggleInput, onToggleOutput, onToggleBoth, onForget }: {
  device: MidiDeviceSnapshot;
  onToggleInput: (next: boolean) => void;
  onToggleOutput: (next: boolean) => void;
  onToggleBoth: (next: boolean) => void;
  onForget?: () => void;
}) {
  const { midi } = useEngines();
  // Quick visual flash on the Test button so the operator gets local
  // confirmation that the send actually went out — useful when the
  // destination device's own status LEDs are out of view.
  const [testFlash, setTestFlash] = useState(false);
  const sendTestNote = () => {
    // C4 on channel 1, velocity 100. Schedule note-off 200ms later so
    // synths that hold notes don't stick. send() is a no-op if the
    // device is disconnected or output is disabled — both already
    // gated by the button's `disabled` attribute.
    midi.send(device.name, 'note_on', 1, 60, 100);
    setTestFlash(true);
    window.setTimeout(() => {
      midi.send(device.name, 'note_off', 1, 60, 0);
      setTestFlash(false);
    }, 200);
  };
  const dim = !device.connected;
  // Light up green when connected AND at least one direction is enabled —
  // a quick visual scan tells you which ports are actually active.
  const isLive = device.connected && (device.inputEnabled || device.outputEnabled);
  return (
    <div
      className="device-card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 14px',
        opacity: dim ? 0.6 : 1,
      }}
    >
      <div
        className="device-icon"
        role={device.connected && (device.hasInput || device.hasOutput) ? 'button' : undefined}
        tabIndex={device.connected && (device.hasInput || device.hasOutput) ? 0 : undefined}
        onClick={() => {
          if (!device.connected) return;
          // Single config write that flips both directions at once. Doing
          // it in one call avoids a race where two sequential writes read
          // the same stale state and one undoes the other.
          const anyOn = device.inputEnabled || device.outputEnabled;
          onToggleBoth(!anyOn);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          if (!device.connected) return;
          e.preventDefault();
          const anyOn = device.inputEnabled || device.outputEnabled;
          onToggleBoth(!anyOn);
        }}
        style={{
          color: isLive ? 'var(--accent-bright)' : 'var(--text-faint)',
          filter: isLive ? 'drop-shadow(0 0 4px rgba(20, 184, 166, 0.45))' : 'none',
          transition: 'color 0.15s ease, filter 0.15s ease',
          cursor: device.connected ? 'pointer' : 'default',
        }}
        title={
          !device.connected
            ? 'Disconnected'
            : isLive
              ? 'Active — click to disable both directions'
              : 'Disabled — click to enable both directions'
        }
      >
        {/* Stylized 5-pin DIN MIDI plug — outer circle, 5 pin dots in a
            semicircle across the top, and a keyway notch at the bottom. */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="12" cy="12" r="9.5" />
          <circle cx="6.5" cy="13" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="9" cy="9" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="7.5" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="15" cy="9" r="1.1" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="13" r="1.1" fill="currentColor" stroke="none" />
          <line x1="9" y1="17.5" x2="15" y2="17.5" strokeLinecap="round" />
        </svg>
      </div>
      <div className="device-info" style={{ flex: 1, minWidth: 0 }}>
        <div className="device-name">
          {device.name}
          {!device.connected && <span className="device-badge" style={{ background: 'var(--bg-elev-2)', color: 'var(--text-faint)' }}>Disconnected</span>}
        </div>
        <div className="device-meta">{device.manufacturer || 'Unknown manufacturer'}</div>
      </div>
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: device.connected && device.hasInput ? 'pointer' : 'default' }}
        title={device.hasInput ? 'Listen to incoming MIDI from this device' : 'No input port on this device'}
      >
        <input
          type="checkbox"
          checked={device.inputEnabled}
          disabled={!device.connected || !device.hasInput}
          onChange={e => onToggleInput(e.target.checked)}
          style={{ accentColor: 'var(--accent)' }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>In</span>
      </label>
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: device.connected && device.hasOutput ? 'pointer' : 'default' }}
        title={device.hasOutput ? 'Allow outgoing MIDI to this device' : 'No output port on this device'}
      >
        <input
          type="checkbox"
          checked={device.outputEnabled}
          disabled={!device.connected || !device.hasOutput}
          onChange={e => onToggleOutput(e.target.checked)}
          style={{ accentColor: 'var(--accent)' }}
        />
        <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>Out</span>
      </label>
      <button
        className="btn-secondary"
        onClick={sendTestNote}
        disabled={!device.connected || !device.hasOutput || !device.outputEnabled}
        style={{
          padding: '4px 10px',
          fontSize: 12,
          background: testFlash ? 'rgba(20, 184, 166, 0.25)' : undefined,
          borderColor: testFlash ? 'var(--accent-bright)' : undefined,
          color: testFlash ? 'var(--accent-bright)' : undefined,
          transition: 'background 0.12s, border-color 0.12s, color 0.12s',
        }}
        title={
          !device.connected
            ? 'Device disconnected'
            : !device.hasOutput
              ? 'Device has no MIDI output'
              : !device.outputEnabled
                ? 'Output disabled — enable it first'
                : 'Send C4 / channel 1 (200ms) to verify the wiring downstream'
        }
      >
        Test
      </button>
      {onForget && (
        <button
          className="btn-secondary"
          onClick={onForget}
          style={{ padding: '4px 10px', fontSize: 12 }}
          title="Remove the saved preference for this device"
        >
          Forget
        </button>
      )}
    </div>
  );
}

function MidiActivityLog() {
  const log = useAppStore(s => s.midiLog);
  // Most recent on top, capped to 50.
  const recent = useMemo(() => log.slice(-50).reverse(), [log]);

  if (recent.length === 0) {
    return (
      <div className="midi-activity">
        <div className="empty-state">
          No MIDI traffic yet. Press a button on your controller to verify it's reaching Runway.
        </div>
      </div>
    );
  }

  return (
    <div className="midi-activity">
      <div className="midi-activity-row header">
        <div>Time</div>
        <div>Device</div>
        <div>Type</div>
        <div>Ch</div>
        <div>Note / CC</div>
        <div>Velocity</div>
        <div>Action</div>
      </div>
      {recent.map((e, i) => {
        const t = new Date(e.timestamp);
        const ts = `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}.${String(t.getMilliseconds()).padStart(3,'0')}`;
        return (
          <div key={`${e.timestamp}-${i}`} className={`midi-activity-row type-${e.type}`}>
            <div className="ma-time">{ts}</div>
            <div className="ma-device" title={e.deviceName ?? ''}>{e.deviceName ?? '—'}</div>
            <div className="ma-type">{formatMessageType(e.type)}</div>
            <div className="ma-ch">{e.channel ? `ch ${e.channel}` : '—'}</div>
            <div className="ma-data">{e.type === 'system' || e.type === 'pitchbend' ? '—' : e.data1}</div>
            <div className="ma-vel">{e.type === 'note' || e.type === 'cc' || e.type === 'note_off' ? e.data2 : '—'}</div>
            <div className="ma-action">{e.matchedAction ?? ''}</div>
          </div>
        );
      })}
    </div>
  );
}

function formatMessageType(t: string): string {
  switch (t) {
    case 'note': return 'Note On';
    case 'note_off': return 'Note Off';
    case 'cc': return 'CC';
    case 'pc': return 'Program';
    case 'pitchbend': return 'Pitch Bend';
    case 'aftertouch': return 'Aftertouch';
    case 'poly_aftertouch': return 'Poly AT';
    case 'system': return 'System';
    default: return t;
  }
}

function ActionPicker({ action, onChange }: { action: MidiAction; onChange: (a: MidiAction) => void }) {
  const isPadKey = typeof action !== 'string' && action.type === 'pad_set_key';
  const baseValue = typeof action === 'string' ? action : action.type;

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <select
        value={baseValue}
        onChange={e => {
          const v = e.target.value;
          if (v === 'pad_set_key') {
            onChange({ type: 'pad_set_key', key: 'D' });
          } else {
            onChange(v as MidiAction);
          }
        }}
        style={{ flex: 1 }}
      >
        <option value="arm_toggle">Arm / Disarm</option>
        <option value="panic_fade">Panic fade</option>
        <option value="start_post_service">Start post-service</option>
        <option value="pad_play">Pad play</option>
        <option value="pad_stop">Pad stop</option>
        <option value="pad_set_key">Pad set key</option>
      </select>
      {isPadKey && (
        <select
          value={(action as any).key}
          onChange={e => onChange({ type: 'pad_set_key', key: e.target.value as KeyName })}
        >
          {ALL_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
        </select>
      )}
    </div>
  );
}

function PadSettings() {
  const pads = useAppStore(s => s.config.pads);
  const defaults = useAppStore(s => s.config.defaults);
  const updateConfig = useAppStore(s => s.updateConfig);

  const padLevel = defaults.padPlayerLevel ?? 0.6;
  const padGainDb = defaults.padPlayerGainDb ?? 0;
  const keyDisplayMode = defaults.keyDisplayMode ?? 'sharp';
  const setPadLevel = (v: number) => updateConfig({
    defaults: { ...defaults, padPlayerLevel: Math.max(0, Math.min(1, v)) },
  });
  const setPadGainDb = (v: number) => updateConfig({
    defaults: { ...defaults, padPlayerGainDb: Math.max(-24, Math.min(12, v)) },
  });
  const setKeyDisplayMode = (m: 'sharp' | 'flat') => updateConfig({
    defaults: { ...defaults, keyDisplayMode: m },
  });

  const onAssignPad = async (key: KeyName) => {
    if (!window.runway) return;
    const paths = await window.runway.files.pickAudio(false);
    if (paths.length === 0) return;
    let filePath = paths[0];
    try {
      filePath = await window.runway.files.importPad(filePath);
    } catch (err) {
      console.warn('[importPad] failed', err);
    }
    const next: PadFile[] = [
      ...pads.filter(p => p.key !== key),
      { key, filePath, texture: 'warm' },
    ];
    updateConfig({ pads: next });
  };

  const onClearPad = (key: KeyName) => {
    updateConfig({ pads: pads.filter(p => p.key !== key) });
  };

  const [scanStatus, setScanStatus] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string; section?: 'major' | 'minor' }>({ kind: 'idle' });
  const [confirmClear, setConfirmClear] = useState<'major' | 'minor' | null>(null);

  const onScanForSection = async (mode: 'major' | 'minor') => {
    if (!window.runway) return;
    const folder = await window.runway.files.pickFolder();
    if (!folder) return;
    setScanStatus({ kind: 'busy', msg: 'Scanning…', section: mode });
    try {
      const results = await window.runway.files.scanPadFolder(folder, mode);
      // Filter to only the section's keys (defensive — scanner respects mode,
      // but a stray "Cm.wav" inside a Major scan would still come through as Cm).
      const sectionKeys = new Set<KeyName>(mode === 'major' ? MAJOR_KEYS : MINOR_KEYS);
      const filtered = results.filter(r => sectionKeys.has(r.key));
      if (filtered.length === 0) {
        setScanStatus({ kind: 'err', msg: `No ${mode} key-named audio files found.`, section: mode });
        return;
      }
      const importedByKey = new Map<KeyName, string>();
      let importErrors = 0;
      for (const r of filtered) {
        try {
          const dest = await window.runway.files.importPad(r.filePath);
          importedByKey.set(r.key, dest);
        } catch (err) {
          console.warn('[scanPadFolder] import failed', r, err);
          importErrors += 1;
        }
      }
      // Replace pads for the keys we just imported; leave everything else (including
      // the OTHER section's pads) intact.
      const next: PadFile[] = [
        ...pads.filter(p => !importedByKey.has(p.key)),
        ...Array.from(importedByKey.entries()).map(([key, filePath]) => ({
          key, filePath, texture: 'warm' as const,
        })),
      ];
      updateConfig({ pads: next });
      const msg = `Mapped ${importedByKey.size} ${mode} pad${importedByKey.size === 1 ? '' : 's'}${importErrors > 0 ? ` · ${importErrors} import error${importErrors === 1 ? '' : 's'}` : ''}.`;
      setScanStatus({ kind: 'ok', msg, section: mode });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setScanStatus({ kind: 'err', msg, section: mode });
    }
  };

  const onClearSection = (mode: 'major' | 'minor') => {
    if (confirmClear !== mode) {
      setConfirmClear(mode);
      window.setTimeout(() => setConfirmClear(c => c === mode ? null : c), 3000);
      return;
    }
    setConfirmClear(null);
    const sectionKeys = new Set<KeyName>(mode === 'major' ? MAJOR_KEYS : MINOR_KEYS);
    const next = pads.filter(p => !sectionKeys.has(p.key));
    updateConfig({ pads: next });
    const removed = pads.length - next.length;
    setScanStatus({ kind: 'ok', msg: `Cleared ${removed} ${mode} pad${removed === 1 ? '' : 's'}.`, section: mode });
  };

  const [consolidate, setConsolidate] = useState<{ kind: 'idle' | 'busy' | 'ok' | 'err'; msg?: string }>({ kind: 'idle' });

  const onConsolidatePads = async () => {
    if (!window.runway || pads.length === 0) return;
    setConsolidate({ kind: 'busy' });
    try {
      const next: PadFile[] = [];
      let moved = 0;
      let alreadyInPlace = 0;
      let errors = 0;
      for (const pad of pads) {
        try {
          // importPad is idempotent: returns the existing path if the source
          // is already inside userData/pads, otherwise copies and returns
          // the new in-folder path.
          const dest = await window.runway.files.importPad(pad.filePath);
          if (dest === pad.filePath) alreadyInPlace += 1;
          else moved += 1;
          next.push({ ...pad, filePath: dest });
        } catch (err) {
          console.warn('[consolidatePads] failed for', pad.key, pad.filePath, err);
          errors += 1;
          next.push(pad);
        }
      }
      updateConfig({ pads: next });
      const parts: string[] = [];
      if (moved > 0) parts.push(`${moved} moved`);
      if (alreadyInPlace > 0) parts.push(`${alreadyInPlace} already in place`);
      if (errors > 0) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      setConsolidate({ kind: errors > 0 && moved === 0 ? 'err' : 'ok', msg: parts.join(' · ') || 'Nothing to consolidate' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setConsolidate({ kind: 'err', msg });
    }
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Pad player output</div>
        <div className="settings-section-sub">
          Volume sets the pad's level relative to other audio. Gain trims dB
          for boosting a quiet pad source or attenuating a loud one. Both apply
          to every pad triggered.
        </div>
        <div className="pad-level-grid">
          <div className="pad-level-field">
            <label className="pad-level-label">Volume</label>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(padLevel * 100)}
              onChange={e => setPadLevel(+e.target.value / 100)}
              className="pad-level-slider"
            />
            <div className="pad-level-readout">{Math.round(padLevel * 100)}%</div>
          </div>
          <div className="pad-level-field">
            <label className="pad-level-label">Gain</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <RotaryKnob
                value={padGainDb}
                min={-24}
                max={12}
                zero={0}
                size={64}
                pxFullRange={180}
                shiftStep={1}
                onChange={v => setPadGainDb(+v.toFixed(1))}
                onDoubleClick={() => setPadGainDb(0)}
                label="dB"
                formatValue={v => v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)}
              />
              <div style={{ fontSize: 11, color: 'var(--text-faint)', maxWidth: 180, lineHeight: 1.4 }}>
                Drag up/down to turn (Shift = snap to whole dB).
                Double-click or scroll to fine-tune. Range −24 dB to +12 dB.
              </div>
            </div>
          </div>
        </div>

        <div className="pad-level-field" style={{ marginTop: 18 }}>
          <label className="pad-level-label">Key naming</label>
          <div className="pl-toggle" style={{ width: 'fit-content' }}>
            <button
              className={`pl-toggle-btn ${keyDisplayMode === 'sharp' ? 'active' : ''}`}
              onClick={() => setKeyDisplayMode('sharp')}
            >Sharps (C# / D# / A#)</button>
            <button
              className={`pl-toggle-btn ${keyDisplayMode === 'flat' ? 'active' : ''}`}
              onClick={() => setKeyDisplayMode('flat')}
            >Flats (Db / Eb / Bb)</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
            Display only — internal storage stays the same regardless. Switch this to match how your pad files / library tracks are labeled.
          </div>
        </div>
      </section>

    <section className="settings-section">
      <div className="settings-section-title">Pad library</div>
      <div className="settings-section-sub" style={{ maxWidth: 560 }}>
        Assign one looping pad file per key, or use Scan to bulk-import a
        folder where each file is named after its key (A.wav, C#.wav, etc.).
        Each section's Scan only fills that section, so plain-letter files
        (A.wav, B.wav, …) get mapped major or minor based on which section's
        button you click. Existing assignments outside the section are kept.
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button
          className="btn-secondary"
          onClick={() => void onConsolidatePads()}
          disabled={consolidate.kind === 'busy' || pads.length === 0}
          title="Copy any pad files referenced from outside the app folder into the app's pads directory. Useful after migrating between dev / packaged installs."
        >
          {consolidate.kind === 'busy' ? 'Consolidating…' : 'Consolidate pads to app folder'}
        </button>
        {consolidate.kind === 'ok' && (
          <span style={{ fontSize: 12, color: 'var(--accent-bright)' }}>{consolidate.msg}</span>
        )}
        {consolidate.kind === 'err' && (
          <span style={{ fontSize: 12, color: 'var(--red-bright)' }}>{consolidate.msg}</span>
        )}
      </div>

      {/* Major section */}
      <div className="pad-section-header" style={{ marginTop: 18 }}>
        <div className="pad-section-title">Major keys</div>
        <div className="pad-section-actions">
          <button
            className="btn-secondary"
            onClick={() => void onScanForSection('major')}
            disabled={scanStatus.kind === 'busy' && scanStatus.section === 'major'}
          >
            {scanStatus.kind === 'busy' && scanStatus.section === 'major' ? 'Scanning…' : 'Scan folder → Major'}
          </button>
          <button
            className={`btn-secondary ${confirmClear === 'major' ? 'btn-confirm-danger' : ''}`}
            onClick={() => onClearSection('major')}
            disabled={!pads.some(p => MAJOR_KEYS.includes(p.key))}
          >
            {confirmClear === 'major' ? 'Click again to clear' : 'Clear all Major'}
          </button>
        </div>
      </div>
      {scanStatus.section === 'major' && scanStatus.kind === 'ok' && (
        <div className="pp-status ok" style={{ marginBottom: 8 }}>{scanStatus.msg}</div>
      )}
      {scanStatus.section === 'major' && scanStatus.kind === 'err' && (
        <div className="pp-status err" style={{ marginBottom: 8 }}>{scanStatus.msg}</div>
      )}
      <PadGrid keys={MAJOR_KEYS} pads={pads} mode={keyDisplayMode} onAssign={onAssignPad} onClear={onClearPad} />

      {/* Minor section */}
      <div className="pad-section-header" style={{ marginTop: 22 }}>
        <div className="pad-section-title">Minor keys</div>
        <div className="pad-section-actions">
          <button
            className="btn-secondary"
            onClick={() => void onScanForSection('minor')}
            disabled={scanStatus.kind === 'busy' && scanStatus.section === 'minor'}
          >
            {scanStatus.kind === 'busy' && scanStatus.section === 'minor' ? 'Scanning…' : 'Scan folder → Minor'}
          </button>
          <button
            className={`btn-secondary ${confirmClear === 'minor' ? 'btn-confirm-danger' : ''}`}
            onClick={() => onClearSection('minor')}
            disabled={!pads.some(p => MINOR_KEYS.includes(p.key))}
          >
            {confirmClear === 'minor' ? 'Click again to clear' : 'Clear all Minor'}
          </button>
        </div>
      </div>
      {scanStatus.section === 'minor' && scanStatus.kind === 'ok' && (
        <div className="pp-status ok" style={{ marginBottom: 8 }}>{scanStatus.msg}</div>
      )}
      {scanStatus.section === 'minor' && scanStatus.kind === 'err' && (
        <div className="pp-status err" style={{ marginBottom: 8 }}>{scanStatus.msg}</div>
      )}
      <PadGrid keys={MINOR_KEYS} pads={pads} mode={keyDisplayMode} onAssign={onAssignPad} onClear={onClearPad} />
    </section>
    </>
  );
}

function PadGrid({ keys, pads, mode, onAssign, onClear }: {
  keys: KeyName[];
  pads: PadFile[];
  mode: 'sharp' | 'flat';
  onAssign: (k: KeyName) => void;
  onClear: (k: KeyName) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
      {keys.map(k => {
        const pad = pads.find(p => p.key === k);
        const c = keyColor(k);
        return (
          <div
            key={k}
            className="device-card"
            style={{
              padding: 12,
              gap: 10,
              background: pad ? c.soft : c.whisper,
              borderColor: pad ? c.fg : undefined,
            }}
          >
            <div
              className="device-icon"
              style={{
                width: 36,
                height: 36,
                background: c.bg,
                borderColor: c.fg,
                borderWidth: 1,
                borderStyle: 'solid',
              }}
            >
              <span style={{
                fontFamily: 'IBM Plex Mono, monospace',
                fontWeight: 700,
                fontSize: 14,
                color: c.fg,
              }}>{displayKey(k, mode)}</span>
            </div>
            <div className="device-info" style={{ minWidth: 0 }}>
              <div className="device-name" style={{ fontSize: 12 }}>
                {pad ? 'Mapped' : 'Not set'}
              </div>
              <div className="device-meta" style={{ fontSize: 10 }}>
                {pad?.filePath ? pad.filePath.split('/').pop() : '— click to assign —'}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <button className="btn" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => onAssign(k)}>
                {pad ? 'Replace' : 'Assign'}
              </button>
              {pad && (
                <button className="btn-danger" style={{ fontSize: 12, padding: '4px 8px' }} onClick={() => onClear(k)}>
                  Clear
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EngineSettings() {
  const config = useAppStore(s => s.config);
  const updateConfig = useAppStore(s => s.updateConfig);
  const updateTrack = useAppStore(s => s.updateTrack);
  const clearAllTombstones = useAppStore(s => s.clearAllTombstones);
  const updateDefault = (k: keyof typeof config.defaults, v: number) => {
    updateConfig({ defaults: { ...config.defaults, [k]: v } });
  };
  // `?? true` covers configs written before the field existed.
  const autoKeyTagOnImport = config.defaults.autoKeyTagOnImport ?? true;
  const repeatToFill = config.defaults.repeatToFill ?? true;
  const setRepeatToFill = (v: boolean) =>
    updateConfig({ defaults: { ...config.defaults, repeatToFill: v } });

  const autoScheduleDaysAhead = config.defaults.autoScheduleDaysAhead ?? 2;
  const autoScheduleTime = config.defaults.autoScheduleTime ?? '00:00';
  const tombstoneCount = config.skippedServiceDates.length;
  const [tombstoneFlash, setTombstoneFlash] = useState<string | null>(null);
  const [tombstonesOpen, setTombstonesOpen] = useState(false);

  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Library audio dir — fetched once on mount so we can show the path
  // and reveal it in Finder.
  const [audioDir, setAudioDir] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    void window.runway?.files.libraryPaths().then(p => {
      if (!cancelled) setAudioDir(p.audioDir);
    });
    return () => { cancelled = true; };
  }, []);
  const onReimportAll = async () => {
    if (!window.runway || importing) return;
    setImporting(true);
    setImportStatus('Starting…');
    const tracks = useAppStore.getState().config.tracks;
    let copied = 0;
    let kept = 0;
    let failed = 0;
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      setImportStatus(`Importing ${i + 1} of ${tracks.length}: ${t.title}`);
      try {
        const newPath = await window.runway.files.importFile(t.filePath);
        if (newPath !== t.filePath) {
          updateTrack(t.id, { filePath: newPath });
          copied++;
        } else {
          kept++;
        }
      } catch (err) {
        console.warn('[reimport] failed', t.filePath, err);
        failed++;
      }
    }
    setImporting(false);
    setImportStatus(
      `Done — ${copied} copied, ${kept} already in library` +
      (failed > 0 ? `, ${failed} failed (check console)` : '')
    );
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Auto-schedule services</div>
        <div className="settings-section-sub">
          When Weekly Pattern mode is set to <strong>Auto rotate</strong>,
          Runway materializes real service entries from your pattern. By
          default it looks ahead 2 days (today + tomorrow). Bump this up
          if you want a longer rolling window. The check-time gates the
          early-morning re-run when the app stays open through midnight —
          set it to e.g. 03:00 so tomorrow's services appear during off
          hours rather than mid-afternoon.
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            columnGap: 14,
            rowGap: 10,
            alignItems: 'center',
            marginTop: 14,
            maxWidth: 520,
          }}
        >
          <label htmlFor="autoScheduleDaysAhead" style={{ color: 'var(--text-dim)' }}>
            Days ahead
          </label>
          <input
            id="autoScheduleDaysAhead"
            type="number"
            min={1}
            max={60}
            value={autoScheduleDaysAhead}
            onChange={e => {
              const n = Math.max(1, Math.min(60, Math.floor(Number(e.target.value) || 1)));
              updateConfig({ defaults: { ...config.defaults, autoScheduleDaysAhead: n } });
            }}
            style={{ maxWidth: 96 }}
          />

          <label htmlFor="autoScheduleTime" style={{ color: 'var(--text-dim)' }}>
            Daily check at
          </label>
          <input
            id="autoScheduleTime"
            type="time"
            value={autoScheduleTime}
            onChange={e => {
              updateConfig({ defaults: { ...config.defaults, autoScheduleTime: e.target.value || '00:00' } });
            }}
            style={{ maxWidth: 160 }}
          />
        </div>

        <div
          style={{
            marginTop: 18,
            padding: 12,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            maxWidth: 520,
          }}
        >
          <div style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)' }}>
            <div style={{ color: 'var(--text)', marginBottom: 2 }}>
              Tombstones: {tombstoneCount}
            </div>
            Tombstones block specific date+time slots from auto-materializing.
            Wipe them all if test-deletions or an accidental "Clear all"
            has stuck. The next materializer pass will refill from the
            weekly pattern.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <button
              className="btn-secondary"
              disabled={tombstoneCount === 0}
              onClick={() => setTombstonesOpen(o => !o)}
            >
              {tombstonesOpen ? 'Hide list' : 'View tombstones'}
            </button>
            <button
              className="btn-secondary"
              disabled={tombstoneCount === 0}
              onClick={() => {
                clearAllTombstones();
                setTombstoneFlash(`Cleared ${tombstoneCount} tombstone${tombstoneCount === 1 ? '' : 's'}`);
                window.setTimeout(() => setTombstoneFlash(null), 3000);
              }}
            >
              Reset all tombstones
            </button>
          </div>
        </div>
        {tombstonesOpen && tombstoneCount > 0 && (
          <div
            style={{
              marginTop: 8,
              padding: '8px 12px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              maxWidth: 520,
              maxHeight: 280,
              overflowY: 'auto',
              fontFamily: 'IBM Plex Mono, monospace',
              fontSize: 12,
              color: 'var(--text-dim)',
            }}
          >
            {[...config.skippedServiceDates]
              .sort((a, b) => a.localeCompare(b))
              .map(slot => {
                const [date, time] = slot.split('|');
                // Resolve the slot back to its weekly-pattern source so we
                // can show the operator the service name + playlist names
                // that would have been materialized. Match by day-of-week
                // and start-time. If the pattern entry has since been
                // deleted/edited, fall back to a "—" label.
                const dow = new Date(date + 'T00:00:00').getDay();
                const pattern = config.weeklyPattern.find(
                  p => p.dayOfWeek === dow && p.startTime === time,
                );
                const prePl = pattern?.preServicePlaylistId
                  ? config.playlists.find(p => p.id === pattern.preServicePlaylistId)?.name
                  : undefined;
                const postPl = pattern?.postServicePlaylistId
                  ? config.playlists.find(p => p.id === pattern.postServicePlaylistId)?.name
                  : undefined;
                const dowLabel = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow];
                return (
                  <div
                    key={slot}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '6px 0',
                      borderBottom: '1px solid var(--border)',
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>
                        <span style={{ color: 'var(--text)' }}>{date}</span>
                        {' · '}
                        <span style={{ color: 'var(--text-dim)' }}>{dowLabel}</span>
                        {' · '}
                        <span>{time}</span>
                        {pattern?.name && (
                          <>
                            {' · '}
                            <span style={{ color: 'var(--text)' }}>{pattern.name}</span>
                          </>
                        )}
                      </div>
                      {(prePl || postPl) && (
                        <div style={{ fontSize: 11, marginTop: 2, color: 'var(--text-faint, #64748b)' }}>
                          {prePl && <>Pre: {prePl}</>}
                          {prePl && postPl && <> · </>}
                          {postPl && <>Post: {postPl}</>}
                        </div>
                      )}
                      {!pattern && (
                        <div style={{ fontSize: 11, marginTop: 2, color: 'var(--text-faint, #64748b)' }}>
                          No matching weekly-pattern entry — slot was set manually or the pattern was edited.
                        </div>
                      )}
                    </div>
                    <button
                      className="btn-secondary"
                      style={{ fontSize: 11, padding: '2px 8px' }}
                      onClick={() => {
                        // Remove this single entry — uses the existing
                        // skippedServiceDates filter pattern; deleting
                        // here just patches the array directly.
                        updateConfig({
                          skippedServiceDates: config.skippedServiceDates.filter(s => s !== slot),
                        });
                      }}
                      title="Remove just this tombstone (the slot will re-create on the next materializer pass)"
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
          </div>
        )}
        {tombstoneFlash && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--accent-bright)' }}>
            {tombstoneFlash}
          </div>
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Library</div>
        <div className="settings-section-sub">
          New imports automatically copy files into a managed folder.
          Consolidate to migrate older tracks that still point at original paths.
        </div>
        {audioDir && (
          <div
            style={{
              marginTop: 12,
              padding: '10px 12px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              fontSize: 12,
              fontFamily: 'IBM Plex Mono, monospace',
              color: 'var(--text-dim)',
              maxWidth: 720,
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                direction: 'rtl',
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                unicodeBidi: 'plaintext',
              }}
              title={audioDir}
            >
              {audioDir}
            </span>
            <button
              className="btn-secondary"
              onClick={() => { void window.runway?.files.revealFolder(audioDir); }}
              style={{ flexShrink: 0 }}
            >
              View in Finder
            </button>
          </div>
        )}
        <button
          className="btn-primary"
          onClick={onReimportAll}
          disabled={importing}
          style={{ width: 'fit-content', marginTop: 12 }}
        >
          {importing ? 'Consolidating…' : 'Consolidate'}
        </button>
        {importStatus && (
          <div className="settings-section-sub" style={{ marginTop: 10, fontSize: 12 }}>
            {importStatus}
          </div>
        )}

        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            cursor: 'pointer',
            maxWidth: 580,
            marginTop: 22,
          }}
        >
          <Toggle
            checked={autoKeyTagOnImport}
            onChange={(next) => updateConfig({
              defaults: { ...config.defaults, autoKeyTagOnImport: next },
            })}
            ariaLabel="Tag keys on import"
          />
          <div>
            <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600 }}>
              Tag keys on import
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
              Newly imported tracks that arrive without a key get looked up on
              MultiTracks.com and tagged with the published original master key.
              Only confident, unambiguous matches are applied — anything the
              catalog lists in more than one key is held for you to review from
              the Library toolbar. Tracks that already carry a key are left alone.
            </div>
          </div>
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Pre-service music</div>
        <div className="settings-section-sub">
          When the playlist is shorter than the auto-start lead time, choose how to fill the gap.
          Either way, music always ends exactly at the right time.
        </div>
        <div className="pl-toggle" style={{ width: 'fit-content' }}>
          <button
            className={`pl-toggle-btn ${repeatToFill ? 'active' : ''}`}
            onClick={() => setRepeatToFill(true)}
          >
            Repeat to fill
          </button>
          <button
            className={`pl-toggle-btn ${!repeatToFill ? 'active' : ''}`}
            onClick={() => setRepeatToFill(false)}
          >
            Start late
          </button>
        </div>
        <div className="settings-section-sub" style={{ marginTop: 8, fontSize: 11 }}>
          {repeatToFill
            ? 'Tracks loop until the lead-time window is filled. Anchor key plays last.'
            : "Music starts late so it ends exactly at service start. Lead time effectively shortens to the playlist's runtime."}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Engine</div>
        <div className="settings-section-sub">
          Audio context settings. Changes take effect after restart.
        </div>
        <div className="settings-grid">
          <div className="settings-field">
            <div className="settings-field-label">Sample rate</div>
            <div className="settings-field-control">
              <span className="settings-field-value">{config.sampleRate} Hz</span>
            </div>
          </div>
          <div className="settings-field">
            <div className="settings-field-label">Buffer size</div>
            <div className="settings-field-control">
              <span className="settings-field-value">{config.bufferSize} samples</span>
              <span className="settings-field-sub">~{(config.bufferSize / config.sampleRate * 1000).toFixed(1)} ms latency</span>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Default fade times</div>
        <div className="settings-section-sub">
          Used when creating new playlists. Existing playlists keep their own settings.
        </div>
        <div className="settings-grid">
          <DefaultsField label="Crossfade" value={config.defaults.crossfadeSec}
                         onChange={v => updateDefault('crossfadeSec', v)} />
          <DefaultsField label="Pad hold" value={config.defaults.padBridgeSec}
                         onChange={v => updateDefault('padBridgeSec', v)} />
          <DefaultsField label="Pad fade out" value={config.defaults.padFadeOutSec}
                         onChange={v => updateDefault('padFadeOutSec', v)} />
          <DefaultsField label="Panic fade" value={config.defaults.panicFadeSec}
                         onChange={v => updateDefault('panicFadeSec', v)} />
          <DefaultsField label="Post-service fade-in" value={config.defaults.postServiceFadeInSec}
                         onChange={v => updateDefault('postServiceFadeInSec', v)} />
          <DefaultsField label="Music start fade-in" value={config.defaults.musicFadeInSec}
                         onChange={v => updateDefault('musicFadeInSec', v)} />
          <DefaultsField label="Auto-start lead time"
                         value={config.defaults.autoStartTargetSec / 60}
                         onChange={v => updateDefault('autoStartTargetSec', v * 60)}
                         unit="min" step={1} max={60} />
        </div>
      </section>

      <BackupSection />
    </>
  );
}

function RemoteSettings() {
  const remote = useAppStore(s => s.config.remote);
  const updateConfig = useAppStore(s => s.updateConfig);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [interfaces, setInterfaces] = useState<Array<{ name: string; address: string }>>([]);

  // Refresh LAN URLs every few seconds — the network can change (Wi-Fi
  // toggle, joining a different SSID) without us being notified. Also
  // re-poll the interface list so the dropdown stays accurate when an
  // operator plugs/unplugs Ethernet or connects a VPN.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      if (!window.runway?.remote?.lanUrls) return;
      const [urlRes, ifaces] = await Promise.all([
        window.runway.remote.lanUrls(),
        window.runway.remote.networkInterfaces?.() ?? Promise.resolve([]),
      ]);
      if (cancelled) return;
      setLanUrls(urlRes.urls);
      setInterfaces(ifaces ?? []);
    };
    void refresh();
    const t = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [remote.port, remote.bindHost]);

  // First-run auto-pick: when the operator hasn't explicitly picked a
  // network interface yet (bindHost is empty/undefined), select the
  // first detected IPv4 once interfaces load, and persist it. The
  // dropdown ends up showing a real IP from the first time this tab
  // opens instead of the abstract "All interfaces" placeholder.
  // Explicit "All interfaces" choice ('0.0.0.0') is respected and
  // never overridden by this effect.
  useEffect(() => {
    if (!interfaces || interfaces.length === 0) return;
    const current = remote.bindHost;
    // undefined / empty string = never picked; let auto-pick fire.
    // '0.0.0.0' = operator explicitly chose all interfaces; leave it.
    if (current !== undefined && current !== '') return;
    const first = interfaces[0];
    if (!first) return;
    updateConfig({ remote: { ...remote, bindHost: first.address } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interfaces.length]);

  // Render a QR for the first LAN URL (whatever interface answers first
  // is what most phones will resolve to).
  useEffect(() => {
    let cancelled = false;
    const target = lanUrls[0];
    if (!target) {
      setQrDataUrl(null);
      return;
    }
    void import('qrcode').then(qr => {
      qr.toDataURL(target, {
        width: 220,
        margin: 1,
        color: { dark: '#e6edf3', light: '#0d1117' },
      }, (err, url) => {
        if (cancelled || err) return;
        setQrDataUrl(url);
      });
    }).catch(() => { /* offline build, no QR */ });
    return () => { cancelled = true; };
  }, [lanUrls]);

  const setPort = (next: number) => {
    const port = Math.max(1024, Math.min(65535, Math.floor(next) || 7811));
    updateConfig({ remote: { ...remote, port } });
  };

  return (
    <>
      <section className="settings-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="settings-section-title">Remote control</div>
          <span
            className="pp-card-status on"
            title="The Runway remote server runs whenever the app is open. No toggle to flip — just open one of the URLs below on the same network."
          >
            <span className="pp-card-status-dot" aria-hidden /> Server on
          </span>
        </div>
        <div className="settings-section-sub" style={{ maxWidth: 580 }}>
          Open one of these URLs on a phone or iPad on the same Wi-Fi to
          see the live timer. Viewing is open to anyone on the network;
          firing actions requires the PIN. The server starts automatically
          whenever Runway runs and stays up until you quit the app.
        </div>

        <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', marginTop: 18, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 320 }}>
            {lanUrls.length === 0 ? (
              <div className="empty-state">
                No LAN-reachable URL detected — is Wi-Fi on?
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {lanUrls.map((u, i) => {
                  const isStable = /\.local:/i.test(u);
                  return (
                    <div key={u} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontFamily: 'IBM Plex Mono, monospace',
                      fontSize: 15,
                      color: isStable ? 'var(--accent-bright)' : 'var(--text-dim)',
                      padding: '6px 10px',
                      background: 'var(--bg-elev)',
                      border: `1px solid ${isStable ? 'var(--accent)' : 'var(--border)'}`,
                      borderRadius: 5,
                      userSelect: 'all',
                      cursor: 'text',
                    }}>
                      <span style={{ flex: 1 }}>{u}</span>
                      {isStable && (
                        <span style={{
                          fontSize: 9,
                          fontFamily: 'inherit',
                          fontWeight: 700,
                          letterSpacing: 0.08,
                          textTransform: 'uppercase',
                          color: 'var(--bg)',
                          background: 'var(--accent-bright)',
                          padding: '2px 6px',
                          borderRadius: 3,
                          flexShrink: 0,
                          userSelect: 'none',
                        }}>STABLE</span>
                      )}
                    </div>
                  );
                })}
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                  The <strong style={{ color: 'var(--accent-bright)' }}>runway.local</strong> URL is published via Bonjour and resolves to whichever Mac is currently running Runway. Bookmark this URL on your phone (or install the PWA from it) and it'll keep working when you switch laptops at a different venue, as long as the phone and the Mac are on the same Wi-Fi.
                </div>
              </div>
            )}

            <div style={{ marginTop: 20, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
                <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
                  Network interface
                </span>
                <select
                  value={remote.bindHost ?? ''}
                  onChange={e => updateConfig({ remote: { ...remote, bindHost: e.target.value } })}
                  style={{
                    fontSize: 13,
                    padding: 6,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    color: 'var(--text)',
                    minWidth: 280,
                  }}
                >
                  <option value="0.0.0.0">All interfaces (any IP)</option>
                  {interfaces.map(i => (
                    <option key={`${i.name}-${i.address}`} value={i.address}>
                      {i.name}: {i.address}
                    </option>
                  ))}
                  {/* If config holds an IP that's no longer present (NIC
                      unplugged, VPN dropped), keep it visible so the user
                      can see what's set instead of silently snapping back
                      to "All interfaces". */}
                  {remote.bindHost &&
                    remote.bindHost !== '' &&
                    remote.bindHost !== '0.0.0.0' &&
                    !interfaces.some(i => i.address === remote.bindHost) && (
                      <option value={remote.bindHost}>
                        (offline) {remote.bindHost}
                      </option>
                    )}
                </select>
                <span style={{ fontSize: 11, color: 'var(--text-faint)', maxWidth: 320 }}>
                  Pick a single Wi-Fi/Ethernet interface if this Mac is on
                  multiple networks (Wi-Fi + Ethernet + VPN). The phone will
                  always reach the server through that one IP, instead of
                  randomly grabbing whichever shows up first.
                </span>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
                  Port
                </span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={remote.port}
                  onChange={e => setPort(+e.target.value)}
                  style={{
                    fontSize: 14,
                    padding: 6,
                    fontFamily: 'IBM Plex Mono, monospace',
                    width: 100,
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    color: 'var(--text)',
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--text-faint)', maxWidth: 200 }}>
                  Default 7811. Only change if another app uses it.
                </span>
              </label>
            </div>
          </div>

          {qrDataUrl && (
            <div style={{
              padding: 12,
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
            }}>
              <img src={qrDataUrl} alt="QR code for remote URL" style={{ width: 220, height: 220, display: 'block' }} />
              <span style={{ fontSize: 11, color: 'var(--text-faint)', letterSpacing: 0.06, textTransform: 'uppercase' }}>
                Scan with Camera
              </span>
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">Security</div>
        <div className="settings-section-sub" style={{ maxWidth: 580 }}>
          The PIN gates remote-control actions (Arm, Panic, Shuffle, Start
          Post-Service, etc.). It does not gate viewing the timer. After
          5 wrong attempts a client is locked out for 30 seconds.
        </div>
        <div style={{ display: 'flex', gap: 24, marginTop: 16, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
              4-digit PIN
            </span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={remote.pin}
              onChange={e => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                updateConfig({ remote: { ...remote, pin: digits } });
              }}
              onBlur={() => {
                // Pad short PINs to 4 digits with zeros so the server has
                // a stable value to compare against.
                if (remote.pin.length < 4) {
                  updateConfig({ remote: { ...remote, pin: remote.pin.padEnd(4, '0') } });
                }
              }}
              style={{
                fontSize: 18,
                padding: '6px 10px',
                fontFamily: 'IBM Plex Mono, monospace',
                letterSpacing: '0.4em',
                width: 100,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text)',
                textAlign: 'center',
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
              Auto-relock idle (sec, 0 = off)
            </span>
            <input
              type="number"
              min={0}
              max={3600}
              value={remote.autoRelockSec}
              onChange={e => {
                const n = Math.max(0, Math.min(3600, +e.target.value || 0));
                updateConfig({ remote: { ...remote, autoRelockSec: n } });
              }}
              style={{
                fontSize: 14,
                padding: 6,
                fontFamily: 'IBM Plex Mono, monospace',
                width: 100,
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text)',
              }}
            />
          </label>
        </div>
      </section>
    </>
  );
}

function BackupSection() {
  const loadConfig = useAppStore(s => s.loadConfig);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const onExport = async () => {
    setBusy('export');
    setStatus(null);
    try {
      const res = await window.runway!.config.export();
      if (res.ok) setStatus({ kind: 'ok', msg: `Exported to ${res.path}` });
      else if (res.reason !== 'Cancelled') setStatus({ kind: 'err', msg: res.reason ?? 'Export failed' });
    } finally {
      setBusy(null);
    }
  };

  const onImport = async () => {
    setBusy('import');
    setStatus(null);
    try {
      const res = await window.runway!.config.import();
      if (res.ok) {
        await loadConfig();
        setStatus({ kind: 'ok', msg: 'Config imported. Tracks with missing audio files will need to be re-imported.' });
      } else if (res.reason !== 'Cancelled') {
        setStatus({ kind: 'err', msg: res.reason ?? 'Import failed' });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Backup &amp; restore</div>
        <div className="settings-section-sub" style={{ maxWidth: 560 }}>
          Export every setting to a JSON file — playlists, services, weekly pattern,
          MIDI bindings, ProPresenter setup, defaults. Audio files aren't included
          and need to be re-imported on the new machine.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-secondary" onClick={onExport} disabled={busy !== null}>
            {busy === 'export' ? 'Exporting…' : 'Export config…'}
          </button>
          <button className="btn-secondary" onClick={onImport} disabled={busy !== null}>
            {busy === 'import' ? 'Importing…' : 'Import config…'}
          </button>
          {status && (
            <span style={{
              fontSize: 12,
              color: status.kind === 'ok' ? 'var(--accent-bright)' : 'var(--red-bright)',
              maxWidth: 420,
            }}>
              {status.msg}
            </span>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title" style={{ color: 'var(--red-bright)' }}>Reset to factory defaults</div>
        <div className="settings-section-sub" style={{ maxWidth: 560 }}>
          Permanently wipes your Runway config — every playlist, service, weekly
          pattern, action sequence, MIDI binding, pad mapping, ProPresenter
          setup, and library track record. Audio files in the internal library
          stay on disk and can be re-imported. Export a backup first if you
          might want any of this back.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button
            className="btn-secondary"
            onClick={() => setResetOpen(true)}
            style={{
              borderColor: 'var(--red, #ef4444)',
              color: 'var(--red-bright, #fb7185)',
            }}
          >
            Reset to factory defaults…
          </button>
        </div>
      </section>

      {resetOpen && (
        <FactoryResetModal
          onClose={() => setResetOpen(false)}
          onExport={onExport}
          exporting={busy === 'export'}
        />
      )}
    </>
  );
}

/**
 * Reset-to-defaults confirmation modal.
 *
 * Three-step funnel:
 *   1. Show what's about to be wiped + offer "Export backup first"
 *   2. Type-to-confirm input (must match the literal phrase
 *      "Erase Everything" — case-sensitive so a glanced-at click can't
 *      sneak through, but operators can read what they're typing)
 *   3. Final destructive button + cancel
 *
 * Reload (via window.location.reload) is the cleanest way to make sure
 * every subscriber re-reads the freshly-defaulted config on the next
 * render cycle — avoids dangling listeners holding old playlists/etc.
 */
function FactoryResetModal({ onClose, onExport, exporting }: {
  onClose: () => void;
  onExport: () => Promise<void>;
  exporting: boolean;
}) {
  const [typed, setTyped] = useState('');
  const [resetting, setResetting] = useState(false);
  const CONFIRM = 'Erase Everything';
  const canReset = typed === CONFIRM && !resetting;

  // Close on Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !resetting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, resetting]);

  const onConfirm = async () => {
    if (!canReset) return;
    setResetting(true);
    try {
      // Write defaults to disk then hard-reload the renderer. We push
      // straight to the main process so the file on disk matches the
      // store before we tear React down.
      await window.runway!.config.set(DEFAULT_CONFIG);
      window.location.reload();
    } catch (err) {
      console.error('[factory-reset] failed', err);
      setResetting(false);
    }
  };

  return (
    <div
      className="key-modal-backdrop"
      onClick={() => { if (!resetting) onClose(); }}
    >
      <div
        className="key-modal"
        onClick={e => e.stopPropagation()}
        style={{ maxWidth: 560, padding: 28 }}
      >
        <div style={{
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--red-bright)',
          marginBottom: 6,
        }}>
          Reset to factory defaults
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.45, marginBottom: 14 }}>
          This permanently deletes every playlist, service, weekly pattern,
          action sequence, MIDI binding, pad mapping, ProPresenter setup, and
          library track record. Cannot be undone. Audio files stay on disk in
          the internal library folder and can be re-imported afterward.
        </div>

        <div style={{
          background: 'rgba(20,184,166,0.06)',
          border: '1px solid rgba(20,184,166,0.3)',
          borderRadius: 6,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}>
          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>
            Want to keep your current config? Export it first — you can
            re-import the JSON later to restore everything.
          </span>
          <button
            className="btn-secondary"
            onClick={() => { void onExport(); }}
            disabled={exporting || resetting}
            style={{ flexShrink: 0 }}
          >
            {exporting ? 'Exporting…' : '↓ Export backup'}
          </button>
        </div>

        <label style={{
          display: 'block',
          fontSize: 12,
          color: 'var(--text-dim)',
          marginBottom: 6,
        }}>
          Type <code style={{
            color: 'var(--red-bright)',
            background: 'rgba(239,68,68,0.08)',
            padding: '1px 6px',
            borderRadius: 3,
            fontFamily: 'IBM Plex Mono, monospace',
            fontSize: 12,
          }}>{CONFIRM}</code> to confirm:
        </label>
        <input
          type="text"
          autoFocus
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={CONFIRM}
          disabled={resetting}
          style={{
            width: '100%',
            background: 'var(--bg-elev-2)',
            border: `1px solid ${typed && typed !== CONFIRM ? 'var(--red, #ef4444)' : 'var(--border-bright)'}`,
            borderRadius: 6,
            color: 'var(--text)',
            padding: '8px 12px',
            fontFamily: 'inherit',
            fontSize: 14,
            marginBottom: 18,
          }}
        />

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            className="btn-secondary"
            onClick={onClose}
            disabled={resetting}
          >
            Cancel
          </button>
          <button
            className="btn-secondary"
            onClick={onConfirm}
            disabled={!canReset}
            style={{
              borderColor: canReset ? 'var(--red, #ef4444)' : undefined,
              color: canReset ? 'var(--red-bright)' : undefined,
              background: canReset ? 'rgba(239,68,68,0.12)' : undefined,
            }}
          >
            {resetting ? 'Resetting…' : 'Reset to factory defaults'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DefaultsField({ label, value, onChange, unit = 's', step = 0.5, max = 30 }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  max?: number;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-label">{label}</div>
      <div className="settings-field-control">
        <span className="settings-field-value">{value.toFixed(unit === 'min' ? 0 : 1)} {unit}</span>
        <div className="pl-stepper">
          <button className="pl-stepper-btn" onClick={() => onChange(Math.max(0, +(value - step).toFixed(1)))}>−</button>
          <button className="pl-stepper-btn" onClick={() => onChange(Math.min(max, +(value + step).toFixed(1)))}>+</button>
        </div>
      </div>
    </div>
  );
}

function DisplaySettings() {
  const ui = useAppStore(s => s.config.ui);
  const updateConfig = useAppStore(s => s.updateConfig);
  const showPlayedTracks = ui?.showPlayedTracks ?? false;

  const setUi = (patch: { showPlayedTracks?: boolean }) => {
    updateConfig({ ui: { ...ui, ...patch } });
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Live runway display</div>
        <div className="settings-section-sub" style={{ maxWidth: 580 }}>
          The runway renders as a horizontal strip of equal-width chips that
          scrolls when there are more tracks than fit. This toggle controls
          whether already-played tracks stay visible.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 18 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              cursor: 'pointer',
              maxWidth: 580,
            }}
          >
            <Toggle
              checked={showPlayedTracks}
              onChange={(next) => setUi({ showPlayedTracks: next })}
              ariaLabel="Show played tracks"
            />
            <div>
              <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600 }}>
                Keep played tracks visible
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 2 }}>
                Already-played chips stay in the runway (dimmed) instead of
                scrolling out of view as the playhead advances. Useful for
                after-service review or when you just want the full picture.
              </div>
            </div>
          </label>
        </div>
      </section>
    </>
  );
}

function AboutSection() {
  return (
    <section className="settings-section">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        <img
          src={runwayIconUrl}
          alt="Runway"
          style={{
            width: 128,
            height: 128,
            flexShrink: 0,
            borderRadius: 28,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
          }}
        />
        <div>
          <div className="settings-section-title">About Runway</div>
          <div className="settings-section-sub" style={{ maxWidth: 560 }}>
            Worship audio control. Schedules pre-service music, fills the time to land
            in the first song's key, bridges with a sustained pad, hands off cleanly to
            live worship. Receives MIDI from ProPresenter and routes through your audio
            interface.
          </div>
          <div style={{ marginTop: 16, fontFamily: 'IBM Plex Mono, monospace', fontSize: 14, color: 'var(--text-faint)' }}>
            v{__APP_VERSION__} · macOS · pre-release
          </div>
          <div style={{ marginTop: 14 }}>
            <button
              type="button"
              onClick={() => { void window.runway?.app?.openChangelog?.(); }}
              style={{
                background: 'transparent',
                color: 'var(--accent-bright)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: 0.04,
                cursor: 'pointer',
              }}
            >
              What's new ↗
            </button>
          </div>
        </div>
      </div>

      <div style={{
        marginTop: 28,
        paddingTop: 18,
        borderTop: '1px solid var(--border)',
        fontSize: 12,
        lineHeight: 1.6,
        color: 'var(--text-faint)',
        maxWidth: 640,
      }}>
        <div style={{ fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6 }}>
          © 2026 jhdev. All rights reserved.
        </div>
        <p style={{ margin: '8px 0' }}>
          The source code, design, and visual assets of this application are
          the property of jhdev and are licensed for use, not sold.
          Unauthorized reproduction, distribution, modification, reverse
          engineering, decompilation, or disassembly of this software, in
          whole or in part, is strictly prohibited.
        </p>
        <p style={{ margin: '8px 0' }}>
          This software is provided "AS IS", without warranty of any kind,
          express or implied, including but not limited to the warranties of
          merchantability, fitness for a particular purpose, and
          non-infringement. In no event shall the author be liable for any
          claim, damages, or other liability, whether in an action of contract,
          tort, or otherwise, arising from, out of, or in connection with the
          software or the use or other dealings in the software.
        </p>
        <p style={{ margin: '8px 0' }}>
          This application is a playback and scheduling tool. It does not
          supply, license, or distribute audio content. The user is solely
          responsible for ensuring they hold the necessary rights, licenses,
          or permissions to import, store, perform, broadcast, or otherwise
          use any audio file or other content played through this software.
          The author makes no representation or warranty regarding the
          licensing status of any content the user provides, and disclaims
          all liability arising from any infringement of third-party
          intellectual property rights, public-performance rights, or any
          applicable streaming, mechanical, or synchronization licenses.
        </p>
        <p style={{ margin: '8px 0' }}>
          ProPresenter is a registered trademark of Renewed Vision, LLC.
          Camelot Wheel® is a trademark of Mixed In Key, LLC. All other
          product names, logos, and brands are property of their respective
          owners and are used for identification purposes only; their use
          does not imply endorsement.
        </p>
        <p style={{ margin: '8px 0' }}>
          This application includes open-source software components used under
          their respective licenses (Electron, React, Zustand, music-metadata,
          and others). License notices are available on request.
        </p>
      </div>
    </section>
  );
}
