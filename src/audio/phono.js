// The phonograph: a spring-wound wax-cylinder machine at the edge of the light.
//   recording: the cutting stylus hisses softly on fresh wax; the clockwork motor purrs and ticks.
//   playing:   a warm crackle bed off the worn groove, and a SEPARATE voice that doubles the modes
//              being played back into the plate (snap.phono.amps, from field source 'phono'),
//              through a horn: band-limited, a little reedy, wobbling with the cylinder's wow and
//              the motor's flutter. The plate rings in sympathy underneath (voices.js ducks the
//              plate's own voice for those modes), so what you hear is a RECORDING of the plate.
//              One horn tone per pitch: modes that share k (the n.m± twins) add by power into one
//              oscillator, as on the plate, so they cannot cancel by phase.
// Like every continuous voice it wakes on demand and sleeps (stopped, disconnected) when idle.
import { MODES } from '../sim/modes.js';
import { PHONO_TURN, pitchGroups, powerByPitch } from './dsp.js';

const PITCH = pitchGroups(MODES, () => false);   // the floor too: the cylinder may hold it
const NP = PITCH.count;
const TONE_MAX = 6;               // doubled pitches, loudest first
const TONE_LEVEL = 0.17;
const MOTOR_LEVEL = 0.03, HISS_LEVEL = 0.05, BED_LEVEL = 0.15;
const SEND = 0.22;                // the machine is in the room: a little reverb
const TURN_HZ = 1 / PHONO_TURN;   // 2.67 Hz: once-a-turn wow, the wax's swell

function glide(last, key, param, v, at, tau) {
  const p = last[key];
  if (p !== undefined && Math.abs(p - v) <= Math.abs(v) * 0.0015 + 1e-6) return;
  last[key] = v;
  param.setTargetAtTime(v, at, tau);
}

export function createPhono(E) {
  let n = null, idle = 0;
  const last = {};
  const slots = new Array(NP).fill(null);
  const order = new Int16Array(NP);
  const amp = new Float32Array(NP);
  let stamp = 0;
  // the horn: a few low harmonics (the diaphragm is not linear), then the band-limit does the rest
  const horn = (() => {
    const amps = [0, 1, 0.38, 0.24, 0.12, 0.07, 0.04];
    const re = new Float32Array(amps.length), im = Float32Array.from(amps);
    return E.ctx.createPeriodicWave(re, im, { disableNormalization: true });
  })();

  function wake(at) {
    const out = E.gain(1), pan = E.pan(0.45), send = E.gain(SEND);
    pan.connect(out); out.connect(E.master); out.connect(send); send.connect(E.verb);
    // the cylinder's turn: one slow LFO shared by the wax swell and the horn's wow
    const turn = E.osc('sine', TURN_HZ);
    // motor: clockwork loop, spinning up as the spring takes hold
    const mSrc = E.src('clock', { rate: 0.55 }), mHp = E.filt('highpass', 160, 0.7), mG = E.gain(0);
    mSrc.connect(mHp); mHp.connect(mG); mG.connect(pan);
    // cutting hiss: pink noise above ~1.8 kHz, breathing once a turn
    const hSrc = E.src('pink'), hHp = E.filt('highpass', 1800, 0.6), hLp = E.filt('lowpass', 7500, 0.6), hG = E.gain(0);
    const hAm = E.gain(1), hDepth = E.gain(0.25);
    hSrc.connect(hHp); hHp.connect(hLp); hLp.connect(hAm); hAm.connect(hG); hG.connect(pan);
    turn.connect(hDepth); hDepth.connect(hAm.gain);
    // playback bed: the worn groove
    const bSrc = E.src('wax'), bLp = E.filt('lowpass', 5200, 0.6), bHp = E.filt('highpass', 220, 0.6), bG = E.gain(0);
    bSrc.connect(bLp); bLp.connect(bHp); bHp.connect(bG); bG.connect(pan);
    // the horn voice: sum -> band-limit (two high-passes ~300 Hz, two low-passes ~3 kHz) -> the
    // horn's honk near 1.2 kHz -> a little amplitude swell once a turn -> out
    const tSum = E.gain(1);
    const tHp1 = E.filt('highpass', 300, 0.7), tHp2 = E.filt('highpass', 340, 0.9);
    const tLp1 = E.filt('lowpass', 2900, 0.9), tLp2 = E.filt('lowpass', 3400, 0.6);
    const tPk = E.filt('peaking', 1200, 1.1);
    tPk.gain.value = 5;
    const tAm = E.gain(1), tDepth = E.gain(0.07), tG = E.gain(0);
    tSum.connect(tHp1); tHp1.connect(tHp2); tHp2.connect(tLp1); tLp1.connect(tLp2); tLp2.connect(tPk);
    tPk.connect(tAm); tAm.connect(tG); tG.connect(pan);
    turn.connect(tDepth); tDepth.connect(tAm.gain);
    // wow and flutter (cents) into every horn oscillator's detune
    const wf = E.gain(1);
    const wowG = E.gain(5), drift = E.osc('sine', 0.37), driftG = E.gain(3.5), flut = E.osc('sine', 9.3), flutG = E.gain(2.5);
    turn.connect(wowG); wowG.connect(wf);
    drift.connect(driftG); driftG.connect(wf);
    flut.connect(flutG); flutG.connect(wf);
    for (const o of [turn, drift, flut]) o.start(at);
    mSrc.start(at, E.offset('clock')); hSrc.start(at, E.offset('pink')); bSrc.start(at, E.offset('wax'));
    n = { out, pan, send, turn, mSrc, mHp, mG, hSrc, hHp, hLp, hG, hAm, hDepth, bSrc, bLp, bHp, bG,
      tSum, tHp1, tHp2, tLp1, tLp2, tPk, tAm, tDepth, tG, wf, wowG, drift, driftG, flut, flutG, motorOn: false };
    for (const k in last) delete last[k];
    idle = 0;
  }
  function sleep(at) {
    for (let g = 0; g < NP; g++) if (slots[g]) killSlot(g, at);
    const nodes = Object.values(n).filter((x) => x && typeof x === 'object');
    for (const s of [n.turn, n.drift, n.flut, n.mSrc, n.hSrc, n.bSrc]) E.stop(s, at);
    n.turn.onended = () => E.free(nodes);
    n = null;
  }
  function slot(p, at) {
    let s = slots[p];
    if (s) return s;
    const o = E.osc(horn, PITCH.hz[p], -4), g = E.gain(0);     // the spring runs a hair slow
    o.connect(g); g.connect(n.tSum); n.wf.connect(o.detune);
    o.start(at);
    s = slots[p] = { o, g, idle: 0, stamp: 0, last: {} };
    return s;
  }
  function killSlot(p, at) {
    const s = slots[p];
    slots[p] = null;
    try { n.wf.disconnect(s.o.detune); } catch { /* gone */ }
    E.stop(s.o, at);
    const nodes = [s.o, s.g];
    s.o.onended = () => E.free(nodes);
  }

  return {
    get live() { return !!n; },
    get tones() { let c = 0; for (const s of slots) if (s) c++; return c; },
    update(snap, dt, at) {
      const P = snap.phono;
      const rec = !!(P && P.rec), play = !!(P && P.play), motor = !!(P && (P.motor || rec || play));
      if (rec || play || motor) { idle = 0; if (!n) wake(at); }
      else if (n) { idle += dt; if (idle > 2.5) { sleep(at + 0.05); return; } }
      if (!n) return;
      glide(last, 'pan', n.pan.pan, P ? Math.max(-0.85, Math.min(0.85, P.pan || 0)) : 0.45, at, 0.2);
      // motor: spins up when wound, winds down when released
      if (motor !== n.motorOn) {
        n.motorOn = motor;
        n.mSrc.playbackRate.setTargetAtTime(motor ? 1 : 0.45, at, motor ? 0.22 : 0.5);
      }
      glide(last, 'm', n.mG.gain, motor ? MOTOR_LEVEL * (play ? 0.7 : 1) : 0, at, motor ? 0.18 : 0.35);
      glide(last, 'h', n.hG.gain, rec ? HISS_LEVEL : 0, at, rec ? 0.08 : 0.06);
      glide(last, 'b', n.bG.gain, play ? BED_LEVEL : 0, at, play ? 0.1 : 0.07);

      // the horn doubles what the cylinder is playing into the plate, loudest pitches first
      const A = play && P.amps ? powerByPitch(P.amps, PITCH.group, amp) : null;
      let cnt = 0;
      if (A) {
        for (let p = 0; p < NP; p++) if (A[p] > 0.004) order[cnt++] = p;
        for (let a = 1; a < cnt; a++) {
          const x = order[a], ax = A[x];
          let b = a - 1;
          while (b >= 0 && A[order[b]] < ax) { order[b + 1] = order[b]; b--; }
          order[b + 1] = x;
        }
        if (cnt > TONE_MAX) cnt = TONE_MAX;
      }
      stamp++;
      let sum = 0;
      for (let j = 0; j < cnt; j++) sum += A[order[j]];
      const norm = sum > 0.7 ? Math.sqrt(0.7 / sum) : 1;
      for (let j = 0; j < cnt; j++) {
        const p = order[j];
        const s = slot(p, at);
        s.stamp = stamp; s.idle = 0;
        const lv = TONE_LEVEL * Math.pow(A[p], 0.8) * norm;
        glide(s.last, 'g', s.g.gain, lv, at, lv > (s.last.g || 0) ? 0.05 : 0.12);
      }
      for (let p = 0; p < NP; p++) {
        const s = slots[p];
        if (!s || s.stamp === stamp) continue;
        glide(s.last, 'g', s.g.gain, 0, at, 0.1);
        if ((s.idle += dt) > 0.9) killSlot(p, at + 0.02);
      }
      glide(last, 't', n.tG.gain, play ? 1 : 0, at, play ? 0.06 : 0.08);
    },
  };
}
