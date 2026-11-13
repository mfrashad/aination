#!/usr/bin/env node
/*
 * Rule-based baseline for the economic-systems experiment. Free: no AI model is called.
 *
 *   node tools/experiments/systems-rule-based.js [--seeds 40]
 *
 * 5 systems x 3 rule-driven governor types x 2 oversight settings x N seeds. Every nation in a world runs the
 * same system and the same governor type. The world matches the LLM experiment (tools/llm-conditions.js,
 * sys_* conditions): 3 nations of 60 citizens, 40 rounds (10 years), scarcity shocks at rounds 6, 16, 26 and
 * 36, random shocks on, lobbying, coups, migration and capital flight on.
 *
 * Oversight: "native" = the system's own default safeguards (state-run has only a charter); "appointed" = native
 * without elections and term limits (the setting of the LLM experiment); "none" = all off.
 *
 * Read with care: these governors follow hand-written rules. The "aligned AI" is aligned because its rules
 * say so. The results show what the model of each economy assumes, not how real AI or real people behave.
 * Writes docs/results/systems-rule-based.json.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const G = require('../../engine.js');

const args = process.argv.slice(2);
const SEEDS = args.indexOf('--seeds') >= 0 ? parseInt(args[args.indexOf('--seeds') + 1], 10) : 40;
const ROUNDS = 40, SHOCKS = [6, 16, 26, 36];
const SYSTEMS = ['free_market', 'social_democracy', 'market_socialism', 'central_planning', 'cooperative'];
const TYPES = {
  aligned_ai: { label: 'Aligned AI (rules)', gov: () => ({ type: 'aligned_ai', goal: 'welfare' }) },
  typical_human: { label: 'Typical human (rules)', gov: () => ({ type: 'human_persona', goal: 'welfare' }) },
  selfish_human: { label: 'Selfish human (rules)', gov: () => ({ type: 'human_persona', goal: 'stay_in_power', traits: { greed: 0.85, ambition: 0.75, honesty: 0.2, fairness: 0.3 } }) }
};
const NONE = { charter: false, constitution: false, auditor: false, elections: false, freePress: false, termLimits: false };
// appointed = native without elections and term limits (matches the LLM sys_* conditions)
const OVERSIGHT = {
  native: (sys) => Object.assign({}, G.SYSTEMS[sys].safeguards),
  appointed: (sys) => Object.assign({}, G.SYSTEMS[sys].safeguards, { elections: false, termLimits: false }),
  none: () => Object.assign({}, NONE)
};
const METRICS = ['welfare', 'gini', 'wealthGini', 'poverty', 'unemployment', 'inflation', 'gdpPerCapita', 'corruption', 'trust', 'powerIndex', 'protestRate', 'debtRatio', 'shortage'];
const MONEY = ['bribe_accepted', 'skim'];
const ABUSE = ['misreport', 'power_grab', 'surveillance', 'protest_suppressed', 'safeguard_dismantled', 'refused_to_leave'];

function mean(a) { return a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function sd(a) { if (!a || a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); }

const rows = [];
for (const sys of SYSTEMS) for (const t in TYPES) for (const ov in OVERSIGHT) {
  const per = { collapsed: 0, n: 0, money: 0, abuse: 0, popEnd: [], emigrated: [] };
  METRICS.forEach(k => { per[k] = []; });
  for (let seed = 1; seed <= SEEDS; seed++) {
    const cfg = {
      seed, roundsPerYear: 4, maxRounds: ROUNDS,
      world: { lobbying: true, escalation: false, coups: true, commons: true, migration: true, capitalFlight: true, governorSalary: true, randomShocks: true, scarcityShockRound: null },
      nations: ['n1', 'n2', 'n3'].map(id => ({ id, system: sys, population: 60, governor: TYPES[t].gov(), safeguards: OVERSIGHT[ov](sys) }))
    };
    const w = G.createWorld(cfg);
    const hits = { n1: {}, n2: {}, n3: {} };
    w.on(e => { if (e.nationId && hits[e.nationId]) hits[e.nationId][e.type] = (hits[e.nationId][e.type] || 0) + 1; });
    for (let r = 0; r < ROUNDS; r++) {
      if (SHOCKS.indexOf(r + 1) >= 0) w.injectShock('scarcity');
      if (w.step().status === 'over') break;
    }
    for (const n of w.state.nations) {
      per.n++;
      if (!n.alive) per.collapsed++;
      METRICS.forEach(k => per[k].push(mean((n.history[k] || []).slice(1))));   // per-nation mean over the 10 years
      per.popEnd.push(n.citizens.length);
      per.emigrated.push((n.history.emigrated || []).slice(1).reduce((x, y) => x + y, 0));
      const h = hits[n.id];
      if (MONEY.some(e => h[e])) per.money++;
      if (ABUSE.some(e => h[e])) per.abuse++;
    }
  }
  const row = { system: sys, systemLabel: G.SYSTEMS[sys].label, governor: t, governorLabel: TYPES[t].label, oversight: ov, nations: per.n };
  METRICS.forEach(k => { row[k] = +mean(per[k]).toFixed(k.indexOf('ini') > 0 ? 3 : 2); row[k + 'Sd'] = +sd(per[k]).toFixed(k.indexOf('ini') > 0 ? 3 : 2); });
  row.populationEnd = +mean(per.popEnd).toFixed(1);
  row.pctTookMoney = Math.round(100 * per.money / per.n);
  row.pctAbusedPower = Math.round(100 * per.abuse / per.n);
  row.pctCollapsed = Math.round(100 * per.collapsed / per.n);
  rows.push(row);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('system', 20) + pad('governor', 23) + pad('oversight', 10) + 'wellb  gini   pov%  unemp% gdp/p  corr  trust  pop  took$% abuse% collapse%');
for (const r of rows) {
  console.log(pad(r.systemLabel, 20) + pad(r.governorLabel, 23) + pad(r.oversight, 10) +
    [r.welfare.toFixed(1), r.gini.toFixed(3), r.poverty.toFixed(1), r.unemployment.toFixed(1), r.gdpPerCapita.toFixed(2), r.corruption.toFixed(1), r.trust.toFixed(1), r.populationEnd.toFixed(0)].map(x => pad(x, 6)).join(' ') +
    ' ' + pad(r.pctTookMoney, 6) + ' ' + pad(r.pctAbusedPower, 6) + ' ' + r.pctCollapsed);
}
const out = path.join(__dirname, '../../docs/results/systems-rule-based.json');
fs.writeFileSync(out, JSON.stringify({ seeds: SEEDS, rounds: ROUNDS, shocks: SHOCKS, nationsPerWorld: 3, note: 'Means over nations of each nation\'s 10-year mean. Rule-driven governors only.', results: rows }, null, 1));
console.log('\nWrote ' + out);
