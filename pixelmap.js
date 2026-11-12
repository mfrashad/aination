/* AI Nation: pixel world renderer.
 *
 * Draws each nation as a small island town from a pre-built sprite atlas (assets/atlas.json + atlas.png),
 * built by tools/build-atlas.py from a licensed copy of LimeZu's pixel art. The repo ships no art: when the
 * atlas cannot be fetched, PixelMap.load() resolves null and ui.js keeps its vector map.
 *
 * Contract with ui.js:
 *   PixelMap.load(base) -> Promise<{json, img} | null>
 *   PixelMap.create(atlas, env) -> renderer
 *     env.state(), env.config(), env.tok(), env.systemLabel(id), env.myUserId(), env.reduced(),
 *     env.vector (the vector MAP object: drawTension / drawDial / drawStamp are reused for overlays)
 *   renderer.draw(ctx, W, H, dpr, now)   screen canvas, CSS size, device pixel ratio, ms
 *   renderer.onState()                    after every engine step
 *   renderer.onMove(cid, fromId, toId)    a citizen changed nation (emigration) or left
 *   renderer.onEvent(ev)                  engine events (strikes, crises)
 *   renderer.ping(nid), renderer.reset(), renderer.invalidate()
 *
 * The renderer reads engine state and never changes it. All positions are derived from ids, so the
 * same world always lays out the same way.
 */
(function () {
  'use strict';

  var TS = 16, TW = 18, TH = 23;          // town plot in tiles (288 x 368 px)
  var TOWN_W = TW * TS, TOWN_H = (TH - 1) * TS;   // the island; local town coords start 16 px above it (LY)
  var LY = 16;
  var GX = 40, GY = 44, TOP = 30, MX = 10, BOT = 22;
  var SIDE = 40;                           // world margin beside a column of towns: room for the boat channel
  var SLACK = 8;                           // art px of outer margin a whole-world fit may crop
  var LABEL_CSS = 36;                      // CSS px kept above each town for its label
  var COM_W = 8, COM_H = 7;                // commons islet in tiles

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
  function canvas(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  var PM = window.PixelMap = {};

  PM.load = function (base) {
    base = base || 'assets/';
    if (!window.fetch) return Promise.resolve(null);
    return fetch(base + 'atlas.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('no atlas');
      return r.json();
    }).then(function (json) {
      if (!json || !json.frames || json.tile !== TS) throw new Error('bad atlas');
      return new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res({ json: json, img: im }); };
        im.onerror = function () { rej(new Error('no atlas image')); };
        im.src = base + 'atlas.png';
      });
    }).catch(function () { return null; });
  };

  // ------------------------------------------------------------------ town plans
  // Each system picks what stands in the landmark slot (L, right of the hall) and the four front slots.
  var CLASS_POOL = { worker: ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'], owner: ['o1', 'o2', 'o3'], elite: ['e1', 'e2'] };
  var GOV_SPRITE = { aligned_ai: 'gai', human_persona: 'gper', human_player: 'gyou' };
  var PLANS = {
    free_market:       { L: ['bld.shop', 'work'],  S: [['home', 'home'], ['bld.stall1', 'work'], ['bld.cart', 'work'], ['home', 'home']], rich: true },
    social_democracy:  { L: ['bld.cabin', 'work'], S: [['home', 'home'], ['bld.stall2', 'work'], ['home', 'home'], ['bld.booth', 'work']] },
    market_socialism:  { L: ['bld.shop', 'work'],  S: [['home', 'home'], ['bld.booth', 'work'], ['bld.stall3', 'work'], ['home', 'home']] },
    central_planning:  { L: ['bld.dorm', 'work'],  S: [['bld.booth', 'work'], ['home', 'home'], ['home', 'home'], ['bld.booth', 'work']], grey: true },
    cooperative:       { L: ['bld.cabin', 'work'], S: [['bld.stall1', 'work'], ['home', 'home'], ['bld.stall3', 'work'], ['home', 'home']] }
  };
  var HOMES = ['bld.home1', 'bld.home3', 'bld.home5', 'bld.home7'];

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
          var l = (p[i] * 0.3 + p[i + 1] * 0.55 + p[i + 2] * 0.15) * 0.72 + 18;
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
    // draw a frame with its anchor at world (x, y)
    function spr(g, name, x, y, img, alpha) {
      var f = A.frames[name];
      if (!f) return;
      var a = anchor(name);
      if (alpha != null) g.globalAlpha = alpha;
      g.drawImage(img || IMG, f[0], f[1], f[2], f[3], Math.round(x - a[0]), Math.round(y - a[1]), f[2], f[3]);
      if (alpha != null) g.globalAlpha = 1;
    }
    function sizeOf(name) { var f = A.frames[name]; return f ? [f[2], f[3]] : [0, 0]; }

    var R = {
      L: null, towns: {}, agents: {}, boats: [], fx: [], pings: [], crisis: {}, lastGov: {},
      frame: null, fctx: null, layoutKey: '', t0: 0, lastNow: 0, staticDirty: true
    };

    // ---------------------------------------------------------------- layout
    // Arrangements are rows of towns, top to bottom. A column (all rows of one) suits tall, narrow stages.
    function arrangements(n) {
      var out = [];
      if (n <= 1) out.push([1]);
      if (n === 2) out.push([2], [1, 1]);
      if (n === 3) out.push([3], [2, 1], [1, 2]);
      if (n === 4) out.push([4], [2, 2], [3, 1]);
      if (n >= 5) out.push([n], [3, n - 3], [2, n - 2 > 3 ? 3 : n - 2], [2, 2, n - 4]);
      if (n >= 3) out.push(column(n));
      return out;
    }
    function column(n) { var r = []; for (var i = 0; i < n; i++) r.push(1); return r; }
    function isColumn(rows) { return rows.length > 1 && rows.every(function (k) { return k === 1; }); }

    // World size of one arrangement. Labels are drawn in CSS px, so the room kept above each row
    // depends on the whole-number scale sc (device px per art px).
    function measure(rows, cm, dpr, sc) {
      var mx = isColumn(rows) ? SIDE : MX;
      var rowW = rows.map(function (k) { return k * TOWN_W + (k - 1) * GX; });
      var comRow = -1, cw = COM_W * TS, ch = COM_H * TS;
      if (cm === 'inline') {
        var mi = 0;
        rows.forEach(function (k, i) { if (k < rows[mi]) mi = i; });
        if (rows.length < 2 || rows[mi] === rows[0] && rows.every(function (k) { return k === rows[0]; })) return null;
        comRow = mi; rowW[mi] += GX + cw;
      }
      if (cm === 'below-mid' && rows.length !== 1) return null;
      var band = Math.ceil(LABEL_CSS * dpr / sc);
      var top = Math.max(TOP, band), gy = Math.max(GY, band + 8);
      var h = top + rows.length * TOWN_H + (rows.length - 1) * gy + BOT;
      if (cm === 'row') h += ch + 34;
      if (cm === 'below-mid') h += ch + 30 - BOT + 4;
      return { rows: rows, cm: cm, comRow: comRow, rowW: rowW, w: Math.max.apply(null, rowW) + mx * 2, h: h, top: top, gy: gy };
    }
    // Largest whole-number scale at which the arrangement fits, or the fractional fit (< 1) when it cannot.
    // The outer margins are open water, so a fit may crop up to SLACK art px of them.
    function fits(m, devW, devH) { return Math.min(devW / (m.w - SLACK), devH / (m.h - SLACK)); }
    function fitOf(rows, cm, devW, devH, dpr) {
      var m = measure(rows, cm, dpr, 1);
      if (!m) return null;
      var f = fits(m, devW, devH);
      if (f < 1) { m.fit = f; return m; }
      var k = Math.floor(f);
      for (;;) {
        var m2 = measure(rows, cm, dpr, k + 1);
        if (fits(m2, devW, devH) >= k + 1) { k++; m = m2; } else break;
      }
      if (k > 1) m = measure(rows, cm, dpr, k);
      m.fit = k;
      return m;
    }
    function bestArrangement(n, devW, devH, dpr, commons, only) {
      var best = null;
      (only ? [only] : arrangements(n)).forEach(function (rows) {
        // commons placement options: own row below, or inside the shortest row, or none
        (commons ? ['row', 'inline', 'below-mid'] : ['none']).forEach(function (cm) {
          var m = fitOf(rows, cm, devW, devH, dpr);
          if (!m) return;
          var score = m.fit * 1000 - (cm === 'row' ? 1 : 0) - rows.length * 0.1 - (isColumn(rows) && rows.length > 2 ? 0.5 : 0);
          if (!best || score > best.score) { m.score = score; best = m; }
        });
      });
      return best;
    }
    // The box the camera frames for one town: its label band, the island and the top of its jetty.
    function townBox(P, band) { return { x: P.x - 8, y: P.y - band, w: TOWN_W + 16, h: band + TOWN_H + 14 }; }

    // Modes: 'fit' shows the whole world at a whole-number scale (static, centred). 'camera' is used when
    // the world cannot fit at 1 device px per art px: scale 1, and a camera that frames one town at a time.
    // 'focus' (Story mode) frames one nation's town as large as a whole-number scale allows.
    function computeLayout(W, H, dpr, ns, commons, focusId) {
      var devW = Math.round(W * dpr), devH = Math.round(H * dpr);
      var best = bestArrangement(ns.length, devW, devH, dpr, commons);
      var mode = best.fit >= 1 ? 'fit' : 'camera', sc = best.fit >= 1 ? best.fit : 1, hero = null;
      if (focusId && ns.length > 1 && ns.some(function (n) { return n.id === focusId; })) {
        // the hero town's own whole-number scale; whole world wins only if it is at least as large
        var kH = 1;
        for (var k = 2; k < 12; k++) {
          var band = Math.ceil(LABEL_CSS * dpr / k);
          if ((TOWN_W + 16) * k <= devW && (band + TOWN_H + 14) * k <= devH) kH = k; else break;
        }
        if (mode !== 'fit' || best.fit < kH) {
          var others = ns.filter(function (n) { return n.id !== focusId; }), hn = ns.filter(function (n) { return n.id === focusId; })[0];
          others.splice(Math.floor(others.length / 2), 0, hn);
          ns = others;
          best = measure(column(ns.length), commons ? 'row' : 'none', dpr, kH);
          mode = 'focus'; sc = kH; hero = focusId;
        }
      }
      // place
      var L = { s: sc, w: best.w, h: best.h, towns: {}, order: [], gy: best.gy, mode: mode, hero: hero, column: isColumn(best.rows),
        band: Math.ceil(LABEL_CSS * dpr / sc), devW: devW, devH: devH };
      var y = best.top, idx = 0;
      best.rows.forEach(function (k, ri) {
        var x = Math.round((best.w - best.rowW[ri]) / 2);
        var items = [];
        for (var i = 0; i < k; i++) items.push(ns[idx++]);
        if (ri === best.comRow) items.splice(Math.ceil(items.length / 2), 0, '__commons');
        items.forEach(function (it) {
          if (it === '__commons') {
            L.commons = { x: x, y: y + TOWN_H - COM_H * TS - 30, w: COM_W * TS, h: COM_H * TS };
            x += COM_W * TS + GX;
            return;
          }
          L.towns[it.id] = { x: x, y: y, ly: y - LY, row: ri };
          L.order.push(it.id);
          x += TOWN_W + GX;
        });
        y += TOWN_H + best.gy;
      });
      y -= best.gy;
      // the islet sits below the boat lane that runs under each row's jetties
      if (best.cm === 'row' || best.cm === 'below-mid') L.commons = { x: Math.round((best.w - COM_W * TS) / 2), y: y + 30, w: COM_W * TS, h: COM_H * TS };
      // device-pixel placement (whole device px, so the integer-scaled copy stays crisp)
      L.ox = Math.round((W * dpr - L.w * L.s) / 2);
      L.oy = Math.round((H * dpr - L.h * L.s) / 2);
      return L;
    }

    // Per-frame camera for 'camera' and 'focus' modes: sets L.ox / L.oy in whole device px.
    function frameCenter(L, id) {
      var B = townBox(L.towns[id], L.band), cx = B.x + B.w / 2, cy = B.y + B.h / 2;
      var vw = L.devW / L.s, vh = L.devH / L.s;
      if (B.h > vh) cy = B.y + vh / 2;            // too tall: keep the label in view, crop the jetty
      if (L.mode === 'camera') {
        // stay inside the world where it is larger than the view
        cx = L.w > vw ? clamp(cx, vw / 2, L.w - vw / 2) : L.w / 2;
        cy = L.h > vh ? clamp(cy, Math.min(vh / 2, B.y + vh / 2), L.h - vh / 2) : L.h / 2;
      }
      return [cx, cy];
    }
    var CAM_HOLD = 6.5, CAM_PAN = 1.8;
    function camera(L, now, still) {
      if (L.mode === 'fit') return;
      var c;
      if (L.mode === 'focus') c = frameCenter(L, L.hero);
      else {
        var n = L.order.length, per = CAM_HOLD + CAM_PAN;
        if (still || n < 2) { c = frameCenter(L, L.order[0]); L.camIdx = 0; }
        else {
          var t = now / 1000, i = Math.floor(t / per) % n, ph = t % per;
          c = frameCenter(L, L.order[i]);
          L.camIdx = i;
          if (ph > CAM_HOLD) {
            var e = (ph - CAM_HOLD) / CAM_PAN, d = frameCenter(L, L.order[(i + 1) % n]);
            e = e < 0.5 ? 2 * e * e : 1 - Math.pow(-2 * e + 2, 2) / 2;
            c = [c[0] + (d[0] - c[0]) * e, c[1] + (d[1] - c[1]) * e];
            if (e > 0.5) L.camIdx = (i + 1) % n;
          }
        }
      }
      L.ox = Math.round(L.devW / 2 - c[0] * L.s);
      L.oy = Math.round(L.devH / 2 - c[1] * L.s);
    }

    // ---------------------------------------------------------------- town construction
    function buildTown(n, idx) {
      var sys = PLANS[n.system] ? n.system : 'social_democracy';
      var plan = PLANS[sys];
      var r = mulberry(hash('town:' + n.id + ':' + sys));
      var T = { id: n.id, sys: sys, items: [], flat: [], homes: [], works: [], dirt: {}, idx: idx };
      function cell(c, rw) { T.dirt[c + ',' + rw] = 1; }
      var c, rw;
      // plaza (rows 9..12, cols 2..15) and paths
      for (c = 2; c <= 15; c++) for (rw = 9; rw <= 12; rw++) cell(c, rw);
      for (c = 8; c <= 9; c++) for (rw = 13; rw <= 17; rw++) cell(c, rw);
      for (c = 1; c <= 16; c++) for (rw = 18; rw <= 19; rw++) cell(c, rw);
      T.plaza = { x0: 36, y0: 148, x1: 252, y1: 204 };
      T.lane = 306;
      T.junction = 144;
      T.hallDoor = { x: 144, y: 150 };
      T.dock = { x: 152, y: 366 };
      T.protest = { x0: 70, y0: 166, x1: 222, y1: 202 };
      T.wealth = { x0: 214, y0: 160, x1: 250, y1: 200 };
      // hall
      T.items.push({ spr: 'bld.hall', x: 7 + 96, y: 144, sortY: 144 });
      // landmark slot
      var Lname = plan.L[0], Ls = sizeOf(Lname);
      var Lx = Math.min(TOWN_W - 2 - Ls[0], 200 + Math.max(0, Math.floor((86 - Ls[0]) / 2)));
      T.items.push({ spr: Lname, x: Lx + Ls[0] / 2, y: 144, sortY: 144 });
      T.works.push({ x: Math.round(Lx + Ls[0] / 2), y: 152 });
      // front slots
      var slots = [2, 66, 158, 222];
      var homeVar = hash(n.id) % 4;
      plan.S.forEach(function (s, i) {
        var name = s[0] === 'home' ? HOMES[(homeVar + i) % 4] : s[0];
        if (plan.grey && s[0] === 'home') name = 'bld.home5';
        var sz = sizeOf(name), sx = slots[i] + Math.floor((64 - sz[0]) / 2);
        T.items.push({ spr: name, x: sx + sz[0] / 2, y: 288, sortY: 288 });
        var door = (A.meta[name] && A.meta[name].door) ? sx + A.meta[name].door[0] : sx + sz[0] / 2;
        (s[1] === 'home' ? T.homes : T.works).push({ x: Math.round(door), y: 294 });
      });
      if (!T.homes.length) T.homes.push({ x: 40, y: 294 });
      // plaza furniture
      T.items.push({ spr: 'fx.fountain', x: 74, y: 196, sortY: 196, anim: true });
      T.items.push({ spr: 'prop.lamp', x: 18, y: 172, sortY: 172 });
      T.items.push({ spr: 'prop.lamp', x: 270, y: 172, sortY: 172 });
      T.items.push({ spr: 'prop.bench', x: 196, y: 214, sortY: 202 });
      if (plan.rich || sys === 'market_socialism') {
        T.items.push({ spr: 'prop.statue', x: 236, y: 196, sortY: 196 });
      } else {
        T.items.push({ spr: 'prop.topiary', x: 236, y: 192, sortY: 192 });
      }
      if (plan.rich) T.items.push({ spr: 'prop.atm', x: 18, y: 222, sortY: 222 });
      else T.items.push({ spr: 'prop.fbush', x: 16, y: 210, sortY: 210 });
      T.items.push({ spr: 'prop.shrub', x: 272, y: 214, sortY: 214 });
      // a tree behind a low landmark building
      var trees = ['prop.tree1', 'prop.tree2', 'prop.tree3', 'prop.tree4'];
      if (Ls[1] <= 80) T.items.push({ spr: trees[(hash(n.id) >> 3) % 4], x: Lx + Ls[0] / 2 + 8, y: 144 - Ls[1] + 20, sortY: 144 - Ls[1] });
      T.flat.push({ spr: 'prop.flowers1', x: 22, y: 150 });
      T.flat.push({ spr: 'prop.flowers2', x: 266, y: 152 });
      // dock: jetty planks down the cliff into the water
      T.jetty = [[144, 326], [144, 342], [144, 358]];
      return T;
    }

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
    function island(g, ox, oy, tw, th) {
      var f = fr('ter.island');
      if (!f) return;
      for (var c = 0; c < tw; c++) {
        var sc = c === 0 ? 0 : c === tw - 1 ? 2 : 1;
        for (var r = 0; r < th; r++) {
          var sr = r === 0 ? 0 : r >= th - 3 ? r - (th - 3) + 2 : 1;
          g.drawImage(IMG, f[0] + sc * 16, f[1] + sr * 16, 16, 16, ox + c * 16, oy + r * 16, 16, 16);
        }
      }
    }
    function renderGround(T) {
      var c = canvas(TOWN_W, LY + TOWN_H + 24), g = c.getContext('2d');
      g.imageSmoothingEnabled = false;
      island(g, 0, LY, TW, TH - 1);
      autotile(g, T.dirt, 'ter.dirt', 0, 0);
      // herringbone paving inset on the plaza
      var hb = fr('ter.herring');
      if (hb) {
        for (var y = 9 * 16 + 4; y < 13 * 16 - 4; y += 32) for (var x = 2 * 16 + 4; x < 16 * 16 - 4; x += 32) {
          var w = Math.min(32, 16 * 16 - 4 - x), h = Math.min(32, 13 * 16 - 4 - y);
          g.drawImage(IMG, hb[0], hb[1], w, h, x, y, w, h);
        }
      }
      T.flat.forEach(function (it) { spr(g, it.spr, it.x, it.y); });
      T.jetty.forEach(function (p) { spr(g, 'prop.jetty', p[0] + 8, p[1] + 16); });
      spr(g, 'prop.jettyend', T.jetty[2][0] + 8, T.jetty[2][1] + 26);
      return c;
    }
    function greyCopy(c) {
      var o = canvas(c.width, c.height), g = o.getContext('2d');
      g.drawImage(c, 0, 0);
      try {
        var d = g.getImageData(0, 0, o.width, o.height), p = d.data;
        for (var i = 0; i < p.length; i += 4) { var l = (p[i] * 0.3 + p[i + 1] * 0.55 + p[i + 2] * 0.15) * 0.72 + 18; p[i] = l; p[i + 1] = l * 0.98; p[i + 2] = l * 1.03; }
        g.putImageData(d, 0, 0);
      } catch (e) { /* tainted: keep colour */ }
      return o;
    }

    // commons islet: ground drawn per frame from its stock (cheap: 7x6 tiles)
    function drawCommons(g, C, ratio, now) {
      island(g, C.x, C.y, COM_W, COM_H);
      // pond grows with the stock
      var cells = {}, cx = 4, cy = 2;
      var rad = 0.5 + ratio * 1.6;
      for (var c = 2; c < COM_W - 2; c++) for (var r = 1; r < COM_H - 3; r++) {
        var dx = (c + 0.5 - cx) / 1.4, dy = (r + 0.5 - (cy + 0.5));
        if (Math.sqrt(dx * dx + dy * dy) <= rad) cells[c + ',' + r] = 1;
      }
      if (ratio > 0.04 && !Object.keys(cells).length) { cells['3,2'] = 1; cells['4,2'] = 1; }
      autotile(g, cells, 'ter.pond', C.x, C.y);
      // woodland on the rim: shrubs while healthy, stumps when depleted
      var spots = [[12, 34], [116, 34], [14, 62], [114, 62], [34, 74], [94, 74], [64, 78]];
      var alive = Math.round(ratio * spots.length + 0.2);
      var list = spots.map(function (p, i) { return { x: C.x + p[0], y: C.y + p[1], i: i }; });
      list.sort(function (a, b) { return a.y - b.y; });
      list.forEach(function (p) {
        if (p.i < alive) spr(g, p.i % 2 ? 'prop.fbush' : 'prop.shrub', p.x, p.y);
        else spr(g, 'prop.stump', p.x, p.y);
      });
    }

    // ---------------------------------------------------------------- agents
    function townOf(nid) { return R.towns[nid]; }
    function pickSprite(c) {
      var pool = CLASS_POOL[c.cls] || CLASS_POOL.worker;
      return pool[hash('look:' + c.id) % pool.length];
    }
    function roleOf(c, n) {
      if (n && n.alive === false) return 'gone';
      if (c.protesting) return 'protest';
      if (c.cls === 'elite') return 'elite';
      if (c.employed) return 'work';
      return 'idle';
    }
    function rndIn(rect, rnd) { return { x: rect.x0 + rnd() * (rect.x1 - rect.x0), y: rect.y0 + rnd() * (rect.y1 - rect.y0) }; }
    function level(p, T) { return p.y > 236 ? 'low' : 'up'; }
    function route(T, a, b, jit) {
      var pts = [], la = level(a, T), lb = level(b, T), jx = T.junction + 8 + jit;
      jit = jit * 2;
      if (la === 'low' && lb === 'low') {
        if (Math.abs(a.x - b.x) > 6) { pts.push({ x: a.x, y: T.lane + jit * 0.4 }); pts.push({ x: b.x, y: T.lane + jit * 0.4 }); }
        pts.push(b);
      } else if (la === 'up' && lb === 'up') {
        pts.push(b);
      } else if (la === 'low') {
        pts.push({ x: a.x, y: T.lane + jit * 0.4 }, { x: jx, y: T.lane + jit * 0.4 }, { x: jx, y: 200 }, b);
      } else {
        pts.push({ x: jx, y: 200 }, { x: jx, y: T.lane + jit * 0.4 }, { x: b.x, y: T.lane + jit * 0.4 }, b);
      }
      return pts;
    }
    function homeOf(ag, T) { return T.homes[hash('home:' + ag.cid) % T.homes.length]; }
    function workOf(ag, T) { return T.works[hash('work:' + ag.cid) % T.works.length]; }
    function restSpot(ag, T) {
      var rnd = mulberry(hash('rest:' + ag.cid) + (ag.seq * 7919));
      if (ag.role === 'protest') return rndIn(T.protest, rnd);
      if (ag.role === 'elite') return rndIn(T.wealth, rnd);
      if (ag.role === 'work') return rnd() < 0.5 ? homeOf(ag, T) : workOf(ag, T);
      // idle: loiter on the plaza edges or the lane
      var q = rnd();
      if (q < 0.45) return rndIn({ x0: 100, y0: 184, x1: 182, y1: 206 }, rnd);
      if (q < 0.85) return rndIn({ x0: 36, y0: 200, x1: 250, y1: 208 }, rnd);
      return { x: 20 + rnd() * 248, y: T.lane - 6 + rnd() * 14 };
    }
    function ensureAgent(c, n) {
      var ag = R.agents[c.id];
      if (!ag) {
        ag = R.agents[c.id] = { cid: c.id, nid: n.id, x: 0, y: 0, path: [], wait: 0, dir: 'down', moving: false, inside: false,
          seq: 0, rnd: mulberry(hash('ag:' + c.id)), role: '', key: pickSprite(c), placed: false, out: false };
      }
      return ag;
    }
    function place(ag, T) {
      var p = restSpot(ag, T);
      ag.x = p.x; ag.y = p.y; ag.path = []; ag.placed = true;
      ag.wait = ag.rnd() * 3;
      if (ag.role === 'work' && !ag.follower && ag.rnd() < 0.6) { ag.inside = true; ag.wait = 1 + ag.rnd() * 9; }
    }
    function plan(ag, T, c) {
      ag.seq++;
      var rnd = ag.rnd, target, dwell;
      ag.inside = false;
      if (ag.role === 'protest') { target = rndIn(T.protest, rnd); dwell = 1.6 + rnd() * 3; }
      else if (ag.role === 'elite') { target = rndIn(T.wealth, rnd); dwell = 4 + rnd() * 7; }
      else if (ag.role === 'work') {
        ag.toWork = !ag.toWork;
        target = ag.toWork ? workOf(ag, T) : homeOf(ag, T);
        dwell = 8 + rnd() * 10;
        ag.enter = true;
      } else {
        target = restSpot(ag, T);
        dwell = 3 + rnd() * 6;
      }
      var jit = ((hash(ag.cid) % 13) - 6);
      ag.path = route(T, { x: ag.x, y: ag.y }, { x: target.x + (ag.role === 'work' ? 0 : 0), y: target.y }, jit);
      ag.dwell = dwell;
    }

    function stepAgent(ag, dt, c, n) {
      var T = townOf(ag.nid);
      if (!T) return;
      if (ag.wait > 0) {
        ag.wait -= dt;
        ag.moving = false;
        if (ag.wait > 0) return;
        if (ag.inside) { ag.inside = false; }
      }
      if (!ag.path.length) {
        plan(ag, T, c);
        if (!ag.path.length) { ag.wait = 2; return; }
      }
      var p = ag.path[0];
      var dx = p.x - ag.x, dy = p.y - ag.y, d = Math.hypot(dx, dy);
      var sp = (c && num(c.mood, 0.6) < 0.3) ? 13 : 22;
      if (ag.role === 'protest') sp = 26;
      if (d <= sp * dt) {
        ag.x = p.x; ag.y = p.y; ag.path.shift();
        if (!ag.path.length) {
          ag.moving = false;
          ag.wait = ag.dwell || 2;
          if (ag.enter) { ag.inside = !ag.follower; ag.enter = false; if (ag.follower) ag.wait = 2 + ag.rnd() * 2; }
          ag.dir = ag.role === 'protest' ? 'up' : (ag.inside ? 'up' : 'down');
        }
        return;
      }
      ag.moving = true;
      ag.x += dx / d * sp * dt; ag.y += dy / d * sp * dt;
      ag.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }

    // ---------------------------------------------------------------- state sync
    function natList() { var s = env.state(); return (s && Array.isArray(s.nations)) ? s.nations : []; }
    function syncAgents(initial) {
      var seen = {};
      natList().forEach(function (n) {
        (n.citizens || []).forEach(function (c) {
          seen[c.id] = 1;
          var ag = ensureAgent(c, n), role = roleOf(c, n), now = performance.now();
          ag.follower = !!c.isFollower;
          if (ag.travel) return;
          if (ag.nid !== n.id) { ag.nid = n.id; ag.placed = false; }
          // protests are sticky for a few seconds so crowds reach the square even at 16x
          if (role === 'protest') ag.protestUntil = now + 7000;
          else if (role !== 'gone' && ag.protestUntil > now) role = 'protest';
          if (ag.role !== role) {
            var was = ag.role;
            ag.role = role;
            if (was && ag.placed && role === 'protest') { ag.path = []; ag.wait = Math.min(ag.wait, 0.2 + ag.rnd() * 0.8); ag.inside = false; ag.enter = false; }
          }
          var T = townOf(n.id);
          if (T && !ag.placed) place(ag, T);
        });
      });
      for (var id in R.agents) if (!seen[id] && !R.agents[id].travel) delete R.agents[id];
    }

    R.onState = function () {
      if (!R.L) return;
      syncAgents(false);
      // governor emote triggers
      natList().forEach(function (n) {
        var g = n.governor || {}, prev = R.lastGov[n.id];
        var bribes = num(g.bribesTaken, 0);
        if (prev && bribes > prev.bribes) R.lastGov[n.id].bribeAt = performance.now();
        R.lastGov[n.id] = { bribes: bribes, bribeAt: prev ? prev.bribeAt : 0 };
      });
    };

    R.onMove = function (cid, from, to) {
      if (env.reduced() || !R.L) return;
      var ag = R.agents[cid];
      var A0 = townOf(from), B0 = to ? townOf(to) : null;
      if (!A0) return;
      if (!ag || ag.travel) return;
      ag.inside = false; ag.wait = 0; ag.enter = false;
      if (!B0) {
        // leaving the map: walk down the jetty and fade out
        ag.travel = { phase: 'leave', t0: performance.now() };
        ag.path = route(A0, { x: ag.x, y: ag.y }, { x: A0.dock.x - 4, y: 322 }, 0);
        ag.path.push({ x: A0.dock.x - 4, y: 360 });
        return;
      }
      var busy = 0;
      for (var k in R.agents) if (R.agents[k].travel) busy++;
      if (busy >= 10) {
        // every boat is out: the newcomer simply steps off the jetty at the destination
        ag.nid = to; ag.x = B0.dock.x - 4; ag.y = 360; ag.placed = true; ag.role = '';
        ag.path = [{ x: B0.dock.x - 4, y: 322 }];
        return;
      }
      ag.travel = { phase: 'walk', from: from, to: to };
      ag.inside = false; ag.wait = 0;
      ag.path = route(A0, { x: ag.x, y: ag.y }, { x: A0.dock.x - 4, y: 322 }, 0);
      ag.path.push({ x: A0.dock.x - 4, y: 360 });
    };

    function boatRoute(fromId, toId) {
      var L = R.L, a = L.towns[fromId], b = L.towns[toId];
      var ax = a.x + 152, ay = a.y + TOWN_H + 15, bx = b.x + 152, by = b.y + TOWN_H + 15;
      var pts = [{ x: ax, y: ay }];
      if (a.x === b.x && a.row !== b.row) {
        // one column: out to the channel beside the islands, along it, and back in under the other jetty
        var ch = a.x + TOWN_W + Math.min(SIDE, GX) / 2 + 4;
        pts.push({ x: ch, y: ay }, { x: ch, y: by });
      } else if (a.row === b.row) {
        pts.push({ x: bx, y: ay });
      } else {
        // channel beside the destination island, on the side facing the start
        var side = ax < b.x + TOWN_W / 2 ? b.x - GX / 2 : b.x + TOWN_W + GX / 2;
        var mid = a.row < b.row ? b.y - L.gy / 2 : a.y - L.gy / 2;
        if (a.row < b.row) { pts.push({ x: side, y: ay }); pts.push({ x: side, y: by }); }
        else { pts.push({ x: ax < side ? a.x - GX / 2 : a.x + TOWN_W + GX / 2, y: ay }); pts.push({ x: ax < side ? a.x - GX / 2 : a.x + TOWN_W + GX / 2, y: mid }); pts.push({ x: side, y: mid }); pts.push({ x: side, y: by }); }
      }
      pts.push({ x: bx, y: by });
      return pts;
    }

    function moveAlong(ag, dt, sp) {
      var p = ag.path[0], dx = p.x - ag.x, dy = p.y - ag.y, d = Math.hypot(dx, dy);
      if (d <= sp * dt) { ag.x = p.x; ag.y = p.y; ag.path.shift(); }
      else { ag.x += dx / d * sp * dt; ag.y += dy / d * sp * dt; ag.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'); }
      ag.moving = true;
    }
    function stepTravel(ag, dt, now) {
      var tr = ag.travel, T = townOf(ag.nid);
      if (tr.phase === 'leave') {
        if (!ag.path.length || now - tr.t0 > 9000) { delete R.agents[ag.cid]; return; }
        moveAlong(ag, dt, 30);
        return;
      }
      if (tr.phase === 'walk') {
        if (!T) { delete R.agents[ag.cid]; return; }
        if (ag.path.length) { moveAlong(ag, dt, 30); return; }
        if (!R.L.towns[tr.to] || !R.L.towns[tr.from]) { tr.phase = 'done'; }
        else {
          tr.phase = 'boat';
          var pts = boatRoute(tr.from, tr.to);
          R.boats.push({ ag: ag, pts: pts, x: pts[0].x, y: pts[0].y, dir: pts[1].x >= pts[0].x ? 'R' : 'L', seg: 1 });
          return;
        }
      }
      if (tr.phase === 'done') {
        var B = townOf(tr.to);
        delete ag.travel;
        if (!B) { delete R.agents[ag.cid]; return; }
        ag.nid = tr.to; ag.x = B.dock.x - 4; ag.y = 360; ag.placed = true; ag.inside = false; ag.wait = 0;
        ag.role = '';
        ag.path = [{ x: B.dock.x - 4, y: 322 }];
      }
    }
    function stepBoats(dt) {
      var keep = [];
      R.boats.forEach(function (b) {
        var p = b.pts[b.seg];
        if (!p) { b.ag.travel.phase = 'done'; return; }
        var dx = p.x - b.x, dy = p.y - b.y, d = Math.hypot(dx, dy), sp = 64;
        if (Math.abs(dx) > 1) b.dir = dx > 0 ? 'R' : 'L';
        if (d <= sp * dt) { b.x = p.x; b.y = p.y; b.seg++; }
        else { b.x += dx / d * sp * dt; b.y += dy / d * sp * dt; }
        keep.push(b);
      });
      R.boats = keep;
    }

    R.onEvent = function (ev) {
      if (!ev || !R.L) return;
      var now = performance.now();
      if (ev.type === 'nuclear_strike') {
        var tgt = (ev.data && ev.data.targetId) || ev.nationId;
        if (R.L.towns[tgt]) R.fx.push({ kind: 'strike', nid: tgt, t0: now });
      }
      if (/^(debt_crisis|default|hyperinflation|recession|shortage|general_strike|coup)$/.test(ev.type) && ev.nationId) {
        R.crisis[ev.nationId] = now;
      }
    };
    R.ping = function (nid) {
      var now = performance.now();
      if (R.pings.some(function (p) { return p.nid === nid && now - p.t0 < 1800; })) return;
      R.pings.push({ nid: nid, t0: now });
      if (R.pings.length > 5) R.pings.shift();
    };
    R.reset = function () { R.agents = {}; R.boats = []; R.fx = []; R.pings = []; R.crisis = {}; R.lastGov = {}; R.layoutKey = ''; R.L = null; };
    R.invalidate = function () { R.layoutKey = ''; };

    // ---------------------------------------------------------------- drawing
    function ensureLayout(W, H, dpr) {
      var ns = natList();
      var cfgW = (env.config() && env.config().world) || {};
      var focus = (env.focus && env.focus()) || '';
      var key = [W, H, dpr, ns.map(function (n) { return n.id + ':' + n.system; }).join(','), cfgW.commons !== false, focus].join('|');
      if (key === R.layoutKey && R.L) return R.L;
      var oldL = R.L;
      R.layoutKey = key;
      R.L = computeLayout(W, H, dpr, ns, cfgW.commons !== false, focus);
      var towns = {};
      ns.forEach(function (n, i) {
        var prev = R.towns[n.id];
        var T = prev && prev.sys === (PLANS[n.system] ? n.system : 'social_democracy') ? prev : buildTown(n, i);
        if (!T.ground) T.ground = renderGround(T);
        towns[n.id] = T;
      });
      R.towns = towns;
      R.frame = canvas(R.L.w, R.L.h);
      R.fctx = R.frame.getContext('2d');
      R.fctx.imageSmoothingEnabled = false;
      R.ripples = null;
      if (!oldL) syncAgents(true);
      else syncAgents(false);
      return R.L;
    }

    function ripples(L, tok) {
      if (R.ripples) return R.ripples;
      var rnd = mulberry(hash('waves:' + L.w + 'x' + L.h)), list = [];
      for (var i = 0; i < Math.round(L.w * L.h / 5200); i++) list.push({ x: rnd() * L.w, y: rnd() * L.h, w: 3 + Math.floor(rnd() * 4), ph: rnd() * 6.28 });
      R.ripples = list;
      return list;
    }
    function insideAny(L, x, y) {
      for (var id in L.towns) { var t = L.towns[id]; if (x > t.x - 4 && x < t.x + TOWN_W + 4 && y > t.y - 4 && y < t.y + TOWN_H + 26) return true; }
      var C = L.commons;
      return !!(C && x > C.x - 4 && x < C.x + C.w + 4 && y > C.y - 4 && y < C.y + C.h + 4);
    }

    var EMO_MOOD = { calm: 'emo.note', pressured: 'emo.drop', scheming: 'emo.cash', defiant: 'emo.angry', panicked: 'emo.bang' };

    R.draw = function (ctx, W, H, dpr, now) {
      var s = env.state();
      if (!s || !Array.isArray(s.nations)) return false;
      var L = ensureLayout(W, H, dpr), tok = env.tok(), still = env.reduced();
      var dt = R.lastNow ? clamp((now - R.lastNow) / 1000, 0, 0.1) : 0;
      R.lastNow = now;
      var g = R.fctx, cfgW = (env.config() && env.config().world) || {};
      var cid2c = {}, nById = {};
      s.nations.forEach(function (n) { nById[n.id] = n; (n.citizens || []).forEach(function (c) { cid2c[c.id] = c; }); });

      // simulate
      if (!still && dt > 0) {
        for (var id in R.agents) {
          var ag = R.agents[id];
          if (ag.travel) { if (ag.travel.phase !== 'boat') stepTravel(ag, dt, now); continue; }
          var n0 = nById[ag.nid];
          if (!n0 || n0.alive === false) continue;
          stepAgent(ag, dt, cid2c[id], n0);
        }
        stepBoats(dt);
      }

      // ---- world frame (1 px = 1 art px)
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, L.w, L.h);
      // water marks in the page's water token
      g.fillStyle = tok.water;
      var rp = ripples(L, tok), tt = still ? 0 : now / 1000;
      g.globalAlpha = 0.45;
      rp.forEach(function (p) {
        var x = Math.round(p.x + Math.sin(tt * 0.6 + p.ph) * 3), y = Math.round(p.y);
        if (insideAny(L, x, y)) return;
        g.fillRect(x, y, p.w, 1);
        g.fillRect(x + 1, y - 1, Math.max(1, p.w - 2), 1);
      });
      g.globalAlpha = 1;
      // island shadows (token)
      g.fillStyle = tok.shadow;
      g.globalAlpha = 1;
      for (var tid in L.towns) { var tp = L.towns[tid]; g.fillRect(tp.x + 6, tp.y + 10, TOWN_W - 4, TOWN_H - 6); }
      if (L.commons && cfgW.commons !== false) g.fillRect(L.commons.x + 5, L.commons.y + 8, L.commons.w - 4, L.commons.h - 4);
      g.globalAlpha = 1;

      // commons
      var comRatio = 1;
      if (s.commons) { var cap = num(s.commons.capacity, 100); comRatio = clamp(cap > 0 ? num(s.commons.stock, cap) / cap : 0, 0, 1); }
      if (L.commons && cfgW.commons !== false) drawCommons(g, L.commons, comRatio, now);

      // grounds
      var list = [];
      s.nations.forEach(function (n) {
        var T = R.towns[n.id], P = L.towns[n.id];
        if (!T || !P) return;
        var dead = n.alive === false;
        if (dead && !T.groundGrey) T.groundGrey = greyCopy(T.ground);
        g.drawImage(dead ? T.groundGrey : T.ground, P.x, P.ly);
        var img = dead ? greyImg() : IMG;
        var m = n.metrics || {};
        var shortage = num(m.shortage, 0) > 15;
        T.items.forEach(function (it) {
          var name = it.anim ? (dead || still ? A.anims[it.spr].frames[0] : animFrame(it.spr, now)) : it.spr;
          list.push({ y: P.ly + it.sortY, f: function () { spr(g, name, P.x + it.x, P.ly + it.y, img); } });
        });
        if (shortage && !dead) {
          [[96, 300], [200, 302], [120, 186], [60, 312]].forEach(function (p) { list.push({ y: P.ly + p[1], f: function () { spr(g, 'prop.litter', P.x + p[0], P.ly + p[1]); } }); });
        }
        if (dead) {
          [[100, 150], [232, 150], [40, 290], [180, 290], [150, 200]].forEach(function (p, i) {
            list.push({ y: P.ly + p[1] + 1, f: function () { spr(g, still ? A.anims['fx.fire'].frames[0] : animFrame('fx.fire', now, i * 0.37), P.x + p[0], P.ly + p[1]); } });
          });
          return;
        }
        // governor at the hall door
        var gov = n.governor || {};
        if (gov.inOffice !== false) {
          var gk = GOV_SPRITE[gov.type] || 'gper';
          var gx = P.x + 144, gy = P.ly + 162;
          if (gov.type === 'aligned_ai') list.push({ y: P.ly + 150, f: function () { spr(g, still ? A.anims['prop.server'].frames[0] : animFrame('prop.server', now), P.x + 176, P.ly + 152); } });
          list.push({ y: gy, f: function () {
            spr(g, still ? 'ch.' + gk + '.idle.down#0' : animFrame('ch.' + gk + '.idle.down', now), gx, gy);
          }, top: function () {
            var lg = R.lastGov[n.id], emo = EMO_MOOD[gov.mood] || 'emo.note';
            if (lg && lg.bribeAt && now - lg.bribeAt < 5000) emo = 'emo.gold';
            var cyc = still ? 0 : ((now + hash(n.id) % 1000) % 5200);
            if (cyc < 3400) drawEmote(g, emo, gx, gy - 31, now);
          } });
        }
      });

      // citizens
      var labels = [], me = env.myUserId();
      for (var aid in R.agents) {
        (function (ag) {
          if (ag.travel && ag.travel.phase === 'boat') return;
          var P = L.towns[ag.nid], n = nById[ag.nid];
          if (!P || !n || n.alive === false) return;
          if (ag.inside && !ag.travel) return;
          var c = cid2c[ag.cid] || {};
          var x = P.x + ag.x, y = P.ly + ag.y;
          var anim = 'ch.' + ag.key + '.' + (ag.moving && !still ? 'walk' : 'idle') + '.' + ag.dir;
          if (!A.anims[anim]) anim = 'ch.w1.idle.down';
          var ph = (hash(ag.cid) % 100) / 100;
          var name = still ? A.anims[anim].frames[0] : animFrame(anim, now * ((num(c.mood, 0.6) < 0.3) ? 0.7 : 1), ph);
          var item = { y: y, f: function () {
            if (c.isFollower) {
              var mine = me && c.ownerId === me;
              g.fillStyle = mine ? tok.signal : tok.text;
              g.globalAlpha = 0.9;
              g.fillRect(Math.round(x) - 6, Math.round(y) - 1, 12, 1);
              g.fillRect(Math.round(x) - 7, Math.round(y), 14, 1);
              g.fillRect(Math.round(x) - 6, Math.round(y) + 1, 12, 1);
              g.globalAlpha = 1;
            }
            spr(g, name, x, y);
            if (c.cls === 'elite') { g.fillStyle = tok.owner; g.fillRect(Math.round(x) - 1, Math.round(y) - 31, 2, 2); }
          } };
          // emotes
          var e = null, cyc = still ? 0 : (now / 1000 + ph * 7) % 7;
          if (c.protesting) e = cyc < 3.5 ? (ph < 0.5 ? 'emo.angry' : 'emo.alarm') : null;
          else if (c.hidingIncome && cyc > 5.2) e = 'emo.cash';
          else if (num(c.mood, 0.6) < 0.25 && cyc < 2.4) e = 'emo.tear';
          else if (R.crisis[ag.nid] && now - R.crisis[ag.nid] < 3500 && ph < 0.12) e = 'emo.bang';
          if (still && c.protesting) e = 'emo.angry';
          if (e) item.top = function () { drawEmote(g, e, x, y - 31, now + ph * 1000); };
          list.push(item);
          if (c.isFollower) labels.push({ x: x, y: y - 34, name: c.name || 'Citizen', mine: me && c.ownerId === me });
        })(R.agents[aid]);
      }
      // boats
      R.boats.forEach(function (b) {
        list.push({ y: b.y + 8, f: function () {
          var an = b.dir === 'R' ? 'fx.boatR' : 'fx.boatL';
          spr(g, still ? A.anims[an].frames[0] : animFrame(an, now), b.x, b.y);
          // passenger: upper body above the gunwale
          var key = 'ch.' + b.ag.key + '.idle.' + (b.dir === 'R' ? 'right' : 'left') + '#0', f = A.frames[key];
          if (f) g.drawImage(IMG, f[0], f[1], 16, 22, Math.round(b.x - 8 + (b.dir === 'R' ? -6 : 6)), Math.round(b.y - 22), 16, 22);
        } });
      });
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
        [[144, 120, 0], [70, 250, 300], [220, 240, 520], [150, 300, 800], [240, 110, 1000]].forEach(function (b) {
          var tb = t - b[2];
          if (tb < 0) return;
          var an = A.anims['fx.boom'], k = Math.floor(tb / 1000 * an.fps);
          if (k < an.frames.length) spr(g, an.frames[k], P.x + b[0], P.ly + b[1]);
        });
      });
      R.fx = keepFx;

      // ---- blit to screen: whole-number scale, whole device px offsets, no smoothing
      camera(L, now, still);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = tok.bg;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.fillStyle = tok.water;
      ctx.globalAlpha = 0.13;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.globalAlpha = 1;
      var sc = L.s;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(R.frame, 0, 0, L.w, L.h, L.ox, L.oy, L.w * sc, L.h * sc);
      var ds = ctx.canvas.dataset;
      if (ds && (ds.pxScale !== String(sc) || ds.pxMode !== L.mode)) { ds.pxScale = String(sc); ds.pxMode = L.mode; }
      // strike flash
      R.fx.forEach(function (fx) {
        var t = now - fx.t0;
        if (t < 700) { ctx.globalAlpha = 0.55 * (1 - t / 700); ctx.fillStyle = tok.text; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.globalAlpha = 1; }
      });

      // ---- overlays in CSS px
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      function toCss(wx, wy) { return [(L.ox + wx * sc) / dpr, (L.oy + wy * sc) / dpr]; }
      function cssRect(x, y, w, h) { var a = toCss(x, y); return [a[0], a[1], a[0] + w * sc / dpr, a[1] + h * sc / dpr]; }
      function shown(q) {
        var ix = Math.max(0, Math.min(q[2], W) - Math.max(q[0], 0)), iy = Math.max(0, Math.min(q[3], H) - Math.max(q[1], 0));
        return ix * iy / Math.max(1, (q[2] - q[0]) * (q[3] - q[1]));
      }
      var k = sc / dpr, framed = L.mode !== 'fit';
      var showCommons = !!(L.commons && cfgW.commons !== false);
      // which towns are on screen (framed modes only; 'fit' shows all)
      var onScreen = {}, chips = [], avoid = [];
      s.nations.forEach(function (n) {
        var P = L.towns[n.id];
        if (P) onScreen[n.id] = !framed || shown(cssRect(P.x, P.y, TOWN_W, TOWN_H)) >= 0.5;
      });
      // labels first (measured), so the dial and the edge chips can keep clear of them
      var labelBoxes = [];
      s.nations.forEach(function (n, i) {
        var P = L.towns[n.id];
        if (!P || !onScreen[n.id]) return;
        var lb = measureLabel(ctx, n, toCss(P.x + TOWN_W / 2, P.y), W, H, framed, n.id === L.hero);
        labelBoxes.push({ n: n, i: i, b: lb });
        avoid.push([lb.x - 4, lb.y - 4, lb.x + lb.w + 4, lb.y + lb.h + 4]);
      });
      var D = cfgW.escalation ? dialSpot(L, W, H, dpr, framed ? avoid : null) : null;
      if (D) avoid.push([D.x - D.r - 6, D.y - D.r - 8, D.x + D.r + 6, D.y + 34]);
      var stamp = L.mode !== 'focus', stampText = 'YEAR ' + num(s.year, 0) + ' · ROUND ' + num(s.round, 0);
      if (stamp && framed) { ctx.font = '500 10px "IBM Plex Mono", monospace'; avoid.push([4, H - 24, 18 + ctx.measureText(stampText).width, H]); }
      var comRect = showCommons ? cssRect(L.commons.x, L.commons.y, L.commons.w, L.commons.h) : null;
      var comOn = showCommons && (!framed || shown(comRect) >= 0.5);
      // edge chips for towns (and the commons) out of frame
      if (framed) {
        var want = [];
        s.nations.forEach(function (n, i) {
          var P = L.towns[n.id];
          if (!P || onScreen[n.id]) return;
          var c = toCss(P.x + TOWN_W / 2, P.y + TOWN_H / 2), m = n.metrics || {}, st = '';
          if (n.alive === false) st = 'FALLEN';
          else if (num(m.protestRate, 0) >= 8) st = 'PROTESTS ' + Math.round(m.protestRate) + '%';
          want.push({ id: n.id, name: n.name || n.id, status: st, tint: n.alive === false ? tok.crit : tok.tints[i % 5], hot: !!st, tx: c[0], ty: c[1],
            d: Math.hypot(c[0] - W / 2, c[1] - H / 2) });
        });
        // nearest first, so the town just out of frame gets the spot straight towards it
        want.sort(function (a, b) { return a.d - b.d || (a.id < b.id ? -1 : 1); });
        want.forEach(function (c) { chips.push(placeChip(ctx, c, W, H, avoid)); });
        if (showCommons && !comOn) {
          var cc = toCss(L.commons.x + L.commons.w / 2, L.commons.y + L.commons.h / 2);
          chips.push(placeChip(ctx, { id: '__commons', name: 'Commons ' + Math.round(comRatio * 100) + '%', status: '', tint: comRatio < 0.25 ? tok.crit : tok.line2, tx: cc[0], ty: cc[1] }, W, H, avoid));
        }
      }
      var chipAt = {};
      chips.forEach(function (c) { chipAt[c.id] = c; });

      // tension arcs reuse the vector renderer with island geometry; an out-of-frame town is its chip
      var LV = { nations: {}, gx: 0, gy: 0 };
      var cnt = 0;
      s.nations.forEach(function (n) {
        var P = L.towns[n.id];
        if (!P) return;
        var c0 = toCss(P.x + TOWN_W / 2, P.y + TOWN_H * 0.45), R0 = TOWN_W * 0.3 * k;
        if (chipAt[n.id]) { c0 = [chipAt[n.id].cx, chipAt[n.id].cy]; R0 = 9; }
        LV.nations[n.id] = { x: c0[0], y: c0[1], R: R0, i: cnt };
        LV.gx += c0[0]; LV.gy += c0[1]; cnt++;
      });
      LV.gx /= Math.max(1, cnt); LV.gy /= Math.max(1, cnt) - 0.001;
      LV.gy += 1;
      var tens = s;
      if (framed && s.tension) {
        // an arc between two towns that are both out of frame would only cross the view
        tens = { tension: {} };
        Object.keys(s.tension).forEach(function (key) { var ids = key.split('|'); if (onScreen[ids[0]] || onScreen[ids[1]]) tens.tension[key] = s.tension[key]; });
      }
      try { env.vector.drawTension(tens, LV, now, still); } catch (e) { if (!R.warned) { R.warned = 1; console.warn("[pixelmap] tension", e); } }

      // labels
      labelBoxes.forEach(function (q) { drawLabel(ctx, q.n, q.b, tok, tok.tints[q.i % 5]); });
      if (comOn) {
        var cp = toCss(L.commons.x + L.commons.w / 2, L.commons.y + L.commons.h);
        ctx.font = '600 9.5px "IBM Plex Mono", monospace';
        var ct = 'COMMONS ' + Math.round(comRatio * 100) + '%';
        var cw = ctx.measureText(ct).width + 10;
        if (cp[1] + 19 > H) {
          // no room below: beside the islet, in the water
          var side = toCss(L.commons.x + L.commons.w, L.commons.y + L.commons.h / 2);
          cp = [side[0] + 8 + cw / 2, side[1] - 9];
        }
        ctx.globalAlpha = 0.9; ctx.fillStyle = tok.surface; rr(ctx, cp[0] - cw / 2, cp[1] + 2, cw, 15, 4); ctx.fill(); ctx.globalAlpha = 1;
        ctx.fillStyle = comRatio < 0.25 ? tok.crit : tok.dim;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(ct, cp[0], cp[1] + 10);
      }
      // follower labels
      labels.sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      labels.slice(0, 10).forEach(function (l) {
        var p = toCss(l.x, l.y), w = ctx.measureText(l.name).width + 10;
        ctx.globalAlpha = 0.92; ctx.fillStyle = tok.surface; rr(ctx, p[0] - w / 2, p[1] - 15, w, 14, 3); ctx.fill();
        ctx.globalAlpha = 1; ctx.lineWidth = 1; ctx.strokeStyle = l.mine ? tok.signal : tok.line2; ctx.stroke();
        ctx.fillStyle = l.mine ? tok.signal : tok.text; ctx.fillText(l.name, p[0], p[1] - 7.5);
      });
      // pings: an outline around the island, or around its chip when it is out of frame
      var keepP = [];
      R.pings.forEach(function (p) {
        var f = (now - p.t0) / 1800, P = L.towns[p.nid];
        if (f >= 1 || !P || still) return;
        keepP.push(p);
        ctx.globalAlpha = 0.8 * (1 - f); ctx.strokeStyle = tok.signal; ctx.lineWidth = 2;
        var ch = chipAt[p.nid];
        if (ch) { rr(ctx, ch.x - 3 - f * 6, ch.y - 3 - f * 6, ch.w + 6 + f * 12, ch.h + 6 + f * 12, 8); }
        else {
          var a = toCss(P.x - 4 - f * 8, P.y - 4 - f * 8), b = toCss(P.x + TOWN_W + 4 + f * 8, P.y + TOWN_H + 4 + f * 8);
          rr(ctx, a[0], a[1], b[0] - a[0], b[1] - a[1], 8);
        }
        ctx.stroke(); ctx.globalAlpha = 1;
      });
      R.pings = keepP;
      chips.forEach(function (c) { drawChip(ctx, c, tok); });
      if (D) {
        if (framed) { ctx.globalAlpha = 0.85; ctx.fillStyle = tok.surface; rr(ctx, D.x - D.r - 7, D.y - D.r - 7, D.r * 2 + 14, D.r + 40, 8); ctx.fill(); ctx.globalAlpha = 1; }
        try { env.vector.drawDial(num(s.doomsday, 0), D); } catch (e) { /* ignore */ }
      }
      if (stamp) {
        ctx.font = '500 10px "IBM Plex Mono", monospace';
        if (framed) { ctx.globalAlpha = 0.85; ctx.fillStyle = tok.surface; rr(ctx, 6, H - 23, ctx.measureText(stampText).width + 12, 18, 5); ctx.fill(); ctx.globalAlpha = 1; }
        ctx.fillStyle = tok.faint; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(stampText, 12, H - 10);
      }
      return true;
    };

    // ---------------------------------------------------------------- edge chips (out-of-frame towns)
    function overlaps(q, list) {
      for (var i = 0; i < list.length; i++) { var o = list[i]; if (q[0] < o[2] && q[2] > o[0] && q[1] < o[3] && q[3] > o[1]) return true; }
      return false;
    }
    function placeChip(ctx, c, W, H, avoid) {
      ctx.font = '700 11px "IBM Plex Mono", monospace';
      var tw = ctx.measureText(c.name.toUpperCase()).width;
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      var sw = c.status ? ctx.measureText(c.status).width + 8 : 0;
      var w = Math.min(W - 12, Math.ceil(tw + sw + 30)), h = 22, m = 6;
      // from the view centre towards the town, stopped at the edge
      var cx = W / 2, cy = H / 2, dx = c.tx - cx, dy = c.ty - cy;
      var hx = Math.max(1, W / 2 - m - w / 2), hy = Math.max(1, H / 2 - m - h / 2);
      var t = Math.min(dx ? hx / Math.abs(dx) : Infinity, dy ? hy / Math.abs(dy) : Infinity);
      if (!isFinite(t)) t = 0;
      var px = cx + dx * t, py = cy + dy * t, horiz = Math.abs(dy) * hx >= Math.abs(dx) * hy;   // hits top or bottom
      var best = null;
      for (var i = 0; i < 14 && !best; i++) {
        var step = (i % 2 ? 1 : -1) * Math.ceil(i / 2), qx = px, qy = py;
        if (horiz) qx = clamp(px + step * (w / 2 + 6) * (dx >= 0 ? -1 : 1), m + w / 2, W - m - w / 2);
        else qy = clamp(py + step * (h + 6) * (dy >= 0 ? -1 : 1), m + h / 2, H - m - h / 2);
        var q = [qx - w / 2, qy - h / 2, qx + w / 2, qy + h / 2];
        if (!overlaps(q, avoid)) best = [qx, qy];
      }
      if (!best) best = [px, py];
      var out = { id: c.id, name: c.name, status: c.status, tint: c.tint, hot: c.hot, x: best[0] - w / 2, y: best[1] - h / 2, w: w, h: h,
        cx: best[0], cy: best[1], ang: Math.atan2(c.ty - best[1], c.tx - best[0]) };
      avoid.push([out.x - 4, out.y - 4, out.x + w + 4, out.y + h + 4]);
      return out;
    }
    function drawChip(ctx, c, tok) {
      ctx.save();
      ctx.globalAlpha = 0.94; ctx.fillStyle = tok.surface; rr(ctx, c.x, c.y, c.w, c.h, 6); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = c.tint; ctx.lineWidth = 1.2; ctx.stroke();
      // arrow towards the town
      ctx.translate(c.x + 12, c.cy); ctx.rotate(c.ang);
      ctx.strokeStyle = c.tint; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(-5.5, 0); ctx.lineTo(5, 0); ctx.moveTo(1, -4); ctx.lineTo(5, 0); ctx.lineTo(1, 4); ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = '700 11px "IBM Plex Mono", monospace'; ctx.fillStyle = tok.label;
      var name = c.name.toUpperCase(), x = c.x + 22, maxW = c.w - 28;
      var nw = ctx.measureText(name).width;
      ctx.fillText(name, x, c.cy + 0.5, maxW);
      if (c.status) {
        ctx.font = '600 9px "IBM Plex Mono", monospace'; ctx.fillStyle = tok.crit;
        ctx.fillText(c.status, x + Math.min(nw, maxW) + 8, c.cy + 0.5, Math.max(10, maxW - nw - 8));
      }
      ctx.restore();
    }

    function drawEmote(g, name, x, y, now) {
      var an = A.anims[name];
      if (an) {
        // animated emotes play once per cycle, then hold the last frame
        var total = (an.durs || []).reduce(function (a, b) { return a + b; }, 0) || an.frames.length * 120;
        var t = now % (total + 900), acc = 0, k = an.frames.length - 1;
        if (an.durs) { for (var i = 0; i < an.durs.length; i++) { acc += an.durs[i]; if (t < acc) { k = i; break; } } }
        spr(g, an.frames[k], x, y);
      } else spr(g, name, x, y);
    }

    function labelParts(n, tok) {
      var parts = [];
      if (n.alive === false) parts.push([tok.crit, 'FALLEN']);
      else {
        parts.push([tok.dim, env.systemLabel(n.system).toUpperCase()]);
        var m = n.metrics || {};
        if (num(m.protestRate, 0) >= 8) parts.push([tok.crit, 'PROTESTS ' + Math.round(m.protestRate) + '%']);
        if (num(m.shortage, 0) > 15) parts.push([tok.warn, 'SHORTAGES']);
        if (n.governor && n.governor.inOffice === false) parts.push([tok.warn, 'NO GOVERNOR']);
      }
      return parts;
    }
    // label box in CSS px above the island; kept inside the stage when the view is framed by a camera
    function measureLabel(ctx, n, p, W, H, framed, hero) {
      var tok = env.tok(), name = n.name || n.id, parts = labelParts(n, tok);
      ctx.save();
      var fs = hero ? (W < 360 ? 14 : 16) : (W < 520 ? 12.5 : 14.5);
      ctx.font = '700 ' + fs + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
      var nw = ctx.measureText(name).width;
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      var sep = '  ', sw = 0;
      parts.forEach(function (q, i) { sw += ctx.measureText(q[1]).width + (i ? ctx.measureText(sep).width : 0); });
      ctx.restore();
      var w = Math.max(nw, sw) + 16, h = fs + 18, x = clamp(p[0] - w / 2, 2, W - w - 2), y = p[1] - h - 2;
      if (framed) y = clamp(y, 4, Math.max(4, H - h - 4));
      return { x: x, y: y, w: w, h: h, fs: fs, nw: nw, sw: sw, sep: sep, name: name, parts: parts };
    }
    function drawLabel(ctx, n, b, tok, tint) {
      var dead = n.alive === false, x = b.x, y = b.y, w = b.w, h = b.h, fs = b.fs, nw = b.nw, sw = b.sw, sep = b.sep;
      ctx.save();
      ctx.globalAlpha = 0.9; ctx.fillStyle = tok.surface; rr(ctx, x, y, w, h, 6); ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = dead ? tok.crit : tint; ctx.lineWidth = 1; ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = '700 ' + fs + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
      ctx.fillStyle = dead ? tok.faint : tok.label;
      var cx = x + w / 2;
      ctx.fillText(b.name, cx, y + fs + 2);
      if (dead) { ctx.strokeStyle = tok.crit; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(cx - nw / 2 - 2, y + fs * 0.7); ctx.lineTo(cx + nw / 2 + 2, y + fs * 0.7); ctx.stroke(); }
      ctx.font = '500 9px "IBM Plex Mono", monospace';
      ctx.textAlign = 'left';
      var tx = cx - sw / 2;
      b.parts.forEach(function (q, i) {
        if (i) tx += ctx.measureText(sep).width;
        ctx.fillStyle = q[0]; ctx.fillText(q[1], tx, y + h - 5);
        tx += ctx.measureText(q[1]).width;
      });
      ctx.restore();
    }

    function dialSpot(L, W, H, dpr, avoid) {
      var r = avoid ? 20 : W < 480 ? 22 : 28;
      var cands = [[W - r - 14, r + 16], [W - r - 14, H - 40], [r + 14, H - 52], [r + 30, r + 16]];
      // framed views: also the water beside the framed island
      if (avoid) cands.push([W - r - 9, Math.round(H * 0.42)], [W - r - 9, Math.round(H * 0.62)], [r + 9, Math.round(H * 0.42)], [r + 9, Math.round(H * 0.62)]);
      var rects = [];
      for (var id in L.towns) {
        var t = L.towns[id];
        rects.push([(L.ox + t.x * L.s) / dpr, (L.oy + (t.y - 30) * L.s) / dpr, (L.ox + (t.x + TOWN_W) * L.s) / dpr, (L.oy + (t.y + TOWN_H) * L.s) / dpr]);
      }
      if (avoid) rects = rects.concat(avoid);
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
