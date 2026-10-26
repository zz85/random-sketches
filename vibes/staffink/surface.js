// StaffInk's engraved page as a notation-ir surface (../notation-ir/surface.js): systems are the
// lines, events are found through the layout, in staff spaces. Pure, so it runs under bun.
// Ids are StaffInk event ids, or IR ids ('si12') for the same events.

const num = (id) => (typeof id === 'number' ? id : Number(String(id).replace(/^si/, '')));
const center = (p) => (p.hw ? p.x + p.hw / 2 : (p.bbox.x0 + p.bbox.x1) / 2);

/** L = layoutScore(...); view() -> { X, Y, sp } for the current scroll and scale. */
export function engravedSurface(L, view) {
  const lines = L.systems.map((sys) => ({ x0: sys.x0, x1: sys.x1, top: sys.staffTops[0], bottom: sys.staffTops[sys.staffTops.length - 1] + 4 }));
  const pos = (id) => L.evPos.get(num(id));
  const measureOf = (p) => (L.measures[p.mi]?.mi === p.mi ? L.measures[p.mi] : L.measures.find((m) => m.mi === p.mi));
  /** The system nearest a point (distance outside its staves, with a little reach). */
  const systemAt = (pt, reach = 3) => {
    let sys = null, sd = Infinity;
    for (const s of L.systems) { const t = s.staffTops[0] - reach, b = s.staffTops[s.staffTops.length - 1] + 4 + reach; const d = pt.y < t ? t - pt.y : pt.y > b ? pt.y - b : 0; if (d < sd) { sd = d; sys = s; } }
    return sys;
  };
  return {
    kind: 'engraved', space: 1, view,
    lines: () => lines,
    place(id, edge = 'start') {
      const p = pos(id); if (!p) return [];
      return [{ line: p.sys, x: edge === 'end' ? p.bbox.x1 + 0.35 : edge === 'center' ? center(p) : p.bbox.x0 - 0.25, top: p.top }];
    },
    eventAt(pt, reach = 3) {
      const sys = systemAt(pt, reach); if (!sys) return null;
      let best = null, bd = Infinity;
      for (const [id, e] of L.evPos) {
        if (e.sys !== sys.index) continue;
        const d = Math.abs((e.bbox.x0 + e.bbox.x1) / 2 - pt.x) + 0.05 * Math.abs(e.top + 2 - pt.y);
        if (d < bd) { bd = d; best = id; }
      }
      return best;
    },
    barOf(id) { const p = pos(id), m = p && measureOf(p); return m ? { key: m.mi, line: m.sys, x: m.x1 - 0.15 } : null; },
    barAt(pt) {
      const sys = systemAt(pt, 0); if (!sys) return null;
      const m = L.measures.find((q) => q.sys === sys.index && pt.x >= q.x0 && pt.x < q.x1); if (!m) return null;
      const ids = [...L.evPos].filter(([, e]) => e.mi === m.mi).sort((a, b) => a[1].x - b[1].x).map(([id]) => id);
      return ids.length ? { first: ids[0], last: ids[ids.length - 1] } : null;
    },
  };
}
