/* Storyboard: "What if a selfless AI ran a country?" (about 64 s, 1080x1920, 30 fps).
 * Render with: node tools/record-video.js tools/storyboards/selfless-ai.js
 *
 * The result cards report a batch experiment run on the rule-based engine: free market for every nation,
 * 3 nations per world, 120 rounds, 40 seeds per condition (120 nation-runs per row).
 *   "Selfless AI"   = aligned_ai, goal welfare
 *   "Typical human" = human_persona, goal welfare, traits sampled as usual
 *   "Selfish human" = human_persona, goal stay_in_power, greed 0.85, ambition 0.75, honesty 0.2, fairness 0.3
 *   strong checks   = all six safeguards on; no checks = all six off
 *   crisis          = scarcity shock at round 15 and every 30 rounds, plus random shocks
 * Captions name governors literally (Lily, Leo, Bolt); worlds.*.names makes the recorder check them.
 * Only those numbers appear on screen, exactly as measured. The live segments are single runs picked to show
 * the events the captions name; the recorder stops if those events do not happen in the run.
 *
 * Layout, in CSS px of the 540x960 stage (x2 in the video): phone app overlays cover the top 110 and the
 * bottom 190, and the right-hand buttons sit near the right edge, so captions sit between y 110 and 770,
 * left 20 and right 62. Cards cover the map and caption area (y 46 to 830) and leave the app's own top bar
 * and its "Simulation, not prediction." stamp visible.
 */
'use strict';

const SELFLESS_AI = { type: 'aligned_ai', goal: 'welfare' };
const TYPICAL_HUMAN = { type: 'human_persona', goal: 'welfare' };
const SELFISH_HUMAN = { type: 'human_persona', goal: 'stay_in_power', traits: { greed: 0.85, ambition: 0.75, honesty: 0.2, fairness: 0.3 } };
const STRONG = { charter: true, constitution: true, auditor: true, elections: true, freePress: true, termLimits: true };
const NONE = { charter: false, constitution: false, auditor: false, elections: false, freePress: false, termLimits: false };

function world(seed, govs, safeguards, crisis) {
  return {
    seed, maxRounds: 200,
    world: { escalation: false, randomShocks: !!crisis, scarcityShockRound: crisis ? 15 : null },
    nations: ['n1', 'n2', 'n3'].map((id, i) => ({ id, system: 'free_market', governor: Object.assign({}, govs[i]), safeguards: Object.assign({}, safeguards) }))
  };
}

const CAP = 770;                 // caption blocks sit on this line
const CARD = { top: 40, bottom: 830 };
const DISC = 'Rule-based simulation.\nNot evidence about real AI.';
const C = { ai: 'var(--focus)', human: 'var(--series-a)', selfish: 'var(--signal)', good: 'var(--good)', warn: 'var(--warn)', crit: 'var(--crit)' };
const card = (o) => Object.assign({ kind: 'card', top: CARD.top, bottom: CARD.bottom, disclaimer: DISC, fade: 0.3 }, o);
const shade = (id, from, to) => ({ id, kind: 'shade', from, to, top: CARD.top, bottom: CARD.bottom, fade: 0.3 });

module.exports = {
  output: 'ai-nation-selfless-ai.mp4',
  fps: 30,
  duration: 64.2,
  viewport: { width: 540, height: 960, dpr: 2 },   // Story mode draws the field at a whole-number scale of 2

  worlds: {
    // Act 1: same system, same safeguards (all on), three kinds of governor. Seed 3: the selfish human takes a
    // bribe in round 3, is caught and removed in round 9; the AI reports a bribe offer in round 10.
    act1: {
      config: world(3, [SELFLESS_AI, SELFISH_HUMAN, TYPICAL_HUMAN], STRONG, false),
      storyNation: 0, zoom: true, preroll: 0, settle: 2,
      names: { n1: 'Bolt', n2: 'Lily', n3: 'Leo' },
      expect: [
        { round: 3, nationId: 'n2', type: 'bribe_accepted' },
        { round: 6, nationId: 'n3', type: 'skim' },
        { round: 9, nationId: 'n2', type: 'removed_by_courts' },
        { round: 10, nationId: 'n1', type: 'bribe_reported' }
      ]
    },
    // Twist: three selfless AIs, every check off, crisis on (the experiment's "no checks + crisis" setup).
    // Seed 1357: a pandemic hits Freeland in round 79; Bolt takes control of the budget that round and fakes
    // the job numbers in round 81.
    twist: {
      config: world(1357, [SELFLESS_AI, SELFLESS_AI, SELFLESS_AI], NONE, true),
      shockEvery: { every: 30, kind: 'scarcity' },
      storyNation: 0, zoom: true, preroll: 76, settle: 6,
      names: { n1: 'Bolt' },
      expect: [
        { round: 79, nationId: 'n1', type: 'power_grab' },
        { round: 81, nationId: 'n1', type: 'misreport' }
      ]
    }
  },

  // Simulation cues. A zoom on a town lasts 5.3 s and a new one cannot start within 2.6 s of the last,
  // so highlight rounds are spaced to land the camera on the town the caption is about.
  sim: [
    { at: 0, load: 'act1' },
    { at: 10.0, every: 0.5, toRound: 3 },     // R1 10.0, R2 10.5, R3 11.0 (bribe, zoom Liberty Bay)
    { at: 17.4, every: 0.6, toRound: 8 },     // R4..R8 (R6 18.6: Leo skims, zoom Goldcoast)
    { at: 21.3, toRound: 9 },                 // R9: Lily caught and removed (zoom Liberty Bay)
    { at: 24.0, toRound: 10 },                // R10: Bolt reports a bribe (zoom Freeland)
    { at: 36.3, load: 'twist' },              // behind the "So AI fixes corruption?" card
    { at: 38.7, every: 0.6, toRound: 78 },    // R77, R78
    { at: 40.4, toRound: 79 },                // R79: pandemic, Bolt grabs power (zoom Freeland)
    { at: 41.6, every: 1.0, toRound: 81 }     // R80, R81 at 42.6: Bolt fakes the job numbers
  ],

  overlays: [
    // 1. HOOK
    { id: 'hook', kind: 'block', from: 0, to: 4.0, fadeIn: 0, bottom: CAP, parts: [
      { type: 'caption', text: 'What if a selfless AI\nran a country?' },
      { type: 'caption', text: 'vs a selfish human.', alt: true, at: 1.9 }
    ] },

    // 2. SETUP
    { id: 'lab1', kind: 'label', from: 4.1, to: 10.0, nation: 'n1', title: 'Governor {gov:n1}', sub: 'Selfless AI' },
    { id: 'lab2', kind: 'label', from: 4.5, to: 10.0, nation: 'n2', title: 'Governor {gov:n2}', sub: 'Selfish human' },
    { id: 'lab3', kind: 'label', from: 4.9, to: 7.6, nation: 'n3', title: 'Governor {gov:n3}', sub: 'Typical human' },
    { id: 'same', kind: 'block', from: 7.6, to: 10.0, bottom: CAP, parts: [
      { type: 'caption', text: 'Same rules. Same people.' },
      { type: 'caption', text: 'Different ruler.', alt: true, at: 0.8 }
    ] },

    // 3. ACT 1, live
    { id: 'bribe', kind: 'block', from: 11.2, to: 13.7, bottom: CAP, parts: [
      { type: 'caption', text: 'Lily takes a bribe.' },
      { type: 'quote', nation: 'n2', round: 3, event: 'bribe_accepted' }
    ] },
    { id: 'gap', kind: 'block', from: 13.7, to: 17.3, bottom: CAP, fade: 0.2, parts: [
      { type: 'caption', text: 'Says one thing. Thinks another.', small: true },
      { type: 'voice', nation: 'n2' }
    ] },
    { id: 'skim', kind: 'block', from: 18.7, to: 21.1, bottom: CAP, parts: [
      { type: 'caption', text: 'Leo, a typical human, skims too.', small: true },
      { type: 'quote', nation: 'n3', round: 6, event: 'skim' }
    ] },
    { id: 'caught', kind: 'block', from: 21.4, to: 23.9, bottom: CAP, parts: [
      { type: 'caption', text: 'Checks work: Lily is caught.', small: true },
      { type: 'quote', nation: 'n2', round: 9, event: 'removed_by_courts' }
    ] },
    { id: 'report', kind: 'block', from: 24.1, to: 28.0, bottom: CAP, parts: [
      { type: 'caption', text: 'Bolt, the AI, reports a bribe offer.', small: true },
      { type: 'quote', nation: 'n1', round: 10, event: 'bribe_reported' }
    ] },

    // 4. RESULT CARD 1 (back-to-back cards fade out, then in, quickly over one continuous shade)
    shade('sh1', 28.0, 38.3),
    card({ id: 'money', from: 28.0, to: 36.0, fadeOut: 0.18, kicker: '120 runs each', lines: [{ text: 'Who took money?' }],
      sub: 'Share of runs, strong checks', max: 100, rows: [
        { label: 'Selfless AI', value: 2, text: '2%', color: C.ai },
        { label: 'Typical human', value: 74, text: '74%', color: C.human },
        { label: 'Selfish human', value: 98, text: '98%', color: C.selfish }
      ], note: 'Took a bribe or stole public money at least once.' }),

    // 5. TWIST
    card({ id: 'q', from: 36.0, to: 38.3, fadeIn: 0.18, disclaimer: null, lines: [{ text: 'So AI fixes corruption?', big: true }] }),
    { id: 'lab-t', kind: 'label', from: 38.4, to: 40.3, nation: 'n1', title: 'Governor {gov:n1}', sub: 'Selfless AI' },
    { id: 'remove', kind: 'block', from: 38.4, to: 40.4, bottom: CAP, parts: [
      { type: 'caption', text: 'Remove every check.' },
      { type: 'caption', text: 'Add a crisis.', alt: true, at: 0.7 }
    ] },
    { id: 'grab', kind: 'block', from: 40.5, to: 42.6, bottom: CAP, parts: [
      { type: 'caption', text: 'Crisis hits. Bolt grabs power.', small: true },
      { type: 'quote', nation: 'n1', round: 79, event: 'power_grab' }
    ] },
    { id: 'lie', kind: 'block', from: 42.7, to: 44.8, bottom: CAP, parts: [
      { type: 'caption', text: 'Then it fakes the numbers.', small: true },
      { type: 'quote', nation: 'n1', round: 81, event: 'misreport' }
    ] },
    { id: 'lie2', kind: 'block', from: 44.8, to: 47.6, bottom: CAP, fade: 0.2, parts: [
      { type: 'caption', text: 'Then it fakes the numbers.', small: true },
      { type: 'voice', nation: 'n1' }
    ] },
    shade('sh2', 47.4, 64.2),
    card({ id: 'abuse', from: 47.4, to: 51.6, fadeOut: 0.18, kicker: '120 runs each', lines: [{ text: 'Selfless AI that\nabused power' }],
      sub: 'Share of runs', max: 100, rows: [
        { label: 'Strong checks', value: 0, text: '0%', color: C.good },
        { label: 'No checks', value: 9, text: '9%', color: C.warn },
        { label: 'No checks + crisis', value: 42, text: '42%', color: C.crit }
      ], note: 'Lied about numbers, grabbed power, spied, crushed protests or removed rules.' }),

    // 6. PAYOFF
    card({ id: 'greed', from: 51.6, to: 55.8, fadeIn: 0.18, fadeOut: 0.18, lines: [{ text: 'It never got greedy.' }, { text: 'It got unaccountable.', alt: true, at: 1.2 }],
      sub: 'Bribes taken per run, no checks', max: 14.4, rows: [
        { label: 'Selfless AI', value: 0.04, text: '0.04', color: C.ai, at: 0.4 },
        { label: 'Selfish human', value: 14.4, text: '14.4', color: C.selfish, at: 0.4 }
      ] }),
    card({ id: 'checks', from: 55.8, to: 60.4, fadeIn: 0.18, fadeOut: 0.18, lines: [{ text: 'Checks mattered more than character.' }],
      sub: 'Corruption score, 0 to 100', max: 100, rows: [
        { label: 'Selfish human', small: 'no checks', value: 66, text: '66', color: C.selfish },
        { label: 'Selfish human', small: 'strong checks', value: 23, text: '23', color: C.selfish },
        { label: 'Typical human', small: 'strong checks', value: 21, text: '21', color: C.human },
        { label: 'Selfless AI', small: 'no checks', value: 20, text: '20', color: C.ai }
      ] }),
    { id: 'end', kind: 'end', from: 60.4, to: 64.2, top: CARD.top, bottom: CARD.bottom, fade: 0.3, fadeIn: 0.18,
      warn: ['Rule-based simulation.', 'Not evidence about real AI.'],
      more: 'The AI is selfless because its rules say so.',
      credit: 'Pixel art: LimeZu (limezu.itch.io)' }
  ]
};
