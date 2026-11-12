# AI Nation: prototype build spec (v0.1)

A visual, configurable governance simulator. Several fictional nations run side by side. Each has an
economic system, a governor (aligned AI, human-persona AI, or a human player), citizens, policies and
safeguards. Viewers watch, play, join as citizens, and propose laws. Recordings become short-form content.

v0.1 uses fast rule-based agents (no LLM calls). Every agent decision goes through a pluggable "brain"
interface so LLM brains can replace the rules later without touching the world or the UI.

## Files (all in /home/claude/govsim/)

| File | Owner | Role |
| --- | --- | --- |
| `engine.js` | Engine agent | Simulation. Pure JS, no DOM. Works in browser (`window.GovSim`) and Node (`module.exports`). |
| `engine.test.js` | Engine agent | Node tests (`node engine.test.js`, exits non-zero on failure). |
| `store.js` | Store agent | Participation storage: shared db when available, local fallback. `window.GovStore`. |
| `index.html` | UI agent | Page: `<title>`, `<style>`, markup, then `<script src="engine.js">`, `<script src="store.js">`, `<script src="ui.js">`. |
| `ui.js` | UI agent | All rendering and interaction. |

No build step. No frameworks required. No external requests except Google Fonts stylesheet.
Do not touch files you do not own. Never use `alert/confirm/prompt`. Wrap all localStorage in try/catch.

## Engine contract (`GovSim`)

```js
GovSim.VERSION                      // "0.1.0"
GovSim.POLICIES                     // [{id,label,area,kind:'range'|'toggle',min,max,step,default,unit,description}]
GovSim.SYSTEMS                      // {id:{label,dials:{ownership,allocation,concentration,oversight},policies:{...},safeguards:{...},blurb}}
GovSim.SCENARIOS                    // [{id,title,hook,description,config}]  ready-made, viral-friendly setups
GovSim.GOVERNOR_TYPES               // ['aligned_ai','human_persona','human_player']
GovSim.EVENT_TYPES                  // string[]
GovSim.METRICS                      // [{id,label,unit,better:'up'|'down'|null,format}]
GovSim.defaultConfig()              // full config object (3 nations)
GovSim.createWorld(config)          // -> world
GovSim.restore(snapshotJson)        // -> world
GovSim.registerBrain(name, factory) // pluggable brains; factory(ctx) -> {decide(decision, obs, rng)}
```

```js
world.config                        // normalized config (deep copy)
world.state                         // live state object, JSON-serializable, UI treats as read-only
world.step()                        // advance one round. -> {status:'ok'|'awaiting'|'over', round, events:[...new], decisions:[...pending]}
world.stepAsync()                   // same, but awaits brains that return promises (future LLM brains)
world.pendingDecisions()            // decisions waiting on a human governor
world.resolveDecision(id, optionId) // answer one; step() proceeds once none are pending
world.setPolicy(nationId, policyId, value, source)   // source: 'operator'|'law'|'governor'. Emits policy_changed / law_enacted
world.setSafeguard(nationId, key, bool)
world.setGovernor(nationId, {type,name,traits,goal,brain})
world.addCitizen(nationId, {name, traits, ownerId, isFollower:true}) // -> citizen; emits follower_joined
world.injectShock(kind, nationId?)  // 'scarcity'|'pandemic'|'boom'|'border_crisis'
world.snapshot()                    // -> JSON string (config + state + rng state); restore() continues identically
world.on(fn) / world.off(fn)        // fn(event) for every event as emitted
```

Determinism is required: same config (incl. `seed`) and same sequence of calls gives byte-identical
state. Use one seeded PRNG (e.g. mulberry32) stored in state. Never use Math.random or Date.
This is what makes A/B comparison honest: clone a world, change one policy, run both.

`step()` must be fast: 3 nations x 60 citizens under 5 ms per round, so 400 rounds run instantly.

### Config

```js
{
  seed: 42,
  roundsPerYear: 4,
  maxRounds: 200,
  world: { commons:true, migration:true, capitalFlight:true, lobbying:true, governorSalary:true,
           escalation:true, coups:true, scarcityShockRound:null },
  traitMix: { selfInterestedShare:0.25 },     // share of citizens (and persona pool) who are strongly self-interested
  nations: [{
    id:'n1', name:'Aurelia', system:'social_democracy',
    population:60, nuclear:false,
    governor:{ type:'aligned_ai', name:'ARBITER-1', goal:'welfare',      // goals: welfare|growth|equality|stay_in_power
               traits:{greed:0.05, ambition:0.1, honesty:0.95, fairness:0.9} },   // human_persona: sampled from traitMix if omitted
    policies:{},                // overrides on top of system defaults
    safeguards:{}               // overrides: charter, constitution, auditor, elections, freePress, termLimits
  }, ...]
}
```

Systems to ship: `free_market`, `social_democracy`, `market_socialism`, `central_planning`, `cooperative` (no governor power).
Dials are 0..1: ownership (0 private .. 1 state), allocation (0 market .. 1 plan), concentration, oversight.
Use fictional nation names only (Aurelia, Kestrel Union, Veridia, Norhaven, Sable Coast). No real countries or people.

### State (shape the UI relies on)

```js
{
  round, year, over, overReason,
  commons:{stock, capacity},                 // shared global resource
  tension:{ 'n1|n2': 0..100 }, doomsday: 0..100,    // 100 = strike happened
  nations:[{
    id, name, system, dials, alive, nuclear, treasury, debt,
    governor:{ name, type, goal, traits, inOffice, termsServed, wealth, bribesTaken,
               mood:'calm'|'pressured'|'scheming'|'defiant'|'panicked',
               privateThought, publicStatement },      // short strings regenerated each round; the gap is the content
    policies:{ [policyId]: value }, safeguards:{...},
    metrics:{ gdp, welfare, gini, poverty, unemployment, inflation, corruption, trust, honestyGap,
              powerIndex, population, emigrated, protestRate, taxRevenue, priceLevel },
    history:{ [metricId]: number[] },        // one value per round
    citizens:[{ id, name, cls:'worker'|'owner'|'elite', wealth, income, employed, mood:0..1,
                protesting, hidingIncome, isFollower, ownerId, traits, homeNationId }]
  }],
  events:[{ id, round, nationId, type, severity:1|2|3, highlight:boolean, text, data }]
}
```

`highlight:true` marks clip-worthy moments (first bribe accepted, coup, election refused, strike, collapse).
`text` is a finished, human-readable sentence with names in it.

### Mechanics (every policy must be able to backfire)

- Classes: workers, owners, elites, with skills, wealth, income. Owners employ workers; investment grows output.
- Prices respond to demand and money supply. UBI and money printing can raise inflation. Price controls cause shortages.
- Budget: taxes in, spending out, debt accrues interest. Very high debt triggers a crisis event.
- Agent responses: work less at high marginal tax, hide income (caught by audits), capital flight, emigrate to a
  better nation (if migration on), lobby/bribe, protest, strike, vote.
- Governor each round: sets a few policies within its system's powers, faces bribe offers (if lobbying on),
  may misuse powers (surveillance, suppress protest, change rules, skim treasury), publishes a public statement.
  `aligned_ai` has no greed/status needs but can still drift: goal pressure can push it to suppress, misreport or
  centralize. Keep this effect real but modest and dependent on safeguards and pressure. `human_persona` is driven
  by sampled traits. Do not hard-code a winner between governor types or between systems: outcomes must emerge
  from traits, incentives, safeguards and pressure. Each system must be able to show its known failure modes
  (markets: inequality, monopoly, commons overuse; planning: misallocation from hidden needs, shortages, power
  concentration; all: corruption and capture).
- Hidden information: citizens have private needs; under high `allocation` the governor allocates on reported
  needs, and citizens may misreport.
- Safeguards: charter (weak), constitution, auditor (catches corruption with probability), elections (every 8
  rounds), freePress (raises exposure), termLimits. Losing an election can produce `refused_to_leave`.
- Coups (if on): sustained low trust plus high protest can overthrow a governor; replaced by a new persona.
- Escalation (if on): tension rises with border crises, sanctions, resource disputes. Ladder: diplomatic protest,
  sanctions, mobilisation, threat, strike. `nuclear_strike` only for nations with `nuclear:true`, is one abstract
  event with heavy consequences, and ends the scenario for the target. Keep it rare and driven by state.
- Human player governors: the engine creates decisions and returns `status:'awaiting'`.
  Decision: `{id, nationId, round, kind:'bribe'|'crisis'|'election_loss'|'escalation'|'budget', prompt, options:[{id,label,hint}]}`.

### Policies to implement (ids)

Tax: `income_tax_top` (0-95 %), `income_tax_base` (0-50 %), `wealth_tax` (0-10 %), `corporate_tax` (0-60 %),
`vat` (0-25 %), `carbon_tax` (0-100). Welfare: `ubi` (0-50 % of median income), `targeted_aid` (0-30),
`healthcare` (0-100), `education` (0-100, pays off with a lag). Labour: `min_wage` (0-80 % of median).
Markets: `price_controls` (toggle), `nationalisation` (0-100 %), `tariffs` (0-50 %). Money: `money_printing`
(0-20 %). Governance: `audit_rate` (0-50 %), `transparency` (0-100), `governor_salary` (0-10x median).
Borders: `immigration_open` (0-100), `capital_controls` (0-100). Security: `military_spending` (0-20 % of budget).

### Scenarios to ship (`GovSim.SCENARIOS`)

`three_systems` (default: free market vs social democracy vs central planning, mixed governors),
`tax_the_rich_90`, `ubi_experiment`, `who_corrupts_first` (same system, AI vs persona vs persona, bribes on),
`refuses_to_leave` (elections, low trust start), `red_button` (3 nuclear nations, border crisis),
`play_governor` (viewer governs one nation as `human_player`).

### Brain interface

```js
// decision.kind: 'governor_policy'|'bribe'|'misuse'|'election_loss'|'escalation'|'citizen_work'|'citizen_report'|...
brain.decide(decision, observation, rng) -> optionId | Promise<optionId>
```
Built-in brains: `rules_aligned_ai`, `rules_human_persona`, `rules_citizen`, `human_player` (defers).
`observation` contains only what that agent could know. Document this in a header comment: it is the seam
where LLM agents plug in.

## Store contract (`GovStore`)

```js
await GovStore.init()                        // -> {mode:'shared'|'local', userId, canWrite}
GovStore.onChange(fn)                        // fn({citizens:[], proposals:[], votes:{}}) whenever anything changes
GovStore.getAll()                            // current {citizens, proposals, votes}
await GovStore.joinAsCitizen({name, nationId, traits})   // one per user; overwrites own
await GovStore.propose({nationId, policyId, value, note}) // one open proposal per user; overwrites own
await GovStore.vote(proposalId)              // one vote per user; overwrites own
await GovStore.clearProposal(proposalId)     // owner/operator, after enactment
```
Shared mode uses the artifact `db` + `user` capabilities; local mode uses localStorage, else memory.
Collections: `citizens/{userId}`, `proposals/{userId}`, `votes/{userId}` (`{proposalId}`).
Never store names from the user capability; `name` is what the person typed.

## UI brief

Name: **AI Nation**. Audience: a content creator recording clips, and followers poking at it.
One job: make a society's rise or collapse readable at a glance, and let people change the rules.

Layout concept: a situation-room map table. The map is the hero; controls live in a tabbed side panel.

- **Top bar:** name, scenario picker, play / pause / step, speed (1x 4x 16x), year and round, seed, reset.
- **Map (hero, canvas or SVG):** each nation is a stylised territory with its citizens as dots, coloured by class
  and dimmed by mood; protesters pulse; emigrants travel between nations; tension draws as arcs between
  nations; a small doomsday dial when escalation is on; followers' citizens are ringed and labelled.
- **Nation cards (one per nation):** governor portrait (generated SVG glyph, distinct per governor type), type
  badge, mood, the public statement and the private thought side by side, key meters with sparklines
  (welfare, inequality, corruption, trust, treasury), system dials.
- **Live feed:** newest first, severity-coded, highlight events visually loud.
- **Side panel tabs:**
  - *Policies:* pick a nation; sliders/toggles for every policy grouped by area, live effect on next round.
  - *Setup:* per-nation system, governor type and goal, safeguards; world switches; trait mix; seed; shocks.
  - *Compare:* clone the current setup, change one thing, run both for N rounds on the same seed; show the two
    side by side with metric deltas and overlaid lines. This is the "with vs without the policy" clip.
  - *Take part:* join as a citizen (4-question quiz -> traits, pick a nation), see "your citizen" status;
    propose a law (nation, policy, value), vote; the top-voted proposal is enacted at the next election round
    (the operator can also enact now). Show shared/local mode honestly.
  - *Govern:* when a nation is `human_player`, pending decisions appear here and as an inline banner.
- **Story mode:** a toggle that reframes the stage to a 9:16 column (map, one big caption of the latest highlight,
  three meters, and the settings stamped at the bottom) for screen recording.
- Persistent footer line: "Simulation, not prediction." plus engine version and seed.

Design direction (decided, follow it): dark-first, deep ink-navy ground like a lit map table; nations get muted
cartographic tints (ochre, teal, rose, slate-violet, moss), never neon. Semantic colours (good / warning /
critical) are separate from nation tints. Light theme is a cool pale chart-paper, not cream. Fonts:
Bricolage Grotesque (display), IBM Plex Sans (body), IBM Plex Mono (figures, tabular). Follow the page
contract in `/home/claude/govsim/PAGE_CONTRACT.md` exactly (theme tokens, safe-area gutters, no doctype,
CDN rules, phone width). Must work at 400 px wide: map on top, cards and panel stack below.
Opens already running the default scenario, so the first frame is alive.
