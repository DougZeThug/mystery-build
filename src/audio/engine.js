// The sound engine: master chain, the dark room's reverb, shared buffers, node factories and the
// continuous voices. Works on any BaseAudioContext (an AudioContext in the app, an
// OfflineAudioContext in dev/audio-check.html), and knows nothing about the game: audio.js turns
// the game into a plain snapshot each frame and into play(name, params) calls for one-shots.
//
//   bus.plate  ─ lowpass ─┐
//   bus.singer ─ lowpass ─┤
//   bus.bow, bus.drone  ──┼─ mix ─ hp 20 Hz ─ shelf ─ compressor ─┬─ limiter ─ soft clip ─ fade ─ mute ─ out
//   bus.room, bus.sfx   ──┤                                       │  (each dynamics stage trimmed to unity)
//   (sends) ─ verb ─ reverb                         bus.sub ──────┘
import { reverbIR, softClipCurve, BUFFER_JOBS, IR_SECONDS } from './dsp.js';
import { createPlate, createBow, createSingers, createRoom, createDrone, createFloor, createSand } from './voices.js';
import { createSfx, GAPS, PRIORITY, LEVELS } from './sfx.js';
import { createPhono } from './phono.js';
import { createKeeper } from './keeper.js';

const SEND = { plate: 0.34, singer: 0.55, bow: 0.16, drone: 0.3 };   // reverb sends per bus
const MAX_ONESHOTS = 24;

// opts.data: precomputed buffer data { rate, bufs: { name: [Float32Array...] }, ir: [L, R], irRate }
//   (audio.js prepares it in idle time); anything missing is generated here, on the spot.
// opts.deferIR: leave the reverb empty for now; the caller hands it over later with E.setIR().
export function createEngine(ctx, { destination = null, fadeIn = 1.5, seed = 7, data = null, deferIR = false } = {}) {
  const sr = ctx.sampleRate;
  const E = {
    ctx, sr,
    nodes: 0,          // live nodes created through the factories (rough CPU gauge)
    oneShots: 0,       // live one-shot voices
    muted: false,
    snap: null,        // last snapshot seen (for harnesses and meters)
    dark: 0, hold: 0,  // smoothed
    t: 0,
  };
  E.now = () => ctx.currentTime;

  // --- node factories (tracked) --------------------------------------------------------------
  const track = (n) => { E.nodes++; return n; };
  E.gain = (v = 0) => { const g = track(ctx.createGain()); g.gain.value = v; return g; };
  E.filt = (type, f, Q = 0.707) => {
    const b = track(ctx.createBiquadFilter());
    b.type = type; b.frequency.value = f; b.Q.value = Q;
    return b;
  };
  E.osc = (type, f, detune = 0) => {
    const o = track(ctx.createOscillator());
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.value = f;
    if (detune) o.detune.value = detune;
    return o;
  };
  E.src = (name, { loop = true, rate = 1 } = {}) => {
    const s = track(ctx.createBufferSource());
    s.buffer = E.buffer(name);
    s.loop = loop;
    s.playbackRate.value = rate;
    return s;
  };
  E.pan = (v = 0) => {
    if (!ctx.createStereoPanner) return E.gain(1);
    const p = track(ctx.createStereoPanner());
    p.pan.value = clampPan(v);
    return p;
  };
  // disconnect and forget a list of nodes (sources must already be stopped or stopping)
  E.free = (list) => {
    for (const n of list) {
      if (!n) continue;
      try { n.disconnect(); } catch { /* already */ }
      E.nodes--;
    }
  };
  // stop a running source safely
  E.stop = (s, at) => { try { s.stop(at); } catch { /* not started / already stopped */ } };
  // random loop offset for buffer sources (so two sources of the same buffer never phase-lock)
  E.offset = (name) => Math.random() * E.buffer(name).duration * 0.9;

  // --- buffers --------------------------------------------------------------------------------
  const toBuf = (chans, rate = sr) => {
    const b = ctx.createBuffer(chans.length, chans[0].length, rate);
    for (let c = 0; c < chans.length; c++) {
      if (b.copyToChannel) b.copyToChannel(chans[c], c); else b.getChannelData(c).set(chans[c]);
    }
    return b;
  };
  // Buffers are made on first use: from the data audio.js prepared in idle time when it is there
  // (possibly at another rate: playback resamples), otherwise generated on the spot.
  const JOBS = new Map(BUFFER_JOBS);
  const bufs = {};
  E.buffer = (name) => {
    let b = bufs[name];
    if (b) return b;
    const pre = data && data.bufs && data.bufs[name];
    const job = JOBS.get(name);
    if (pre) b = toBuf(pre, data.rate);
    else if (job) b = toBuf(job(sr, seed));
    else return E.buffer('white');
    return (bufs[name] = b);
  };

  // --- periodic waves (partial weights baked in, so a voice needs no per-partial gains) ---------
  const wave = (amps) => {
    const real = new Float32Array(amps.length), imag = new Float32Array(amps.length);
    for (let i = 0; i < amps.length; i++) imag[i] = amps[i];
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  };
  E.waves = {
    glass: wave([0, 1, 0.14, 0.045, 0.018]),         // glassy: almost sine, a whisper of octave
    glassSoft: wave([0, 0.6, 0.084, 0.027, 0.011]),  // the same, quieter (inner voices of a chord)
    metal: wave([0, 0.13, 0.043]),                    // plate partials at ×2.72 and ×5.44 of the mode
    strike: wave([0, 1, 0.33]),                       // the same pair at full strength (struck one-shots)
    warm: wave([0, 1, 0.42, 0.2, 0.1, 0.05, 0.025]),  // soft reed for chords
    bell: wave([0, 1, 0, 0.3, 0, 0.12]),              // odd partials: with an inharmonic partner it chimes
    bellSoft: wave([0, 0.6, 0, 0.18, 0, 0.072]),
    hum: wave([0, 1, 0.5, 0.3, 0.12]),                // the lamp's 100 Hz filament buzz
  };

  // --- master chain ---------------------------------------------------------------------------
  // DynamicsCompressorNode adds its own makeup gain (spec: fullRangeGain^-0.6), which would lift
  // everything below threshold. Each stage is followed by its exact inverse (measured for these
  // settings; dev/audio-check.html verifies the chain is unity at low level), so the compressor
  // only glues loud moments and the limiter only catches peaks near -4 dBFS. The floor's sub-bass
  // joins after the compressor (bus.sub), so it cannot make the plate pump.
  const out = destination || ctx.destination;
  const mix = E.gain(1);
  const hp = E.filt('highpass', 20, 0.707);          // subsonic / DC guard
  const shelf = E.filt('highshelf', 6500, 0.707);    // never shrill
  shelf.gain.value = -6;
  const comp = track(ctx.createDynamicsCompressor());
  comp.threshold.value = -16; comp.knee.value = 10; comp.ratio.value = 2.5;
  comp.attack.value = 0.012; comp.release.value = 0.3;
  const compTrim = E.gain(Math.pow(10, -3.99 / 20));
  const lim = track(ctx.createDynamicsCompressor());
  lim.threshold.value = -4; lim.knee.value = 0; lim.ratio.value = 20;
  lim.attack.value = 0.001; lim.release.value = 0.1;
  const limTrim = E.gain(Math.pow(10, -2.28 / 20) * 0.25);   // ×0.25: the soft-clip curve spans ±4
  const clip = track(ctx.createWaveShaper());
  clip.curve = softClipCurve(4097, 4, 0.7, 0.89);
  clip.oversample = 'none';
  const fade = E.gain(0);
  const mute = E.gain(1);
  mix.connect(hp); hp.connect(shelf); shelf.connect(comp); comp.connect(compTrim); compTrim.connect(lim);
  lim.connect(limTrim); limTrim.connect(clip); clip.connect(fade); fade.connect(mute); mute.connect(out);
  E.master = mix;
  E.compressor = comp;
  E.output = mute;                                   // tap point for meters / analysers

  // --- reverb ---------------------------------------------------------------------------------
  // the IR is already dark and high-passed (dsp.js), so the send goes straight in
  const verbIn = E.gain(0.9);
  const conv = track(ctx.createConvolver());
  conv.normalize = false;
  // a convolver needs its IR at the context's own rate
  E.setIR = (chans) => { try { conv.buffer = toBuf(chans, sr); } catch (e) { console.warn('[audio] reverb', e); } };
  if (!deferIR) E.setIR(data && data.ir && data.irRate === sr ? data.ir : reverbIR(sr, { seconds: IR_SECONDS, seed }));
  verbIn.connect(conv); conv.connect(mix);
  E.verb = verbIn;

  // --- buses ----------------------------------------------------------------------------------
  // plate and singers enter through their own lowpass (darkness closes them); bow and drone have a
  // reverb send; room tone and one-shots go straight to the mix (one-shots carry their own sends).
  E.bus = { room: mix, sfx: mix };
  E.busFilter = {};
  for (const name of Object.keys(SEND)) {
    let inp;
    if (name === 'plate' || name === 'singer') {
      inp = E.filt('lowpass', name === 'plate' ? 4500 : 5200, 0.6);
      E.busFilter[name] = inp;
    } else inp = E.gain(1);
    inp.connect(mix);
    const send = E.gain(SEND[name]);
    inp.connect(send); send.connect(verbIn);
    E.bus[name] = inp;
  }
  E.bus.sub = compTrim;                              // after the glue compressor, before the limiter

  // --- one-shot voice collector ----------------------------------------------------------------
  // const V = E.voice(t); ...build with V.osc / V.src / V.gain / V.filt / V.out...; V.done(end)
  // Every source starts at its own time and stops at `end` (or earlier via V.stopAt); when the last
  // one ends, all the voice's nodes are disconnected.
  E.trim = 1;                                        // level of the one-shot being built (sfx LEVELS)
  E.voice = (t) => {
    const nodes = [], sources = [], stops = [];
    const trim = E.trim;
    const V = {
      t, closed: false,
      add(n) { nodes.push(n); return n; },
      gain(v = 0) { return V.add(E.gain(v)); },
      filt(type, f, Q) { return V.add(E.filt(type, f, Q)); },
      osc(type, f, start = t, detune = 0) {
        const o = V.add(E.osc(type, f, detune));
        o.start(start); sources.push(o); stops.push(Infinity);
        return o;
      },
      src(name, start = t, opts = {}) {
        const s = V.add(E.src(name, opts));
        const off = opts.offset ?? (opts.loop === false ? 0 : E.offset(name));
        s.start(start, off); sources.push(s); stops.push(Infinity);
        return s;
      },
      stopAt(src, at) { const i = sources.indexOf(src); if (i >= 0) stops[i] = at; },
      // route to the sfx bus, optionally panned, with a reverb send
      out(node, pan = 0, verb = 0.3, dry = 1) {
        let tail = node;
        if (pan) { const p = V.add(E.pan(pan)); node.connect(p); tail = p; }
        dry *= trim; verb *= trim;
        if (dry > 0) {
          if (dry === 1) tail.connect(E.bus.sfx);
          else { const g = V.gain(dry); tail.connect(g); g.connect(E.bus.sfx); }
        }
        if (verb > 0) { const s = V.gain(verb); tail.connect(s); s.connect(E.verb); }
        return tail;
      },
      done(end) {
        if (V.closed) return;
        V.closed = true;
        if (!sources.length) { E.free(nodes); return; }
        let last = 0, lastAt = -1;
        for (let i = 0; i < sources.length; i++) {
          const at = Math.min(stops[i], end);
          E.stop(sources[i], at);
          if (at >= lastAt) { lastAt = at; last = i; }
        }
        E.oneShots++;
        let freed = false;
        sources[last].onended = () => {
          if (freed) return;
          freed = true;
          E.oneShots--;
          E.free(nodes);
        };
      },
    };
    building = V;
    return V;
  };
  let building = null;                               // the voice being built (freed if its synth throws)

  // envelopes: attack-decay (exponential tail); returns when it is ~-60 dB
  E.ad = (param, t, a, peak, tau, from = 0) => {
    param.setValueAtTime(from, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.setTargetAtTime(0, t + a, tau);
    return t + a + tau * 7;
  };
  // attack-hold-release
  E.ahr = (param, t, a, peak, hold, tau) => {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + a);
    param.setValueAtTime(peak, t + a + hold);
    param.setTargetAtTime(0, t + a + hold, tau);
    return t + a + hold + tau * 7;
  };

  // --- continuous voices --------------------------------------------------------------------
  const plate = createPlate(E);
  const bow = createBow(E);
  const singers = createSingers(E);
  const room = createRoom(E);
  const drone = createDrone(E);
  const floor = createFloor(E);
  const sand = createSand(E);
  const phono = createPhono(E);
  const keeper = createKeeper(E);
  E.voices = { plate, bow, singers, room, drone, floor, sand, phono, keeper };
  const sfx = createSfx(E);
  E.sfx = sfx;

  // --- public ---------------------------------------------------------------------------------
  E.start = (fadeSeconds = fadeIn, at = ctx.currentTime, withRoom = true) => {
    const g = fade.gain;
    g.cancelScheduledValues(at);
    g.setValueAtTime(g.value, at);
    if (fadeSeconds > 0) g.setTargetAtTime(1, at, fadeSeconds / 3.5); else g.setValueAtTime(1, at);
    if (withRoom) room.start(at);
  };
  // fade the whole mix (tab hidden etc.)
  E.fadeTo = (v, tau = 0.15, at = ctx.currentTime) => fade.gain.setTargetAtTime(v, at, tau);
  E.setMuted = (m, at = ctx.currentTime) => {
    E.muted = !!m;
    mute.gain.setTargetAtTime(E.muted ? 0 : 1, at, 0.06);
  };

  // per-frame: the snapshot (see audio.js makeSnapshot) drives every continuous voice
  E.frame = (snap, dt, at = ctx.currentTime) => {
    E.snap = snap;
    dt = dt > 0 ? Math.min(dt, 0.1) : 0;
    E.t += dt;
    E.dark += ((snap.dark > 0.5 ? 1 : 0) - E.dark) * (1 - Math.exp(-dt / 1.1));
    E.hold += ((snap.hold ? 1 : 0) - E.hold) * (1 - Math.exp(-dt / 0.6));
    // the plate brightens as it swells; darkness softens the highs and enlarges the room
    const swell = snap.total > 0 ? Math.min(1, snap.total) : 0;
    if (E.busFilter.plate) setT(E.busFilter.plate.frequency, (2600 + 2400 * swell) * (1 - 0.3 * E.dark), at, 0.3, 'plateLp');
    if (E.busFilter.singer) setT(E.busFilter.singer.frequency, 5200 - 2600 * E.dark, at, 0.3, 'singLp');
    setT(E.verb.gain, 0.9 + 0.35 * E.dark + 0.25 * (snap.choir || 0), at, 0.4, 'verb');
    plate.update(snap, dt, at);
    bow.update(snap, dt, at);
    singers.update(snap, dt, at);
    room.update(snap, dt, at);
    drone.update(snap, dt, at);
    floor.update(snap, dt, at);
    sand.update(snap, dt, at);
    phono.update(snap, dt, at);
    keeper.update(snap, dt, at);
  };

  // one-shots: name -> synth; returns false when dropped (unknown, throttled or over budget)
  const lastPlay = Object.create(null);
  E.play = (name, p = {}, when = null) => {
    const fn = sfx[name];
    if (typeof fn !== 'function') return false;
    const now = ctx.currentTime;
    const t = when ?? now + 0.012;
    const gap = GAPS[name] ?? 0.03;
    if (when === null && lastPlay[name] !== undefined && now - lastPlay[name] < gap) return false;
    const pri = PRIORITY[name] ?? 1;
    if (E.oneShots >= MAX_ONESHOTS * (pri >= 2 ? 1.25 : pri >= 1 ? 1 : 0.6)) return false;
    lastPlay[name] = now;
    E.trim = Math.pow(10, (LEVELS[name] || 0) / 20);
    building = null;
    try { fn(p, t); } catch (e) {
      console.warn('[audio] sfx failed', name, e);
      if (building && !building.closed) building.done(ctx.currentTime);
      return false;
    } finally { E.trim = 1; }
    return true;
  };
  // pouring sand is a stream of events, not a one-shot
  E.pour = (n, pan) => sand.pour(n, pan);
  E.bowOnset = (s = 1) => bow.onset(s);

  // smoothed param set that skips redundant automation events
  const lastSet = Object.create(null);
  function setT(param, v, at, tau, key) {
    const prev = lastSet[key];
    if (prev !== undefined && Math.abs(prev - v) <= Math.abs(v) * 0.002 + 1e-5) return;
    lastSet[key] = v;
    param.setTargetAtTime(v, at, tau);
  }
  E.setT = setT;

  return E;
}

function clampPan(v) { return v > 1 ? 1 : v < -1 ? -1 : (v || 0); }
export { clampPan };
