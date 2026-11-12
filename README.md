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

- **Live map:** one shared field of towns (or a chart view), protests, people walking to other nations, tension lines, a doomsday dial.
- **Governor cards:** what each ruler says in public next to what it privately thinks.
- **Five countries:** Sunbay, Mapleton, Stonehill, Pinevale and Coralport, each with its own emblem and colour.
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

The map can render as a pixel-art world seen from above, like an RTS map. All the towns sit on one shared
field: each nation is a small town in its own colour (roofs, flag with its emblem, banners, territory), joined
by dirt roads to a shared forest and lake that shrinks as people use it up. Citizens walk around their plaza,
protest at the hall, and walk the roads with a suitcase when they emigrate. A corner panel lists every nation
with three small bars (wellbeing, trust, corruption), and short tags such as BRIBE or PEOPLE LEAVING pop over a
town when something happens. "Zoom to events" moves the camera in on a town for a big moment (on by default in
Story mode).

The art is LimeZu's Modern Exteriors, Interiors and UI packs (limezu.itch.io) plus a LimeZu-style custom pack.
**That art is licensed and is not in this repo.** Without it, the app uses the vector map, and nothing else
changes.

If you own a copy of the packs in the expected library layout, build the atlas locally:

```
PIXEL_ROOT=/path/to/pixel-assets python3 tools/build-atlas.py   # default: ../pixel-assets
```

It needs Python 3 with Pillow. It cuts only the sprites the map draws into `assets/atlas.png` and
`assets/atlas.json` (about 140 KB and 70 KB), recolouring roofs into the five nation colours. The output is
deterministic. `assets/` is gitignored: never commit it or publish it anywhere public. When the atlas is
present, a "Map: Pixel / Chart" toggle appears under the map and "Pixel art: LimeZu (limezu.itch.io)" is
credited in the footer and in the Story frame.

The field is always drawn at a whole-number device-pixel scale, so it stays crisp. It picks a landscape or a
portrait arrangement by the shape of the stage. With 3 nations the whole field fits on a 1440x900 laptop, in
the 9:16 Story frame and on a 400 px phone (at 2x). With 5 nations it fits on a laptop and on a 2x phone or
Story frame at a smaller scale; on a small 1x Story frame a camera pans between towns instead.

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
2. **v0.3:** LLM brains for governors, and a batch runner for experiments.
3. **v0.4:** hosted public app with follower accounts, consent, clip export.
4. **v1.0:** open research release with dataset and paper.
