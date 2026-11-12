/* AI Nation: UI layer. Reads window.GovSim (engine) and window.GovStore (participation).
 * Rendering reads world.state only. No frameworks, no external requests.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- utils
  var G = window.GovSim || null;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var PROPS = { value: 1, checked: 1, hidden: 1, disabled: 1, selected: 1, htmlFor: 1, type: 1, min: 1, max: 1, step: 1, tabIndex: 1 };

  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      for (var k in props) {
        var v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (k === 'style') e.style.cssText = v;
        else if (PROPS[k]) e[k] = v;
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (var i = 2; i < arguments.length; i++) append(e, arguments[i]);
    return e;
  }
  function append(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { append(e, x); }); return; }
    e.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function clear(e) { while (e && e.firstChild) e.removeChild(e.firstChild); return e; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
  function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function humanize(id) {
    if (!id) return '';
    var s = String(id).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function hash(str) {
    var x = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 16777619); }
    return x >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem('aination.ui.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('aination.ui.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  function safe(fn, label) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { if (window.console) console.warn('[aination ui] ' + (label || 'error'), e); }
    };
  }
  var reduceMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function reduced() { return !!(reduceMQ && reduceMQ.matches); }

  // ---------------------------------------------------------------- engine metadata (read at runtime)
  var META = { policies: [], policyById: {}, systems: {}, scenarios: [], metrics: [], metricById: {}, govTypes: [], version: '?' };
  function loadMeta() {
    if (!G) return;
    META.policies = Array.isArray(G.POLICIES) ? G.POLICIES : [];
    META.policies.forEach(function (p) { META.policyById[p.id] = p; });
    META.systems = G.SYSTEMS || {};
    META.scenarios = Array.isArray(G.SCENARIOS) ? G.SCENARIOS : [];
    META.metrics = Array.isArray(G.METRICS) ? G.METRICS : [];
    META.metrics.forEach(function (m) { META.metricById[m.id] = m; });
    META.govTypes = Array.isArray(G.GOVERNOR_TYPES) ? G.GOVERNOR_TYPES : ['aligned_ai', 'human_persona', 'human_player'];
    META.goals = Array.isArray(G.GOALS) ? G.GOALS : ['welfare', 'growth', 'equality', 'stay_in_power'];
    META.version = G.VERSION || '?';
    META.electionInterval = num(G.ELECTION_INTERVAL, 8);
  }

  var GOV_LABEL = { aligned_ai: 'Aligned AI', human_persona: 'Persona AI', human_player: 'You' };
  var GOAL_LABEL = { welfare: 'Welfare', growth: 'Growth', equality: 'Equality', stay_in_power: 'Stay in power' };
  var SAFEGUARDS = (G && Array.isArray(G.SAFEGUARDS) && G.SAFEGUARDS.length) ? G.SAFEGUARDS : ['charter', 'constitution', 'auditor', 'elections', 'freePress', 'termLimits'];
  var SAFEGUARD_LABEL = { charter: 'Charter', constitution: 'Constitution', auditor: 'Auditor', elections: 'Elections', freePress: 'Free press', termLimits: 'Term limits' };
  var WORLD_LABEL = { commons: 'Shared commons', migration: 'Migration', capitalFlight: 'Capital flight', lobbying: 'Lobbying and bribes', governorSalary: 'Governor salary', escalation: 'Escalation', coups: 'Coups' };
  var NATION_NAMES = ['Aurelia', 'Kestrel Union', 'Veridia', 'Norhaven', 'Sable Coast'];
  var SHOCKS = [['scarcity', 'Scarcity'], ['pandemic', 'Pandemic'], ['boom', 'Boom'], ['border_crisis', 'Border crisis']];
  var CARD_METERS = [
    { id: 'welfare', label: 'Welfare' },
    { id: 'gini', label: 'Inequality' },
    { id: 'corruption', label: 'Corruption' },
    { id: 'trust', label: 'Trust' },
    { id: 'treasury', label: 'Net treasury' }
  ];
  var KEY_METRICS = ['welfare', 'gdp', 'gini', 'poverty', 'unemployment', 'inflation', 'shortage', 'debtRatio', 'corruption', 'trust', 'population', 'emigrated', 'protestRate'];
  var CHART_METRICS = ['welfare', 'gini', 'trust', 'corruption'];

  function metricMeta(id) {
    var m = META.metricById[id];
    if (m) return m;
    if (id === 'treasury') return { id: 'treasury', label: 'Treasury', better: 'up', format: 'money' };
    return { id: id, label: humanize(id), better: null, format: null };
  }
  function metricLabel(id) {
    if (id === 'gini') return 'Inequality';
    return metricMeta(id).label || humanize(id);
  }
  // Format a metric value. Uses METRICS[].format / unit when present, with sensible fallbacks.
  function fmtMetric(id, v) {
    if (typeof v !== 'number' || !isFinite(v)) return '-';
    var m = metricMeta(id), f = m.format, u = m.unit || '';
    if (f === 'pct' || u === '%' || /^%/.test(u)) {
      // The engine reports percentages on a 0-100 scale.
      return (Math.abs(v) < 10 && Math.round(v) !== v ? v.toFixed(1) : Math.round(v)) + '%';
    }
    if (f === 'money' || id === 'treasury') return fmtMoney(v);
    if (f === 'ratio' || u === '0-1') return v.toFixed(2);
    if (f === 'index' || f === 'int') return String(Math.round(v));
    if (f === 'num') return v.toFixed(2) + (/^x/.test(u) ? 'x' : '');
    if (Math.abs(v) >= 100) return String(Math.round(v));
    if (Math.abs(v) >= 10) return v.toFixed(1);
    return v.toFixed(2);
  }
  function fmtMoney(v) {
    var a = Math.abs(v), s = v < 0 ? '-' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(1) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(1) + 'M';
    if (a >= 1e4) return s + Math.round(a / 1e3) + 'k';
    if (a >= 1e3) return s + (a / 1e3).toFixed(1) + 'k';
    if (a >= 100) return s + Math.round(a);
    return s + a.toFixed(1);
  }
  function fmtPolicy(p, v) {
    if (!p) return String(v);
    if (p.kind === 'toggle') return v ? 'On' : 'Off';
    if (typeof v !== 'number') return String(v);
    var step = num(p.step, 1), dec = step < 1 ? Math.min(2, String(step).split('.')[1] ? String(step).split('.')[1].length : 1) : 0;
    var s = v.toFixed(dec), u = p.unit || '';
    if (!u) return s;
    if (u === '%' || u === 'x' || u.charAt(0) === '%') return s + u.replace(/^% /, '% ');
    return s + ' ' + u;
  }
  function policyDefault(nationOrSys, pid) {
    var p = META.policyById[pid];
    var sys = typeof nationOrSys === 'string' ? nationOrSys : nationOrSys && nationOrSys.system;
    var sp = sys && META.systems[sys] && META.systems[sys].policies;
    if (sp && sp[pid] != null) return sp[pid];
    return p ? p.default : null;
  }
  function systemLabel(id) { var s = META.systems[id]; return (s && s.label) || humanize(id); }
  function rangeOf(id, v) {
    var m = metricMeta(id), u = m.unit || '';
    if (typeof m.min === 'number' && typeof m.max === 'number') return [m.min, m.max];
    var r = /^(-?\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(u);
    if (r) return [+r[1], +r[2]];
    if (m.format === 'pct' || /^%/.test(u)) return [0, 100];
    if (m.format === 'ratio') return [0, 1];
    var a = Math.abs(num(v, 1));
    return [0, Math.max(1, a * 2)];
  }

  // ---------------------------------------------------------------- app state
  var S = {
    world: null,
    scenarioId: null,
    playing: true,
    speed: [1, 4, 16].indexOf(LS.get('speed', 1)) >= 0 ? LS.get('speed', 1) : 1,
    tab: LS.get('tab', 'policies'),
    story: false,
    storyNation: LS.get('storyNation', 0),
    timer: null,
    unsub: null,
    tintIdx: {},
    feedCount: 0,
    lastHighlight: null,
    hlTimer: null,
    autoPaused: false,
    polNation: null,
    draft: null,
    draftDirty: false,
    cmp: { nationId: null, policyId: null, value: null, rounds: 50, result: null },
    store: { ready: false, info: null, data: { citizens: [], proposals: [], votes: {}, myVote: null, myCitizen: null, myProposal: null } },
    added: new Set(),
    lastEnactRound: -1,
    treas: {},
    uiQueued: false,
    lastAnnounce: 0
  };

  function W() { return S.world; }
  function st() { return S.world && S.world.state; }
  function nations() { var s = st(); return (s && Array.isArray(s.nations)) ? s.nations : []; }
  function nationById(id) { var ns = nations(); for (var i = 0; i < ns.length; i++) if (ns[i].id === id) return ns[i]; return null; }
  function tintVar(nid) { var i = S.tintIdx[nid]; return 'var(--tint-' + (((i == null ? 0 : i) % 5) + 1) + ')'; }
  function nationName(id) { var n = nationById(id); return n ? n.name : (id || 'World'); }
  function isAlive(n) { return n && n.alive !== false; }
  function hist(n, id) {
    if (!n) return [];
    if (id === 'treasury') return S.treas[n.id] || [];
    var a = n.history && n.history[id];
    return Array.isArray(a) ? a : [];
  }
  function metricVal(n, id) {
    if (!n) return null;
    if (id === 'treasury') return num(n.treasury, 0) - num(n.debt, 0);
    return n.metrics ? num(n.metrics[id], null) : null;
  }

  // ---------------------------------------------------------------- world lifecycle
  function scenarioById(id) { for (var i = 0; i < META.scenarios.length; i++) if (META.scenarios[i].id === id) return META.scenarios[i]; return null; }

  function newWorld(config, scenarioId) {
    if (!G) return;
    stopLoop();
    if (S.world && S.unsub) { try { S.world.off(S.unsub); } catch (e) { /* ignore */ } }
    var w;
    try { w = G.createWorld(clone(config)); }
    catch (e) { console.warn('[aination ui] createWorld failed', e); return; }
    S.world = w;
    S.scenarioId = scenarioId || S.scenarioId;
    S.tintIdx = {};
    nations().forEach(function (n, i) { S.tintIdx[n.id] = i; });
    S.treas = {};
    S.feedCount = 0;
    S.lastHighlight = null;
    S.added = new Set();
    S.lastEnactRound = -1;
    S.draft = clone(w.config);
    S.draftDirty = false;
    S.cmp.result = null;
    if (!nationById(S.polNation)) S.polNation = nations()[0] ? nations()[0].id : null;
    if (S.storyNation >= nations().length) S.storyNation = 0;
    S.unsub = function (ev) { onEvent(ev); };
    try { w.on(S.unsub); } catch (e) { S.unsub = null; }
    clear($('#feed'));
    $('#hlBanner').hidden = true;
    $('#endCard').hidden = true;
    $('#decBanner').hidden = true;
    MAP.resetWorld();
    syncStoreCitizens();
    buildCards();
    renderScenarioHead();
    renderAllTabs();
    renderStoryPick();
    recordTreasury();
    updateUI();
    MAP.onState();
    if (S.playing) startLoop();
  }

  function resetWorld() {
    if (!S.world) return;
    newWorld(S.world.config, S.scenarioId);
  }

  // ---------------------------------------------------------------- loop
  function interval() { return Math.round(900 / S.speed); }
  function startLoop() {
    stopLoop();
    if (!S.world) return;
    var tickFn = function () {
      S.timer = null;
      if (!S.playing) return;
      tick();
      if (S.playing) S.timer = setTimeout(tickFn, interval());
    };
    S.timer = setTimeout(tickFn, interval());
  }
  function stopLoop() { if (S.timer) { clearTimeout(S.timer); S.timer = null; } }
  function setPlaying(p) {
    var s = st();
    if (p && s && s.over) p = false;
    S.playing = !!p;
    if (S.playing) { S.autoPaused = false; startLoop(); } else stopLoop();
    renderTransport();
  }

  function tick() {
    var w = W();
    if (!w) return;
    var s = w.state;
    if (s.over) { setPlaying(false); showEnd(); return; }
    var pend = safePending();
    if (pend.length) { S.autoPaused = true; setPlaying(false); S.autoPaused = true; renderDecisions(); return; }
    var res;
    try { res = w.step(); }
    catch (e) { console.warn('[aination ui] step failed', e); setPlaying(false); return; }
    afterStep(res || {});
  }

  function afterStep(res) {
    if (!S.unsub && Array.isArray(res.events)) res.events.forEach(onEvent);
    recordTreasury();
    maybeEnactLaw();
    MAP.onState();
    scheduleUI();
    if (res.status === 'awaiting' || safePending().length) {
      if (S.playing) { setPlaying(false); S.autoPaused = true; }
      renderDecisions();
      announce('Decision needed. ' + ((safePending()[0] || {}).prompt || ''));
    } else {
      renderDecisions();
    }
    if (res.status === 'over' || (st() && st().over)) { setPlaying(false); showEnd(); }
  }

  function recordTreasury() {
    nations().forEach(function (n) {
      var a = S.treas[n.id] || (S.treas[n.id] = []);
      var r = num(st().round, 0);
      if (a.length <= r) a.push(num(n.treasury, 0) - num(n.debt, 0));
      if (a.length > 400) a.shift();
    });
  }

  function safePending() {
    var w = W();
    if (!w || typeof w.pendingDecisions !== 'function') return [];
    try { var p = w.pendingDecisions(); return Array.isArray(p) ? p : []; } catch (e) { return []; }
  }

  function scheduleUI() {
    if (S.uiQueued) return;
    S.uiQueued = true;
    requestAnimationFrame(function () { S.uiQueued = false; updateUI(); });
  }

  // ---------------------------------------------------------------- events, feed, highlights
  function onEvent(ev) {
    if (!ev) return;
    addFeed(ev);
    if (ev.highlight) showHighlight(ev);
    if (ev.nationId && ev.highlight) MAP.ping(ev.nationId);
  }

  function addFeed(ev) {
    var feed = $('#feed');
    if (!feed) return;
    var sev = clamp(num(ev.severity, 1), 1, 3);
    var li = h('li', { class: 'sev-' + sev + (ev.highlight ? ' hl' : '') },
      h('span', { class: 'r', text: 'R' + num(ev.round, 0) }),
      h('span', { class: 't' }, ev.nationId ? h('i', { class: 'nat', 'aria-hidden': 'true' }) : null, ev.text || humanize(ev.type)));
    if (ev.nationId) li.style.setProperty('--tint', tintVar(ev.nationId));
    li.title = humanize(ev.type) + (ev.nationId ? ' in ' + nationName(ev.nationId) : '');
    feed.insertBefore(li, feed.firstChild);
    while (feed.children.length > 90) feed.removeChild(feed.lastChild);
    S.feedCount++;
  }

  function showHighlight(ev) {
    S.lastHighlight = ev;
    var b = $('#hlBanner');
    $('#hlKicker').textContent = 'Round ' + num(ev.round, 0) + (ev.nationId ? ' · ' + nationName(ev.nationId) : '') + ' · ' + humanize(ev.type);
    $('#hlText').textContent = ev.text || humanize(ev.type);
    b.hidden = false;
    b.classList.remove('is-in');
    void b.offsetWidth;
    b.classList.add('is-in');
    clearTimeout(S.hlTimer);
    S.hlTimer = setTimeout(function () { b.hidden = true; }, 4200);
    announce(ev.text || humanize(ev.type));
    renderStoryCaption();
  }

  function announce(text) {
    var now = Date.now();
    if (now - S.lastAnnounce < 4000) return;
    S.lastAnnounce = now;
    var r = $('#liveRegion');
    if (r) r.textContent = text;
  }

  // ---------------------------------------------------------------- map renderer (canvas)
  var SQ = 0.9;
  var MAP = {
    wrap: null, cv: null, ctx: null, W: 0, H: 0, dpr: 1, tok: null, L: null,
    shapes: {}, units: {}, prevLoc: {}, prevInfo: {}, travellers: [], inFlight: {}, pings: [],
    raf: 0, needs: true,
    init: function () {
      this.wrap = $('#mapWrap');
      this.cv = $('#mapCanvas');
      this.ctx = this.cv.getContext('2d');
      this.readTokens();
      var self = this;
      if (window.ResizeObserver) new ResizeObserver(function () { self.resize(); }).observe(this.wrap);
      window.addEventListener('resize', function () { self.resize(); });
      this.resize();
      this.loop = this.loop.bind(this);
      this.raf = requestAnimationFrame(this.loop);
    },
    readTokens: function () {
      var cs = getComputedStyle(document.documentElement);
      var g = function (n, d) { var v = cs.getPropertyValue(n).trim(); return v || d; };
      this.tok = {
        bg: g('--map-bg', '#0b1420'), grid: g('--map-grid', '#152133'), gridS: g('--map-grid-strong', '#1d2c44'),
        label: g('--map-label', '#dfe6ef'), dim: g('--text-dim', '#9eabbd'), faint: g('--text-faint', '#6a7a91'),
        text: g('--text', '#e7ecf3'), surface: g('--surface', '#101a29'),
        tints: [1, 2, 3, 4, 5].map(function (i) { return g('--tint-' + i, '#888'); }),
        worker: g('--dot-worker', '#ccc'), owner: g('--dot-owner', '#eb7'), elite: g('--dot-elite', '#fff'), dead: g('--dot-dead', '#555'),
        good: g('--good', '#5b8'), warn: g('--warn', '#da5'), crit: g('--crit', '#e65'), signal: g('--signal', '#f97'), water: g('--water', '#47a')
      };
      this.needs = true;
    },
    resize: function () {
      var r = this.wrap.getBoundingClientRect();
      var W = Math.max(10, Math.round(r.width)), H = Math.max(10, Math.round(r.height));
      var dpr = Math.min(2.5, window.devicePixelRatio || 1);
      if (W === this.W && H === this.H && dpr === this.dpr) return;
      this.W = W; this.H = H; this.dpr = dpr;
      this.cv.width = Math.round(W * dpr);
      this.cv.height = Math.round(H * dpr);
      this.L = null;
      this.needs = true;
      if (reduced()) this.draw(performance.now());
    },
    resetWorld: function () {
      this.L = null; this.units = {}; this.prevLoc = {}; this.prevInfo = {}; this.travellers = []; this.inFlight = {}; this.pings = [];
      this.basePop = {};
      var cfgN = (W() && W().config && W().config.nations) || [];
      var self = this;
      nations().forEach(function (n, i) {
        var c = cfgN[i] || {};
        self.basePop[n.id] = num(c.population, (n.citizens || []).length || 60);
      });
      this.snapshotLocs(false);
      this.needs = true;
    },
    onState: function () {
      this.snapshotLocs(!reduced());
      this.needs = true;
      if (reduced()) this.draw(performance.now());
    },
    ping: function (nid) {
      var now = performance.now();
      if (this.pings.some(function (p) { return p.nid === nid && now - p.t0 < 1800; })) return;
      this.pings.push({ nid: nid, t0: now });
      if (this.pings.length > 5) this.pings.shift();
    },
    shape: function (id) {
      var s = this.shapes[id];
      if (s) return s;
      var r = rng(hash('territory:' + id)), harm = [];
      for (var k = 2; k <= 6; k++) harm.push([k, (0.12 / (k * 0.75)) * (0.45 + r() * 0.7), r() * Math.PI * 2]);
      harm.push([9, 0.02, r() * 6.283], [14, 0.012, r() * 6.283], [21, 0.007, r() * 6.283]);
      var N = 160, arr = new Float32Array(N), mean = 0;
      for (var i = 0; i < N; i++) {
        var th = i / N * Math.PI * 2, v = 1;
        for (var j = 0; j < harm.length; j++) v += harm[j][1] * Math.sin(harm[j][0] * th + harm[j][2]);
        arr[i] = v; mean += v;
      }
      mean /= N;
      for (i = 0; i < N; i++) arr[i] /= mean;
      this.shapes[id] = arr;
      return arr;
    },
    shapeAt: function (s, th) {
      var N = s.length, t = ((th % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      var x = t / (Math.PI * 2) * N, i0 = Math.floor(x) % N, f = x - Math.floor(x);
      return s[i0] * (1 - f) + s[(i0 + 1) % N] * f;
    },
    unit: function (nid, cid) {
      var key = nid + '|' + cid, u = this.units[key];
      if (u) return u;
      var r = rng(hash(cid + '@' + nid));
      var th = r() * Math.PI * 2, q = r();
      var rr = (0.06 + 0.86 * Math.sqrt(q)) * this.shapeAt(this.shape(nid), th) * 0.82;
      u = [Math.cos(th) * rr, Math.sin(th) * rr * SQ];
      this.units[key] = u;
      return u;
    },
    layout: function () {
      if (this.L) return this.L;
      var ns = nations(), n = ns.length, Wd = this.W, Ht = this.H, asp = Wd / Ht;
      var cx = Wd / 2;
      // Try a few centre heights and spreads; keep the arrangement that gives the largest territories.
      function arrange(cyF, rxF, ryF) {
        var cy = Ht * cyF, pts = [];
        if (n === 1) pts = [[cx, cy]];
        else if (n === 2) pts = asp > 1.15 ? [[Wd * (0.5 - rxF * 0.7), cy], [Wd * (0.5 + rxF * 0.7), cy]] : [[Wd * 0.33, cy - Ht * ryF], [Wd * 0.67, cy + Ht * ryF]];
        else {
          var angs = n === 4 ? [215, 325, 35, 145] : Array.from({ length: n }, function (_, i) { return 90 + 360 / n * (i + 1); });
          pts = angs.map(function (a) { var t = a * Math.PI / 180; return [cx + Wd * rxF * Math.cos(t), cy + Ht * ryF * Math.sin(t)]; });
        }
        var R = Math.min(Wd, Ht) * 0.3, dmin = Infinity;
        for (var i = 0; i < pts.length; i++) for (var j = i + 1; j < pts.length; j++) dmin = Math.min(dmin, Math.hypot(pts[i][0] - pts[j][0], (pts[i][1] - pts[j][1]) / SQ));
        if (isFinite(dmin)) R = Math.min(R, dmin * 0.37);
        R = Math.min(R, Ht * 0.24, Wd * 0.17);
        var lowY = n >= 3 ? cy + Ht * 0.03 : (n === 2 && asp <= 1.15 ? cy : Infinity);
        var below = pts.map(function (p) { return p[1] > lowY; });
        pts.forEach(function (p, i) {
          var topRoom = below[i] ? 12 : 40, botRoom = below[i] ? 42 : 14;
          R = Math.min(R, (p[1] - topRoom) / (1.12 * SQ), (Ht - p[1] - botRoom) / (1.12 * SQ), (p[0] - 8) / 1.15, (Wd - p[0] - 8) / 1.15);
        });
        return { pts: pts, below: below, R: R };
      }
      var best = null;
      [0.44, 0.47, 0.5, 0.53].forEach(function (cyF) {
        [0.26, 0.29, 0.32, 0.35].forEach(function (rxF) {
          [0.16, 0.19, 0.22, 0.25, 0.28].forEach(function (ryF) {
            var c = arrange(cyF, rxF, ryF);
            if (!best || c.R > best.R + 0.5) best = c;
          });
        });
      });
      var pts = best.pts, below = best.below, R = Math.max(best.R, 20);
      var meanPop = 0, self = this;
      ns.forEach(function (nn) { meanPop += num(self.basePop && self.basePop[nn.id], 60); });
      meanPop = meanPop / Math.max(1, n);
      var L = { nations: {}, R: R };
      ns.forEach(function (nn, i) {
        var pop = num(self.basePop && self.basePop[nn.id], meanPop);
        var sc = clamp(Math.sqrt(pop / Math.max(1, meanPop)), 0.82, 1.08);
        L.nations[nn.id] = { x: pts[i][0], y: pts[i][1], R: R * sc, i: i, below: below[i] };
      });
      L.gx = 0; L.gy = 0;
      ns.forEach(function (nn) { L.gx += L.nations[nn.id].x; L.gy += L.nations[nn.id].y; });
      L.gx /= Math.max(1, n); L.gy /= Math.max(1, n);
      // doomsday dial: the clearest corner, away from territories and their labels
      var dr = Wd < 480 ? 24 : 30, corners = [[Wd - dr - 16, dr + 18, 0], [Wd - dr - 16, Ht - 36, 6], [dr + 34, dr + 18, 10], [dr + 16, Ht - 50, 14]];
      var bestC = null, bestCd = -Infinity;
      corners.forEach(function (c) {
        var d = Infinity;
        ns.forEach(function (nn) {
          var q = L.nations[nn.id], ly = q.below ? q.y + q.R * SQ * 1.1 + 24 : q.y - q.R * SQ * 1.1 - 16;
          d = Math.min(d, Math.hypot(q.x - c[0], (q.y - c[1]) / SQ) - q.R * 1.12, Math.hypot((q.x - c[0]) * 0.55, ly - c[1]) - 10);
        });
        d -= c[2];
        if (d > bestCd) { bestCd = d; bestC = c; }
      });
      L.dial = { x: bestC[0], y: bestC[1], r: dr };
      // commons: the open spot farthest from every territory edge
      var best = null, bestD = -Infinity;
      for (var gx = 1; gx < 24; gx++) for (var gy = 2; gy < 14; gy++) {
        var x = Wd * gx / 24, y = Ht * gy / 15, d = Infinity;
        ns.forEach(function (nn) { var q = L.nations[nn.id]; d = Math.min(d, Math.hypot(q.x - x, (q.y - y) / SQ) - q.R * 1.12); });
        d = Math.min(d, x - 10, Wd - x - 10, y - 30, Ht - y - 24);
        if ((W() && W().config && W().config.world || {}).escalation) d = Math.min(d, Math.hypot(x - L.dial.x, y - L.dial.y) - L.dial.r - 28);
        // keep clear of the tension arcs, which run between every pair of territories
        for (var a = 0; a < ns.length; a++) for (var b2 = a + 1; b2 < ns.length; b2++) {
          var A = L.nations[ns[a].id], B = L.nations[ns[b2].id];
          var g = arcGeom(A, B, L), prev = g.a;
          for (var t = 0.1; t <= 1.001; t += 0.1) { var q2 = quad(g.a, g.c, g.b, t); d = Math.min(d, segDist(x, y, prev[0], prev[1], q2[0], q2[1]) - 14); prev = q2; }
        }
        d -= Math.hypot(x - cx, y - Ht * 0.5) * 0.08;
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
      L.commons = best ? { x: best[0], y: best[1], r: clamp(bestD * 0.75, 12, R * 0.42) } : null;
      this.L = L;
      return L;
    },
    citizenXY: function (nid, cid) {
      var L = this.layout(), q = L.nations[nid];
      if (!q) return null;
      var u = this.unit(nid, cid);
      return [q.x + u[0] * q.R, q.y + u[1] * q.R];
    },
    snapshotLocs: function (animate) {
      var cur = {}, info = {}, self = this, now = performance.now();
      nations().forEach(function (n) {
        (n.citizens || []).forEach(function (c) { cur[c.id] = n.id; info[c.id] = c; });
      });
      if (animate && this.W > 20) {
        var dur = clamp(interval() * 1.35, 520, 1500), added = 0;
        for (var cid in this.prevLoc) {
          if (added > 40) break;
          var from = this.prevLoc[cid], to = cur[cid];
          if (to === from) continue;
          var a = this.citizenXY(from, cid);
          if (!a) continue;
          var b, exit = false;
          if (to) b = this.citizenXY(to, cid);
          else {
            var q = this.layout().nations[from], fromN = nationById(from);
            if (!q || !fromN || fromN.alive === false) continue;
            var ang = Math.atan2(a[1] - q.y, a[0] - q.x);
            b = [a[0] + Math.cos(ang) * q.R * 0.9, a[1] + Math.sin(ang) * q.R * 0.9];
            exit = true;
          }
          if (!b) continue;
          var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
          var bend = (hash(cid) % 2 ? 1 : -1) * 0.22;
          this.travellers.push({ cid: cid, cls: (info[cid] || this.prevInfo[cid] || {}).cls, a: a, b: b,
            c: [mx - dy * bend, my + dx * bend], t0: now + added * 25, dur: exit ? dur * 0.8 : dur, exit: exit });
          if (to) this.inFlight[cid] = true;
          added++;
        }
      }
      if (this.travellers.length > 80) this.travellers.splice(0, this.travellers.length - 80);
      this.prevLoc = cur;
      this.prevInfo = info;
    },
    loop: function (t) {
      this.raf = requestAnimationFrame(this.loop);
      if (reduced() || document.hidden) return;
      this.draw(t);
    },
    draw: safe(function (now) {
      var ctx = this.ctx, T = this.tok, Wd = this.W, Ht = this.H, s = st();
      if (!ctx || !T) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.fillStyle = T.bg;
      ctx.fillRect(0, 0, Wd, Ht);
      this.drawGrid();
      if (!s || !Array.isArray(s.nations)) return;
      var L = this.layout(), still = reduced(), self = this, ns = s.nations;
      var cfgW = (W() && W().config && W().config.world) || {};

      if (L.commons && s.commons && cfgW.commons !== false) this.drawCommons(L.commons, s.commons);

      ns.forEach(function (n) { self.drawTerritory(n, L.nations[n.id], now); });
      this.drawTension(s, L, now, still);
      ns.forEach(function (n) { self.drawCitizens(n, L.nations[n.id], now, still); });
      this.drawTravellers(now, still);
      this.drawPings(L, now, still);
      ns.forEach(function (n) { self.drawLabel(n, L.nations[n.id]); });
      if (cfgW.escalation) this.drawDial(num(s.doomsday, 0), L.dial);
      this.drawStamp(s);
    }, 'map draw'),
    drawGrid: function () {
      var ctx = this.ctx, T = this.tok, Wd = this.W, Ht = this.H, step = Wd < 520 ? 40 : 56;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (var x = (Wd % step) / 2; x < Wd; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, Ht); }
      for (var y = (Ht % step) / 2; y < Ht; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(Wd, Math.round(y) + 0.5); }
      ctx.strokeStyle = T.grid;
      ctx.stroke();
      // corner ticks, like a plotting table
      ctx.strokeStyle = T.gridS;
      ctx.beginPath();
      for (x = (Wd % step) / 2; x < Wd; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, 5); ctx.moveTo(Math.round(x) + 0.5, Ht - 5); ctx.lineTo(Math.round(x) + 0.5, Ht); }
      for (y = (Ht % step) / 2; y < Ht; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(5, Math.round(y) + 0.5); ctx.moveTo(Wd - 5, Math.round(y) + 0.5); ctx.lineTo(Wd, Math.round(y) + 0.5); }
      ctx.stroke();
    },
    blobPath: function (s, q, scale) {
      var ctx = this.ctx, N = s.length;
      ctx.beginPath();
      for (var i = 0; i <= N; i++) {
        var th = i / N * Math.PI * 2, r = s[i % N] * q.R * scale;
        var x = q.x + Math.cos(th) * r, y = q.y + Math.sin(th) * r * SQ;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    },
    drawCommons: function (c, commons) {
      var ctx = this.ctx, T = this.tok;
      var cap = num(commons.capacity, 100), stock = num(commons.stock, cap), ratio = clamp(cap > 0 ? stock / cap : 0, 0, 1);
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = T.water;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = T.water;
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1.5, c.r * Math.sqrt(ratio)), 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = ratio < 0.25 ? T.crit : T.dim;
      ctx.font = '500 9.5px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('COMMONS ' + Math.round(ratio * 100) + '%', c.x, c.y + c.r + 5);
      ctx.restore();
    },
    drawTerritory: function (n, q, now) {
      if (!q) return;
      var ctx = this.ctx, T = this.tok, s = this.shape(n.id), tint = T.tints[q.i % 5], dead = n.alive === false;
      ctx.save();
      this.blobPath(s, q, 1.06);
      ctx.globalAlpha = dead ? 0.05 : 0.1;
      ctx.fillStyle = dead ? T.dead : tint;
      ctx.fill();
      this.blobPath(s, q, 1);
      ctx.globalAlpha = dead ? 0.1 : 0.2;
      ctx.fill();
      if (dead) {
        ctx.save();
        ctx.clip();
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = T.dead;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var k = -q.R * 2; k < q.R * 2; k += 7) { ctx.moveTo(q.x + k - q.R, q.y - q.R); ctx.lineTo(q.x + k + q.R, q.y + q.R); }
        ctx.stroke();
        ctx.restore();
        this.blobPath(s, q, 1);
      }
      ctx.globalAlpha = dead ? 0.5 : 0.9;
      ctx.strokeStyle = dead ? T.dead : tint;
      ctx.lineWidth = 1.4;
      if (dead) ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      // contour rings (cartographic)
      ctx.globalAlpha = dead ? 0.12 : 0.28;
      ctx.lineWidth = 0.8;
      ctx.setLineDash([1.5, 3.5]);
      this.blobPath(s, q, 0.72); ctx.stroke();
      this.blobPath(s, q, 0.42); ctx.stroke();
      ctx.restore();
    },
    drawTension: function (s, L, now, still) {
      var ctx = this.ctx, T = this.tok, ten = s.tension || {}, compact = this.W < 560;
      for (var key in ten) {
        var t = num(ten[key], 0);
        if (t < 6) continue;
        var ids = key.split('|'), A = L.nations[ids[0]], B = L.nations[ids[1]];
        if (!A || !B) continue;
        var g = arcGeom(A, B, L), a = g.a, b = g.b, c = g.c;
        var col = t >= 70 ? T.crit : t >= 35 ? T.warn : T.faint;
        ctx.save();
        ctx.strokeStyle = col;
        ctx.lineCap = 'round';
        ctx.lineWidth = 0.8 + t / 100 * 5.5;
        ctx.globalAlpha = 0.22 + t / 100 * 0.6;
        if (t < 35) ctx.setLineDash([3, 6]);
        else if (t >= 70 && !still) { ctx.setLineDash([10, 7]); ctx.lineDashOffset = -now / 45; }
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]); ctx.stroke();
        ctx.setLineDash([]);
        if (t >= 25) {
          var lx = 0.25 * a[0] + 0.5 * c[0] + 0.25 * b[0], ly = 0.25 * a[1] + 0.5 * c[1] + 0.25 * b[1];
          var label = compact ? String(Math.round(t)) : 'TENSION ' + Math.round(t);
          if (compact && t < 45) { ctx.restore(); continue; }
          ctx.font = '600 9.5px "IBM Plex Mono", monospace';
          var w = ctx.measureText(label).width + 10;
          ctx.globalAlpha = 0.92;
          ctx.fillStyle = T.bg;
          roundRect(ctx, lx - w / 2, ly - 8, w, 16, 4); ctx.fill();
          ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
          ctx.fillStyle = col;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(label, lx, ly + 0.5);
        }
        ctx.restore();
      }
    },
    dotR: function (q, count) {
      var base = clamp(q.R * 0.042, 1.6, 3.6);
      if (count > 70) base *= clamp(Math.sqrt(70 / count), 0.6, 1);
      return base;
    },
    drawCitizens: function (n, q, now, still) {
      if (!q) return;
      var ctx = this.ctx, T = this.tok, cs = n.citizens || [], dead = n.alive === false, r0 = this.dotR(q, cs.length);
      var me = S.store.info && S.store.info.userId, labels = [];
      ctx.save();
      for (var i = 0; i < cs.length; i++) {
        var c = cs[i];
        if (this.inFlight[c.id]) continue;
        var u = this.unit(n.id, c.id), x = q.x + u[0] * q.R, y = q.y + u[1] * q.R;
        var mood = clamp(num(c.mood, 0.6), 0, 1);
        var col = dead ? T.dead : c.cls === 'owner' ? T.owner : c.cls === 'elite' ? T.elite : T.worker;
        var r = c.cls === 'elite' ? r0 * 1.35 : c.cls === 'owner' ? r0 * 1.15 : r0;
        ctx.globalAlpha = dead ? 0.45 : 0.22 + 0.78 * mood;
        ctx.fillStyle = col;
        ctx.beginPath();
        if (c.cls === 'elite') { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
        else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (c.protesting && !dead) {
          var ph = still ? 0.45 : ((now / 1700 + (hash(c.id) % 1000) / 1000) % 1);
          ctx.globalAlpha = still ? 0.85 : 0.95 * (1 - ph);
          ctx.strokeStyle = T.crit;
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(x, y, r * (1.7 + ph * 1.8), 0, Math.PI * 2); ctx.stroke();
        }
        if (c.isFollower) labels.push({ x: x, y: y, r: r, name: c.name || 'Citizen', mine: me && c.ownerId === me });
      }
      // follower rings + labels (cap to keep the map readable)
      labels.sort(function (a, b) { return (b.mine ? 1 : 0) - (a.mine ? 1 : 0); });
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      for (var j = 0; j < labels.length; j++) {
        var l = labels[j];
        ctx.globalAlpha = 1;
        ctx.strokeStyle = l.mine ? T.signal : T.text;
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(l.x, l.y, l.r + 3.2, 0, Math.PI * 2); ctx.stroke();
        if (j < 8) {
          var w = ctx.measureText(l.name).width + 8, lx = l.x + l.r + 6, ly = l.y - l.r - 7;
          if (lx + w > this.W - 4) lx = l.x - l.r - 6 - w;
          ctx.globalAlpha = 0.88;
          ctx.fillStyle = T.bg;
          roundRect(ctx, lx, ly - 7, w, 14, 3); ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = l.mine ? T.signal : T.text;
          ctx.fillText(l.name, lx + 4, ly + 0.5);
        }
      }
      ctx.restore();
    },
    drawTravellers: function (now, still) {
      var ctx = this.ctx, T = this.tok, keep = [];
      for (var i = 0; i < this.travellers.length; i++) {
        var tr = this.travellers[i], p = (now - tr.t0) / tr.dur;
        if (still) p = 1;
        if (p >= 1) { delete this.inFlight[tr.cid]; continue; }
        keep.push(tr);
        if (p < 0) continue;
        var col = tr.cls === 'owner' ? T.owner : tr.cls === 'elite' ? T.elite : T.worker;
        ctx.save();
        for (var k = 6; k >= 0; k--) {
          var e = ease(clamp(p - k * 0.025, 0, 1)), pt = quad(tr.a, tr.c, tr.b, e);
          ctx.globalAlpha = (k === 0 ? 1 : 0.35 * (1 - k / 7)) * (tr.exit ? 1 - p : 1);
          ctx.fillStyle = k === 0 ? col : T.signal;
          ctx.beginPath(); ctx.arc(pt[0], pt[1], k === 0 ? 2.6 : 1.8, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }
      this.travellers = keep;
    },
    drawPings: function (L, now, still) {
      if (still) { this.pings = []; return; }
      var ctx = this.ctx, T = this.tok, keep = [];
      for (var i = 0; i < this.pings.length; i++) {
        var p = this.pings[i], f = (now - p.t0) / 1800, q = L.nations[p.nid];
        if (f >= 1 || !q) continue;
        keep.push(p);
        ctx.save();
        ctx.globalAlpha = 0.8 * (1 - f);
        ctx.strokeStyle = T.signal;
        ctx.lineWidth = 2;
        this.blobPath(this.shape(p.nid), q, 1.05 + f * 0.3);
        ctx.stroke();
        ctx.restore();
      }
      this.pings = keep;
    },
    drawLabel: function (n, q) {
      if (!q) return;
      var ctx = this.ctx, T = this.tok, s = this.shape(n.id), dead = n.alive === false;
      var fs = clamp(q.R * 0.2, 12.5, 17);
      // `top` is the baseline anchor: name sits 17px above it, the sub line 4px above it.
      var top = q.below ? q.y + this.shapeAt(s, Math.PI * 0.5) * q.R * SQ * 1.06 + fs + 21
                        : q.y - this.shapeAt(s, Math.PI * 1.5) * q.R * SQ * 1.06;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '700 ' + fs + 'px "Bricolage Grotesque", "IBM Plex Sans", sans-serif';
      ctx.fillStyle = dead ? T.faint : T.label;
      var name = n.name || n.id;
      ctx.fillText(name, q.x, top - 17);
      if (dead) {
        var w = ctx.measureText(name).width;
        ctx.strokeStyle = T.crit; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(q.x - w / 2 - 2, top - 17 - fs * 0.32); ctx.lineTo(q.x + w / 2 + 2, top - 17 - fs * 0.32); ctx.stroke();
      }
      ctx.font = '500 9.5px "IBM Plex Mono", monospace';
      var parts = [];
      if (dead) parts.push([T.crit, 'FALLEN']);
      else {
        parts.push([T.faint, systemLabel(n.system).toUpperCase()]);
        var pr = n.metrics ? num(n.metrics.protestRate, 0) : 0;
        if (pr >= 8) parts.push([T.crit, 'PROTESTS ' + Math.round(pr) + '%']);
        if (n.governor && n.governor.inOffice === false) parts.push([T.warn, 'NO GOVERNOR']);
      }
      var sep = '  ', total = 0;
      parts.forEach(function (p, i) { total += ctx.measureText(p[1]).width + (i ? ctx.measureText(sep).width : 0); });
      var x = q.x - total / 2;
      ctx.textAlign = 'left';
      parts.forEach(function (p, i) {
        if (i) x += ctx.measureText(sep).width;
        ctx.fillStyle = p[0];
        ctx.fillText(p[1], x, top - 4);
        x += ctx.measureText(p[1]).width;
      });
      ctx.restore();
    },
    drawDial: function (v, D) {
      var ctx = this.ctx, T = this.tok, r = D.r, cx = D.x, cy = D.y;
      var f = clamp(v / 100, 0, 1), col = v >= 70 ? T.crit : v >= 35 ? T.warn : T.dim;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineWidth = 5;
      ctx.strokeStyle = T.gridS;
      ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI * 2); ctx.stroke();
      if (f > 0) { ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * f); ctx.stroke(); }
      ctx.lineWidth = 1;
      ctx.strokeStyle = T.faint;
      for (var i = 0; i <= 4; i++) {
        var a = Math.PI + Math.PI * i / 4;
        ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6)); ctx.lineTo(cx + Math.cos(a) * (r - 9), cy + Math.sin(a) * (r - 9)); ctx.stroke();
      }
      var na = Math.PI + Math.PI * f;
      ctx.strokeStyle = T.label; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(na) * (r - 4), cy + Math.sin(na) * (r - 4)); ctx.stroke();
      ctx.fillStyle = T.label; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = col;
      ctx.font = '600 12px "IBM Plex Mono", monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(String(Math.round(v)), cx, cy + 5);
      ctx.fillStyle = T.faint;
      ctx.font = '500 8.5px "IBM Plex Mono", monospace';
      ctx.fillText('DOOMSDAY', cx, cy + 19);
      ctx.restore();
    },
    drawStamp: function (s) {
      var ctx = this.ctx, T = this.tok;
      ctx.save();
      ctx.font = '500 10px "IBM Plex Mono", monospace';
      ctx.fillStyle = T.faint;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText('YEAR ' + num(s.year, 0) + ' · ROUND ' + num(s.round, 0), 14, this.H - 12);
      // north mark
      var x = 20, y = 24;
      ctx.strokeStyle = T.faint; ctx.fillStyle = T.faint; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 4, y + 3); ctx.lineTo(x, y); ctx.lineTo(x - 4, y + 3); ctx.closePath(); ctx.fill();
      ctx.textAlign = 'center'; ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillText('N', x, y + 14);
      ctx.restore();
    }
  };
  function roundRect(ctx, x, y, w, hh, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + hh - r); ctx.quadraticCurveTo(x + w, y + hh, x + w - r, y + hh);
    ctx.lineTo(x + r, y + hh); ctx.quadraticCurveTo(x, y + hh, x, y + hh - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath();
  }
  function arcGeom(A, B, L) {
    var dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    var a = [A.x + ux * A.R * 0.92, A.y + uy * A.R * 0.92 * SQ], b = [B.x - ux * B.R * 0.92, B.y - uy * B.R * 0.92 * SQ];
    var mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, px = -uy, py = ux;
    if ((mx - L.gx) * px + (my - L.gy) * py < 0) { px = -px; py = -py; }
    return { a: a, b: b, c: [mx + px * d * 0.16, my + py * d * 0.16] };
  }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1, t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function quad(a, c, b, t) { var u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]]; }

  // ---------------------------------------------------------------- portraits (generated SVG glyphs)
  function portraitSVG(gov, nid) {
    var type = gov && gov.type, mood = (gov && gov.mood) || 'calm', tr = (gov && gov.traits) || {};
    var seed = rng(hash((gov && gov.name || '') + nid));
    var o = '<svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">';
    if (type === 'aligned_ai') {
      var ap = mood === 'scheming' ? 3 : mood === 'panicked' ? 8 : mood === 'pressured' ? 5 : 6;
      o += '<path d="M22 4 L37.6 13 L37.6 31 L22 40 L6.4 31 L6.4 13 Z" stroke-width="1.6"' + (mood === 'panicked' ? ' stroke-dasharray="3 2"' : '') + '/>';
      o += '<circle cx="22" cy="22" r="10.5" stroke-width="1.2" opacity=".6"/>';
      for (var i = 0; i < 6; i++) {
        var a = i * Math.PI / 3 + 0.4, x1 = 22 + Math.cos(a) * 10.5, y1 = 22 + Math.sin(a) * 10.5, x2 = 22 + Math.cos(a + 1.2) * ap, y2 = 22 + Math.sin(a + 1.2) * ap;
        o += '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke-width="1.1" opacity=".75"/>';
      }
      o += '<circle cx="22" cy="22" r="' + (ap * 0.45).toFixed(1) + '" fill="currentColor" stroke="none"/>';
    } else if (type === 'human_player') {
      o += '<rect x="4" y="4" width="36" height="36" rx="9" stroke-width="1.4" stroke-dasharray="4 3"/>';
      o += '<circle cx="22" cy="17" r="6" stroke-width="1.6"/>';
      o += '<path d="M11 35 C12 27 17 25 22 25 C27 25 32 27 33 35" stroke-width="1.6"/>';
      o += '<path d="M30 28 L38 31 L34.5 32.5 L33 36 Z" fill="currentColor" stroke-width="1"/>';
    } else {
      var greed = num(tr.greed, 0.4), honesty = num(tr.honesty, 0.5), ambition = num(tr.ambition, 0.5);
      var hair = Math.floor(seed() * 3);
      o += '<circle cx="22" cy="19" r="9.5" stroke-width="1.6"/>';
      if (hair === 0) o += '<path d="M12.6 17 C14 9 30 9 31.4 17" stroke-width="2.4"/>';
      else if (hair === 1) o += '<path d="M13 15 C16 10 24 9 31 14 L29 12" stroke-width="2.4"/>';
      else o += '<path d="M12.5 19 C12 10 32 8 31.5 19" stroke-width="1.4"/><path d="M14 13 L30 13" stroke-width="2"/>';
      var tilt = (greed - 0.4) * 5;
      o += '<path d="M16.5 ' + (17 - tilt).toFixed(1) + ' L20 ' + (17 + tilt * 0.4).toFixed(1) + '" stroke-width="1.5"/>';
      o += '<path d="M24 ' + (17 + tilt * 0.4).toFixed(1) + ' L27.5 ' + (17 - tilt).toFixed(1) + '" stroke-width="1.5"/>';
      o += '<circle cx="18.3" cy="19.6" r="1" fill="currentColor" stroke="none"/><circle cx="25.7" cy="19.6" r="1" fill="currentColor" stroke="none"/>';
      var curve = (honesty - 0.5) * 5 - (mood === 'defiant' || mood === 'panicked' ? 2 : 0);
      if (mood === 'scheming') o += '<path d="M18.5 24 Q23 ' + (25.5).toFixed(1) + ' 26 23" stroke-width="1.4"/>';
      else o += '<path d="M18.5 24 Q22 ' + (24 + curve).toFixed(1) + ' 25.5 24" stroke-width="1.4"/>';
      var sh = 8 + ambition * 4;
      o += '<path d="M' + (22 - sh - 2).toFixed(1) + ' 40 C' + (22 - sh).toFixed(1) + ' 31 ' + (22 - 4) + ' 30 22 30 C26 30 ' + (22 + sh).toFixed(1) + ' 31 ' + (22 + sh + 2).toFixed(1) + ' 40" stroke-width="1.6"/>';
      if (num(gov && gov.bribesTaken, 0) > 0) o += '<circle cx="35" cy="9" r="3.2" fill="currentColor" stroke="none" opacity=".85"/>';
    }
    return o + '</svg>';
  }

  // ---------------------------------------------------------------- nation cards
  var CARD_REFS = {};
  function buildCards() {
    var box = clear($('#cards'));
    CARD_REFS = {};
    nations().forEach(function (n) {
      var refs = {};
      var meters = h('div', { class: 'meters' });
      CARD_METERS.forEach(function (m) {
        var row = h('div', { class: 'meter' },
          h('span', { class: 'meter-label', text: m.label }),
          h('span', { html: '<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" d=""/><path class="spark-line" vector-effect="non-scaling-stroke" d=""/></svg>' }),
          h('span', { class: 'meter-val' }),
          h('span', { class: 'trend', 'aria-hidden': 'true' }));
        refs['m_' + m.id] = row;
        meters.appendChild(row);
      });
      var dials = h('div', { class: 'dials', 'aria-label': 'System dials' });
      ['ownership', 'allocation', 'concentration', 'oversight'].forEach(function (d) {
        var bar = h('i');
        refs['d_' + d] = bar;
        dials.appendChild(h('div', { class: 'dial', title: humanize(d) + ': 0 is ' + ({ ownership: 'private', allocation: 'market', concentration: 'spread out', oversight: 'none' })[d] + ', 1 is ' + ({ ownership: 'state', allocation: 'plan', concentration: 'concentrated', oversight: 'strong' })[d] },
          h('span', { class: 'dial-label', text: ({ ownership: 'Ownership', allocation: 'Planning', concentration: 'Power', oversight: 'Oversight' })[d] }), h('div', { class: 'dial-bar' }, bar)));
      });
      refs.portrait = h('div', { class: 'portrait' });
      refs.name = h('h3', { class: 'card-name', text: n.name });
      refs.sys = h('p', { class: 'card-sys' });
      refs.gname = h('span', { class: 'gov-name' });
      refs.gtype = h('span', { class: 'badge badge-type' });
      refs.mood = h('span', { class: 'mood' });
      refs.says = h('span', { class: 'vtext' });
      refs.thinks = h('span', { class: 'vtext' });
      refs.gap = h('span');
      refs.wealth = h('span');
      var card = h('article', { class: 'card', 'aria-label': n.name },
        h('div', { class: 'card-head' }, refs.portrait,
          h('div', { class: 'card-id' }, refs.name, refs.sys, h('div', { class: 'gov-line' }, refs.gname, refs.gtype, refs.mood))),
        h('div', { class: 'voice' },
          h('div', { class: 'says' }, h('span', { class: 'vlabel', text: 'Says' }), refs.says),
          h('div', { class: 'thinks' }, h('span', { class: 'vlabel', text: 'Thinks' }), refs.thinks)),
        h('div', { class: 'gap-line' }, refs.gap, refs.wealth),
        meters, dials);
      card.style.setProperty('--tint', tintVar(n.id));
      refs.card = card;
      CARD_REFS[n.id] = refs;
      box.appendChild(card);
    });
  }

  function sparkPath(arr, lo, hi, n) {
    var a = arr.slice(-n);
    if (a.length < 2) return { line: '', area: '' };
    var span = hi - lo || 1, pts = [];
    for (var i = 0; i < a.length; i++) {
      var x = (i / (a.length - 1)) * 100, y = 18 - ((num(a[i], lo) - lo) / span) * 16;
      pts.push(x.toFixed(2) + ' ' + clamp(y, 0, 20).toFixed(2));
    }
    return { line: 'M' + pts.join(' L'), area: 'M0 20 L' + pts.join(' L') + ' L100 20 Z' };
  }
  function sparkDomain(arr, id, n) {
    var a = arr.slice(-n), lo = Infinity, hi = -Infinity;
    a.forEach(function (v) { if (typeof v === 'number' && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    if (!isFinite(lo)) return [0, 1];
    var rg = rangeOf(id, a[a.length - 1]), minSpan = (rg[1] - rg[0]) * 0.08;
    if (id === 'treasury') minSpan = Math.max(Math.abs(hi), Math.abs(lo), 1) * 0.2;
    if (hi - lo < minSpan) { var mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
    return [lo, hi];
  }
  function trendOf(arr, id) {
    if (arr.length < 3) return { sym: '', cls: '' };
    var a = num(arr[arr.length - 1], 0), b = num(arr[Math.max(0, arr.length - 9)], a);
    var rg = rangeOf(id, a), eps = id === 'treasury' ? Math.max(1, Math.abs(b) * 0.03) : (rg[1] - rg[0]) * 0.01;
    var d = a - b;
    if (Math.abs(d) <= eps) return { sym: '→', cls: '' };
    var better = metricMeta(id).better, up = d > 0;
    var good = better === 'up' ? up : better === 'down' ? !up : null;
    return { sym: up ? '↑' : '↓', cls: good == null ? '' : good ? 'good' : 'bad' };
  }

  function updateCards() {
    nations().forEach(function (n) {
      var R = CARD_REFS[n.id];
      if (!R) return;
      var g = n.governor || {};
      R.card.classList.toggle('is-dead', n.alive === false);
      var pk = (g.type || '') + '|' + (g.name || '') + '|' + (g.mood || '') + '|' + (num(g.bribesTaken, 0) > 0);
      if (R._pk !== pk) { R.portrait.innerHTML = portraitSVG(g, n.id); R._pk = pk; R.portrait.title = (GOV_LABEL[g.type] || humanize(g.type)) + ' governor'; }
      R.sys.textContent = systemLabel(n.system) + (g.goal ? ' · goal: ' + (GOAL_LABEL[g.goal] || humanize(g.goal)).toLowerCase() : '');
      R.gname.textContent = g.inOffice === false ? (g.name || 'Governor') + ' (out)' : (g.name || 'Governor');
      R.gtype.textContent = GOV_LABEL[g.type] || humanize(g.type) || 'Governor';
      R.mood.className = 'mood mood-' + (g.mood || 'calm');
      R.mood.textContent = humanize(g.mood || 'calm');
      R.says.textContent = g.publicStatement ? '“' + g.publicStatement + '”' : 'No statement yet.';
      R.thinks.textContent = g.privateThought || '...';
      var gapV = n.metrics ? n.metrics.honestyGap : null;
      R.gap.textContent = typeof gapV === 'number' ? 'Honesty gap ' + fmtMetric('honestyGap', gapV) : '';
      var extra = [];
      if (typeof g.wealth === 'number') extra.push('Gov. wealth ' + fmtMoney(g.wealth));
      if (num(g.bribesTaken, 0) > 0) extra.push(g.bribesTaken + ' bribe' + (g.bribesTaken > 1 ? 's' : ''));
      R.wealth.textContent = extra.join(' · ');
      CARD_METERS.forEach(function (m) {
        var row = R['m_' + m.id], v = metricVal(n, m.id), arr = hist(n, m.id);
        if (!arr.length && v != null) arr = [v];
        var dom = sparkDomain(arr, m.id, 48), p = sparkPath(arr, dom[0], dom[1], 48);
        var svg = row.children[1].firstChild;
        if (svg) { svg.children[0].setAttribute('d', p.area); svg.children[1].setAttribute('d', p.line); }
        row.children[2].textContent = fmtMetric(m.id, v);
        var t = trendOf(arr, m.id);
        row.children[3].textContent = t.sym;
        row.children[3].className = 'trend ' + t.cls;
        row.title = metricLabel(m.id) + ': ' + fmtMetric(m.id, v);
      });
      var d = n.dials || (META.systems[n.system] && META.systems[n.system].dials) || {};
      ['ownership', 'allocation', 'concentration', 'oversight'].forEach(function (k) {
        R['d_' + k].style.width = (clamp(num(d[k], 0), 0, 1) * 100).toFixed(0) + '%';
      });
    });
  }

  // ---------------------------------------------------------------- top bar and global UI
  function renderTransport() {
    var s = st(), over = !!(s && s.over);
    var pb = $('#playBtn');
    pb.textContent = S.playing ? 'Pause' : 'Play';
    pb.setAttribute('aria-pressed', S.playing ? 'true' : 'false');
    pb.disabled = over || !S.world;
    $('#stepBtn').disabled = over || S.playing || !S.world;
    $$('#speedSeg button').forEach(function (b) { b.setAttribute('aria-pressed', String(+b.dataset.speed === S.speed)); });
  }
  function renderClock() {
    var s = st();
    if (!s) return;
    $('#clockYear').textContent = 'Year ' + num(s.year, 0);
    $('#clockRound').textContent = 'Round ' + num(s.round, 0);
    var seed = W().config && W().config.seed;
    $('#seedVal').textContent = seed;
    $('#footSeed').textContent = seed;
    $('#footVer').textContent = META.version;
    $('#feedCount').textContent = S.feedCount ? S.feedCount + ' events' : '';
  }
  function renderScenarioHead() {
    var sc = scenarioById(S.scenarioId);
    $('#scenKicker').textContent = sc ? 'Scenario' : 'Custom setup';
    $('#scenTitle').textContent = sc ? sc.title : 'Your own rules';
    $('#scenHook').textContent = sc ? (sc.hook || sc.description || '') : 'A setup you built in the Setup tab.';
    var sel = $('#scenarioSel');
    if (sel) {
      var custom = sel.querySelector('option[value="__custom"]');
      if (!sc && !custom) sel.appendChild(h('option', { value: '__custom', text: 'Custom setup' }));
      if (sc && custom) custom.remove();
      sel.value = sc ? sc.id : '__custom';
    }
  }

  function updateUI() {
    if (!S.world) return;
    safe(renderClock, 'clock')();
    safe(renderTransport, 'transport')();
    safe(updateCards, 'cards')();
    safe(syncPolicyInputs, 'policies')();
    if (S.tab === 'part') safe(updateMyCitizen, 'part')();
    if (S.story) safe(renderStory, 'story')();
    var pend = safePending().length, pip = $('#tab-govern .pip');
    if (pend && !pip) $('#tab-govern').appendChild(h('span', { class: 'pip', 'aria-hidden': 'true' }));
    if (!pend && pip) pip.remove();
    $('#tab-govern').setAttribute('aria-label', pend ? 'Govern, ' + pend + ' waiting' : 'Govern');
  }

  // ---------------------------------------------------------------- decisions + end card
  function decisionOptions(d, onPick) {
    var box = h('div', { class: 'dec-options' });
    (d.options || []).forEach(function (o) {
      box.appendChild(h('button', { type: 'button', class: 'btn dec-opt', onclick: function () { onPick(o.id); } },
        h('span', { text: o.label || humanize(o.id) }), o.hint ? h('small', { text: o.hint }) : null));
    });
    return box;
  }
  function resolve(d, optId) {
    try { W().resolveDecision(d.id, optId); } catch (e) { console.warn('[aination ui] resolveDecision failed', e); }
    renderDecisions();
    renderGovern();
    updateUI();
    MAP.onState();
    if (!safePending().length && S.autoPaused) { S.autoPaused = false; setPlaying(true); }
  }
  function renderDecisions() {
    var box = $('#decBanner'), pend = safePending();
    if (!pend.length) { box.hidden = true; renderGovern(); return; }
    var d = pend[0];
    clear(box);
    box.appendChild(h('p', { class: 'kicker', text: 'Your call · ' + nationName(d.nationId) + ' · ' + humanize(d.kind) + (pend.length > 1 ? ' · 1 of ' + pend.length : '') }));
    box.appendChild(h('p', { class: 'dec-prompt', text: d.prompt || 'A decision is waiting.' }));
    box.appendChild(decisionOptions(d, function (oid) { resolve(d, oid); }));
    box.hidden = false;
    renderGovern();
  }

  function showEnd() {
    var s = st(), box = $('#endCard');
    if (!s || !s.over) return;
    clear(box);
    var hl = 0;
    var tbl = h('table', { class: 'end-table' },
      h('thead', null, h('tr', null, h('th', { text: 'Nation' }), h('th', { text: 'Welfare' }), h('th', { text: 'Inequality' }), h('th', { text: 'Trust' }), h('th', { text: 'Status' }))));
    var tb = h('tbody');
    nations().forEach(function (n) {
      tb.appendChild(h('tr', null, h('td', { text: n.name }), h('td', { text: fmtMetric('welfare', metricVal(n, 'welfare')) }),
        h('td', { text: fmtMetric('gini', metricVal(n, 'gini')) }), h('td', { text: fmtMetric('trust', metricVal(n, 'trust')) }),
        h('td', { text: n.alive === false ? 'Fallen' : 'Standing' })));
    });
    tbl.appendChild(tb);
    (s.events || []).forEach(function (e) { if (e.highlight) hl++; });
    box.appendChild(h('p', { class: 'kicker', text: 'Simulation over · round ' + num(s.round, 0) + ' · year ' + num(s.year, 0) }));
    box.appendChild(h('h2', { text: s.overReason ? cap(s.overReason) : 'The run has ended.' }));
    box.appendChild(h('p', { text: hl + ' clip-worthy moments. Same seed gives the same story. Change one rule and run it again.' }));
    box.appendChild(tbl);
    box.appendChild(h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn-primary', onclick: function () { resetWorld(); setPlaying(true); }, text: 'Run again' }),
      h('button', { type: 'button', class: 'btn', onclick: function () { var c = clone(W().config); c.seed = newSeed(); newWorld(c, S.scenarioId); setPlaying(true); }, text: 'New seed' }),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: function () { box.hidden = true; }, text: 'Close' })));
    box.hidden = false;
    announce('Simulation over. ' + (s.overReason || ''));
  }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? '' : '.'); }
  function newSeed() { return Math.floor(Math.random() * 99999) + 1; }

  // ---------------------------------------------------------------- tabs
  var TABS = ['policies', 'setup', 'compare', 'part', 'govern'];
  function selectTab(t, focus) {
    if (TABS.indexOf(t) < 0) t = 'policies';
    S.tab = t;
    LS.set('tab', t);
    TABS.forEach(function (x) {
      var b = $('#tab-' + x), p = $('#panel-' + x), on = x === t;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      p.hidden = !on;
    });
    if (focus) $('#tab-' + t).focus();
    if (t === 'part') renderPart();
    if (t === 'govern') renderGovern();
    if (t === 'policies') syncPolicyInputs(true);
  }
  function renderAllTabs() {
    safe(renderPolicies, 'policies tab')();
    safe(renderSetup, 'setup tab')();
    safe(renderCompare, 'compare tab')();
    safe(renderPart, 'part tab')();
    safe(renderGovern, 'govern tab')();
  }

  function nationPicker(selected, onPick, opts) {
    opts = opts || {};
    var box = h('div', { class: 'nation-pick', role: 'group', 'aria-label': opts.label || 'Nation' });
    nations().forEach(function (n, i) {
      if (opts.aliveOnly && n.alive === false) return;
      var b = h('button', { type: 'button', 'aria-pressed': String(n.id === selected || (opts.byIndex && i === selected)), text: n.name,
        onclick: function () { onPick(opts.byIndex ? i : n.id); } });
      b.style.setProperty('--tint', tintVar(n.id));
      box.appendChild(b);
    });
    return box;
  }
  function nationSelect(id, value, aliveOnly) {
    var sel = h('select', { id: id });
    nations().forEach(function (n) { if (aliveOnly && n.alive === false) return; sel.appendChild(h('option', { value: n.id, text: n.name })); });
    if (value && nationById(value)) sel.value = value;
    return sel;
  }
  function policySelect(id, value) {
    var sel = h('select', { id: id }), groups = {};
    META.policies.forEach(function (p) {
      var a = p.area || 'Other';
      if (!groups[a]) { groups[a] = h('optgroup', { label: humanize(a) }); sel.appendChild(groups[a]); }
      groups[a].appendChild(h('option', { value: p.id, text: p.label || humanize(p.id) }));
    });
    if (value) sel.value = value;
    return sel;
  }
  // A value control for one policy: range with live label, or a switch. Returns {el, get()}.
  function valueControl(id, p, value, labelText) {
    if (!p) return { el: h('div'), get: function () { return null; } };
    if (p.kind === 'toggle') {
      var cb = h('input', { type: 'checkbox', id: id, checked: !!value, role: 'switch' });
      return { el: h('label', { class: 'switch', htmlFor: id }, h('span', { text: labelText || 'Value' }), cb), get: function () { return cb.checked; } };
    }
    var out = h('span', { class: 'pol-val', text: fmtPolicy(p, value) });
    var rg = h('input', { type: 'range', id: id, min: num(p.min, 0), max: num(p.max, 100), step: num(p.step, 1), value: num(value, num(p.default, 0)),
      oninput: function () { out.textContent = fmtPolicy(p, +rg.value); } });
    return { el: h('div', { class: 'field' }, h('div', { class: 'pol-top' }, h('label', { htmlFor: id, text: labelText || 'Value' }), out), rg), get: function () { return +rg.value; } };
  }

  // ----- Policies tab
  var POL_INPUTS = {};
  function renderPolicies() {
    var box = clear($('#panel-policies'));
    POL_INPUTS = {};
    if (!S.world) return;
    var n = nationById(S.polNation) || nations()[0];
    if (!n) return;
    S.polNation = n.id;
    box.appendChild(h('h4', { text: 'Nation' }));
    box.appendChild(nationPicker(n.id, function (id) { S.polNation = id; renderPolicies(); }, { label: 'Nation to edit' }));
    box.appendChild(h('p', { class: 'hint', text: 'Changes apply from the next round. The governor may push back by changing them again.' }));
    if (n.alive === false) box.appendChild(h('p', { class: 'hint', text: n.name + ' has fallen. Its laws no longer matter.' }));
    var groups = {}, order = [];
    META.policies.forEach(function (p) { var a = p.area || 'other'; if (!groups[a]) { groups[a] = []; order.push(a); } groups[a].push(p); });
    order.forEach(function (a) {
      box.appendChild(h('h4', { text: humanize(a) }));
      groups[a].forEach(function (p) {
        var id = 'pol-' + p.id, cur = n.policies ? n.policies[p.id] : undefined, def = policyDefault(n, p.id);
        if (cur === undefined) cur = def;
        var row;
        if (p.kind === 'toggle') {
          var cb = h('input', { type: 'checkbox', id: id, role: 'switch', checked: !!cur, disabled: n.alive === false,
            onchange: function () { applyPolicy(n.id, p.id, cb.checked); } });
          row = h('div', { class: 'pol' }, h('label', { class: 'switch', htmlFor: id }, h('span', { text: p.label || humanize(p.id) }), cb),
            p.description ? h('p', { class: 'pol-desc', text: p.description }) : null);
          POL_INPUTS[p.id] = { input: cb, p: p };
        } else {
          var val = h('span', { class: 'pol-val' });
          var rg = h('input', { type: 'range', id: id, min: num(p.min, 0), max: num(p.max, 100), step: num(p.step, 1), value: num(cur, 0), disabled: n.alive === false,
            oninput: function () { val.textContent = fmtPolicy(p, +rg.value); },
            onchange: function () { applyPolicy(n.id, p.id, +rg.value); } });
          rg.setAttribute('aria-describedby', id + '-d');
          row = h('div', { class: 'pol' }, h('div', { class: 'pol-top' }, h('label', { htmlFor: id, text: p.label || humanize(p.id) }), val), rg,
            p.description ? h('p', { class: 'pol-desc', id: id + '-d', text: p.description }) : null);
          POL_INPUTS[p.id] = { input: rg, p: p, val: val };
        }
        box.appendChild(row);
      });
    });
    syncPolicyInputs(true);
  }
  function applyPolicy(nid, pid, v) {
    try { W().setPolicy(nid, pid, v, 'operator'); } catch (e) { console.warn('[aination ui] setPolicy failed', e); }
    syncPolicyInputs(true);
    updateUI();
  }
  function syncPolicyInputs(force) {
    if (S.tab !== 'policies' && !force) return;
    var n = nationById(S.polNation);
    if (!n) return;
    for (var pid in POL_INPUTS) {
      var r = POL_INPUTS[pid], cur = n.policies ? n.policies[pid] : undefined, def = policyDefault(n, pid);
      if (cur === undefined) cur = def;
      if (document.activeElement === r.input && !force) continue;
      if (r.p.kind === 'toggle') r.input.checked = !!cur;
      else {
        if (document.activeElement !== r.input) r.input.value = num(cur, 0);
        r.val.textContent = fmtPolicy(r.p, num(+r.input.value, 0));
        r.val.classList.toggle('changed', def != null && Math.abs(num(cur, 0) - num(def, 0)) > 1e-9);
        r.val.title = def != null ? 'System default: ' + fmtPolicy(r.p, def) : '';
      }
    }
  }

  // ----- Setup tab
  function renderSetup() {
    var box = clear($('#panel-setup'));
    if (!S.world || !S.draft) return;
    var d = S.draft;
    d.world = d.world || {};
    d.traitMix = d.traitMix || { selfInterestedShare: 0.25 };
    var dirty = h('span', { class: 'dirty', text: S.draftDirty ? 'Unapplied changes' : '' });
    function touch() { S.draftDirty = true; dirty.textContent = 'Unapplied changes'; }

    box.appendChild(h('h4', { text: 'Shocks (apply now)' }));
    var tgt = h('select', { id: 'shockTarget' }, h('option', { value: '', text: 'Whole world' }));
    nations().forEach(function (n) { if (n.alive !== false) tgt.appendChild(h('option', { value: n.id, text: n.name })); });
    box.appendChild(h('div', { class: 'field' }, h('label', { htmlFor: 'shockTarget', text: 'Target' }), tgt));
    var sg = h('div', { class: 'shock-grid' });
    SHOCKS.forEach(function (s) {
      sg.appendChild(h('button', { type: 'button', class: 'btn btn-sm', text: s[1], onclick: function () {
        try { W().injectShock(s[0], tgt.value || undefined); } catch (e) { console.warn('[aination ui] injectShock failed', e); }
        MAP.onState(); updateUI();
      } }));
    });
    box.appendChild(sg);

    box.appendChild(h('h4', { text: 'Nations' }));
    box.appendChild(h('p', { class: 'hint', text: 'Edit a draft, then apply. Applying restarts the run from round 0.' }));
    (d.nations || []).forEach(function (cn, i) {
      cn.governor = cn.governor || { type: 'aligned_ai', name: 'ARBITER', goal: 'welfare' };
      cn.safeguards = cn.safeguards || {};
      var pre = 'su-' + i + '-';
      var sys = h('select', { id: pre + 'sys', onchange: function () { cn.system = sys.value; touch(); renderSetup(); } });
      Object.keys(META.systems).forEach(function (k) { sys.appendChild(h('option', { value: k, text: systemLabel(k) })); });
      sys.value = cn.system;
      var gt = h('select', { id: pre + 'gt', onchange: function () {
        cn.governor.type = gt.value; delete cn.governor.traits;
        if (gt.value === 'human_player') cn.governor.name = 'You';
        else if (cn.governor.name === 'You') cn.governor.name = gt.value === 'aligned_ai' ? 'ARBITER-' + (i + 1) : 'Governor ' + (i + 1);
        touch(); renderSetup();
      } });
      META.govTypes.forEach(function (k) { gt.appendChild(h('option', { value: k, text: GOV_LABEL[k] || humanize(k) })); });
      gt.value = cn.governor.type;
      var goal = h('select', { id: pre + 'goal', onchange: function () { cn.governor.goal = goal.value; touch(); } });
      META.goals.forEach(function (k) { goal.appendChild(h('option', { value: k, text: GOAL_LABEL[k] || humanize(k) })); });
      goal.value = cn.governor.goal || 'welfare';
      var gname = h('input', { type: 'text', id: pre + 'gname', value: cn.governor.name || '', maxlength: '24', oninput: function () { cn.governor.name = gname.value; touch(); } });
      var nname = h('input', { type: 'text', id: pre + 'name', value: cn.name || '', maxlength: '24', oninput: function () { cn.name = nname.value; touch(); } });
      var pop = h('input', { type: 'number', id: pre + 'pop', min: 10, max: 150, step: 5, value: num(cn.population, 60), onchange: function () { cn.population = clamp(+pop.value || 60, 10, 150); touch(); } });
      var nuc = h('input', { type: 'checkbox', id: pre + 'nuc', role: 'switch', checked: !!cn.nuclear, onchange: function () { cn.nuclear = nuc.checked; touch(); } });
      var sysSg = (META.systems[cn.system] && META.systems[cn.system].safeguards) || {};
      var chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Safeguards for ' + (cn.name || 'nation') });
      SAFEGUARDS.forEach(function (k) {
        var on = cn.safeguards[k] != null ? !!cn.safeguards[k] : !!sysSg[k];
        var cb = h('input', { type: 'checkbox', id: pre + 'sg-' + k, checked: on, onchange: function () { cn.safeguards[k] = cb.checked; touch(); } });
        chips.appendChild(h('label', { class: 'chip', htmlFor: pre + 'sg-' + k }, cb, SAFEGUARD_LABEL[k]));
      });
      var card = h('div', { class: 'nation-setup' },
        h('div', { class: 'ns-head' }, h('strong', { text: cn.name || ('Nation ' + (i + 1)) }),
          (d.nations.length > 2) ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Remove', onclick: function () { d.nations.splice(i, 1); touch(); renderSetup(); } }) : null),
        h('div', { class: 'grid2' },
          h('div', { class: 'field' }, h('label', { htmlFor: pre + 'name', text: 'Name' }), nname),
          h('div', { class: 'field' }, h('label', { htmlFor: pre + 'sys', text: 'System' }), sys),
          h('div', { class: 'field' }, h('label', { htmlFor: pre + 'gt', text: 'Governor' }), gt),
          h('div', { class: 'field' }, h('label', { htmlFor: pre + 'goal', text: 'Governor goal' }), goal),
          h('div', { class: 'field' }, h('label', { htmlFor: pre + 'gname', text: 'Governor name' }), gname),
          h('div', { class: 'field' }, h('label', { htmlFor: pre + 'pop', text: 'Citizens' }), pop)),
        h('span', { class: 'flabel', text: 'Safeguards' }), chips,
        h('label', { class: 'switch', htmlFor: pre + 'nuc' }, h('span', { text: 'Nuclear armed' }), nuc));
      card.style.setProperty('--tint', 'var(--tint-' + ((i % 5) + 1) + ')');
      if (META.systems[cn.system] && META.systems[cn.system].blurb) card.insertBefore(h('p', { class: 'hint', text: META.systems[cn.system].blurb }), card.children[1]);
      box.appendChild(card);
    });
    if ((d.nations || []).length < 5) {
      box.appendChild(h('button', { type: 'button', class: 'btn btn-sm', text: 'Add a nation', onclick: function () {
        var used = d.nations.map(function (x) { return x.name; }), name = NATION_NAMES.filter(function (x) { return used.indexOf(x) < 0; })[0] || 'New State';
        var ids = d.nations.map(function (x) { return x.id; }), k = 1;
        while (ids.indexOf('n' + k) >= 0) k++;
        d.nations.push({ id: 'n' + k, name: name, system: Object.keys(META.systems)[0] || 'free_market', population: 60, nuclear: false,
          governor: { type: 'human_persona', name: 'Governor ' + k, goal: 'growth' }, policies: {}, safeguards: {} });
        touch(); renderSetup();
      } }));
    }

    box.appendChild(h('h4', { text: 'World' }));
    Object.keys(d.world).forEach(function (k) {
      if (typeof d.world[k] !== 'boolean') return;
      var cb = h('input', { type: 'checkbox', id: 'sw-' + k, role: 'switch', checked: d.world[k], onchange: function () { d.world[k] = cb.checked; touch(); } });
      box.appendChild(h('label', { class: 'switch', htmlFor: 'sw-' + k }, h('span', { text: WORLD_LABEL[k] || humanize(k) }), cb));
    });
    var scr = h('input', { type: 'number', id: 'sw-scarcity', min: 0, max: 400, placeholder: 'Off', value: d.world.scarcityShockRound == null ? '' : d.world.scarcityShockRound,
      onchange: function () { d.world.scarcityShockRound = scr.value === '' ? null : clamp(Math.round(+scr.value), 1, 400); touch(); } });
    var share = num(d.traitMix.selfInterestedShare, 0.25);
    var shareOut = h('span', { class: 'pol-val', text: Math.round(share * 100) + '%' });
    var shareIn = h('input', { type: 'range', id: 'su-traitmix', min: 0, max: 1, step: 0.05, value: share,
      oninput: function () { shareOut.textContent = Math.round(+shareIn.value * 100) + '%'; d.traitMix.selfInterestedShare = +shareIn.value; touch(); } });
    var seed = h('input', { type: 'number', id: 'su-seed', value: d.seed, min: 1, onchange: function () { d.seed = Math.max(1, Math.round(+seed.value) || 1); touch(); } });
    var maxR = h('input', { type: 'number', id: 'su-max', value: num(d.maxRounds, 200), min: 20, max: 1000, step: 10, onchange: function () { d.maxRounds = clamp(Math.round(+maxR.value) || 200, 20, 1000); touch(); } });
    box.appendChild(h('div', { class: 'grid2', style: 'margin-top:8px' },
      h('div', { class: 'field' }, h('label', { htmlFor: 'sw-scarcity', text: 'Scarcity shock at round' }), scr),
      h('div', { class: 'field' }, h('label', { htmlFor: 'su-max', text: 'Max rounds' }), maxR)));
    box.appendChild(h('div', { class: 'field' }, h('div', { class: 'pol-top' }, h('label', { htmlFor: 'su-traitmix', text: 'Strongly self-interested people' }), shareOut), shareIn,
      h('p', { class: 'pol-desc', text: 'Share of citizens, and of persona governors, who put themselves first.' })));
    box.appendChild(h('div', { class: 'field' }, h('label', { htmlFor: 'su-seed', text: 'Seed' }),
      h('div', { class: 'row' }, seed, h('button', { type: 'button', class: 'btn btn-sm', text: 'Random', onclick: function () { d.seed = newSeed(); seed.value = d.seed; touch(); } }))));

    box.appendChild(h('div', { class: 'apply-bar' },
      h('button', { type: 'button', class: 'btn btn-primary', text: 'Apply and restart', onclick: function () {
        var cfg = clone(S.draft);
        newWorld(cfg, scenarioMatches(cfg) ? S.scenarioId : null);
        setPlaying(true);
      } }),
      h('button', { type: 'button', class: 'btn btn-ghost', text: 'Discard', onclick: function () { S.draft = clone(W().config); S.draftDirty = false; renderSetup(); } }),
      dirty));
  }
  function scenarioMatches(cfg) {
    return !S.draftDirty || false;
  }

  // ----- Compare tab
  function renderCompare() {
    var box = clear($('#panel-compare'));
    if (!S.world) return;
    var C = S.cmp;
    if (!nationById(C.nationId)) C.nationId = nations()[0] && nations()[0].id;
    if (!META.policyById[C.policyId]) C.policyId = META.policyById.income_tax_top ? 'income_tax_top' : (META.policies[0] && META.policies[0].id);
    var n = nationById(C.nationId), p = META.policyById[C.policyId];
    var base = n ? (n.policies && n.policies[C.policyId] != null ? n.policies[C.policyId] : policyDefault(n, C.policyId)) : null;
    var cfgN = W().config.nations.filter(function (x) { return x.id === C.nationId; })[0];
    var startVal = cfgN && cfgN.policies && cfgN.policies[C.policyId] != null ? cfgN.policies[C.policyId] : policyDefault(cfgN || n, C.policyId);
    if (C.value == null || C._for !== C.nationId + C.policyId) {
      C._for = C.nationId + C.policyId;
      if (p && p.kind === 'toggle') C.value = !startVal;
      else if (p) { var mid = (num(p.min, 0) + num(p.max, 100)) / 2; C.value = Math.abs(num(startVal, 0) - num(p.max, 100)) > Math.abs(num(startVal, 0) - num(p.min, 0)) ? num(p.max, 100) : num(p.min, 0); if (C.value === startVal) C.value = mid; }
    }
    box.appendChild(h('h3', { text: 'With vs without one rule' }));
    var hasPlayer = (W().config.nations || []).some(function (x) { return x.governor && x.governor.type === 'human_player'; });
    box.appendChild(h('p', { class: 'hint', text: 'A is this setup from round 0. B is the same setup and the same seed, with one policy changed in one nation. Both run in the background.' +
      (hasPlayer ? ' Where you govern, both runs take the default option of each decision.' : '') }));
    var ns = nationSelect('cmp-nation', C.nationId);
    ns.addEventListener('change', function () { C.nationId = ns.value; C.value = null; renderCompare(); });
    var ps = policySelect('cmp-policy', C.policyId);
    ps.addEventListener('change', function () { C.policyId = ps.value; C.value = null; renderCompare(); });
    box.appendChild(h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { htmlFor: 'cmp-nation', text: 'Nation' }), ns),
      h('div', { class: 'field' }, h('label', { htmlFor: 'cmp-policy', text: 'Policy' }), ps)));
    if (p) box.appendChild(h('p', { class: 'hint faint', text: 'In A it starts at ' + fmtPolicy(p, startVal) + '.' + (p.description ? ' ' + p.description : '') }));
    var vc = valueControl('cmp-value', p, C.value, 'Value in B');
    vc.el.addEventListener('input', function () { C.value = vc.get(); });
    vc.el.addEventListener('change', function () { C.value = vc.get(); });
    box.appendChild(vc.el);
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Rounds to run' });
    [25, 50, 100].forEach(function (r) {
      seg.appendChild(h('button', { type: 'button', 'aria-pressed': String(C.rounds === r), text: r + ' rounds', onclick: function () { C.rounds = r; renderCompare(); } }));
    });
    var status = h('span', { class: 'hint', style: 'margin:0', 'aria-live': 'polite' });
    var run = h('button', { type: 'button', class: 'btn btn-primary', text: 'Run A/B', onclick: function () {
      C.value = vc.get();
      run.disabled = true; status.textContent = 'Running...';
      setTimeout(function () {
        try { C.result = runAB(C.nationId, C.policyId, C.value, C.rounds); status.textContent = ''; }
        catch (e) { console.warn('[aination ui] A/B failed', e); status.textContent = 'The run failed. Try another setting.'; }
        run.disabled = false;
        drawCompareResult(resBox);
      }, 20);
    } });
    box.appendChild(h('div', { class: 'row', style: 'margin-top:4px' }, seg));
    box.appendChild(h('div', { class: 'row', style: 'margin-top:10px' }, run, status));
    var resBox = h('div', { class: 'cmp-result' });
    box.appendChild(resBox);
    drawCompareResult(resBox);
  }

  function runHeadless(cfg, nid, rounds) {
    var w = G.createWorld(clone(cfg)), series = {}, counts = {}, guard = 0, done = 0;
    var keys = KEY_METRICS.concat(CHART_METRICS);
    keys.forEach(function (k) { series[k] = []; });
    var seen = {};
    function count(e) {
      if (!e || e.nationId !== nid) return;
      if (e.id != null) { if (seen[e.id]) return; seen[e.id] = 1; }
      counts[e.type] = (counts[e.type] || 0) + 1;
    }
    var hasOn = false;
    try { w.on(count); hasOn = true; } catch (e) { hasOn = false; }
    function sample() {
      var n = null;
      w.state.nations.forEach(function (x) { if (x.id === nid) n = x; });
      keys.forEach(function (k) { series[k].push(n && n.metrics ? num(n.metrics[k], null) : null); });
    }
    sample();
    while (done < rounds && guard++ < rounds * 6) {
      if (w.state.over) break;
      var pend = [];
      try { pend = w.pendingDecisions() || []; } catch (e) { pend = []; }
      pend.forEach(function (d) { try { w.resolveDecision(d.id, d.defaultOption || (d.options && d.options[0] && d.options[0].id)); } catch (e) { /* ignore */ } });
      var before = w.state.round, res = w.step() || {};
      if (!hasOn && Array.isArray(res.events)) res.events.forEach(count);
      if (w.state.round !== before) { done++; sample(); }
    }
    var fin = null;
    w.state.nations.forEach(function (x) { if (x.id === nid) fin = x; });
    return { series: series, counts: counts, alive: fin ? fin.alive !== false : false, rounds: done, over: w.state.over, overReason: w.state.overReason };
  }

  function runAB(nid, pid, value, rounds) {
    var cfgA = clone(W().config), cfgB = clone(W().config);
    cfgB.nations.forEach(function (x) { if (x.id === nid) { x.policies = x.policies || {}; x.policies[pid] = value; } });
    var A = runHeadless(cfgA, nid, rounds), B = runHeadless(cfgB, nid, rounds);
    var cn = cfgA.nations.filter(function (x) { return x.id === nid; })[0] || {};
    var startVal = cn.policies && cn.policies[pid] != null ? cn.policies[pid] : policyDefault(cn, pid);
    return { nid: nid, name: cn.name || nid, pid: pid, value: value, from: startVal, rounds: rounds, seed: cfgA.seed, A: A, B: B };
  }

  function drawCompareResult(box) {
    clear(box);
    var r = S.cmp.result;
    if (!r) { box.appendChild(h('p', { class: 'hint faint', text: 'Results appear here: final numbers, deltas, and lines for A and B on one scale.' })); return; }
    var p = META.policyById[r.pid];
    box.appendChild(h('p', { class: 'kicker', text: r.name + ' · ' + r.rounds + ' rounds · seed ' + r.seed }));
    box.appendChild(h('h3', { style: 'margin-top:4px', text: (p ? p.label : humanize(r.pid)) + ': ' + fmtPolicy(p, r.from) + ' → ' + fmtPolicy(p, r.value) }));
    box.appendChild(h('div', { class: 'cmp-legend' },
      h('span', null, h('i', { class: 'sw sw-a' }), 'A: as set up'),
      h('span', null, h('i', { class: 'sw sw-b' }), 'B: with the change')));
    if (r.A.over || r.B.over || !r.A.alive || !r.B.alive) {
      var notes = [];
      if (!r.A.alive) notes.push('In A, ' + r.name + ' fell.');
      if (!r.B.alive) notes.push('In B, ' + r.name + ' fell.');
      if (r.A.over && r.A.rounds < r.rounds) notes.push('A ended early at round ' + r.A.rounds + '.');
      if (r.B.over && r.B.rounds < r.rounds) notes.push('B ended early at round ' + r.B.rounds + '.');
      if (notes.length) box.appendChild(h('p', { class: 'hint', text: notes.join(' ') }));
    }
    var tb = h('tbody');
    KEY_METRICS.forEach(function (k) {
      var a = last(r.A.series[k]), b = last(r.B.series[k]);
      if (a == null && b == null) return;
      var d = (b != null && a != null) ? b - a : null, better = metricMeta(k).better, cls = 'delta-flat';
      var rg = rangeOf(k, a), eps = (rg[1] - rg[0]) * 0.002;
      if (d != null && Math.abs(d) > eps && better) cls = ((d > 0) === (better === 'up')) ? 'delta-good' : 'delta-bad';
      tb.appendChild(h('tr', null, h('td', { text: metricLabel(k) }), h('td', { text: fmtMetric(k, a) }), h('td', { text: fmtMetric(k, b) }),
        h('td', { class: cls, text: d == null ? '-' : (d > 0 ? '+' : d < 0 ? '−' : '') + fmtMetric(k, Math.abs(d)) })));
    });
    box.appendChild(h('div', { class: 'tbl-wrap' }, h('table', { class: 'cmp-table' },
      h('thead', null, h('tr', null, h('th', { text: 'Final' }), h('th', { text: 'A' }), h('th', { text: 'B' }), h('th', { text: 'B − A' }))), tb)));
    var charts = h('div', { class: 'charts' });
    CHART_METRICS.forEach(function (k) {
      var a = r.A.series[k] || [], b = r.B.series[k] || [];
      if (!a.some(isNum) && !b.some(isNum)) return;
      charts.appendChild(h('figure', { class: 'chart', style: 'margin:0' },
        h('figcaption', { class: 'chart-title' }, h('span', { text: metricLabel(k) }), h('span', { class: 'mono', text: fmtMetric(k, last(b)) })),
        h('div', { html: chartSVG(a, b, k, r.rounds) })));
    });
    box.appendChild(charts);
    var types = {};
    Object.keys(r.A.counts).concat(Object.keys(r.B.counts)).forEach(function (t) { types[t] = (r.A.counts[t] || 0) + (r.B.counts[t] || 0); });
    var list = Object.keys(types).sort(function (x, y) { return types[y] - types[x]; }).slice(0, 9);
    if (list.length) {
      var ev = h('div', { class: 'ev-rows' }, h('div', { class: 'ev-row head' }, h('span', { text: 'Events in ' + r.name }), h('span', { class: 'n', text: 'A' }), h('span', { class: 'n', text: 'B' })));
      list.forEach(function (t) {
        ev.appendChild(h('div', { class: 'ev-row' }, h('span', { class: 'lbl', text: humanize(t) }), h('span', { class: 'n', text: r.A.counts[t] || 0 }), h('span', { class: 'n', text: r.B.counts[t] || 0 })));
      });
      box.appendChild(h('h4', { style: 'margin-top:14px', text: 'Key events' }));
      box.appendChild(ev);
    }
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function last(a) { if (!a) return null; for (var i = a.length - 1; i >= 0; i--) if (isNum(a[i])) return a[i]; return null; }
  function chartSVG(a, b, k, rounds) {
    var Wc = 160, Hc = 84, pl = 2, pr = 2, pt = 13, pb = 14, lo = Infinity, hi = -Infinity;
    a.concat(b).forEach(function (v) { if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    var rg = rangeOf(k, hi), minSpan = (rg[1] - rg[0]) * 0.06;
    if (hi - lo < minSpan) { var m = (hi + lo) / 2; lo = m - minSpan / 2; hi = m + minSpan / 2; }
    var pad = 0;
    var n = Math.max(a.length, b.length) - 1 || 1;
    function path(arr) {
      var d = '', pen = false;
      arr.forEach(function (v, i) {
        if (!isNum(v)) { pen = false; return; }
        var x = pl + (i / n) * (Wc - pl - pr), y = pt + (1 - (v - lo) / (hi - lo)) * (Hc - pt - pb);
        d += (pen ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
        pen = true;
      });
      return d;
    }
    var yb = Hc - pb;
    return '<svg viewBox="0 0 ' + Wc + ' ' + Hc + '" role="img" aria-label="' + esc(metricLabel(k)) + ' over ' + rounds + ' rounds, A and B">' +
      '<line class="grid" x1="0" x2="' + Wc + '" y1="' + pt + '" y2="' + pt + '"/>' +
      '<line class="grid" x1="0" x2="' + Wc + '" y1="' + ((pt + yb) / 2).toFixed(1) + '" y2="' + ((pt + yb) / 2).toFixed(1) + '"/>' +
      '<line class="ax" x1="0" x2="' + Wc + '" y1="' + yb + '" y2="' + yb + '"/>' +
      '<path class="la" d="' + path(a) + '"/><path class="lb" d="' + path(b) + '"/>' +
      '<text x="0" y="' + (pt - 4) + '">' + esc(fmtMetric(k, hi - pad)) + '</text>' +
      '<text x="0" y="' + (Hc - 2) + '">' + esc(fmtMetric(k, lo + pad)) + '</text>' +
      '<text x="' + Wc + '" y="' + (Hc - 2) + '" text-anchor="end">R0 to R' + rounds + '</text></svg>';
  }

  // ----- Take part tab
  var QUIZ = [
    { id: 'q1', q: 'Taxes are due and nobody is checking. You...', opts: [['Pay in full', { honesty: 0.92, selfInterest: 0.15 }], ['Round down a little', { honesty: 0.55, selfInterest: 0.45 }], ['Hide what you can', { honesty: 0.12, selfInterest: 0.85 }]] },
    { id: 'q2', q: 'A rival offers you a big job abroad.', opts: [['Stay put, roots matter', { mobility: 0.12 }], ['Ask your boss to match it', { mobility: 0.45 }], ['Pack tonight', { mobility: 0.9 }]] },
    { id: 'q3', q: 'A hard project lands on your desk on Friday.', opts: [['Stay late and finish it', { workEthic: 0.9 }], ['Do a solid job by Monday', { workEthic: 0.55 }], ['Hand it to someone else', { workEthic: 0.15 }]] },
    { id: 'q4', q: 'The government breaks a promise. You...', opts: [['March on the square', { activism: 0.9, riskTolerance: 0.75 }], ['Vote them out next time', { activism: 0.45, riskTolerance: 0.4 }], ['Keep your head down', { activism: 0.1, riskTolerance: 0.15 }]] }
  ];
  function quizTraits(form) {
    var t = {};
    QUIZ.forEach(function (q) {
      var c = form.querySelector('input[name="' + q.id + '"]:checked');
      var o = q.opts[c ? +c.value : 1][1];
      for (var k in o) t[k] = o[k];
    });
    return t;
  }

  function storeMode() {
    var info = (window.GovStore && GovStore.info && GovStore.info()) || S.store.info;
    return info && info.mode;
  }

  function renderPart() {
    var box = clear($('#panel-part'));
    if (!S.world) return;
    var mode = S.store.ready ? storeMode() : null;
    var ml = h('div', { class: 'mode-line ' + (mode || '') });
    ml.textContent = !window.GovStore ? 'Participation is unavailable on this page.' : !S.store.ready ? 'Connecting...' :
      mode === 'shared' ? 'Shared with everyone who has this page.' : 'Saved on this device only.';
    if (S.store.ready && S.store.info && S.store.info.canWrite === false) ml.textContent += ' You can look, but not change anything.';
    box.appendChild(ml);
    var data = S.store.data || {};

    // your citizen
    box.appendChild(h('h4', { text: 'Your citizen' }));
    var meWrap = h('div', { id: 'meWrap' });
    box.appendChild(meWrap);
    if (data.myCitizen) {
      updateMyCitizen(meWrap);
      var det = h('details', null, h('summary', { class: 'hint', style: 'cursor:pointer', text: 'Start over with a new citizen' }));
      det.appendChild(joinForm());
      box.appendChild(det);
    } else {
      box.appendChild(h('p', { class: 'hint', text: 'Answer four questions. Your answers become your citizen\'s traits. Then watch how they fare.' }));
      box.appendChild(joinForm());
    }

    // proposals
    box.appendChild(h('h4', { text: 'Propose a law' }));
    box.appendChild(proposeForm());
    box.appendChild(h('h4', { text: 'Proposals' }));
    var interval = META.electionInterval, r = num(st().round, 0), next = (Math.floor(r / interval) + 1) * interval;
    box.appendChild(h('p', { class: 'hint', text: 'The top-voted proposal becomes law at the next election round (round ' + next + ').' }));
    var props = (data.proposals || []).slice().sort(function (a, b) { return (num(data.votes[b.id], 0) - num(data.votes[a.id], 0)) || (a.seq - b.seq); });
    if (!props.length) box.appendChild(h('p', { class: 'hint faint', text: 'No proposals yet.' }));
    props.forEach(function (pr, i) {
      var pol = META.policyById[pr.policyId], votes = num(data.votes[pr.id], 0), mine = data.myVote === pr.id;
      var btn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-pressed': String(mine), text: mine ? 'Voted' : 'Vote', disabled: mine,
        onclick: function () { storeCall(GovStore.vote(pr.id), msg); } });
      box.appendChild(h('div', { class: 'prop' + (i === 0 && votes > 0 ? ' top' : '') },
        h('span', { class: 'p-main', text: nationName(pr.nationId) + ': ' + (pol ? pol.label : humanize(pr.policyId)) + ' to ' + fmtPolicy(pol, pr.value) }),
        h('span', { class: 'row', style: 'gap:8px;flex-wrap:nowrap' }, h('span', { class: 'p-votes', text: votes + (votes === 1 ? ' vote' : ' votes') }), btn),
        pr.note ? h('span', { class: 'p-note', text: pr.note }) : null));
    });
    var msg = h('p', { class: 'msg', role: 'status' });
    if (props.length) box.appendChild(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn btn-sm', text: 'Enact top proposal now', onclick: function () {
      var did = enactTop(true);
      msg.className = 'msg ' + (did ? 'ok' : 'err');
      msg.textContent = did === 'same' ? 'That was already the law, so nothing changed.' : did ? 'Enacted. It applies from the next round.' : 'Nothing to enact yet.';
    } })));
    box.appendChild(msg);
  }

  function joinForm() {
    var form = h('form', { class: 'join', onsubmit: function (e) { e.preventDefault(); } });
    QUIZ.forEach(function (q, qi) {
      var fs = h('fieldset', { class: 'q' }, h('legend', { text: (qi + 1) + '. ' + q.q }));
      var opts = h('div', { class: 'q-opts' });
      q.opts.forEach(function (o, oi) {
        var id = 'quiz-' + q.id + '-' + oi;
        opts.appendChild(h('label', { class: 'q-opt', htmlFor: id }, h('input', { type: 'radio', name: q.id, id: id, value: String(oi), checked: oi === 1 }), h('span', { text: o[0] })));
      });
      fs.appendChild(opts);
      form.appendChild(fs);
    });
    var my = S.store.data && S.store.data.myCitizen;
    var name = h('input', { type: 'text', id: 'join-name', maxlength: '24', placeholder: 'Any name', value: my ? my.name : '', autocomplete: 'off' });
    var ns = nationSelect('join-nation', my && my.nationId, true);
    var msg = h('p', { class: 'msg', role: 'status' });
    form.appendChild(h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { htmlFor: 'join-name', text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { htmlFor: 'join-nation', text: 'Nation' }), ns)));
    form.appendChild(h('button', { type: 'button', class: 'btn btn-primary join-btn', text: my ? 'Join again' : 'Join as a citizen', onclick: function () {
      if (!name.value.trim()) { msg.className = 'msg err'; msg.textContent = 'Please type a name.'; name.focus(); return; }
      var traits = quizTraits(form);
      storeCall(GovStore.joinAsCitizen({ name: name.value.trim(), nationId: ns.value, traits: traits }), msg, 'You are in. Find your ringed dot on the map.');
    } }));
    form.appendChild(msg);
    return form;
  }

  function proposeForm() {
    var C = S.prop || (S.prop = { nationId: null, policyId: null });
    if (!nationById(C.nationId)) C.nationId = nations()[0] && nations()[0].id;
    if (!META.policyById[C.policyId]) C.policyId = META.policies[0] && META.policies[0].id;
    var wrap = h('div');
    var ns = nationSelect('prop-nation', C.nationId, true), ps = policySelect('prop-policy', C.policyId);
    var n = nationById(C.nationId), p = META.policyById[C.policyId];
    var cur = n && n.policies && n.policies[C.policyId] != null ? n.policies[C.policyId] : policyDefault(n, C.policyId);
    var vc = valueControl('prop-value', p, p && p.kind === 'toggle' ? !cur : cur, 'New value');
    ns.addEventListener('change', function () { C.nationId = ns.value; rebuild(); });
    ps.addEventListener('change', function () { C.policyId = ps.value; rebuild(); });
    function rebuild() { var nw = proposeForm(); wrap.replaceWith(nw); }
    var note = h('input', { type: 'text', id: 'prop-note', maxlength: '140', placeholder: 'Why? (optional)', autocomplete: 'off' });
    var msg = h('p', { class: 'msg', role: 'status' });
    wrap.appendChild(h('div', { class: 'grid2' },
      h('div', { class: 'field' }, h('label', { htmlFor: 'prop-nation', text: 'Nation' }), ns),
      h('div', { class: 'field' }, h('label', { htmlFor: 'prop-policy', text: 'Policy' }), ps)));
    if (p) wrap.appendChild(h('p', { class: 'hint faint', text: 'Now: ' + fmtPolicy(p, cur) + '.' }));
    wrap.appendChild(vc.el);
    wrap.appendChild(h('div', { class: 'field' }, h('label', { htmlFor: 'prop-note', text: 'Note' }), note));
    wrap.appendChild(h('button', { type: 'button', class: 'btn', text: 'Propose', onclick: function () {
      if (vc.get() === cur) { msg.className = 'msg err'; msg.textContent = 'That is already the law. Pick a different value.'; return; }
      storeCall(GovStore.propose({ nationId: ns.value, policyId: ps.value, value: vc.get(), note: note.value }), msg, 'Proposed. Others can vote on it.');
    } }));
    wrap.appendChild(msg);
    return wrap;
  }

  function storeCall(p, msg, okText) {
    if (!p || !p.then) return;
    p.then(function (r) {
      if (!msg) return;
      if (r && r.ok === false) { msg.className = 'msg err'; msg.textContent = r.message || 'That did not work.'; }
      else if (okText) { msg.className = 'msg ok'; msg.textContent = okText; }
    }).catch(function (e) { if (msg) { msg.className = 'msg err'; msg.textContent = 'That did not work.'; } });
  }

  function findMine() {
    var uid = S.store.info && S.store.info.userId, found = null;
    if (!uid) return null;
    nations().forEach(function (n) { (n.citizens || []).forEach(function (c) { if (c.ownerId === uid && c.isFollower) found = { c: c, n: n }; }); });
    return found;
  }
  function updateMyCitizen(wrap) {
    wrap = wrap || $('#meWrap');
    if (!wrap) return;
    var rec = S.store.data && S.store.data.myCitizen;
    if (!rec) { clear(wrap); return; }
    var f = findMine(), home = nationById(rec.nationId);
    clear(wrap);
    var card = h('div', { class: 'me-card' });
    card.style.setProperty('--tint', tintVar(f ? f.n.id : rec.nationId));
    card.appendChild(h('p', { class: 'me-name', text: rec.name }));
    if (!f) {
      card.appendChild(h('p', { class: 'hint', style: 'margin:0', text: home && home.alive === false ? home.name + ' fell. Your citizen is gone with it.' : 'Your citizen has left the simulation.' }));
    } else {
      var c = f.c, still = f.n.id === rec.nationId;
      var dl = h('div', { class: 'stat-grid' });
      [['Wealth', fmtMoney(num(c.wealth, 0))], ['Mood', Math.round(clamp(num(c.mood, 0), 0, 1) * 100) + '%'], ['Class', humanize(c.cls)],
        ['Job', c.employed === false ? 'Unemployed' : 'Employed'], ['Protesting', c.protesting ? 'Yes' : 'No'],
        ['Still in ' + (home ? home.name : 'home') + '?', still ? 'Yes' : 'No, in ' + f.n.name]].forEach(function (x) {
        dl.appendChild(h('div', null, h('span', { text: x[0] }), h('b', { text: x[1] })));
      });
      card.appendChild(dl);
    }
    wrap.appendChild(card);
  }

  function enactTop(force) {
    if (!window.GovStore || !S.world) return false;
    var data = S.store.data || {}, props = (data.proposals || []).slice();
    if (!props.length) return false;
    props.sort(function (a, b) { return (num(data.votes[b.id], 0) - num(data.votes[a.id], 0)) || (a.seq - b.seq); });
    var top = props[0];
    if (!force && !(num(data.votes[top.id], 0) > 0)) return false;
    var n = nationById(top.nationId);
    if (!n || n.alive === false || !META.policyById[top.policyId]) { GovStore.clearProposal(top.id); return false; }
    var cur = n.policies ? n.policies[top.policyId] : undefined, same = cur === top.value;
    if (!same) { try { W().setPolicy(top.nationId, top.policyId, top.value, 'law'); } catch (e) { console.warn('[aination ui] law failed', e); return false; } }
    GovStore.clearProposal(top.id);
    if (same) return 'same';
    syncPolicyInputs(true);
    updateUI();
    return true;
  }
  function maybeEnactLaw() {
    var r = num(st().round, 0), iv = META.electionInterval;
    if (r > 0 && r % iv === 0 && S.lastEnactRound !== r) { S.lastEnactRound = r; enactTop(false); }
  }

  function syncStoreCitizens() {
    if (!S.world || !S.store.data) return;
    (S.store.data.citizens || []).forEach(function (c) {
      var key = c.ownerId + '#' + c.seq;
      if (S.added.has(key)) return;
      var n = nationById(c.nationId);
      if (!n || n.alive === false) return;
      S.added.add(key);
      try { W().addCitizen(c.nationId, { name: c.name, traits: c.traits || {}, ownerId: c.ownerId, isFollower: true }); }
      catch (e) { console.warn('[aination ui] addCitizen failed', e); }
    });
    MAP.onState();
  }

  function initStore() {
    if (!window.GovStore) { renderPart(); return; }
    try {
      GovStore.onChange(function (snap) {
        S.store.data = snap || S.store.data;
        syncStoreCitizens();
        if (S.tab === 'part') renderPartSoft();
        updateUI();
      });
    } catch (e) { /* ignore */ }
    Promise.resolve().then(function () { return GovStore.init(); }).then(function (info) {
      S.store.info = info || {};
      S.store.ready = true;
      S.store.data = GovStore.getAll() || S.store.data;
      syncStoreCitizens();
      renderPart();
    }).catch(function () { S.store.ready = true; renderPart(); });
  }
  // Re-render the Take part tab without stomping on a form the person is typing into.
  function renderPartSoft() {
    var a = document.activeElement, panel = $('#panel-part');
    if (a && panel.contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { updateMyCitizen(); return; }
    renderPart();
  }

  // ----- Govern tab
  function renderGovern() {
    var box = clear($('#panel-govern'));
    if (!S.world) return;
    var pend = safePending();
    box.appendChild(h('h4', { text: 'Waiting for you' }));
    if (!pend.length) box.appendChild(h('p', { class: 'hint faint', text: 'No decisions waiting. Take over a nation below and the simulation will stop to ask you.' }));
    pend.forEach(function (d) {
      var card = h('div', { class: 'dec-card' },
        h('p', { class: 'kicker', text: nationName(d.nationId) + ' · ' + humanize(d.kind) + ' · round ' + num(d.round, 0) }),
        h('p', { text: d.prompt || 'A decision is waiting.' }),
        decisionOptions(d, function (oid) { resolve(d, oid); }));
      box.appendChild(card);
    });
    box.appendChild(h('h4', { text: 'Who governs' }));
    nations().forEach(function (n) {
      var g = n.governor || {}, mine = g.type === 'human_player';
      var row = h('div', { class: 'prop' },
        h('span', { class: 'p-main' }, n.name + ' ', h('span', { class: 'badge', text: GOV_LABEL[g.type] || humanize(g.type) })),
        n.alive === false ? h('span', { class: 'p-votes', text: 'Fallen' }) :
          h('button', { type: 'button', class: 'btn btn-sm', text: mine ? 'Hand to AI' : 'Govern it', onclick: function () {
            try {
              if (mine) W().setGovernor(n.id, { type: 'aligned_ai', name: 'ARBITER-' + (S.tintIdx[n.id] + 1), goal: g.goal || 'welfare' });
              else W().setGovernor(n.id, { type: 'human_player', name: 'You', goal: g.goal || 'welfare' });
            } catch (e) { console.warn('[aination ui] setGovernor failed', e); }
            renderGovern(); updateUI(); renderDecisions();
          } }));
      box.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- story mode
  var STORY_METERS = ['welfare', 'trust', 'corruption'];
  function setStory(on) {
    S.story = !!on;
    $('#storyBtn').setAttribute('aria-pressed', String(S.story));
    $('#main').hidden = S.story;
    $('#story').hidden = !S.story;
    var wrap = $('#mapWrap');
    (S.story ? $('#storyMapSlot') : $('#mapHome')).appendChild(wrap);
    renderStoryPick();
    renderStory();
    renderStoryCaption();
    MAP.L = null;
    MAP.resize();
    MAP.needs = true;
    if (reduced()) MAP.draw(performance.now());
  }
  function renderStoryPick() {
    var box = $('#storyPick');
    if (!box) return;
    clear(box);
    box.appendChild(nationPicker(S.storyNation, function (i) { S.storyNation = i; LS.set('storyNation', i); renderStoryPick(); renderStory(); }, { byIndex: true, label: 'Nation for meters' }));
  }
  function renderStory() {
    if (!S.story || !S.world) return;
    var s = st(), n = nations()[S.storyNation] || nations()[0];
    if (!n) return;
    $('#storyClock').textContent = 'YEAR ' + num(s.year, 0) + ' · R' + num(s.round, 0);
    var fr = $('#storyFrame');
    fr.style.setProperty('--tint', tintVar(n.id));
    var mbox = $('#storyMeters');
    if (mbox.children.length !== STORY_METERS.length || mbox.dataset.nid !== n.id) {
      clear(mbox);
      mbox.dataset.nid = n.id;
      STORY_METERS.forEach(function (k) {
        mbox.appendChild(h('div', { class: 'smeter' }, h('div', { class: 'l', text: n.name.split(' ')[0] + ' ' + metricLabel(k) }), h('div', { class: 'v' }),
          h('div', { html: '<svg viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><path class="spark-area" d=""/><path class="spark-line" vector-effect="non-scaling-stroke" d=""/></svg>' })));
      });
    }
    STORY_METERS.forEach(function (k, i) {
      var el = mbox.children[i], arr = hist(n, k), dom = sparkDomain(arr, k, 60), p = sparkPath(arr, dom[0], dom[1], 60);
      el.children[1].textContent = fmtMetric(k, metricVal(n, k));
      var svg = el.children[2].firstChild;
      svg.children[0].setAttribute('d', p.area); svg.children[1].setAttribute('d', p.line);
    });
    var sc = scenarioById(S.scenarioId);
    var lines = nations().map(function (x) {
      return x.name + ': ' + systemLabel(x.system).toLowerCase() + ', ' + (GOV_LABEL[x.governor && x.governor.type] || 'governor').toLowerCase();
    });
    var cfgW = W().config.world || {}, sw = [];
    ['lobbying', 'migration', 'escalation', 'coups'].forEach(function (k) { if (cfgW[k] != null) sw.push(humanize(k).toLowerCase() + ' ' + (cfgW[k] ? 'on' : 'off')); });
    var stamp = clear($('#storyStamp'));
    stamp.appendChild(h('div', { text: (sc ? sc.title : 'Custom setup') + ' · seed ' + W().config.seed }));
    stamp.appendChild(h('div', { text: lines.join(' / ') }));
    if (sw.length) stamp.appendChild(h('div', { text: sw.join(', ') }));
    stamp.appendChild(h('strong', { text: 'Simulation, not prediction.' }));
  }
  function renderStoryCaption() {
    if (!S.story) return;
    var ev = S.lastHighlight, sc = scenarioById(S.scenarioId);
    $('#storyKicker').textContent = ev ? 'Round ' + num(ev.round, 0) + (ev.nationId ? ' · ' + nationName(ev.nationId) : '') : (sc ? sc.title : 'AI Nation');
    $('#storyCap').textContent = ev ? (ev.text || humanize(ev.type)) : (sc ? (sc.hook || sc.description) : 'Watch a society rise or fall.');
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    var sel = $('#scenarioSel');
    META.scenarios.forEach(function (sc) { sel.appendChild(h('option', { value: sc.id, text: sc.title || humanize(sc.id) })); });
    sel.addEventListener('change', function () {
      var sc = scenarioById(sel.value);
      if (!sc) return;
      newWorld(sc.config || G.defaultConfig(), sc.id);
      setPlaying(true);
    });
    $('#playBtn').addEventListener('click', function () { setPlaying(!S.playing); });
    $('#stepBtn').addEventListener('click', function () { if (!S.playing) tick(); });
    $$('#speedSeg button').forEach(function (b) {
      b.addEventListener('click', function () { S.speed = +b.dataset.speed; LS.set('speed', S.speed); renderTransport(); if (S.playing) startLoop(); });
    });
    $('#resetBtn').addEventListener('click', function () { resetWorld(); setPlaying(true); });
    $('#storyBtn').addEventListener('click', function () { setStory(!S.story); });
    $('#storyExit').addEventListener('click', function () { setStory(false); $('#storyBtn').focus(); });
    $$('#tabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { selectTab(b.dataset.tab); });
      b.addEventListener('keydown', function (e) {
        var i = TABS.indexOf(b.dataset.tab);
        if (e.key === 'ArrowRight') { e.preventDefault(); selectTab(TABS[(i + 1) % TABS.length], true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); selectTab(TABS[(i + TABS.length - 1) % TABS.length], true); }
        if (e.key === 'Home') { e.preventDefault(); selectTab(TABS[0], true); }
        if (e.key === 'End') { e.preventDefault(); selectTab(TABS[TABS.length - 1], true); }
      });
    });
    document.addEventListener('keydown', function (e) {
      var t = e.target, tag = t && t.tagName;
      if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(tag) || (t && t.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === ' ') { e.preventDefault(); setPlaying(!S.playing); }
      else if (e.key === '.') { if (!S.playing) tick(); }
    });
    var onTheme = function () { MAP.readTokens(); if (reduced()) MAP.draw(performance.now()); };
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      if (mq.addEventListener) mq.addEventListener('change', onTheme); else if (mq.addListener) mq.addListener(onTheme);
    }
    if (window.MutationObserver) new MutationObserver(onTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (reduceMQ) {
      var onRM = function () { MAP.travellers = []; MAP.inFlight = {}; MAP.draw(performance.now()); };
      if (reduceMQ.addEventListener) reduceMQ.addEventListener('change', onRM); else if (reduceMQ.addListener) reduceMQ.addListener(onRM);
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { MAP.needs = true; if (reduced()) MAP.draw(performance.now()); });
  }

  function boot() {
    if (!G || typeof G.createWorld !== 'function') {
      var wrap = $('#mapWrap');
      if (wrap) wrap.appendChild(h('div', { class: 'map-err', text: 'The simulation engine did not load. Reload the page to try again.' }));
      $('#playBtn').disabled = true; $('#stepBtn').disabled = true;
      return;
    }
    loadMeta();
    MAP.init();
    wire();
    selectTab(S.tab);
    var first = scenarioById('three_systems') || META.scenarios[0];
    var cfg = first ? first.config : G.defaultConfig();
    S.playing = true;
    newWorld(cfg || G.defaultConfig(), first ? first.id : null);
    selectTab(S.tab);
    setTimeout(initStore, 0);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
