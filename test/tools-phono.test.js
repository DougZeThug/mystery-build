// Pure logic of the phonograph (src/ui/tools-phono.js): frame capture, playback mixing, labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mixFrames, compactFrame, cylinderLabel } from '../src/ui/tools-phono.js';

const pool = () => Array.from({ length: 8 }, () => ({ mode: null, amp: 0 }));
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) <= e, `${a} ≉ ${b}`);

test('compactFrame keeps the four loudest modes, amps to .01, drops the inaudible', () => {
  const sp = [
    { mode: '2.3+', amp: 0.4567 }, { mode: '1.4-', amp: 0.2 }, { mode: '3.4+', amp: 0.1049 },
    { mode: '1.2+', amp: 0.05 }, { mode: '2.5-', amp: 0.04 }, { mode: '1.3+', amp: 0.004 },
  ];
  assert.deepEqual(compactFrame(sp), [['2.3+', 0.46], ['1.4-', 0.2], ['3.4+', 0.1], ['1.2+', 0.05]]);
  assert.deepEqual(compactFrame([{ mode: 'x', amp: 0.004 }]), []);
  assert.deepEqual(compactFrame(null), []);
});

test('mixFrames eases linearly between frames, scaled by .85, and fades in and out', () => {
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push(i % 2 ? [['2.3+', 0.6], ['1.4-', 0.2]] : [['2.3+', 0.4]]);
  const comps = pool(), live = [];
  const dur = (frames.length - 1) * 0.25;
  // half way between frame 4 (0.4) and frame 5 (0.6 + a new mode at 0.2)
  mixFrames(frames, 0.25, 1.125, dur, comps, live);
  const a = live.find((c) => c.mode === '2.3+'), b = live.find((c) => c.mode === '1.4-');
  near(a.amp, 0.5 * 0.85);
  near(b.amp, 0.1 * 0.85);
  // at the very start the needle has only just touched: silent
  mixFrames(frames, 0.25, 0, dur, comps, live);
  assert.equal(live.length, 0);
  // and it ramps up over the first third of a second
  mixFrames(frames, 0.25, 0.175, dur, comps, live);       // w = .7 between frames 0 and 1, envelope .5
  near(live.find((c) => c.mode === '2.3+').amp, (0.4 * 0.3 + 0.6 * 0.7) * 0.85 * 0.5);
});

test('mixFrames never drives the plate harder than the cap, and skips unknown modes', () => {
  const frames = Array.from({ length: 10 }, () => [['2.3+', 1.2], ['1.4-', 1.1], ['3.4+', 0.9]]);
  const comps = pool(), live = [];
  const norm = mixFrames(frames, 0.25, 1, 2.25, comps, live);
  const s = Math.sqrt(live.reduce((t, c) => t + c.amp * c.amp, 0));
  assert.ok(s <= 0.62 + 1e-9, `norm ${s}`);
  near(norm, s, 1e-9);
  mixFrames(frames, 0.25, 1, 2.25, comps, live, (id) => id !== '1.4-');
  assert.ok(!live.some((c) => c.mode === '1.4-'));
  assert.equal(mixFrames([], 0.25, 1, 1, comps, live), 0);
});

test('cylinderLabel names a recording after who was singing', () => {
  const eve = new Date(2026, 9, 3, 19, 30);
  const night = new Date(2026, 9, 3, 23, 30);
  assert.equal(cylinderLabel({ n: 20, w: { Pentas: 40 } }, eve), 'the Pentas evening');
  assert.equal(cylinderLabel({ n: 20, w: { Pentas: 40, Dyas: 25 } }, eve), 'Pentas & Dyas');
  assert.equal(cylinderLabel({ n: 20, w: { Pentas: 40, Dyas: 5 } }, night), 'the Pentas night');
  assert.equal(cylinderLabel({ n: 20, choir: 15, w: { Pentas: 40 } }, eve), 'the choir, evening');
  assert.equal(cylinderLabel({ n: 20, floor: 8, w: { Pentas: 40 } }, eve), 'below the floor');
  assert.equal(cylinderLabel({ n: 20, dark: 20, w: { Pentas: 40 } }, eve), 'the Pentas asleep');
  assert.equal(cylinderLabel({ n: 4, w: {}, frames: [[['2.3+', 0.5]]] }, eve, () => 13), 'a bare plate, 13');
  assert.equal(cylinderLabel({ n: 4, w: {}, frames: [] }, eve), 'a silence, evening');
});
