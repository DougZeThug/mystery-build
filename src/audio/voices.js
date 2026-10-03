// Continuous voices. Each is created idle, wakes its nodes when it has something to say and puts
// them to sleep (stopped and disconnected) after a quiet spell, so a still room costs a handful
// of nodes. update(snap, dt, at) is called every frame; parameters only move by setTargetAtTime
// and only when they actually change (glide), so nothing clicks and the automation queue stays
// short. Nothing here allocates per frame once a voice is awake.
import { MODES } from '../sim/modes.js';
import { voiceChord, hash01, pitchGroups, powerByPitch, spreadOffset, minGap, singerDetune } from './dsp.js';

const TAU = Math.PI * 2;
const PITCH = pitchGroups(MODES);            // modes -> distinct pitches (the n.m± twins share one)
const NP = PITCH.count;
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);

// set an AudioParam toward v unless it is already heading there
function glide(last, key, param, v, at, tau) {
  const p = last[key];
  if (p !== undefined && Math.abs(p - v) <= Math.abs(v) * 0.0015 + 1e-6) return;
  last[key] = v;
  param.setTargetAtTime(v, at, tau);
}

// ---------------------------------------------------------------------------------------------
// The plate: one voice per sounding pitch (max 10, loudest first). Modes that share k (the n.m±
// twins) ring at one frequency, so they share one voice at their power sum: two oscillators on one
// pitch would add or cancel by the accident of when each woke. A sine at the pitch plus an
// inharmonic pair (×2.72, ×5.44, baked into one PeriodicWave): bronze, not organ. (The plate bus
// brightens as the whole plate swells; see engine.frame.) Unhealed cracks pull the tone flat and
// add a slightly sharp ghost that beats against it.

const PLATE_MAX = 10;
const PLATE_LEVEL = 0.22;
const PHONO_DUCK = 0.6;
const PARTIAL = 2.72;

export function createPlate(E) {
  const out = E.bus.plate;
  const V = new Array(NP).fill(null);
  const order = new Int16Array(NP);
  const amp = new Float32Array(NP), phAmp = new Float32Array(NP);
  let stamp = 0;
  let wob = null, wobG = null, wobIdle = 0;
  const wl = {};

  function voice(g) {
    let v = V[g];
    if (!v) v = V[g] = { g, f: PITCH.hz[g], live: false, stamp: 0, idle: 0, o1: null, o2: null, out: null, oh: null, gh: null, last: {} };
    return v;
  }
  function wake(v, at) {
    v.out = E.gain(0);
    v.o1 = E.osc('sine', v.f);
    v.o2 = E.osc(E.waves.metal, v.f * PARTIAL);
    v.o1.connect(v.out); v.o2.connect(v.out); v.out.connect(out);
    if (wobG) { wobG.connect(v.o1.detune); wobG.connect(v.o2.detune); }
    v.o1.start(at); v.o2.start(at);
    v.live = true; v.idle = 0;
    for (const k in v.last) delete v.last[k];
  }
  function sleep(v, at) {
    const nodes = [v.o1, v.o2, v.out, v.oh, v.gh];
    if (wobG) { try { wobG.disconnect(v.o1.detune); wobG.disconnect(v.o2.detune); } catch { /* not connected */ } }
    E.stop(v.o1, at); E.stop(v.o2, at); if (v.oh) E.stop(v.oh, at);
    v.o1.onended = () => E.free(nodes);
    v.live = false; v.oh = null; v.gh = null;
  }
  function ghost(v, at) {
    v.oh = E.osc('sine', v.f);
    v.gh = E.gain(0);
    v.oh.connect(v.gh); v.gh.connect(v.out);
    v.oh.start(at);
    delete v.last.hf; delete v.last.hg;
  }
  function wobble(on, at, det, dt) {
    if (on && !wob) {
      wob = E.osc('sine', 0.07); wobG = E.gain(0);
      wob.connect(wobG); wob.start(at);
      for (const v of V) if (v && v.live) { wobG.connect(v.o1.detune); wobG.connect(v.o2.detune); }
      for (const k in wl) delete wl[k];
    }
    if (!wob) return;
    glide(wl, 'g', wobG.gain, on ? det * 900 : 0, at, 0.6);   // cents
    if (on) wobIdle = 0;
    else if ((wobIdle += dt) > 3) {
      const nodes = [wob, wobG];
      E.stop(wob, at);
      wob.onended = () => E.free(nodes);
      wob = null; wobG = null;
    }
  }

  return {
    get live() { let n = 0; for (const v of V) if (v && v.live) n++; return n; },
    update(snap, dt, at) {
      powerByPitch(snap.amps, PITCH.group, amp);    // the floor (special) has its own voice
      let n = 0;
      for (let g = 0; g < NP; g++) if (amp[g] > 0.008) order[n++] = g;
      for (let a = 1; a < n; a++) {
        const x = order[a], ax = amp[x];
        let b = a - 1;
        while (b >= 0 && amp[order[b]] < ax) { order[b + 1] = order[b]; b--; }
        order[b + 1] = x;
      }
      const count = n < PLATE_MAX ? n : PLATE_MAX;
      stamp++;
      const det = snap.detune > 0 ? Math.min(0.03, snap.detune) : 0;
      let sum = 0;
      for (let j = 0; j < count; j++) sum += Math.min(1.6, amp[order[j]]);
      const norm = sum > 1.1 ? Math.sqrt(1.1 / sum) : 1;   // many modes do not add up linearly
      // what the phonograph is playing back is heard through its horn (phono.js); the bronze only
      // rings along in sympathy, so its own voice steps back for those pitches
      const ph = snap.phono && snap.phono.play ? powerByPitch(snap.phono.amps, PITCH.group, phAmp) : null;
      for (let j = 0; j < count; j++) {
        const g = order[j], a = Math.min(1.6, amp[g]);
        const v = voice(g);
        if (!v.live) wake(v, at);
        v.stamp = stamp; v.idle = 0;
        const share = ph && ph[g] > 0 ? Math.min(1, ph[g] / Math.max(1e-3, amp[g])) : 0;
        const lv = PLATE_LEVEL * Math.pow(a, 0.8) * norm * (1 - PHONO_DUCK * share);
        glide(v.last, 'g', v.out.gain, lv, at, lv > (v.last.g || 0) ? 0.025 : 0.09);
        glide(v.last, 'f', v.o1.frequency, v.f * (1 - det * 0.35), at, 0.25);
        if (det > 0.0005) {
          if (!v.oh) ghost(v, at);
          glide(v.last, 'hf', v.oh.frequency, v.f * (1 + det * 0.9), at, 0.25);
          glide(v.last, 'hg', v.gh.gain, Math.min(0.8, det / 0.0075), at, 0.3);
        } else if (v.oh) glide(v.last, 'hg', v.gh.gain, 0, at, 0.4);
      }
      for (let g = 0; g < NP; g++) {
        const v = V[g];
        if (!v || !v.live || v.stamp === stamp) continue;
        glide(v.last, 'g', v.out.gain, 0, at, 0.1);
        v.idle += dt;
        if (v.idle > 1.2) sleep(v, at + 0.02);
      }
      wobble(det > 0.0005, at, det, dt);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The bow: white noise, amplitude-modulated by a stick-slip pulse train (rosin catching and
// letting go), split two ways: a resonant band at the bowed mode (it narrows as the mode locks
// in) and a broad, gritty rosin band that dominates the onset and slow, unsure strokes.

export function createBow(E) {
  let n = null, idle = 0, lock = 0, lastMode = -2, onset = 0;
  const last = {};

  function wake(at) {
    const src = E.src('white'), am = E.gain(0.4), crk = E.src('crackle'), crkG = E.gain(0.7);
    crk.connect(crkG); crkG.connect(am.gain); src.connect(am);
    const bpT = E.filt('bandpass', 440, 12), gT = E.gain(0);
    const bpS = E.filt('bandpass', 2300, 0.9), gS = E.gain(0);
    const pan = E.pan(0.4);
    am.connect(bpT); bpT.connect(gT); gT.connect(pan);
    am.connect(bpS); bpS.connect(gS); gS.connect(pan);
    pan.connect(E.bus.bow);
    src.start(at, E.offset('white')); crk.start(at, E.offset('crackle'));
    n = { src, am, crk, crkG, bpT, gT, bpS, gS, pan };
    for (const k in last) delete last[k];
  }
  function sleep(at) {
    const nodes = Object.values(n);
    E.stop(n.src, at); E.stop(n.crk, at);
    n.src.onended = () => E.free(nodes);
    n = null;
  }

  return {
    get live() { return !!n; },
    get lock() { return lock; },
    onset(s = 1) { onset = Math.max(onset, s); },
    update(snap, dt, at) {
      const b = snap.bow;
      const active = b.held || b.bowing || onset > 0.02;
      if (active) { idle = 0; if (!n) wake(at); } else if (n) { idle += dt; if (idle > 3) { sleep(at + 0.05); return; } }
      if (!n) return;
      const s = b.bowing ? clamp01(b.speed) : 0;
      if (b.modeIndex !== lastMode) { lock = Math.min(lock, 0.2); lastMode = b.modeIndex; }
      lock = b.bowing ? Math.min(1, lock + dt / 0.9) : Math.max(0, lock - dt * 1.5);
      onset *= Math.exp(-dt / 0.09);
      // a bow resting still on the edge is silent; the first few millimetres already catch
      const I = b.bowing ? 0.15 * Math.min(1, s / 0.06) + 0.85 * Math.pow(s, 0.7) : 0;
      const f = b.freq > 0 ? b.freq : 440;
      const Q = 10 + 30 * lock;
      const qc = Math.sqrt(Q / 10);           // a narrower band lets through less noise: compensate
      glide(last, 'tf', n.bpT.frequency, f, at, 0.04);
      glide(last, 'tq', n.bpT.Q, Q, at, 0.12);
      glide(last, 'tg', n.gT.gain, BOW_TONE * I * (0.45 + 0.55 * lock) * qc, at, 0.06);
      glide(last, 'sg', n.gS.gain, BOW_ROSIN * (I * (0.35 + 0.65 * (1 - lock)) + 1.5 * onset), at, 0.03);
      glide(last, 'sf', n.bpS.frequency, 1900 + 1400 * s, at, 0.08);
      glide(last, 'cr', n.crk.playbackRate, 0.55 + 1.7 * s, at, 0.08);
      glide(last, 'cd', n.crkG.gain, 0.35 + 0.9 * (1 - lock) + onset, at, 0.05);
      glide(last, 'p', n.pan.pan, b.pan || 0, at, 0.1);
    },
  };
}
const BOW_TONE = 3.2, BOW_ROSIN = 0.2;

// ---------------------------------------------------------------------------------------------
// The singers: one voice per living species (max 10, most numerous first). Each component of the
// species is a glassy oscillator (hybrids sing chords), a detuned twin thickens a crowd, a slow
// vibrato of its own and breathing keep it alive. Panned to where the species gathers. Kinds often
// share a pitch (the ± twins; k and 2k fold onto one octave), so every voice is given a fixed
// detune of its own, drawn from its name and kept clear of the pitches already sounding, and a
// vibrato rate apart from the kinds it coincides with: coinciding kinds beat slowly instead of
// locking into whatever sum or cancellation their starting phases happened to give. In the dark
// they sink an octave, soften and slow; in a choir they swell; around a resting finger they purr.
// When many cling to the bronze against a violent plate (life state 'cling'), the clinging kinds
// tremble: a fast, faint tremolo and a shiver of pitch (one shared LFO, depth by how many of each
// kind cling). The tremolo sits on its own stage after the voice's gain, so a voice that fades
// out takes its trembling with it.

const SING_MAX = 10;
const DETUNE = { lo: -7, hi: 7, step: 0.25, min: 2.5 };         // cents: each voice's fixed detune
const VIB_RATE = { lo: 4.2, hi: 5.9, step: 0.05, min: 0.35 };   // Hz: each voice's vibrato
const NEAR = 25;                  // cents: pitches closer than this beat against each other
const centsOf = (f) => 1200 * Math.log2(f);

export function createSingers(E) {
  const slots = [];
  const pick = new Int16Array(256);
  let stamp = 0;
  let trem = null, tremIdle = 0;

  function find(id) {
    for (let i = 0; i < slots.length; i++) if (slots[i].id === id) return slots[i];
    return null;
  }
  function make(sp, at) {
    if (!trem) { trem = E.osc('sine', TREM_HZ); trem.start(at); tremIdle = 0; }
    const freqs = voiceChord(sp.ks);
    if (!freqs.length) freqs.push(550);
    const h = hash01(sp.id), h2 = hash01(sp.id + '~'), h3 = hash01(sp.id + '^');
    // where its pitches sit (cents): the components, and the crowd twin a little above the lowest
    const twin = 6 + 6 * h2;
    const pos = freqs.map(centsOf);
    pos.push(pos[0] + twin);
    // its fixed detune, kept clear of the pitches already sounding; its vibrato rate, apart from
    // the voices it would beat against
    const det = singerDetune(pos, freqs.length, slots, (h - 0.5) * 12, DETUNE);
    for (let i = 0; i < pos.length; i++) pos[i] += det;
    const rates = [];
    for (const o of slots) if (minGap(pos, o.pos) < NEAR) rates.push(o.rate);
    const rate = spreadOffset([0], rates, VIB_RATE.lo + (VIB_RATE.hi - VIB_RATE.lo) * h3, VIB_RATE);
    // voice -> gain (level) -> tremolo stage -> pan
    const out = E.gain(0), ts = E.gain(1), pan = E.pan(0);
    out.connect(ts); ts.connect(pan); pan.connect(E.bus.singer);
    const depth = 9 + 3 * h2;                                   // vibrato, cents
    const vo = E.osc('sine', rate), vib = E.gain(depth);
    vo.connect(vib); vo.start(at);
    const os = [];
    for (let i = 0; i < freqs.length; i++) {
      const w = sp.aurata ? (i ? E.waves.bellSoft : E.waves.bell) : (i ? E.waves.glassSoft : E.waves.glass);
      const o = E.osc(w, freqs[i], det);
      o.connect(out); vib.connect(o.detune); o.start(at);
      os.push(o);
    }
    // a slightly detuned twin of the lowest voice: a crowd of the same kind shimmers
    const oc = E.osc(E.waves.glass, freqs[0], det + twin), gc = E.gain(0);
    oc.connect(gc); gc.connect(out); vib.connect(oc.detune); oc.start(at);
    // trembling (clinging): tremolo onto the stage after the gain, a shiver onto every pitch; silent at 0
    const tg = E.gain(0), tp = E.gain(0);
    trem.connect(tg); tg.connect(ts.gain);
    trem.connect(tp);
    for (const o of os) tp.connect(o.detune);
    tp.connect(oc.detune);
    const s = { id: sp.id, freqs, os, oc, gc, out, ts, pan, vo, vib, tg, tp, det, rate, depth, pos, nMain: freqs.length,
      ph: h * TAU, bw: TAU / (5 + 4 * h2), stamp, idle: 0, last: {} };
    slots.push(s);
    return s;
  }
  function kill(s, at) {
    const nodes = [...s.os, s.oc, s.gc, s.out, s.ts, s.pan, s.vo, s.vib, s.tg, s.tp];
    if (trem) { try { trem.disconnect(s.tg); trem.disconnect(s.tp); } catch { /* gone */ } }
    for (const o of s.os) E.stop(o, at);
    E.stop(s.oc, at); E.stop(s.vo, at);
    s.oc.onended = () => E.free(nodes);
  }

  return {
    get live() { return slots.length; },
    update(snap, dt, at) {
      const list = snap.species, N = Math.min(snap.nSpecies | 0, pick.length);
      // the most numerous species get voices
      let n = 0;
      for (let i = 0; i < N; i++) if (list[i].count > 0) pick[n++] = i;
      for (let a = 1; a < n; a++) {
        const x = pick[a], cx = list[x].count;
        let b = a - 1;
        while (b >= 0 && list[pick[b]].count < cx) { pick[b + 1] = pick[b]; b--; }
        pick[b + 1] = x;
      }
      const count = n < SING_MAX ? n : SING_MAX;
      stamp++;
      const dark = E.dark, choir = snap.choir || 0, hold = E.hold;
      const mul = Math.pow(2, -dark);
      const hush = snap.bow.bowing ? 0.78 : 1;
      const norm = 1 / Math.sqrt(1 + 0.3 * Math.max(0, count - 1));
      const det = snap.detune || 0;
      const T = E.t;
      const many = clamp01(((snap.clingN || 0) - 2) / 4);   // a few clinging: nothing; six or more: full
      for (let j = 0; j < count; j++) {
        const sp = list[pick[j]];
        let s = find(sp.id);
        if (!s) s = make(sp, at);
        s.stamp = stamp; s.idle = 0;
        const c = Math.min(16, sp.count), e = clamp01(sp.meanE);
        const breath = 1 + 0.14 * Math.sin(T * s.bw + s.ph);
        const purr = 1 + 0.22 * hold * Math.sin(T * TAU * 3.1 + s.ph);
        const g = SING_LEVEL * Math.sqrt(c) * (0.3 + 0.7 * e) * (1 - 0.45 * dark) * (1 + 0.55 * choir) * hush * norm * breath * purr;
        glide(s.last, 'g', s.out.gain, g, at, 0.12);
        // clinging: depth by the share of this kind that clings, once many cling at all
        const w = many > 0 && sp.cling > 0 ? many * Math.min(1, sp.cling / Math.max(1, sp.count)) : 0;
        glide(s.last, 'tg', s.tg.gain, TREM_DEPTH * w, at, w > 0 ? 0.15 : 0.4);
        glide(s.last, 'tp', s.tp.gain, TREM_CENTS * w, at, w > 0 ? 0.15 : 0.4);
        glide(s.last, 'c', s.gc.gain, Math.min(0.55, 0.18 * (c - 1)), at, 0.4);
        glide(s.last, 'p', s.pan.pan, Math.max(-0.75, Math.min(0.75, (sp.cu || 0) * 0.65)), at, 0.3);
        // its vibrato: slower and shallower in the dark, wider in a choir
        glide(s.last, 'vr', s.vo.frequency, s.rate * (1 - 0.5 * dark), at, 0.5);
        glide(s.last, 'vd', s.vib.gain, s.depth * (1 - 0.4 * dark) + 4 * choir, at, 0.5);
        // cracks pull each species further off true along its own detune, so the kinds spread apart
        // (never across each other) and beat against the plate
        const fm = mul * (1 + det * (s.det / DETUNE.hi) * 0.6);
        if (s.last.m === undefined || Math.abs(s.last.m - fm) > 0.0008) {
          s.last.m = fm;
          for (let i = 0; i < s.os.length; i++) s.os[i].frequency.setTargetAtTime(s.freqs[i] * fm, at, 0.09);
          s.oc.frequency.setTargetAtTime(s.freqs[0] * fm, at, 0.09);
        }
      }
      for (let i = slots.length - 1; i >= 0; i--) {
        const s = slots[i];
        if (s.stamp === stamp) continue;
        glide(s.last, 'g', s.out.gain, 0, at, 0.35);
        glide(s.last, 'tg', s.tg.gain, 0, at, 0.35);
        glide(s.last, 'tp', s.tp.gain, 0, at, 0.35);
        s.idle += dt;
        if (s.idle > 2.5) { kill(s, at + 0.02); slots.splice(i, 1); }
      }
      // the shared tremolo sleeps once nobody has sung for a while
      if (trem) {
        if (slots.length) tremIdle = 0;
        else if ((tremIdle += dt) > 4) {
          const t = trem;
          E.stop(t, at + 0.02);
          t.onended = () => E.free([t]);
          trem = null;
        }
      }
    },
  };
}
const SING_LEVEL = 0.05;
const TREM_HZ = 10.5, TREM_DEPTH = 0.42, TREM_CENTS = 7;

// ---------------------------------------------------------------------------------------------
// The room: a baked loop of rumble and air (dsp.js roomTone), the lamp's filament hum while it
// burns, and now and then a distant creak of the house.

export function createRoom(E) {
  let n = null, creakT = 40 + Math.random() * 50;
  const last = {};
  return {
    start(at) {
      if (n) return;
      const tone = E.src('room'), tG = E.gain(ROOM_LEVEL);
      const hum = E.osc(E.waves.hum, 100), hG = E.gain(0);
      tone.connect(tG); tG.connect(E.bus.room);
      hum.connect(hG); hG.connect(E.bus.room);
      tone.start(at, E.offset('room')); hum.start(at);
      n = { tone, tG, hum, hG };
    },
    update(snap, dt, at) {
      if (!n) return;
      glide(last, 'h', n.hG.gain, HUM_LEVEL * (1 - E.dark) * (1 - 0.6 * (snap.floor || 0)), at, 0.2);
      creakT -= dt;
      if (creakT <= 0) {
        creakT = 50 + Math.random() * 120;
        E.play('creak', { pan: Math.random() * 1.6 - 0.8 });
      }
    },
  };
}
const ROOM_LEVEL = 0.016, HUM_LEVEL = 0.0007;

// ---------------------------------------------------------------------------------------------
// The choir's drone: a warm bed on the root of the choir's clan (root, octave pair, twelfth,
// double octave), sawtooths through a slowly breathing lowpass. Only exists while a choir sings.

export function createDrone(E) {
  let n = null, idle = 0, root = 0;
  const last = {};
  function wake(r, at) {
    root = r;
    const out = E.gain(0), lp = E.filt('lowpass', 400, 0.8);
    lp.connect(out); out.connect(E.bus.drone);
    const o1 = E.osc('sine', r), g1 = E.gain(0.55);
    const o2a = E.osc('sawtooth', r * 2, -6), o2b = E.osc('sawtooth', r * 2, 6), g2 = E.gain(0.4);
    const o3 = E.osc('sawtooth', r * 3, 3), g3 = E.gain(0.22);
    const o4 = E.osc(E.waves.glass, r * 4), g4 = E.gain(0.16);
    o1.connect(g1); g1.connect(out);
    o2a.connect(g2); o2b.connect(g2); g2.connect(lp);
    o3.connect(g3); g3.connect(lp);
    o4.connect(g4); g4.connect(out);
    for (const o of [o1, o2a, o2b, o3, o4]) o.start(at);
    n = { out, lp, o1, g1, o2a, o2b, g2, o3, g3, o4, g4 };
    for (const k in last) delete last[k];
  }
  function sleep(at) {
    const nodes = Object.values(n);
    for (const o of [n.o1, n.o2a, n.o2b, n.o3, n.o4]) E.stop(o, at);
    n.o1.onended = () => E.free(nodes);
    n = null;
  }
  return {
    get live() { return !!n; },
    update(snap, dt, at) {
      const c = snap.choir || 0;
      if (c > 0.004) { idle = 0; if (!n) wake(snap.choirRoot || 68.75, at); }
      else if (n) { idle += dt; if (idle > 2) { sleep(at + 0.05); return; } }
      if (!n) return;
      const r = snap.choirRoot || root;
      if (Math.abs(r - root) > 0.3) {
        root = r;
        n.o1.frequency.setTargetAtTime(r, at, 0.7);
        n.o2a.frequency.setTargetAtTime(r * 2, at, 0.7); n.o2b.frequency.setTargetAtTime(r * 2, at, 0.7);
        n.o3.frequency.setTargetAtTime(r * 3, at, 0.7); n.o4.frequency.setTargetAtTime(r * 4, at, 0.7);
      }
      const dk = 1 - 0.4 * E.dark;
      glide(last, 'g', n.out.gain, 0.07 * Math.pow(c, 1.3) * dk, at, 0.3);
      glide(last, 'f', n.lp.frequency, (330 + 850 * c + 140 * Math.sin(E.t * 0.21)) * (1 - 0.35 * E.dark), at, 0.4);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The floor: the fundamental (k = 2, 55 Hz) blooms, felt more than heard: a sub-octave that slowly
// sweeps, a couple of upper harmonics so small speakers still carry it, a brown-noise roar of the
// whole plate, and a rush of sand fleeing to the rim while the bloom builds and fades.

export function createFloor(E) {
  let n = null, idle = 0, prevL = 0, rush = 0;
  const last = {};
  function wake(at) {
    const out = E.gain(0);                       // the sub-bass skips the glue compressor (bus.sub)
    out.connect(E.bus.sub);
    const o55 = E.osc('sine', 55), o27 = E.osc('sine', 27.5), g27 = E.gain(0.6);
    const o110 = E.osc('sine', 110), g110 = E.gain(0.24), o165 = E.osc('sine', 165), g165 = E.gain(0.1);
    o55.connect(out); o27.connect(g27); g27.connect(out); o110.connect(g110); g110.connect(out); o165.connect(g165); g165.connect(out);
    const roar = E.src('brown'), rLp = E.filt('lowpass', 120, 0.9), rG = E.gain(0);
    roar.connect(rLp); rLp.connect(rG); rG.connect(E.bus.drone);
    const sand = E.src('sand', { rate: 0.8 }), sBp = E.filt('bandpass', 2600, 0.6), sG = E.gain(0);
    sand.connect(sBp); sBp.connect(sG); sG.connect(E.bus.sfx);
    for (const o of [o55, o27, o110, o165]) o.start(at);
    roar.start(at, E.offset('brown')); sand.start(at, E.offset('sand'));
    n = { out, o55, o27, g27, o110, g110, o165, g165, roar, rLp, rG, sand, sBp, sG };
    for (const k in last) delete last[k];
  }
  function sleep(at) {
    const nodes = Object.values(n);
    for (const s of [n.o55, n.o27, n.o110, n.o165, n.roar, n.sand]) E.stop(s, at);
    n.o55.onended = () => E.free(nodes);
    n = null;
  }
  return {
    get live() { return !!n; },
    update(snap, dt, at) {
      const L = clamp01(snap.floor || 0);
      if (L > 0.003) { idle = 0; if (!n) wake(at); }
      else if (n) { idle += dt; if (idle > 2) { sleep(at + 0.05); prevL = 0; return; } }
      if (!n) return;
      const T = E.t;
      const swell = 1 + 0.12 * Math.sin(T * TAU * 0.11);
      glide(last, 'g', n.out.gain, FLOOR_LEVEL * Math.pow(L, 1.1) * swell, at, 0.25);
      glide(last, 'sub', n.o27.frequency, 27.5 * (1 + 0.035 * Math.sin(T * 0.45)), at, 0.3);
      glide(last, 'rf', n.rLp.frequency, 70 + 320 * L * (0.5 + 0.5 * Math.sin(T * 0.55)), at, 0.25);
      glide(last, 'rg', n.rG.gain, 0.3 * FLOOR_LEVEL * L, at, 0.3);
      // the sand rushes while the bloom is changing (rising or ebbing), not while it holds
      const dL = dt > 0 ? Math.abs(L - prevL) / dt : 0;
      prevL = L;
      rush += (Math.min(1, dL * 2.2) - rush) * Math.min(1, dt * 3);
      glide(last, 'sg', n.sG.gain, 0.09 * rush + 0.012 * L, at, 0.2);
    },
  };
}

const FLOOR_LEVEL = 0.28;

// ---------------------------------------------------------------------------------------------
// Sand: the rattle of grains hopping on a vibrating plate (loud while a figure is forming, a
// faint sizzle once it has settled) and the hiss of a stream being poured from the jar.

export function createSand(E) {
  let r = null, p = null, rIdle = 0, pIdle = 0, pourLvl = 0, pourAt = -9, pourPan = 0;
  const lr = {}, lp = {};
  const free = (nodes, src, at) => { E.stop(src, at); src.onended = () => E.free(nodes); };
  return {
    get live() { return !!(r || p); },
    pour(count, pan = 0) {
      pourAt = E.t;
      pourLvl = Math.min(1, 0.45 + (+count || 0) / 30);
      pourPan = pan;
    },
    update(snap, dt, at) {
      // rattle: grains hopping while the plate moves them; it settles as the figure forms
      const tot = snap.total || 0, st = snap.stable || 0;
      const sandF = Math.pow(clamp01((snap.sandN ?? 15000) / 15000), 0.6);
      const rattle = RATTLE * Math.pow(clamp01((tot - 0.08) / 1.1), 1.2) * (0.25 + 0.75 * Math.exp(-st / 2.5)) * sandF;
      if (rattle > 0.0006) {
        rIdle = 0;
        if (!r) {
          const src = E.src('sand'), bp = E.filt('bandpass', 4300, 0.6), g = E.gain(0);
          src.connect(bp); bp.connect(g); g.connect(E.bus.sfx); src.start(at, E.offset('sand'));
          r = { src, bp, g };
          for (const k in lr) delete lr[k];
        }
      } else if (r && (rIdle += dt) > 2) { free(Object.values(r), r.src, at + 0.05); r = null; }
      if (r) glide(lr, 'g', r.g.gain, rattle, at, 0.12);

      // pouring from the jar: a stream of events keeps it alive
      const pouring = E.t - pourAt < 0.16 ? pourLvl : 0;
      if (pouring > 0) {
        pIdle = 0;
        if (!p) {
          const src = E.src('sand', { rate: 0.72 }), bp = E.filt('bandpass', 2500, 0.5), g = E.gain(0), pan = E.pan(0);
          src.connect(bp); bp.connect(g); g.connect(pan); pan.connect(E.bus.sfx); src.start(at, E.offset('sand'));
          p = { src, bp, g, pan };
          for (const k in lp) delete lp[k];
        }
      } else if (p && (pIdle += dt) > 1.5) { free(Object.values(p), p.src, at + 0.05); p = null; }
      if (p) {
        glide(lp, 'g', p.g.gain, POUR * pouring, at, pouring > 0 ? 0.05 : 0.12);
        glide(lp, 'p', p.pan.pan, pourPan, at, 0.1);
      }
    },
  };
}
const RATTLE = 0.06, POUR = 0.16;
