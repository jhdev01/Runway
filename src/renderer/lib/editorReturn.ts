/**
 * "Back" from the Editor to exactly where the operator came from: the
 * screen, and how far each list on it was scrolled. Screens rebuild when
 * you leave them, so the scroll positions are noted when the Editor opens
 * and put back after returning.
 */

interface SavedScroll { sig: string; nth: number; top: number }
let saved: SavedScroll[] = [];

const sigOf = (el: Element) => `${el.tagName}.${[...el.classList].sort().join('.')}`;

function scrollables(): Element[] {
  const root = document.querySelector('.view-container');
  if (!root) return [];
  return [root, ...root.querySelectorAll('*')].filter(el => el.scrollHeight > el.clientHeight + 1);
}

/** Note every scrolled list on the current screen (call before leaving it). */
export function rememberScroll(): void {
  const seen = new Map<string, number>();
  saved = [];
  for (const el of scrollables()) {
    const sig = sigOf(el);
    const nth = seen.get(sig) ?? 0;
    seen.set(sig, nth + 1);
    if (el.scrollTop > 0) saved.push({ sig, nth, top: el.scrollTop });
  }
}

/** Put the noted scroll positions back (call after returning to the screen). */
export function restoreScroll(): void {
  if (saved.length === 0) return;
  const want = saved;
  const apply = () => {
    const seen = new Map<string, number>();
    for (const el of scrollables()) {
      const sig = sigOf(el);
      const nth = seen.get(sig) ?? 0;
      seen.set(sig, nth + 1);
      const s = want.find(x => x.sig === sig && x.nth === nth);
      if (s) el.scrollTop = s.top;
    }
  };
  // Lists can fill in a moment later (artwork, playlist loads): try a few times.
  for (const ms of [0, 60, 250, 600]) window.setTimeout(apply, ms);
}
