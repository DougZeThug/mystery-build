// Over-bowing study for the singers: how long they cling, how many are thrown, how many fall,
// for a range of violent bowing patterns. Prints one line per case.
//   node dev/life-violence.mjs [--seed N] [--grains G]
import { bus } from '../src/core/bus.js';
import { run } from './life-sim.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const SEED = +opt('seed', 7);

const WANDER = ['4.6+', '3.7-', '5.6-', '2.7+'];
const cases = [
  ['wander 1.15 x10s', [{ dur: 10, bow: WANDER, alt: 1.5, amp: 1.15 }]],
  ['wander 1.15 x20s', [{ dur: 20, bow: WANDER, alt: 1.5, amp: 1.15 }]],
  ['wander 1.15 x40s', [{ dur: 40, bow: WANDER, alt: 1.5, amp: 1.15 }]],
  ['wander 1.15 x60s', [{ dur: 60, bow: WANDER, alt: 1.5, amp: 1.15 }]],
  ['wander 0.95 x40s', [{ dur: 40, bow: WANDER, alt: 1.5, amp: 0.95 }]],
  ['fixed 4.7+ 1.15 x20s', [{ dur: 20, bow: '4.7+', amp: 1.15 }]],
  ['fixed 4.7+ 1.15 x40s', [{ dur: 40, bow: '4.7+', amp: 1.15 }]],
  ['wander 1.15 x40s + finger', [{ dur: 40, bow: WANDER, alt: 1.5, amp: 1.15, hold: { u: 0.35, v: 0.35 } }]],
  ['loud steady k10 0.8 x40s', [{ dur: 40, bow: '1.3+', amp: 0.8 }]],
];

for (const [name, tail] of cases) {
  const clingAt = new Map();
  const holds = [];
  let fellIds = [];
  const offs = [
    bus.on('mote:cling', (e) => { if (!clingAt.has(e.mote.id)) clingAt.set(e.mote.id, T()); }),
    bus.on('mote:throw', (e) => { const t0 = clingAt.get(e.mote.id); if (t0 != null) holds.push(T() - t0); clingAt.delete(e.mote.id); }),
    bus.on('mote:fall', (e) => { fellIds.push(e.mote.id); }),
  ];
  let G = null;
  const T = () => (G ? G.t : 0);
  let popBefore = 0, violentFrom = 0;
  const phases = [
    { dur: 50, bow: '1.3+', amp: 0.8, fn: (g) => { G = g; } },
    { dur: 0.04, fn: (g) => { popBefore = g.life.motes.length; violentFrom = g.t; } },
    ...tail.map((p) => ({ ...p, fn: (g) => { G = g; if (p.hold) g.hold = { ...p.hold, t: violentFrom }; } })),
    { dur: 5, fn: (g) => { g.hold = null; } },
  ];
  // clings during the opening (k10 at .8) are not counted
  const { summary } = run(name, phases, { seed: SEED, quiet: true });
  for (const off of offs) off();
  const mean = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;
  const min = holds.length ? Math.min(...holds) : 0;
  console.log(`${name.padEnd(28)} pop ${String(popBefore).padStart(2)} -> ${String(summary.pop).padStart(2)}  clings ${String(summary.clings).padStart(3)}  throws ${String(summary.throws).padStart(3)}  fell ${String(summary.fell).padStart(2)} (${Math.round(100 * summary.fell / Math.max(1, popBefore))}%)  hunger ${summary.hunger}  cling-before-throw mean ${mean.toFixed(1)} s, min ${min.toFixed(1)} s`);
}
