// Committee Boat UI: fleet list, start line, finish line, results. State in localStorage.
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const params = new URLSearchParams(location.search);
  const KEY = 'committee-boat-v1';

  const DEMO = `Sail,Boat,Type,PHRF,Fleet
USA 60123,Kinetic,J/111,48,PHRF A
42,Salty Dog,Olson 911,129,PHRF B
39001,Tango,J/105,81,PHRF A
USA 112,Mojo,J/24,171,PHRF B
28771,Blue Moon,J/80,111,PHRF B
7,The Albatross,Catalina 30,186,Cruising
51150,Sea Biscuit,Beneteau First 36.7,84,PHRF A
393,Rusty Pelican,Cal 29,192,Cruising
1331,Windwalker,Express 27,129,PHRF B
46,Second Wind,Hunter 33,174,Cruising
88,Dark Star,Melges 24,75,PHRF A
5150,Ginger,Catalina 27,207,Cruising`;

  // ---------- state ----------
  const DEF = { useGps: true, manualMs: 0, speak: true, names: true, preCount: true, sayOcs: true, sayFin: true, beep: false, voice: '', rate: 1.05,
    hornRise: 15, hornMin: 150, hornStart: true, theme: 'day', wake: true, sortFleet: 'name', sortStart: 'sail', tab: 'fleet', closed: false };
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)); } catch (e) { S = null; }
  if (!S || !Array.isArray(S.boats)) S = { boats: [], races: [], cur: null, set: {} };
  S.set = Object.assign({}, DEF, S.set);
  S.races = S.races.map((r) => RC.makeRace(r));
  if (!S.races.length) { S.races.push(RC.makeRace({ name: 'Race 1' })); }
  if (!S.races.find((r) => r.id === S.cur)) S.cur = S.races[S.races.length - 1].id;
  const race = () => S.races.find((r) => r.id === S.cur);
  const boat = (id) => S.boats.find((b) => b.id === id);
  let saveT = 0;
  const save = () => { clearTimeout(saveT); saveT = setTimeout(() => localStorage.setItem(KEY, JSON.stringify(S)), 150); };
  const saveNow = () => { clearTimeout(saveT); localStorage.setItem(KEY, JSON.stringify(S)); };
  addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

  // demo: ?demo=<seconds to the first start> loads the demo fleet with rolling starts
  if (params.has('demo')) {
    if (!S.boats.length || params.get('fresh') != null) { S.boats = RC.parseFleet(DEMO); S.races = [RC.makeRace({ name: 'Demo race', distance: 8.4 })]; S.cur = S.races[0].id; }
    const r = race();
    if (!r.starts.some((s) => s.time != null)) RC.autoStarts(r, S.boats, Math.ceil(RC.secOfDay(Date.now()) + (+params.get('demo') || 330)), 300);
  }
  if (params.get('tab')) S.set.tab = params.get('tab');

  // ---------- clock ----------
  // Shown time = device clock + GPS offset (fix timestamps vs the device) + manual offset.
  const gps = { samples: [], offset: null, acc: null, fixes: 0, err: '', watch: null };
  const nowMs = () => Date.now() + (S.set.useGps && gps.offset != null ? gps.offset : 0) + (S.set.manualMs || 0);
  const nowSec = () => RC.secOfDay(nowMs());
  function startGps() {
    if (gps.watch != null || !navigator.geolocation || !S.set.useGps) return;
    gps.watch = navigator.geolocation.watchPosition((p) => {
      const off = p.timestamp - Date.now();
      gps.fixes++; gps.acc = p.coords.accuracy; gps.err = '';
      if (Math.abs(off) < 6 * 3600e3) { gps.samples.push(off); if (gps.samples.length > 15) gps.samples.shift(); }
      // a fix reaches us after its timestamp, so lag only pushes the sample down: take a high percentile
      const s = gps.samples.slice().sort((a, b) => a - b);
      gps.offset = s.length >= 3 ? s[Math.floor((s.length - 1) * 0.8)] : null;
    }, (e) => { gps.err = e.message || 'no GPS'; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function stopGps() { if (gps.watch != null) navigator.geolocation.clearWatch(gps.watch); gps.watch = null; gps.offset = null; gps.samples = []; }

  // ---------- speech, beep ----------
  const synth = window.speechSynthesis;
  const sayQ = [];
  let voices = [];
  const loadVoices = () => { voices = synth ? synth.getVoices().filter((v) => /^en/i.test(v.lang)) : []; fillVoices(); };
  if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
  function speak(text, { ttl = 8000, force = false } = {}) {
    if (!synth || (!S.set.speak && !force) || !text) return;
    sayQ.push({ text, until: Date.now() + ttl }); pump();
  }
  function pump() {
    if (!synth || synth.speaking || synth.pending) return;
    let it; while ((it = sayQ.shift()) && it.until < Date.now());
    if (!it) return;
    const u = new SpeechSynthesisUtterance(it.text);
    const v = voices.find((x) => x.voiceURI === S.set.voice); if (v) u.voice = v;
    u.rate = S.set.rate; u.lang = v ? v.lang : 'en-US';
    u.onend = u.onerror = () => setTimeout(pump, 0);
    synth.speak(u);
  }
  let actx = null;
  const audio = () => (actx || (actx = new (window.AudioContext || window.webkitAudioContext)()));
  function beep(ms = 300, hz = 880) {
    try { const a = audio(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = hz; g.gain.value = 0.25; o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + ms / 1000); } catch (e) { /* no audio */ }
  }
  // iOS: speech and audio only start from a user gesture
  addEventListener('pointerdown', function unlock() {
    if (synth) synth.speak(new SpeechSynthesisUtterance(''));
    try { audio().resume(); } catch (e) { /* */ }
    removeEventListener('pointerdown', unlock, true);
  }, true);

  // ---------- undo, actions, toast ----------
  const undoStack = [];
  function act(label, fn, { toast: t = true, undo = true } = {}) {
    if (undo) { undoStack.push(JSON.stringify({ boats: S.boats, race: race() })); if (undoStack.length > 40) undoStack.shift(); }
    const r = fn(); save(); render();
    if (t) toast(label, undo);
    return r;
  }
  function undo() {
    const s = undoStack.pop(); if (!s) return;
    const o = JSON.parse(s); S.boats = o.boats;
    const i = S.races.findIndex((r) => r.id === o.race.id); if (i >= 0) S.races[i] = RC.makeRace(o.race);
    save(); render(); toast('Undone', false);
  }
  let toastT = 0;
  function toast(msg, withUndo) {
    const t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (withUndo ? '<button id="undobtn">Undo</button>' : '');
    t.classList.remove('hidden');
    if (withUndo) $('#undobtn').onclick = () => { t.classList.add('hidden'); undo(); };
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), withUndo ? 6000 : 2500);
  }
  const label = (b) => (b ? [b.sail, b.name].filter(Boolean).join(' ') : 'unknown boat');

  // ---------- generic action sheet ----------
  const sheetDlg = document.createElement('dialog');
  document.body.appendChild(sheetDlg);
  function sheet(title, items) {
    sheetDlg.innerHTML = '<h2>' + esc(title) + '</h2><div class="list">' + items.map((it, i) => `<button data-i="${i}" class="${it.cls || ''}" style="min-height:52px;text-align:left">${esc(it.label)}</button>`).join('') + '</div><div class="dlgbtns"><button data-i="x">Cancel</button></div>';
    sheetDlg.onclick = (e) => { const b = e.target.closest('button'); if (!b) { if (e.target === sheetDlg) sheetDlg.close(); return; } sheetDlg.close(); if (b.dataset.i !== 'x') items[+b.dataset.i].fn(); };
    sheetDlg.showModal();
  }

  // ---------- header ----------
  function renderHeader() {
    const sel = $('#racesel');
    sel.innerHTML = S.races.map((r) => `<option value="${r.id}">${esc(r.name)} · ${esc(r.date)}</option>`).join('');
    sel.value = S.cur;
    $$('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.set.tab));
    $$('section.view').forEach((v) => v.classList.toggle('on', v.id === 'v-' + S.set.tab));
    $('#finishbar').classList.toggle('hidden', S.set.tab !== 'finish');
    $('#speakbtn').textContent = S.set.speak ? '🔊' : '🔇';
    document.documentElement.dataset.theme = S.set.theme;
    const r = race(), now = nowSec();
    const ocs = S.boats.filter((b) => RC.startState(r, b, now) === 'ocs').length;
    $('#ocsbadge').textContent = ocs; $('#ocsbadge').classList.toggle('hidden', !ocs);
    const unk = r.finishes.filter((f) => !f.boatId).length;
    $('#unkbadge').textContent = unk; $('#unkbadge').classList.toggle('hidden', !unk);
  }
  $('#racesel').onchange = (e) => { S.cur = e.target.value; undoStack.length = 0; save(); render(); };
  $('#newrace').onclick = () => {
    const cur = race(), name = prompt('Name of the new race', 'Race ' + (S.races.length + 1));
    if (!name) return;
    const r = RC.makeRace({ name, sequence: cur.sequence, scoring: cur.scoring, distance: cur.distance, totA: cur.totA, totB: cur.totB,
      starts: cur.starts.map((s) => RC.makeStart({ label: s.label, fleets: s.fleets.slice() })) });
    S.races.push(r); S.cur = r.id; S.set.tab = 'start'; undoStack.length = 0; save(); render();
    $('#setup').open = true;
  };
  $$('nav button').forEach((b) => (b.onclick = () => { S.set.tab = b.dataset.tab; save(); render(); scrollTo(0, 0); }));
  $('#speakbtn').onclick = () => { S.set.speak = !S.set.speak; if (!S.set.speak && synth) { synth.cancel(); sayQ.length = 0; } save(); renderHeader(); };

  // ---------- fleet ----------
  function renderFleet() {
    $$('#fleetsort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === S.set.sortFleet));
    const q = $('#fleetfilter').value.trim();
    let list = RC.sortBoats(S.boats, S.set.sortFleet);
    if (q) { const m = new Set(RC.matchBoats(q, S.boats, 999).map((x) => x.boat.id)); list = list.filter((b) => m.has(b.id) || b.type.toLowerCase().includes(q.toLowerCase()) || b.fleet.toLowerCase().includes(q.toLowerCase())); }
    const fleets = RC.fleetsOf(S.boats);
    $('#fleetcount').textContent = S.boats.length ? `${S.boats.length} boats` + (fleets.length > 1 || fleets[0] ? ' in ' + fleets.map((f) => f || 'no fleet').join(', ') : '') : '';
    let lastFleet = null;
    $('#fleetlist').innerHTML = !S.boats.length
      ? '<div class="empty">No boats yet. <b>+ Boat</b> to add one, <b>Import</b> to paste a list, or load the demo fleet from Import.</div>'
      : list.map((b) => {
        let head = '';
        if (S.set.sortFleet === 'fleet' && b.fleet !== lastFleet) { lastFleet = b.fleet; head = `<h3 style="margin:8px 4px 0">${esc(b.fleet || 'No fleet')}</h3>`; }
        return head + `<div class="boat" data-edit="${b.id}" style="cursor:pointer">
          <div class="sail mono">${esc(b.sail)}</div>
          <div style="min-width:0"><div class="nm">${esc(b.name)}</div><div class="sub">${esc([b.type, b.fleet, b.skipper].filter(Boolean).join(' · '))}</div></div>
          <div class="mono" style="font-size:18px;font-weight:700">${b.rating ?? ''}</div></div>`;
      }).join('');
  }
  $('#fleetsort').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.set.sortFleet = b.dataset.sort; save(); renderFleet(); } };
  $('#fleetfilter').oninput = renderFleet;
  $('#fleetlist').onclick = (e) => { const r = e.target.closest('[data-edit]'); if (r) editBoat(r.dataset.edit); };
  $('#addboat').onclick = () => editBoat(null);
  $('#exportfleet').onclick = () => download('fleet.csv', RC.fleetCsv(S.boats), 'text/csv');

  let editing = null;
  function editBoat(id) {
    editing = id; const b = id ? boat(id) : RC.makeBoat({ fleet: S.boats.length ? S.boats[S.boats.length - 1].fleet : '' });
    $('#boatdlgtitle').textContent = id ? 'Edit boat' : 'New boat';
    for (const k of ['sail', 'name', 'type', 'rating', 'fleet', 'skipper']) $('#bf-' + k).value = b[k] ?? '';
    $('#fleetnames').innerHTML = RC.fleetsOf(S.boats).filter(Boolean).map((f) => `<option value="${esc(f)}">`).join('');
    $('#bf-del').classList.toggle('hidden', !id);
    $('#boatdlg').showModal(); $('#bf-' + (id ? 'name' : 'sail')).focus();
  }
  function saveBoat(again) {
    const o = {}; for (const k of ['sail', 'name', 'type', 'rating', 'fleet', 'skipper']) o[k] = $('#bf-' + k).value;
    if (!o.name.trim() && !o.sail.trim()) { $('#bf-sail').focus(); return; }
    const nb = RC.makeBoat({ ...o, id: editing || undefined });
    act(editing ? 'Saved ' + label(nb) : 'Added ' + label(nb), () => {
      const i = S.boats.findIndex((b) => b.id === nb.id);
      if (i >= 0) S.boats[i] = nb; else S.boats.push(nb);
    });
    if (again) { editBoat(null); $('#bf-fleet').value = nb.fleet; } else $('#boatdlg').close();
  }
  $('#bf-save').onclick = () => saveBoat(false);
  $('#boatform').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); saveBoat(!editing); } };
  $('#bf-cancel').onclick = () => $('#boatdlg').close();
  $('#bf-del').onclick = () => {
    const b = boat(editing); if (!b || !confirm('Delete ' + label(b) + ' from the fleet?')) return;
    act('Deleted ' + label(b), () => { S.boats = S.boats.filter((x) => x.id !== b.id); for (const r of S.races) { r.queue = r.queue.filter((x) => x !== b.id); for (const f of r.finishes) if (f.boatId === b.id) f.boatId = null; } });
    $('#boatdlg').close();
  };

  $('#importbtn').onclick = () => { $('#importtext').value = ''; $('#importdlg').showModal(); };
  $('#importfile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#importtext').value = await f.text(); };
  $('#im-demo').onclick = () => { $('#importtext').value = DEMO; };
  $('#im-cancel').onclick = () => $('#importdlg').close();
  const doImport = (replace) => {
    const list = RC.parseFleet($('#importtext').value);
    if (!list.length) { toast('No boats found in that text', false); return; }
    act(`Imported ${list.length} boats`, () => {
      if (replace) S.boats = list;
      else for (const b of list) { const same = S.boats.find((x) => x.sail && x.sail === b.sail && x.name === b.name); if (same) Object.assign(same, { ...b, id: same.id }); else S.boats.push(b); }
    });
    $('#importdlg').close();
  };
  $('#im-add').onclick = () => doImport(false);
  $('#im-replace').onclick = () => { if (!S.boats.length || confirm('Replace all ' + S.boats.length + ' boats?')) doImport(true); };

  // ---------- start ----------
  const STATE_CHIP = { waiting: 'waiting', clear: 'clear to cross', started: 'started', ocs: 'OCS', dns: 'DNS', dnc: 'DNC' };
  function renderStart() {
    const r = race(), now = nowSec(), fleets = RC.fleetsOf(S.boats);
    $('#sequence').value = r.sequence;
    $$('#startsort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === S.set.sortStart));
    $('#setupsum').textContent = r.starts.length ? '· ' + r.starts.map((s) => (s.label || '?') + ' ' + (s.time != null ? RC.hms(s.time).slice(0, s.time % 60 ? 8 : 5) : '--')).join(', ') : '· none yet';
    if (!$('#firststart').value) { const t = Math.ceil((now + 600) / 300) * 300; $('#firststart').value = RC.hms(t); }
    $('#startrows').innerHTML = r.starts.map((s) => `<div class="srow" data-sid="${s.id}">
      <input value="${esc(s.label)}" data-f="label" placeholder="Start name">
      <div class="fleetchips">${fleets.map((f) => `<button class="${s.fleets.includes(f) ? 'on' : ''}" data-fleet="${esc(f)}">${esc(f || 'no fleet')}</button>`).join('')}</div>
      <input type="time" step="1" value="${s.time != null ? RC.hms(s.time) : ''}" data-f="time">
      <button class="sm ghost" data-del="1" title="Remove start">✕</button></div>`).join('') || '<div class="dim">No starts. Add one, or make one per fleet.</div>';
    const un = RC.unassigned(r, S.boats);
    $('#unassigned').textContent = un.length ? `Not in any start: ${un.length} boats (${[...new Set(un.map((b) => b.fleet || 'no fleet'))].join(', ')})` : '';
    if (!r.starts.length && S.boats.length) $('#setup').open = true;

    const sorted = r.starts.slice().sort((a, b) => (a.time ?? 1e9) - (b.time ?? 1e9));
    const counts = { started: 0, ocs: 0, waiting: 0, clear: 0, dns: 0, dnc: 0 };
    $('#startlist').innerHTML = sorted.map((st) => {
      const p = RC.startPhase(r, st, now);
      const list = RC.sortBoats(RC.boatsIn(r, S.boats, st), S.set.sortStart);
      return `<div class="starthead phase-${p.phase}"><h2>${esc(st.label || st.fleets.join(', ') || 'Start')}</h2>
        <span class="dim mono">${st.time != null ? RC.hms(st.time) : 'no time'}</span>
        <span class="cd mono" data-cd="${st.id}">${p.dt == null ? '' : p.dt < 0 ? '−' + RC.dur(-p.dt) : '+' + RC.dur(p.dt)}</span><span class="grow"></span>
        ${p.phase === 'started' && p.dt < 1800 ? `<button class="sm" data-recall="${st.id}">General recall</button>` : ''}</div>
        <div class="list">${list.map((b) => { const s = RC.startState(r, b, now); counts[s]++; return startRow(r, b, s); }).join('') || '<div class="dim">No boats in this start.</div>'}</div>`;
    }).join('') || (S.boats.length ? '' : '<div class="empty">Add boats in the Fleet tab first.</div>');
    $('#startcounts').textContent = [counts.started && counts.started + ' started', counts.ocs && counts.ocs + ' OCS', counts.clear && counts.clear + ' to start', counts.dns + counts.dnc && counts.dns + counts.dnc + ' DNS/DNC'].filter(Boolean).join(' · ');
    renderBanner();
  }
  function startRow(r, b, s) {
    const e = r.entries[b.id] || {};
    const sub = [b.type, b.rating != null ? b.rating : '', e.startT != null && (s === 'started' || s === 'ocs') ? (s === 'ocs' ? 'over ' : 'crossed ') + RC.hms(e.startT) : '', e.returned ? 'returned' : ''].filter((x) => x !== '').join(' · ');
    let acts;
    if (s === 'ocs') acts = `<button class="cross" data-a="returned">Returned</button>`;
    else if (s === 'started') acts = '';
    else if (s === 'dns' || s === 'dnc') acts = '';
    else acts = `<button class="cross" data-a="cross">Crossed</button><button class="ocs" data-a="ocs">Over</button>`;
    return `<div class="boat st-${s}" data-bid="${b.id}"><div class="sail mono">${esc(b.sail)}</div>
      <div style="min-width:0"><div class="nm">${esc(b.name)} <span class="chip">${STATE_CHIP[s]}</span></div><div class="sub">${esc(sub)}</div></div>
      <div class="acts">${acts}<button class="ghost" data-a="more" aria-label="More">⋯</button></div></div>`;
  }
  function renderBanner() {
    const r = race(), now = nowSec(), c = RC.clearToCross(r, S.boats, now);
    const name = (x) => esc(x.start.label || x.start.fleets.join(', '));
    let h = '';
    if (c.clear.length) h += `<div class="banner clear"><b>Clear to cross:</b> ${c.clear.map((x) => name(x) + ` <span class="mono">(${RC.dur(x.phase.dt)} ago)</span>`).join(', ')}</div>`;
    if (c.early.length) h += `<div class="banner early"><b>Not yet:</b> ${c.early.map((x) => name(x) + ` <span class="mono">in ${RC.dur(-x.phase.dt)}</span>`).join(', ')}</div>`;
    $('#crossbanner').innerHTML = h;
  }
  $('#startsort').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.set.sortStart = b.dataset.sort; save(); renderStart(); } };
  $('#sequence').onchange = (e) => act('Sequence ' + e.target.value, () => { race().sequence = e.target.value; }, { toast: false });
  $('#addstart').onclick = () => act('Start added', () => { const r = race(), last = r.starts[r.starts.length - 1]; r.starts.push(RC.makeStart({ label: 'Start ' + (r.starts.length + 1), time: last && last.time != null ? last.time + 300 : null })); }, { toast: false });
  $('#autostarts').onclick = () => {
    const t = RC.parseHms($('#firststart').value), iv = (+$('#interval').value || 5) * 60;
    if (t == null) { toast('Set the first start time', false); return; }
    act('Starts set', () => RC.autoStarts(race(), S.boats, t, iv));
  };
  $('#startrows').onchange = (e) => {
    const row = e.target.closest('[data-sid]'); if (!row) return;
    const st = race().starts.find((s) => s.id === row.dataset.sid), f = e.target.dataset.f;
    if (f === 'label') act('Start renamed', () => { st.label = e.target.value.trim(); }, { toast: false });
    if (f === 'time') act('Start time ' + e.target.value, () => { st.time = RC.parseHms(e.target.value); RC.sortStarts(race()); });
  };
  $('#startrows').onclick = (e) => {
    const row = e.target.closest('[data-sid]'), b = e.target.closest('button'); if (!row || !b) return;
    const r = race(), st = r.starts.find((s) => s.id === row.dataset.sid);
    if (b.dataset.del) act('Start removed', () => { r.starts = r.starts.filter((s) => s !== st); });
    else if (b.dataset.fleet != null) act('Fleets changed', () => {
      const f = b.dataset.fleet;
      if (st.fleets.includes(f)) st.fleets = st.fleets.filter((x) => x !== f);
      else { for (const s of r.starts) s.fleets = s.fleets.filter((x) => x !== f); st.fleets.push(f); } // a fleet starts once
    }, { toast: false });
  };
  $('#startlist').onclick = (e) => {
    const rc = e.target.closest('[data-recall]');
    if (rc) return recall(rc.dataset.recall);
    const btn = e.target.closest('button[data-a]'), row = e.target.closest('[data-bid]'); if (!btn || !row) return;
    const r = race(), b = boat(row.dataset.bid), t = RC.secOfDay(nowMs() - (performance.now() - e.timeStamp));
    if (btn.dataset.a === 'cross') {
      const en = act('', () => RC.markCrossed(r, b, t), { toast: false });
      if (en.start === 'ocs') { toast(label(b) + ' OVER EARLY ' + RC.hms(t), true); if (S.set.sayOcs) speak('Over early: ' + RC.spokenBoat(b), { ttl: 15000 }); }
      else toast(label(b) + ' crossed ' + RC.hms(t), true);
    } else if (btn.dataset.a === 'ocs') {
      act(label(b) + ' OCS', () => { RC.markStart(r, b, 'ocs'); RC.entry(r, b.id).startT = t; });
      if (S.set.sayOcs) speak('Over early: ' + RC.spokenBoat(b), { ttl: 15000 });
    } else if (btn.dataset.a === 'returned') act(label(b) + ' returned', () => { RC.markStart(r, b, 'returned'); RC.entry(r, b.id).startT = t; });
    else if (btn.dataset.a === 'more') boatSheet(b);
  };
  function boatSheet(b) {
    const r = race(), t = nowSec();
    sheet(label(b), [
      { label: 'Crossed now (' + RC.hms(t) + ')', fn: () => act(label(b) + ' crossed', () => RC.markCrossed(r, b, t)) },
      { label: 'Over early (OCS)', cls: 'ocs', fn: () => act(label(b) + ' OCS', () => RC.markStart(r, b, 'ocs')) },
      { label: 'Returned and started', fn: () => act(label(b) + ' returned', () => RC.markStart(r, b, 'returned')) },
      { label: 'DNS — did not start', fn: () => act(label(b) + ' DNS', () => RC.markStart(r, b, 'dns')) },
      { label: 'DNC — did not come to the start', fn: () => act(label(b) + ' DNC', () => RC.markStart(r, b, 'dnc')) },
      { label: 'Clear start mark', fn: () => act(label(b) + ' start cleared', () => RC.markStart(r, b, null)) },
      { label: 'Add to finish deck', fn: () => act(label(b) + ' on deck', () => RC.enqueue(r, b.id)) },
      { label: 'Edit boat…', fn: () => editBoat(b.id) },
    ]);
  }
  function recall(sid) {
    const r = race(), st = r.starts.find((s) => s.id === sid), last = Math.max(...r.starts.map((s) => s.time ?? 0));
    const def = RC.hms(Math.max(last + 300, Math.ceil((nowSec() + 360) / 60) * 60));
    const v = prompt(`General recall of ${st.label || 'this start'}: start marks are cleared. New start time:`, def);
    if (v == null) return;
    const t = RC.parseHms(v); if (t == null) { toast('Could not read ' + v, false); return; }
    act('General recall, new start ' + RC.hms(t), () => {
      for (const b of RC.boatsIn(r, S.boats, st)) { const e = r.entries[b.id]; if (e && ['ok', 'ocs'].includes(e.start)) RC.markStart(r, b, null); }
      st.time = t; RC.sortStarts(r);
    });
    speak((st.label || 'Start') + ', general recall. New start ' + RC.hms(t).slice(0, 5), { force: false });
  }

  // ---------- finish ----------
  function renderFinish() {
    const r = race(), now = nowSec();
    renderSugg();
    $('#deck').innerHTML = r.queue.map((id, i) => { const b = boat(id); return b ? `<div class="boat" data-qid="${id}"><div class="n">${i + 1}</div><div class="sail mono">${esc(b.sail)}</div>
      <div style="min-width:0"><div class="nm">${esc(b.name)}</div><div class="sub">${esc([b.type, b.fleet].filter(Boolean).join(' · '))}</div></div>
      <div class="acts">${i ? '<button class="sm" data-q="up" aria-label="Move up">↑</button>' : ''}<button class="sm" data-q="fin">Finish</button><button class="sm ghost" data-q="x" aria-label="Remove">✕</button></div></div>` : ''; }).join('')
      || '<div class="dim" style="padding:6px 2px">Nobody on deck. Type a sail number or a name above as a boat comes up; a time with nobody on deck is kept as an unknown boat to fill in later.</div>';
    const fins = r.finishes;
    $('#fincount').textContent = fins.length ? fins.length + ' times' + (fins.some((f) => !f.boatId) ? ', ' + fins.filter((f) => !f.boatId).length + ' unknown' : '') : '';
    $('#finlist').innerHTML = fins.map((f, i) => finRow(r, f, i)).reverse().join('') || '<div class="dim" style="padding:6px 2px">No finishes yet.</div>';
    // still racing / out
    const racing = [], out = [];
    for (const b of S.boats) {
      const c = RC.code(r, b);
      if (c === 'racing') { const s = RC.startState(r, b, now); racing.push({ b, s }); } else if (c) out.push({ b, c });
    }
    const st = (b) => { const s = RC.startOf(r, b); return s && s.time != null ? s.time : 1e9; };
    racing.sort((x, y) => st(x.b) - st(y.b) || RC.cmpSail(x.b, y.b));
    $('#racinglist').innerHTML = racing.map(({ b, s }) => `<div class="boat ${s === 'ocs' ? 'st-ocs' : ''}" data-bid="${b.id}"><div class="sail mono">${esc(b.sail)}</div>
      <div style="min-width:0"><div class="nm">${esc(b.name)} ${s === 'ocs' ? '<span class="chip">OCS not returned</span>' : s === 'waiting' ? '<span class="chip">not started</span>' : ''}</div><div class="sub">${esc([b.type, b.fleet].filter(Boolean).join(' · '))}</div></div>
      <div class="acts">${r.queue.includes(b.id) ? '<span class="dim">on deck</span>' : '<button data-r="deck">Deck</button>'}<button class="sm" data-r="dnf">DNF</button><button class="sm" data-r="ret">RET</button></div></div>`).join('')
      || '<div class="dim">Nobody out there.</div>';
    out.sort((x, y) => x.c.localeCompare(y.c) || RC.cmpSail(x.b, y.b));
    $('#outlist').innerHTML = out.map(({ b, c }) => `<div class="boat st-out" data-bid="${b.id}"><div class="sail mono">${esc(b.sail)}</div>
      <div style="min-width:0"><div class="nm">${esc(b.name)} <span class="chip" title="${esc(RC.CODES[c])}">${c}</span></div><div class="sub">${esc(RC.CODES[c])}</div></div>
      <div class="acts"><button class="sm" data-r="clear">Clear</button></div></div>`).join('') || '<div class="dim">No DNC, DNS, OCS, DNF or RET.</div>';
    updateFinishBtn();
  }
  function finRow(r, f, i) {
    const b = boat(f.boatId), st = b && RC.startOf(r, b);
    const el = st && st.time != null ? RC.wrap(f.t - st.time) : null;
    if (editFin === f.id) {
      const t = Math.round(f.t), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
      return `<div class="fin" data-fid="${f.id}" style="grid-template-columns:34px 1fr"><div class="n">${i + 1}</div>
        <div class="tedit"><input type="number" inputmode="numeric" min="0" max="23" value="${h}" data-p="h" aria-label="hours">:<input type="number" inputmode="numeric" min="0" max="59" value="${String(m).padStart(2, '0')}" data-p="m" aria-label="minutes">:<input type="number" inputmode="numeric" min="0" max="59" value="${String(s).padStart(2, '0')}" data-p="s" aria-label="seconds">
        <button class="sm" data-e="-1">−1 s</button><button class="sm" data-e="1">+1 s</button><button class="sm pri" data-e="ok">Save</button><button class="sm" data-e="cancel">Cancel</button><button class="sm ghost" data-e="del" style="color:var(--bad)">Delete</button></div></div>`;
    }
    const src = f.src === 'horn' ? '📯' : f.src === 'manual' ? '✎' : '';
    return `<div class="fin ${b ? '' : 'unk'}" data-fid="${f.id}"><div class="n">${i + 1}</div>
      <div class="t mono" data-e="edit" style="cursor:pointer" title="Edit time">${RC.hms(f.t)}</div>
      <div class="who" data-e="who" style="min-width:0"><div class="nm" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b ? `<b class="mono">${esc(b.sail)}</b> ${esc(b.name)}` : 'Unknown boat — tap to set'}</div>
      <div class="sub dim" style="font-size:13px">${esc([b && b.fleet, el != null ? 'elapsed ' + RC.dur(el) : ''].filter(Boolean).join(' · '))} ${src}</div></div>
      <button class="ghost sm" data-e="more" aria-label="More">⋯</button></div>`;
  }
  let editFin = null;
  function renderSugg() {
    const r = race(), q = $('#lookup').value;
    const done = new Set(r.finishes.map((f) => f.boatId).filter(Boolean));
    const m = q.trim() ? RC.matchBoats(q, S.boats, 8) : [];
    $('#sugg').innerHTML = m.map(({ boat: b }) => `<button data-sug="${b.id}" ${done.has(b.id) ? 'style="opacity:.55"' : ''}><b class="mono">${esc(b.sail)}</b> ${esc(b.name)}<br><span class="dim" style="font-size:13px">${esc([b.type, b.fleet, done.has(b.id) ? 'finished' : r.queue.includes(b.id) ? 'on deck' : ''].filter(Boolean).join(' · '))}</span></button>`).join('')
      || (q.trim() ? '<span class="dim">No boat matches</span>' : '');
  }
  function updateFinishBtn() {
    const r = race(), b = r.queue.length ? boat(r.queue[0]) : null;
    $('#finishbtn').innerHTML = b ? `FINISH <small>${esc(label(b))}</small>` : 'FINISH <small>time only, name it later</small>';
  }
  function finishNow(tMs, src, boatId) {
    const r = race(), t = RC.secOfDay(tMs);
    const f = act('', () => RC.recordFinish(r, t, boatId, src), { toast: false });
    const b = boat(f.boatId);
    toast((b ? label(b) : 'Unknown boat') + ' finished ' + RC.hms(t), true);
    if (S.set.sayFin) speak(b ? RC.spokenBoat(b) + '. ' + RC.hms(t) : 'Time ' + RC.hms(t), { ttl: 10000 });
    if (navigator.vibrate) navigator.vibrate(60);
    return f;
  }
  // pointerdown, not click: click waits for the finger to lift
  $('#finishbtn').addEventListener('pointerdown', (e) => { e.preventDefault(); finishNow(nowMs() - (performance.now() - e.timeStamp), 'tap'); });
  $('#finishbtn').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); finishNow(nowMs(), 'tap'); } });
  document.addEventListener('keydown', (e) => {
    if (S.set.tab !== 'finish' || e.repeat || $('dialog[open]')) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (e.key === ' ' && !['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(tag)) { e.preventDefault(); finishNow(nowMs() - (performance.now() - e.timeStamp), 'tap'); }
  });
  $('#lookup').oninput = renderSugg;
  $('#lookup').onkeydown = (e) => {
    if (e.key === 'Enter') { const m = RC.matchBoats(e.target.value, S.boats, 1)[0]; if (m) deck(m.boat.id); }
    if (e.key === 'Escape') { e.target.value = ''; renderSugg(); }
  };
  function deck(id) {
    const r = race(), b = boat(id);
    if (RC.finishOf(r, id)) { toast(label(b) + ' already finished', false); return; }
    act(label(b) + ' on deck', () => RC.enqueue(r, id), { toast: false });
    $('#lookup').value = ''; renderSugg();
  }
  $('#sugg').onclick = (e) => { const b = e.target.closest('[data-sug]'); if (b) { deck(b.dataset.sug); $('#lookup').focus(); } };
  $('#deck').onclick = (e) => {
    const btn = e.target.closest('button[data-q]'), row = e.target.closest('[data-qid]'); if (!btn || !row) return;
    const r = race(), id = row.dataset.qid, i = r.queue.indexOf(id);
    if (btn.dataset.q === 'x') act('Removed from deck', () => { r.queue.splice(i, 1); }, { toast: false });
    if (btn.dataset.q === 'up') act('Moved up', () => { r.queue.splice(i, 1); r.queue.splice(i - 1, 0, id); }, { toast: false });
    if (btn.dataset.q === 'fin') finishNow(nowMs() - (performance.now() - e.timeStamp), 'tap', id);
  };
  $('#finlist').onclick = async (e) => {
    const el = e.target.closest('[data-e]'), row = e.target.closest('[data-fid]'); if (!el || !row) return;
    const r = race(), f = r.finishes.find((x) => x.id === row.dataset.fid), a = el.dataset.e;
    if (a === 'edit') { editFin = f.id; renderFinish(); const h = $(`[data-fid="${f.id}"] input[data-p=s]`); if (h) h.focus(); return; }
    if (a === 'cancel') { editFin = null; renderFinish(); return; }
    if (a === '1' || a === '-1') { const s = $(`[data-fid="${f.id}"] input[data-p=s]`), m = $(`[data-fid="${f.id}"] input[data-p=m]`), h = $(`[data-fid="${f.id}"] input[data-p=h]`);
      let t = (+h.value * 3600 + +m.value * 60 + +s.value + +a + RC.DAY) % RC.DAY; h.value = Math.floor(t / 3600); m.value = String(Math.floor(t / 60) % 60).padStart(2, '0'); s.value = String(t % 60).padStart(2, '0'); return; }
    if (a === 'ok') {
      const v = (p) => +$(`[data-fid="${f.id}"] input[data-p=${p}]`).value;
      const h = v('h'), m = v('m'), s = v('s');
      if (!(h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60)) { toast('Not a time', false); return; }
      editFin = null; act('Time ' + RC.hms(h * 3600 + m * 60 + s), () => { f.t = h * 3600 + m * 60 + s; f.src = 'manual'; RC.sortFinishes(r); }); return;
    }
    if (a === 'del') { editFin = null; act('Finish deleted', () => { r.finishes = r.finishes.filter((x) => x !== f); }); return; }
    if (a === 'who') { const id = await pickBoat('Who finished at ' + RC.hms(f.t) + '?', f.boatId); if (id !== undefined) act(id ? label(boat(id)) + ' at ' + RC.hms(f.t) : 'Set to unknown', () => RC.assignFinish(r, f.id, id)); return; }
    if (a === 'more') sheet(RC.hms(f.t) + ' ' + label(boat(f.boatId)), [
      { label: 'Edit time', fn: () => { editFin = f.id; renderFinish(); } },
      { label: 'Change boat…', fn: async () => { const id = await pickBoat('Who finished at ' + RC.hms(f.t) + '?', f.boatId); if (id !== undefined) act('Changed', () => RC.assignFinish(r, f.id, id)); } },
      { label: 'Delete this finish', cls: 'ocs', fn: () => act('Finish deleted', () => { r.finishes = r.finishes.filter((x) => x !== f); }) },
    ]);
  };
  $('#finlist').onkeydown = (e) => { if (e.key === 'Enter' && e.target.matches('.tedit input')) { const ok = e.target.closest('.tedit').querySelector('[data-e=ok]'); ok.click(); } };
  $('#racinglist').onclick = (e) => {
    const btn = e.target.closest('button[data-r]'), row = e.target.closest('[data-bid]'); if (!btn || !row) return;
    const r = race(), b = boat(row.dataset.bid), a = btn.dataset.r;
    if (a === 'deck') deck(b.id);
    else act(label(b) + ' ' + a.toUpperCase(), () => { RC.setStatus(r, b, a); r.queue = r.queue.filter((x) => x !== b.id); });
  };
  $('#outlist').onclick = (e) => {
    const btn = e.target.closest('button[data-r]'), row = e.target.closest('[data-bid]'); if (!btn || !row) return;
    const r = race(), b = boat(row.dataset.bid), en = r.entries[b.id] || {};
    act(label(b) + ' back in', () => { RC.setStatus(r, b, null); if (en.start === 'dns' || en.start === 'dnc') RC.markStart(r, b, null); if (en.start === 'ocs') RC.markStart(r, b, 'returned'); });
  };
  $('#addtime').onclick = () => {
    const c = $('#addtimecard'), t = Math.floor(nowSec());
    c.style.display = c.style.display === 'none' ? '' : 'none';
    c.innerHTML = `<div class="row"><b>Add a finish time</b><span class="tedit"><input type="number" inputmode="numeric" id="at-h" value="${Math.floor(t / 3600)}" min="0" max="23" aria-label="hours">:<input type="number" inputmode="numeric" id="at-m" value="${String(Math.floor(t / 60) % 60).padStart(2, '0')}" min="0" max="59" aria-label="minutes">:<input type="number" inputmode="numeric" id="at-s" value="${String(t % 60).padStart(2, '0')}" min="0" max="59" aria-label="seconds"></span>
      <button class="pri" id="at-ok">Add${race().queue.length ? ' for ' + esc(label(boat(race().queue[0]))) : ''}</button><button id="at-pick">Add for…</button></div>`;
    const read = () => { const h = +$('#at-h').value, m = +$('#at-m').value, s = +$('#at-s').value; return h >= 0 && h < 24 && m >= 0 && m < 60 && s >= 0 && s < 60 ? h * 3600 + m * 60 + s : null; };
    $('#at-ok').onclick = () => { const t = read(); if (t == null) return toast('Not a time', false); act('Added ' + RC.hms(t), () => RC.recordFinish(race(), t, undefined, 'manual')); c.style.display = 'none'; };
    $('#at-pick').onclick = async () => { const t = read(); if (t == null) return toast('Not a time', false); const id = await pickBoat('Who finished at ' + RC.hms(t) + '?'); if (id === undefined) return; act('Added ' + RC.hms(t), () => RC.recordFinish(race(), t, id, 'manual')); c.style.display = 'none'; };
  };

  // boat picker: resolves boat id, null (unknown boat) or undefined (cancelled)
  let pickResolve = null;
  function pickBoat(title, current) {
    $('#picktitle').textContent = title; $('#pickq').value = '';
    const draw = () => {
      const r = race(), q = $('#pickq').value;
      const list = q.trim() ? RC.matchBoats(q, S.boats, 20).map((m) => m.boat) : RC.sortBoats(S.boats.filter((b) => !RC.finishOf(r, b.id) || b.id === current), 'sail');
      $('#picklist').innerHTML = list.map((b) => `<button data-pick="${b.id}" class="${b.id === current ? 'on' : ''}" style="text-align:left;min-height:48px"><b class="mono">${esc(b.sail)}</b> ${esc(b.name)} <span class="dim">${esc(b.fleet)}${RC.finishOf(r, b.id) && b.id !== current ? ' · finished' : ''}</span></button>`).join('') || '<div class="dim">No match</div>';
    };
    draw(); $('#pickq').oninput = draw;
    $('#pickq').onkeydown = (e) => { if (e.key === 'Enter') { const f = $('#picklist [data-pick]'); if (f) f.click(); } };
    $('#pickdlg').showModal(); $('#pickq').focus();
    return new Promise((res) => { pickResolve = res; });
  }
  const pickDone = (v) => { $('#pickdlg').close(); const f = pickResolve; pickResolve = null; if (f) f(v); };
  $('#picklist').onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) pickDone(b.dataset.pick); };
  $('#pick-none').onclick = () => pickDone(null);
  $('#pick-cancel').onclick = () => pickDone(undefined);
  $('#pickdlg').addEventListener('close', () => { if (pickResolve) pickDone(undefined); });

  // ---------- horn ----------
  const horn = { on: false, stream: null, ctx: null, an: null, det: null, timer: 0, buf: null, last: '' };
  async function hornStart() {
    try {
      horn.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { toast('Microphone: ' + (e.message || e.name), false); return; }
    const ctx = horn.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    const an = horn.an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(horn.stream).connect(an);
    horn.buf = new Float32Array(an.frequencyBinCount);
    horn.det = new HornDetector({ rise: S.set.hornRise, minMs: S.set.hornMin, latencyMs: (an.fftSize / ctx.sampleRate) * 500 + (ctx.baseLatency || 0) * 1000 });
    const binHz = ctx.sampleRate / an.fftSize;
    horn.timer = setInterval(() => {
      an.getFloatFrequencyData(horn.buf);
      const tp = performance.now(), res = horn.det.step(horn.buf, binHz, tp);
      const m = $('#meter'); m.querySelector('i').style.width = Math.max(0, Math.min(100, ((res.level - res.floor) / 30) * 100)) + '%';
      m.querySelector('u').style.left = Math.min(100, (horn.det.rise / 30) * 100) + '%'; m.classList.toggle('hit', res.hit);
      if (res.onset != null) onHorn(nowMs() - (tp - res.onset));
    }, 20);
    horn.on = true; $('#hornbtn').classList.add('on'); $('#hornbtn').textContent = '👂 Listening'; $('#hornstat').textContent = 'a horn records a finish';
  }
  function hornStop() {
    clearInterval(horn.timer); if (horn.stream) horn.stream.getTracks().forEach((t) => t.stop()); if (horn.ctx) horn.ctx.close();
    Object.assign(horn, { on: false, stream: null, ctx: null }); $('#hornbtn').classList.remove('on'); $('#hornbtn').textContent = '👂 Listen for horn'; $('#hornstat').textContent = ''; $('#meter i').style.width = 0;
  }
  function onHorn(ms) {
    const t = RC.secOfDay(ms), r = race();
    if (S.set.hornStart) {
      const seqs = RC.SEQUENCES[r.sequence];
      const near = r.starts.some((s) => s.time != null && seqs.some((g) => Math.abs(RC.wrap(t - (s.time + g.at))) < 5));
      if (near) { $('#hornstat').textContent = 'horn at ' + RC.hms(t) + ' ignored: start signal'; return; }
    }
    $('#hornstat').textContent = 'horn at ' + RC.hms(t);
    finishNow(ms, 'horn');
  }
  $('#hornbtn').onclick = () => (horn.on ? hornStop() : hornStart());

  // ---------- voice lookup ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) $('#micbtn').classList.add('hidden');
  let rec = null;
  $('#micbtn').onclick = () => {
    if (rec) { rec.abort(); return; }
    rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 4;
    $('#micbtn').classList.add('on');
    rec.onresult = (e) => {
      const alts = [...e.results[0]].map((a) => RC.spokenQuery(a.transcript)).filter(Boolean);
      const q = alts.find((a) => RC.matchBoats(a, S.boats, 1).length) || alts[0] || '';
      $('#lookup').value = q; renderSugg();
      const m = RC.matchBoats(q, S.boats, 2);
      if (m.length && m[0].score >= 85 && (!m[1] || m[1].score < m[0].score)) deck(m[0].boat.id);
    };
    rec.onend = rec.onerror = () => { rec = null; $('#micbtn').classList.remove('on'); };
    rec.start();
  };

  // ---------- camera OCR ----------
  const ocr = { stream: null, busy: false, timer: 0, worker: null, loading: null };
  const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  function loadTesseract() {
    if (ocr.worker) return Promise.resolve(ocr.worker);
    return ocr.loading || (ocr.loading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = TESS; s.onload = res; s.onerror = () => rej(new Error('could not load the OCR engine (offline?)')); document.head.appendChild(s);
    }).then(() => Tesseract.createWorker('eng')).then((w) => (ocr.worker = w)).catch((e) => { ocr.loading = null; throw e; }));
  }
  async function readText(canvas) {
    if ('TextDetector' in window) {
      try { const r = await new window.TextDetector().detect(canvas); if (r.length) return r.map((x) => x.rawValue).join('\n'); } catch (e) { /* fall through */ }
    }
    $('#camstat').textContent = ocr.worker ? 'reading…' : 'loading OCR…';
    const w = await loadTesseract();
    const { data } = await w.recognize(canvas);
    return data.text;
  }
  function grab(src, sw, sh) {
    // the guide box: 8% in from the sides, middle 40% of the height; grey, contrast stretched, at least 1000 px wide
    const x = sw * 0.08, y = sh * 0.3, w = sw * 0.84, h = sh * 0.4, k = Math.max(1, 1000 / w);
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data; let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { const v = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; d[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const sc = 255 / Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = (d[i] - lo) * sc;
    g.putImageData(im, 0, 0); return c;
  }
  async function ocrOnce(src, sw, sh) {
    if (ocr.busy) return; ocr.busy = true;
    try {
      const text = await readText(grab(src, sw, sh));
      $('#ocrtext').textContent = text.trim() || '(no text found)';
      const m = RC.matchOcr(text, S.boats);
      $('#camstat').textContent = m.length ? m.length + ' match' + (m.length > 1 ? 'es' : '') : 'no boat matched';
      $('#camsugg').innerHTML = m.map(({ boat: b, score, why }) => `<button data-sug="${b.id}"><b class="mono">${esc(b.sail)}</b> ${esc(b.name)}<br><span class="dim" style="font-size:13px">${score}% · ${esc(why)}</span></button>`).join('');
    } catch (e) { $('#camstat').textContent = e.message; }
    ocr.busy = false;
  }
  $('#cambtn').onclick = async () => {
    $('#ocrtext').textContent = ''; $('#camsugg').innerHTML = ''; $('#camstat').textContent = '';
    $('#camdlg').showModal();
    try {
      ocr.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } });
      const v = $('#cam'); v.srcObject = ocr.stream; await v.play();
    } catch (e) { $('#camstat').textContent = 'camera: ' + (e.message || e.name) + ' — use photo…'; }
  };
  const camRead = () => { const v = $('#cam'); if (v.videoWidth) ocrOnce(v, v.videoWidth, v.videoHeight); };
  $('#camread').onclick = camRead;
  $('#camauto').onchange = (e) => { clearInterval(ocr.timer); if (e.target.checked) ocr.timer = setInterval(camRead, 1500); };
  $('#camfile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const img = await createImageBitmap(f); ocrOnce(img, img.width, img.height); };
  $('#camsugg').onclick = (e) => { const b = e.target.closest('[data-sug]'); if (b) { deck(b.dataset.sug); toast(label(boat(b.dataset.sug)) + ' on deck', false); } };
  const camClose = () => { clearInterval(ocr.timer); $('#camauto').checked = false; if (ocr.stream) ocr.stream.getTracks().forEach((t) => t.stop()); ocr.stream = null; if ($('#camdlg').open) $('#camdlg').close(); };
  $('#camclose').onclick = camClose;
  $('#camdlg').addEventListener('close', camClose);

  // ---------- results ----------
  function renderResults() {
    const r = race();
    $('#scoring').value = r.scoring; $('#distance').value = r.distance ?? ''; $('#totA').value = r.totA; $('#totB').value = r.totB; $('#closed').checked = S.set.closed;
    $('#todopts').classList.toggle('hidden', r.scoring !== 'tod'); $('#totopts').classList.toggle('hidden', r.scoring !== 'tot');
    const res = RC.results(r, S.boats, { closed: S.set.closed });
    const hasCorr = r.scoring !== 'elapsed';
    $('#reslist').innerHTML = `<h2 style="margin:0 2px 8px">${esc(r.name)} <span class="dim" style="font-weight:400">${esc(r.date)}</span></h2>` + res.map((g) => `<div class="card"><div class="row"><h3 style="margin:0">${esc(g.fleet || 'No fleet')}</h3>
      <span class="dim">${g.start && g.start.time != null ? 'start ' + RC.hms(g.start.time) : 'no start time'} · ${g.entries} boats${r.scoring === 'tod' ? (r.distance ? ' · ' + r.distance + ' nm' : ' · set the course length') : ''}</span></div>
      <div class="tablewrap"><table><thead><tr><th class="num">#</th><th>Sail</th><th>Boat</th><th class="hide-sm">Type</th><th class="num">Rtg</th><th class="num">Finish</th><th class="num">Elapsed</th>${hasCorr ? '<th class="num">Corrected</th>' : ''}<th class="num">Behind</th><th class="num">Pts</th></tr></thead><tbody>
      ${g.rows.map((x) => `<tr><td class="num">${x.place ?? ''}</td><td class="mono">${esc(x.boat.sail)}</td><td>${esc(x.boat.name)}${x.ocsReturned ? ' <span class="chip" title="was over early and returned">ret</span>' : ''}</td><td class="hide-sm dim">${esc(x.boat.type)}</td><td class="num">${x.boat.rating ?? ''}</td>
        <td class="num mono">${x.finish != null ? RC.hms(x.finish) : ''}</td><td class="num mono">${x.elapsed != null ? RC.dur(x.elapsed, { hours: true }) : ''}</td>${hasCorr ? `<td class="num mono"><b>${x.corrected != null ? RC.dur(x.corrected, { hours: true }) : ''}</b></td>` : ''}
        <td class="num mono dim">${x.behind ? '+' + RC.dur(x.behind) : ''}</td><td class="num">${x.check ? `<span class="chip" style="background:var(--badbg);color:var(--bad)">${esc(x.check)}</span>` : x.code === 'racing' ? '<span class="dim">racing</span>' : (x.points ?? '') + (x.code ? ` <span class="chip">${x.code}</span>` : '')}</td></tr>`).join('')}
      </tbody></table></div></div>`).join('') + (S.boats.length ? '' : '<div class="empty">No boats.</div>');
  }
  const rset = (k, v) => act('', () => { race()[k] = v; }, { toast: false });
  $('#scoring').onchange = (e) => rset('scoring', e.target.value);
  $('#distance').onchange = (e) => rset('distance', e.target.value === '' ? null : +e.target.value);
  $('#totA').onchange = (e) => rset('totA', +e.target.value || 650);
  $('#totB').onchange = (e) => rset('totB', +e.target.value || 550);
  $('#closed').onchange = (e) => { S.set.closed = e.target.checked; save(); renderResults(); };
  function resultsText() {
    const r = race(), out = [r.name + ' — ' + r.date];
    for (const g of RC.results(r, S.boats, { closed: S.set.closed })) {
      out.push('', `${g.fleet || 'No fleet'} (start ${g.start && g.start.time != null ? RC.hms(g.start.time) : '?'}${r.scoring === 'tod' && r.distance ? ', ' + r.distance + ' nm' : ''})`);
      for (const x of g.rows) out.push([String(x.place ?? '').padStart(2), x.boat.sail.padEnd(9), x.boat.name.padEnd(16), x.finish != null ? RC.hms(x.finish) : '        ', x.elapsed != null ? RC.dur(x.elapsed, { hours: true }).padStart(8) : '        ', x.corrected != null && r.scoring !== 'elapsed' ? RC.dur(x.corrected, { hours: true }).padStart(8) : '', x.code === 'racing' ? 'racing' : (x.code || '') + (x.points != null ? ' ' + x.points : '')].join('  ').trimEnd());
    }
    return out.join('\n');
  }
  $('#copyres').onclick = async () => { try { await navigator.clipboard.writeText(resultsText()); toast('Results copied', false); } catch (e) { toast('Copy failed', false); } };
  $('#csvres').onclick = () => download(race().name.replace(/\W+/g, '_') + '_results.csv', RC.resultsCsv(race(), S.boats, { closed: S.set.closed }), 'text/csv');
  $('#printres').onclick = () => print();
  function download(name, text, type) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- settings ----------
  function fillVoices() {
    const sel = $('#s-voice'); if (!sel) return;
    sel.innerHTML = '<option value="">default</option>' + voices.map((v) => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
    sel.value = S.set.voice;
  }
  const BOOL = { 's-gps': 'useGps', 's-speak': 'speak', 's-names': 'names', 's-precount': 'preCount', 's-sayocs': 'sayOcs', 's-sayfin': 'sayFin', 's-beep': 'beep', 's-hornstart': 'hornStart', 's-wake': 'wake' };
  function renderSettings() {
    for (const id in BOOL) $('#' + id).checked = !!S.set[BOOL[id]];
    $('#s-rate').value = S.set.rate; $('#s-rise').value = S.set.hornRise; $('#s-min').value = S.set.hornMin;
    $('#s-riseval').textContent = S.set.hornRise + ' dB'; $('#s-minval').textContent = S.set.hornMin + ' ms';
    $$('#s-theme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === S.set.theme));
    fillVoices(); renderClockStat();
  }
  function renderClockStat() {
    $('#offsetval').textContent = (S.set.manualMs >= 0 ? '+' : '') + (S.set.manualMs / 1000).toFixed(1) + ' s';
    $('#gpsstat').textContent = !navigator.geolocation ? 'No geolocation in this browser.' : !S.set.useGps ? 'Off: device clock.'
      : gps.err ? 'GPS: ' + gps.err : gps.offset == null ? `Waiting for GPS fixes (${gps.fixes})…`
      : `GPS fix time is ${gps.offset >= 0 ? '+' : ''}${(gps.offset / 1000).toFixed(2)} s from the device clock, ${gps.fixes} fixes, ±${Math.round(gps.acc)} m. Some browsers stamp fixes with the device clock; then this stays near 0 and the manual offset is the way to correct the clock.`;
  }
  $('#setbtn').onclick = () => { renderSettings(); $('#setdlg').showModal(); };
  $('#setclose').onclick = () => $('#setdlg').close();
  $('#setdlg').onchange = (e) => {
    const id = e.target.id;
    if (BOOL[id]) { S.set[BOOL[id]] = e.target.checked; if (id === 's-gps') (e.target.checked ? startGps() : stopGps()); if (id === 's-wake') wake(); }
    if (id === 's-voice') S.set.voice = e.target.value;
    save(); renderSettings(); renderHeader();
  };
  $('#setdlg').oninput = (e) => {
    const id = e.target.id;
    if (id === 's-rate') S.set.rate = +e.target.value;
    if (id === 's-rise') { S.set.hornRise = +e.target.value; if (horn.det) horn.det.rise = S.set.hornRise; }
    if (id === 's-min') { S.set.hornMin = +e.target.value; if (horn.det) horn.det.minMs = S.set.hornMin; }
    $('#s-riseval').textContent = S.set.hornRise + ' dB'; $('#s-minval').textContent = S.set.hornMin + ' ms'; save();
  };
  $('#s-test').onclick = () => speak('Committee boat. Forty two, Salty Dog. Clear to cross.', { force: true });
  $('#s-theme').onclick = (e) => { const b = e.target.closest('button'); if (b) { S.set.theme = b.dataset.theme; save(); renderSettings(); renderHeader(); } };
  $$('[data-nudge]').forEach((b) => (b.onclick = () => { S.set.manualMs += +b.dataset.nudge; save(); renderClockStat(); }));
  $('#s-offreset').onclick = () => { S.set.manualMs = 0; save(); renderClockStat(); };
  $('#s-minute').addEventListener('pointerdown', (e) => {
    // the reference turned a whole minute at this tap: move our clock to the nearest whole minute
    const t = nowMs() - (performance.now() - e.timeStamp), d = Math.round(t / 60000) * 60000 - t;
    S.set.manualMs += d; save(); renderClockStat(); toast('Clock moved ' + (d >= 0 ? '+' : '') + (d / 1000).toFixed(2) + ' s', false);
  });
  $('#s-backup').onclick = () => download('committee-boat-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(S, null, 1), 'application/json');
  $('#s-restore').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { const o = JSON.parse(await f.text()); if (!Array.isArray(o.boats) || !Array.isArray(o.races)) throw new Error('not a backup'); if (!confirm('Replace everything with this backup?')) return; localStorage.setItem(KEY, JSON.stringify(o)); location.reload(); }
    catch (err) { toast('Restore failed: ' + err.message, false); }
  };
  $('#s-renamerace').onclick = () => { const n = prompt('Race name', race().name); if (n) act('Renamed', () => { race().name = n; }, { toast: false }); };
  $('#s-delrace').onclick = () => {
    if (!confirm('Delete ' + race().name + ' and all its marks and finishes?')) return;
    S.races = S.races.filter((r) => r.id !== S.cur);
    if (!S.races.length) S.races.push(RC.makeRace({ name: 'Race 1' }));
    S.cur = S.races[S.races.length - 1].id; undoStack.length = 0; save(); render(); $('#setdlg').close();
  };

  // ---------- wake lock ----------
  let lock = null;
  async function wake() {
    try {
      if (S.set.wake && !document.hidden && 'wakeLock' in navigator && !lock) { lock = await navigator.wakeLock.request('screen'); lock.onrelease = () => { lock = null; }; }
      if (!S.set.wake && lock) { lock.release(); lock = null; }
    } catch (e) { /* not allowed now */ }
  }
  document.addEventListener('visibilitychange', wake);

  // ---------- render + tick ----------
  function render() {
    renderHeader();
    if (S.set.tab === 'fleet') renderFleet();
    if (S.set.tab === 'start') renderStart();
    if (S.set.tab === 'finish') renderFinish();
    if (S.set.tab === 'results') renderResults();
  }
  const fired = new Set();
  let lastSec = -1, phaseSig = '';
  function tick() {
    const ms = nowMs(), t = RC.secOfDay(ms), r = race(), sec = Math.floor(t);
    const msTenth = Math.floor((ms % 1000) / 100);
    $('#clock').innerHTML = RC.hms(t) + '<small>.' + msTenth + '</small>';
    // signals
    for (const a of RC.announcements(r, S.boats, t, fired, { names: S.set.names, preCount: S.set.preCount })) {
      speak(a.text, { ttl: a.kind === 'count' ? 1200 : a.kind === 'pre' ? 4000 : 30000 });
      if (S.set.beep && (a.kind === 'signal' || a.kind === 'start')) beep(a.kind === 'start' ? 700 : 400);
      if (a.kind === 'start') toast(a.text.split('.')[0], false);
    }
    pump();
    if (sec === lastSec) return;
    lastSec = sec;
    $('#clocksrc').textContent = (S.set.useGps && gps.offset != null ? 'GPS time' : 'device clock') + (S.set.manualMs ? ` ${S.set.manualMs > 0 ? '+' : ''}${(S.set.manualMs / 1000).toFixed(1)} s` : '');
    // next signal across all starts
    const seqs = RC.SEQUENCES[r.sequence]; let best = null;
    for (const st of r.starts) if (st.time != null) for (const g of seqs) { const dt = RC.wrap(st.time + g.at - t); if (dt > 0 && (!best || dt < best.dt)) best = { dt, st, g }; }
    $('#nextsig').innerHTML = best && best.dt < 3600 ? `${esc(best.st.label || 'Start')} ${esc(best.g.name.toLowerCase())}<br><b class="mono">${RC.dur(best.dt)}</b>` : '';
    // start countdowns, and a full redraw when a start changes phase
    const sig = r.starts.map((s) => RC.startPhase(r, s, t).phase).join();
    if (sig !== phaseSig) { phaseSig = sig; if (S.set.tab === 'start' || S.set.tab === 'finish') render(); }
    if (S.set.tab === 'start') {
      for (const el of $$('[data-cd]')) { const st = r.starts.find((s) => s.id === el.dataset.cd); if (!st) continue; const p = RC.startPhase(r, st, t); el.textContent = p.dt == null ? '' : p.dt < 0 ? '−' + RC.dur(-p.dt) : '+' + RC.dur(p.dt); }
      renderBanner();
    }
    if ($('#setdlg').open) renderClockStat();
  }

  render(); startGps(); wake();
  setInterval(tick, 100); tick();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // for the smoke test
  window.app = { S, race, nowMs, nowSec, finishNow, onHorn, render, gps, speak, sayQ, fired, deck };
})();
