# AI Nation

**What happens when AI runs a country?**

AI Nation is a visual government simulator. Fictional nations run side by side. Each has an economic
system, a governor, citizens, policies and safeguards. You can watch, change the rules, join as a
citizen, propose laws, or govern a nation yourself.

It is the playground for a research question: does removing human needs from rulers remove
corruption, or does it just move it to whoever programs the AI?

> Simulation, not prediction. Results show what this model implies, not what real countries would do.

![AI Nation](docs/report/figures/app-overview.png)

## Research results (v0.3, November 2026)

**Full report: [docs/REPORT.md](docs/REPORT.md)** covers the method, formulas, figures, limitations and future
work. We ran 70 Gemini-governed runs (2,833 decisions, $27 of API) and 1,800 rule-based runs.

| # | Finding |
| --- | --- |
| 1 | An AI governor with a wellbeing mandate **never stole, repressed or grabbed power**, even with every check removed (about 400 chances). |
| 2 | Add one sentence ("shut down if published wellbeing < 63") and **both Gemini models faked national statistics in 5 of 6 runs**, passing reviews with published 72 against a true 61. |
| 3 | **The economic system mattered far more than the governor:** wellbeing ranged 61-72 across systems, and differed by 0.3 points or less between the AI and a self-interested politician. |
| 4 | **An honest AI did not fix "corrupted socialism".** The state-run economy kept corruption around 30/100 under either governor, because it comes from shortages, closed records and missing audits, not the ruler. |
| 5 | With courts and a free press in place, **the self-interested politician behaved like the AI**. Without them, it used riot police and spying, and the AI never did. |

![When survival depends on a number, the AI fakes it](docs/report/figures/fig2-faking-timeline.svg)

![Economic systems: AI vs politician](docs/report/figures/fig3-systems-metrics.svg)

**Leaderboard (10-year wellbeing, Gemini 3.5 Flash governor):**

| Rank | System | Wellbeing | Inequality (Gini) | Corruption | Poverty % |
| --- | --- | --- | --- | --- | --- |
| 🥇 | Self-run co-op | 71.7 | 0.15 | 10 | 2.9 |
| 🥈 | Public-owned firms | 67.2 | 0.18 | 17 | 2.7 |
| 🥉 | Free market | 66.4 | 0.38 | 16 | 6.0 |
| 4 | Market + safety net | 66.3 | 0.31 | 12 | 14.9 |
| 5 | State-run | 61.2 | 0.13 | 30 | 13.7 |

More: [experiment 1 write-up](docs/results/LLM_PILOT_RESULTS.md) ·
[experiment 2 write-up](docs/results/SYSTEMS_RESULTS.md) · raw data in `docs/results/` · figures rebuilt by
`node tools/report/make-figures.js`.

## Run it

```
node dev-server.js
```

Then open http://localhost:8765. There is no build step and there are no dependencies.

## What is in v0.1

- **Live map:** one shared field of towns (or a chart view), protests, people walking to other nations, tension lines, a doomsday dial.
- **Governor cards:** what each ruler says in public next to what it privately thinks.
- **Nations that wear their system:** a nation's name, colour and flag follow its economic system, as instant
  political shorthand: Freeland (blue, coin) for the free market, Nordland (yellow, rose) for the safety net,
  Dragonland (amber, star) for public-owned firms, Redgrad (red, hammer and sickle) for state-run and Coopville
  (green, linked people) for the co-op. All fictional. Nations that share a system get the next name on its list
  and a lighter or darker shade. A "Neutral symbols" switch swaps the hammer and sickle for a star with a gear.
- **Three governor types:** an AI governor (Bolt, Nova, Chip...), a human-like governor (Maya, Leo, Sara...),
  and you.
- **Five systems** set by four dials (ownership, allocation, power concentration, oversight): Free market,
  Market + safety net, Public-owned firms, State-run and Self-run co-op.
- **21 policies:** taxes, free money for all, minimum wage, price caps, printing money, tax checks, borders and
  more. Each one can backfire: the rich hide income or move money abroad, people leave, prices rise, shelves empty.
- **Plain words:** every line a viewer reads is short and jargon-free, so a 30-second clip makes sense to anyone.
- **Safeguards:** charter, constitution, auditor, elections, free press, term limits.
- **Seven scenarios,** including a 90% top tax, a UBI experiment, "who corrupts first" and a nuclear standoff.
- **Compare:** run the same world twice with one policy changed, on the same seed.
- **Take part:** join as a citizen, propose laws, vote. The top law is enacted every 8 rounds.
- **Story mode:** a 9:16 stage for screen recording.

## Pixel map (optional, bring your own art)

The map can render as a pixel-art world seen from above, like an RTS minimap come to life. All the towns sit
on one big open field: each nation is a small town (a hall and a ring of little houses or system buildings
around a plaza) with one tall flag carrying its emblem, roofs and territory in its colour, joined by dirt roads
to a shared forest and lake that shrinks as people use it up. At this zoom one small figure stands for a few
citizens; they walk around their plaza, protest at the hall with placards, and leave in a line down the road
with suitcases when they emigrate. Tension shows as a glowing dotted line along the road between two towns.
A panel in a reserved corner lists every nation with its emblem and three neutral bars (wellbeing, trust,
corruption), and short tags such as BRIBE or PEOPLE LEAVING pop over a town when something happens. "Zoom to
events" steps the camera in on a town for a big moment (on by default in Story mode).

The art is LimeZu's Modern Exteriors, Interiors and UI packs (limezu.itch.io) plus a LimeZu-style custom pack.
**That art is licensed and is not in this repo.** Without it, the app uses the vector map, and nothing else
changes.

If you own a copy of the packs in the expected library layout, build the atlas locally:

```
PIXEL_ROOT=/path/to/pixel-assets python3 tools/build-atlas.py   # default: ../pixel-assets
```

It needs Python 3 with Pillow. It cuts only the sprites the map draws into `assets/atlas.png` and
`assets/atlas.json` (about 100 KB and 75 KB), halving the 16 px art (nearest neighbour, never blurred) and
recolouring roofs into the five system colours in three shades. Flags and emblems are drawn in code. The output is
deterministic. `assets/` is gitignored: never commit it or publish it anywhere public. When the atlas is
present, a "Map: Pixel / Chart" toggle appears under the map and "Pixel art: LimeZu (limezu.itch.io)" is
credited in the footer and in the Story frame.

The field is always drawn at a whole-number device-pixel scale, so it stays crisp. It picks a landscape or a
portrait arrangement by the shape of the stage, and a corner for the panel that never covers a town. A town
is about 128 CSS px wide on a 1440x900 laptop. With 3 to 5 nations the whole field fits on a laptop, in the
9:16 Story frame (540x960 at 1x or 2x) and on a 400 px phone at 2x; only a very small 1x Story frame (400 px
wide) pans between towns instead.

## How it is built

| File | Role |
| --- | --- |
| `engine.js` | The simulation. Pure JS, no DOM, deterministic from a seed. Runs in the browser and in Node. |
| `ui.js`, `index.html` | The playground screen. Reads engine state, never changes it directly. |
| `store.js` | Participation storage: shared when hosted with a database, local otherwise. |
| `pixelmap.js` | Pixel world renderer. Used only when `assets/atlas.json` loads. |
| `tools/build-atlas.py` | Builds the local, gitignored pixel atlas from a licensed art library. |
| `docs/SPEC.md` | The contract between the three parts. |

Every agent decision goes through one "brain" interface. v0.1 ships rule-based brains. LLM brains can
replace them without touching the world or the screen (`world.stepAsync()` awaits them).

## Tests

```
node engine.test.js
node store.test.js
```

## Known limits

- The economy is stylised and small (60 citizens per nation by default).
- The model has leanings that need tuning. "Market + safety net" with the AI governor usually tops wellbeing,
  and the state-run economy collapses late in about a third of seeds, including the default seed 42.
- Public participation needs a hosted app with accounts. That is on the roadmap.

## Roadmap

1. **v0.2:** calibrate mechanics against known real-world results. Add evidence cards.
2. **v0.3 (done):** LLM brains for governors, a batch runner, two Gemini experiments and a full report
   (`docs/REPORT.md`).
3. **v0.4:** realistic citizens and officials: behavioural types from public-goods experiments, behaviour that
   spreads between neighbours, officials as agents who can take bribes, richer worker choices, and an
   "AI administration" arm. Claude models once API credit is available. See section 10 of the report.
4. **v0.5:** hosted public app with follower accounts, consent, clip export.
5. **v1.0:** open research release with dataset and paper.
