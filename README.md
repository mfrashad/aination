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

## How it is built

| File | Role |
| --- | --- |
| `engine.js` | The simulation. Pure JS, no DOM, deterministic from a seed. Runs in the browser and in Node. |
| `ui.js`, `index.html` | The playground screen. Reads engine state, never changes it directly. |
| `store.js` | Participation storage: shared when hosted with a database, local otherwise. |
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
