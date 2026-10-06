// Saving a session: the user's corrections, as a small list of edits anchored to where each
// symbol was recognised (recognition is deterministic for the same image, so the anchors match
// exactly when the same page is read again). Used for the autosave in IndexedDB and for
// ScoreShift project files (.scoreshift: the source file plus the edits of every page).
// Pure, no DOM; runs under bun for the tests.

export const PROJECT_FORMAT = 'scoreshift-project', PROJECT_VERSION = 1;
const accOf = (n) => (n.accid ? n.accid.type : null);
const artOf = (n) => [...(n.artic || [])].sort().join(',');
const kcOf = (st) => (st.keyChanges || []).map((k) => ({ x: Math.round(k.x), fifths: k.fifths, manual: !!k.manual, x0: k.x0 }));

/** Remember what recognition read, before any correction (call once per freshly read page). */
export function markOriginal(model) {
  model.orig = {
    staves: model.staves.map((st) => ({ clef: st.clef.type, fifths: st.key.fifths, kc: JSON.stringify(kcOf(st)) })),
    notes: model.staves.flatMap((st, si) => st.notes.map((n) => ({ si, x: n.x, y: n.y, p: n.p, acc: accOf(n), art: artOf(n), ref: n }))),
    rests: model.staves.flatMap((st, si) => (st.rests || []).map((r) => ({ si, x: r.x, y: r.y, ref: r }))),
  };
  return model;
}

const r1 = (v) => Math.round(v * 10) / 10;
/** The corrections made since markOriginal, as plain JSON. */
export function collectEdits(model) {
  const o = model.orig; if (!o) return null;
  const staves = [], notes = [], rests = [];
  model.staves.forEach((st, si) => {
    const e = {}, os = o.staves[si];
    if (st.clef.type !== os.clef) e.clef = st.clef.type;
    if (st.key.fifths !== os.fifths) e.fifths = st.key.fifths;
    const kc = kcOf(st); if (JSON.stringify(kc) !== os.kc) e.keyChanges = kc;
    if (st.timeFix && Object.keys(st.timeFix).length) e.timeFix = st.timeFix;
    if (Object.keys(e).length) staves.push({ si, ...e });
  });
  for (const q of o.notes) {
    const n = q.ref, st = model.staves[q.si], e = {};
    if (!st.notes.includes(n)) e.del = true;
    else {
      if (n.p !== q.p) e.p = n.p;
      if (accOf(n) !== q.acc) e.acc = accOf(n);
      if (artOf(n) !== q.art) e.artic = [...(n.artic || [])];
      if (n.fix) e.fix = n.fix;
    }
    if (Object.keys(e).length) notes.push({ si: q.si, x: r1(q.x), y: r1(q.y), ...e });
  }
  for (const q of o.rests) {
    const r = q.ref, e = {};
    if (r.deleted) e.del = true;
    if (r.fix) e.fix = r.fix;
    if (Object.keys(e).length) rests.push({ si: q.si, x: r1(q.x), y: r1(q.y), ...e });
  }
  return staves.length || notes.length || rests.length ? { staves, notes, rests } : null;
}

/**
 * Apply edits from collectEdits to a freshly read model of the same page. `interpret(st)`
* re-spells a staff and `yOfP(st, p, x)` places a head (both passed in, so this module stays
 * free of the recogniser). Returns the
 * number of edits applied and of those whose symbol was not found.
 */
export function applyEdits(model, edits, { interpret, yOfP } = {}) {
  let applied = 0, missed = 0;
  if (!edits) return { applied, missed };
  const S = model.space || 16;
  const near = (list, x, y) => { let best = null, bd = 0.6 * S; for (const q of list) { const d = Math.abs(q.x - x) + Math.abs(q.y - y); if (d < bd) { bd = d; best = q; } } return best; };
  for (const e of edits.staves || []) {
    const st = model.staves[e.si]; if (!st) { missed++; continue; }
    if (e.clef) st.clef.type = e.clef;
    if (e.fifths != null) st.key.fifths = e.fifths;
    if (e.keyChanges) {
      const old = st.keyChanges || [];
      st.keyChanges = e.keyChanges.map((k) => old.find((q) => Math.abs(q.x - k.x) < 2) ? Object.assign(old.find((q) => Math.abs(q.x - k.x) < 2), { fifths: k.fifths })
        : { x: k.x, x0: k.x0 ?? k.x, x1: k.x0 ?? k.x, detected: null, fifths: k.fifths, from: null, ids: [], glyphs: [], manual: true });
      let cur = st.key.fifths; for (const k of st.keyChanges) { k.from = cur; cur = k.fifths; }
    }
    if (e.timeFix) st.timeFix = e.timeFix;
    applied++;
  }
  const touched = new Set();
  for (const e of edits.notes || []) {
    const st = model.staves[e.si], n = st && near(st.notes, e.x, e.y);
    if (!n) { missed++; continue; }
    if (e.del) { st.notes.splice(st.notes.indexOf(n), 1); const i = model.notes.indexOf(n); if (i >= 0) model.notes.splice(i, 1); }
    else {
      if (e.p != null) { n.p = e.p; if (yOfP) n.y = yOfP(st, n.p, n.x); }
      if ('acc' in e) n.accid = e.acc == null ? null : { ...(n.accid || { ids: [], box: [n.box[0] - 12, n.y - 12, n.box[0] - 2, n.y + 12] }), type: e.acc };
      if (e.artic) n.artic = e.artic;
      if (e.fix) n.fix = e.fix;
    }
    touched.add(st); applied++;
  }
  for (const e of edits.rests || []) {
    const st = model.staves[e.si], r = st && near(st.rests || [], e.x, e.y);
    if (!r) { missed++; continue; }
    if (e.del) r.deleted = true;
    if (e.fix) r.fix = e.fix;
    applied++;
  }
  if (interpret) for (const st of model.staves) interpret(st);
  return { applied, missed };
}

// ---------------------------------------------------------------- project files

const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

/** A project: the source file's bytes, its name and type, edits per page, the settings. */
export function makeProject({ bytes, name, mime, pages, settings }) {
  return JSON.stringify({ format: PROJECT_FORMAT, version: PROJECT_VERSION, saved: new Date().toISOString(), name, mime, settings, pages, source: b64(bytes) });
}
/** Parse a project file; returns { bytes, name, mime, pages, settings } or null if it is not one. */
export function readProject(text) {
  let j; try { j = JSON.parse(text); } catch (e) { return null; }
  if (!j || j.format !== PROJECT_FORMAT) return null;
  if (j.version > PROJECT_VERSION) throw new Error(`project version ${j.version} is newer than this app`);
  return { bytes: unb64(j.source), name: j.name, mime: j.mime, pages: j.pages || {}, settings: j.settings || {} };
}

/** Content key of a source file (same file -> same key), for the autosave. */
export async function fileKey(bytes) {
  if (globalThis.crypto?.subtle) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return [...d.slice(0, 12)].map((v) => v.toString(16).padStart(2, '0')).join(''); }
  let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } return 'f' + h.toString(16) + bytes.length.toString(16);
}
