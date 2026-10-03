// The keeper's voice. She is the fundamental's own creature (comps ['floor'], k = 2, 55 Hz), and
// 55 Hz is below what a laptop can play, so she is heard by her overtones: a soft, breathy
// harmonic stack on 55·{2,3,4,5,6} with a gentle formant around 400–700 Hz (an "oh" more than an
// "ah"), a very slow vibrato and a slower drift, a twin a few cents off so she seems to breathe,
// and breath itself: noise pulsed at her own 55 Hz through the formant. Always present while she
// lives (snap.keeper.on), low in the mix, panned to where she walks the rim; she swells and ebbs
// in long phrases, softens in the dark, warms a little against a resting finger and under a Floor.
// (Her arrival phrase is the one-shot 'keeperArrive' in sfx.js.)

export const KEEPER_HZ = 55;
const LEVEL = 0.02;
// harmonics of 55 Hz: the stack 2–6 carries her, 7–13 sit in the formant, a trace of the true 55
export const KEEPER_PARTIALS = [0, 0.03, 0.7, 0.85, 0.75, 0.6, 0.5, 0.3, 0.34, 0.32, 0.28, 0.2, 0.14, 0.08, 0.05, 0.03, 0.02];
const TAU = Math.PI * 2;

function glide(last, key, param, v, at, tau) {
  const p = last[key];
  if (p !== undefined && Math.abs(p - v) <= Math.abs(v) * 0.0015 + 1e-6) return;
  last[key] = v;
  param.setTargetAtTime(v, at, tau);
}

export function createKeeper(E) {
  let n = null, idle = 0, rise = 0;
  const last = {};
  let wave = null;
  const ph = Math.random() * TAU;

  function wake(at) {
    if (!wave) {
      const im = Float32Array.from(KEEPER_PARTIALS), re = new Float32Array(im.length);
      wave = E.ctx.createPeriodicWave(re, im, { disableNormalization: true });
    }
    const out = E.gain(0), pan = E.pan(0);
    out.connect(pan); pan.connect(E.bus.singer);
    // formant: a broad bump near 560 Hz, then a soft roll-off (nothing glassy about her)
    const fm = E.filt('peaking', 560, 1.0), lp = E.filt('lowpass', 2400, 0.5);
    fm.gain.value = 7;
    fm.connect(lp); lp.connect(out);
    // the stack and its twin
    const a = E.osc(wave, KEEPER_HZ), b = E.osc(wave, KEEPER_HZ, 5), gb = E.gain(0.55);
    a.connect(fm); b.connect(gb); gb.connect(fm);
    // very slow vibrato (cents) and a slower drift, shared by both
    const vib = E.osc('sine', 0.31), vg = E.gain(7), drift = E.osc('sine', 0.053), dg = E.gain(4);
    vib.connect(vg); drift.connect(dg);
    for (const o of [a, b]) { vg.connect(o.detune); dg.connect(o.detune); }
    // breath: pink noise pulsed at 55 Hz (a breathy, pitched air), through the formant and a
    // little air band above it
    const nz = E.src('pink'), nAm = E.gain(0.5), pulse = E.osc('sine', KEEPER_HZ), pg = E.gain(0.45);
    pulse.connect(pg); pg.connect(nAm.gain);
    const nBp = E.filt('bandpass', 620, 1.4), nG = E.gain(3.5), air = E.filt('bandpass', 1700, 1.1), airG = E.gain(1);
    nz.connect(nAm); nAm.connect(nBp); nBp.connect(nG); nG.connect(lp);
    nAm.connect(air); air.connect(airG); airG.connect(out);
    for (const o of [a, b, vib, drift, pulse]) o.start(at);
    nz.start(at, E.offset('pink'));
    n = { out, pan, fm, lp, a, b, gb, vib, vg, drift, dg, nz, nAm, pulse, pg, nBp, nG, air, airG };
    for (const k in last) delete last[k];
    rise = 0;
  }
  function sleep(at) {
    const nodes = Object.values(n);
    for (const s of [n.a, n.b, n.vib, n.drift, n.pulse, n.nz]) E.stop(s, at);
    n.a.onended = () => E.free(nodes);
    n = null;
  }

  return {
    get live() { return !!n; },
    update(snap, dt, at) {
      const K = snap.keeper;
      const on = !!(K && K.on);
      if (on) { idle = 0; if (!n) wake(at); }
      else if (n) {
        glide(last, 'g', n.out.gain, 0, at, 1.2);
        idle += dt;
        if (idle > 6) sleep(at + 0.05);
        return;
      }
      if (!n) return;
      // she comes in slowly (and hardly at all while still standing up out of the bronze)
      rise = Math.min(1, rise + dt / 6);
      const T = E.t, dark = E.dark;
      const phrase = 0.72 + 0.2 * Math.sin(T * TAU * 0.071 + ph) + 0.08 * Math.sin(T * TAU * 0.19 + ph * 2);
      const born = K.born ? 0.3 : 1;
      const warm = 1 + 0.18 * (K.nestle ? 1 : 0) + 0.4 * (snap.floor || 0);
      const e = K.e > 0 ? Math.min(1, K.e) : 0.9;
      const g = LEVEL * rise * born * phrase * warm * (0.8 + 0.2 * e) * (1 - 0.3 * dark);
      glide(last, 'g', n.out.gain, g, at, 0.6);
      glide(last, 'p', n.pan.pan, Math.max(-0.7, Math.min(0.7, (K.cu || 0) * 0.6)), at, 0.8);
      // in the dark the formant sinks and closes a little (a sleepier vowel)
      glide(last, 'f', n.fm.frequency, 560 - 90 * dark, at, 1);
      glide(last, 'l', n.lp.frequency, 2400 - 800 * dark, at, 1);
      glide(last, 'v', n.vg.gain, 7 * (1 - 0.4 * dark), at, 1);
    },
  };
}
