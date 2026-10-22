/*
 * store.js - persistence. IndexedDB holds a gallery of paintings:
 *   meta    id -> {id, name, W, H, created, updated, frames, thumb (Blob)}
 *   layers  id -> {v: 2, W, H, active, paper, tint, texture, layers: [{name, visible, opacity, K, S}]}
 *           K / S are the dried pigment layers as half floats, gzip-compressed where the
 *           browser has CompressionStream.
 *   frames  "id:n" -> JPEG Blob, the time-lapse
 * Version 1 kept a single painting under paintings/"current"; it is migrated on first open.
 */

const DB = 'aquarelle';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['paintings', 'meta', 'layers', 'frames']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode); let out;
    Promise.resolve(fn(t.objectStore(store))).then((v) => (out = v));
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  });
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
export const get = (store, key) => tx(store, 'readonly', (s) => req(s.get(key)));
export const put = (store, key, val) => tx(store, 'readwrite', (s) => { s.put(val, key); });
export const del = (store, key) => tx(store, 'readwrite', (s) => { s.delete(key); });
export const all = (store) => tx(store, 'readonly', (s) => req(s.getAll()));

export const gz = async (u8) => (typeof CompressionStream === 'undefined' ? u8 : new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()));
export const gunz = async (u8, gzipped) => (gzipped ? new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : u8);
const zipped = typeof CompressionStream !== 'undefined';

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Save a painting: data from Sim.readAll() plus look settings, and its gallery card. */
export async function savePainting(id, meta, data) {
  const layers = [];
  for (const L of data.layers) layers.push({ name: L.name, visible: L.visible, opacity: L.opacity, K: await gz(new Uint8Array(L.K.buffer)), S: await gz(new Uint8Array(L.S.buffer)) });
  await put('layers', id, { v: 2, gzipped: zipped, W: meta.W, H: meta.H, active: data.active, paper: data.paper, tint: data.tint, texture: data.texture, layers });
  await put('meta', id, { ...meta, id, updated: Date.now() });
}

export async function loadPainting(id) {
  const d = await get('layers', id);
  if (!d || d.v !== 2) return null;
  const layers = [];
  for (const L of d.layers) layers.push({ ...L, K: new Uint16Array((await gunz(L.K, d.gzipped)).buffer), S: new Uint16Array((await gunz(L.S, d.gzipped)).buffer) });
  return { ...d, layers };
}

export async function listPaintings() { return (await all('meta')).sort((a, b) => b.updated - a.updated); }

export async function deletePainting(id) {
  const m = await get('meta', id);
  await del('meta', id); await del('layers', id);
  for (let i = 0; i < (m?.frames || 0); i++) await del('frames', id + ':' + i);
}

export async function duplicatePainting(id) {
  const m = await get('meta', id), d = await get('layers', id);
  if (!m || !d) return null;
  const nid = newId();
  await put('layers', nid, d);
  for (let i = 0; i < (m.frames || 0); i++) { const f = await get('frames', id + ':' + i); if (f) await put('frames', nid + ':' + i, f); }
  await put('meta', nid, { ...m, id: nid, name: m.name + ' copy', created: Date.now(), updated: Date.now() });
  return nid;
}

export const putFrame = (id, n, blob) => put('frames', id + ':' + n, blob);
export const getFrame = (id, n) => get('frames', id + ':' + n);

/** Version 1 (a single painting, one layer) -> a gallery entry. Returns its id or null. */
export async function migrateV1() {
  const d = await get('paintings', 'current');
  if (!d || d.v !== 1) return null;
  const id = newId(), conv = !d.gzipped && zipped;
  const K = conv ? await gz(d.K) : d.K, S = conv ? await gz(d.S) : d.S;
  await put('layers', id, { v: 2, gzipped: d.gzipped || conv, W: d.W, H: d.H, active: 0, layers: [{ name: 'Layer 1', visible: true, opacity: 1, K, S }] });
  await put('meta', id, { id, name: 'Untitled', W: d.W, H: d.H, created: d.t || Date.now(), updated: d.t || Date.now(), frames: 0, thumb: null });
  await del('paintings', 'current');
  return id;
}
