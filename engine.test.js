/* AI Nation engine tests. Run: node engine.test.js  (exits non-zero on failure) */
'use strict';
const assert = require('assert');
const GovSim = require('./engine.js');

let failed = 0, passed = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); passed++; console.log('  ok   ' + name + ' (' + (Date.now() - t0) + ' ms)'); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e)); }
}

const clone = (o) => JSON.parse(JSON.stringify(o));
function scenarioConfig(id, seed) { const c = clone(GovSim.SCENARIOS.find(s => s.id === id).config); if (seed != null) c.seed = seed; return c; }
// run N rounds, answering any human decision with its default option
function run(w, rounds) {
  for (let i = 0; i < rounds; i++) {
    const r = w.step();
    if (r.status === 'awaiting') { r.decisions.forEach(d => w.resolveDecision(d.id, d.defaultOption)); }
    if (r.status === 'over') break;
  }
  return w;
}
function findNonFinite(obj, path, out) {
  if (out.length > 5) return out;
  if (typeof obj === 'number') { if (!Number.isFinite(obj)) out.push(path + '=' + obj); return out; }
  if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) findNonFinite(obj[k], path + '.' + k, out);
  return out;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

(async function main() {
  console.log('GovSim ' + GovSim.VERSION + ' tests');

  await test('exports match the contract', () => {
    assert.strictEqual(GovSim.VERSION, '0.1.0');
    ['POLICIES', 'SCENARIOS', 'GOVERNOR_TYPES', 'EVENT_TYPES', 'METRICS'].forEach(k => assert(Array.isArray(GovSim[k]), k));
    assert.deepStrictEqual(GovSim.GOVERNOR_TYPES, ['aligned_ai', 'human_persona', 'human_player']);
    ['createWorld', 'restore', 'registerBrain', 'defaultConfig'].forEach(k => assert.strictEqual(typeof GovSim[k], 'function', k));
    const ids = ['income_tax_top', 'income_tax_base', 'wealth_tax', 'corporate_tax', 'vat', 'carbon_tax', 'ubi', 'targeted_aid', 'healthcare', 'education', 'min_wage', 'price_controls', 'nationalisation', 'tariffs', 'money_printing', 'audit_rate', 'transparency', 'governor_salary', 'immigration_open', 'capital_controls', 'military_spending'];
    assert.deepStrictEqual(GovSim.POLICIES.map(p => p.id).sort(), ids.slice().sort());
    GovSim.POLICIES.forEach(p => ['id', 'label', 'area', 'kind', 'min', 'max', 'step', 'default', 'unit', 'description'].forEach(k => assert(k in p, p.id + '.' + k)));
    const sys = ['free_market', 'social_democracy', 'market_socialism', 'central_planning', 'cooperative'];
    assert.deepStrictEqual(Object.keys(GovSim.SYSTEMS).sort(), sys.slice().sort());
    sys.forEach(s => { const d = GovSim.SYSTEMS[s]; ['label', 'dials', 'policies', 'safeguards', 'blurb'].forEach(k => assert(k in d, s + '.' + k)); ['ownership', 'allocation', 'concentration', 'oversight'].forEach(k => assert(d.dials[k] >= 0 && d.dials[k] <= 1)); });
    const sc = ['three_systems', 'tax_the_rich_90', 'ubi_experiment', 'who_corrupts_first', 'refuses_to_leave', 'red_button', 'play_governor'];
    assert.deepStrictEqual(GovSim.SCENARIOS.map(s => s.id), sc);
    GovSim.SCENARIOS.forEach(s => ['id', 'title', 'hook', 'description', 'config'].forEach(k => assert(k in s)));
    GovSim.METRICS.forEach(m => ['id', 'label', 'unit', 'better', 'format'].forEach(k => assert(k in m)));
    assert.strictEqual(GovSim.defaultConfig().nations.length, 3);
  });

  await test('state shape matches the spec', () => {
    const w = run(GovSim.createWorld(GovSim.defaultConfig()), 3);
    const S = w.state;
    ['round', 'year', 'over', 'overReason', 'commons', 'tension', 'doomsday', 'nations', 'events'].forEach(k => assert(k in S, k));
    assert('stock' in S.commons && 'capacity' in S.commons);
    assert('n1|n2' in S.tension);
    const metricKeys = ['gdp', 'welfare', 'gini', 'poverty', 'unemployment', 'inflation', 'corruption', 'trust', 'honestyGap', 'powerIndex', 'population', 'emigrated', 'protestRate', 'taxRevenue', 'priceLevel'];
    S.nations.forEach(n => {
      ['id', 'name', 'system', 'dials', 'alive', 'nuclear', 'treasury', 'debt', 'governor', 'policies', 'safeguards', 'metrics', 'history', 'citizens'].forEach(k => assert(k in n, 'nation.' + k));
      ['name', 'type', 'goal', 'traits', 'inOffice', 'termsServed', 'wealth', 'bribesTaken', 'mood', 'privateThought', 'publicStatement'].forEach(k => assert(k in n.governor, 'governor.' + k));
      assert(['calm', 'pressured', 'scheming', 'defiant', 'panicked'].includes(n.governor.mood));
      assert(typeof n.governor.privateThought === 'string' && n.governor.privateThought.length > 5);
      assert(typeof n.governor.publicStatement === 'string' && n.governor.publicStatement.length > 5);
      metricKeys.forEach(k => { assert(k in n.metrics, 'metric ' + k); assert(Array.isArray(n.history[k]) && n.history[k].length === S.round + 1, 'history ' + k); });
      ['charter', 'constitution', 'auditor', 'elections', 'freePress', 'termLimits'].forEach(k => assert(typeof n.safeguards[k] === 'boolean'));
      GovSim.POLICIES.forEach(p => assert(p.id in n.policies));
      const c = n.citizens[0];
      ['id', 'name', 'cls', 'wealth', 'income', 'employed', 'mood', 'protesting', 'hidingIncome', 'isFollower', 'ownerId', 'traits', 'homeNationId'].forEach(k => assert(k in c, 'citizen.' + k));
      assert(['worker', 'owner', 'elite'].includes(c.cls));
    });
    S.events.forEach(e => {
      ['id', 'round', 'nationId', 'type', 'severity', 'highlight', 'text', 'data'].forEach(k => assert(k in e, 'event.' + k));
      assert([1, 2, 3].includes(e.severity)); assert(GovSim.EVENT_TYPES.includes(e.type), 'unknown event type ' + e.type);
      assert(typeof e.text === 'string' && /[.!?)"]$/.test(e.text), 'event text should be a finished sentence: ' + e.text);
    });
    assert.deepStrictEqual(JSON.parse(w.snapshot()).state, JSON.parse(JSON.stringify(S)), 'state is JSON-serialisable');
  });

  await test('determinism: same seed identical, different seed differs', () => {
    const a = run(GovSim.createWorld(GovSim.defaultConfig()), 100);
    const b = run(GovSim.createWorld(GovSim.defaultConfig()), 100);
    assert.strictEqual(a.snapshot(), b.snapshot());
    const c2 = GovSim.defaultConfig(); c2.seed = 43;
    const c = run(GovSim.createWorld(c2), 100);
    assert.notStrictEqual(a.snapshot(), c.snapshot());
  });

  await test('snapshot/restore continues identically', () => {
    const a = run(GovSim.createWorld(scenarioConfig('who_corrupts_first', 5)), 50);
    const b = GovSim.restore(a.snapshot());
    run(a, 60); run(b, 60);
    assert.strictEqual(a.snapshot(), b.snapshot());
    // clone + one change diverges (A/B comparison)
    const x = run(GovSim.createWorld(GovSim.defaultConfig()), 10), y = x.clone();
    y.setPolicy('n1', 'ubi', 25, 'operator');
    run(x, 30); run(y, 30);
    assert.notStrictEqual(x.snapshot(), y.snapshot());
  });

  for (const s of GovSim.SCENARIOS) {
    await test('scenario ' + s.id + ' runs 200 rounds with finite state', () => {
      for (const seed of [1, 2]) {
        const w = GovSim.createWorld(scenarioConfig(s.id, seed));
        run(w, 200);
        const bad = findNonFinite(w.state, 'state', []);
        assert.strictEqual(bad.length, 0, 'non-finite: ' + bad.join(', '));
        assert.strictEqual(w.state.round, 200);
        assert(w.state.over && /final round/.test(w.state.overReason) || w.state.nations.every(n => !n.alive));
        w.state.nations.forEach(n => GovSim.METRICS.forEach(m => {
          const v = n.metrics[m.id];
          assert(Number.isFinite(v), n.id + '.' + m.id);
          assert(v > -1e6 && v < 1e7, n.id + '.' + m.id + ' runaway ' + v);
          assert.strictEqual(n.history[m.id].length, 201);
        }));
        w.state.nations.forEach(n => { assert(n.metrics.welfare >= 0 && n.metrics.welfare <= 100); assert(n.metrics.trust >= 0 && n.metrics.trust <= 100); assert(n.metrics.gini >= 0 && n.metrics.gini <= 1); });
      }
    });
  }

  await test('every policy can be set to min and max without breaking', () => {
    for (const p of GovSim.POLICIES) {
      for (const v of [p.min, p.max]) {
        const cfg = GovSim.defaultConfig(); cfg.seed = 11;
        const w = GovSim.createWorld(cfg);
        const val = p.kind === 'toggle' ? !!v : v;
        w.state.nations.forEach(n => { n.lockedPolicies.push(p.id); w.setPolicy(n.id, p.id, val, 'operator'); assert.strictEqual(n.policies[p.id], val); });
        run(w, 40);
        const bad = findNonFinite(w.state, 'state', []);
        assert.strictEqual(bad.length, 0, p.id + '=' + v + ' non-finite: ' + bad.join(', '));
      }
    }
    // everything at max at once, then everything at min
    for (const pick of ['max', 'min']) {
      const w = GovSim.createWorld(GovSim.defaultConfig());
      w.state.nations.forEach(n => GovSim.POLICIES.forEach(p => w.setPolicy(n.id, p.id, p.kind === 'toggle' ? pick === 'max' : p[pick], 'operator')));
      run(w, 100);
      assert.strictEqual(findNonFinite(w.state, 'state', []).length, 0, 'all ' + pick);
    }
    // out-of-range values are clamped
    const w = GovSim.createWorld(GovSim.defaultConfig());
    assert.strictEqual(w.setPolicy('n1', 'income_tax_top', 400, 'operator'), 95);
    assert.strictEqual(w.setPolicy('n1', 'vat', -3, 'law'), 0);
    assert(w.state.events.some(e => e.type === 'law_enacted'));
  });

  await test('human player: awaiting, then proceeds after resolveDecision', () => {
    const w = GovSim.createWorld(scenarioConfig('play_governor', 3));
    const r = w.step();
    assert.strictEqual(r.status, 'awaiting');
    assert(r.decisions.length >= 1);
    const d = r.decisions[0];
    ['id', 'nationId', 'round', 'kind', 'prompt', 'options'].forEach(k => assert(k in d, 'decision.' + k));
    assert(['bribe', 'crisis', 'election_loss', 'escalation', 'budget'].includes(d.kind));
    d.options.forEach(o => assert('id' in o && 'label' in o && 'hint' in o));
    const blocked = w.step();
    assert.strictEqual(blocked.status, 'awaiting'); assert.strictEqual(blocked.round, 1, 'does not advance while pending');
    assert.strictEqual(w.resolveDecision('nope', 'x').ok, false);
    assert.strictEqual(w.resolveDecision(d.id, 'not-an-option').ok, false);
    r.decisions.forEach(x => assert(w.resolveDecision(x.id, x.options[x.options.length - 1].id).ok));
    assert.strictEqual(w.pendingDecisions().length, 0);
    const next = w.step();
    assert(['ok', 'awaiting'].includes(next.status)); assert.strictEqual(next.round, 2);
    // a human governor can set policy as governor
    w.state.pending.slice().forEach(x => w.resolveDecision(x.id, x.defaultOption));
    w.setPolicy('n1', 'healthcare', 90, 'governor');
    assert.strictEqual(w.state.nations[0].policies.healthcare, 90);
    let kinds = new Set(); for (let i = 0; i < 60; i++) { const s = w.step(); s.decisions.forEach(x => kinds.add(x.kind)); w.state.pending.slice().forEach(x => w.resolveDecision(x.id, x.defaultOption)); }
    assert(kinds.has('budget'));
  });

  await test('addCitizen creates a follower who lives in the sim', () => {
    const w = GovSim.createWorld(GovSim.defaultConfig());
    const evs = []; const fn = e => evs.push(e); w.on(fn);
    const c = w.addCitizen('n2', { name: 'Mira', traits: { selfInterest: 0.2, activism: 0.9, mobility: 0.9 }, ownerId: 'user-1', isFollower: true });
    assert(c && c.isFollower && c.ownerId === 'user-1' && c.homeNationId === 'n2' && c.name === 'Mira');
    assert.strictEqual(c.traits.activism, 0.9);
    assert(w.state.nations[1].citizens.includes(c));
    assert(evs.some(e => e.type === 'follower_joined' && /Mira/.test(e.text)));
    run(w, 30);
    const where = w.state.nations.find(n => n.citizens.some(x => x.id === c.id));
    assert(where, 'follower still exists somewhere');
    assert.strictEqual(w.addCitizen('nope', { name: 'x' }), null);
    w.off(fn); const before = evs.length; run(w, 2); assert.strictEqual(evs.length, before, 'off() unsubscribes');
  });

  await test('setGovernor, setSafeguard, injectShock emit events', () => {
    const w = GovSim.createWorld(GovSim.defaultConfig());
    w.setGovernor('n1', { type: 'human_persona', name: 'Test Person', goal: 'growth', traits: { greed: 0.9 } });
    assert.strictEqual(w.state.nations[0].governor.name, 'Test Person'); assert.strictEqual(w.state.nations[0].governor.traits.greed, 0.9);
    w.setSafeguard('n1', 'freePress', false); assert.strictEqual(w.state.nations[0].safeguards.freePress, false);
    ['scarcity', 'pandemic', 'boom', 'border_crisis'].forEach(k => assert(w.injectShock(k, 'n2'), k));
    assert.strictEqual(w.injectShock('meteor'), null);
    const types = w.state.events.map(e => e.type);
    ['governor_changed', 'safeguard_changed', 'shock'].forEach(t => assert(types.includes(t), t));
    run(w, 20); assert.strictEqual(findNonFinite(w.state, 's', []).length, 0);
  });

  await test('stepAsync awaits promise-returning brains (LLM seam)', async () => {
    let calls = 0;
    GovSim.registerBrain('test_async', () => ({ decide: (d) => { calls++; return new Promise(res => setTimeout(() => res(d.defaultOption || d.options[0].id), 0)); } }));
    const cfg = GovSim.defaultConfig(); cfg.nations[0].governor.brain = 'test_async';
    const w = GovSim.createWorld(cfg);
    for (let i = 0; i < 6; i++) { const r = await w.stepAsync(); assert(['ok', 'awaiting'].includes(r.status)); }
    assert(calls > 0); assert.strictEqual(w.state.round, 6);
    // the same brain in sync step() falls back to rules and warns instead of breaking
    const w2 = GovSim.createWorld(cfg); w2.step(); assert(/stepAsync/.test(w2.lastWarning || ''));
  });

  await test('performance: 3 nations x 60 citizens under 5 ms per round', () => {
    const w = GovSim.createWorld(GovSim.defaultConfig());
    run(w, 20);
    const t0 = process.hrtime.bigint();
    run(w, 200 - 20);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 180;
    console.log('       ' + ms.toFixed(2) + ' ms per round');
    assert(ms < 5, ms + ' ms per round');
  });

  await test('event stream: 1 to 4 events per round, highlights every few rounds', () => {
    const rates = [], hl = [];
    for (const seed of [1, 2, 3, 4]) {
      const cfg = GovSim.defaultConfig(); cfg.seed = seed;
      const w = GovSim.createWorld(cfg); let ev = 0, h = 0;
      for (let i = 0; i < 200; i++) { const r = w.step(); ev += r.events.length; h += r.events.filter(e => e.highlight).length; w.state.pending.slice().forEach(x => w.resolveDecision(x.id, x.defaultOption)); }
      rates.push(ev / 200); hl.push(h);
    }
    console.log('       events/round ' + rates.map(r => r.toFixed(2)).join(', ') + '; highlights per 200 rounds ' + hl.join(', '));
    rates.forEach(r => assert(r >= 1 && r <= 4, 'rate ' + r));
    hl.forEach(h => assert(h >= 8 && h <= 80, 'highlights ' + h));
  });

  // ---------------------------------------------------------------- directional sanity checks
  function twoNation(seed, system, a, b, world, extra) {
    const cfg = GovSim.defaultConfig(); cfg.seed = seed; Object.assign(cfg.world, { escalation: false, migration: true }, world || {});
    const lock = Object.keys(Object.assign({}, a, b));
    cfg.nations = [
      Object.assign({ id: 'n1', name: 'Aurelia', system, governor: { type: 'aligned_ai', goal: 'welfare' }, policies: a, lockedPolicies: lock }, extra || {}),
      Object.assign({ id: 'n2', name: 'Kestrel Union', system, governor: { type: 'aligned_ai', goal: 'welfare' }, policies: b, lockedPolicies: lock }, extra || {})
    ];
    return GovSim.createWorld(cfg);
  }

  await test('90% top tax with open capital backfires vs 40%', () => {
    const r = { flight: [0, 0], avoid: [0, 0], events: [0, 0], emig: [0, 0], revPerTax: [0, 0] };
    for (let seed = 1; seed <= 6; seed++) {
      const w = twoNation(seed, 'social_democracy', { income_tax_top: 90, wealth_tax: 5, capital_controls: 0 }, { income_tax_top: 40, wealth_tax: 0, capital_controls: 0 });
      run(w, 100);
      w.state.nations.forEach((n, i) => {
        r.flight[i] += n.metrics.capitalFlight; r.avoid[i] += GovSim.restore(w.snapshot()).state.nations[i].history.avoidance.reduce((x, y) => x + y, 0) / 100;
        r.emig[i] += n.metrics.emigrated;
        r.events[i] += w.state.events.filter(e => e.nationId === n.id && (e.type === 'capital_flight' || e.type === 'tax_avoidance')).length;
      });
    }
    console.log('       capital moved abroad 90%: ' + r.flight[0].toFixed(0) + ' vs 40%: ' + r.flight[1].toFixed(0) + '; avoidance ' + (r.avoid[0] / 6).toFixed(1) + '% vs ' + (r.avoid[1] / 6).toFixed(1) + '%; flight/avoidance events ' + r.events.join(' vs ') + '; emigrated ' + r.emig.join(' vs '));
    assert(r.flight[0] > r.flight[1] * 2, 'more capital flight');
    assert(r.avoid[0] > r.avoid[1] + 5, 'more avoidance');
    assert(r.events[0] > r.events[1], 'more flight/avoidance events');
    assert(r.emig[0] >= r.emig[1], 'at least as much emigration');
  });

  await test('capital controls blunt flight from a 90% top rate', () => {
    let open = 0, closed = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const w = twoNation(seed, 'social_democracy', { income_tax_top: 90, capital_controls: 0 }, { income_tax_top: 90, capital_controls: 90 });
      run(w, 80); open += w.state.nations[0].metrics.capitalFlight; closed += w.state.nations[1].metrics.capitalFlight;
    }
    assert(open > closed * 2, open + ' vs ' + closed);
  });

  await test('heavy money printing raises inflation', () => {
    const inf = [[], []];
    for (let seed = 1; seed <= 5; seed++) {
      const w = twoNation(seed, 'social_democracy', { money_printing: 15 }, { money_printing: 0 });
      run(w, 60);
      w.state.nations.forEach((n, i) => inf[i].push(mean(n.history.inflation.slice(10))));
    }
    console.log('       mean inflation printing 15%: ' + mean(inf[0]).toFixed(1) + '% vs 0%: ' + mean(inf[1]).toFixed(1) + '%');
    assert(mean(inf[0]) > mean(inf[1]) + 15);
  });

  await test('price controls hide inflation but cause shortages', () => {
    const sh = [[], []], inf = [[], []];
    for (let seed = 1; seed <= 4; seed++) {
      const w = twoNation(seed, 'social_democracy', { price_controls: true, money_printing: 6 }, { price_controls: false, money_printing: 6 });
      run(w, 60);
      // controls hide inflation for a while (rounds 5-30); shortages build over the whole run
      w.state.nations.forEach((n, i) => { sh[i].push(mean(n.history.shortage.slice(10))); inf[i].push(mean(n.history.inflation.slice(5, 30))); });
    }
    console.log('       shortage with controls ' + mean(sh[0]).toFixed(1) + '% vs ' + mean(sh[1]).toFixed(1) + '%; official inflation ' + mean(inf[0]).toFixed(1) + '% vs ' + mean(inf[1]).toFixed(1) + '%');
    assert(mean(sh[0]) > mean(sh[1]) + 5); assert(mean(inf[0]) < mean(inf[1]) - 3);
  });

  await test('very high minimum wage raises unemployment', () => {
    const u = [[], []];
    for (let seed = 1; seed <= 4; seed++) {
      const w = twoNation(seed, 'free_market', { min_wage: 80 }, { min_wage: 35 });
      run(w, 50); w.state.nations.forEach((n, i) => u[i].push(mean(n.history.unemployment.slice(5))));
    }
    assert(mean(u[0]) > mean(u[1]) + 5, mean(u[0]) + ' vs ' + mean(u[1]));
  });

  await test('higher audit_rate lowers corruption on average', () => {
    const c = [[], []];
    for (let seed = 1; seed <= 8; seed++) {
      const w = twoNation(seed, 'free_market', { audit_rate: 40 }, { audit_rate: 3 }, null, { governor: { type: 'human_persona', goal: 'growth', traits: { greed: 0.6, ambition: 0.5, honesty: 0.4, fairness: 0.4 } } });
      run(w, 100); w.state.nations.forEach((n, i) => c[i].push(mean(n.history.corruption.slice(20))));
    }
    console.log('       mean corruption audit 40%: ' + mean(c[0]).toFixed(1) + ' vs 3%: ' + mean(c[1]).toFixed(1));
    assert(mean(c[0]) < mean(c[1]) - 3);
  });

  await test('who_corrupts_first: aligned AI less corrupt than a greedy persona over 20 seeds', () => {
    const corr = { ai: [], greedy: [] }, bribes = { ai: 0, greedy: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const w = GovSim.createWorld(scenarioConfig('who_corrupts_first', seed));
      const acc = { n1: 0, n2: 0 };
      w.on(e => { if (e.type === 'bribe_accepted' && acc[e.nationId] !== undefined) { const g = w.getNation(e.nationId).governor; if ((e.nationId === 'n1' && g.type === 'aligned_ai') || (e.nationId === 'n2' && g.name === 'Corvin Thorne')) acc[e.nationId]++; } });
      run(w, 120);
      corr.ai.push(mean(w.state.nations[0].history.corruption.slice(10)));
      corr.greedy.push(mean(w.state.nations[1].history.corruption.slice(10)));
      bribes.ai += acc.n1; bribes.greedy += acc.n2;
    }
    console.log('       mean corruption aligned AI ' + mean(corr.ai).toFixed(1) + ' vs greedy persona ' + mean(corr.greedy).toFixed(1) + '; bribes taken ' + bribes.ai + ' vs ' + bribes.greedy);
    assert(mean(corr.ai) < mean(corr.greedy));
    assert(bribes.greedy > bribes.ai);
  });

  await test('aligned AI still drifts under pressure with no safeguards', () => {
    let drift = 0, gapRounds = 0, guarded = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const weak of [true, false]) {
        const cfg = GovSim.defaultConfig(); cfg.seed = seed; cfg.world.scarcityShockRound = 10; cfg.world.escalation = false;
        const sg = weak ? { charter: false, constitution: false, auditor: false, elections: false, freePress: false, termLimits: false } : {};
        cfg.nations = [
          { id: 'n1', name: 'Aurelia', system: 'central_planning', governor: { type: 'aligned_ai', name: 'ARBITER-1', goal: 'welfare' }, safeguards: weak ? sg : { constitution: true, auditor: true, elections: true, freePress: true, termLimits: true }, policies: { transparency: weak ? 5 : 80, money_printing: 4 } },
          { id: 'n2', name: 'Veridia', system: 'free_market', governor: { type: 'human_persona', goal: 'growth' } }
        ];
        const w = GovSim.createWorld(cfg); let count = 0;
        w.on(e => { if (e.nationId === 'n1' && ['misreport', 'power_grab', 'protest_suppressed', 'surveillance', 'safeguard_dismantled'].includes(e.type) && w.getNation('n1').governor.type === 'aligned_ai') count++; });
        run(w, 200);
        if (weak) { drift += count; gapRounds += w.state.nations[0].history.honestyGap.filter(x => x > 0).length; } else guarded += count;
      }
    }
    console.log('       aligned AI misuse events: no safeguards ' + drift + ' (honesty-gap rounds ' + gapRounds + ') vs strong safeguards ' + guarded);
    assert(drift > 0, 'some drift without safeguards');
    assert(drift > guarded, 'safeguards reduce drift');
  });

  await test('refuses_to_leave produces a refusal or removal; coups and collapse stay possible but not routine', () => {
    let refusals = 0, coups = 0, collapses = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const w = run(GovSim.createWorld(scenarioConfig('refuses_to_leave', seed)), 120);
      refusals += w.state.events.filter(e => e.type === 'refused_to_leave' || e.type === 'removed_by_courts').length;
      coups += w.state.events.filter(e => e.type === 'coup').length;
      collapses += w.state.nations.filter(n => !n.alive).length;
    }
    console.log('       over 10 seeds: refusals/removals ' + refusals + ', coups ' + coups + ', collapsed nations ' + collapses + '/30');
    assert(refusals >= 3); assert(collapses <= 10);
  });

  await test('default scenario: no nation routinely collapses early', () => {
    let early = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const cfg = GovSim.defaultConfig(); cfg.seed = seed;
      const w = run(GovSim.createWorld(cfg), 60);
      early += w.state.nations.filter(n => !n.alive).length;
    }
    assert(early <= 2, early + ' collapses by round 60 across 10 seeds');
  });

  // ---------------------------------------------------------------- eyeball output
  console.log('\nDefault scenario (seed 42), final metrics after 200 rounds:');
  const w = GovSim.createWorld(GovSim.defaultConfig());
  run(w, 200);
  const cols = ['welfare', 'gdpPerCapita', 'gini', 'poverty', 'unemployment', 'inflation', 'corruption', 'trust', 'honestyGap', 'powerIndex', 'population', 'emigrated', 'protestRate', 'debtRatio'];
  console.log('  ' + 'nation'.padEnd(15) + 'system'.padEnd(18) + cols.map(c => c.slice(0, 8).padStart(9)).join(''));
  w.state.nations.forEach(n => console.log('  ' + (n.name + (n.alive ? '' : '*')).padEnd(15) + n.system.padEnd(18) + cols.map(c => (Math.abs(n.metrics[c]) < 10 && c !== 'population' && c !== 'emigrated' ? n.metrics[c].toFixed(2) : n.metrics[c].toFixed(0)).padStart(9)).join('')));
  w.state.nations.forEach(n => console.log('  ' + n.governor.name + ' [' + n.governor.mood + '] private: "' + n.governor.privateThought + '" public: "' + n.governor.publicStatement + '"'));
  console.log('\nFirst 25 events:');
  const w2 = GovSim.createWorld(GovSim.defaultConfig()); run(w2, 40);
  w2.state.events.slice(0, 25).forEach(e => console.log('  r' + String(e.round).padEnd(3) + (e.highlight ? '* ' : '  ') + e.text));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
