// Committee Boat race model: fleet, starts, start / finish marks, scoring, boat lookup.
// Pure functions over plain JSON state. Works in the browser (window.RC) and in node.
//
// Times of day are seconds since local midnight of the race day (fractions allowed);
// a finish after midnight is handled by wrapping elapsed time by 24 h.
(function (root) {
  'use strict';

  const DAY = 86400;
  // Scoring codes (RRS Appendix A). Every one of them scores entries in the fleet + 1.
  const CODES = {
    DNC: 'Did not come to the starting area',
    DNS: 'Did not start',
    OCS: 'On course side at the start, did not return',
    DNF: 'Did not finish',
    RET: 'Retired',
    DSQ: 'Disqualified',
  };
  // Default 5-4-1-0 sequence (RRS 26): warning, preparatory, one minute, start.
  const SEQ_5 = [
    { at: -300, name: 'Warning', say: '{s}, warning signal. Five minutes.' },
    { at: -240, name: 'Preparatory', say: '{s}, preparatory signal. Four minutes.' },
    { at: -60, name: 'One minute', say: '{s}, one minute.' },
    { at: 0, name: 'Start', say: '' },
  ];
  const SEQ_3 = [
    { at: -180, name: 'Warning', say: '{s}, warning signal. Three minutes.' },
    { at: -120, name: 'Preparatory', say: '{s}, preparatory signal. Two minutes.' },
    { at: -60, name: 'One minute', say: '{s}, one minute.' },
    { at: 0, name: 'Start', say: '' },
  ];
  const SEQUENCES = { '5-4-1-0': SEQ_5, '3-2-1-0': SEQ_3 };
  const COUNTDOWN = [30, 20, 10, 5, 4, 3, 2, 1];

  let seq = 0;
  const uid = (p) => p + Date.now().toString(36) + (seq++).toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------- time ----------
  const pad = (n) => String(n).padStart(2, '0');
  function hms(t) {
    if (t == null || !isFinite(t)) return '--:--:--';
    t = Math.floor(((t % DAY) + DAY) % DAY);
    return pad(Math.floor(t / 3600)) + ':' + pad(Math.floor(t / 60) % 60) + ':' + pad(t % 60);
  }
  // duration: H:MM:SS (or M:SS under an hour), signed
  function dur(s, opts = {}) {
    if (s == null || !isFinite(s)) return '';
    const neg = s < 0; s = Math.abs(Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    const body = h || opts.hours ? h + ':' + pad(m) + ':' + pad(x) : m + ':' + pad(x);
    return (neg ? '-' : '') + body;
  }
  // "14:05", "14:05:30", "140530", "1405" -> seconds of day; null if unreadable
  function parseHms(str) {
    if (str == null) return null;
    const s = String(str).trim();
    let h, m, x = 0;
    let mm = s.match(/^(\d{1,2})[:.h ](\d{1,2})(?:[:.m ](\d{1,2}(?:\.\d+)?))?s?$/i);
    if (mm) { h = +mm[1]; m = +mm[2]; x = mm[3] ? +mm[3] : 0; }
    else if ((mm = s.match(/^(\d{2})(\d{2})(\d{2})?$/))) { h = +mm[1]; m = +mm[2]; x = mm[3] ? +mm[3] : 0; }
    else return null;
    if (h > 23 || m > 59 || x >= 60) return null;
    return h * 3600 + m * 60 + x;
  }
  // epoch ms -> seconds since local midnight (fractions kept)
  function secOfDay(ms) {
    const d = new Date(ms);
    return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  }
  const wrap = (dt) => (dt < -DAY / 2 ? dt + DAY : dt > DAY / 2 ? dt - DAY : dt);

  // ---------- fleet ----------
  function makeBoat(o = {}) {
    return {
      id: o.id || uid('b'),
      name: String(o.name || '').trim(),
      sail: String(o.sail || '').trim(),
      type: String(o.type || '').trim(),
      rating: o.rating === '' || o.rating == null || !isFinite(+o.rating) ? null : +o.rating,
      fleet: String(o.fleet || '').trim(),
      skipper: String(o.skipper || '').trim(),
    };
  }
  const sailDigits = (s) => String(s || '').replace(/\D/g, '');
  // natural sort on sail numbers: numeric part, then the rest ("USA 7" before "USA 12")
  function cmpSail(a, b) {
    const da = sailDigits(a.sail), db = sailDigits(b.sail);
    if (da && db && +da !== +db) return +da - +db;
    if (!!da !== !!db) return da ? -1 : 1;
    return String(a.sail).localeCompare(String(b.sail), undefined, { numeric: true }) || cmpName(a, b);
  }
  function cmpName(a, b) {
    return normName(a.name).localeCompare(normName(b.name)) || String(a.sail).localeCompare(String(b.sail), undefined, { numeric: true });
  }
  // "The Wild Thing" sorts under W, as a club list would
  const normName = (n) => String(n || '').trim().toLowerCase().replace(/^(the|la|le|el)\s+/, '');
  function sortBoats(boats, by) {
    const a = boats.slice();
    if (by === 'sail') a.sort(cmpSail);
    else if (by === 'rating') a.sort((x, y) => (x.rating ?? 1e9) - (y.rating ?? 1e9) || cmpName(x, y));
    else if (by === 'fleet') a.sort((x, y) => x.fleet.localeCompare(y.fleet) || cmpName(x, y));
    else a.sort(cmpName);
    return a;
  }

  // CSV / pasted spreadsheet rows -> boats. Header row optional; columns found by name.
  function parseFleet(text) {
    const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const sep = lines[0].includes('\t') ? '\t' : lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
    const split = (l) => {
      const out = []; let cur = '', q = false;
      for (let i = 0; i < l.length; i++) {
        const c = l[i];
        if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
        else if (c === '"') q = true; else if (c === sep) { out.push(cur.trim()); cur = ''; } else cur += c;
      }
      out.push(cur.trim()); return out;
    };
    const rows = lines.map(split);
    const keys = { name: /^(boat|boat ?name|name|yacht|vessel)$/i, sail: /^(sail|sail ?(no|num|number|#)|no\.?|number|#)$/i, type: /^(type|class|boat ?type|design|make|model)$/i,
      rating: /^(rating|phrf|handicap|hcp|tcf|ghr)$/i, fleet: /^(fleet|division|div|start|group)$/i, skipper: /^(skipper|owner|helm|helmsman)$/i };
    let col = null;
    const h = rows[0].map((c) => c.replace(/[.\s]+$/, ''));
    const found = {};
    for (const k in keys) { const i = h.findIndex((c) => keys[k].test(c)); if (i >= 0) found[k] = i; }
    if (found.name != null || found.sail != null) { col = found; rows.shift(); }
    else col = { sail: 0, name: 1, type: 2, rating: 3, fleet: 4, skipper: 5 }; // no header: sail, name, type, rating, fleet
    return rows.map((r) => makeBoat({ name: r[col.name], sail: r[col.sail], type: r[col.type], rating: r[col.rating], fleet: r[col.fleet], skipper: r[col.skipper] }))
      .filter((b) => b.name || b.sail);
  }
  const csvCell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');
  const fleetCsv = (boats) => toCsv([['Sail', 'Boat', 'Type', 'Rating', 'Fleet', 'Skipper'], ...sortBoats(boats, 'sail').map((b) => [b.sail, b.name, b.type, b.rating, b.fleet, b.skipper])]);

  // ---------- lookup ----------
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length; if (!m || !n) return m || n;
    let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);
  const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function subseq(q, s) { let i = 0; for (const c of s) if (c === q[i]) i++; return i === q.length; }

  // Typed partial sail number or name -> boats, best first. Digits match sail numbers
  // (the end of a sail number counts most: that is what you read off the bow first).
  function matchBoats(query, boats, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const qd = q.replace(/\s+/g, ''), digitsOnly = /^\d+$/.test(qd), qa = alnum(q);
    const out = [];
    for (const b of boats) {
      let s = 0;
      const d = sailDigits(b.sail), sa = alnum(b.sail);
      if (digitsOnly && d) {
        if (d === qd) s = 100; else if (d.endsWith(qd)) s = 85; else if (d.startsWith(qd)) s = 75; else if (d.includes(qd)) s = 65;
      }
      if (qa && sa === qa) s = Math.max(s, 100);
      const n = String(b.name).toLowerCase(), na = alnum(n), words = n.split(/[^a-z0-9]+/).filter(Boolean);
      if (!digitsOnly || !s) {
        if (na && na === qa) s = Math.max(s, 98);
        else if (qa && na.startsWith(qa)) s = Math.max(s, 90);
        else if (qa && words.some((w) => w.startsWith(qa))) s = Math.max(s, 82);
        else if (qa.length >= 2 && na.includes(qa)) s = Math.max(s, 70);
        else if (qa.length >= 2 && sa.includes(qa)) s = Math.max(s, 60);
        else if (qa.length >= 3 && subseq(qa, na)) s = Math.max(s, 40);
        else if (qa.length >= 4) { const best = Math.max(sim(qa, na), ...words.map((w) => sim(qa, w))); if (best >= 0.6) s = Math.max(s, Math.round(50 * best)); }
      }
      if (s) out.push({ boat: b, score: s });
    }
    out.sort((x, y) => y.score - x.score || cmpName(x.boat, y.boat));
    return out.slice(0, limit);
  }

  // OCR text (a photo of a bow or a sail) -> candidate boats. Digit runs are compared with sail
  // numbers, letter runs with names (fuzzy: OCR confuses O/0, l/1, rn/m and drops letters).
  function matchOcr(text, boats, limit = 5) {
    const raw = String(text || '');
    const fixDigits = (s) => s.replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/[sS]/g, '5').replace(/[bB]/g, '8').replace(/[zZ]/g, '2');
    const runs = (raw.match(/[0-9oOlI|sSbBzZ]{2,}/g) || []).map(fixDigits).filter((r) => /^\d+$/.test(r) && /\d{2}/.test(r));
    const letters = alnum(raw.replace(/\d/g, ' '));
    const tokens = raw.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2);
    const out = [];
    for (const b of boats) {
      let s = 0, why = '';
      const d = sailDigits(b.sail);
      if (d) for (const r of runs) {
        const v = r === d ? 1 : d.length >= 3 && (r.endsWith(d) || r.includes(d)) ? 0.95 : r.length >= 3 && d.endsWith(r) ? 0.7 : r.length >= 3 ? sim(r, d) * 0.8 : 0;
        if (v > s) { s = v; why = 'sail ' + r; }
      }
      const na = alnum(b.name);
      if (na.length >= 3) {
        let v = letters.includes(na) ? 1 : 0;
        if (!v) {
          const nw = String(b.name).toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 2).length || 1;
          for (let i = 0; i < tokens.length; i++) for (let k = Math.max(1, nw - 1); k <= nw + 1 && i + k <= tokens.length; k++) v = Math.max(v, sim(tokens.slice(i, i + k).join(''), na));
        }
        if (v > s) { s = v; why = 'name'; }
      }
      if (s >= 0.6) out.push({ boat: b, score: Math.round(s * 100), why });
    }
    out.sort((x, y) => y.score - x.score);
    return out.slice(0, limit);
  }

  // ---------- race ----------
  function makeRace(o = {}) {
    return {
      id: o.id || uid('r'),
      name: o.name || 'Race',
      date: o.date || new Date().toISOString().slice(0, 10),
      sequence: o.sequence || '5-4-1-0',
      scoring: o.scoring || 'tod', // tod | tot | elapsed
      distance: o.distance ?? null, // nm, for time-on-distance
      totA: o.totA ?? 650, totB: o.totB ?? 550,
      starts: o.starts || [], // {id, label, fleets:[..], time}
      entries: o.entries || {}, // boatId -> {start:null|'ok'|'ocs'|'dns'|'dnc', startT, returned, status:null|'dnf'|'ret'|'dsq', note}
      finishes: o.finishes || [], // {id, t, boatId|null, src}
      queue: o.queue || [], // boatIds on deck for the finish, next first
      log: o.log || [], // {t, msg}
    };
  }
  function makeStart(o = {}) { return { id: o.id || uid('s'), label: o.label || '', fleets: o.fleets || [], time: o.time ?? null }; }
  const entry = (race, id) => race.entries[id] || (race.entries[id] = { start: null, startT: null, returned: false, status: null, note: '' });

  // Fleets in the fleet list, in first-seen order of the sorted list.
  const fleetsOf = (boats) => [...new Set(sortBoats(boats, 'fleet').map((b) => b.fleet))];
  // One start per fleet, five minutes apart from the first (rolling starts), keeping times already set.
  function autoStarts(race, boats, first, interval = 300) {
    const have = new Set(race.starts.flatMap((s) => s.fleets));
    for (const f of fleetsOf(boats)) if (!have.has(f)) race.starts.push(makeStart({ label: f || 'Fleet', fleets: [f] }));
    if (first != null) race.starts.forEach((s, i) => { s.time = first + i * interval; });
    sortStarts(race);
    return race;
  }
  const sortStarts = (race) => race.starts.sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
  function startOf(race, boat) { return race.starts.find((s) => s.fleets.includes(boat.fleet)) || null; }
  const boatsIn = (race, boats, start) => boats.filter((b) => start.fleets.includes(b.fleet));
  const unassigned = (race, boats) => boats.filter((b) => !startOf(race, b));

  // Where a start is: 'pending' (before warning), 'sequence' (warning .. start), 'started'.
  function startPhase(race, start, now) {
    if (start.time == null) return { phase: 'untimed', dt: null };
    const s = SEQUENCES[race.sequence] || SEQ_5, dt = wrap(now - start.time);
    if (dt >= 0) return { phase: 'started', dt };
    if (dt >= s[0].at) {
      const next = s.find((x) => x.at > dt);
      return { phase: 'sequence', dt, next };
    }
    return { phase: 'pending', dt, next: s[0] };
  }

  // Boat crossed the start line at t. Before its gun that is OCS (it must return); after, a good start.
  function markCrossed(race, boat, t) {
    const st = startOf(race, boat), e = entry(race, boat.id);
    e.startT = t;
    if (st && st.time != null && wrap(t - st.time) < 0) { e.start = 'ocs'; e.returned = false; }
    else { if (e.start === 'ocs') e.returned = true; e.start = 'ok'; } // an OCS boat crossing after the gun has come back and started
    return e;
  }
  function markStart(race, boat, code) {
    const e = entry(race, boat.id);
    if (code === 'returned') { e.returned = true; e.start = 'ok'; return e; }
    e.start = code; if (code === 'ocs') e.returned = false;
    if (!code) { e.startT = null; e.returned = false; }
    return e;
  }
  function setStatus(race, boat, code) { entry(race, boat.id).status = code || null; }

  // Who may cross now: started boats' fleets are clear, the others are early.
  function clearToCross(race, boats, now) {
    const clear = [], early = [], untimed = [];
    for (const st of race.starts) {
      const p = startPhase(race, st, now), list = boatsIn(race, boats, st);
      (p.phase === 'started' ? clear : p.phase === 'untimed' ? untimed : early).push({ start: st, phase: p, boats: list });
    }
    return { clear, early, untimed };
  }
  // A boat's next start-line job: still to start, over early (must return), started.
  function startState(race, boat, now) {
    const st = startOf(race, boat), e = race.entries[boat.id] || {};
    if (e.start === 'dnc' || e.start === 'dns') return e.start;
    if (e.start === 'ocs' && !e.returned) return 'ocs';
    if (e.start === 'ok') return 'started';
    if (!st || st.time == null) return 'waiting';
    return wrap(now - st.time) >= 0 ? 'clear' : 'waiting';
  }

  // ---------- finishes ----------
  // Record a finish at t for the boat first on deck (or a given boat, or none: an unassigned time).
  function recordFinish(race, t, boatId, src = 'tap') {
    if (boatId === undefined) boatId = race.queue.length ? race.queue[0] : null;
    if (boatId) race.queue = race.queue.filter((id) => id !== boatId);
    const f = { id: uid('f'), t, boatId: boatId || null, src };
    race.finishes.push(f); sortFinishes(race);
    return f;
  }
  const sortFinishes = (race) => race.finishes.sort((a, b) => a.t - b.t);
  function assignFinish(race, finishId, boatId) {
    for (const f of race.finishes) if (f.boatId === boatId && f.id !== finishId && boatId) f.boatId = null; // one finish per boat
    const f = race.finishes.find((x) => x.id === finishId); if (f) f.boatId = boatId || null;
    race.queue = race.queue.filter((id) => id !== boatId);
    return f;
  }
  const finishOf = (race, boatId) => race.finishes.find((f) => f.boatId === boatId) || null;
  function enqueue(race, boatId) { if (!race.queue.includes(boatId) && !finishOf(race, boatId)) race.queue.push(boatId); }

  // ---------- scoring ----------
  // Status code a boat scores (null = finished with a time, 'racing' = still out there).
  function code(race, boat) {
    const e = race.entries[boat.id] || {}, f = finishOf(race, boat.id);
    if (e.start === 'dnc') return 'DNC';
    if (e.start === 'dns') return 'DNS';
    if (e.status === 'dsq') return 'DSQ';
    if (e.start === 'ocs' && !e.returned && (f || e.status)) return 'OCS';
    if (e.status === 'ret') return 'RET';
    if (e.status === 'dnf') return 'DNF';
    if (f) return null;
    return 'racing';
  }
  function corrected(race, boat, elapsed) {
    const r = boat.rating;
    if (race.scoring === 'elapsed' || r == null) return elapsed;
    if (race.scoring === 'tot') return (elapsed * race.totA) / (race.totB + r);
    return race.distance ? elapsed - r * race.distance : elapsed; // time on distance, rating in s/nm
  }
  // Results per scoring fleet: place by corrected time, ties share points (A8 style average),
  // every code scores entries + 1. closed=true scores boats still racing as DNF.
  function results(race, boats, { closed = false } = {}) {
    const byFleet = new Map();
    for (const b of boats) { if (!byFleet.has(b.fleet)) byFleet.set(b.fleet, []); byFleet.get(b.fleet).push(b); }
    const out = [];
    for (const [fleet, list] of byFleet) {
      const st = race.starts.find((s) => s.fleets.includes(fleet)) || null;
      const rows = list.map((b) => {
        let c = code(race, b); if (c === 'racing' && closed) c = 'DNF';
        const f = finishOf(race, b.id), e = race.entries[b.id] || {};
        const startT = st && st.time != null ? st.time : null;
        let elapsed = null, corr = null;
        let check = null;
        if (!c && f && startT != null) {
          elapsed = wrap(f.t - startT); // a race past midnight still works; a finish before the gun is a mistake to fix
          if (elapsed < 0) { check = 'finish before start'; elapsed = null; } else corr = corrected(race, b, elapsed);
        }
        return { boat: b, code: c, start: startT, finish: f ? f.t : null, elapsed, corrected: corr, check, ocsReturned: e.start === 'ok' && e.returned };
      });
      const fin = rows.filter((r) => r.corrected != null).sort((a, b) => a.corrected - b.corrected);
      for (let i = 0; i < fin.length;) {
        let j = i; while (j + 1 < fin.length && Math.round(fin[j + 1].corrected) === Math.round(fin[i].corrected)) j++;
        const pts = (i + 1 + j + 1) / 2;
        for (let k = i; k <= j; k++) { fin[k].place = i + 1; fin[k].points = pts; }
        i = j + 1;
      }
      const best = fin.length ? fin[0].corrected : null;
      for (const r of fin) r.behind = r.corrected - best;
      const other = rows.filter((r) => r.corrected == null).sort((a, b) => (a.code === 'racing' ? 0 : 1) - (b.code === 'racing' ? 0 : 1) || (a.finish ?? 1e9) - (b.finish ?? 1e9) || cmpName(a.boat, b.boat));
      for (const r of other) r.points = r.code && r.code !== 'racing' ? list.length + 1 : null;
      out.push({ fleet, start: st, rows: fin.concat(other), entries: list.length });
    }
    out.sort((a, b) => ((a.start && a.start.time) ?? 1e9) - ((b.start && b.start.time) ?? 1e9) || a.fleet.localeCompare(b.fleet));
    return out;
  }
  function resultsCsv(race, boats, opts) {
    const rows = [['Fleet', 'Place', 'Sail', 'Boat', 'Type', 'Rating', 'Start', 'Finish', 'Elapsed', 'Corrected', 'Points', 'Code']];
    for (const g of results(race, boats, opts)) for (const r of g.rows)
      rows.push([g.fleet, r.place ?? '', r.boat.sail, r.boat.name, r.boat.type, r.boat.rating ?? '', hms(r.start), r.finish != null ? hms(r.finish) : '', r.elapsed != null ? dur(r.elapsed, { hours: true }) : '', r.corrected != null ? dur(r.corrected, { hours: true }) : '', r.points ?? '', r.code === 'racing' ? '' : r.code || '']);
    return toCsv(rows);
  }

  // ---------- narration ----------
  // Things to say when `now` passes a signal of some start; `fired` remembers what was said.
  // preCount: "B warning in 10 seconds", 3, 2, 1 before each signal, so the horn goes on time.
  function announcements(race, boats, now, fired, { names = true, preCount = true, window = 2 } = {}) {
    const s = SEQUENCES[race.sequence] || SEQ_5, out = [];
    for (const st of race.starts) {
      if (st.time == null) continue;
      const label = st.label || st.fleets.join(' and ') || 'Start';
      const say = (key, at, text, kind) => {
        const k = st.id + '@' + st.time + key, dt = wrap(now - (st.time + at));
        if (dt >= 0 && dt < window && !fired.has(k)) {
          fired.add(k);
          // rolling starts: one start's countdown and the next one's are the same words at the same moment
          if (!out.some((o) => o.text === text && o.at + o.start.time === st.time + at)) out.push({ start: st, at, text, kind });
        } else if (dt >= window) fired.add(k); // too late: never say a stale signal
      };
      for (const sig of s) {
        if (sig.at !== 0 && preCount) {
          say(sig.name + '-10', sig.at - 10, label + ' ' + sig.name.toLowerCase() + ' in 10 seconds.', 'pre');
          for (const c of [3, 2, 1]) say(sig.name + '-' + c, sig.at - c, String(c), 'count');
        }
        if (sig.at === 0) {
          const list = sortBoats(boatsIn(race, boats, st).filter((b) => !['dnc', 'dns'].includes((race.entries[b.id] || {}).start)), 'sail');
          const who = names && list.length ? ' Clear to cross: ' + list.map(spokenBoat).join(', ') + '.' : list.length ? ' ' + list.length + ' boats clear to cross.' : '';
          say('start', 0, label + ' start.' + who, 'start');
        } else say(sig.name, sig.at, sig.say.replace('{s}', label), 'signal');
      }
      for (const c of COUNTDOWN) say('c' + c, -c, c >= 10 ? c + ' seconds.' : String(c), 'count');
    }
    return out;
  }
  // "one two three, Wild Thing": digits one by one, as on the radio
  const spokenSail = (s) => sailDigits(s).split('').join(' ');
  const spokenBoat = (b) => [spokenSail(b.sail), b.name].filter(Boolean).join(', ');

  // Speech recognition text -> lookup query: "four two" / "forty two" / "sail 42" -> "42", names pass through.
  const WORDS = { zero: 0, oh: 0, o: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9 };
  const TENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
  function spokenQuery(text) {
    const w = String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((x) => x && !/^(sail|number|no|boat|is|the|finish|finished)$/.test(x));
    if (!w.length) return '';
    let digits = '', allNum = true;
    for (let i = 0; i < w.length; i++) {
      const x = w[i];
      if (/^\d+$/.test(x)) digits += x;
      else if (x in WORDS) digits += WORDS[x];
      else if (x in TENS) { const t = TENS[x]; if (t >= 20 && w[i + 1] in WORDS && WORDS[w[i + 1]] > 0) { digits += t + WORDS[w[i + 1]]; i++; } else digits += t; }
      else if (x === 'hundred') digits += '00';
      else { allNum = false; break; }
    }
    return allNum ? digits : w.join(' ');
  }

  const api = {
    spokenQuery,
    DAY, CODES, SEQUENCES, uid, hms, dur, parseHms, secOfDay, wrap,
    makeBoat, sortBoats, cmpSail, cmpName, sailDigits, parseFleet, fleetCsv, toCsv,
    lev, sim, matchBoats, matchOcr,
    makeRace, makeStart, entry, fleetsOf, autoStarts, sortStarts, startOf, boatsIn, unassigned, startPhase,
    markCrossed, markStart, setStatus, clearToCross, startState,
    recordFinish, sortFinishes, assignFinish, finishOf, enqueue,
    code, corrected, results, resultsCsv, announcements, spokenBoat, spokenSail,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RC = api;
})(typeof self !== 'undefined' ? self : this);
