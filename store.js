/* AI Nation: participation store (window.GovStore).
 *
 * Shared mode: artifact `db` + `user` capabilities. Collections `citizens`, `proposals`, `votes`,
 * one doc per viewer, doc id = viewer id from user.id().
 * Local mode: localStorage key "aination.store.v1", else memory. Same API, same results.
 * No DOM access, no dependencies. Everything read from the shared store is untrusted and is
 * sanitised and shape-checked before the UI sees it.
 */
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : globalThis;
  var KEY = 'aination.store.v1';
  var COLS = ['citizens', 'proposals', 'votes'];
  var CAP_TIMEOUT_MS = 4000;
  var SUB_TIMEOUT_MS = 10000;

  // ---------- sanitising ----------
  function cleanStr(s, max) {
    if (typeof s !== 'string') return '';
    s = s.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
    return s.replace(/ {2,}/g, ' ').trim().slice(0, max);
  }
  function cleanId(s) {
    return typeof s === 'string' && /^[A-Za-z0-9_.:@+~-]{1,64}$/.test(s) ? s : '';
  }
  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
  function cleanTraits(t) {
    var out = {}, n = 0;
    if (!t || typeof t !== 'object' || Array.isArray(t)) return out;
    var keys = Object.keys(t);
    for (var i = 0; i < keys.length && n < 12; i++) {
      var k = keys[i], v = t[k];
      if (/^[A-Za-z_]{1,16}$/.test(k) && typeof v === 'number' && isFinite(v)) { out[k] = clamp01(v); n++; }
    }
    return out;
  }
  function cleanValue(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number' && isFinite(v)) return Math.max(-1e6, Math.min(1e6, v));
    return null;
  }
  function cleanSeq(n) { return typeof n === 'number' && isFinite(n) ? Math.max(0, Math.min(1e12, Math.floor(n))) : 0; }
  function cleanTime(n) { return typeof n === 'number' && isFinite(n) && n > 0 ? Math.floor(n) : 0; }
  function isObj(d) { return d && typeof d === 'object' && !Array.isArray(d); }

  // Each returns a clean object or null (malformed). The doc id is the owner, never a stored field.
  function sanCitizen(id, d) {
    if (!isObj(d)) return null;
    var name = cleanStr(d.name, 24), nationId = cleanId(d.nationId);
    if (!name || !nationId) return null;
    return { id: id, ownerId: id, name: name, nationId: nationId, traits: cleanTraits(d.traits),
             seq: cleanSeq(d.seq), createdAt: cleanTime(d.createdAt) };
  }
  function sanProposal(id, d) {
    if (!isObj(d)) return null;
    var nationId = cleanId(d.nationId), policyId = cleanId(d.policyId), value = cleanValue(d.value);
    if (!nationId || !policyId || value === null) return null;
    return { id: id, ownerId: id, nationId: nationId, policyId: policyId, value: value,
             note: cleanStr(d.note, 140), seq: cleanSeq(d.seq), createdAt: cleanTime(d.createdAt) };
  }
  function sanVote(id, d) {
    if (!isObj(d)) return null;
    var pid = cleanId(d.proposalId);
    if (!pid) return null;
    return { id: id, ownerId: id, proposalId: pid, proposalSeq: cleanSeq(d.proposalSeq),
             seq: cleanSeq(d.seq), createdAt: cleanTime(d.createdAt) };
  }
  var SAN = { citizens: sanCitizen, proposals: sanProposal, votes: sanVote };

  // ---------- helpers ----------
  function now() { try { return Date.now(); } catch (e) { return 0; } }
  function bySeq(a, b) { return a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
  function fail(code, message) { return { ok: false, code: code, message: message }; }
  function errResult(e) {
    var code = e && typeof e.code === 'string' ? e.code : 'unavailable';
    var msg = e && e.message ? String(e.message) : String(e || 'Write failed');
    return fail(code, msg.slice(0, 200));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function withTimeout(p, ms, fallback) {
    var t;
    return Promise.race([
      Promise.resolve(p).catch(function () { return fallback; }),
      new Promise(function (r) { t = setTimeout(function () { r(fallback); }, ms); })
    ]).then(function (v) { clearTimeout(t); return v; });
  }
  function newId() {
    var s = '';
    try {
      var c = W.crypto || globalThis.crypto;
      if (c && c.getRandomValues) {
        var a = new Uint8Array(9); c.getRandomValues(a);
        for (var i = 0; i < a.length; i++) s += (a[i] % 36).toString(36);
      }
    } catch (e) { s = ''; }
    while (s.length < 12) s += Math.floor(Math.random() * 36).toString(36);
    return 'local_' + s;
  }

  // ---------- state ----------
  var st = {
    initP: null, mode: 'local', userId: null, canWrite: true, fallbackReason: null,
    db: null, unsubs: [], timer: null, fresh: {},
    docs: { citizens: new Map(), proposals: new Map(), votes: new Map() }, // clean docs by id
    mem: null,        // in-memory copy of local state when localStorage is unavailable
    listeners: [], snapshot: emptyView(), queues: {}
  };

  function emptyView() {
    return { citizens: [], proposals: [], votes: {}, myVote: null, myCitizen: null, myProposal: null };
  }

  function buildView() {
    var d = st.docs, uid = st.userId;
    var citizens = Array.from(d.citizens.values()).sort(bySeq);
    var proposals = Array.from(d.proposals.values()).sort(bySeq);
    var pById = {};
    proposals.forEach(function (p) { pById[p.id] = p; });
    var votes = {}, myVote = null;
    d.votes.forEach(function (v) {
      var p = pById[v.proposalId];
      if (!p || v.proposalSeq !== p.seq) return;   // stale: proposal gone or rewritten since the vote
      votes[p.id] = (votes[p.id] || 0) + 1;
      if (v.id === uid) myVote = p.id;
    });
    return { citizens: citizens, proposals: proposals, votes: votes, myVote: myVote,
             myCitizen: d.citizens.get(uid) || null, myProposal: d.proposals.get(uid) || null };
  }

  function emit() {
    st.snapshot = buildView();
    var snap = st.snapshot;
    st.listeners.slice().forEach(function (fn) { try { fn(snap); } catch (e) { /* listener bug, ignore */ } });
  }

  function nextSeq(col) {
    var m = 0;
    st.docs[col].forEach(function (d) { if (d.seq > m) m = d.seq; });
    return m + 1;
  }

  // ---------- local persistence ----------
  function ls() {
    try { return W.localStorage || globalThis.localStorage || null; } catch (e) { return null; }
  }
  function loadLocal() {
    var raw = null, s = ls();
    try { if (s) raw = s.getItem(KEY); } catch (e) { raw = null; }
    var data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
    if (!isObj(data)) data = st.mem && isObj(st.mem) ? st.mem : {};
    var uid = cleanId(data.userId) || newId();
    st.userId = uid;
    COLS.forEach(function (c) {
      var m = new Map(), src = isObj(data[c]) ? data[c] : {};
      Object.keys(src).forEach(function (id) {
        if (!cleanId(id)) return;
        var clean = SAN[c](id, src[id]);
        if (clean) m.set(id, clean);
      });
      st.docs[c] = m;
    });
    saveLocal();
  }
  function saveLocal() {
    var data = { userId: st.userId };
    COLS.forEach(function (c) {
      data[c] = {};
      st.docs[c].forEach(function (doc, id) { data[c][id] = doc; });
    });
    st.mem = data;
    try { var s = ls(); if (s) s.setItem(KEY, JSON.stringify(data)); } catch (e) { /* memory only */ }
  }

  // ---------- shared mode ----------
  function stopShared() {
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.unsubs.forEach(function (u) { try { u(); } catch (e) { /* ignore */ } });
    st.unsubs = [];
  }
  function fallbackToLocal(reason) {
    if (st.mode !== 'shared') return;
    stopShared();
    st.mode = 'local';
    st.fallbackReason = String(reason || 'shared store unavailable').slice(0, 200);
    st.canWrite = true;
    st.db = null;
    loadLocal();
    emit();
  }
  function subscribe() {
    COLS.forEach(function (c) { st.fresh[c] = false; });
    st.timer = setTimeout(function () {
      var stale = COLS.some(function (c) { return !st.fresh[c]; });
      if (stale) fallbackToLocal('shared store did not answer in time');
    }, SUB_TIMEOUT_MS);
    COLS.forEach(function (c) {
      try {
        var un = st.db.collection(c).onSnapshot(function (snap) {
          if (st.mode !== 'shared') return;
          var m = new Map();
          (snap.docs || []).forEach(function (ds) {
            try {
              if (!ds || ds.exists === false) return;
              var id = String(ds.id).slice(0, 200);
              if (!cleanId(id)) return;
              var clean = SAN[c](id, ds.data());
              if (clean) m.set(id, clean);
            } catch (e) { /* drop malformed */ }
          });
          st.docs[c] = m;
          if (snap.metadata && snap.metadata.fromCache === false) st.fresh[c] = true;
          if (st.timer && COLS.every(function (k) { return st.fresh[k]; })) { clearTimeout(st.timer); st.timer = null; }
          emit();
        }, function (e) {
          fallbackToLocal('subscription failed: ' + (e && e.code ? e.code : 'error'));
        });
        if (typeof un === 'function') st.unsubs.push(un);
      } catch (e) {
        fallbackToLocal('subscribe threw: ' + (e && e.message ? e.message : 'error'));
      }
    });
  }

  // Serialise writes per document (the db wants one write at a time per doc), retry once on unavailable.
  function sharedOp(key, fn) {
    var prev = st.queues[key] || Promise.resolve();
    var run = prev.then(function () {
      return fn().catch(function (e) {
        if (e && e.code === 'unavailable') return sleep(300 + Math.random() * 400).then(fn);
        throw e;
      });
    });
    st.queues[key] = run.catch(function () { /* keep chain alive */ });
    return run;
  }

  // ---------- init ----------
  async function doInit() {
    try {
      var caps = await withTimeout(
        (async function () {
          var db = await W.claude?.use?.('db');
          var user = await W.claude?.use?.('user');
          return { db: db, user: user };
        })(), CAP_TIMEOUT_MS, null);
      var db = caps && caps.db, user = caps && caps.user, uid = null;
      if (db && typeof db === 'object' && user && typeof user === 'object') {
        try { uid = await withTimeout(user.id(), CAP_TIMEOUT_MS, null); } catch (e) { uid = null; }
      }
      if (db && user && typeof uid === 'string' && cleanId(uid)) {
        var can = null;
        try { if (typeof user.can === 'function') can = await withTimeout(user.can('data.write'), CAP_TIMEOUT_MS, null); } catch (e) { can = null; }
        st.mode = 'shared'; st.db = db; st.userId = uid; st.canWrite = can !== false;
        subscribe();
      } else {
        st.mode = 'local'; st.canWrite = true;
        loadLocal();
      }
    } catch (e) {
      st.mode = 'local'; st.canWrite = true;
      try { loadLocal(); } catch (e2) { st.userId = st.userId || newId(); }
    }
    emit();
    return { mode: st.mode, userId: st.userId, canWrite: st.canWrite };
  }

  // ---------- writes ----------
  async function put(col, data) {
    if (!st.initP) await api.init();
    if (!st.canWrite) return fail('read_only', 'You can look but not change shared data here.');
    var uid = st.userId;
    if (st.mode === 'local') {
      var clean = SAN[col](uid, data);
      if (!clean) return fail('invalid_argument', 'That record is not valid.');
      st.docs[col].set(uid, clean);
      saveLocal(); emit();
      return { ok: true, id: uid };
    }
    try {
      await sharedOp(col + '/' + uid, function () { return st.db.collection(col).doc(uid).set(data); });
      return { ok: true, id: uid };
    } catch (e) { return errResult(e); }
  }

  async function joinAsCitizen(input) {
    input = input || {};
    var name = cleanStr(input.name, 24), nationId = cleanId(input.nationId);
    if (!name) return fail('invalid_argument', 'Please type a name.');
    if (!nationId) return fail('invalid_argument', 'Please pick a nation.');
    if (!st.initP) await api.init();
    return put('citizens', { ownerId: st.userId, name: name, nationId: nationId, traits: cleanTraits(input.traits),
                             seq: nextSeq('citizens'), createdAt: now() });
  }

  async function propose(input) {
    input = input || {};
    var nationId = cleanId(input.nationId), policyId = cleanId(input.policyId), value = cleanValue(input.value);
    if (!nationId) return fail('invalid_argument', 'Please pick a nation.');
    if (!policyId) return fail('invalid_argument', 'Please pick a policy.');
    if (value === null) return fail('invalid_argument', 'The value must be a number or on/off.');
    if (!st.initP) await api.init();
    return put('proposals', { ownerId: st.userId, nationId: nationId, policyId: policyId, value: value,
                              note: cleanStr(input.note, 140), seq: nextSeq('proposals'), createdAt: now() });
  }

  async function vote(proposalId) {
    if (!st.initP) await api.init();
    var pid = cleanId(proposalId), p = st.docs.proposals.get(pid);
    if (!pid || !p) return fail('not_found', 'That proposal no longer exists.');
    return put('votes', { ownerId: st.userId, proposalId: pid, proposalSeq: p.seq,
                          seq: nextSeq('votes'), createdAt: now() });
  }

  async function clearProposal(proposalId) {
    if (!st.initP) await api.init();
    var pid = cleanId(proposalId);
    if (!pid || !st.docs.proposals.has(pid)) return fail('not_found', 'That proposal no longer exists.');
    if (st.mode === 'local') {
      st.docs.proposals.delete(pid);
      Array.from(st.docs.votes.keys()).forEach(function (k) {
        if (st.docs.votes.get(k).proposalId === pid) st.docs.votes.delete(k);
      });
      saveLocal(); emit();
      return { ok: true };
    }
    try {
      await sharedOp('proposals/' + pid, function () { return st.db.collection('proposals').doc(pid).delete(); });
    } catch (e) { return errResult(e); }
    // Best effort: remove votes for it. Others' votes may be refused; stale votes are never counted anyway.
    var ids = [];
    st.docs.votes.forEach(function (v, id) { if (v.proposalId === pid) ids.push(id); });
    await Promise.all(ids.map(function (id) {
      return sharedOp('votes/' + id, function () { return st.db.collection('votes').doc(id).delete(); }).catch(function () {});
    }));
    return { ok: true };
  }

  var api = {
    init: function () {
      if (!st.initP) st.initP = doInit().catch(function () {
        return { mode: 'local', userId: st.userId, canWrite: true };
      });
      return st.initP;
    },
    onChange: function (fn) {
      if (typeof fn !== 'function') return function () {};
      st.listeners.push(fn);
      return function () { st.listeners = st.listeners.filter(function (f) { return f !== fn; }); };
    },
    getAll: function () { return st.snapshot; },
    joinAsCitizen: joinAsCitizen,
    propose: propose,
    vote: vote,
    clearProposal: clearProposal,
    // Extras, not in the contract: current mode (it can flip shared -> local) and why.
    info: function () { return { mode: st.mode, userId: st.userId, canWrite: st.canWrite, fallbackReason: st.fallbackReason }; }
  };

  W.GovStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
