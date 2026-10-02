// Sand: pour/take/countNear, settling on nodes, freezing, the rim, the floor, peaks, persistence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createField } from '../src/sim/field.js';
import { createSand, encodeCounts, decodeCounts, b64 } from '../src/sim/sand.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≉ ${b} (±${eps})`);
function world(n = 0, opts = {}) {
  const state = { plate: { fatigue: 0, cracks: [] } };
  const field = createField({ state });
  const sand = createSand(field, { state, ...opts });
  if (n) sand.seedScatter(n);
  return { state, field, sand };
}
const step = (w, secs, dt = 1 / 60) => { for (let i = 0; i < Math.round(secs / dt); i++) { w.field.update(dt); w.sand.update(dt); } };
const inPlate = (s) => { for (let i = 0; i < s.n; i++) if (!(Math.abs(s.x[i]) <= 1 && Math.abs(s.y[i]) <= 1)) return false; return true; };
// median distance (plate units) of grains to the nodal set, |f| / |∇f| from the exact modal sum
function nodalDistance(field, sand) {
  const h = 1e-3, d = [];
  for (let i = 0; i < sand.n; i += 9) {
    const u = sand.x[i], v = sand.y[i];
    const g = Math.hypot(field.evalAt(u + h, v) - field.evalAt(u - h, v), field.evalAt(u, v + h) - field.evalAt(u, v - h)) / (2 * h);
    d.push(Math.abs(field.evalAt(u, v)) / (g + 1e-6));
  }
  d.sort((a, b) => a - b);
  return { med: d[d.length >> 1], p80: d[Math.floor(d.length * 0.8)] };
}

test('seedScatter, pour, drop, take, countNear', () => {
  const { sand } = world();
  sand.seedScatter(5000);
  assert.ok(sand.n > 4900 && sand.n <= 5000, `${sand.n}`);
  assert.ok(inPlate(sand));
  const n0 = sand.n;
  assert.equal(sand.pour(0.2, -0.3, 300), 300);
  assert.equal(sand.n, n0 + 300);
  assert.equal(sand.pour(0.2, -0.3, 40, 1, 0.01), 40);
  assert.equal(sand.goldCount, 40);
  assert.equal(sand.pour(NaN, 0, 10), 0);
  assert.equal(sand.drop(0.5, 0.5, 20, 0), 20);
  // countNear agrees with a brute-force count (cell-resolution tolerance)
  let brute = 0;
  for (let i = 0; i < sand.n; i++) if ((sand.x[i] - 0.2) ** 2 + (sand.y[i] + 0.3) ** 2 < 0.08 ** 2) brute++;
  const c = sand.countNear(0.2, -0.3, 0.08);
  assert.ok(Math.abs(c - brute) < 0.2 * brute, `countNear ${c} vs ${brute}`);
  assert.equal(sand.countNear(NaN, 0, 0.1), 0);
  // take prefers plain sand
  const before = sand.goldCount;
  const took = sand.take(0.2, -0.3, 0.05, 50);
  assert.equal(took, 50);
  assert.equal(sand.goldCount, before, 'gold untouched while sand is available');
  assert.equal(sand.take(0.2, -0.3, 0.0, 10), 0);
  // a cap is a cap
  const small = createSand(createField({}), { cap: 100 });
  assert.equal(small.pour(0, 0, 500, 0, 0.05), 100);
  assert.equal(small.n, 100);
});

test('a silent plate: grains do not move at all', () => {
  const w = world(3000);
  const x0 = Float32Array.from(w.sand.x.subarray(0, w.sand.n)), y0 = Float32Array.from(w.sand.y.subarray(0, w.sand.n));
  step(w, 2);
  assert.ok(w.sand.asleep);
  for (let i = 0; i < w.sand.n; i++) { assert.equal(w.sand.x[i], x0[i]); assert.equal(w.sand.y[i], y0[i]); }
});

test('a vibrating plate draws sand onto its nodal lines within seconds', () => {
  const w = world(12000);
  w.field.setSource('t', [{ mode: '2.5+', amp: 0.8 }]);
  step(w, 0.5);
  const early = nodalDistance(w.field, w.sand);
  step(w, 5.5);
  const late = nodalDistance(w.field, w.sand);
  assert.ok(late.med < 0.006, `median ${late.med}`);        // < 2 px at a 600 px plate
  assert.ok(late.p80 < 0.015, `p80 ${late.p80}`);
  assert.ok(late.p80 < early.p80 / 3);
  assert.ok(inPlate(w.sand));
  assert.ok(w.sand.lost < 0.01 * 12000, `lost ${w.sand.lost}`);
});

test('even a slow, quiet bow on the lowest mode forms its figure in under 10 s', () => {
  const w = world(12000);
  w.field.setSource('t', [{ mode: '1.2+', amp: 0.3 }]);
  step(w, 9);
  const d = nodalDistance(w.field, w.sand);
  assert.ok(d.p80 < 0.03, `p80 ${d.p80}`);
});

test('when the plate falls silent the figure freezes where it lies', () => {
  const w = world(8000);
  w.field.setSource('t', [{ mode: '3.4-', amp: 0.8 }]);
  step(w, 4);
  w.field.setSource('t', []);
  // release takes a few seconds; once the amplitude is under the threshold the grains stop dead
  let t = 0;
  while (w.field.total > 0.02 && t < 20) { step(w, 0.1); t += 0.1; }
  step(w, 0.5);
  const x0 = Float32Array.from(w.sand.x.subarray(0, w.sand.n));
  step(w, 3);
  assert.ok(w.sand.asleep);
  let moved = 0;
  for (let i = 0; i < w.sand.n; i++) moved = Math.max(moved, Math.abs(w.sand.x[i] - x0[i]));
  assert.equal(moved, 0);
});

test('loud plates throw a few grains into the dark; slow ones rest on the rim', () => {
  const w = world(10000);
  w.field.setSource('t', [{ mode: '4.7-', amp: 1.2 }]);
  step(w, 6);
  assert.ok(inPlate(w.sand));
  assert.ok(w.sand.lost > 0 && w.sand.lost < 0.04 * 10000, `lost ${w.sand.lost}`);
});

test('the floor sweeps the whole plate bare within 8 s, sand gathering at the rim', () => {
  const w = world(15000);
  w.field.setSource('t', [{ mode: '3.5-', amp: 0.8 }]);
  step(w, 3);
  const n0 = w.sand.n;
  w.field.setSource('t', []);
  w.field.setSource('floor', [{ mode: 'floor', amp: 1.2 }]);
  step(w, 8);
  let inside = 0;
  for (let i = 0; i < w.sand.n; i++) if (Math.max(Math.abs(w.sand.x[i]), Math.abs(w.sand.y[i])) < 0.9) inside++;
  assert.equal(inside, 0, `${inside} grains still on the open plate`);
  assert.ok(n0 - w.sand.n < 0.02 * n0, `lost ${n0 - w.sand.n} of ${n0}`);
});

test('fine dust trembles at antinodes only when the plate is loud', () => {
  const quiet = world(15000), loud = world(15000);
  quiet.field.setSource('t', [{ mode: '3.3+', amp: 0.5 }]);
  loud.field.setSource('t', [{ mode: '3.3+', amp: 1.15 }]);
  step(quiet, 6); step(loud, 6);
  const atAnti = (w) => { let k = 0; for (let i = 0; i < w.sand.n; i++) if (Math.abs(w.field.evalAt(w.sand.x[i], w.sand.y[i])) > 0.6 * w.field.total) k++; return k / w.sand.n; };
  const q = atAnti(quiet), l = atAnti(loud);
  assert.ok(q < 0.004, `quiet ${q}`);
  assert.ok(l > 0.006 && l < 0.05, `loud ${l}`);
});

test('peaks: sorted, spaced, crossings first in a superposition', () => {
  const w = world(22000);
  w.field.setSource('t', [{ mode: '1.3+', amp: 0.5 }, { mode: '3.3+', amp: 0.5 }]);
  step(w, 8);
  const pk = w.sand.peaks();
  assert.ok(pk.length >= 6 && pk.length <= 12);
  for (let i = 1; i < pk.length; i++) assert.ok(pk[i - 1].score >= pk[i].score);
  for (const p of pk) assert.ok(p.n >= 22 && Math.abs(p.u) < 1 && Math.abs(p.v) < 1);
  for (let i = 0; i < pk.length; i++) for (let j = 0; j < i; j++) assert.ok(Math.hypot(pk[i].u - pk[j].u, pk[i].v - pk[j].v) >= 0.09);
  // a crossing: the field and its gradient both vanish there
  const A = w.field.total, k = w.field.kEff, h = 0.01;
  const gradN = (u, v) => Math.hypot(w.field.evalAt(u + h, v) - w.field.evalAt(u - h, v), w.field.evalAt(u, v + h) - w.field.evalAt(u, v - h)) / (2 * h) / (A * Math.sqrt(k));
  for (const p of pk.slice(0, 3)) {
    assert.ok(Math.abs(w.field.evalAt(p.u, p.v)) < 0.03 * A, 'on a nodal line');
    assert.ok(gradN(p.u, p.v) < 0.12, `top peak (${p.u.toFixed(2)},${p.v.toFixed(2)}) is not a crossing: ${gradN(p.u, p.v)}`);
    assert.ok(p.cross > 0.5);
  }
  assert.ok(w.sand.peaks(1e9).length === 0);
});

test('texture(): RGBA bytes from density, rebuilt only on change', () => {
  const { sand } = world(4000);
  sand.pour(0.5, 0.5, 200, 1, 0.02);
  const t = sand.texture();
  assert.equal(t.length, sand.D * sand.D * 4);
  let r = 0, g = 0;
  for (let i = 0; i < t.length; i += 4) { r += t[i]; g += t[i + 1]; assert.equal(t[i + 2], 0); assert.equal(t[i + 3], 255); }
  assert.ok(r > 0 && g > 0);
  assert.equal(sand.texture(), t, 'same buffer');
  assert.equal(sand.density.length, sand.D * sand.D);
});

test('serialize: compact, faithful round trip', () => {
  const w = world(26000);
  const scatter = JSON.stringify(w.sand.serialize());
  assert.ok(scatter.length < 20000, `scatter snapshot ${scatter.length} B`);
  w.sand.pour(-0.4, 0.4, 300, 1, 0.05);
  w.field.setSource('t', [{ mode: '2.4-', amp: 0.8 }]);
  step(w, 6);
  const snap = w.sand.serialize();
  const json = JSON.stringify(snap);
  assert.ok(json.length < 20000, `figure snapshot ${json.length} B`);
  const w2 = world();
  const restored = w2.sand.deserialize(JSON.parse(json));
  assert.equal(restored, w.sand.n);
  assert.equal(w2.sand.n, w.sand.n);
  assert.equal(w2.sand.goldCount, w.sand.goldCount);
  // the figure survives: 64×64 count maps correlate strongly
  const map = (s) => { const m = new Float64Array(64 * 64); for (let i = 0; i < s.n; i++) m[Math.min(63, ((s.y[i] + 1) * 32) | 0) * 64 + Math.min(63, ((s.x[i] + 1) * 32) | 0)]++; return m; };
  const a = map(w.sand), b = map(w2.sand);
  let ma = 0, mb = 0; for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; } ma /= a.length; mb /= b.length;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  assert.ok(sab / Math.sqrt(saa * sbb) > 0.97, `correlation ${sab / Math.sqrt(saa * sbb)}`);
  assert.ok(w2.sand.asleep, 'restored onto a still plate');
});

test('deserialize: original 64×64 byte format, null and garbage', () => {
  const S = 64, a = new Uint8Array(S * S), g = new Uint8Array(S * S);
  a[10 * S + 10] = 30; a[40 * S + 20] = 255; g[5 * S + 5] = 7;
  const { sand } = world();
  assert.equal(sand.deserialize({ S, n: 292, sand: b64(a), gold: b64(g) }), 292);
  assert.equal(sand.goldCount, 7);
  assert.equal(sand.countNear(-1 + (10.5 * 2) / S, -1 + (10.5 * 2) / S, 0.02) >= 20, true);
  assert.equal(sand.deserialize(null), 0);
  assert.equal(sand.n, 0);
  const fresh = sand.deserialize({ v: 2, S: 128, sand: '***not base64***' });
  assert.ok(fresh > 10000, 'a damaged snapshot gives a fresh dusting');
});

test('count stream codec round-trips every range', () => {
  const arr = new Uint16Array(5000);
  const vals = [0, 1, 12, 13, 200, 268, 269, 1000, 40000, 65535];
  for (let i = 0; i < arr.length; i++) arr[i] = i % 7 === 0 ? vals[(i / 7) % vals.length | 0] : 0;
  arr[4999] = 3;
  const back = decodeCounts(encodeCounts(arr), arr.length);
  assert.deepEqual(Array.from(back), Array.from(arr));
  assert.deepEqual(Array.from(decodeCounts(encodeCounts(new Uint16Array(17)), 17)), new Array(17).fill(0));
});

test('deterministic for equal seeds and equal histories', () => {
  const a = world(3000), b = world(3000);
  for (const w of [a, b]) { w.field.setSource('t', [{ mode: '2.3-', amp: 0.6 }]); w.sand.pour(0.1, 0.1, 100, 1); }
  step(a, 2); step(b, 2);
  assert.equal(a.sand.n, b.sand.n);
  for (let i = 0; i < a.sand.n; i++) { assert.equal(a.sand.x[i], b.sand.x[i]); assert.equal(a.sand.y[i], b.sand.y[i]); }
});

test('robust: NaN amplitude, huge dt, junk calls', () => {
  const w = world(2000);
  w.field.total = NaN;            // as if something upstream misbehaved
  w.sand.update(1 / 60);
  w.sand.update(NaN); w.sand.update(-1); w.sand.update(1e9);
  w.sand.scatter(NaN, 0, 1); w.sand.scatter(0, 0, Infinity);
  w.field.setSource('t', [{ mode: '1.4+', amp: 0.7 }]);
  step(w, 1);
  for (let i = 0; i < w.sand.n; i++) assert.ok(Number.isFinite(w.sand.x[i]) && Number.isFinite(w.sand.y[i]));
  assert.ok(inPlate(w.sand));
  assert.ok(Array.isArray(w.sand.peaks()));
});

test('a dreaming plate: sand creeps into a silent figure over about a minute', () => {
  const w = world(10000);
  const ghost = createField({});
  ghost.setSource('g', [{ mode: '3.4-', amp: 0.6 }]);
  for (let i = 0; i < 300; i++) ghost.update(1 / 60);
  const start = nodalDistance(ghost, w.sand);
  w.sand.setDream([{ mode: '3.4-', amp: 0.6 }]);
  assert.ok(w.sand.dreaming);
  step(w, 10);
  const early = nodalDistance(ghost, w.sand);
  assert.ok(early.med > 0.02, 'slow: no figure after 10 s');
  step(w, 80);
  const late = nodalDistance(ghost, w.sand);
  assert.ok(late.med < start.med / 4 && late.med < 0.015, `med ${start.med} -> ${late.med}`);
  assert.equal(w.field.total, 0, 'the plate itself stays silent');
  assert.equal(w.sand.lost, 0);
  // the real plate takes over whenever it sings; waking ends the dream
  w.sand.setDream(null);
  step(w, 1);
  assert.ok(w.sand.asleep && !w.sand.dreaming);
});

test('performance: 26000 grains (incl. density rebuild)', (t) => {
  const w = world(26000);
  const modes = ['3.5-', '2.4+', '1.6-', '4.5+', '2.2+'];
  const times = [];
  for (let i = 0; i < 300; i++) {
    w.field.setSource('t', modes.map((m, j) => ({ mode: m, amp: (0.6 / (j + 1)) * (1 + 0.3 * Math.sin(i * 0.1 + j)) })));
    w.field.update(1 / 60);
    const a = performance.now(); w.sand.update(1 / 60); times.push(performance.now() - a);
  }
  times.sort((a, b) => a - b);
  const med = times[times.length >> 1];
  t.diagnostic(`sand.update median ${med.toFixed(2)} ms, min ${times[0].toFixed(2)} ms for ${w.sand.n} grains`);
  assert.ok(med < 8, `median ${med.toFixed(2)} ms`);    // generous: ~2.4 ms here, < 3 ms on desktop Chrome
});
