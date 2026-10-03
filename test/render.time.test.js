// The shaders see time wrapped on TIME_WRAP (200π s) so float32 never loses its fraction. That is
// only seamless for periodic terms whose rate is a whole number of turns per wrap: every literal
// rate on uTime must be a multiple of 0.01 rad/s. Slow non-periodic drifts read uTimeS instead,
// and the film grain takes its own wrapped seed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as SH from '../src/render/shaders.js';

const sources = Object.entries(SH).filter(([, v]) => typeof v === 'string');

test('the wrap is a whole number of turns for 0.01 rad/s', () => {
  const turns = (SH.TIME_WRAP * 0.01) / (2 * Math.PI);
  assert.ok(Math.abs(turns - Math.round(turns)) < 1e-9);
});

test('every literal rate on uTime wraps without a seam', () => {
  let seen = 0;
  for (const [name, src] of sources) {
    for (const m of src.matchAll(/uTime\s*\*\s*(\d+(?:\.\d+)?)(?![\d.]*\s*[/*])/g)) {
      const rate = +m[1];
      seen++;
      assert.ok(Math.abs(rate * 100 - Math.round(rate * 100)) < 1e-6, `${name}: uTime * ${m[1]} is not a multiple of 0.01`);
    }
  }
  assert.ok(seen > 10, 'expected to find the shaders\' rates');
});

test('dust and beam shafts drift on slow time; grain has its own seed', () => {
  assert.ok(!/uTime\b/.test(SH.VS_DUST), 'VS_DUST should read uTimeS only');
  assert.ok(!/floor\(uTime\s*\*\s*24/.test(SH.FS_COMPOSITE), 'grain seed must not come from raw time');
  assert.ok(/uGrain/.test(SH.FS_COMPOSITE));
});
