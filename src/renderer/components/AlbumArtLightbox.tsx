import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Full-screen lightbox for an album cover. Used by both the Live
 * "now playing" art and the Library mini-player art so the operator
 * can see the artwork at a useful size during a service. ESC and
 * backdrop click close it; clicking the image itself does not.
 *
 * Rendered via portal into document.body so parent overflow/stacking
 * contexts can't clip or hide it.
 */
interface Props {
  artUrl: string;
  title: string;
  meta?: string;
  onClose: () => void;
}

export function AlbumArtLightbox({ artUrl, title, meta, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="art-lightbox" onClick={onClose} role="dialog" aria-label="Album artwork">
      <button
        className="art-lightbox-close"
        onClick={onClose}
        aria-label="Close"
      >✕</button>
      <img
        className="art-lightbox-img"
        src={artUrl}
        alt=""
      />
      <div className="art-lightbox-caption" onClick={e => e.stopPropagation()}>
        <strong>{title}</strong>
        {meta && <span>{meta}</span>}
      </div>
    </div>,
    document.body,
  );
}
