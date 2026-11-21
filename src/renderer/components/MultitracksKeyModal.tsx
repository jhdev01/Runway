import React, { useMemo, useState } from 'react';
import { keyColor, camelotOf } from '@shared/music';
import type { KeyName, MultitracksCandidate, MultitracksResult } from '@shared/types';

/**
 * One track's outcome from a MultiTracks scan, plus the operator's
 * pending decision about it.
 */
export interface KeyProposal {
  trackId: string;
  trackTitle: string;
  trackArtist: string;
  /** Whatever key the track carries right now, if any. */
  currentKey?: KeyName;
  result: MultitracksResult;
  /** Which candidate key the operator has settled on. */
  chosenKey?: KeyName;
  /** Whether "Apply" will write this one. */
  include: boolean;
}

/**
 * How a proposal reads at a glance. Drives the grouping, the default
 * checkbox state, and the badge on each row.
 *
 *   'new'       — track had no key, match is confident. Safe default: on.
 *   'same'      — MultiTracks agrees with what's already there. Nothing to do.
 *   'relative'  — proposed key is the relative major of the operator's
 *                 minor key (or vice versa). MultiTracks publishes ROOTS
 *                 ONLY, so this is very likely the same song spelled the
 *                 other way, not a correction. Never auto-checked.
 *   'conflict'  — MultiTracks disagrees with an existing key in a way
 *                 that isn't just major/minor spelling. Operator decides.
 *   'ambiguous' — matched, but the catalog lists the song in more than
 *                 one key, or confidence is low. Operator decides.
 *   'none'      — no usable match. Nothing to apply.
 */
export type ProposalKind = 'new' | 'same' | 'relative' | 'conflict' | 'ambiguous' | 'none';

/** Confidence at or above which a match needs no second look. */
const CONFIDENT = 0.8;

/**
 * How far ahead of the nearest key-disagreeing alternate the best match
 * has to be before we'll treat it as settled.
 *
 * The catalog routinely lists one song in several keys (album cut, radio
 * edit, acoustic). When the local file's duration matches one of them,
 * that one scores a clean 1.00 and the others fall away — a wide gap
 * means the signals agree and there's nothing to decide. A narrow gap
 * means two releases fit the file about equally well, which is a coin
 * flip, and a coin flip about a key is exactly what shouldn't happen
 * unattended.
 */
const DECISIVE_MARGIN = 0.1;

/** Same Camelot number = relative major/minor pair (e.g. G and Em). */
function isRelativePair(a: KeyName, b: KeyName): boolean {
  if (a === b) return false;
  const ca = camelotOf(a);
  const cb = camelotOf(b);
  if (!ca || !cb) return false;
  return parseInt(ca, 10) === parseInt(cb, 10);
}

export function classifyProposal(p: {
  currentKey?: KeyName;
  result: MultitracksResult;
  chosenKey?: KeyName;
}): ProposalKind {
  const proposed = p.chosenKey ?? p.result.best?.key;
  if (!proposed) return 'none';
  if (p.currentKey && p.currentKey === proposed) return 'same';
  if (p.currentKey && isRelativePair(p.currentKey, proposed)) return 'relative';
  if (p.currentKey) return 'conflict';
  const bestScore = p.result.best?.score ?? 0;
  // alternates only ever holds candidates whose key DISAGREES with best,
  // and it's sorted best-first, so [0] is the closest real rival.
  const rivalScore = p.result.alternates[0]?.score ?? 0;
  const confident = bestScore >= CONFIDENT && (bestScore - rivalScore) >= DECISIVE_MARGIN;
  return confident ? 'new' : 'ambiguous';
}

/**
 * Build the initial proposal from a lookup result. Only the clean case
 * — empty key, confident match, catalog agrees with itself — starts
 * checked. Everything else is opt-in.
 */
export function makeProposal(
  trackId: string,
  trackTitle: string,
  trackArtist: string,
  currentKey: KeyName | undefined,
  result: MultitracksResult,
): KeyProposal {
  const chosenKey = result.best?.key;
  const kind = classifyProposal({ currentKey, result, chosenKey });
  return {
    trackId,
    trackTitle,
    trackArtist,
    currentKey,
    result,
    chosenKey,
    include: kind === 'new',
  };
}

const KIND_LABEL: Record<ProposalKind, string> = {
  new: 'New key',
  same: 'Already correct',
  relative: 'Relative major/minor',
  conflict: 'Differs from yours',
  ambiguous: 'Needs a look',
  none: 'No match',
};

const GROUP_ORDER: ProposalKind[] = ['conflict', 'ambiguous', 'relative', 'new', 'same', 'none'];

const GROUP_NOTE: Partial<Record<ProposalKind, string>> = {
  conflict: 'MultiTracks lists a different key than the one on your track. Check the ones you want to overwrite.',
  ambiguous: 'The catalog has this song in more than one key (live, radio and acoustic cuts often differ). Pick the release you actually use.',
  relative: 'MultiTracks publishes the key root only — it doesn\'t mark major vs minor. Your key sits at the same spot on the wheel, so it\'s probably already right.',
  new: 'These tracks had no key. Confident matches, checked by default.',
  same: 'Nothing to change — MultiTracks agrees with what you already have.',
  none: 'Not found in the MultiTracks catalog. Tag these by hand.',
};

function KeyChip({ k, dim }: { k: KeyName; dim?: boolean }) {
  const c = keyColor(k);
  return (
    <span
      className="mt-key-chip"
      style={{
        background: c.bg,
        color: c.fg,
        borderColor: c.fg,
        opacity: dim ? 0.55 : 1,
      }}
    >{k}</span>
  );
}

function MatchLine({ c }: { c: MultitracksCandidate }) {
  return (
    <a
      className="mt-match-line"
      href={c.url}
      target="_blank"
      rel="noreferrer"
      title={`Open on multitracks.com — ${c.album || 'single'}${c.durationSec ? ` · ${Math.round(c.durationSec)}s` : ''}`}
    >
      {c.artist} — {c.title} ↗
    </a>
  );
}

interface Props {
  open: boolean;
  proposals: KeyProposal[];
  /** Tracks that were scanned but produced nothing at all. */
  onChange: (next: KeyProposal[]) => void;
  onApply: () => void;
  onClose: () => void;
}

/**
 * Review sheet for a MultiTracks key scan. Nothing is written to the
 * library until the operator hits Apply — a batch import that silently
 * overwrote hand-tuned keys would be far worse than no feature at all.
 */
export function MultitracksKeyModal({ open, proposals, onChange, onApply, onClose }: Props) {
  const [collapsed, setCollapsed] = useState<Set<ProposalKind>>(new Set(['same', 'none']));
  const grouped = useMemo(() => {
    const m = new Map<ProposalKind, KeyProposal[]>();
    for (const p of proposals) {
      const kind = classifyProposal(p);
      const list = m.get(kind) ?? [];
      list.push(p);
      m.set(kind, list);
    }
    return m;
  }, [proposals]);

  // Early-out sits below the hooks so the hook order stays stable.
  if (!open) return null;

  const applyCount = proposals.reduce((n, p) => n + (p.include && p.chosenKey ? 1 : 0), 0);

  const setProposal = (trackId: string, patch: Partial<KeyProposal>) => {
    onChange(proposals.map(p => (p.trackId === trackId ? { ...p, ...patch } : p)));
  };

  const toggleGroup = (kind: ProposalKind, on: boolean) => {
    const ids = new Set((grouped.get(kind) ?? []).map(p => p.trackId));
    onChange(proposals.map(p => (
      ids.has(p.trackId) && p.chosenKey ? { ...p, include: on } : p
    )));
  };

  return (
    <div className="key-modal-backdrop" onClick={onClose}>
      <div className="mt-modal" onClick={e => e.stopPropagation()}>
        <div className="mt-modal-head">
          <div>
            <div className="key-modal-title">Keys from MultiTracks</div>
            <div className="mt-modal-sub">
              {proposals.length} track{proposals.length === 1 ? '' : 's'} checked ·
              {' '}nothing changes until you hit Apply
            </div>
          </div>
          <button className="mt-modal-x" onClick={onClose} title="Close without applying">✕</button>
        </div>

        <div className="mt-modal-body">
          {GROUP_ORDER.map(kind => {
            const rows = grouped.get(kind);
            if (!rows || rows.length === 0) return null;
            const isCollapsed = collapsed.has(kind);
            const selectable = kind !== 'same' && kind !== 'none';
            return (
              <section className="mt-group" key={kind}>
                <header className="mt-group-head">
                  <button
                    className="mt-group-toggle"
                    onClick={() => setCollapsed(prev => {
                      const next = new Set(prev);
                      if (next.has(kind)) next.delete(kind); else next.add(kind);
                      return next;
                    })}
                  >
                    {isCollapsed ? '▸' : '▾'} {KIND_LABEL[kind]}
                    <span className="mt-group-count">{rows.length}</span>
                  </button>
                  {selectable && !isCollapsed && (
                    <div className="mt-group-actions">
                      <button className="mt-mini" onClick={() => toggleGroup(kind, true)}>All</button>
                      <button className="mt-mini" onClick={() => toggleGroup(kind, false)}>None</button>
                    </div>
                  )}
                </header>
                {!isCollapsed && GROUP_NOTE[kind] && (
                  <p className="mt-group-note">{GROUP_NOTE[kind]}</p>
                )}
                {!isCollapsed && rows.map(p => {
                  // Every distinct key the catalog offered for this track.
                  const options: MultitracksCandidate[] = p.result.best
                    ? [p.result.best, ...p.result.alternates]
                    : [];
                  const chosen = options.find(o => o.key === p.chosenKey) ?? p.result.best;
                  return (
                    <div className={`mt-row ${p.include ? 'is-on' : ''}`} key={p.trackId}>
                      <label className="mt-row-check">
                        <input
                          type="checkbox"
                          checked={p.include}
                          // 'same' has nothing to write and 'none' has
                          // nothing to write it from.
                          disabled={!selectable || !p.chosenKey}
                          onChange={e => setProposal(p.trackId, { include: e.target.checked })}
                        />
                      </label>
                      <div className="mt-row-main">
                        <div className="mt-row-title">
                          {p.trackTitle}
                          {p.trackArtist && <span className="mt-row-artist"> · {p.trackArtist}</span>}
                        </div>
                        {chosen
                          ? <MatchLine c={chosen} />
                          : <div className="mt-row-reason">{p.result.reason ?? 'No match'}</div>}
                      </div>
                      <div className="mt-row-keys">
                        {p.currentKey && (
                          <>
                            <KeyChip k={p.currentKey} dim />
                            <span className="mt-arrow">→</span>
                          </>
                        )}
                        {options.length > 1 ? (
                          <div className="mt-key-options">
                            {options.map(o => (
                              <button
                                key={o.key}
                                className={`mt-key-option ${p.chosenKey === o.key ? 'active' : ''}`}
                                title={`${o.artist} — ${o.title}${o.album ? ` (${o.album})` : ''}`}
                                onClick={() => setProposal(p.trackId, { chosenKey: o.key })}
                              >
                                <KeyChip k={o.key} dim={p.chosenKey !== o.key} />
                              </button>
                            ))}
                          </div>
                        ) : (
                          p.chosenKey && <KeyChip k={p.chosenKey} />
                        )}
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>

        <div className="mt-modal-foot">
          <span className="mt-credit">Key data from multitracks.com</span>
          <div className="key-modal-actions">
            <button className="btn" onClick={onClose}>Cancel</button>
            <button
              className="btn-primary"
              disabled={applyCount === 0}
              onClick={onApply}
            >
              {applyCount === 0 ? 'Nothing selected' : `Apply ${applyCount} key${applyCount === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
