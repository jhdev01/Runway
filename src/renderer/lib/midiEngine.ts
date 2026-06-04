import type { MidiBinding, MidiAction, MidiLogEntry, MidiMessageType, MidiDevicePref } from '@shared/types';

export type MidiEventListener = (entry: MidiLogEntry) => void;
export type MidiActionListener = (action: MidiAction) => void;
export type MidiDeviceListener = (devices: MidiDeviceSnapshot[]) => void;

export interface MidiLearnCapture {
  channel: number;
  type: 'note' | 'cc';
  noteOrCc: number;
  velocity: number;
}
export type MidiLearnCallback = (capture: MidiLearnCapture) => void;

/**
 * Per-device snapshot for the settings UI. Connected devices are keyed by
 * `name`; saved prefs for currently-disconnected devices are also surfaced
 * so the user can see and clear them.
 */
export interface MidiDeviceSnapshot {
  name: string;
  manufacturer?: string;
  hasInput: boolean;
  hasOutput: boolean;
  connected: boolean;
  inputEnabled: boolean;
  outputEnabled: boolean;
}

const MAX_LOG_ENTRIES = 200;

export class MidiEngine {
  private access: MIDIAccess | null = null;
  private bindings: MidiBinding[] = [];
  private devicePrefs: MidiDevicePref[] = [];
  private logListeners: Set<MidiEventListener> = new Set();
  private actionListeners: Set<MidiActionListener> = new Set();
  private deviceListeners: Set<MidiDeviceListener> = new Set();
  private log: MidiLogEntry[] = [];
  private connected = false;
  private enabled = true;
  private enabledListeners: Set<(b: boolean) => void> = new Set();
  private learnCallback: MidiLearnCallback | null = null;

  async init(): Promise<boolean> {
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.applyDevicePrefs();
      this.access.onstatechange = () => {
        // Devices coming or going — re-apply prefs (covers new attaches),
        // then notify subscribers so the settings UI can refresh.
        this.applyDevicePrefs();
        this.emitDevices();
      };
      this.connected = true;
      this.emitDevices();
      return true;
    } catch (err) {
      console.warn('[midi] requestMIDIAccess failed', err);
      this.connected = false;
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Toggle whether incoming MIDI is processed. When false, all messages drop. */
  setEnabled(b: boolean): void {
    this.enabled = b;
    this.enabledListeners.forEach(l => l(b));
  }

  subscribeEnabled(listener: (b: boolean) => void): () => void {
    this.enabledListeners.add(listener);
    return () => this.enabledListeners.delete(listener);
  }

  inputs(): MIDIInput[] {
    if (!this.access) return [];
    return Array.from(this.access.inputs.values());
  }

  outputs(): MIDIOutput[] {
    if (!this.access) return [];
    return Array.from(this.access.outputs.values());
  }

  /** Resolve a saved output port name back to a live MIDIOutput, if present. */
  findOutputByName(name: string | null): MIDIOutput | null {
    if (!name || !this.access) return null;
    for (const out of this.access.outputs.values()) {
      if ((out.name || '') === name) return out;
    }
    return null;
  }

  setBindings(bindings: MidiBinding[]) {
    this.bindings = bindings;
  }

  getLog(): MidiLogEntry[] {
    return [...this.log];
  }

  subscribeLog(listener: MidiEventListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  subscribeActions(listener: MidiActionListener): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  /**
   * Capture the next incoming Note On or CC message and report it to `cb`.
   * While listening, normal action dispatch is suppressed so the learning press
   * doesn't fire whatever was previously bound to that note. Returns a
   * cancel function — call to abort without capture.
   */
  startLearn(cb: MidiLearnCallback): () => void {
    this.learnCallback = cb;
    return () => {
      if (this.learnCallback === cb) this.learnCallback = null;
    };
  }

  isLearning(): boolean {
    return this.learnCallback !== null;
  }

  /**
   * Walk currently-connected inputs and attach (or detach) the message
   * handler based on `devicePrefs`. Devices without an explicit pref entry
   * default to enabled, so users who never visit the device-settings UI
   * keep the previous "listen to everything" behavior.
   */
  private applyDevicePrefs() {
    if (!this.access) return;
    this.access.inputs.forEach(input => {
      const deviceName = input.name || 'Unknown device';
      const pref = this.devicePrefs.find(p => p.name === deviceName);
      const inputEnabled = pref ? pref.inputEnabled : true;
      if (inputEnabled) {
        input.onmidimessage = (e: MIDIMessageEvent) => this.handleMessage(e, deviceName);
      } else {
        input.onmidimessage = null;
      }
    });
  }

  /**
   * Replace stored device prefs and re-attach inputs accordingly. Called
   * from the engines provider whenever `config.midiDevices` changes.
   */
  setDevicePrefs(prefs: MidiDevicePref[]): void {
    this.devicePrefs = prefs.map(p => ({ ...p }));
    this.applyDevicePrefs();
    this.emitDevices();
  }

  /**
   * Snapshot of every device the settings UI should show: every connected
   * input/output (merged by name) plus saved prefs for devices not currently
   * connected (so the user can see them as disconnected and clear stale entries).
   */
  getDevices(): MidiDeviceSnapshot[] {
    const byName = new Map<string, MidiDeviceSnapshot>();

    const upsert = (
      name: string,
      patch: Partial<MidiDeviceSnapshot>,
    ) => {
      const existing = byName.get(name);
      if (existing) Object.assign(existing, patch);
      else {
        const pref = this.devicePrefs.find(p => p.name === name);
        byName.set(name, {
          name,
          manufacturer: undefined,
          hasInput: false,
          hasOutput: false,
          connected: false,
          inputEnabled: pref ? pref.inputEnabled : true,
          outputEnabled: pref ? pref.outputEnabled : true,
          ...patch,
        });
      }
    };

    if (this.access) {
      this.access.inputs.forEach(input => {
        const name = input.name || 'Unknown device';
        upsert(name, {
          manufacturer: input.manufacturer || undefined,
          hasInput: true,
          connected: true,
        });
      });
      this.access.outputs.forEach(output => {
        const name = output.name || 'Unknown device';
        upsert(name, {
          manufacturer: output.manufacturer || undefined,
          hasOutput: true,
          connected: true,
        });
      });
    }

    // Surface saved prefs for currently-disconnected devices so the user
    // can find and prune stale entries.
    for (const pref of this.devicePrefs) {
      if (!byName.has(pref.name)) {
        byName.set(pref.name, {
          name: pref.name,
          manufacturer: pref.manufacturer,
          hasInput: false,
          hasOutput: false,
          connected: false,
          inputEnabled: pref.inputEnabled,
          outputEnabled: pref.outputEnabled,
        });
      }
    }

    return Array.from(byName.values()).sort((a, b) => {
      // Connected devices first, then alphabetical within each group.
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  subscribeDevices(listener: MidiDeviceListener): () => void {
    this.deviceListeners.add(listener);
    listener(this.getDevices());
    return () => this.deviceListeners.delete(listener);
  }

  private emitDevices() {
    const snapshot = this.getDevices();
    this.deviceListeners.forEach(l => l(snapshot));
  }

  /**
   * Resolve a saved output port name to a live MIDIOutput, but only if
   * outputs are enabled for that device per `devicePrefs`. Used by any
   * future MIDI-out feature (timecode, etc.) to honor the user's prefs.
   */
  resolveEnabledOutputByName(name: string | null): MIDIOutput | null {
    if (!name || !this.access) return null;
    const pref = this.devicePrefs.find(p => p.name === name);
    if (pref && !pref.outputEnabled) return null;
    for (const out of this.access.outputs.values()) {
      if ((out.name || '') === name) return out;
    }
    return null;
  }

  /**
   * Send a single channel-voice message on the named output. `channel`
   * is 1..16 (web MIDI uses 0..15 in the status nibble). Used by the
   * Action Sequence engine to fire MIDI cues.
   */
  send(
    portName: string,
    type: 'note_on' | 'note_off' | 'cc' | 'program_change',
    channel: number,
    data1: number,
    data2: number = 0,
  ): boolean {
    const out = this.resolveEnabledOutputByName(portName);
    if (!out) return false;
    const ch = Math.max(0, Math.min(15, channel - 1));
    const d1 = Math.max(0, Math.min(127, Math.round(data1)));
    const d2 = Math.max(0, Math.min(127, Math.round(data2)));
    let status: number;
    switch (type) {
      case 'note_on':        status = 0x90 | ch; break;
      case 'note_off':       status = 0x80 | ch; break;
      case 'cc':             status = 0xB0 | ch; break;
      case 'program_change': status = 0xC0 | ch; break;
    }
    try {
      // Program change is 2 bytes; everything else is 3.
      if (type === 'program_change') out.send([status, d1]);
      else out.send([status, d1, d2]);
      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(e: MIDIMessageEvent, deviceName: string) {
    if (!this.enabled) return;
    const data = e.data;
    if (!data || data.length < 1) return;
    const status = data[0];
    const data1 = data.length > 1 ? data[1] : 0;
    const data2 = data.length > 2 ? data[2] : 0;

    // System messages (0xF0..0xFF) — clock, sysex, transport. No channel.
    if ((status & 0xF0) === 0xF0) {
      this.appendLog({
        timestamp: Date.now(),
        direction: 'in',
        channel: 0,
        type: 'system',
        data1,
        data2,
        deviceName,
      });
      return;
    }

    const channel = (status & 0x0f) + 1;     // 1-16
    const messageType = status & 0xf0;

    // Classify so we can log every type (so the user can verify what's
    // arriving) but only mark note/cc as bindable / learnable. Note Off and
    // releases mustn't fire bindings or learn — they happen on key-up.
    let type: MidiMessageType;
    let isLearnable = false;
    let learnType: 'note' | 'cc' = 'note';

    if (messageType === 0x90 && data2 > 0) {
      type = 'note';
      isLearnable = true;
      learnType = 'note';
    } else if (messageType === 0x80 || (messageType === 0x90 && data2 === 0)) {
      type = 'note_off';
    } else if (messageType === 0xa0) {
      type = 'poly_aftertouch';
    } else if (messageType === 0xb0) {
      type = 'cc';
      isLearnable = true;
      learnType = 'cc';
    } else if (messageType === 0xc0) {
      type = 'pc';
    } else if (messageType === 0xd0) {
      type = 'aftertouch';
    } else if (messageType === 0xe0) {
      type = 'pitchbend';
    } else {
      type = 'other';
    }

    // Learn intercepts the next learnable press before binding match, so
    // pressing a button that's already bound doesn't also fire its action.
    if (this.learnCallback && isLearnable) {
      const cb = this.learnCallback;
      this.learnCallback = null;
      this.appendLog({
        timestamp: Date.now(),
        direction: 'in',
        channel,
        type,
        data1,
        data2,
        deviceName,
        matchedAction: 'LEARN',
      });
      cb({ channel, type: learnType, noteOrCc: data1, velocity: data2 });
      return;
    }

    // Match bindings only for note/cc. Other types just log.
    const matched = (type === 'note' || type === 'cc')
      ? this.bindings.find(b =>
          b.channel === channel && b.noteOrCc === data1 && b.type === type
        )
      : undefined;

    this.appendLog({
      timestamp: Date.now(),
      direction: 'in',
      channel,
      type,
      data1,
      data2,
      deviceName,
      matchedAction: matched ? actionToString(matched.action) : undefined,
    });

    if (matched) {
      this.actionListeners.forEach(l => l(matched.action));
    }
  }

  private appendLog(entry: MidiLogEntry) {
    this.log.push(entry);
    if (this.log.length > MAX_LOG_ENTRIES) {
      this.log = this.log.slice(-MAX_LOG_ENTRIES);
    }
    this.logListeners.forEach(l => l(entry));
  }
}

function actionToString(action: MidiAction): string {
  if (typeof action === 'string') return action;
  if (action.type === 'pad_set_key') return `pad_set_key:${action.key}`;
  return JSON.stringify(action);
}
