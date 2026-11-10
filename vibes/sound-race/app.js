// Sound Race: the page. Drawing, input, the race loop and the debrief; the physics and the AI are in sim.js.
(function () {
  'use strict';
  const S = self.SoundSim, DATA = self.SOUND_DAYS, D = S.D, KN = S.KN;
  const $ = (id) => document.getElementById(id);
  const land = S.makeLand(self.SOUND_LAND), polar = S.makePolar(self.SOUND_POLAR);
  const SPEEDS = [1, 2, 4, 8, 16, 32];
  const COLORS = { me: '#ff7a59', shifts: '#7fd4ff', current: '#b9f07a', middle: '#e7b6ff' };
  const DT = 0.5; // simulation step, s
  const params = new URLSearchParams(location.search);

  // ---- Setup -----------------------------------------------------------------------------------------
  DATA.days.forEach((d, i) => {
    const o = document.createElement('option'); o.value = i;
    const local = new Date(d.start - 7 * 3600e3); // the race windows are PDT
    o.textContent = `${d.label}: ${local.toISOString().slice(0, 10)} ${String(local.getUTCHours()).padStart(2, '0')}:00`;
    $('day').appendChild(o);
  });
  if (params.has('day')) $('day').value = params.get('day');
  if (params.has('leg')) $('leg').value = params.get('leg');
  if (params.has('laps')) $('laps').value = params.get('laps');
  SPEEDS.forEach((s, i) => { const b = document.createElement('button'); b.textContent = s + 'x'; b.onclick = () => setSpeed(i); $('speeds').appendChild(b); });
  $('sources').textContent = DATA.source + ' Coastline: ' + self.SOUND_LAND.source + '. Boat: ' + self.SOUND_POLAR.source + '.';

  let G = null; // the game
  function newGame() {
    const day = DATA.days[+$('day').value], legNm = +$('leg').value, laps = +$('laps').value;
    const wind = S.makeWind(day, land), cur = S.makeCurrent(day, DATA.stations, land);
    const course = S.makeCourse(wind.record(day.start).dir, legNm, land, { laps });
    const race = S.newRace(course, { countdown: 180 });
    const me = { name: 'You', key: 'me', b: S.newBoat(Object.assign(course.fromCourse(-300, 300), { hdg: S.wrap(course.axis - 45), bs: 3 })), e: S.newEntry('You'), track: [] };
    const boats = [me];
    if ($('rivals').checked) for (const k of Object.keys(S.STYLES)) {
      const ai = S.newAI(k, Object.assign(course.fromCourse(-250, S.STYLES[k].spot), { hdg: S.wrap(course.axis - 45) }));
      boats.push({ name: S.STYLES[k].name, key: k, ai, b: ai.b, e: S.newEntry(k), track: [] });
    }
    G = {
      day, wind, cur, course, race, boats, me, tg: -race.countdown, acc: 0, paused: false, speed: G ? G.speed : 0,
      env: { wind, current: cur, land, t: day.start - race.countdown * 1000, tGun: -race.countdown },
      helm: { mode: 'vmg', board: 1, twa: 45 }, msg: [], msgUntil: 0,
      view: { mpp: 3.2, follow: true, cx: 0, cy: 0 },
      stats: { up: 0, lifted: 0, headed: 0, curGain: 0, dirs: [], onLayFor: 0 },
      done: false,
    };
    const s = day.summary;
    $('day-info').textContent = `Mean ${s.spd} kn from ${s.dir}°, spread ${s.sd}°, ${s.trend > 0 ? 'veering' : 'backing'} ${Math.abs(s.trend)}° over the race window. Course ${course.axis.toFixed(0)}°, ${legNm} nm legs, ${laps} lap${laps > 1 ? 's' : ''}.`;
    $('results').textContent = 'Three minutes to the gun. Get to the line, start on starboard, windward mark to port.';
    $('debrief').innerHTML = '';
    say('Three minutes to the start. Luff with ← → to hold back, cross the line after the gun.', 6);
    drawStrip();
  }
  function setSpeed(i) { if (G) G.speed = i; [...$('speeds').children].forEach((b, j) => b.classList.toggle('on', j === i)); }
  function say(text, secs) { if (G) { G.msg = text; G.msgUntil = performance.now() + (secs || 4) * 1000; } }

  // ---- Helm ------------------------------------------------------------------------------------------
  const isUpwind = (e) => { const l = G.race.legs[e.leg]; return l === 'start' || l === 'W'; };
  function helmStep() {
    const b = G.me.b, w = G.wind.at(b.x, b.y, G.env.t), h = G.helm;
    if (h.mode === 'vmg') {
      const o = polar.optimum(w.spd), a = isUpwind(G.me.e) ? o.up.a : o.dn.a;
      b.turnTo = S.wrap(w.dir - a * h.board);
    } else b.turnTo = S.wrap(w.dir - h.twa);
  }
  function steer(deg) {
    const h = G.helm, b = G.me.b;
    if (h.mode === 'vmg') { h.mode = 'twa'; h.twa = S.twaOf(b.turnTo != null ? b.turnTo : b.hdg, b.twd != null ? b.twd : G.course.axis); }
    // Turning left lowers the heading, which raises the wind angle (wind minus heading).
    h.twa = S.angDiff(h.twa + deg, 0); h.board = h.twa >= 0 ? 1 : -1;
  }
  function tackOrGybe() {
    const h = G.helm;
    if (h.mode === 'vmg') h.board = -h.board;
    else { h.twa = -h.twa; h.board = h.twa >= 0 ? 1 : -1; }
  }
  function vmgMode() { const h = G.helm; h.mode = 'vmg'; h.board = S.twaOf(G.me.b.hdg, G.me.b.twd || G.course.axis) >= 0 ? 1 : -1; }

  // ---- Step ------------------------------------------------------------------------------------------
  function stepGame(dt) {
    const g = G, gunBefore = g.tg;
    g.tg += dt; g.env.tGun = g.tg; g.env.t = g.day.start + g.tg * 1000;
    for (const B of g.boats) {
      const p0 = { x: B.b.x, y: B.b.y };
      if (B.ai) S.aiStep(B.ai, g.env, polar, g.race, B.e, dt);
      else { helmStep(); S.stepBoat(B.b, g.env, polar, dt); }
      if (gunBefore < 0 && g.tg >= 0 && g.course.toCourse(B.b).s > 0) B.e.ocs = true;
      const ev = S.advance(g.race, B.e, p0, B.b, g.tg);
      if (B === g.me) for (const e of ev) onEvent(e);
      if (!B.lastT || g.tg - B.lastT >= 5) { B.track.push([B.b.x, B.b.y]); B.lastT = g.tg; if (B.track.length > 3000) B.track.shift(); }
    }
    if (gunBefore < -60 && g.tg >= -60) say('One minute.');
    if (gunBefore < -10 && g.tg >= -10) say('Ten seconds.');
    if (gunBefore < 0 && g.tg >= 0) say(g.me.e.ocs ? 'OCS: you were over the line at the gun. Dip back below it and start again.' : 'Start!', 5);
    if (g.me.b.aground) say('Aground! Steer back toward open water.', 2);
    trackStats(dt);
    if (!g.done && g.boats.every((B) => B.e.finish != null || (B !== g.me && g.me.e.finish != null && g.tg > g.me.e.finish + 1800))) finishRace();
  }
  function onEvent(e) {
    const msgs = { started: 'Started. Windward mark to port: leave it on your left.', cleared: 'Back below the line: now start.', roundedW: 'Rounded the windward mark. Bear away for the gate.', roundedG: 'Through the gate. Up the next beat.', finished: 'Finished!' };
    if (msgs[e]) say(msgs[e], 4);
    if (e === 'finished') { G.me.e.finishWall = performance.now(); showResults(); }
  }
  function trackStats(dt) {
    const g = G, b = g.me.b, st = g.stats;
    if (g.tg < 0 || g.me.e.finish != null || b.twd == null) return;
    const w = { dir: b.twd };
    st.dirs.push(w.dir); if (st.dirs.length > 360 / DT) st.dirs.shift();
    let su = 0, cu = 0; for (const d of st.dirs) { su += Math.sin(d * D); cu += Math.cos(d * D); }
    const mean = S.wrap(Math.atan2(su, cu) / D), shift = S.angDiff(w.dir, mean);
    st.shift = shift;
    if (isUpwind(g.me.e) && g.me.e.started != null) {
      st.up += dt;
      const onStb = b.twa >= 0, lifted = onStb ? shift > 2 : shift < -2, headed = onStb ? shift < -2 : shift > 2;
      if (lifted) st.lifted += dt; if (headed) st.headed += dt;
    }
    const m = nextMark(g.me.e);
    if (m && b.cur) { const brg = Math.atan2(m.x - b.x, m.y - b.y); st.curGain += (b.cur.u * Math.sin(brg) + b.cur.v * Math.cos(brg)) * KN * dt; }
  }
  function nextMark(e) {
    const C = G.course, leg = G.race.legs[e.leg];
    if (leg === 'W') return C.windward;
    if (leg === 'G') return { x: (C.gate[0].x + C.gate[1].x) / 2, y: (C.gate[0].y + C.gate[1].y) / 2, name: 'gate' };
    return { x: (C.pin.x + C.committee.x) / 2, y: (C.pin.y + C.committee.y) / 2 };
  }
  // Progress for the standings: legs done, then distance left to the next mark.
  function progress(B) {
    if (B.e.finish != null) return 1e9 - B.e.finish;
    const m = nextMark(B.e); return B.e.leg * 1e5 - Math.hypot(m.x - B.b.x, m.y - B.b.y);
  }

  // ---- Results ---------------------------------------------------------------------------------------
  const fmt = (s) => { if (s == null || !isFinite(s)) return '-'; const n = Math.max(0, Math.round(s)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
  function orcTime() {
    const o = polar.optimum(G.day.summary.spd), C = G.course;
    return C.laps * (C.L / (o.up.v * KN) + C.L / (o.dn.v * KN));
  }
  function showResults() {
    const rows = G.boats.slice().sort((a, b) => progress(b) - progress(a));
    const best = Math.min(...G.boats.filter((B) => B.e.finish != null).map((B) => B.e.finish));
    $('results').innerHTML = '<table><tr><th>#</th><th>Boat</th><th>Elapsed</th><th>Behind</th><th>Tacks</th><th>Gybes</th></tr>' + rows.map((B, i) =>
      `<tr class="${B === G.me ? 'me' : ''}"><td>${i + 1}</td><td><span style="color:${COLORS[B.key]}">■</span> ${B.name}</td><td>${B.e.finish != null ? fmt(B.e.finish) : 'racing'}</td><td>${B.e.finish != null && B.e.finish > best ? '+' + fmt(B.e.finish - best) : ''}</td><td>${B.b.tacks}</td><td>${B.b.gybes}</td></tr>`).join('') + '</table>';
    const st = G.stats, me = G.me, el = me.e.finish;
    if (el == null) return;
    const orc = orcTime(), up = Math.max(st.up, 1);
    $('debrief').innerHTML = `
      <p>Your time ${fmt(el)} from the gun${me.e.started != null ? `, started ${Math.round(me.e.started)} s after it` : ''}. ORC VMG time for this course at the day's mean wind: ${fmt(orc)} (${(el / orc * 100).toFixed(0)}%).</p>
      <p>Upwind on the lifted board ${(st.lifted / up * 100).toFixed(0)}% of the time, on the headed board ${(st.headed / up * 100).toFixed(0)}% (shifts over 2° against your last 3 minutes' mean).</p>
      <p>Current ${st.curGain >= 0 ? 'carried you' : 'held you back'} ${Math.abs(st.curGain).toFixed(0)} m toward the marks; sailed ${(me.b.dist / 1852).toFixed(2)} nm over the ground for ${(2 * G.course.laps * G.course.legNm).toFixed(1)} nm of course.</p>`;
  }
  function finishRace() { G.done = true; showResults(); }

  // ---- Drawing ---------------------------------------------------------------------------------------
  const cv = $('cv'), ctx = cv.getContext('2d');
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    const r = $('map').getBoundingClientRect(); W = r.width; H = r.height;
    cv.width = W * DPR; cv.height = H * DPR;
    const s = $('strip').getBoundingClientRect(); $('sc').width = s.width * DPR; $('sc').height = s.height * DPR;
    drawStrip();
  }
  window.addEventListener('resize', resize);
  const landPath = new Path2D();
  for (const p of land.polys) for (const r of p) { r.forEach(([x, y], i) => (i ? landPath.lineTo(x, y) : landPath.moveTo(x, y))); landPath.closePath(); }

  // World (x east, y north, m) to screen: course up (or north up), centred on the view's centre.
  function viewXf() {
    const v = G.view, ax = ($('s-north').checked ? 0 : G.course.axis) * D, k = 1 / v.mpp;
    const a = k * Math.cos(ax), b = -k * Math.sin(ax), c = -k * Math.sin(ax), d = -k * Math.cos(ax);
    return { a, b, c, d, e: W / 2 - (a * v.cx + c * v.cy), f: H / 2 - (b * v.cx + d * v.cy), ax, k };
  }
  const toS = (T, x, y) => [T.a * x + T.c * y + T.e, T.b * x + T.d * y + T.f];
  const toW = (T, X, Y) => { const det = T.a * T.d - T.b * T.c, x0 = X - T.e, y0 = Y - T.f; return [(T.d * x0 - T.c * y0) / det, (-T.b * x0 + T.a * y0) / det]; };
  const scrAng = (T, hdg) => (hdg * D - T.ax); // a heading as a screen angle from up, clockwise

  function draw() {
    if (!G) return;
    const g = G, v = g.view;
    if (v.follow) { v.cx = g.me.b.x; v.cy = g.me.b.y; }
    const T = viewXf();
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#123a55'; ctx.fillRect(0, 0, W, H);
    const rec = g.wind.record(g.env.t);
    if ($('s-puffs').checked) {
      const step = 28;
      for (let Y = 0; Y < H; Y += step) for (let X = 0; X < W; X += step) {
        const [x, y] = toW(T, X + step / 2, Y + step / 2);
        if (land.isLand(x, y)) continue;
        const w = g.wind.at(x, y, g.env.t), r = w.spd / Math.max(rec.spd, 0.5) - 1;
        ctx.fillStyle = r > 0 ? `rgba(5,20,45,${Math.min(0.55, r * 1.6)})` : `rgba(160,200,225,${Math.min(0.3, -r * 1.1)})`;
        ctx.fillRect(X, Y, step, step);
      }
      // Wind direction ticks
      ctx.strokeStyle = 'rgba(220,240,255,0.25)'; ctx.lineWidth = 1;
      for (let Y = 40; Y < H; Y += 110) for (let X = 40; X < W; X += 110) {
        const [x, y] = toW(T, X, Y); if (land.isLand(x, y)) continue;
        const w = g.wind.at(x, y, g.env.t), a = scrAng(T, w.dir + 180), L = 8 + w.spd * 1.2;
        ctx.beginPath(); ctx.moveTo(X - Math.sin(a) * L / 2, Y + Math.cos(a) * L / 2); ctx.lineTo(X + Math.sin(a) * L / 2, Y - Math.cos(a) * L / 2); ctx.stroke();
      }
    }
    // Land
    ctx.setTransform(T.a * DPR, T.b * DPR, T.c * DPR, T.d * DPR, T.e * DPR, T.f * DPR);
    ctx.fillStyle = '#2e3d2c'; ctx.fill(landPath, 'evenodd');
    ctx.strokeStyle = '#7f9a6e'; ctx.lineWidth = 1.2 * v.mpp; ctx.stroke(landPath);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if ($('s-cur').checked) {
      ctx.strokeStyle = 'rgba(90,230,230,0.75)'; ctx.fillStyle = 'rgba(90,230,230,0.75)'; ctx.lineWidth = 1.5;
      for (let Y = 70; Y < H; Y += 140) for (let X = 70; X < W; X += 140) {
        const [x, y] = toW(T, X, Y); if (land.isLand(x, y)) continue;
        const c = g.cur.at(x, y, g.env.t); if (c.spd < 0.05) continue;
        arrow(X, Y, scrAng(T, c.dir), 14 + c.spd * 45, `${c.spd.toFixed(1)}`);
      }
    }
    const C = g.course;
    if ($('s-tracks').checked) for (const B of g.boats) {
      if (B.track.length < 2) continue;
      ctx.strokeStyle = COLORS[B.key] + (B === g.me ? 'cc' : '77'); ctx.lineWidth = B === g.me ? 1.6 : 1;
      ctx.beginPath(); B.track.forEach(([x, y], i) => { const [X, Y] = toS(T, x, y); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      const [X, Y] = toS(T, B.b.x, B.b.y); ctx.lineTo(X, Y); ctx.stroke();
    }
    // Laylines to the player's next mark, from the wind and current there.
    if ($('s-lay').checked && g.me.e.finish == null) {
      const leg = g.race.legs[g.me.e.leg], up = leg === 'start' || leg === 'W', m = up ? C.windward : nextMark(g.me.e);
      const w = g.wind.at(m.x, m.y, g.env.t), c = g.cur.at(m.x, m.y, g.env.t), L = S.laylines(polar, w, c, up);
      ctx.setLineDash([8, 6]); ctx.lineWidth = 1.2;
      for (const [brg, col] of [[L.stb, 'rgba(120,255,140,0.8)'], [L.port, 'rgba(255,110,110,0.8)']]) {
        const [X0, Y0] = toS(T, m.x, m.y), [X1, Y1] = toS(T, m.x + Math.sin(brg * D) * 4000, m.y + Math.cos(brg * D) * 4000);
        ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(X0, Y0); ctx.lineTo(X1, Y1); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    // Course: start/finish line, windward mark, gate
    const [px, py] = toS(T, C.pin.x, C.pin.y), [cx, cy] = toS(T, C.committee.x, C.committee.y);
    ctx.strokeStyle = g.tg < 0 ? '#ffd24d' : 'rgba(255,210,77,0.6)'; ctx.setLineDash([5, 5]); ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(cx, cy); ctx.stroke(); ctx.setLineDash([]);
    mark(px, py, '#ffd24d', 4); ctx.fillStyle = '#e8e8e8'; ctx.save(); ctx.translate(cx, cy); ctx.rotate(scrAng(T, C.axis)); ctx.fillRect(-4, -9, 8, 18); ctx.restore();
    const [wx, wy] = toS(T, C.windward.x, C.windward.y); mark(wx, wy, '#ff9a3c', 6);
    for (const q of C.gate) { const [X, Y] = toS(T, q.x, q.y); mark(X, Y, '#ffd24d', 5); }
    // Boats
    for (const B of g.boats.slice().reverse()) drawBoat(T, B);
    // Wind indicator, top right
    const a = scrAng(T, rec.dir + 180);
    ctx.save(); ctx.translate(W - 46, 46); ctx.fillStyle = '#0b1a26aa'; ctx.beginPath(); ctx.arc(0, 0, 34, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = '#dbe8f2'; ctx.fillStyle = '#dbe8f2'; ctx.lineWidth = 2; arrow(0, 0, a, 46, '');
    ctx.fillStyle = '#86a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(`${rec.spd.toFixed(0)} kn ${rec.dir.toFixed(0)}°`, 0, 30);
    ctx.restore();
    // Scale bar
    const m200 = 200 / v.mpp; ctx.strokeStyle = '#86a3b8'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(12, H - 64); ctx.lineTo(12 + m200, H - 64); ctx.stroke();
    ctx.fillStyle = '#86a3b8'; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.fillText('200 m', 12, H - 68);
  }
  function arrow(X, Y, a, L, label) {
    const ex = X + Math.sin(a) * L / 2, ey = Y - Math.cos(a) * L / 2, sx = X - Math.sin(a) * L / 2, sy = Y + Math.cos(a) * L / 2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - Math.sin(a - 0.45) * 6, ey + Math.cos(a - 0.45) * 6); ctx.lineTo(ex - Math.sin(a + 0.45) * 6, ey + Math.cos(a + 0.45) * 6); ctx.closePath(); ctx.fill();
    if (label) { ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.fillText(label, X + 6, Y + 12); }
  }
  function mark(X, Y, col, r) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(X, Y, r, 0, 2 * Math.PI); ctx.fill(); ctx.strokeStyle = '#0008'; ctx.lineWidth = 1; ctx.stroke(); }
  function drawBoat(T, B) {
    const b = B.b, [X, Y] = toS(T, b.x, b.y), k = Math.max(1 / G.view.mpp, 1.4), L = 9 * k, Bm = 3.2 * k;
    ctx.save(); ctx.translate(X, Y); ctx.rotate(scrAng(T, b.hdg));
    ctx.fillStyle = COLORS[B.key]; ctx.strokeStyle = '#0b1a26'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, -L / 2); ctx.quadraticCurveTo(Bm, -L / 6, Bm * 0.7, L / 2); ctx.lineTo(-Bm * 0.7, L / 2); ctx.quadraticCurveTo(-Bm, -L / 6, 0, -L / 2); ctx.fill(); ctx.stroke();
    // Sail: the boom swings to leeward, about half the wind angle off the centreline.
    // Sail: the boom swings to leeward (to port with the wind on starboard), about half the wind angle off the centreline.
    const twa = b.twa || 0, bo = Math.min(85, Math.max(8, Math.abs(twa) / 2)) * D, side = twa >= 0 ? -1 : 1;
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(0, -L * 0.1); ctx.lineTo(side * Math.sin(bo) * L * 0.55, -L * 0.1 + Math.cos(bo) * L * 0.55); ctx.stroke();
    const sail = b.tws ? polar.sail(b.tws, twa) : 'j';
    if (sail === 's' && Math.abs(twa) > 80) { ctx.fillStyle = 'rgba(255,90,90,0.75)'; ctx.beginPath(); ctx.ellipse(side * L * 0.2, -L * 0.75, L * 0.38, L * 0.22, 0, 0, 2 * Math.PI); ctx.fill(); }
    ctx.restore();
    // Labels stack by boat so a close fleet stays readable.
    const i = G.boats.indexOf(B);
    if (B !== G.me || G.view.mpp > 6) { ctx.fillStyle = COLORS[B.key]; ctx.font = '11px system-ui'; ctx.textAlign = 'left'; ctx.fillText(B.name + (B.e.ocs ? ' OCS' : ''), X + 9, Y - 6 + (i - 1) * 12); }
  }

  // Strip: the day's wind record (speed and direction) and the current along the course, with now and the gun marked.
  function drawStrip() {
    if (!G) return;
    const sc = $('sc'), c = sc.getContext('2d'), w = sc.width / DPR, h = sc.height / DPR;
    c.setTransform(DPR, 0, 0, DPR, 0, 0); c.clearRect(0, 0, w, h);
    const wd = G.day.wind, n = wd.spd.length, t0 = wd.t, t1 = wd.t + (n - 1) * wd.dt * 1000;
    const X = (t) => 40 + (t - t0) / (t1 - t0) * (w - 50);
    const maxS = Math.max(...wd.spd, ...wd.gst.filter((x) => x != null)) * 1.1;
    const mean = G.day.summary.dir;
    c.fillStyle = 'rgba(255,210,77,0.08)'; c.fillRect(X(G.day.start), 0, X(G.day.start + G.day.hours * 3600e3) - X(G.day.start), h);
    c.font = '10px system-ui'; c.fillStyle = '#86a3b8'; c.textAlign = 'left';
    c.fillText('wind kn', 2, 12); c.fillText('dir', 2, h / 2 + 10); c.fillText('tide', 2, h - 6);
    c.strokeStyle = '#5fb4ff'; c.lineWidth = 1.5; c.beginPath();
    wd.spd.forEach((s, i) => { const x = X(t0 + i * wd.dt * 1000), y = h / 2 - 4 - s / maxS * (h / 2 - 10); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
    c.strokeStyle = 'rgba(95,180,255,0.35)'; c.beginPath();
    wd.gst.forEach((s, i) => { if (s == null) return; const x = X(t0 + i * wd.dt * 1000), y = h / 2 - 4 - s / maxS * (h / 2 - 10); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
    // Direction against the mean, +-40 deg
    c.strokeStyle = '#ffc34d'; c.beginPath();
    wd.dir.forEach((d, i) => { const x = X(t0 + i * wd.dt * 1000), y = h * 0.62 + S.clamp(S.angDiff(d, mean), -40, 40) / 40 * h * 0.12; i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.stroke();
    // Current along the course axis at its middle (+ helps upwind)
    const mid = G.course.fromCourse(G.course.L / 2, 0);
    c.strokeStyle = '#5ae6e6'; c.beginPath();
    for (let t = t0, i = 0; t <= t1; t += 300e3, i++) {
      const k = G.cur.at(mid.x, mid.y, t), along = k.u * Math.sin(G.course.axis * D) + k.v * Math.cos(G.course.axis * D);
      const y = h - 14 - along * 8; i ? c.lineTo(X(t), y) : c.moveTo(X(t), y);
    }
    c.stroke(); c.strokeStyle = 'rgba(90,230,230,0.25)'; c.beginPath(); c.moveTo(40, h - 14); c.lineTo(w - 10, h - 14); c.stroke();
    const now = X(G.env.t); c.strokeStyle = '#ff7a59'; c.lineWidth = 2; c.beginPath(); c.moveTo(now, 0); c.lineTo(now, h); c.stroke();
    c.fillStyle = '#dbe8f2'; c.textAlign = 'right';
    c.fillText('10-minute means at West Point; yellow: direction against the race mean; cyan: current up the course', w - 6, 12);
  }

  // ---- HUD -------------------------------------------------------------------------------------------
  function hud() {
    const g = G, b = g.me.b, e = g.me.e;
    const local = new Date(g.env.t - 7 * 3600e3);
    $('r-clock').textContent = local.toISOString().slice(11, 19);
    const leg = g.race.legs[e.leg];
    let race;
    if (g.tg < 0) race = 'Start in ' + fmt(-g.tg);
    else if (e.finish != null) race = 'Finished ' + fmt(e.finish);
    else race = (e.ocs ? 'OCS ' : '') + ({ start: 'Start', W: 'Beat', G: 'Run', F: 'Run to finish' }[leg]) + ' ' + fmt(g.tg);
    $('r-race').textContent = race;
    $('ro-race').className = 'ro' + (e.ocs ? ' bad' : g.tg < 0 && g.tg > -30 ? ' warn' : '');
    $('r-bs').textContent = `${b.bs.toFixed(1)} / ${(b.sog || 0).toFixed(1)}`;
    $('r-wind').textContent = b.twd != null ? `${b.tws.toFixed(1)} kn ${b.twd.toFixed(0)}° TWA ${Math.abs(b.twa).toFixed(0)}${b.twa >= 0 ? 'S' : 'P'}` : '-';
    const sh = g.stats.shift;
    if (sh != null && isUpwind(e)) {
      const onStb = b.twa >= 0, lift = onStb ? sh : -sh;
      $('r-shift').textContent = Math.abs(lift) < 2 ? 'mean' : `${lift > 0 ? 'lifted' : 'headed'} ${Math.abs(lift).toFixed(0)}°`;
      $('ro-shift').className = 'ro' + (lift > 2 ? ' good' : lift < -2 ? ' bad' : '');
    } else { $('r-shift').textContent = sh != null ? `${sh > 0 ? 'veer' : 'back'} ${Math.abs(sh).toFixed(0)}°` : '-'; $('ro-shift').className = 'ro'; }
    $('r-cur').textContent = b.cur ? `${b.cur.spd.toFixed(1)} kn to ${b.cur.dir.toFixed(0)}°` : '-';
    const m = nextMark(e), dist = Math.hypot(m.x - b.x, m.y - b.y), brg = S.wrap(Math.atan2(m.x - b.x, m.y - b.y) / D);
    const vmc = (b.sog || 0) * Math.cos((b.cog - brg) * D);
    $('r-mark').textContent = e.finish != null ? '-' : `${(dist / 1852).toFixed(2)} nm ${brg.toFixed(0)}° VMC ${vmc.toFixed(1)}`;
    const order = g.boats.slice().sort((a, c) => progress(c) - progress(a));
    $('r-place').textContent = g.boats.length > 1 ? `${order.indexOf(g.me) + 1} of ${g.boats.length}` : '-';
    const h = g.helm;
    $('helm').textContent = h.mode === 'vmg' ? `Best VMG angle on ${h.board > 0 ? 'starboard' : 'port'} (${isUpwind(e) ? 'upwind' : 'downwind'}).` : `Holding ${Math.abs(h.twa).toFixed(0)}° true wind angle on ${h.board > 0 ? 'starboard' : 'port'}.`;
    const msg = performance.now() < g.msgUntil ? g.msg : (g.paused ? 'Paused (P)' : '');
    if ($('msg').textContent !== msg) $('msg').textContent = msg;
  }

  // ---- Input -----------------------------------------------------------------------------------------
  const act = {
    left: () => steer(2), right: () => steer(-2), left10: () => steer(10), right10: () => steer(-10),
    tack: tackOrGybe, vmg: vmgMode,
  };
  window.addEventListener('keydown', (ev) => {
    if (!G || ev.target.tagName === 'SELECT') return;
    const k = ev.key;
    if (k === 'ArrowLeft') act[ev.shiftKey ? 'left10' : 'left']();
    else if (k === 'ArrowRight') act[ev.shiftKey ? 'right10' : 'right']();
    else if (k === ' ') act.tack();
    else if (k === 'v' || k === 'V') act.vmg();
    else if (k === 'p' || k === 'P') G.paused = !G.paused;
    else if (k >= '1' && k <= '6') setSpeed(+k - 1);
    else if (k === '+' || k === '=') G.view.mpp /= 1.25;
    else if (k === '-') G.view.mpp *= 1.25;
    else if (k === 'c' || k === 'C') G.view.follow = true;
    else return;
    ev.preventDefault();
  });
  $('touch').addEventListener('click', (ev) => { const k = ev.target.dataset.k; if (k && G) act[k](); });
  $('new').onclick = newGame;
  ['day', 'leg', 'laps', 'rivals'].forEach((id) => $(id).addEventListener('change', newGame));
  $('map').addEventListener('wheel', (ev) => { ev.preventDefault(); G.view.mpp *= ev.deltaY > 0 ? 1.15 : 1 / 1.15; G.view.mpp = S.clamp(G.view.mpp, 0.5, 40); }, { passive: false });
  let drag = null;
  $('map').addEventListener('pointerdown', (ev) => { if (ev.target !== cv) return; drag = { x: ev.clientX, y: ev.clientY, cx: G.view.cx, cy: G.view.cy, moved: false }; });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const T = viewXf(), det = T.a * T.d - T.b * T.c;
    G.view.follow = false;
    G.view.cx = drag.cx - (T.d * dx - T.c * dy) / det; G.view.cy = drag.cy - (-T.b * dx + T.a * dy) / det;
  });
  window.addEventListener('pointerup', () => { drag = null; });
  $('map').addEventListener('dblclick', () => { G.view.follow = true; });

  // ---- Loop ------------------------------------------------------------------------------------------
  let last = performance.now(), stripAt = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (G && !G.paused && !G.done) {
      G.acc += dt * SPEEDS[G.speed];
      let n = 0;
      while (G.acc >= DT && n < 200) { stepGame(DT); G.acc -= DT; n++; }
    }
    if (G) { draw(); hud(); if (now - stripAt > 1000) { drawStrip(); stripAt = now; } }
    requestAnimationFrame(frame);
  }
  self.SoundRace = { get game() { return G; }, newGame, stepGame, setSpeed, act, polar, land };
  newGame(); setSpeed(+(params.get('speed') || 0)); resize();
  requestAnimationFrame(frame);
})();
