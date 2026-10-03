// Violence breaks the plate; gold mends it. Cracks drain sand, lodge gold, and heal into seams.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createField, makeCrackFamily } from '../src/sim/field.js';
import { createSand } from '../src/sim/sand.js';
import { makeRng } from '../src/core/rng.js';

function world(cracks, tuning = null) {
  const ev = [];
  const bus = { emit: (type, p) => ev.push({ type, p }) };
  const state = { plate: { fatigue: 0, cracks } };
  const field = createField({ state, bus });
  const sand = createSand(field, { state, bus, tuning });
  return { ev, state, field, sand };
}
const step = (w, secs, dt = 1 / 60) => { for (let i = 0; i < Math.round(secs / dt); i++) { w.field.update(dt); w.sand.update(dt); } };

test('gold poured along a crack lodges, gilds it segment by segment and heals it', () => {
  const crack = makeCrackFamily(makeRng(5))[0];
  const w = world([crack]);
  const rng = makeRng(77);
  w.field.setSource('t', [{ mode: '2.5+', amp: 0.5 }]);
  let healedAt = -1, poured = 0;
  for (let s = 0; s < 40 && healedAt < 0; s += 0.5) {
    // a little gold dust near random points of the crack, as death would scatter it
    for (let k = 0; k < 6; k++) {
      const p = crack.pts[Math.floor(rng.next() * crack.pts.length)];
      poured += w.sand.pour(p[0] * 0.985, p[1] * 0.985, 1, 1, 0.01);
    }
    step(w, 0.5);
    const gilded = crack.gold.reduce((a, b) => a + b, 0) / crack.gold.length;
    assert.ok(gilded >= 0 && gilded <= 1);
    if (crack.healed) healedAt = s;
  }
  assert.ok(crack.healed, `not healed; gold ${crack.gold.map((g) => g.toFixed(2)).join(' ')}`);
  assert.ok(crack.gold.every((g) => g === 1));
  const heal = w.ev.filter((e) => e.type === 'plate:heal');
  assert.equal(heal.length, 1);
  assert.deepEqual(heal[0].p, { crack: 0 });
  assert.ok(w.sand.lodged > 10 && w.sand.lodged <= poured, `lodged ${w.sand.lodged} of ${poured}`);
  // once healed: no more lodging, no draining, no detune
  step(w, 0.1);
  assert.equal(w.field.detune, 0);
  const lodged = w.sand.lodged;
  w.sand.pour(crack.pts[3][0], crack.pts[3][1], 20, 1, 0.005);
  step(w, 2);
  assert.equal(w.sand.lodged, lodged);
});

test('gilding needs a sensible amount of gold (tens of grains, not thousands)', () => {
  const crack = { pts: [], gold: [], healed: false };
  for (let i = 0; i <= 30; i++) crack.pts.push([-1 + i * 0.02, 0.3 + 0.004 * Math.sin(i)]);  // 0.6 long
  crack.gold = new Array(crack.pts.length - 1).fill(0);
  const w = world([crack]);
  w.field.setSource('t', [{ mode: '1.3+', amp: 0.5 }]);
  let used = 0;
  for (let i = 0; i < 400 && !crack.healed; i++) {
    const p = crack.pts[(i * 7) % crack.pts.length];
    w.sand.pour(Math.max(-0.99, p[0]), p[1], 1, 1, 0.003);
    used++;
    step(w, 1 / 20);
  }
  assert.ok(crack.healed, 'heals');
  assert.ok(used > 15 && used < 200, `${used} grains`);
});

// a straight 0.6-long crack in from the left rim, 30 segments
function rimCrack() {
  const crack = { pts: [], gold: [], healed: false };
  for (let i = 0; i <= 30; i++) crack.pts.push([-1 + i * 0.02, 0.3]);
  crack.gold = new Array(30).fill(0);
  return crack;
}
// one gold grain at a time at (u,v) until the crack heals (or `max` grains)
function gildAt(w, crack, u, v, max = 80) {
  for (let i = 0; i < max && !crack.healed; i++) { w.sand.pour(u, v, 1, 1, 0.002); step(w, 1 / 10); }
  return w.sand.lodged;
}

test('gold that lodges in one place runs along the seam into every gap, the rim end included', () => {
  const crack = rimCrack();
  const w = world([crack], { HEAL_AT: 1 });        // demand every segment, to see the flow reach them all
  w.field.setSource('t', [{ mode: '1.3+', amp: 0.5 }]);
  const lodged = gildAt(w, crack, -0.45, 0.3);     // only ever at the inner tip
  assert.ok(crack.healed, `not healed; gold ${crack.gold.map((g) => g.toFixed(2)).join(' ')}`);
  // nothing is thrown away: 0.6 of crack at GILD_LEN 0.03 a grain is 20 grains
  assert.ok(lodged >= 19 && lodged <= 22, `${lodged} grains`);
});

test('a crack heals once ~90% of its length is gilded; the seam is then gold throughout', () => {
  const crack = rimCrack();
  const w = world([crack]);
  w.field.setSource('t', [{ mode: '1.3+', amp: 0.5 }]);
  const gilt = () => crack.gold.reduce((a, g) => a + g, 0) * 0.02;   // gilded length
  let last = 0, lodged = 0;
  for (let i = 0; i < 80 && !crack.healed; i++) {
    w.sand.pour(-0.7, 0.3, 1, 1, 0.002);
    step(w, 1 / 10);
    if (crack.healed || w.sand.lodged === lodged) continue;
    const per = (gilt() - last) / (w.sand.lodged - lodged);
    assert.ok(Math.abs(per - 0.03) < 1e-4, `a grain gilded ${per.toFixed(4)} of the crack, not GILD_LEN`);
    last = gilt(); lodged = w.sand.lodged;
  }
  assert.ok(crack.healed);
  assert.ok(last >= 0.5 && last < 0.54, `healed at ${(last / 0.6).toFixed(2)} gilded`);
  assert.ok(w.sand.lodged >= 17 && w.sand.lodged <= 20, `${w.sand.lodged} grains for 0.9 × 20`);
  assert.ok(crack.gold.every((g) => g === 1));
  assert.equal(w.ev.filter((e) => e.type === 'plate:heal').length, 1);
});

test('sand lying in an unhealed crack drains while the plate sings, not when it is still', () => {
  const crack = { pts: [[-1, -0.2], [-0.5, -0.15], [-0.1, -0.2]], gold: [0, 0], healed: false };
  const w = world([crack]);
  for (let i = 0; i < 400; i++) w.sand.pour(-0.9 + (0.8 * i) / 400, -0.17 + 0.03 * Math.sin(i), 1, 0, 0.004);
  step(w, 2);
  assert.equal(w.sand.drained, 0, 'a still plate keeps its sand');
  w.field.setSource('t', [{ mode: '1.2+', amp: 0.6 }]);
  step(w, 3);
  assert.ok(w.sand.drained > 10, `drained ${w.sand.drained}`);
  assert.ok(w.sand.drained <= 30 * 3 + 2, 'at most ~30 grains a second per crack');
});

test('branches heal on their own and report their own index', () => {
  let fam = null;
  for (let s = 1; s < 60 && !fam; s++) { const f = makeCrackFamily(makeRng(s)); if (f.length === 2) fam = f; }
  assert.ok(fam, 'found a branching crack');
  fam[1].branchOf = 0;
  const w = world(fam);
  w.field.setSource('t', [{ mode: '2.2+', amp: 0.5 }]);
  const br = fam[1];
  for (let i = 0; i < 300 && !br.healed; i++) {
    const p = br.pts[i % br.pts.length];
    w.sand.pour(p[0], p[1], 1, 1, 0.003);
    step(w, 1 / 20);
  }
  assert.ok(br.healed);
  const heal = w.ev.filter((e) => e.type === 'plate:heal');
  assert.ok(heal.some((e) => e.p.crack === 1));
  assert.equal(w.field.detune, fam[0].healed ? 0 : 0.006, 'branches do not add detune');
});
