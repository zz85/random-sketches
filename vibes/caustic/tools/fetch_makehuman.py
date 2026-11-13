#!/usr/bin/env python3
"""
fetch_makehuman.py - downloads the MakeHuman data the Luv model is built from, then builds it:

  python3 tools/fetch_makehuman.py            # -> assets/luv.glb, assets/wallace.glb (not committed: see assets/CREDITS.md)

It fetches only the files it needs, about 60 MB:
  - from MPFB 2's data on GitHub (CC0), at a fixed commit: the base mesh, the four macro targets Luv's shape uses,
    and the game-engine rig and its weights;
  - from the MakeHuman community's asset packs, without downloading whole packs (some are 500 MB): each pack is a
    zip on a server that answers HTTP range requests, so the script reads the zip's directory from its end and
    then each wanted file's own bytes.
Everything goes to a cache folder (assets/.makehuman, also not committed), so a second run downloads nothing.
"""
import argparse, json, os, struct, subprocess, sys, urllib.request, zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MPFB = 'https://raw.githubusercontent.com/makehumancommunity/mpfb2/6ff1eb358f6c1959ced77e79e6dd2406d9a71f49/src/mpfb/data/'
MPFB_FILES = ['3dobjs/base.obj', 'rigs/standard/rig.game_engine.json', 'rigs/standard/weights.game_engine.json'] + [
  'targets/' + t + '.target.gz' for t in [
    'macrodetails/caucasian-female-young', 'macrodetails/universal-female-young-averagemuscle-minweight',
    'macrodetails/height/female-young-averagemuscle-averageweight-maxheight',
    'macrodetails/proportions/female-young-averagemuscle-averageweight-idealproportions',
    'macrodetails/caucasian-male-young', 'macrodetails/universal-male-young-averagemuscle-maxweight',
    'macrodetails/height/male-young-averagemuscle-averageweight-maxheight',
    'macrodetails/proportions/male-young-averagemuscle-averageweight-idealproportions']]
PACKS = 'https://files.makehumancommunity.org/asset_packs/'
WANT = { # pack zip: the folders of it to take
  'dress01/dress01_cc0.zip': ['clothes/wdg_mycenaean_tunic/', 'clothes/mindfront_kimono/'],
  'suits02/suits02_cc0.zip': ['clothes/donitz_monk_robe_hood_off/'],
  'bodyparts05/bodyparts05_cc0.zip': ['clothes/wdg_scruffy_beard/'],
  'skins02/skins02_cc0.zip': ['skins/toigo_light_skin_male_bronze/'],
  'dress03/dress03_cc-by.zip': ['clothes/punkduck_winter_coat/'],
  'hair01/hair01_cc0.zip': ['hair/o4saken_long01/', 'hair/rehmanpolanski_hair_bun_brown/'],
  'skins01/skins01_cc0.zip': ['skins/darthfurby_caucasian_female/', 'skins/onlytheghosts_middle_aged_eurasian_female/'],
  'shoes01/shoes01_cc0.zip': ['clothes/toigo_stiletto_booties/'],
  'makehuman_system_assets/makehuman_system_assets_cc0.zip': ['hair/braid01/', 'eyebrows/eyebrow002/', 'eyelashes/eyelashes01/', 'eyes/low-poly/', 'eyes/materials/brown', 'hair/ponytail01/'],
}

def get(url, rng=None):
  req = urllib.request.Request(url, headers={'User-Agent': 'caustic-fetch', **({'Range': 'bytes=%d-%d' % rng} if rng else {})})
  with urllib.request.urlopen(req, timeout=120) as r: return r.read()

def size_of(url):
  req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'caustic-fetch'})
  with urllib.request.urlopen(req, timeout=60) as r: return int(r.headers['Content-Length'])

def zip_members(url):
  """the zip's central directory, read from its end: name -> (local header offset, compressed size, method)"""
  n = size_of(url); tail = get(url, (max(0, n - 65558), n - 1))
  e = tail.rfind(b'PK\x05\x06')
  if e < 0: raise RuntimeError('no zip end record in ' + url)
  cd_size, cd_off = struct.unpack('<II', tail[e + 12:e + 20])
  cd = get(url, (cd_off, cd_off + cd_size - 1)); out, i = {}, 0
  while i < len(cd) and cd[i:i + 4] == b'PK\x01\x02':
    method, = struct.unpack('<H', cd[i + 10:i + 12]); csize, = struct.unpack('<I', cd[i + 20:i + 24])
    nl, xl, cl = struct.unpack('<HHH', cd[i + 28:i + 34]); off, = struct.unpack('<I', cd[i + 42:i + 46])
    name = cd[i + 46:i + 46 + nl].decode('utf-8', 'replace'); out[name] = (off, csize, method); i += 46 + nl + xl + cl
  return out

def zip_read(url, off, csize, method):
  h = get(url, (off, off + 29)); nl, xl = struct.unpack('<HH', h[26:30])
  data = get(url, (off + 30 + nl + xl, off + 30 + nl + xl + csize - 1)) if csize else b''
  return data if method == 0 else zlib.decompress(data, -15)

def main():
  ap = argparse.ArgumentParser()
  ap.add_argument('--cache', default=os.path.join(HERE, '..', 'assets', '.makehuman'))
  ap.add_argument('--out', default=os.path.join(HERE, '..', 'assets'))
  a = ap.parse_args(); mp, ad = os.path.join(a.cache, 'mpfb'), os.path.join(a.cache, 'assets')
  for f in MPFB_FILES:
    p = os.path.join(mp, f)
    if os.path.exists(p): continue
    os.makedirs(os.path.dirname(p), exist_ok=True); open(p, 'wb').write(get(MPFB + f)); print('mpfb', f)
  for pack, prefixes in WANT.items():
    # (done once for the folders listed: a pack whose list grows is read again)
    mark = os.path.join(ad, '.' + pack.replace('/', '_') + '.done')
    if os.path.exists(mark) and open(mark).read() == json.dumps(prefixes): continue
    url = PACKS + pack; mem = zip_members(url); got = 0
    for name, (off, cs, meth) in mem.items():
      if name.endswith('/') or not any(name.startswith(p) for p in prefixes) or name.endswith('.thumb'): continue
      p = os.path.join(ad, name); os.makedirs(os.path.dirname(p), exist_ok=True)
      open(p, 'wb').write(zip_read(url, off, cs, meth)); got += 1
    if not got: raise RuntimeError('nothing of %s in %s' % (prefixes, pack))
    os.makedirs(ad, exist_ok=True); open(mark, 'w').write(json.dumps(prefixes)); print('pack', pack, got, 'files')
  for who in ('luv', 'wallace'):
    r = subprocess.call([sys.executable, os.path.join(HERE, 'makehuman_luv.py'), '--who', who, '--mpfb', mp, '--assets', ad, '--out', os.path.join(a.out, who + '.glb')])
    if r: sys.exit(r)

if __name__ == '__main__': main()
