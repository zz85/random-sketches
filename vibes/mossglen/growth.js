// Where moss grows and when. Every mossable vertex (ground, stones, bark) gets a global id,
// a habitat (how much moss likes it: wet, shaded, facing up, low on a trunk), ambient
// occlusion, and an arrival time on a growth front: a shortest-path spread over the mesh
// graph from the wettest ground by the burn, cheap through good habitat and slow through
// poor, so moss creeps out along the banks, over the hummocks, up the stones and the trunks.
// Painting and scraping are per-vertex state that grows, matures and creeps to neighbours,
// kept in an RGBA8 texture (r painted, g scraped, b maturity) the shaders read by id.
import * as THREE from 'three';
import { heightAt, streamDist, streamHalfWidth, waterY, noise3, fbm3, smooth, mulberry32 } from './world.js';

export function makeGrowth() {
  const parts = [];
  let N = 0;
  const G = { parts };

  G.add = (p) => { p.offset = N; p.count = p.pos.length / 3; N += p.count; parts.push(p); return p; };

  G.finalize = ({ rocks, trees, sunDir }) => {
    G.N = N;
    const pos = (G.pos = new Float32Array(N * 3)), nor = (G.nor = new Float32Array(N * 3));
    const kind = (G.kind = new Uint8Array(N)), hab = (G.hab = new Float32Array(N)), ao = (G.ao = new Float32Array(N));
    for (const p of parts) { pos.set(p.pos, p.offset * 3); nor.set(p.nor, p.offset * 3); kind.fill(p.kind, p.offset, p.offset + p.count); }
    // ---- habitat and occlusion
    const away = new THREE.Vector3(-sunDir.x, 0, -sunDir.z).normalize();
    for (let i = 0; i < N; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2], nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
      const sd = streamDist(x, z), w = streamHalfWidth(x);
      const moist = Math.max(Math.exp(-Math.max(0, sd - w) / 3.2), smooth(1.2, -0.6, y - waterY(x) - 0.3) * 0.6);
      let shade = 0;
      for (const t of trees) { const dx = x - t.at[0], dz = z - t.at[1]; shade += Math.exp(-(dx * dx + dz * dz) / 50); }
      shade = Math.min(1, shade);
      const patch = fbm3(x * 0.35 + 5, y * 0.35, z * 0.35, 3), fine = noise3(x * 2.1, y * 2.1, z * 2.1);
      const up = Math.max(0, ny), facing = Math.max(0, nx * away.x + nz * away.z);
      const ground = heightAt(x, z);
      let h, a = 1;
      if (kind[i] === 0) {
        const slope = 1 - ny;
        h = 0.48 + 0.4 * moist + 0.3 * shade + (patch - 0.5) * 0.8 + (fine - 0.5) * 0.15 - slope * 0.6;
        if (y < waterY(x) + 0.03 && sd < w + 0.3) h = 0;                       // nothing under the water
        // hollows hold water and shade: darker, and a better home
        const lap = (heightAt(x + 0.6, z) + heightAt(x - 0.6, z) + heightAt(x, z + 0.6) + heightAt(x, z - 0.6)) / 4 - y;
        h += Math.max(-0.15, Math.min(0.2, lap * 2));
        a *= 1 - Math.min(0.35, Math.max(0, lap * 3));
        for (const r of rocks) { const d = Math.hypot(x - r.x, z - r.z) - r.r; if (d < 1.5) { a *= 1 - 0.45 * Math.exp(-Math.max(0, d) / 0.35); h += 0.15 * Math.exp(-Math.max(0, d) / 0.5); } }
        for (const t of trees) { const d = Math.hypot(x - t.at[0], z - t.at[1]); if (d < 2.5) a *= 1 - 0.35 * Math.exp(-d / 0.8); }
      } else if (kind[i] === 1) {
        // caps on the tops, patches down the sides, bare where it is steep and dry
        const p2 = fbm3(x * 1.4 + 9, y * 1.4, z * 1.4, 3);
        h = 0.26 + 0.45 * up * up + 0.12 * facing + 0.15 * moist + 0.12 * shade + (p2 - 0.5) * 1.3 + (patch - 0.5) * 0.3 - Math.max(0, -ny) * 0.6;
        a = (0.45 + 0.55 * smooth(-0.05, 0.6, y - ground)) * (0.75 + 0.25 * (ny * 0.5 + 0.5));
      } else {
        const low = smooth(2.5, 0.2, y - ground);
        h = 0.25 + 0.35 * up + 0.35 * low + 0.15 * facing + 0.15 * moist + (patch - 0.5) * 0.6 - Math.max(0, -ny) * 0.35;
        a = (0.5 + 0.5 * smooth(-0.05, 0.5, y - ground)) * (0.8 + 0.2 * (ny * 0.5 + 0.5));
      }
      hab[i] = Math.min(1, Math.max(0, h)); ao[i] = Math.min(1, Math.max(0.2, a));
    }
    // ---- graph: directed edges from the triangles, plus links from prop vertices that touch
    // the ground to the nearest ground vertex, so the front climbs from the ground onto them
    const grid = (G.grid = new Map()), CELL = (G.CELL = 0.6);
    const key = (x, y, z) => ((Math.floor(x / CELL) + 512) * 1024 + (Math.floor(y / CELL) + 512)) * 1024 + (Math.floor(z / CELL) + 512);
    G.key = key;
    for (let i = 0; i < N; i++) { const k = key(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); let c = grid.get(k); if (!c) grid.set(k, (c = [])); c.push(i); }
    const extra = [], terrain = parts[0];
    for (let i = terrain.count; i < N; i++) {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (y - heightAt(x, z) > 0.12) continue;
      let best = -1, bd = 1e9;
      G.near(x, y, z, 1.2, (j, d2) => { if (j < terrain.count && d2 < bd) { bd = d2; best = j; } });
      if (best >= 0) extra.push(i, best);
    }
    const deg = new Int32Array(N + 1);
    for (const p of parts) { const I = p.idx; for (let t = 0; t < I.length; t++) deg[I[t] + p.offset] += 2; }
    for (let e = 0; e < extra.length; e += 2) { deg[extra[e]]++; deg[extra[e + 1]]++; }
    const start = (G.adjStart = new Int32Array(N + 1));
    for (let i = 0; i < N; i++) start[i + 1] = start[i] + deg[i];
    const adj = (G.adj = new Int32Array(start[N])), fill = start.slice(0, N);
    for (const p of parts) {
      const I = p.idx, o = p.offset;
      for (let t = 0; t < I.length; t += 3) {
        const a2 = I[t] + o, b = I[t + 1] + o, c = I[t + 2] + o;
        adj[fill[a2]++] = b; adj[fill[a2]++] = c; adj[fill[b]++] = a2; adj[fill[b]++] = c; adj[fill[c]++] = a2; adj[fill[c]++] = b;
      }
    }
    for (let e = 0; e < extra.length; e += 2) { adj[fill[extra[e]]++] = extra[e + 1]; adj[fill[extra[e + 1]]++] = extra[e]; }
    // ---- arrival: Dijkstra from seeds by the burn and a few wet hollows
    const dist = new Float32Array(N).fill(Infinity), rnd = mulberry32(11);
    const heap = new Int32Array(start[N] + N), hd = new Float32Array(heap.length); let hn = 0;
    const push = (i, d) => { let k = hn++; while (k > 0) { const p = (k - 1) >> 1; if (hd[p] <= d) break; heap[k] = heap[p]; hd[k] = hd[p]; k = p; } heap[k] = i; hd[k] = d; };
    const pop = () => {
      const top = heap[0], li = heap[--hn], ld = hd[hn]; let k = 0;
      for (;;) { let c = 2 * k + 1; if (c >= hn) break; if (c + 1 < hn && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; heap[k] = heap[c]; hd[k] = hd[c]; k = c; }
      heap[k] = li; hd[k] = ld; return top;
    };
    for (let i = 0; i < terrain.count; i++) {
      const x = pos[i * 3], z = pos[i * 3 + 2], sd = streamDist(x, z) - streamHalfWidth(x);
      if (hab[i] > 0.05 && ((sd > 0 && sd < 0.8 && rnd() < 0.25) || (hab[i] > 0.85 && rnd() < 0.01))) { dist[i] = rnd() * 0.5; push(i, dist[i]); }
    }
    const run = () => {
      while (hn > 0) {
        const d0 = hd[0], i = pop(); if (d0 > dist[i]) continue;
        for (let e = start[i]; e < start[i + 1]; e++) {
          const j = adj[e], dx = pos[j * 3] - pos[i * 3], dy = pos[j * 3 + 1] - pos[i * 3 + 1], dz = pos[j * 3 + 2] - pos[i * 3 + 2];
          // slower up stones and bark than across the ground, slower still uphill
          const q = 1 - hab[j], d = d0 + Math.sqrt(dx * dx + dy * dy + dz * dz) * (0.3 + 3.2 * q * q) * (kind[j] ? 2.2 : 1) + (dy > 0 ? dy * 0.8 : 0);
          if (d < dist[j]) { dist[j] = d; push(j, d); }
        }
      }
    };
    run();
    // branches and roots are separate tubes: carry the front across to any piece it didn't
    // reach from the nearest vertex it did
    for (let pass = 0; pass < 4; pass++) {
      let n = 0;
      for (let i = 0; i < N; i++) {
        if (Number.isFinite(dist[i])) continue;
        let bd = Infinity;
        G.near(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], 0.7, (j, d2) => { if (Number.isFinite(dist[j])) bd = Math.min(bd, dist[j] + Math.sqrt(d2) * 3); });
        if (bd < Infinity) { dist[i] = bd; push(i, bd); n++; }
      }
      if (!n) break;
      run();
    }
    // normalise over the clearing, not the far hillsides
    const finite = [];
    for (let i = 0; i < N; i++) if (Number.isFinite(dist[i]) && Math.hypot(pos[i * 3], pos[i * 3 + 2] - 2) < 30) finite.push(dist[i]);
    finite.sort((a2, b) => a2 - b); const p97 = finite[Math.floor(finite.length * 0.97)] || 1;
    const arr = (G.arr = new Float32Array(N));
    for (let i = 0; i < N; i++) {
      const d = Number.isFinite(dist[i]) ? dist[i] / p97 : 1;
      arr[i] = Math.min(1, Math.max(0, Math.pow(Math.min(d, 1.1), 0.8) * 0.9 + (noise3(pos[i * 3] * 1.3, pos[i * 3 + 1] * 1.3, pos[i * 3 + 2] * 1.3) - 0.5) * 0.05));
    }
    // ---- painted state and the texture the shaders read
    G.W = 512; G.H = Math.ceil(N / G.W);
    G.data = new Uint8Array(G.W * G.H * 4);
    G.tex = new THREE.DataTexture(G.data, G.W, G.H, THREE.RGBAFormat, THREE.UnsignedByteType);
    G.tex.minFilter = G.tex.magFilter = THREE.NearestFilter; G.tex.needsUpdate = true;
    G.paint = new Float32Array(N); G.paintT = new Float32Array(N); G.scrape = new Float32Array(N); G.scrapeT = new Float32Array(N);
    G.mat = new Float32Array(N); G.spread = new Float32Array(N); G.on = new Uint8Array(N); G.active = [];
  };

  // Visit vertices within r of a point: fn(index, squared distance).
  G.near = (x, y, z, r, fn) => {
    const C = G.CELL, r2 = r * r, x0 = Math.floor((x - r) / C), x1 = Math.floor((x + r) / C), y0 = Math.floor((y - r) / C), y1 = Math.floor((y + r) / C), z0 = Math.floor((z - r) / C), z1 = Math.floor((z + r) / C);
    for (let a = x0; a <= x1; a++) for (let b = y0; b <= y1; b++) for (let c = z0; c <= z1; c++) {
      const cell = G.grid.get(((a + 512) * 1024 + (b + 512)) * 1024 + (c + 512)); if (!cell) continue;
      for (const i of cell) { const dx = G.pos[i * 3] - x, dy = G.pos[i * 3 + 1] - y, dz = G.pos[i * 3 + 2] - z, d2 = dx * dx + dy * dy + dz * dz; if (d2 <= r2) fn(i, d2); }
    }
  };

  const wake = (i) => { if (!G.on[i]) { G.on[i] = 1; G.active.push(i); } };
  // Brush: 'grow' plants moss that rises over a second or so, then creeps outward through
  // good habitat; 'scrape' strips it back to bare stone, soil or bark.
  G.brush = (p, r, mode, strength = 1) => {
    G.near(p.x, p.y, p.z, r, (i, d2) => {
      const w = Math.min(1, (1 - d2 / (r * r)) * 1.8) * strength;
      if (mode === 'scrape') { G.scrapeT[i] = Math.max(G.scrapeT[i], w); if (w > 0.3) { G.paintT[i] = 0; } }
      else { if (w > G.paintT[i]) { G.paintT[i] = w; G.spread[i] = 0; } G.scrapeT[i] = Math.max(0, G.scrapeT[i] - w); }
      wake(i);
    });
  };
  G.creep = 1.2; // metres a painted patch creeps in good habitat before it thins to half
  G.update = (dt) => {
    const A = G.active, keep = [], { paint, paintT, scrape, scrapeT, mat, hab, pos, adj, adjStart, data } = G;
    for (let k = 0; k < A.length; k++) {
      const i = A[k], rate = 1.8 * (0.5 + hab[i]);
      paint[i] += (paintT[i] - paint[i]) * Math.min(1, dt * (paintT[i] > paint[i] ? rate : 6));
      scrape[i] += (scrapeT[i] - scrape[i]) * Math.min(1, dt * 8);
      const mt = paint[i] * (0.45 + 0.55 * hab[i]);
      mat[i] += (mt - mat[i]) * Math.min(1, dt * (mt > mat[i] ? 0.35 : 4));
      if (paint[i] > 0.3 && G.spread[i] < paintT[i]) {
        G.spread[i] = paintT[i];
        for (let e = adjStart[i]; e < adjStart[i + 1]; e++) {
          const j = adj[e]; if (scrapeT[j] > 0.5) continue;
          const len = Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]);
          const c = paintT[i] - 0.5 * len / (G.creep * (0.1 + 0.9 * hab[j] * hab[j])); // full strength to half over `creep` metres
          if (c > paintT[j] + 0.02) { paintT[j] = c; G.spread[j] = 0; wake(j); }
        }
      }
      data[i * 4] = paint[i] * 255; data[i * 4 + 1] = scrape[i] * 255; data[i * 4 + 2] = mat[i] * 255;
      const settled = Math.abs(paintT[i] - paint[i]) < 0.004 && Math.abs(scrapeT[i] - scrape[i]) < 0.004 && Math.abs(mt - mat[i]) < 0.004;
      if (settled) G.on[i] = 0; else keep.push(i);
    }
    if (A.length) G.tex.needsUpdate = true;
    G.active = keep;
  };
  G.clear = () => {
    for (const a of [G.paint, G.paintT, G.scrape, G.scrapeT, G.mat, G.spread]) a.fill(0);
    G.data.fill(0); G.on.fill(0); G.active = []; G.tex.needsUpdate = true;
  };

  // The same moss state the shaders compute, for tests and the coverage readout.
  G.state = (i, u) => {
    const gate = smooth(1 - u.cover, 1 - u.cover + 0.16, G.hab[i]);
    const autoM = smooth(G.arr[i], G.arr[i] + 0.06, u.grow) * gate;
    return Math.max(autoM, G.paint[i]) * (1 - G.scrape[i]);
  };
  G.coverage = (u, from = 0, to = N) => { let s = 0, n = 0; for (let i = from; i < to; i++) { if (G.hab[i] <= 0 && G.kind[i] === 0) continue; s += G.state(i, u) > 0.5 ? 1 : 0; n++; } return n ? s / n : 0; };

  // One geometry with the moss attributes for a run of consecutive parts (one draw call).
  G.geometry = (list) => {
    const o = list[0].offset, n = list.reduce((s, p) => s + p.count, 0), ni = list.reduce((s, p) => s + p.idx.length, 0);
    const idx = new Uint32Array(ni); let k = 0;
    for (const p of list) { for (let t = 0; t < p.idx.length; t++) idx[k++] = p.idx[t] + p.offset - o; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(G.pos.subarray(o * 3, (o + n) * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(G.nor.subarray(o * 3, (o + n) * 3), 3));
    const vid = new Float32Array(n), kd = new Float32Array(n);
    for (let i = 0; i < n; i++) { vid[i] = o + i; kd[i] = G.kind[o + i]; }
    g.setAttribute('vid', new THREE.BufferAttribute(vid, 1));
    g.setAttribute('hab', new THREE.BufferAttribute(G.hab.subarray(o, o + n), 1));
    g.setAttribute('arr', new THREE.BufferAttribute(G.arr.subarray(o, o + n), 1));
    g.setAttribute('ao', new THREE.BufferAttribute(G.ao.subarray(o, o + n), 1));
    g.setAttribute('kind', new THREE.BufferAttribute(kd, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  };

  // Scatter n points over the parts' triangles, weighted by area and weight(i) at each
  // corner; each point takes the id, habitat and arrival of its nearest corner.
  G.scatter = (n, weight, rnd, partFilter = () => true) => {
    const tris = [], cum = [];
    let tot = 0;
    for (const p of parts) {
      if (!partFilter(p)) continue;
      const I = p.idx, o = p.offset;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] + o, b = I[t + 1] + o, c = I[t + 2] + o;
        const w = (weight(a) + weight(b) + weight(c)) / 3; if (w <= 0) continue;
        const P = G.pos, ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2], vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        tot += area * w; tris.push(a, b, c); cum.push(tot);
      }
    }
    const out = [];
    if (!tot) return out;
    for (let k = 0; k < n; k++) {
      const r = rnd() * tot; let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
      const a = tris[lo * 3], b = tris[lo * 3 + 1], c = tris[lo * 3 + 2];
      let u = rnd(), v = rnd(); if (u + v > 1) { u = 1 - u; v = 1 - v; } const w = 1 - u - v;
      const P = G.pos, Nn = G.nor, q = [0, 0, 0], nn = [0, 0, 0];
      for (let d = 0; d < 3; d++) { q[d] = P[a * 3 + d] * w + P[b * 3 + d] * u + P[c * 3 + d] * v; nn[d] = Nn[a * 3 + d] * w + Nn[b * 3 + d] * u + Nn[c * 3 + d] * v; }
      const l = Math.hypot(...nn) || 1;
      const near = w >= u && w >= v ? a : u >= v ? b : c;
      out.push({ p: q, n: nn.map((x) => x / l), vid: near, hab: G.hab[near], arr: G.arr[a] * w + G.arr[b] * u + G.arr[c] * v, kind: G.kind[near] });
    }
    return out;
  };
  return G;
}
