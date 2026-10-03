// Boot, loop, wiring.
import { bus } from './core/bus.js';
import { makeRng } from './core/rng.js';
import { computeView } from './core/view.js';
import { loadState, saveState, clearState, newState } from './core/persist.js';
import { createProgress } from './core/progress.js';
import { createField } from './sim/field.js';
import { createSand, b64, unb64 } from './sim/sand.js';
import { createLife } from './sim/life.js';
import { createRenderer } from './render/gl.js';
import { createAudio } from './audio/audio.js';
import { createTools } from './ui/tools.js';
import { createJournal } from './ui/journal.js';

const params = new URLSearchParams(location.search);
if (params.has('fresh')) clearState();

const glCanvas = document.getElementById('gl');
const fxCanvas = document.getElementById('fx');
const uiRoot = document.getElementById('ui');
const fxCtx = fxCanvas.getContext('2d');

const WEAR = 128;

const game = {
  t: 0, dt: 0,
  rng: makeRng((Date.now() ^ (Math.random() * 1e9)) >>> 0),
  bus,
  debug: params.has('debug'),
  view: null,
  light: { on: true, level: 0, flicker: 0, boot: 0 },
  fx: { choir: 0, floor: 0, shake: 0, flash: 0 },
  state: null,
  field: null, sand: null, life: null,
  gfx: null, audio: null, tools: null, journal: null, progress: null,
  hold: null,
  wear: new Uint8Array(WEAR * WEAR), WEAR, wearVersion: 0,
  started: false,
  save,
};

// safe-area insets (notch, home indicator) read through CSS
const insetProbe = document.createElement('div');
insetProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;inset:0;' +
  'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
document.body.appendChild(insetProbe);
function readInsets() {
  const cs = getComputedStyle(insetProbe);
  return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0,
    b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
}

let lastSize = '';
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vw = window.innerWidth, vh = window.innerHeight;
  const ins = readInsets();
  const sig = `${vw}x${vh}@${dpr}|${ins.t},${ins.r},${ins.b},${ins.l}`;
  if (sig === lastSize && game.view) return;
  lastSize = sig;
  game.view = computeView(vw, vh, dpr, ins);
  for (const c of [glCanvas, fxCanvas]) {
    const w = Math.round(vw * dpr), h = Math.round(vh * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    c.style.width = vw + 'px'; c.style.height = vh + 'px';
  }
  game.gfx?.resize?.();
  bus.emit('resize', game.view);
}
// coalesce bursts of resize events (dragging a window edge) into one layout per frame
let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
}
// a change of devicePixelRatio alone (moving the window to another screen) fires no resize
function watchDpr() {
  try {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', () => { queueResize(); watchDpr(); }, { once: true });
  } catch {}
}

let readOnly = false;          // another tab has the plate now: stop writing over it
function save() {
  if (readOnly) return;
  const s = game.state;
  try {
    s.sand = game.sand.serialize();
    s.life = game.life?.serialize?.() ?? null;
    s.plate.wear = b64(game.wear);
    s.light = { on: !!game.light.on };
    s.lastVisit = Date.now();
    saveState(s);
  } catch (e) { console.warn('save failed', e); }
}

function catchUp(seconds) {
  if (!(seconds > 600) || !game.life?.simulateOffline) return;
  const notes = game.life.simulateOffline(Math.min(seconds, 3 * 3600)) || [];
  game.state.seen.awayNotes = notes;
  for (const n of notes) bus.emit('log', { kind: 'away', text: n.text, data: n });
}

function boot() {
  resize();
  watchDpr();
  let loaded = loadState();
  try { buildWorld(loaded); } catch (e) {
    // a save that cannot be brought back to life: keep it aside and begin on a fresh plate
    console.warn('could not restore the saved plate; starting fresh', e);
    try { localStorage.setItem('stillpoint.v1.unreadable', JSON.stringify(loaded)); } catch {}
    clearState();
    loaded = null;
    buildWorld(null);
  }
  const s = game.state;
  const away = loaded ? (Date.now() - (s.lastVisit || Date.now())) / 1000 : 0;
  if (loaded && s.light?.on === false) { game.light.on = false; game.light.boot = 3; game.light.level = 0; }
  catchUp(away);
  wireInput();
  if (game.debug) installDebug();
  requestAnimationFrame(frame);
}

function buildWorld(loaded) {
  game.state = loaded || newState();
  const s = game.state;
  s.visits = (s.visits || 0) + 1;

  game.field = createField({ state: s, bus, rng: game.rng });
  game.sand = createSand(game.field, { state: s, bus });
  if (s.sand) game.sand.deserialize(s.sand); else game.sand.seedScatter(20000);
  if (s.plate.wear) { try { game.wear.set(unb64(s.plate.wear).subarray(0, WEAR * WEAR)); } catch {} }

  game.life = createLife(game);
  if (s.life) game.life.deserialize?.(s.life);

  game.gfx = createRenderer(glCanvas, game);
  game.audio = createAudio(game);
  game.tools = createTools(game);
  game.journal = createJournal(game, uiRoot);
  game.progress = createProgress(game);
}

function wireInput() {
  const pos = (e) => ({ x: e.clientX, y: e.clientY });
  const setCursor = (x, y) => { fxCanvas.style.cursor = game.tools.cursor?.(x, y) || 'default'; };
  fxCanvas.addEventListener('pointerdown', (e) => {
    if (!game.started) start();
    const p = pos(e);
    if (game.tools.pointerDown(p.x, p.y, e)) {
      try { fxCanvas.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    }
    setCursor(p.x, p.y);
  });
  fxCanvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    game.tools.pointerMove(p.x, p.y, e);
    setCursor(p.x, p.y);
  });
  const up = (e) => { const p = pos(e); game.tools.pointerUp(p.x, p.y, e); setCursor(p.x, p.y); };
  fxCanvas.addEventListener('pointerup', up);
  fxCanvas.addEventListener('pointercancel', up);
  // a release the page never saw (focus stolen mid-drag): the browser drops capture; treat it as a cancel
  fxCanvas.addEventListener('lostpointercapture', up);
  fxCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => { if (!game.started) start(); game.tools.key?.(e); });
  bus.on('journal:close', () => { const pt = game.tools.lastPointer?.(); if (pt) setCursor(pt.x, pt.y); else fxCanvas.style.cursor = 'default'; });

  window.addEventListener('resize', queueResize);
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); save(); return; }
    // back from a long absence in a background tab: let the time pass on the plate too
    if (hiddenAt) { const away = (Date.now() - hiddenAt) / 1000; hiddenAt = 0; catchUp(away); last = performance.now(); }
  });
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    catchUp((Date.now() - (game.state.lastVisit || Date.now())) / 1000);
    last = performance.now();
  });
  window.addEventListener('pagehide', save);
  // two tabs on one plate would overwrite each other: the older one steps aside
  window.addEventListener('storage', (e) => { if (e.key === 'stillpoint.v1' && e.newValue) readOnly = true; });
}

function installDebug() {
  window.__sp = game;
  // test hook: run the simulation forward synchronously (no rendering)
  game.advance = (sec, h = 1 / 30) => {
    const n = Math.round(sec / h);
    for (let i = 0; i < n; i++) { game.t += h; stepLight(h); update(h); }
    render();
    return n;
  };
}

function start() {
  if (game.started) return;
  game.started = true;
  bus.emit('start', {});
}

let last = performance.now();
let saveAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  last = now;
  if (!(dt > 0)) dt = 1 / 60;
  dt = Math.min(dt, 1 / 20);
  game.dt = dt;
  game.t += dt;
  stepLight(dt);
  update(dt);
  try { render(); } catch (e) { reportOnce('render', e); }
  saveAcc += dt;
  if (saveAcc > 15) { saveAcc = 0; save(); }
}

function stepLight(dt) {
  const L = game.light;
  // boot: tungsten flicker on
  if (L.boot < 3) {
    L.boot += dt;
    const b = L.boot;
    let lv = 0;
    if (b > 0.5) lv = 0.25 + 0.2 * Math.sin(b * 31);
    if (b > 0.75) lv = 0.05;
    if (b > 0.95) lv = 0.6;
    if (b > 1.1) lv = 0.3;
    if (b > 1.25) lv = Math.min(1, 0.55 + (b - 1.25) * 0.5);
    L.level = L.on ? lv : 0;
    return;
  }
  const target = L.on ? 1 : 0;
  L.level += (target - L.level) * Math.min(1, dt * (L.on ? 2.2 : 3.5));
  L.flicker *= Math.exp(-dt * 3);
}

// each subsystem is guarded on its own, so one failing part cannot silence the others
function guard(name, fn) {
  try { fn(); } catch (e) { reportOnce(name, e); }
}

function update(dt) {
  const steps = Math.ceil(dt / (1 / 30));
  const h = dt / steps;
  guard('tools', () => game.tools.update(dt));
  for (let i = 0; i < steps; i++) {
    guard('sim', () => {
      game.field.setSource('chorus', game.life.chorus?.() || []);
      game.field.update(h);
      game.sand.update(h);
    });
    guard('life', () => game.life.update(h));
  }
  guard('progress', () => game.progress.update(dt));
  guard('audio', () => game.audio.update?.(dt));
  guard('journal', () => game.journal.update?.(dt));
}

let frameNo = 0;
function render() {
  // behind the open notebook the scene only needs to breathe, not to be smooth
  if (!game.journal?.isOpen || (frameNo++ & 1) === 0) game.gfx.render();
  const { dpr, vw, vh } = game.view;
  fxCtx.setTransform(1, 0, 0, 1, 0, 0);
  fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
  fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  game.tools.render(fxCtx, vw, vh);
}

const reported = new Set();
function reportOnce(where, e) {
  const key = where + (e?.message || '');
  if (reported.has(key)) return;
  reported.add(key);
  console.error(`[${where}]`, e);
}

boot();
