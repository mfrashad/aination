#!/usr/bin/env python3
"""Build the pixel-map atlas for AI Nation from a licensed copy of the LimeZu art.

The AI Nation repo ships WITHOUT any art. The pixel map is drawn from LimeZu's Modern Exteriors,
Modern Interiors and Modern UI packs (limezu.itch.io), plus the owner's own LimeZu-style custom pack.
Those files may not be redistributed, so this script cuts only the sprites the app draws out of YOUR
copy of the library and packs them into:

    assets/atlas.png    one packed sprite sheet (16 px tiles)
    assets/atlas.json   frame rects, animations, anchors, tile size

`assets/` is gitignored. Never commit it. Without it the app falls back to the vector map.

Usage:
    python3 tools/build-atlas.py                 # library at ../pixel-assets (relative to the repo)
    PIXEL_ROOT=/path/to/pixel-assets python3 tools/build-atlas.py

The library layout expected is the owner's indexed clone: `limezu/` (the unzipped packs), `custom/`
(pack "my", 16x16 folder) and `characters/` (built cast sheets at 32 px). Needs Pillow.
Output is deterministic: the same library gives byte-identical files.
"""
import hashlib
import json
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit('build-atlas: needs Pillow (pip install pillow)')

REPO = Path(__file__).resolve().parent.parent
ROOT = Path(os.environ.get('PIXEL_ROOT') or (REPO.parent / 'pixel-assets')).resolve()
OUT = REPO / 'assets'
TILE = 16

EXT = 'limezu/exteriors/Modern_Exteriors_16x16/'
SORT = EXT + 'ME_Theme_Sorter_16x16/'
ANIM = EXT + 'Animated_16x16/Animated_sheets_16x16/'
UI = 'limezu/interiors/4_User_Interface_Elements/'
PREMADE = 'limezu/interiors/2_Characters/Character_Generator/0_Premade_Characters/16x16/Premade_Character_%02d.png'
CUSTOM = 'custom/16x16/'

_cache = {}


def img(rel):
    """Open a library file (first frame for GIFs) as RGBA."""
    if rel not in _cache:
        p = ROOT / rel
        if not p.exists():
            sys.exit('build-atlas: missing library file %s\n(set PIXEL_ROOT to your pixel-assets clone)' % p)
        im = Image.open(p)
        im.seek(0)
        _cache[rel] = im.convert('RGBA')
    return _cache[rel]


def gif_frames(rel):
    p = ROOT / rel
    if not p.exists():
        sys.exit('build-atlas: missing library file %s' % p)
    im = Image.open(p)
    out, durs = [], []
    for i in range(getattr(im, 'n_frames', 1)):
        im.seek(i)
        out.append(im.convert('RGBA'))
        durs.append(im.info.get('duration') or 100)
    return out, durs


def crop(rel, x, y, w, h):
    return img(rel).crop((x, y, x + w, y + h))


def trim(im):
    bb = im.getbbox()
    return (im.crop(bb), bb) if bb else (im, (0, 0, im.width, im.height))


# ------------------------------------------------------------------ what the app draws
SPRITES = {}   # name -> PIL image
ANCHORS = {}   # name -> [ax, ay] (feet / base point inside the frame)
ANIMS = {}     # name -> {frames: [names], fps}
META = {}      # name -> extra info (door points, notes)
SOURCES = []   # credits / provenance lines (library ids)


def add(name, im, anchor=None, meta=None, src=None):
    SPRITES[name] = im
    if anchor is not None:
        ANCHORS[name] = anchor
    if meta:
        META[name] = meta
    if src:
        SOURCES.append('%s <- %s' % (name, src))


def add_strip(name, rel, fw, fh, n, fps, y=0, anchor=None, src=None, first=0, step=1):
    names = []
    for i in range(n):
        fr = crop(rel, (first + i * step) * fw, y, fw, fh)
        nm = '%s#%d' % (name, i)
        add(nm, fr, anchor)
        names.append(nm)
    ANIMS[name] = {'frames': names, 'fps': fps}
    SOURCES.append('%s <- %s' % (name, src or rel))


def single(name, rel, anchor='bottom', meta=None, src=None, do_trim=True):
    im = img(rel)
    if do_trim:
        im, _ = trim(im)
    a = [im.width // 2, im.height] if anchor == 'bottom' else anchor
    add(name, im, a, meta, src or rel)


def terrain():
    tf = SORT + '1_Terrains_and_Fences_16x16.png'
    # Autotile blocks: a 3x3 rounded rect (outer corners + edges + fill) and a 2x2 inner-corner block.
    add('ter.dirt', crop(tf, 0, 480, 80, 48), src='ext/terrains-and-fences dirt path on grass (autotile)')
    add('ter.pond', crop(tf, 0, 560, 80, 48), src='ext/terrains-and-fences pond in grass (autotile)')
    # Island: grass plateau with a dirt cliff skirt (9-slice: 3 columns, rows top/mid/bottom-3).
    add('ter.island', crop(tf, 128, 672, 48, 80), src='ext/terrains-and-fences grass cliff plateau')
    add('ter.herring', crop(tf, 432, 144, 32, 32), src='ext/terrains-and-fences herringbone paving')
    add('ter.water', crop(tf, 464, 80, 16, 16), src='ext/terrains-and-fences water ripple')


def gov_hall():
    """A small brick civic hall composed from LimeZu's modular Generic Building pieces."""
    gb = SORT + '4_Generic_Buildings_16x16.png'
    left = (80, 112)    # bay corner section incl. the brick strip (7 tiles)
    door = (288, 80)    # arched door section with right pillar (5 tiles)
    rows = [(800, 16), (880, 32), (1184, 80)]   # roof top edge, roof bottom with bay notch, 1-floor facade
    W = left[1] + door[1]
    H = sum(h for _, h in rows)
    out = Image.new('RGBA', (W, H))
    y = 0
    for (sy, sh) in rows:
        out.alpha_composite(crop(gb, left[0], sy, left[1], sh), (0, y))
        out.alpha_composite(crop(gb, door[0], sy, door[1], sh), (left[1], y))
        y += sh
    # door: centre of the arch in the door section, at the bottom step
    add('bld.hall', out, [W // 2, H], {'door': [left[1] + 25, H - 2], 'w': W, 'h': H},
        'ext/generic-building modular brick pieces (composed)')


def buildings():
    S = SORT
    single('bld.home1', S + '7_Villas_Singles_16x16/ME_Singles_Villas_16x16_Toy_House_1.png', meta={'door': [42, 78]}, src='ext/villas/1-8')
    single('bld.home3', S + '7_Villas_Singles_16x16/ME_Singles_Villas_16x16_Toy_House_3.png', meta={'door': [42, 78]}, src='ext/villas/3-4')
    single('bld.home5', S + '7_Villas_Singles_16x16/ME_Singles_Villas_16x16_Toy_House_5.png', meta={'door': [42, 78]}, src='ext/villas/5-4')
    single('bld.home7', S + '7_Villas_Singles_16x16/ME_Singles_Villas_16x16_Toy_House_7.png', meta={'door': [42, 78]}, src='ext/villas/7-3')
    single('bld.power', S + '3_City_Props_Singles_16x16/ME_Singles_City_Props_16x16_Power_House_1.png', src='ext/city-props/1-51')
    single('bld.cabin', S + '11_Camping_Singles_16x16/ME_Singles_Camping_16x16_Mobile_House_Small_1.png', src='ext/camping/1-27')
    single('bld.booth', S + '3_City_Props_Singles_16x16/ME_Singles_City_Props_16x16_Orange_Structure.png', src='ext/city-props/me-city-props-orange-structure')
    single('bld.dorm', CUSTOM + 'compound/dorm-block-small.png', src='my/compound/dorm-block-small (custom pack)')
    single('bld.shop', CUSTOM + 'my-street/kedai-runcit-front.png', src='my/my-street/kedai-runcit-front (custom pack)')
    single('bld.stall1', CUSTOM + 'kopitiam/hawker-stall-noodle.png', src='my/kopitiam/hawker-stall-noodle (custom pack)')
    single('bld.stall2', CUSTOM + 'kopitiam/hawker-stall-drinks.png', src='my/kopitiam/hawker-stall-drinks (custom pack)')
    single('bld.stall3', CUSTOM + 'kopitiam/hawker-stall-wok.png', src='my/kopitiam/hawker-stall-wok (custom pack)')
    single('bld.cart', S + '10_Vehicles_Singles_16x16/ME_Singles_Vehicles_16x16_Fruit_Flowers_Cart_2.png', src='ext/vehicles/2-22')
    single('bld.hut', CUSTOM + 'border/checkpoint-hut.png', src='my/border/checkpoint-hut (custom pack)')


def props():
    cat =json.load(open(ROOT / 'index/catalog.json'))
    byid = {e['id']: e for e in cat}

    def lib(name, cid, **kw):
        e = byid.get(cid)
        if not e or not e.get('f16'):
            sys.exit('build-atlas: library id %s has no 16 px file' % cid)
        single(name, 'limezu/' + e['f16'] if not e['f16'].startswith('../') else e['f16'][3:], src=cid, **kw)

    lib('prop.tree1', 'ext/camping/1-51')
    lib('prop.tree2', 'ext/camping/2-49')
    lib('prop.tree3', 'ext/camping/9-6')
    lib('prop.tree4', 'ext/camping/5-23')
    lib('prop.bush', 'ext/camping/121')
    lib('prop.shrub', 'ext/garden/20')
    lib('prop.fbush', 'ext/city-props/7-9')
    lib('prop.flowers1', 'ext/city-props/1-25')
    lib('prop.flowers2', 'ext/city-props/3-18')
    lib('prop.stump', 'ext/camping/1-46')
    lib('prop.lamp', 'ext/city-props/5-25')
    lib('prop.planter', 'ext/city-props/1-24')
    lib('prop.litter', 'ext/city-props/1-44')
    lib('prop.atm', 'ext/city-props/1')
    lib('prop.statue', 'ext/garden/1-97')
    lib('prop.bench', 'ext/subway-and-train-station/1-63')
    lib('prop.jetty', 'my/border/jetty-plank')
    lib('prop.jettyend', 'my/border/jetty-end')
    lib('prop.topiary', 'ext/garden/1-6')
    # AI governor terminal: animated server rack (Modern Interiors, 16 px gif)
    fr, durs = gif_frames('limezu/interiors/3_Animated_objects/16x16/gif/animated_control_room_server.gif')
    names = []
    for i, f in enumerate(fr):
        nm = 'prop.server#%d' % i
        add(nm, f, [8, f.height])
        names.append(nm)
    ANIMS['prop.server'] = {'frames': names, 'fps': round(1000 / (sum(durs) / len(durs)), 2)}
    SOURCES.append('prop.server <- int/gif/animated-control-room-server')


def animated():
    add_strip('fx.fountain', ANIM + 'Fountain_16x16.png', 32, 48, 8, 8, anchor=[16, 48])
    add_strip('fx.pigeon', ANIM + 'Pigeon_16x16.png', 16, 16, 6, 6, anchor=[8, 15])
    add_strip('fx.boom', ANIM + 'Landmine_Explosion_vfx_16x16.png', 48, 48, 11, 12, anchor=[24, 40])
    add_strip('fx.fire', ANIM + 'Campfire_16x16.png', 16, 32, 6, 10, anchor=[8, 31])
    add_strip('fx.boatR', ANIM + 'Boat_1_right_1_16x16.png', 64, 32, 8, 8, anchor=[32, 22])
    add_strip('fx.boatL', ANIM + 'Boat_1_left_1_16x16.png', 64, 32, 8, 8, anchor=[32, 22])


def emotes():
    ui = UI + 'UI_16x16.png'
    pick = {'heart': (0, 2), 'quest': (0, 4), 'bang': (0, 5), 'alarm': (0, 6), 'zzz': (0, 7), 'note': (0, 8),
            'gold': (1, 2), 'cash': (1, 3), 'grim': (1, 7), 'cog': (1, 9), 'sun': (1, 10), 'drop': (1, 11)}
    for k, (row, col) in sorted(pick.items()):
        add('emo.' + k, crop(ui, 64 + col * 16, 8 if row == 0 else 40, 16, 18), [8, 17], src='int/ui emote bubble')
    for k, f in [('angry', 'UI_angry_emote_16x16.gif'), ('tear', 'UI_tear_drop_emote_16x16.gif'), ('dots', 'UI_thinking_emote_dots_16x16.gif')]:
        fr, durs = gif_frames(UI + 'Animated_Spritesheets/' + f)
        names = []
        for i, im in enumerate(fr):
            im, bb = trim(im)
            nm = 'emo.%s#%d' % (k, i)
            add(nm, im, [8 - bb[0], 32 - bb[1] - 14])
            names.append(nm)
        ANIMS['emo.' + k] = {'frames': names, 'fps': round(1000 / (sum(durs) / len(durs)), 2), 'durs': durs}
        SOURCES.append('emo.%s <- int/animated-spritesheets %s' % (k, f))


# Character sheets: LimeZu premades (16 px) and built cast sheets (32 px, halved: LimeZu draws its 32 px
# art on a 2 px grid). Rows: idle (y 32) and walk (y 64) at 16 px; each row holds right, up, left, down x 6.
CHARS = [
    # key, source, class
    ('w1', ('premade', 3)), ('w2', ('premade', 4)), ('w3', ('premade', 11)), ('w4', ('premade', 13)),
    ('w5', ('premade', 15)), ('w6', ('cast', 'mak')), ('w7', ('cast', 'worker')),
    ('o1', ('premade', 8)), ('o2', ('premade', 10)), ('o3', ('premade', 14)),
    ('e1', ('cast', 'lay-manager')), ('e2', ('premade', 19)),
    ('gai', ('cast', 'helperbot')), ('gper', ('cast', 'hr-bot')), ('gyou', ('premade', 12)),
]
DIRS = ['right', 'up', 'left', 'down']


def characters():
    for key, (kind, ref) in CHARS:
        if kind == 'premade':
            sheet = img(PREMADE % ref)
            src = 'premade character %02d (LimeZu Character Generator)' % ref
        else:
            big = img('characters/%s/sheet.png' % ref)
            sheet = big.resize((big.width // 2, big.height // 2), Image.NEAREST)
            src = 'characters/%s (built LimeZu cast sheet, halved)' % ref
        for anim, y in (('idle', 32), ('walk', 64)):
            for d, dname in enumerate(DIRS):
                names = []
                for i in range(6):
                    fr = sheet.crop((d * 96 + i * 16, y, d * 96 + i * 16 + 16, y + 32))
                    nm = 'ch.%s.%s.%s#%d' % (key, anim, dname, i)
                    add(nm, fr, [8, 31])
                    names.append(nm)
                ANIMS['ch.%s.%s.%s' % (key, anim, dname)] = {'frames': names, 'fps': 8 if anim == 'walk' else 6}
        SOURCES.append('ch.%s <- %s' % (key, src))


# ------------------------------------------------------------------ packing
def pack(sprites, width=1024):
    """Deterministic shelf packer with exact-duplicate reuse. Returns (sheet, rects)."""
    uniq, alias = {}, {}
    for name in sorted(sprites):
        im = sprites[name]
        h = hashlib.sha1(im.tobytes() + bytes(str(im.size), 'ascii')).hexdigest()
        if h in uniq:
            alias[name] = uniq[h]
        else:
            uniq[h] = name
    order = sorted(set(uniq.values()), key=lambda n: (-sprites[n].height, -sprites[n].width, n))
    rects, x, y, shelf = {}, 0, 0, 0
    for n in order:
        w, h = sprites[n].size
        if x + w > width:
            x, y, shelf = 0, y + shelf + 1, 0
        rects[n] = [x, y, w, h]
        x += w + 1
        shelf = max(shelf, h)
    H = y + shelf
    sheet = Image.new('RGBA', (width, H))
    for n, r in rects.items():
        sheet.alpha_composite(sprites[n], (r[0], r[1]))
    for a, b in alias.items():
        rects[a] = rects[b]
    return sheet, rects


def main():
    if not (ROOT / 'limezu').is_dir():
        sys.exit('build-atlas: no LimeZu library at %s (set PIXEL_ROOT)' % ROOT)
    terrain()
    gov_hall()
    buildings()
    props()
    animated()
    emotes()
    characters()
    sheet, rects = pack(SPRITES)
    OUT.mkdir(exist_ok=True)
    gi = OUT / '.gitignore'
    if not gi.exists():
        gi.write_text('# Licensed pixel art. Never commit.\n*\n')
    sheet.save(OUT / 'atlas.png', optimize=True)
    data = {
        'version': 1,
        'tile': TILE,
        'size': [sheet.width, sheet.height],
        'credit': 'Pixel art: LimeZu (limezu.itch.io)',
        'frames': rects,
        'anchors': ANCHORS,
        'anims': ANIMS,
        'meta': META,
        'chars': {k: {'src': (v[0] + ':' + str(v[1]))} for k, v in CHARS},
    }
    with open(OUT / 'atlas.json', 'w') as f:
        json.dump(data, f, sort_keys=True, separators=(',', ':'))
    with open(OUT / 'SOURCES.txt', 'w') as f:
        f.write('Pixel art: LimeZu (limezu.itch.io). Licensed; never commit or redistribute.\n')
        f.write('\n'.join(sorted(SOURCES)) + '\n')
    kb = (OUT / 'atlas.png').stat().st_size / 1024
    print('atlas.png %dx%d, %.0f KB; %d frames (%d unique); atlas.json %.0f KB' % (
        sheet.width, sheet.height, kb, len(rects), len(set(map(tuple, rects.values()))),
        (OUT / 'atlas.json').stat().st_size / 1024))


if __name__ == '__main__':
    main()
