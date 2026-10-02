// Plate field: sources, envelopes, impulses, dampers, coherence, grid, fatigue -> cracks, crack mask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createField, makeCrack, makeCrackFamily, distToPolyline, nearestSegment } from '../src/sim/field.js';
import { modeById, evalMode } from '../src/sim/modes.js';
import { makeRng } from '../src/core/rng.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≉ ${b} (±${eps})`);
const run = (f, secs, dt = 1 / 60) => { for (let i = 0; i < Math.round(secs / dt); i++) f.update(dt); };
const mkBus = () => { const ev = []; return { ev, emit: (type, p) => ev.push({ type, p }) }; };

test('source attack (τ .35 s) and release (τ 1.4 s)', () => {
  const f = createField({});
  f.setSource('bow', [{ mode: '2.3+', amp: 1 }]);
  run(f, 0.35);
  near(f.amp('2.3+'), 1 - Math.exp(-1), 0.02, 'one attack constant');
  run(f, 3);
  near(f.amp('2.3+'), 1, 0.01);
  f.setSource('bow', []);
  run(f, 1.4);
  near(f.amp('2.3+'), Math.exp(-1), 0.02, 'one release constant');
  assert.equal(f.getSource('bow'), null);
});

test('total, kEff and spectrum', () => {
  const f = createField({});
  f.setSource('a', [{ mode: '1.2+', amp: 0.6 }, { mode: '3.4-', amp: 0.8 }]);
  run(f, 6);
  near(f.total, 1, 0.01);
  near(f.kEff, (0.36 * 5 + 0.64 * 25) / 1, 0.3);
  const sp = f.spectrum();
  assert.deepEqual(sp.map((s) => s.mode), ['3.4-', '1.2+']);
  assert.equal(sp[0].k, 25); assert.equal(sp[0].freq, 27.5 * 25);
  assert.ok(sp.every((s, i) => i === 0 || sp[i - 1].amp >= s.amp));
  // two sources sum on the same mode
  f.setSource('b', [{ mode: '1.2+', amp: 0.4 }]);
  run(f, 6);
  near(f.amp('1.2+'), 1.0, 0.01);
});

test('grid matches the exact modal sum; sample() gives F = f² and ∇F', () => {
  const f = createField({});
  f.setSource('a', [{ mode: '3.5-', amp: 0.7 }, { mode: '1.2+', amp: 0.3 }, { mode: 'floor', amp: 0.4 }, { mode: '2.6-', amp: 0.2 }]);
  run(f, 8);
  const G = f.G;
  for (let j = 3; j < G; j += 17) for (let i = 5; i < G; i += 13) {
    const u = ((i + 0.5) / G) * 2 - 1, v = ((j + 0.5) / G) * 2 - 1;
    near(f.grid[j * G + i], f.evalAt(u, v), 3e-3, 'grid');
  }
  const h = 1e-3;
  for (const [u, v] of [[0.31, -0.22], [-0.6, 0.45], [0.05, 0.77]]) {
    const s = f.sample(u, v);
    near(s.F, s.f * s.f, 1e-9);
    near(s.f, f.evalAt(u, v), 3e-3, 'f');
    const Fx = (f.evalAt(u + h, v) ** 2 - f.evalAt(u - h, v) ** 2) / (2 * h);
    const Fy = (f.evalAt(u, v + h) ** 2 - f.evalAt(u, v - h) ** 2) / (2 * h);
    near(s.gx, Fx, 0.03 + 0.03 * Math.abs(Fx), 'gx');
    near(s.gy, Fy, 0.03 + 0.03 * Math.abs(Fy), 'gy');
  }
  const o = {};
  assert.equal(f.sampleInto(0.1, 0.2, o), o);
  assert.ok(Number.isFinite(f.sample(NaN, Infinity).f));
});

test('single mode at amp 1 peaks at F = 1', () => {
  const f = createField({});
  f.setSource('a', [{ mode: '2.4+', amp: 1 }]);
  run(f, 8);
  let mx = 0;
  for (let p = 0; p < f.grid.length; p++) mx = Math.max(mx, f.grid[p] * f.grid[p]);
  near(mx, 1, 0.03);
});

test('impulses decay exponentially and do not need a source', () => {
  const f = createField({});
  f.impulse([{ mode: '1.3+', amp: 0.8 }, { mode: 'nope', amp: 1 }, { mode: '2.2+', amp: NaN }], 0.5);
  run(f, 1 / 60);
  near(f.amp('1.3+'), 0.8 * Math.exp(-1 / 30), 0.01);
  run(f, 0.5);
  near(f.amp('1.3+'), 0.8 * Math.exp(-(0.5 + 1 / 60) / 0.5), 0.02);
  run(f, 5);
  assert.equal(f.amp('1.3+'), 0);
  assert.equal(f.total, 0);
});

test('dampers suppress modes that move there and still the spot itself', () => {
  const f = createField({});
  const loud = modeById('1.3+');                 // loud at the corner region
  const d = { u: -0.92, v: -0.92, r: 0.06 };
  assert.ok(Math.abs(evalMode(loud, d.u, d.v)) > 0.8);
  f.dampers.push(d);
  f.setSource('a', [{ mode: '1.3+', amp: 1 }]);
  run(f, 6);
  const s = f.suppression(loud);
  near(f.amp('1.3+'), 1 - 0.92 * s, 0.02);
  near(f.suppressed('1.3+'), s, 1e-6, 'cached suppression');
  // a mode with a node at the damper is untouched
  const quiet = modeById('1.2-');                // antisymmetric: zero on the diagonal
  const g = createField({});
  g.dampers.push({ u: 0.3, v: 0.3, r: 0.05 });
  g.setSource('a', [{ mode: '1.2-', amp: 1 }]);
  run(g, 6);
  assert.ok(Math.abs(evalMode(quiet, 0.3, 0.3)) < 1e-9);
  near(g.amp('1.2-'), 1, 0.01);
  // the damper pocket: f is pinned near zero right under it
  const h = createField({});
  h.dampers.push({ u: 0.5, v: 0.1, r: 0.06 });
  h.setSource('a', [{ mode: '1.2+', amp: 1 }]);
  run(h, 6);
  const under = Math.abs(h.sample(0.5, 0.1).f), free = Math.abs(h.evalAt(0.5, 0.1));
  assert.ok(under < 0.2 * free + 1e-3, `under ${under} vs ${free}`);
  // junk dampers are ignored
  h.dampers.push({ u: NaN, v: 0 }, null);
  run(h, 0.2);
  assert.ok(Number.isFinite(h.total));
});

test('coherence: dominant, share, stable timer', () => {
  const f = createField({});
  f.setSource('a', [{ mode: '2.5+', amp: 0.8 }]);
  run(f, 3);
  const c = f.coherence;
  assert.equal(c.dominant, '2.5+');
  near(c.share, 1, 1e-6);
  assert.ok(c.stable > 2.4 && c.stable <= 3.01, `stable ${c.stable}`);
  f.setSource('a', [{ mode: '2.5+', amp: 0.8 }, { mode: '1.4-', amp: 0.5 }]);
  run(f, 4);
  assert.equal(c.second, '1.4-');
  near(c.share, 0.64 / 0.89, 0.02);
  near(c.secondShare, 0.25 / 0.89, 0.02);
  f.setSource('a', [{ mode: '1.4-', amp: 0.9 }]);
  run(f, 0.6);
  assert.equal(c.dominant, '1.4-');
  assert.ok(c.stable < 0.6, 'timer restarted when the dominant changed');
  run(f, 3);
  assert.ok(c.stable > 2.5);
  f.setSource('a', []);
  run(f, 12);
  assert.equal(c.stable, 0);
});

test('fatigue accumulates above total 1.05 and cracks the plate', () => {
  const bus = mkBus();
  const state = { plate: { fatigue: 0.9, cracks: [] } };
  const f = createField({ state, bus, rng: makeRng(42) });
  f.setSource('a', [{ mode: '1.3+', amp: 1.4 }]);
  run(f, 0.2);
  assert.equal(f.fatigueRate, 0, 'still below 1.05 while the attack builds');
  run(f, 1.5);
  assert.ok(f.total > 1.05);
  near(f.fatigueRate, (f.total - 1.05) ** 2 * 0.9, 1e-6);
  run(f, 10);
  assert.ok(state.plate.cracks.length >= 1, 'cracked');
  const ev = bus.ev.filter((e) => e.type === 'plate:crack');
  assert.ok(ev.length >= 1);
  assert.equal(ev[0].p.crack, 0);
  assert.ok(state.plate.fatigue < 1);
  near(f.detune, 0.006 * ev.length, 1e-9);
  // calm plates heal their fatigue slowly instead
  const s2 = { plate: { fatigue: 0.5, cracks: [] } };
  const g = createField({ state: s2 });
  g.setSource('a', [{ mode: '1.3+', amp: 0.6 }]);
  run(g, 10);
  assert.ok(s2.plate.fatigue < 0.5 && s2.plate.fatigue > 0.4);
  assert.equal(g.fatigueRate, 0);
});

test('at most 7 main cracks; detune capped at .03', () => {
  const state = { plate: { fatigue: 0, cracks: [] } };
  const f = createField({ state, rng: makeRng(1) });
  f.setSource('a', [{ mode: '1.3+', amp: 1.6 }, { mode: '2.4+', amp: 1.6 }]);
  run(f, 120);
  const mains = state.plate.cracks.filter((c) => c.branchOf === undefined);
  assert.equal(mains.length, 7);
  assert.ok(f.detune <= 0.03 + 1e-12);
});

test('crack mask: a line of stillness; healed seams soften and stop draining', () => {
  const crack = { pts: [[-1, 0.2], [-0.6, 0.25], [-0.3, 0.2]], gold: [0, 0], healed: false };
  const state = { plate: { fatigue: 0, cracks: [crack] } };
  const f = createField({ state });
  f.setSource('a', [{ mode: 'floor', amp: 1 }]);
  run(f, 6);
  const G = f.G, cell = (u, v) => Math.round(((v + 1) / 2) * G - 0.5) * G + Math.round(((u + 1) / 2) * G - 0.5);
  const on = f.sample(-0.6, 0.25).f, free = f.evalAt(-0.6, 0.25);
  near(on / free, 0.15, 0.04, 'f × (1 − .85) on the crack');
  near(f.sample(-0.6, 0.6).f / f.evalAt(-0.6, 0.6), 1, 0.01, 'unaffected far away');
  assert.equal(f.crackNear[cell(-0.6, 0.25)], 1);
  assert.equal(f.crackIdx[cell(-0.6, 0.25)], 0);
  assert.equal(f.crackNear[cell(-0.6, 0.5)], 0);
  crack.healed = true;
  run(f, 1 / 60);
  near(f.sample(-0.6, 0.25).f / f.evalAt(-0.6, 0.25), 0.5, 0.05, 'healed seam: softer');
  assert.equal(f.crackNear[cell(-0.6, 0.25)], 0);
  assert.equal(f.crackIdx[cell(-0.6, 0.25)], -1);
  assert.equal(f.detune, 0);
});

test('makeCrackFamily: hairline from an edge inwards, sometimes one short branch', () => {
  let branches = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const fam = makeCrackFamily(makeRng(seed));
    const main = fam[0];
    assert.ok(main.pts.length >= 6);
    const [u0, v0] = main.pts[0];
    assert.ok(Math.max(Math.abs(u0), Math.abs(v0)) > 0.999, 'starts on the rim');
    let len = 0, turn = 0;
    for (let i = 1; i < main.pts.length; i++) {
      const [a, b] = main.pts[i - 1], [c, d] = main.pts[i];
      len += Math.hypot(c - a, d - b);
      assert.ok(Math.abs(c) <= 1 && Math.abs(d) <= 1);
      assert.ok(Math.hypot(c, d) > 0.1, 'keeps off the clamp');
      if (i > 1) {
        const [p, q] = main.pts[i - 2];
        const a1 = Math.atan2(b - q, a - p), a2 = Math.atan2(d - b, c - a);
        turn += Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      }
    }
    assert.ok(len > 0.2 && len < 1.15, `length ${len}`);
    assert.ok(turn / (main.pts.length - 2) > 0.05, 'jagged, not straight');
    assert.equal(main.gold.length, main.pts.length - 1);
    assert.equal(main.healed, false);
    assert.ok(fam.length <= 2);
    if (fam.length === 2) {
      branches++;
      const b = fam[1];
      assert.ok(main.pts.some((p) => p[0] === b.pts[0][0] && p[1] === b.pts[0][1]), 'branch grows from the crack');
      let bl = 0;
      for (let i = 1; i < b.pts.length; i++) bl += Math.hypot(b.pts[i][0] - b.pts[i - 1][0], b.pts[i][1] - b.pts[i - 1][1]);
      assert.ok(bl < 0.3, `branch length ${bl}`);
    }
    assert.ok(JSON.stringify(fam).length < 3000, 'compact enough to persist');
  }
  assert.ok(branches > 8 && branches < 34, `branches ${branches}/40`);
  // deterministic for a seeded rng; makeCrack returns the main crack only
  assert.deepEqual(makeCrackFamily(makeRng(9))[0].pts, makeCrack(makeRng(9)).pts);
});

test('fatigue cracks register their branch with branchOf', () => {
  const state = { plate: { fatigue: 0, cracks: [] } };
  const f = createField({ state, rng: makeRng(3) });
  f.setSource('a', [{ mode: '1.3+', amp: 1.6 }, { mode: '2.4+', amp: 1.6 }]);
  run(f, 60);
  const cracks = state.plate.cracks;
  for (let i = 0; i < cracks.length; i++) {
    const c = cracks[i];
    if (c.branchOf !== undefined) {
      assert.ok(c.branchOf < i);
      assert.equal(cracks[c.branchOf].branchOf, undefined);
    }
  }
});

test('geometry helpers', () => {
  const pts = [[0, 0], [1, 0], [1, 1]];
  near(distToPolyline(0.5, 0.2, pts), 0.2, 1e-12);
  near(distToPolyline(1.3, 0.5, pts), 0.3, 1e-12);
  const s = nearestSegment(1.1, 0.75, pts);
  assert.equal(s.index, 1); near(s.dist, 0.1, 1e-12); near(s.t, 0.75, 1e-12);
});

test('robust: junk sources, NaN dt, null state, damaged saved cracks', () => {
  const f = createField({ state: null });
  f.setSource('a', [{ mode: '2.3+', amp: NaN }, { mode: 'zzz', amp: 1 }, null, { mode: '1.2+' }]);
  f.update(NaN); f.update(-1); f.update(Infinity); f.update(1 / 60);
  assert.ok(Number.isFinite(f.total));
  assert.equal(f.cracks.length, 0);
  f.setSource('a', null);
  const state = { plate: { fatigue: NaN, cracks: [{ pts: [[0.9, 0], [NaN, 1], [0.5, 0.1], [0.4, 0.2]], gold: [2, 'x'] }, { pts: [] }, null] } };
  const g = createField({ state });
  g.setSource('a', [{ mode: '1.3+', amp: 0.5 }]);
  run(g, 1);
  assert.equal(state.plate.cracks.length, 1);
  assert.equal(state.plate.cracks[0].pts.length, 3);
  assert.deepEqual(state.plate.cracks[0].gold, [1, 0]);
  assert.equal(state.plate.fatigue, 0);
  assert.ok(Number.isFinite(g.total));
});

test('performance: field.update with ~10 live modes', () => {
  const f = createField({});
  const modes = ['3.5-', '2.4+', '1.6-', '4.5+', '2.2+', '1.3-', '3.3+', '2.7+', '5.6-', '1.2+'];
  const t = [];
  for (let i = 0; i < 400; i++) {
    f.setSource('a', modes.map((m, j) => ({ mode: m, amp: (0.6 / (j + 1)) * (1 + 0.3 * Math.sin(i * 0.37 + j)) })));
    const a = performance.now(); f.update(1 / 60); t.push(performance.now() - a);
  }
  t.sort((a, b) => a - b);
  // generous bound for shared CI machines; ~0.9 ms per rebuild here
  assert.ok(t[Math.floor(t.length * 0.9)] < 4, `p90 ${t[Math.floor(t.length * 0.9)].toFixed(2)} ms`);
});
