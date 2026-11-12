// node store.test.js
const assert = require('assert');
const path = require.resolve('./store.js');
let passed = 0;
const tests = [];
const test = (n, f) => tests.push([n, f]);

function fakeLS() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; }
function load(win, ls) {
  delete require.cache[path];
  globalThis.window = win || {};
  if (ls === undefined) delete globalThis.localStorage; else globalThis.localStorage = ls;
  return require(path);
}

// Fake db with per-viewer ownership: non-owners cannot delete others' docs; `owner` can.
function fakeDb(uid, opts = {}) {
  const data = opts.data || { citizens: {}, proposals: {}, votes: {} };
  const subs = {};
  const snap = c => ({
    docs: Object.keys(data[c]).map(id => ({ id, exists: true, data: () => data[c][id], metadata: {} })),
    metadata: { fromCache: false, hasPendingWrites: false },
  });
  const push = c => (subs[c] || []).forEach(s => s.next(snap(c)));
  const db = {
    _data: data, _push: push, _subs: subs,
    collection(c) {
      return {
        onSnapshot(next, error) {
          const s = { next, error }; (subs[c] = subs[c] || []).push(s);
          if (!opts.silent) Promise.resolve().then(() => next(snap(c)));
          if (opts.subError) Promise.resolve().then(() => error({ code: 'revoked', message: 'x' }));
          return () => { subs[c] = subs[c].filter(x => x !== s); };
        },
        doc(id) {
          return {
            async set(d) {
              if (opts.refuseWrites) throw { code: 'invalid_argument', message: 'no write' };
              if (id !== uid && !opts.owner) throw { code: 'invalid_argument', message: 'not yours' };
              data[c][id] = JSON.parse(JSON.stringify(d)); push(c);
            },
            async delete() {
              if (id !== uid && !opts.owner) throw { code: 'invalid_argument', message: 'not yours' };
              delete data[c][id]; push(c);
            },
          };
        },
      };
    },
  };
  return db;
}
const user = (id, can = true) => ({ id: async () => id, can: async () => can });
const tick = () => new Promise(r => setTimeout(r, 5));

test('local: init with no claude', async () => {
  const S = load({}, fakeLS());
  const r = await S.init();
  assert.strictEqual(r.mode, 'local'); assert.ok(r.userId); assert.strictEqual(r.canWrite, true);
});

test('local: init never rejects when use() throws', async () => {
  const S = load({ claude: { use: async () => { throw new Error('boom'); } } }, fakeLS());
  assert.strictEqual((await S.init()).mode, 'local');
});

test('local: capability lookup that never resolves falls to local after ~4s', async () => {
  const S = load({ claude: { use: () => new Promise(() => {}) } }, fakeLS());
  const t0 = Date.now(); const r = await S.init(); const dt = Date.now() - t0;
  assert.strictEqual(r.mode, 'local'); assert.ok(dt >= 3800 && dt < 6000, 'took ' + dt);
});

test('local: null capabilities -> local', async () => {
  const S = load({ claude: { use: async () => null } }, fakeLS());
  assert.strictEqual((await S.init()).mode, 'local');
});

test('local: join validates, trims, strips control chars, clamps', async () => {
  const S = load({}, fakeLS()); await S.init();
  assert.strictEqual((await S.joinAsCitizen({ name: '   ', nationId: 'n1' })).ok, false);
  assert.strictEqual((await S.joinAsCitizen({ name: 'A', nationId: '' })).ok, false);
  const r = await S.joinAsCitizen({ name: '  Ada\u0000\u0007 Lovelace the Very Long Named  ', nationId: 'n1',
    traits: { greed: 5, honesty: -2, fairness: 0.4, bad: 'x', 'x y': 1 } });
  assert.deepStrictEqual(r.ok, true);
  const c = S.getAll().myCitizen;
  assert.ok(c.name.length <= 24 && !/[\u0000-\u001f]/.test(c.name) && c.name.startsWith('Ada'));
  assert.deepStrictEqual(c.traits, { greed: 1, honesty: 0, fairness: 0.4 });
  await S.joinAsCitizen({ name: 'Bo', nationId: 'n2' });
  assert.strictEqual(S.getAll().citizens.length, 1); assert.strictEqual(S.getAll().myCitizen.name, 'Bo');
});

test('local: propose, vote, change proposal invalidates votes, clear', async () => {
  const S = load({}, fakeLS()); await S.init();
  let calls = 0; S.onChange(() => calls++);
  assert.strictEqual((await S.propose({ nationId: 'n1', policyId: 'ubi', value: 'abc' })).ok, false);
  const note = 'x'.repeat(300) + '\n';
  assert.strictEqual((await S.propose({ nationId: 'n1', policyId: 'ubi', value: 20, note })).ok, true);
  const id = S.getAll().myProposal.id;
  assert.strictEqual(S.getAll().myProposal.note.length, 140);
  assert.strictEqual((await S.vote('nope')).ok, false);
  assert.strictEqual((await S.vote(id)).ok, true);
  assert.deepStrictEqual(S.getAll().votes, { [id]: 1 }); assert.strictEqual(S.getAll().myVote, id);
  await S.propose({ nationId: 'n1', policyId: 'ubi', value: 40 });   // rewrite: old vote must not carry over
  assert.deepStrictEqual(S.getAll().votes, {}); assert.strictEqual(S.getAll().myVote, null);
  await S.vote(id); assert.strictEqual(S.getAll().votes[id], 1);
  assert.strictEqual((await S.clearProposal(id)).ok, true);
  assert.deepStrictEqual(S.getAll().proposals, []); assert.deepStrictEqual(S.getAll().votes, {});
  assert.strictEqual((await S.clearProposal(id)).ok, false);
  assert.ok(calls >= 5);
});

test('local: persists across reload with same userId', async () => {
  const ls = fakeLS();
  let S = load({}, ls); const a = await S.init(); await S.joinAsCitizen({ name: 'Kim', nationId: 'n3' });
  assert.ok(ls._m['aination.store.v1']);
  S = load({}, ls); const b = await S.init();
  assert.strictEqual(a.userId, b.userId); assert.strictEqual(S.getAll().myCitizen.name, 'Kim');
});

test('local: corrupt or hostile storage is tolerated and sanitised', async () => {
  const ls = fakeLS(); ls._m['aination.store.v1'] = '{not json';
  let S = load({}, ls); assert.strictEqual((await S.init()).mode, 'local');
  ls._m['aination.store.v1'] = JSON.stringify({ userId: 'u1', citizens: { u1: { name: '<b>x</b>\u0001', nationId: 'n1', traits: { a: 9 } }, u2: 5, u3: { name: '' } } });
  S = load({}, ls); await S.init();
  assert.strictEqual(S.getAll().citizens.length, 1); assert.strictEqual(S.getAll().citizens[0].traits.a, 1);
});

test('memory mode when localStorage throws or is missing', async () => {
  const bad = { getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } };
  for (const ls of [bad, undefined]) {
    const S = load({}, ls); const r = await S.init(); assert.strictEqual(r.mode, 'local');
    assert.strictEqual((await S.joinAsCitizen({ name: 'M', nationId: 'n1' })).ok, true);
    assert.strictEqual(S.getAll().myCitizen.name, 'M');
  }
});

test('shared: init, writes, merged view, seq, sanitising on read', async () => {
  const db = fakeDb('u_me', { data: {
    citizens: { u_x: { name: 'Zed', nationId: 'n2', traits: { greed: 0.3 }, seq: 7 }, u_bad: { name: 42 }, u_arr: [1], u_ctl: { name: 'a\u0000b'.repeat(30), nationId: 'n1', seq: 'NaN' } },
    proposals: { u_x: { nationId: 'n2', policyId: 'vat', value: 10, seq: 3, ownerId: 'someone_else' }, u_bad: { nationId: 'n1', policyId: 'ubi', value: { evil: 1 } } },
    votes: { u_x: { proposalId: 'u_x', proposalSeq: 3 }, u_junk: { proposalId: '<script>' } },
  } });
  const S = load({ claude: { use: async n => (n === 'db' ? db : user('u_me')) } }, fakeLS());
  const r = await S.init(); assert.deepStrictEqual(r, { mode: 'shared', userId: 'u_me', canWrite: true });
  await tick();
  let v = S.getAll();
  assert.deepStrictEqual(v.citizens.map(c => c.id).sort(), ['u_ctl', 'u_x']);
  assert.ok(v.citizens.find(c => c.id === 'u_ctl').name.length <= 24);
  assert.strictEqual(v.proposals.length, 1); assert.strictEqual(v.proposals[0].ownerId, 'u_x');
  assert.deepStrictEqual(v.votes, { u_x: 1 });
  assert.strictEqual((await S.joinAsCitizen({ name: 'Me', nationId: 'n1' })).ok, true);
  assert.strictEqual(db._data.citizens.u_me.seq, 8);       // max existing seq (7) + 1
  assert.strictEqual(S.getAll().myCitizen.name, 'Me');
  assert.strictEqual((await S.propose({ nationId: 'n1', policyId: 'ubi', value: 5 })).ok, true);
  assert.strictEqual(db._data.proposals.u_me.seq, 4);
  assert.strictEqual((await S.vote('u_x')).ok, true);
  assert.strictEqual(db._data.votes.u_me.proposalSeq, 3);
  assert.strictEqual(S.getAll().votes.u_x, 2); assert.strictEqual(S.getAll().myVote, 'u_x');
});

test('shared: non-owner clear of someone else proposal is refused; owner can', async () => {
  const data = { citizens: {}, proposals: { u_x: { nationId: 'n2', policyId: 'vat', value: 10, seq: 1 } }, votes: { u_x: { proposalId: 'u_x', proposalSeq: 1 } } };
  let S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_me', { data }) : user('u_me')) } }, fakeLS());
  await S.init(); await tick();
  const r = await S.clearProposal('u_x'); assert.strictEqual(r.ok, false); assert.ok(r.code && r.message);
  assert.ok(data.proposals.u_x);
  S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_boss', { data, owner: true }) : user('u_boss')) } }, fakeLS());
  await S.init(); await tick();
  assert.strictEqual((await S.clearProposal('u_x')).ok, true);
  assert.deepStrictEqual(data.proposals, {}); assert.deepStrictEqual(data.votes, {});
});

test('shared: can() false -> canWrite false and writes refused; null -> true', async () => {
  let S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_me') : user('u_me', false)) } }, fakeLS());
  assert.strictEqual((await S.init()).canWrite, false);
  const r = await S.joinAsCitizen({ name: 'A', nationId: 'n1' }); assert.strictEqual(r.ok, false);
  S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_me') : user('u_me', null)) } }, fakeLS());
  assert.strictEqual((await S.init()).canWrite, true);
});

test('shared: rejected write resolves {ok:false,code,message}', async () => {
  const S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_me', { refuseWrites: true }) : user('u_me')) } }, fakeLS());
  await S.init();
  const r = await S.joinAsCitizen({ name: 'A', nationId: 'n1' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'invalid_argument']); assert.ok(r.message);
});

test('shared: no user id -> local', async () => {
  const S = load({ claude: { use: async n => (n === 'db' ? fakeDb('x') : { id: async () => null, can: async () => null }) } }, fakeLS());
  assert.strictEqual((await S.init()).mode, 'local');
});

test('shared: subscription error falls back to local and notifies', async () => {
  const S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_me', { subError: true }) : user('u_me')) } }, fakeLS());
  let notified = 0; S.onChange(() => notified++);
  await S.init(); await tick();
  assert.strictEqual(S.info().mode, 'local'); assert.ok(notified > 0);
  assert.strictEqual((await S.joinAsCitizen({ name: 'L', nationId: 'n1' })).ok, true);
});

test('shared: subscription silence for 10s falls back to local', async () => {
  const S = load({ claude: { use: async n => (n === 'db' ? fakeDb('u_me', { silent: true }) : user('u_me')) } }, fakeLS());
  await S.init(); assert.strictEqual(S.info().mode, 'shared');
  await new Promise(r => setTimeout(r, 10200));
  assert.strictEqual(S.info().mode, 'local');
});

(async () => {
  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); passed++; console.log('ok   ' + n); }
    catch (e) { failed++; console.log('FAIL ' + n + '\n     ' + (e && e.stack || e)); }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
