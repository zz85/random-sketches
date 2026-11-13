#!/usr/bin/env python3
"""
makehuman_luv.py - builds assets/luv.glb (and, with --who wallace, assets/wallace.glb), the MakeHuman Luv and Wallace
for Caustic's People, from MakeHuman's own data:

  - the base mesh, its targets (shape), the game-engine rig and its weights, from MPFB 2's data (CC0):
      git clone --depth 1 --filter=blob:none --sparse https://github.com/makehumancommunity/mpfb2
      (cd mpfb2 && git sparse-checkout set src/mpfb/data)
  - the clothes, hair, skins, eyebrows, eyelashes and eyes, from the asset packs
      (https://static.makehumancommunity.org/assets/assetpacks/index.html): dress01, dress03, hair01, skins01 and
      makehuman_system_assets, unzipped into one folder.

  python3 tools/makehuman_luv.py --mpfb /tmp/mh/mpfb2/src/mpfb/data --assets /tmp/mh/a --out assets/luv.glb

The body is shaped as MakeHuman shapes it (its macro targets: a young caucasian woman, tall, slim, with ideal
proportions), each clothing and hair is fitted to it as MakeHuman fits a proxy (every vertex a weighted sum of
three body vertices plus a scaled offset), and every mesh is skinned to the rig, its weights the body's at those
vertices. The shoes, stiletto booties, are modelled on a foot pointed toe-down: they are turned back toe-up about
the ankle by each vertex's share of the foot's weight, and the page points the foot down again. The glb holds one body per outfit (the body under each with the vertices it hides left out, sharing
one set of vertex data), both outfits, three hairstyles and two skins; Caustic shows one of each. Its bones have
no rotation at rest, so the page drives them from world directions alone. The textures are cut to 1024 px.
"""
import argparse, gzip, io, json, math, os, re, struct, sys
import numpy as np
from PIL import Image

PEOPLE = {
  'luv': {
    'name': 'Luv',
    'shape': { # the macro shape: (target, weight)
      'macrodetails/caucasian-female-young': 1.0,
      'macrodetails/universal-female-young-averagemuscle-minweight': 0.35,
      'macrodetails/height/female-young-averagemuscle-averageweight-maxheight': 0.2,
      'macrodetails/proportions/female-young-averagemuscle-averageweight-idealproportions': 0.8,
    },
    'outfits': {'tunic': 'clothes/wdg_mycenaean_tunic/wdg_mycenaean_tunic.mhclo', 'coat': 'clothes/punkduck_winter_coat/punkduck_winter_coat.mhclo'},
    'hairs': {'bun': 'hair/rehmanpolanski_hair_bun_brown/rehmanpolanski_hair_bun_brown.mhclo', 'long': 'hair/o4saken_long01/o4saken_long01.mhclo', 'braid': 'hair/braid01/braid01.mhclo'},
    'skins': {'caucasian': 'skins/darthfurby_caucasian_female/darthfurby_caucasian_female.mhmat', 'eurasian': 'skins/onlytheghosts_middle_aged_eurasian_female/onlytheghosts_middle_aged_eurasian_female.mhmat'},
    # heels: stiletto booties, modelled around a foot pointed 33 degrees toe-down (found by fitting the foot into
    # them) with their soles 6.9 cm under the flat foot's, so the figure stands that much taller in them
    'shoes': {'stiletto': 'clothes/toigo_stiletto_booties/toigo_stiletto_booties.mhclo'}, 'pitch': math.radians(33),
    'extra': {},
  },
  'wallace': {
    'name': 'Wallace',
    'shape': {
      'macrodetails/caucasian-male-young': 1.0,
      'macrodetails/universal-male-young-averagemuscle-maxweight': 0.12,
      'macrodetails/height/male-young-averagemuscle-averageweight-maxheight': 0.155,
      'macrodetails/proportions/male-young-averagemuscle-averageweight-idealproportions': 0.6,
    },
    # a dark robe, his long hair tied back, a short beard, barefoot as in the film
    'outfits': {'kimono': 'clothes/mindfront_kimono/mindfront_kimono.mhclo', 'robe': 'clothes/donitz_monk_robe_hood_off/donitz_monk_robe_hood_off.mhclo'},
    'hairs': {'ponytail': 'hair/ponytail01/ponytail01.mhclo'},
    'skins': {'light': 'skins/toigo_light_skin_male_bronze/toigo_light_skin_male_bronze.mhmat'},
    'shoes': {}, 'pitch': 0.0,
    'extra': {'beard': 'clothes/wdg_scruffy_beard/wdg_scruffy_beard.mhclo'},
    'tints': {'outfit_kimono': [0.16, 0.13, 0.11], 'outfit_robe': [0.22, 0.2, 0.18]}, # his robes dark, near black
  },
}
FACE = {'eyebrows': 'eyebrows/eyebrow002/eyebrow002.mhclo', 'eyelashes': 'eyelashes/eyelashes01/eyelashes01.mhclo', 'eyes': 'eyes/low-poly/low-poly.mhclo'}
SKINS = {'caucasian': 'skins/darthfurby_caucasian_female/darthfurby_caucasian_female.mhmat', 'eurasian': 'skins/onlytheghosts_middle_aged_eurasian_female/onlytheghosts_middle_aged_eurasian_female.mhmat'}
SCALE = 0.1 # MakeHuman's decimetres to metres
TEX = 1024

def load_obj(path):
  v, vt, faces, g = [], [], [], None
  for line in open(path, encoding='utf-8', errors='replace'):
    if line.startswith('v '): v.append([float(x) for x in line.split()[1:4]])
    elif line.startswith('vt '): vt.append([float(x) for x in line.split()[1:3]])
    elif line.startswith('g '): g = line.split(None, 1)[1].strip()
    elif line.startswith('f '):
      a = [p.split('/') for p in line.split()[1:]]
      faces.append(([int(p[0]) - 1 for p in a], [int(p[1]) - 1 if len(p) > 1 and p[1] else -1 for p in a], g))
  return np.array(v, np.float64), np.array(vt or [[0, 0]], np.float64), faces

def load_target(path):
  d = gzip.open(path).read().decode() if path.endswith('.gz') else open(path).read()
  idx, off = [], []
  for line in d.splitlines():
    if not line or line[0] == '#': continue
    p = line.split(); idx.append(int(p[0])); off.append([float(x) for x in p[1:4]])
  return np.array(idx, np.int64), np.array(off, np.float64)

def parse_mat(path):
  m = {'dir': os.path.dirname(path)}
  for line in open(path, encoding='utf-8', errors='replace'):
    line = line.split('//')[0].strip()
    if not line or line[0] == '#': continue
    p = line.split(None, 1)
    if len(p) == 2: m[p[0]] = p[1].strip()
  return m

def parse_mhclo(path):
  c = {'dir': os.path.dirname(path), 'scale': {}, 'refs': [], 'delete': set()}
  sect = None
  for line in open(path, encoding='utf-8', errors='replace'):
    s = line.strip()
    if not s or s[0] == '#': continue
    p = s.split()
    if p[0] in ('x_scale', 'y_scale', 'z_scale'): c['scale']['xyz'.index(p[0][0])] = (int(p[1]), int(p[2]), float(p[3])); continue
    if p[0] == 'obj_file': c['obj'] = os.path.join(c['dir'], p[1]); continue
    if p[0] == 'material': c['mat'] = os.path.normpath(os.path.join(c['dir'], p[1])); continue
    if p[0] == 'verts': sect = 'verts'; continue
    if p[0] == 'delete_verts': sect = 'delete'; continue
    if p[0] in ('weights', 'offsets', 'name', 'uuid', 'basemesh', 'tag', 'z_depth', 'max_pole', 'version', 'license', 'author', 'special_pose'): sect = None if p[0] in ('weights', 'offsets') else sect; continue
    if sect == 'verts' and re.match(r'^[-0-9.e ]+$', s):
      if len(p) == 1: c['refs'].append(((int(p[0]), 0, 0), (1.0, 0.0, 0.0), (0.0, 0.0, 0.0)))
      elif len(p) >= 9: c['refs'].append(((int(p[0]), int(p[1]), int(p[2])), tuple(map(float, p[3:6])), tuple(map(float, p[6:9]))))
    elif sect == 'delete':
      i = 0
      while i < len(p):
        if i + 2 < len(p) and p[i + 1] == '-': c['delete'].update(range(int(p[i]), int(p[i + 2]) + 1)); i += 3
        else: c['delete'].add(int(p[i])); i += 1
  return c

def fit(c, V):
  """the proxy's vertices on the shaped body V: each a weighted sum of three body vertices plus its offset, scaled
  per axis by how far apart two body vertices are now against how far they were when it was made"""
  sc = np.ones(3)
  for ax, (a, b, ref) in c['scale'].items(): sc[ax] = abs(V[a][ax] - V[b][ax]) / ref
  R = np.array([r[0] for r in c['refs']]); W = np.array([r[1] for r in c['refs']]); O = np.array([r[2] for r in c['refs']])
  return (V[R] * W[..., None]).sum(1) + O * sc, R, W

def normals(P, tris):
  N = np.zeros_like(P)
  a, b, c = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
  n = np.cross(b - a, c - a)
  for k in range(3): np.add.at(N, tris[:, k], n)
  l = np.linalg.norm(N, axis=1, keepdims=True); l[l == 0] = 1
  return N / l

def build_mesh(P, UV, faces, keep=lambda f: True, skip_verts=()):
  """split vertices by (position, uv) pair, quads into triangles; returns arrays and per-vertex source index"""
  skip = set(skip_verts); key, src, uvo, tri = {}, [], [], []
  for vi, ti, g in faces:
    if not keep(g) or any(v in skip for v in vi): continue
    ids = []
    for v, t in zip(vi, ti):
      k = (v, t)
      if k not in key: key[k] = len(src); src.append(v); uvo.append(UV[t] if t >= 0 else (0, 0))
      ids.append(key[k])
    for j in range(1, len(ids) - 1): tri.append((ids[0], ids[j], ids[j + 1]))
  return np.array(src, np.int64), np.array(uvo, np.float32), np.array(tri, np.uint32)

def texture(path, alpha):
  im = Image.open(path); im.load()
  im = im.convert('RGBA' if alpha else 'RGB')
  if max(im.size) > TEX: im.thumbnail((TEX, TEX), Image.LANCZOS)
  b = io.BytesIO()
  if alpha: im.save(b, 'PNG', optimize=True); return b.getvalue(), 'image/png'
  im.save(b, 'JPEG', quality=86); return b.getvalue(), 'image/jpeg'

class GLB:
  def __init__(self):
    self.bin = bytearray(); self.j = {'asset': {'version': '2.0', 'generator': 'caustic makehuman_luv.py'}, 'buffers': [], 'bufferViews': [], 'accessors': [],
      'meshes': [], 'nodes': [], 'materials': [], 'textures': [], 'images': [], 'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}], 'skins': [], 'scenes': [{'nodes': []}], 'scene': 0}
  def view(self, data, target=None):
    while len(self.bin) % 4: self.bin.append(0)
    o = len(self.bin); self.bin += data
    v = {'buffer': 0, 'byteOffset': o, 'byteLength': len(data)}
    if target: v['target'] = target
    self.j['bufferViews'].append(v); return len(self.j['bufferViews']) - 1
  def acc(self, a, comp, typ, target=None, minmax=False):
    a = np.ascontiguousarray(a)
    v = self.view(a.tobytes(), target)
    d = {'bufferView': v, 'componentType': comp, 'count': int(a.shape[0]), 'type': typ}
    if minmax: d['min'] = a.min(0).tolist(); d['max'] = a.max(0).tolist()
    self.j['accessors'].append(d); return len(self.j['accessors']) - 1
  def image(self, data, mime):
    v = self.view(data); self.j['images'].append({'bufferView': v, 'mimeType': mime})
    self.j['textures'].append({'sampler': 0, 'source': len(self.j['images']) - 1}); return len(self.j['textures']) - 1
  def save(self, path):
    if getattr(self, 'ext', None): self.j['extensionsUsed'] = sorted(self.ext)
    self.j['buffers'] = [{'byteLength': len(self.bin)}]
    for k in [k for k, v in self.j.items() if v == []]: del self.j[k]
    js = json.dumps(self.j, separators=(',', ':')).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    while len(self.bin) % 4: self.bin.append(0)
    out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(self.bin)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(self.bin), 0x004E4942) + bytes(self.bin)
    open(path, 'wb').write(out); return len(out)

def main():
  ap = argparse.ArgumentParser()
  ap.add_argument('--who', default='luv', choices=list(PEOPLE)); ap.add_argument('--mpfb', required=True); ap.add_argument('--assets', required=True); ap.add_argument('--out', required=True)
  a = ap.parse_args()
  P0 = PEOPLE[a.who]; LUV, OUTFITS, HAIRS, SKINS, SHOES, SHOE_PITCH = P0['shape'], P0['outfits'], P0['hairs'], P0['skins'], P0['shoes'], P0['pitch']
  base, UV, faces = load_obj(os.path.join(a.mpfb, '3dobjs/base.obj'))
  V = base.copy()
  for t, w in LUV.items():
    i, o = load_target(os.path.join(a.mpfb, 'targets', t + '.target.gz')); V[i] += o * w
  # joints: the mean of each joint cube's vertices
  groups = {}
  for vi, ti, g in faces: groups.setdefault(g, set()).update(vi)
  joint = {g: V[sorted(s)].mean(0) for g, s in groups.items() if g.startswith('joint-')}
  ground = joint['joint-ground'][1]
  W2 = lambda P: (P - np.array([0, ground, 0])) * SCALE # to metres, feet on y = 0
  rig = json.load(open(os.path.join(a.mpfb, 'rigs/standard/rig.game_engine.json')))
  def end(e): return joint[e['cube_name']] if e['strategy'] == 'CUBE' else V[e['vertex_indices']].mean(0)
  names = list(rig)
  order = []
  def visit(n):
    if n in order: return
    if rig[n]['parent']: visit(rig[n]['parent'])
    order.append(n)
  for n in names: visit(n)
  head = {n: W2(end(rig[n]['head'])) for n in order}; tail = {n: W2(end(rig[n]['tail'])) for n in order}
  bi = {n: k for k, n in enumerate(order)}
  # weights, four a vertex
  wj = json.load(open(os.path.join(a.mpfb, 'rigs/standard/weights.game_engine.json')))['weights']
  WV = np.zeros((len(V), len(order)), np.float32)
  for b, l in wj.items():
    if b in bi:
      for v, x in l: WV[v, bi[b]] += x
  def top4(Wm):
    j = np.argsort(-Wm, axis=1)[:, :4]; w = np.take_along_axis(Wm, j, 1); s = w.sum(1, keepdims=True); s[s == 0] = 1
    w = w / s; w[w.sum(1) == 0, 0] = 1
    return j.astype(np.uint16), w.astype(np.float32)

  g = GLB()
  # the skeleton: nodes with no rotation, each at its head, relative to its parent's head
  jn = {}
  for n in order:
    p = rig[n]['parent']; t = head[n] - (head[p] if p else 0)
    g.j['nodes'].append({'name': n, 'translation': [float(x) for x in t]}); jn[n] = len(g.j['nodes']) - 1
  for n in order:
    kids = [jn[m] for m in order if rig[m]['parent'] == n]
    if kids: g.j['nodes'][jn[n]]['children'] = kids
  ibm = np.array([np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [-head[n][0], -head[n][1], -head[n][2], 1]], np.float32).reshape(16) for n in order], np.float32)
  g.j['skins'].append({'joints': [jn[n] for n in order], 'skeleton': jn[order[0]], 'inverseBindMatrices': g.acc(ibm, 5126, 'MAT4')})
  root = {'name': P0['name'], 'children': [jn[order[0]]], 'extras': {}}

  mats = {}
  # PBR (glTF metallic-roughness, which three.js renders as a standard or physical material): the asset's colour
  # map, its normal map where it has one, roughness from its own value, else from its specular map (a matte cloth's
  # threads, a boot's polish), else by what it is; cloth gets a sheen, the eyes a clearcoat, skin and hair a little
  # specular of their own (MakeHuman's own Phong values, shininess and specularColor, are for its old renderer)
  ROUGH = {'skin': 0.52, 'hair': 0.45, 'eyes': 0.05, 'eyebrows': 0.6, 'eyelashes': 0.6, 'beard': 0.55, 'shoes': 0.38, 'outfit': 0.82}
  def kind(name): return next((k for k in ROUGH if name == k or name.startswith(k + '_') or name.startswith(k)), 'outfit')
  def find(m, key):
    t = m.get(key)
    if not t: return None
    for p in (os.path.normpath(os.path.join(m['dir'], t)), os.path.join(m['dir'], os.path.basename(t))):
      if os.path.exists(p): return p
    # (a misspelt map name in its .mhmat: the one file in the folder that ends the same way)
    import glob
    c = [p for p in glob.glob(os.path.join(m['dir'], '*' + os.path.basename(t)[-8:]))]
    return c[0] if len(c) == 1 else None
  def rough_map(path, base):
    im = Image.open(path).convert('L')
    if max(im.size) > TEX: im.thumbnail((TEX, TEX), Image.LANCZOS)
    s = np.asarray(im, np.float32) / 255.0
    r = np.clip(base + 0.35 - 0.6 * s, 0.25, 1.0) # brighter specular: smoother
    out = np.zeros(s.shape + (3,), np.uint8); out[..., 0] = 255; out[..., 1] = (r * 255).astype(np.uint8) # (G roughness, B metal 0)
    b = io.BytesIO(); Image.fromarray(out).save(b, 'JPEG', quality=90); return b.getvalue(), 'image/jpeg'
  ext = set()
  def material(mpath, alpha, name):
    if mpath in mats: return mats[mpath]
    tint = P0.get('tints', {}).get(name)
    m = parse_mat(mpath); tex = m.get('diffuseTexture'); k = kind(name)
    col = [float(x) for x in m.get('diffuseColor', '1 1 1').split()[:3]]
    if tint: col = [c * t for c, t in zip(col, tint)]
    rough = float(m['roughness']) if 'roughness' in m else ROUGH[k]
    pbr = {'baseColorFactor': col + [1.0], 'metallicFactor': 0.0, 'roughnessFactor': rough}
    d = {'name': name, 'pbrMetallicRoughness': pbr, 'doubleSided': alpha or m.get('backfaceCull', 'True') == 'False', 'extensions': {}}
    if tex:
      tp = find(m, 'diffuseTexture')
      data, mime = texture(tp, alpha); pbr['baseColorTexture'] = {'index': g.image(data, mime)}
    np_ = find(m, 'normalmapTexture')
    if np_:
      data, mime = texture(np_, False); d['normalTexture'] = {'index': g.image(data, mime), 'scale': float(m.get('normalmapIntensity', 1.0))}
    sp = find(m, 'specularTexture') or find(m, 'specularmapTexture')
    if sp and 'roughness' not in m:
      data, mime = rough_map(sp, rough); pbr['roughnessFactor'] = 1.0; pbr['metallicRoughnessTexture'] = {'index': g.image(data, mime)}
    if k == 'outfit':
      d['extensions']['KHR_materials_sheen'] = {'sheenColorFactor': [min(1, 0.35 + 0.5 * c) for c in col], 'sheenRoughnessFactor': 0.55}; ext.add('KHR_materials_sheen')
    if k == 'eyes':
      d['extensions']['KHR_materials_clearcoat'] = {'clearcoatFactor': 1.0, 'clearcoatRoughnessFactor': 0.03}; ext.add('KHR_materials_clearcoat')
    if k in ('skin', 'hair', 'beard'):
      d['extensions']['KHR_materials_specular'] = {'specularFactor': 0.5 if k == 'skin' else 0.7}; ext.add('KHR_materials_specular')
    if not d['extensions']: del d['extensions']
    if alpha: d['alphaMode'] = 'MASK'; d['alphaCutoff'] = 0.35
    g.j['materials'].append(d); mats[mpath] = len(g.j['materials']) - 1; return mats[mpath]

  meshes = []
  def mesh(name, P, N, UVs, tri, src_w, mat, attrs=None, extras=None):
    if attrs is None:
      J, Wt = top4(src_w)
      attrs = {'POSITION': g.acc(P.astype(np.float32), 5126, 'VEC3', 34962, True), 'NORMAL': g.acc(N.astype(np.float32), 5126, 'VEC3', 34962),
               'TEXCOORD_0': g.acc(UVs * np.array([1, -1], np.float32) + np.array([0, 1], np.float32), 5126, 'VEC2', 34962),
               'JOINTS_0': g.acc(J, 5123, 'VEC4', 34962), 'WEIGHTS_0': g.acc(Wt, 5126, 'VEC4', 34962)}
    ind = g.acc(tri.reshape(-1), 5125, 'SCALAR', 34963)
    g.j['meshes'].append({'name': name, 'primitives': [{'attributes': attrs, 'indices': ind, 'material': mat}]})
    g.j['nodes'].append({'name': name, 'mesh': len(g.j['meshes']) - 1, 'skin': 0, **({'extras': extras} if extras else {})})
    meshes.append(len(g.j['nodes']) - 1); return attrs

  # the body: one per outfit, without the vertices that outfit hides, sharing the vertex data
  fits = {k: parse_mhclo(os.path.join(a.assets, p)) for k, p in OUTFITS.items()}
  src, uvb, tri_all = build_mesh(V, UV, faces, keep=lambda gr: gr == 'body')
  Pb = W2(V[src]); Nb = normals(W2(V), np.array([t for f in faces if f[2] == 'body' for t in [(f[0][0], f[0][j], f[0][j + 1]) for j in range(1, len(f[0]) - 1)]]))[src]
  skins = {k: os.path.join(a.assets, p) for k, p in SKINS.items()}
  body_mat = material(next(iter(skins.values())), False, 'skin')
  skin_tex = {}
  for k, p in skins.items():
    m = parse_mat(p); data, mime = texture(os.path.join(m['dir'], m['diffuseTexture']), False); skin_tex[k] = g.image(data, mime)
  root['extras']['skins'] = skin_tex
  attrs = None
  for k, c in [('none', None)] + list(fits.items()):
    dele = c['delete'] if c else set()
    keep = np.array([not any(int(src[i]) in dele for i in t) for t in tri_all])
    attrs = mesh('body_' + k, Pb, Nb, uvb, tri_all[keep], WV[src], body_mat, attrs, {'role': 'body', 'outfit': k})
  def proxy(name, path, alpha, extras, unpose=None):
    c = parse_mhclo(path); P, R, Wr = fit(c, V)
    pv, puv, pf = load_obj(c['obj'])
    if len(pv) != len(P): print('warning:', name, 'has', len(pv), 'obj vertices and', len(P), 'fitted', file=sys.stderr)
    n = min(len(pv), len(P)); P = P[:n]
    s, u, t = build_mesh(P, puv, [f for f in pf if max(f[0]) < n])
    Pw = W2(P); Wp = (WV[R[:n]] * Wr[:n, :, None]).sum(1)
    if unpose: Pw = unpose(Pw, Wp)
    N = normals(Pw, np.array([tt for f in pf if max(f[0]) < n for tt in [(f[0][0], f[0][j], f[0][j + 1]) for j in range(1, len(f[0]) - 1)]]))
    mesh(name, Pw[s], N[s], u, t, Wp[s], material(c['mat'], alpha, name), None, extras)
  for k, p in OUTFITS.items(): proxy('outfit_' + k, os.path.join(a.assets, p), False, {'role': 'outfit', 'outfit': k})
  for k, p in HAIRS.items(): proxy('hair_' + k, os.path.join(a.assets, p), True, {'role': 'hair', 'hair': k})
  for k, p in FACE.items(): proxy(k, os.path.join(a.assets, p), k != 'eyes', {'role': k})
  for k, p in P0['extra'].items(): proxy(k, os.path.join(a.assets, p), True, {'role': k})
  # the shoes are modelled on a pointed foot: each vertex is turned back toe-up about its ankle by its share of the
  # foot's weight, so the page's toe-down turn of the foot (by SHOE_PITCH, legs.pitch) puts it where it was modelled
  heel = 0.0
  for k, p in SHOES.items():
    def unpose(Pw, Wp):
      nonlocal heel; heel = max(heel, -float(Pw[:, 1].min()))
      out = Pw.copy()
      for side in 'lr':
        A = head['foot_' + side]; wf = Wp[:, bi['foot_' + side]] + Wp[:, bi['ball_' + side]]
        sel = wf > 1e-4
        ang = -SHOE_PITCH * wf[sel]; r = Pw[sel] - A; cs, sn = np.cos(ang), np.sin(ang)
        out[sel, 1] = A[1] + r[:, 1] * cs - r[:, 2] * sn; out[sel, 2] = A[2] + r[:, 1] * sn + r[:, 2] * cs
      return out
    proxy('shoes_' + k, os.path.join(a.assets, p), False, {'role': 'shoes', 'shoes': k}, unpose)
  # the legs' measures, which the page's walker uses in place of the mannequin's
  L = lambda x, y: float(np.linalg.norm(head[x] - head[y]))
  root['extras']['legs'] = {'hipY': float(head['thigh_l'][1]), 'thigh': L('thigh_l', 'calf_l'), 'shin': L('calf_l', 'foot_l'), 'ankle': float(head['foot_l'][1]), 'hipX': float(abs(head['thigh_l'][0])), 'height': float(W2(V[src]).max(0)[1]), 'heel': heel, 'pitch': SHOE_PITCH}
  root['extras']['bones'] = {n: {'head': [float(x) for x in head[n]], 'tail': [float(x) for x in tail[n]]} for n in order}
  root['children'] += meshes
  g.j['nodes'].append(root); g.j['scenes'][0]['nodes'] = [len(g.j['nodes']) - 1]
  g.ext = ext; size = g.save(a.out)
  print(a.out, f'{size / 1e6:.2f} MB', json.dumps(root['extras']['legs']))

if __name__ == '__main__': main()
