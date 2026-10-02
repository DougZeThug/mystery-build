// Consonance math.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  gcd, ratio, consonance, consonanceWithSpectrum, feedFromSpectrum, meanConsonance, clanOf, detuned,
} from '../src/sim/harmony.js';

const near = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

test('consonance values from the bible', () => {
  assert.equal(consonance(5, 5), 1);
  near(consonance(5, 10), 0.8, 1e-12);
  near(consonance(10, 5), 0.8, 1e-12);
  near(consonance(25, 20), 0.136);          // 5:4
  near(consonance(13, 10), -0.404);         // 13:10
  near(consonance(25, 26), -0.868);         // ≈ −.86
  near(consonance(20, 40), 0.8, 1e-12);
  near(consonance(5, 40), 0.4, 1e-12);      // three octaves
});

test('consonance is symmetric, bounded, neutral for nonsense', () => {
  for (let a = 1; a < 100; a += 3) for (let b = 1; b < 100; b += 5) {
    const c = consonance(a, b);
    assert.equal(c, consonance(b, a));
    assert.ok(c >= -1 && c <= 1);
  }
  assert.equal(consonance(0, 5), 0);
  assert.equal(consonance(-4, 5), 0);
  assert.equal(consonance(NaN, 5), 0);
  assert.equal(consonance(5.2, 5), 1, 'rounds to the nearest harmonic number');
});

test('gcd, ratio', () => {
  assert.equal(gcd(50, 20), 10);
  assert.equal(gcd(13, 26), 13);
  assert.equal(gcd(0, 0), 1);
  assert.deepEqual(ratio(25, 20), { p: 5, q: 4 });
  assert.deepEqual(ratio(26, 25), { p: 26, q: 25 });
  assert.deepEqual(ratio(0, 4), { p: 0, q: 0 });
});

test('clanOf: octave classes', () => {
  for (const k of [5, 10, 20, 40]) assert.equal(clanOf(k), '5');
  for (const k of [25, 50]) assert.equal(clanOf(k), '25');
  for (const k of [13, 26, 52]) assert.equal(clanOf(k), '13');
  for (const k of [17, 34]) assert.equal(clanOf(k), '17');
  assert.equal(clanOf(65), '65');
  assert.equal(clanOf(2), '1');
  assert.equal(clanOf(8), '1');
  assert.equal(clanOf(0), '0');
  assert.equal(clanOf(NaN), '0');
});

test('consonanceWithSpectrum: number-like result with value and weight', () => {
  const spec = [{ mode: '1.3+', k: 10, amp: 0.6 }, { mode: '2.4+', k: 20, amp: 0.3 }];
  const c = consonanceWithSpectrum([5], spec);
  assert.ok(c > 0.4, 'octaves feed');
  assert.ok(Math.abs(c.value - +c) < 1e-15);
  near(c.weight, 0.9, 1e-9);
  near(c.value, (0.6 * 0.8 + 0.3 * 0.6) / 0.9, 1e-9);
  const d = consonanceWithSpectrum([25], [{ mode: '1.5+', k: 26, amp: 0.8 }]);
  assert.ok(d < -0.8, 'beating starves');
  // quiet plate is damped towards 0 (denominator floor .35)
  near(consonanceWithSpectrum([5], [{ mode: '1.3+', k: 10, amp: 0.07 }]).value, (0.07 * 0.8) / 0.35, 1e-9);
  assert.equal(+consonanceWithSpectrum([5], []), 0);
  assert.equal(+consonanceWithSpectrum([], spec), 0);
  assert.equal(+consonanceWithSpectrum(null, null), 0);
  assert.equal(JSON.stringify({ c: consonanceWithSpectrum([5], spec) }), JSON.stringify({ c: c.value }));
});

test('consonanceWithSpectrum: self weighting', () => {
  const spec = [{ mode: '1.2+', k: 5, amp: 0.5 }, { mode: '1.5+', k: 26, amp: 0.5 }];
  const all = consonanceWithSpectrum([5], spec).value;
  const exclude = consonanceWithSpectrum([5], spec, true).value;
  const map = consonanceWithSpectrum([5], spec, { '1.2+': 0.4 }).value;
  const fn = consonanceWithSpectrum([5], spec, (e) => (e.k === 5 ? 0.4 : 1)).value;
  const num = consonanceWithSpectrum([5], spec, 0.4).value;
  assert.ok(exclude < map && map < all);
  near(map, fn, 1e-12);
  near(map, num, 1e-12);
});

test('feedFromSpectrum and meanConsonance', () => {
  const spec = [{ mode: '1.3+', k: 10, amp: 0.6 }, { mode: '1.5+', k: 26, amp: 0.4 }];
  near(feedFromSpectrum([5], spec), 0.6 * 0.8 + 0.4 * consonance(5, 26), 1e-12);
  assert.equal(feedFromSpectrum([5], [{ k: 10, amp: 5 }]), 1, 'clamped');
  near(meanConsonance([5, 10], [20]), (consonance(5, 20) + consonance(10, 20)) / 2, 1e-12);
  assert.equal(meanConsonance([], [5]), 0);
});

test('detuned', () => {
  near(detuned(20, 0.012), 20.24, 1e-12);
  assert.equal(detuned(20, NaN), 20);
  assert.equal(detuned(20, 9), 20, 'absurd detune ignored');
});
