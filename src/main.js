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

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const vw = window.innerWidth, vh = window.innerHeight;
  game.view = computeView(vw, vh, dpr);
  for (const c of [glCanvas, fxCanvas]) {
    c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr);
    c.style.width = vw + 'px'; c.style.height = vh + 'px';
  }
  game.gfx?.resize?.();
  bus.emit('resize', game.view);
}

function save() {
  const s = game.state;
  try {
    s.sand = game.sand.serialize();
    s.life = game.life?.serialize?.() ?? null;
    s.plate.wear = b64(game.wear);
    s.lastVisit = Date.now();
    saveState(s);
  } catch (e) { console.warn('save failed', e); }
}

function boot() {
  resize();
  const loaded = loadState();
  game.state = loaded || newState();
  const s = game.state;
  const away = loaded ? (Date.now() - (s.lastVisit || Date.now())) / 1000 : 0;
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

  if (loaded && away > 600 && game.life.simulateOffline) {
    const notes = game.life.simulateOffline(Math.min(away, 3 * 3600)) || [];
    s.seen.awayNotes = notes;
    for (const n of notes) bus.emit('log', { kind: 'away', text: n.text, data: n });
  }

  // input
  const pos = (e) => ({ x: e.clientX, y: e.clientY });
  fxCanvas.addEventListener('pointerdown', (e) => {
    if (!game.started) start();
    const p = pos(e);
    if (game.tools.pointerDown(p.x, p.y, e)) {
      try { fxCanvas.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    }
  });
  fxCanvas.addEventListener('pointermove', (e) => {
    const p = pos(e);
    game.tools.pointerMove(p.x, p.y, e);
    fxCanvas.style.cursor = game.tools.cursor?.(p.x, p.y) || 'default';
  });
  const up = (e) => { const p = pos(e); game.tools.pointerUp(p.x, p.y, e); };
  fxCanvas.addEventListener('pointerup', up);
  fxCanvas.addEventListener('pointercancel', up);
  fxCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('keydown', (e) => { if (!game.started) start(); game.tools.key?.(e); });

  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
  window.addEventListener('pagehide', save);

  if (game.debug) {
    window.__sp = game;
    // test hook: run the simulation forward synchronously (no rendering)
    game.advance = (sec, h = 1 / 30) => {
      const n = Math.round(sec / h);
      for (let i = 0; i < n; i++) { game.t += h; stepLight(h); update(h); }
      render();
      return n;
    };
  }
  requestAnimationFrame(frame);
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
  try { update(dt); } catch (e) { reportOnce('update', e); }
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

function update(dt) {
  const steps = Math.ceil(dt / (1 / 30));
  const h = dt / steps;
  game.tools.update(dt);
  for (let i = 0; i < steps; i++) {
    game.field.setSource('chorus', game.life.chorus?.() || []);
    game.field.update(h);
    game.sand.update(h);
    game.life.update(h);
  }
  game.progress.update(dt);
  game.audio.update?.(dt);
  game.journal.update?.(dt);
}

function render() {
  game.gfx.render();
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
