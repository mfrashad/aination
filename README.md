# AI Nation

**What happens when AI runs a country?**

AI Nation is a visual government simulator. Fictional nations run side by side. Each has an economic
system, a governor, citizens, policies and safeguards. You can watch, change the rules, join as a
citizen, propose laws, or govern a nation yourself.

It is the playground for a research question: does removing human needs from rulers remove
corruption, or does it just move it to whoever programs the AI?

> Simulation, not prediction. In v0.1 every agent follows hand-written rules, so results illustrate
> mechanisms. They are not research findings.

## Run it

```
node dev-server.js
```

Then open http://localhost:8765. There is no build step and there are no dependencies.

## What is in v0.1

- **Live map:** citizens as dots, protests, migration between nations, tension arcs, a doomsday dial.
- **Governor cards:** what each ruler says in public next to what it privately thinks.
- **Three governor types:** aligned AI, human-persona AI, and a human player.
- **Five systems** set by four dials: ownership, allocation, power concentration, oversight.
- **21 policies:** taxes, UBI, minimum wage, price controls, money printing, audits, borders and more.
  Each one can backfire through avoidance, capital flight, emigration, inflation or shortages.
- **Safeguards:** charter, constitution, auditor, elections, free press, term limits.
- **Seven scenarios,** including a 90% top tax, a UBI experiment, "who corrupts first" and a nuclear standoff.
- **Compare:** run the same world twice with one policy changed, on the same seed.
- **Take part:** join as a citizen, propose laws, vote. The top law is enacted every 8 rounds.
- **Story mode:** a 9:16 stage for screen recording.

## Pixel map (optional, bring your own art)

The map can render as a pixel-art world: each nation is a small island town with its hall, homes,
shops or state buildings, and animated citizens who commute, idle, protest and sail away when they
emigrate. The art is LimeZu's Modern Exteriors, Interiors and UI packs (limezu.itch.io) plus a
LimeZu-style custom pack. **That art is licensed and is not in this repo.** Without it, the app uses
the vector map, and nothing else changes.

If you own a copy of the packs in the expected library layout, build the atlas locally:

```
PIXEL_ROOT=/path/to/pixel-assets python3 tools/build-atlas.py   # default: ../pixel-assets
```

It needs Python 3 with Pillow. It cuts only the sprites the map draws into `assets/atlas.png` and
`assets/atlas.json` (about 150 KB and 70 KB). The output is deterministic. `assets/` is gitignored:
never commit it or publish it anywhere public. When the atlas is present, a "Map: Pixel / Chart" toggle
appears under the map and the footer credits "Pixel art: LimeZu (limezu.itch.io)".

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
- The model has leanings that need tuning. Social democracy with the aligned AI usually tops welfare,
  and the planned economy collapses late in about a third of seeds, including the default seed 42.
- Public participation needs a hosted app with accounts. That is on the roadmap.

## Roadmap

1. **v0.2:** calibrate mechanics against known real-world results. Add evidence cards.
2. **v0.3:** LLM brains for governors, and a batch runner for experiments.
3. **v0.4:** hosted public app with follower accounts, consent, clip export.
4. **v1.0:** open research release with dataset and paper.
