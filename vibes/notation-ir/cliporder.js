// The playing order of an arrangement's clips as a row of chips, shared by StaffInk and
// ScoreShift: tap a chip to select its clip, drag it sideways to move it earlier or later.
// A clip that plays together with the one before it (withPrev) is shown joined to it.
// Browser only (DOM); the order itself is changed through arrangement.js moveClip.
import { COLORS } from './markers.js';
import { clipHue } from './arrangement.js';

/**
 * Render chips for arr.clips into `box` (replacing its content).
 *   selected       id of the selected clip
 *   onSelect(id)   a chip was tapped
 *   onMove(id, to) a chip was dropped at index `to`
 */
export function renderClipOrder(box, arr, { selected = null, onSelect, onMove } = {}) {
  box.textContent = '';
  const chips = arr.clips.map((c) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'clipchip'; b.dataset.clip = c.id;
    b.textContent = (c.withPrev ? '‖ ' : '') + c.name + (c.loop > 1 ? ` ×${c.loop}` : '');
    b.title = `Clip ${c.name}: tap to edit, drag sideways to play it earlier or later`;
    b.setAttribute('aria-pressed', String(c.id === selected));
    Object.assign(b.style, { background: COLORS[clipHue(c) % COLORS.length], color: '#fff', border: 'none', borderRadius: '999px', padding: '0 .7em', height: '1.9em', minWidth: '2.2em', marginLeft: c.withPrev ? '-2px' : '3px', fontWeight: '600', cursor: 'grab', touchAction: 'none', outline: c.id === selected ? '2px solid #111' : 'none', outlineOffset: '1px' });
    box.appendChild(b);
    return b;
  });
  chips.forEach((b, i) => {
    let drag = null;
    b.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      drag = { x: e.clientX, moved: false, to: i, mids: chips.map((q) => { const r = q.getBoundingClientRect(); return r.left + r.width / 2; }) };
      b.setPointerCapture(e.pointerId);
    });
    b.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 6) return;
      drag.moved = true;
      b.style.transform = `translateX(${dx}px)`; b.style.zIndex = '2'; b.style.cursor = 'grabbing';
      const x = drag.mids[i] + dx;
      drag.to = drag.mids.filter((m, k) => k !== i && m < x).length; // chips left of where it is now
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      b.style.transform = ''; b.style.zIndex = ''; b.style.cursor = 'grab';
      if (e.type === 'pointercancel') return;
      if (d.moved) { if (d.to !== i) onMove?.(arr.clips[i].id, d.to); } else onSelect?.(arr.clips[i].id);
    };
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    b.addEventListener('click', (e) => e.stopPropagation());
  });
  return chips;
}
