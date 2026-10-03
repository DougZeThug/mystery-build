// Pure DSP for the audio module: deterministic buffer synthesis (noise colours, the dark room's
// impulse response, grain textures) and pitch helpers. No WebAudio in here, so node can test it.
// Every generator returns plain Float32Arrays; the engine copies them into AudioBuffers once.

const PI = Math.PI;
const TAU = PI * 2;

export const BASE_HZ = 27.5;            // freq = 27.5 · k (src/sim/modes.js)

// mulberry32: small, fast, deterministic (the room sounds the same every visit)
export function mulberry(seed = 1) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a of a string -> [0,1). Gives each species a stable vibrato rate, phase, pan wobble.
export function hash01(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------
// helpers on Float32Arrays

export function removeDC(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m += x[i];
  m /= x.length || 1;
  for (let i = 0; i < x.length; i++) x[i] -= m;
  return x;
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / (x.length || 1));
}

export function peak(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

export function scaleTo(x, targetRms) {
  const r = rms(x);
  if (r > 1e-12) { const g = targetRms / r; for (let i = 0; i < x.length; i++) x[i] *= g; }
  return x;
}

// Render n + fade samples, then fold the overshoot back over the head with an equal-power
// crossfade, so the buffer loops without a seam (matters for brown noise, which wanders).
function seamless(n, fade, fill) {
  const tmp = new Float32Array(n + fade);
  fill(tmp);
  const out = tmp.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const x = (i + 0.5) / fade;
    out[i] = tmp[i] * Math.sin(x * PI * 0.5) + tmp[n + i] * Math.cos(x * PI * 0.5);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// noise colours (all zero-mean, RMS 0.3, loopable)

export function whiteNoise(n, seed = 11) {
  const r = mulberry(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = r() * 2 - 1;
  return scaleTo(removeDC(x), 0.3);
}

// Paul Kellet's refined pink filter
export function pinkNoise(n, seed = 23) {
  const r = mulberry(seed);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const x = seamless(n, Math.min(4096, n >> 2), (buf) => {
    for (let i = 0; i < buf.length; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      buf[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    }
  });
  return scaleTo(removeDC(x), 0.3);
}

// leaky integrator, then a gentle 15 Hz high-pass so it rumbles without drifting
export function brownNoise(n, seed = 37) {
  const r = mulberry(seed);
  let b = 0, hp = 0, prev = 0;
  const a = Math.exp(-TAU * 15 / 48000);
  const x = seamless(n, Math.min(8192, n >> 2), (buf) => {
    for (let i = 0; i < buf.length; i++) {
      b = (b + 0.02 * (r() * 2 - 1)) / 1.02;
      hp = a * (hp + b - prev);
      prev = b;
      buf[i] = hp;
    }
  });
  return scaleTo(removeDC(x), 0.3);
}

// The room's own tone, baked into one loop: a brown rumble under ~140 Hz and, far beneath it, a
// thin band of air near 2.6 kHz. (One buffer source instead of two sources and two filters.)
export function roomTone(sr, seconds = 4, seed = 41) {
  const n = Math.round(sr * seconds), fade = 8192;
  const r = mulberry(seed);
  const aL = Math.exp(-TAU * 140 / sr), aH = Math.exp(-TAU * 18 / sr);
  let b = 0, l1 = 0, l2 = 0, hp = 0, prev = 0;
  const rum = seamless(n, fade, (buf) => {
    for (let i = 0; i < buf.length; i++) {
      b = (b + 0.02 * (r() * 2 - 1)) / 1.02;
      l1 = (1 - aL) * b + aL * l1; l2 = (1 - aL) * l1 + aL * l2;
      hp = aH * (hp + l2 - prev); prev = l2;
      buf[i] = hp;
    }
  });
  // two-pole resonator (bandwidth ~ 1 kHz) on white noise
  const w0 = TAU * 2600 / sr, rad = Math.exp(-PI * 1000 / sr), c1 = 2 * rad * Math.cos(w0), c2 = -rad * rad;
  let y1 = 0, y2 = 0;
  const air = seamless(n, fade, (buf) => {
    for (let i = 0; i < buf.length; i++) { const y = (r() * 2 - 1) + c1 * y1 + c2 * y2; y2 = y1; y1 = y; buf[i] = y; }
  });
  scaleTo(removeDC(rum), 0.3);
  scaleTo(removeDC(air), 0.05);
  for (let i = 0; i < n; i++) rum[i] += air[i];
  return rum;
}

// ---------------------------------------------------------------------------------------------
// The room: a dark, long, slightly uneven space (the cabinet of a 19th-century study).
// Exponentially decaying noise whose brightness falls with time (air and felt drink the highs),
// a handful of early reflections, a soft onset, high-passed so it never booms. Unit energy per
// channel, so a send gain of g gives roughly g times the dry loudness for noise-like material.

export function reverbChannel(sr, c, { seconds = 3.2, t60 = 2.8, pre = 0.018, seed = 7, bright = 6800, dark = 520, darkTau = 0.5 } = {}) {
  const n = Math.max(64, Math.round(sr * seconds));
  const p0 = Math.round(pre * sr);
  const tau = t60 / 6.9078;                         // amplitude e-fold for -60 dB at t60
  const fadeN = Math.round(0.08 * sr);
  const r = mulberry(seed * 977 + c * 7919);
  const x = new Float32Array(n);
  let lp = 0, lp2 = 0, a = 0;
  // incremental envelopes (no exp per sample): decay, soft onset, and the darkening cutoff
  let env = 1, ex = 1, dEnv = 1;
  const envMul = Math.exp(-1 / (tau * sr)), exMul = Math.exp(-1 / (0.012 * sr));
  const BLOCK = 32, dMul = Math.exp(-BLOCK / (darkTau * sr));
  for (let i = p0, b = 0; i < n; i++, b--) {
    if (b <= 0) { b = BLOCK; a = Math.exp(-TAU * (dark + bright * dEnv) / sr); dEnv *= dMul; }
    const w = (r() * 2 - 1) * env * (1 - ex);
    env *= envMul; ex *= exMul;
    lp = (1 - a) * w + a * lp;                     // two poles: a softer, woollier roll-off
    lp2 = (1 - a) * lp + a * lp2;
    x[i] = lp2;
  }
  // early reflections off the cabinet, table and walls (different per ear)
  for (let e = 0; e < 9; e++) {
    const d = 0.006 + r() * 0.07;
    const i = p0 + Math.round(d * sr);
    const g = (r() < 0.5 ? -1 : 1) * (0.25 + 0.5 * r()) * Math.exp(-d / 0.05);
    for (let j = 0; j < 24 && i + j < n; j++) x[i + j] += g * Math.exp(-j / 5) * 0.012;
  }
  // high-pass ~110 Hz (one pole), remove DC, fade the very end, unit energy
  const ah = Math.exp(-TAU * 110 / sr);
  let hp = 0, prev = 0;
  for (let i = 0; i < n; i++) { const v = x[i]; hp = ah * (hp + v - prev); prev = v; x[i] = hp; }
  removeDC(x);
  for (let i = 0; i < fadeN; i++) x[n - 1 - i] *= i / fadeN;
  let en = 0;
  for (let i = 0; i < n; i++) en += x[i] * x[i];
  const g = en > 0 ? 1 / Math.sqrt(en) : 0;
  for (let i = 0; i < n; i++) x[i] *= g;
  return x;
}

export function reverbIR(sr, opts = {}) {
  return [reverbChannel(sr, 0, opts), reverbChannel(sr, 1, opts)];
}

// ---------------------------------------------------------------------------------------------
// grain textures

// Stick-slip: a positive train of tiny pulses at irregular intervals (~90 per second at rate 1).
// Used as an amplitude modulator on noise (rosin catching and releasing the bronze).
export function crackle(sr, seconds = 2, seed = 5, meanGap = 0.011) {
  const n = Math.round(sr * seconds);
  const r = mulberry(seed);
  const x = new Float32Array(n);
  let t = 0;
  while (t < n) {
    t += Math.max(1, Math.round(-Math.log(1 - r()) * meanGap * sr));
    const amp = 0.25 + 0.75 * r() * r();
    const len = (0.4 + r() * 2.2) * 0.001 * sr;
    const L = Math.round(len * 5), d = Math.exp(-1 / len);
    for (let j = 0, e = amp; j < L; j++, e *= d) x[(t + j) % n] += e;
  }
  for (let i = 0; i < n; i++) if (x[i] > 1.4) x[i] = 1.4;
  return x;
}

// one decaying sinusoidal tick added into x at t0 (recurrence oscillator: no sin/exp per sample)
function tick(x, t0, f, tau, amp, ph, sr, wrap) {
  const n = x.length, w = TAU * f / sr, d = Math.exp(-1 / tau), L = Math.round(tau * 6);
  const c2 = 2 * Math.cos(w);
  let s1 = Math.sin(ph - w), s0 = Math.sin(ph), e = amp;
  for (let j = 0; j < L; j++) {
    const idx = t0 + j;
    if (idx >= n) { if (!wrap) break; x[idx - n] += e * s0; } else x[idx] += e * s0;
    const s2 = c2 * s0 - s1; s1 = s0; s0 = s2; e *= d;
  }
}

// Sand on bronze: thousands of tiny ringing ticks, mostly faint, a few bright (power law).
export function sandGrains(sr, seconds = 3, seed = 9, density = 1100, lo = 1800, hi = 8500) {
  const n = Math.round(sr * seconds);
  const r = mulberry(seed);
  const x = new Float32Array(n);
  const count = Math.round(density * seconds);
  for (let g = 0; g < count; g++) {
    const t0 = Math.floor(r() * n);
    const f = lo + Math.pow(r(), 1.6) * (hi - lo);
    const tau = (0.18 + r() * 0.9) * 0.001 * sr;
    const amp = 0.1 + 0.9 * Math.pow(r(), 4);
    tick(x, t0, f, tau, amp, r() * TAU, sr, true);
  }
  const wr = mulberry(seed + 1);
  for (let i = 0; i < n; i++) x[i] += (wr() * 2 - 1) * 0.015;
  return scaleTo(removeDC(x), 0.25);
}

// A one-shot crumble (an old singer falling back into sand): dense at first, thinning out,
// with a few heavier clumps early on. Fades to silence by the end.
export function crumble(sr, seconds = 1.9, seed = 13) {
  const n = Math.round(sr * seconds);
  const r = mulberry(seed);
  const x = new Float32Array(n);
  const step = 0.001;
  for (let t = 0; t < seconds - 0.05; t += step) {
    const rate = 1300 * Math.exp(-t / 0.38) + 30 * Math.exp(-t / 1.2);
    let k = rate * step;
    while (k > 0) {
      if (k >= 1 || r() < k) {
        const clump = t < 0.35 && r() < 0.12;
        const t0 = Math.floor((t + r() * step) * sr);
        const f = clump ? 380 + r() * 900 : 1500 + Math.pow(r(), 1.4) * 6000;
        const tau = (clump ? 1.5 + r() * 3.5 : 0.15 + r() * 0.8) * 0.001 * sr;
        const amp = (clump ? 0.7 : 0.12 + 0.88 * Math.pow(r(), 3.5)) * Math.exp(-t / 0.9);
        tick(x, t0, f, tau, amp, r() * TAU, sr, false);
      }
      k -= 1;
    }
  }
  removeDC(x);
  const p = peak(x);
  if (p > 0) for (let i = 0; i < n; i++) x[i] *= 0.8 / p;
  const fadeN = Math.round(0.05 * sr);
  for (let i = 0; i < fadeN; i++) x[n - 1 - i] *= i / fadeN;
  return x;
}

// Paper, felt, leather: noise under a jittery sample-and-hold envelope (crinkles).
export function crinkle(sr, seconds = 2, seed = 17) {
  const n = Math.round(sr * seconds);
  const r = mulberry(seed);
  const x = new Float32Array(n);
  let env = 0, target = 0, hold = 0;
  const a = Math.exp(-1 / (0.0004 * sr));
  for (let i = 0; i < n; i++) {
    if (--hold <= 0) { hold = Math.round((0.8 + r() * 11) * 0.001 * sr); target = Math.pow(r(), 2.6); }
    env = a * env + (1 - a) * target;
    x[i] = (r() * 2 - 1) * env;
  }
  return scaleTo(removeDC(x), 0.25);
}

// ---------------------------------------------------------------------------------------------
// The phonograph (a spring-wound cylinder machine). Its mandrel turns at PHONO_RPM, so every loop
// below spans a whole number of turns: a scratch on the wax comes round again exactly once a turn
// and the loops never show a seam.

export const PHONO_RPM = 160;
export const PHONO_TURN = 60 / PHONO_RPM;          // seconds per turn of the cylinder (0.375)

// Playback surface of a worn wax cylinder: a warm groove hiss that swells and thins once a turn,
// a scatter of dust ticks, a few heavier pops, and one scratch that returns every revolution.
export function waxCrackle(sr, seconds = 3, seed = 19) {
  const turns = Math.max(1, Math.round(seconds / PHONO_TURN));
  const P = Math.round(PHONO_TURN * sr), n = P * turns;
  const r = mulberry(seed);
  // groove hiss: white noise band-limited to ~600 Hz – 4 kHz (wax is warm), breathing per turn
  const aH = Math.exp(-TAU * 600 / sr), aL = Math.exp(-TAU * 4000 / sr);
  let hp = 0, prev = 0, l1 = 0, l2 = 0;
  const hiss = seamless(n, Math.min(4096, n >> 3), (buf) => {
    for (let i = 0; i < buf.length; i++) {
      const w = r() * 2 - 1;
      hp = aH * (hp + w - prev); prev = w;
      l1 = (1 - aL) * hp + aL * l1; l2 = (1 - aL) * l1 + aL * l2;
      buf[i] = l2;
    }
  });
  scaleTo(removeDC(hiss), 0.05);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = hiss[i] * (0.82 + 0.18 * Math.sin(TAU * i / P + 1.3) + 0.06 * Math.sin(TAU * 3 * i / P));
  // dust: many faint ticks, bright and very short
  const nDust = Math.round(26 * n / sr);
  for (let g = 0; g < nDust; g++) {
    const amp = (0.04 + 0.22 * Math.pow(r(), 3)) * (r() < 0.5 ? -1 : 1);
    tick(x, Math.floor(r() * n), 1800 + r() * 4200, (0.08 + r() * 0.22) * 0.001 * sr, amp, r() * TAU, sr, true);
  }
  // pops: fewer, rounder, louder
  const nPop = Math.round(2.2 * n / sr);
  for (let g = 0; g < nPop; g++) {
    const t0 = Math.floor(r() * n), amp = (0.25 + 0.35 * r()) * (r() < 0.5 ? -1 : 1);
    tick(x, t0, 700 + r() * 900, (0.35 + r() * 0.6) * 0.001 * sr, amp, r() * TAU, sr, true);
    tick(x, t0 + 3, 2600 + r() * 1800, 0.12 * 0.001 * sr, amp * 0.5, r() * TAU, sr, true);
  }
  // the scratch that comes round every turn (and a faint swish of the groove's eccentricity)
  const sAt = Math.floor(r() * P), sF = 900 + r() * 500;
  for (let k = 0; k < turns; k++) {
    tick(x, k * P + sAt, sF, 0.7 * 0.001 * sr, 0.42, 0.4, sr, true);
    tick(x, k * P + sAt + Math.round(0.0016 * sr), sF * 2.3, 0.3 * 0.001 * sr, -0.2, 1.1, sr, true);
  }
  removeDC(x);
  const p = peak(x);
  if (p > 0) for (let i = 0; i < n; i++) x[i] *= 0.85 / p;
  return x;
}

// The spring motor's clockwork, heard from a little way off: the fly-ball governor's whir (it
// spins sixteen times a second), the worm gear's teeth ticking eight to the turn (each tooth its
// own small voice, the pattern repeating every revolution), and the mandrel's soft rumble.
export function clockwork(sr, seconds = 3, seed = 29) {
  const turns = Math.max(1, Math.round(seconds / PHONO_TURN));
  const P = Math.round(PHONO_TURN * sr), n = P * turns;
  const r = mulberry(seed);
  const GOV = 6;                                    // governor turns per mandrel turn (16 Hz)
  // whir: a resonant band of noise near 950 Hz, swelling with each spin of the governor
  const w0 = TAU * 950 / sr, rad = Math.exp(-PI * 320 / sr), c1 = 2 * rad * Math.cos(w0), c2 = -rad * rad;
  let y1 = 0, y2 = 0;
  const whir = seamless(n, Math.min(4096, n >> 3), (buf) => {
    for (let i = 0; i < buf.length; i++) { const y = (r() * 2 - 1) + c1 * y1 + c2 * y2; y2 = y1; y1 = y; buf[i] = y; }
  });
  scaleTo(removeDC(whir), 0.05);
  // rumble: low noise under ~180 Hz, swaying once a turn
  const aL = Math.exp(-TAU * 180 / sr);
  let l1 = 0, l2 = 0;
  const rum = seamless(n, Math.min(4096, n >> 3), (buf) => {
    for (let i = 0; i < buf.length; i++) { l1 = (1 - aL) * (r() * 2 - 1) + aL * l1; l2 = (1 - aL) * l1 + aL * l2; buf[i] = l2; }
  });
  scaleTo(removeDC(rum), 0.03);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const g = Math.sin(PI * GOV * i / P);
    x[i] = whir[i] * (0.45 + 0.55 * g * g) + rum[i] * (0.8 + 0.2 * Math.sin(TAU * i / P));
  }
  // the gear teeth: eight per turn, each with its own level, pitch and timing slip
  const TEETH = 8;
  const teeth = [];
  for (let j = 0; j < TEETH; j++) teeth.push({ a: 0.18 + 0.32 * r(), f: 2100 + r() * 900, f2: 3900 + r() * 1400, slip: (r() - 0.5) * 0.004 });
  teeth[0].a = 0.6;                                // one tooth a little bent: a heavier tick each turn
  for (let k = 0; k < turns; k++) {
    for (let j = 0; j < TEETH; j++) {
      const th = teeth[j];
      const t0 = Math.round(k * P + (j / TEETH + th.slip) * P);
      tick(x, (t0 + n) % n, th.f, 0.25 * 0.001 * sr, th.a, 0.3, sr, true);
      tick(x, (t0 + 2 + n) % n, th.f2, 0.12 * 0.001 * sr, th.a * 0.45, 1.7, sr, true);
    }
  }
  removeDC(x);
  const p = peak(x);
  if (p > 0) for (let i = 0; i < n; i++) x[i] *= 0.85 / p;
  return x;
}

// Soft-clip transfer curve for a WaveShaper fed through a pre-gain of 1/range:
// linear (unity) up to `knee`, then a tanh shoulder that never exceeds `ceiling`.
export function softClipCurve(points = 4097, range = 4, knee = 0.6, ceiling = 0.89) {
  const c = new Float32Array(points);
  const room = ceiling - knee;
  for (let i = 0; i < points; i++) {
    const x = ((i / (points - 1)) * 2 - 1) * range;
    const a = Math.abs(x);
    const y = a <= knee ? a : knee + room * Math.tanh((a - knee) / room);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// The shared buffers, as jobs: [name, (sr, seed) -> channels]. The engine runs them on the spot;
// audio.js runs them one per idle slot before the first gesture so the first click stays instant.
export const BUFFER_JOBS = [          // in the order they are first needed
  ['room', (sr, seed) => [roomTone(sr, 4, seed + 8)]],
  ['white', (sr, seed) => [whiteNoise(Math.round(sr * 2), seed + 1)]],
  ['crackle', (sr, seed) => [crackle(sr, 2, seed + 4)]],
  ['sand', (sr, seed) => [sandGrains(sr, 3, seed + 5)]],
  ['pink', (sr, seed) => [pinkNoise(Math.round(sr * 3), seed + 2)]],
  ['crinkle', (sr, seed) => [crinkle(sr, 2, seed + 7)]],
  ['brown', (sr, seed) => [brownNoise(Math.round(sr * 4), seed + 3)]],
  ['crumble', (sr, seed) => [crumble(sr, 1.9, seed + 6)]],
  ['clock', (sr, seed) => [clockwork(sr, 3, seed + 9)]],
  ['wax', (sr, seed) => [waxCrackle(sr, 3, seed + 10)]],
];
export const IR_SECONDS = 3.2;

// linear resampling (the reverb IR prepared at 48 kHz, for a 44.1 kHz context: it is dark enough
// that nothing near the new Nyquist needs filtering)
export function resample(x, from, to) {
  if (!(from > 0) || !(to > 0) || from === to) return x;
  const n = Math.max(1, Math.round((x.length * to) / from)), out = new Float32Array(n), r = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * r, j = Math.floor(p), f = p - j;
    out[i] = (x[j] || 0) * (1 - f) + (x[j + 1] || 0) * f;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pitch

export const kHz = (k) => BASE_HZ * (+k || 0);

export function foldInto(f, lo, hi) {
  if (!(f > 0) || !(hi > lo * 1.99)) return f > 0 ? f : 0;
  while (f < lo) f *= 2;
  while (f >= hi) f *= 0.5;
  return f;
}

// How a singer voices its components: sorted by k; the lowest is octave-folded into [lo, hi)
// (glassy register, never shrill, never mud); each next one sits at the lowest octave of its own
// pitch class above the previous voice, so chords stay open and ordered. Octave folding keeps
// pitch class, so clans (5·10·20·40, 13·26·52 ...) still agree with each other and with the plate.
export function voiceChord(ks, lo = 250, hi = 1300, top = 2100) {
  const out = [];
  const sorted = (ks || []).map((k) => +k).filter((k) => k > 0).sort((a, b) => a - b);
  let prev = 0;
  for (const k of sorted) {
    let f = kHz(k);
    if (!prev) f = foldInto(f, lo, hi);
    else {
      while (f > prev * 1.02) f *= 0.5;
      while (f <= prev * 1.02) f *= 2;
      if (f > top) f = foldInto(f, prev * 0.5, prev);   // no room above: tuck inside
    }
    out.push(f);
    prev = f;
  }
  return out;
}

// Root of a set of harmonic numbers for a drone: gcd if meaningful, else the lowest.
export function droneRootHz(ks, lo = 55, hi = 110) {
  const list = (ks || []).map((k) => Math.round(+k)).filter((k) => k > 0);
  if (!list.length) return foldInto(kHz(5), lo, hi);
  let g = list[0];
  for (const k of list) { let a = g, b = k; while (b) { const t = a % b; a = b; b = t; } g = a; }
  const root = g >= 4 ? g : Math.min(...list);
  return foldInto(kHz(root), lo, hi);
}
