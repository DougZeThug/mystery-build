// Invariants for the singers and their names. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../src/core/bus.js';
import { makeRng } from '../src/core/rng.js';
import { newState } from '../src/core/persist.js';
import { createField } from '../src/sim/field.js';
import { createSand } from '../src/sim/sand.js';
import { createLife, TUNE, STATE_CODE } from '../src/sim/life.js';
import { nameFor, noteFor, speciesRatioText, NOTE_COUNT, colourFor } from '../src/sim/naming.js';
import { MODES } from '../src/sim/modes.js';

function makeGame(seed = 5, state = newState()) {
  const rng = makeRng(seed);
  const field = createField({ state, bus, rng });
  const sand = createSand(field, { state, bus });
  sand.seedScatter(9000);
  const game = { t: 0, rng, bus, state, field, sand, light: { on: true, level: 1 }, fx: {}, hold: null,
    wear: new Uint8Array(128 * 128), WEAR: 128, wearVersion: 0 };
  game.life = createLife(game);
  return game;
}
function step(game, secs, bow = null, amp = 0.8) {
  const dt = 1 / 30;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    game.field.setSource('bow', bow ? [{ mode: bow, amp }] : []);
    game.field.setSource('chorus', game.life.chorus());
    game.field.update(dt);
    game.sand.update(dt);
    game.life.update(dt);
    game.t += dt;
  }
}
function listen(types) {
  const seen = Object.fromEntries(types.map((t) => [t, []]));
  const offs = types.map((t) => bus.on(t, (p) => seen[t].push(p)));
  return { seen, off: () => offs.forEach((f) => f()) };
}
const finite = (m) => [m.u, m.v, m.vx, m.vy, m.hx, m.hy, m.e, m.age, m.r].every(Number.isFinite);

test('a held note quickens a singer within 15-40 s, with events and a record', () => {
  const ev = listen(['mote:birth', 'species:new']);
  const g = makeGame(3);
  step(g, 45, '2.5-');
  ev.off(); g.life.destroy();
  assert.ok(ev.seen['mote:birth'].length >= 1, 'no birth');
  const first = ev.seen['mote:birth'][0];
  assert.equal(first.species.id, '2.5-');
  assert.equal(first.isNew, true);
  assert.equal(ev.seen['species:new'].length >= 1, true);
  const rec = g.state.species['2.5-'];
  assert.ok(rec && rec.name && rec.genus && rec.epithet && rec.note, 'record incomplete');
  assert.ok(rec.firstSeen > 0 && rec.peak >= 1);
});

test('no NaN, cap respected, instance data consistent under violent and long play', () => {
  const g = makeGame(9);
  for (let i = 0; i < 90; i++) g.life.spawn(i % 2 ? '1.3+' : '2.4-', Math.random() * 1.6 - 0.8, Math.random() * 1.6 - 0.8, 0.9, { silent: true });
  assert.ok(g.life.motes.length <= TUNE.cap);
  step(g, 20, '1.3+', 0.9);
  step(g, 10, '3.7-', 1.5);
  step(g, 30);
  assert.ok(g.life.motes.length <= TUNE.cap);
  for (const m of g.life.motes) assert.ok(finite(m), `non-finite mote ${JSON.stringify(m.state)}`);
  const inst = g.life.instanceData();
  assert.equal(inst.stride, 16);
  assert.equal(inst.count, g.life.motes.length);
  for (let i = 0; i < inst.count * 16; i++) assert.ok(Number.isFinite(inst.data[i]));
  for (let i = 0; i < inst.count; i++) {
    const code = Math.floor(inst.data[i * 16 + 5]);
    assert.ok(code >= 0 && code <= STATE_CODE.born);
  }
  for (const c of g.life.chorus()) assert.ok(c.amp > 0 && c.amp <= 1.0 && typeof c.mode === 'string');
  g.life.destroy();
});

test('chorus() and populations() return pooled arrays (no per-frame allocation)', () => {
  const g = makeGame(2);
  g.life.spawn('1.3+', 0.3, 0.3, 0.8, { silent: true });
  step(g, 1);
  const a = g.life.chorus(), p = g.life.populations();
  step(g, 1);
  assert.equal(g.life.chorus(), a);
  assert.equal(g.life.populations(), p);
  assert.equal(p[0].count, 1);
  g.life.destroy();
});

test('serialize -> JSON -> deserialize round trip', () => {
  const g = makeGame(4);
  for (let i = 0; i < 8; i++) g.life.spawn(['1.3+', '2.4-', '1.2+|1.3+'][i % 3].split('|'), -0.5 + i * 0.12, 0.3, 0.7, { silent: true });
  step(g, 5);
  const before = g.life.motes.map((m) => ({ id: m.id, sp: m.sp, u: m.u, v: m.v, e: m.e }));
  const blob = JSON.parse(JSON.stringify(g.life.serialize()));
  g.life.destroy();
  const g2 = makeGame(4, g.state);
  g2.life.deserialize(blob);
  assert.equal(g2.life.motes.length, before.length);
  for (const b of before) {
    const m = g2.life.motes.find((x) => x.id === b.id);
    assert.ok(m, 'mote lost');
    assert.equal(m.sp, b.sp);
    assert.ok(Math.abs(m.u - b.u) < 1e-3 && Math.abs(m.e - b.e) < 2e-3);
  }
  assert.ok(g2.life.species['1.2+|1.3+'], 'hybrid species not restored');
  step(g2, 2);
  g2.life.destroy();
  // garbage in: no throw
  const g3 = makeGame(1);
  g3.life.deserialize({ v: 1, motes: [[1, 'nonsense', NaN, 0, 0, 0, 0.5, 1, 300, 0, 0, 0, 0]], species: [] });
  g3.life.deserialize(null);
  assert.equal(g3.life.motes.length, 0);
  g3.life.destroy();
});

test('old age crumbles into sand and gold; walking off the edge is a fall', () => {
  const ev = listen(['mote:death', 'mote:fall']);
  const g = makeGame(6);
  const old = g.life.spawn('1.3+', 0.4, 0.4, 0.8, { silent: true });
  old.age = old.life - 0.1;
  const goldBefore = countGold(g.sand);
  step(g, 3);
  assert.ok(ev.seen['mote:death'].some((d) => d.cause === 'age' && d.mote === old));
  assert.ok(countGold(g.sand) > goldBefore, 'no gold left behind');
  const m = g.life.spawn('1.3+', 0.95, 0, 0.8, { silent: true });
  m.state = 'startle'; m.dur = 0.55; m.st = 0; m.kx = 3; m.scool = 5;
  step(g, 2);
  assert.ok(ev.seen['mote:fall'].some((d) => d.mote === m));
  assert.ok(ev.seen['mote:death'].some((d) => d.cause === 'fall' && d.mote === m));
  ev.off(); g.life.destroy();
});
function countGold(sand) { let n = 0; for (let i = 0; i < sand.n; i++) if (sand.kind[i] === 1) n++; return n; }

test('disagreement devours; agreement fuses into a recorded hybrid', () => {
  const ev = listen(['mote:eat', 'mote:fuse', 'species:new', 'species:extinct']);
  const g = makeGame(8);
  const a = g.life.spawn('2.4-', 0.3, 0.3, 0.8, { silent: true });     // k20
  const b = g.life.spawn('2.3-', 0.33, 0.3, 0.4, { silent: true });    // k13: 20:13 is sour
  step(g, 2);
  assert.equal(ev.seen['mote:eat'].length, 1);
  assert.equal(ev.seen['mote:eat'][0].pred, a);
  assert.equal(ev.seen['mote:eat'][0].prey, b);
  step(g, 2);
  assert.ok(ev.seen['species:extinct'].some((e) => e.species.id === '2.3-'));
  assert.equal(g.state.species['2.3-'].extinct, true);
  // fusion: an octave pair, well fed, side by side
  const c = g.life.spawn('1.3+', -0.4, -0.3, 0.95, { silent: true });
  const d = g.life.spawn('2.4+', -0.37, -0.3, 0.95, { silent: true });
  let fused = false;
  for (let i = 0; i < 40 && !fused; i++) {
    c.e = d.e = 0.95;
    if (!c.dead && !d.dead && c.state !== 'fuse') { d.u = c.u + 0.03; d.v = c.v; }
    step(g, 0.5);
    fused = ev.seen['mote:fuse'].length > 0;
  }
  assert.ok(fused, 'no fusion');
  const f = ev.seen['mote:fuse'][0];
  assert.equal(f.species.id, '1.3+|2.4+');
  assert.equal(f.isNew, true);
  const rec = g.state.species['1.3+|2.4+'];
  assert.deepEqual(rec.parents.slice().sort(), ['1.3+', '2.4+']);
  assert.equal(rec.gen, 1);
  ev.off(); g.life.destroy();
});

test('darkness: metabolism halves, no births, singers sleep', () => {
  const g = makeGame(10);
  step(g, 40, '1.3+');
  const ev = listen(['mote:birth', 'mote:split']);
  g.light.on = false;
  const n = g.life.motes.length;
  step(g, 30, '1.3+');
  assert.equal(ev.seen['mote:birth'].length, 0);
  assert.equal(ev.seen['mote:split'].length, 0);
  assert.ok(g.life.motes.length <= n);
  const inst = g.life.instanceData();
  let sleeping = 0;
  for (let i = 0; i < inst.count; i++) if (inst.data[i * 16 + 15] & 2) sleeping++;
  assert.ok(sleeping > 0, 'nobody sleeping');
  ev.off(); g.life.destroy();
});

test('walking polishes the bronze', () => {
  const g = makeGame(12);
  for (let i = 0; i < 6; i++) g.life.spawn('1.3+', -0.6 + i * 0.2, 0.2, 0.8, { silent: true });
  step(g, 8, '1.3+');
  let sum = 0;
  for (const w of g.wear) sum += w;
  assert.ok(sum > 0 && g.wearVersion > 0);
  assert.ok(g.wearVersion <= 8 / 0.25 + 1, 'wearVersion bumped too often');
  g.life.destroy();
});

test('resting finger gathers singers', () => {
  const g = makeGame(13);
  for (let i = 0; i < 5; i++) g.life.spawn('1.3+', 0.2 + i * 0.05, -0.2, 0.8, { silent: true });
  g.hold = { u: 0.3, v: 0.1, t: 0 };
  step(g, 12, '1.3+', 0.5);
  const near = g.life.motes.filter((m) => Math.hypot(m.u - 0.3, m.v - 0.1) < 0.16).length;
  assert.ok(near >= 3, `only ${near} came to the finger`);
  assert.ok(g.life.motes.some((m) => m.state === 'nestle'));
  g.life.destroy();
});

test('simulateOffline: quick, sane, and writes field notes', () => {
  const g = makeGame(14);
  for (let i = 0; i < 20; i++) g.life.spawn(['1.3+', '2.4-', '3.4+'][i % 3], Math.random() - 0.5, Math.random() - 0.5, 0.7, { silent: true });
  step(g, 2);
  const t0 = performance.now();
  const notes = g.life.simulateOffline(3 * 3600);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `offline took ${ms.toFixed(0)} ms`);
  assert.ok(Array.isArray(notes) && notes.length >= 1);
  for (const n of notes) { assert.equal(typeof n.text, 'string'); assert.ok(!n.text.includes('!')); assert.ok(n.kind); }
  for (const m of g.life.motes) assert.ok(finite(m));
  assert.ok(g.life.motes.length <= TUNE.cap);
  for (const r of Object.values(g.state.species)) assert.equal(r.count, g.life.motes.filter((m) => m.sp === r.id).length);
  g.life.destroy();
});

test('names: deterministic, distinct for every single mode, sensible hybrids', () => {
  const seen = new Map();
  for (const m of MODES) {
    if (m.special || m.k < 5) continue;
    const a = nameFor([m.id]), b = nameFor([m.id]);
    assert.equal(a.name, b.name);
    assert.match(a.name, /^[A-Z][a-z]+ [a-z]+$/);
    assert.ok(!seen.has(a.name), `${a.name} used twice (${seen.get(a.name)}, ${m.id})`);
    seen.set(a.name, m.id);
  }
  assert.equal(nameFor(['2.5-']).genus, 'Dyapentas');
  assert.equal(nameFor(['1.3+', '2.4-']).epithet, 'diapasonica');
  assert.match(nameFor(['1.2+', '1.3+', '2.4-']).genus, /^(Scala|Symphonia|Polyphonia)$/);
  assert.match(nameFor(['2.5-'], true).name, / aurata$/);
  assert.ok(nameFor(['1.3+', '2.4-'], false, true).name.split(' ').length === 3);
  assert.equal(speciesRatioText({ ks: [10, 20] }), 'k 10, 20 (1:2)');
  assert.ok(colourFor('1.3+').every((x) => x >= 0 && x <= 1));
});

test('notes: plenty of templates, varied, Victorian (no exclamations)', () => {
  assert.ok(NOTE_COUNT >= 40);
  const texts = new Set();
  for (const m of MODES) {
    if (m.special || m.k < 5) continue;
    for (const stats of [{}, { devoured: 4 }, { eaten: 3 }, { fusions: 2 }, { ageDeaths: 3, lifeSum: 1300 }, { fell: 1 }]) {
      const sp = { id: m.id, comps: [m.id], ks: [m.k] };
      const t = noteFor(sp, { name: 'X y', peak: 5, stats }, {});
      assert.ok(t.length > 20 && !t.includes('!') && !t.includes('undefined') && !t.includes('NaN'), t);
      texts.add(t);
    }
  }
  assert.ok(texts.size > 60, `only ${texts.size} distinct notes`);
});

test('beside a mended seam the plate quickens gilded (aurata) singers', () => {
  const state = newState();
  // two healed seams along the still cross of mode 1.3+ (u = 0 and v = 0)
  state.plate.cracks = [
    { pts: [[-0.95, 0], [-0.3, 0.004], [0.3, -0.004], [0.95, 0]], gold: [1, 1, 1], healed: true, born: 0 },
    { pts: [[0, -0.95], [0.004, -0.3], [-0.004, 0.3], [0, 0.95]], gold: [1, 1, 1], healed: true, born: 0 },
  ];
  const ev = listen(['mote:birth']);
  const g = makeGame(21, state);
  step(g, 60, '1.3+');
  ev.off();
  const gilded = ev.seen['mote:birth'].filter((b) => b.species.aurata);
  assert.ok(gilded.length >= 1, `no aurata among ${ev.seen['mote:birth'].length} births`);
  assert.ok(gilded[0].species.id.endsWith('*'));
  assert.match(gilded[0].species.name, / aurata$/);
  assert.ok(gilded[0].mote.life >= TUNE.lifeMin * TUNE.aurataLife, 'aurata should outlive plain singers');
  g.life.destroy();
});

test('a landed moth is a small stillness that singers gather round', () => {
  const g = makeGame(22);
  for (let i = 0; i < 5; i++) g.life.spawn('1.3+', 0.1 + i * 0.06, 0.45, 0.8, { silent: true });
  g.moth = { landed: true, u: 0.35, v: 0.3 };
  step(g, 12, '1.3+', 0.5);
  const near = g.life.motes.filter((m) => Math.hypot(m.u - 0.35, m.v - 0.3) < 0.18).length;
  assert.ok(near >= 3, `only ${near} gathered round the moth`);
  g.moth = null;
  g.life.destroy();
});
