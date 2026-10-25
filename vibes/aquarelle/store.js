/*
 * store.js - persistence. IndexedDB holds a gallery of paintings:
 *   meta    id -> {id, name, W, H, created, updated, frames, thumb (Blob), pages: [page key],
 *              page (last open), pageThumbs: {page key: Blob}}
 *   layers  page key -> {v: 2, W, H, active, paper, tint, texture, layers: [{name, visible, opacity, K, S}]}
 *           A painting or notebook has one or more pages; the first page's key is the
 *           painting's id (paintings saved before pages existed are one-page notebooks).
 *           K / S are the dried pigment layers as half floats, gzip-compressed where the
 *           browser has CompressionStream.
 *   frames  "id:n" -> JPEG Blob, the time-lapse
 *   tiles   "page key|layer uid|x,y" -> {gzipped, K, S}: an infinite page's pigment in 128 px
 *           tiles (only tiles with something on them); its layers record (v: 3) holds the
 *           layer list and where you were looking
 * Version 1 kept a single painting under paintings/"current"; it is migrated on first open.
 */

const DB = 'aquarelle';
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 3);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of ['paintings', 'meta', 'layers', 'frames', 'tiles']) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
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

export const pagesOf = (m) => (m?.pages?.length ? m.pages : [m.id]);
export const newPageKey = (id) => id + '~' + newId();

/** Save one page (data from Sim.readAll() plus look settings) under its key, and the gallery card. */
export async function savePainting(id, meta, data) {
  const layers = [];
  for (const L of data.layers) layers.push({ name: L.name, visible: L.visible, opacity: L.opacity, K: await gz(new Uint8Array(L.K.buffer)), S: await gz(new Uint8Array(L.S.buffer)) });
  await put('layers', id, { v: 2, gzipped: zipped, W: meta.W, H: meta.H, active: data.active, paper: data.paper, tint: data.tint, texture: data.texture, pattern: data.pattern, layers });
  await put('meta', meta.id || id, { ...meta, id: meta.id || id, updated: Date.now() });
}

export async function loadPainting(id) {
  const d = await get('layers', id);
  if (d?.v === 3) return d; // infinite page: layers come in tiles
  if (!d || d.v !== 2) return null;
  const layers = [];
  for (const L of d.layers) layers.push({ ...L, K: new Uint16Array((await gunz(L.K, d.gzipped)).buffer), S: new Uint16Array((await gunz(L.S, d.gzipped)).buffer) });
  return { ...d, layers };
}

// ---- infinite pages ----
const range = (prefix) => IDBKeyRange.bound(prefix, prefix + '\uffff');
/** All tiles under a key prefix as [[key, value]]. */
export const getTiles = (prefix) => tx('tiles', 'readonly', (s) => new Promise((res, rej) => {
  const out = [], c = s.openCursor(range(prefix));
  c.onsuccess = () => { const cur = c.result; if (!cur) return res(out); out.push([cur.key, cur.value]); cur.continue(); };
  c.onerror = () => rej(c.error);
}));
export const delTiles = (prefix) => tx('tiles', 'readwrite', (s) => { s.delete(range(prefix)); });
/** Write and delete tiles in one transaction: puts [[key, value]], dels [key]. */
export const writeTiles = (puts, dels) => tx('tiles', 'readwrite', (s) => { for (const [k, v] of puts) s.put(v, k); for (const k of dels) s.delete(k); });
export async function packTile(K, S) { return { gzipped: zipped, K: await gz(new Uint8Array(K.buffer)), S: await gz(new Uint8Array(S.buffer)) }; }
export async function unpackTile(v) { return { K: new Uint16Array((await gunz(v.K, v.gzipped)).buffer), S: new Uint16Array((await gunz(v.S, v.gzipped)).buffer) }; }
/** An infinite page's record (layer list, view) and the gallery card. */
export async function savePageRecord(key, meta, rec) {
  await put('layers', key, { v: 3, ...rec });
  await put('meta', meta.id, { ...meta, updated: Date.now() });
}

export async function listPaintings() { return (await all('meta')).sort((a, b) => b.updated - a.updated); }

export async function deletePainting(id) {
  const m = await get('meta', id);
  await del('meta', id);
  for (const k of new Set([id, ...pagesOf(m || { id })])) { await del('layers', k); await delTiles(k + '|'); }
  for (let i = 0; i < (m?.frames || 0); i++) await del('frames', id + ':' + i);
}

export async function duplicatePainting(id) {
  const m = await get('meta', id);
  if (!m) return null;
  const nid = newId(), pages = [], thumbs = {};
  for (const [i, k] of pagesOf(m).entries()) {
    const d = await get('layers', k); if (!d) continue;
    const nk = i === 0 ? nid : newPageKey(nid);
    await put('layers', nk, d); pages.push(nk);
    if (d.v === 3) { const ts = await getTiles(k + '|'); if (ts.length) await writeTiles(ts.map(([tk, v]) => [nk + tk.slice(k.length), v]), []); }
    if (m.pageThumbs?.[k]) thumbs[nk] = m.pageThumbs[k];
  }
  if (!pages.length) return null;
  for (let i = 0; i < (m.frames || 0); i++) { const f = await get('frames', id + ':' + i); if (f) await put('frames', nid + ':' + i, f); }
  await put('meta', nid, { ...m, id: nid, name: m.name + ' copy', pages, pageThumbs: thumbs, page: Math.min(m.page || 0, pages.length - 1), created: Date.now(), updated: Date.now() });
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
