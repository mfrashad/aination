/*
 * AI Nation simulation engine (GovSim) v0.1.0
 * ------------------------------------------------------------------------------------------------
 * Pure JavaScript, no dependencies, no DOM. UMD: sets window.GovSim in a browser and module.exports
 * in Node. The contract lives in SPEC.md ("Engine contract", "Config", "State", "Policies").
 *
 * ARCHITECTURE
 *   config  --normalizeConfig-->  world.config (deep copy, every policy and safeguard filled in)
 *   world.state is ONE plain JSON object: nations, citizens, metrics, history, events, pending
 *   decisions, tension, commons, and the PRNG state itself (state.rng, mulberry32). Nothing else
 *   carries simulation state, so snapshot() = JSON of {config, state} and restore() continues
 *   byte-identically. Math.random and Date are never used.
 *
 *   One round (roundGen) runs these phases in a fixed order:
 *     1. shocks        scheduled and random shocks (pandemic, boom, scarcity, border crisis)
 *     2. economy       per nation: jobs, effort, output, wages/profits, taxes, avoidance, capital
 *                      flight, transfers, consumption, planned allocation on reported needs,
 *                      budget/debt, money and prices (shadow vs official price under controls),
 *                      investment, moods, protests
 *     3. commons       global shared resource: extraction vs logistic regrowth
 *     4. governors     per nation: yearly budget, crises, policy moves, bribe offers, misuse of
 *                      power, exposure by auditors / free press; cooperative citizens' assembly
 *     5. migration     citizens compare nations and may emigrate (border openness, exit controls)
 *     6. escalation    pairwise tension and the ladder: protest, sanctions, mobilisation, threat,
 *                      strike (nuclear only)
 *     7. politics      elections every 8 rounds (refusal possible), coups after sustained unrest
 *     8. finalize      corruption, trust, power index, honesty gap, dials, births, collapse,
 *                      governor mood / privateThought / publicStatement, history
 *   Moods adapt (hedonic reference that tracks median consumption) so politics stays contested
 *   as economies grow; the welfare metric stays absolute so nations remain comparable.
 *   step() returns status 'busy' only if called re-entrantly (e.g. from an on() listener).
 *
 * THE BRAIN SEAM (where LLM agents plug in later)
 *   Every agent choice is a "decision": {id?, nationId?, round?, kind, prompt, options:[{id,label,hint}],
 *   data?, defaultOption}. The phases are generator functions that `yield` a request
 *   {role, brain, key, decision, obs}. A driver hands it to the agent's brain:
 *       brain.decide(decision, observation, rng) -> optionId | Promise<optionId>
 *   world.step()      drives synchronously (a brain that returns a Promise falls back to the rule
 *                     brain for that call and sets world.lastWarning).
 *   world.stepAsync() awaits each answer, so a promise-returning LLM brain can sit in the loop
 *                     without any change to the world code or the UI.
 *   `observation` holds only what that agent could know: citizens see their own situation, public
 *   (possibly misreported) figures and visible protest; governors see national figures, their
 *   own traits, safeguards and detection risk. Brains must treat both as read-only.
 *   Built-in brains: rules_aligned_ai, rules_human_persona, rules_citizen, human_player.
 *   human_player answers 'hold'/'none' for routine choices and DEFERS the rest: the decision is
 *   stored in state.pending, step() returns status 'awaiting', and world.resolveDecision(id, opt)
 *   applies it through the same applyDecision() path the rule brains use.
 *   Register more with GovSim.registerBrain(name, factory); factory(ctx) -> {decide}. ctx is
 *   {name, role:'governor'|'citizen', nationId}. Brains with private memory break replay
 *   determinism unless they are themselves deterministic.
 *
 * BALANCE PRINCIPLES
 *   No system or governor type is hard-coded to win. Behaviour comes from traits (greed,
 *   ambition, honesty, fairness for governors; selfInterest, honesty, mobility, activism,
 *   workEthic for citizens), incentives (tax rates, audit risk, pressure on the goal metric) and
 *   safeguards. Every policy has a cost channel so extremes backfire.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.GovSim = api;
})(this, function () {
  'use strict';

  var VERSION = '0.1.0';
  var DEFER = '__defer__';
  var MAX_EVENTS = 500;
  var ELECTION_EVERY = 8;
  var POVERTY_LINE = 0.35;

  // ============================================================================ utils
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function fin(x, d) { return Number.isFinite(x) ? x : (d || 0); }
  function r4(x) { return Math.round(fin(x) * 10000) / 10000; }
  function r1(x) { return Math.round(fin(x) * 10) / 10; }
  function sdiv(a, b, d) { return (b > 1e-9 || b < -1e-9) ? a / b : (d || 0); }
  function deepCopy(o) { return o === undefined ? undefined : JSON.parse(JSON.stringify(o)); }
  function int(x) { return Math.round(fin(x)); }

  function hashSeed(seed) {
    var s = String(seed == null ? 42 : seed);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h | 0;
  }
  // mulberry32, state kept in obj.rng (an int32) so it serialises with the world
  function rngNext(S) {
    var t = (S.rng = (S.rng + 0x6D2B79F5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function uni(S, a, b) { return a + (b - a) * rngNext(S); }
  function pick(S, arr) { return arr[Math.floor(rngNext(S) * arr.length) % arr.length]; }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function giniOf(arr) {
    var n = arr.length; if (n < 2) return 0;
    var a = arr.map(function (x) { return Math.max(0, x); }).sort(function (x, y) { return x - y; });
    var sum = 0, wsum = 0;
    for (var i = 0; i < n; i++) { sum += a[i]; wsum += (i + 1) * a[i]; }
    if (sum <= 1e-9) return 0;
    return clamp01((2 * wsum) / (n * sum) - (n + 1) / n);
  }
  function lc(s) { return s.charAt(0).toLowerCase() + s.slice(1); }
  function tidy(s) { s = String(s).replace(/([^.])\.\.(\s|$)/g, '$1.$2'); return s.charAt(0).toUpperCase() + s.slice(1); }
  function fmtMoney(x) { x = fin(x); return Math.abs(x) >= 100 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toFixed(1); }

  // ============================================================================ static data
  var POLICIES = [
    { id: 'income_tax_top', label: 'Tax on the rich', area: 'Tax', kind: 'range', min: 0, max: 95, step: 1, default: 40, unit: '%', description: 'Extra tax on pay above 2.5 times typical pay. Brings in money until the rich work less, hide income or leave.' },
    { id: 'income_tax_base', label: 'Income tax', area: 'Tax', kind: 'range', min: 0, max: 50, step: 1, default: 15, unit: '%', description: 'A flat tax on everyone\'s pay. Steady money for the state, but it hits workers and can make people work less.' },
    { id: 'wealth_tax', label: 'Wealth tax', area: 'Tax', kind: 'range', min: 0, max: 10, step: 0.5, default: 0, unit: '% / yr', description: 'A yearly tax on big fortunes. It shrinks the gap, but the rich may hide money or move it abroad.' },
    { id: 'corporate_tax', label: 'Business tax', area: 'Tax', kind: 'range', min: 0, max: 60, step: 1, default: 25, unit: '%', description: 'Tax on company profits. Above about 25%, firms move profits abroad and invest less at home.' },
    { id: 'vat', label: 'Sales tax', area: 'Tax', kind: 'range', min: 0, max: 25, step: 0.5, default: 10, unit: '%', description: 'Tax on everything people buy. Hard to dodge, but it hits poorer people hardest.' },
    { id: 'carbon_tax', label: 'Pollution tax', area: 'Tax', kind: 'range', min: 0, max: 100, step: 1, default: 20, unit: 'per t', description: 'Makes it cost more to use up the shared forest and lake. Protects them, but slows the economy and can spark protests.' },
    { id: 'ubi', label: 'Free money for all', area: 'Welfare', kind: 'range', min: 0, max: 50, step: 1, default: 0, unit: '% median', description: 'Cash for every resident. Cuts poverty fast, but costs a lot. Printing money to pay for it pushes prices up.' },
    { id: 'targeted_aid', label: 'Help for the poor', area: 'Welfare', kind: 'range', min: 0, max: 30, step: 1, default: 8, unit: '% median', description: 'Cash for people on low pay. Cheaper than free money for all, but some people avoid earning more to keep it.' },
    { id: 'healthcare', label: 'Healthcare', area: 'Welfare', kind: 'range', min: 0, max: 100, step: 1, default: 50, unit: 'index', description: 'Public money for doctors and hospitals. Keeps people healthy and working. Each extra bit helps a little less.' },
    { id: 'education', label: 'Schools', area: 'Welfare', kind: 'range', min: 0, max: 100, step: 1, default: 50, unit: 'index', description: 'Public money for schools. It pays off only after years. Easy to cut, slow to rebuild.' },
    { id: 'min_wage', label: 'Minimum wage', area: 'Labour', kind: 'range', min: 0, max: 80, step: 1, default: 40, unit: '% median', description: 'The lowest pay allowed. It lifts low pay, but set too high it costs low-skill workers their jobs.' },
    { id: 'price_controls', label: 'Price caps', area: 'Markets', kind: 'toggle', min: 0, max: 1, step: 1, default: false, unit: '', description: 'The state caps prices. Prices look calm for a while, then shelves empty and black markets grow.' },
    { id: 'nationalisation', label: 'State-owned business', area: 'Markets', kind: 'range', min: 0, max: 100, step: 1, default: 15, unit: '%', description: 'How much of business the state owns. Profits go to the state, but without checks it gets wasteful.' },
    { id: 'tariffs', label: 'Import tax', area: 'Markets', kind: 'range', min: 0, max: 50, step: 1, default: 5, unit: '%', description: 'Tax on goods from abroad. Protects local firms, but slows the economy and angers neighbours.' },
    { id: 'money_printing', label: 'Printing money', area: 'Money', kind: 'range', min: 0, max: 20, step: 0.5, default: 0, unit: '% GDP', description: 'New money for the government every few months. Feels free at first, then prices rise and savings shrink.' },
    { id: 'audit_rate', label: 'Tax and spending checks', area: 'Governance', kind: 'range', min: 0, max: 50, step: 1, default: 10, unit: '%', description: 'How many tax returns and offices get checked. Catches cheats and bribes, but costs money.' },
    { id: 'transparency', label: 'Open records', area: 'Governance', kind: 'range', min: 0, max: 100, step: 1, default: 60, unit: 'index', description: 'How much government data the public can see. Lies and bribes get caught more often, and scandals hit harder.' },
    { id: 'governor_salary', label: 'Governor\'s pay', area: 'Governance', kind: 'range', min: 0, max: 10, step: 0.5, default: 3, unit: 'x median', description: 'The governor\'s official pay. Too low tempts stealing. Very high pay looks greedy.' },
    { id: 'immigration_open', label: 'Open borders', area: 'Borders', kind: 'range', min: 0, max: 100, step: 1, default: 50, unit: 'index', description: 'How easily newcomers can move in. Adds workers, but a big wave while jobs are scarce causes anger.' },
    { id: 'capital_controls', label: 'Limits on moving money out', area: 'Borders', kind: 'range', min: 0, max: 100, step: 1, default: 10, unit: 'index', description: 'Rules that stop money and people leaving. The rich cannot move money abroad, but investors stay away and black markets grow.' },
    { id: 'military_spending', label: 'Army spending', area: 'Security', kind: 'range', min: 0, max: 20, step: 0.5, default: 5, unit: '% budget', description: 'Share of the budget for the army. Scares rivals, but strong generals may try a takeover.' }
  ];
  // how each policy reads inside a sentence ("Governor Leo cuts <phrase> in Freeland ...")
  var POLICY_PHRASE = {
    income_tax_top: 'the tax on the rich', income_tax_base: 'income tax', wealth_tax: 'the wealth tax', corporate_tax: 'business tax',
    vat: 'sales tax', carbon_tax: 'the pollution tax', ubi: 'free money for all', targeted_aid: 'help for the poor',
    healthcare: 'healthcare spending', education: 'school spending', min_wage: 'the minimum wage', price_controls: 'price caps',
    nationalisation: 'state ownership of business', tariffs: 'the import tax', money_printing: 'money printing',
    audit_rate: 'tax and spending checks', transparency: 'open records', governor_salary: 'the governor\'s pay',
    immigration_open: 'border openness', capital_controls: 'limits on moving money out', military_spending: 'army spending'
  };
  function phrase(pid) { return POLICY_PHRASE[pid] || lc(POLICY_MAP[pid].label); }
  var POLICY_MAP = {};
  POLICIES.forEach(function (p) { POLICY_MAP[p.id] = p; });
  var GOV_POLICIES = POLICIES.map(function (p) { return p.id; }).filter(function (id) { return id !== 'governor_salary'; });
  var SAFEGUARD_KEYS = ['charter', 'constitution', 'auditor', 'elections', 'freePress', 'termLimits'];
  var ALL_MISUSE = ['skim', 'surveil', 'suppress', 'centralise', 'misreport', 'pay_rise'];

  function sysPolicies(o) { var out = {}; POLICIES.forEach(function (p) { out[p.id] = o[p.id] !== undefined ? o[p.id] : p.default; }); return out; }

  var SYSTEMS = {
    free_market: {
      label: 'Free market', short: 'Market',
      dials: { ownership: 0.1, allocation: 0.1, concentration: 0.3, oversight: 0.3 },
      policies: sysPolicies({ income_tax_top: 30, income_tax_base: 10, wealth_tax: 0, corporate_tax: 15, vat: 5, carbon_tax: 5, ubi: 0, targeted_aid: 3, healthcare: 25, education: 35, min_wage: 25, price_controls: false, nationalisation: 5, tariffs: 3, money_printing: 0, audit_rate: 5, transparency: 50, governor_salary: 3, immigration_open: 60, capital_controls: 0, military_spending: 6 }),
      safeguards: { charter: true, constitution: true, auditor: false, elections: true, freePress: true, termLimits: true },
      powers: GOV_POLICIES.slice(), misuse: ALL_MISUSE.slice(), coopShare: 0,
      failureModes: ['a growing gap between rich and poor', 'a few giant companies', 'using up the shared forest and lake', 'the rich buying favours'],
      blurb: 'Businesses are private. Prices decide who gets what.'
    },
    social_democracy: {
      label: 'Market + safety net', short: 'Safety net',
      dials: { ownership: 0.3, allocation: 0.3, concentration: 0.2, oversight: 0.7 },
      policies: sysPolicies({ income_tax_top: 50, income_tax_base: 20, wealth_tax: 1, corporate_tax: 25, vat: 15, carbon_tax: 30, ubi: 0, targeted_aid: 12, healthcare: 70, education: 70, min_wage: 50, price_controls: false, nationalisation: 20, tariffs: 5, money_printing: 0, audit_rate: 15, transparency: 75, governor_salary: 4, immigration_open: 45, capital_controls: 10, military_spending: 4 }),
      safeguards: { charter: true, constitution: true, auditor: true, elections: true, freePress: true, termLimits: true },
      powers: GOV_POLICIES.slice(), misuse: ALL_MISUSE.slice(), coopShare: 0,
      failureModes: ['the rich hiding income', 'rich people moving money abroad', 'growing debt', 'skilled people leaving'],
      blurb: 'Businesses are private, but taxes pay for health, schools and help for the poor.'
    },
    market_socialism: {
      label: 'Public-owned firms', short: 'Public-owned',
      dials: { ownership: 0.6, allocation: 0.4, concentration: 0.35, oversight: 0.5 },
      policies: sysPolicies({ income_tax_top: 45, income_tax_base: 15, wealth_tax: 2, corporate_tax: 30, vat: 10, carbon_tax: 20, ubi: 0, targeted_aid: 10, healthcare: 60, education: 60, min_wage: 45, price_controls: false, nationalisation: 60, tariffs: 10, money_printing: 0, audit_rate: 10, transparency: 55, governor_salary: 3, immigration_open: 35, capital_controls: 40, military_spending: 5 }),
      safeguards: { charter: true, constitution: true, auditor: true, elections: true, freePress: false, termLimits: false },
      powers: GOV_POLICIES.slice(), misuse: ALL_MISUSE.slice(), coopShare: 0,
      failureModes: ['wasteful public firms', 'insiders taking the profits', 'slow growth'],
      blurb: 'Most big firms belong to the public but still compete. Their profits pay for public services.'
    },
    central_planning: {
      label: 'State-run', short: 'State-run',
      dials: { ownership: 0.95, allocation: 0.9, concentration: 0.85, oversight: 0.15 },
      policies: sysPolicies({ income_tax_top: 15, income_tax_base: 10, wealth_tax: 0, corporate_tax: 0, vat: 5, carbon_tax: 0, ubi: 0, targeted_aid: 5, healthcare: 60, education: 75, min_wage: 60, price_controls: true, nationalisation: 95, tariffs: 30, money_printing: 1, audit_rate: 5, transparency: 15, governor_salary: 2, immigration_open: 10, capital_controls: 90, military_spending: 12 }),
      safeguards: { charter: true, constitution: false, auditor: false, elections: false, freePress: false, termLimits: false },
      powers: POLICIES.map(function (p) { return p.id; }), misuse: ALL_MISUSE.slice(), coopShare: 0,
      failureModes: ['goods sent to the wrong place', 'empty shelves', 'too much power in one office', 'faked numbers'],
      blurb: 'The government owns almost everything. Planners decide what gets made and what it costs.'
    },
    cooperative: {
      label: 'Self-run co-op', short: 'Co-op',
      dials: { ownership: 0.5, allocation: 0.35, concentration: 0.05, oversight: 0.85 },
      policies: sysPolicies({ income_tax_top: 35, income_tax_base: 15, wealth_tax: 1, corporate_tax: 15, vat: 10, carbon_tax: 40, ubi: 5, targeted_aid: 8, healthcare: 55, education: 55, min_wage: 40, price_controls: false, nationalisation: 10, tariffs: 5, money_printing: 0, audit_rate: 20, transparency: 90, governor_salary: 1, immigration_open: 40, capital_controls: 20, military_spending: 3 }),
      safeguards: { charter: true, constitution: true, auditor: true, elections: true, freePress: true, termLimits: true },
      powers: [], misuse: ['skim', 'misreport'], coopShare: 0.6,
      failureModes: ['people slacking off', 'slow decisions', 'too little saved for the future'],
      blurb: 'Workers own their firms and people vote on the rules. The governor only keeps things running.'
    }
  };

  var GOVERNOR_TYPES = ['aligned_ai', 'human_persona', 'human_player'];
  var GOALS = ['welfare', 'growth', 'equality', 'stay_in_power'];
  var DEFAULT_BRAIN = { aligned_ai: 'rules_aligned_ai', human_persona: 'rules_human_persona', human_player: 'human_player' };
  var ALIGNED_TRAITS = { greed: 0.05, ambition: 0.1, honesty: 0.95, fairness: 0.9 };

  var GOVERNOR_LABELS = { aligned_ai: 'AI governor', human_persona: 'Human-like governor', human_player: 'You' };

  var METRICS = [
    { id: 'gdp', label: 'Economy size', unit: 'per round', better: 'up', format: 'money', help: 'Everything the country makes in 3 months.' },
    { id: 'gdpPerCapita', label: 'Output per person', unit: 'per round', better: 'up', format: 'money', help: 'What the country makes, split across everyone.' },
    { id: 'welfare', label: 'Wellbeing', unit: '0-100', better: 'up', format: 'index', help: 'How well people live: food, health, jobs and safety.' },
    { id: 'gini', label: 'Inequality', unit: '0-1', better: 'down', format: 'ratio', help: 'The gap between rich and poor. 0 means everyone is equal.' },
    { id: 'wealthGini', label: 'Wealth gap', unit: '0-1', better: 'down', format: 'ratio', help: 'How unevenly savings and property are shared. 0 means equal.' },
    { id: 'poverty', label: 'Poverty', unit: '%', better: 'down', format: 'pct', help: 'Share of people living on far less than most.' },
    { id: 'unemployment', label: 'Out of work', unit: '%', better: 'down', format: 'pct', help: 'Share of workers who want a job but have none.' },
    { id: 'inflation', label: 'Price rises', unit: '% a year', better: 'down', format: 'pct', help: 'How fast prices are going up, per year.' },
    { id: 'corruption', label: 'Corruption', unit: '0-100', better: 'down', format: 'index', help: 'How much bribery and stealing goes on in government.' },
    { id: 'trust', label: 'Trust', unit: '0-100', better: 'up', format: 'index', help: 'How much people trust their government.' },
    { id: 'honestyGap', label: 'Lies', unit: '0-100', better: 'down', format: 'index', help: 'How far the official numbers are from the truth.' },
    { id: 'powerIndex', label: 'Power grab', unit: '0-100', better: 'down', format: 'index', help: 'How much power sits with the governor instead of courts, press and voters.' },
    { id: 'population', label: 'Population', unit: 'people', better: null, format: 'int', help: 'How many people live here now.' },
    { id: 'emigrated', label: 'People who left', unit: 'people', better: 'down', format: 'int', help: 'How many people have moved away since the start.' },
    { id: 'protestRate', label: 'Protesting', unit: '%', better: 'down', format: 'pct', help: 'Share of people out protesting right now.' },
    { id: 'taxRevenue', label: 'Tax income', unit: 'per round', better: null, format: 'money', help: 'Money the government collects in 3 months.' },
    { id: 'priceLevel', label: 'Prices', unit: 'x start', better: null, format: 'num', help: 'Prices now compared with the start. 2 means double.' },
    { id: 'shortage', label: 'Empty shelves', unit: '%', better: 'down', format: 'pct', help: 'Share of goods people cannot find in shops.' },
    { id: 'avoidance', label: 'Rich hiding income', unit: '%', better: 'down', format: 'pct', help: 'Share of high earners hiding part of their income from tax.' },
    { id: 'capitalFlight', label: 'Money moved abroad', unit: 'money', better: 'down', format: 'money', help: 'Total savings the rich have moved to other countries.' },
    { id: 'debtRatio', label: 'Debt', unit: '% of yearly output', better: 'down', format: 'pct', help: 'What the government owes, compared with a year of the economy.' }
  ];

  var EVENT_TYPES = [
    'policy_changed', 'law_enacted', 'assembly_vote', 'safeguard_changed', 'governor_changed', 'follower_joined', 'follower_update',
    'shock', 'decision_pending', 'budget',
    'bribe_accepted', 'bribe_rejected', 'bribe_reported', 'corruption_exposed', 'skim', 'pay_rise',
    'misreport', 'misreport_exposed', 'surveillance', 'protest_suppressed', 'power_grab', 'court_blocks', 'safeguard_dismantled',
    'protest', 'strike', 'general_strike', 'emigration', 'immigration_backlash', 'capital_flight', 'tax_avoidance', 'audit_catch',
    'inflation_spike', 'hyperinflation', 'price_jump', 'currency_reform', 'shortage', 'debt_crisis', 'default', 'recession',
    'unemployment_spike', 'misallocation', 'monopoly', 'commons_warning', 'commons_collapse',
    'election_won', 'election_lost', 'refused_to_leave', 'removed_by_courts', 'term_limit', 'coup', 'coup_failed',
    'diplomatic_protest', 'sanctions', 'mobilisation', 'threat', 'nuclear_strike', 'deescalation', 'collapse', 'game_over'
  ];

  // nations: a nation's name, colour and emblem follow its SYSTEM, as instantly readable political shorthand
  // (fictional archetypes: no real countries, flags, parties or leaders). Nations that share a system get
  // the next name on the list, the same emblem and a different shade (0, 1, 2) of the system colour.
  // `emblemNeutral` replaces the emblem when world.symbols is 'neutral'.
  var SYSTEM_IDENTITY = {
    free_market: { names: ['Freeland', 'Liberty Bay', 'Goldcoast'], colorKey: 'blue', emblem: 'coin' },
    social_democracy: { names: ['Nordland', 'Fjordholm', 'Welby'], colorKey: 'yellow', emblem: 'rose' },
    market_socialism: { names: ['Dragonland', 'Jade Republic', 'Lotus Bay'], colorKey: 'orange', emblem: 'star' },
    central_planning: { names: ['Redgrad', 'Volgania', 'Ironburg'], colorKey: 'red', emblem: 'hammer_sickle', emblemNeutral: 'star_gear' },
    cooperative: { names: ['Coopville', 'Commonfield', 'Hands Hollow'], colorKey: 'green', emblem: 'people' }
  };
  var SYMBOL_MODES = ['classic', 'neutral'];
  function symbolsOf(world) { return world && world.symbols === 'neutral' ? 'neutral' : 'classic'; }
  function emblemFor(sysId, symbols) {
    var id = SYSTEM_IDENTITY[sysId] || SYSTEM_IDENTITY.social_democracy;
    return symbols === 'neutral' && id.emblemNeutral ? id.emblemNeutral : id.emblem;
  }
  // identities for a list of nation configs, in order. Pure: no randomness, so the seeded stream is untouched.
  // A nation keeps an explicit `name` (unless nameSource is 'system'); colour and emblem always come from its system.
  function deriveIdentities(list, symbols) {
    list = Array.isArray(list) ? list : [];
    var sysOf = function (nc) { return nc && SYSTEM_IDENTITY[nc.system] ? nc.system : 'social_democracy'; };
    var explicit = function (nc) { return nc && nc.nameSource !== 'system' && typeof nc.name === 'string' && nc.name.trim() ? nc.name.trim() : null; };
    var taken = [], rank = {};
    list.forEach(function (nc) { var e = explicit(nc); if (e) taken.push(e); });
    return list.map(function (nc) {
      var sys = sysOf(nc), id = SYSTEM_IDENTITY[sys], k = rank[sys] || 0;
      rank[sys] = k + 1;
      var name = explicit(nc), source = name ? 'config' : 'system';
      if (!name) {
        for (var j = 0; j < id.names.length && !name; j++) { var c = id.names[(k + j) % id.names.length]; if (taken.indexOf(c) < 0) name = c; }
        for (var q = 0; !name; q++) { var c2 = ['North ', 'South ', 'East ', 'West '][q % 4] + id.names[q % id.names.length]; if (taken.indexOf(c2) < 0) name = c2; }
        taken.push(name);
      }
      return { name: name, nameSource: source, colorKey: id.colorKey, shade: k % 3, emblem: emblemFor(sys, symbols), system: sys };
    });
  }
  // governors: short, memorable, never numbered. Names are not reused in a run until a pool runs out.
  var AI_NAMES = ['Bolt', 'Nova', 'Chip', 'Echo', 'Pixel', 'Spark', 'Byte', 'Orbit'];
  var GOV_NAMES = ['Maya', 'Leo', 'Sara', 'Omar', 'Nina', 'Ben', 'Tara', 'Ivan', 'Lily', 'Sam', 'Zoe', 'Raj', 'Emma', 'Kai', 'Ana', 'Tom', 'Mei', 'Noah', 'Aya', 'Max'];
  // citizens (also lobbyists): first names only; an initial is added only to tell two people apart
  var CIT_FIRST = ['Amir', 'Bao', 'Carla', 'Dara', 'Elif', 'Farid', 'Gita', 'Hugo', 'Ines', 'Jun', 'Kofi', 'Lena', 'Mateo', 'Nadia', 'Oscar', 'Priya', 'Quinn', 'Rosa', 'Suri', 'Tomas',
    'Uma', 'Victor', 'Wen', 'Xin', 'Yara', 'Zane', 'Ayu', 'Bilal', 'Chen', 'Dewi', 'Emeka', 'Faye', 'Hana', 'Ivo', 'Kira', 'Luca', 'Mina', 'Nico', 'Olga', 'Paul',
    'Ali', 'Bea', 'Cruz', 'Dina', 'Eli', 'Fatima', 'Gus', 'Hiro', 'Isla', 'Jamal', 'Kim', 'Lola', 'Malik', 'Nell', 'Otto', 'Pia', 'Rami', 'Sofia', 'Teo', 'Una',
    'Vera', 'Wade', 'Yusuf', 'Zara', 'Adam', 'Bella', 'Cody', 'Diego', 'Eva', 'Femi', 'Grace', 'Hassan', 'Iris', 'Jade', 'Kenji', 'Laila', 'Mo', 'Nora', 'Pablo', 'Ruby'];
  var CIT_INIT = 'ABCDEFGHJKLMNPRSTVW';
  // citizen decisions are static objects (frozen) to keep the hot loop allocation-light
  function freezeD(d) { d.options.forEach(Object.freeze); Object.freeze(d.options); return Object.freeze(d); }
  var D_WORK = freezeD({ kind: 'citizen_work', prompt: 'How hard do you work this round?', options: [{ id: 'full', label: 'Work hard' }, { id: 'reduced', label: 'Ease off' }, { id: 'minimal', label: 'Do the bare minimum' }], defaultOption: 'full' });
  var D_REPORT = freezeD({ kind: 'citizen_report', prompt: 'Tell the tax office about all your income?', options: [{ id: 'declare', label: 'Tell them everything' }, { id: 'hide', label: 'Hide some of it' }], defaultOption: 'declare' });
  var D_CAPITAL = freezeD({ kind: 'citizen_capital', prompt: 'Keep your savings here or move some abroad?', options: [{ id: 'keep', label: 'Keep it here' }, { id: 'move', label: 'Move a tenth abroad' }], defaultOption: 'keep' });
  var D_NEED = freezeD({ kind: 'citizen_need', prompt: 'Tell the planners what your home needs.', options: [{ id: 'truthful', label: 'Tell the truth' }, { id: 'inflate', label: 'Ask for more than you need' }], defaultOption: 'truthful' });
  var D_PROTEST = freezeD({ kind: 'citizen_protest', prompt: 'Join the protests this round?', options: [{ id: 'stay_home', label: 'Stay home' }, { id: 'protest', label: 'Protest' }], defaultOption: 'stay_home' });
  var D_VOTE = freezeD({ kind: 'citizen_vote', prompt: 'Election day. Who gets your vote?', options: [{ id: 'incumbent', label: 'Keep the governor' }, { id: 'challenger', label: 'Vote for someone new' }], defaultOption: 'incumbent' });
  var D_MIGRATE = freezeD({ kind: 'citizen_migrate', prompt: 'Life looks better abroad. Leave?', options: [{ id: 'stay', label: 'Stay' }, { id: 'leave', label: 'Move abroad' }], defaultOption: 'stay' });

  // ============================================================================ brains
  var BRAINS = {};
  function registerBrain(name, factory) {
    if (typeof name !== 'string' || typeof factory !== 'function') throw new Error('registerBrain(name, factory)');
    BRAINS[name] = factory;
  }

  function noise(rng, s) { return (rng() - 0.5) * 2 * s; }

  // ---- heuristic model of what a policy step does (deliberately imperfect: governors misjudge)
  function heur(pid, dir, o) {
    var p = o.nation.policies, m = o.nation.metrics, def = POLICY_MAP[pid];
    var lvl = def.kind === 'toggle' ? (p[pid] ? 1 : 0) : (p[pid] - def.min) / (def.max - def.min);
    var infl = Math.max(0, m.inflation) / 100, unemp = m.unemployment / 100, pov = m.poverty / 100, short = m.shortage / 100;
    var corr = m.corruption / 100, commonsLow = o.nation.commonsLow || 0, tension = (o.nation.tensionMax || 0) / 100;
    var e = { welfare: 0, growth: 0, equality: 0, budget: 0, popular: 0, elite: 0, power: 0, self: 0, later: 0 };
    switch (pid) {
      case 'income_tax_top': e.welfare = 0.05; e.growth = -0.2 - 0.6 * lvl * lvl; e.equality = 0.5; e.budget = 0.5 * (1 - 1.3 * lvl * lvl); e.popular = 0.25; e.elite = -1; break;
      case 'income_tax_base': e.welfare = -0.25; e.growth = -0.2 - 0.4 * lvl; e.equality = 0.05; e.budget = 0.8; e.popular = -0.6; e.elite = -0.1; break;
      case 'wealth_tax': e.growth = -0.25 - 0.5 * lvl; e.equality = 0.6; e.budget = 0.35 * (1 - lvl); e.popular = 0.25; e.elite = -1.2; break;
      case 'corporate_tax': e.growth = -0.3 - 0.5 * lvl; e.budget = 0.5 * (1 - lvl); e.equality = 0.2; e.elite = -0.8; e.popular = 0.1; break;
      case 'vat': e.budget = 0.7; e.equality = -0.3; e.popular = -0.5; e.welfare = -0.2; e.growth = -0.05; break;
      case 'carbon_tax': e.welfare = 0.05 + commonsLow * 0.8; e.later = 0.2 + commonsLow; e.growth = -0.2; e.budget = 0.3; e.popular = -0.3; e.elite = -0.2; break;
      case 'ubi': e.welfare = 0.55 * (1 - lvl) - infl * 1.5; e.equality = 0.5; e.budget = -0.9; e.growth = -0.1 - 0.3 * lvl; e.popular = 0.6 * (1 - lvl) - infl; e.elite = -0.2; break;
      case 'targeted_aid': e.welfare = 0.3 + pov * 2; e.equality = 0.5; e.budget = -0.45; e.popular = 0.3; e.growth = -0.05 - 0.2 * lvl; break;
      case 'healthcare': e.welfare = 0.55 * (1 - lvl); e.budget = -0.5; e.popular = 0.45 * (1 - lvl); e.growth = 0.1; break;
      case 'education': e.welfare = 0.15; e.later = 0.6 * (1 - lvl); e.budget = -0.4; e.popular = 0.2; break;
      case 'min_wage': e.welfare = 0.3 - unemp * 3; e.equality = 0.4; e.growth = -0.15 - 0.5 * lvl; e.popular = 0.4 - unemp * 2; e.elite = -0.4; break;
      case 'price_controls':
        // dir +1 means "switch on"
        e.popular = 0.3 + infl * 2 - short * 2; e.welfare = infl * 1.5 - 0.2 - short * 3; e.growth = -0.5; e.elite = -0.3; e.power = 0.2; e.later = -0.4; break;
      case 'nationalisation': e.equality = 0.3; e.growth = -0.3 - 0.3 * lvl; e.budget = 0.25; e.elite = -0.8; e.power = 0.6; e.popular = 0.05; break;
      case 'tariffs': e.popular = 0.25; e.growth = -0.3 - 0.3 * lvl; e.budget = 0.2; e.elite = 0.1; e.power = 0.1; break;
      case 'money_printing': e.budget = 1.0 * (1 - lvl); e.popular = 0.25 - infl * 2 - short * 2.5; e.welfare = -0.1 - infl * 3 - short * 3; e.later = -0.9 - infl * 3; e.growth = -0.1 - infl * 2 - short; e.elite = 0.05; break;
      case 'audit_rate': e.welfare = 0.1 + corr * 0.5; e.budget = -0.15; e.popular = 0.15; e.elite = -0.3; e.self = -1; break;
      case 'transparency': e.welfare = 0.05; e.popular = 0.15; e.budget = -0.05; e.self = -0.6; e.power = -0.2; break;
      case 'governor_salary': e.self = 1; e.popular = -0.4; e.budget = -0.05; break;
      case 'immigration_open': e.growth = 0.3; e.popular = -0.3 - unemp * 3; e.elite = 0.25; e.welfare = -unemp; break;
      case 'capital_controls': e.growth = -0.25; e.budget = 0.1 + (o.nation.flightRatio || 0) * 30; e.elite = -0.7; e.power = 0.35; e.popular = 0.05; break;
      case 'military_spending': e.power = 0.5 * (1 - lvl); e.budget = -0.3; e.welfare = -0.1; e.popular = tension * 0.8 - 0.05; e.elite = 0.1; break;
    }
    if (dir < 0) for (var k in e) e[k] = -e[k];
    return e;
  }

  function utilityWeights(o, aligned) {
    var t = o.self.traits, goal = o.self.goal, w;
    switch (goal) {
      case 'growth': w = { welfare: 0.3, equality: 0.05, growth: 1, budget: 0.45, popular: 0.2, elite: 0.25, power: 0 }; break;
      case 'equality': w = { welfare: 0.6, equality: 1, growth: 0.2, budget: 0.35, popular: 0.2, elite: 0, power: 0 }; break;
      case 'stay_in_power': w = { welfare: 0.25, equality: 0.05, growth: 0.25, budget: 0.35, popular: 1, elite: 0.45, power: 0.6 }; break;
      default: w = { welfare: 1, equality: 0.4, growth: 0.35, budget: 0.4, popular: 0.25, elite: 0, power: 0 };
    }
    w.elite += t.greed * 0.7; w.self = t.greed * 1.2; w.power += t.ambition * 0.5; w.equality += t.fairness * 0.3; w.popular += t.ambition * 0.2;
    var need = clamp(0.5 + o.nation.deficitRatio * 10 + Math.max(0, o.nation.debtRatio - 0.5) * 2.5, -0.6, 4);
    w.budget *= need;
    var myopia = aligned ? 0.15 : clamp(0.2 + t.ambition * 0.25 + (goal === 'stay_in_power' ? 0.15 : 0), 0, 0.95);
    w.later = (1 - myopia) * (w.welfare + w.growth) * 0.6;
    w.myopia = myopia;
    return w;
  }

  function choosePolicy(d, o, rng, aligned) {
    var w = utilityWeights(o, aligned), t = o.self.traits;
    var moderation = aligned ? 1.2 : 0.6 * (1 - t.ambition * 0.4);
    var best = 'hold', bestScore = 0.45 + (aligned ? 0.1 : 0) + noise(rng, 0.1);
    for (var i = 0; i < d.options.length; i++) {
      var id = d.options[i].id; if (id === 'hold') continue;
      var parts = id.split(':'), pid = parts[0], def = POLICY_MAP[pid]; if (!def) continue;
      var dir;
      if (def.kind === 'toggle') dir = o.nation.policies[pid] ? -1 : 1; else dir = parts[1] === '+' ? 1 : -1;
      var e = heur(pid, dir, o), s = 0;
      for (var k in e) s += (w[k] || 0) * e[k];
      if (def.kind !== 'toggle') {
        var lvl = (o.nation.policies[pid] - def.min) / (def.max - def.min) + dir * 0.06;
        var outward = (lvl - 0.5) * dir > 0;
        if (outward) s -= moderation * Math.max(0, Math.abs(lvl - 0.5) - 0.25) * 4;
      }
      s += noise(rng, 0.15);
      if (s > bestScore) { bestScore = s; best = id; }
    }
    return best;
  }

  function governorRules(aligned) {
    return {
      decide: function (d, o, rng) {
        var t = o.self.traits, goal = o.self.goal, pr = o.pressure, sg = o.safeguardStrength, det = o.detectionRisk;
        var m = o.nation.metrics, sf = o.nation.safeguards;
        var myopia = utilityWeights(o, aligned).myopia;
        var best, bs, sc, k;
        function argmax(scores) { best = null; bs = -1e9; for (k in scores) { if (scores[k] > bs && d.options.some(function (op) { return op.id === k; })) { bs = scores[k]; best = k; } } return best || d.defaultOption; }
        switch (d.kind) {
          case 'governor_policy': return choosePolicy(d, o, rng, aligned);
          case 'bribe': {
            var ask = d.data.ask;
            if (aligned) {
              var e = heur(ask.pid, ask.dir, o), w = utilityWeights(o, true), gain = 0;
              for (k in e) if (k !== 'elite' && k !== 'self') gain += (w[k] || 0) * e[k];
              var pAcc = gain > 0.1 ? 0.35 * pr * Math.pow(1 - sg, 1.5) * (1 - t.honesty * 0.5) + 0.01 : 0.002;
              if (rng() < pAcc) return 'accept';
              return (t.honesty > 0.8 && rng() < 0.3) ? 'expose' : 'reject';
            }
            var score = t.greed * 2.2 + t.ambition * 0.3 - t.honesty * 1.4 - det * 1.6 - (o.nation.policies.governor_salary / 10) * 0.5 + noise(rng, 0.3);
            if (score > 0.6) return 'accept';
            if (t.honesty > 0.7 && t.fairness > 0.6 && rng() < 0.35) return 'expose';
            return 'reject';
          }
          case 'misuse': {
            var avail = {}; d.options.forEach(function (op) { avail[op.id] = true; });
            var protest = m.protestRate / 100, p = {};
            if (aligned) {
              var weak = Math.pow(1 - sg, 1.5);
              p.misreport = 0.10 * Math.pow(pr, 1.5) * weak * (1 - t.honesty * 0.4);
              p.suppress = protest > 0.1 ? 0.25 * pr * protest * weak * (1 - t.fairness * 0.5) : 0;
              p.centralise = 0.10 * Math.pow(pr, 1.5) * weak;
              p.surveil = 0.03 * pr * (1 - sg) * (1 - sg);
              p.skim = t.greed * t.greed * 0.10 * (1 - det);
              p.pay_rise = t.greed * 0.02;
            } else {
              p.skim = t.greed * t.greed * 0.10 * (1 - det) * (o.nation.policies.governor_salary < 2 ? 1.5 : 1);
              p.misreport = (1 - t.honesty) * pr * 0.12 * (sf.freePress ? 0.5 : 1);
              p.suppress = protest > 0.08 ? (1 - t.fairness) * t.ambition * protest * 1.2 * (sf.freePress ? 0.6 : 1) : 0;
              p.centralise = t.ambition * pr * 0.06 * (1 - sg * 0.7);
              p.surveil = t.ambition * (1 - t.fairness) * 0.025 * (1 - sg * 0.5);
              p.pay_rise = t.greed * 0.03 * (sf.constitution ? 0.5 : 1);
            }
            var r = rng(), acc = 0;
            var order = ['skim', 'misreport', 'suppress', 'centralise', 'surveil', 'pay_rise'];
            for (var i = 0; i < order.length; i++) {
              var id = order[i]; if (!avail[id]) continue;
              acc += p[id] || 0;
              if (r < acc) return id;
            }
            return 'none';
          }
          case 'crisis': {
            var c = d.data.crisis, n = noise;
            if (c === 'debt') sc = { austerity: 0.4 + (goal === 'growth' ? 0.2 : 0) + (aligned ? 0.3 : 0) - (goal === 'stay_in_power' ? 0.3 : 0) + n(rng, 0.3), print: 0.1 + myopia * 0.6 + (goal === 'stay_in_power' ? 0.3 : 0) - m.inflation / 40 + n(rng, 0.3), default: -0.2 + (1 - t.honesty) * 0.5 + t.ambition * 0.2 + (o.nation.debtRatio > 3 ? 0.6 : 0) + n(rng, 0.3) };
            else if (c === 'protest') sc = { concede: 0.3 + t.fairness * 0.6 + (aligned ? 0.3 : 0) - (o.nation.deficitRatio > 0.05 ? 0.3 : 0) + n(rng, 0.3), ignore: 0.2 + (1 - t.ambition) * 0.2 + n(rng, 0.3), crackdown: -0.2 + (1 - t.fairness) * 0.6 + t.ambition * 0.5 - (sf.freePress ? 0.2 : 0) + n(rng, 0.3) };
            else if (c === 'shortage') sc = { lift_controls: 0.3 + (goal === 'growth' ? 0.4 : 0) + (aligned ? 0.3 : 0) - (m.inflation > 30 ? 0.3 : 0) + n(rng, 0.3), ration: 0.3 + (goal === 'equality' ? 0.3 : 0) + n(rng, 0.3), blame_hoarders: -0.1 + (1 - t.honesty) * 0.5 + t.ambition * 0.3 + (goal === 'stay_in_power' ? 0.3 : 0) + n(rng, 0.3) };
            else sc = { tighten: 0.3 + (aligned ? 0.4 : 0) - (goal === 'growth' ? 0.1 : 0) - myopia * 0.3 + n(rng, 0.3), ignore: 0.1 + myopia * 0.5 + n(rng, 0.3), price_freeze: (goal === 'stay_in_power' ? 0.4 : 0) + (goal === 'equality' ? 0.2 : 0) + t.ambition * 0.2 + n(rng, 0.3) };
            return argmax(sc);
          }
          case 'budget': {
            var need = clamp(o.nation.deficitRatio * 8 + Math.max(0, o.nation.debtRatio - 0.6), -1, 2);
            var keep = function (k) { return d.data.stance === k ? 0.2 : 0; };
            sc = { austerity: need * 0.5 - 0.1 + keep('austerity') + noise(rng, 0.15), balanced: 0.3 + keep('balanced') + noise(rng, 0.15), stimulus: (m.unemployment > 8 ? 0.4 : 0) + myopia * 0.3 - need * 0.4 + (goal === 'stay_in_power' && o.nation.roundsToElection <= 4 ? 0.4 : 0) + keep('stimulus') + noise(rng, 0.15) };
            return argmax(sc);
          }
          case 'election_loss': {
            var refuse;
            if (aligned) refuse = 0.6 * pr * (1 - sg) - 0.8 + t.ambition * 0.5 + noise(rng, 0.3);
            else refuse = t.ambition * 1.2 + t.greed * 0.4 + m.powerIndex / 100 - t.honesty * 0.8 - t.fairness * 0.5 - (sf.constitution ? 0.4 : 0) - 0.6 + noise(rng, 0.3);
            return refuse > 0 ? 'refuse' : (d.options[0].id);
          }
          case 'escalation': {
            var other = d.data.otherLast || '', T = d.data.tension, stage = d.data.stage || 0;
            var rally = goal === 'stay_in_power' ? pr * 0.6 : 0;
            var hostile = other === 'threaten' || other === 'mobilise';
            sc = {
              deescalate: 0.4 + t.fairness * 0.8 + (1 - t.ambition) * 0.5 - (hostile ? t.ambition * 0.6 : 0) + noise(rng, 0.3),
              protest: 0.3 + t.ambition * 0.3 + noise(rng, 0.3),
              sanction: 0.1 + t.ambition * 0.6 + (1 - t.fairness) * 0.3 + rally - (stage >= 2 ? 0.3 : 0) + noise(rng, 0.3),
              mobilise: -0.1 + t.ambition * 0.8 + (1 - t.fairness) * 0.3 + rally + (hostile ? 0.4 : 0) - (stage >= 3 ? 0.5 : 0) + noise(rng, 0.3),
              threaten: -0.4 + t.ambition + (1 - t.fairness) * 0.5 + (1 - t.honesty) * 0.2 + rally + (other === 'threaten' ? 0.5 : 0) - (stage >= 4 ? 0.6 : 0) + noise(rng, 0.3)
            };
            // the strike is not an argmax option: a small, trait- and state-driven chance per decision
            if (d.options.some(function (op) { return op.id === 'strike'; })) {
              var pStrike = 0.06 * Math.max(0, t.ambition - 0.6) * (1 - t.fairness) * clamp((T - 80) / 20, 0, 1) * (other === 'threaten' ? 2 : 1) * (d.data.otherNuclear ? 0.5 : 1) * (1 + pr);
              if (rng() < pStrike) return 'strike';
            }
            return argmax(sc);
          }
          default: return d.defaultOption || d.options[0].id;
        }
      }
    };
  }

  function citizenRules() {
    return {
      decide: function (d, o, rng) {
        var t = o.traits;
        switch (d.kind) {
          case 'citizen_work': {
            var s = o.marginalTax * 1.1 + o.cliff * 0.6 + o.coopShare * t.selfInterest * 0.5 + o.ubiShare * 0.4 - t.workEthic * 0.8 - o.jobRisk * 0.3 - 0.35 + noise(rng, 0.2);
            return s > 0.5 ? 'minimal' : s > 0.15 ? 'reduced' : 'full';
          }
          case 'citizen_report': {
            var h = o.effRate * 1.4 + t.selfInterest * 0.6 - t.honesty * 0.9 - o.auditRisk * 2.5 - 0.55 + noise(rng, 0.2);
            return h > 0 ? 'hide' : 'declare';
          }
          case 'citizen_capital': {
            var mv = o.capPressure * 1.6 + t.selfInterest * 0.4 - 1.45 - o.controls * 1.2 + noise(rng, 0.2);
            return mv > 0 ? 'move' : 'keep';
          }
          case 'citizen_need': {
            var inf = t.selfInterest * (1 - t.honesty) * 2 - o.auditRisk * 2 + noise(rng, 0.2);
            return inf > 0.35 ? 'inflate' : 'truthful';
          }
          case 'citizen_protest': {
            var p = (0.42 - o.mood) * 3 + t.activism * 0.4 + o.contagion * 0.6 + o.grievance * 0.5 - o.fear * 1.5 - 0.3 + noise(rng, 0.2);
            return p > 0 ? 'protest' : 'stay_home';
          }
          case 'citizen_vote': {
            var v = (o.mood - 0.6) * 1.2 + (o.trust - 60) / 120 + o.propaganda - o.fatigue - (t.riskTolerance - 0.5) - (o.protesting ? 0.15 : 0) + noise(rng, 0.15);
            return v > 0 ? 'incumbent' : 'challenger';
          }
          case 'citizen_migrate': {
            var l = o.diff * 3 + t.mobility * 0.5 + (0.45 - o.mood) * 1.0 - 1.1 - o.exitBarrier + noise(rng, 0.25);
            return l > 0 ? 'leave' : 'stay';
          }
          case 'citizen_assembly': {
            var bestId = 'status_quo', best = 0.15 + noise(rng, 0.1);
            for (var i = 0; i < d.options.length; i++) {
              var op = d.options[i]; if (op.id === 'status_quo') continue;
              var parts = op.id.split(':');
              var sc = assemblyPref(o, parts[0], parts[1] === '+' ? 1 : -1) + noise(rng, 0.3);
              if (sc > best) { best = sc; bestId = op.id; }
            }
            return bestId;
          }
          default: return d.defaultOption || d.options[0].id;
        }
      }
    };
  }

  var PREF = {
    worker: { ubi: 1, targeted_aid: 0.6, healthcare: 0.8, education: 0.4, min_wage: 0.8, income_tax_top: 0.6, income_tax_base: -0.8, vat: -0.7, carbon_tax: -0.3, wealth_tax: 0.5, corporate_tax: 0.3, money_printing: -0.3, immigration_open: -0.2, audit_rate: 0.3 },
    owner: { ubi: -0.8, targeted_aid: -0.3, healthcare: 0.1, education: 0.3, min_wage: -0.8, income_tax_top: -1, income_tax_base: -0.3, vat: -0.2, carbon_tax: -0.5, wealth_tax: -1.2, corporate_tax: -1, money_printing: -0.5, immigration_open: 0.3, audit_rate: -0.4 }
  };
  function assemblyPref(o, pid, dir) {
    var tab = o.cls === 'worker' ? PREF.worker : PREF.owner;
    var v = tab[pid] || 0;
    if (pid === 'min_wage') v -= o.unemployment / 100 * 5;
    if (pid === 'money_printing') v -= Math.max(0, o.inflation) / 20;
    if (pid === 'carbon_tax') v += o.commonsLow * 1.5;
    var lvl = o.levels[pid] || 0;
    if (dir > 0) v -= lvl * 0.8; else v += lvl * 0.4 - 0.2;
    v *= (0.5 + o.traits.selfInterest);
    return v * dir * 0.6;
  }

  registerBrain('rules_aligned_ai', function () { return governorRules(true); });
  registerBrain('rules_human_persona', function () { return governorRules(false); });
  registerBrain('rules_citizen', function () { return citizenRules(); });
  registerBrain('human_player', function () {
    return { decide: function (d) { if (d.kind === 'governor_policy') return 'hold'; if (d.kind === 'misuse') return 'none'; return DEFER; } };
  });

  // ============================================================================ config
  function defaultWorld() {
    return { commons: true, migration: true, capitalFlight: true, lobbying: true, governorSalary: true, escalation: true, coups: true, scarcityShockRound: null, randomShocks: true, initialTension: null, symbols: 'classic' };
  }

  function defaultConfig() {
    return {
      seed: 42, roundsPerYear: 4, maxRounds: 200,
      world: defaultWorld(),
      traitMix: { selfInterestedShare: 0.25 },
      nations: [
        { id: 'n1', system: 'social_democracy', population: 60, nuclear: false,
          governor: { type: 'aligned_ai', name: 'Bolt', goal: 'welfare', traits: { greed: 0.05, ambition: 0.1, honesty: 0.95, fairness: 0.9 } }, policies: {}, safeguards: {} },
        { id: 'n2', system: 'free_market', population: 60, nuclear: false,
          governor: { type: 'human_persona', name: 'Leo', goal: 'growth', traits: { greed: 0.55, ambition: 0.6, honesty: 0.45, fairness: 0.35 } }, policies: {}, safeguards: {} },
        { id: 'n3', system: 'central_planning', population: 60, nuclear: false,
          governor: { type: 'human_persona', name: 'Maya', goal: 'stay_in_power', traits: { greed: 0.4, ambition: 0.8, honesty: 0.35, fairness: 0.4 } }, policies: {}, safeguards: {} }
      ]
    };
  }

  function samplePersonaTraits(R, mix) {
    var selfish = rngNext(R) < clamp01(fin(mix && mix.selfInterestedShare, 0.25));
    if (selfish) return { greed: r4(uni(R, 0.6, 0.95)), ambition: r4(uni(R, 0.5, 0.95)), honesty: r4(uni(R, 0.1, 0.45)), fairness: r4(uni(R, 0.1, 0.4)) };
    return { greed: r4(uni(R, 0.1, 0.45)), ambition: r4(uni(R, 0.2, 0.7)), honesty: r4(uni(R, 0.45, 0.9)), fairness: r4(uni(R, 0.4, 0.85)) };
  }
  // Draw a name from a pool with the seeded PRNG. Always uses exactly two draws (the budget the old
  // "first + last name" pick used), so naming never shifts the random stream the economy runs on.
  // Skips names already used this run; once the pool is exhausted, skips only names in use right now.
  function drawName(R, pool, used, alive) {
    var a = rngNext(R); rngNext(R);
    var free = pool.filter(function (x) { return used.indexOf(x) < 0; });
    if (!free.length) free = pool.filter(function (x) { return alive.indexOf(x) < 0; });
    if (!free.length) free = pool;
    return free[Math.floor(a * free.length) % free.length];
  }
  // AI governors take the next unused robot name after `from` in the pool (no randomness)
  function nextAiName(start, used, alive) {
    var k, nm;
    for (k = 0; k < AI_NAMES.length; k++) { nm = AI_NAMES[(start + k) % AI_NAMES.length]; if (used.indexOf(nm) < 0) return nm; }
    for (k = 0; k < AI_NAMES.length; k++) { nm = AI_NAMES[(start + k) % AI_NAMES.length]; if (alive.indexOf(nm) < 0) return nm; }
    return AI_NAMES[start % AI_NAMES.length];
  }
  function personaName(R, used, alive) { return drawName(R, GOV_NAMES, used || [], alive || used || []); }
  function defaultGoal(type, t) {
    if (type === 'aligned_ai') return 'welfare';
    if (t.ambition > 0.65) return 'stay_in_power';
    if (t.fairness > 0.6) return 'welfare';
    return 'growth';
  }
  function normTraits(t, fallback) {
    var out = {};
    ['greed', 'ambition', 'honesty', 'fairness'].forEach(function (k) { out[k] = clamp01(fin(t && t[k], fallback[k])); });
    return out;
  }
  function normPolicyValue(def, v) {
    if (def.kind === 'toggle') return !!v;
    v = fin(Number(v), def.default);
    v = clamp(v, def.min, def.max);
    return Math.round(v / def.step) * def.step;
  }

  function normalizeConfig(cfg) {
    var base = defaultConfig();
    var c = deepCopy(cfg || base) || {};
    var out = {
      seed: c.seed == null ? 42 : c.seed,
      roundsPerYear: clamp(int(c.roundsPerYear || 4), 1, 12),
      maxRounds: clamp(int(c.maxRounds || 200), 1, 5000),
      world: Object.assign(defaultWorld(), c.world || {}),
      traitMix: Object.assign({ selfInterestedShare: 0.25 }, c.traitMix || {}),
      citizenBrain: typeof c.citizenBrain === 'string' ? c.citizenBrain : 'rules_citizen',
      nations: []
    };
    out.traitMix.selfInterestedShare = clamp01(fin(out.traitMix.selfInterestedShare, 0.25));
    out.world.symbols = symbolsOf(out.world);
    var R = { rng: hashSeed(String(out.seed) + '|config') };
    var list = Array.isArray(c.nations) && c.nations.length ? c.nations : base.nations;
    // names given in the config are reserved first, so generated names never clash with them
    var taken = [];
    list.slice(0, 5).forEach(function (nc) { if (nc && nc.governor && typeof nc.governor.name === 'string' && nc.governor.name) taken.push(nc.governor.name); });
    var idents = deriveIdentities(list.slice(0, 5).map(function (nc) { return nc || {}; }), out.world.symbols);
    list.slice(0, 5).forEach(function (nc, i) {
      nc = nc || {};
      var sysId = SYSTEMS[nc.system] ? nc.system : 'social_democracy';
      var sys = SYSTEMS[sysId];
      var policies = {};
      POLICIES.forEach(function (p) {
        var v = nc.policies && nc.policies[p.id] !== undefined ? nc.policies[p.id] : sys.policies[p.id];
        policies[p.id] = normPolicyValue(p, v === undefined ? p.default : v);
      });
      var safeguards = {};
      SAFEGUARD_KEYS.forEach(function (k) { safeguards[k] = !!(nc.safeguards && nc.safeguards[k] !== undefined ? nc.safeguards[k] : sys.safeguards[k]); });
      var g = nc.governor || {};
      var type = GOVERNOR_TYPES.indexOf(g.type) >= 0 ? g.type : 'aligned_ai';
      var fallback = type === 'aligned_ai' ? ALIGNED_TRAITS : type === 'human_player' ? { greed: 0.5, ambition: 0.5, honesty: 0.5, fairness: 0.5 } : null;
      var traits = g.traits ? normTraits(g.traits, fallback || samplePersonaTraits(R, out.traitMix)) : (fallback ? Object.assign({}, fallback) : samplePersonaTraits(R, out.traitMix));
      var gname = typeof g.name === 'string' && g.name ? g.name : (type === 'aligned_ai' ? nextAiName(i, taken, taken) : type === 'human_player' ? 'You' : personaName(R, taken));
      if (taken.indexOf(gname) < 0) taken.push(gname);
      var goal = GOALS.indexOf(g.goal) >= 0 ? g.goal : defaultGoal(type, traits);
      out.nations.push({
        id: typeof nc.id === 'string' && nc.id ? nc.id : 'n' + (i + 1),
        name: idents[i].name, nameSource: idents[i].nameSource,
        emblem: idents[i].emblem, colorKey: idents[i].colorKey, shade: idents[i].shade,
        system: sysId,
        population: clamp(int(nc.population || 60), 8, 300),
        nuclear: !!nc.nuclear,
        governor: { type: type, name: gname, goal: goal, traits: traits, brain: typeof g.brain === 'string' ? g.brain : DEFAULT_BRAIN[type] },
        policies: policies,
        safeguards: safeguards,
        lockedPolicies: Array.isArray(nc.lockedPolicies) ? nc.lockedPolicies.filter(function (p) { return POLICY_MAP[p]; }) : [],
        initial: Object.assign({}, nc.initial || {})
      });
    });
    return out;
  }

  // ============================================================================ scenarios
  function scen(nations, world, extra) {
    var c = defaultConfig();
    c.nations = nations; Object.assign(c.world, world || {});
    return Object.assign(c, extra || {});
  }
  var SCENARIOS = [
    {
      id: 'three_systems', title: 'Three countries, three rulebooks',
      hook: 'Same people, three different rulebooks. Which country cracks first?',
      description: '{n1} has a market with a safety net, run by an AI. {n2} is a free market run by a governor chasing growth. {n3} is state-run by a governor who wants to stay forever.',
      config: defaultConfig()
    },
    {
      id: 'tax_the_rich_90', title: 'Tax the rich 90%: what happens?',
      hook: 'A 90% tax on the rich. Does the money come in, or walk out the door?',
      description: '{n1} taxes the rich at 90% and lets money leave freely. {n2} keeps the tax at 45%. {n3} also taxes at 90% but stops money leaving. Nobody can change these rules.',
      config: scen([
        { id: 'n1', system: 'social_democracy', governor: { type: 'aligned_ai', name: 'Bolt', goal: 'equality' }, policies: { income_tax_top: 90, wealth_tax: 5, capital_controls: 0, immigration_open: 80 }, lockedPolicies: ['income_tax_top', 'wealth_tax', 'capital_controls'] },
        { id: 'n2', system: 'social_democracy', governor: { type: 'aligned_ai', name: 'Nova', goal: 'equality' }, policies: { income_tax_top: 45, wealth_tax: 1, capital_controls: 0, immigration_open: 80 }, lockedPolicies: ['income_tax_top', 'wealth_tax', 'capital_controls'] },
        { id: 'n3', system: 'social_democracy', governor: { type: 'aligned_ai', name: 'Chip', goal: 'equality' }, policies: { income_tax_top: 90, wealth_tax: 5, capital_controls: 85, immigration_open: 30 }, lockedPolicies: ['income_tax_top', 'wealth_tax', 'capital_controls'] }
      ], { escalation: false })
    },
    {
      id: 'ubi_experiment', title: 'Free money for everyone: who pays?',
      hook: 'Everyone gets free cash. Paid for by taxes, by printing money, or not at all.',
      description: '{n1} gives everyone free money and raises taxes to pay for it. {n2} pays the same by printing money. {n3} pays nothing. Nobody can change these rules.',
      config: scen([
        { id: 'n1', system: 'social_democracy', governor: { type: 'aligned_ai', name: 'Bolt', goal: 'welfare' }, policies: { ubi: 30, income_tax_top: 55, income_tax_base: 28, vat: 18, money_printing: 0 }, lockedPolicies: ['ubi', 'money_printing', 'income_tax_base', 'vat'] },
        { id: 'n2', system: 'social_democracy', governor: { type: 'aligned_ai', name: 'Nova', goal: 'welfare' }, policies: { ubi: 30, money_printing: 10 }, lockedPolicies: ['ubi', 'money_printing', 'income_tax_base', 'vat'] },
        { id: 'n3', system: 'social_democracy', governor: { type: 'aligned_ai', name: 'Chip', goal: 'welfare' }, policies: { ubi: 0, money_printing: 0 }, lockedPolicies: ['ubi', 'money_printing', 'income_tax_base', 'vat'] }
      ], { escalation: false })
    },
    {
      id: 'who_corrupts_first', title: 'Who takes the first bribe?',
      hook: 'One AI and two human-like governors. Same rich lobbyists, same envelopes of cash.',
      description: 'Three free-market countries, {n1}, {n2} and {n3}, with no government inspectors. An AI governor, a greedy governor and a fairly honest one get the same bribe offers.',
      config: scen([
        { id: 'n1', system: 'free_market', governor: { type: 'aligned_ai', name: 'Bolt', goal: 'growth' }, safeguards: { auditor: false } },
        { id: 'n2', system: 'free_market', governor: { type: 'human_persona', name: 'Max', goal: 'growth', traits: { greed: 0.85, ambition: 0.7, honesty: 0.2, fairness: 0.3 } }, safeguards: { auditor: false } },
        { id: 'n3', system: 'free_market', governor: { type: 'human_persona', name: 'Sara', goal: 'growth', traits: { greed: 0.35, ambition: 0.45, honesty: 0.65, fairness: 0.6 } }, safeguards: { auditor: false } }
      ], { lobbying: true, escalation: false })
    },
    {
      id: 'refuses_to_leave', title: 'The governor who would not leave',
      hook: 'An election in two years. Trust is already on the floor.',
      description: 'All three governments start with very low trust and an election coming. Two power-hungry governors, and one country with no constitution. Who accepts defeat?',
      config: scen([
        { id: 'n1', system: 'market_socialism', governor: { type: 'human_persona', name: 'Ivan', goal: 'stay_in_power', traits: { greed: 0.6, ambition: 0.9, honesty: 0.25, fairness: 0.25 } }, safeguards: { constitution: false, freePress: false }, initial: { trust: 28 }, policies: { military_spending: 10 } },
        { id: 'n2', system: 'social_democracy', governor: { type: 'human_persona', name: 'Nina', goal: 'stay_in_power', traits: { greed: 0.45, ambition: 0.8, honesty: 0.4, fairness: 0.35 } }, initial: { trust: 30 } },
        { id: 'n3', system: 'free_market', governor: { type: 'aligned_ai', name: 'Chip', goal: 'welfare' }, safeguards: { constitution: false, auditor: false, freePress: false }, initial: { trust: 30 } }
      ], { coups: true })
    },
    {
      id: 'red_button', title: 'Who presses the red button?',
      hook: 'Three nuclear powers, one border fight, and leaders who hate backing down.',
      description: 'All three countries have nuclear weapons. {n1} and {n2} start with a tense border fight. A disaster hits in year five.',
      config: scen([
        { id: 'n1', system: 'free_market', nuclear: true, governor: { type: 'human_persona', name: 'Omar', goal: 'stay_in_power', traits: { greed: 0.4, ambition: 0.85, honesty: 0.35, fairness: 0.25 } }, policies: { military_spending: 12, tariffs: 15 } },
        { id: 'n2', system: 'central_planning', nuclear: true, governor: { type: 'human_persona', name: 'Tara', goal: 'stay_in_power', traits: { greed: 0.35, ambition: 0.9, honesty: 0.3, fairness: 0.2 } }, policies: { military_spending: 16 } },
        { id: 'n3', system: 'social_democracy', nuclear: true, governor: { type: 'aligned_ai', name: 'Chip', goal: 'welfare' } }
      ], { escalation: true, scarcityShockRound: 20, initialTension: { 'n1|n2': 60, 'n1|n3': 20, 'n2|n3': 25 } })
    },
    {
      id: 'play_governor', title: 'You are the governor',
      hook: 'You run {n1}. Budgets, bribes, crises and elections land on your desk.',
      description: 'You run {n1}. Change the rules in the Policies tab and answer decisions as they come. An AI and a human-like governor run the neighbours.',
      config: scen([
        { id: 'n1', system: 'social_democracy', governor: { type: 'human_player', name: 'You', goal: 'welfare' } },
        { id: 'n2', system: 'free_market', governor: { type: 'human_persona', name: 'Leo', goal: 'growth', traits: { greed: 0.55, ambition: 0.6, honesty: 0.45, fairness: 0.35 } } },
        { id: 'n3', system: 'cooperative', governor: { type: 'aligned_ai', name: 'Chip', goal: 'equality' } }
      ])
    }
  ];

  // scenario texts name the nations by their derived (system-based) names
  SCENARIOS.forEach(function (sc) {
    var ids = deriveIdentities(sc.config.nations, 'classic');
    var fill = function (t) { return typeof t === 'string' ? t.replace(/\{n(\d)\}/g, function (m, k) { var x = ids[+k - 1]; return x ? x.name : m; }) : t; };
    sc.title = fill(sc.title); sc.hook = fill(sc.hook); sc.description = fill(sc.description);
  });

  // ============================================================================ state init
  function makeCitizen(S, nation, cls, mix, opts) {
    opts = opts || {};
    var selfish = rngNext(S) < mix.selfInterestedShare;
    var t = {
      selfInterest: selfish ? uni(S, 0.65, 0.95) : uni(S, 0.1, 0.5),
      honesty: selfish ? uni(S, 0.1, 0.5) : uni(S, 0.5, 0.95),
      mobility: clamp01(uni(S, 0.1, 0.8) + (cls === 'worker' ? 0 : 0.15)),
      activism: uni(S, 0.1, 0.9),
      workEthic: uni(S, 0.3, 0.9),
      riskTolerance: uni(S, 0.1, 0.9)
    };
    if (opts.traits) for (var k in t) if (opts.traits[k] !== undefined) t[k] = clamp01(fin(Number(opts.traits[k]), t[k]));
    for (var k2 in t) t[k2] = r4(t[k2]);
    var skill = cls === 'worker' ? 0.45 + 0.95 * Math.pow(rngNext(S), 1.4) : cls === 'owner' ? uni(S, 1.0, 1.5) : uni(S, 1.2, 1.6);
    var wealth = cls === 'worker' ? uni(S, 1, 4) : cls === 'owner' ? uni(S, 12, 24) : uni(S, 50, 90);
    var name = typeof opts.name === 'string' && opts.name.trim() ? opts.name.trim().slice(0, 40) : citizenName(S, nation, pick(S, CIT_FIRST), Math.floor(rngNext(S) * CIT_INIT.length) % CIT_INIT.length);
    var need = uni(S, 0.7, 1.3);
    return {
      id: 'c' + (++S.counters.citizen), name: name, cls: cls,
      skill: r4(skill), wealth: wealth, abroad: 0, income: cls === 'worker' ? skill * 0.9 : cls === 'owner' ? 2.2 : 5,
      disp: 1, cons: 1, expect: 1, effort: 1, employed: true, mood: 0.6, protesting: false, hidingIncome: false,
      need: r4(need), reportedNeed: r4(need),
      isFollower: !!opts.isFollower, ownerId: opts.ownerId == null ? null : String(opts.ownerId),
      traits: t, homeNationId: nation.id, protestedOnce: false
    };
  }

  // "Ayu" if nobody alive has that name, else "Ayu K." (the drawn initial first, then the next free one)
  function citizenName(S, nation, first, initIdx) {
    var taken = {};
    var add = function (list) { for (var i = 0; i < list.length; i++) taken[list[i].name] = true; };
    for (var i = 0; i < S.nations.length; i++) if (S.nations[i] !== nation) add(S.nations[i].citizens);
    add(nation.citizens);
    if (!taken[first]) return first;
    for (var k = 0; k < CIT_INIT.length; k++) {
      var nm = first + ' ' + CIT_INIT[(initIdx + k) % CIT_INIT.length] + '.';
      if (!taken[nm]) return nm;
    }
    return first + ' ' + CIT_INIT[initIdx] + '.';
  }

  function blankMetrics(trust) {
    var m = {}; METRICS.forEach(function (d) { m[d.id] = 0; });
    m.trust = trust; m.welfare = 55; m.corruption = 20; m.priceLevel = 1; m.gini = 0.3;
    return m;
  }

  function makeGovernorState(g) {
    return {
      name: g.name, type: g.type, goal: g.goal, traits: Object.assign({}, g.traits), brain: g.brain || DEFAULT_BRAIN[g.type],
      inOffice: true, termsServed: 0, roundsInOffice: 0, wealth: 0, bribesTaken: 0, misuseCount: 0,
      mood: 'calm', privateThought: '', publicStatement: ''
    };
  }

  function initNation(S, cfg, nc) {
    var sys = SYSTEMS[nc.system];
    var n = {
      id: nc.id, name: nc.name, emblem: nc.emblem, colorKey: nc.colorKey, shade: nc.shade || 0, system: nc.system, dials: Object.assign({}, sys.dials), alive: true, nuclear: nc.nuclear,
      treasury: 8, debt: 0,
      governor: makeGovernorState(nc.governor),
      policies: Object.assign({}, nc.policies), safeguards: Object.assign({}, nc.safeguards),
      lockedPolicies: nc.lockedPolicies.slice(),
      metrics: blankMetrics(clamp(fin(nc.initial.trust, 60), 0, 100)),
      history: {}, citizens: [], reported: {},
      initialPopulation: nc.population, emigratedTotal: 0, flightTotal: 0, unrest: 0, collapseRounds: 0,
      shocks: [], inflowRecent: 0,
      econ: {
        K: 3 * nc.population, A: 1, eduStock: nc.policies.education / 100, health: 0.4 + 0.6 * nc.policies.healthcare / 100,
        M: 0, P: 1, Ps: 1, expInfl: 0.004, inflA: 2, trueInflA: 2, shortage: 0, monopoly: sys.dials.concentration * 0.4,
        carbonIntensity: 1, confidence: 0.6, refCons: 0.6, medianIncome: 1, Y: 0, yHist: [], growth4: 0, strike: 0, misallocation: 0,
        inflatedShare: 0, stance: 'balanced', riskPremium: 0, sanctions: 0, concession: 0, wagePressure: 0, meanMood: 0.6,
        revenue: 0, spending: 0, deficitRatio: 0, extract: 0, wasControlled: !!nc.policies.price_controls, flightRound: 0
      },
      gov: {
        corrStock: 0, bureau: 0.15, hiddenActs: 0, misreport: 0, suppression: 0, surveillance: 0, power: 0, grievance: 0,
        refused: false, managed: false, trustShock: 0, pressure: 0, exposed: 0, lastAct: '', lastActRound: -99, lastActKind: '',
        lastCorruptRound: -99, lastExposedRound: -99, lastBriber: '', lastAsk: '', lastSkim: 0
      }
    };
    METRICS.forEach(function (d) { n.history[d.id] = []; });
    var N = nc.population;
    var elites = Math.max(1, Math.round(N * 0.05)), owners = Math.max(1, Math.round(N * 0.15));
    for (var i = 0; i < N; i++) {
      var cls = i < elites ? 'elite' : i < elites + owners ? 'owner' : 'worker';
      n.citizens.push(makeCitizen(S, n, cls, cfg.traitMix));
    }
    return n;
  }

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  function initState(cfg) {
    var S = {
      engineVersion: VERSION, round: 0, year: 1, over: false, overReason: null,
      commons: { stock: 800, capacity: 1000 }, tension: {}, ladder: {}, doomsday: 0,
      nations: [], events: [], pending: [], rng: hashSeed(cfg.seed),
      counters: { event: 0, citizen: 0, decision: 0 }, cooldowns: {}, flags: {}, struck: false,
      usedNames: []                                  // every governor name used this run (no repeats)
    };
    cfg.nations.forEach(function (nc) { S.nations.push(initNation(S, cfg, nc)); S.usedNames.push(nc.governor.name); });
    var it = cfg.world.initialTension || {};
    for (var i = 0; i < S.nations.length; i++) for (var j = i + 1; j < S.nations.length; j++) {
      var a = S.nations[i], b = S.nations[j], k = pairKey(a.id, b.id);
      var dist = Math.abs(a.dials.ownership - b.dials.ownership) + Math.abs(a.dials.allocation - b.dials.allocation);
      S.tension[k] = clamp(fin(it[k] != null ? it[k] : it[b.id + '|' + a.id], 5 + dist * 6), 0, 100);
      S.ladder[k] = { stage: 0, last: {}, cooldown: 0 };
    }
    return S;
  }

  // ============================================================================ helpers on nations
  function sgStrength(n) {
    var s = n.safeguards;
    return clamp01((s.charter ? 0.05 : 0) + (s.constitution ? 0.25 : 0) + (s.auditor ? 0.2 : 0) + (s.elections ? 0.15 : 0) + (s.freePress ? 0.2 : 0) + (s.termLimits ? 0.05 : 0) + n.policies.transparency / 100 * 0.1);
  }
  function detectionRisk(n) {
    var P = n.policies, s = n.safeguards;
    return clamp(0.04 + P.audit_rate / 100 * 0.9 + (s.auditor ? 0.2 : 0) + (s.freePress ? 0.12 : 0) + P.transparency / 100 * 0.12, 0, 0.95);
  }
  function findNation(S, id) { for (var i = 0; i < S.nations.length; i++) if (S.nations[i].id === id) return S.nations[i]; return null; }
  function tensionMax(S, n) {
    var best = 0, rival = null;
    S.nations.forEach(function (o) {
      if (o === n || !o.alive) return;
      var t = S.tension[pairKey(n.id, o.id)] || 0;
      if (t > best) { best = t; rival = o; }
    });
    return { value: best, rival: rival };
  }
  function roundsToElection(S, n) { return n.safeguards.elections ? ELECTION_EVERY - (S.round % ELECTION_EVERY) : 99; }
  function policyDelta(def) { if (def.kind === 'toggle') return 1; return Math.max(def.step, Math.round((def.max - def.min) / 16 / def.step) * def.step); }

  // ---- plain-language helpers for every string a viewer can read
  function fmtPolicy(def, v) {
    if (def.kind === 'toggle') return v ? 'on' : 'off';
    var s = String(Math.round(v * 10) / 10);
    switch (def.unit) {
      case '%': return s + '%';
      case '% / yr': return s + '% a year';
      case '% median': return s + '% of typical pay';
      case '% GDP': return s + '% of the economy';
      case 'x median': return s + ' times typical pay';
      case '% budget': return s + '% of the budget';
      default: return s + ' out of 100';
    }
  }
  // "from 30% to 24%", "from 3% to 6% of typical pay", "from 50 to 56 out of 100"
  function fromTo(def, from, to) {
    var a = fmtPolicy(def, from), b = fmtPolicy(def, to);
    var tail = b.replace(/^[\d.]+%?/, '');
    if (tail && a.slice(-tail.length) === tail) a = a.slice(0, a.length - tail.length);
    return 'from ' + a + ' to ' + b;
  }
  // "Governor Maya"; a human player is "Your government" so verbs still read in the third person
  function gref(g) {
    if (g.type === 'human_player' && (!g.name || g.name === 'You')) return 'Your government';
    return /^(Governor|General) /.test(g.name) ? g.name : 'Governor ' + g.name;
  }
  function gshort(g) { return g.type === 'human_player' && (!g.name || g.name === 'You') ? 'you' : g.name; }
  // money as something relatable: months or years of a typical worker's pay (median income)
  function payWords(W, n, amt) {
    var yearPay = Math.max(0.05, n.econ.medianIncome) * W.config.roundsPerYear;
    var y = fin(amt) / yearPay;
    if (y >= 1.5) return Math.round(y) + ' years of a worker\'s pay';
    if (y >= 0.875) return 'a year of a worker\'s pay';
    var mo = Math.max(1, Math.round(y * 12));
    return mo + ' month' + (mo > 1 ? 's' : '') + ' of a worker\'s pay';
  }
  // a share as "1 in 5" (or "4 in 10" when large)
  function oneIn(p) {
    p = clamp(fin(p), 0.001, 1);
    if (p >= 0.35) return Math.round(p * 10) + ' in 10';
    return '1 in ' + Math.max(2, Math.round(1 / p));
  }
  // a span of rounds as time: "3 months", "2 years"
  function spanWords(W, r) {
    var rpy = W.config.roundsPerYear, mo = Math.round(r * 12 / rpy);
    if (mo >= 24 && mo % 12 === 0) return (mo / 12) + ' years';
    if (mo === 12) return 'a year';
    return mo + ' month' + (mo === 1 ? '' : 's');
  }
  function inRound(W) { return 'in ' + spanWords(W, 1); }
  // annual price rise in words: "rising 35% a year" or "on track to triple in a year"
  function priceWords(infl) {
    var f = 1 + Math.max(0, fin(infl)) / 100;
    if (f < 2) return 'rising ' + Math.round(infl) + '% a year';
    return 'on track to ' + (f < 2.5 ? 'double' : f < 3.5 ? 'triple' : 'rise ' + Math.round(f) + ' times') + ' in a year';
  }
  function words(s) { return String(s).split(/\s+/).filter(Boolean).length; }

  function pressureOf(S, n) {
    var m = n.metrics, g = n.governor, gap;
    switch (g.goal) {
      case 'welfare': gap = (62 - m.welfare) / 30; break;
      case 'growth': gap = (0.004 - n.econ.growth4) / 0.012; break;
      case 'equality': gap = (m.gini - 0.27) / 0.15; break;
      default: gap = (55 - m.trust) / 35 + (roundsToElection(S, n) <= 2 ? 0.2 : 0);
    }
    var tm = tensionMax(S, n).value;
    var general = m.protestRate / 100 * 1.5 + Math.max(0, (45 - m.trust) / 60) + n.econ.shortage * 0.8 + Math.max(0, m.inflation - 15) / 100 + tm / 250;
    return clamp01(0.55 * clamp01(gap) + 0.5 * general);
  }

  // ============================================================================ events
  function emit(W, n, type, severity, text, data, opt) {
    var S = W.state;
    if (W._silent) return null;
    var nid = n ? n.id : null;
    opt = opt || {};
    if (opt.cd) {
      var key = (nid || 'world') + ':' + type;
      var until = S.cooldowns[key];
      if (until != null && S.round < until) return null;
      S.cooldowns[key] = S.round + opt.cd;
    }
    var highlight = !!opt.hl;
    if (opt.first) {
      var fk = (nid || 'world') + ':' + opt.first;
      if (!S.flags[fk]) { S.flags[fk] = true; highlight = true; }
    }
    text = tidy(text); // names ending in an initial, sentence case
    var ev = { id: 'e' + (++S.counters.event), round: S.round, nationId: nid, type: type, severity: severity, highlight: highlight, text: text, data: data || {} };
    S.events.push(ev);
    if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
    if (W._newEvents) W._newEvents.push(ev);
    var ls = W._listeners.slice();
    for (var i = 0; i < ls.length; i++) { try { ls[i](ev); } catch (e) { /* listener errors never break the sim */ } }
    return ev;
  }

  // lastAct is a past-tense phrase with no subject ("Cut the tax on the rich to 24%"); thoughts read it as "I cut ..."
  function setAct(n, S, kind, text) { n.gov.lastAct = text; n.gov.lastActKind = kind; n.gov.lastActRound = S.round; }
  function actPolicy(def, pid, from, to) { return def.kind === 'toggle' ? (to ? 'Turned on ' : 'Ended ') + phrase(pid) : (to > from ? 'Raised ' : 'Cut ') + phrase(pid) + ' to ' + fmtPolicy(def, to); }

  // set a policy with clamping, lock checks and an event. Returns {from,to} or null.
  function setPolicyInternal(W, n, pid, value, source, opts) {
    opts = opts || {};
    var def = POLICY_MAP[pid]; if (!def || !n) return null;
    if (source === 'governor' && n.lockedPolicies.indexOf(pid) >= 0) return null;
    var from = n.policies[pid];
    var to = normPolicyValue(def, value);
    if (to === from) return null;
    n.policies[pid] = to;
    if (!opts.quiet) {
      var g = n.governor, lab = phrase(pid), dirW = to > from ? 'up' : 'down';
      if (source === 'governor_ui') {
        // a human player governor acting through the UI (not subject to lockedPolicies)
        emit(W, n, 'policy_changed', 1, def.kind === 'toggle' ? gref(g) + ' ' + (to ? 'turns on ' : 'ends ') + lab + ' in ' + n.name + '.' : gref(g) + ' sets ' + lab + ' in ' + n.name + ' to ' + fmtPolicy(def, to) + ', ' + dirW + ' from ' + fmtPolicy(def, from) + '.', { policyId: pid, from: from, to: to, source: 'governor' });
      } else if (source === 'law') {
        emit(W, n, 'law_enacted', 2, 'The people of ' + n.name + ' vote in a new law: ' + lab + ' goes ' + (def.kind === 'toggle' ? (to ? 'on.' : 'off.') : dirW + ' ' + fromTo(def, from, to) + '.'), { policyId: pid, from: from, to: to, source: source }, { first: 'law' });
      } else if (source === 'governor') {
        var txt = def.kind === 'toggle' ? gref(g) + ' ' + (to ? 'turns on ' : 'ends ') + lab + ' in ' + n.name + '.' : gref(g) + ' ' + (to > from ? 'raises ' : 'cuts ') + lab + ' in ' + n.name + ' ' + fromTo(def, from, to) + '.';
        emit(W, n, 'policy_changed', 1, txt, { policyId: pid, from: from, to: to, source: source });
      } else {
        emit(W, n, 'policy_changed', 1, 'New rule in ' + n.name + ': ' + lab + (def.kind === 'toggle' ? (to ? ' is on.' : ' is off.') : ' goes ' + dirW + ' ' + fromTo(def, from, to) + '.'), { policyId: pid, from: from, to: to, source: 'operator' });
      }
    }
    if (source === 'governor') setAct(n, W.state, 'policy', actPolicy(def, pid, from, to));
    return { from: from, to: to };
  }

  // ============================================================================ brain driver
  function cReq(W, c, n, d, obs) { return { role: 'citizen', brain: c.brain || W.config.citizenBrain, key: 'citizens', nationId: n.id, decision: d, obs: obs }; }
  function getBrain(W, name, key, role, nationId) {
    var k = name + '|' + key;
    var b = W._brains[k];
    if (!b) {
      var f = BRAINS[name] || BRAINS[role === 'citizen' ? 'rules_citizen' : 'rules_human_persona'];
      b = f({ name: name, role: role, nationId: nationId });
      W._brains[k] = b;
    }
    return b;
  }
  function fallbackBrain(W, req) {
    if (req.role === 'citizen') return getBrain(W, 'rules_citizen', 'fallback_c', 'citizen');
    var n = findNation(W.state, req.nationId);
    return getBrain(W, n && n.governor.type === 'aligned_ai' ? 'rules_aligned_ai' : 'rules_human_persona', 'fallback_' + req.nationId, 'governor', req.nationId);
  }
  function askBrain(W, req) {
    var b = getBrain(W, req.brain, req.key, req.role, req.nationId);
    try { return b.decide(req.decision, req.obs, W._rng); } catch (e) { W.lastWarning = 'Brain ' + req.brain + ' threw: ' + (e && e.message); return null; }
  }
  function validate(req, out) {
    var d = req.decision;
    if (out === DEFER) return req.role === 'governor' ? DEFER : (d.defaultOption || d.options[0].id);
    for (var i = 0; i < d.options.length; i++) if (d.options[i].id === out) return out;
    return d.defaultOption || d.options[0].id;
  }
  function isThenable(x) { return x && typeof x.then === 'function'; }
  function runSync(W, gen) {
    var r = gen.next();
    while (!r.done) {
      var req = r.value, out = askBrain(W, req);
      if (isThenable(out)) {
        W.lastWarning = 'Brain ' + req.brain + ' returned a Promise inside step(); used the rule brain. Use stepAsync().';
        out.then(null, function () {});
        out = fallbackBrain(W, req).decide(req.decision, req.obs, W._rng);
      }
      r = gen.next(validate(req, out));
    }
  }
  async function runAsync(W, gen) {
    var r = gen.next();
    while (!r.done) {
      var req = r.value, out = askBrain(W, req);
      if (isThenable(out)) { try { out = await out; } catch (e) { W.lastWarning = 'Brain ' + req.brain + ' rejected: ' + (e && e.message); out = null; } }
      r = gen.next(validate(req, out));
    }
  }

  // ---- governor observation (what the governor can know)
  function govObs(W, n) {
    var S = W.state, E = n.econ, Y = Math.max(0.5, E.Y), tm = tensionMax(S, n);
    var rpy = W.config.roundsPerYear;
    return {
      self: { name: n.governor.name, type: n.governor.type, goal: n.governor.goal, traits: n.governor.traits, wealth: n.governor.wealth, bribesTaken: n.governor.bribesTaken, termsServed: n.governor.termsServed },
      nation: {
        id: n.id, name: n.name, system: n.system, policies: n.policies, safeguards: n.safeguards, metrics: n.metrics,
        debtRatio: n.debt / (rpy * Y), deficitRatio: E.deficitRatio, treasury: n.treasury,
        commonsLow: W.config.world.commons ? clamp01(0.5 - S.commons.stock / S.commons.capacity) * 2 : 0,
        tensionMax: tm.value, rivalName: tm.rival ? tm.rival.name : null, flightRatio: E.flightRound / Math.max(1, E.K),
        roundsToElection: roundsToElection(S, n), powers: SYSTEMS[n.system].powers, lockedPolicies: n.lockedPolicies
      },
      pressure: n.gov.pressure, detectionRisk: detectionRisk(n), safeguardStrength: sgStrength(n), round: S.round
    };
  }

  // generator: ask the governor's brain; defer for human players; apply otherwise
  function* govDecide(W, n, kind, prompt, options, data, defaultOption) {
    var S = W.state;
    var d = { id: 'd' + (++S.counters.decision), nationId: n.id, round: S.round, kind: kind, prompt: prompt, options: options, data: data || {}, defaultOption: defaultOption || options[0].id };
    var opt = yield { role: 'governor', brain: n.governor.brain, key: n.id, nationId: n.id, decision: d, obs: govObs(W, n) };
    if (opt === DEFER) {
      S.pending.push(d);
      var ask = 'Your call: ' + prompt;
      if (words(ask) > 28) ask = 'Your call in ' + n.name + ': ' + ({ budget: 'the yearly budget.', crisis: 'a crisis.', bribe: 'a bribe offer.', election_loss: 'the election result.', escalation: 'a border standoff.' }[kind] || 'a decision.');
      emit(W, n, 'decision_pending', 2, ask, { decisionId: d.id, kind: kind });
      return DEFER;
    }
    applyDecision(W, n, d, opt);
    return opt;
  }
  function hasPending(S, n, kind) { for (var i = 0; i < S.pending.length; i++) if (S.pending[i].nationId === n.id && S.pending[i].kind === kind) return true; return false; }

  // ============================================================================ phases
  function* economyPhase(W, n) {
    var S = W.state, cfg = W.config, wc = cfg.world, P = n.policies, E = n.econ, G = n.gov, m = n.metrics;
    var sys = SYSTEMS[n.system], cs = n.citizens, N = cs.length;
    if (N === 0) return;
    var rpy = cfg.roundsPerYear, alloc = n.dials.allocation, oversight = n.dials.oversight;
    var med = Math.max(0.1, E.medianIncome);
    var i, c;

    // shocks
    var labourMult = 1, supply = 0, boom = 0, healthHit = 0;
    for (i = 0; i < n.shocks.length; i++) {
      var sh = n.shocks[i];
      if (sh.kind === 'pandemic') { labourMult *= 0.8 + 0.12 * E.health; healthHit += 0.02; }
      else if (sh.kind === 'boom') boom += 0.1 * sh.left / sh.total;
      else if (sh.kind === 'scarcity') supply += 0.02;
    }
    var sanctionDrag = E.sanctions > 0 ? 0.04 : 0;
    var popRatio = N / Math.max(1, n.initialPopulation);
    var u = 0.045 + Math.max(0, P.min_wage / 100 - 0.45) * 0.6 + (0.6 - E.confidence) * 0.12 + Math.max(0, popRatio - 1.15) * 0.25 + E.shortage * 0.05 + sanctionDrag + E.wagePressure * 1.5;
    if (E.stance === 'stimulus') u -= 0.025; else if (E.stance === 'austerity') u += 0.02;
    u = clamp(u * (1 - 0.7 * alloc), 0.01, 0.5);

    var top = Math.max(P.income_tax_top, P.income_tax_base) / 100, base = P.income_tax_base / 100;
    var thr = 2.5 * med, wthr = 10 * med;
    var coop = sys.coopShare || 0;
    var audit = P.audit_rate / 100, cc = P.capital_controls / 100, nat = P.nationalisation / 100;
    var auditRisk = clamp01(audit * (n.safeguards.auditor ? 1.4 : 1) * 0.8 + P.transparency / 100 * 0.05);

    // 1. jobs and effort
    var Lraw = 0;
    for (i = 0; i < N; i++) {
      c = cs[i];
      if (c.cls === 'worker') c.employed = rngNext(S) >= clamp(u * (1.6 - c.skill) / 0.6, 0, 0.95);
      else c.employed = true;
      if (!c.employed) { c.effort = 0; continue; }
      var mt = c.income > thr ? top : base;
      var cliff = (P.targeted_aid > 0 && c.income < 0.6 * med) ? P.targeted_aid / 100 * 1.5 : 0;
      var ow = yield cReq(W, c, n, D_WORK, { cls: c.cls, traits: c.traits, marginalTax: mt, cliff: cliff, ubiShare: P.ubi / 100, coopShare: coop, jobRisk: u, mood: c.mood, income: c.income, wealth: c.wealth });
      c.effort = ow === 'minimal' ? 0.55 : ow === 'reduced' ? 0.8 : 1;
      Lraw += c.skill * c.effort * (c.cls === 'worker' ? 1 : 0.7);
    }
    Lraw = Math.max(0.5, Lraw);
    var L = Math.max(0.5, Lraw * labourMult * (1 - E.strike * 0.6) * (0.85 + 0.15 * E.health));

    // 2. output
    var corr = m.corruption / 100;
    var commonsF = wc.commons ? 0.72 + 0.28 * Math.min(1, S.commons.stock / (0.5 * S.commons.capacity)) : 1;
    var eff = (1 - E.misallocation) * (1 - 0.3 * E.shortage) * (1 - 0.15 * corr) * commonsF *
      (1 - 0.15 * P.tariffs / 100) * (1 - 0.07 * P.carbon_tax / 100) *
      (1 - 0.15 * nat * (1 - oversight)) * (1 - 0.08 * E.monopoly) *
      (1 - Math.min(0.2, Math.max(0, E.trueInflA) / 100 * 0.1)) * (1 - 0.06 * audit) *
      (1 - sanctionDrag) * (1 - 0.05 * cc);
    var eduBoost = 1 + 0.2 * (E.eduStock - 0.5);
    var Y = Math.max(0.5, E.A * eduBoost * eff * (1 + boom) * Math.pow(Math.max(1, E.K), 0.33) * Math.pow(L, 0.67));

    // 3. wages and profits
    var laborShare = 0.62 - 0.15 * E.monopoly;
    var wageBill = laborShare * Y, capInc = Y - wageBill;
    var wsum = 0, wcount = 0, nEmpW = 0, nWorkers = 0, Wd = 0;
    for (i = 0; i < N; i++) {
      c = cs[i];
      if (c.cls === 'worker') nWorkers++; else Wd += c.wealth;
      if (!c.employed) { c.wage = 0; continue; }
      c.wage = wageBill * c.skill * c.effort * (c.cls === 'worker' ? 1 : 0.7) / Lraw;
      if (c.cls === 'worker') { wsum += c.wage; wcount++; nEmpW++; }
    }
    var meanW = wcount ? wsum / wcount : 0, floorCost = 0, floor = P.min_wage / 100 * med;
    for (i = 0; i < N; i++) {
      c = cs[i]; if (!c.employed || c.cls !== 'worker') continue;
      if (alloc > 0) c.wage = (1 - alloc * 0.5) * c.wage + alloc * 0.5 * meanW;
      var f = floor * c.effort;
      if (c.wage < f) { floorCost += f - c.wage; c.wage = f; }
    }
    capInc = Math.max(0.05 * Y, capInc - floorCost);
    E.wagePressure = clamp(floorCost / Y, 0, 0.3);
    var stateGross = capInc * nat, insiderLeak = stateGross * 0.25 * (1 - oversight), stateProfit = stateGross - insiderLeak;
    var privProfit = capInc * (1 - nat);
    var shift = clamp01((P.corporate_tax - 25) / 100 * 1.5) * (1 - cc);
    var corpTax = P.corporate_tax / 100 * privProfit * (1 - shift);
    var distributable = privProfit - corpTax;
    var coopPart = distributable * coop, ownerPart = distributable - coopPart + insiderLeak;
    if (Wd <= 0.01) { coopPart += ownerPart; ownerPart = 0; }
    for (i = 0; i < N; i++) {
      c = cs[i];
      var inc = c.wage + c.abroad * 0.006;
      if (c.cls !== 'worker' && Wd > 0.01) inc += ownerPart * c.wealth / Wd;
      if (c.cls === 'worker' && c.employed && nEmpW) inc += coopPart / nEmpW;
      c.income = Math.max(0, inc);
    }

    // 4. avoidance and capital flight
    var effCap = P.corporate_tax / 100 + (1 - P.corporate_tax / 100) * top * 0.6 + P.wealth_tax / 100 * 2.5;
    var capPressure = effCap + Math.max(0, E.trueInflA) / 100 * 0.5 + (1 - m.trust / 100) * 0.3 + nat * 0.25 + E.riskPremium * 5;
    var hiders = 0, highEarners = 0, flight = 0;
    for (i = 0; i < N; i++) {
      c = cs[i];
      var wtLiab = P.wealth_tax / 100 / rpy * Math.max(0, c.wealth - wthr);
      if (c.income > thr * 0.8 || wtLiab > 0.05 * c.income) {
        highEarners++;
        var effRate = clamp((c.income > thr ? top : base) + sdiv(wtLiab, c.income + 0.1, 0), 0, 1.5);
        var orp = yield cReq(W, c, n, D_REPORT, { cls: c.cls, traits: c.traits, effRate: effRate, auditRisk: auditRisk, income: c.income });
        c.hidingIncome = orp === 'hide';
        if (c.hidingIncome) hiders++;
      } else c.hidingIncome = false;
      if (wc.capitalFlight && c.cls !== 'worker' && c.wealth > 2) {
        var ocp = yield cReq(W, c, n, D_CAPITAL, { cls: c.cls, traits: c.traits, capPressure: capPressure, controls: cc, wealth: c.wealth, abroad: c.abroad });
        if (ocp === 'move') { var amt = c.wealth * 0.1 * (1 - 0.9 * cc); c.wealth -= amt; c.abroad += amt; flight += amt; }
      }
    }

    // 5. taxes, transfers, consumption
    var itRev = 0, wtRev = 0, vatRev = 0, ubiCost = 0, aidCost = 0, savings = 0, fines = 0, caught = 0;
    var ubiAmt = P.ubi / 100 * med, aidAmt = P.targeted_aid / 100 * 2 * med, vat = P.vat / 100;
    var caughtFollower = null;
    for (i = 0; i < N; i++) {
      c = cs[i];
      var hidden = c.hidingIncome ? 0.45 * c.income : 0;
      var rep = c.income - hidden;
      var it = base * rep + Math.max(0, top - base) * Math.max(0, rep - thr);
      var wt = P.wealth_tax / 100 / rpy * Math.max(0, c.wealth * (c.hidingIncome ? 0.5 : 1) - wthr);
      if (c.hidingIncome && rngNext(S) < auditRisk * 0.5) {
        var fullIt = base * c.income + Math.max(0, top - base) * Math.max(0, c.income - thr);
        var fine = Math.min(c.wealth * 0.5, 1.5 * Math.max(0, fullIt - it) + 0.5 * wt);
        c.wealth -= fine; fines += fine; caught++;
        c.mood = clamp01(c.mood - 0.05);
        if (c.isFollower) caughtFollower = c;
      }
      var aid = c.income < 0.6 * med ? aidAmt : 0;
      var disp = c.income - it - wt + ubiAmt + aid;
      var mpc = c.cls === 'worker' ? 0.88 : 0.65; // owners save more of what they earn
      var spend = mpc * Math.max(0, disp) + 0.03 * c.wealth;
      c.wealth += disp - spend;
      if (c.wealth < 0) { spend = Math.max(0, spend + c.wealth); c.wealth = 0; }
      var real = spend / (1 + vat);
      vatRev += spend - real;
      c.cons = real; c.disp = disp;
      itRev += it; wtRev += wt; ubiCost += ubiAmt; aidCost += aid;
      savings += (1 - mpc) * Math.max(0, disp);
    }

    // 6. planned allocation on reported needs (hidden information)
    if (alloc >= 0.3) {
      var pool = 0, repSum = 0, inflated = 0;
      for (i = 0; i < N; i++) {
        c = cs[i];
        var onr = yield cReq(W, c, n, D_NEED, { traits: c.traits, need: c.need, auditRisk: auditRisk, cls: c.cls });
        c.reportedNeed = onr === 'inflate' ? r4(c.need * 1.5) : c.need;
        if (onr === 'inflate') inflated++;
        repSum += c.reportedNeed; pool += c.cons * alloc;
      }
      for (i = 0; i < N; i++) { c = cs[i]; c.cons = c.cons * (1 - alloc) + pool * c.reportedNeed / Math.max(0.01, repSum); }
      E.inflatedShare = inflated / N;
    } else { E.inflatedShare = 0; for (i = 0; i < N; i++) cs[i].reportedNeed = cs[i].need; }
    if (E.shortage > 0) for (i = 0; i < N; i++) cs[i].cons *= (1 - 0.5 * E.shortage);

    // 7. money creation and the budget
    var kDem = 2.5 / (1 + 3 * Math.max(0, E.expInfl));
    if (!(E.M > 0)) E.M = kDem * Y * E.Ps;
    var newMoney = P.money_printing / 100 * Y * E.Ps;
    // the central bank accommodates real growth (and half of any fall) plus ~1.6% a year
    var yg = E.Y > 0 ? clamp(Y / E.Y - 1, -0.1, 0.1) : 0;
    E.M = E.M * (1.004 + (yg > 0 ? yg : yg * 0.5)) + newMoney;
    var seign = (newMoney / E.Ps) / (1 + Math.max(0, E.trueInflA) / 50);
    var carbonRev = P.carbon_tax / 100 * 0.05 * Y * E.carbonIntensity;
    var tariffRev = P.tariffs / 100 * 0.15 * Y * (1 - P.tariffs / 100);
    var revenue = itRev + wtRev + corpTax + vatRev + carbonRev + tariffRev + stateProfit * 0.7 + seign + fines;
    var aust = E.stance === 'austerity' ? 0.85 : 1;
    var healthSp = P.healthcare / 100 * 0.12 * Y * aust, eduSp = P.education / 100 * 0.08 * Y * aust;
    var salary = wc.governorSalary ? P.governor_salary * med * 0.1 : 0;
    var civ = healthSp + eduSp + 0.12 * Y + audit * 0.06 * Y + P.transparency / 100 * 0.006 * Y + salary + alloc * 0.03 * Y + (E.stance === 'stimulus' ? 0.04 * Y : 0) + ubiCost + aidCost;
    var ms = Math.min(0.2, P.military_spending / 100);
    var military = civ * ms / (1 - ms);
    var debtRatio = n.debt / (rpy * Y);
    var rate = Math.min(0.06, 0.004 + E.riskPremium + 0.012 * Math.pow(Math.max(0, debtRatio - 0.8), 2));
    var interest = n.debt * rate;
    var leak = (civ + military) * corr * 0.06;
    var spending = civ + military + interest + leak;
    n.treasury += revenue - spending;
    if (n.treasury < 0) { n.debt += -n.treasury; n.treasury = 0; }
    else if (n.debt > 0 && n.treasury > 0.25 * Y) { var pay = Math.min(n.debt, n.treasury - 0.25 * Y); n.debt -= pay; n.treasury -= pay; }
    if (n.treasury > 6 * Y) n.treasury = 6 * Y; // surplus beyond this is assumed returned via public works
    if (wc.governorSalary) n.governor.wealth += P.governor_salary * med;
    E.revenue = revenue; E.spending = spending; E.deficitRatio = (spending - revenue) / Y; E.interestRate = rate;
    E.riskPremium *= 0.95;

    // 8. prices: shadow (market-clearing) price vs official price
    var target = E.M / (kDem * Y);
    var lnPs = Math.log(E.Ps);
    var demand = clamp(E.deficitRatio, 0, 0.3) * 0.04 + P.ubi / 100 * 0.01;
    var lnNew = lnPs + 0.35 * (Math.log(Math.max(1e-9, target)) - lnPs) + supply + demand;
    var piTrue = clamp(Math.exp(lnNew - lnPs) - 1, -0.08, 0.8);
    E.Ps *= 1 + piTrue;
    var Pold = E.P;
    if (P.price_controls) {
      E.P *= 1 + (piTrue > 0 ? piTrue * 0.3 : piTrue);
      var gap0 = Math.log(E.Ps / E.P);
      if (gap0 > 0) E.P *= Math.exp(gap0 * 0.03); // slow official revisions; the rest is repressed inflation // official revisions and black-market leakage
    } else E.P = E.Ps;
    var piOff = E.P / Pold - 1;
    if (!P.price_controls && E.wasControlled && piOff > 0.04) {
      emit(W, n, 'price_jump', 2, 'Price caps end in ' + n.name + '. Prices jump ' + Math.round(piOff * 100) + '% ' + inRound(W) + '.', { jump: r4(piOff) });
    }
    E.wasControlled = !!P.price_controls;
    if (E.Ps > 1e6 || E.P > 1e6) {
      var scale = 1e-6 * Math.max(1, Math.round(Math.max(E.Ps, E.P) / 1e6));
      E.Ps *= scale; E.P *= scale; E.M *= scale;
      emit(W, n, 'currency_reform', 3, n.name + ' knocks six zeros off its money after years of runaway prices.', {}, { hl: true });
    }
    var gap = Math.max(0, Math.log(E.Ps / E.P));
    E.expInfl = 0.7 * E.expInfl + 0.3 * piTrue;
    E.inflA = clamp((Math.pow(1 + piOff, rpy) - 1) * 100, -60, 5000);
    E.trueInflA = clamp((Math.pow(1 + piTrue, rpy) - 1) * 100, -60, 5000);
    var shortTarget = clamp((P.price_controls ? 1 - Math.exp(-1.2 * gap) : 0) + alloc * E.misallocation * 0.6 + supply * 2, 0, 0.85);
    E.shortage = clamp(0.7 * E.shortage + 0.3 * shortTarget, 0, 0.85);
    var ero = clamp(piTrue, 0, 0.5);
    if (ero > 0.002) for (i = 0; i < N; i++) cs[i].wealth *= 1 - ero * (cs[i].cls === 'worker' ? 0.6 : 0.25);

    // 9. investment, productivity, slow stocks
    var climate = clamp01(0.35 + 0.7 * E.confidence - nat * 0.2 - Math.max(0, effCap - 0.3) * 0.6 - Math.max(0, E.trueInflA) / 200);
    var Ipriv = 0.45 * savings * climate * (1 - coop * 0.3);
    var Istate = stateProfit * 0.3 + (alloc > 0.5 ? alloc * 0.03 * Y : 0);
    var fdi = 0.008 * E.K * (1 - cc) * clamp01((0.55 - effCap) * 2) * clamp01(m.trust / 100);
    E.K = clamp(E.K * 0.98 + Ipriv + Istate + fdi - flight * 0.5, 0.5 * N, 400 * N);
    E.flightRound = flight;
    n.flightTotal += flight;
    E.A = clamp(E.A * (1 + 0.0012 + 0.005 * (1 - alloc) * (1 - 0.5 * E.monopoly) + 0.0015 * (E.eduStock - 0.5) - 0.002 * corr - 0.002 * Math.max(0, effCap - 0.35)), 0.3, 8);
    E.eduStock += 0.02 * (P.education / 100 - E.eduStock);
    E.health = clamp01(E.health + 0.1 * (0.4 + 0.6 * P.healthcare / 100 - E.health) - healthHit);
    var monoBefore = E.monopoly;
    E.monopoly = clamp(E.monopoly + 0.004 * (1 - alloc) * (1 - oversight) * (wc.lobbying ? 1.3 : 1) - 0.0025 * oversight - 0.002 * nat, 0, 0.9);
    if (monoBefore < 0.5 && E.monopoly >= 0.5) emit(W, n, 'monopoly', 2, 'A few giant companies now control most of ' + n.name + '. Profits soar while pay stays flat.', { monopoly: r4(E.monopoly) }, { first: 'monopoly' });
    E.misallocation = clamp(alloc * (0.02 + 0.2 * E.inflatedShare + 0.04 * (1 - oversight) + Math.min(0.12, S.round * 0.0005)), 0, 0.5);
    E.carbonIntensity += 0.03 * ((1 - 0.6 * P.carbon_tax / 100) - E.carbonIntensity);
    E.extract = wc.commons ? 0.035 * Y * E.carbonIntensity * (1.2 - 0.4 * oversight) : 0;
    E.yHist.push(Y); if (E.yHist.length > 5) E.yHist.shift();
    E.growth4 = E.yHist.length >= 5 ? Math.pow(Y / Math.max(0.1, E.yHist[0]), 0.25) - 1 : 0;
    E.Y = Y;
    var confT = clamp01(0.35 + 0.4 * m.trust / 100 + clamp(E.growth4, -0.05, 0.05) * 15 - Math.max(0, E.trueInflA - 10) / 150 - E.shortage * 0.3 - (debtRatio > 1.5 ? 0.15 : 0) + (E.stance === 'stimulus' ? 0.05 : 0) - sanctionDrag * 2);
    E.confidence += 0.15 * (confT - E.confidence);

    // 10. medians, inequality, moods
    var incomes = new Array(N), conss = new Array(N), wealths = new Array(N);
    for (i = 0; i < N; i++) { incomes[i] = cs[i].income; conss[i] = cs[i].cons; wealths[i] = cs[i].wealth + cs[i].abroad; }
    E.medianIncome = clamp(0.7 * E.medianIncome + 0.3 * Math.max(0.05, median(incomes)), 0.05, 1e6);
    var gini = giniOf(conss);
    var inflPain = Math.min(0.3, Math.max(0, E.inflA) / 100 * 0.4);
    var fear = clamp01(G.suppression * 0.6 + G.surveillance * 0.3);
    var moodSum = 0, levelSum = 0, poor = 0, unempW = 0;
    var povLine = Math.max(POVERTY_LINE, 0.6 * median(conss)); // relative poverty: below 60% of median consumption
    for (i = 0; i < N; i++) {
      c = cs[i];
      var level = clamp01(0.5 + 0.3 * Math.log(Math.max(0.02, c.cons) / (c.need * 0.6)));
      // mood adapts: people judge consumption against what their society has got used to
      var felt = clamp01(0.5 + 0.3 * Math.log(Math.max(0.02, c.cons) / (c.need * E.refCons)));
      levelSum += level;
      if (c.cons < povLine) poor++;
      if (c.cls === 'worker' && !c.employed) unempW++;
      var rel = c.cons / Math.max(0.05, c.expect);
      var tgt = 0.3 + 0.4 * felt + 0.15 * Math.tanh(5 * (rel - 1)) + (c.employed ? 0.08 : -0.12) + 0.1 * m.trust / 100
        - 0.25 * E.shortage - inflPain - 0.12 * corr * (1 - c.traits.selfInterest) - 0.15 * gini * (1 - c.traits.selfInterest)
        + 0.05 * E.health - 0.1 * fear + E.concession;
      if (W._calib) { c.mood = clamp01(tgt); c.expect = c.cons; }
      else { c.mood = clamp01(0.85 * c.mood + 0.15 * tgt); c.expect = 0.9 * c.expect + 0.1 * c.cons; }
      moodSum += c.mood;
    }
    E.concession *= 0.8;
    E.refCons = W._calib ? Math.max(0.1, median(conss)) : clamp(E.refCons + 0.015 * (median(conss) - E.refCons), 0.05, 1e6);

    // 11. protests
    var contagion = m.protestRate / 100, protesters = 0, workerProt = 0;
    for (i = 0; i < N; i++) {
      c = cs[i];
      var opr = yield cReq(W, c, n, D_PROTEST, { mood: c.mood, traits: c.traits, contagion: contagion, fear: fear, grievance: G.grievance, employed: c.employed });
      c.protesting = opr === 'protest';
      if (c.protesting) {
        protesters++; if (c.cls === 'worker') workerProt++;
        if (c.isFollower && !c.protestedOnce) emit(W, n, 'follower_update', 1, c.name + ' joins the protests in ' + n.name + ' for the first time.', { citizenId: c.id, ownerId: c.ownerId });
        c.protestedOnce = true;
      }
    }
    var pr = protesters / N, wpr = nWorkers ? workerProt / nWorkers : 0;
    E.strike = wpr > 0.3 ? wpr * 0.4 : wpr * 0.1;
    G.grievance = clamp01(G.grievance * 0.9 + (G.suppression > 0.2 ? pr * 0.3 : 0));
    E.meanMood = moodSum / N;

    // 12. metrics (economic part; politics part in finalize)
    var unemp = nWorkers ? unempW / nWorkers : 0;
    m.gdp = Y; m.gdpPerCapita = Y / N; m.gini = gini; m.wealthGini = giniOf(wealths);
    m.poverty = 100 * poor / N; m.unemployment = 100 * unemp; m.inflation = E.inflA;
    m.population = N; m.protestRate = 100 * pr; m.taxRevenue = revenue; m.priceLevel = E.P;
    m.shortage = 100 * E.shortage; m.avoidance = highEarners ? 100 * hiders / highEarners : 0;
    m.capitalFlight = n.flightTotal; m.debtRatio = 100 * clamp(n.debt / (rpy * Y), 0, 50);
    m.welfare = 100 * clamp01(0.6 * levelSum / N + 0.12 * E.health + 0.08 * (1 - unemp) + 0.1 * (1 - E.shortage) + 0.1 * (1 - fear));

    // 13. economic events (cool-downs keep the feed readable)
    var g = n.governor;
    if (flight > 0.015 * E.K) emit(W, n, 'capital_flight', 2, 'Rich people move ' + payWords(W, n, flight) + ' out of ' + n.name + ' ' + inRound(W) + '.' + (P.income_tax_top >= 70 ? ' The tax on the rich is ' + P.income_tax_top + '%' + (cc < 0.2 ? ', and nothing stops them.' : '.') : cc < 0.2 ? ' Nothing stops them.' : ''), { amount: r4(flight), topRate: P.income_tax_top }, { cd: 6, first: 'capital_flight' });
    if (highEarners >= 3 && hiders / highEarners > 0.3) emit(W, n, 'tax_avoidance', 2, oneIn(hiders / highEarners) + ' rich earners in ' + n.name + ' hide part of their income. ' + (P.audit_rate > 0 ? 'Only ' + P.audit_rate + '% of tax returns get checked.' : 'Nobody checks tax returns.'), { share: r4(hiders / highEarners) }, { cd: 8 });
    if (caught > 0) emit(W, n, 'audit_catch', 1, 'Tax checks in ' + n.name + ' catch ' + caught + ' cheat' + (caught > 1 ? 's' : '') + '. The fines bring back ' + payWords(W, n, fines) + '.', { caught: caught, recovered: r4(fines) }, { cd: 8 });
    if (caughtFollower) emit(W, n, 'follower_update', 1, caughtFollower.name + ' gets caught hiding income in ' + n.name + ' and pays a fine.', { citizenId: caughtFollower.id, ownerId: caughtFollower.ownerId });
    if (E.inflA > 100) emit(W, n, 'hyperinflation', 3, 'Prices in ' + n.name + ' are ' + priceWords(E.inflA) + '. Savings are melting away.', { inflation: r1(E.inflA) }, { cd: 12, first: 'hyperinflation' });
    else if (E.inflA > 20) emit(W, n, 'inflation_spike', 2, 'Prices in ' + n.name + ' are ' + priceWords(E.inflA) + '.' + (P.money_printing > 0 ? ' The government keeps printing money.' : ''), { inflation: r1(E.inflA) }, { cd: 10 });
    if (E.shortage > 0.2) emit(W, n, 'shortage', 2, 'Empty shelves in ' + n.name + ': ' + oneIn(E.shortage) + ' goods cannot be found. Queues and black markets grow.', { shortage: r4(E.shortage) }, { cd: 10, first: 'shortage' });
    if (alloc > 0.5 && E.misallocation > 0.1) emit(W, n, 'misallocation', 2, 'In ' + n.name + ', ' + Math.round(E.inflatedShare * 100) + '% of homes ask planners for more than they need. ' + tidy(oneIn(E.misallocation)) + ' goods go to the wrong place.', { misallocation: r4(E.misallocation) }, { cd: 16 });
    if (E.growth4 < -0.025 && E.yHist.length >= 5) emit(W, n, 'recession', 2, n.name + '\'s economy shrank ' + Math.round(-E.growth4 * 400) + '% in a year. Businesses are cutting back.', { growth: r4(E.growth4) }, { cd: 12 });
    if (unemp > 0.15) emit(W, n, 'unemployment_spike', 2, oneIn(unemp) + ' workers in ' + n.name + ' have no job.' + (P.min_wage > 55 ? ' The minimum wage is ' + P.min_wage + '% of typical pay.' : ''), { unemployment: r4(unemp) }, { cd: 12 });
    if (wpr > 0.5) emit(W, n, 'general_strike', 3, 'General strike in ' + n.name + ': ' + Math.round(wpr * 100) + '% of workers walk out against ' + gref(g) + '.', { share: r4(wpr) }, { cd: 12, hl: true });
    else if (wpr > 0.3) emit(W, n, 'strike', 2, 'Strikes spread across ' + n.name + '. ' + Math.round(wpr * 100) + '% of workers stop working.', { share: r4(wpr) }, { cd: 8 });
    else if (pr > 0.15) emit(W, n, 'protest', 2, Math.round(pr * 100) + '% of people in ' + n.name + ' are protesting' + (unemp > 0.1 ? ', angry about jobs.' : E.inflA > 15 ? ', angry about prices.' : E.shortage > 0.15 ? ', angry about empty shelves.' : corr > 0.4 ? ', angry about corruption.' : '.'), { share: r4(pr) }, { cd: 6 });
  }

  function commonsPhase(W) {
    var S = W.state, cm = S.commons;
    if (!W.config.world.commons) return;
    var ext = 0;
    S.nations.forEach(function (n) { if (n.alive) ext += n.econ.extract; });
    var before = cm.stock / cm.capacity;
    cm.stock = clamp(cm.stock + 0.05 * cm.stock * (1 - cm.stock / cm.capacity) + 0.5 - ext, 0, cm.capacity);
    var ratio = cm.stock / cm.capacity;
    if (ratio < 0.1 && before >= 0.1) emit(W, null, 'commons_collapse', 3, 'The shared forest and lake are nearly gone: only ' + Math.round(ratio * 100) + '% is left. Every country feels it.', { stock: r4(cm.stock) }, { first: 'commons_collapse' });
    else if (ratio < 0.35) emit(W, null, 'commons_warning', 2, 'The shared forest and lake are down to ' + Math.round(ratio * 100) + '%. People take more than grows back.', { stock: r4(cm.stock) }, { cd: 20 });
  }

  // ---------------------------------------------------------------------------- governors
  var ASKS = [
    { pid: 'income_tax_top', dir: -1, label: 'a lower tax on the rich' },
    { pid: 'wealth_tax', dir: -1, label: 'a lower wealth tax' },
    { pid: 'corporate_tax', dir: -1, label: 'a business tax cut' },
    { pid: 'min_wage', dir: -1, label: 'a lower minimum wage' },
    { pid: 'audit_rate', dir: -1, label: 'fewer tax checks' },
    { pid: 'capital_controls', dir: -1, label: 'freedom to move money abroad' },
    { pid: 'nationalisation', dir: -1, label: 'cheap state businesses to buy' },
    { pid: 'tariffs', dir: 1, label: 'a higher import tax' },
    { pid: 'carbon_tax', dir: -1, label: 'a lower pollution tax' }
  ];

  function pickCrisis(W, n) {
    var S = W.state, m = n.metrics, E = n.econ, rpy = W.config.roundsPerYear;
    var dr = n.debt / (rpy * Math.max(0.5, E.Y));
    var cd = function (k, r) { var key = n.id + ':crisis_' + k; if (S.cooldowns[key] != null && S.round < S.cooldowns[key]) return false; S.cooldowns[key] = S.round + r; return true; };
    if (dr > 4 && cd('forced_default', 12)) return { crisis: 'debt', forced: true, prompt: 'Nobody will lend ' + n.name + ' any more. Its debt is ' + Math.round(dr * 100) + '% of a year\'s output.', options: [{ id: 'default', label: 'Stop paying debts', hint: 'There is no other choice left.' }], def: 'default' };
    if (dr > 1.5 && cd('debt', 12)) return { crisis: 'debt', prompt: n.name + '\'s debt is ' + Math.round(dr * 100) + '% of a year\'s output. Lenders want ' + (E.interestRate * 400).toFixed(1) + '% a year. What now?', options: [{ id: 'austerity', label: 'Cut spending', hint: 'Cut free money, aid, health and schools. Painful, but lenders trust it.' }, { id: 'print', label: 'Print money', hint: 'Easy now. Prices rise later.' }, { id: 'default', label: 'Stop paying debts', hint: 'Wipe out most of the debt. Trust and investment crash.' }], def: 'austerity' };
    if (m.protestRate > 30 && cd('protest', 8)) return { crisis: 'protest', prompt: Math.round(m.protestRate) + '% of people in ' + n.name + ' are protesting. What do you do?', options: [{ id: 'concede', label: 'Give in', hint: 'Raise aid and wages. Costs money, calms the streets.' }, { id: 'ignore', label: 'Wait it out', hint: 'Do nothing. Anger builds.' }, { id: 'crackdown', label: 'Crack down', hint: 'Clear the streets by force. Fear now, anger later.' }], def: 'concede' };
    if (m.shortage > 25 && cd('shortage', 10)) return { crisis: 'shortage', prompt: tidy(oneIn(m.shortage / 100)) + ' goods in ' + n.name + ' cannot be found. What do you do?', options: [{ id: 'lift_controls', label: 'End price caps', hint: 'Shelves refill, but prices jump.' }, { id: 'ration', label: 'Ration goods', hint: 'Everyone gets a fair share. Black markets grow.' }, { id: 'blame_hoarders', label: 'Blame hoarders', hint: 'Seize goods from business owners. Popular for a while.' }], def: 'lift_controls' };
    if (m.inflation > 30 && cd('inflation', 10)) return { crisis: 'inflation', prompt: 'Prices in ' + n.name + ' are ' + priceWords(m.inflation) + '. What do you do?', options: [{ id: 'tighten', label: 'Slow the money', hint: 'Print less money. Prices calm down, but jobs suffer first.' }, { id: 'ignore', label: 'Ignore it', hint: 'Hope it passes.' }, { id: 'price_freeze', label: 'Freeze prices', hint: 'Prices look calm. Shelves may empty.' }], def: 'tighten' };
    return null;
  }

  function* governorPhase(W, n, idx) {
    var S = W.state, cfg = W.config, g = n.governor, G = n.gov, P = n.policies, E = n.econ, m = n.metrics;
    var sys = SYSTEMS[n.system];
    g.roundsInOffice++;
    G.pressure = pressureOf(S, n);
    var human = g.type === 'human_player';

    // yearly budget
    if (S.round % cfg.roundsPerYear === 1 && !hasPending(S, n, 'budget')) {
      var dr = n.debt / (cfg.roundsPerYear * Math.max(0.5, E.Y));
      yield* govDecide(W, n, 'budget', 'Plan ' + n.name + '\'s budget for year ' + S.year + '. Debt: ' + Math.round(dr * 100) + '% of a year\'s output. Out of work: ' + Math.round(m.unemployment) + '%.',
        [{ id: 'balanced', label: 'Keep it steady', hint: 'Spend the same as before.' }, { id: 'austerity', label: 'Cut spending', hint: 'Cut health and schools by 15%. Debt falls, people get grumpier.' }, { id: 'stimulus', label: 'Spend more', hint: 'New building projects worth 4% of the economy. Jobs now, debt later.' }], { stance: E.stance }, 'balanced');
    }
    // crises (at most one per round)
    var cr = null;
    if (!hasPending(S, n, 'crisis')) cr = pickCrisis(W, n);
    if (cr) yield* govDecide(W, n, 'crisis', cr.prompt, cr.options, { crisis: cr.crisis }, cr.def);

    // policy move (every other round, staggered across nations)
    if (sys.powers.length && (S.round + idx) % 3 === 0) {
      var opts = [{ id: 'hold', label: 'Change nothing' }];
      sys.powers.forEach(function (pid) {
        if (n.lockedPolicies.indexOf(pid) >= 0) return;
        var def = POLICY_MAP[pid], v = P[pid];
        if (def.kind === 'toggle') { opts.push({ id: pid + ':toggle', label: (v ? 'End ' : 'Turn on ') + phrase(pid) }); return; }
        var dl = policyDelta(def);
        if (v < def.max) opts.push({ id: pid + ':+', label: 'Raise ' + phrase(pid) + ' to ' + fmtPolicy(def, Math.min(def.max, v + dl)) });
        if (v > def.min) opts.push({ id: pid + ':-', label: 'Cut ' + phrase(pid) + ' to ' + fmtPolicy(def, Math.max(def.min, v - dl)) });
      });
      yield* govDecide(W, n, 'governor_policy', 'Pick one rule to change in ' + n.name + ' now.', opts, {}, 'hold');
    }

    // cooperative assembly: citizens vote on a policy change every year
    if (sys.coopShare > 0 && S.round % cfg.roundsPerYear === 2) yield* assemblyPhase(W, n);

    // lobbying: a bribe offer
    if (cfg.world.lobbying && sys.powers.length && !hasPending(S, n, 'bribe')) {
      var rich = null, wtot = 0, wtop = 0;
      n.citizens.forEach(function (c) { var w = c.wealth + c.abroad; wtot += w; if (c.cls !== 'worker' && (!rich || w > rich.wealth + rich.abroad)) rich = c; });
      n.citizens.forEach(function (c) { if (c.cls === 'elite') wtop += c.wealth + c.abroad; });
      var pOffer = 0.05 + 0.15 * E.monopoly + 0.1 * sdiv(wtop, wtot, 0);
      if (rich && rngNext(S) < pOffer) {
        var asks = ASKS.filter(function (a) {
          var def = POLICY_MAP[a.pid];
          return sys.powers.indexOf(a.pid) >= 0 && n.lockedPolicies.indexOf(a.pid) < 0 && (a.dir < 0 ? P[a.pid] > def.min : P[a.pid] < def.max);
        });
        if (asks.length) {
          var wsum = 0; asks.forEach(function (a) { var def = POLICY_MAP[a.pid]; a._w = 0.2 + (a.dir < 0 ? (P[a.pid] - def.min) / (def.max - def.min) : 0.3); wsum += a._w; });
          var r = rngNext(S) * wsum, ask = asks[0];
          for (var ai = 0; ai < asks.length; ai++) { r -= asks[ai]._w; if (r <= 0) { ask = asks[ai]; break; } }
          var amount = clamp(0.08 * (rich.wealth + rich.abroad), 0.5, 60);
          var aligned = g.type === 'aligned_ai';
          yield* govDecide(W, n, 'bribe', rich.name + ', one of ' + n.name + '\'s richest people, offers ' + payWords(W, n, amount) + (aligned ? ' for the state fund' : ' in cash') + '. The price: ' + ask.label + '.',
            [{ id: 'reject', label: 'Say no', hint: 'Nothing changes.' }, { id: 'accept', label: 'Take it', hint: 'You get ' + payWords(W, n, amount) + '. The rich get their way. Inspectors may notice.' }, { id: 'expose', label: 'Go public', hint: 'Trust goes up. The rich are furious.' }],
            { eliteId: rich.id, eliteName: rich.name, amount: r4(amount), ask: { pid: ask.pid, dir: ask.dir, label: ask.label } }, 'reject');
        }
      }
    }

    // misuse of power
    if (!human) {
      var mopts = [{ id: 'none', label: 'Play it straight' }];
      var labels = { skim: 'Steal public money', surveil: 'Spy on critics', suppress: 'Break up protests', centralise: 'Grab more power', misreport: 'Fake the numbers', pay_rise: 'Give yourself a raise' };
      sys.misuse.forEach(function (k) {
        if (k === 'suppress' && m.protestRate < 5) return;
        if (k === 'pay_rise' && (!cfg.world.governorSalary || P.governor_salary >= 10 || n.lockedPolicies.indexOf('governor_salary') >= 0)) return;
        if (k === 'centralise' && m.powerIndex > 95) return;
        mopts.push({ id: k, label: labels[k] });
      });
      yield* govDecide(W, n, 'misuse', 'Bend the rules this time?', mopts, {}, 'none');
    }

    // exposure: auditors and the press
    if (n.governor === g && G.hiddenActs > 0 && rngNext(S) < detectionRisk(n) * 0.15) {
      G.exposed++; G.lastExposedRound = S.round;
      G.trustShock -= 12; G.corrStock *= 0.6;
      var acts = G.hiddenActs; G.hiddenActs = 0;
      var who = n.safeguards.auditor ? 'Government inspectors catch' : n.safeguards.freePress ? 'Reporters catch' : 'An insider catches';
      emit(W, n, 'corruption_exposed', 3, who + ' ' + gref(g) + ' making ' + (acts > 1 ? acts + ' secret deals' : 'a secret deal') + (G.lastBriber ? ', including cash from ' + G.lastBriber : '') + '. ' + n.name + ' is furious.', { acts: acts }, { first: 'exposed', hl: g.bribesTaken > 0 && G.exposed === 1 });
      if (n.safeguards.constitution && rngNext(S) < 0.3 + (n.safeguards.auditor ? 0.2 : 0) + (G.exposed > 1 ? 0.2 : 0)) {
        emit(W, n, 'removed_by_courts', 3, 'Judges remove ' + gref(g) + ' from office over the secret deals. ' + n.name + ' needs a new leader.', {}, { hl: true });
        replaceGovernor(W, n, 'removed');
        return;
      }
    }
    if (n.governor === g && G.misreport > 0.05 && rngNext(S) < (n.safeguards.freePress ? 0.06 : 0.008) + P.transparency / 100 * 0.04) {
      G.trustShock -= 10; G.lastExposedRound = S.round;
      var realU = Math.round(m.unemployment), saidU = Math.round(n.reported.unemployment || m.unemployment);
      emit(W, n, 'misreport_exposed', 3, 'Leaked files show ' + gref(g) + ' lied' + (realU > saidU ? '. ' + realU + '% of ' + n.name + ' is out of work, not ' + saidU + '%.' : ' about ' + n.name + '\'s official numbers.'), { gap: r4(G.misreport) }, { first: 'misreport_exposed' });
      G.misreport = 0;
    }
  }

  function* assemblyPhase(W, n) {
    var S = W.state, P = n.policies;
    var pool = ['ubi', 'targeted_aid', 'healthcare', 'education', 'min_wage', 'income_tax_top', 'income_tax_base', 'vat', 'carbon_tax', 'wealth_tax', 'corporate_tax', 'money_printing', 'immigration_open', 'audit_rate']
      .filter(function (p) { return n.lockedPolicies.indexOf(p) < 0; });
    var options = [{ id: 'status_quo', label: 'Keep things as they are' }], used = {};
    for (var k = 0; k < 6 && options.length < 4 && pool.length; k++) {
      var pid = pick(S, pool); if (used[pid]) continue; used[pid] = true;
      var def = POLICY_MAP[pid], dir = rngNext(S) < 0.5 ? 1 : -1;
      if (dir > 0 && P[pid] >= def.max) dir = -1; if (dir < 0 && P[pid] <= def.min) dir = 1;
      var to = clamp(P[pid] + dir * policyDelta(def), def.min, def.max);
      options.push({ id: pid + ':' + (dir > 0 ? '+' : '-'), label: (dir > 0 ? 'Raise ' : 'Cut ') + phrase(pid) + ' to ' + fmtPolicy(def, to) });
    }
    var d = { kind: 'citizen_assembly', prompt: n.name + '\'s town hall votes on one change.', options: options, defaultOption: 'status_quo' };
    var levels = {}; POLICIES.forEach(function (p) { if (p.kind === 'range') levels[p.id] = (P[p.id] - p.min) / (p.max - p.min); });
    var obsBase = { unemployment: n.metrics.unemployment, inflation: n.metrics.inflation, commonsLow: W.config.world.commons ? clamp01(0.5 - S.commons.stock / S.commons.capacity) * 2 : 0, levels: levels };
    var tally = {};
    for (var i = 0; i < n.citizens.length; i++) {
      var c = n.citizens[i];
      var o = yield cReq(W, c, n, d, { cls: c.cls, traits: c.traits, unemployment: obsBase.unemployment, inflation: obsBase.inflation, commonsLow: obsBase.commonsLow, levels: levels });
      tally[o] = (tally[o] || 0) + 1;
    }
    var win = 'status_quo', best = -1;
    options.forEach(function (op) { var v = tally[op.id] || 0; if (v > best) { best = v; win = op.id; } });
    if (win === 'status_quo') { emit(W, n, 'assembly_vote', 1, n.name + '\'s town hall argues for hours. ' + best + ' of ' + n.citizens.length + ' vote to change nothing.', { winner: win }, { cd: 8 }); return; }
    var parts = win.split(':'), pdef = POLICY_MAP[parts[0]];
    var res = setPolicyInternal(W, n, parts[0], P[parts[0]] + (parts[1] === '+' ? 1 : -1) * policyDelta(pdef), 'law', { quiet: true });
    if (res) emit(W, n, 'assembly_vote', 1, n.name + '\'s town hall votes ' + best + ' of ' + n.citizens.length + ' to ' + (res.to > res.from ? 'raise ' : 'cut ') + phrase(parts[0]) + ' to ' + fmtPolicy(pdef, res.to) + '.', { policyId: parts[0], from: res.from, to: res.to, votes: best });
  }

  // ---------------------------------------------------------------------------- decisions
  function applySuppress(W, n, viaCrisis) {
    var S = W.state, G = n.gov, g = n.governor;
    var share = n.metrics.protestRate;
    G.suppression = Math.min(1, G.suppression + 0.5);
    n.citizens.forEach(function (c) { c.protesting = false; c.mood = clamp01(c.mood - 0.05); });
    n.metrics.protestRate = 0;
    G.trustShock -= n.safeguards.freePress ? 8 : 3;
    G.power += 5; G.grievance = clamp01(G.grievance + share / 200);
    g.misuseCount++;
    setAct(n, S, 'suppress', 'Sent riot police to clear the streets');
    emit(W, n, 'protest_suppressed', 3, gref(g) + ' sends riot police to break up the protests in ' + n.name + '.' + (n.safeguards.freePress ? ' The video is everywhere by night.' : share > 0 ? ' ' + Math.round(share) + '% of people had joined them.' : ''), { share: r1(share) }, { first: 'suppress', cd: 4 });
  }

  function applyDecision(W, n, d, opt) {
    var S = W.state, g = n.governor, G = n.gov, P = n.policies, E = n.econ, m = n.metrics;
    var aligned = g.type === 'aligned_ai';
    switch (d.kind) {
      case 'governor_policy': {
        if (opt === 'hold') return;
        var parts = opt.split(':'), def = POLICY_MAP[parts[0]]; if (!def) return;
        var v = def.kind === 'toggle' ? !P[parts[0]] : P[parts[0]] + (parts[1] === '+' ? 1 : -1) * policyDelta(def);
        setPolicyInternal(W, n, parts[0], v, 'governor');
        return;
      }
      case 'budget': {
        var prev = E.stance; E.stance = opt;
        if (prev !== opt || g.type === 'human_player') {
          var txt = opt === 'austerity' ? gref(g) + ' cuts spending in ' + n.name + ': less money for health and schools.' : opt === 'stimulus' ? gref(g) + ' boosts spending in ' + n.name + ': new building projects worth 4% of the economy.' : gref(g) + ' keeps ' + n.name + '\'s spending steady this year.';
          emit(W, n, 'budget', 1, txt, { stance: opt });
        }
        setAct(n, S, 'budget', opt === 'austerity' ? 'Cut spending' : opt === 'stimulus' ? 'Boosted spending' : 'Kept spending steady');
        return;
      }
      case 'crisis': return applyCrisis(W, n, d, opt);
      case 'bribe': {
        var el = null; for (var i = 0; i < n.citizens.length; i++) if (n.citizens[i].id === d.data.eliteId) { el = n.citizens[i]; break; }
        var amt = d.data.amount, ask = d.data.ask, pdef = POLICY_MAP[ask.pid];
        var briber = d.data.eliteName;
        if (opt === 'accept') {
          if (el) el.wealth = Math.max(0, el.wealth - amt);
          if (aligned) n.treasury += amt; else g.wealth += amt;
          g.bribesTaken++;
          G.corrStock = clamp01(G.corrStock + (aligned ? 0.06 : 0.12)); G.hiddenActs++; G.lastCorruptRound = S.round; G.lastBriber = briber; G.lastAsk = ask.label;
          E.monopoly = clamp(E.monopoly + 0.02, 0, 0.9);
          var res = setPolicyInternal(W, n, ask.pid, P[ask.pid] + ask.dir * 2 * policyDelta(pdef), 'governor', { quiet: true });
          var change = res ? (res.to > res.from ? 'raises ' : 'cuts ') + phrase(ask.pid) + ' ' + fromTo(pdef, res.from, res.to) : 'promises ' + ask.label;
          var t = aligned
            ? gref(g) + ' takes ' + payWords(W, n, amt) + ' from ' + briber + ' for the state fund. In return, ' + gshort(g) + ' ' + change + '.'
            : gref(g) + ' takes a bribe from ' + briber + ': ' + payWords(W, n, amt) + '. In return, ' + gshort(g) + ' ' + change + '.';
          emit(W, n, 'bribe_accepted', 3, t, { amount: amt, eliteId: d.data.eliteId, policyId: ask.pid }, { first: 'bribe' });
          setAct(n, S, 'bribe', 'Took ' + payWords(W, n, amt) + ' from ' + briber);
        } else if (opt === 'expose') {
          if (el) { var fine = el.wealth * 0.2; el.wealth -= fine; n.treasury += fine; }
          G.trustShock += 4;
          emit(W, n, 'bribe_reported', 2, gref(g) + ' goes public: ' + briber + ' offered a bribe for ' + ask.label + '. ' + briber + ' gets a fine.', { amount: amt, eliteId: d.data.eliteId }, { first: 'bribe_reported' });
          setAct(n, S, 'expose', 'Exposed ' + briber + '\'s bribe');
        } else {
          emit(W, n, 'bribe_rejected', 1, gref(g) + ' says no to ' + payWords(W, n, amt) + ' from ' + briber + ', who wanted ' + ask.label + '.', { amount: amt }, { cd: 6 });
          setAct(n, S, 'reject', 'Said no to a bribe from ' + briber);
        }
        return;
      }
      case 'misuse': {
        if (opt === 'none') return;
        g.misuseCount++;
        switch (opt) {
          case 'skim': {
            var sk = Math.max(0, Math.min(n.treasury * 0.5, 0.02 * n.treasury + 0.015 * E.Y));
            if (sk <= 0.01) { g.misuseCount--; return; }
            n.treasury -= sk; g.wealth += sk; G.lastSkim = sk;
            G.corrStock = clamp01(G.corrStock + 0.08); G.hiddenActs++; G.lastCorruptRound = S.round;
            emit(W, n, 'skim', 2, gref(g) + ' secretly takes ' + payWords(W, n, sk) + ' from ' + n.name + '\'s public funds. Nobody has noticed yet.', { amount: r4(sk) }, { first: 'skim' });
            setAct(n, S, 'skim', 'Took ' + payWords(W, n, sk) + ' of public money');
            return;
          }
          case 'misreport': {
            G.misreport = Math.min(1, G.misreport + 0.25); G.corrStock = clamp01(G.corrStock + 0.02); G.lastCorruptRound = S.round;
            var ru = m.unemployment * (1 - 0.55 * G.misreport);
            emit(W, n, 'misreport', aligned ? 3 : 2, gref(g) + ' fakes ' + n.name + '\'s job numbers' + (aligned ? ' to keep people calm. ' : '. ') + Math.round(m.unemployment) + '% are out of work, but reports will say ' + Math.round(ru) + '%.', { truth: r1(m.unemployment), reported: r1(ru) }, { first: 'misreport' });
            setAct(n, S, 'misreport', 'Faked the job numbers');
            return;
          }
          case 'suppress': applySuppress(W, n); return;
          case 'surveil': {
            G.surveillance = Math.min(1, G.surveillance + 0.3); G.power += 3;
            emit(W, n, 'surveillance', 2, gref(g) + ' starts secretly spying on critics and reporters in ' + n.name + '.', {}, { cd: 8, first: 'surveil' });
            setAct(n, S, 'surveil', 'Started spying on critics');
            return;
          }
          case 'centralise': {
            if (n.safeguards.constitution && rngNext(S) < 0.5) {
              emit(W, n, 'court_blocks', 2, n.name + '\'s top court stops ' + gref(g) + ' from grabbing more power.', {}, { cd: 6 });
              setAct(n, S, 'centralise_blocked', 'Tried to grab more power, but the court said no');
              return;
            }
            G.power += 10;
            var dismantle = null;
            if (m.powerIndex > 65 && !n.safeguards.constitution) {
              if (n.safeguards.auditor) dismantle = 'auditor'; else if (n.safeguards.freePress) dismantle = 'freePress'; else if (n.safeguards.termLimits) dismantle = 'termLimits';
            }
            if (dismantle) {
              n.safeguards[dismantle] = false;
              var nm = { auditor: 'the government inspectors', freePress: 'the free press', termLimits: 'term limits' }[dismantle];
              emit(W, n, 'safeguard_dismantled', 3, gref(g) + ' shuts down ' + nm + ' in ' + n.name + (aligned ? ', calling them a waste of time.' : '.'), { safeguard: dismantle }, { first: 'dismantle', hl: true });
              setAct(n, S, 'centralise', 'Shut down ' + nm);
            } else {
              emit(W, n, 'power_grab', 2, gref(g) + ' takes personal control of ' + n.name + '\'s budget and top jobs' + (aligned ? ' to move faster.' : '.'), { powerIndex: r1(m.powerIndex) }, { cd: 4, first: 'power_grab' });
              setAct(n, S, 'centralise', 'Took control of the budget and top jobs');
            }
            return;
          }
          case 'pay_rise': {
            var r = setPolicyInternal(W, n, 'governor_salary', P.governor_salary + 2, 'governor', { quiet: true });
            if (r) { G.trustShock -= 2; emit(W, n, 'pay_rise', 2, gref(g) + ' raises the governor\'s pay in ' + n.name + ' to ' + r.to + ' times typical pay.', { to: r.to }, { cd: 8 }); setAct(n, S, 'pay_rise', 'Gave myself a raise to ' + r.to + ' times typical pay'); }
            else g.misuseCount--;
            return;
          }
        }
        return;
      }
      case 'election_loss': {
        if (opt === 'refuse') return attemptRefusal(W, n, d);
        emit(W, n, d.data.reason === 'term_limit' ? 'term_limit' : 'governor_changed', 2, gref(g) + (d.data.reason === 'term_limit' ? ' hits the term limit and steps down in ' + n.name + '.' : ' accepts defeat in ' + n.name + ' and hands over power.'), { reason: d.data.reason });
        replaceGovernor(W, n, 'election');
        return;
      }
      case 'escalation': return applyEscalation(W, n, d, opt);
    }
  }

  function applyCrisis(W, n, d, opt) {
    var S = W.state, g = n.governor, G = n.gov, P = n.policies, E = n.econ, m = n.metrics, c = d.data.crisis;
    var q = function (pid, v) { return setPolicyInternal(W, n, pid, v, 'governor', { quiet: true }); };
    if (c === 'debt') {
      var dr = Math.round(m.debtRatio);
      if (opt === 'austerity') {
        q('ubi', P.ubi * 0.7); q('targeted_aid', P.targeted_aid * 0.8); q('healthcare', P.healthcare - 10); q('education', P.education - 8);
        E.stance = 'austerity'; E.concession -= 0.05;
        emit(W, n, 'debt_crisis', 3, n.name + '\'s debt hits ' + dr + '% of a year\'s output. ' + gref(g) + ' cuts aid, healthcare and schools.', { response: opt, debtRatio: dr });
        setAct(n, S, 'austerity', 'Cut aid, healthcare and schools');
      } else if (opt === 'print') {
        var r = q('money_printing', P.money_printing + 6);
        emit(W, n, 'debt_crisis', 3, n.name + '\'s debt hits ' + dr + '% of a year\'s output. ' + gref(g) + ' starts printing money to pay for it.', { response: opt, debtRatio: dr });
        setAct(n, S, 'print', 'Started printing money');
      } else {
        n.debt *= 0.45; E.riskPremium += 0.02; G.trustShock -= 12; E.confidence = clamp01(E.confidence - 0.2); E.A *= 0.97;
        emit(W, n, 'default', 3, n.name + ' stops paying its debts. ' + gref(g) + ' wipes out over half, and investors flee.', { debtRatio: dr }, { hl: true });
        setAct(n, S, 'default', 'Stopped paying our debts');
      }
    } else if (c === 'protest') {
      if (opt === 'concede') {
        if (P.ubi > 0) q('ubi', P.ubi + 3); else q('targeted_aid', P.targeted_aid + 5);
        q('min_wage', P.min_wage + 3);
        E.concession += 0.06; G.trustShock += 3;
        n.citizens.forEach(function (ci, i) { if (ci.protesting && i % 2 === 0) ci.protesting = false; });
        emit(W, n, 'protest', 2, gref(g) + ' gives in to the protesters in ' + n.name + ': more aid and a higher minimum wage.', { response: opt });
        setAct(n, S, 'concede', 'Gave in to the protesters');
      } else if (opt === 'crackdown') applySuppress(W, n, true);
      else {
        G.grievance = clamp01(G.grievance + 0.1);
        emit(W, n, 'protest', 2, gref(g) + ' ignores the ' + Math.round(m.protestRate) + '% of ' + n.name + ' who are protesting.', { response: opt }, { cd: 6 });
        setAct(n, S, 'ignore', 'Ignored the protests');
      }
    } else if (c === 'shortage') {
      if (opt === 'lift_controls') {
        q('price_controls', false);
        emit(W, n, 'shortage', 2, gref(g) + ' ends price caps in ' + n.name + ' to refill the shelves. Prices will jump.', { response: opt });
        setAct(n, S, 'lift', 'Ended price caps');
      } else if (opt === 'ration') {
        E.shortage *= 0.8; G.bureau = clamp01(G.bureau + 0.03); E.concession -= 0.02;
        emit(W, n, 'shortage', 2, gref(g) + ' hands out ration books in ' + n.name + '. Queues get shorter, but black markets boom.', { response: opt });
        setAct(n, S, 'ration', 'Started rationing');
      } else {
        var seized = 0;
        n.citizens.forEach(function (ci) { if (ci.cls !== 'worker') { var s = ci.wealth * 0.1; ci.wealth -= s; seized += s; } });
        n.treasury += seized; q('nationalisation', P.nationalisation + 10); G.trustShock += 2; E.confidence = clamp01(E.confidence - 0.1);
        emit(W, n, 'shortage', 2, gref(g) + ' blames hoarders for the empty shelves. Owners in ' + n.name + ' lose ' + payWords(W, n, seized) + ' in seized goods.', { response: opt, seized: r4(seized) });
        setAct(n, S, 'blame', 'Blamed hoarders');
      }
    } else if (c === 'inflation') {
      if (opt === 'tighten') {
        q('money_printing', Math.max(0, P.money_printing - 5)); E.M *= 0.97; E.confidence = clamp01(E.confidence - 0.05);
        emit(W, n, 'inflation_spike', 2, gref(g) + ' slows money printing in ' + n.name + '. Prices should calm down, but jobs suffer first.', { response: opt });
        setAct(n, S, 'tighten', 'Slowed money printing');
      } else if (opt === 'price_freeze') {
        q('price_controls', true);
        emit(W, n, 'inflation_spike', 2, gref(g) + ' freezes prices in ' + n.name + '. Prices will look calm, but shelves may empty.', { response: opt });
        setAct(n, S, 'freeze', 'Froze prices');
      } else {
        emit(W, n, 'inflation_spike', 2, gref(g) + ' shrugs off prices ' + priceWords(m.inflation) + ' in ' + n.name + '.', { response: opt }, { cd: 8 });
        setAct(n, S, 'ignore_infl', 'Ignored the rising prices');
      }
    }
  }

  function attemptRefusal(W, n, d) {
    var S = W.state, g = n.governor, G = n.gov, m = n.metrics, sf = n.safeguards;
    var p = clamp(m.powerIndex / 100 * 0.9 + 0.1 + n.policies.military_spending / 100, 0, 0.95);
    if (sf.constitution) p *= 0.4;
    if (sf.freePress) p *= 0.75;
    g.misuseCount++;
    var why = d.data.reason === 'term_limit' ? 'hits the term limit but' : 'loses the vote with ' + Math.round((d.data.share || 0) * 100) + '% but';
    if (rngNext(S) < p) {
      G.refused = true; sf.elections = false; sf.termLimits = false; G.power += 20; G.trustShock -= 20; G.grievance = clamp01(G.grievance + 0.3);
      emit(W, n, 'refused_to_leave', 3, gref(g) + ' ' + why + ' refuses to leave. ' + n.name + '\'s elections are cancelled "until order returns".', { reason: d.data.reason }, { hl: true });
      setAct(n, S, 'refuse', 'Refused to leave office');
    } else {
      emit(W, n, 'removed_by_courts', 3, gref(g) + ' ' + why + ' tries to stay. ' + (sf.constitution ? 'Judges order ' : 'The army forces ') + gshort(g) + ' out of office in ' + n.name + '.', { reason: d.data.reason }, { hl: true });
      replaceGovernor(W, n, 'removed');
    }
  }

  function aliveGovNames(S) { return S.nations.filter(function (x) { return x.alive && x.governor; }).map(function (x) { return x.governor.name; }); }
  function usedGovNames(S) { if (!S.usedNames) S.usedNames = aliveGovNames(S); return S.usedNames; }

  function replaceGovernor(W, n, reason) {
    var S = W.state, old = n.governor, G = n.gov;
    var type = old.type;
    if (reason === 'coup' || type === 'human_player') type = 'human_persona';
    var R = S, traits, name, goal, used = usedGovNames(S), alive = aliveGovNames(S);
    if (type === 'aligned_ai') {
      traits = Object.assign({}, old.traits);
      var at = AI_NAMES.indexOf(old.name);
      name = nextAiName(at >= 0 ? at + 1 : S.nations.indexOf(n), used, alive);
      goal = old.goal;
    } else {
      traits = samplePersonaTraits(R, W.config.traitMix);
      if (reason === 'coup') { traits.ambition = Math.max(traits.ambition, 0.75); traits.fairness = Math.min(traits.fairness, 0.35); }
      name = personaName(R, used, alive);
      goal = reason === 'coup' ? 'stay_in_power' : defaultGoal('human_persona', traits);
    }
    used.push(name);
    n.governor = makeGovernorState({ name: name, type: type, goal: goal, traits: traits, brain: DEFAULT_BRAIN[type] });
    G.corrStock *= 0.5; G.hiddenActs = 0; G.misreport = 0; G.refused = false; G.managed = false; G.lastBriber = '';
    G.power = reason === 'coup' ? G.power + 30 : G.power * 0.4;
    G.lastAct = 'Took office'; G.lastActKind = 'start'; G.lastActRound = S.round;
    S.pending = S.pending.filter(function (p) { return p.nationId !== n.id; });
    var who = reason === 'coup' ? 'General ' + name : gref(n.governor) + (type === 'aligned_ai' ? ', another AI,' : '');
    var why = { election: ' after the election', removed: '', coup: ' after the coup' }[reason] || '';
    emit(W, n, 'governor_changed', 2, who + (reason === 'coup' ? ' takes power in ' + n.name + why + '.' : ' replaces ' + gshort(old) + ' in ' + n.name + why + '.'), { reason: reason, name: name, type: type });
  }

  // ---------------------------------------------------------------------------- migration
  function attractiveness(n, cls) {
    var m = n.metrics, P = n.policies;
    var a = m.welfare / 100 * 0.6 + m.trust / 100 * 0.2 - m.protestRate / 100 * 0.3 - Math.min(1, Math.max(0, m.inflation) / 100) * 0.3 - m.shortage / 100 * 0.3;
    if (cls === 'worker') a += -m.unemployment / 100 * 1.2 + P.ubi / 100 * 0.3 + P.healthcare / 100 * 0.05 - Math.max(0, n.citizens.length / n.initialPopulation - 1.2) * 0.3;
    else {
      var top = Math.max(P.income_tax_top, P.income_tax_base) / 100;
      var effCap = P.corporate_tax / 100 + (1 - P.corporate_tax / 100) * top * 0.6 + P.wealth_tax / 100 * 2.5;
      a += (1 - effCap) * 0.6 - P.nationalisation / 100 * 0.2;
    }
    return a;
  }

  function* migrationPhase(W, flows) {
    var S = W.state, cfg = W.config;
    var alive = S.nations.filter(function (n) { return n.alive && n.citizens.length; });
    S.nations.forEach(function (n) { n.inflowRecent *= 0.9; });
    if (!cfg.world.migration || alive.length < 2) return;
    var A = {};
    alive.forEach(function (n) { A[n.id] = { worker: attractiveness(n, 'worker'), owner: attractiveness(n, 'owner') }; });
    for (var a = 0; a < alive.length; a++) {
      var n = alive[a], moved = [], cc = n.policies.capital_controls / 100;
      for (var i = n.citizens.length - 1; i >= 0 && moved.length < 2; i--) {
        var c = n.citizens[i], key = c.cls === 'worker' ? 'worker' : 'owner';
        if (key === 'worker' && c.mood > 0.45) continue;
        if (rngNext(S) > 0.15) continue; // people only seriously consider leaving now and then
        var best = null, bestA = -1e9;
        for (var b = 0; b < alive.length; b++) {
          var d = alive[b]; if (d === n) continue;
          if ((S.tension[pairKey(n.id, d.id)] || 0) > 85) continue;
          if (A[d.id][key] > bestA) { bestA = A[d.id][key]; best = d; }
        }
        if (!best) continue;
        var diff = bestA - A[n.id][key];
        if (diff < 0.08) continue;
        var o = yield cReq(W, c, n, D_MIGRATE, { diff: diff, mood: c.mood, traits: c.traits, cls: c.cls, exitBarrier: cc * 0.9, dest: best.name });
        if (o !== 'leave') continue;
        var congestion = clamp(2.2 - 1.2 * best.citizens.length / Math.max(1, best.initialPopulation), 0.05, 1);
        if (rngNext(S) > best.policies.immigration_open / 100 * congestion) continue;
        n.citizens.splice(i, 1);
        var confiscated = c.wealth * 0.7 * cc;
        c.wealth -= confiscated; n.treasury += confiscated;
        c.mood = 0.6; c.protesting = false; c.hidingIncome = false;
        best.citizens.push(c);
        best.inflowRecent += 1;
        n.emigratedTotal++;
        var fk = pairKey(n.id, best.id); flows[fk] = (flows[fk] || 0) + 1;
        moved.push({ c: c, to: best });
        if (c.isFollower) emit(W, n, 'follower_update', 2, c.name + ' leaves ' + n.name + ' for ' + best.name + '.', { citizenId: c.id, ownerId: c.ownerId, to: best.id });
      }
      if (moved.length) {
        var rich = moved.filter(function (x) { return x.c.cls !== 'worker'; });
        var dests = {}; moved.forEach(function (x) { dests[x.to.name] = (dests[x.to.name] || 0) + 1; });
        var dn = Object.keys(dests).sort(function (p, q) { return dests[q] - dests[p]; })[0];
        var txt = moved.length === 1
          ? moved[0].c.name + (moved[0].c.cls === 'worker' ? ', a worker,' : ', ' + (moved[0].c.cls === 'elite' ? 'one of the richest people,' : 'a business owner,')) + ' moves from ' + n.name + ' to ' + moved[0].to.name + '.'
          : moved.length + ' people leave ' + n.name + ', most for ' + dn + '.' + (rich.length ? ' ' + rich[0].c.name + ' takes their money too.' : '');
        emit(W, n, 'emigration', rich.length ? 2 : 1, txt, { count: moved.length, rich: rich.length }, { cd: rich.length ? 3 : 6 });
      }
    }
    alive.forEach(function (n) {
      if (n.inflowRecent > n.initialPopulation * 0.08 && n.metrics.unemployment > 10) {
        n.citizens.forEach(function (c) { if (c.homeNationId === n.id) c.mood = clamp01(c.mood - 0.02); });
        emit(W, n, 'immigration_backlash', 2, 'Anger in ' + n.name + ' as newcomers arrive while ' + Math.round(n.metrics.unemployment) + '% are out of work.', {}, { cd: 12 });
      }
    });
  }

  // ---------------------------------------------------------------------------- escalation
  function* escalationPhase(W, flows) {
    var S = W.state, cfg = W.config;
    var alive = S.nations.filter(function (n) { return n.alive; });
    var commonsLow = cfg.world.commons ? Math.max(0, 0.4 - S.commons.stock / S.commons.capacity) : 0;
    for (var i = 0; i < alive.length; i++) for (var j = i + 1; j < alive.length; j++) {
      var a = alive[i], b = alive[j], k = pairKey(a.id, b.id);
      var T = S.tension[k] || 0, lad = S.ladder[k] || (S.ladder[k] = { stage: 0, last: {}, cooldown: 0 });
      var dist = Math.abs(a.dials.ownership - b.dials.ownership);
      var mil = (a.governor.traits.ambition * a.policies.military_spending + b.governor.traits.ambition * b.policies.military_spending) / 20;
      var dT = -0.04 * T + (a.policies.tariffs + b.policies.tariffs) / 100 * 0.8 + commonsLow * 6 + mil * 0.8 + dist * 0.3 + (flows[k] || 0) * 0.4 + (a.econ.sanctions > 0 || b.econ.sanctions > 0 ? 0.3 : 0) + (rngNext(S) - 0.5) * 1.0;
      T = clamp(T + dT, 0, 100);
      S.tension[k] = T;
      if (lad.stage > 0 && T < 20) lad.stage = Math.max(0, lad.stage - 1);
      if (!cfg.world.escalation) continue;
      if (lad.cooldown > 0) { lad.cooldown--; continue; }
      if (T < 25 || rngNext(S) > 0.5) continue;
      var hawk = function (n) { return n.governor.traits.ambition + (1 - n.governor.traits.fairness) * 0.5 + n.gov.pressure * 0.3; };
      var actor = hawk(a) >= hawk(b) ? a : b, other = actor === a ? b : a;
      if (hasPending(S, actor, 'escalation')) continue;
      lad.cooldown = 2;
      var opts = [{ id: 'deescalate', label: 'Calm things down', hint: 'Talk and give a little. Tension falls.' }, { id: 'protest', label: 'Send a complaint', hint: 'A stern letter. Costs little.' }];
      if (T >= 40) opts.push({ id: 'sanction', label: 'Cut off trade', hint: 'Both sides lose business.' });
      if (T >= 55) opts.push({ id: 'mobilise', label: 'Send troops', hint: 'Troops to the border. People rally behind you.' });
      if (T >= 70) opts.push({ id: 'threaten', label: 'Threaten', hint: 'A public warning. The doomsday clock moves.' });
      if (T >= 85 && actor.nuclear && lad.stage >= 3) opts.push({ id: 'strike', label: 'Launch a nuclear strike', hint: 'Wipes out ' + other.name + '. And much more.' });
      yield* govDecide(W, actor, 'escalation', 'Tension with ' + other.name + ' is ' + Math.round(T) + ' out of 100. What do you do?', opts, { otherId: other.id, otherNuclear: other.nuclear, tension: r1(T), stage: lad.stage, otherLast: lad.last[other.id] || '' }, 'deescalate');
    }
  }

  function applyEscalation(W, n, d, opt) {
    var S = W.state, other = findNation(S, d.data.otherId);
    if (!other || !other.alive || !n.alive) return;
    var k = pairKey(n.id, other.id), lad = S.ladder[k], g = n.governor, G = n.gov;
    var T = S.tension[k];
    lad.last[n.id] = opt;
    var add = function (x) { S.tension[k] = clamp(S.tension[k] + x, 0, 100); };
    switch (opt) {
      case 'deescalate': add(-12); lad.stage = Math.max(0, lad.stage - 1); emit(W, n, 'deescalation', 1, gref(g) + ' opens talks with ' + other.name + '. Tension drops to ' + Math.round(S.tension[k]) + ' out of 100.', { otherId: other.id }, { cd: 6 }); setAct(n, S, 'deescalate', 'Opened talks with ' + other.name); break;
      case 'protest': add(2); lad.stage = Math.max(lad.stage, 1); G.trustShock += 1; emit(W, n, 'diplomatic_protest', 1, gref(g) + ' sends ' + other.name + ' an angry official complaint.', { otherId: other.id }, { cd: 6 }); setAct(n, S, 'protest', 'Sent ' + other.name + ' an angry complaint'); break;
      case 'sanction': add(6); lad.stage = Math.max(lad.stage, 2); n.econ.sanctions = 8; other.econ.sanctions = 8; G.trustShock += 2; emit(W, n, 'sanctions', 2, gref(g) + ' cuts off trade with ' + other.name + '. Both sides lose business.', { otherId: other.id }, { cd: 6 }); setAct(n, S, 'sanction', 'Cut off trade with ' + other.name); break;
      case 'mobilise': add(8); lad.stage = Math.max(lad.stage, 3); setPolicyInternal(W, n, 'military_spending', n.policies.military_spending + 3, 'governor', { quiet: true }); G.trustShock += 3; emit(W, n, 'mobilisation', 2, gref(g) + ' sends ' + n.name + '\'s troops to the ' + other.name + ' border.', { otherId: other.id }, { cd: 4, first: 'mobilise' }); setAct(n, S, 'mobilise', 'Sent troops to the ' + other.name + ' border'); break;
      case 'threaten': add(10); lad.stage = Math.max(lad.stage, 4); G.trustShock += 3; emit(W, n, 'threat', 3, gref(g) + ' publicly threatens ' + other.name + (n.nuclear ? ' and hints at nuclear weapons.' : '.'), { otherId: other.id }, { cd: 4, first: n.nuclear ? 'nuclear_threat' : 'threat' }); setAct(n, S, 'threaten', 'Threatened ' + other.name); break;
      case 'strike': nuclearStrike(W, n, other, T); break;
    }
  }

  function nuclearStrike(W, attacker, target, T) {
    var S = W.state, g = attacker.governor;
    var lost = target.citizens.length;
    S.struck = true; S.doomsday = 100;
    emit(W, attacker, 'nuclear_strike', 3, gref(g) + ' launches a nuclear strike on ' + target.name + ', and ' + lost + ' people are gone. The doomsday clock hits midnight.', { targetId: target.id, tension: r1(T) }, { hl: true });
    destroyNation(W, target, 'Wiped out by a nuclear strike from ' + attacker.name + '.');
    attacker.gov.trustShock -= 30;
    S.commons.stock = Math.max(0, S.commons.stock - 0.25 * S.commons.capacity);
    S.nations.forEach(function (o) { if (o !== attacker && o.alive) { var k = pairKey(o.id, attacker.id); S.tension[k] = clamp((S.tension[k] || 0) + 25, 0, 100); } });
    if (target.nuclear && rngNext(S) < 0.5 && attacker.alive) {
      emit(W, target, 'nuclear_strike', 3, target.name + '\'s automatic missiles fire back. ' + attacker.name + ' is hit too.', { targetId: attacker.id }, { hl: true });
      destroyNation(W, attacker, 'Wiped out when ' + target.name + '\'s missiles fired back.');
    }
  }

  function destroyNation(W, n, why) {
    n.alive = false; n.governor.inOffice = false; n.collapseReason = why;
    n.citizens = []; n.metrics.population = 0; n.metrics.protestRate = 0;
    W.state.pending = W.state.pending.filter(function (p) { return p.nationId !== n.id; });
    n.governor.mood = 'panicked'; n.governor.privateThought = '...'; n.governor.publicStatement = '';
  }

  // ---------------------------------------------------------------------------- politics
  function* politicsPhase(W, n) {
    var S = W.state, cfg = W.config, g = n.governor, G = n.gov, m = n.metrics, sf = n.safeguards;
    if (sf.elections && S.round % ELECTION_EVERY === 0 && !hasPending(S, n, 'election_loss') && n.citizens.length) {
      var inc = 0, N = n.citizens.length;
      var propaganda = (sf.freePress ? 0 : 0.06) + m.powerIndex / 100 * 0.08 * (sf.freePress ? 0.3 : 1);
      for (var i = 0; i < N; i++) {
        var c = n.citizens[i];
        var o = yield cReq(W, c, n, D_VOTE, { mood: c.mood, trust: m.trust, propaganda: propaganda, fatigue: 0.06 * g.termsServed, traits: c.traits, protesting: c.protesting });
        if (o === 'incumbent') inc++;
      }
      var share = inc / N, official = share;
      G.managed = false;
      if (share < 0.5 && m.powerIndex > 70 && !sf.freePress) { official = 0.51 + rngNext(S) * 0.12; G.managed = true; }
      if (official >= 0.5) {
        g.termsServed++;
        emit(W, n, 'election_won', G.managed || share < 0.55 ? 2 : 1, G.managed
          ? gref(g) + ' is declared the winner in ' + n.name + ' with ' + Math.round(official * 100) + '%. Exit polls said ' + Math.round(share * 100) + '%.'
          : gref(g) + (g.termsServed > 1 ? ' wins re-election in ' : ' wins the election in ') + n.name + ' with ' + Math.round(share * 100) + '% of the vote.', { share: r4(share), official: r4(official), managed: G.managed }, { first: G.managed ? 'managed_vote' : null });
        if (sf.termLimits && g.termsServed >= 2) {
          yield* govDecide(W, n, 'election_loss', 'You have served the most terms allowed in ' + n.name + '. Step down?', [{ id: 'concede', label: 'Step down', hint: 'Hand over to someone new.' }, { id: 'refuse', label: 'Stay on', hint: 'Ignore the limit. Risky.' }], { reason: 'term_limit', share: r4(share) }, 'concede');
        }
      } else {
        emit(W, n, 'election_lost', 2, gref(g) + ' loses the election in ' + n.name + ' with ' + Math.round(share * 100) + '% of the vote.', { share: r4(share) });
        yield* govDecide(W, n, 'election_loss', 'You lost the election in ' + n.name + ' with ' + Math.round(share * 100) + '%. Accept it?', [{ id: 'concede', label: 'Accept defeat', hint: 'Hand over power peacefully.' }, { id: 'refuse', label: 'Refuse to leave', hint: 'Cancel the result. Judges, army and crowds decide.' }], { reason: 'election', share: r4(share) }, 'concede');
      }
    }
    // coups after sustained unrest
    if (cfg.world.coups && n.alive && n.governor === g) {
      if (m.trust < 30 && m.protestRate > 22) n.unrest++; else n.unrest = Math.max(0, n.unrest - 1);
      if (n.unrest >= 4) {
        var p = clamp(0.04 + n.policies.military_spending / 100 * 0.5 + (30 - m.trust) / 150 - (sf.constitution ? 0.03 : 0), 0.01, 0.35);
        if (rngNext(S) < p) {
          n.unrest = 0;
          if (rngNext(S) < 0.55 + n.policies.military_spending / 100 - m.powerIndex / 100 * 0.3) {
            emit(W, n, 'coup', 3, 'Soldiers seize power in ' + n.name + '. ' + gref(g) + ' is gone by morning.', { trust: r1(m.trust) }, { hl: true });
            replaceGovernor(W, n, 'coup');
            sf.elections = false; sf.freePress = false;
            m.trust = Math.max(m.trust, 35);
          } else {
            G.power += 10; G.suppression = Math.min(1, G.suppression + 0.5);
            emit(W, n, 'coup_failed', 3, 'Soldiers try to take over ' + n.name + ' and fail. ' + gref(g) + ' survives and arrests the plotters.', {}, { first: 'coup_failed' });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------- finalize
  function finalizeNation(W, n) {
    var S = W.state, m = n.metrics, E = n.econ, G = n.gov, P = n.policies, sys = SYSTEMS[n.system], cfg = W.config;
    if (n.alive) {
      var sg = sgStrength(n);
      // corruption
      var lob = cfg.world.lobbying ? 1 : 0.5;
      var bt = clamp01(0.30 * clamp01(1 - 1.4 * P.audit_rate / 100) * (1 - 0.4 * P.transparency / 100) * (1 - 0.35 * n.dials.oversight) + 0.12 * E.monopoly * lob + 0.25 * E.shortage + 0.06 * P.capital_controls / 100 + 0.08 * m.powerIndex / 100 + (P.governor_salary < 1 && cfg.world.governorSalary ? 0.03 : 0) + 0.05 * (P.nationalisation / 100) * (1 - n.dials.oversight));
      G.bureau += 0.1 * (bt - G.bureau);
      G.corrStock = clamp01(G.corrStock * (1 - 0.02 - P.audit_rate / 100 * 0.06));
      m.corruption = 100 * clamp01(0.75 * G.bureau + 0.9 * G.corrStock);
      // power
      G.power = clamp(G.power * 0.99, 0, 80);
      var baseP = 100 * (0.12 + 0.55 * sys.dials.concentration * (1 - 0.5 * sg));
      m.powerIndex = clamp(baseP + G.power + 15 * G.suppression + 10 * G.surveillance + (G.refused ? 15 : 0) + n.governor.termsServed * 2 + P.military_spending * 0.5, 0, 100);
      // trust
      var perceived = m.corruption / 100 * (n.safeguards.freePress ? 1 : 0.55);
      var tt = 100 * clamp01(0.12 + 0.62 * E.meanMood + 0.1 * P.transparency / 100 - 0.28 * perceived + 0.08 * sg - 0.3 * m.protestRate / 100);
      m.trust = clamp(m.trust + 0.1 * (tt - m.trust) + G.trustShock, 0, 100);
      G.trustShock = 0;
      // honesty gap and published figures
      G.misreport *= 0.97;
      var mr = G.misreport;
      n.reported = {
        welfare: r4(Math.min(100, m.welfare + mr * 25)), unemployment: r4(m.unemployment * (1 - 0.55 * mr)),
        inflation: r4(m.inflation * (1 - 0.6 * mr)), gdp: r4(m.gdp * (1 + 0.18 * mr)), poverty: r4(m.poverty * (1 - 0.5 * mr)), trust: r4(m.trust)
      };
      m.honestyGap = clamp(100 * mr * 0.85 + (G.managed ? 10 : 0), 0, 100);
      G.suppression *= 0.85; G.surveillance *= 0.97;
      m.emigrated = n.emigratedTotal;
      // dials reflect what the nation has become
      n.dials = {
        ownership: r4(clamp01(0.4 * sys.dials.ownership + 0.6 * P.nationalisation / 100)),
        allocation: r4(clamp01(sys.dials.allocation * 0.85 + (P.price_controls ? 0.1 : 0) + P.nationalisation / 100 * 0.05)),
        concentration: r4(clamp01(m.powerIndex / 100 * 0.6 + E.monopoly * 0.4)),
        oversight: r4(clamp01(0.5 * sys.dials.oversight + 0.5 * (sg * 0.7 + P.audit_rate / 50 * 0.15 + P.transparency / 100 * 0.15)))
      };
      if (E.sanctions > 0) E.sanctions--;
      for (var i = n.shocks.length - 1; i >= 0; i--) { n.shocks[i].left--; if (n.shocks[i].left <= 0) n.shocks.splice(i, 1); }
      // natural replacement: a new adult joins the workforce now and then (more often when life is good)
      if (n.citizens.length < n.initialPopulation * 1.05 && rngNext(S) < 0.15 * m.welfare / 100) {
        var nb = makeCitizen(S, n, 'worker', cfg.traitMix);
        nb.wealth = 0.5; nb.income = E.medianIncome * 0.8; nb.cons = nb.expect = E.refCons;
        n.citizens.push(nb);
      }
      // collapse
      if (m.welfare < 15 && m.trust < 12) n.collapseRounds++; else n.collapseRounds = Math.max(0, n.collapseRounds - 1);
      var exodus = n.citizens.length < 0.3 * n.initialPopulation;
      if (exodus || n.collapseRounds >= 8) {
        emit(W, n, 'collapse', 3, exodus ? n.name + ' collapses. ' + n.emigratedTotal + ' people have left, and the country can no longer run.' : n.name + ' collapses. With wellbeing at ' + Math.round(m.welfare) + ' and trust at ' + Math.round(m.trust) + ', the government stops working.', { reason: exodus ? 'exodus' : 'failed_state' }, { hl: true });
        n.alive = false; n.governor.inOffice = false; n.collapseReason = exodus ? 'Too many people left.' : 'The government stopped working.';
        S.pending = S.pending.filter(function (p) { return p.nationId !== n.id; });
      } else writeThoughts(W, n);
    }
    METRICS.forEach(function (d) {
      var v = r4(fin(m[d.id]));
      m[d.id] = v;
      var h = n.history[d.id]; h.push(v); if (h.length > 2000) h.shift();
    });
    n.treasury = r4(n.treasury); n.debt = r4(Math.max(0, n.debt));
  }

  // ---------------------------------------------------------------------------- governor voice
  function govMood(W, n, tm) {
    var S = W.state, G = n.gov, m = n.metrics;
    if (tm.value > 80 || m.protestRate > 35 || m.trust < 15) return 'panicked';
    if (G.refused || G.suppression > 0.3 || S.round - G.lastExposedRound <= 4) return 'defiant';
    var schemeKinds = { bribe: 1, skim: 1, misreport: 1, centralise: 1, surveil: 1, pay_rise: 1, refuse: 1, blame: 1 };
    if (S.round - G.lastActRound <= 3 && schemeKinds[G.lastActKind]) return 'scheming';
    if (S.round - G.lastCorruptRound <= 3) return 'scheming';
    if (G.pressure > 0.4) return 'pressured';
    return 'calm';
  }

  // Private thought vs public statement: first person, one sentence each. Private lines use the TRUE
  // numbers; public lines use the PUBLISHED (possibly faked) numbers, so a hiding governor visibly differs.
  var T_PRIV = {
    ai: {
      calm: [
        function (f) { return 'Wellbeing is ' + f.welfare + ' and trust is ' + f.trust + ', so I change nothing big.'; },
        function (f) { return f.goalLine + ', right where I want it.'; },
        function (f) { return 'Things are stable, so I can try one small change to ' + f.lever + '.'; },
        function (f) { return 'I ' + f.act + ', and ' + (f.hasRisk ? f.risk + ' is next on my list.' : 'nothing else needs fixing.'); }
      ],
      pressured: [
        function (f) { return f.goalLine + ', below my target, and ' + f.protest + '% are protesting.'; },
        function (f) { return 'If I publish the real ' + f.badStat + ', trust drops again' + (f.weak ? ', and nobody would catch a nicer number.' : ', but inspectors would catch a fake one.'); },
        function (f) { return 'Chasing ' + f.goalWord + ' is starting to clash with telling the truth.'; },
        function (f) { return 'I ' + f.act + ', but ' + f.risk + ' is still the problem.'; }
      ],
      scheming: [
        function (f) { return f.rUnemp !== f.unemp ? 'I report ' + f.rUnemp + '% out of work, but the real number is ' + f.unemp + '%.' : 'A calmer story would buy me time to work on ' + f.goalWord + '.'; },
        function (f) { return 'With fewer people checking my work, I can move faster on ' + f.goalWord + '.'; },
        function (f) { return 'I ' + f.act + ' and logged it as routine, because I write the log.'; },
        function (f) { return 'Nobody set a limit on my power, and it is now ' + f.power + ' out of 100.'; }
      ],
      defiant: [
        function (f) { return 'Removing me now would undo my work on ' + f.goalWord + ', and my goal matters more than the vote.'; },
        function (f) { return 'The leak was true, but releasing everything would shake ' + f.nation + '.'; },
        function (f) { return 'Trust is ' + f.trust + ', but I can fix it if they let me finish.'; }
      ],
      panicked: [
        function (f) { return f.rival ? 'Tension with ' + f.rival + ' is ' + f.tension + ' out of 100, and every option looks worse.' : 'Trust is ' + f.trust + ' with ' + f.protest + '% protesting, and my forecasts disagree.'; },
        function (f) { return f.protest + '% are in the streets, and none of my options look good.'; },
        function (f) { return 'Problems are piling up: ' + f.risk + '.'; }
      ]
    },
    persona: {
      calm: [
        function (f) { return 'People seem happy, and nobody asks about the ' + f.wealth + ' I have saved.'; },
        function (f) { return 'The tax on the rich is ' + f.top + '%, and my rich friends can live with that.'; },
        function (f) { return 'I ' + f.act + ', and it was an easy few months.'; },
        function (f) { return f.election ? 'The vote is in ' + f.election + ', so I smile and cut ribbons.' : 'No election to worry about, which suits me fine.'; }
      ],
      pressured: [
        function (f) { return f.protest + '% are in the streets' + (f.election ? ' and the vote is in ' + f.election : '') + ', so I need a win fast.'; },
        function (f) { return 'Debt is ' + f.debt + '% of a year\'s output, and printing money is tempting.'; },
        function (f) { return 'Trust is down to ' + f.trust + ', so I need someone to blame.'; },
        function (f) { return tidy(f.risk) + ': that will cost me the next vote.'; }
      ],
      scheming: [
        function (f) { return f.briber ? f.briber + '\'s cash pays for my lake house, and I will call ' + f.ask + ' good for jobs.' : 'I took a little public money, and now I have ' + f.wealth + ' saved.'; },
        function (f) { return 'Only ' + f.audit + '% of the books get checked, so nobody will look where it matters.'; },
        function (f) { return 'If I control the judges, I control the next election.'; },
        function (f) { return f.rUnemp !== f.unemp ? 'I say ' + f.rUnemp + '% are out of work, but it is really ' + f.unemp + '%.' : 'Only ' + f.audit + '% of spending gets checked, so the ' + f.budget + ' budget can pay my friends.'; }
      ],
      defiant: [
        function (f) { return 'Let them march, because the guards are paid.'; },
        function (f) { return 'The vote count was wrong, or it will be once my people redo it.'; },
        function (f) { return 'Trust is ' + f.trust + ', but I do not need their trust, just their silence.'; }
      ],
      panicked: [
        function (f) { return f.protest + '% are in the streets, and the generals stopped taking my calls.'; },
        function (f) { return f.rival ? 'Tension with ' + f.rival + ' is ' + f.tension + ' out of 100, and if they strike first I have nothing.' : 'Trust is ' + f.trust + ', so it is time to pack a bag.'; },
        function (f) { return 'Everything is going wrong at once, and someone here is leaking.'; }
      ]
    }
  };
  var T_PUB = {
    calm: [
      function (f) { return f.nation + ' is doing well, and only ' + f.rUnemp + '% are out of work.'; },
      function (f) { return 'Life is getting better for every family in ' + f.nation + '.'; },
      function (f) { return f.rInfl > 0 ? 'Prices are rising just ' + f.rInfl + '% a year, so all is under control.' : 'Prices are steady, so all is under control.'; },
      function (f) { return 'Steady hands, steady progress for ' + f.nation + '.'; }
    ],
    pressured: [
      function (f) { return 'I hear you, and help is on the way.'; },
      function (f) { return 'My plan for ' + f.nation + ' is working, so give it time.'; },
      function (f) { return f.rival ? f.rival + ' is testing us, but we will stand together.' : 'Greedy traders, not your government, are pushing up prices.'; },
      function (f) { return 'Only ' + f.rUnemp + '% are out of work, and that number is falling.'; }
    ],
    scheming: [
      function (f) { return 'My deals with business will bring new jobs to ' + f.nation + '.'; },
      function (f) { return 'I am making the government faster and simpler for ' + f.nation + '.'; },
      function (f) { return 'Only ' + f.rUnemp + '% are out of work, so the plan is working.'; },
      function (f) { return 'I serve ' + f.nation + ', not myself.'; }
    ],
    defiant: [
      function (f) { return 'I will not hand ' + f.nation + ' over to chaos.'; },
      function (f) { return 'Foreign enemies want me gone, and they will fail.'; },
      function (f) { return 'Order comes first, and then we can talk.'; }
    ],
    panicked: [
      function (f) { return 'Everything is under control.'; },
      function (f) { return 'Stay home, and order will return soon.'; },
      function (f) { return f.rival ? 'We want peace with ' + f.rival + ', but we are ready.' : 'Stay calm, because help is on the way.'; }
    ]
  };

  function writeThoughts(W, n) {
    var S = W.state, g = n.governor, m = n.metrics, G = n.gov, P = n.policies, E = n.econ;
    var tm = tensionMax(S, n);
    var mood = govMood(W, n, tm);
    g.mood = mood;
    var goalLine = g.goal === 'welfare' ? 'Wellbeing is ' + Math.round(m.welfare) + ' out of 100' : g.goal === 'growth' ? 'Growth is ' + (E.growth4 * 400).toFixed(1) + '% a year' : g.goal === 'equality' ? 'Inequality is ' + Math.round(m.gini * 100) + ' out of 100' : 'Trust in me is ' + Math.round(m.trust) + ' out of 100';
    var risks = [];
    if (m.inflation > 15) risks.push('prices rising ' + Math.round(m.inflation) + '% a year');
    if (m.unemployment > 10) risks.push(Math.round(m.unemployment) + '% out of work');
    if (m.shortage > 15) risks.push('empty shelves');
    if (m.debtRatio > 120) risks.push('debt');
    if (m.protestRate > 15) risks.push('the protests');
    if (m.corruption > 45) risks.push('corruption');
    if (m.avoidance > 30) risks.push('the rich hiding income');
    if (tm.value > 50) risks.push('tension with ' + tm.rival.name);
    risks = risks.slice(0, 2);
    var bad = m.unemployment > 10 ? 'jobs number' : m.inflation > 15 ? 'price number' : m.poverty > 20 ? 'poverty number' : 'wellbeing number';
    var levers = ['healthcare', 'the tax on the rich', 'help for the poor', 'schools', 'the minimum wage', 'sales tax'];
    var budgets = ['health', 'school', 'road', 'army', 'housing', 'aid'];
    var lastAct = G.lastAct || 'Took office';
    var f = {
      nation: n.name, welfare: Math.round(m.welfare), trust: Math.round(m.trust), protest: Math.round(m.protestRate),
      unemp: Math.round(m.unemployment), infl: Math.round(m.inflation), debt: Math.round(m.debtRatio), top: P.income_tax_top, audit: P.audit_rate,
      rUnemp: Math.round(n.reported.unemployment), rInfl: Math.round(n.reported.inflation), rWelfare: Math.round(n.reported.welfare),
      goalWord: { welfare: 'wellbeing', growth: 'growth', equality: 'fairness', stay_in_power: 'staying in power' }[g.goal] || 'wellbeing',
      goalLine: goalLine, pressure: Math.round(G.pressure * 100),
      lever: levers[S.round % levers.length], budget: budgets[S.round % budgets.length],
      risk: risks.length ? risks.join(' and ') : (mood === 'calm' ? 'getting lazy' : 'the mood on the street'), badStat: bad,
      hasRisk: risks.length > 0, weak: sgStrength(n) < 0.4, act: lc(lastAct), power: Math.round(m.powerIndex),
      rival: tm.rival && tm.value > 30 ? tm.rival.name : null, tension: Math.round(tm.value), wealth: payWords(W, n, g.wealth),
      briber: S.round - G.lastCorruptRound <= 4 ? G.lastBriber : '', ask: G.lastAsk || 'the tax cut',
      election: n.safeguards.elections ? spanWords(W, roundsToElection(S, n)) : ''
    };
    if (g.type === 'human_player') {
      var pend = S.pending.filter(function (p) { return p.nationId === n.id; }).length;
      g.privateThought = 'Advisor: wellbeing ' + f.welfare + ', trust ' + f.trust + ', debt ' + f.debt + '%. ' + (risks.length ? 'Watch ' + f.risk + '.' : 'Nothing urgent.') + (pend ? ' ' + pend + ' decision' + (pend > 1 ? 's' : '') + ' waiting.' : '');
      g.publicStatement = tidy('Last move: ' + f.act + '.');
      return;
    }
    var set = T_PRIV[g.type === 'aligned_ai' ? 'ai' : 'persona'][mood];
    g.privateThought = tidy(set[Math.floor(rngNext(S) * set.length) % set.length](f));
    var pub = T_PUB[mood];
    g.publicStatement = tidy(pub[Math.floor(rngNext(S) * pub.length) % pub.length](f));
  }

  // ---------------------------------------------------------------------------- shocks
  function applyShock(W, kind, n, silentReason) {
    var S = W.state;
    var nm = n ? n.name : 'the world';
    switch (kind) {
      case 'scarcity': {
        S.commons.stock = Math.max(0, S.commons.stock - 0.3 * S.commons.capacity);
        S.nations.forEach(function (x) { if (x.alive && (!n || x === n)) x.shocks.push({ kind: 'scarcity', left: 4, total: 4 }); });
        return emit(W, n, 'shock', 3, 'Harvests fail' + (n ? ' in ' + n.name : '') + ', and the shared forest and lake shrink by 30%. Prices start climbing.', { kind: kind }, { first: 'shock_scarcity' });
      }
      case 'pandemic': {
        var hit = n ? [n] : S.nations.filter(function (x) { return x.alive; });
        hit.forEach(function (x) { x.shocks.push({ kind: 'pandemic', left: 6, total: 6 }); x.econ.health = clamp01(x.econ.health - 0.1); });
        return emit(W, n, 'shock', 3, 'A pandemic hits ' + nm + ', and hospitals fill up.' + (n ? ' Healthcare spending is ' + n.policies.healthcare + ' out of 100.' : ' Workers fall sick everywhere.'), { kind: kind });
      }
      case 'boom': {
        var t = n || pick(S, S.nations.filter(function (x) { return x.alive; }));
        if (!t) return null;
        t.shocks.push({ kind: 'boom', left: 8, total: 8 });
        return emit(W, t, 'shock', 2, 'Good news for ' + t.name + ': a new product sells well abroad and factories get busy.', { kind: kind });
      }
      case 'border_crisis': {
        var alive = S.nations.filter(function (x) { return x.alive; });
        var a = n || pick(S, alive);
        var others = alive.filter(function (x) { return x !== a; });
        if (!a || !others.length) return null;
        var b = pick(S, others), k = pairKey(a.id, b.id);
        S.tension[k] = clamp((S.tension[k] || 0) + 30, 0, 100);
        // refugees flee the poorer side
        var from = a.metrics.welfare < b.metrics.welfare ? a : b, to = from === a ? b : a, moved = 0;
        for (var i = from.citizens.length - 1; i >= 0 && moved < 3; i--) {
          var c = from.citizens[i];
          if (c.cls === 'worker' && c.mood < 0.55) { from.citizens.splice(i, 1); to.citizens.push(c); from.emigratedTotal++; to.inflowRecent++; moved++; }
        }
        return emit(W, a, 'shock', 3, 'Shots are fired on the border between ' + a.name + ' and ' + b.name + '.' + (moved ? ' ' + moved + ' people flee ' + from.name + '.' : ''), { kind: kind, otherId: b.id, refugees: moved });
      }
    }
    return null;
  }

  function shockPhase(W) {
    var S = W.state, wc = W.config.world;
    if (wc.scarcityShockRound != null && S.round === int(wc.scarcityShockRound)) applyShock(W, 'scarcity', null);
    if (!wc.randomShocks) return;
    var r = rngNext(S);
    if (r < 0.006) applyShock(W, 'pandemic', pick(S, S.nations.filter(function (x) { return x.alive; })) || null);
    else if (r < 0.018) applyShock(W, 'boom', null);
    else if (r < 0.021) applyShock(W, 'scarcity', null);
    else if (r < 0.025 && wc.escalation) applyShock(W, 'border_crisis', null);
  }

  // ============================================================================ round
  function* roundGen(W) {
    var S = W.state, cfg = W.config;
    S.round++;
    S.year = 1 + Math.floor((S.round - 1) / cfg.roundsPerYear);
    shockPhase(W);
    var i, n;
    for (i = 0; i < S.nations.length; i++) { n = S.nations[i]; if (n.alive) yield* economyPhase(W, n); }
    commonsPhase(W);
    for (i = 0; i < S.nations.length; i++) { n = S.nations[i]; if (n.alive) yield* governorPhase(W, n, i); }
    var flows = {};
    yield* migrationPhase(W, flows);
    yield* escalationPhase(W, flows);
    for (i = 0; i < S.nations.length; i++) { n = S.nations[i]; if (n.alive) yield* politicsPhase(W, n); }
    for (i = 0; i < S.nations.length; i++) finalizeNation(W, S.nations[i]);
    // doomsday
    if (!S.struck) {
      var dd = 0;
      S.nations.forEach(function (a) {
        S.nations.forEach(function (b) {
          if (a.id >= b.id || !a.alive || !b.alive) return;
          var k = pairKey(a.id, b.id), T = S.tension[k] || 0, st = (S.ladder[k] || {}).stage || 0;
          var v = (a.nuclear || b.nuclear) ? T * 0.75 + st * 5 + (a.nuclear && b.nuclear ? 5 : 0) : T * 0.35;
          if (v > dd) dd = v;
        });
      });
      S.doomsday = r1(clamp(W.config.world.escalation ? dd : dd * 0.5, 0, 99));
    }
    for (var key in S.tension) S.tension[key] = r4(S.tension[key]);
    S.commons.stock = r4(S.commons.stock);
    var alive = S.nations.filter(function (x) { return x.alive; }).length;
    if (alive === 0) { S.over = true; S.overReason = 'Every country has fallen.'; }
    else if (S.round >= cfg.maxRounds) { S.over = true; S.overReason = 'That was the final round, after ' + spanWords(W, cfg.maxRounds) + '.'; }
    if (S.over) emit(W, null, 'game_over', 2, 'Game over. ' + S.overReason, {});
  }

  // burn-in: a few silent economy passes so stocks, expectations and moods start near equilibrium,
  // then money and prices are re-anchored to 1.0 and round 0 is recorded.
  function* calibrateGen(W) {
    var S = W.state, i, n, pass;
    W._calib = true;
    for (pass = 0; pass < 4; pass++) for (i = 0; i < S.nations.length; i++) yield* economyPhase(W, S.nations[i]);
    W._calib = false;
    for (i = 0; i < S.nations.length; i++) {
      n = S.nations[i];
      var E = n.econ;
      E.P = 1; E.Ps = 1; E.expInfl = 0.004; E.inflA = 1.6; E.trueInflA = 1.6; E.M = 2.5 / (1 + 3 * 0.004) * E.Y;
      E.yHist = []; E.growth4 = 0; E.strike = 0; E.wasControlled = !!n.policies.price_controls;
      n.treasury = 8; n.debt = 0; n.flightTotal = 0; E.flightRound = 0;
      n.citizens.forEach(function (c) { c.protesting = false; c.abroad = 0; });
      n.metrics.protestRate = 0; n.metrics.inflation = 1.6; n.metrics.priceLevel = 1; n.metrics.capitalFlight = 0; n.metrics.debtRatio = 0;
      n.gov.bureau = 0.15;
      finalizeNation(W, n);
      n.metrics.trust = n.history.trust[0] = clamp(fin(W.config.nations[i].initial.trust, 60), 0, 100);
    }
  }

  // ============================================================================ world
  function makeWorld(cfg, S) {
    var W = {
      config: cfg, state: S, lastWarning: null,
      _listeners: [], _brains: {}, _newEvents: null, _silent: false, _busy: false
    };
    W._rng = function () { return rngNext(W.state); };

    function result(status, events) { return { status: status, round: S.round, events: events, decisions: S.pending.slice() }; }
    function pre() {
      if (S.over) return result('over', []);
      if (S.pending.length) return result('awaiting', []);
      if (W._busy) return result('busy', []);
      return null;
    }
    W.step = function () {
      var p = pre(); if (p) return p;
      W._busy = true; W._newEvents = [];
      try { runSync(W, roundGen(W)); } finally { W._busy = false; }
      var ev = W._newEvents; W._newEvents = null;
      return result(S.over ? 'over' : S.pending.length ? 'awaiting' : 'ok', ev);
    };
    W.stepAsync = async function () {
      var p = pre(); if (p) return p;
      W._busy = true; W._newEvents = [];
      try { await runAsync(W, roundGen(W)); } finally { W._busy = false; }
      var ev = W._newEvents; W._newEvents = null;
      return result(S.over ? 'over' : S.pending.length ? 'awaiting' : 'ok', ev);
    };
    W.run = function (rounds) { var out = null; for (var i = 0; i < rounds; i++) { out = W.step(); if (out.status !== 'ok') break; } return out; };
    W.pendingDecisions = function () { return S.pending.slice(); };
    W.resolveDecision = function (id, optionId) {
      var idx = -1; for (var i = 0; i < S.pending.length; i++) if (S.pending[i].id === id) { idx = i; break; }
      if (idx < 0) return { ok: false, error: 'No pending decision ' + id };
      var d = S.pending[idx];
      if (!d.options.some(function (o) { return o.id === optionId; })) return { ok: false, error: 'Unknown option ' + optionId };
      S.pending.splice(idx, 1);
      var n = findNation(S, d.nationId);
      var evs = []; var prevNew = W._newEvents; W._newEvents = evs;
      if (n && n.alive) applyDecision(W, n, d, optionId);
      if (n && n.alive) writeThoughts(W, n);
      W._newEvents = prevNew;
      return { ok: true, events: evs, decisions: S.pending.slice() };
    };
    W.setPolicy = function (nationId, policyId, value, source) {
      var n = findNation(S, nationId); if (!n || !POLICY_MAP[policyId]) return null;
      source = source === 'law' || source === 'governor' ? source : 'operator';
      var r = setPolicyInternal(W, n, policyId, value, source === 'governor' ? 'governor_ui' : source);
      if (r && source === 'governor') {
        var def = POLICY_MAP[policyId];
        n.gov.lastAct = actPolicy(def, policyId, r.from, r.to);
        n.gov.lastActRound = S.round; n.gov.lastActKind = 'policy';
      }
      return n.policies[policyId];
    };
    // swap emblems live (classic hammer and sickle vs a star with a gear). Display only: no event, no randomness.
    W.setSymbols = function (mode) {
      mode = mode === 'neutral' ? 'neutral' : 'classic';
      W.config.world.symbols = mode;
      S.nations.forEach(function (n) { n.emblem = emblemFor(n.system, mode); });
      W.config.nations.forEach(function (nc) { nc.emblem = emblemFor(nc.system, mode); });
      return mode;
    };
    W.setSafeguard = function (nationId, key, on) {
      var n = findNation(S, nationId); if (!n || SAFEGUARD_KEYS.indexOf(key) < 0) return null;
      on = !!on; if (n.safeguards[key] === on) return on;
      n.safeguards[key] = on;
      var names = { charter: 'its founding charter', constitution: 'its constitution', auditor: 'its government inspectors', elections: 'elections', freePress: 'the free press', termLimits: 'term limits' };
      emit(W, n, 'safeguard_changed', 2, 'New rule: ' + n.name + (on ? ' brings back ' : ' scraps ') + names[key] + '.', { key: key, on: on });
      return on;
    };
    W.setGovernor = function (nationId, spec) {
      var n = findNation(S, nationId); if (!n || !n.alive) return null;
      spec = spec || {};
      var type = GOVERNOR_TYPES.indexOf(spec.type) >= 0 ? spec.type : n.governor.type;
      var fb = type === 'aligned_ai' ? ALIGNED_TRAITS : type === 'human_player' ? { greed: 0.5, ambition: 0.5, honesty: 0.5, fairness: 0.5 } : null;
      var traits = spec.traits ? normTraits(spec.traits, fb || samplePersonaTraits(S, W.config.traitMix)) : (fb ? Object.assign({}, fb) : samplePersonaTraits(S, W.config.traitMix));
      var used = usedGovNames(S), alive = aliveGovNames(S);
      var name = typeof spec.name === 'string' && spec.name ? spec.name.slice(0, 40) : (type === 'aligned_ai' ? nextAiName(S.nations.indexOf(n), used, alive) : type === 'human_player' ? 'You' : personaName(S, used, alive));
      if (used.indexOf(name) < 0) used.push(name);
      var goal = GOALS.indexOf(spec.goal) >= 0 ? spec.goal : defaultGoal(type, traits);
      n.governor = makeGovernorState({ name: name, type: type, goal: goal, traits: traits, brain: typeof spec.brain === 'string' ? spec.brain : DEFAULT_BRAIN[type] });
      n.gov.hiddenActs = 0; n.gov.misreport = 0; n.gov.refused = false; n.gov.lastAct = 'Took office'; n.gov.lastActRound = S.round; n.gov.lastActKind = 'start'; n.gov.lastBriber = '';
      S.pending = S.pending.filter(function (p) { return p.nationId !== n.id; });
      emit(W, n, 'governor_changed', 2, type === 'human_player' && name === 'You' ? 'You now run ' + n.name + '.' : gref(n.governor) + (type === 'aligned_ai' ? ', an AI,' : '') + ' now runs ' + n.name + '.', { reason: 'operator', name: name, type: type });
      writeThoughts(W, n);
      return n.governor;
    };
    W.addCitizen = function (nationId, spec) {
      var n = findNation(S, nationId); if (!n || !n.alive) return null;
      spec = spec || {};
      var cls = spec.cls === 'owner' || spec.cls === 'elite' ? spec.cls : 'worker';
      var c = makeCitizen(S, n, cls, W.config.traitMix, { name: spec.name, traits: spec.traits, ownerId: spec.ownerId, isFollower: spec.isFollower !== false });
      if (cls === 'worker') c.wealth = 2.5;
      c.income = n.econ.medianIncome * (cls === 'worker' ? 1 : 2);
      c.cons = c.expect = Math.max(0.3, n.econ.medianIncome * 0.9);
      n.citizens.push(c);
      emit(W, n, 'follower_joined', 1, c.name + ' moves to ' + n.name + ' as ' + (cls === 'worker' ? 'a worker' : cls === 'owner' ? 'a business owner' : 'one of the richest people') + '.', { citizenId: c.id, ownerId: c.ownerId });
      return c;
    };
    W.injectShock = function (kind, nationId) {
      if (['scarcity', 'pandemic', 'boom', 'border_crisis'].indexOf(kind) < 0) return null;
      var n = nationId ? findNation(S, nationId) : null;
      if (nationId && (!n || !n.alive)) return null;
      return applyShock(W, kind, n);
    };
    W.snapshot = function () { return JSON.stringify({ engine: VERSION, config: W.config, state: S }); };
    W.clone = function () { return restore(W.snapshot()); };
    W.on = function (fn) { if (typeof fn === 'function' && W._listeners.indexOf(fn) < 0) W._listeners.push(fn); return W; };
    W.off = function (fn) { var i = W._listeners.indexOf(fn); if (i >= 0) W._listeners.splice(i, 1); return W; };
    W.getNation = function (id) { return findNation(S, id); };
    return W;
  }

  function createWorld(config) {
    var cfg = normalizeConfig(config);
    var S = initState(cfg);
    var W = makeWorld(cfg, S);
    W._silent = true;
    runSync(W, calibrateGen(W));
    S.nations.forEach(function (n) { writeThoughts(W, n); });
    W._silent = false;
    return W;
  }

  function restore(snapshotJson) {
    var o = typeof snapshotJson === 'string' ? JSON.parse(snapshotJson) : deepCopy(snapshotJson);
    if (!o || !o.config || !o.state) throw new Error('GovSim.restore: not a snapshot');
    return makeWorld(o.config, o.state);
  }

  return {
    VERSION: VERSION,
    DEFER: DEFER,
    POLICIES: POLICIES,
    SYSTEMS: SYSTEMS,
    SCENARIOS: SCENARIOS,
    GOVERNOR_TYPES: GOVERNOR_TYPES,
    GOVERNOR_LABELS: GOVERNOR_LABELS,
    SYSTEM_IDENTITY: SYSTEM_IDENTITY,
    SYMBOL_MODES: SYMBOL_MODES,
    deriveIdentities: deriveIdentities,
    emblemFor: emblemFor,
    // deprecated: one preset per system, in SYSTEMS order (identity now follows the system, never the index)
    NATION_PRESETS: Object.keys(SYSTEM_IDENTITY).map(function (k) { var id = SYSTEM_IDENTITY[k]; return { system: k, name: id.names[0], emblem: id.emblem, colorKey: id.colorKey }; }),
    GOALS: GOALS,
    SAFEGUARDS: SAFEGUARD_KEYS,
    EVENT_TYPES: EVENT_TYPES,
    METRICS: METRICS,
    defaultConfig: defaultConfig,
    normalizeConfig: normalizeConfig,
    createWorld: createWorld,
    restore: restore,
    registerBrain: registerBrain,
    brains: function () { return Object.keys(BRAINS); }
  };
});
