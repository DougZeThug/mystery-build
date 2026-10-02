// Mode library: catalogue, normalisation, edge response, GLSL twin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODES, BOWABLE, K_VALUES, modeById, modesWithK, evalMode, edgePoint, edgeResponse, modeVec, GLSL_MODE, BASE_FREQ,
} from '../src/sim/modes.js';

test('catalogue: 49 Chladni modes + the floor, ids, k, freq, bowable', () => {
  assert.equal(MODES.length, 50);
  const ids = new Set(MODES.map((m) => m.id));
  assert.equal(ids.size, MODES.length, 'ids are unique');
  for (const m of MODES) {
    if (m.special) { assert.equal(m.id, 'floor'); assert.equal(m.k, 2); assert.equal(m.bowable, false); continue; }
    assert.match(m.id, /^[1-7]\.[1-7][+-]$/);
    assert.equal(m.id, `${m.n}.${m.m}${m.s > 0 ? '+' : '-'}`);
    assert.ok(m.n <= m.m);
    if (m.n === m.m) assert.equal(m.s, 1, 'n == m only has the symmetric mode');
    assert.equal(m.k, m.n * m.n + m.m * m.m);
    assert.equal(m.freq, BASE_FREQ * m.k);
    assert.equal(m.bowable, m.k >= 5 && m.k <= 65);
    assert.equal(MODES[m.index], m);
  }
  assert.deepEqual(K_VALUES, [2, 5, 8, 10, 13, 17, 18, 20, 25, 26, 29, 32, 34, 37, 40, 41, 45, 50, 52, 53, 58, 61, 65, 72, 74, 85, 98]);
  assert.ok(BOWABLE.every((m) => m.bowable));
  assert.equal(modeById('2.5-').k, 29);
  assert.equal(modeById('nope'), null);
  assert.equal(modeById(null), null);
  assert.equal(modeById(modeById('3.4+')), modeById('3.4+'), 'accepts a mode object');
  assert.deepEqual(modesWithK(50).map((m) => m.id).sort(), ['1.7+', '1.7-', '5.5+']);
});

test('normalisation: max |M| over the plate is 1 for every mode', () => {
  const N = 200;
  for (const m of MODES) {
    let mx = 0;
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
      mx = Math.max(mx, Math.abs(evalMode(m, -1 + (2 * i) / N, -1 + (2 * j) / N)));
    }
    assert.ok(mx <= 1 + 1e-9, `${m.id} exceeds 1 (${mx})`);
    assert.ok(mx > 0.995, `${m.id} peaks at only ${mx}`);
  }
  // the same-parity antisymmetric modes peak inside the plate, not at a corner
  assert.ok(Math.abs(modeById('1.3-').norm - 1 / 1.53959) < 1e-4);
  assert.equal(modeById('2.4+').norm, 0.5);
});

test('floor: one antinode in the middle, stillness exactly at the rim', () => {
  const f = modeById('floor');
  assert.equal(evalMode(f, 0, 0), 1);
  for (const t of [-1, -0.5, 0, 0.3, 1]) {
    assert.ok(Math.abs(evalMode(f, 1, t)) < 1e-12);
    assert.ok(Math.abs(evalMode(f, t, -1)) < 1e-12);
  }
  assert.ok(evalMode(f, 0.5, 0.5) > 0 && evalMode(f, 0.5, 0.5) < 1);
});

test('edges run clockwise and edgeResponse = |M| at the edge point', () => {
  assert.deepEqual(edgePoint('top', 0), { u: -1, v: -1 });
  assert.deepEqual(edgePoint('top', 1), { u: 1, v: -1 });
  assert.deepEqual(edgePoint('right', 0), { u: 1, v: -1 });
  assert.deepEqual(edgePoint('bottom', 0), { u: 1, v: 1 });
  assert.deepEqual(edgePoint('left', 0), { u: -1, v: 1 });
  assert.deepEqual(edgePoint('left', 1), { u: -1, v: -1 });
  for (const m of MODES) for (const e of ['top', 'right', 'bottom', 'left']) for (let t = 0; t <= 1; t += 0.05) {
    const p = edgePoint(e, t);
    const r = edgeResponse(m, e, t);
    assert.ok(Math.abs(r - Math.abs(evalMode(m, p.u, p.v))) < 1e-12);
    assert.ok(r >= 0 && r <= 1 + 1e-12);
  }
  // corners: symmetric modes are loud there, antisymmetric same-parity ones silent
  assert.ok(Math.abs(edgeResponse(modeById('1.3+'), 'top', 0) - 1) < 1e-9);
  assert.ok(edgeResponse(modeById('1.3-'), 'top', 0) < 1e-9);
  // robustness
  assert.equal(edgeResponse(modeById('2.3+'), 'top', NaN), edgeResponse(modeById('2.3+'), 'top', 0));
  assert.equal(edgeResponse(modeById('2.3+'), 'top', 7), edgeResponse(modeById('2.3+'), 'top', 1));
  assert.equal(edgeResponse(null, 'top', 0.5), 0);
});

// Port the GLSL source textually to JS (it is written in a scalar subset on purpose) and compare.
function portGlsl(src) {
  const js = src
    .replace(/\bfloat\s+(\w+)\s*\(([^)]*)\)\s*\{/g, (_, name, params) =>
      `function ${name}(${params.split(',').map((p) => p.trim().split(/\s+/).pop()).join(', ')}) {`)
    .replace(/\bfloat\s+(\w+)\s*=/g, 'let $1 =')
    .replace(/\b(cos|sin|abs|min|max|sqrt)\(/g, 'Math.$1(');
  assert.ok(!/\bvec[234]\s*\(/.test(js), 'no vector constructors left: ' + js);
  return new Function(`${js}\nreturn { chladni, chladniNorm, chladniN };`)();
}

test('GLSL twin: chladniN matches evalMode; chladni is the raw sum', () => {
  assert.match(GLSL_MODE, /float chladni\(vec2 uv, vec3 nms\)/);
  assert.match(GLSL_MODE, /float chladniN\(vec2 uv, vec3 nms\)/);
  const g = portGlsl(GLSL_MODE);
  let worst = 0;
  for (const m of MODES) {
    const nms = { x: m.n, y: m.m, z: m.s };
    assert.ok(Math.abs(g.chladniNorm(nms) - m.norm) < 1e-5, `${m.id} norm`);
    for (let j = 0; j <= 12; j++) for (let i = 0; i <= 12; i++) {
      const uv = { x: -1 + i / 6, y: -1 + j / 6 };
      const want = evalMode(m, uv.x, uv.y);
      worst = Math.max(worst, Math.abs(g.chladniN(uv, nms) - want));
      assert.ok(Math.abs(g.chladni(uv, nms) * m.norm - want) < 2e-6);
    }
  }
  assert.ok(worst < 2e-6, `max deviation ${worst}`);
});

test('modeVec packs [n, m, s, norm]', () => {
  assert.deepEqual(modeVec('2.5-'), [2, 5, -1, 0.5]);
  assert.deepEqual(modeVec('floor'), [0, 0, 1, 1]);
  assert.deepEqual(modeVec('bogus'), [0, 0, 0, 0]);
});
