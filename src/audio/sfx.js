// One-shot sounds. Each synth is (params, t) -> builds a short-lived voice with E.voice(t),
// schedules its envelopes, and lets the voice free itself when its last source ends.
// Params are plain data prepared by audio.js: { ks: [k...], pan: -1..1, strength, ... }.
// Each synth is voiced at a nominal level; LEVELS (below) is the mixer that balances them.
import { MODES, evalMode } from '../sim/modes.js';
import { voiceChord, foldInto } from './dsp.js';

// minimum seconds between two plays of the same sound (bursts are thinned, never stacked)
export const GAPS = {
  tap: 0.05, split: 0.12, eat: 0.1, crumble: 0.1, fizzle: 0.12, fall: 0.15, birth: 0.14, fuse: 0.18,
  page: 0.06, scratch: 0.07, bowLift: 0.1, moth: 0.25, creak: 4, extinct: 0.8, reveal: 0.8,
  damper: 0.06, damperOff: 0.06, grab: 0.05, drop: 0.05, glass: 0.05, tick: 0.03, forkTouch: 0.2,
  phonoNeedle: 0.25, phonoStop: 0.25, keeperArrive: 6,
};
// 2: always (rare, meaningful) · 1: normal · <1: dropped first when many voices are alive
export const PRIORITY = {
  crack: 2, heal: 2, floorBloom: 2, choirSwell: 2, lightOn: 2, lightOff: 2, cord: 2, fork: 2, keeperArrive: 2,
  phonoNeedle: 1.5, phonoStop: 1.5,
  birth: 1.5, fuse: 1.5, fall: 1.5, crumble: 1.2,
  creak: 0.3, reveal: 0.3, moth: 0.6, fizzle: 0.8, split: 0.8,
};

// the mixer: per-sound level in dB (measured with dev/audio-check.html: a single event lands
// between about -26 and -16 dBFS over its loudest 50 ms; rare, meaningful events are louder)
export const LEVELS = {
  tap: 4.5, crack: 8.5, heal: 2, fork: 3.5, forkTouch: 14, damper: 3.5, damperOff: 10, pour: 3,
  scratch: 12, bowLift: 14, birth: 4, split: 5, fuse: 2, eat: 3.5, crumble: 4, fizzle: 6, fall: 3,
  extinct: -5, choirSwell: 6, floorBloom: 0, creak: 11, cord: 13, lightOn: 9, lightOff: 11,
  drawer: 0, page: 6, bookOpen: 4, bookClose: 0, grab: 11, drop: 4, glass: 7, tick: 4, reveal: 8, moth: 6,
  phonoNeedle: 9, phonoStop: 6, keeperArrive: -3,
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function createSfx(E) {
  const S = {};
  const dk = () => Math.pow(2, -E.dark);                         // darkness: an octave down
  const voices = (p, fallback = 20) => voiceChord(p && p.ks && p.ks.length ? p.ks : [fallback]);
  const pan = (p, s = 0.6) => clamp((+p?.pan || 0) * s, -0.85, 0.85);

  // a glassy ping: sine-ish tone with a fast attack and an exponential ring
  function ping(V, bus, f, t, peak, tau, wave = E.waves.glass, a = 0.003) {
    const o = V.osc(wave, f, t), g = V.gain(0);
    o.connect(g); g.connect(bus);
    return E.ad(g.gain, t, a, peak, tau);
  }
  // a short noise burst through a band
  function burst(V, bus, t, { buf = 'white', type = 'bandpass', f = 2000, Q = 1, peak = 0.2, a = 0.001, tau = 0.01, rate = 1 } = {}) {
    const s = V.src(buf, t, { rate }), fl = V.filt(type, f, Q), g = V.gain(0);
    s.connect(fl); fl.connect(g); g.connect(bus);
    const end = E.ad(g.gain, t, a, peak, tau);
    V.stopAt(s, end);
    return { end, fl, g, s };
  }
  // a low thump (felt, wood, a body)
  function thump(V, bus, t, f0, f1, peak, tau) {
    const o = V.osc('sine', f0, t), g = V.gain(0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + tau * 3);
    o.connect(g); g.connect(bus);
    const end = E.ad(g.gain, t, 0.003, peak, tau);
    V.stopAt(o, end);
    return end;
  }

  // the low modes a point on the plate excites most: [{f, w}] (w normalised to the strongest)
  function modesAt(u, v, count) {
    const found = [];
    for (const m of MODES) {
      if (m.special || m.k < 5 || m.k > 26) continue;
      const w = Math.abs(evalMode(m, u, v)) * Math.pow(m.k, -0.35);
      const dup = found.find((x) => x.k === m.k);
      if (dup) { if (w > dup.w) dup.w = w; continue; }
      found.push({ k: m.k, f: m.freq, w });
    }
    found.sort((a, b) => b.w - a.w);
    const top = found.slice(0, count);
    const mx = top[0]?.w || 1;
    for (const x of top) x.w = mx > 0 ? x.w / mx : 1;
    return top;
  }

  // --- the plate --------------------------------------------------------------------------------

  // bronze strike: the struck modes ring with their inharmonic partials; a click of the knuckle;
  // the sand hops
  S.tap = (p, t) => {
    const s = clamp(p.strength ?? 0.6, 0.15, 1.2);
    const u = clamp(+p.u || 0, -1, 1), v = clamp(+p.v || 0, -1, 1);
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, u * 0.35, 0.4);
    let end = t + 0.4;
    for (const m of modesAt(u, v, 3)) {
      const o1 = V.osc('sine', m.f, t), o2 = V.osc(E.waves.strike, m.f * 2.76, t);
      const g1 = V.gain(0), g2 = V.gain(0);
      o1.connect(g1); o2.connect(g2); g1.connect(bus); g2.connect(bus);
      const a = 0.13 * s * (0.35 + 0.65 * m.w);
      end = Math.max(end, E.ad(g1.gain, t, 0.002, a, 0.45 + 0.35 * m.w));
      V.stopAt(o2, E.ad(g2.gain, t, 0.001, a * 0.55, 0.11));
    }
    burst(V, bus, t, { f: 3200, Q: 0.8, peak: 0.35 * s, tau: 0.005 });
    thump(V, bus, t, 210, 85, 0.1 * s, 0.018);
    const sd = burst(V, bus, t + 0.006, { buf: 'sand', type: 'highpass', f: 2500, Q: 0.5, peak: 0.12 * s, a: 0.01, tau: 0.08 });
    V.stopAt(sd.s, t + 0.7);
    V.done(end);
  };

  // a crack: a sharp splitting snap, splinters, a dull thud in the stand, then the struck modes
  // ring sour (pairs a percent apart, beating)
  S.crack = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.45);
    burst(V, bus, t, { type: 'highpass', f: 1400, Q: 0.6, peak: 0.6, a: 0.0004, tau: 0.004 });
    const spl = V.src('crackle', t, { rate: 2.4 }), sbp = V.filt('bandpass', 4200, 0.8), sg = V.gain(0), am = V.gain(0);
    const nz = V.src('white', t);
    spl.connect(am.gain); nz.connect(am); am.connect(sbp); sbp.connect(sg); sg.connect(bus);
    const sEnd = E.ad(sg.gain, t + 0.002, 0.003, 0.5, 0.06);
    V.stopAt(spl, sEnd); V.stopAt(nz, sEnd);
    thump(V, bus, t, 120, 48, 0.28, 0.06);
    const fs = p.freqs && p.freqs.length ? p.freqs : [357.5, 550];
    let end = t + 1;
    for (let i = 0; i < Math.min(3, fs.length); i++) {
      const f = foldInto(fs[i], 180, 1400);
      for (const d of [-0.013, 0.011]) {
        end = Math.max(end, ping(V, bus, f * (1 + d), t + 0.004, 0.065 / (i + 1), 1.0, E.waves.strike, 0.002));
      }
    }
    ping(V, bus, 3100 + Math.random() * 600, t + 0.003, 0.05, 0.05, 'sine', 0.001);
    V.done(end);
  };

  // a seam filled with gold: a warm strummed chord on the harmonic series (it cannot be out of tune)
  S.heal = (p, t) => {
    const root = foldInto(p.root || 137.5, 110, 220);
    const V = E.voice(t), bus = V.gain(1), lp = V.filt('lowpass', 2800, 0.6);
    bus.connect(lp);
    V.out(lp, pan(p, 0.4), 0.65);
    const parts = [2, 3, 4, 5, 6, 8];
    const amp = [0.06, 0.05, 0.045, 0.034, 0.028, 0.018];
    let end = t;
    parts.forEach((h, i) => {
      const ti = t + i * 0.085;
      const o = V.osc(i < 2 ? E.waves.warm : E.waves.glass, root * h, ti), g = V.gain(0);
      o.connect(g); g.connect(bus);
      end = Math.max(end, E.ahr(g.gain, ti, 0.6, amp[i], 1.2, 0.9));
    });
    for (let i = 0; i < 5; i++) ping(V, bus, root * [10, 12, 16, 15, 20][i], t + 0.5 + i * 0.23 + Math.random() * 0.1, 0.012, 0.35, E.waves.bell);
    V.done(end);
  };

  // tuning fork struck in the air: nearly pure, long, with the fork's brief clang overtone
  S.fork = (p, t) => {
    const f = (+p.k > 0 ? 27.5 * p.k : 440);
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.3);
    const end = ping(V, bus, f, t, 0.1, 2.2, 'sine', 0.004);
    ping(V, bus, f * 6.27, t, 0.025, 0.05, 'sine', 0.001);
    burst(V, bus, t, { f: 2600, Q: 2, peak: 0.08, tau: 0.004 });
    V.done(Math.min(end, t + 14));
  };
  // fork foot touching bronze: a brief buzzing contact at the fork's own pitch
  S.forkTouch = (p, t) => {
    const f = (+p.k > 0 ? 27.5 * p.k : 440);
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.25);
    const saw = V.osc('sawtooth', f, t), c = V.src('crackle', t, { rate: 3 }), am = V.gain(0.15), bp = V.filt('bandpass', f * 3, 2.5), g = V.gain(0);
    c.connect(am.gain); saw.connect(am); am.connect(bp); bp.connect(g); g.connect(bus);
    const end = E.ad(g.gain, t, 0.004, 0.14, 0.06);
    burst(V, bus, t, { f: 3800, Q: 1.5, peak: 0.12, tau: 0.003 });
    V.done(end);
  };

  // felt damper set down / lifted
  S.damper = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.4), 0.12);
    const e1 = thump(V, bus, t, 105, 62, 0.22, 0.05);
    const b = burst(V, bus, t, { buf: 'pink', type: 'lowpass', f: 420, Q: 0.6, peak: 0.16, a: 0.003, tau: 0.035 });
    V.done(Math.max(e1, b.end));
  };
  S.damperOff = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.4), 0.1);
    const b = burst(V, bus, t, { buf: 'crinkle', type: 'bandpass', f: 900, Q: 0.8, peak: 0.08, a: 0.01, tau: 0.04 });
    const e = thump(V, bus, t, 150, 120, 0.04, 0.03);
    V.done(Math.max(b.end, e));
  };

  // pouring is continuous (E.pour); a single 'pour' one-shot is a brief trickle
  S.pour = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.15);
    const b = burst(V, bus, t, { buf: 'sand', type: 'bandpass', f: 2600, Q: 0.6, peak: 0.12, a: 0.03, tau: 0.12, rate: 0.8 });
    V.done(b.end);
  };

  // --- the bow ----------------------------------------------------------------------------------

  // the hair catching the edge: a short, gritty scratch (the continuous bow voice takes over)
  S.scratch = (p, t) => {
    const s = clamp(p.strength ?? 0.7, 0.2, 1);
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.6), 0.12);
    const c = V.src('crackle', t, { rate: 2.2 }), nz = V.src('white', t), am = V.gain(0.25), bp = V.filt('bandpass', 2100, 1.1), g = V.gain(0);
    c.connect(am.gain); nz.connect(am); am.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(2600, t); bp.frequency.exponentialRampToValueAtTime(1500, t + 0.08);
    const end = E.ad(g.gain, t, 0.004, 0.5 * s, 0.045);
    burst(V, bus, t, { buf: 'brown', type: 'lowpass', f: 300, Q: 0.7, peak: 0.25 * s, a: 0.004, tau: 0.03 });
    V.done(end);
  };
  S.bowLift = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.6), 0.15);
    const b = burst(V, bus, t, { f: 3400, Q: 0.8, peak: 0.03, a: 0.01, tau: 0.06 });
    V.done(b.end);
  };

  // --- the singers ------------------------------------------------------------------------------

  // a birth: a soft glassy bloom rising into the species' chord, a breath of light around it;
  // a new form gets a little constellation of high glints
  S.birth = (p, t) => {
    const fs = voices(p), m = dk();
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p), 0.6);
    const n = fs.length;
    const base = (p.isNew ? 0.085 : 0.065) * (p.aurata ? 0.75 : 1) * (1 - 0.35 * E.dark) / Math.sqrt(n);
    let end = t;
    fs.forEach((f0, i) => {
      const f = f0 * m, ti = t + i * 0.075;
      const o = V.osc(p.aurata ? E.waves.bell : E.waves.glass, f * 0.75, ti), g = V.gain(0);
      o.frequency.setValueAtTime(f * 0.75, ti);
      o.frequency.setTargetAtTime(f, ti, 0.16);
      o.connect(g); g.connect(bus);
      end = Math.max(end, E.ahr(g.gain, ti, 0.35, base, 0.3, 0.6));
      const o2 = V.osc('sine', f * 2, ti + 0.12), g2 = V.gain(0);
      o2.connect(g2); g2.connect(bus);
      V.stopAt(o2, E.ahr(g2.gain, ti + 0.12, 0.45, base * 0.22, 0.1, 0.45));
    });
    const nz = V.src('pink', t), bp = V.filt('bandpass', fs[0] * m * 2, 5), gn = V.gain(0);
    nz.connect(bp); bp.connect(gn); gn.connect(bus);
    V.stopAt(nz, E.ahr(gn.gain, t, 0.4, 0.09, 0.05, 0.25));
    if (p.isNew) {
      const top = fs[n - 1] * m;
      [3, 4, 6].forEach((h, i) => ping(V, bus, foldInto(top * h, 1500, 4200), t + 0.38 + i * 0.17, 0.018, 0.3));
    }
    V.done(end);
  };

  // division: two quick plucks, the second (the child) an octave up
  S.split = (p, t) => {
    const f = voices(p)[0] * dk();
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p), 0.35);
    let end = t;
    [[0, 1, 0.07], [0.09, 2, 0.05]].forEach(([d, mul, a]) => {
      const ti = t + d, o = V.osc('triangle', f * mul, ti), lp = V.filt('lowpass', f * mul * 6, 0.8), g = V.gain(0);
      o.connect(lp); lp.connect(g); g.connect(bus);
      lp.frequency.setValueAtTime(f * mul * 6, ti);
      lp.frequency.setTargetAtTime(f * mul * 1.3, ti, 0.05);
      end = Math.max(end, E.ad(g.gain, ti, 0.003, a, 0.09));
    });
    V.done(end);
  };

  // fusion: the two parents' tones glide toward each other into the child's chord, then shimmer
  S.fuse = (p, t) => {
    const m = dk();
    const C = voices(p).map((f) => f * m);
    const A = voices({ ks: p.ksA }, 10)[0] * m, B = voices({ ks: p.ksB }, 25)[0] * m;
    const near = (f, pool) => pool.reduce((best, x) => (Math.abs(Math.log(x / f)) < Math.abs(Math.log(best / f)) ? x : best), pool[0]);
    const tA = near(A, C), restB = C.filter((x) => x !== tA), tB = restB.length ? near(B, restB) : tA * 2;
    const rest = C.filter((x) => x !== tA && x !== tB);
    const V = E.voice(t), bus = V.gain(1), sh = V.gain(1);
    sh.connect(bus);
    V.out(bus, pan(p), 0.55);
    const trem = V.osc('sine', 6.5, t), tg = V.gain(0);
    trem.connect(tg); tg.connect(sh.gain);
    tg.gain.setValueAtTime(0, t + 0.9); tg.gain.linearRampToValueAtTime(0.35, t + 1.25); tg.gain.setTargetAtTime(0, t + 1.6, 0.45);
    let end = t;
    for (const [f0, f1] of [[A, tA], [B, tB]]) {
      const o = V.osc(E.waves.glass, f0, t), g = V.gain(0);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 1.0);
      o.connect(g); g.connect(sh);
      end = Math.max(end, E.ahr(g.gain, t, 0.12, 0.055, 1.3, 0.6));
    }
    for (const f of rest) {
      const o = V.osc(E.waves.glass, f, t + 0.7), g = V.gain(0);
      o.connect(g); g.connect(sh);
      end = Math.max(end, E.ahr(g.gain, t + 0.7, 0.4, 0.045, 0.6, 0.6));
    }
    const top = Math.max(...C);
    ping(V, bus, foldInto(top * 2, 1200, 3600), t + 1.02, 0.02, 0.3);
    ping(V, bus, foldInto(top * 3, 1200, 3600), t + 1.2, 0.014, 0.3);
    V.done(end);
  };

  // predation: a dissonant crunch, the prey's tone swallowed (falling, muffled), a gulp
  S.eat = (p, t) => {
    const m = dk();
    const prey = voices({ ks: p.preyKs }, 13)[0] * m;
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p), 0.28);
    burst(V, bus, t, { buf: 'crinkle', f: 1400, Q: 0.9, peak: 0.32, a: 0.002, tau: 0.03 });
    burst(V, bus, t + 0.085, { buf: 'crinkle', f: 1100, Q: 0.9, peak: 0.24, a: 0.002, tau: 0.035, rate: 0.8 });
    const lpC = V.filt('lowpass', 2400, 0.7), gc = V.gain(0);
    lpC.connect(gc); gc.connect(bus);
    for (const f of [prey, prey * 1.0595 * 1.012]) { const o = V.osc('triangle', f, t); o.connect(lpC); V.stopAt(o, t + 0.5); }
    E.ad(gc.gain, t, 0.004, 0.05, 0.07);
    const o = V.osc('sine', prey, t + 0.05), lp = V.filt('lowpass', 2400, 0.9), g = V.gain(0);
    o.frequency.setValueAtTime(prey, t + 0.05);
    o.frequency.exponentialRampToValueAtTime(prey * 0.45, t + 0.42);
    lp.frequency.setValueAtTime(2400, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(220, t + 0.42);
    o.connect(lp); lp.connect(g); g.connect(bus);
    const end = E.ahr(g.gain, t + 0.05, 0.02, 0.08, 0.14, 0.07);
    thump(V, bus, t + 0.33, 170, 62, 0.13, 0.04);
    V.done(Math.max(end, t + 0.6));
  };

  // death of old age: the body crumbles back into sand, its note sinks a fifth, gold chimes
  S.crumble = (p, t) => {
    const f = voices(p)[0] * dk();
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p), 0.45);
    const c = V.src('crumble', t, { loop: false, rate: 0.9 + Math.random() * 0.2 });
    const hi = V.filt('bandpass', 3000, 0.5), gh = V.gain(0.5), lo = V.filt('lowpass', 1000, 0.7), gl = V.gain(0.3);
    c.connect(hi); hi.connect(gh); gh.connect(bus); c.connect(lo); lo.connect(gl); gl.connect(bus);
    const o = V.osc(E.waves.glass, f, t), g = V.gain(0);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 2 / 3, t + 2.2);
    o.connect(g); g.connect(bus);
    let end = E.ad(g.gain, t, 0.15, 0.05, 0.6);
    if (p.gold !== false) {
      const base = foldInto(f * 4, 1800, 3600);
      [1, 1.5, 2].forEach((h, i) => { end = Math.max(end, ping(V, bus, base * h, t + 0.75 + i * 0.27 + Math.random() * 0.05, 0.022 - i * 0.004, 0.35, E.waves.bell, 0.002)); });
    }
    V.done(Math.max(end, t + 2));
  };

  // death of hunger: a dim fizzle, the note sagging flat
  S.fizzle = (p, t) => {
    const f = voices(p)[0] * dk();
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p), 0.3);
    const c = V.src('crackle', t, { rate: 1.6 }), nz = V.src('white', t), am = V.gain(0.1), bp = V.filt('bandpass', 2400, 4), g = V.gain(0);
    c.connect(am.gain); nz.connect(am); am.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(2400, t); bp.frequency.exponentialRampToValueAtTime(500, t + 0.7);
    const e1 = E.ad(g.gain, t, 0.05, 0.22, 0.2);
    const o = V.osc(E.waves.glass, f, t), go = V.gain(0);
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.9, t + 0.6);
    o.connect(go); go.connect(bus);
    const e2 = E.ad(go.gain, t, 0.02, 0.035, 0.18);
    V.done(Math.max(e1, e2));
  };

  // over the edge: a long falling glissando, dry first, then only the room hears it
  S.fall = (p, t) => {
    const f = voices(p)[0] * dk();
    const V = E.voice(t), bus = V.gain(1), lp = V.filt('lowpass', 3200, 0.7);
    bus.connect(lp);
    const pn = pan(p, 0.85);
    V.out(lp, pn, 0.7, 0);                              // wet path (constant)
    const dry = V.gain(1); lp.connect(dry);
    V.out(dry, pn, 0, 1);
    dry.gain.setValueAtTime(1, t); dry.gain.setTargetAtTime(0, t + 0.3, 0.55);
    const o = V.osc(E.waves.glass, f, t), g = V.gain(0);
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.25, t + 2.6);
    lp.frequency.setValueAtTime(3200, t); lp.frequency.exponentialRampToValueAtTime(260, t + 2.6);
    o.connect(g); g.connect(bus);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.085, t + 0.03);
    g.gain.setTargetAtTime(0, t + 0.6, 0.7);
    const w = V.src('pink', t), wb = V.filt('bandpass', 1200, 1.2), wg = V.gain(0);
    w.connect(wb); wb.connect(wg); wg.connect(bus);
    wb.frequency.setValueAtTime(1300, t); wb.frequency.exponentialRampToValueAtTime(280, t + 2.2);
    E.ahr(wg.gain, t, 0.3, 0.03, 0.4, 0.4);
    V.done(t + 5.4);
  };

  // extinction: a last, distant echo of the species' note, heard mostly in the room
  S.extinct = (p, t) => {
    const f = voices(p)[0] * 0.5 * dk();
    const V = E.voice(t), bus = V.gain(1), lp = V.filt('lowpass', 1100, 0.6);
    bus.connect(lp);
    V.out(lp, pan(p, 0.3), 0.8, 0.25);
    const o = V.osc(E.waves.glass, f, t), g = V.gain(0);
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.97, t + 4);
    o.connect(g); g.connect(bus);
    V.done(E.ahr(g.gain, t, 1.4, 0.05, 0.4, 0.9));
  };

  // --- rare states ------------------------------------------------------------------------------

  // the choir arrives: an airy swell rising under the voices (the drone itself is continuous)
  S.choirSwell = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, 0, 0.7, 0.6);
    for (const [f0, f1, pn] of [[700, 2600, -0.4], [900, 3200, 0.4]]) {
      const nz = V.src('pink', t), bp = V.filt('bandpass', f0, 2.2), g = V.gain(0), pp = V.add(E.pan(pn));
      nz.connect(bp); bp.connect(g); g.connect(pp); pp.connect(bus);
      bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + 3.5);
      E.ahr(g.gain, t, 3, 0.05, 0.8, 0.8);
    }
    const root = foldInto(p.root || 137.5, 220, 440);
    [1, 1.5, 2, 3].forEach((h, i) => ping(V, bus, root * h * 2, t + 1.2 + i * 0.4, 0.012, 0.6));
    V.done(t + 3.8 + 0.8 * 7);
  };

  // the floor opens: a slow pressure wave under everything (the bloom itself is continuous)
  S.floorBloom = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, 0, 0.2);
    const o = V.osc('sine', 38, t), g = V.gain(0);
    o.frequency.setValueAtTime(38, t); o.frequency.exponentialRampToValueAtTime(55, t + 2.2);
    o.connect(g); g.connect(bus);
    const o2 = V.osc('sine', 76, t), g2 = V.gain(0);
    o2.frequency.setValueAtTime(76, t); o2.frequency.exponentialRampToValueAtTime(110, t + 2.2);
    o2.connect(g2); g2.connect(bus);
    E.ahr(g2.gain, t, 1.2, 0.06, 0.6, 0.6);
    V.done(E.ahr(g.gain, t, 1.6, 0.22, 0.8, 0.8));
  };

  // --- the room and its objects -----------------------------------------------------------------

  // the house settling, somewhere beyond the light
  S.creak = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 1), 0.9, 0.35);
    const dur = 0.6 + Math.random() * 0.7;
    const saw = V.osc('sawtooth', 60, t), am = V.gain(0.3), c = V.src('crackle', t, { rate: 0.5 });
    c.connect(am.gain); saw.connect(am);
    const f0 = 45 + Math.random() * 30;
    saw.frequency.setValueAtTime(f0, t);
    saw.frequency.linearRampToValueAtTime(f0 * (1.4 + Math.random() * 0.6), t + dur * 0.6);
    saw.frequency.linearRampToValueAtTime(f0 * 0.9, t + dur);
    const b1 = V.filt('bandpass', 650 + Math.random() * 250, 7), b2 = V.filt('bandpass', 1500 + Math.random() * 400, 5), g = V.gain(0);
    am.connect(b1); am.connect(b2); b1.connect(g); b2.connect(g); g.connect(bus);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.035, t + dur * 0.8); g.gain.linearRampToValueAtTime(0, t + dur);
    V.done(t + dur + 0.05);
  };

  // the pull-cord: a chain-pull click pair and a little rattle
  S.cord = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.4), 0.25);
    burst(V, bus, t, { f: 3000, Q: 2, peak: 0.25, tau: 0.002 });
    ping(V, bus, 1850, t, 0.05, 0.012, 'sine', 0.0005);
    burst(V, bus, t + 0.065, { f: 2300, Q: 2, peak: 0.18, tau: 0.003 });
    const r = burst(V, bus, t + 0.02, { buf: 'crackle', type: 'bandpass', f: 5200, Q: 1, peak: 0.1, a: 0.005, tau: 0.05, rate: 2.5 });
    V.done(r.end);
  };
  // the filament catching (buzz rising into the hum, a tick of hot tungsten) or dying
  S.lightOn = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.3), 0.2);
    const saw = V.osc('sawtooth', 100, t), bp = V.filt('bandpass', 900, 0.9), g = V.gain(0);
    saw.connect(bp); bp.connect(g); g.connect(bus);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.03, t + 0.04);
    g.gain.setTargetAtTime(0.004, t + 0.08, 0.25); g.gain.setTargetAtTime(0, t + 0.9, 0.2);
    ping(V, bus, 4300, t + 0.05, 0.012, 0.04, 'sine', 0.001);
    V.done(t + 2.4);
  };
  S.lightOff = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.3), 0.3);
    const saw = V.osc('sawtooth', 100, t), bp = V.filt('bandpass', 700, 0.9), g = V.gain(0);
    saw.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(250, t + 0.4);
    g.gain.setValueAtTime(0.012, t); g.gain.setTargetAtTime(0, t, 0.12);
    ping(V, bus, 5200, t + 0.35 + Math.random() * 0.2, 0.008, 0.02, 'sine', 0.0005);
    V.done(t + 1.2);
  };

  // the cabinet drawer: wood sliding on wood, a soft knock at the end of its travel
  S.drawer = (p, t) => {
    const open = p.open !== false;
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.3), 0.25);
    const dur = open ? 0.42 : 0.34;
    const nz = V.src('brown', t), c = V.src('crinkle', t, { rate: 0.5 }), am = V.gain(0.4), bp = V.filt('bandpass', 520, 1.8), g = V.gain(0);
    c.connect(am.gain); nz.connect(am); am.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(open ? 450 : 620, t); bp.frequency.linearRampToValueAtTime(open ? 680 : 430, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.06);
    g.gain.setValueAtTime(0.45, t + dur - 0.05); g.gain.linearRampToValueAtTime(0, t + dur);
    V.stopAt(nz, t + dur + 0.02); V.stopAt(c, t + dur + 0.02);
    const e = thump(V, bus, t + dur - 0.01, open ? 160 : 190, 90, open ? 0.12 : 0.2, 0.035);
    burst(V, bus, t + dur - 0.01, { buf: 'pink', type: 'lowpass', f: 900, Q: 0.7, peak: open ? 0.08 : 0.13, tau: 0.02 });
    V.done(e);
  };

  // the notebook: a page turning; the covers opening (leather) and closing
  S.page = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.3), 0.15);
    const c = V.src('crinkle', t, { rate: 0.9 + Math.random() * 0.3 }), bp = V.filt('bandpass', 1500, 0.9), hp = V.filt('highpass', 500, 0.7), g = V.gain(0);
    c.connect(bp); bp.connect(hp); hp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(1300, t); bp.frequency.exponentialRampToValueAtTime(4200, t + 0.28);
    const end = E.ahr(g.gain, t, 0.07, 0.3, 0.08, 0.06);
    V.stopAt(c, end);
    const w = burst(V, bus, t + 0.12, { buf: 'pink', type: 'bandpass', f: 800, Q: 0.7, peak: 0.06, a: 0.05, tau: 0.06 });
    V.done(Math.max(end, w.end));
  };
  S.bookOpen = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.3), 0.15);
    const c = V.src('crinkle', t, { rate: 0.35 }), bp = V.filt('bandpass', 520, 3), g = V.gain(0);
    c.connect(bp); bp.connect(g); g.connect(bus);
    const e = E.ahr(g.gain, t, 0.08, 0.35, 0.15, 0.06);
    V.stopAt(c, e);
    S.page(p, t + 0.18);
    V.done(e);
  };
  S.bookClose = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.3), 0.2);
    const e = thump(V, bus, t, 125, 80, 0.16, 0.05);
    const b = burst(V, bus, t, { buf: 'pink', type: 'lowpass', f: 700, Q: 0.6, peak: 0.12, a: 0.004, tau: 0.04 });
    V.done(Math.max(e, b.end));
  };

  // small handling sounds
  S.grab = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.12);
    const e = thump(V, bus, t, 420, 300, 0.05, 0.012);
    const b = burst(V, bus, t, { buf: 'crinkle', type: 'bandpass', f: 1800, Q: 0.8, peak: 0.06, a: 0.004, tau: 0.03 });
    V.done(Math.max(e, b.end));
  };
  S.drop = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.15);
    const e = thump(V, bus, t, 180, 110, 0.12, 0.03);
    const b = burst(V, bus, t, { buf: 'pink', type: 'lowpass', f: 1200, Q: 0.6, peak: 0.07, a: 0.002, tau: 0.02 });
    V.done(Math.max(e, b.end));
  };
  S.glass = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.3);
    let end = t;
    for (const [f, a, tau] of [[2350, 0.03, 0.25], [3910, 0.018, 0.16], [5630, 0.01, 0.1]]) end = Math.max(end, ping(V, bus, f * (0.97 + Math.random() * 0.06), t, a, tau, 'sine', 0.001));
    V.done(end);
  };
  S.tick = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.1);
    ping(V, bus, 2400, t, 0.03, 0.01, 'sine', 0.0005);
    V.done(burst(V, bus, t, { f: 3500, Q: 1.2, peak: 0.5, tau: 0.003 }).end + 0.01);
  };

  // something emerges at the edge of the light: barely a sound, a stir of air
  S.reveal = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.5), 0.6, 0.4);
    const nz = V.src('pink', t), bp = V.filt('bandpass', 500, 1.2), g = V.gain(0);
    nz.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(400, t); bp.frequency.exponentialRampToValueAtTime(900, t + 1.4);
    V.done(E.ahr(g.gain, t, 0.9, 0.02, 0.2, 0.25));
  };

  // the moth: tiny soft wingbeats (arrive / land / leave)
  S.moth = (p, t) => {
    const st = p.state || 'arrive';
    const V = E.voice(t), bus = V.gain(1);
    const pn = V.add(E.pan(clamp(+p.pan || 0, -0.8, 0.8)));
    bus.connect(pn);
    V.out(pn, 0, 0.3);
    const dur = st === 'land' ? 0.35 : 1.4;
    const nz = V.src('pink', t), bp = V.filt('bandpass', 700, 1.1), am = V.gain(0.5), g = V.gain(0);
    const wing = V.osc('triangle', 26 + Math.random() * 10, t), wg = V.gain(0.5);
    wing.connect(wg); wg.connect(am.gain);
    nz.connect(bp); bp.connect(am); am.connect(g); g.connect(bus);
    const peak = 0.12;
    g.gain.setValueAtTime(0, t);
    if (st === 'leave') { g.gain.linearRampToValueAtTime(peak, t + 0.1); g.gain.linearRampToValueAtTime(0, t + dur); bp.frequency.setValueAtTime(800, t); bp.frequency.exponentialRampToValueAtTime(350, t + dur); }
    else if (st === 'land') { g.gain.linearRampToValueAtTime(peak, t + 0.05); g.gain.linearRampToValueAtTime(0, t + dur); }
    else { g.gain.linearRampToValueAtTime(peak, t + dur * 0.6); g.gain.linearRampToValueAtTime(0, t + dur); }
    if (st === 'land') burst(V, bus, t + dur * 0.8, { f: 4200, Q: 1.5, peak: 0.04, tau: 0.002 });
    V.done(t + dur + 0.05);
  };

  // --- the phonograph -----------------------------------------------------------------------------

  // the needle set down on the wax: the arm's soft weight, a tiny contact click, a scrape as the
  // stylus finds the groove (the continuous voice takes over: cutting hiss or the worn groove)
  S.phonoNeedle = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.8), 0.18);
    const e1 = thump(V, bus, t, 210, 120, 0.06, 0.022);
    ping(V, bus, 2900, t + 0.004, 0.035, 0.005, 'sine', 0.0005);
    burst(V, bus, t + 0.003, { f: 3600, Q: 1.2, peak: 0.12, tau: 0.003 });
    const c = V.src('crackle', t + 0.01, { rate: 1.3 }), nz = V.src('white', t + 0.01), am = V.gain(0.2);
    const bp = V.filt('bandpass', 2300, 0.9), g = V.gain(0);
    c.connect(am.gain); nz.connect(am); am.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(3000, t + 0.01); bp.frequency.exponentialRampToValueAtTime(1700, t + 0.22);
    const e2 = E.ahr(g.gain, t + 0.01, 0.02, 0.16, 0.08, 0.05);
    V.stopAt(c, e2); V.stopAt(nz, e2);
    V.done(Math.max(e1, e2));
  };

  // the needle lifted off and the brake lever set: a short upward scrape, a click, a knock
  S.phonoStop = (p, t) => {
    const V = E.voice(t), bus = V.gain(1);
    V.out(bus, pan(p, 0.8), 0.18);
    const c = V.src('crackle', t, { rate: 1.8 }), nz = V.src('white', t), am = V.gain(0.2);
    const bp = V.filt('bandpass', 1900, 1.1), g = V.gain(0);
    c.connect(am.gain); nz.connect(am); am.connect(bp); bp.connect(g); g.connect(bus);
    bp.frequency.setValueAtTime(1800, t); bp.frequency.exponentialRampToValueAtTime(4400, t + 0.11);
    const e1 = E.ahr(g.gain, t, 0.015, 0.12, 0.06, 0.025);
    V.stopAt(c, e1); V.stopAt(nz, e1);
    const tc = t + 0.15;
    ping(V, bus, 2450, tc, 0.05, 0.008, 'sine', 0.0005);
    ping(V, bus, 4100, tc + 0.002, 0.02, 0.004, 'sine', 0.0005);
    const b = burst(V, bus, tc, { f: 3100, Q: 2, peak: 0.22, tau: 0.003 });
    const e2 = thump(V, bus, tc + 0.004, 330, 190, 0.07, 0.014);
    V.done(Math.max(e1, b.end, e2));
  };

  // --- the keeper ---------------------------------------------------------------------------------

  // She stands up out of the bare bronze: a slow intake of breath, her low tones (110, 165) bloom,
  // and over them one falling phrase in her own just intonation: up a fifth, a lingering minor
  // sixth that leans back onto the fifth, then down the old lament (5 4 b3 2 1) to rest. Warm,
  // breathy (the same formant as her continuous voice), mostly heard in the room.
  S.keeperArrive = (p, t) => {
    const R = 220;                                          // 55 · 4
    const V = E.voice(t), bus = V.gain(1), lp = V.filt('lowpass', 2300, 0.5);
    bus.connect(lp);
    V.out(lp, pan(p, 0.5), 0.9, 0.75);
    const fm = V.filt('peaking', 580, 1.2), body = V.gain(0);
    fm.gain.value = 6;
    fm.connect(body); body.connect(bus);
    // ratio to 220, onset (s), glide into it (s)
    const NOTES = [[1, 0, 0], [1.5, 0.95, 0.24], [1.6, 2.1, 0.12], [1.5, 2.7, 0.16], [4 / 3, 3.5, 0.14],
      [6 / 5, 4.1, 0.13], [9 / 8, 4.7, 0.13], [1, 5.35, 0.2]];
    const END = 6.9;                                       // the last note lets go here
    const a = V.osc(E.waves.warm, R, t + 0.25), b = V.osc(E.waves.warm, R, t + 0.25, 6), gb = V.gain(0.5);
    a.connect(fm); b.connect(gb); gb.connect(fm);
    for (const o of [a, b]) {
      o.frequency.setValueAtTime(R, t + 0.25);
      for (let i = 1; i < NOTES.length; i++) {
        const [r0] = NOTES[i - 1], [r1, on, gl] = NOTES[i];
        o.frequency.setValueAtTime(R * r0, t + on - gl);
        o.frequency.exponentialRampToValueAtTime(R * r1, t + on);
      }
    }
    // a slow, human vibrato that grows on the long notes
    const vib = V.osc('sine', 4.4, t), vg = V.gain(0);
    vib.connect(vg); vg.connect(a.detune); vg.connect(b.detune);
    vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(9, t + 1.9);
    vg.gain.setValueAtTime(9, t + 2.05); vg.gain.linearRampToValueAtTime(4, t + 2.3);
    vg.gain.linearRampToValueAtTime(10, t + 3.4); vg.gain.setValueAtTime(10, t + 5.3);
    vg.gain.linearRampToValueAtTime(3, t + 5.5); vg.gain.linearRampToValueAtTime(12, t + 6.8);
    // phrasing: swell in, lean on the sixth, a breath before the descent, rest, let go
    const G = body.gain, pk = 0.075;
    G.setValueAtTime(0, t + 0.25);
    G.linearRampToValueAtTime(pk * 0.8, t + 0.8);
    G.linearRampToValueAtTime(pk, t + 1.6);
    G.linearRampToValueAtTime(pk * 1.12, t + 2.15);
    G.linearRampToValueAtTime(pk * 0.85, t + 3.2);
    G.linearRampToValueAtTime(pk * 0.62, t + 3.42);
    G.linearRampToValueAtTime(pk * 0.85, t + 3.6);
    G.linearRampToValueAtTime(pk * 0.75, t + 5.2);
    G.linearRampToValueAtTime(pk * 0.9, t + 5.6);
    G.setTargetAtTime(0, t + END, 0.75);
    // her own low tones under it (the 55 itself would not carry)
    const lo = V.gain(0);
    lo.connect(fm);
    for (const [h, w] of [[2, 1], [3, 0.7], [4, 0.35]]) {
      const o = V.osc('sine', 55 * h, t), g = V.gain(w);
      o.connect(g); g.connect(lo);
    }
    lo.gain.setValueAtTime(0, t); lo.gain.linearRampToValueAtTime(0.04, t + 2.2);
    lo.gain.setValueAtTime(0.04, t + END - 0.6); lo.gain.setTargetAtTime(0, t + END - 0.6, 1.0);
    // breath: an intake before she sings, then air on every note
    const nz = V.src('pink', t), nBp = V.filt('bandpass', 820, 1.3), nG = V.gain(0);
    nz.connect(nBp); nBp.connect(nG); nG.connect(bus);
    nBp.frequency.setValueAtTime(520, t); nBp.frequency.exponentialRampToValueAtTime(900, t + 0.5);
    nG.gain.setValueAtTime(0, t); nG.gain.linearRampToValueAtTime(0.05, t + 0.4); nG.gain.linearRampToValueAtTime(0.014, t + 0.75);
    nG.gain.setValueAtTime(0.014, t + END - 0.3); nG.gain.setTargetAtTime(0, t + END - 0.3, 0.5);
    V.stopAt(nz, t + END + 4);
    V.done(t + END + 0.75 * 8);
  };

  return S;
}
