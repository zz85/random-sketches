// Ground truth from MusicXML for evaluating ScoreShift on real IMSLP files.
// readMusicXML(text) -> { parts: [{ systems: [{ page, staves: [{ clef, fifths, notes: [{ midi, d, alter, grace, onset }] }] }] }] }
// One entry per printed system (<print new-system/new-page>), notes in onset order, chords low to high.
const STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 }, NAT = [0, 2, 4, 5, 7, 9, 11];
const CLEF = (sign, line, oct) => (sign === 'G' ? (oct === -1 ? 'treble8vb' : 'treble') : sign === 'F' ? 'bass' : sign === 'C' ? (line === 4 ? 'tenor' : 'alto') : sign);
const tag = (s, t) => { const m = s.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)</${t}>`)); return m ? m[1] : null; };
const num = (s, t, d = 0) => { const v = tag(s, t); return v == null ? d : +v; };

export function readMusicXML(xml) {
  const parts = [];
  for (const pm of xml.matchAll(/<part\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/part>/g)) {
    const body = pm[2];
    let divisions = 1, nStaves = 1, page = 0, sys = null, clefs = {}, fifths = 0;
    const systems = [];
    const newSystem = () => {
      sys = { page, staves: [] };
      for (let s = 1; s <= nStaves; s++) sys.staves.push({ clef: clefs[s] || 'treble', fifths, notes: [] });
      systems.push(sys);
    };
    let t0 = 0; // onset of measure start, in divisions (global)
    for (const mm of body.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)) {
      const m = mm[1];
      const pr = m.match(/<print\b([^>]*)>/);
      const isPage = pr && /new-page="yes"/.test(pr[1]), isSys = pr && /new-system="yes"/.test(pr[1]);
      if (isPage) page++;
      // attributes before the first note apply to the system start
      const firstNote = m.search(/<note\b/), head = firstNote < 0 ? m : m.slice(0, firstNote);
      const applyAttr = (a) => {
        if (/<divisions>/.test(a)) divisions = num(a, 'divisions', divisions);
        if (/<staves>/.test(a)) nStaves = num(a, 'staves', nStaves);
        if (/<fifths>/.test(a)) fifths = num(a, 'fifths', fifths);
        for (const c of a.matchAll(/<clef\b([^>]*)>([\s\S]*?)<\/clef>/g)) {
          const n = +(c[1].match(/number="(\d+)"/)?.[1] || 1);
          clefs[n] = CLEF(tag(c[2], 'sign'), num(c[2], 'line', 0), num(c[2], 'clef-octave-change', 0));
        }
      };
      for (const a of head.matchAll(/<attributes>([\s\S]*?)<\/attributes>/g)) applyAttr(a[1]);
      if (!sys || isPage || isSys) newSystem();
      // walk notes / backup / forward / mid-measure attributes in order
      let t = 0, lastDur = 0;
      for (const ev of m.matchAll(/<(note|backup|forward|attributes)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        const [, kind, e] = ev;
        if (kind === 'attributes') { if (ev.index > firstNote && firstNote >= 0) applyAttr(e); continue; }
        if (kind === 'backup') { t -= num(e, 'duration'); continue; }
        if (kind === 'forward') { t += num(e, 'duration'); continue; }
        const chord = /<chord\s*\/>/.test(e), grace = /<grace\b/.test(e), dur = num(e, 'duration');
        const onset = chord ? t - lastDur : t;
        if (!chord && !grace) { t += dur; lastDur = dur; }
        if (/<rest\b/.test(e) || !/<pitch>/.test(e)) continue;
        const p = tag(e, 'pitch'), step = STEP[tag(p, 'step')], alter = Math.round(num(p, 'alter')), oct = num(p, 'octave');
        const staff = num(e, 'staff', 1), d = oct * 7 + step;
        sys.staves[staff - 1]?.notes.push({ midi: 12 * (oct + 1) + NAT[step] + alter, d, alter, grace, onset: (t0 + onset) / divisions });
      }
      // measure length = furthest point reached
      let mx = 0, tt = 0;
      for (const ev of m.matchAll(/<(note|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        const e = ev[2];
        if (ev[1] === 'backup') tt -= num(e, 'duration'); else if (ev[1] === 'forward') tt += num(e, 'duration');
        else if (!/<chord\s*\/>/.test(e) && !/<grace\b/.test(e)) tt += num(e, 'duration');
        mx = Math.max(mx, tt);
      }
      t0 += mx;
    }
    for (const s of systems) for (const st of s.staves) st.notes.sort((a, b) => a.onset - b.onset || a.midi - b.midi);
    parts.push({ id: pm[1], systems });
  }
  return { parts };
}

// Levenshtein alignment of detected vs true MIDI sequences with backtrace.
// match = same pitch, sub = a head found where a true note is but with another pitch,
// del = true note missed, ins = detected note with no counterpart.
export function align(truth, got, band = Infinity) {
  const n = truth.length, m = got.length, W = m + 1;
  const D = new Int32Array((n + 1) * W), INF = 1e9;
  for (let j = 0; j <= m; j++) D[j] = j;
  for (let i = 1; i <= n; i++) {
    const c = Math.round((i * m) / Math.max(1, n)), lo = Math.max(1, c - band), hi = Math.min(m, c + band);
    D[i * W] = i;
    for (let j = 1; j <= m; j++) {
      if (j < lo || j > hi) { D[i * W + j] = INF; continue; }
      const s = D[(i - 1) * W + j - 1] + (truth[i - 1] === got[j - 1] ? 0 : 1);
      D[i * W + j] = Math.min(s, D[(i - 1) * W + j] + 1, D[i * W + j - 1] + 1);
    }
  }
  let i = n, j = m, match = 0, sub = 0, del = 0, ins = 0; const pairs = [];
  while (i > 0 || j > 0) {
    const v = D[i * W + j];
    if (i > 0 && j > 0 && v === D[(i - 1) * W + j - 1] + (truth[i - 1] === got[j - 1] ? 0 : 1)) {
      if (truth[i - 1] === got[j - 1]) match++; else sub++;
      pairs.push([i - 1, j - 1]); i--; j--;
    } else if (i > 0 && v === D[(i - 1) * W + j] + 1) { del++; pairs.push([i - 1, -1]); i--; }
    else { ins++; pairs.push([-1, j - 1]); j--; }
  }
  return { match, sub, del, ins, pairs: pairs.reverse() };
}
