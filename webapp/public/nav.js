// Arrow-key navigation between [data-nav] elements, so a keyboard or TV remote can drive the UI.

const DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

function score(from, to, dir) {
  const fx = from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  const tx = to.left + to.width / 2;
  const ty = to.top + to.height / 2;
  const dx = tx - fx;
  const dy = ty - fy;
  if (dir === 'left' && dx >= -1) return null;
  if (dir === 'right' && dx <= 1) return null;
  if (dir === 'up' && dy >= -1) return null;
  if (dir === 'down' && dy <= 1) return null;
  const horizontal = dir === 'left' || dir === 'right';
  const main = horizontal ? Math.abs(dx) : Math.abs(dy);
  const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
  // Staying in the same row (or column) matters more than being close
  return main + cross * (horizontal ? 4 : 0.6);
}

export function initNav(isEnabled) {
  document.addEventListener('keydown', e => {
    const dir = DIRS[e.key];
    if (!dir || !isEnabled() || e.altKey || e.metaKey || e.ctrlKey) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const all = [...document.querySelectorAll('[data-nav]')].filter(visible);
    if (!all.length) return;
    e.preventDefault();
    const current = document.activeElement;
    if (!current || !all.includes(current)) {
      focusEl(all[0], dir);
      return;
    }
    const from = current.getBoundingClientRect();
    let best = null;
    let bestScore = Infinity;
    for (const el of all) {
      if (el === current) continue;
      const s = score(from, el.getBoundingClientRect(), dir);
      if (s !== null && s < bestScore) {
        best = el;
        bestScore = s;
      }
    }
    if (best) focusEl(best, dir);
  });
}

export function focusEl(el, dir = 'down') {
  el.focus({ preventScroll: true });
  const vertical = dir === 'up' || dir === 'down';
  el.scrollIntoView({ block: vertical ? 'center' : 'nearest', inline: 'nearest', behavior: 'smooth' });
}
