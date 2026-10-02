// bowPick tuning: reachability over (edge, t, speed), speed ordering, stability.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOWABLE, EDGES, bowPick, bowTargetK, createBowSelector, modeById } from '../src/sim/modes.js';

// full sweep: every edge, t = 0..1 step .01, speed = 0..1 step .02 (no hysteresis)
const reach = new Map();
for (const e of EDGES) for (let ti = 0; ti <= 100; ti++) for (let si = 0; si <= 50; si++) {
  const id = bowPick(e, ti / 100, si / 50, null);
  let r = reach.get(id);
  if (!r) reach.set(id, (r = { hits: 0, speeds: [] }));
  r.hits++; r.speeds.push(si / 50);
}

test('sweep: every bowable mode with k <= 50 is reachable', (t) => {
  const missing = BOWABLE.filter((m) => m.k <= 50 && !reach.has(m.id)).map((m) => m.id);
  assert.deepEqual(missing, []);
  for (const id of reach.keys()) assert.ok(modeById(id).bowable, `${id} is bowable`);
  const rows = BOWABLE.map((m) => {
    const r = reach.get(m.id);
    return r ? `${m.id}(k${m.k}) ${Math.min(...r.speeds).toFixed(2)}–${Math.max(...r.speeds).toFixed(2)}` : `${m.id} -`;
  });
  t.diagnostic(`reachable ${reach.size}/${BOWABLE.length}: ${rows.join(', ')}`);
});

test('sweep: low k at slow strokes, high k at fast ones', () => {
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const pts = [...reach.entries()].map(([id, r]) => ({ k: modeById(id).k, s: mean(r.speeds), min: Math.min(...r.speeds) }));
  for (const p of pts) {
    if (p.k <= 10) assert.ok(p.min <= 0.25, `k=${p.k} reachable slowly (min speed ${p.min})`);
    if (p.k >= 50) assert.ok(p.min >= 0.6, `k=${p.k} needs vigour (min speed ${p.min})`);
  }
  // Spearman rank correlation between k and mean speed
  const rank = (arr) => { const s = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = []; s.forEach(([, i], n) => { r[i] = n; }); return r; };
  const rk = rank(pts.map((p) => p.k)), rs = rank(pts.map((p) => p.s));
  const n = pts.length; let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (rk[i] - rs[i]) ** 2;
  const rho = 1 - (6 * d2) / (n * (n * n - 1));
  assert.ok(rho > 0.95, `rank correlation ${rho}`);
  // the target itself is monotonic
  for (let s = 0; s < 1; s += 0.05) assert.ok(bowTargetK(s + 0.05) > bowTargetK(s));
  assert.ok(bowTargetK(0) < 5 && bowTargetK(1) > 65);
});

test('hysteresis: sliding along an edge never ping-pongs A→B→A within 4 steps', () => {
  let pingpong = 0, flips = 0, sweeps = 0;
  for (const e of EDGES) for (let si = 0; si <= 50; si++) {
    let cur = null; const hist = [];
    for (let ti = 0; ti <= 100; ti++) {
      const prev = cur;
      cur = bowPick(e, ti / 100, si / 50, cur);
      if (prev && cur !== prev) { flips++; hist.push([ti, cur]); }
    }
    for (let i = 2; i < hist.length; i++) if (hist[i][1] === hist[i - 2][1] && hist[i][0] - hist[i - 2][0] <= 4) pingpong++;
    sweeps++;
  }
  assert.equal(pingpong, 0);
  assert.ok(flips / sweeps < 9, `mean flips per full-edge sweep ${(flips / sweeps).toFixed(1)}`);
});

test('hysteresis: holding still with a slightly wavering hand keeps the mode', () => {
  let unstable = 0, total = 0;
  for (const e of EDGES) for (let ti = 1; ti < 100; ti += 2) for (let si = 2; si <= 48; si += 4) {
    let cur = bowPick(e, ti / 100, si / 50, null), changes = 0;
    for (let q = 0; q < 40; q++) {
      const c = bowPick(e, ti / 100 + 0.006 * Math.sin(q * 2.3), si / 50 + 0.015 * Math.sin(q * 1.7), cur);
      if (c !== cur) { changes++; cur = c; }
    }
    if (changes > 2) unstable++;
    total++;
  }
  assert.ok(unstable / total < 0.05, `${((100 * unstable) / total).toFixed(1)}% of positions stutter`);
});

test('deterministic, honours suppression, tolerates junk input', () => {
  assert.equal(bowPick('top', 0.37, 0.4, null), bowPick('top', 0.37, 0.4, null));
  const free = bowPick('right', 0.21, 0.5, null);
  const choked = bowPick('right', 0.21, 0.5, null, (m) => (m.id === free ? 1 : 0));
  assert.notEqual(choked, free);
  assert.ok(modeById(bowPick('left', NaN, NaN, 'junk')));
  assert.ok(modeById(bowPick('top', -3, 9, null)));
});

test('createBowSelector waits for a new mode to persist before switching', () => {
  const sel = createBowSelector(0.2);
  const a = sel.pick('top', 0.5, 0.1, 1 / 60);
  assert.equal(sel.current, a);
  // find a position that picks something else
  let t = 0, b = a;
  while (b === a && t < 1) { t += 0.01; b = bowPick('top', t, 0.9, null); }
  assert.notEqual(b, a);
  assert.equal(sel.pick('top', t, 0.9, 1 / 60), a, 'one frame is not enough');
  let out = a;
  for (let i = 0; i < 15; i++) out = sel.pick('top', t, 0.9, 1 / 60);
  assert.equal(out, bowPick('top', t, 0.9, a), 'switches after the hold time');
  sel.reset();
  assert.equal(sel.current, null);
});
