// Polar view: the model's speed polar, auto-trimmed at every angle, against the ORC certificate's.
// Computed in Web Workers built from the model's own source (works from file:// too), else in the page.
(function (root) {
  'use strict';
  const ANGLES = [32, 36, 40, 44, 48, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180];
  const COLORS = { 4: '#9b8cff', 6: '#4aa3ff', 8: '#38c6d9', 10: '#3ad07a', 12: '#c6d93a', 14: '#ffc34d', 16: '#ff9a4d', 20: '#ff6a4d', 24: '#ff4d8a' };

  // One true wind speed's polar, angle by angle, each warm-started from the angle before.
  function job(M, msg, post) {
    M.setBoat(msg.loa);
    const KN = M.KN, warm = {};
    let guess = Math.min(6, 0.6 * msg.tws);
    msg.angles.forEach((twa, i) => {
      let best = { bs: 0 };
      for (const head of twa >= 75 ? ['jib', 'spin'] : ['jib']) {
        const start = warm[head] || Object.assign(M.defaultControls(), {
          head, mainsheet: twa > 90 ? 0.6 : 0.06, jibSheet: twa > 90 ? 0.7 : 0.1, spinSheet: 0.6,
          spinPole: Math.min(1, Math.max(0, (twa - 95) / 85)),
        });
        const env = { tws: msg.tws * KN, twa, bs: guess * KN };
        const c = M.autoTrim(Object.assign({}, start, { head }), env, { reefs: msg.tws >= 14 ? [0, 1, 2] : [0] });
        warm[head] = c;
        const s = M.steady(c, env, 100);
        if (s.bs > best.bs) best = { bs: s.bs, sail: (c.head === 'spin' ? 'spinnaker' : c.wing ? 'jib, winged' : 'jib') + (c.reef ? `, ${c.reef} reef${c.reef > 1 ? 's' : ''}` : ''), heel: s.heel };
      }
      guess = best.bs / KN;
      post({ tws: msg.tws, i, twa, bs: best.bs / KN, sail: best.sail, heel: best.heel });
    });
    post({ tws: msg.tws, done: true });
  }

  // A pool of workers; `run(tws, loa, onPoint)` queues one true wind speed.
  function pool() {
    const factory = root.SailModelFactory;
    let workers = [], ok = typeof Worker !== 'undefined' && !!factory;
    const n = Math.max(1, Math.min(6, (root.navigator && navigator.hardwareConcurrency) || 2));
    const queue = [], busy = new Map();
    if (ok) {
      try {
        const src = `${factory.toString()}\nconst M = SailModelFactory(self);\nconst job = ${job.toString()};\nonmessage = (e) => job(M, e.data, (m) => postMessage(m));\n`;
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        for (let i = 0; i < n; i++) workers.push(new Worker(url));
      } catch (e) { ok = false; workers = []; }
    }
    const M = root.SailModel;
    function pump() {
      for (const w of workers) {
        if (busy.has(w) || !queue.length) continue;
        const q = queue.shift(); busy.set(w, q);
        w.onmessage = (e) => { q.cb(e.data); if (e.data.done) { busy.delete(w); pump(); } };
        w.onerror = () => { busy.delete(w); fallback(q); };
        w.postMessage(q.msg);
      }
    }
    // In the page: one angle per tick so the animation keeps running.
    function fallback(q) {
      let i = 0;
      const tick = () => {
        if (i >= q.msg.angles.length) { q.cb({ tws: q.msg.tws, done: true }); return; }
        const saved = M.BOAT.loa;
        job(M, { tws: q.msg.tws, loa: q.msg.loa, angles: [q.msg.angles[i]] }, (m) => { if (!m.done) { m.i = i; q.cb(m); } });
        M.setBoat(saved); i++;
        setTimeout(tick, 30);
      };
      tick();
    }
    return {
      workers: workers.length,
      run(tws, loa, cb) {
        const q = { msg: { tws, loa, angles: ANGLES }, cb };
        if (ok) { queue.push(q); pump(); } else fallback(q);
      },
      stop() { queue.length = 0; workers.forEach((w) => w.terminate()); },
    };
  }

  // ORC certificate points of one true wind speed: the beat, the fixed angles and the run, by angle.
  function orcLine(O, tws) {
    const i = O.tws.indexOf(tws), D = Math.PI / 180;
    if (i < 0) return [];
    const pts = O.twa.map((a) => ({ twa: a, bs: O.speeds[a][i] }));
    pts.push({ twa: O.beatAngle[i], bs: O.beatVmg[i] / Math.cos(O.beatAngle[i] * D), vmg: 'beat' });
    pts.push({ twa: O.gybeAngle[i], bs: O.runVmg[i] / -Math.cos(O.gybeAngle[i] * D), vmg: 'run' });
    return pts.sort((a, b) => a.twa - b.twa);
  }

  // Each line's RMS error against ORC, in percent, at the angles both have.
  function rms(O, tws, model) {
    const i = O.tws.indexOf(tws), e = [];
    for (const p of model) if (p && O.speeds[p.twa]) e.push(p.bs / O.speeds[p.twa][i] - 1);
    return e.length ? 100 * Math.sqrt(e.reduce((a, x) => a + x * x, 0) / e.length) : null;
  }

  function draw(g, w, h, o) {
    const D = Math.PI / 180, O = o.orc;
    g.clearRect(0, 0, w, h);
    let max = 4;
    for (const t of o.selected) {
      for (const p of orcLine(O, t)) max = Math.max(max, p.bs);
      for (const p of o.model[t] || []) if (p) max = Math.max(max, p.bs);
    }
    if (o.live) max = Math.max(max, o.live.bs);
    max = Math.ceil(max + 0.3);
    const pad = 26, R = Math.min(w - pad * 2 - 150, (h - pad * 2) / 2), cx = pad + 8, cy = h / 2 + 6;
    const at = (twa, bs) => [cx + (bs / max) * R * Math.sin(twa * D), cy - (bs / max) * R * Math.cos(twa * D)];
    // grid
    g.strokeStyle = 'rgba(140,180,210,.18)'; g.fillStyle = '#7f9bb0'; g.font = '11px system-ui'; g.lineWidth = 1;
    for (let k = 1; k <= max; k++) {
      g.beginPath(); g.arc(cx, cy, (k / max) * R, -Math.PI / 2, Math.PI / 2); g.stroke();
      if (k % (max > 8 ? 2 : 1) === 0) g.fillText(k + ' kn', cx + 3, cy - (k / max) * R - 2);
    }
    for (let a = 0; a <= 180; a += 15) {
      const [x, y] = at(a, max);
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(x, y); g.stroke();
      if (a % 30 === 0 || a === 45 || a === 135) g.fillText(a + '°', x + (a > 0 && a < 180 ? 4 : -8), y + (a < 90 ? -2 : a === 90 ? 4 : 12));
    }
    g.fillText('wind', cx + 26, cy - R + 4);
    // lines
    const legend = [];
    for (const t of o.selected) {
      const col = COLORS[t] || '#fff', orc = orcLine(O, t), model = (o.model[t] || []).filter(Boolean).sort((a, b) => a.twa - b.twa);
      g.strokeStyle = col; g.fillStyle = col;
      g.setLineDash([5, 4]); g.lineWidth = 1.5; g.globalAlpha = o.orcDim ? 0.45 : 1;
      g.beginPath(); orc.forEach((p, i) => { const [x, y] = at(p.twa, p.bs); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      g.setLineDash([]);
      for (const p of orc) {
        const [x, y] = at(p.twa, p.bs);
        g.beginPath(); g.arc(x, y, p.vmg ? 4.5 : 2.5, 0, 7); p.vmg ? g.stroke() : g.fill();
      }
      g.globalAlpha = 1;
      if (model.length > 1) {
        g.lineWidth = 2.5; g.beginPath();
        model.forEach((p, i) => { const [x, y] = at(p.twa, p.bs); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.stroke();
        // the model's VMG-optimal angles, from the computed angles
        const up = model.filter((p) => p.twa < 90).reduce((a, p) => (p.bs * Math.cos(p.twa * D) > a.v ? { v: p.bs * Math.cos(p.twa * D), p } : a), { v: -1 }).p;
        const dn = model.filter((p) => p.twa > 90).reduce((a, p) => (-p.bs * Math.cos(p.twa * D) > a.v ? { v: -p.bs * Math.cos(p.twa * D), p } : a), { v: -1 }).p;
        for (const p of [up, dn]) if (p) { const [x, y] = at(p.twa, p.bs); g.beginPath(); g.moveTo(x, y - 7); g.lineTo(x - 5, y + 4); g.lineTo(x + 5, y + 4); g.closePath(); g.fill(); }
      }
      const n = (o.model[t] || []).filter(Boolean).length, err = rms(O, t, model);
      legend.push({ col, text: `${t} kn` + (n < ANGLES.length ? `  computing ${n}/${ANGLES.length}` : err != null ? `  model ${err.toFixed(1)}% RMS from ORC` : '') });
    }
    // live boat
    if (o.live) {
      const [x, y] = at(Math.abs(o.live.twa), o.live.bs);
      g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.font = '12px system-ui'; g.fillText(`you ${o.live.bs.toFixed(1)} kn in ${o.live.tws.toFixed(0)} kn`, x + 8, y + 4);
    }
    // legend
    g.font = '12px system-ui';
    let ly = 46;
    for (const l of legend) { g.fillStyle = l.col; g.fillRect(w - 230, ly - 9, 14, 3); g.fillText(l.text, w - 210, ly - 4); ly += 17; }
    g.fillStyle = '#9fb6c7';
    const notes = ['dashed, dots: ORC certificate, Catalina 30', 'rings: ORC VMG beat and run', `solid: model, auto-trimmed, ${o.loa} ft`, 'triangles: model VMG optimum'];
    if (o.orcDim) notes.push(`ORC is for ${o.baseLoa} ft: set Length to compare`);
    for (const t of notes) { g.fillText(t, w - 230, ly); ly += 15; }
  }

  const api = { ANGLES, COLORS, job, pool, orcLine, rms, draw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Polar = api;
})(typeof self !== 'undefined' ? self : this);
