/* AI Nation: pixel world renderer.
 *
 * One big open field seen from above, like an RTS minimap come to life: every nation is a small town (a hall,
 * a ring of little houses or system buildings around a compact plaza, and one tall flag) on the same plain.
 * A nation's colour and flag emblem follow its economic system (engine SYSTEM_IDENTITY): blue coin for the
 * free market, yellow rose for the safety net, amber star for public-owned firms, red hammer and sickle (or a
 * star with a gear, with "Neutral symbols") for state-run, green linked people for the co-op. Nations that
 * share a system get lighter or darker shades. Dirt roads join every town to the shared forest and lake in
 * the middle, which shrinks and dries as the commons stock falls. Emigrants walk the roads in a line, each
 * with a suitcase. A compact HUD sits in a reserved corner, and short action tags pop over a town.
 *
 * The art comes from a pre-built sprite atlas (assets/atlas.json + atlas.png), built by
 * tools/build-atlas.py from a licensed copy of LimeZu's pixel art, halved to suit the zoomed-out field.
 * Flags and emblems are drawn here in code. The repo ships no art: when the atlas cannot be fetched,
 * PixelMap.load() resolves null and ui.js keeps its vector map.
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
 *   renderer.cinematic(ev)                step the camera in on the event's town for a few seconds
 *   renderer.ping(nid), renderer.reset(), renderer.invalidate(), renderer.debug()
 *   PixelMap.TAGS, PixelMap.tagFor(ev)    event type -> short plain-words tag
 *   PixelMap.nationColor(nation, index)   the map colour of a nation ('#rrggbb'), shade included
 *   PixelMap.drawEmblem(ctx, emblem, x, y, size)   an emblem in CSS px (used by ui.js chips)
 *
 * Scaling: the field is drawn 1:1 into an offscreen canvas and copied to the screen at a whole-number
 * device-pixel scale with smoothing off. Never a fractional scale. The renderer reads engine state and
 * never changes it. All positions derive from ids and the stage size, so a world always lays out the same.
 */
(function () {
  'use strict';

  var TS = 8;                             // field cell in art px (the atlas art is the 16 px library art, halved)
  var TOWN_W = 128, TOWN_H = 96;          // town footprint in art px
  var TOWN_C = TOWN_W / TS, TOWN_R = TOWN_H / TS;
  var SKIRT = 8;                          // cliff below the plateau
  var KEYS = ['blue', 'yellow', 'orange', 'red', 'green'];
  var LEGACY = { gold: 'yellow', teal: 'blue', rose: 'red', violet: 'blue', moss: 'green' };
  var SYS_KEY = { free_market: 'blue', social_democracy: 'yellow', market_socialism: 'orange', central_planning: 'red', cooperative: 'green' };
  var SYS_EMB = { free_market: 'coin', social_democracy: 'rose', market_socialism: 'star', central_planning: 'hammer_sickle', cooperative: 'people' };
  // nation colours (the atlas overrides these with the exact values it recoloured the roofs to)
  var HSV = {
    blue: [213, 0.70, 0.92], yellow: [52, 0.74, 1.00], orange: [31, 0.94, 0.96], red: [356, 0.84, 0.80], green: [150, 0.70, 0.76],
    grey: [215, 0.08, 0.62]
  };
  KEYS.forEach(function (k) { var b = HSV[k]; HSV[k + '1'] = [b[0], b[1] * 0.55, Math.min(1, b[2] * 1.08 + 0.04)]; HSV[k + '2'] = [b[0], Math.min(1, b[1] * 1.04), b[2] * 0.62]; });

  // Emblems: drawn in code (never cut from any flag image). '.' is empty; other characters index `pal`.
  var EMB = {
    coin: { pal: { '#': '#f6c443', o: '#7a4d0c' }, rows: ['.....ooooo.....', '...ooo###ooo...', '..oo###o###oo..', '.oo###oooo##oo.', '.o###o#o#####o.', 'oo###o#o#####oo', 'o####o#o######o', 'o#####ooo#####o', 'o######o#o####o', 'oo#####o#o###oo', '.o#####o#o###o.', '.oo##oooo###oo.', '..oo###o###oo..', '...ooo###ooo...', '.....ooooo.....'] },
    rose: { pal: { r: '#d8323d', R: '#7c1020', g: '#2c8a3c' }, rows: ['.....rrrrr.....', '...rrRRrrRrr...', '..rrRrrRRrrRr..', '..rRrrRrrRrrr..', '..rRrRRrrrRrr..', '..rrRrrRRRrr...', '...rrRRrrrr....', '....rrrrrr.....', '.......g.......', '..ggg..g...gg..', '.gggg..g..gggg.', '..ggg..g.gggg..', '....gggggg.....', '.......g.......', '.......g.......'] },
    star: { pal: { '#': '#ffe46b' }, rows: ['.........#.........', '.........#.........', '..#......#......#..', '.###....###....###.', '..#.....###.....#..', '....###########....', '.....#########.....', '.......#####.......', '.......#####.......', '......#######......', '......##...##......', '......#.....#......'] },
    hammer_sickle: { pal: { '#': '#ffd84d' }, rows: ['...#.....##....', '..###.....##...', '.####......##..', '#####......##..', '.##.##......##.', '.....##.....##.', '......##....##.', '.......##..###.', '........#####..', '........####...', '....########...', '..##.##....##..', '.##.........##.', '##.............'] },
    star_gear: { pal: { '#': '#fff0c8', r: '#d22a33' }, rows: ['......###......', '..#...###...#..', '.###.#####.###.', '..#####r#####..', '...####r####...', '..#####r#####..', '###rrrrrrrrr###', '####rrrrrrr####', '######rrr######', '..###rrrrr###..', '...##r###r##...', '..###########..', '.###.#####.###.', '..#...###...#..', '......###......'] },
    people: { pal: { '#': '#fff6dc' }, rows: ['.###..###..###.', '.###..###..###.', '..#....#....#..', '###############', '.###..###..###.', '.###..###..###.', '.###..###..###.', '.###..###..###.', '.#.#..#.#..#.#.', '.#.#..#.#..#.#.', '.#.#..#.#..#.#.'] }
  };
  Object.keys(EMB).forEach(function (k) { var e = EMB[k]; e.w = e.rows[0].length; e.h = e.rows.length; });

  // HUD icons (7 px bitmaps, CSS px): one per bar, so the bars stay neutral grey and never read as a nation colour
  var ICON = {
    welfare: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
    trust: ['#######', '#######', '#.###.#', '.#####.', '.#####.', '..###..', '...#...'],
    corruption: ['#######', '##...##', '#.#.#.#', '#..#..#', '#.....#', '#######']
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
    var to = function (x) { var q = Math.round(clamp(x, 0, 1) * 255).toString(16); return q.length < 2 ? '0' + q : q; };
    return '#' + to(f(5)) + to(f(3)) + to(f(1));
  }
  function lum(hex) { var n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; }
  // a nation's base colour key: its engine colorKey (new keys, or an old index key mapped across), else its system
  function keyOf(n, i) {
    var k = n && n.colorKey;
    if (KEYS.indexOf(k) >= 0) return k;
    if (LEGACY[k]) return LEGACY[k];
    return (n && SYS_KEY[n.system]) || KEYS[((i || 0) % 5 + 5) % 5];
  }
  function shadeOf(n) { var s = n && Math.round(num(n.shade, 0)); return s === 1 || s === 2 ? s : 0; }
  function toneOf(n, i) { var s = shadeOf(n); return keyOf(n, i) + (s ? String(s) : ''); }
  function emblemOf(n) { return (n && EMB[n.emblem]) ? n.emblem : ((n && SYS_EMB[n.system]) || 'coin'); }
  var COLORS = {};
  function paint(key) {
    if (COLORS[key]) return COLORS[key];
    var p = HSV[key] || HSV.grey;
    var mid = hsv(p[0], p[1], p[2]);
    COLORS[key] = { mid: mid, dark: hsv(p[0], Math.min(1, p[1] * 1.05 + 0.05), p[2] * 0.55), light: hsv(p[0], p[1] * 0.45, Math.min(1, p[2] * 1.12)), ink: lum(mid) > 0.55 ? '#16120a' : '#fff8ea' };
    return COLORS[key];
  }
  // an emblem in CSS px on a 2d context, scaled to `size` (the longer side)
  function drawEmblemCss(ctx, emb, x, y, size) {
    var e = EMB[emb] || EMB.coin, px = size / Math.max(e.w, e.h), oy = (size - e.h * px) / 2, ox = (size - e.w * px) / 2;
    for (var r = 0; r < e.h; r++) for (var c = 0; c < e.w; c++) {
      var ch = e.rows[r].charAt(c);
      if (ch === '.') continue;
      ctx.fillStyle = e.pal[ch] || '#fff';
      ctx.fillRect(x + ox + c * px, y + oy + r * px, px + 0.05, px + 0.05);
    }
  }

  var PM = window.PixelMap = {};
  PM.TAGS = TAGS;
  PM.tagFor = tagFor;
  PM.nationColor = function (n, i) { return paint(toneOf(n, i)).mid; };
  PM.colorKeyOf = keyOf;
  PM.emblemOf = emblemOf;
  PM.EMBLEMS = EMB;
  PM.drawEmblem = drawEmblemCss;

  PM.load = function (base) {
    base = base || 'assets/';
    if (!window.fetch) return Promise.resolve(null);
    return fetch(base + 'atlas.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('no atlas');
      return r.json();
    }).then(function (json) {
      if (!json || !json.frames || json.tile !== TS || !json.frames['bld.hall.blue'] || !json.frames['bld.house.blue.a']) throw new Error('bad atlas');
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

  // ------------------------------------------------------------------ town plans (local art px, box 128 x 96)
  // A small hall at the back, little houses (or system buildings) in a ring around a compact plaza, low
  // market or state pieces by the gate at the front, and one tall flag in the plaza. y is the feet line.
  var CLASS_POOL = { worker: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'], owner: ['o1', 'o2', 'o3'], elite: ['e1', 'e2'] };
  var GOV_SPRITE = { aligned_ai: 'gai', human_persona: 'gper', human_player: 'gyou' };
  var RING = [['house.a', 20, 42], ['house.b', 108, 42], ['house.b', 15, 70], ['house.a', 113, 70]];
  var PLANS = {
    free_market: { ring: RING, front: [['bld.stall1', 30, 95], ['bld.cart', 99, 95], ['prop.atm', 44, 86]], rich: true },
    social_democracy: { ring: RING, front: [['bld.stall2', 30, 95], ['prop.bench', 98, 92], ['prop.treeS', 112, 95], ['prop.flowers1', 86, 94]] },
    market_socialism: { ring: RING, front: [['bld.stall3', 30, 95], ['prop.stand', 99, 95], ['prop.crates', 112, 94]] },
    central_planning: { ring: [['bld.block', 21, 44], ['bld.block', 107, 44], ['bld.depot', 14, 72], ['bld.depot', 114, 72]], front: [['bld.depot', 30, 95], ['prop.crates', 99, 94]], grey: true },
    cooperative: { ring: [['house.a', 20, 42], ['house.b', 108, 42], ['house.b', 15, 70], ['bld.barn', 114, 72]], front: [['prop.bed', 28, 94], ['prop.bed', 44, 94], ['prop.fruit', 99, 95], ['prop.bed', 113, 94]] }
  };
  var HALL_X = 64, HALL_Y = 44, FLAG = { x: 86, y: 76 }, GOV = { x: 79, y: 79 }, GATE_X = 64;

  // Field templates, in 8 px cells: towns T [c, r] (16 x 12 each, in nation order), shared forest C [c, r, w, h],
  // and where the HUD and the doomsday dial may go (corners tried in order; each must be clear of every town,
  // the forest and their labels). The field may be larger than the template: items keep their relative
  // position and the gaps grow. Landscape templates are sized so a town is about 128 CSS px on a laptop.
  var TPL = {
    land: {
      1: { w: 80, h: 40, T: [[20, 14]], C: [46, 14, 14, 12], hud: ['bl', 'tl', 'br'], dial: ['br', 'tr', 'tl'] },
      2: { w: 80, h: 40, T: [[8, 6], [56, 22]], C: [33, 14, 14, 12], hud: ['bl', 'tr'], dial: ['br', 'tl', 'tr'] },
      3: { w: 80, h: 40, T: [[7, 5], [59, 5], [40, 24]], C: [33, 4, 14, 12], hud: ['bl', 'br'], dial: ['br', 'tr', 'tl'] },
      4: { w: 88, h: 44, T: [[6, 4], [66, 4], [6, 28], [66, 28]], C: [37, 16, 14, 12], hud: ['tc', 'bc'], dial: ['bc', 'tc', 'bl'] },
      5: { w: 96, h: 50, T: [[5, 4], [40, 4], [75, 4], [12, 29], [68, 29]], C: [41, 18, 14, 12], hud: ['bc', 'bl', 'br'], dial: ['bl', 'br', 'tc'] }
    },
    port: {
      1: { w: 40, h: 46, T: [[12, 6]], C: [14, 28, 12, 12], hud: ['br', 'tr', 'bl'], dial: ['bl', 'tl'] },
      2: { w: 44, h: 52, T: [[3, 5], [25, 34]], C: [5, 22, 12, 12], hud: ['tr', 'br'], dial: ['bl', 'br'] },
      3: { w: 44, h: 58, T: [[2, 4], [26, 22], [14, 42]], C: [3, 22, 12, 12], hud: ['tr'], dial: ['br', 'bl'] },
      // 4 and 5: two columns of towns with the forest and lake as a narrow valley between them
      4: { w: 44, h: 55, T: [[1, 1], [1, 20], [27, 20], [14, 40]], C: [19, 17, 6, 20], hud: ['tr'], dial: ['tc', 'bl', 'br'] },
      5: { w: 44, h: 55, T: [[1, 1], [1, 20], [27, 20], [1, 40], [27, 40]], C: [19, 17, 6, 20], hud: ['tr'], dial: ['tc', 'bc'] }
    }
  };

  // tiny binary heap for the road search
  function Heap() { this.a = []; }
  Heap.prototype.push = function (x) { var a = this.a; a.push(x); var i = a.length - 1; while (i > 0) { var p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; var t = a[p]; a[p] = a[i]; a[i] = t; i = p; } };
  Heap.prototype.pop = function () {
    var a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; var i = 0; for (;;) { var l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; var t = a[m]; a[m] = a[i]; a[i] = t; i = m; } }
    return top;
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
    function roofKey(tone) { return A.frames['bld.house.' + tone + '.a'] ? tone : (A.frames['bld.house.' + tone.replace(/\d$/, '') + '.a'] ? tone.replace(/\d$/, '') : 'grey'); }

    var R = {
      L: null, towns: {}, agents: {}, fx: [], pings: [], crisis: {}, lastGov: {}, tags: {}, cine: null, depart: {},
      frame: null, fctx: null, layoutKey: '', lastNow: 0, ground: null, groundKey: '', comKey: '', comCanvas: null, sampleN: 3
    };

    // ---------------------------------------------------------------- HUD size (CSS px)
    function hudSize(n, mode) {
      // wide: one line per nation with governor name; mini: chip, name and three short bars on one line
      if (mode === 'wide') return { w: 272, h: 24 + n * 17 + 5, rowH: 17, head: 24, mode: 'wide' };
      return { w: 150, h: 31 + n * 16 + 5, rowH: 16, head: 31, mode: 'mini' };
    }
    function dialR(W) { return W < 480 ? 19 : 23; }

    // ---------------------------------------------------------------- layout
    function rectsHit(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }
    function cornerRect(code, w, h, F, pad) {
      var x, y;
      if (code.charAt(1) === 'l') x = F.x + pad; else if (code.charAt(1) === 'r') x = F.x + F.w - w - pad; else x = F.x + Math.round((F.w - w) / 2);
      y = code.charAt(0) === 't' ? F.y + pad : F.y + F.h - h - pad;
      return { x: x, y: y, w: w, h: h, code: code };
    }
    function mapItems(tpl, PC, PR) {
      // keep each item's centre at the same fraction of the field, in whole cells, at least 1 cell from the edge
      function at(c, r, w, h) {
        var fx = (c + w / 2) / tpl.w, fy = (r + h / 2) / tpl.h;
        return { c: clamp(Math.round(fx * PC - w / 2), 1, PC - w - 1), r: clamp(Math.round(fy * PR - h / 2), 1, PR - h - 1), w: w, h: h };
      }
      return { T: tpl.T.map(function (t) { return at(t[0], t[1], TOWN_C, TOWN_R); }), C: tpl.C ? at(tpl.C[0], tpl.C[1], tpl.C[2], tpl.C[3]) : null };
    }
    function obstacles(L) {
      var out = [];
      L.order.forEach(function (id) { var t = L.towns[id]; out.push({ x: t.x - 6, y: t.y - 8, w: TOWN_W + 12, h: TOWN_H + 22 }); });
      if (L.commons) out.push({ x: L.commons.x - 4, y: L.commons.y - 4, w: L.commons.w + 8, h: L.commons.h + 24 });
      return out;
    }

    function computeLayout(W, H, dpr, ns, focusId) {
      var devW = Math.round(W * dpr), devH = Math.round(H * dpr), n = Math.max(1, Math.min(5, ns.length));
      var story = !!focusId, wantPort = story || W / H < 1.05;
      var orients = story ? ['port'] : wantPort ? ['port', 'land'] : ['land', 'port'];
      var pick = null;
      R.attempts = [];
      for (var s = 10; s >= 1 && !pick; s--) {
        var fw = Math.floor(devW / s), fh = Math.floor(devH / s);
        var PCmax = Math.floor((fw - 4) / TS), PRmax = Math.floor((fh - 4 - SKIRT) / TS);
        for (var oi = 0; oi < orients.length && !pick; oi++) {
          var tpl = TPL[orients[oi]][n];
          // above 1 art px per device px, a landscape field only zooms in when it keeps some spare ground
          var room = orients[oi] === 'land' && s > 1 ? 1.12 : 1;
          if (tpl.w * room > PCmax || tpl.h > PRmax) continue;
          var L = build(tpl, orients[oi], s, fw, fh, PCmax, PRmax, ns, devW, devH, dpr);
          var modes = orients[oi] === 'land' ? ['wide', 'mini'] : ['mini'];
          for (var mi = 0; mi < modes.length && !pick; mi++) {
            var hud = hudSize(n, modes[mi]);
            var spot = findSpot(L, tpl.hud, Math.ceil(hud.w * dpr / s), Math.ceil(hud.h * dpr / s), obstacles(L));
            R.attempts.push([s, orients[oi], modes[mi], L.PC, L.PR, !!spot]);
            if (spot) { L.hud = hud; L.hudCell = spot; pick = L; }
          }
        }
      }
      var mode = 'field';
      if (!pick) {
        // too small for the whole field even at 1 device px per art px: a camera pans between towns
        var o = wantPort ? 'port' : 'land', tp = TPL[o][n];
        pick = build(tp, o, 1, Math.max(devW, tp.w * TS + 4), Math.max(devH, tp.h * TS + SKIRT + 4), tp.w, tp.h, ns, devW, devH, dpr);
        pick.hud = hudSize(n, 'mini'); pick.hudOverlay = true;
        mode = 'pan';
      }
      pick.mode = mode; pick.story = story; pick.focus = focusId;
      var hc = pick.hudCell;
      var dr = dialR(W), dw = Math.ceil((dr * 2 + 14) * dpr / pick.s), dh = Math.ceil((dr + 40) * dpr / pick.s);
      pick.dialCell = findSpot(pick, TPL[pick.orient][n].dial.concat(['br', 'bl', 'tr', 'tl']), dw, dh, obstacles(pick).concat(hc ? [{ x: hc.x - 4, y: hc.y - 4, w: hc.w + 8, h: hc.h + 8 }] : []));
      buildNetwork(pick);
      return pick;
    }
    function findSpot(L, codes, w, h, obs) {
      var F = { x: L.px0, y: L.py0, w: L.PC * TS, h: L.PR * TS };
      if (w > F.w - 4 || h > F.h - 4) return null;
      for (var i = 0; i < codes.length; i++) {
        var r = cornerRect(codes[i], w, h, F, 3), ok = true;
        for (var k = 0; k < obs.length && ok; k++) if (rectsHit(r, obs[k])) ok = false;
        if (ok) return r;
      }
      return null;
    }
    function build(tpl, orient, s, fw, fh, PCmax, PRmax, ns, devW, devH, dpr) {
      // grow the field past the template (more open grass), but keep some water around a very wide stage
      var PC = Math.min(PCmax, Math.max(tpl.w, Math.round(tpl.w * 1.4))), PR = Math.min(PRmax, Math.max(tpl.h, Math.round(tpl.h * 1.3)));
      var L = { s: s, w: fw, h: fh, orient: orient, PC: PC, PR: PR, devW: devW, devH: devH, dpr: dpr, towns: {}, order: [], tpl: tpl };
      L.px0 = Math.floor((L.w - PC * TS) / 2);
      L.py0 = Math.floor((L.h - PR * TS - SKIRT) / 2);
      var it = mapItems(tpl, PC, PR);
      ns.slice(0, 5).forEach(function (nn, i) {
        var q = it.T[i];
        if (!q) return;
        L.towns[nn.id] = { c: q.c, r: q.r, x: L.px0 + q.c * TS, y: L.py0 + q.r * TS, i: i };
        L.order.push(nn.id);
      });
      if (it.C) L.commons = { c: it.C.c, r: it.C.r, cw: it.C.w, ch: it.C.h, x: L.px0 + it.C.c * TS, y: L.py0 + it.C.r * TS, w: it.C.w * TS, h: it.C.h * TS };
      L.ox = Math.round((devW - L.w * L.s) / 2);
      L.oy = Math.round((devH - L.h * L.s) / 2);
      return L;
    }

    // ---------------------------------------------------------------- roads, territories, decor
    function cellKey(c, r) { return c + ',' + r; }
    function buildNetwork(L) {
      var PC = L.PC, PR = L.PR, block = {}, cost = {};
      function inside(c, r) { return c >= 0 && r >= 0 && c < PC && r < PR; }
      L.order.forEach(function (id) {
        var t = L.towns[id];
        for (var c = t.c - 1; c <= t.c + TOWN_C; c++) for (var r = t.r - 1; r <= t.r + TOWN_R; r++) block[cellKey(c, r)] = 1;
        t.gate = { c: t.c + GATE_X / TS - 1, r: t.r + TOWN_R + 1 };
        // the gate opens through the bottom margin
        delete block[cellKey(t.gate.c, t.gate.r - 1)]; delete block[cellKey(t.gate.c + 1, t.gate.r - 1)];
      });
      var C = L.commons, hub;
      if (C) {
        for (var c0 = C.c - 1; c0 <= C.c + C.cw; c0++) for (var r0 = C.r - 1; r0 <= C.r + C.ch; r0++) block[cellKey(c0, r0)] = 2;
        hub = { c0: C.c - 3, r0: C.r - 3, c1: C.c + C.cw + 1, r1: C.r + C.ch + 1 };
      } else hub = { c0: Math.floor(PC / 2) - 2, r0: Math.floor(PR / 2) - 2, c1: Math.floor(PC / 2) + 1, r1: Math.floor(PR / 2) + 1 };
      if (L.hudCell) {
        var H = L.hudCell;
        for (var hc = Math.floor((H.x - L.px0) / TS) - 1; hc <= Math.ceil((H.x + H.w - L.px0) / TS); hc++) for (var hr = Math.floor((H.y - L.py0) / TS) - 1; hr <= Math.ceil((H.y + H.h - L.py0) / TS); hr++) cost[cellKey(hc, hr)] = 8;
      }
      // the ring road: two cells wide, around the forest
      var roads = {};
      function free2(c, r) { return inside(c, r) && inside(c + 1, r + 1) && !block[cellKey(c, r)] && !block[cellKey(c + 1, r)] && !block[cellKey(c, r + 1)] && !block[cellKey(c + 1, r + 1)]; }
      function paintRoad(c, r) { roads[cellKey(c, r)] = 1; roads[cellKey(c + 1, r)] = 1; roads[cellKey(c, r + 1)] = 1; roads[cellKey(c + 1, r + 1)] = 1; }
      var ring = {};
      for (var c = hub.c0; c <= hub.c1; c++) for (var r = hub.r0; r <= hub.r1; r++) {
        if (!(c === hub.c0 || c === hub.c1 || r === hub.r0 || r === hub.r1)) continue;
        if (free2(c, r)) { ring[cellKey(c, r)] = 1; paintRoad(c, r); }
      }
      L.routes = {};
      L.order.forEach(function (id) {
        // Dijkstra from the gate to the ring (or an earlier road), with a turn penalty so roads run straight
        var t = L.towns[id], start = cellKey(t.gate.c, t.gate.r), dist = {}, prev = {}, heap = new Heap(), found = null, guard = 0;
        dist[start] = 0; heap.push([0, t.gate.c, t.gate.r, -1]);
        var trunk = {};
        for (var k0 in L.routes) L.routes[k0].forEach(function (q) { trunk[q] = 1; });
        while (heap.a.length && guard++ < 60000) {
          var cur = heap.pop(), cc = cur[1], cr = cur[2], key = cellKey(cc, cr);
          if (cur[0] > dist[key]) continue;
          if (ring[key] || (key !== start && trunk[key])) { found = key; break; }
          var dirs = [[0, 1], [1, 0], [-1, 0], [0, -1]];
          for (var d = 0; d < 4; d++) {
            var nc = cc + dirs[d][0], nr = cr + dirs[d][1], nk = cellKey(nc, nr);
            if (!free2(nc, nr)) continue;
            var nd = cur[0] + 1 + (cost[nk] || 0) + (cur[3] >= 0 && cur[3] !== d ? 1.5 : 0) + (nr <= 1 || nr >= PR - 3 || nc <= 1 || nc >= PC - 3 ? 2 : 0);
            if (dist[nk] == null || nd < dist[nk]) { dist[nk] = nd; prev[nk] = key; heap.push([nd, nc, nr, d]); }
          }
        }
        var path = [];
        if (found) { var p = found; while (p) { path.unshift(p); p = prev[p]; } }
        path.forEach(function (q) { var a = q.split(','); paintRoad(+a[0], +a[1]); });
        L.routes[id] = path;
      });
      // the gate mouth up to the plaza
      L.order.forEach(function (id) { var t = L.towns[id]; paintRoad(t.gate.c, t.gate.r - 1); });
      L.roads = roads;
      L.ring = ring;
      L.block = block;
      // territory boxes (world px) and a checkpoint hut where each road leaves its territory
      L.order.forEach(function (id) {
        var t = L.towns[id];
        t.terr = { x: t.x - 6, y: t.y - 6, w: TOWN_W + 12, h: TOWN_H + 14 };
        var route = L.routes[id] || [];
        for (var k = 1; k < route.length; k++) {
          var q = route[k].split(','), qc = +q[0], qr = +q[1], wx = L.px0 + qc * TS + TS, wy = L.py0 + qr * TS + TS;
          if (wx < t.terr.x || wx > t.terr.x + t.terr.w || wy < t.terr.y || wy > t.terr.y + t.terr.h) {
            t.post = { x: wx + 14, y: wy + 6 };
            break;
          }
        }
      });
      // open-ground decor: sparse trees and bushes, never on roads or right against a town
      var rnd = mulberry(hash('decor:' + PC + 'x' + PR + ':' + L.order.join(','))), decor = [], taken = {};
      function near(c, r, dd) {
        for (var a = -dd; a <= dd; a++) for (var b = -dd; b <= dd; b++) { var kk = cellKey(c + a, r + b); if (block[kk] || roads[kk] || cost[kk]) return true; }
        return false;
      }
      var kinds = ['prop.treeS', 'prop.pine', 'prop.treeR', 'prop.treeS', 'prop.shrub', 'prop.fbush', 'prop.flowers2', 'prop.tree1', 'prop.pine', 'prop.fbush'];
      for (r = 3; r < PR - 1; r++) for (c = 1; c < PC - 2; c++) {
        if (rnd() > 0.016) continue;
        var kind = kinds[Math.floor(rnd() * kinds.length)];
        var tall = /tree|pine/.test(kind);
        if (near(c, r, 1) || (tall && (near(c, r - 2, 1) || near(c, r - 3, 0)))) continue;
        var clash = false;
        for (var a2 = -3; a2 <= 3 && !clash; a2++) for (var b2 = -3; b2 <= 1 && !clash; b2++) if (taken[cellKey(c + a2, r + b2)]) clash = true;
        if (clash) continue;
        taken[cellKey(c, r)] = 1;
        decor.push({ spr: kind, x: L.px0 + c * TS + 4 + Math.round((rnd() - 0.5) * 4), y: L.py0 + r * TS + 7 });
      }
      L.decor = decor;
      // forest trees: a jittered ring around the lake, dying in a fixed order as the stock falls
      L.forest = [];
      if (C) {
        var fr2 = mulberry(hash('forest:' + C.cw + 'x' + C.ch));
        for (var fy = 14; fy <= C.h; fy += 12) for (var fx = 8; fx <= C.w - 8; fx += 14) {
          var dx = (fx - C.w / 2) / (C.w * 0.3), dy = (fy - C.h / 2 - 4) / (C.h * 0.27);
          if (dx * dx + dy * dy < 1) continue;
          L.forest.push({ x: C.x + fx + Math.round((fr2() - 0.5) * 6), y: C.y + fy + Math.round((fr2() - 0.5) * 4), k: fr2() });
        }
      }
      L.gateW = {};
      L.order.forEach(function (id) { var t = L.towns[id]; L.gateW[id] = { x: t.x + GATE_X, y: t.y + TOWN_H + 4 }; });
      L.pathCache = {};
    }
    // road path (world px points, road centre line) between two towns' gates, or null
    function roadPath(L, a, b) {
      var key = a + '>' + b;
      if (L.pathCache[key] !== undefined) return L.pathCache[key];
      var ta = L.towns[a], tb = L.towns[b];
      if (!ta || !tb) return (L.pathCache[key] = null);
      var s = cellKey(ta.gate.c, ta.gate.r), goal = cellKey(tb.gate.c, tb.gate.r), prev = {}, q = [s], seen = {}, qi = 0;
      seen[s] = 1;
      // walk the road centre: the top-left cell of each 2 x 2 road block
      var ok = function (k) { if (k === goal) return true; var p = k.split(','), c = +p[0], r = +p[1]; return L.roads[k] && L.roads[cellKey(c + 1, r)] && L.roads[cellKey(c, r + 1)] && L.roads[cellKey(c + 1, r + 1)]; };
      while (qi < q.length) {
        var k = q[qi++];
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
      var pts = cells.map(function (k2) { var p2 = k2.split(','); return { x: L.px0 + (+p2[0]) * TS + TS, y: L.py0 + (+p2[1]) * TS + TS }; });
      var out = [pts[0]];
      for (var i = 1; i < pts.length - 1; i++) {
        var A0 = out[out.length - 1], B0 = pts[i], C0 = pts[i + 1];
        if (!((A0.x === B0.x && B0.x === C0.x) || (A0.y === B0.y && B0.y === C0.y))) out.push(B0);
      }
      if (pts.length > 1) out.push(pts[pts.length - 1]);
      return (L.pathCache[key] = out);
    }
    function polyLen(pts) { var l = 0; for (var i = 1; i < pts.length; i++) l += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y); return l; }
    function polyAt(pts, d) {
      for (var i = 1; i < pts.length; i++) {
        var seg = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
        if (d <= seg || i === pts.length - 1) { var f = seg ? clamp(d / seg, 0, 1) : 0; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f }; }
        d -= seg;
      }
      return pts[0];
    }

    // ---------------------------------------------------------------- town construction
    function buildTown(n, idx) {
      var sys = PLANS[n.system] ? n.system : 'social_democracy', plan = PLANS[sys], tone = roofKey(toneOf(n, idx));
      var T = { id: n.id, sys: sys, tone: tone, items: [], homes: [], works: [], idx: idx };
      T.items.push({ spr: 'bld.hall.' + tone, x: HALL_X, y: HALL_Y });
      plan.ring.concat(plan.front).forEach(function (b) {
        var name = b[0];
        if (/^house\./.test(name)) name = 'bld.house.' + tone + '.' + name.split('.')[1];
        else if (name === 'bld.block' || name === 'bld.barn') name = name + '.' + tone;
        T.items.push({ spr: name, x: b[1], y: b[2] });
        if (/^bld\.(house|block)/.test(name)) T.homes.push({ x: b[1] + (/block/.test(name) ? 0 : 5), y: b[2] + 1 });
        else if (/^bld\./.test(name)) T.works.push({ x: b[1] < 64 ? b[1] + 10 : b[1] - 10, y: Math.min(90, b[2] + 1) });
      });
      if (!T.homes.length) T.homes.push({ x: 24, y: 48 });
      T.works.push({ x: HALL_X, y: HALL_Y + 1 });
      T.plaza = { x0: 36, y0: 50, x1: 92, y1: 86 };
      T.protest = { x0: 46, y0: 49, x1: 82, y1: 62 };
      T.wealth = { x0: 92, y0: 76, x1: 104, y1: 86 };
      T.rich = !!plan.rich;
      return T;
    }

    // ---------------------------------------------------------------- terrain drawing
    function autotile(g, cells, block, ox, oy) {
      var f = fr(block), h = TS / 2;
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
          g.drawImage(IMG, f[0] + tc * TS + qx * h, f[1] + tr * TS + qy * h, h, h, ox + c * TS + qx * h, oy + r * TS + qy * h, h, h);
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
          g.drawImage(IMG, f[0] + sc * TS, f[1] + sr * TS, TS, TS, ox + c * TS, oy + r * TS, TS, TS);
        }
      }
    }
    // static ground: plateau, territory tints, roads, plazas. Re-rendered when a town falls or recolours.
    function renderGround(L, ns) {
      var c = canvas(L.w, L.h), g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      plateau(g, L.px0, L.py0, L.PC, L.PR);
      ns.forEach(function (n, i) {
        var t = L.towns[n.id];
        if (!t) return;
        var dead = n.alive === false, col = dead ? paint('grey') : paint(toneOf(n, i)), q = t.terr;
        g.globalAlpha = dead ? 0.28 : 0.24;
        g.fillStyle = dead ? '#3a3a40' : col.mid;
        g.fillRect(q.x, q.y, q.w, q.h);
        g.globalAlpha = dead ? 0.5 : 0.95;
        g.fillStyle = dead ? '#6b6b72' : col.dark;
        for (var x = q.x; x < q.x + q.w; x += 4) { g.fillRect(x, q.y, 2, 1); g.fillRect(x, q.y + q.h - 1, 2, 1); }
        for (var y = q.y; y < q.y + q.h; y += 4) { g.fillRect(q.x, y, 1, 2); g.fillRect(q.x + q.w - 1, y, 1, 2); }
        g.globalAlpha = 1;
      });
      autotile(g, L.roads, 'ter.dirt', L.px0, L.py0);
      // plazas: paving from the hall to the gate, trimmed in the nation colour
      var hb = fr('ter.herring');
      ns.forEach(function (n, i) {
        var t = L.towns[n.id];
        if (!t || !hb) return;
        var x0 = t.x + 32, y0 = t.y + 46, x1 = t.x + 96, y1 = t.y + 90, tw = hb[2];
        for (var yy = y0; yy < y1; yy += tw) for (var xx = x0; xx < x1; xx += tw) {
          var w = Math.min(tw, x1 - xx), h = Math.min(tw, y1 - yy);
          g.drawImage(IMG, hb[0], hb[1], w, h, xx, yy, w, h);
        }
        var gx = t.x + GATE_X - 8;
        g.drawImage(IMG, hb[0], hb[1], 16, Math.min(tw, 8), gx, y1, 16, Math.min(tw, 8));
        var col = n.alive === false ? paint('grey') : paint(toneOf(n, i));
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
      var pond = {}, mud = {}, cx = C.cw / 2, cy = C.ch / 2 + 0.5, sx = C.cw / C.ch * 1.1;
      var rad = 0.9 + ratio * 2.9, full = 3.9;
      for (var cc = 1; cc < C.cw - 1; cc++) for (var r = 1; r < C.ch - 1; r++) {
        var dx = (cc + 0.5 - cx) / sx, dy = (r + 0.5 - cy), d = Math.sqrt(dx * dx + dy * dy);
        if (d <= rad) pond[cc + ',' + r] = 1;
        else if (d <= full) mud[cc + ',' + r] = 1;
      }
      if (ratio > 0.03 && !Object.keys(pond).length) { pond[Math.floor(cx - 1) + ',' + Math.floor(cy)] = 1; pond[Math.floor(cx) + ',' + Math.floor(cy)] = 1; }
      if (ratio < 0.97) autotile(g, mud, 'ter.dirt', 0, 0);
      autotile(g, pond, 'ter.pond', 0, 0);
      return c;
    }

    // ---------------------------------------------------------------- agents
    // At this zoom one sprite stands for R.sampleN citizens (picked by id, so a protest or an exodus still
    // shows a proportional crowd). Followers are always drawn.
    function sampled(c) { return c.isFollower || R.sampleN <= 1 || hash('s:' + c.id) % R.sampleN === 0; }
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
      var sp = (c && num(c.mood, 0.6) < 0.3) ? 7 : 11;
      if (ag.role === 'protest') sp = 13;
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
          if (!sampled(c)) return;
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

    // Emigrants leave one at a time, about a second apart, so a group reads as a line of walkers on the road.
    // While waiting for their turn they stay indoors (packing), never bunched at the gate.
    var MAX_TRAVEL = 30, DEPART_GAP = 0.85, MAX_QUEUE = 14;
    R.moves = 0;
    R.onMove = function (cid, from, to) {
      R.moves++;
      if (env.reduced() || !R.L) return;
      var ag = R.agents[cid], L = R.L;
      if (!L.towns[from]) return;
      if (!ag) {
        // every emigrant walks, even one not drawn in town: an exodus shows its full size on the road
        var c0 = null, Tf = townOf(from);
        natList().forEach(function (n) { (n.citizens || []).forEach(function (c) { if (c.id === cid) c0 = c; }); });
        if (!Tf) return;
        ag = ensureAgent(c0 || { id: cid, cls: 'worker' }, { id: from });
        ag.transient = true; ag.role = 'idle';
        var sp0 = toWorld(from, rndIn(Tf.plaza, ag.rnd)); ag.x = sp0.x; ag.y = sp0.y; ag.placed = true;
      }
      if (ag.travel) return;
      var busy = 0;
      for (var k in R.agents) if (R.agents[k].travel) busy++;
      var now = performance.now() / 1000, slot = Math.max(now, R.depart[from] || 0);
      if (busy >= MAX_TRAVEL || slot - now > MAX_QUEUE * DEPART_GAP) { if (to && L.towns[to]) { ag.nid = to; ag.placed = false; } return; }
      R.depart[from] = slot + DEPART_GAP;
      ag.inside = false; ag.enter = false;
      ag.wait = slot - now;
      var gate = L.gateW[from];
      var lane = (hash(cid) % 3) - 1;
      var path = [{ x: gate.x + lane, y: gate.y - 14 }, { x: gate.x, y: gate.y }];
      if (to && L.towns[to]) {
        var road = roadPath(L, from, to), g2 = L.gateW[to];
        if (road) road.forEach(function (p) { path.push({ x: p.x + lane, y: p.y + lane }); });
        else path.push({ x: g2.x, y: g2.y });
        path.push({ x: g2.x + lane, y: g2.y - 12 });
        var T2 = townOf(to);
        if (T2) path.push(toWorld(to, rndIn(T2.plaza, ag.rnd)));
        ag.travel = { from: from, to: to };
      } else {
        // leaving the map: down the road off the cliff and away
        var ex = gate.x, ey = L.py0 + L.PR * TS + SKIRT + 16;
        path.push({ x: ex + lane, y: Math.min(ey, gate.y + 30) }, { x: ex + lane, y: ey });
        ag.travel = { from: from, to: null };
      }
      ag.path = path;
    };
    function stepTravel(ag, dt) {
      if (ag.wait > 0) { ag.wait -= dt; ag.moving = false; return; }
      if (!ag.path.length) {
        var tr = ag.travel;
        delete ag.travel;
        if (!tr.to || !R.L.towns[tr.to] || ag.transient) { delete R.agents[ag.cid]; return; }
        ag.nid = tr.to; ag.role = ''; ag.wait = 0.5; ag.placed = true;
        return;
      }
      var p = ag.path[0], dx = p.x - ag.x, dy = p.y - ag.y, d = Math.hypot(dx, dy), sp = 40;
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
      if (prev && now - prev.t0 < 1400 && prev.sev > sev) return;   // a quiet tag does not cut short a louder one
      R.tags[where] = { text: tag, t0: now, sev: sev };
    };
    R.ping = function (nid) {
      var now = performance.now();
      if (R.pings.some(function (p) { return p.nid === nid && now - p.t0 < 1800; })) return;
      R.pings.push({ nid: nid, t0: now });
      if (R.pings.length > 5) R.pings.shift();
    };
    // camera: step in to a close whole-number zoom on the event's town, hold, step back to the whole field
    var CINE_IN = 700, CINE_HOLD = 3800, CINE_OUT = 800;
    R.cinematic = function (ev) {
      if (!ev || env.reduced() || !R.L || R.L.mode !== 'field') return;
      var nid = ev.type === 'nuclear_strike' ? ((ev.data && ev.data.targetId) || ev.nationId) : ev.nationId;
      if (!nid || !R.L.towns[nid]) return;
      var now = performance.now();
      if (R.cine && now - R.cine.t0 < CINE_IN + CINE_HOLD * 0.5) return;  // do not yank between towns
      R.cine = { nid: nid, t0: now };
    };
    R.reset = function () { R.agents = {}; R.fx = []; R.pings = []; R.crisis = {}; R.lastGov = {}; R.tags = {}; R.cine = null; R.depart = {}; R.layoutKey = ''; R.L = null; R.groundKey = ''; R.comKey = ''; };
    R.invalidate = function () { R.layoutKey = ''; };

    // ---------------------------------------------------------------- drawing
    function ensureLayout(W, H, dpr) {
      var ns = natList();
      var focus = (env.focus && env.focus()) || '';
      var key = [W, H, dpr, ns.map(function (n, i) { return n.id + ':' + n.system + ':' + toneOf(n, i); }).join(','), focus ? 'story' : ''].join('|');
      if (key === R.layoutKey && R.L) return R.L;
      R.layoutKey = key;
      R.L = computeLayout(W, H, dpr, ns, focus);
      var cfg = env.config && env.config(), pops = ((cfg && cfg.nations) || ns).map(function (x) { return num(x.population, x.initialPopulation || 60); });
      var avg = pops.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, pops.length);
      R.sampleN = Math.max(1, Math.round(avg / 16));
      var towns = {};
      ns.forEach(function (n, i) {
        var prev = R.towns[n.id];
        towns[n.id] = prev && prev.sys === (PLANS[n.system] ? n.system : 'social_democracy') && prev.tone === roofKey(toneOf(n, i)) ? prev : buildTown(n, i);
      });
      R.towns = towns;
      R.frame = canvas(R.L.w, R.L.h);
      R.fctx = R.frame.getContext('2d');
      R.fctx.imageSmoothingEnabled = false;
      R.groundKey = ''; R.comKey = ''; R.ripples = null; R.cine = null; R.depart = {};
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

    // The flag is each town's hero identifier: a tall pole, cloth in the nation colour, the emblem big and
    // outlined so it reads at a glance. It ripples. Down and grey when the town has fallen.
    var POLE = 64;
    function drawFlag(g, x, y, tone, emb, now, still, dead) {
      var top = y - POLE;
      g.fillStyle = '#2f3440'; g.fillRect(x - 1, top, 3, POLE);
      g.fillStyle = '#cfd4de'; g.fillRect(x, top, 1, POLE - 1);
      g.fillStyle = '#f0c95a'; g.fillRect(x - 1, top - 3, 3, 3);
      g.fillStyle = '#262a33'; g.fillRect(x - 4, y - 1, 9, 2);
      if (dead) {
        g.fillStyle = '#55575e'; g.fillRect(x + 2, y - 18, 6, 16);
        g.fillStyle = '#7a7c84'; g.fillRect(x + 2, y - 18, 6, 1);
        return;
      }
      var e = EMB[emb] || EMB.coin, col = paint(tone), base = tone.replace(/\d$/, '');
      var cw = e.w + 8, ch = e.h + 6, cx = x + 2, cy = top + 1, t = still ? 0 : now / 1000;
      var ex0 = Math.floor((cw - e.w) / 2), ey0 = Math.floor((ch - e.h) / 2);
      var trim = base === 'orange' ? '#ffd650' : null;
      for (var c = 0; c < cw; c++) {
        var off = Math.round(Math.sin(t * 4.5 - c * 0.42) * (c / cw) * 1.6);
        // a near-black edge keeps the cloth apart from roofs of the same colour behind it
        g.fillStyle = '#141821'; g.fillRect(cx + c, cy + off - 1, 1, ch + 2);
        g.fillStyle = col.dark; g.fillRect(cx + c, cy + off, 1, ch);
        g.fillStyle = col.mid; g.fillRect(cx + c, cy + off + 1, 1, ch - 2);
        if (c === cw - 1) { g.fillStyle = '#141821'; g.fillRect(cx + cw, cy + off - 1, 1, ch + 2); }
        if (trim) { g.fillStyle = trim; g.fillRect(cx + c, cy + off + 1, 1, 1); g.fillRect(cx + c, cy + off + ch - 2, 1, 1); }
        // emblem, column by column so it ripples with the cloth; a dark outline keeps it readable on any shade
        var bc = c - ex0;
        for (var r = -1; r <= e.h; r++) {
          var here = bc >= 0 && bc < e.w && r >= 0 && r < e.h ? e.rows[r].charAt(bc) : '.';
          if (here !== '.') { g.fillStyle = e.pal[here] || '#fff'; g.fillRect(cx + c, cy + off + ey0 + r, 1, 1); continue; }
          var nb = false;
          for (var q = 0; q < 4 && !nb; q++) {
            var cc = bc + [1, -1, 0, 0][q], rr2 = r + [0, 0, 1, -1][q];
            if (cc >= 0 && cc < e.w && rr2 >= 0 && rr2 < e.h && e.rows[rr2].charAt(cc) !== '.') nb = true;
          }
          if (nb && r >= -1 && ey0 + r >= 1 && ey0 + r < ch - 1) { g.fillStyle = col.dark; g.fillRect(cx + c, cy + off + ey0 + r, 1, 1); }
        }
      }
    }
    // two short banners on the hall facade, in the nation colour
    function drawBanners(g, x, y, tone, dead) {
      var col = dead ? paint('grey') : paint(tone);
      [x - 17, x + 13].forEach(function (bx) {
        g.fillStyle = col.dark; g.fillRect(bx, y, 5, 9); g.fillRect(bx + 1, y + 9, 1, 1); g.fillRect(bx + 3, y + 9, 1, 1);
        g.fillStyle = col.mid; g.fillRect(bx + 1, y + 1, 3, 8);
      });
    }
    // protest placard held above the head, bobbing
    function drawPlacard(g, x, y, ph, now, still) {
      var bob = still ? 0 : (Math.sin(now / 180 + ph * 9) > 0 ? 1 : 0), px = Math.round(x + (ph < 0.5 ? -4 : 1)), py = Math.round(y - 22 - bob);
      g.fillStyle = '#5a3d26'; g.fillRect(px + 2, py + 4, 1, 6);
      g.fillStyle = '#2b2622'; g.fillRect(px, py, 6, 5);
      g.fillStyle = '#f3ead6'; g.fillRect(px + 1, py + 1, 4, 3);
      g.fillStyle = '#d24b45'; g.fillRect(px + 1, py + 2, 4, 1);
    }
    // little suitcase in an emigrant's hand
    function drawCase(g, x, y, dir) {
      var sx = Math.round(x + (dir === 'left' ? -6 : dir === 'right' ? 3 : 3)), sy = Math.round(y - 6);
      g.fillStyle = '#3b2a20'; g.fillRect(sx, sy, 4, 4);
      g.fillStyle = '#b07a44'; g.fillRect(sx + 1, sy + 1, 2, 2);
      g.fillStyle = '#3b2a20'; g.fillRect(sx + 1, sy - 1, 2, 1);
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
      var gk = s.nations.map(function (n, i) { return (n.alive === false ? 0 : 1) + toneOf(n, i); }).join('');
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
      g.fillRect(L.px0 + 4, L.py0 + 6, L.PC * TS, L.PR * TS + SKIRT - 2);
      g.drawImage(R.ground, 0, 0);
      if (showCom) g.drawImage(R.comCanvas, L.commons.x, L.commons.y);

      var tensions = drawTension(g, L, s, now, still);

      var list = [];
      function push(y, f, top) { list.push({ y: y, f: f, top: top }); }
      L.decor.forEach(function (d) { push(d.y, function () { spr(g, d.spr, d.x, d.y); }); });
      if (showCom) {
        var N = L.forest.length, alive = Math.round(comRatio * N + 0.25);
        var order = L.forest.map(function (p, i) { return { p: p, i: i }; }).sort(function (a, b) { return a.p.k - b.p.k; });
        order.forEach(function (o, rank) {
          var kind = rank < alive ? ['prop.tree1', 'prop.tree2', 'prop.treeR', 'prop.tree3', 'prop.pine'][o.i % 5] : (comRatio < 0.35 && o.i % 3 === 0 ? 'prop.dead' : (o.i % 2 ? 'prop.stump' : 'prop.stumpS'));
          push(o.p.y, function () { spr(g, kind, o.p.x, o.p.y); });
        });
      }
      // towns
      s.nations.forEach(function (n, i) {
        var T = R.towns[n.id], P = L.towns[n.id];
        if (!T || !P) return;
        var dead = n.alive === false, img = dead ? greyImg() : IMG, m = n.metrics || {}, tone = toneOf(n, i);
        T.items.forEach(function (it) { push(P.y + it.y, function () { spr(g, it.spr, P.x + it.x, P.y + it.y, img); }); });
        push(P.y + HALL_Y + 0.5, function () { drawBanners(g, P.x + HALL_X, P.y + HALL_Y - 26, tone, dead); });
        if (P.post) push(P.post.y, function () { spr(g, 'bld.hut', P.post.x, P.post.y, img); });
        if (num(m.shortage, 0) > 15 && !dead) {
          [[44, 88], [78, 84], [58, 70], [40, 60]].forEach(function (p) { push(P.y + p[1], function () { spr(g, 'prop.litter', P.x + p[0], P.y + p[1]); }); });
        }
        push(P.y + FLAG.y, function () { drawFlag(g, P.x + FLAG.x, P.y + FLAG.y, tone, emblemOf(n), now + i * 300, still, dead); });
        if (dead) {
          [[20, 44], [64, 46], [108, 44], [15, 72], [113, 72], [30, 96], [99, 96]].forEach(function (p, k) {
            push(P.y + p[1] + 1, function () { spr(g, still ? A.anims['fx.fire'].frames[0] : animFrame('fx.fire', now, k * 0.37), P.x + p[0], P.y + p[1]); });
          });
          return;
        }
        var gov = n.governor || {};
        if (gov.inOffice !== false) {
          var gk2 = GOV_SPRITE[gov.type] || 'gper', gx = P.x + GOV.x, gy = P.y + GOV.y;
          push(gy, function () {
            spr(g, still ? 'ch.' + gk2 + '.idle.down#0' : animFrame('ch.' + gk2 + '.idle.down', now), gx, gy);
            if (gov.type === 'human_player') { g.fillStyle = '#ffd25e'; g.fillRect(gx - 2, gy - 18, 5, 1); g.fillRect(gx - 2, gy - 19, 1, 1); g.fillRect(gx, gy - 20, 1, 2); g.fillRect(gx + 2, gy - 19, 1, 1); }
          }, function () {
            var lg = R.lastGov[n.id], emo = EMO_MOOD[gov.mood] || 'emo.note';
            if (lg && lg.bribeAt && now - lg.bribeAt < 5000) emo = 'emo.gold';
            var cyc = still ? 0 : ((now + hash(n.id) % 1000) % 5200);
            if (cyc < 3400) drawEmote(g, emo, gx, gy - 16, now);
          });
        }
      });

      // citizens (one sprite per R.sampleN people)
      var labels = [], me = env.myUserId(), nTravel = 0, nProtest = 0, nShown = 0;
      for (var aid in R.agents) {
        (function (ag) {
          var n = nById[ag.nid];
          if (ag.travel && ag.wait > 0) return;            // packing indoors, waiting for a gap in the line
          if (!ag.travel && (!L.towns[ag.nid] || !n || n.alive === false || ag.inside || !ag.placed)) return;
          var c = cid2c[ag.cid] || {}, x = ag.x, y = ag.y;
          nShown++;
          if (ag.travel) nTravel++;
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
              g.fillRect(Math.round(x) - 4, Math.round(y), 9, 1); g.fillRect(Math.round(x) - 5, Math.round(y) + 1, 11, 1);
              g.globalAlpha = 1;
            }
            spr(g, name, x, y, null, fade < 1 ? fade : null);
            if (ag.travel) drawCase(g, x, y, ag.dir);
            else if (ag.role === 'protest') drawPlacard(g, x, y, ph, now, still);
            if (c.cls === 'elite') { g.fillStyle = tok.owner; g.fillRect(Math.round(x) - 1, Math.round(y) - 17, 2, 1); }
          } };
          var e = null, cyc = still ? 0 : (now / 1000 + ph * 7) % 7;
          if (ag.travel) e = null;
          else if (c.protesting || ag.role === 'protest') e = (cyc < 3.5 && ph < 0.45) ? (ph < 0.22 ? 'emo.angry' : 'emo.alarm') : null;
          else if (c.hidingIncome && cyc > 5.2 && ph < 0.5) e = 'emo.cash';
          else if (num(c.mood, 0.6) < 0.25 && cyc < 2.4 && ph < 0.5) e = 'emo.tear';
          else if (R.crisis[ag.nid] && now - R.crisis[ag.nid] < 3500 && ph < 0.12) e = 'emo.bang';
          if (still && c.protesting && ph < 0.45) e = 'emo.angry';
          if (e) item.top = function () { drawEmote(g, e, x, y - 16, now + ph * 1000); };
          list.push(item);
          if (c.isFollower) labels.push({ x: x, y: y - 18, name: c.name || 'Citizen', mine: me && c.ownerId === me });
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
        [[64, 30, 0], [20, 56, 300], [108, 50, 520], [64, 90, 800], [112, 24, 1000]].forEach(function (b) {
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
        ds.pxField = L.PC * TS + 'x' + L.PR * TS + ' ' + L.orient;
        ds.pxHud = (L.hud && L.hud.mode) + (L.hudOverlay ? ' overlay' : '');
        ds.pxTravel = String(nTravel); ds.pxProtest = String(nProtest); ds.pxStrike = String(R.fx.length);
        ds.pxShown = String(nShown); ds.pxSample = String(R.sampleN); ds.pxMoves = String(R.moves);
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
      R.lastBoxes = { tags: [], hud: null, dial: null, forest: null };
      s.nations.forEach(function (n, i) {
        var P = L.towns[n.id], T = R.towns[n.id];
        if (!P || !T) return;
        var p = toCss(P.x + TOWN_W / 2, P.y + TOWN_H + 3);
        if (zoomed && (p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > H + 8)) return;
        R.lastBoxes.tags.push(drawNameTag(ctx, n, i, p, tok, W, H, z / dpr));
      });
      tensions.forEach(function (tn) {
        if (tn.t < 35) return;
        var p = toCss(tn.x, tn.y), col = tn.t >= 70 ? tok.crit : tok.warn;
        var label = (W < 520 ? '' : 'TENSION ') + Math.round(tn.t);
        ctx.font = '600 9.5px "IBM Plex Mono", monospace';
        var w = ctx.measureText(label).width + 10;
        ctx.globalAlpha = 0.92; ctx.fillStyle = tok.bg; rr(ctx, p[0] - w / 2, p[1] - 7.5, w, 15, 4); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
        ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, p[0], p[1] + 0.5);
      });
      if (showCom) {
        var cp = toCss(L.commons.x + L.commons.w / 2, L.commons.y + L.commons.h + 4);
        ctx.font = '600 9.5px "IBM Plex Mono", monospace';
        var ct = 'SHARED FOREST ' + Math.round(comRatio * 100) + '%', cw = ctx.measureText(ct).width + 10;
        ctx.globalAlpha = 0.9; ctx.fillStyle = tok.surface; rr(ctx, cp[0] - cw / 2, cp[1] - 7, cw, 15, 4); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = comRatio < 0.25 ? tok.crit : tok.dim; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ct, cp[0], cp[1] + 0.5);
        R.lastBoxes.forest = [cp[0] - cw / 2, cp[1] - 7, cp[0] + cw / 2, cp[1] + 8];
      }
      labels.sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      labels.slice(0, 8).forEach(function (l) {
        var p = toCss(l.x, l.y), w = ctx.measureText(l.name).width + 10;
        ctx.globalAlpha = 0.92; ctx.fillStyle = tok.surface; rr(ctx, p[0] - w / 2, p[1] - 15, w, 14, 3); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = l.mine ? tok.signal : tok.line2; ctx.stroke();
        ctx.fillStyle = l.mine ? tok.signal : tok.text; ctx.fillText(l.name, p[0], p[1] - 7.5);
      });
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
      for (var tid in R.tags) {
        var tg = R.tags[tid], age = now - tg.t0;
        if (age > 2600) { delete R.tags[tid]; continue; }
        var anchorW = tid === '__commons' ? (L.commons ? [L.commons.x + L.commons.w / 2, L.commons.y + 6] : null)
          : (L.towns[tid] ? [L.towns[tid].x + HALL_X, L.towns[tid].y + 2] : null);
        if (!anchorW) continue;
        var tp = toCss(anchorW[0], anchorW[1]);
        if (zoomed && (tp[0] < 0 || tp[0] > W || tp[1] < 0 || tp[1] > H)) continue;
        drawTag(ctx, tg, tp, age, still, tok, W);
      }
      var hudBox = drawHud(ctx, s, L, tok, W, H, dpr, zoomed);
      R.lastBoxes.hud = hudBox;
      if (cfgW.escalation) {
        var D = dialSpot(L, W, H, dpr, hudBox, zoomed);
        if (D) {
          ctx.globalAlpha = 0.85; ctx.fillStyle = tok.surface; rr(ctx, D.x - D.r - 7, D.y - D.r - 7, D.r * 2 + 14, D.r + 40, 8); ctx.fill(); ctx.globalAlpha = 1;
          try { env.vector.drawDial(num(s.doomsday, 0), D); } catch (e) { /* ignore */ }
          R.lastBoxes.dial = [D.x - D.r - 7, D.y - D.r - 7, D.x + D.r + 7, D.y + 33];
        }
      }
      if (!L.story) {
        var stampText = 'YEAR ' + num(s.year, 0) + ' · ROUND ' + num(s.round, 0);
        ctx.font = '500 10px "IBM Plex Mono", monospace';
        var sw = ctx.measureText(stampText).width + 12, sx = W - sw - 6, sy = H - 23;
        // the page shows the round too: drop the stamp rather than cover a town, a tag, the HUD or the dial
        var sr = [sx, sy, sx + sw, sy + 18], hits = function (b) { return b && sr[0] < b[2] && b[0] < sr[2] && sr[1] < b[3] && b[1] < sr[3]; };
        var covers = hits(R.lastBoxes.hud) || hits(R.lastBoxes.dial) || R.lastBoxes.tags.some(hits) || (!zoomed && L.order.some(function (id) { var t = L.towns[id], a = toCss(t.x, t.y), b = toCss(t.x + TOWN_W, t.y + TOWN_H); return hits([a[0], a[1], b[0], b[1]]); }));
        if (covers) return true;
        ctx.globalAlpha = 0.85; ctx.fillStyle = tok.surface; rr(ctx, sx, sy, sw, 18, 5); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = tok.faint; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(stampText, sx + 6, H - 10);
      }
      return true;
    };

    // geometry for tests and tuning (CSS px at the whole-field camera)
    try { window.__pixDebug = function () { return R.debug(); }; } catch (e) { /* ignore */ }
    R.debug = function () {
      var L = R.L;
      if (!L) return null;
      var d = L.dpr, f = function (x, y, w, h) { return [(L.ox + x * L.s) / d, (L.oy + y * L.s) / d, (L.ox + (x + w) * L.s) / d, (L.oy + (y + h) * L.s) / d]; };
      var towns = L.order.map(function (id) { var t = L.towns[id]; return { id: id, box: f(t.x, t.y, TOWN_W, TOWN_H), flagTop: f(t.x + FLAG.x, t.y + FLAG.y - POLE, 1, 1)[1] }; });
      var area = L.PC * L.PR * TS * TS, built = L.order.length * TOWN_W * TOWN_H;
      return { s: L.s, mode: L.mode, orient: L.orient, field: f(L.px0, L.py0, L.PC * TS, L.PR * TS + SKIRT), fieldArt: [L.PC * TS, L.PR * TS], towns: towns,
        forest: L.commons ? f(L.commons.x, L.commons.y, L.commons.w, L.commons.h) : null, hudCell: L.hudCell ? f(L.hudCell.x, L.hudCell.y, L.hudCell.w, L.hudCell.h) : null,
        attempts: R.attempts, travellers: Object.keys(R.agents).filter(function (k) { return R.agents[k].travel; }).map(function (k) { var a = R.agents[k]; return { x: a.x, y: a.y, wait: a.wait, path: a.path.length, next: a.path[0], tr: a.travel, nid: a.nid }; }), openShare: 1 - built / area, builtShare: built / area, sampleN: R.sampleN, boxes: R.lastBoxes, emblemCss: (EMB.coin.w * L.s) / d };
    };

    // ---------------------------------------------------------------- camera
    function camera(L, now, still) {
      var base = { z: L.s, ox: L.ox, oy: L.oy };
      if (L.mode === 'pan') {
        var n = L.order.length, per = 8.3, c;
        var ctr = function (id) { var t = L.towns[id]; return [t.x + TOWN_W / 2, t.y + TOWN_H / 2]; };
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
      // the closest whole-number zoom that still shows the whole town and its flag, with a little ground
      var zt = L.s;
      for (var k = L.s + 1; k <= L.s * 3; k++) { if ((TOWN_W + 24) * k <= L.devW && (TOWN_H + 44) * k <= L.devH) zt = k; else break; }
      if (zt === L.s) return base;
      var e = tt < CINE_IN ? tt / CINE_IN : tt < CINE_IN + CINE_HOLD ? 1 : 1 - (tt - CINE_IN - CINE_HOLD) / CINE_OUT;
      e = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
      var z = L.s + Math.round((zt - L.s) * e);
      var fcx = (L.devW / 2 - L.ox) / L.s, fcy = (L.devH / 2 - L.oy) / L.s;
      var tcx = P.x + TOWN_W / 2, tcy = P.y + TOWN_H / 2 - 6;
      var cx2 = fcx + (tcx - fcx) * e, cy2 = fcy + (tcy - fcy) * e;
      return { z: z, ox: Math.round(L.devW / 2 - cx2 * z), oy: Math.round(L.devH / 2 - cy2 * z) };
    }

    // ---------------------------------------------------------------- tension along the roads
    // A dotted glowing line that follows the road between the two towns (so it bends around the forest),
    // with its label at the halfway point and a barricade there at 70 and above.
    function drawTension(g, L, s, now, still) {
      var ten = s.tension || {}, tok = env.tok(), out = [];
      for (var key in ten) {
        var t = num(ten[key], 0);
        if (t < 15) continue;
        var ids = key.split('|'), a = L.towns[ids[0]], b = L.towns[ids[1]];
        if (!a || !b) continue;
        var pts = roadPath(L, ids[0], ids[1]);
        if (!pts || pts.length < 2) continue;
        // trim the part inside each town's own territory
        var len = polyLen(pts), d0 = 18, d1 = len - 18;
        if (d1 <= d0) continue;
        var col = t >= 70 ? tok.crit : t >= 35 ? tok.warn : tok.faint, sz = t >= 70 ? 3 : 2, stepPx = t >= 70 ? 6 : 5;
        var shift = (!still && t >= 35) ? (now / 90) % stepPx : 0, lane = (hash(key) % 2 ? 3 : -3);
        g.fillStyle = col;
        g.globalAlpha = 0.16 + t / 100 * 0.22;
        for (var d = d0; d < d1; d += 2) { var q = polyAt(pts, d); g.fillRect(Math.round(q.x + lane) - sz, Math.round(q.y + lane) - sz, sz * 2 + 1, sz * 2 + 1); }
        g.globalAlpha = 0.65 + t / 100 * 0.35;
        for (d = d0 + shift; d < d1; d += stepPx) { var q2 = polyAt(pts, d); g.fillRect(Math.round(q2.x + lane) - (sz >> 1), Math.round(q2.y + lane) - (sz >> 1), sz, sz); }
        g.globalAlpha = 1;
        var m = polyAt(pts, (d0 + d1) / 2);
        out.push({ t: t, x: m.x + lane, y: m.y + lane - 10 });
        if (t >= 70) { spr(g, 'prop.sandbag', m.x - 7, m.y + 6); spr(g, 'prop.sandbag', m.x + 7, m.y + 6); spr(g, 'prop.barrier', m.x, m.y + 8); }
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
    function drawNameTag(ctx, n, i, p, tok, W, H, zr) {
      var dead = n.alive === false, col = dead ? paint('grey') : paint(toneOf(n, i));
      var fs = clamp(Math.round(11 * Math.sqrt(Math.max(1, zr))), 10.5, 15), name = (n.name || n.id), es = Math.round(fs + 1);
      ctx.save();
      ctx.font = '700 ' + fs + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
      var w = Math.ceil(ctx.measureText(name).width) + es + 16, h = fs + 8;
      var x = clamp(p[0] - w / 2, 2, W - w - 2), y = p[1] - h / 2;
      if (y + h > H - 2) y = H - h - 2;
      ctx.fillStyle = col.mid; rr(ctx, x, y, w, h, h / 2); ctx.fill();
      ctx.strokeStyle = col.dark; ctx.lineWidth = 1.2; ctx.stroke();
      // emblem on a small dark disc so every palette reads on every shade
      ctx.fillStyle = 'rgba(14, 18, 28, 0.82)'; ctx.beginPath(); ctx.arc(x + 4 + es / 2 + 1, y + h / 2, es / 2 + 1.5, 0, Math.PI * 2); ctx.fill();
      drawEmblemCss(ctx, emblemOf(n), x + 5, y + (h - es) / 2, es);
      ctx.fillStyle = col.ink; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(name, x + es + 10, y + h / 2 + 0.5);
      if (dead) { ctx.strokeStyle = tok.crit; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + es + 8, y + h / 2); ctx.lineTo(x + w - 4, y + h / 2); ctx.stroke(); }
      ctx.restore();
      return [x, y, x + w, y + h];
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
    function icon(ctx, id, x, y, color) {
      var bm = ICON[id];
      if (!bm) return;
      ctx.fillStyle = color;
      for (var r = 0; r < bm.length; r++) for (var c = 0; c < bm[r].length; c++) if (bm[r].charAt(c) === '#') ctx.fillRect(x + c, y + r, 1, 1);
    }
    function metric01(n, id) {
      var v = n.metrics ? num(n.metrics[id], null) : null;
      if (v == null) return null;
      return clamp(v / 100, 0, 1);
    }
    // HUD in its reserved corner: one row per nation with a colour chip carrying the emblem, the name, and
    // three neutral bars (wellbeing, trust, corruption) labelled by icons, so no bar reads as a nation colour
    var BAR_IDS = ['welfare', 'trust', 'corruption'], BAR_LABELS = ['Wellbeing', 'Trust', 'Corruption'];
    function drawHud(ctx, s, L, tok, W, H, dpr, zoomed) {
      var hud = L.hud, ns = s.nations, x, y, wide = hud.mode === 'wide', w = hud.w, h = hud.h, rowH = hud.rowH, head = hud.head;
      if (L.hudCell && !L.hudOverlay) {
        x = (L.ox + L.hudCell.x * L.s) / dpr; y = (L.oy + L.hudCell.y * L.s) / dpr;
        // keep the HUD in the matching screen corner while the camera is in close
        if (zoomed) { var code = L.hudCell.code; x = code.charAt(1) === 'l' ? 6 : code.charAt(1) === 'r' ? W - w - 6 : (W - w) / 2; y = code.charAt(0) === 't' ? 6 : H - h - 30; }
      } else {
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
      ctx.globalAlpha = 0.92; ctx.fillStyle = tok.bg; rr(ctx, x, y, w, h, 7); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = tok.line2; ctx.lineWidth = 1; ctx.stroke();
      var barW = wide ? 24 : 13, gap = wide ? 5 : 3, bx0 = x + w - 8 - 3 * barW - 2 * gap;
      var barCol = tok.label, iconCol = tok.dim;
      ctx.font = '600 8px "IBM Plex Mono", monospace'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      // legend: icon + word for each bar, then the same icons right above the bar columns
      var lx = x + 8, ly = y + 8;
      BAR_IDS.forEach(function (id, i) {
        if (!wide && i === 2) { lx = x + 8; ly += 11; }
        icon(ctx, id, lx, ly - 1, iconCol);
        ctx.fillStyle = tok.dim; ctx.fillText(BAR_LABELS[i], lx + 10, ly + 2.5);
        lx += ctx.measureText(BAR_LABELS[i]).width + 18;
      });
      var iy = y + head - 10;
      BAR_IDS.forEach(function (id, k) { icon(ctx, id, bx0 + k * (barW + gap) + Math.floor((barW - 7) / 2), iy, iconCol); });
      var focusId = L.focus;
      ns.forEach(function (n, i) {
        var dead = n.alive === false, ry = y + head + i * rowH, cy = ry + rowH / 2;
        var col = dead ? paint('grey') : paint(toneOf(n, i));
        if (focusId && n.id === focusId) {
          ctx.globalAlpha = 0.28; ctx.fillStyle = col.mid; rr(ctx, x + 3, ry, w - 6, rowH - 1, 4); ctx.fill(); ctx.globalAlpha = 1;
          ctx.strokeStyle = col.mid; ctx.lineWidth = 1.2; rr(ctx, x + 3, ry, w - 6, rowH - 1, 4); ctx.stroke();
        }
        var cs = rowH - 3;
        ctx.fillStyle = col.mid; rr(ctx, x + 6, cy - cs / 2, cs, cs, 3); ctx.fill();
        ctx.fillStyle = 'rgba(14, 18, 28, 0.55)'; rr(ctx, x + 7.5, cy - cs / 2 + 1.5, cs - 3, cs - 3, 2); ctx.fill();
        drawEmblemCss(ctx, emblemOf(n), x + 8, cy - cs / 2 + 2, cs - 4);
        var nx = x + 6 + cs + 5, g0 = n.governor || {};
        if (wide) { govIcon(ctx, g0.type, nx, cy - 5, dead ? tok.faint : tok.dim); nx += 13; }
        ctx.textAlign = 'left';
        ctx.font = '700 ' + (wide ? 11.5 : 10.5) + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
        ctx.fillStyle = dead ? tok.faint : tok.label;
        var nameW = wide ? 82 : bx0 - nx - 4;
        ctx.fillText(fit(ctx, n.name || n.id, nameW), nx, cy + 0.5);
        if (wide) {
          ctx.font = '500 9.5px "IBM Plex Mono", monospace'; ctx.fillStyle = tok.faint;
          var gname = dead ? 'FALLEN' : (g0.inOffice === false ? 'No governor' : (g0.name || env.govLabel(g0.type)));
          if (dead) ctx.fillStyle = tok.crit;
          ctx.fillText(fit(ctx, gname, bx0 - nx - 88), nx + 86, cy + 0.5);
        }
        BAR_IDS.forEach(function (id, k) {
          var v = dead ? 0 : metric01(n, id), bx = bx0 + k * (barW + gap);
          ctx.fillStyle = tok.line2; ctx.fillRect(bx, cy - 2.5, barW, 5);
          if (v != null) { ctx.fillStyle = barCol; ctx.fillRect(bx, cy - 2.5, Math.max(1, Math.round(barW * v)), 5); }
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
    function dialSpot(L, W, H, dpr, hudBox, zoomed) {
      var r = dialR(W);
      if (L.dialCell && !zoomed) {
        var a = [(L.ox + L.dialCell.x * L.s) / dpr, (L.oy + L.dialCell.y * L.s) / dpr];
        return { x: a[0] + r + 7, y: a[1] + r + 7, r: r };
      }
      // no reserved spot (or the camera is in close): the screen corner furthest from the HUD
      var cands = [[W - r - 14, r + 16], [r + 14, H - 52], [W - r - 14, H - 64], [r + 14, r + 16]], best = cands[0], bd = -1;
      cands.forEach(function (c) {
        var d = Math.hypot(Math.max(hudBox[0] - c[0], 0, c[0] - hudBox[2]), Math.max(hudBox[1] - c[1], 0, c[1] - hudBox[3]));
        if (d > bd) { bd = d; best = c; }
      });
      return { x: best[0], y: best[1], r: r };
    }

    return R;
  };
})();
