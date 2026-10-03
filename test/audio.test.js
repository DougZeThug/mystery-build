// Unit tests for the audio module's pure DSP (src/audio/dsp.js): no WebAudio needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry, hash01, whiteNoise, pinkNoise, brownNoise, roomTone, reverbChannel, crackle, sandGrains, crumble, crinkle,
  softClipCurve, foldInto, voiceChord, droneRootHz, rms, peak, BUFFER_JOBS, resample,
  waxCrackle, clockwork, PHONO_TURN, pitchGroups, powerByPitch, spreadOffset, minGap, singerDetune,
} from '../src/audio/dsp.js';
import { MODES, modeById } from '../src/sim/modes.js';

const SR = 8000;   // small rate keeps the tests fast; the generators are rate-agnostic
const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
const finite = (x) => x.every(Number.isFinite);

test('prng and hash are deterministic and in [0,1)', () => {
  const a = mulberry(3), b = mulberry(3);
  for (let i = 0; i < 100; i++) { const v = a(); assert.equal(v, b()); assert.ok(v >= 0 && v < 1); }
  assert.equal(hash01('2.4+|1.3+'), hash01('2.4+|1.3+'));
  assert.notEqual(hash01('2.4+'), hash01('2.4-'));
});

test('noise colours: zero mean, RMS 0.3, finite, loop without a seam', () => {
  for (const gen of [whiteNoise, pinkNoise, brownNoise]) {
    const x = gen(SR * 2, 5);
    assert.ok(finite(x));
    assert.ok(Math.abs(mean(x)) < 1e-6);
    assert.ok(Math.abs(rms(x) - 0.3) < 1e-3);
  }
  // brown noise wanders slowly: the loop point must not jump more than a typical step
  const br = brownNoise(SR * 2, 9);
  let step = 0;
  for (let i = 1; i < br.length; i++) step = Math.max(step, Math.abs(br[i] - br[i - 1]));
  assert.ok(Math.abs(br[0] - br[br.length - 1]) <= step * 1.5);
});

test('room tone is a quiet-able rumble with a little air, zero-mean', () => {
  const x = roomTone(SR, 2, 1);
  assert.ok(finite(x));
  assert.ok(Math.abs(mean(x)) < 1e-3);
  assert.ok(rms(x) > 0.25 && rms(x) < 0.4);
});

test('reverb channel: unit energy, decays, dark tail', () => {
  const x = reverbChannel(SR, 0, { seconds: 3.2 });
  assert.ok(finite(x));
  let e = 0; for (const v of x) e += v * v;
  assert.ok(Math.abs(e - 1) < 1e-3);
  const head = rms(x.subarray(0, SR / 2)), tail = rms(x.subarray(x.length - SR / 2));
  assert.ok(tail < head * 0.01, `tail ${tail} vs head ${head}`);
  assert.ok(x[x.length - 1] === 0, 'the tail is faded to silence');
  const l = reverbChannel(SR, 0), r = reverbChannel(SR, 1);
  let c = 0; for (let i = 0; i < l.length; i++) c += l[i] * r[i];
  assert.ok(Math.abs(c) < 0.2, 'channels are decorrelated');
});

test('grain textures behave', () => {
  const ck = crackle(SR, 1, 2);
  assert.ok(ck.every((v) => v >= 0 && v <= 1.4), 'crackle is a positive modulator');
  const sg = sandGrains(SR, 1, 2, 800, 500, 3500);
  assert.ok(finite(sg) && Math.abs(mean(sg)) < 1e-6);
  const cr = crumble(SR, 1.9, 4);
  assert.ok(finite(cr) && peak(cr) <= 0.8 + 1e-6);
  assert.ok(cr[cr.length - 1] === 0, 'crumble ends in silence');
  assert.ok(rms(cr.subarray(0, SR / 4)) > rms(cr.subarray(cr.length - SR / 4)) * 4, 'crumble thins out');
  assert.ok(finite(crinkle(SR, 1, 3)));
});

test('every buffer job yields finite channels', () => {
  for (const [name, job] of BUFFER_JOBS) {
    const chans = job(SR, 7);
    assert.ok(Array.isArray(chans) && chans.length >= 1, name);
    for (const c of chans) assert.ok(c.length > 0 && finite(c), name);
  }
});

test('soft clip: unity below the knee, monotonic, never above the ceiling', () => {
  const c = softClipCurve(4097, 4, 0.7, 0.89);
  const at = (x) => c[Math.round(((x / 4 + 1) / 2) * 4096)];
  assert.ok(Math.abs(at(0.5) - 0.5) < 0.002);
  assert.ok(Math.abs(at(-0.3) + 0.3) < 0.002);
  for (let i = 1; i < c.length; i++) assert.ok(c[i] >= c[i - 1]);
  assert.ok(Math.max(...c) <= 0.89 && Math.min(...c) >= -0.89);
  assert.ok(Math.abs(c[2048]) < 1e-6, 'no DC at zero');
});

test('pitch: folding keeps pitch class, chords open upward, drone roots', () => {
  assert.equal(foldInto(137.5, 250, 1300), 275);
  assert.equal(foldInto(1787.5, 250, 1300), 893.75);
  assert.deepEqual(voiceChord([20, 5, 10]), [275, 550, 1100]);
  const ch = voiceChord([5, 25, 50]);
  assert.ok(ch[0] < ch[1] && ch[1] < ch[2]);
  for (const f of voiceChord([65, 13, 41])) assert.ok(f >= 250 && f <= 2100);
  assert.deepEqual(voiceChord([]), []);
  assert.equal(droneRootHz([5, 10, 20, 40]), 68.75);
  assert.equal(droneRootHz([13, 26, 52]), foldInto(27.5 * 13, 55, 110));
  assert.equal(droneRootHz([17, 13]), foldInto(27.5 * 13, 55, 110));   // gcd 1: the lowest
});

test('resampling keeps shape and length ratio', () => {
  const x = new Float32Array(4800);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * 100 * i) / 48000);
  const y = resample(x, 48000, 44100);
  assert.equal(y.length, 4410);
  for (let i = 0; i < y.length - 1; i++) assert.ok(Math.abs(y[i] - Math.sin((2 * Math.PI * 100 * i) / 44100)) < 1e-3);
  assert.equal(resample(x, 48000, 48000), x);
});

test('phonograph loops: whole turns, zero-mean, bounded, seamless, repeating once a turn', () => {
  const P = Math.round(PHONO_TURN * SR);
  for (const gen of [waxCrackle, clockwork]) {
    const x = gen(SR, 3, 4);
    assert.equal(x.length % P, 0, `${gen.name} spans whole turns`);
    assert.ok(finite(x), gen.name);
    assert.ok(Math.abs(mean(x)) < 1e-6, gen.name);
    assert.ok(peak(x) <= 0.85 + 1e-6 && peak(x) > 0.5, gen.name);
    assert.ok(rms(x) > 0.02 && rms(x) < 0.3, `${gen.name} rms ${rms(x)}`);
    // the loop point is no louder a jump than the signal's own steps
    let step = 0;
    for (let i = 1; i < x.length; i++) step = Math.max(step, Math.abs(x[i] - x[i - 1]));
    assert.ok(Math.abs(x[0] - x[x.length - 1]) <= step, gen.name);
  }
  // the clockwork repeats every turn: turn-to-turn correlation is strong (its teeth come round)
  const c = clockwork(SR, 3, 4);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < P; i++) { const a = c[i] * c[i], b = c[i + P] * c[i + P]; ab += a * b; aa += a * a; bb += b * b; }
  assert.ok(ab / Math.sqrt(aa * bb) > 0.3, 'tick energy recurs each turn');
});

test('pitch groups: modes that share k share one voice, at their power sum', () => {
  const P = pitchGroups(MODES);
  const g = (id) => P.group[modeById(id).index];
  assert.equal(g('1.2+'), g('1.2-'));
  assert.equal(g('1.7+'), g('5.5+'));                        // k = 50 three ways
  assert.notEqual(g('1.2+'), g('1.3+'));
  assert.equal(g('floor'), -1, 'the floor has its own voice');
  assert.equal(P.count, new Set(MODES.filter((m) => !m.special).map((m) => m.k)).size);
  for (const m of MODES) if (!m.special) assert.equal(P.hz[P.group[m.index]], m.freq);
  const amps = new Float32Array(MODES.length), out = new Float32Array(P.count);
  amps[modeById('1.2+').index] = 0.3; amps[modeById('1.2-').index] = 0.4; amps[modeById('2.4+').index] = 0.5;
  amps[modeById('floor').index] = 1;
  powerByPitch(amps, P.group, out);
  assert.ok(Math.abs(out[g('1.2+')] - 0.5) < 1e-6);
  assert.ok(Math.abs(out[g('2.4+')] - 0.5) < 1e-6);
  assert.equal(out.reduce((a, b) => a + b, 0).toFixed(6), (1).toFixed(6));
});

test('spread offset: stays near its preference, in range, and clear of what is taken when it can', () => {
  const D = { lo: -7, hi: 7, step: 0.25, min: 2.5 };
  assert.equal(spreadOffset([0], [], 3, D), 3, 'nothing taken: its own preference');
  assert.equal(spreadOffset([1200], [5000], -2, D), -2, 'far values do not matter');
  const d = spreadOffset([0], [0.5], 0, D);
  assert.ok(minGap([0], [0.5], d) >= 2.5 && Math.abs(d) <= 2.25 + 1e-9, `moved just clear: ${d}`);
  assert.equal(spreadOffset([0], [], 9, D), 7, 'preference clamped into range');
  // nothing clears: the widest gap wins, still in range
  const crowd = [];
  for (let c = -7; c <= 7; c += 1) crowd.push(c);
  const y = spreadOffset([0], crowd, 0, D);
  assert.ok(y >= D.lo && y <= D.hi);
  assert.ok(Math.abs(minGap([0], crowd, y) - 0.5) < 1e-9, `between two taken values: ${y}`);
});

test('singer detune: kinds on one pitch never lock together', () => {
  const D = { lo: -7, hi: 7, step: 0.25, min: 2.5 };
  const c = (f) => 1200 * Math.log2(f);
  // the four kinds that all sing 275 Hz (1.2±: k 5, 1.3±: k 10), each with a crowd twin above,
  // arriving one by one with nearly the same preferred detune
  const sounding = [];
  for (const [pref, twin] of [[0.4, 9], [0.1, 7], [-0.2, 11], [0.3, 8]]) {
    const pos = [c(275), c(275) + twin];
    const d = singerDetune(pos, 1, sounding, pref, D);
    assert.ok(d >= D.lo && d <= D.hi, `in range: ${d}`);
    for (const v of sounding) assert.ok(Math.abs(pos[0] + d - v.pos[0]) >= 2.5 - 1e-9, 'components keep apart');
    if (sounding.length === 1) assert.ok(minGap(pos, sounding[0].pos, d) >= 2.5 - 1e-9, 'two kinds: twins clear too');
    sounding.push({ pos: pos.map((p) => p + d), nMain: 1 });
  }
  // alone, a voice keeps its own detune; a chord that shares one pitch with a sounding voice moves
  assert.equal(singerDetune([c(275), c(275) + 9], 1, [], -3.5, D), -3.5);
  const chord = [c(275), c(550), c(275) + 6];
  const d = singerDetune(chord, 2, [{ pos: [c(550) + 0.5, c(550) + 10], nMain: 1 }], 0, D);
  assert.ok(Math.abs(chord[1] + d - (c(550) + 0.5)) >= 2.5 - 1e-9);
});
