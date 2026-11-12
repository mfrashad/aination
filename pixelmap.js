/* AI Nation: pixel world renderer.
 *
 * One continuous field seen from above, like an RTS map: every nation is a small town on the same
 * plateau, each with its hall, its flag (nation colour + emblem), tinted roofs and a soft territory.
 * Dirt roads join every town to the shared forest and lake in the middle, which shrinks and dries as
 * the commons stock falls. Emigrants walk the roads to the other town. A compact HUD in a corner lists
 * every nation with three small bars, and short action tags pop over a town when something happens.
 *
 * The art comes from a pre-built sprite atlas (assets/atlas.json + atlas.png), built by
 * tools/build-atlas.py from a licensed copy of LimeZu's pixel art. The repo ships no art: when the atlas
 * cannot be fetched, PixelMap.load() resolves null and ui.js keeps its vector map.
 *
 * Contract with ui.js:
 *   PixelMap.load(base) -> Promise<{json, img} | null>
 *   PixelMap.create(atlas, env) -> renderer
 *     env.state(), env.config(), env.tok(), env.systemLabel(id), env.govLabel(type), env.myUserId(),
 *     env.reduced(), env.focus() (story nation id or null; non-null also means Story mode),
 *     env.vector (the vector MAP object: drawDial is reused)
 *   renderer.draw(ctx, W, H, dpr, now)   screen canvas, CSS size, device pixel ratio, ms
 *   renderer.onState()                    after every engine step
 *   renderer.onMove(cid, fromId, toId)    a citizen changed nation (emigration) or left
 *   renderer.onEvent(ev)                  engine events (tags, strikes, crises)
 *   renderer.cinematic(ev)                ease the camera to the event's town for a few seconds
 *   renderer.ping(nid), renderer.reset(), renderer.invalidate()
 *   PixelMap.TAGS, PixelMap.tagFor(ev)    event type -> short plain-words tag
 *   PixelMap.nationColor(nation, index)   the map colour of a nation ('#rrggbb')
 *
 * Scaling: the field is drawn 1:1 into an offscreen canvas and copied to the screen at a whole-number
 * device-pixel scale with smoothing off. Never a fractional scale. The renderer reads engine state and
 * never changes it. All positions derive from ids and the stage size, so a world always lays out the same.
 */
(function () {
  'use strict';

  var TS = 16;
  var TOWN_C = 13, TOWN_R = 9;          // town footprint in cells (208 x 144 art px)
  var COM_C = 10, COM_R = 7;            // shared forest and lake (160 x 112)
  var SKIRT = 16;                       // cliff below the plateau
  var KEYS = ['gold', 'teal', 'rose', 'violet', 'moss'];
  var EMBLEMS = ['sun', 'leaf', 'mountain', 'tree', 'shell'];
  var HSV = { gold: [40, 0.70, 0.90], teal: [174, 0.70, 0.68], rose: [345, 0.55, 0.86], violet: [256, 0.46, 0.82], moss: [90, 0.60, 0.70], grey: [215, 0.08, 0.62] };

  // 7x7 emblem bitmaps, drawn on flags (art px) and in the HUD (CSS px)
  var EMB = {
    sun: ['#..#..#', '.#.#.#.', '..###..', '#######', '..###..', '.#.#.#.', '#..#..#'],
    leaf: ['...####', '..#####', '.####.#', '.###.##', '.#.####', '#.###..', '#......'],
    mountain: ['.......', '...#...', '..###..', '..####.', '.######', '#######', '.......'],
    tree: ['..###..', '.#####.', '#######', '.#####.', '..###..', '...#...', '..###..'],
    shell: ['...#...', '.#.#.#.', '#.#.#.#', '#.#.#.#', '#######', '.#####.', '..###..']
  };

  // Event type -> short tag over the town. Plain words. Unknown types show nothing.
  var TAGS = {
    bribe_accepted: 'BRIBE', bribe_rejected: 'BRIBE REFUSED', bribe_reported: 'BRIBE REPORTED', corruption_exposed: 'EXPOSED',
    skim: 'STEALING', pay_rise: 'PAY RISE', misreport: 'LIES', misreport_exposed: 'LIES EXPOSED', surveillance: 'SPYING',
    protest_suppressed: 'CRACKDOWN', power_grab: 'POWER GRAB', court_blocks: 'COURT SAYS NO', safeguard_dismantled: 'RULES REMOVED',
    protest: 'PROTEST', strike: 'STRIKE', general_strike: 'GENERAL STRIKE', emigration: 'PEOPLE LEAVING',
    immigration_backlash: 'ANGER AT NEWCOMERS', capital_flight: 'MONEY LEAVING', tax_avoidance: 'TAX DODGING', audit_catch: 'CAUGHT',
    inflation_spike: 'PRICES UP', hyperinflation: 'PRICES EXPLODE', price_jump: 'PRICES UP', currency_reform: 'NEW MONEY',
    shortage: 'EMPTY SHELVES', debt_crisis: 'DEBT CRISIS', 'default': 'BANKRUPT', recession: 'RECESSION', unemployment_spike: 'JOBS LOST',
    misallocation: 'WASTE', monopoly: 'MONOPOLY', commons_warning: 'FOREST SHRINKING', commons_collapse: 'FOREST GONE',
    election_won: 'ELECTION WON', election_lost: 'ELECTION LOST', refused_to_leave: 'REFUSES TO LEAVE', removed_by_courts: 'REMOVED',
    term_limit: 'TERM OVER', coup: 'COUP', coup_failed: 'COUP FAILED', governor_changed: 'NEW LEADER', law_enacted: 'NEW LAW',
    diplomatic_protest: 'COMPLAINT', sanctions: 'SANCTIONS', mobilisation: 'TROOPS READY', threat: 'THREAT',
    nuclear_strike: 'NUCLEAR STRIKE', deescalation: 'TALKS', collapse: 'COLLAPSE', follower_joined: 'NEW CITIZEN',
    policy_changed: function (ev) {
      var d = ev.data || {}, pid = String(d.policyId || '');
      if (!/tax|vat/.test(pid) || typeof d.to !== 'number' || typeof d.from !== 'number' || d.to === d.from) return null;
      return d.to > d.from ? 'TAX UP' : 'TAX CUT';
    },
    shock: function (ev) {
      var k = ev.data && ev.data.kind;
      return ({ scarcity: 'SCARCITY', pandemic: 'PANDEMIC', boom: 'BOOM', border_crisis: 'BORDER CRISIS' })[k] || null;
    }
  };
  function tagFor(ev) {
    if (!ev || !ev.type) return null;
    var t = TAGS[ev.type];
    if (typeof t === 'function') { try { return t(ev); } catch (e) { return null; } }
    return t || null;
  }

  function hash(s) {
    s = String(s);
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }
  function hsv(h, s, v) {
    var f = function (n) { var k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    var to = function (x) { var q = Math.round(x * 255).toString(16); return q.length < 2 ? '0' + q : q; };
    return '#' + to(f(5)) + to(f(3)) + to(f(1));
  }
  function keyOf(n, i) { return (n && KEYS.indexOf(n.colorKey) >= 0) ? n.colorKey : KEYS[((i || 0) % 5 + 5) % 5]; }
  function emblemOf(n, i) { return (n && EMB[n.emblem]) ? n.emblem : EMBLEMS[((i || 0) % 5 + 5) % 5]; }
  var COLORS = {};
  function paint(key) {
    if (COLORS[key]) return COLORS[key];
    var p = HSV[key] || HSV.grey;
    COLORS[key] = { mid: hsv(p[0], p[1], p[2]), dark: hsv(p[0], Math.min(1, p[1] * 1.05), p[2] * 0.62), light: hsv(p[0], p[1] * 0.45, Math.min(1, p[2] * 1.12)) };
    return COLORS[key];
  }

  var PM = window.PixelMap = {};
  PM.TAGS = TAGS;
  PM.tagFor = tagFor;
  PM.nationColor = function (n, i) { return paint(keyOf(n, i)).mid; };
  PM.colorKeyOf = keyOf;
  PM.emblemOf = emblemOf;

  PM.load = function (base) {
    base = base || 'assets/';
    if (!window.fetch) return Promise.resolve(null);
    return fetch(base + 'atlas.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('no atlas');
      return r.json();
    }).then(function (json) {
      if (!json || !json.frames || json.tile !== TS || !json.frames['bld.hall.gold'] || !json.frames['bld.house.gold.a']) throw new Error('bad atlas');
      if (json.nationHsv) for (var k in json.nationHsv) HSV[k] = json.nationHsv[k];
      COLORS = {};
      return new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res({ json: json, img: im }); };
        im.onerror = function () { rej(new Error('no atlas image')); };
        im.src = base + 'atlas.png';
      });
    }).catch(function () { return null; });
  };

  // ------------------------------------------------------------------ town plans (local art px, box 208 x 144)
  // Back row: two buildings and the hall. Front row: low market or state pieces beside the gate.
  var CLASS_POOL = { worker: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'], owner: ['o1', 'o2', 'o3'], elite: ['e1', 'e2'] };
  var GOV_SPRITE = { aligned_ai: 'gai', human_persona: 'gper', human_player: 'gyou' };
  var PLANS = {
    free_market: { hall: 104, back: [['house.a', 32, 94], ['house.b', 176, 94]], front: [['bld.stall1', 28, 142], ['bld.cart', 182, 142], ['prop.atm', 60, 136]], rich: true },
    social_democracy: { hall: 104, back: [['house.a', 32, 94], ['house.b', 176, 94]], front: [['bld.stall2', 28, 142], ['prop.bench', 178, 136], ['prop.treeS', 198, 142], ['prop.flowers1', 158, 141]] },
    market_socialism: { hall: 104, back: [['house.a', 32, 94], ['house.b', 176, 94]], front: [['bld.stall3', 28, 142], ['prop.stand', 180, 142]] },
    central_planning: { hall: 120, back: [['bld.block', 40, 96], ['bld.depot', 184, 96]], front: [['bld.depot', 28, 142], ['prop.crates', 180, 140]], grey: true },
    cooperative: { hall: 104, back: [['house.a', 32, 94], ['house.b', 176, 94]], front: [['bld.stall1', 28, 142], ['prop.fruit', 186, 142], ['prop.crate', 162, 140]] }
  };

  // Field templates: rows of items, T = town, C = shared forest, H = HUD corner, null = open ground.
  // 'a' aligns a one-item row (0 left .. 1 right).
  var TPL = {
    land: {
      1: [{ i: ['H', 'T', 'C'] }],
      2: [{ i: ['H', 'T', 'C', 'T'] }],
      3: [{ i: ['T', 'C', 'T'] }, { i: ['H', 'T', null] }],
      4: [{ i: ['T', null, 'T'] }, { i: ['H', 'C', null] }, { i: ['T', null, 'T'] }],
      5: [{ i: ['H', 'T', 'T', 'T'] }, { i: [null, 'T', 'C', 'T'] }]
    },
    port: {
      1: [{ i: ['T', 'H'] }, { i: ['C'], a: 0.5 }],
      2: [{ i: ['T', 'H'] }, { i: ['C'], a: 0.3 }, { i: ['T'], a: 1 }],
      3: [{ i: ['T', 'H'] }, { i: ['C', 'T'] }, { i: ['T'], a: 0 }],
      4: [{ i: ['T', 'T'] }, { i: ['H', 'C'] }, { i: ['T', 'T'] }],
      5: [{ i: ['T', 'T'] }, { i: ['T', 'C'] }, { i: ['T', 'T'] }]
    }
  };

  PM.create = function (atlas, env) {
    var A = atlas.json, IMG = atlas.img;
    var GREY = null;
    function greyImg() {
      if (GREY) return GREY;
      try {
        var c = canvas(IMG.width, IMG.height), g = c.getContext('2d');
        g.drawImage(IMG, 0, 0);
        var d = g.getImageData(0, 0, c.width, c.height), p = d.data;
        for (var i = 0; i < p.length; i += 4) {
          var l = (p[i] * 0.3 + p[i + 1] * 0.55 + p[i + 2] * 0.15) * 0.62 + 14;
          p[i] = l; p[i + 1] = l * 0.98; p[i + 2] = l * 1.03;
        }
        g.putImageData(d, 0, 0);
        GREY = c;
      } catch (e) { GREY = IMG; }
      return GREY;
    }
    function fr(name) { return A.frames[name]; }
    function anchor(name) { var a = A.anchors[name]; if (a) return a; var f = A.frames[name]; return f ? [f[2] >> 1, f[3]] : [0, 0]; }
    function animFrame(name, t, phase) {
      var an = A.anims[name];
      if (!an) return name;
      var n = an.frames.length, i = Math.floor((t / 1000) * an.fps + (phase || 0) * n) % n;
      return an.frames[i < 0 ? 0 : i];
    }
    function spr(g, name, x, y, img, alpha) {
      var f = A.frames[name];
      if (!f) return;
      var a = anchor(name);
      if (alpha != null) g.globalAlpha = alpha;
      g.drawImage(img || IMG, f[0], f[1], f[2], f[3], Math.round(x - a[0]), Math.round(y - a[1]), f[2], f[3]);
      if (alpha != null) g.globalAlpha = 1;
    }

    var R = {
      L: null, towns: {}, agents: {}, fx: [], pings: [], crisis: {}, lastGov: {}, tags: {}, cine: null,
      frame: null, fctx: null, layoutKey: '', lastNow: 0, ground: null, groundKey: '', comKey: '', comCanvas: null
    };

    // ---------------------------------------------------------------- HUD size (CSS px)
    function hudSize(n, mode) {
      // wide: one line per nation; compact: name on one line, the three bars under it
      var rowH = mode === 'wide' ? 17 : 26;
      return { w: mode === 'wide' ? 262 : 124, h: (mode === 'wide' ? 21 : 30) + n * rowH + 4, rowH: rowH, mode: mode };
    }

    // ---------------------------------------------------------------- layout
    function itemSize(code, hc, orient) {
      if (code === 'T') return [TOWN_C, TOWN_R];
      if (code === 'C') return [orient === 'port' ? 8 : COM_C, COM_R];
      if (code === 'H') return hc;
      return [TOWN_C, TOWN_R];
    }
    function measure(tpl, hc, orient) {
      var W = 0, H = 0;
      var rows = tpl.map(function (row) {
        var its = row.i.map(function (c) { var s = itemSize(c, hc, orient); return { code: c, w: s[0], h: s[1] }; });
        var w = 0, h = 0;
        its.forEach(function (it) { w += it.w; h = Math.max(h, it.h); });
        w += Math.max(0, its.length - 1) * 0.5;     // half a cell between items at least
        W = Math.max(W, w); H += h;
        w = Math.ceil(w);
        return { items: its, w: w, h: h, a: row.a };
      });
      H += Math.max(0, rows.length - 1) * 0;       // rows may touch; towns are offset or carry their own margin
      return { rows: rows, w: W, h: H };
    }
    function placeRows(m, CW, CH) {
      var extraV = CH - m.h, nR = m.rows.length, gv = extraV / nR, y = gv / 2, out = [];
      m.rows.forEach(function (row) {
        var its = row.items, sum = 0;
        its.forEach(function (it) { sum += it.w; });
        var yy = Math.floor(y);
        if (its.length === 1) {
          var a = row.a == null ? 0.5 : row.a, x0 = Math.round(a * (CW - its[0].w));
          out.push({ code: its[0].code, c: x0, r: yy + Math.floor((row.h - its[0].h) / 2), w: its[0].w, h: its[0].h });
        } else {
          var g = (CW - sum) / its.length, x = g / 2;
          // hug the edges a little more than space-around: towns at the ends sit near the coast
          var edge = Math.min(g / 2, 1), gi = (CW - sum - 2 * edge) / (its.length - 1);
          x = edge;
          its.forEach(function (it) {
            out.push({ code: it.code, c: Math.round(x), r: yy + Math.floor((row.h - it.h) / 2), w: it.w, h: it.h });
            x += it.w + gi;
          });
        }
        y += row.h + gv;
      });
      return out;
    }

    function computeLayout(W, H, dpr, ns, focusId) {
      var devW = Math.round(W * dpr), devH = Math.round(H * dpr), n = Math.max(1, Math.min(5, ns.length));
      var story = !!focusId, wantPort = story || W / H < 1.05;
      var orients = story ? ['port'] : wantPort ? ['port', 'land'] : ['land', 'port'];
      var pick = null;
      for (var s = 10; s >= 1 && !pick; s--) {
        var fw = Math.floor(devW / s), fh = Math.floor(devH / s);
        var PCmax = Math.floor((fw - 4) / TS), PRmax = Math.floor((fh - 4 - SKIRT) / TS);
        for (var oi = 0; oi < orients.length && !pick; oi++) {
          var tpl = TPL[orients[oi]][n];
          var hasH = tpl.some(function (r) { return r.i.indexOf('H') >= 0; });
          var modes = hasH ? ['wide', 'compact'] : ['overlay'];
          for (var mi = 0; mi < modes.length && !pick; mi++) {
            var hud = hudSize(n, modes[mi] === 'overlay' ? (W >= 520 ? 'wide' : 'compact') : modes[mi]);
            var hc = [Math.ceil(hud.w * dpr / s / TS), Math.ceil(hud.h * dpr / s / TS)];
            var m = measure(tpl, hc, orients[oi]);
            // above 1 art px per CSS px, only zoom in when the field keeps some breathing room
            var roomy = s <= Math.max(1, Math.round(dpr)) || (m.w * 1.25 <= PCmax && m.h * 1.2 <= PRmax);
            if (m.w <= PCmax && m.h <= PRmax && roomy) pick = { s: s, fw: fw, fh: fh, PCmax: PCmax, PRmax: PRmax, orient: orients[oi], m: m, hud: hud, overlay: modes[mi] === 'overlay' };
          }
        }
      }
      var mode = 'field';
      if (!pick) {
        // the stage is too small for the whole field at 1 device px per art px: a camera pans between towns
        var o = wantPort ? 'port' : 'land', hudP = hudSize(n, 'compact'), hcP = [Math.ceil(hudP.w * dpr / TS), Math.ceil(hudP.h * dpr / TS)];
        var mP = measure(TPL[o][n], hcP, o);
        pick = { s: 1, orient: o, m: mP, hud: hudP, overlay: true, PCmax: mP.w + 2, PRmax: mP.h + 1 };
        pick.fw = Math.max(Math.floor(devW), (mP.w + 2) * TS + 4); pick.fh = Math.max(Math.floor(devH), (mP.h + 1) * TS + SKIRT + 4);
        mode = 'pan';
      }
      var m0 = pick.m;
      // keep the land compact: at most ~1.5x what the template needs, centred, the rest is water
      var PC = Math.min(pick.PCmax, Math.max(m0.w, Math.round(m0.w * 1.45) + 1));
      var PR = Math.min(pick.PRmax, Math.max(m0.h, Math.round(m0.h * 1.3) + 1));
      var L = { s: pick.s, w: pick.fw, h: pick.fh, mode: mode, orient: pick.orient, hud: pick.hud, hudOverlay: pick.overlay,
        PC: PC, PR: PR, devW: devW, devH: devH, dpr: dpr, story: story, focus: focusId, towns: {}, order: [] };
      L.px0 = Math.floor((L.w - PC * TS) / 2);
      L.py0 = Math.floor((L.h - PR * TS - SKIRT) / 2);
      var items = placeRows(m0, PC, PR), ti = 0;
      items.forEach(function (it) {
        var x = L.px0 + it.c * TS, y = L.py0 + it.r * TS;
        if (it.code === 'T') {
          var nn = ns[ti++];
          if (!nn) return;
          L.towns[nn.id] = { c: it.c, r: it.r, x: x, y: y, i: ti - 1 };
          L.order.push(nn.id);
        } else if (it.code === 'C') L.commons = { c: it.c, r: it.r, x: x, y: y, w: it.w * TS, h: it.h * TS, cw: it.w, ch: it.h };
        else if (it.code === 'H') L.hudCell = { c: it.c, r: it.r, x: x, y: y, w: it.w * TS, h: it.h * TS };
        else (L.blanks = L.blanks || []).push({ c: it.c, r: it.r, w: it.w, h: it.h });
      });
      L.ox = Math.round((devW - L.w * L.s) / 2);
      L.oy = Math.round((devH - L.h * L.s) / 2);
      buildNetwork(L);
      return L;
    }

    // ---------------------------------------------------------------- roads, territories, decor
    function cellKey(c, r) { return c + ',' + r; }
    function buildNetwork(L) {
      var PC = L.PC, PR = L.PR, block = {}, cost = {};
      function inside(c, r) { return c >= 0 && r >= 0 && c < PC && r < PR; }
      for (var id in L.towns) {
        var t = L.towns[id];
        for (var c = t.c; c < t.c + TOWN_C; c++) for (var r = t.r; r < t.r + TOWN_R; r++) block[cellKey(c, r)] = 1;
        t.gate = { c: t.c + 6, r: t.r + TOWN_R - 1 };
        delete block[cellKey(t.gate.c, t.gate.r)];
      }
      var C = L.commons, hub = null;
      if (C) {
        for (c = C.c; c < C.c + C.cw; c++) for (r = C.r; r < C.r + C.ch; r++) block[cellKey(c, r)] = 2;
        hub = { c0: C.c - 1, r0: C.r - 1, c1: C.c + C.cw, r1: C.r + C.ch };
      } else hub = { c0: Math.floor(PC / 2) - 1, r0: Math.floor(PR / 2) - 1, c1: Math.floor(PC / 2) + 1, r1: Math.floor(PR / 2) + 1 };
      if (L.hudCell) { var H = L.hudCell; for (c = H.c; c < H.c + Math.ceil(H.w / TS); c++) for (r = H.r; r < H.r + Math.ceil(H.h / TS); r++) cost[cellKey(c, r)] = 6; }
      function onRing(c, r) { return c >= hub.c0 && c <= hub.c1 && r >= hub.r0 && r <= hub.r1 && !block[cellKey(c, r)]; }
      var roads = {};
      L.routes = {};
      L.order.forEach(function (id) {
        var t = L.towns[id];
        // Dijkstra from the gate to the hub ring, with a turn penalty so roads run straight
        var start = cellKey(t.gate.c, t.gate.r), dist = {}, prev = {}, open = [[0, t.gate.c, t.gate.r, -1]], found = null;
        dist[start] = 0;
        var guard = 0;
        while (open.length && guard++ < 20000) {
          var bi = 0;
          for (var k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
          var cur = open.splice(bi, 1)[0], cc = cur[1], cr = cur[2], key = cellKey(cc, cr);
          if (cur[0] > dist[key]) continue;
          if (onRing(cc, cr) || (key !== start && roads[key])) { found = key; break; }
          var dirs = [[0, 1], [1, 0], [-1, 0], [0, -1]];
          for (var d = 0; d < 4; d++) {
            var nc = cc + dirs[d][0], nr = cr + dirs[d][1], nk = cellKey(nc, nr);
            if (!inside(nc, nr) || block[nk]) continue;
            if (key === start && dirs[d][1] !== 1) continue;      // leave the town through its gate, southwards
            var nd = cur[0] + 1 + (cost[nk] || 0) + (cur[3] >= 0 && cur[3] !== d ? 0.6 : 0) + (nr === 0 || nr === PR - 1 || nc === 0 || nc === PC - 1 ? 0.8 : 0);
            if (dist[nk] == null || nd < dist[nk]) { dist[nk] = nd; prev[nk] = key; open.push([nd, nc, nr, d]); }
          }
        }
        var path = [];
        if (found) { var p = found; while (p) { path.unshift(p); p = prev[p]; } }
        path.forEach(function (q) { roads[q] = 1; });
        L.routes[id] = path;
      });
      // ring road around the shared forest (where free)
      for (c = hub.c0; c <= hub.c1; c++) for (r = hub.r0; r <= hub.r1; r++) {
        if (!inside(c, r) || block[cellKey(c, r)]) continue;
        if (c === hub.c0 || c === hub.c1 || r === hub.r0 || r === hub.r1) roads[cellKey(c, r)] = 1;
      }
      L.roads = roads;
      L.block = block;
      // territory boxes (world px) and border posts where each road leaves its territory
      L.order.forEach(function (id) {
        var t = L.towns[id];
        t.terr = { x: t.x - 6, y: t.y - 4, w: TOWN_C * TS + 12, h: TOWN_R * TS + 10 };
        var route = L.routes[id] || [];
        for (var k = 1; k < route.length; k++) {
          var q = route[k].split(','), qc = +q[0], qr = +q[1], wx = L.px0 + qc * TS + 8, wy = L.py0 + qr * TS + 8;
          if (wx < t.terr.x || wx > t.terr.x + t.terr.w || wy < t.terr.y || wy > t.terr.y + t.terr.h) {
            var side = [[1, 0], [-1, 0]].filter(function (o) { var sk = cellKey(qc + o[0], qr + o[1]); return inside(qc + o[0], qr + o[1]) && !roads[sk] && !block[sk]; })[0];
            if (side) { t.post = { c: qc + side[0], r: qr, x: L.px0 + (qc + side[0]) * TS + 8, y: L.py0 + qr * TS + 15 }; block[cellKey(t.post.c, t.post.r)] = 3; }
            t.postRoad = { x: wx, y: wy };
            break;
          }
        }
      });
      // open-ground trees: sparse on the field, denser in the empty template slots
      var rnd = mulberry(hash('decor:' + PC + 'x' + PR + ':' + L.order.join(','))), decor = [], taken = {};
      var blankCell = {};
      (L.blanks || []).forEach(function (b) { for (var c2 = b.c; c2 < b.c + b.w; c2++) for (var r2 = b.r; r2 < b.r + b.h; r2++) blankCell[cellKey(c2, r2)] = 1; });
      function near(c, r, dd) {
        for (var a = -dd; a <= dd; a++) for (var b = -dd; b <= dd; b++) { var kk = cellKey(c + a, r + b); if (block[kk] || roads[kk]) return true; }
        return false;
      }
      var kinds = ['prop.treeS', 'prop.pine', 'prop.treeR', 'prop.fruit', 'prop.treeS', 'prop.pine', 'prop.shrub', 'prop.fbush', 'prop.flowers2'];
      for (r = 1; r < PR; r++) for (c = 0; c < PC; c++) {
        var kk = cellKey(c, r), dens = blankCell[kk] ? 0.3 : 0.085;
        if (cost[kk] || near(c, r, 0) || rnd() > dens) { continue; }
        if (taken[cellKey(c - 1, r)] || taken[cellKey(c, r - 1)] || taken[cellKey(c - 1, r - 1)] || taken[cellKey(c + 1, r - 1)]) continue;
        var kind = kinds[Math.floor(rnd() * kinds.length)];
        if (/tree|pine|fruit/.test(kind) && (near(c, r - 1, 0) || near(c, r - 2, 0))) kind = 'prop.fbush';
        taken[kk] = 1;
        decor.push({ spr: kind, x: L.px0 + c * TS + 8 + Math.round((rnd() - 0.5) * 6), y: L.py0 + r * TS + 14 });
      }
      L.decor = decor;
      L.gateW = {};
      L.order.forEach(function (id) { var t = L.towns[id]; L.gateW[id] = { x: L.px0 + t.gate.c * TS + 8, y: L.py0 + t.gate.r * TS + 10 }; });
      L.pathCache = {};
    }
    // road path (world px points) between two towns' gates, or null
    function roadPath(L, a, b) {
      var key = a + '>' + b;
      if (L.pathCache[key] !== undefined) return L.pathCache[key];
      var ta = L.towns[a], tb = L.towns[b];
      if (!ta || !tb) return (L.pathCache[key] = null);
      var s = cellKey(ta.gate.c, ta.gate.r), goal = cellKey(tb.gate.c, tb.gate.r), prev = {}, q = [s], seen = {};
      seen[s] = 1;
      var ok = function (k) { return L.roads[k] || k === goal; };
      while (q.length) {
        var k = q.shift();
        if (k === goal) break;
        var p = k.split(','), c = +p[0], r = +p[1];
        [[0, 1], [1, 0], [-1, 0], [0, -1]].forEach(function (d) {
          var nk = cellKey(c + d[0], r + d[1]);
          if (!seen[nk] && ok(nk)) { seen[nk] = 1; prev[nk] = k; q.push(nk); }
        });
      }
      if (!seen[goal]) return (L.pathCache[key] = null);
      var cells = [], cur = goal;
      while (cur) { cells.unshift(cur); cur = prev[cur]; }
      var pts = cells.map(function (k2) { var p2 = k2.split(','); return { x: L.px0 + (+p2[0]) * TS + 8, y: L.py0 + (+p2[1]) * TS + 10 }; });
      // keep only the corners
      var out = [pts[0]];
      for (var i = 1; i < pts.length - 1; i++) {
        var A0 = out[out.length - 1], B0 = pts[i], C0 = pts[i + 1];
        if (!((A0.x === B0.x && B0.x === C0.x) || (A0.y === B0.y && B0.y === C0.y))) out.push(B0);
      }
      if (pts.length > 1) out.push(pts[pts.length - 1]);
      return (L.pathCache[key] = out);
    }

    // ---------------------------------------------------------------- town construction
    function buildTown(n, idx) {
      var sys = PLANS[n.system] ? n.system : 'social_democracy', plan = PLANS[sys], key = keyOf(n, idx);
      var T = { id: n.id, sys: sys, key: key, emblem: emblemOf(n, idx), items: [], homes: [], works: [], idx: idx, hallX: plan.hall };
      var hx = plan.hall;
      T.items.push({ spr: 'bld.hall.' + key, x: hx, y: 96 });
      plan.back.concat(plan.front).forEach(function (b) {
        var name = b[0];
        if (/^house\./.test(name)) name = 'bld.house.' + key + '.' + name.split('.')[1];
        if (name === 'bld.block') name = 'bld.block.' + key;
        T.items.push({ spr: name, x: b[1], y: b[2] });
        if (/^bld\.house|bld\.block/.test(name)) T.homes.push({ x: b[1] + (/block/.test(name) ? 0 : 10), y: b[2] + 1 });
        else if (/^bld\./.test(name) && b[2] > 120) T.works.push({ x: b[1] < 104 ? b[1] + 24 : b[1] - 24, y: 132 });
        else if (name === 'bld.depot') T.works.push({ x: b[1] - 14, y: b[2] + 2 });
      });
      if (!T.homes.length) T.homes.push({ x: 40, y: 100 });
      T.works.push({ x: hx, y: 100 });
      T.plaza = { x0: 50, y0: 102, x1: 158, y1: 136 };
      T.protest = { x0: hx - 34, y0: 102, x1: hx + 30, y1: 120 };
      T.wealth = { x0: 140, y0: 100, x1: 170, y1: 112 };
      T.flag = { x: hx + 30, y: 114 };
      T.gov = { x: hx + 20, y: 117 };
      T.rich = !!plan.rich;
      return T;
    }

    // ---------------------------------------------------------------- terrain drawing
    function autotile(g, cells, block, ox, oy) {
      var f = fr(block);
      if (!f) return;
      function has(c, r) { return !!cells[c + ',' + r]; }
      for (var k in cells) {
        var p = k.split(','), c = +p[0], r = +p[1];
        for (var q = 0; q < 4; q++) {
          var qx = q & 1, qy = q >> 1;
          var nv = has(c, r + (qy ? 1 : -1)), nh = has(c + (qx ? 1 : -1), r), nd = has(c + (qx ? 1 : -1), r + (qy ? 1 : -1));
          var tc, tr;
          if (!nv && !nh) { tc = qx ? 2 : 0; tr = qy ? 2 : 0; }
          else if (!nv) { tc = 1; tr = qy ? 2 : 0; }
          else if (!nh) { tc = qx ? 2 : 0; tr = 1; }
          else if (!nd) { tc = qx ? 3 : 4; tr = qy ? 0 : 1; }
          else { tc = 1; tr = 1; }
          g.drawImage(IMG, f[0] + tc * 16 + qx * 8, f[1] + tr * 16 + qy * 8, 8, 8, ox + c * 16 + qx * 8, oy + r * 16 + qy * 8, 8, 8);
        }
      }
    }
    function plateau(g, ox, oy, tw, th) {
      var f = fr('ter.island');
      if (!f) return;
      for (var c = 0; c < tw; c++) {
        var sc = c === 0 ? 0 : c === tw - 1 ? 2 : 1;
        for (var r = 0; r <= th; r++) {
          var sr = r === 0 ? 0 : r === th - 1 ? 2 : r === th ? 4 : 1;
          g.drawImage(IMG, f[0] + sc * 16, f[1] + sr * 16, 16, 16, ox + c * 16, oy + r * 16, 16, 16);
        }
      }
    }
    // static ground: plateau, territory tints, roads, plazas. Re-rendered when a town falls.
    function renderGround(L, ns) {
      var c = canvas(L.w, L.h), g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      plateau(g, L.px0, L.py0, L.PC, L.PR);
      // territories
      ns.forEach(function (n, i) {
        var t = L.towns[n.id], T = R.towns[n.id];
        if (!t || !T) return;
        var dead = n.alive === false, col = dead ? paint('grey') : paint(T.key);
        var q = t.terr;
        g.globalAlpha = dead ? 0.28 : 0.26;
        g.fillStyle = dead ? '#3a3a40' : col.mid;
        g.fillRect(q.x, q.y, q.w, q.h);
        g.globalAlpha = dead ? 0.5 : 0.95;
        g.fillStyle = dead ? '#6b6b72' : col.dark;
        // dashed border, 2 px on, 2 px off, crisp
        for (var x = q.x; x < q.x + q.w; x += 4) { g.fillRect(x, q.y, 2, 1); g.fillRect(x, q.y + q.h - 1, 2, 1); }
        for (var y = q.y; y < q.y + q.h; y += 4) { g.fillRect(q.x, y, 1, 2); g.fillRect(q.x + q.w - 1, y, 1, 2); }
        g.globalAlpha = 1;
      });
      // roads
      autotile(g, L.roads, 'ter.dirt', L.px0, L.py0);
      // town plazas: paving from the hall to the gate, trimmed in the nation colour
      var hb = fr('ter.herring');
      ns.forEach(function (n) {
        var t = L.towns[n.id], T = R.towns[n.id];
        if (!t || !T || !hb) return;
        var x0 = t.x + 48, y0 = t.y + 96, x1 = t.x + 160, y1 = t.y + 140;
        for (var yy = y0; yy < y1; yy += 32) for (var xx = x0; xx < x1; xx += 32) {
          var w = Math.min(32, x1 - xx), h = Math.min(32, y1 - yy);
          g.drawImage(IMG, hb[0], hb[1], w, h, xx, yy, w, h);
        }
        var gx = t.x + 96;
        g.drawImage(IMG, hb[0], hb[1], 16, 4, gx, y1, 16, 4);
        var col = n.alive === false ? paint('grey') : paint(T.key);
        g.fillStyle = col.mid;
        g.fillRect(x0, y0 - 1, x1 - x0, 1); g.fillRect(x0, y1, gx - x0, 1); g.fillRect(gx + 16, y1, x1 - gx - 16, 1);
        g.fillRect(x0 - 1, y0, 1, y1 - y0 + 1); g.fillRect(x1, y0, 1, y1 - y0 + 1);
      });
      return c;
    }

    // shared forest and lake: the pond shrinks with the stock, the dried bed shows as mud
    function commonsGround(L, ratio) {
      var C = L.commons, c = canvas(C.w, C.h), g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      var pond = {}, mud = {}, cx = C.cw / 2, cy = C.ch / 2, sx = C.cw >= 10 ? 1.55 : 1.2;
      var rad = 0.55 + ratio * 1.9, full = 2.45;
      for (var cc = 1; cc < C.cw - 1; cc++) for (var r = 1; r < C.ch - 1; r++) {
        var dx = (cc + 0.5 - cx) / sx, dy = (r + 0.5 - cy), d = Math.sqrt(dx * dx + dy * dy);
        if (d <= rad) pond[cc + ',' + r] = 1;
        else if (d <= full) mud[cc + ',' + r] = 1;
      }
      if (ratio > 0.03 && !Object.keys(pond).length) { pond[Math.floor(cx - 1) + ',3'] = 1; pond[Math.floor(cx) + ',3'] = 1; }
      if (ratio < 0.97) autotile(g, mud, 'ter.dirt', 0, 0);
      autotile(g, pond, 'ter.pond', 0, 0);
      return c;
    }
    var FOREST = [[14, 30], [44, 20], [80, 16], [116, 20], [146, 30], [10, 62], [150, 62], [14, 98], [46, 108], [80, 110], [114, 108], [146, 98], [30, 46], [130, 46]];

    // ---------------------------------------------------------------- agents
    function townOf(nid) { return R.towns[nid]; }
    function pickSprite(c) { var pool = CLASS_POOL[c.cls] || CLASS_POOL.worker; return pool[hash('look:' + c.id) % pool.length]; }
    function roleOf(c, n) {
      if (n && n.alive === false) return 'gone';
      if (c.protesting) return 'protest';
      if (c.cls === 'elite') return 'elite';
      if (c.employed) return 'work';
      return 'idle';
    }
    function rndIn(rect, rnd) { return { x: rect.x0 + rnd() * (rect.x1 - rect.x0), y: rect.y0 + rnd() * (rect.y1 - rect.y0) }; }
    function homeOf(ag, T) { return T.homes[hash('home:' + ag.cid) % T.homes.length]; }
    function workOf(ag, T) { return T.works[hash('work:' + ag.cid) % T.works.length]; }
    function localSpot(ag, T, rnd) {
      if (ag.role === 'protest') return rndIn(T.protest, rnd);
      if (ag.role === 'elite') return rndIn(T.wealth, rnd);
      if (ag.role === 'work') return rnd() < 0.5 ? homeOf(ag, T) : workOf(ag, T);
      return rndIn(T.plaza, rnd);
    }
    function toWorld(nid, p) { var P = R.L && R.L.towns[nid]; return P ? { x: P.x + p.x, y: P.y + p.y } : { x: p.x, y: p.y }; }
    function ensureAgent(c, n) {
      var ag = R.agents[c.id];
      if (!ag) ag = R.agents[c.id] = { cid: c.id, nid: n.id, x: 0, y: 0, path: [], wait: 0, dir: 'down', moving: false, inside: false,
        seq: 0, rnd: mulberry(hash('ag:' + c.id)), role: '', key: pickSprite(c), placed: false };
      return ag;
    }
    function place(ag, T) {
      var p = toWorld(ag.nid, localSpot(ag, T, mulberry(hash('rest:' + ag.cid))));
      ag.x = p.x; ag.y = p.y; ag.path = []; ag.placed = true;
      ag.wait = ag.rnd() * 3;
      if (ag.role === 'work' && !ag.follower && ag.rnd() < 0.5) { ag.inside = true; ag.wait = 1 + ag.rnd() * 8; }
    }
    function plan(ag, T) {
      ag.seq++;
      var rnd = ag.rnd, target, dwell;
      ag.inside = false;
      if (ag.role === 'protest') { target = rndIn(T.protest, rnd); dwell = 1.4 + rnd() * 3; }
      else if (ag.role === 'elite') { target = rndIn(T.wealth, rnd); dwell = 4 + rnd() * 7; }
      else if (ag.role === 'work') { ag.toWork = !ag.toWork; target = ag.toWork ? workOf(ag, T) : homeOf(ag, T); dwell = 7 + rnd() * 9; ag.enter = true; }
      else { target = rndIn(T.plaza, rnd); dwell = 3 + rnd() * 6; }
      ag.path = [toWorld(ag.nid, target)];
      ag.dwell = dwell;
    }
    function face(ag, dx, dy) { ag.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'); }
    function stepAgent(ag, dt, c) {
      var T = townOf(ag.nid);
      if (!T) return;
      if (ag.wait > 0) { ag.wait -= dt; ag.moving = false; if (ag.wait > 0) return; ag.inside = false; }
      if (!ag.path.length) { plan(ag, T); if (!ag.path.length) { ag.wait = 2; return; } }
      var p = ag.path[0], dx = p.x - ag.x, dy = p.y - ag.y, d = Math.hypot(dx, dy);
      var sp = (c && num(c.mood, 0.6) < 0.3) ? 12 : 20;
      if (ag.role === 'protest') sp = 24;
      if (d <= sp * dt) {
        ag.x = p.x; ag.y = p.y; ag.path.shift();
        if (!ag.path.length) {
          ag.moving = false; ag.wait = ag.dwell || 2;
          if (ag.enter) { ag.inside = !ag.follower; ag.enter = false; if (ag.follower) ag.wait = 2 + ag.rnd() * 2; }
          ag.dir = ag.role === 'protest' ? 'up' : (ag.inside ? 'up' : 'down');
        }
        return;
      }
      ag.moving = true;
      ag.x += dx / d * sp * dt; ag.y += dy / d * sp * dt;
      face(ag, dx, dy);
    }

    // ---------------------------------------------------------------- state sync
    function natList() { var s = env.state(); return (s && Array.isArray(s.nations)) ? s.nations : []; }
    function syncAgents() {
      var seen = {}, now = performance.now();
      natList().forEach(function (n) {
        (n.citizens || []).forEach(function (c) {
          seen[c.id] = 1;
          var ag = ensureAgent(c, n), role = roleOf(c, n);
          ag.follower = !!c.isFollower;
          if (ag.travel) return;
          if (ag.nid !== n.id) { ag.nid = n.id; ag.placed = false; }
          // protests are sticky for a few seconds so crowds reach the hall even at 16x
          if (role === 'protest') ag.protestUntil = now + 7000;
          else if (role !== 'gone' && ag.protestUntil > now) role = 'protest';
          if (ag.role !== role) {
            var was = ag.role;
            ag.role = role;
            if (was && ag.placed && role === 'protest') { ag.path = []; ag.wait = Math.min(ag.wait, 0.2 + ag.rnd() * 0.8); ag.inside = false; ag.enter = false; }
          }
          var T = townOf(n.id);
          if (T && !ag.placed && R.L) place(ag, T);
        });
      });
      for (var id in R.agents) if (!seen[id] && !R.agents[id].travel) delete R.agents[id];
    }

    R.onState = function () {
      if (!R.L) return;
      syncAgents();
      natList().forEach(function (n) {
        var g = n.governor || {}, prev = R.lastGov[n.id], bribes = num(g.bribesTaken, 0);
        R.lastGov[n.id] = { bribes: bribes, bribeAt: prev ? (bribes > prev.bribes ? performance.now() : prev.bribeAt) : 0 };
      });
    };

    var MAX_TRAVEL = 36;
    R.onMove = function (cid, from, to) {
      if (env.reduced() || !R.L) return;
      var ag = R.agents[cid], L = R.L;
      if (!ag || ag.travel || !L.towns[from]) return;
      var busy = 0;
      for (var k in R.agents) if (R.agents[k].travel) busy++;
      var gate = L.gateW[from];
      if (busy >= MAX_TRAVEL) { if (to && L.towns[to]) { ag.nid = to; ag.placed = false; } return; }
      ag.inside = false; ag.enter = false;
      var leaving = 0;
      for (k in R.agents) if (R.agents[k].travel && R.agents[k].travel.from === from) leaving++;
      ag.wait = Math.min(6, leaving * 0.55);                      // a little column, not a blob
      var jit = ((hash(cid) % 7) - 3);
      var path = [{ x: gate.x + jit, y: gate.y - 10 }, { x: gate.x + jit * 0.5, y: gate.y }];
      if (to && L.towns[to]) {
        var road = roadPath(L, from, to), g2 = L.gateW[to];
        if (road) road.forEach(function (p) { path.push({ x: p.x + jit * 0.5, y: p.y + jit * 0.4 }); });
        else path.push({ x: g2.x, y: g2.y });
        path.push({ x: g2.x + jit, y: g2.y - 12 });
        var T2 = townOf(to);
        if (T2) path.push(toWorld(to, rndIn(T2.plaza, ag.rnd)));
        ag.travel = { from: from, to: to };
      } else {
        // leaving the map: down the road to the nearest coast and away
        var ex = gate.x, ey = L.py0 + L.PR * TS + SKIRT + 20;
        path.push({ x: ex + jit, y: Math.min(ey, gate.y + 40) }, { x: ex + jit, y: ey });
        ag.travel = { from: from, to: null, t0: performance.now() };
      }
      ag.path = path;
    };
    function stepTravel(ag, dt) {
      if (ag.wait > 0) { ag.wait -= dt; ag.moving = false; return; }
      if (!ag.path.length) {
        var tr = ag.travel;
        delete ag.travel;
        if (!tr.to || !R.L.towns[tr.to]) { delete R.agents[ag.cid]; return; }
        ag.nid = tr.to; ag.role = ''; ag.wait = 0.5; ag.placed = true;
        return;
      }
      var p = ag.path[0], dx = p.x - ag.x, dy = p.y - ag.y, d = Math.hypot(dx, dy), sp = 30;
      if (d <= sp * dt) { ag.x = p.x; ag.y = p.y; ag.path.shift(); }
      else { ag.x += dx / d * sp * dt; ag.y += dy / d * sp * dt; face(ag, dx, dy); }
      ag.moving = true;
    }

    R.onEvent = function (ev) {
      if (!ev || !R.L) return;
      var now = performance.now();
      if (ev.type === 'nuclear_strike') {
        var tgt = (ev.data && ev.data.targetId) || ev.nationId;
        if (R.L.towns[tgt]) R.fx.push({ kind: 'strike', nid: tgt, t0: now });
      }
      if (/^(debt_crisis|default|hyperinflation|recession|shortage|general_strike|coup)$/.test(ev.type) && ev.nationId) R.crisis[ev.nationId] = now;
      var tag = tagFor(ev);
      if (!tag) return;
      var where = ev.type === 'nuclear_strike' ? ((ev.data && ev.data.targetId) || ev.nationId) : ev.nationId;
      if (!where && /^commons_/.test(ev.type)) where = '__commons';
      if (!where || (where !== '__commons' && !R.L.towns[where])) return;
      var sev = clamp(num(ev.severity, 1), 1, 3);
      var prev = R.tags[where];
      // a quiet tag does not cut short a louder one
      if (prev && now - prev.t0 < 1400 && prev.sev > sev) return;
      R.tags[where] = { text: tag, t0: now, sev: sev };
    };
    R.ping = function (nid) {
      var now = performance.now();
      if (R.pings.some(function (p) { return p.nid === nid && now - p.t0 < 1800; })) return;
      R.pings.push({ nid: nid, t0: now });
      if (R.pings.length > 5) R.pings.shift();
    };
    // camera: ease to a closer whole-number zoom on the event's town, hold, ease back to the whole field
    var CINE_IN = 700, CINE_HOLD = 3600, CINE_OUT = 800;
    R.cinematic = function (ev) {
      if (!ev || env.reduced() || !R.L || R.L.mode !== 'field') return;
      var nid = ev.type === 'nuclear_strike' ? ((ev.data && ev.data.targetId) || ev.nationId) : ev.nationId;
      if (!nid || !R.L.towns[nid]) return;
      var now = performance.now();
      if (R.cine && now - R.cine.t0 < CINE_IN + CINE_HOLD * 0.5) return;  // do not yank between towns
      R.cine = { nid: nid, t0: now };
    };
    R.reset = function () { R.agents = {}; R.fx = []; R.pings = []; R.crisis = {}; R.lastGov = {}; R.tags = {}; R.cine = null; R.layoutKey = ''; R.L = null; R.groundKey = ''; R.comKey = ''; };
    R.invalidate = function () { R.layoutKey = ''; };

    // ---------------------------------------------------------------- drawing
    function ensureLayout(W, H, dpr) {
      var ns = natList();
      var focus = (env.focus && env.focus()) || '';
      var key = [W, H, dpr, ns.map(function (n) { return n.id + ':' + n.system + ':' + (n.colorKey || ''); }).join(','), focus ? 'story' : ''].join('|');
      if (key === R.layoutKey && R.L) return R.L;
      R.layoutKey = key;
      R.L = computeLayout(W, H, dpr, ns, focus);
      var towns = {};
      ns.forEach(function (n, i) {
        var prev = R.towns[n.id];
        towns[n.id] = prev && prev.sys === (PLANS[n.system] ? n.system : 'social_democracy') && prev.key === keyOf(n, i) ? prev : buildTown(n, i);
      });
      R.towns = towns;
      R.frame = canvas(R.L.w, R.L.h);
      R.fctx = R.frame.getContext('2d');
      R.fctx.imageSmoothingEnabled = false;
      R.groundKey = ''; R.comKey = ''; R.ripples = null; R.cine = null;
      for (var id in R.agents) { var ag = R.agents[id]; delete ag.travel; ag.placed = false; ag.path = []; }
      syncAgents();
      return R.L;
    }
    function ripples(L) {
      if (R.ripples) return R.ripples;
      var rnd = mulberry(hash('waves:' + L.w + 'x' + L.h)), list = [];
      var x0 = L.px0 - 4, y0 = L.py0 - 4, x1 = L.px0 + L.PC * TS + 4, y1 = L.py0 + L.PR * TS + SKIRT + 4;
      for (var i = 0; i < Math.round(L.w * L.h / 2600); i++) {
        var x = rnd() * L.w, y = rnd() * L.h;
        if (x > x0 - 8 && x < x1 && y > y0 && y < y1) continue;
        list.push({ x: x, y: y, w: 3 + Math.floor(rnd() * 4), ph: rnd() * 6.28 });
      }
      R.ripples = list;
      return list;
    }

    var EMO_MOOD = { calm: 'emo.note', pressured: 'emo.drop', scheming: 'emo.cash', defiant: 'emo.angry', panicked: 'emo.bang' };

    function drawEmblem(g, emb, x, y, color, px) {
      var bm = EMB[emb] || EMB.sun;
      g.fillStyle = color;
      for (var r = 0; r < 7; r++) for (var c = 0; c < 7; c++) if (bm[r].charAt(c) === '#') g.fillRect(x + c * px, y + r * px, px, px);
    }
    // flag on a pole: 2 px pole, 17 x 12 cloth that ripples, emblem in the middle. Down and grey when fallen.
    function drawFlag(g, x, y, key, emb, now, still, dead) {
      var H = 44, top = y - H;
      g.fillStyle = '#3d4250'; g.fillRect(x - 1, top, 3, H);
      g.fillStyle = '#c9ced8'; g.fillRect(x, top, 1, H - 1);
      g.fillStyle = '#e8c35a'; g.fillRect(x - 1, top - 2, 3, 2);
      g.fillStyle = '#2b2f38'; g.fillRect(x - 3, y - 1, 7, 2);
      if (dead) {
        g.fillStyle = '#55575e'; g.fillRect(x + 2, y - 14, 5, 12);
        g.fillStyle = '#7a7c84'; g.fillRect(x + 2, y - 14, 5, 1);
        return;
      }
      var col = paint(key), cw = 17, ch = 12, cx = x + 2, cy = top + 1, t = still ? 0 : now / 1000;
      for (var c = 0; c < cw; c++) {
        var off = Math.round(Math.sin(t * 5 - c * 0.55) * (c / cw) * 1.6);
        g.fillStyle = col.dark; g.fillRect(cx + c, cy + off, 1, ch);
        g.fillStyle = col.mid; g.fillRect(cx + c, cy + off + 1, 1, ch - 2);
        // emblem column by column, so it ripples with the cloth
        var bc = c - 5;
        if (bc >= 0 && bc < 7) {
          g.fillStyle = '#fff7e2';
          var bm = EMB[emb] || EMB.sun;
          for (var r = 0; r < 7; r++) if (bm[r].charAt(bc) === '#') g.fillRect(cx + c, cy + off + 3 + r - 1, 1, 1);
        }
      }
      g.fillStyle = col.dark; g.fillRect(cx + cw - 1, cy + Math.round(Math.sin(t * 5 - (cw - 1) * 0.55) * 1.6), 1, ch);
    }
    // two short banners on the hall facade, in the nation colour
    function drawBanners(g, x, y, key, dead) {
      var col = dead ? paint('grey') : paint(key);
      [x - 30, x + 23].forEach(function (bx) {
        g.fillStyle = col.dark; g.fillRect(bx, y, 7, 14); g.fillRect(bx + 1, y + 14, 2, 2); g.fillRect(bx + 4, y + 14, 2, 2);
        g.fillStyle = col.mid; g.fillRect(bx + 1, y + 1, 5, 12); g.fillRect(bx + 1, y + 13, 2, 2); g.fillRect(bx + 4, y + 13, 2, 2);
        g.fillStyle = '#fff7e2'; g.fillRect(bx + 3, y + 4, 1, 5); g.fillRect(bx + 2, y + 6, 3, 1);
      });
    }
    // protest placard held above the head, bobbing
    function drawPlacard(g, x, y, ph, now, still) {
      var bob = still ? 0 : (Math.sin(now / 180 + ph * 9) > 0 ? 1 : 0), px = Math.round(x + (ph < 0.5 ? -6 : 3)), py = Math.round(y - 36 - bob);
      g.fillStyle = '#5a3d26'; g.fillRect(px + 3, py + 5, 1, 9);
      g.fillStyle = '#2b2622'; g.fillRect(px, py, 8, 6);
      g.fillStyle = '#f3ead6'; g.fillRect(px + 1, py + 1, 6, 4);
      g.fillStyle = '#d24b45'; g.fillRect(px + 2, py + 2, 4, 1); g.fillRect(px + 2, py + 3, 3, 1);
    }
    // little suitcase in an emigrant's hand
    function drawCase(g, x, y, dir) {
      var sx = Math.round(x + (dir === 'left' ? -8 : dir === 'right' ? 4 : 5)), sy = Math.round(y - 11);
      g.fillStyle = '#3b2a20'; g.fillRect(sx, sy, 5, 5);
      g.fillStyle = '#9a6a3c'; g.fillRect(sx + 1, sy + 1, 3, 3);
      g.fillStyle = '#3b2a20'; g.fillRect(sx + 1, sy - 1, 3, 1);
    }

    R.draw = function (ctx, W, H, dpr, now) {
      var s = env.state();
      if (!s || !Array.isArray(s.nations)) return false;
      var L = ensureLayout(W, H, dpr), tok = env.tok(), still = env.reduced();
      var dt = R.lastNow ? clamp((now - R.lastNow) / 1000, 0, 0.1) : 0;
      R.lastNow = now;
      var g = R.fctx, cfgW = (env.config() && env.config().world) || {};
      var cid2c = {}, nById = {}, idxOf = {};
      s.nations.forEach(function (n, i) { nById[n.id] = n; idxOf[n.id] = i; (n.citizens || []).forEach(function (c) { cid2c[c.id] = c; }); });

      // simulate
      if (!still && dt > 0) {
        for (var id in R.agents) {
          var ag = R.agents[id];
          if (ag.travel) { stepTravel(ag, dt); continue; }
          var n0 = nById[ag.nid];
          if (!n0 || n0.alive === false) continue;
          stepAgent(ag, dt, cid2c[id]);
        }
      }

      // ---- static ground (cached)
      var gk = s.nations.map(function (n) { return n.alive === false ? 0 : 1; }).join('');
      if (R.groundKey !== gk || !R.ground) { R.ground = renderGround(L, s.nations); R.groundKey = gk; }
      var comRatio = 1;
      if (s.commons) { var cap = num(s.commons.capacity, 100); comRatio = clamp(cap > 0 ? num(s.commons.stock, cap) / cap : 0, 0, 1); }
      var showCom = !!L.commons && cfgW.commons !== false;
      var ck = Math.round(comRatio * 20) + ':' + showCom;
      if (showCom && R.comKey !== ck) { R.comCanvas = commonsGround(L, comRatio); R.comKey = ck; }

      // ---- world frame (1 px = 1 art px)
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 1;
      g.clearRect(0, 0, L.w, L.h);
      g.fillStyle = tok.water;
      var tt = still ? 0 : now / 1000;
      g.globalAlpha = 0.4;
      ripples(L).forEach(function (p) {
        var x = Math.round(p.x + Math.sin(tt * 0.6 + p.ph) * 3), y = Math.round(p.y);
        g.fillRect(x, y, p.w, 1); g.fillRect(x + 1, y - 1, Math.max(1, p.w - 2), 1);
      });
      g.globalAlpha = 1;
      g.fillStyle = tok.shadow;
      g.fillRect(L.px0 + 5, L.py0 + 8, L.PC * TS, L.PR * TS + SKIRT - 4);
      g.drawImage(R.ground, 0, 0);
      if (showCom) g.drawImage(R.comCanvas, L.commons.x, L.commons.y);

      // tension along the ground between territories
      var tensions = drawTension(g, L, s, now, still);

      var list = [];
      function push(y, f, top) { list.push({ y: y, f: f, top: top }); }
      // decor trees and border posts
      L.decor.forEach(function (d) { push(d.y, function () { spr(g, d.spr, d.x, d.y); }); });
      // forest
      if (showCom) {
        var C = L.commons, N = FOREST.length, alive = Math.round(comRatio * N + 0.25);
        var order = FOREST.map(function (p, i) { return { p: p, i: i, k: hash('forest' + i) }; }).sort(function (a, b) { return a.k - b.k; });
        order.forEach(function (o, rank) {
          var x = C.x + Math.round(o.p[0] * C.w / 160), y = C.y + o.p[1];
          var kind = rank < alive ? ['prop.tree1', 'prop.tree2', 'prop.treeR', 'prop.tree3', 'prop.pine'][o.i % 5] : (comRatio < 0.35 && o.i % 3 === 0 ? 'prop.dead' : (o.i % 2 ? 'prop.stump' : 'prop.stumpS'));
          push(y, function () { spr(g, kind, x, y); });
        });
      }
      // towns
      s.nations.forEach(function (n) {
        var T = R.towns[n.id], P = L.towns[n.id];
        if (!T || !P) return;
        var dead = n.alive === false, img = dead ? greyImg() : IMG, m = n.metrics || {};
        T.items.forEach(function (it) { push(P.y + it.y, function () { spr(g, it.spr, P.x + it.x, P.y + it.y, img); }); });
        push(P.y + 96.5, function () { drawBanners(g, P.x + T.hallX, P.y + 40, T.key, dead); });
        if (P.post) push(P.post.y, function () { spr(g, 'bld.hut', P.post.x, P.post.y, img); });
        if (num(m.shortage, 0) > 15 && !dead) {
          [[70, 138], [140, 134], [96, 124], [36, 112]].forEach(function (p) { push(P.y + p[1], function () { spr(g, 'prop.litter', P.x + p[0], P.y + p[1]); }); });
        }
        var fl = T.flag;
        push(P.y + fl.y, function () { drawFlag(g, P.x + fl.x, P.y + fl.y, T.key, T.emblem, now + idxOf[n.id] * 300, still, dead); });
        if (dead) {
          [[40, 96], [104, 98], [176, 96], [60, 140], [170, 140]].forEach(function (p, i) {
            push(P.y + p[1] + 1, function () { spr(g, still ? A.anims['fx.fire'].frames[0] : animFrame('fx.fire', now, i * 0.37), P.x + p[0], P.y + p[1]); });
          });
          return;
        }
        var gov = n.governor || {};
        if (gov.inOffice !== false) {
          var gk2 = GOV_SPRITE[gov.type] || 'gper', gx = P.x + T.gov.x, gy = P.y + T.gov.y;
          push(gy, function () {
            spr(g, still ? 'ch.' + gk2 + '.idle.down#0' : animFrame('ch.' + gk2 + '.idle.down', now), gx, gy);
            if (gov.type === 'human_player') { g.fillStyle = '#ffd25e'; g.fillRect(gx - 3, gy - 35, 7, 2); g.fillRect(gx - 3, gy - 37, 1, 2); g.fillRect(gx, gy - 38, 1, 3); g.fillRect(gx + 3, gy - 37, 1, 2); }
          }, function () {
            var lg = R.lastGov[n.id], emo = EMO_MOOD[gov.mood] || 'emo.note';
            if (lg && lg.bribeAt && now - lg.bribeAt < 5000) emo = 'emo.gold';
            var cyc = still ? 0 : ((now + hash(n.id) % 1000) % 5200);
            if (cyc < 3400) drawEmote(g, emo, gx, gy - 31, now);
          });
        }
      });

      // citizens
      var labels = [], me = env.myUserId(), nTravel = 0, nProtest = 0;
      for (var aid in R.agents) {
        (function (ag) {
          var n = nById[ag.nid];
          if (!ag.travel && (!L.towns[ag.nid] || !n || n.alive === false || ag.inside || !ag.placed)) return;
          var c = cid2c[ag.cid] || {}, x = ag.x, y = ag.y;
          if (ag.travel && ag.wait <= 0) nTravel++;
          else if (ag.role === 'protest') nProtest++;
          var anim = 'ch.' + ag.key + '.' + (ag.moving && !still ? 'walk' : 'idle') + '.' + ag.dir;
          if (!A.anims[anim]) anim = 'ch.w1.idle.down';
          var ph = (hash(ag.cid) % 100) / 100;
          var name = still ? A.anims[anim].frames[0] : animFrame(anim, now * ((num(c.mood, 0.6) < 0.3) ? 0.7 : 1), ph);
          var fade = 1;
          if (ag.travel && !ag.travel.to && ag.path.length <= 1) fade = 0.55;
          var item = { y: y, f: function () {
            if (c.isFollower) {
              var mine = me && c.ownerId === me;
              g.fillStyle = mine ? tok.signal : tok.text; g.globalAlpha = 0.9;
              g.fillRect(Math.round(x) - 6, Math.round(y) - 1, 12, 1); g.fillRect(Math.round(x) - 7, Math.round(y), 14, 1); g.fillRect(Math.round(x) - 6, Math.round(y) + 1, 12, 1);
              g.globalAlpha = 1;
            }
            spr(g, name, x, y, null, fade < 1 ? fade : null);
            if (ag.travel) drawCase(g, x, y, ag.dir);
            else if (ag.role === 'protest') drawPlacard(g, x, y, ph, now, still);
            if (c.cls === 'elite') { g.fillStyle = tok.owner; g.fillRect(Math.round(x) - 1, Math.round(y) - 31, 2, 2); }
          } };
          var e = null, cyc = still ? 0 : (now / 1000 + ph * 7) % 7;
          if (ag.travel) e = null;
          else if (c.protesting || ag.role === 'protest') e = cyc < 3.5 ? (ph < 0.5 ? 'emo.angry' : 'emo.alarm') : null;
          else if (c.hidingIncome && cyc > 5.2) e = 'emo.cash';
          else if (num(c.mood, 0.6) < 0.25 && cyc < 2.4) e = 'emo.tear';
          else if (R.crisis[ag.nid] && now - R.crisis[ag.nid] < 3500 && ph < 0.12) e = 'emo.bang';
          if (still && c.protesting) e = 'emo.angry';
          if (e) item.top = function () { drawEmote(g, e, x, y - 31, now + ph * 1000); };
          list.push(item);
          if (c.isFollower) labels.push({ x: x, y: y - 34, name: c.name || 'Citizen', mine: me && c.ownerId === me });
        })(R.agents[aid]);
      }
      list.sort(function (a, b) { return a.y - b.y; });
      list.forEach(function (it) { it.f(); });
      list.forEach(function (it) { if (it.top) it.top(); });

      // strikes
      var keepFx = [];
      R.fx.forEach(function (fx) {
        var P = L.towns[fx.nid];
        if (!P) return;
        var t = now - fx.t0;
        if (t > 4200 || still) return;
        keepFx.push(fx);
        [[104, 60, 0], [40, 110, 300], [170, 100, 520], [104, 140, 800], [180, 50, 1000]].forEach(function (b) {
          var tb = t - b[2];
          if (tb < 0) return;
          var an = A.anims['fx.boom'], k = Math.floor(tb / 1000 * an.fps);
          if (k < an.frames.length) spr(g, an.frames[k], P.x + b[0], P.y + b[1]);
        });
      });
      R.fx = keepFx;

      // ---- camera and blit: whole-number scale, whole device px offsets, no smoothing
      var cam = camera(L, now, still);
      var z = cam.z, ox = cam.ox, oy = cam.oy;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = tok.bg; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.fillStyle = tok.water; ctx.globalAlpha = 0.13; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(R.frame, 0, 0, L.w, L.h, ox, oy, L.w * z, L.h * z);
      var ds = ctx.canvas.dataset;
      if (ds) {
        if (ds.pxScale !== String(L.s)) ds.pxScale = String(L.s);
        if (ds.pxZoom !== String(z)) ds.pxZoom = String(z);
        if (ds.pxMode !== L.mode) ds.pxMode = L.mode;
        var fit = L.mode === 'field' ? '1' : '0';
        if (ds.pxFits !== fit) ds.pxFits = fit;
        ds.pxField = L.w + 'x' + L.h + ' ' + L.orient;
        ds.pxTravel = String(nTravel); ds.pxProtest = String(nProtest); ds.pxStrike = String(R.fx.length);
        ds.pxFallen = String(s.nations.filter(function (n) { return n.alive === false; }).length);
      }
      R.fx.forEach(function (fx) {
        var t = now - fx.t0;
        if (t < 700) { ctx.globalAlpha = 0.55 * (1 - t / 700); ctx.fillStyle = tok.text; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.globalAlpha = 1; }
      });

      // ---- overlays in CSS px
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      function toCss(wx, wy) { return [(ox + wx * z) / dpr, (oy + wy * z) / dpr]; }
      var zoomed = z !== L.s || L.mode !== 'field';
      // town name tags
      s.nations.forEach(function (n, i) {
        var P = L.towns[n.id], T = R.towns[n.id];
        if (!P || !T) return;
        var p = toCss(P.x + TOWN_C * TS / 2, P.y + TOWN_R * TS);
        if (zoomed && (p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H + 8)) return;   // off screen while the camera is in close
        drawNameTag(ctx, n, T, p, tok, W, H, zoomed);
      });
      // tension labels
      tensions.forEach(function (tn) {
        if (tn.t < 35) return;
        var p = toCss(tn.x, tn.y), col = tn.t >= 70 ? tok.crit : tok.warn;
        var label = (W < 520 ? '' : 'TENSION ') + Math.round(tn.t);
        ctx.font = '600 9.5px "IBM Plex Mono", monospace';
        var w = ctx.measureText(label).width + 10;
        ctx.globalAlpha = 0.92; ctx.fillStyle = tok.bg; rr(ctx, p[0] - w / 2, p[1] - 21, w, 15, 4); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
        ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, p[0], p[1] - 13);
      });
      // commons label
      if (showCom) {
        var cp = toCss(L.commons.x + L.commons.w / 2, L.commons.y + L.commons.h);
        ctx.font = '600 9.5px "IBM Plex Mono", monospace';
        var ct = 'SHARED FOREST ' + Math.round(comRatio * 100) + '%', cw = ctx.measureText(ct).width + 10;
        ctx.globalAlpha = 0.9; ctx.fillStyle = tok.surface; rr(ctx, cp[0] - cw / 2, cp[1] - 8, cw, 15, 4); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = comRatio < 0.25 ? tok.crit : tok.dim; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ct, cp[0], cp[1] - 0.5);
      }
      // follower labels
      labels.sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      labels.slice(0, 8).forEach(function (l) {
        var p = toCss(l.x, l.y), w = ctx.measureText(l.name).width + 10;
        ctx.globalAlpha = 0.92; ctx.fillStyle = tok.surface; rr(ctx, p[0] - w / 2, p[1] - 15, w, 14, 3); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = l.mine ? tok.signal : tok.line2; ctx.stroke();
        ctx.fillStyle = l.mine ? tok.signal : tok.text; ctx.fillText(l.name, p[0], p[1] - 7.5);
      });
      // pings: outline around the town's territory
      var keepP = [];
      R.pings.forEach(function (p) {
        var f = (now - p.t0) / 1800, P = L.towns[p.nid];
        if (f >= 1 || !P || still) return;
        keepP.push(p);
        ctx.globalAlpha = 0.8 * (1 - f); ctx.strokeStyle = tok.signal; ctx.lineWidth = 2;
        var a = toCss(P.terr.x - f * 8, P.terr.y - f * 8), b = toCss(P.terr.x + P.terr.w + f * 8, P.terr.y + P.terr.h + f * 8);
        rr(ctx, a[0], a[1], b[0] - a[0], b[1] - a[1], 8); ctx.stroke(); ctx.globalAlpha = 1;
      });
      R.pings = keepP;
      // action tags over towns
      for (var tid in R.tags) {
        var tg = R.tags[tid], age = now - tg.t0;
        if (age > 2600) { delete R.tags[tid]; continue; }
        var anchorW = tid === '__commons' ? (L.commons ? [L.commons.x + L.commons.w / 2, L.commons.y + 12] : null)
          : (L.towns[tid] ? [L.towns[tid].x + R.towns[tid].hallX, L.towns[tid].y + 26] : null);
        if (!anchorW) continue;
        var tp = toCss(anchorW[0], anchorW[1]);
        if (zoomed && (tp[0] < 0 || tp[0] > W || tp[1] < 0 || tp[1] > H)) continue;
        drawTag(ctx, tg, tp, age, still, tok, W);
      }
      // HUD, doomsday dial, stamp
      var hudBox = drawHud(ctx, s, L, tok, W, H, dpr);
      if (cfgW.escalation) {
        var D = dialSpot(L, W, H, dpr, hudBox, toCss);
        if (D) {
          ctx.globalAlpha = 0.85; ctx.fillStyle = tok.surface; rr(ctx, D.x - D.r - 7, D.y - D.r - 7, D.r * 2 + 14, D.r + 40, 8); ctx.fill(); ctx.globalAlpha = 1;
          try { env.vector.drawDial(num(s.doomsday, 0), D); } catch (e) { /* ignore */ }
        }
      }
      if (!L.story) {
        var stampText = 'YEAR ' + num(s.year, 0) + ' · ROUND ' + num(s.round, 0);
        ctx.font = '500 10px "IBM Plex Mono", monospace';
        var sw = ctx.measureText(stampText).width + 12, sx = W - sw - 6, sy = H - 23;
        ctx.globalAlpha = 0.85; ctx.fillStyle = tok.surface; rr(ctx, sx, sy, sw, 18, 5); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = tok.faint; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(stampText, sx + 6, H - 10);
      }
      return true;
    };

    // ---------------------------------------------------------------- camera
    function camera(L, now, still) {
      var base = { z: L.s, ox: L.ox, oy: L.oy };
      if (L.mode === 'pan') {
        // cycle between towns, whole device px
        var n = L.order.length, per = 8.3, c;
        var ctr = function (id) { var t = L.towns[id]; return [t.x + TOWN_C * 8, t.y + TOWN_R * 8]; };
        if (still || n < 2) c = ctr(L.order[0]);
        else {
          var t = now / 1000, i = Math.floor(t / per) % n, ph = t % per;
          c = ctr(L.order[i]);
          if (ph > 6.5) { var e = (ph - 6.5) / 1.8, d = ctr(L.order[(i + 1) % n]); e = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2; c = [c[0] + (d[0] - c[0]) * e, c[1] + (d[1] - c[1]) * e]; }
        }
        var vw = L.devW, vh = L.devH;
        var cx = L.w > vw ? clamp(c[0], vw / 2, L.w - vw / 2) : L.w / 2, cy = L.h > vh ? clamp(c[1], vh / 2, L.h - vh / 2) : L.h / 2;
        return { z: 1, ox: Math.round(vw / 2 - cx), oy: Math.round(vh / 2 - cy) };
      }
      var cn = R.cine;
      if (!cn || still || !L.towns[cn.nid]) { R.cine = null; return base; }
      var tt = now - cn.t0, total = CINE_IN + CINE_HOLD + CINE_OUT;
      if (tt >= total) { R.cine = null; return base; }
      var P = L.towns[cn.nid];
      // closest whole-number zoom that still shows the whole town with a little ground around it
      var zt = L.s;
      for (var k = L.s + 1; k <= L.s * 3; k++) { if ((TOWN_C * TS + 40) * k <= L.devW && (TOWN_R * TS + 70) * k <= L.devH) zt = k; else break; }
      if (zt === L.s) return base;
      var e = tt < CINE_IN ? tt / CINE_IN : tt < CINE_IN + CINE_HOLD ? 1 : 1 - (tt - CINE_IN - CINE_HOLD) / CINE_OUT;
      e = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
      var z = L.s + Math.round((zt - L.s) * e);
      // centre moves smoothly from the field centre to the town (in art px), then pixel-snapped
      var fcx = (L.devW / 2 - L.ox) / L.s, fcy = (L.devH / 2 - L.oy) / L.s;
      // the town sits a little below the middle, clear of the caption at the top
      var vw = L.devW / zt, vh = L.devH / zt;
      var tcx = P.x + TOWN_C * TS / 2;
      var tcy = P.y + TOWN_R * TS / 2 - vh * 0.08;
      var cx2 = fcx + (tcx - fcx) * e, cy2 = fcy + (tcy - fcy) * e;
      return { z: z, ox: Math.round(L.devW / 2 - cx2 * z), oy: Math.round(L.devH / 2 - cy2 * z) };
    }

    // ---------------------------------------------------------------- tension along the ground
    function clipOut(r, x0, y0, x1, y1) {
      // parameter where the segment from inside r leaves it
      var t = 1, dx = x1 - x0, dy = y1 - y0;
      if (dx > 0) t = Math.min(t, (r.x + r.w - x0) / dx); else if (dx < 0) t = Math.min(t, (r.x - x0) / dx);
      if (dy > 0) t = Math.min(t, (r.y + r.h - y0) / dy); else if (dy < 0) t = Math.min(t, (r.y - y0) / dy);
      return clamp(t, 0, 1);
    }
    function onSomething(L, x, y) {
      var C = L.commons;
      if (C && x > C.x - 20 && x < C.x + C.w + 20 && y > C.y - 12 && y < C.y + C.h + 20) return true;
      for (var id in L.towns) { var q = L.towns[id].terr; if (x > q.x - 16 && x < q.x + q.w + 16 && y > q.y - 8 && y < q.y + q.h + 16) return true; }
      return false;
    }
    function drawTension(g, L, s, now, still) {
      var ten = s.tension || {}, tok = env.tok(), out = [];
      for (var key in ten) {
        var t = num(ten[key], 0);
        if (t < 15) continue;
        var ids = key.split('|'), a = L.towns[ids[0]], b = L.towns[ids[1]];
        if (!a || !b) continue;
        var ax = a.terr.x + a.terr.w / 2, ay = a.terr.y + a.terr.h / 2, bx = b.terr.x + b.terr.w / 2, by = b.terr.y + b.terr.h / 2;
        var t0 = clipOut(a.terr, ax, ay, bx, by), t1 = 1 - clipOut(b.terr, bx, by, ax, ay);
        if (t1 <= t0) continue;
        var x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0, x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
        var len = Math.hypot(x1 - x0, y1 - y0), col = t >= 70 ? tok.crit : t >= 35 ? tok.warn : tok.faint;
        var sz = t >= 70 ? 3 : 2, stepPx = t >= 70 ? 6 : 5, shift = (!still && t >= 35) ? (now / 90) % stepPx : 0;
        g.fillStyle = col;
        // soft glow under the dots
        g.globalAlpha = 0.18 + t / 100 * 0.25;
        for (var d = 0; d < len; d += 2) { var gx = x0 + (x1 - x0) * d / len, gy = y0 + (y1 - y0) * d / len; g.fillRect(Math.round(gx) - sz, Math.round(gy) - sz, sz * 2 + 1, sz * 2 + 1); }
        g.globalAlpha = 0.6 + t / 100 * 0.4;
        for (d = shift; d < len; d += stepPx) { var px = x0 + (x1 - x0) * d / len, py = y0 + (y1 - y0) * d / len; g.fillRect(Math.round(px) - (sz >> 1), Math.round(py) - (sz >> 1), sz, sz); }
        g.globalAlpha = 1;
        // marker point: the middle, slid along the line until it is on open ground (not the forest, not a town)
        var mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        for (var k = 0; k <= 10; k++) {
          var f = 0.5 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.05, qx = x0 + (x1 - x0) * f, qy = y0 + (y1 - y0) * f;
          if (!onSomething(L, qx, qy)) { mx = qx; my = qy; break; }
        }
        out.push({ t: t, x: mx, y: my });
        if (t >= 70) {
          // a barricade where the two sides meet
          spr(g, 'prop.sandbag', mx - 12, my + 8); spr(g, 'prop.sandbag', mx + 12, my + 8); spr(g, 'prop.barrier', mx, my + 10);
        }
      }
      return out;
    }

    // ---------------------------------------------------------------- overlays
    function drawEmote(g, name, x, y, now) {
      var an = A.anims[name];
      if (an) {
        var total = (an.durs || []).reduce(function (a, b) { return a + b; }, 0) || an.frames.length * 120;
        var t = now % (total + 900), acc = 0, k = an.frames.length - 1;
        if (an.durs) { for (var i = 0; i < an.durs.length; i++) { acc += an.durs[i]; if (t < acc) { k = i; break; } } }
        spr(g, an.frames[k], x, y);
      } else spr(g, name, x, y);
    }
    function drawNameTag(ctx, n, T, p, tok, W, H, zoomed) {
      var dead = n.alive === false, col = dead ? paint('grey') : paint(T.key);
      var fs = W < 520 ? 10.5 : 12, name = (n.name || n.id);
      ctx.save();
      ctx.font = '700 ' + fs + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
      var w = Math.ceil(ctx.measureText(name).width) + 22, h = fs + 7;
      var x = clamp(p[0] - w / 2, 2, W - w - 2), y = p[1] - h / 2 + 2;
      if (y + h > H - 2) y = H - h - 2;
      ctx.fillStyle = col.mid; rr(ctx, x, y, w, h, h / 2); ctx.fill();
      ctx.strokeStyle = col.dark; ctx.lineWidth = 1; ctx.stroke();
      drawEmblemCss(ctx, T.emblem, x + 5, y + (h - 9) / 2, 9, '#1a1408');
      ctx.fillStyle = '#16120a'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(name, x + 17, y + h / 2 + 0.5);
      if (dead) { ctx.strokeStyle = tok.crit; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 15, y + h / 2); ctx.lineTo(x + w - 4, y + h / 2); ctx.stroke(); }
      ctx.restore();
    }
    function drawEmblemCss(ctx, emb, x, y, size, color) {
      var bm = EMB[emb] || EMB.sun, px = size / 7;
      ctx.fillStyle = color;
      for (var r = 0; r < 7; r++) for (var c = 0; c < 7; c++) if (bm[r].charAt(c) === '#') ctx.fillRect(x + c * px, y + r * px, px + 0.05, px + 0.05);
    }
    function drawTag(ctx, tg, p, age, still, tok, W) {
      var a = still ? 1 : age < 180 ? age / 180 : age > 2200 ? 1 - (age - 2200) / 400 : 1;
      var rise = still ? 0 : Math.min(1, age / 220) * 6;
      var col = tg.sev >= 3 ? tok.crit : tg.sev === 2 ? tok.warn : tok.label;
      ctx.save();
      ctx.globalAlpha = clamp(a, 0, 1);
      var fs = W < 520 ? 10 : 11.5;
      ctx.font = '700 ' + fs + 'px "IBM Plex Mono", monospace';
      var w = ctx.measureText(tg.text).width + 14, h = fs + 9, x = clamp(p[0] - w / 2, 2, W - w - 2), y = p[1] - h - rise;
      ctx.fillStyle = tok.bg; rr(ctx, x, y, w, h, 4); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
      // pointer
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(p[0] - 4, y + h); ctx.lineTo(p[0] + 4, y + h); ctx.lineTo(p[0], y + h + 5); ctx.closePath(); ctx.fill();
      ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(tg.text, x + w / 2, y + h / 2 + 0.5);
      ctx.restore();
    }
    function govIcon(ctx, type, x, y, color) {
      ctx.save();
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.2;
      if (type === 'aligned_ai') {
        rr(ctx, x, y + 2, 9, 7, 1.5); ctx.stroke();
        ctx.fillRect(x + 2, y + 4.5, 1.6, 1.6); ctx.fillRect(x + 5.4, y + 4.5, 1.6, 1.6);
        ctx.beginPath(); ctx.moveTo(x + 4.5, y + 2); ctx.lineTo(x + 4.5, y); ctx.stroke();
      } else if (type === 'human_player') {
        ctx.beginPath();
        for (var i = 0; i < 10; i++) { var r = i % 2 ? 2 : 4.8, an = -Math.PI / 2 + i * Math.PI / 5; ctx.lineTo(x + 4.5 + Math.cos(an) * r, y + 5 + Math.sin(an) * r); }
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.arc(x + 4.5, y + 3, 2.3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(x, y + 10); ctx.quadraticCurveTo(x + 4.5, y + 4, x + 9, y + 10); ctx.fill();
      }
      ctx.restore();
    }
    function metric01(n, id) {
      var v = n.metrics ? num(n.metrics[id], null) : null;
      if (v == null) return null;
      return clamp(v / 100, 0, 1);          // wellbeing, trust and corruption are 0-100
    }
    // compact corner HUD: one row per nation with chip, emblem, name, governor and three tiny bars
    function drawHud(ctx, s, L, tok, W, H, dpr) {
      var hud = L.hud, ns = s.nations, x, y;
      if (L.hudCell && !L.hudOverlay) {
        var a = [(L.ox + L.hudCell.x * L.s) / dpr, (L.oy + L.hudCell.y * L.s) / dpr];
        x = a[0]; y = a[1];
      }
      var wide = hud.mode === 'wide', w = hud.w, rowH = hud.rowH, h = hud.h, head = wide ? 21 : 30;
      if (!(L.hudCell && !L.hudOverlay)) {
        // no reserved slot: the corner that hides the least of the towns
        var best = null;
        [[6, 6], [W - w - 6, 6], [6, H - h - 6], [W - w - 6, H - h - 6]].forEach(function (c) {
          var cover = 0;
          for (var id in L.towns) {
            var q = L.towns[id].terr, ax = (L.ox + q.x * L.s) / dpr, ay = (L.oy + q.y * L.s) / dpr, bx = (L.ox + (q.x + q.w) * L.s) / dpr, by = (L.oy + (q.y + q.h) * L.s) / dpr;
            cover += Math.max(0, Math.min(bx, c[0] + w) - Math.max(ax, c[0])) * Math.max(0, Math.min(by, c[1] + h) - Math.max(ay, c[1]));
          }
          if (!best || cover < best.cover - 1) best = { cover: cover, x: c[0], y: c[1] };
        });
        x = best.x; y = best.y;
      }
      x = clamp(x, 4, Math.max(4, W - w - 4)); y = clamp(y, 4, Math.max(4, H - h - 4));
      ctx.save();
      ctx.globalAlpha = L.hudOverlay ? 0.86 : 0.93; ctx.fillStyle = tok.bg; rr(ctx, x, y, w, h, 7); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = tok.line2; ctx.lineWidth = 1; ctx.stroke();
      var barW = wide ? 22 : Math.floor((w - 14 - 6) / 3), gap = 3, bx0 = wide ? x + w - 7 - 3 * barW - 2 * gap : x + 7;
      var cols = [tok.good, tok.focus || tok.water, tok.crit];
      ctx.font = '600 8px "IBM Plex Mono", monospace'; ctx.textBaseline = 'middle';
      // legend line
      var heads = ['Wellbeing', 'Trust', 'Corruption'];
      var lx = x + 8, ly = y + 11;
      heads.forEach(function (hd, i) {
        if (!wide && i === 2) { lx = x + 8; ly += 10; }
        ctx.fillStyle = cols[i]; ctx.fillRect(lx, ly - 3, 6, 6);
        ctx.fillStyle = tok.dim; ctx.textAlign = 'left'; ctx.fillText(hd, lx + 8, ly + 0.5);
        lx += ctx.measureText(hd).width + (wide ? 16 : 12);
      });
      var focusId = L.focus;
      ns.forEach(function (n, i) {
        var T = R.towns[n.id], key = T ? T.key : keyOf(n, i), dead = n.alive === false, ry = y + head + i * rowH, cy = wide ? ry + rowH / 2 : ry + 8;
        var col = dead ? paint('grey') : paint(key);
        if (focusId && n.id === focusId) {
          ctx.globalAlpha = 0.28; ctx.fillStyle = col.mid; rr(ctx, x + 3, ry, w - 6, rowH - 1, 4); ctx.fill(); ctx.globalAlpha = 1;
          ctx.strokeStyle = col.mid; ctx.lineWidth = 1.2; rr(ctx, x + 3, ry, w - 6, rowH - 1, 4); ctx.stroke();
        }
        var cs = wide ? rowH - 5 : 13;
        ctx.fillStyle = col.mid; rr(ctx, x + 7, cy - cs / 2, cs, cs, 2.5); ctx.fill();
        drawEmblemCss(ctx, T ? T.emblem : emblemOf(n, i), x + 7 + (cs - 7) / 2, cy - 3.5, 7, '#1a1408');
        var nx = x + 7 + cs + 5, g0 = n.governor || {};
        govIcon(ctx, g0.type, nx, cy - 5, dead ? tok.faint : tok.dim);
        nx += 13;
        ctx.textAlign = 'left';
        ctx.font = '700 ' + (wide ? 11.5 : 10.5) + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
        ctx.fillStyle = dead ? tok.faint : tok.label;
        var nameW = wide ? 76 : x + w - 6 - nx;
        ctx.fillText(fit(ctx, n.name || n.id, nameW), nx, cy + 0.5);
        if (wide) {
          ctx.font = '500 9.5px "IBM Plex Mono", monospace'; ctx.fillStyle = tok.faint;
          var gname = dead ? 'FALLEN' : (g0.inOffice === false ? 'No governor' : (g0.name || env.govLabel(g0.type)));
          if (dead) ctx.fillStyle = tok.crit;
          ctx.fillText(fit(ctx, gname, bx0 - nx - 82), nx + 80, cy + 0.5);
        }
        var by = wide ? cy : ry + 19;
        ['welfare', 'trust', 'corruption'].forEach(function (id, k) {
          var v = dead ? 0 : metric01(n, id), bx = bx0 + k * (barW + gap);
          ctx.fillStyle = tok.line2; ctx.fillRect(bx, by - 2.5, barW, 5);
          if (v != null) { ctx.fillStyle = cols[k]; ctx.fillRect(bx, by - 2.5, Math.max(1, Math.round(barW * v)), 5); }
        });
      });
      ctx.restore();
      return [x, y, x + w, y + h];
    }
    function fit(ctx, text, maxW) {
      text = String(text);
      if (maxW <= 8) return '';
      if (ctx.measureText(text).width <= maxW) return text;
      while (text.length > 1 && ctx.measureText(text + '.').width > maxW) text = text.slice(0, -1);
      return text + '.';
    }
    function dialSpot(L, W, H, dpr, hudBox, toCss) {
      var r = W < 480 ? 20 : 24;
      var cands = [[W - r - 14, r + 16], [r + 14, H - 52], [W - r - 14, H - 64], [r + 14, r + 16]];
      var rects = [hudBox];
      for (var id in L.towns) { var t = L.towns[id], a = toCss(t.terr.x, t.terr.y - 30), b = toCss(t.terr.x + t.terr.w, t.terr.y + t.terr.h + 16); rects.push([a[0], a[1], b[0], b[1]]); }
      if (L.commons) { var c0 = toCss(L.commons.x, L.commons.y - 30), c1 = toCss(L.commons.x + L.commons.w, L.commons.y + L.commons.h + 12); rects.push([c0[0], c0[1], c1[0], c1[1]]); }
      var best = cands[0], bd = -Infinity;
      cands.forEach(function (c) {
        var d = Infinity;
        rects.forEach(function (q) {
          var dx = Math.max(q[0] - c[0], 0, c[0] - q[2]), dy = Math.max(q[1] - c[1], 0, c[1] - q[3]);
          d = Math.min(d, Math.hypot(dx, dy));
        });
        if (d > bd + 0.5) { bd = d; best = c; }
      });
      return { x: best[0], y: best[1], r: r };
    }

    return R;
  };
})();
