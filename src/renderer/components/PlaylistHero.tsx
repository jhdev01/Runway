import React from 'react';

/**
 * Playlist header (new look): artwork, eyebrow, big title, the numbers in
 * one line, and the playlist's buttons on the right. Display only.
 */
export interface HeroStat { value: React.ReactNode; label?: string; tone?: 'good' | 'warn' | 'dim' }

export function PlaylistHero({ arts, eyebrow, eyebrowTone, title, stats, actions, color }: {
  arts: (string | undefined)[];
  eyebrow: React.ReactNode;
  eyebrowTone?: 'spotify' | 'accent';
  title: React.ReactNode;
  stats: HeroStat[];
  actions?: React.ReactNode;
  color?: string;
}) {
  const pics = arts.filter((a): a is string => !!a);
  const uniq = [...new Set(pics)].slice(0, 4);
  return (
    <header className="pl-hero">
      <div className="pl-hero-art" style={color ? { background: color } : undefined} aria-hidden>
        {uniq.length >= 4
          ? uniq.map(a => <img key={a} src={a} alt="" />)
          : uniq.length > 0
            ? <img className="single" src={uniq[0]} alt="" />
            : <span>♪</span>}
      </div>
      <div className="pl-hero-text">
        <div className={`pl-hero-eyebrow ${eyebrowTone ?? 'accent'}`}>{eyebrow}</div>
        <div className="pl-hero-title">{title}</div>
        <div className="pl-hero-stats">
          {stats.map((s, i) => (
            <span key={i} className={s.tone ? `tone-${s.tone}` : undefined}>
              <strong>{s.value}</strong>{s.label ? ` ${s.label}` : ''}
            </span>
          ))}
        </div>
      </div>
      {actions && <div className="pl-hero-actions">{actions}</div>}
    </header>
  );
}
