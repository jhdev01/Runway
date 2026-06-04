import React, { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../state/store';
import { useEngines } from '../state/engines';
import type { ProPresenterServiceOverride } from '@shared/types';
import type { PpTimer } from '../lib/proPresenterClient';

interface Props {
  /** Header text (e.g. service or pattern name). Optional. */
  title?: string;
  /** Subline beneath the header — date+time, day-of-week+time, etc. */
  subtitle: string;
  /** Existing override or undefined for "inherit global". */
  override: ProPresenterServiceOverride | undefined;
  onClose: () => void;
  onSave: (override: ProPresenterServiceOverride | undefined) => void;
}

type HookKey = 'musicStart' | 'serviceStart' | 'postServiceStart' | 'disarm';

const HOOK_FIELD_MAP: Record<HookKey, {
  action: keyof ProPresenterServiceOverride;
  playlistUuid: keyof ProPresenterServiceOverride;
  playlistName: keyof ProPresenterServiceOverride;
  itemIndex: keyof ProPresenterServiceOverride;
  itemName: keyof ProPresenterServiceOverride;
}> = {
  musicStart: {
    action: 'musicStartAction',
    playlistUuid: 'musicStartPlaylistUuid',
    playlistName: 'musicStartPlaylistName',
    itemIndex: 'musicStartItemIndex',
    itemName: 'musicStartItemName',
  },
  serviceStart: {
    action: 'serviceStartAction',
    playlistUuid: 'serviceStartPlaylistUuid',
    playlistName: 'serviceStartPlaylistName',
    itemIndex: 'serviceStartItemIndex',
    itemName: 'serviceStartItemName',
  },
  postServiceStart: {
    action: 'postServiceStartAction',
    playlistUuid: 'postServiceStartPlaylistUuid',
    playlistName: 'postServiceStartPlaylistName',
    itemIndex: 'postServiceStartItemIndex',
    itemName: 'postServiceStartItemName',
  },
  disarm: {
    action: 'disarmAction',
    playlistUuid: 'disarmPlaylistUuid',
    playlistName: 'disarmPlaylistName',
    itemIndex: 'disarmItemIndex',
    itemName: 'disarmItemName',
  },
};

type GlobalCfg = ReturnType<typeof useAppStore.getState>['config']['proPresenterSync'];

/**
 * Seed an override from the global PP config when the user has none yet, so
 * toggling Enable doesn't blank every field — they just tweak what's different.
 */
function buildInitialOverride(
  existing: ProPresenterServiceOverride | undefined,
  globalCfg: GlobalCfg,
): ProPresenterServiceOverride {
  if (existing) return existing;
  return {
    timerUuid: globalCfg.timerUuid,
    timerName: globalCfg.timerName,
    musicStartAction: globalCfg.musicStartAction,
    musicStartPlaylistUuid: globalCfg.musicStartPlaylistUuid,
    musicStartPlaylistName: globalCfg.musicStartPlaylistName,
    musicStartItemIndex: globalCfg.musicStartItemIndex,
    musicStartItemName: globalCfg.musicStartItemName,
    disarmAction: globalCfg.disarmAction,
    disarmPlaylistUuid: globalCfg.disarmPlaylistUuid,
    disarmPlaylistName: globalCfg.disarmPlaylistName,
    disarmItemIndex: globalCfg.disarmItemIndex,
    disarmItemName: globalCfg.disarmItemName,
    serviceStartAction: globalCfg.serviceStartAction,
    serviceStartPlaylistUuid: globalCfg.serviceStartPlaylistUuid,
    serviceStartPlaylistName: globalCfg.serviceStartPlaylistName,
    serviceStartItemIndex: globalCfg.serviceStartItemIndex,
    serviceStartItemName: globalCfg.serviceStartItemName,
    postServiceStartAction: globalCfg.postServiceStartAction,
    postServiceStartPlaylistUuid: globalCfg.postServiceStartPlaylistUuid,
    postServiceStartPlaylistName: globalCfg.postServiceStartPlaylistName,
    postServiceStartItemIndex: globalCfg.postServiceStartItemIndex,
    postServiceStartItemName: globalCfg.postServiceStartItemName,
  };
}

export function ProPresenterServiceModal({ title, subtitle, override, onClose, onSave }: Props) {
  const globalCfg = useAppStore(s => s.config.proPresenterSync);
  const cachedTimers = useAppStore(s => s.ppTimers);
  const cachedPlaylists = useAppStore(s => s.ppPlaylists);
  const { pp } = useEngines();

  const [draft, setDraft] = useState<ProPresenterServiceOverride>(() =>
    buildInitialOverride(override, globalCfg),
  );

  const [itemsByHook, setItemsByHook] = useState<Record<HookKey, PpTimer[]>>({
    musicStart: [], serviceStart: [], postServiceStart: [], disarm: [],
  });
  const [busyByHook, setBusyByHook] = useState<Record<HookKey, boolean>>({
    musicStart: false, serviceStart: false, postServiceStart: false, disarm: false,
  });
  const [polling, setPolling] = useState(true);
  const [pollError, setPollError] = useState<string | null>(null);

  const setPpTimers = useAppStore(s => s.setPpTimers);
  const setPpPlaylists = useAppStore(s => s.setPpPlaylists);

  // Always poll PP fresh when the modal opens — playlist/timer cache may be
  // stale, especially if PP was just reopened or the document changed. Then
  // load items for any saved playlist on each hook.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPolling(true);
      setPollError(null);
      try {
        const [freshTimers, freshPlaylists] = await Promise.all([
          pp.listTimers(),
          pp.listPlaylists(),
        ]);
        if (cancelled) return;
        setPpTimers(freshTimers);
        setPpPlaylists(freshPlaylists);
      } catch (err) {
        if (cancelled) return;
        setPollError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setPolling(false);
      }

      // Items per hook — request in parallel, update each as it lands.
      await Promise.all((Object.keys(HOOK_FIELD_MAP) as HookKey[]).map(async hook => {
        const k = HOOK_FIELD_MAP[hook];
        const uuid = draft[k.playlistUuid] as string | null;
        if (!uuid) return;
        setBusyByHook(prev => ({ ...prev, [hook]: true }));
        try {
          const items = await pp.listPlaylistItems(uuid);
          if (!cancelled) setItemsByHook(prev => ({ ...prev, [hook]: items }));
        } catch { /* non-fatal */ }
        finally {
          if (!cancelled) setBusyByHook(prev => ({ ...prev, [hook]: false }));
        }
      }));
    })();
    return () => { cancelled = true; };
    // Run once on open. The `draft` snapshot at mount captures saved
    // playlist uuids; we don't want to re-poll on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timers: PpTimer[] = useMemo(() =>
    cachedTimers.map(t => ({ ...t, raw: t })),
    [cachedTimers],
  );
  const playlists: PpTimer[] = useMemo(() =>
    cachedPlaylists.map(p => ({ ...p, raw: p })),
    [cachedPlaylists],
  );

  const patch = (p: Partial<ProPresenterServiceOverride>) => {
    setDraft(d => ({ ...d, ...p }));
  };

  const onPickPlaylist = async (hook: HookKey, uuid: string) => {
    const k = HOOK_FIELD_MAP[hook];
    const playlist = playlists.find(p => p.uuid === uuid);
    patch({
      [k.playlistUuid]: uuid || null,
      [k.playlistName]: playlist?.name ?? null,
      [k.itemIndex]: null,
      [k.itemName]: null,
    } as Partial<ProPresenterServiceOverride>);
    setItemsByHook(prev => ({ ...prev, [hook]: [] }));
    if (!uuid) return;
    setBusyByHook(prev => ({ ...prev, [hook]: true }));
    try {
      const items = await pp.listPlaylistItems(uuid);
      setItemsByHook(prev => ({ ...prev, [hook]: items }));
    } catch (err) {
      console.warn(`[pp-override] listPlaylistItems (${hook}) failed`, err);
    } finally {
      setBusyByHook(prev => ({ ...prev, [hook]: false }));
    }
  };

  const onPickItem = (hook: HookKey, raw: string) => {
    const k = HOOK_FIELD_MAP[hook];
    if (raw === '') {
      patch({ [k.itemIndex]: null, [k.itemName]: null } as Partial<ProPresenterServiceOverride>);
      return;
    }
    const idx = parseInt(raw, 10);
    if (Number.isNaN(idx)) return;
    const item = itemsByHook[hook].find(i => i.index === idx);
    patch({ [k.itemIndex]: idx, [k.itemName]: item?.name ?? null } as Partial<ProPresenterServiceOverride>);
  };

  const onSaveClick = () => {
    // Saving always writes an override — clicking any field implicitly opts
    // this entry out of inheriting global. To go back to global, use the
    // "Use global instead" button.
    onSave(draft);
    onClose();
  };

  const onClearOverride = () => {
    onSave(undefined);
    onClose();
  };

  const renderHook = (
    hook: HookKey,
    label: string,
    description: string,
    icon: string,
    tone: 'music' | 'service' | 'post' | 'disarm',
  ) => {
    const k = HOOK_FIELD_MAP[hook];
    const action = draft[k.action] as 'none' | 'clear_timer' | 'clear_all' | 'trigger_item';
    const playlistUuid = draft[k.playlistUuid] as string | null;
    const playlistName = draft[k.playlistName] as string | null;
    const itemIndex = draft[k.itemIndex] as number | null;
    const itemName = draft[k.itemName] as string | null;
    const items = itemsByHook[hook];
    const busy = busyByHook[hook];
    const inactive = action === 'none';

    return (
      <div className={`pp-modal-hook pp-hook tone-${tone} ${inactive ? 'inactive' : ''}`} key={hook}>
        <div className="pp-card-head">
          <span className="pp-card-icon" aria-hidden>{icon}</span>
          <div className="pp-card-text">
            <div className="pp-card-title">{label}</div>
            <div className="pp-card-sub">{description}</div>
          </div>
        </div>
        <div className="pp-modal-hook-grid">
          <select
            value={action}
            onChange={e => patch({ [k.action]: e.target.value } as Partial<ProPresenterServiceOverride>)}
            disabled={false}
          >
            <option value="none">Do nothing</option>
            <option value="clear_timer">Clear PP timer only</option>
            <option value="clear_all">Clear all PP layers</option>
            <option value="trigger_item">Trigger playlist item</option>
          </select>
          {action === 'trigger_item' && (
            <>
              <select
                value={playlistUuid ?? ''}
                onChange={e => void onPickPlaylist(hook, e.target.value)}
                disabled={false}
              >
                <option value="">{playlists.length === 0 ? '— No playlists loaded —' : '— Select a playlist —'}</option>
                {playlists.map(p => (
                  <option key={p.uuid} value={p.uuid}>{p.name}</option>
                ))}
                {playlistUuid && playlistName && !playlists.some(p => p.uuid === playlistUuid) && (
                  <option value={playlistUuid}>{playlistName} (not loaded)</option>
                )}
              </select>
              <select
                value={itemIndex !== null ? String(itemIndex) : ''}
                onChange={e => onPickItem(hook, e.target.value)}
                disabled={!playlistUuid || busy}
              >
                <option value="">
                  {!playlistUuid ? '— Pick a playlist first —'
                    : busy ? '— Loading items… —'
                    : items.length === 0 ? '— No items loaded —'
                    : '— Select an item —'}
                </option>
                {items.map(i => (
                  <option key={i.uuid} value={i.index ?? ''}>
                    {i.index !== undefined ? `${i.index + 1}. ` : ''}{i.name}
                  </option>
                ))}
                {itemIndex !== null && itemName && !items.some(i => i.index === itemIndex) && (
                  <option value={String(itemIndex)}>{itemIndex + 1}. {itemName} (not loaded)</option>
                )}
              </select>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="pp-modal-backdrop" onClick={onClose}>
      <div className="pp-modal" onClick={e => e.stopPropagation()}>
        <div className="pp-modal-header">
          <div>
            <div className="pp-modal-title">{title ?? 'ProPresenter setup'}</div>
            <div className="pp-modal-sub">{subtitle}</div>
          </div>
          <button className="pp-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="pp-modal-body">
          <div className="pp-modal-help">
            {override
              ? 'These settings override the global ProPresenter defaults for this entry. Click "Use global instead" below to clear the override.'
              : 'Saving any change here overrides the global ProPresenter defaults for this entry. Use "Use global instead" later to revert.'}
          </div>
          <div className="pp-modal-poll-status">
            {polling
              ? '⟳ Polling ProPresenter for timers and playlists…'
              : pollError
                ? `Couldn't refresh from ProPresenter: ${pollError}`
                : `Refreshed — ${cachedPlaylists.length} playlist${cachedPlaylists.length === 1 ? '' : 's'}, ${cachedTimers.length} timer${cachedTimers.length === 1 ? '' : 's'}`}
          </div>

          <div className="pp-modal-section-title">Timer</div>
          <select
            value={draft.timerUuid ?? ''}
            onChange={e => {
              const uuid = e.target.value || null;
              const t = timers.find(x => x.uuid === uuid);
              patch({ timerUuid: uuid, timerName: t?.name ?? null });
            }}
            disabled={false}
          >
            <option value="">— No timer —</option>
            {timers.map(t => (
              <option key={t.uuid} value={t.uuid}>{t.name}</option>
            ))}
            {draft.timerUuid && draft.timerName && !timers.some(t => t.uuid === draft.timerUuid) && (
              <option value={draft.timerUuid}>{draft.timerName} (not loaded)</option>
            )}
          </select>

          <div className="pp-modal-section-title" style={{ marginTop: 18 }}>Hooks</div>
          {renderHook('musicStart', 'When music starts', 'Fires when the pre-service music actually begins playing.', '♪', 'music')}
          {renderHook('serviceStart', 'When service starts', 'Fires when the PP timer reaches 00:00.', '▶', 'service')}
          {renderHook('postServiceStart', 'When post-service starts', 'Fires when Start Post-Service is pressed (no timer).', '✦', 'post')}
          {renderHook('disarm', 'When disarmed', "Fires when this service is panicked or manually disarmed. 'Do nothing' leaves the PP timer running.", '◯', 'disarm')}
        </div>

        <div className="pp-modal-footer">
          {override && (
            <button
              className="btn-secondary"
              onClick={onClearOverride}
              style={{ marginRight: 'auto' }}
              title="Remove this entry's override and inherit global PP settings"
            >
              Use global instead
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={onSaveClick}>Save</button>
        </div>
      </div>
    </div>
  );
}
