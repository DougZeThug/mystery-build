// Headless ecosystem harness for the singers. Runs scripted scenarios far faster than real time
// against the real field and sand, and prints a timeline.
//   node dev/life-sim.mjs [scenario|all] [--seed N] [--every S] [--sandEvery K] [--quiet]
// Scenarios: a (one held note, then silence), b (clan against clan), c (fusion), d (long drift),
//            e (choir & floor), f (darkness)
import { bus } from '../src/core/bus.js';
import { makeRng } from '../src/core/rng.js';
import { newState } from '../src/core/persist.js';
import { createField } from '../src/sim/field.js';
import { createSand } from '../src/sim/sand.js';
import { createLife, TUNE } from '../src/sim/life.js';
import { modesWithK } from '../src/sim/modes.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes('--' + name);
const which = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || 'all';
const SEED = +opt('seed', 7);
const EVERY = +opt('every', 10);
const QUIET = flag('quiet');

export function makeGame(seed = SEED) {
  const state = newState();
  const rng = makeRng(seed);
  const field = createField({ state, bus, rng });
  const sand = createSand(field, { state, bus });
  sand.seedScatter(15000);
  const game = {
    t: 0, dt: 1 / 30, rng, bus, debug: false, state, field, sand,
    light: { on: true, level: 1, flicker: 0 }, fx: { choir: 0, floor: 0 }, hold: null,
    wear: new Uint8Array(128 * 128), WEAR: 128, wearVersion: 0,
  };
  game.life = createLife(game);
  return game;
}

// phases: [{ dur, bow?: modeId | [modeIds], amp?, light?, hold?: {u,v}, note? }]
export function run(name, phases, { seed = SEED, every = EVERY, sandEvery = 1, quiet = QUIET, onTick = null } = {}) {
  const game = makeGame(seed);
  const { field, sand, life } = game;
  const dt = 1 / 30;
  const win = { births: 0, splits: 0, deaths: 0, age: 0, hunger: 0, eaten: 0, fall: 0, fusions: 0, devoured: 0, newSp: 0, extinct: 0 };
  const tot = { ...win, choirs: 0, floors: 0, firstBirth: null, firstFusion: null, firstEat: null, hybrids: new Set(), species: new Set(), extinctNames: [], newNames: [] };
  const offs = [
    bus.on('mote:birth', (e) => { win.births++; tot.births++; if (tot.firstBirth === null) tot.firstBirth = game.t; }),
    bus.on('mote:split', () => { win.splits++; tot.splits++; }),
    bus.on('mote:death', (e) => { win.deaths++; tot.deaths++; win[e.cause]++; tot[e.cause]++; }),
    bus.on('mote:fuse', (e) => { win.fusions++; tot.fusions++; if (tot.firstFusion === null) tot.firstFusion = game.t; if (e.species.nc > 1) tot.hybrids.add(e.species.name); }),
    bus.on('mote:eat', () => { win.devoured++; tot.devoured++; if (tot.firstEat === null) tot.firstEat = game.t; }),
    bus.on('species:new', (e) => { win.newSp++; tot.newNames.push(`${fmt(game.t)} ${e.species.name}`); if (e.species.nc > 1) tot.hybrids.add(e.species.name); }),
    bus.on('species:extinct', (e) => { win.extinct++; tot.extinctNames.push(`${fmt(game.t)} ${e.species.name}`); }),
    bus.on('life:choir', (e) => { if (e.on) tot.choirs++; if (!quiet) console.log(`   ${fmt(game.t)}  ** choir ${e.on ? 'ON' : 'off'} ${e.species.join(' ')}`); }),
    bus.on('life:floor', (e) => {
      if (!e.on) return;
      tot.floors++;
      if (!quiet) console.log(`   ${fmt(game.t)}  ** FLOOR`);
      field.setSource('floor', [{ mode: 'floor', amp: 1.2 }]); floorLeft = 18;
    }),
  ];
  let floorLeft = 0;
  if (!quiet) console.log(`\n=== ${name} (seed ${seed}) ===`);
  if (!quiet) console.log('  time   pop sp  born split  dAge dHun eaten fell fuse new ext  chorus field  q     species');
  const t0 = Date.now();
  let step = 0, next = every, popMax = 0, popMin = 1e9;
  const samples = [];
  for (const ph of phases) {
    if (ph.note && !quiet) console.log(`   ${fmt(game.t)}  -- ${ph.note}`);
    const bows = ph.bow ? (Array.isArray(ph.bow) ? ph.bow : [ph.bow]) : [];
    if (ph.light !== undefined) game.light.on = ph.light;
    game.hold = ph.hold ? { u: ph.hold.u, v: ph.hold.v, t: game.t } : null;
    const steps = Math.round(ph.dur / dt);
    for (let s = 0; s < steps; s++) {
      // alternate bows: each listed mode in turn for ph.alt seconds
      if (bows.length) {
        const idx = ph.alt ? Math.floor(game.t / ph.alt) % bows.length : 0;
        field.setSource('bow', [{ mode: bows[idx], amp: ph.amp ?? 0.8 }]);
      } else field.setSource('bow', []);
      if (ph.fn) ph.fn(game, s * dt);
      if (floorLeft > 0) { floorLeft -= dt; if (floorLeft <= 0) field.setSource('floor', []); }
      field.setSource('chorus', life.chorus());
      field.update(dt);
      if (step % sandEvery === 0) sand.update(dt * sandEvery);
      life.update(dt);
      game.t += dt; step++;
      onTick?.(game);
      const pop = life.motes.length;
      if (game.t > 60) { popMax = Math.max(popMax, pop); popMin = Math.min(popMin, pop); }
      if (game.t >= next - 1e-6) {
        next += every;
        let c2 = 0;
        for (const c of life.chorus()) c2 += c.amp * c.amp;
        const pops = life.populations().slice().sort((a, b) => b.count - a.count);
        const spStr = pops.slice(0, 6).map((p) => `${life.species[p.id].name.replace(/ (\w)\w+/, ' $1.')}:${p.count}${flag('diag') ? `(e${p.meanE.toFixed(2)} f${life.species[p.id].feed.toFixed(2)})` : ''}`).join(' ');
        for (const p of pops) tot.species.add(p.id);
        samples.push({ t: game.t, pop, sp: pops.length, ids: pops.map((p) => p.id) });
        if (!quiet) console.log(`  ${fmt(game.t)} ${String(pop).padStart(4)} ${String(pops.length).padStart(2)}  ${pad(win.births)} ${pad(win.splits, 5)}  ${pad(win.age, 4)} ${pad(win.hunger, 4)} ${pad(win.eaten, 5)} ${pad(win.fall, 4)} ${pad(win.fusions, 4)} ${pad(win.newSp, 3)} ${pad(win.extinct, 3)}  ${Math.sqrt(c2).toFixed(2).padStart(5)}  ${field.total.toFixed(2)}  ${life.quickening.toFixed(2)}  ${spStr}`);
        for (const k in win) win[k] = 0;
      }
    }
  }
  for (const off of offs) off();
  life.destroy?.();
  field.setSource('bow', []);
  const secs = (Date.now() - t0) / 1000;
  // composition turnover: Jaccard distance between species sets 5 minutes apart
  let drift = 0, dn = 0;
  for (let i = 0; i < samples.length; i++) {
    const j = samples.findIndex((s) => s.t >= samples[i].t + 300);
    if (j < 0) break;
    const A = new Set(samples[i].ids), B = new Set(samples[j].ids);
    const inter = [...A].filter((x) => B.has(x)).length, uni = new Set([...A, ...B]).size;
    if (uni) { drift += 1 - inter / uni; dn++; }
  }
  const summary = {
    name, seed, simSeconds: Math.round(game.t), wallSeconds: +secs.toFixed(1), pop: life.motes.length, popMin: popMin === 1e9 ? 0 : popMin, popMax,
    firstBirth: tot.firstBirth === null ? null : +tot.firstBirth.toFixed(1), firstFusion: tot.firstFusion && +tot.firstFusion.toFixed(1),
    firstEat: tot.firstEat && +tot.firstEat.toFixed(1),
    births: tot.births, splits: tot.splits, deaths: tot.deaths, age: tot.age, hunger: tot.hunger, eaten: tot.eaten, fell: tot.fall,
    fusions: tot.fusions, devoured: tot.devoured, choirs: tot.choirs, floors: tot.floors,
    speciesSeen: tot.species.size, records: Object.keys(game.state.species).length, hybrids: [...tot.hybrids],
    extinct: tot.extinctNames, newForms: tot.newNames, drift5min: dn ? +(drift / dn).toFixed(2) : 0,
    wear: game.wearVersion, wearMax: Math.max(...game.wear),
  };
  if (!quiet) {
    console.log(`  -> ${JSON.stringify({ ...summary, extinct: summary.extinct.length, newForms: summary.newForms.length })}`);
    if (summary.newForms.length) console.log('  new forms: ' + summary.newForms.slice(0, 14).join('; ') + (summary.newForms.length > 14 ? ` … (+${summary.newForms.length - 14})` : ''));
    if (summary.extinct.length) console.log('  extinct:   ' + summary.extinct.slice(0, 14).join('; ') + (summary.extinct.length > 14 ? ` … (+${summary.extinct.length - 14})` : ''));
  }
  return { summary, game };
}

const fmt = (t) => { const r = Math.round(t); return `${String(Math.floor(r / 60)).padStart(2)}:${String(r % 60).padStart(2, '0')}`; };
const pad = (n, w = 4) => String(n).padStart(w);
const modeK = (k, s = 0) => modesWithK(k)[s]?.id;

export const SCENARIOS = {
  // (a) one held note, then silence: the plate keeps playing itself
  a: () => [
    { dur: 60, bow: '2.5-', amp: 0.8, note: 'bow 2.5- (k29) at .8' },
    { dur: 600, note: 'silence' },
  ],
  // (b) clan of five (k20) against clan of thirteen (k13)
  b: () => [
    { dur: 40, bow: '2.4+', amp: 0.8, note: 'bow 2.4+ (k20, clan 5)' },
    { dur: 40, bow: '2.3-', amp: 0.8, note: 'bow 2.3- (k13, clan 13)' },
    { dur: 240, note: 'silence' },
  ],
  // (c) two consonant modes alternated: k10 and k20 (an octave)
  c: () => [
    { dur: 120, bow: ['1.3+', '2.4-'], alt: 20, amp: 0.8, note: 'alternate 1.3+ (k10) / 2.4- (k20) every 20 s' },
    { dur: 300, note: 'silence' },
  ],
  // (d) long silence from a mid-sized mixed population
  d: () => [
    { dur: 40, bow: '1.3+', amp: 0.8, note: 'bow k10' },
    { dur: 40, bow: '2.4-', amp: 0.8, note: 'bow k20' },
    { dur: 40, bow: '3.4+', amp: 0.8, note: 'bow k25' },
    { dur: 1800, note: 'silence for 30 minutes' },
  ],
  // (e) choir (k5,10,20 fed deliberately), then the floor (add k40)
  e: () => [
    { dur: 40, bow: '1.2+', amp: 0.8, note: 'bow k5' },
    { dur: 40, bow: '1.3-', amp: 0.8, note: 'bow k10' },
    { dur: 40, bow: '2.4+', amp: 0.8, note: 'bow k20' },
    { dur: 90, note: 'silence (choir?)' },
    { dur: 60, bow: '2.6-', amp: 0.8, note: 'bow k40' },
    { dur: 120, note: 'silence (floor?)' },
  ],
  // (f) darkness
  f: () => [
    { dur: 60, bow: '1.3+', amp: 0.8, note: 'bow k10' },
    { dur: 60, note: 'silence, light on' },
    { dur: 120, light: false, note: 'light OFF' },
    { dur: 30, light: true, bow: '1.3+', amp: 0.8, note: 'light on + bow' },
    { dur: 30, light: false, bow: '1.3+', amp: 0.8, note: 'light off + bow (no births expected)' },
    { dur: 60, light: true, note: 'light on, silence' },
  ],
  // the resting finger
  h: () => [
    { dur: 50, bow: '1.3+', amp: 0.8, note: 'bow k10' },
    { dur: 30, hold: { u: 0.3, v: -0.3 }, note: 'finger rests at (.3,-.3)' },
    { dur: 20, note: 'release' },
  ],
  // over-bowing: fast, violent, wandering bow
  o: () => [
    { dur: 50, bow: '1.3+', amp: 0.8, note: 'bow k10' },
    { dur: 20, bow: ['4.6+', '3.7-', '5.6-', '2.7+'], alt: 1.5, amp: 1.15, note: 'bowing flat out (amp 1.15, the bow maximum)' },
    { dur: 30, note: 'silence' },
  ],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = which === 'all' ? ['a', 'b', 'c', 'd', 'e', 'f'] : which.split(',');
  const sandEvery = +opt('sandEvery', 1);
  for (const s of list) {
    if (!SCENARIOS[s]) { console.log('unknown scenario', s); continue; }
    run(s, SCENARIOS[s](), { sandEvery: s === 'd' ? Math.max(sandEvery, 2) : sandEvery });
  }
  void TUNE; void modeK;
}
