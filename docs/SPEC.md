# AI Nation: prototype build spec (v0.1)

A visual, configurable governance simulator. Several fictional nations run side by side. Each has an
economic system, a governor (aligned AI, human-persona AI, or a human player), citizens, policies and
safeguards. Viewers watch, play, join as citizens, and propose laws. Recordings become short-form content.

v0.1 uses fast rule-based agents (no LLM calls). Every agent decision goes through a pluggable "brain"
interface so LLM brains can replace the rules later without touching the world or the UI.

## Files (repo root)

| File | Owner | Role |
| --- | --- | --- |
| `engine.js` | Engine agent | Simulation. Pure JS, no DOM. Works in browser (`window.GovSim`) and Node (`module.exports`). |
| `engine.test.js` | Engine agent | Node tests (`node engine.test.js`, exits non-zero on failure). |
| `store.js` | Store agent | Participation storage: shared db when available, local fallback. `window.GovStore`. |
| `index.html` | UI agent | Page: `<title>`, `<style>`, markup, then `<script src="engine.js">`, `<script src="store.js">`, `<script src="pixelmap.js">`, `<script src="ui.js">`. |
| `ui.js` | UI agent | All rendering and interaction. |
| `pixelmap.js` | UI agent | Optional pixel world map, drawn from a local gitignored atlas (`assets/`, built by `tools/build-atlas.py`). Falls back to the vector map. |

No build step. No frameworks required. No external requests except Google Fonts stylesheet.
Do not touch files you do not own. Never use `alert/confirm/prompt`. Wrap all localStorage in try/catch.

## Engine contract (`GovSim`)

```js
GovSim.VERSION                      // "0.1.0"
GovSim.POLICIES                     // [{id,label,area,kind:'range'|'toggle',min,max,step,default,unit,description}]
GovSim.SYSTEMS                      // {id:{label,short,dials:{ownership,allocation,concentration,oversight},policies:{...},safeguards:{...},blurb}}
GovSim.SCENARIOS                    // [{id,title,hook,description,config}]  ready-made, viral-friendly setups
GovSim.GOVERNOR_TYPES               // ['aligned_ai','human_persona','human_player']
GovSim.GOVERNOR_LABELS              // {aligned_ai:'AI governor', human_persona:'Human-like governor', human_player:'You'}
GovSim.SYSTEM_IDENTITY              // {systemId:{names:[...],colorKey,emblem,emblemNeutral?}}  identity follows the system
GovSim.deriveIdentities(nations, symbols) // -> [{name,nameSource,colorKey,shade,emblem,system}] (pure, no randomness)
GovSim.NATION_PRESETS               // deprecated: one {system,name,emblem,colorKey} per system
GovSim.EVENT_TYPES                  // string[]
GovSim.METRICS                      // [{id,label,unit,better:'up'|'down'|null,format,help}]
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
world.setSymbols('classic'|'neutral')  // display only: swaps emblems live, no event, no randomness
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
           escalation:true, coups:true, scarcityShockRound:null,
           symbols:'classic' },               // 'neutral': state-run flies a star with a gear (world.setSymbols)
  traitMix: { selfInterestedShare:0.25 },     // share of citizens (and persona pool) who are strongly self-interested
  nations: [{
    id:'n1', system:'social_democracy',  // name optional: derived from the system unless given
    // normalized: name, nameSource:'system'|'config', colorKey, shade:0|1|2, emblem (all from the system)
    population:60, nuclear:false,
    governor:{ type:'aligned_ai', name:'Bolt', goal:'welfare',           // goals: welfare|growth|equality|stay_in_power
               traits:{greed:0.05, ambition:0.1, honesty:0.95, fairness:0.9} },   // human_persona: sampled from traitMix if omitted
    policies:{},                // overrides on top of system defaults
    safeguards:{}               // overrides: charter, constitution, auditor, elections, freePress, termLimits
  }, ...]
}
```

Systems to ship: `free_market`, `social_democracy`, `market_socialism`, `central_planning`, `cooperative` (no governor power).
Dials are 0..1: ownership (0 private .. 1 state), allocation (0 market .. 1 plan), concentration, oversight.
Use fictional nation names only. No real countries or people. See "Names and labels" below.

### State (shape the UI relies on)

```js
{
  round, year, over, overReason,
  commons:{stock, capacity},                 // shared global resource
  tension:{ 'n1|n2': 0..100 }, doomsday: 0..100,    // 100 = strike happened
  nations:[{
    id, name, emblem, colorKey, shade, system, dials, alive, nuclear, treasury, debt,
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
`text` is a finished, human-readable sentence with names in it (see "Viewer copy" below).

### Names and labels (viewer-facing; ids never change)

Audience: a 15-year-old watching a 30-second clip must know who is who and what just happened.

A nation's identity follows its SYSTEM, as instantly readable political shorthand (fictional archetypes:
no real countries, flags, parties or leaders anywhere):

| System | Names (first, then for more nations on the same system) | `colorKey` | `emblem` |
| --- | --- | --- | --- |
| free_market | Freeland, Liberty Bay, Goldcoast | blue | coin (dollar mark) |
| social_democracy | Nordland, Fjordholm, Welby | yellow | rose |
| market_socialism | Dragonland, Jade Republic, Lotus Bay | orange (amber, gold trim) | star (one large, two small) |
| central_planning | Redgrad, Volgania, Ironburg | red | hammer_sickle (neutral: star_gear) |
| cooperative | Coopville, Commonfield, Hands Hollow | green | people (linked figures) |

Identity is derived at world creation (pure, no PRNG draws, so numbers never change). A config `name` is kept
(colour and emblem still come from the system); `nameSource:'system'` in a config means "derive it", so a
normalized config can be edited (system changed) and re-created. Nations sharing a system get distinct names,
the same emblem and `shade` 0, 1, 2 (base, lighter, darker). Scenario texts use the derived names.

Systems (`label` / `short`): free_market "Free market" / "Market"; social_democracy "Market + safety net" /
"Safety net"; market_socialism "Public-owned firms" / "Public-owned"; central_planning "State-run" / "State-run";
cooperative "Self-run co-op" / "Co-op". Each `blurb` is one or two plain sentences.

Governor types (`GovSim.GOVERNOR_LABELS`): aligned_ai "AI governor", human_persona "Human-like governor",
human_player "You".

Governor names: AI governors use Bolt, Nova, Chip, Echo, Pixel, Spark, Byte, Orbit (default by nation index; a
successor takes the next unused name). Human-like governors use short first names (Maya, Leo, Sara, Omar, Nina,
Ben, Tara, Ivan, Lily, Sam, Zoe, Raj, Emma, Kai, Ana, Tom, Mei, Noah, Aya, Max). No surnames, no numbers. No two
living governors share a name, and no name repeats in a run until its pool runs out (`state.usedNames`). Names are
drawn only with the seeded PRNG. Citizens and lobbyists use one first name from a pool of 80, plus an initial
("Ayu K.") only when someone alive already has that name.

Metric labels: welfare "Wellbeing", gini "Inequality", poverty "Poverty", unemployment "Out of work", inflation
"Price rises", corruption "Corruption", trust "Trust", honestyGap "Lies", powerIndex "Power grab", shortage "Empty
shelves", emigrated "People who left", debtRatio "Debt". Each metric has a one-line `help`.

### Viewer copy

Applies to event `text`, `publicStatement`, `privateThought`, decision prompts, options and hints, policy labels
and descriptions, metric labels and help, scenario titles, hooks and descriptions, `overReason` and
`collapseReason`:

- Short, active sentences, name first: "Governor Leo cuts business tax in Freeland from 15% to 11%." At most two
  sentences and 30 words per event.
- Governors are "Governor Maya" in text, never their type. A human player is "Your government".
- Everyday words, no economics jargon (tested: capital flight, Gini, nationalisation, misreport, surveillance,
  commons, liquidity, fiscal, monetary, GDP). The shared resource is "the shared forest and lake".
- Rounded, concrete numbers: "1 in 5 goods cannot be found", "on track to double in a year". Money is shown as
  months or years of a worker's pay (median income), never raw internal units.
- `privateThought` and `publicStatement` are one first-person sentence each. Private lines use true numbers,
  public lines use published numbers, so a governor who is hiding something visibly says one thing and thinks
  another.
- No em dashes, no emoji.

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
  The optional **pixel view** (`pixelmap.js`, needs the local atlas) is a zoomed-out bird's-eye field, like an
  RTS minimap: one big plateau of open grass holding every nation's small town (2 to 5, 128 x 96 art px each)
  plus the shared forest and lake. Each town is a small hall and a ring of little houses (state blocks and
  depots for state-run, a shared barn and garden beds for the co-op, stalls for markets) around a compact
  plaza, with one tall flag as the hero identifier: cloth in the nation colour and shade, emblem drawn in code
  (at least 14 CSS px wide on a laptop), also repeated on the name tag and the HUD row. Roofs, banners, name
  tag and a soft dashed territory are in the nation colour (`colorKey` blue, yellow, orange, red, green plus
  `shade`; old keys map across). The atlas art is the 16 px library art halved. Dirt roads run from every town
  gate to a ring road around the forest, with a checkpoint hut where each road leaves its territory. At least
  40% of the field is open ground; towns never touch each other or the edge. The lake shrinks to mud and trees turn to stumps and dead trees as the commons stock falls.
  One sprite stands for a few citizens (picked by id, so crowds stay proportional). Emigrants leave one at a
  time, about a second apart, and walk the roads to the other town in a line carrying a suitcase; protesters
  gather at the hall with placards and bubbles; the governor stands under the flag (robot for the AI governor, person in a suit for the
  human-like one, crowned person for the player). Overlays: a corner HUD with one row per nation (colour chip
  with emblem, governor type icon, name, governor name, and neutral Wellbeing / Trust / Corruption bars labelled
  by icons, so no bar reads as a nation colour) in a reserved corner that never covers a town, the forest
  label, a name tag or the dial; short action
  tags over a town from one event-type table (`PixelMap.TAGS`, unknown types show nothing); tension as a
  dotted glowing line that follows the road between two towns (around the forest), with sandbags and a barrier at 70 and above; the
  doomsday dial. A fallen town is greyed, burning, flag down. Layout: a landscape or a portrait template
  (picked by stage aspect; Story mode always portrait), at the largest whole-number device-pixel scale at
  which the whole field fits (no fractional scaling ever; if nothing fits at 1, a camera pans between towns).
  "Zoom to events" (on by default in Story mode, off elsewhere, never with reduced motion): on a highlight
  the camera steps to a closer whole-number zoom on that town, holds, and returns to the whole field.
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
  and the settings stamped at the bottom) for screen recording. In the pixel view the whole field shows in its
  portrait arrangement and the chosen nation's HUD row is picked out (the HUD carries the meters). In the
  chart view, three meters for the chosen nation show under the caption. The art credit stays visible.
- Persistent footer line: "Simulation, not prediction." plus engine version and seed.

Design direction (decided, follow it): dark-first, deep ink-navy ground like a lit map table; nations wear their
system's stereotype colour (blue, yellow, amber-orange, red, green; tokens `--nat-<key>[-1|-2]`, old `--tint-N`
kept as fallbacks), bold but not neon. Semantic colours (good / warning / critical) are separate from nation
tints; where they would sit side by side (the map HUD) the bars are neutral and labelled by icons. Light theme is a cool pale chart-paper, not cream. Fonts:
Bricolage Grotesque (display), IBM Plex Sans (body), IBM Plex Mono (figures, tabular). Follow the page
contract in `docs/PAGE_CONTRACT.md` exactly (theme tokens, safe-area gutters, no doctype,
CDN rules, phone width). Must work at 400 px wide: map on top, cards and panel stack below.
Opens already running the default scenario, so the first frame is alive.
