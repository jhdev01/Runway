import React, { useEffect, useMemo, useRef, useState } from 'react';
import { waveformScanner, useWaveformScan, allImportedSpotifySongs } from '../lib/spotifyWaveformScan';
import { relearnKeys } from '../lib/keyLearning';
import { useAppStore, generateId } from '../state/store';
import { useEngines } from '../state/engines';
import { ALL_KEYS, MAJOR_KEYS, MINOR_KEYS, keyColor, displayKey } from '@shared/music';
import type { RelinkReport, LibraryBundlePreview, LibraryImportMode, AudioBusConfig, MidiAction, MidiBinding, KeyName, PadFile, ProPresenterSyncConfig, MidiDevicePref, SpotifyStatus, SpotifyPlaylistResult, SpotifyPlaylistList, SpotifyWaveformStatus } from '@shared/types';
import { DEFAULT_CONFIG } from '@shared/types';
import { formatDuration } from '../lib/format';
import type { MidiDeviceSnapshot } from '../lib/midiEngine';
import type { PpTimer } from '../lib/proPresenterClient';
import { PpItemPicker } from '../components/PpItemPicker';
import { runPcoKeySync, type PcoServiceType } from '../lib/planningCenterClient';
import { RotaryKnob } from '../components/RotaryKnob';
import { Toggle } from '../components/Toggle';
import { SpotifyTestRunPanel } from '../components/SpotifyTestRunPanel';
import { SpotifySongList } from '../components/SpotifySongList';
import runwayIconUrl from '../assets/runway-icon.png';
import { InfoTip } from '../components/InfoTip';

type SettingsTab = 'service' | 'audio' | 'pads' | 'library' | 'spotify' | 'propresenter' | 'planningcenter' | 'midi' | 'remote' | 'display' | 'about';

const SETTINGS_NAV: { group: string; items: { id: SettingsTab; label: string }[] }[] = [
  { group: 'Service', items: [
    { id: 'service', label: 'Service timing' },
    { id: 'audio', label: 'Audio' },
    { id: 'pads', label: 'Pads' },
  ] },
  { group: 'Music', items: [
    { id: 'library', label: 'Library' },
    { id: 'spotify', label: 'Spotify' },
  ] },
  { group: 'Connections', items: [
    { id: 'propresenter', label: 'ProPresenter' },
    { id: 'planningcenter', label: 'Planning Center' },
    { id: 'midi', label: 'MIDI' },
    { id: 'remote', label: 'Phone remote' },
  ] },
  { group: 'App', items: [
    { id: 'display', label: 'Display' },
    { id: 'about', label: 'Backup & about' },
  ] },
];

const SETTINGS_SUB: Record<SettingsTab, string> = {
  service: 'When pre-service music starts, how it fades, and when services get set up.',
  audio: 'Where the music and pad play out, and how loud.',
  pads: 'One looping pad per key, to bridge into the service.',
  library: 'Where your songs live and how new ones come in.',
  spotify: 'Play Spotify playlists as service music on this computer.',
  propresenter: 'Countdown timer and slide cues in ProPresenter.',
  planningcenter: 'Song keys and service times from Planning Center.',
  midi: 'Controllers and cues that trigger Runway.',
  remote: 'Run Runway from a phone on the same network.',
  display: 'How the Live page looks.',
  about: 'Version, timing log, and backing up your setup.',
};

/** Rarely touched settings, folded away until asked for. */
function Advanced({ children }: { children: React.ReactNode }) {
  return (
    <details className="settings-advanced">
      <summary>Advanced</summary>
      <div className="settings-advanced-body">{children}</div>
    </details>
  );
}

export function SettingsView() {
  const [tab, setTab] = useState<SettingsTab>('service');
  const consumePendingSettingsTab = useAppStore(s => s.consumePendingSettingsTab);
  const pendingSettingsTab = useAppStore(s => s.pendingSettingsTab);

  useEffect(() => {
    const next = consumePendingSettingsTab();
    if (next) setTab(next);
  }, [pendingSettingsTab, consumePendingSettingsTab]);

  const title = SETTINGS_NAV.flatMap(g => g.items).find(i => i.id === tab)?.label ?? 'Settings';

  return (
    <div className="settings-view">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title">Settings</div>
        {SETTINGS_NAV.map(g => (
          <div key={g.group} className="settings-nav-group">
            <div className="settings-nav-group-label">{g.group}</div>
            {g.items.map(item => (
              <button
                key={item.id}
                className={`settings-nav-item ${tab === item.id ? 'active' : ''}`}
                aria-current={tab === item.id ? 'page' : undefined}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-content">
        <div className="settings-page">
          <h1 className="settings-page-title">{title}</h1>
          <p className="settings-page-sub">{SETTINGS_SUB[tab]}</p>
          {tab === 'service' && <EngineSettings parts={['preservice', 'fades', 'autoschedule']} />}
          {tab === 'audio' && (
            <>
              <AudioSettings />
              <PadSettings parts={['output']} />
              <Advanced><EngineSettings parts={['engine']} /></Advanced>
            </>
          )}
          {tab === 'pads' && <PadSettings parts={['library']} />}
          {tab === 'library' && <EngineSettings parts={['library']} />}
          {tab === 'spotify' && <><SpotifyAccountSection /><Advanced><SpotifyTimingTestSection /></Advanced></>}
          {tab === 'propresenter' && <ProPresenterSettings />}
          {tab === 'planningcenter' && <PlanningCenterSettings />}
          {tab === 'midi' && <MidiSettings />}
          {tab === 'remote' && <RemoteSettings />}
          {tab === 'display' && <DisplaySettings parts={['runway']} />}
          {tab === 'about' && (
            <>
              <AboutSection />
              <EngineSettings parts={['timinglog']} />
              <DisplaySettings parts={['dev']} />
              <BackupSection />
            </>
          )}
        </div>
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
            ? 'No output devices found. Allow microphone access for Runway in macOS Privacy settings so it can list them.'
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
        <div className="settings-section-title">Bus routing<InfoTip>Send each bus to its own stereo output. To use other channel pairs on a multi-channel interface (e.g. MOTU outs 3-4 or 5-6), make an Aggregate Device for each pair in macOS Audio MIDI Setup. Each one then shows up here as its own device.</InfoTip></div>

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
                title="Outputs 1-2 only. For other pairs, use an Aggregate Device."
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
  { id: 'pad_play', label: 'Pad: Play', action: 'pad_play' },
  { id: 'pad_stop', label: 'Pad: Stop', action: 'pad_stop' },
  { id: 'add_song', label: 'Add a song (fill to start)', action: 'add_song' },
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
      label: `Pad set key: ${k}`,
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
      <div className="set-cards-2 midi-top">
      <section className="settings-section set-card">
        <div className="settings-section-title">Devices<InfoTip>Choose which devices Runway listens to (In) and sends to (Out). A device with In off is ignored: it won't show in the activity log or trigger anything. Turn one off if it floods Runway with messages. New devices start with both on.</InfoTip></div>
        {(() => {
          const row = (d: MidiDeviceSnapshot) => (
            <MidiDeviceRow
              key={d.name}
              device={d}
              onToggleInput={(v) => setDevicePref(d.name, d.manufacturer, { inputEnabled: v })}
              onToggleOutput={(v) => setDevicePref(d.name, d.manufacturer, { outputEnabled: v })}
              onToggleBoth={(v) => setBothDirections(d.name, d.manufacturer, v)}
              onForget={!d.connected ? () => clearDevicePref(d.name) : undefined}
            />
          );
          const live = devices.filter(d => d.connected);
          const gone = devices.filter(d => !d.connected);
          return (
            <>
              {live.length === 0
                ? <div className="set-card-note">No MIDI devices connected. Plug in a controller, or turn on an IAC bus or network session in Audio MIDI Setup.</div>
                : <div className="midi-devs">{live.map(row)}</div>}
              {gone.length > 0 && (
                <details className="midi-gone">
                  <summary>Not connected right now ({gone.length})</summary>
                  <div className="midi-devs">{gone.map(row)}</div>
                </details>
              )}
            </>
          );
        })()}
      </section>

      <section className="settings-section set-card">
        <div className="settings-section-title">Activity<InfoTip>Every incoming MIDI message, newest first. Use it to check that your controller reaches Runway and to see which note or CC each button sends.</InfoTip></div>
        <MidiActivityLog />
      </section>
      </div>

      <section className="settings-section">
        <div className="settings-section-title">Quick assign<InfoTip>Click Learn next to an action, then press the button or key on your MIDI controller. Runway captures the channel and note (or CC) and assigns it to that action.</InfoTip></div>

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
                <InfoTip>One per key that has a pad file. Sets which key the pad player is ready on.</InfoTip>
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
      setTestStatus({ kind: 'ok', msg: res.version ? `Connected to ProPresenter ${res.version}` : 'Connected' });
      // Re-send the countdown to PP if a pre-service runway is rolling.
      window.dispatchEvent(new Event('runway:pp-resync'));
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

  const connHeadline =
    ppStatus === 'ok' ? 'Connected to ProPresenter' :
    ppStatus === 'err' ? 'Can’t reach ProPresenter' :
    ppStatus === 'unknown' ? 'Checking ProPresenter…' :
    'ProPresenter sync is off';
  const timerMissing = !!cfg.timerUuid && !timers.some(t => t.uuid === cfg.timerUuid);

  return (
    <>
      <section className={`settings-section pp-conn ${connDotClass}`}>
        <div className="pp-conn-head">
          <span className="pp-conn-dot" aria-hidden />
          <div className="pp-conn-text">
            <div className="pp-conn-title">{connHeadline}</div>
            <div className="pp-conn-sub">
              {testStatus.kind === 'ok' ? testStatus.msg
                : testStatus.kind === 'err' ? testStatus.msg
                : `${cfg.host || 'localhost'} · port ${cfg.port}`}
            </div>
          </div>
          <button className={ppStatus === 'ok' ? 'btn-secondary' : 'btn-primary'} onClick={onTest} disabled={testStatus.kind === 'busy'}>
            {testStatus.kind === 'busy' ? 'Testing…' : ppStatus === 'ok' ? 'Test again' : ppStatus === 'err' ? 'Try again' : 'Test connection'}
          </button>
        </div>
        <div className="pp-conn-grid">
          <div className="pp-field">
            <label className="pp-label">Computer</label>
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
        </div>
        {ppStatus !== 'ok' && (
          <div className="pp-conn-help">
            Is ProPresenter open? In ProPresenter on {cfg.host && cfg.host !== 'localhost' && cfg.host !== '127.0.0.1' ? 'that computer' : 'this Mac'}: Settings › Network › turn on <strong>Enable Network</strong>, and use the port shown there.
          </div>
        )}
      </section>

      <div className="set-cards-2 pp-cards">
        <section className="settings-section set-card">
          <div className="settings-section-title">Countdown<InfoTip>When you arm a service, Runway sets this ProPresenter timer to count down to service start, and keeps it running while pre-service music plays.</InfoTip></div>
          <SettingRow
            label="Timer"
            sub={timerMissing ? 'Not found in ProPresenter right now' : 'The ProPresenter timer Runway counts down'}
            control={
              <select
                className="pp-timer-select"
                value={cfg.timerUuid ?? ''}
                onChange={e => onPickTimer(e.target.value)}
              >
                <option value="">{timers.length === 0 ? 'Connect to load timers' : 'Choose a timer'}</option>
                {timers.map(t => (
                  <option key={t.uuid} value={t.uuid}>{t.name}</option>
                ))}
                {cfg.timerUuid && cfg.timerName && timerMissing && (
                  <option value={cfg.timerUuid}>{cfg.timerName}</option>
                )}
              </select>
            }
          />
          <SettingRow
            label="Count down to service start"
            sub={!cfg.timerUuid ? 'Pick a timer first' : cfg.enabled ? 'On for every armed service' : 'Off: ProPresenter isn’t touched'}
            control={
              <Toggle
                checked={cfg.enabled}
                disabled={!cfg.timerUuid}
                ariaLabel="Count down to service start in ProPresenter"
                onChange={v => update({ enabled: v })}
              />
            }
          />
        </section>
        <section className="settings-section set-card">
          <div className="settings-section-title">How it works</div>
          <div className="pp-explain">
            <div><span className="pp-explain-dot music" />Music starts: optional slide cue</div>
            <div><span className="pp-explain-dot timer" />Countdown runs to service start</div>
            <div><span className="pp-explain-dot service" />0:00: optional slide cue (e.g. Welcome)</div>
            <div><span className="pp-explain-dot post" />Post-service and disarm cues below</div>
          </div>
        </section>
      </div>

      <section className="settings-section">
      <div className="settings-section-title">Slide cues<InfoTip>Each moment can trigger a ProPresenter playlist item or clear ProPresenter. Turn on Network in ProPresenter under <em>Settings → Network</em>.</InfoTip></div>
      {/* Hooks — each gets its own colored card so the operator can scan
          the four moments at a glance. Functionality is identical to the
          old flat layout. */}
      <div className="pp-cues" role="table" aria-label="Slide cues">
        <div className="pp-cue-head" role="row">
          <span role="columnheader">Moment</span><span role="columnheader">Action</span><span role="columnheader">Playlist</span><span role="columnheader">Item</span>
        </div>
        <HookCard
          hook="musicStart" label="When music starts" short="Pre-service music begins" icon="♪" tone="music"
          description="When pre-service music begins."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.musicStart} busy={busyByHook.musicStart}
          loadItems={loadItemsForHook}
        />
        <HookCard
          hook="serviceStart" label="When service starts" short="Countdown hits 0:00" icon="▶" tone="service"
          description="When the countdown reaches 0:00 at the scheduled service start."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.serviceStart} busy={busyByHook.serviceStart}
          loadItems={loadItemsForHook}
        />
        <HookCard
          hook="postServiceStart" label="When post-service starts" short="Start Post-Service pressed" icon="✦" tone="post"
          description="When Start Post-Service is pressed. The timer is not touched."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.postServiceStart} busy={busyByHook.postServiceStart}
          loadItems={loadItemsForHook}
        />
        <HookCard
          hook="disarm" label="When disarmed" short="Stop All or Disarm before start" icon="◯" tone="disarm"
          description="When you press Stop All or Disarm before service start. Choose 'Do nothing' to leave the ProPresenter timer running."
          cfg={cfg} update={update}
          playlists={playlists}
          items={itemsByHook.disarm} busy={busyByHook.disarm}
          loadItems={loadItemsForHook}
        />
      </div>
      </section>
    </>
  );
}

interface HookCardProps {
  hook: HookKey;
  label: string;
  description: string;
  short: string;
  icon: string;
  tone: 'music' | 'service' | 'post' | 'disarm';
  cfg: ProPresenterSyncConfig;
  update: (patch: Partial<ProPresenterSyncConfig>) => void;
  playlists: PpTimer[];
  items: PpTimer[];
  busy: boolean;
  loadItems: (hook: HookKey, playlistUuid: string | null) => Promise<void>;
}

function HookCard({ hook, label, description, short, icon, tone, cfg, update, playlists, items, busy, loadItems }: HookCardProps) {
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
    <div className={`pp-cue tone-${tone} ${inactive ? 'inactive' : ''}`} role="row">
      <div className="pp-cue-moment" title={description} role="cell">
        <span className="pp-cue-icon" aria-hidden>{icon}</span>
        <div className="pp-cue-text">
          <div className="pp-cue-title">{label}</div>
          <div className="pp-cue-sub">{short}</div>
        </div>
      </div>
      <select
        role="cell"
        aria-label={`${label}: action`}
        value={action}
        onChange={e => update({ [k.action]: e.target.value } as Partial<ProPresenterSyncConfig>)}
      >
        <option value="none">Do nothing</option>
        <option value="clear_timer">Clear PP timer only</option>
        <option value="clear_all">Clear all PP layers</option>
        <option value="trigger_item">Trigger playlist item</option>
      </select>
      {action === 'trigger_item' ? (
        <>
          <select
            role="cell"
            aria-label={`${label}: ProPresenter playlist`}
            value={playlistUuid ?? ''}
            onChange={e => onPickPlaylist(e.target.value)}
          >
            <option value="">{playlists.length === 0 ? 'Connect to load playlists' : 'Choose a playlist'}</option>
            {playlists.map(p => (
              <option key={p.uuid} value={p.uuid}>{p.name}</option>
            ))}
            {playlistUuid && playlistName && !playlists.some(p => p.uuid === playlistUuid) && (
              <option value={playlistUuid}>{playlistName} (not found)</option>
            )}
          </select>
          <div className="pp-cue-item" role="cell">
            <PpItemPicker
              items={items}
              value={itemIndex !== null ? String(itemIndex) : ''}
              onChange={onPickItem}
              disabled={!playlistUuid || busy}
              placeholder={!playlistUuid ? 'Choose a playlist first'
                : busy ? 'Loading items…'
                : items.length === 0 ? 'No items in this playlist'
                : 'Choose an item'}
              savedIndex={itemIndex}
              savedName={itemName}
            />
          </div>
        </>
      ) : <span className="pp-cue-none" role="cell"></span>}
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
    <div className={`midi-dev ${dim ? 'gone' : ''} ${isLive ? 'live' : ''}`}>
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
          filter: isLive ? 'drop-shadow(0 0 4px rgba(0, 122, 209,  0.45))' : 'none',
          transition: 'color 0.15s ease, filter 0.15s ease',
          cursor: device.connected ? 'pointer' : 'default',
        }}
        title={
          !device.connected
            ? 'Disconnected'
            : isLive
              ? 'On. Click to turn off input and output.'
              : 'Off. Click to turn on input and output.'
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
        </div>
        <div className="device-meta">{device.manufacturer || 'Unknown manufacturer'}</div>
      </div>
      {device.connected && (
        <div className="midi-dirs">
          <button
            type="button"
            className={`midi-dir ${device.inputEnabled ? 'on' : ''}`}
            aria-pressed={device.inputEnabled}
            disabled={!device.hasInput}
            onClick={() => onToggleInput(!device.inputEnabled)}
            title={device.hasInput ? 'Listen to incoming MIDI from this device' : 'No input port on this device'}
          >In</button>
          <button
            type="button"
            className={`midi-dir ${device.outputEnabled ? 'on' : ''}`}
            aria-pressed={device.outputEnabled}
            disabled={!device.hasOutput}
            onClick={() => onToggleOutput(!device.outputEnabled)}
            title={device.hasOutput ? 'Allow outgoing MIDI to this device' : 'No output port on this device'}
          >Out</button>
        </div>
      )}
      {device.connected && <button
        className="btn-secondary"
        onClick={sendTestNote}
        disabled={!device.connected || !device.hasOutput || !device.outputEnabled}
        style={{
          padding: '4px 10px',
          fontSize: 12,
          background: testFlash ? 'rgba(0, 122, 209,  0.25)' : undefined,
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
                ? 'Turn output on first'
                : 'Send C4 / channel 1 (200ms) to verify the wiring downstream'
        }
      >
        Test
      </button>}
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

type PadPart = 'output' | 'library';
function PadSettings({ parts }: { parts: PadPart[] }) {
  const show = (p: PadPart) => parts.includes(p);
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
      {show('output') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Pad player output<InfoTip>Volume sets the pad level against the music. Gain boosts quiet pad files or turns down loud ones. Both apply to every pad.</InfoTip></div>
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
              <InfoTip>Drag up/down to turn (Shift = snap to whole dB). Double-click or scroll to fine-tune. Range −24 dB to +12 dB.</InfoTip>
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
          <InfoTip>Changes how keys are shown, not your files. Match how your pad files and songs are named.</InfoTip>
        </div>
      </section>
      </>)}

    {show('library') && (<>
    <section className="settings-section">
      <div className="settings-section-title">Pad library<InfoTip>Assign one looping pad file per key, or use Scan to load a folder of files named after their keys (A.wav, C#.wav, etc.). Scan in the Major section maps plain-letter files (A.wav, B.wav) as major; Scan in Minor maps them as minor. The other section is left alone.</InfoTip></div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button
          className="btn-secondary"
          onClick={() => void onConsolidatePads()}
          disabled={consolidate.kind === 'busy' || pads.length === 0}
          title="Copy pad files stored elsewhere into Runway's pad folder, so they keep working if the originals move."
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
    </>)}
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
                {pad?.filePath ? pad.filePath.split('/').pop() : 'Click to assign'}
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

type EnginePart = 'autoschedule' | 'library' | 'preservice' | 'engine' | 'timinglog' | 'fades';
function EngineSettings({ parts }: { parts: EnginePart[] }) {
  const show = (p: EnginePart) => parts.includes(p);
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
      `Done: ${copied} copied, ${kept} already in library` +
      (failed > 0 ? `, ${failed} failed` : '')
    );
  };

  return (
    <>

      {show('library') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Library<InfoTip>New imports are copied into Runway's library folder. Consolidate copies in older songs that still play from their original location.</InfoTip></div>
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
        <SettingRow
          label="Consolidate songs"
          sub="Copy older songs that still play from their original location into the library folder"
          control={
            <button className="btn-secondary" onClick={onReimportAll} disabled={importing}>
              {importing ? 'Consolidating…' : 'Consolidate'}
            </button>
          }
        />
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
            <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
              Tag keys on import
              <InfoTip>Newly imported tracks that arrive without a key get looked up on MultiTracks.com and tagged with the published original master key. Only confident, unambiguous matches are applied. Anything the catalog lists in more than one key is held for you to review from the Library toolbar. Tracks that already carry a key are left alone.</InfoTip>
            </div>
          </div>
        </label>
      </section>
      </>)}

      {show('preservice') && !show('fades') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Pre-service music<InfoTip><p>When a playlist is shorter than the auto-start lead time:</p><p><strong>Repeat to fill</strong>: songs repeat to fill the time. The song in the service key plays last.</p><p><strong>Start late</strong>: the playlist plays once and music starts later.</p><p>Either way, music ends at service start.</p></InfoTip></div>
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
      </section>
      </>)}

      {show('engine') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Audio engine<InfoTip>Changes apply after you restart Runway.</InfoTip></div>
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
      </>)}
      {show('timinglog') && (
      <section className="settings-section">
        <div className="settings-section-title">Diagnostics</div>
        <div className="settings-grid">
          <div className="settings-field">
            <div className="settings-field-label" style={{ display: 'flex', alignItems: 'center' }}>Service timing log<InfoTip>Records each service's arm, landing and pad handoff to a file you can review afterward.</InfoTip></div>
            <div className="settings-field-control">
              <button
                className="btn-secondary"
                onClick={() => { void window.runway?.diagnostics?.revealTimingLog(); }}
                style={{ width: 'fit-content' }}
              >
                Open timing log
              </button>
            </div>
          </div>
        </div>
      </section>
      )}

      {show('fades') && (<>
      <div className="set-cards-2">
        <section className="settings-section set-card">
          <div className="settings-section-title">Timing<InfoTip>Defaults for new services and playlists. Existing playlists keep their own settings.</InfoTip></div>
          <StepRow label="Music starts before service" sub="Default for new services" unit="min" step={1} max={60}
                   value={config.defaults.autoStartTargetSec / 60} onChange={v => updateDefault('autoStartTargetSec', v * 60)} />
          <StepRow label="Pad hold" sub="Pad keeps playing into the service" value={config.defaults.padBridgeSec}
                   onChange={v => updateDefault('padBridgeSec', v)} />
          <SettingRow
            label="Short playlists"
            sub={repeatToFill ? 'Songs repeat to fill the time; the song in the service key plays last' : 'The playlist plays once and music starts later'}
            tip={<><p>When a playlist is shorter than the time before the service:</p><p><strong>Repeat to fill</strong>: songs repeat to fill the time. The song in the service key plays last.</p><p><strong>Start late</strong>: the playlist plays once and music starts later.</p><p>Either way, music ends at service start.</p></>}
            control={
              <div className="set-seg" role="radiogroup" aria-label="Short playlists">
                <button type="button" role="radio" aria-checked={repeatToFill} className={repeatToFill ? 'on' : ''} onClick={() => setRepeatToFill(true)}>Repeat to fill</button>
                <button type="button" role="radio" aria-checked={!repeatToFill} className={!repeatToFill ? 'on' : ''} onClick={() => setRepeatToFill(false)}>Start late</button>
              </div>
            }
          />
        </section>
        <section className="settings-section set-card">
          <div className="settings-section-title">Fades<InfoTip>Used when creating new playlists. Existing playlists keep their own settings.</InfoTip></div>
          <StepRow label="Song crossfade" sub="Between songs in a runway" value={config.defaults.crossfadeSec}
                   onChange={v => updateDefault('crossfadeSec', v)} />
          <StepRow label="First song fade-in" sub="When the music starts" value={config.defaults.musicFadeInSec}
                   onChange={v => updateDefault('musicFadeInSec', v)} />
          <StepRow label="Pad fade out" sub="After the pad hold" value={config.defaults.padFadeOutSec}
                   onChange={v => updateDefault('padFadeOutSec', v)} />
          <StepRow label="Post-service fade-in" sub="Start Post-Service" value={config.defaults.postServiceFadeInSec}
                   onChange={v => updateDefault('postServiceFadeInSec', v)} />
          <StepRow label="Panic fade" sub="Fade everything out" value={config.defaults.panicFadeSec}
                   onChange={v => updateDefault('panicFadeSec', v)} />
        </section>
      </div>
      <section className="settings-section set-explain">
        <div className="settings-section-title">What this means</div>
        <div className="set-explain-bar" aria-hidden>
          <span className="music">Music {Math.round(config.defaults.autoStartTargetSec / 60)}:00</span>
          <span className="pad">Pad</span>
          <span className="service">Service</span>
        </div>
        <div className="set-card-note">
          Music starts {Math.round(config.defaults.autoStartTargetSec / 60)} minutes before the service, fading in over {fmtSec(config.defaults.musicFadeInSec)}, with
          {' '}{fmtSec(config.defaults.crossfadeSec)} crossfades between songs, and ends right at service start. The pad holds
          {' '}{fmtSec(config.defaults.padBridgeSec)} into the service, then fades over {fmtSec(config.defaults.padFadeOutSec)}.
        </div>
      </section>
      </>)}
      {show('autoschedule') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Auto-schedule services<InfoTip>When the weekly pattern is set to <strong>Auto rotate</strong>, Runway adds services from it to the schedule. Days ahead sets how far out (2 = today and tomorrow). If Runway stays open overnight, it adds the next day's services at the daily check time, e.g. 03:00.</InfoTip></div>
        <SettingRow
          label="Days ahead"
          sub="How far out Runway adds services (2 = today and tomorrow)"
          control={
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
              style={{ width: 90 }}
            />
          }
        />
        <SettingRow
          label="Daily check at"
          sub="If Runway stays open overnight, it adds the next day’s services then"
          control={
            <input
              id="autoScheduleTime"
              type="time"
              value={autoScheduleTime}
              onChange={e => {
                updateConfig({ defaults: { ...config.defaults, autoScheduleTime: e.target.value || '00:00' } });
              }}
              style={{ width: 140 }}
            />
          }
        />
        <div
          style={{
            marginTop: 10,
            padding: 14,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
          }}
        >
          <div style={{ flex: 1, fontSize: 12, color: 'var(--text-dim)' }}>
            <div style={{ color: 'var(--text)', marginBottom: 2 }}>
              Blocked time slots: {tombstoneCount}
              <InfoTip>When you delete an auto-scheduled service, its time slot is blocked so it doesn't come back. Unblock all if you deleted services by mistake (or pressed Clear all). They return on the next daily check.</InfoTip>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
            <button
              className="btn-secondary"
              disabled={tombstoneCount === 0}
              onClick={() => setTombstonesOpen(o => !o)}
            >
              {tombstonesOpen ? 'Hide list' : 'View blocked slots'}
            </button>
            <button
              className="btn-secondary"
              disabled={tombstoneCount === 0}
              onClick={() => {
                clearAllTombstones();
                setTombstoneFlash(`Unblocked ${tombstoneCount} slot${tombstoneCount === 1 ? '' : 's'}`);
                window.setTimeout(() => setTombstoneFlash(null), 3000);
              }}
            >
              Unblock all
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
                          Not in the weekly pattern. Added by hand, or the pattern changed.
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
                      title="Unblock this slot. The service returns on the next daily check."
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
      </>)}

    </>
  );
}

// Lets Runway close Spotify's window before each song so it never flashes
// on screen. macOS requires Runway to be allowed under Accessibility.
/** One settings row (new look): label and a short line on the left, the control on the right. */
function SettingRow({ label, sub, tip, control, children }: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  tip?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-main">
        <div className="set-row-text">
          <div className="set-row-label">{label}{tip && <InfoTip>{tip}</InfoTip>}</div>
          {sub && <div className="set-row-sub">{sub}</div>}
        </div>
        {control && <div className="set-row-control">{control}</div>}
      </div>
      {children}
    </div>
  );
}

function SpotifyWindowPermission() {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const check = (prompt: boolean) =>
    window.runway?.spotify?.player({ op: 'accessibility', prompt })
      .then(r => setAllowed(!!r.accessibilityAllowed))
      .catch(() => setAllowed(false));
  useEffect(() => { void check(false); }, []);
  // After the prompt, the operator flips the switch in System Settings;
  // re-check when they come back to Runway.
  useEffect(() => {
    const onFocus = () => { void check(false); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  if (allowed === null) return null;
  return (
    <SettingRow
      label="Keep Spotify’s window hidden"
      sub={allowed ? 'Runway closes Spotify’s window before each song, so it doesn’t flash on screen.' : 'Spotify may flash on screen when songs change.'}
      tip={<>Let Runway close Spotify’s window so it doesn’t flash on screen. Allow it in System Settings › Privacy &amp; Security › Accessibility.</>}
      control={allowed
        ? <span className="set-pill ok">Allowed</span>
        : <button className="btn-secondary" onClick={() => void check(true)}>Allow…</button>}
    />
  );
}

// Key learning status: Runway re-learns its key detector's settings from
// the operator's own tags in the background (lib/keyLearning.ts).
function KeyLearningStatus() {
  const kl = useAppStore(s => s.config.keyLearning);
  const updateConfig = useAppStore(s => s.updateConfig);
  const [busy, setBusy] = useState(false);
  const text = !kl
    ? 'Runway hasn’t learned from your songs yet.'
    : kl.examples < 20
      ? `Learning from your tagged songs: ${kl.examples} so far. It starts once there are 20 that Runway has also listened to (Spotify songs it has heard, or Library songs run through Detect keys).`
      : kl.adopted
        ? `Using settings learned from ${kl.examples} of your songs. On songs it didn’t learn from, it now gets ${kl.after} right (standard settings: ${kl.before}).`
        : `Checked against ${kl.examples} of your songs: the standard settings do as well (${kl.before}), so they’re still in use.`;
  return (
    <SettingRow
      label="Key learning"
      sub={text}
      tip="Keys you set or fix yourself teach Runway’s key detection. It re-checks on its own and only switches when it clearly gets more right."
      control={
        <div className="set-row-buttons">
          {kl?.adopted && (
            <button className="btn-secondary" onClick={() => updateConfig({ keyLearning: { ...kl, adopted: false } })}>Use standard</button>
          )}
          <button className="btn-secondary" disabled={busy} onClick={async () => { setBusy(true); try { await relearnKeys(); } finally { setBusy(false); } }}>
            {busy ? 'Learning…' : 'Learn now'}
          </button>
        </div>
      }
    />
  );
}

// Draw waveforms of Spotify songs (Mac): Runway listens to the Spotify app's
// loudness as songs play (never the sound itself) and draws it in the song
// editor. macOS asks for Screen & System Audio Recording permission first.
function useSpotifyWaveformStatus() {
  const [st, setSt] = useState<SpotifyWaveformStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => window.runway?.spotify?.waveformStatus?.().then(x => { if (alive) setSt(x); }).catch(() => undefined);
    void read();
    const t = window.setInterval(read, 2000);
    return () => { alive = false; window.clearInterval(t); };
  }, []);
  return st;
}

function SpotifyWaveformToggleRow() {
  const on = useAppStore(s => !!s.config.spotify?.waveforms);
  const updateConfig = useAppStore(s => s.updateConfig);
  const st = useSpotifyWaveformStatus();
  if (st && st.tap === 'unavailable' && !on) {
    return <SettingRow label="Draw waveforms while songs play" sub={st.reason ?? 'Not available on this computer.'} />;
  }
  const status = !on ? 'Needs a one-time macOS permission'
    : st?.tap === 'on' ? 'Listening to Spotify. Songs get a waveform as they play through.'
    : st?.tap === 'denied' || st?.tap === 'error' || st?.tap === 'unavailable' ? (st.reason ?? 'Couldn’t listen to Spotify.')
    : 'On. Starts listening when Spotify plays.';
  const bad = on && (st?.tap === 'denied' || st?.tap === 'error' || st?.tap === 'unavailable');
  return (
    <SettingRow
      label="Draw waveforms while songs play"
      sub={<span className={bad ? 'set-row-err' : undefined}>{status}</span>}
      tip={<>Runway listens to how loud Spotify is as each song plays (never the sound itself, nothing is recorded) and draws the song’s waveform in its Edit panel. A song needs to play through once. macOS asks you to allow Runway under Screen &amp; System Audio Recording; Runway only listens to Spotify, never your screen.</>}
      control={
        <Toggle
          checked={on}
          ariaLabel="Draw waveforms of Spotify songs"
          onChange={v => {
            const latest = useAppStore.getState().config.spotify;
            updateConfig({ spotify: { ...latest, waveforms: v } });
          }}
        />
      }
    />
  );
}

const SCAN_DONE_AT = 0.95; // matches the scanner: a song counts as scanned at this coverage

function SpotifyScanCard() {
  const on = useAppStore(s => !!s.config.spotify?.waveforms);
  const updateConfig = useAppStore(s => s.updateConfig);
  const playlistCache = useAppStore(s => s.config.spotify?.playlistCache);
  const scan = useWaveformScan();
  const scanMode = useAppStore(s => s.config.spotify?.waveformScan ?? 'edges');
  const scanSec = useAppStore(s => s.config.spotify?.waveformScanSec ?? 30);
  const [custom, setCustom] = useState(false);
  const scanChoice = scanMode === 'whole' ? 'whole' : (custom || ![10, 20, 30].includes(scanSec)) ? 'custom' : String(scanSec);
  const songs = useMemo(() => allImportedSpotifySongs(), [playlistCache]);
  const [done, setDone] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const uris = [...new Set(songs.map(t => t.uri))];
    const read = async () => {
      if (uris.length === 0) { if (alive) setDone(0); return; }
      try {
        const edges = scanMode === 'whole' ? undefined : scanSec;
        const [cov, keys] = await Promise.all([
          window.runway.spotify.waveformCoverage(uris, edges),
          window.runway.spotify.waveformKeys(uris).catch(() => ({} as Record<string, unknown>)),
        ]);
        if (alive) setDone(uris.filter(u => (cov?.[u] ?? 0) >= SCAN_DONE_AT && keys?.[u]).length);
      } catch { /* keep the last count */ }
    };
    void read();
    const t = window.setInterval(read, scan.running ? 4000 : 15000);
    return () => { alive = false; window.clearInterval(t); };
  }, [songs, scan.running, scanMode, scanSec]);

  const total = new Set(songs.map(t => t.uri)).size;
  const missing = done === null ? null : Math.max(0, total - done);
  const pct = total > 0 && done !== null ? Math.round((done / total) * 100) : 0;
  const setChoice = (v: string) => {
    const latest = useAppStore.getState().config.spotify;
    if (v === 'whole') updateConfig({ spotify: { ...latest, waveformScan: 'whole' } });
    else if (v === 'custom') { setCustom(true); updateConfig({ spotify: { ...latest, waveformScan: 'edges' } }); }
    else { setCustom(false); updateConfig({ spotify: { ...latest, waveformScan: 'edges', waveformScanSec: Number(v) } }); }
  };
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  return (
    <section className="settings-section set-card">
      <div className="settings-section-title">Waveforms &amp; keys</div>
      <div className="set-scan-count">
        <strong>{done ?? '–'} / {total}</strong>
        <span>songs scanned</span>
      </div>
      <div className="set-scan-bar" aria-hidden><span style={{ width: `${pct}%` }} /></div>
      {!on ? (
        <div className="set-card-note">Turn on <strong>Draw waveforms while songs play</strong> to scan songs for waveforms and keys.</div>
      ) : (
        <>
          <SettingRow
            label="Scan length"
            sub={scanMode === 'whole' ? 'Every song, start to finish' : `First and last ${scanSec} seconds of each song`}
            control={
              <div className="set-seg" role="radiogroup" aria-label="Scan length">
                {[['10', '10 s'], ['20', '20 s'], ['30', '30 s'], ['custom', 'Custom'], ['whole', 'Whole']].map(([v, l]) => (
                  <button key={v} type="button" role="radio" aria-checked={scanChoice === v}
                    className={scanChoice === v ? 'on' : ''} disabled={scan.running} onClick={() => setChoice(v)}>{l}</button>
                ))}
              </div>
            }
          >
            {scanChoice === 'custom' && (
              <div className="set-row-extra">
                <input
                  type="number"
                  min={5}
                  max={600}
                  value={scanSec}
                  onChange={e => {
                    const n = Math.round(Number(e.target.value));
                    if (!Number.isFinite(n) || n < 1) return;
                    const latest = useAppStore.getState().config.spotify;
                    updateConfig({ spotify: { ...latest, waveformScan: 'edges', waveformScanSec: Math.min(600, Math.max(5, n)) } });
                  }}
                  style={{ width: 80 }}
                  title="Seconds of each song's start and end to scan"
                />
                <span className="set-row-sub">seconds from each end</span>
              </div>
            )}
          </SettingRow>
          {scan.running ? (
            <div className="set-scan-running">
              <div>
                <div className="set-row-label">Scanning {scan.idx} of {scan.total}</div>
                <div className="set-row-sub">{scan.title} · {mmss(scan.posSec)} of {mmss(scan.durSec)}</div>
              </div>
              <button className="btn-secondary" onClick={() => waveformScanner.stop()}>Stop</button>
            </div>
          ) : (
            <button
              className="btn-primary set-scan-btn"
              onClick={() => void waveformScanner.start(allImportedSpotifySongs())}
              disabled={total === 0 || missing === 0}
              title="Plays every imported Spotify song that doesn’t have a waveform yet, one after another"
            >
              {total === 0 ? 'Import a Spotify playlist first' : missing === 0 ? 'All songs scanned' : missing === null ? 'Scan missing songs' : `Scan the ${missing} missing song${missing === 1 ? '' : 's'}`}
            </button>
          )}
          <div className="set-card-note">
            {scan.note ?? 'Mute your Mac and walk away. It keeps going on other screens and stops by itself before a service starts.'}
          </div>
        </>
      )}
      <KeyLearningStatus />
    </section>
  );
}

// Sign in to Spotify (reads playlists) and the Spotify playback settings.
function SpotifyAccountSection() {
  const config = useAppStore(s => s.config);
  const updateConfig = useAppStore(s => s.updateConfig);
  const clientId = config.spotify?.clientId ?? '';
  const [status, setStatus] = useState<SpotifyStatus>({ connected: false });
  const [busy, setBusy] = useState<null | 'connect'>(null);
  const [appOpen, setAppOpen] = useState<boolean | null>(null);
  const isMac = navigator.userAgent.includes('Mac');
  useEffect(() => { void window.runway?.spotify?.status().then(setStatus); }, []);
  useEffect(() => {
    if (!isMac || !status.connected) return;
    let alive = true;
    const read = () => window.runway.spotify.player({ op: 'check' })
      .then(r => { if (alive) setAppOpen(!!r?.ok); })
      .catch(() => { if (alive) setAppOpen(false); });
    void read();
    const t = window.setInterval(read, 5000);
    return () => { alive = false; window.clearInterval(t); };
  }, [isMac, status.connected]);

  const connect = async () => {
    setBusy('connect');
    try { setStatus(await window.runway.spotify.connect(clientId)); }
    finally { setBusy(null); }
  };
  const disconnect = async () => {
    setStatus(await window.runway.spotify.disconnect());
  };
  const name = status.displayName || 'Spotify';
  const quiet = !!status.quietStart && !!status.canControl;

  return (
    <>
      <section className="settings-section set-account">
        {status.connected ? (
          <>
            <div className="set-avatar" aria-hidden>{name.trim().charAt(0).toUpperCase()}</div>
            <div className="set-account-text">
              <div className="set-account-title">Signed in{status.displayName ? ` as ${status.displayName}` : ''}</div>
              <div className="set-account-sub">
                {status.signInLost
                  ? <span className="set-row-err">Spotify refused the saved sign-in. Sign in again.</span>
                  : 'Runway reads your playlists; songs play in this computer’s Spotify app.'}
              </div>
            </div>
            <div className="set-account-status">
              {isMac && appOpen !== null && (
                <div className={appOpen ? 'ok' : 'warn'}><i />{appOpen ? 'Spotify app open' : 'Spotify app closed'}</div>
              )}
              <div className={quiet ? 'ok' : 'off'}><i />{quiet ? 'Quiet start ready' : 'Quiet start off'}</div>
            </div>
            {status.signInLost
              ? <button className="btn-primary" onClick={connect} disabled={busy !== null || !clientId}>{busy === 'connect' ? 'Waiting for sign-in…' : 'Sign in again'}</button>
              : <button className="btn-secondary" onClick={disconnect} disabled={busy !== null}>Sign out</button>}
          </>
        ) : (
          <div className="set-account-setup">
            <div className="set-account-title">Connect Spotify</div>
            <div className="set-account-sub">
              One-time setup: at developer.spotify.com/dashboard create an app, add the Redirect URI{' '}
              <code>http://127.0.0.1:7813/callback</code>, tick “Web API”, then paste the app’s Client ID here.
              <InfoTip>Sign in so Runway can read the songs in your Spotify playlists. Spotify only lets Runway read playlists you created or collaborate on.</InfoTip>
            </div>
            <div className="pp-actions">
              <input
                type="text"
                value={clientId}
                onChange={e => updateConfig({ spotify: { ...config.spotify, clientId: e.target.value.trim() } })}
                placeholder="Spotify Client ID"
                style={{ flex: 1, minWidth: 260 }}
                disabled={busy !== null}
              />
              <button className="btn-primary" onClick={connect} disabled={busy !== null || !clientId}>
                {busy === 'connect' ? 'Waiting for sign-in…' : 'Connect Spotify'}
              </button>
            </div>
            {status.reason && <div className="pp-status err">{status.reason}</div>}
          </div>
        )}
      </section>

      {status.connected && (
        <div className="set-cards-2">
          <section className="settings-section set-card">
            <div className="settings-section-title">Playback</div>
            <SettingRow
              label="Quiet start"
              sub={status.quietStart && !status.canControl
                ? <span className="set-row-err">Sign in to Spotify again once so Runway is allowed to start songs this way.</span>
                : 'Songs start without bringing Spotify forward (Spotify Premium)'}
              tip="Runway starts each song through Spotify’s own remote control (like your phone does), so the Spotify window never comes forward. Volume, jumps and timing work the same. If it can’t reach Spotify that way, Runway starts the song the usual way instead."
              control={
                <Toggle
                  checked={!!status.quietStart}
                  ariaLabel="Start songs without showing Spotify"
                  onChange={async on => {
                    await window.runway.spotify.player({ op: 'quietStart', on });
                    setStatus(await window.runway.spotify.status());
                  }}
                />
              }
            >
              {status.quietStart && !status.canControl && (
                <div className="set-row-extra">
                  <button className="btn-secondary" onClick={connect} disabled={busy !== null || !clientId}>
                    {busy === 'connect' ? 'Waiting for sign-in…' : 'Sign in again'}
                  </button>
                </div>
              )}
            </SettingRow>
            {!quiet && isMac && <SpotifyWindowPermission />}
            <SpotifyWaveformToggleRow />
            <SettingRow
              label="Playlists, keys and artwork"
              sub="Import playlists and set song keys in Playlists › Spotify"
              control={<button className="btn-secondary" onClick={() => useAppStore.getState().setView('playlists')}>Open</button>}
            />
          </section>
          <SpotifyScanCard />
        </div>
      )}
    </>
  );
}

// Experimental: measures how precisely Runway can land a Spotify song on
// a planned moment. Standalone — doesn't touch services or Runway audio.
function SpotifyTimingTestSection() {
  type Result = Awaited<ReturnType<typeof window.runway.diagnostics.spotifyTimingTest>>;
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await window.runway.diagnostics.spotifyTimingTest(link.trim() || undefined));
    } catch (e) {
      setResult({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };
  const fmt = (ms: number) => {
    const s = (Math.abs(ms) / 1000).toFixed(2);
    return ms === 0 ? 'on time' : `${s}s ${ms > 0 ? 'late' : 'early'}`;
  };
  const worst = result?.runs?.length
    ? Math.max(...result.runs.map(r => Math.abs(r.correctedErrorMs) + r.jitterMs / 2))
    : null;
  return (
    <section className="settings-section">
      <div className="settings-section-title">Spotify timing test (experimental)<InfoTip>Checks how precisely Runway can make a Spotify song end at a planned moment. Open the Spotify app, then run the test: it plays the last 20 seconds of a song three times (about a minute) and reports how close each landing was. Don’t run this during a service; it takes over Spotify.</InfoTip></div>
      <div className="pp-actions">
        <input
          type="text"
          value={link}
          onChange={e => setLink(e.target.value)}
          placeholder="Spotify song link (optional — uses the current song if empty)"
          style={{ flex: 1, minWidth: 260 }}
          disabled={busy}
        />
        <button className="btn-secondary" onClick={run} disabled={busy}>
          {busy ? 'Testing… (about a minute)' : 'Run timing test'}
        </button>
      </div>
      {result && !result.ok && <div className="pp-status err">{result.reason}</div>}
      {result?.ok && result.runs && (
        <div className="settings-section-sub" style={{ marginTop: 12 }}>
          <div><strong>{result.track}</strong></div>
          {result.runs.map((r, i) => (
            <div key={i}>
              Run {i + 1}: loaded in {(r.loadMs / 1000).toFixed(2)}s · first jump {fmt(r.rawErrorMs)} → after correction {fmt(r.correctedErrorMs)}
              {' '}(wobble ±{(r.jitterMs / 2000).toFixed(2)}s, command {r.commandMs} ms)
            </div>
          ))}
          {worst !== null && (
            <div style={{ marginTop: 6 }}>
              <strong>Worst case: about {(worst / 1000).toFixed(2)}s off the planned landing.</strong>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RemoteSettings() {
  const remote = useAppStore(s => s.config.remote);
  const updateConfig = useAppStore(s => s.updateConfig);
  const [lanUrls, setLanUrls] = useState<string[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [interfaces, setInterfaces] = useState<Array<{ name: string; address: string }>>([]);
  const [srv, setSrv] = useState<{ listening: boolean; error?: string; phones: number } | null>(null);

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
      setSrv(urlRes.status ?? null);
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
          <div className="settings-section-title">Remote control<InfoTip>Open one of these addresses on a phone or iPad on the same Wi-Fi to see the live timer. Anyone on the network can watch; controlling Runway needs the PIN. It's on whenever Runway is open.</InfoTip></div>
          <span
            className={`pp-card-status ${!srv ? 'unknown' : srv.listening ? 'on' : 'err'}`}
            title={srv?.error ?? 'On whenever Runway is open.'}
          >
            <span className="pp-card-status-dot" aria-hidden /> {!srv ? 'Checking…' : srv.listening ? (srv.phones > 0 ? `On · ${srv.phones} phone${srv.phones === 1 ? '' : 's'} connected` : 'On') : 'Not running'}
          </span>
        </div>

        {srv?.error && (
          <div className="pp-conn-help" style={{ borderColor: 'rgba(248, 113, 113, 0.45)', color: '#fca5a5' }}>{srv.error}</div>
        )}
        <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', marginTop: 18, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 320 }}>
            {lanUrls.length === 0 ? (
              <div className="empty-state">
                No network address found. Check that Wi-Fi is on.
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
                  Bookmark <strong style={{ color: 'var(--accent-bright)' }}>runway.local</strong> on your phone (or add it to the Home Screen). It finds whichever Mac is running Runway on the same Wi-Fi, so it keeps working when you switch laptops.
                </div>
              </div>
            )}

            <div style={{ marginTop: 20, display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 280 }}>
                <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
                  Network interface
                  <InfoTip>If this Mac is on more than one network (Wi-Fi, Ethernet, VPN), pick the one your phone uses.</InfoTip>
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

              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.06, color: 'var(--text-faint)', fontWeight: 600 }}>
                  Port
                  <InfoTip>Default 7811. Only change it if another app uses that port.</InfoTip>
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
        <div className="settings-section-title">Security<InfoTip>The PIN is needed to control Runway from a phone (Arm, Stop All, Shuffle, Start Post-Service, etc.). Watching the timer doesn't need it. After 5 wrong tries, that phone is locked out for 30 seconds.</InfoTip></div>
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
  const [busy, setBusy] = useState<'export' | 'import' | 'relink' | 'libExport' | 'libImport' | null>(null);
  const [libPreview, setLibPreview] = useState<LibraryBundlePreview | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  // Set after an import / fix pass that left files unresolved — opens the
  // "find your missing audio" prompt so the operator isn't left with a
  // library that silently can't play.
  const [missingReport, setMissingReport] = useState<RelinkReport | null>(null);
  const hasMissing = (r: RelinkReport) => r.tracksMissing + r.padsMissing > 0;

  // Turn a re-link report into a one-line operator-readable summary.
  const relinkMsg = (r: {
    tracksRelinked: number; padsRelinked: number;
    tracksMissing: number; padsMissing: number;
  }): { kind: 'ok' | 'err'; msg: string } => {
    const missing = r.tracksMissing + r.padsMissing;
    const relinkedBits: string[] = [];
    if (r.tracksRelinked) relinkedBits.push(`${r.tracksRelinked} track${r.tracksRelinked === 1 ? '' : 's'}`);
    if (r.padsRelinked) relinkedBits.push(`${r.padsRelinked} pad${r.padsRelinked === 1 ? '' : 's'}`);
    const reconnected = relinkedBits.length
      ? `Reconnected ${relinkedBits.join(' and ')} to this computer.`
      : 'Nothing needed reconnecting.';
    if (missing > 0) {
      return { kind: 'err', msg: `${reconnected} ${missing} file${missing === 1 ? '' : 's'} still missing. Click “Fix missing audio files” and choose the folder your audio is in.` };
    }
    return { kind: 'ok', msg: `${reconnected} All files are linked.` };
  };

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
        // Import auto-re-links to this machine's library. Report the result
        // so a clean "copy config + audio folder" migration reads as done,
        // and a partial one points the operator at the fix.
        if (res.report) {
          setStatus({ kind: relinkMsg(res.report).kind, msg: `Config imported. ${relinkMsg(res.report).msg}` });
          if (hasMissing(res.report)) setMissingReport(res.report);
        } else {
          setStatus({ kind: 'ok', msg: 'Config imported.' });
        }
      } else if (res.reason !== 'Cancelled') {
        setStatus({ kind: 'err', msg: res.reason ?? 'Import failed' });
      }
    } finally {
      setBusy(null);
    }
  };

  // Export every playlist + the audio itself to a folder.
  const onExportLibrary = async () => {
    setBusy('libExport');
    setStatus(null);
    try {
      const res = await window.runway!.config.exportLibrary();
      if (res.ok) {
        const miss = res.missingFiles?.length ?? 0;
        setStatus({
          kind: miss ? 'err' : 'ok',
          msg: `Exported ${res.playlists} playlist${res.playlists === 1 ? '' : 's'} and ${res.tracks} song${res.tracks === 1 ? '' : 's'} to ${res.bundleDir}.`
            + (miss ? ` ${miss} file${miss === 1 ? ' was' : 's were'} missing on this computer and couldn't be included.` : ''),
        });
      } else if (res.reason !== 'Cancelled') {
        setStatus({ kind: 'err', msg: res.reason ?? 'Export failed' });
      }
    } finally {
      setBusy(null);
    }
  };

  // Import step 1: pick the export folder, then show the Add/Merge/Replace chooser.
  const onImportLibrary = async () => {
    setBusy('libImport');
    setStatus(null);
    try {
      const res = await window.runway!.config.previewLibrary();
      if (res.ok && res.preview) setLibPreview(res.preview);
      else if (res.reason !== 'Cancelled') setStatus({ kind: 'err', msg: res.reason ?? 'Import failed' });
    } finally {
      setBusy(null);
    }
  };

  // Import step 2: apply with the chosen mode.
  const runLibraryImport = async (mode: LibraryImportMode) => {
    if (!libPreview) return;
    setBusy('libImport');
    try {
      const res = await window.runway!.config.importLibrary(libPreview.bundleDir, mode);
      setLibPreview(null);
      if (!res.ok || !res.report) {
        setStatus({ kind: 'err', msg: res.reason ?? 'Import failed' });
        return;
      }
      await loadConfig();
      const r = res.report;
      const bits: string[] = [];
      if (r.playlistsAdded) bits.push(`added ${r.playlistsAdded} playlist${r.playlistsAdded === 1 ? '' : 's'}`);
      if (r.playlistsMerged) bits.push(`merged ${r.playlistsMerged}`);
      if (r.playlistsReplaced) bits.push(`replaced ${r.playlistsReplaced}`);
      if (r.tracksAdded) bits.push(`${r.tracksAdded} new song${r.tracksAdded === 1 ? '' : 's'}`);
      const summary = `Imported: ${bits.join(', ') || 'nothing changed'}.`;
      if (res.relink && hasMissing(res.relink)) {
        setStatus({ kind: 'err', msg: `${summary} Some audio is still missing.` });
        setMissingReport(res.relink);
      } else {
        setStatus({ kind: 'ok', msg: `${summary} All files are linked.` });
      }
    } finally {
      setBusy(null);
    }
  };

  // Re-link file paths to this computer without re-importing. First tries the
  // managed library folders; if anything's still missing, offers to search a
  // folder the operator points at. Keeps all keys, trims, fades, playlists.
  const onRelink = async () => {
    setBusy('relink');
    setStatus(null);
    try {
      let report = await window.runway!.config.relink();
      if (report.tracksMissing + report.padsMissing > 0) {
        const folder = await window.runway!.files.pickFolder();
        if (folder) {
          report = await window.runway!.config.relink({ extraFolders: [folder] });
        }
      }
      await loadConfig();
      setStatus(relinkMsg(report));
      if (hasMissing(report)) setMissingReport(report);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Backup &amp; restore<InfoTip>Export saves your playlists, services, weekly pattern, MIDI assignments, ProPresenter setup and defaults to one file. To move to a new computer, copy this file <em>and</em> your audio and pad folders, then Import here. Runway reconnects every song and pad and keeps all keys, trims, fades and playlists. If a song shows as missing later, use “Fix missing audio files”.</InfoTip></div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-secondary" onClick={onExport} disabled={busy !== null}>
            {busy === 'export' ? 'Exporting…' : 'Export config…'}
          </button>
          <button className="btn-secondary" onClick={onImport} disabled={busy !== null}>
            {busy === 'import' ? 'Importing…' : 'Import config…'}
          </button>
          <button className="btn-secondary" onClick={onRelink} disabled={busy !== null}>
            {busy === 'relink' ? 'Fixing…' : 'Fix missing audio files'}
          </button>
        </div>
        <div className="settings-field-label" style={{ marginTop: 18 }}>
          Playlists + audio
          <InfoTip>Export every playlist with its song and pad files into one folder. Copy that folder to another computer (USB drive, AirDrop, shared drive) and import it there. On import you choose to add, merge or replace playlists.</InfoTip>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-secondary" onClick={onExportLibrary} disabled={busy !== null}>
            {busy === 'libExport' ? 'Exporting audio…' : 'Export playlists + audio…'}
          </button>
          <button className="btn-secondary" onClick={onImportLibrary} disabled={busy !== null}>
            {busy === 'libImport' ? 'Importing…' : 'Import playlists + audio…'}
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

      <Advanced>
      <section className="settings-section">
        <div className="settings-section-title" style={{ color: 'var(--red-bright)' }}>Reset to factory defaults<InfoTip>Permanently deletes every playlist, service, weekly pattern, action sequence, MIDI assignment, pad assignment, ProPresenter setting and library entry. Audio files stay in Runway's library folder and can be imported again. Export a backup first if you might want any of this back.</InfoTip></div>
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
      </Advanced>

      {libPreview && (
        <LibraryImportModal
          preview={libPreview}
          busy={busy === 'libImport'}
          onCancel={() => setLibPreview(null)}
          onChoose={runLibraryImport}
        />
      )}

      {missingReport && (
        <MissingAudioModal
          report={missingReport}
          onClose={() => setMissingReport(null)}
          onResolved={(r) => {
            setStatus(relinkMsg(r));
            setMissingReport(hasMissing(r) ? r : null);
          }}
        />
      )}

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
 * Add / Merge / Replace chooser for importing a playlist + audio export.
 * Only edits playlist and track records and copies files — no timing.
 */
function LibraryImportModal({ preview, busy, onCancel, onChoose }: {
  preview: LibraryBundlePreview;
  busy: boolean;
  onCancel: () => void;
  onChoose: (mode: LibraryImportMode) => void;
}) {
  const [mode, setMode] = useState<LibraryImportMode>('merge');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  const existing = preview.playlists.filter(p => p.existsAlready).length;
  const options: Array<{ mode: LibraryImportMode; title: string; body: string }> = [
    {
      mode: 'add',
      title: 'Add as new playlists',
      body: 'Every imported playlist is added alongside yours. Names that already exist get “(imported)” added. Nothing you have changes.',
    },
    {
      mode: 'merge',
      title: 'Merge into matching playlists',
      body: 'Playlists with the same name get any songs they’re missing added at the end. Your playlist settings and song edits stay as they are. New playlists are added.',
    },
    {
      mode: 'replace',
      title: 'Replace matching playlists',
      body: 'Playlists with the same name are overwritten with the imported version (songs, order, settings, and song edits). Services and actions still point at them. Playlists not in the export are kept.',
    },
  ];

  return (
    <div className="key-modal-backdrop" onClick={() => { if (!busy) onCancel(); }}>
      <div className="key-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 580, padding: 28 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Import playlists + audio</div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.45, marginBottom: 12 }}>
          {preview.playlists.length} playlist{preview.playlists.length === 1 ? '' : 's'}, {preview.trackCount} song
          {preview.trackCount === 1 ? '' : 's'}{preview.padCount ? `, ${preview.padCount} pads` : ''}
          {preview.exportedAt ? ` — exported ${new Date(preview.exportedAt).toLocaleString()}` : ''}.
          {existing > 0 && ` ${existing} of these playlist${existing === 1 ? '' : 's'} already exist here.`}
        </div>
        <div style={{ maxHeight: 120, overflowY: 'auto', fontSize: 12, color: 'var(--text-dim)', marginBottom: 14 }}>
          {preview.playlists.map((p, i) => (
            <div key={i}>
              {p.name} · {p.trackCount} song{p.trackCount === 1 ? '' : 's'}
              {p.existsAlready && <span style={{ color: 'var(--accent-bright)' }}> · already here</span>}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {options.map(o => (
            <label
              key={o.mode}
              style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer',
                padding: 10, borderRadius: 8,
                border: `1px solid ${mode === o.mode ? 'var(--accent-bright)' : 'var(--border, #333)'}`,
              }}
            >
              <input
                type="radio"
                name="lib-import-mode"
                checked={mode === o.mode}
                onChange={() => setMode(o.mode)}
                style={{ marginTop: 3 }}
              />
              <span>
                <div style={{ fontWeight: 600, fontSize: 13 }}>{o.title}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4 }}>{o.body}</div>
              </span>
            </label>
          ))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 14 }}>
          Songs already in your library are reused, not copied twice. Your current
          settings are backed up first.
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => onChoose(mode)} disabled={busy}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Some audio is missing" prompt — shown right after a config import (or a
 * Fix pass) leaves tracks/pads pointing at files that aren't on this
 * computer. Lists the missing songs and the playlists they break, and lets
 * the operator point at a folder to search. Repeats until everything is
 * linked or they choose "Later". Only rewrites file locations — no timing.
 */
function MissingAudioModal({ report, onClose, onResolved }: {
  report: RelinkReport;
  onClose: () => void;
  onResolved: (r: RelinkReport) => void;
}) {
  const loadConfig = useAppStore(s => s.loadConfig);
  const tracks = useAppStore(s => s.config.tracks);
  const playlists = useAppStore(s => s.config.playlists);
  const [searching, setSearching] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !searching) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, searching]);

  const missingIds = new Set(report.missingTrackIds ?? []);
  const affectedPlaylists = playlists
    .map(pl => ({ name: pl.name, count: pl.trackIds.filter(id => missingIds.has(id)).length }))
    .filter(x => x.count > 0);
  const missingTotal = report.tracksMissing + report.padsMissing;
  const SHOW = 10;
  const names = report.missingNames;
  // Prefer the track's title over the raw filename where we have it.
  const titleByFile = new Map(tracks.map(t => [t.filePath.split(/[\\/]/).pop() ?? '', t.title]));

  const onFind = async () => {
    const folder = await window.runway!.files.pickFolder();
    if (!folder) return;
    setSearching(true);
    try {
      const before = missingTotal;
      const r = await window.runway!.config.relink({ extraFolders: [folder] });
      await loadConfig();
      const after = r.tracksMissing + r.padsMissing;
      setNote(after === before
        ? `No matching files found in that folder. Pick the folder you copied the audio into.`
        : null);
      onResolved(r);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="key-modal-backdrop" onClick={() => { if (!searching) onClose(); }}>
      <div className="key-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 560, padding: 28 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--red-bright)', marginBottom: 6 }}>
          {missingTotal} audio file{missingTotal === 1 ? ' is' : 's are'} missing
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.45, marginBottom: 14 }}>
          These songs are in your library but their audio isn't on this computer,
          so they can't play. Copy them over from the other computer (or find
          where they are), then click <strong>Find missing files…</strong> and
          pick that folder. Runway matches them by filename and keeps every key,
          trim, fade, and playlist.
        </div>

        {affectedPlaylists.length > 0 && (
          <div style={{ fontSize: 13, marginBottom: 12 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Playlists affected</div>
            {affectedPlaylists.map(pl => (
              <div key={pl.name} style={{ color: 'var(--text-dim)' }}>
                {pl.name} — {pl.count} song{pl.count === 1 ? '' : 's'} missing
              </div>
            ))}
          </div>
        )}

        <div style={{ fontSize: 13, marginBottom: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Missing files</div>
          <div style={{ maxHeight: 180, overflowY: 'auto', color: 'var(--text-dim)' }}>
            {names.slice(0, SHOW).map((n, i) => (
              <div key={i}>{titleByFile.get(n) ? `${titleByFile.get(n)} (${n})` : n}</div>
            ))}
            {names.length > SHOW && <div>…and {names.length - SHOW} more</div>}
          </div>
        </div>

        {note && (
          <div style={{ fontSize: 12, color: 'var(--red-bright)', marginBottom: 12 }}>{note}</div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose} disabled={searching}>Later</button>
          <button className="btn-primary" onClick={onFind} disabled={searching}>
            {searching ? 'Searching…' : 'Find missing files…'}
          </button>
        </div>
      </div>
    </div>
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
          action sequence, MIDI assignment, pad assignment, ProPresenter setting
          and library entry. It can't be undone. Audio files stay in Runway's
          library folder and can be imported again afterward.
        </div>

        <div style={{
          background: 'rgba(0, 122, 209, 0.06)',
          border: '1px solid rgba(0, 122, 209, 0.3)',
          borderRadius: 6,
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
        }}>
          <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>
            Export a backup first. Importing it later restores everything.
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

const fmtSec = (v: number) => `${+v.toFixed(1)} s`;

/** A settings row with a − value + stepper (new look). */
function StepRow({ label, sub, value, onChange, unit = 's', step = 0.5, max = 30 }: {
  label: string;
  sub?: string;
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  step?: number;
  max?: number;
}) {
  return (
    <SettingRow
      label={label}
      sub={sub}
      control={
        <div className="set-stepper">
          <button type="button" aria-label={`Less ${label}`} onClick={() => onChange(Math.max(0, +(value - step).toFixed(1)))}>−</button>
          <span>{unit === 'min' ? value.toFixed(0) : +value.toFixed(1)} {unit}</span>
          <button type="button" aria-label={`More ${label}`} onClick={() => onChange(Math.min(max, +(value + step).toFixed(1)))}>+</button>
        </div>
      }
    />
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

type DisplayPart = 'runway' | 'dev';
function DisplaySettings({ parts }: { parts: DisplayPart[] }) {
  const show = (p: DisplayPart) => parts.includes(p);
  const ui = useAppStore(s => s.config.ui);
  const updateConfig = useAppStore(s => s.updateConfig);
  const showPlayedTracks = ui?.showPlayedTracks ?? false;

  const developerMode = ui?.developerMode ?? false;

  const setUi = (patch: { showPlayedTracks?: boolean; developerMode?: boolean }) => {
    updateConfig({ ui: { ...ui, ...patch } });
  };

  return (
    <>
      {show('runway') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Live runway display<InfoTip>The runway on the Live screen shows one tile per song and scrolls when they don't all fit.</InfoTip></div>

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
              <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                Keep played tracks visible
                <InfoTip>Played songs stay in the runway, dimmed, so you can review the whole service afterward.</InfoTip>
              </div>
            </div>
          </label>
        </div>
      </section>
      </>)}

      {show('dev') && (<>
      <section className="settings-section">
        <div className="settings-section-title">Developer mode<InfoTip>Testing tools for working on Runway itself. Nothing here affects playback or timing.</InfoTip></div>
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
              checked={developerMode}
              onChange={(next) => setUi({ developerMode: next })}
              ariaLabel="Developer mode"
            />
            <div>
              <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 600, display: 'flex', alignItems: 'center' }}>
                Show developer tools
                <InfoTip>Adds a "Key test" button to the Library. It runs key detection on songs you've already tagged, compares the two, and gives you a report to copy. It never changes your tags.</InfoTip>
              </div>
            </div>
          </label>
        </div>
      </section>
      </>)}
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
            Worship audio control. Runway schedules pre-service music to end at service
            start in the first song's key, holds a pad underneath, and hands off to the
            band. It takes MIDI cues from ProPresenter and plays through your audio
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
          © 2026{' '}
          <a
            href="https://groundedlabs.dev"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-bright)', textDecoration: 'none' }}
          >
            Grounded Labs Dev
          </a>
          . All rights reserved.
        </div>
        <p style={{ margin: '8px 0' }}>
          The source code, design, and visual assets of this application are
          the property of Grounded Labs Dev and are licensed for use, not sold.
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

function PlanningCenterSettings() {
  const cfg = useAppStore(s => s.config.pcoSync) ?? DEFAULT_CONFIG.pcoSync!;
  const updateConfig = useAppStore(s => s.updateConfig);
  const setServiceFirstSongKey = useAppStore(s => s.setServiceFirstSongKey);
  const services = useAppStore(s => s.config.services);
  const { pco } = useEngines();

  // Next upcoming Runway service (soonest future start) — the target for a
  // manual "Fetch now". Date need not match the PCO plan's date.
  const nextService = useMemo(() => {
    const now = Date.now();
    const startMs = (s: typeof services[number]) => {
      const d = new Date(s.date + 'T00:00:00');
      const [h, m] = s.startTime.split(':').map(Number);
      d.setHours(h, m, 0, 0);
      return d.getTime();
    };
    return services
      .map(s => ({ s, ms: startMs(s) }))
      .filter(x => x.ms > now)
      .sort((a, b) => a.ms - b.ms)[0]?.s;
  }, [services]);

  const [serviceTypes, setServiceTypes] = useState<PcoServiceType[]>([]);
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<'ok' | 'err' | 'info'>('info');

  const patch = (partial: Partial<typeof cfg>) => {
    updateConfig({ pcoSync: { ...cfg, ...partial } });
  };

  const onTest = async () => {
    setTesting(true);
    setStatus(null);
    // Make sure the client has the freshly-typed credentials before calling.
    pco.updateConfig({ ...cfg });
    try {
      const conn = await pco.testConnection();
      const types = await pco.listServiceTypes();
      setServiceTypes(types);
      setStatusKind('ok');
      setStatus(`Connected${conn.name ? ` to ${conn.name}` : ''}. ${types.length} service type${types.length === 1 ? '' : 's'} found.`);
    } catch (err) {
      setStatusKind('err');
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const onFetchNow = async () => {
    setFetching(true);
    setStatus(null);
    pco.updateConfig({ ...cfg });
    // Manual test: apply the coming plan's key to the next upcoming
    // service, regardless of whether the dates line up.
    const target = nextService;
    const outcome = await runPcoKeySync(pco, cfg, (key) =>
      target ? setServiceFirstSongKey(target.id, key) : 0,
    );
    // Persist the same status snapshot the scheduled pull writes.
    updateConfig({
      pcoSync: {
        ...cfg,
        lastFetchedAt: Date.now(),
        lastFetchedKey: outcome.result?.key ?? null,
        lastFetchedRawKey: outcome.result?.rawKey ?? null,
        lastFetchedSong: outcome.result?.song ?? null,
        lastFetchedPlanDate: outcome.result?.planDate ?? null,
        lastError: outcome.ok ? null : (outcome.reason ?? 'Fetch failed'),
      },
    });
    if (!outcome.ok) {
      setStatusKind('err');
      setStatus(outcome.reason ?? 'Fetch failed');
    } else if (outcome.result?.key) {
      setStatusKind('ok');
      const svcLabel = target ? (target.name || `${target.date} ${target.startTime}`) : null;
      setStatus(
        `${outcome.result.song ?? 'First song'} is in ${displayKey(outcome.result.key)}`
        + (outcome.result.planDate ? ` (plan ${outcome.result.planDate})` : '')
        + ' — '
        + (outcome.applied > 0
          ? `set on ${svcLabel}.`
          : svcLabel
            ? `${svcLabel} already has that key.`
            : 'no upcoming Runway service to set it on yet.'),
      );
    } else {
      setStatusKind('info');
      setStatus(outcome.reason ?? 'Nothing to set.');
    }
    setFetching(false);
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface-2, rgba(255,255,255,0.05))',
    border: '1px solid var(--border, rgba(255,255,255,0.15))',
    borderRadius: 6, color: 'var(--text)', padding: '8px 10px', width: '100%', maxWidth: 420,
  };
  const statusColor = statusKind === 'ok' ? '#34d399' : statusKind === 'err' ? '#f87171' : 'var(--text-dim)';

  return (
    <>
      <section className="settings-section">
        <div className="settings-section-title">Planning Center<InfoTip>Sets the pad key from the first song in your Planning Center plan, so it's right even when nobody sets it by hand.</InfoTip></div>

        <div className="settings-field" style={{ marginTop: 12 }}>
          <div className="settings-field-label">Auto-set key from Planning Center</div>
          <div className="settings-field-control">
            <Toggle checked={cfg.enabled} onChange={v => patch({ enabled: v })} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16, opacity: cfg.enabled ? 1 : 0.55 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="settings-field-label">Application ID</span>
            <input
              style={inputStyle}
              type="text"
              value={cfg.appId}
              placeholder="Application ID from your access token"
              onChange={e => patch({ appId: e.target.value.trim() })}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span className="settings-field-label">Secret</span>
            <input
              style={inputStyle}
              type="password"
              value={cfg.secret}
              placeholder="Secret from your access token"
              onChange={e => patch({ secret: e.target.value.trim() })}
            />
          </label>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={onTest} disabled={testing || !cfg.appId || !cfg.secret}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {serviceTypes.length > 0 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="settings-field-label">Service type</span>
                <select
                  style={{ ...inputStyle, width: 'auto', minWidth: 200 }}
                  value={cfg.serviceTypeId ?? ''}
                  onChange={e => {
                    const st = serviceTypes.find(t => t.id === e.target.value);
                    patch({ serviceTypeId: st?.id ?? null, serviceTypeName: st?.name ?? null });
                  }}
                >
                  <option value="">Choose one</option>
                  {serviceTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* If a service type was saved previously, show it even before Test is pressed. */}
          {serviceTypes.length === 0 && cfg.serviceTypeName && (
            <div className="settings-field-sub">
              Reading plans from <strong>{cfg.serviceTypeName}</strong>. Press Test connection to change it.
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="settings-field-label">Pull key</span>
            <input
              type="number"
              min={1}
              max={1440}
              style={{ ...inputStyle, width: 90 }}
              value={Math.round((cfg.pullLeadSec ?? 14400) / 60)}
              onChange={e => {
                const mins = Math.max(1, Math.min(1440, Number(e.target.value) || 1));
                patch({ pullLeadSec: mins * 60 });
              }}
            />
            <span className="settings-field-sub">
              minutes before each service
              <InfoTip>Change it per service on the Schedule screen.</InfoTip>
            </span>
          </label>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn-primary" onClick={onFetchNow} disabled={fetching || !cfg.enabled || !cfg.serviceTypeId}>
              {fetching ? 'Fetching…' : 'Fetch now'}
            </button>
            <InfoTip>
              {nextService
                ? `Pull the coming plan's key and set it on ${nextService.name || `${nextService.date} ${nextService.startTime}`} now.`
                : 'Get the next plan’s key now. No upcoming service to apply it to yet.'}
            </InfoTip>
          </div>

          {status && (
            <div style={{ color: statusColor, fontSize: 13, marginTop: 4 }}>{status}</div>
          )}

          {cfg.lastFetchedAt && !status && (
            <div className="settings-field-sub" style={{ marginTop: 4 }}>
              {cfg.lastError
                ? `Last sync error: ${cfg.lastError}`
                : cfg.lastFetchedKey
                  ? `Last sync: ${cfg.lastFetchedSong ?? 'first song'} in ${displayKey(cfg.lastFetchedKey as KeyName)} for ${cfg.lastFetchedPlanDate ?? '—'}.`
                  : 'Last sync: nothing to set.'}
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <details open={!cfg.serviceTypeId}>
        <summary className="settings-section-title" style={{ cursor: 'pointer', display: 'list-item' }}>How to connect</summary>
        <ol className="settings-section-sub" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
          <li>Sign in at <strong>planningcenteronline.com</strong> → <strong>Developer</strong> (api.planningcenteronline.com).</li>
          <li>Open <strong>Personal Access Tokens</strong> → <strong>New Personal Access Token</strong>. Name it "Runway".</li>
          <li>Copy the <strong>Application ID</strong> and <strong>Secret</strong> into the fields above.</li>
          <li>Press <strong>Test connection</strong>, then choose your Sunday <strong>service type</strong>.</li>
          <li>Press <strong>Fetch now</strong> to confirm it reads the right key. After that it refreshes on its own each day.</li>
        </ol>
        </details>
      </section>
    </>
  );
}
