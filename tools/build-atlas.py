#!/usr/bin/env python3
"""Build the pixel-map atlas for AI Nation from a licensed copy of the LimeZu art.

The AI Nation repo ships WITHOUT any art. The pixel map is drawn from LimeZu's Modern Exteriors,
Modern Interiors and Modern UI packs (limezu.itch.io), plus the owner's own LimeZu-style custom pack.
Those files may not be redistributed, so this script cuts only the sprites the app draws out of YOUR
copy of the library and packs them into:

    assets/atlas.png    one packed sprite sheet (8 px field cells: the library's 16 px art, halved)
    assets/atlas.json   frame rects, animations, anchors, tile size

`assets/` is gitignored. Never commit it. Without it the app falls back to the vector map.

Usage:
    python3 tools/build-atlas.py                 # library at ../pixel-assets (relative to the repo)
    PIXEL_ROOT=/path/to/pixel-assets python3 tools/build-atlas.py

The library layout expected is the owner's indexed clone: `limezu/` (the unzipped packs), `custom/`
(pack "my", 16x16 folder) and `characters/` (built cast sheets at 32 px). Needs Pillow.
Output is deterministic: the same library gives byte-identical files.

The map is a zoomed-out field (small towns on a big plain), so every sprite is cut from the 16 px art and
halved with nearest-neighbour sampling (a whole-number factor: crisp, never blurred). Flags and emblems are
drawn in code by pixelmap.js, never cut from any flag image.
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
TILE = 8          # field cell in art px (the 16 px library art, halved)

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


def half(im):
    """Whole-number 2x downscale, nearest neighbour. Odd sizes are padded at the top / right first, so the
    bottom (the feet line) stays put."""
    w, h = im.width + (im.width & 1), im.height + (im.height & 1)
    if (w, h) != im.size:
        pad = Image.new('RGBA', (w, h))
        pad.alpha_composite(im, (0, h - im.height))
        im = pad
    return im.resize((w // 2, h // 2), Image.NEAREST)


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


def single(name, rel, anchor='bottom', meta=None, src=None, do_trim=True, halve=True):
    im = img(rel)
    if do_trim:
        im, _ = trim(im)
    if halve:
        im = half(im)
    a = [im.width // 2, im.height] if anchor == 'bottom' else anchor
    add(name, im, a, meta, src or rel)


# Nation colours follow the system (engine SYSTEM_IDENTITY colorKey): blue free market, yellow safety net,
# amber-orange public-owned firms, red state-run, emerald co-op. Each has three shades for nations that share
# a system: '' (base), '1' (lighter), '2' (darker). Roofs are recoloured to these at build time; pixelmap.js
# reads the same values from atlas.json (nationHsv). The old index keys stay as fallbacks for the UI.
BASE_HSV = {
    'blue': (213, 0.70, 0.92), 'yellow': (52, 0.74, 1.00), 'orange': (31, 0.94, 0.96),
    'red': (356, 0.84, 0.80), 'green': (150, 0.70, 0.76),
}


def shade_hsv(hsv, k):
    h, sat, v = hsv
    if k == 1:
        return (h, round(sat * 0.55, 3), round(min(1.0, v * 1.08 + 0.04), 3))
    if k == 2:
        return (h, round(min(1.0, sat * 1.04), 3), round(v * 0.62, 3))
    return hsv


NATION_HSV = {}
for _k, _v in BASE_HSV.items():
    for _s in (0, 1, 2):
        NATION_HSV[_k + ('' if _s == 0 else str(_s))] = shade_hsv(_v, _s)
NATION_HSV['grey'] = (215, 0.08, 0.62)
ROOF_KEYS = sorted(NATION_HSV)
# legacy keys: colours only (no sprites); pixelmap maps them onto the nearest new key
LEGACY_HSV = {'gold': (40, 0.70, 0.90), 'teal': (174, 0.70, 0.68), 'rose': (345, 0.55, 0.86),
              'violet': (256, 0.46, 0.82), 'moss': (90, 0.60, 0.70)}


def recolour(im, key, test, flat=False):
    """Map the pixels that pass `test` (a red roof ramp) onto a nation colour, keeping their shading.
    flat=True is for pale, low-saturation roofs: they take the full nation saturation."""
    import colorsys
    th, ts, tv = NATION_HSV[key]
    out = im.copy()
    px = out.load()
    for y in range(out.height):
        for x in range(out.width):
            r, g, b, a = px[x, y]
            if not a:
                continue
            h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if not test(h * 360, s, v):
                continue
            ns = min(1, ts * (0.85 if flat else s / 0.78))
            nv = min(1, tv * (v / 0.80 if flat else v / 0.82))
            rr, gg, bb = colorsys.hsv_to_rgb(th / 360, ns, nv)
            px[x, y] = (round(rr * 255), round(gg * 255), round(bb * 255), a)
    return out


def is_red(h, s, v):
    return (h < 16 or h > 340) and s > 0.42 and v > 0.45


def is_brick(h, s, v):
    return (h < 30 or h > 340) and s > 0.25


def terrain():
    tf = SORT + '1_Terrains_and_Fences_16x16.png'
    # Autotile blocks (halved to 8 px cells): a 3x3 rounded rect (outer corners + edges + fill) and a 2x2
    # inner-corner block.
    add('ter.dirt', half(crop(tf, 0, 480, 80, 48)), src='ext/terrains-and-fences dirt path on grass (autotile, halved)')
    add('ter.pond', half(crop(tf, 0, 560, 80, 48)), src='ext/terrains-and-fences pond in grass (autotile, halved)')
    # Plateau: grass with a dirt cliff skirt (9-slice: 3 columns, rows top/mid/bottom-3).
    add('ter.island', half(crop(tf, 128, 672, 48, 80)), src='ext/terrains-and-fences grass cliff plateau (halved)')
    add('ter.herring', half(crop(tf, 432, 144, 32, 32)), src='ext/terrains-and-fences herringbone paving (halved)')


def gov_hall():
    """Compact civic hall (80 x 96) and a grey state block, composed from LimeZu's modular Generic Building
    pieces: an arched door or a window bay between two pillars, under a strip of flat roof."""
    gb = SORT + '4_Generic_Buildings_16x16.png'
    pil = crop(gb, 352, 880, 16, 32), crop(gb, 352, 1184, 16, 64)

    def compose(mid_x, mid_w):
        W = 16 + mid_w + 16
        out = Image.new('RGBA', (W, 96))
        for (sy, sh), pc in zip(((880, 32), (1184, 64)), pil):
            y = 0 if sy == 880 else 32
            out.alpha_composite(pc.transpose(Image.FLIP_LEFT_RIGHT), (0, y))
            out.alpha_composite(crop(gb, mid_x, sy, mid_w, sh), (16, y))
            out.alpha_composite(pc, (16 + mid_w, y))
        return out
    hall = compose(288, 48)
    block = recolour(compose(208, 48), 'grey', is_brick)
    # the flat roof (top rows) takes the nation colour, so every town reads by colour from above
    def roof(im, key):
        top = im.crop((0, 0, im.width, 30))
        top = recolour(top, key, lambda h, s, v: 20 <= h <= 55 and 0.12 <= s <= 0.5 and v > 0.55, flat=True)
        out = im.copy()
        out.paste(top, (0, 0))
        return out
    for key in ROOF_KEYS:
        add('bld.hall.' + key, half(roof(hall, key)), [20, 48], {'door': [20, 47]})
        add('bld.block.' + key, half(roof(block, key)), [20, 48], {'door': [20, 47]})
    SOURCES.append('bld.hall.* <- ext/generic-building modular pieces (composed civic hall, roof recoloured per nation)')
    SOURCES.append('bld.block.* <- ext/generic-building modular pieces (composed, greyed state block, roof recoloured per nation)')


def buildings():
    S = SORT
    villa = S + '7_Villas_Singles_16x16/ME_Singles_Villas_16x16_Toy_House_%d.png'
    # Two neutral-walled cottages, roofs recoloured per nation (and grey for fallen towns)
    for var, num in (('a', 5), ('b', 7)):
        base, _ = trim(img(villa % num))
        for key in ROOF_KEYS:
            im = half(recolour(base, key, is_red))
            add('bld.house.%s.%s' % (key, var), im, [im.width // 2, im.height], {'door': [21, 37]})
        SOURCES.append('bld.house.*.%s <- ext/villas/%d (Toy_House_%d, roof recoloured per nation, halved)' % (var, num, num))
    # the co-op's shared barn: a garden storage shed, roof in the nation colour
    barn, _ = trim(img(S + '17_Garden_Singles_16x16/ME_Singles_Garden_16x16_Red_Brown_Wood_Storage.png'))
    for key in ROOF_KEYS:
        im = half(recolour(barn, key, is_red))
        add('bld.barn.' + key, im, [im.width // 2, im.height])
    SOURCES.append('bld.barn.* <- ext/garden Red_Brown_Wood_Storage (roof recoloured per nation, halved)')
    single('prop.bed', S + '17_Garden_Singles_16x16/ME_Singles_Garden_16x16_Sprout_Square_Bench.png', src='ext/garden sprout square bench (halved)')
    single('prop.lemon', S + '7_Villas_Singles_16x16/ME_Singles_Villas_16x16_Lemonade_Stand_2.png', src='ext/villas lemonade stand 2 (halved)')
    single('bld.depot', S + '6_Garage_Sales_Singles_16x16/ME_Singles_Garage_Sales_16x16_Building_2_Door_1.png', src='ext/garage-sales/1-7')
    single('bld.stall1', CUSTOM + 'kopitiam/hawker-stall-noodle.png', src='my/kopitiam/hawker-stall-noodle (custom pack)')
    single('bld.stall2', CUSTOM + 'kopitiam/hawker-stall-drinks.png', src='my/kopitiam/hawker-stall-drinks (custom pack)')
    single('bld.stall3', CUSTOM + 'kopitiam/hawker-stall-wok.png', src='my/kopitiam/hawker-stall-wok (custom pack)')
    single('bld.cart', S + '10_Vehicles_Singles_16x16/ME_Singles_Vehicles_16x16_Fruit_Flowers_Cart_2.png', src='ext/vehicles/2-22')
    single('bld.hut', CUSTOM + 'border/checkpoint-hut.png', src='my/border/checkpoint-hut (custom pack)')


def props():
    cat = json.load(open(ROOT / 'index/catalog.json'))
    byid = {e['id']: e for e in cat}

    def lib(name, cid, **kw):
        e = byid.get(cid)
        if not e or not e.get('f16'):
            sys.exit('build-atlas: library id %s has no 16 px file' % cid)
        single(name, 'limezu/' + e['f16'] if not e['f16'].startswith('../') else e['f16'][3:], src=cid, **kw)

    # trees for the shared forest and the open field; dead trees and stumps for a stripped forest
    lib('prop.tree1', 'ext/camping/1-51')
    lib('prop.tree2', 'ext/camping/2-49')
    lib('prop.tree3', 'ext/camping/9-6')
    lib('prop.treeS', 'ext/camping/170')
    lib('prop.treeR', 'ext/camping/145')
    lib('prop.pine', 'ext/camping/182')
    lib('prop.fruit', 'ext/camping/254')
    lib('prop.dead', 'ext/camping/1-52')
    lib('prop.stump', 'ext/camping/1-46')
    lib('prop.stumpS', 'ext/villas/3-14')
    lib('prop.shrub', 'ext/garden/20')
    lib('prop.fbush', 'ext/city-props/7-9')
    lib('prop.flowers1', 'ext/city-props/1-25')
    lib('prop.flowers2', 'ext/city-props/3-18')
    lib('prop.litter', 'ext/city-props/1-44')
    lib('prop.atm', 'ext/city-props/1')
    lib('prop.bench', 'ext/subway-and-train-station/1-63')
    lib('prop.stand', 'ext/villas/1-3')
    lib('prop.crate', 'ext/camping/1-35')
    lib('prop.crates', 'ext/villas/1-4')
    lib('prop.barrier', 'ext/city-props/1-16')
    lib('prop.railing', 'ext/beach/1-72')
    lib('prop.sandbag', 'ext/military-base/military-base-sandbag-horizontal')


def animated():
    for name, rel, fw, fh, n, fps, anc in (('fx.boom', ANIM + 'Landmine_Explosion_vfx_16x16.png', 48, 48, 11, 12, [12, 20]),
                                           ('fx.fire', ANIM + 'Campfire_16x16.png', 16, 32, 6, 10, [4, 15])):
        names = []
        for i in range(n):
            nm = '%s#%d' % (name, i)
            add(nm, half(crop(rel, i * fw, 0, fw, fh)), anc)
            names.append(nm)
        ANIMS[name] = {'frames': names, 'fps': fps}
        SOURCES.append('%s <- %s (halved)' % (name, rel))


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
    ('gai', ('cast', 'helperbot')), ('gper', ('cast', 'lay-daniel')), ('gyou', ('premade', 12)),
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
                    fr = half(sheet.crop((d * 96 + i * 16, y, d * 96 + i * 16 + 16, y + 32)))
                    nm = 'ch.%s.%s.%s#%d' % (key, anim, dname, i)
                    add(nm, fr, [4, 15])
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
        'nationHsv': dict(NATION_HSV, **LEGACY_HSV),
        'roofKeys': ROOF_KEYS,
        'scale': 0.5,
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
