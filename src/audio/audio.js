// All sound: procedural WebAudio, no samples.
// createAudio(game) waits for the first user gesture (bus 'start'), then builds the engine
// (engine.js: master chain, the dark room's reverb, continuous voices; sfx.js: one-shots).
// Every frame audio.update(dt) condenses the game into a plain snapshot (plate amplitudes, bow,
// living species, darkness, choir, floor) without allocating; bus events become one-shots.
import { createEngine } from './engine.js';
import { droneRootHz, foldInto, BUFFER_JOBS, reverbChannel, IR_SECONDS, resample } from './dsp.js';
import { MODES, modeById } from '../sim/modes.js';

const NM = MODES.length;
const FLOOR_INDEX = MODES.findIndex((m) => m.special);
const MUTE_KEY = 'stillpoint.muted';
const PREP_RATE = 48000;          // buffers are prepared at this rate before the context exists
const SEED = 7;
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
const clampPan = (x) => (x > 1 ? 1 : x < -1 ? -1 : x || 0);

// The engine's per-frame input. Plain data, reused every frame (dev harnesses fill it by hand).
export function makeSnapshot() {
  return {
    amps: new Float32Array(NM),      // plate amplitude per mode (index = MODES index)
    detune: 0,                       // field.detune (unhealed cracks)
    total: 0, stable: 0,             // field.total, field.coherence.stable
    sandN: 15000,                    // grains on the plate
    bow: { held: false, bowing: false, speed: 0, freq: 0, modeIndex: -1, pan: 0.4 },
    species: [], nSpecies: 0,        // [{ id, ks, count, meanE, cu, aurata }]
    dark: 0, hold: 0,                // light off; resting finger
    choir: 0, choirRoot: 0, floor: 0,
  };
}

export function createAudio(game) {
  const bus = game.bus || { on() { return () => {}; } };
  const snap = makeSnapshot();
  const ksCache = new Map();
  const offs = [];
  let ctx = null, E = null, started = false;
  let muted = readMuted();
  let choirRoot = 0, choirRootAuto = 0;
  let bowFallback = null, bowFallbackT = 0;
  let hideTimer = 0, irSet = false;
  // buffer data prepared in idle time, before and after the first gesture (see dsp.js BUFFER_JOBS)
  const prep = { rate: PREP_RATE, bufs: {}, ir: null, irRate: 0 };
  schedulePrep();

  const audio = {
    get muted() { return muted; },
    set muted(v) { audio.setMuted(v); },
    get ready() { return !!E; },
    get context() { return ctx; },
    get engine() { return E; },
    get snapshot() { return snap; },
    setMuted(m) {
      muted = !!m;
      writeMuted(muted);
      if (E) E.setMuted(muted);
    },
    toggleMute() { audio.setMuted(!muted); return muted; },
    // resume a context the browser suspended (call from any user gesture; harmless otherwise)
    unlock,
    start,
    // generic one-shot (same names as bus 'sfx'); returns false if dropped
    play(name, params = {}) { return E ? E.play(aliasOf(name, params), params) : false; },
    update(dt) {
      if (!E || ctx.state !== 'running') return;
      fill(dt);
      E.frame(snap, dt);
    },
    stats() {
      if (!E) return { state: ctx ? ctx.state : 'idle' };
      const v = E.voices;
      return { state: ctx.state, nodes: E.nodes, oneShots: E.oneShots, plate: v.plate.live, singers: v.singers.live,
        bow: v.bow.live, drone: v.drone.live, floor: v.floor.live, sand: v.sand.live, sampleRate: ctx.sampleRate };
    },
    destroy() {
      for (const off of offs) try { off(); } catch { /* gone */ }
      offs.length = 0;
      try { ctx?.close(); } catch { /* closed */ }
      E = null; ctx = null;
    },
  };

  // --- lifecycle -----------------------------------------------------------------------------
  function start() {
    if (started) { unlock(); return; }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;                                 // no WebAudio: the room is silent, nothing breaks
    started = true;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* Safari only */ }
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { try { ctx = new AC(); } catch { ctx = null; } }
    if (!ctx) return;
    unlock();
    try {
      E = createEngine(ctx, { fadeIn: 1.5, data: prep, deferIR: true, seed: SEED });
    } catch (e) {
      console.warn('[audio] engine failed to start', e);
      E = null;
      return;
    }
    E.setMuted(muted, ctx.currentTime);
    E.start(1.5);
    handOverIR();
    for (const type of ['pointerdown', 'touchend', 'keydown', 'click']) {
      window.addEventListener(type, unlock, { capture: true, passive: true });
      offs.push(() => window.removeEventListener(type, unlock, { capture: true }));
    }
    const vis = () => visibility();
    document.addEventListener('visibilitychange', vis);
    offs.push(() => document.removeEventListener('visibilitychange', vis));
  }

  // One buffer per idle slot, starting shortly after boot, so the first click costs almost nothing
  // (the engine makes buffers on first use and takes them from here when they are ready).
  function schedulePrep() {
    if (typeof window === 'undefined') return;
    const jobs = BUFFER_JOBS.map(([name, job]) => () => { if (!prep.bufs[name]) prep.bufs[name] = job(PREP_RATE, SEED); });
    const ir = [];
    jobs.push(() => { ir[0] = reverbChannel(PREP_RATE, 0, { seconds: IR_SECONDS, seed: SEED }); });
    jobs.push(() => {
      ir[1] = reverbChannel(PREP_RATE, 1, { seconds: IR_SECONDS, seed: SEED });
      prep.ir = ir; prep.irRate = PREP_RATE;
      handOverIR();
    });
    const idle = window.requestIdleCallback
      ? (fn) => window.requestIdleCallback(fn, { timeout: 1200 })
      : (fn) => setTimeout(fn, 40);
    let i = 0;
    const step = () => {
      if (i >= jobs.length) return;
      try { jobs[i++](); } catch (e) { console.warn('[audio] prepare', e); }
      if (i < jobs.length) idle(step);
    };
    setTimeout(() => idle(step), 300);
  }

  // the convolver needs its IR at the context's own rate (resampled if the device runs at 44.1k)
  function handOverIR() {
    if (!E || irSet || !prep.ir) return;
    irSet = true;
    const sr = ctx.sampleRate;
    E.setIR(prep.irRate === sr ? prep.ir : prep.ir.map((x) => resample(x, prep.irRate, sr)));
  }

  // resume + a one-sample silent buffer. iOS only truly unlocks on a sound started inside a
  // gesture it accepts (some versions ignore pointerdown), so this repeats on every gesture until
  // the context is running.
  let primed = false;
  function unlock() {
    if (!ctx || ctx.state === 'closed' || document.visibilityState === 'hidden') return;
    if (ctx.state === 'running' && primed) return;
    try { const p = ctx.resume(); if (p && p.catch) p.catch(() => {}); } catch { /* not allowed yet */ }
    try {
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = b; s.connect(ctx.destination); s.start(0);
      s.onended = () => { try { s.disconnect(); } catch { /* fine */ } };
    } catch { /* fine */ }
    primed = true;
  }

  // hidden tab: fade out and suspend (no drones playing behind your back); back: resume, fade in
  function visibility() {
    if (!ctx || !E) return;
    clearTimeout(hideTimer);
    if (document.visibilityState === 'hidden') {
      E.fadeTo(0, 0.06);
      hideTimer = setTimeout(() => { if (document.visibilityState === 'hidden') ctx.suspend().catch(() => {}); }, 300);
    } else {
      const p = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
      p.then(() => E && E.fadeTo(1, 0.35)).catch(() => {});
    }
  }

  // --- the snapshot ----------------------------------------------------------------------------
  function fill(dt) {
    const f = game.field;
    const amps = snap.amps;
    if (f) {
      if (typeof f.ampIndex === 'function') {
        for (let i = 0; i < NM; i++) { const a = +f.ampIndex(i); amps[i] = a > 0 ? a : 0; }
      } else if (typeof f.spectrum === 'function') {
        amps.fill(0);
        const sp = f.spectrum() || [];
        for (let i = 0; i < sp.length; i++) { const m = modeById(sp[i].mode); if (m) amps[m.index] = +sp[i].amp || 0; }
      }
      snap.detune = +f.detune || 0;
      snap.total = +f.total || 0;
      snap.stable = +(f.coherence && f.coherence.stable) || 0;
    }
    snap.sandN = Number.isFinite(game.sand?.n) ? game.sand.n : 15000;

    // the bow (tools.bow, else the last bow:move event)
    const sb = snap.bow, b = game.tools?.bow;
    if (b && (b.held !== undefined || b.bowing !== undefined)) {
      sb.held = !!b.held; sb.bowing = !!b.bowing; sb.speed = clamp01(+b.speed01 || 0);
      setBowMode(sb, b.mode);
      sb.pan = bowPan(b);
    } else if (bowFallback && (bowFallbackT -= dt) > 0) {
      sb.held = true; sb.bowing = true; sb.speed = clamp01(+bowFallback.speed || 0);
      setBowMode(sb, bowFallback.mode);
      sb.pan = bowPan(bowFallback);
    } else { sb.held = false; sb.bowing = false; sb.speed = 0; }

    // living species
    const pops = game.life?.populations?.();
    let n = 0;
    if (pops && pops.length) {
      for (let i = 0; i < pops.length && n < 64; i++) {
        const p = pops[i];
        if (!p || !(p.count > 0)) continue;
        let e = snap.species[n];
        if (!e) e = snap.species[n] = { id: '', ks: null, count: 0, meanE: 0, cu: 0, aurata: false };
        e.id = typeof p.id === 'string' ? p.id : String(p.id);
        e.ks = p.ks && p.ks.length ? p.ks : ksFor(e.id, p.comps);
        e.count = p.count;
        e.meanE = Number.isFinite(p.meanE) ? p.meanE : 0.5;
        e.cu = Number.isFinite(p.cu) ? p.cu : 0;
        e.aurata = !!(p.species ? p.species.aurata : e.id.endsWith('*'));
        n++;
      }
    }
    snap.nSpecies = n;

    snap.dark = game.light && game.light.on === false ? 1 : 0;
    snap.hold = game.hold ? 1 : 0;
    snap.choir = clamp01(+(game.fx && game.fx.choir) || 0);
    snap.floor = Math.max(clamp01(+(game.fx && game.fx.floor) || 0), FLOOR_INDEX >= 0 ? clamp01(amps[FLOOR_INDEX] / 1.2) : 0);
    if (snap.choir > 0.004 && !choirRoot && !choirRootAuto) choirRootAuto = droneRootHz(livingKs());
    snap.choirRoot = choirRoot || choirRootAuto || 68.75;
  }

  function setBowMode(sb, id) {
    const m = id !== undefined && id !== null ? modeById(id) : null;
    sb.modeIndex = m ? m.index : -1;
    sb.freq = m ? m.freq : 0;
  }
  function bowPan(b) {
    const vw = game.view?.vw;
    if (Number.isFinite(b.x) && vw > 0) return clampPan(((b.x / vw) * 2 - 1) * 0.8);
    const t = Number.isFinite(b.t) ? b.t : 0.5;
    switch (b.edge) {
      case 'right': return 0.45;
      case 'left': return -0.45;
      case 'top': return (t * 2 - 1) * 0.45;
      case 'bottom': return (1 - t * 2) * 0.45;
      default: return 0.4;
    }
  }

  // --- species / motes -> harmonic numbers ------------------------------------------------------
  function ksFor(key, comps) {
    let ks = ksCache.get(key);
    if (ks) return ks;
    let list = comps;
    if (!Array.isArray(list)) list = String(key).replace(/\*$/, '').split('|');
    ks = [];
    for (const c of list) { const m = modeById(c); if (m) ks.push(m.k); }
    if (!ks.length) ks.push(20);
    ksCache.set(key, ks);
    return ks;
  }
  // a mote, a species object, a species id, or a list of mode ids -> [k...]
  function ksOf(x, depth = 0) {
    if (!x || depth > 3) return null;
    if (typeof x === 'string') {
      const sp = game.life?.species?.[x] || game.state?.species?.[x];
      return sp && typeof sp === 'object' ? (ksOf(sp, depth + 1) || ksFor(x)) : ksFor(x);
    }
    if (Array.isArray(x)) return typeof x[0] === 'number' ? x : ksFor(x.join('|'), x);
    if (Array.isArray(x.ks) && x.ks.length) return x.ks;
    if (Array.isArray(x.comps) && x.comps.length) return ksFor(x.id || x.comps.join('|'), x.comps);
    return ksOf(x.spec, depth + 1) || ksOf(x.species, depth + 1) || ksOf(x.sp, depth + 1);
  }
  const isAurata = (x) => !!(x && (x.aurata || x.spec?.aurata || x.species?.aurata || (typeof x.sp === 'string' && x.sp.endsWith('*'))));
  const uOf = (m) => (m && Number.isFinite(m.u) ? m.u : 0);

  function livingKs() {
    const out = [];
    for (let i = 0; i < snap.nSpecies; i++) for (const k of snap.species[i].ks) out.push(k);
    return out;
  }
  function loudestFreqs(count = 3) {
    const idx = [];
    for (let i = 0; i < NM; i++) if (snap.amps[i] > 0.02 && i !== FLOOR_INDEX) idx.push(i);
    idx.sort((a, b) => snap.amps[b] - snap.amps[a]);
    return idx.slice(0, count).map((i) => MODES[i].freq);
  }
  function clanRoot() {
    let best = null;
    for (let i = 0; i < snap.nSpecies; i++) if (!best || snap.species[i].count > best.count) best = snap.species[i];
    return best ? foldInto(27.5 * Math.min(...best.ks), 110, 220) : 137.5;
  }
  function anchorPan(what) {
    const a = game.view?.anchors?.[what], vw = game.view?.vw;
    if (!a || !(vw > 0) || !Number.isFinite(a.x)) return 0;
    return clampPan(((a.x / vw) * 2 - 1) * 0.8);
  }

  // --- bus events -> one-shots ---------------------------------------------------------------
  const on = (type, fn) => { const off = bus.on(type, (e) => { try { fn(e || {}); } catch (err) { console.warn('[audio]', type, err); } }); if (off) offs.push(off); };
  const play = (name, p) => (E ? E.play(name, p) : false);

  on('start', () => start());

  on('bow:start', (e) => {
    if (!E) return;
    E.bowOnset(1);
    play('scratch', { pan: bowPan(e.edge ? e : game.tools?.bow || {}), strength: 0.8 });
  });
  on('bow:move', (e) => { bowFallback = e; bowFallbackT = 0.25; });
  on('bow:end', () => { bowFallback = null; play('bowLift', { pan: bowPan(game.tools?.bow || {}) }); });

  on('plate:tap', (e) => play('tap', { u: +e.u || 0, v: +e.v || 0, strength: Number.isFinite(e.strength) ? e.strength : 0.6 }));
  on('plate:crack', (e) => {
    const c = game.state?.plate?.cracks?.[e.crack];
    const u = c?.pts?.[0]?.[0];
    play('crack', { pan: Number.isFinite(u) ? u : 0, freqs: loudestFreqs(3) });
  });
  on('plate:heal', (e) => {
    const c = game.state?.plate?.cracks?.[e.crack];
    const u = c?.pts?.[0]?.[0];
    play('heal', { pan: Number.isFinite(u) ? u : 0, root: clanRoot() });
  });
  on('sand:pour', (e) => { if (E) E.pour(+e.n || 10, clampPan((+e.u || 0) * 0.6)); });
  on('fork:strike', (e) => play('fork', { k: +e.k || 0 }));
  on('fork:touch', (e) => play('forkTouch', { k: +e.k || modeById(e.mode)?.k || 0 }));
  on('damper:place', (e) => play('damper', { pan: +e.u || 0 }));
  on('damper:remove', (e) => play('damperOff', { pan: +e.u || 0 }));

  on('mote:birth', (e) => play('birth', {
    ks: ksOf(e.species) || ksOf(e.mote), pan: uOf(e.mote), isNew: !!e.isNew, aurata: isAurata(e.species) || isAurata(e.mote),
  }));
  on('mote:split', (e) => play('split', { ks: ksOf(e.parent) || ksOf(e.child), pan: uOf(e.parent) }));
  on('mote:fuse', (e) => play('fuse', {
    ks: ksOf(e.species) || ksOf(e.child), ksA: ksOf(e.a), ksB: ksOf(e.b), pan: uOf(e.child) || (uOf(e.a) + uOf(e.b)) / 2,
  }));
  on('mote:eat', (e) => play('eat', { ks: ksOf(e.pred), preyKs: ksOf(e.prey), pan: uOf(e.prey) || uOf(e.pred) }));
  on('mote:death', (e) => {
    const p = { ks: ksOf(e.mote), pan: uOf(e.mote) };
    if (e.cause === 'age') play('crumble', p);
    else if (e.cause === 'hunger') play('fizzle', p);
    // 'eaten' is the eat sound; 'fall' already sang its glissando on mote:fall
  });
  on('mote:fall', (e) => play('fall', { ks: ksOf(e.mote), pan: uOf(e.mote) }));
  on('species:extinct', (e) => play('extinct', { ks: ksOf(e.species) }));

  on('life:choir', (e) => {
    if (e.on) {
      const ks = [];
      for (const id of e.species || []) { const k = ksOf(id); if (k) ks.push(...k); }
      choirRoot = ks.length ? droneRootHz(ks) : 0;
      play('choirSwell', { root: choirRoot || droneRootHz(livingKs()) });
    } else { choirRootAuto = 0; }
  });
  on('life:floor', (e) => { if (e.on) play('floorBloom', {}); });
  on('light', (e) => play(e.on ? 'lightOn' : 'lightOff', { pan: anchorPan('cord') }));
  on('reveal', (e) => play('reveal', { pan: anchorPan(e.what) }));
  on('journal:open', () => play('bookOpen', { pan: anchorPan('journal') }));
  on('journal:close', () => play('bookClose', { pan: anchorPan('journal') }));
  on('moth', (e) => play('moth', { state: e.state, pan: Number.isFinite(e.u) ? e.u * 0.6 : (Math.random() - 0.5) }));
  on('sfx', (e) => { const name = aliasOf(e.name, e); if (name) play(name, e); });

  return audio;
}

// bus 'sfx' names (and a few friendly aliases) -> synth names
const ALIAS = {
  cord: 'cord', pull: 'cord', drawer: 'drawer', drawerOpen: 'drawer', 'drawer:open': 'drawer',
  page: 'page', 'journal:page': 'page', paper: 'page', book: 'bookOpen', bookOpen: 'bookOpen', bookClose: 'bookClose',
  grab: 'grab', pickup: 'grab', lift: 'grab', drop: 'drop', place: 'drop', putdown: 'drop', thud: 'drop', settle: 'drop',
  glass: 'glass', jar: 'glass', clink: 'glass', tick: 'tick', click: 'tick',
  fork: 'fork', forkTouch: 'forkTouch', damper: 'damper', damperOff: 'damperOff', creak: 'creak', moth: 'moth',
  tap: 'tap', crack: 'crack', heal: 'heal', pour: 'pour', scratch: 'scratch', reveal: 'reveal',
  lightOn: 'lightOn', lightOff: 'lightOff', chime: 'glass',
};
function aliasOf(name, p) {
  if (!name) return null;
  if (name === 'drawerClose' || name === 'drawer:close') { if (p) p.open = false; return 'drawer'; }
  return ALIAS[name] || name;
}

function readMuted() { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } }
function writeMuted(m) { try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* private mode */ } }
