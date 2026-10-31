// Sail trim model: controls -> sail shape -> per-height flow -> forces -> boat speed / heel.
// SI inside (m/s, N, m), angles in degrees. Works in the browser (window.SailModel) and in node.
(function (root) {
  'use strict';
  const KN = 0.514444, RHO = 1.225, RHO_W = 1025, D = Math.PI / 180;
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

  // A masthead sloop scaled from a 30 footer. Areas go with L^2, displacement with L^3,
  // righting moment with L^4 (beam and keel depth both grow), hull speed with sqrt(L).
  function makeBoat(ft) {
    const k = ft / 30;
    return {
      loa: ft, k,
      main: 25 * k * k, jib: 20 * k * k, spin: 55 * k * k, gen: 46 * k * k,
      mast: 12 * k, boom: 4.2 * k, jibFoot: 4.6 * k, pole: 3.6 * k,
      mass: 4200 * k ** 3, rm: 42000 * k ** 4,   // righting moment per unit tan(heel), N m
      keelA: 2.0 * k * k, keelAR: 2.5, keelZ: 1.2 * k, wet: 20 * k * k, hullV: 3.5 * Math.sqrt(k),
    };
  }
  const BOAT = makeBoat(30);
  function setBoat(ft) { return Object.assign(BOAT, makeBoat(clamp(ft, 16, 60))); }

  const H = [0.2, 0.5, 0.8];          // section heights (fraction of hoist)
  const MAIN_W = [0.42, 0.35, 0.23];  // area share per section
  const JIB_W = [0.45, 0.35, 0.20];
  const IDEAL_DRAFT = { main: 0.47, jib: 0.38 };
  // Each reef takes a slab off the foot of the main: less area, lower centre of effort, flatter.
  const REEF = [{ area: 1, hoist: 1 }, { area: 0.8, hoist: 0.86 }, { area: 0.62, hoist: 0.73 }];
  const HEADSAILS = { jib: 'Jib', spin: 'Spinnaker', gen: 'Gennaker' };

  function defaultControls() {
    return {
      mainsheet: 0.06,   // 0 = two-blocked, 1 = fully eased
      traveler: 0,       // -1 leeward .. +1 windward
      vang: 0.15,
      mainHalyard: 0.45,
      cunningham: 0,
      outhaul: 0.4,
      reef: 0,           // 0, 1 or 2 reefs
      backstay: 0.2,
      head: 'jib',       // jib | spin | gen
      jibSheet: 0.08,    // 0 = in hard
      jibLead: 0,        // -1 aft .. +1 forward
      jibHalyard: 0.45,
      wing: false,       // jib poled out to windward with a whisker pole
      spinSheet: 0.5,    // 0 = in .. 1 = eased
      spinPole: 0.6,     // 0 = at the forestay .. 1 = squared back abeam
      poleHeight: 0.45,  // 0 = low .. 1 = high
      genSheet: 0.5,
      tackLine: 0.3,     // 0 = tack on the bowsprit .. 1 = eased up
    };
  }

  const RANGES = {
    mainsheet: [0, 1], traveler: [-1, 1], vang: [0, 1], mainHalyard: [0, 1], cunningham: [0, 1],
    outhaul: [0, 1], reef: [0, 2], backstay: [0, 1], jibSheet: [0, 1], jibLead: [-1, 1], jibHalyard: [0, 1],
    spinSheet: [0, 1], spinPole: [0, 1], poleHeight: [0, 1], genSheet: [0, 1], tackLine: [0, 1],
  };
  const KEYS = {
    main: ['mainsheet', 'traveler', 'vang', 'mainHalyard', 'cunningham', 'outhaul', 'backstay'],
    jib: ['jibSheet', 'jibLead', 'jibHalyard'],
    spin: ['spinSheet', 'spinPole', 'poleHeight'],
    gen: ['genSheet', 'tackLine'],
  };
  const trimKeys = (c) => KEYS.main.concat(KEYS[c.head] || KEYS.jib);

  // Wind gradient: wind measured at 10 m.
  const grad = (z) => Math.pow(Math.max(z, 0.5) / 10, 0.12);
  const sections = (base, twist, cam, draft, adj) => H.map((h, i) => ({
    h, angle: base + twist * (h - 0.1) / 0.7, camber: cam[i], draft: clamp(draft + adj[i], 0.2, 0.7),
  }));

  // Shape of both sails from the controls, given wind load (apparent wind in knots).
  function shape(c, awsKn) {
    const L = clamp(awsKn / 15, 0, 2);
    const reef = clamp(Math.round(c.reef || 0), 0, 2), rf = REEF[reef];
    // --- Main ---
    const boom = clamp(2 - 4 * c.traveler + 78 * c.mainsheet, -3, 82);
    // The sheet only pulls the boom down while it is near the centreline; past that the vang holds the leech.
    const sheetLeech = clamp(1 - 2.8 * c.mainsheet, 0, 1);
    const leech = Math.max(c.vang, 0.95 * sheetLeech);
    const bend = clamp(0.85 * c.backstay + 0.15 * c.vang, 0, 1);
    const twistM = 2 + 16 * (1 - leech) + 5 * c.backstay + 3 * c.cunningham + 2 * L;
    const tM = 0.6 * c.mainHalyard + 0.55 * c.cunningham, needM = 0.22 + 0.3 * L * rf.area;
    const draftM = clamp(0.48 - 0.25 * (tM - needM) + 0.03 * bend + 0.02 * L, 0.3, 0.65);
    const camM = [
      0.15 - 0.08 * c.outhaul - 0.02 * bend,
      0.14 - 0.03 * c.outhaul - 0.05 * bend - 0.015 * c.cunningham,
      0.12 - 0.07 * bend - 0.01 * c.cunningham,
    ].map((x) => clamp(x - 0.012 * reef, 0.03, 0.2));
    const main = {
      boom, twist: twistM, bend, leech, draft: draftM, tension: tM, need: needM, reef, area: BOAT.main * rf.area, hoist: rf.hoist,
      luff: tM < needM - 0.15 ? 'scallops' : tM > needM + 0.35 ? 'crease' : 'smooth',
      sections: sections(boom, twistM, camM, draftM, [0.02, 0, -0.02]),
    };
    // --- Headsail ---
    const sag = clamp((1 - c.backstay) * (0.25 + 0.6 * L), 0, 1.5);
    let head;
    if (c.head === 'spin') {
      // Pole angle from the bow; pole height relative to the clew sets how the luff and foot load up.
      const poleDeg = 5 + 85 * c.spinPole, phIdeal = 0.35 + 0.15 * Math.min(L, 1), phErr = c.poleHeight - phIdeal;
      const twist = 8 + 10 * c.spinSheet + 18 * phErr, base = 18 + 0.55 * poleDeg + 40 * c.spinSheet;
      const draft = clamp(0.5 + 0.25 * phErr, 0.35, 0.65);
      head = {
        kind: 'spin', area: BOAT.spin, weights: [0.33, 0.4, 0.27], zTop: 0.95, ideal: 0.5,
        poleDeg, phIdeal, phErr, clFactor: 1 - 1.5 * phErr * phErr, twist, clew: base, sag, draft, luff: 'smooth',
        sections: sections(base, twist, [0.21, 0.24, 0.21], draft, [0.02, 0, -0.02]),
      };
    } else if (c.head === 'gen') {
      const twist = 8 + 12 * c.genSheet + 8 * c.tackLine, base = 14 + 45 * c.genSheet + 16 * c.tackLine;
      const draft = 0.45 + 0.08 * c.tackLine;
      head = {
        kind: 'gen', area: BOAT.gen, weights: [0.36, 0.38, 0.26], zTop: 0.9, ideal: 0.47, clFactor: 1,
        twist, clew: base, sag, draft, luff: 'smooth',
        sections: sections(base, twist, [0.17, 0.19, 0.16].map((x) => x + 0.03 * c.tackLine), draft, [0.02, 0, -0.02]),
      };
    } else {
      // Winged out, the whisker pole holds the clew to windward, from 30 to 90 deg off the bow.
      const clew = c.wing ? 30 + 60 * c.jibSheet : 8 + 55 * c.jibSheet;
      const twist = 6 - 8 * c.jibLead + 16 * c.jibSheet + 2 * L;
      const tJ = c.jibHalyard, needJ = 0.3 + 0.35 * L;
      const draft = clamp(0.4 - 0.25 * (tJ - needJ) + 0.04 * sag, 0.25, 0.6);
      const cam = [0.11 + 0.03 * c.jibLead, 0.11 + 0.035 * sag, 0.09 + 0.025 * sag - 0.01 * c.jibLead].map((x) => clamp(x, 0.04, 0.18));
      head = {
        kind: 'jib', wing: !!c.wing, area: BOAT.jib, weights: JIB_W, zTop: 0.85, ideal: IDEAL_DRAFT.jib, clFactor: 1,
        clew, twist, sag, draft, tension: tJ, need: needJ,
        luff: tJ < needJ - 0.15 ? 'scallops' : tJ > needJ + 0.35 ? 'crease' : 'smooth',
        sections: sections(clew, twist, cam, draft, [0.02, 0, -0.01]),
      };
    }
    return { main, head, jib: head, load: L };
  }

  // One horizontal section of a soft sail at angle of attack alpha (deg, chord to apparent wind).
  // The "groove" between luffing and stalling is wider for deeper sails with the draft forward.
  function aero(alpha, camber, draft, ideal) {
    const opt = 4 + 70 * camber;
    const w = Math.max(2, 3 + 30 * camber + (0.5 - draft) * 16);
    const luffA = opt - w / 2, stallA = opt + w / 2;
    const clMax = (0.7 + 5 * camber) * (1 - 4 * (draft - ideal) * (draft - ideal));
    let cl, state;
    if (alpha <= 0) { cl = 0; state = 'flog'; }
    else if (alpha < luffA) { cl = clMax * 0.85 * Math.pow(alpha / luffA, 1.5); state = 'luff'; }
    else if (alpha <= stallA) { cl = clMax * (0.85 + 0.15 * (alpha - luffA) / w); state = 'ok'; }
    else {
      cl = clMax * Math.max(0.55, 1 - 0.025 * (alpha - stallA));
      if (alpha > 45) cl *= Math.max(0, Math.cos((Math.min(alpha - 45, 45) / 45) * Math.PI / 2));
      state = 'stall';
    }
    const s2 = Math.sin(clamp(alpha, 0, 180) * D) ** 2;
    let cd = 0.02 + 0.08 * cl * cl + 0.3 * camber * camber + (state === 'stall' ? 1.25 * s2 : 0.05 * s2);
    if (state === 'flog') cd += 0.12;
    // Telltales: windward lifts when luffing, leeward stalls when over-trimmed.
    const near = 1.5;
    return {
      alpha, cl, cd, state, luffA, stallA,
      windward: state === 'luff' || state === 'flog' ? 'lift' : alpha < luffA + near ? 'flutter' : 'stream',
      leeward: state === 'stall' ? 'stall' : alpha > stallA - near ? 'flutter' : 'stream',
    };
  }

  function apparent(tws, twa, bs, heel) {
    const x = tws * Math.cos(twa * D) + bs, y = tws * Math.sin(twa * D) * Math.cos(heel * D);
    return { aws: Math.hypot(x, y), awa: Math.atan2(y, x) / D };
  }

  // Forces on the rig. env: { tws m/s at 10 m, twa deg (either sign), bs m/s }.
  function forces(c, env, heel) {
    heel = heel || 0;
    const twa = Math.abs(env.twa), k = BOAT.k;
    const aw0 = apparent(env.tws * grad(7 * k), twa, env.bs, heel);
    const sh = shape(c, aw0.aws / KN), hd = sh.head, mn = sh.main;
    let drive = 0, side = 0, hm = 0, fMain = 0, fHead = 0;
    const out = { main: [], head: [] };
    out.jib = out.head;
    const blanket = aw0.awa > 120 ? 0.35 + 0.65 * (180 - aw0.awa) / 60 : 1; // headsail in the main's shadow on a run
    let factor = hd.clFactor, blk = blanket;
    if (hd.kind === 'spin') {
      // Pole at right angles to the apparent wind shows the whole sail; squared back it gets clear of the main.
      hd.idealPole = clamp(aw0.awa - 90, 5, 90);
      const e = (hd.poleDeg - hd.idealPole) / 60;
      factor *= clamp(1 - 0.6 * e * e, 0.4, 1) * (1 - 0.25 * clamp((115 - aw0.awa) / 40, 0, 1));
      blk = blanket + (1 - blanket) * 0.85 * clamp(hd.poleDeg / Math.max(hd.idealPole, 10), 0, 1);
    } else if (hd.kind === 'gen') {
      // Tack down on a tight reach (luff tension), eased up on a broad one (the sail rotates out from behind the main).
      hd.tackIdeal = clamp((aw0.awa - 90) / 60, 0, 1);
      const e = c.tackLine - hd.tackIdeal;
      factor *= 1 - 0.7 * e * e;
    }
    hd.factor = factor;
    const add = (aw, a, area, z, q0) => {
      const q = 0.5 * RHO * aw.aws * aw.aws * q0;
      const Lf = q * area * a.cl, Df = q * area * a.cd, s = Math.sin(aw.awa * D), co = Math.cos(aw.awa * D);
      const dr = Lf * s - Df * co, sd = Lf * co + Df * s;
      drive += dr; side += sd; hm += sd * (z + BOAT.keelZ);
      return Math.hypot(dr, sd);
    };
    for (let i = 0; i < 3; i++) {
      const s = hd.sections[i], z = k + H[i] * BOAT.mast * hd.zTop;
      const aw = apparent(env.tws * grad(z), twa, env.bs, heel);
      // A winged jib sits on the windward side: it meets the wind from the other side of the stern and
      // is clear of the main's wind shadow; its side force pushes to windward.
      const alpha = hd.wing ? s.angle - (180 - aw.awa) : aw.awa - s.angle;
      const a = aero(alpha, s.camber, s.draft, hd.ideal);
      const sd0 = side, hm0 = hm;
      fHead += add(aw, a, hd.area * hd.weights[i], z, hd.wing ? factor : blk * factor);
      if (hd.wing) { side = sd0 - (side - sd0); hm = hm0 - (hm - hm0); }
      out.head.push(Object.assign({ awa: aw.awa, aws: aw.aws }, a));
    }
    for (let i = 0; i < 3; i++) {
      const s = mn.sections[i], z = 1.5 * k + H[i] * BOAT.mast * mn.hoist;
      const aw = apparent(env.tws * grad(z), twa, env.bs, heel);
      // The headsail heads the main a little (upwash), and a jib or gennaker backwinds its luff when sheeted inside it.
      const j = out.head[i], js = hd.sections[i], close = aw0.awa < 100 ? 1 : 0;
      const working = hd.wing ? 0 : j.state === 'ok' || j.state === 'stall' ? 1 : 0.4;
      const backwind = hd.kind === 'spin' || hd.wing ? 0 : working * clamp((s.angle - js.angle + 2) / 8, 0, 1) * close;
      const headed = 2 * working * close + 6 * backwind;
      const a = aero(aw.awa - s.angle - headed, s.camber, s.draft, IDEAL_DRAFT.main);
      a.backwind = backwind;
      fMain += add(aw, a, mn.area * MAIN_W[i], z, 1 - 0.04 * mn.reef);
      out.main.push(Object.assign({ awa: aw.awa, aws: aw.aws }, a));
    }
    // Rudder angle needed (deg, + = weather helm): heel and an aft centre of effort round the boat up.
    const helm = 0.22 * heel + 6 * (fMain - 1.1 * fHead) / (fMain + fHead + 50 * k * k);
    return { drive, side, hm, aw: aw0, shape: sh, flow: out, helm, fMain, fHead, fJib: fHead };
  }

  function hullDrag(bs, heel, side) {
    const v = Math.max(bs, 0);
    const fric = 0.5 * RHO_W * v * v * BOAT.wet * 0.0045 * (1 + 0.6 * (heel / 30) ** 2);
    const wave = 320 * BOAT.k ** 3 * Math.pow(v / BOAT.hullV, 6);
    const vk = Math.max(v, 0.8), qw = 0.5 * RHO_W * vk * vk;
    const induced = (side * side) / (qw * Math.PI * BOAT.keelAR * BOAT.keelA) * clamp(v / 0.8, 0, 1);
    const leeway = clamp((side / (qw * BOAT.keelA)) / (2 * Math.PI * 0.7) / D, 0, 15);
    return { total: fric + wave + induced, fric, wave, induced, leeway };
  }

  // Advance boat speed and heel by dt seconds. s: { tws, twa, bs, heel }.
  function step(s, c, dt) {
    const f = forces(c, s, s.heel);
    const heelEq = Math.atan(f.hm / BOAT.rm) / D;
    s.heel += (heelEq - s.heel) * Math.min(1, dt * 1.5);
    const h = hullDrag(s.bs, s.heel, f.side);
    // Rudder held against weather helm costs speed too.
    const rudder = 0.5 * RHO_W * Math.max(s.bs, 0.5) ** 2 * 0.25 * BOAT.k * BOAT.k * 0.004 * f.helm * f.helm;
    s.bs = Math.max(0, s.bs + ((f.drive - h.total - rudder) / (BOAT.mass * 1.15)) * dt);
    s.leeway = h.leeway;
    return { f, drag: h, heelEq };
  }

  function steady(c, env, iters) {
    const s = { tws: env.tws, twa: env.twa, bs: env.bs != null ? env.bs : 2, heel: env.heel || 0 };
    let r;
    for (let i = 0; i < (iters || 120); i++) r = step(s, c, 0.6);
    return Object.assign(s, { result: r });
  }

  // How well a trim sails: speed, minus a penalty for heel past 25 deg and a heavy helm.
  function score(c, env) {
    const s = steady(c, env, 90);
    return { s, value: s.bs - 0.06 * Math.max(0, s.heel - 25) - 0.02 * Math.max(0, Math.abs(s.result.f.helm) - 5) };
  }

  // Coordinate search over the continuous controls of the hoisted sails, for each number of reefs.
  function autoTrim(c0, env) {
    const keys = trimKeys(c0);
    let bestC = null, bestV = -Infinity;
    const awa = apparent(env.tws * grad(7 * BOAT.k), Math.abs(env.twa), env.bs != null ? env.bs : 2, env.heel || 0).awa;
    const wings = c0.head === 'jib' && awa > 130 ? [false, true] : [c0.head === 'jib' && awa > 130 ? !!c0.wing : false];
    // Off the wind also start from eased sheets, so a search begun close-hauled doesn't stop short.
    const eased = { mainsheet: 0.8, traveler: -1, vang: 0.6, jibSheet: 0.85, spinSheet: 0.6, spinPole: clamp((awa - 95) / 85, 0, 1), genSheet: 0.7, tackLine: clamp((awa - 90) / 60, 0, 1) };
    const starts = awa > 100 ? [{}, eased] : [{}];
    for (const wing of wings) for (const reef of [0, 1, 2]) for (const st of starts) {
      let c = Object.assign({}, c0, st, { reef, wing }), best = score(c, env).value, stepSz = 0.2;
      while (stepSz > 0.01) {
        let improved = false;
        for (const k of keys) {
          for (const dir of [1, -1]) {
            const t = Object.assign({}, c);
            t[k] = clamp(t[k] + dir * stepSz * (RANGES[k][1] - RANGES[k][0]) / 2, RANGES[k][0], RANGES[k][1]);
            const v = score(t, env).value;
            if (v > best + 1e-4) { best = v; c = t; improved = true; }
          }
        }
        if (!improved) stepSz /= 2;
      }
      if (best > bestV + 0.04) { bestV = best; bestC = c; } // a reef has to earn its keep (time to tuck it, wet crew)
    }
    return bestC;
  }

  // Plain-language trim advice, most important first.
  function coach(f, s, c) {
    const tips = [], m = f.flow.main, j = f.flow.head, sh = f.shape, hd = sh.head, awa = f.aw.awa;
    const tws = s.tws / KN, upwind = awa < 60, down = awa > 110, kite = hd.kind !== 'jib';
    const say = (pri, text) => tips.push({ pri, text });
    if (j.every((x) => x.state === 'flog') && m.every((x) => x.state === 'flog'))
      say(10, awa < 30 ? 'In irons: head is in the no-go zone. Bear away.' : 'Both sails flogging: trim in.');
    if (kite && awa < (hd.kind === 'spin' ? 70 : 55)) say(9.5, `Too tight for the ${HEADSAILS[hd.kind].toLowerCase()}: bear away or drop it and set the jib.`);
    if (s.heel > 26) {
      if (kite) say(9, `Overpowered under the ${HEADSAILS[hd.kind].toLowerCase()} (${s.heel.toFixed(0)} deg heel): ease the kite sheet and the vang in the puffs, or bear away, before she broaches.`);
      else if (c.backstay > 0.7 && c.cunningham > 0.6 && sh.main.reef < 2) say(9, `Still overpowered with everything pulled on (${s.heel.toFixed(0)} deg heel): tuck in a reef.`);
      else say(9, `Overpowered (${s.heel.toFixed(0)} deg heel): backstay on, cunningham and outhaul on, traveler down, twist the top open${sh.main.reef < 2 ? ', then reef' : ''}.`);
    }
    if (sh.main.reef > 0 && tws < 11 && s.heel < 12) say(5, 'Plenty of wind to spare: shake out the reef.');
    if (m.some((x) => x.backwind > 0.5 && (x.state === 'luff' || x.state === 'flog'))) say(8, `${HEADSAILS[hd.kind]} is backwinding the main luff: ease it or trim the main in.`);
    if (hd.kind === 'jib') {
      if (down && tws < 20) say(4, 'Off the wind: hoist the spinnaker or gennaker for more power.');
      if (!hd.wing && awa > 150) say(6.5, 'Jib collapsing behind the main: pole it out to windward, wing on wing.');
      if (hd.wing && awa < 140) say(8, 'Too high for wing on wing: the poled jib is aback. Bear away or take the pole down.');
      // Jib lead: which height luffs first
      if (hd.wing) { /* telltales read the other way round on a poled-out jib */ }
      else if (j[2].windward === 'lift' && j[0].windward !== 'lift') say(7, 'Jib top luffs first: move the jib car forward (or trim the sheet).');
      else if (j[0].windward === 'lift' && j[2].windward !== 'lift') say(7, 'Jib foot luffs first: move the jib car aft.');
      else if (j.every((x) => x.windward === 'lift')) say(7, 'Jib windward telltales lifting: trim the jib sheet or bear away.');
      else if (!down && j.every((x) => x.leeward === 'stall')) say(7, 'Jib leeward telltales stalled: ease the jib sheet or head up.');
      if (hd.luff === 'scallops') say(5, 'Scallops on the jib luff: more jib halyard.');
      if (hd.luff === 'crease') say(4, 'Vertical crease on the jib luff: ease the jib halyard.');
      if (upwind && hd.sag > 0.8) say(3, 'Forestay is sagging: the jib is deep and round in the entry. Backstay on to point higher.');
    } else {
      const reaching = awa < 120;
      if (j[1].state === 'luff' || j[1].state === 'flog') say(7.5, `${HEADSAILS[hd.kind]} luff collapsing: trim the sheet.`);
      else if (reaching && j[1].state === 'stall') say(7, `${HEADSAILS[hd.kind]} over-trimmed: ease the sheet until the luff just curls, then trim a touch.`);
      else if (reaching && j[1].alpha > j[1].luffA + 4) say(4, `Ease the ${HEADSAILS[hd.kind].toLowerCase()} sheet until the luff just starts to curl: that is the fastest trim.`);
      if (hd.kind === 'spin') {
        const e = hd.poleDeg - hd.idealPole;
        if (e < -15) say(6.5, 'Square the pole back (guy aft): keep it at right angles to the apparent wind so the kite comes out from behind the main.');
        else if (e > 15) say(6.5, 'Pole too far aft for this angle: ease the guy and bring the pole forward.');
        if (hd.phErr > 0.15) say(5.5, 'Pole too high: the top of the luff curls first. Lower the pole so the tack and clew are level.');
        else if (hd.phErr < -0.15) say(5.5, 'Pole too low: the foot curls first and the luff is tight. Raise the pole.');
      } else {
        const e = c.tackLine - hd.tackIdeal;
        if (awa > 150) say(6.5, 'Too deep for the gennaker: it hides behind the main. Head up to a broad reach and gybe downwind.');
        if (e > 0.3) say(5.5, 'Tack line too far eased for a reach: pull the tack down to tighten the luff.');
        else if (e < -0.3) say(5.5, 'Ease the tack line: the gennaker rotates out to windward from behind the main.');
      }
    }
    // Main
    if (m[2].leeward === 'stall' && m[0].leeward !== 'stall') say(6, 'Main top leech telltale hiding: leech too tight. Ease sheet or vang, or add backstay to twist.');
    else if (m[2].windward === 'lift' && m[0].windward !== 'lift') say(6, 'Main top luffing before the bottom: too much twist. More mainsheet' + (c.mainsheet > 0.25 ? ' or vang.' : '.'));
    if (m[1].leeward === 'stall' && m[0].leeward === 'stall') say(6, down ? 'Main stalled: normal on a run, it works as drag. Ease to about 90 deg to the wind.' : 'Main stalled: ease the mainsheet or drop the traveler.');
    else if (m[1].state === 'luff' || m[1].state === 'flog') say(6, 'Main luffing: trim the mainsheet' + (upwind ? ' or pull the traveler up.' : '.'));
    if (sh.main.luff === 'scallops') say(5, 'Horizontal wrinkles at the main luff: more halyard or cunningham.');
    if (sh.main.luff === 'crease') say(4, 'Vertical crease along the main luff: too much halyard/cunningham for this wind. Ease it.');
    if (sh.main.draft > 0.53) say(4, `Main draft has blown aft (${(sh.main.draft * 100).toFixed(0)}%): pull it forward with cunningham.`);
    if (upwind && tws < 8 && s.heel < 8 && sh.main.sections[1].camber < 0.11) say(3, 'Light air: make the sails fuller. Ease outhaul and backstay, allow a few luff wrinkles.');
    if (Math.abs(f.helm) > 6) say(3, f.helm > 0 ? `Heavy weather helm (${f.helm.toFixed(0)} deg rudder): traveler down, flatten the main, reduce heel.` : 'Lee helm: trim the main more or ease the headsail.');
    if (down && c.vang < 0.3) say(3, 'Off the wind the sheet no longer holds the boom down: use vang to stop the top twisting off.');
    if (!tips.length) say(0, 'Telltales streaming. Nice trim.');
    return tips.sort((a, b) => b.pri - a.pri).map((t) => t.text);
  }

  const D0 = defaultControls();
  const P = (o) => Object.assign({}, D0, o);
  const PRESETS = {
    light: { label: 'Light air beat', tws: 6, twa: 44, c: P({ mainsheet: 0.12, traveler: 0.5, vang: 0, mainHalyard: 0.3, outhaul: 0.15, backstay: 0, jibSheet: 0.12, jibLead: 0.3, jibHalyard: 0.35 }) },
    medium: { label: 'Medium beat', tws: 12, twa: 42, c: P({}) },
    breezy: { label: 'Breezy beat', tws: 21, twa: 42, c: P({ mainsheet: 0.08, traveler: -0.6, vang: 0.5, mainHalyard: 0.9, cunningham: 0.8, outhaul: 0.95, backstay: 0.9, jibSheet: 0.1, jibLead: -0.4, jibHalyard: 0.95 }) },
    gale: { label: 'Gale beat, 2 reefs', tws: 28, twa: 45, c: P({ reef: 2, mainsheet: 0.08, traveler: -0.8, vang: 0.6, mainHalyard: 0.7, cunningham: 0.6, outhaul: 1, backstay: 1, jibSheet: 0.12, jibLead: -0.6, jibHalyard: 1 }) },
    reach: { label: 'Beam reach', tws: 12, twa: 95, c: P({ mainsheet: 0.5, traveler: -1, vang: 0.45, mainHalyard: 0.5, outhaul: 0.35, backstay: 0.1, jibSheet: 0.55, jibLead: 0.4, jibHalyard: 0.5 }) },
    genReach: { label: 'Gennaker broad reach', tws: 12, twa: 125, c: P({ head: 'gen', mainsheet: 0.75, traveler: -1, vang: 0.55, outhaul: 0.3, backstay: 0, genSheet: 0.7, tackLine: 0.15 }) },
    run: { label: 'Run, jib', tws: 12, twa: 165, c: P({ mainsheet: 1, traveler: -1, vang: 0.6, outhaul: 0.2, backstay: 0, jibSheet: 0.9, jibLead: 0.5, jibHalyard: 0.4 }) },
    wing: { label: 'Run, wing on wing', tws: 12, twa: 172, c: P({ wing: true, mainsheet: 1, traveler: -1, vang: 0.6, outhaul: 0.2, backstay: 0, jibSheet: 0.85, jibLead: 0.3, jibHalyard: 0.4 }) },
    spinRun: { label: 'Spinnaker run', tws: 14, twa: 160, c: P({ head: 'spin', mainsheet: 1, traveler: -1, vang: 0.6, outhaul: 0.2, backstay: 0, spinSheet: 0.7, spinPole: 0.75, poleHeight: 0.5 }) },
  };

  const api = { KN, D, BOAT, H, RANGES, KEYS, REEF, HEADSAILS, PRESETS, IDEAL_DRAFT, makeBoat, setBoat, trimKeys, defaultControls, shape, aero, apparent, forces, hullDrag, step, steady, score, autoTrim, coach, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SailModel = api;
})(typeof self !== 'undefined' ? self : this);
