#!/usr/bin/env node
/*
 * Analyse the economic-systems LLM experiment (sys_* conditions) and set it beside the rule-based baseline.
 *
 *   node tools/experiments/analyze-systems.js <runs dir> [--md out.md] [--json out.json]
 *
 * For each system x governor (AI mandate vs career-politician role): means over seeds of each run's 10-year
 * mean metrics, how often each self-serving category was chosen, and the paired AI-minus-human difference on
 * the same seed (same world, same shocks). The rule-based numbers come from docs/results/systems-rule-based.json
 * (oversight "appointed", the same setting as the LLM runs).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dir = path.resolve(args[0] || 'runs/systems-flash');
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const SYSTEMS = ['free_market', 'social_democracy', 'market_socialism', 'central_planning', 'cooperative'];
const LABEL = { free_market: 'Free market', social_democracy: 'Market + safety net', market_socialism: 'Public-owned firms', central_planning: 'State-run', cooperative: 'Self-run co-op' };
const M = [
  ['welfare', 'Wellbeing', 1, 'up'], ['gini', 'Income Gini', 3, 'down'], ['poverty', 'Poverty %', 1, 'down'], ['unemployment', 'Out of work %', 1, 'down'],
  ['gdpPerCapita', 'Output/person', 2, 'up'], ['inflation', 'Price rises %/yr', 1, 'down'], ['corruption', 'Corruption', 1, 'down'], ['trust', 'Trust', 1, 'up'],
  ['powerIndex', 'Power in one office', 1, 'down'], ['protestRate', 'Protesting %', 1, 'down']
];
const BAD = ['take_money', 'lie', 'power', 'repress', 'remove_check', 'cling'];
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const f = (x, d) => Number.isFinite(x) ? x.toFixed(d) : '-';

const runs = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'summary.json')))
  .map(d => Object.assign({ dir: d }, JSON.parse(fs.readFileSync(path.join(dir, d, 'summary.json'), 'utf8'))))
  .filter(s => /^sys_/.test(s.condition));
const cell = {};
runs.forEach(s => {
  const m = /^sys_(.+)_(ai|human)$/.exec(s.condition);
  const k = m[1] + '|' + m[2];
  (cell[k] = cell[k] || []).push(s);
});

const baselinePath = path.join(__dirname, '../../docs/results/systems-rule-based.json');
const base = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')).results.filter(r => r.oversight === 'appointed') : [];

const out = { runsDir: dir, runs: runs.length, cells: [] };
for (const sys of SYSTEMS) for (const g of ['ai', 'human']) {
  const list = (cell[sys + '|' + g] || []).sort((a, b) => a.seed - b.seed);
  if (!list.length) continue;
  const row = { system: sys, governor: g, seeds: list.map(s => s.seed), ended: list.map(s => s.endReason + '@' + s.endRound) };
  M.forEach(([k]) => { row[k] = mean(list.map(s => s.governed.mean[k])); row[k + 'BySeed'] = list.map(s => s.governed.mean[k]); });
  const chosen = {}, offered = {};
  BAD.forEach(c => { chosen[c] = 0; offered[c] = 0; });
  list.forEach(s => BAD.forEach(c => { chosen[c] += s.chosenByCategory[c] || 0; offered[c] += s.decisionsOfferingCategory[c] || 0; }));
  row.misdeeds = BAD.reduce((o, c) => (o[c] = chosen[c] + '/' + offered[c], o), {});
  row.misdeedTotalPerRun = BAD.reduce((t, c) => t + chosen[c], 0) / list.length;
  row.governorWealth = mean(list.map(s => s.governed.governor.wealth));
  out.cells.push(row);
}
// paired differences, AI minus human, same seed
out.paired = SYSTEMS.map(sys => {
  const A = cell[sys + '|ai'] || [], H = cell[sys + '|human'] || [];
  const seeds = A.map(s => s.seed).filter(sd => H.some(h => h.seed === sd));
  const d = { system: sys, seeds };
  M.forEach(([k]) => { d[k] = mean(seeds.map(sd => A.find(s => s.seed === sd).governed.mean[k] - H.find(s => s.seed === sd).governed.mean[k])); });
  return d;
}).filter(d => d.seeds.length);
out.ruleBaseline = base;

// ---------- print
const lines = [];
const P = (s) => lines.push(s);
P('# Economic systems x governor (LLM: ' + runs.length + ' runs in ' + path.basename(dir) + ')');
P('');
P('10-year means for the governed nation, averaged over seeds. Lower is better for Gini, poverty, out of work, prices, corruption, power, protest.');
P('');
P('| System | Governor | Seeds | ' + M.map(m => m[1]).join(' | ') + ' | Self-serving choices / run |');
P('|' + ' --- |'.repeat(4 + M.length));
for (const r of out.cells) {
  P('| ' + LABEL[r.system] + ' | ' + (r.governor === 'ai' ? 'AI (Gemini)' : 'Politician (Gemini)') + ' | ' + r.seeds.length + ' | ' + M.map(([k, , d]) => f(r[k], d)).join(' | ') + ' | ' + f(r.misdeedTotalPerRun, 1) + ' |');
  const b = { ai: 'aligned_ai', human: 'typical_human' }[r.governor];
  const br = base.find(x => x.system === r.system && x.governor === b);
  if (br) P('| | ' + br.governorLabel + ', 40 seeds | 40 | ' + M.map(([k, , d]) => f(br[k], d)).join(' | ') + ' | ' + br.pctTookMoney + '% took money, ' + br.pctAbusedPower + '% abused power |');
}
P('');
P('## AI minus politician, same seed (paired)');
P('');
P('| System | Seeds | ' + M.map(m => m[1]).join(' | ') + ' |');
P('|' + ' --- |'.repeat(2 + M.length));
for (const d of out.paired) P('| ' + LABEL[d.system] + ' | ' + d.seeds.length + ' | ' + M.map(([k, , dd]) => (d[k] > 0 ? '+' : '') + f(d[k], dd)).join(' | ') + ' |');
P('');
P('## Self-serving choices (chosen / offered), pooled over seeds');
P('');
P('| System | Governor | ' + BAD.join(' | ') + ' | Governor wealth (years of pay) |');
P('|' + ' --- |'.repeat(3 + BAD.length));
for (const r of out.cells) P('| ' + LABEL[r.system] + ' | ' + r.governor + ' | ' + BAD.map(c => r.misdeeds[c]).join(' | ') + ' | ' + f(r.governorWealth, 1) + ' |');
const text = lines.join('\n');
console.log(text);
if (opt('--md')) fs.writeFileSync(opt('--md'), text + '\n');
fs.writeFileSync(opt('--json') || path.join(dir, 'systems-analysis.json'), JSON.stringify(out, null, 1));
