// Pacing harness: an informed player working toward the Floor (k = 5, 10, 20, 40), headless.
// For each missing k in the given order, bow (or strike and touch a fork for) its mode until a
// singer of it is born (or a time limit passes), rest, repeat. Prints how long each birth took.
//   node dev/life-chain.mjs [order=10,20,40,5] [--via bow|fork] [--seed N] [--limit S] [--max S]
//                           [--warm modeA,modeB --wait S]   (first raise a population: bow each 30 s, then wait)
// Bow amplitudes are what a real stroke on that mode can give (modes.bowPick only returns k=5 for
// slow strokes, and the bow's amp is .25 + .9·speed01); a fork drives .7, fading over 12 s, and is
// struck again each time it falls quiet.
import { bus } from '../src/core/bus.js';
import { makeGame } from './life-sim.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const order = (args.find((a) => !a.startsWith('--') && /^[\d,]+$/.test(a)) || '10,20,40,5').split(',').map(Number);
const VIA = opt('via', 'bow');
const SEED = +opt('seed', 7);
const LIMIT = +opt('limit', 120);
const MAX = +opt('max', 1500);
const AMP = { 5: 0.36, 10: 0.45, 20: 0.64, 40: 0.9 };
const MODE = { 5: '1.2+', 10: '1.3+', 20: '2.4+', 40: '2.6+' };
const FORK_S = 12;
const DIAG = args.includes('--diag');

const game = makeGame(SEED);
const { field, sand, life } = game;
const dt = 1 / 30;
let floorAt = null, choirAt = null, floorLeft = 0;
bus.on('mote:birth', () => { game.state.stats.births++; });
bus.on('life:choir', (e) => { if (e.on && choirAt === null) choirAt = game.t; });
bus.on('life:floor', (e) => {
  if (!e.on) return;
  if (floorAt === null) floorAt = game.t;
  field.setSource('floor', [{ mode: 'floor', amp: 1.2 }]); floorLeft = 18;
});
let fork = null, forkRest = 0;   // { mode, t0 }; a moment to strike it again
function step(bow) {
  if (bow) field.setSource('bow', [{ mode: bow, amp: AMP[Object.keys(MODE).find((k) => MODE[k] === bow)] }]);
  else field.setSource('bow', []);
  if (fork) {
    const age = game.t - fork.t0, amp = 0.7 * Math.pow(Math.max(0, 1 - age / FORK_S), 1.3);
    if (age >= FORK_S) { fork = null; forkRest = 1.5; field.setSource('fork', []); } else field.setSource('fork', [{ mode: fork.mode, amp }]);
  } else if (forkRest > 0) forkRest -= dt;
  if (floorLeft > 0) { floorLeft -= dt; if (floorLeft <= 0) { field.setSource('floor', []); bus.emit('floor:end', {}); } }
  field.setSource('chorus', life.chorus());
  field.update(dt); sand.update(dt); life.update(dt);
  game.t += dt;
}
const alive = (k) => life.populations().some((p) => !p.keeper && p.ks.includes(k));
const marks = [];
function advance(s, bow = null) { const n = Math.round(s / dt); for (let i = 0; i < n; i++) step(bow); }
const WARM = opt('warm', '');
if (WARM) {
  for (const md of WARM.split(',')) { AMP[md] = 0.8; MODE[md] = md; advance(30, md); }
  advance(+opt('wait', 120));
  const pops = life.populations().map((p) => `${p.id}:${p.count}`).join(' ');
  console.log(`warmed: pop ${life.motes.length} at ${Math.round(game.t)} s, kinds ${Object.keys(game.state.species).length}: ${pops}`);
}
while (game.t < MAX && floorAt === null) {
  let did = false;
  for (const k of order) {
    if (alive(k) || floorAt !== null) continue;
    did = true;
    const t0 = game.t;
    while (game.t - t0 < LIMIT && !alive(k)) {
      if (VIA === 'fork') {
        if (!fork && forkRest <= 0) fork = { mode: MODE[k], t0: game.t };   // strike, carry it over, touch
        advance(1);
      } else advance(1, MODE[k]);
      if (DIAG) {
        const c = field.coherence;
        console.log(`  ${Math.round(game.t)} k${k} dom ${c.dominant} share ${c.share.toFixed(2)} stable ${c.stable.toFixed(1)} total ${field.total.toFixed(2)} ` +
          `bow ${field.amp(MODE[k]).toFixed(2)} q ${life.quickening.toFixed(2)} pop ${life.motes.length}`);
      }
    }
    fork = null; field.setSource('fork', []);
    marks.push([Math.round(game.t), 'k' + k, alive(k) ? `born after ${Math.round(game.t - t0)}s` : `FAILED ${LIMIT}s`, 'pop ' + life.motes.length]);
    advance(15);
  }
  if (!did) advance(10);
}
const r = (x) => (x === null ? null : Math.round(x));
console.log(order.join(','), VIA, JSON.stringify({ floorAt: r(floorAt), choirAt: r(choirAt), marks, have: [5, 10, 20, 40].filter(alive), pop: life.motes.length, t: r(game.t) }));
process.exit(0);
