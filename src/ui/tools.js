// The overlay: every object on the felt and every touch of the hand.
// The bow (always), the plate under the fingertip (tap / resting finger), the sand jar, the
// notebook, the pull-cord, the cabinet drawer with its felt dampers and tuning forks, the
// phonograph case, and a rare moth. All drawn procedurally on the 2D overlay canvas (CSS px; main
// sets the dpr transform), lit by the same lamp the renderer uses.
import { MODES, evalMode } from '../sim/modes.js';
import { clamp, smooth, createLamp, loadFonts, bake, bakeShadow, blit, toPlateInto, toScreenInto } from './tools-art.js';
import { createBow } from './tools-bow.js';
import { createJar, createBook, createCord, createCabinet } from './tools-objects.js';
import { createPhonograph } from './tools-phono.js';
import { createMoth } from './tools-moth.js';

const TAP_MS = 220, TAP_PX = 6;          // a click on the plate
const HOLD_S = 1.2, HOLD_PX = 5;         // the resting finger
const SNAP_PX = 18;                      // a drag that starts this close to an edge grabs the bow
const FADE_S = 3;                        // eyes adjusting to the dark
const DUST_N = 240;
const RING_N = 6;
const LOW_MODES = MODES.filter((m) => !m.special && m.k <= 26);

export function createTools(game) {
  const { bus } = game;
  const params = new URLSearchParams(location.search);
  let reduced = false;
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced = !!mq.matches;
    mq.addEventListener?.('change', (e) => { reduced = e.matches; env.reduced = reduced; });
  } catch { /* old browsers */ }

  game.state.tools ||= {};
  const saved = game.state.tools;

  const lamp = createLamp(game);
  const bowPub = { held: false, bowing: false, edge: null, t: 0.5, speed01: 0, mode: null, x: 0, y: 0, angle: 0 };

  // ---- reveals (fade in over ~3 s) ----------------------------------------------------------------
  const KEYS = ['jar', 'journal', 'drawer', 'dampers', 'forks', 'phonograph', 'cord'];
  const shown = { jar: 0, journal: 0, drawer: 0, dampers: 0, forks: 0, phonograph: 0, cord: 0 };
  const want = { jar: false, journal: false, drawer: false, dampers: false, forks: false, phonograph: false, cord: false };
  const alphaOf = (w) => { const a = shown[w] || 0; return a * a * (3 - 2 * a); };
  const isOn = (w) => !!want[w] && shown[w] > 0.3;

  // ---- dust (rosin puffs, sand splashes) -----------------------------------------------------------
  const dx = new Float32Array(DUST_N), dy = new Float32Array(DUST_N), dvx = new Float32Array(DUST_N), dvy = new Float32Array(DUST_N);
  const dl = new Float32Array(DUST_N), dl0 = new Float32Array(DUST_N), ds = new Float32Array(DUST_N), dk = new Uint8Array(DUST_N);
  let dustHead = 0;
  let dot = null;                        // soft dust sprite (baked lazily, dropped on resize)
  function dust(x, y, vx, vy, life, size, kind = 0) {
    const i = dustHead; dustHead = (dustHead + 1) % DUST_N;
    dx[i] = x; dy[i] = y; dvx[i] = vx; dvy[i] = vy; dl[i] = dl0[i] = life; ds[i] = size; dk[i] = kind;
  }

  // bus helper. Payloads of the per-frame events (bow:move, sand:pour) are reused objects; all
  // others are fresh, so listeners may keep them
  const emit = (type, payload) => { try { bus.emit(type, payload); } catch (e) { console.error(e); } };

  // ---- dampers in the field (felt discs + a landed moth) ----------------------------------------
  const damperList = [];
  let damperSrc = null, mothRef = null;
  function syncDampers() {
    damperList.length = 0;
    if (damperSrc) damperSrc(damperList);
    if (mothRef && mothRef.landed) damperList.push(mothRef.fd);
    if (game.field) game.field.dampers = damperList;
  }

  const env = {
    game, lamp, emit, dust, reduced, publicBow: bowPub, alphaOf, isOn, syncDampers, saved,
    plateHit: (x, y, m = 0) => {
      const p = game.view.plate;
      return x >= p.x - m && x <= p.x + p.size + m && y >= p.y - m && y <= p.y + p.size + m;
    },
    panOf: (x) => clamp((x / Math.max(1, game.view.vw)) * 2 - 1, -1, 1) * 0.8,
  };

  // the cord is there from the start, faint; once a hand has found it, it stays found
  env.foundCord = () => { if (!want.cord) { want.cord = true; saved.cordFound = true; } };
  if (saved.cordFound) { want.cord = true; shown.cord = 1; }

  const bow = createBow(env);
  env.bowRest = () => ({ x: bow.rest.x, y: bow.rest.y, a: bow.rest.a, L: bow.L });
  const jar = createJar(env);
  const book = createBook(env);
  const cord = createCord(env);
  const cabinet = createCabinet(env);
  const phono = createPhonograph(env);
  const moth = createMoth(env, params.has('moth'));
  damperSrc = cabinet.collectDampers;
  mothRef = moth.pub;

  // ---- pointers -------------------------------------------------------------------------------------
  const ptrs = new Map();
  const plist = [];                       // the same pointers, for allocation-free loops
  const pool = [];
  const uvs = { u: 0, v: 0 }, xys = { x: 0, y: 0 };
  const getPtr = (e) => {
    const id = e && Number.isFinite(e.pointerId) ? e.pointerId : 1;
    let p = ptrs.get(id);
    if (!p) {
      p = pool.pop() || { id: 0, x: 0, y: 0, x0: 0, y0: 0, t0: 0, type: 'mouse', kind: null, moved: false, sx: 0, sy: 0, st: 0, hold: false, spd: 0, target: null };
      p.id = id; ptrs.set(id, p); plist.push(p);
    }
    return p;
  };
  const freePtr = (p) => { ptrs.delete(p.id); const i = plist.indexOf(p); if (i >= 0) plist.splice(i, 1); p.kind = null; p.target = null; pool.push(p); };
  let hoverX = -1, hoverY = -1;

  // ---- the resting finger and taps -----------------------------------------------------------------
  const holdObj = { u: 0, v: 0, t: 0 };
  let holdPtr = null, holdVis = 0, holdX = 0, holdY = 0, holdPend = 0;
  const rings = [];
  for (let i = 0; i < RING_N; i++) rings.push({ x: 0, y: 0, t: 9, s: 1 });
  let ringHead = 0;
  const tapComps = [{ mode: null, amp: 0 }, { mode: null, amp: 0 }, { mode: null, amp: 0 }];
  const best = [null, null, null], bestS = [0, 0, 0];

  function tap(x, y, e) {
    const { u, v } = game.view.toPlate(x, y);
    // modes that move most at the tap point (low ones ring longest)
    bestS[0] = bestS[1] = bestS[2] = -1; best[0] = best[1] = best[2] = null;
    for (let i = 0; i < LOW_MODES.length; i++) {
      const m = LOW_MODES[i];
      const sc = Math.abs(evalMode(m, u, v)) * Math.exp(-m.k / 22);
      if (sc > bestS[2]) {
        if (sc > bestS[0]) { bestS[2] = bestS[1]; best[2] = best[1]; bestS[1] = bestS[0]; best[1] = best[0]; bestS[0] = sc; best[0] = m; }
        else if (sc > bestS[1]) { bestS[2] = bestS[1]; best[2] = best[1]; bestS[1] = sc; best[1] = m; }
        else { bestS[2] = sc; best[2] = m; }
      }
    }
    const pr = e && e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    const strength = clamp(0.62 + (pr - 0.5) * 0.5 + (Math.random() - 0.5) * 0.12, 0.35, 1);
    const shares = [0.55, 0.36, 0.24];
    let n = 0;
    for (let i = 0; i < 3; i++) {
      if (!best[i]) continue;
      const mag = Math.abs(evalMode(best[i], u, v));
      tapComps[n].mode = best[i].id; tapComps[n].amp = strength * shares[i] * (0.45 + 0.55 * mag); n++;
    }
    for (let i = n; i < 3; i++) { tapComps[i].mode = null; tapComps[i].amp = 0; }
    game.field?.impulse?.(tapComps, 0.75);
    game.sand?.scatter?.(u, v, strength * 0.85);
    emit('plate:tap', { u, v, strength });
    const r = rings[ringHead]; ringHead = (ringHead + 1) % RING_N;
    r.x = x; r.y = y; r.t = 0; r.s = strength;
    moth.disturb(u, v, 0.35);
    // no hover on a touch screen: a tap on a singer shows its name for a moment
    if (e && e.pointerType === 'touch') { hoverLabel(x, y); if (label.target > 0) labelHold = 2.6; }
  }

  function setHold(p) {
    const { u, v } = game.view.toPlate(p.x, p.y);
    holdObj.u = clamp(u, -0.98, 0.98); holdObj.v = clamp(v, -0.98, 0.98); holdObj.t = game.t;
    game.hold = holdObj; holdPtr = p; p.hold = true; p.spd = 0;
  }
  function clearHold() { if (game.hold === holdObj) game.hold = null; if (holdPtr) holdPtr.hold = false; holdPtr = null; }

  // ---- hover label (a singer's name, in pencil) ----------------------------------------------------
  const label = { mote: null, a: 0, target: 0, text: '', x: 0, y: 0 };
  let labelHold = 0;
  let labelFont = '15px Caveat';
  function nameOf(m) {
    const life = game.life;
    const sp = life?.speciesOf?.(m) || life?.species?.[m.sp] || null;
    return sp?.name || game.state.species?.[m.sp]?.name || '';
  }
  function hoverLabel(x, y) {
    if (!isOn('journal') || !game.life?.moteAt) { label.target = 0; return; }
    toPlateInto(game.view, x, y, uvs);
    if (Math.abs(uvs.u) > 1.08 || Math.abs(uvs.v) > 1.08) { label.target = 0; return; }
    const m = game.life.moteAt(uvs.u, uvs.v, 0.08);
    if (m && !m.dead) {
      if (m !== label.mote) { const t = nameOf(m); if (t) { label.mote = m; label.text = t; if (label.a < 0.05) label.a = 0; } }
      label.target = label.text ? 1 : 0;
    } else label.target = 0;
  }

  // ---- layout ----------------------------------------------------------------------------------------
  let lastView = null;
  let fingerSh = null, fingerRing = null;
  function bakeFinger(S, dpr) {
    // a fingertip's soft shadow (an oval, blurred) and a soft ring of stillness
    const fw = clamp(S * 0.03, 11, 20), fh = fw * 1.35;
    const tip = bake(fw * 2.4, fh * 2.4, fw * 1.2, fh * 1.2, dpr, (g) => {
      g.fillStyle = '#000'; g.beginPath(); g.ellipse(0, 0, fh * 0.5, fw * 0.5, 0, 0, Math.PI * 2); g.fill();
    });
    fingerSh = bakeShadow(tip, fw * 0.45);
    const R = 0.07 * S * 0.5, E = R * 1.6;      // the singers nestle at radius .07
    fingerRing = bake(E * 2, E * 2, E, E, dpr, (g) => {
      const rg = g.createRadialGradient(0, 0, R * 0.55, 0, 0, E);
      rg.addColorStop(0, 'rgba(255,220,160,0)'); rg.addColorStop(0.5, 'rgba(255,220,160,0.55)');
      rg.addColorStop(0.62, 'rgba(255,214,150,0.35)'); rg.addColorStop(1, 'rgba(255,210,150,0)');
      g.fillStyle = rg; g.fillRect(-E, -E, E * 2, E * 2);
    });
  }
  function layout() {
    if (!game.view?.plate) return;
    lastView = game.view;
    lamp.layout();
    const S = game.view.plate.size;
    bakeFinger(S, game.view.dpr || 1);
    labelFont = `${Math.round(clamp(S * 0.028, 14, 19))}px Caveat, 'Segoe Print', cursive`;
    dot = null;
    bow.layout(); jar.layout(); book.layout(); cord.layout(); cabinet.layout(); phono.layout(); moth.layout();
  }
  layout();
  bus.on?.('resize', () => layout());
  loadFonts().then(() => cabinet.layout());   // the engraved numbers need their face
  // restore persisted dampers
  syncDampers();

  // ---- routing -------------------------------------------------------------------------------------
  function edgeNear(x, y, px) {
    const p = game.view.plate;
    const inX = x >= p.x - px && x <= p.x + p.size + px, inY = y >= p.y - px && y <= p.y + p.size + px;
    if (!inX || !inY) return false;
    return Math.abs(x - p.x) <= px || Math.abs(x - p.x - p.size) <= px || Math.abs(y - p.y) <= px || Math.abs(y - p.y - p.size) <= px;
  }

  function pointerDown(x, y, e) {
    if (!game.view) return false;
    if (game.journal?.isOpen) return false;
    const p = getPtr(e);
    const touch = e && e.pointerType === 'touch';
    p.x = p.x0 = p.sx = x; p.y = p.y0 = p.sy = y; p.t0 = p.st = performance.now(); p.target = null;
    p.type = (e && e.pointerType) || 'mouse'; p.moved = false; p.hold = false; p.kind = null;
    if (e && e.button > 0) { freePtr(p); return false; }

    // the open tray is on top of everything; a press outside it closes it, except on a damper
    // already on the plate (the hand is arranging them, the drawer stays open)
    if (cabinet.userOpen) {
      if (!cabinet.inTray(x, y)) {
        const pk = cabinet.downPlateDamper(p, x, y, touch);
        if (pk) { p.kind = pk; return true; }
      }
      const k = cabinet.down(p, x, y, touch);
      if (k) { p.kind = k; return true; }
    }
    if (moth.hit(x, y, touch)) { moth.startle(); p.kind = 'none'; return true; }
    const dk = cabinet.downPlateDamper(p, x, y, touch);
    if (dk) { p.kind = dk; return true; }
    if (isOn('jar') && jar.heldBy < 0 && jar.hit(x, y, touch)) { jar.pickUp(p.id, x, y); p.kind = 'jar'; return true; }
    if (cord.hit(x, y, touch) && cord.heldBy < 0) { cord.pickUp(p.id, x, y); p.kind = 'cord'; return true; }
    if (bow.heldBy < 0 && bow.hit(x, y, touch)) { bow.pickUp(p.id, x, y, false); p.kind = 'bow'; return true; }
    if (isOn('phonograph')) { const ph = phono.hit(x, y, touch); if (ph) { p.kind = 'phono'; p.target = ph; phono.press(ph); return true; } }
    if (isOn('journal') && book.hit(x, y, touch)) { p.kind = 'book'; book.press(true); return true; }
    if (isOn('drawer') && cabinet.hitFront(x, y, touch)) { p.kind = 'front'; return true; }
    if (bow.heldBy < 0 && edgeNear(x, y, touch ? SNAP_PX * 1.4 : SNAP_PX)) { bow.pickUp(p.id, x, y, true); p.kind = 'bow'; return true; }
    if (env.plateHit(x, y)) { p.kind = 'press'; return true; }
    freePtr(p);
    return false;
  }

  function pointerMove(x, y, e) {
    if (!game.view) return;
    const id = e && Number.isFinite(e.pointerId) ? e.pointerId : 1;
    const p = ptrs.get(id);
    if (!p) {
      // hover
      const t = (e && e.pointerType) || 'mouse';
      if (t === 'mouse' || t === 'pen') {
        const ox = hoverX, oy = hoverY;
        hoverX = x; hoverY = y;
        if (ox >= 0) cord.brush(ox, oy, x, y);
        hoverLabel(x, y);
        book.hover(isOn('journal') && book.hit(x, y, false));
        cabinet.hover(x, y);
      }
      return;
    }
    p.x = x; p.y = y;
    const dist = Math.hypot(x - p.x0, y - p.y0);
    if (dist > TAP_PX) p.moved = true;
    switch (p.kind) {
      case 'press':
        if (!p.hold) {
          if (Math.hypot(x - p.sx, y - p.sy) > HOLD_PX) { p.sx = x; p.sy = y; p.st = performance.now(); }
          // dragging off the plate's interior onto an edge picks the bow up there
          if (p.moved && bow.heldBy < 0 && edgeNear(x, y, SNAP_PX * 0.8)) { bow.pickUp(p.id, x, y, true); p.kind = 'bow'; }
        }
        break;
      case 'bow': bow.samples(e, x, y); break;         // the bow reads the pointer in update, plus its path
      case 'jar': case 'cord': break;                  // they read the pointer in update
      case 'book': if (p.moved) { book.press(false); p.kind = 'none'; } break;
      case 'phono': if (p.moved) { phono.release(); p.kind = 'none'; } break;
      case 'front': break;
      default: cabinet.move(p, x, y); break;
    }
  }

  function pointerUp(x, y, e) {
    const id = e && Number.isFinite(e.pointerId) ? e.pointerId : 1;
    const p = ptrs.get(id);
    if (!p) return false;
    if (Number.isFinite(x)) { p.x = x; p.y = y; }
    const cancel = e && e.type === 'pointercancel';
    const dur = performance.now() - p.t0;
    switch (p.kind) {
      case 'press':
        if (p.hold) clearHold();
        else if (!cancel && !p.moved && dur < TAP_MS && env.plateHit(p.x, p.y)) tap(p.x, p.y, e);
        break;
      case 'bow': bow.drop(); break;
      case 'jar': jar.drop(); break;
      case 'cord': cord.release(cancel ? NaN : p.x, p.y); break;
      case 'book':
        book.press(false);
        if (!cancel && !p.moved && book.hit(p.x, p.y, true)) { try { game.journal?.open?.(); } catch (err) { console.error(err); } }
        break;
      case 'front':
        if (!cancel && !p.moved && cabinet.hitFront(p.x, p.y, true)) cabinet.toggle();
        break;
      case 'phono':
        if (!cancel && !p.moved && phono.hit(p.x, p.y, true) === p.target) phono.click(p.target);
        else phono.release();
        break;
      case 'none': break;
      default: cabinet.up(p, p.x, p.y, cancel, dur); break;
    }
    freePtr(p);
    return true;
  }

  function cursor(x, y) {
    for (let i = 0; i < plist.length; i++) {
      const k = plist[i].kind;
      if (k && k !== 'press' && k !== 'none' && k !== 'book' && k !== 'front' && k !== 'phono') return 'grabbing';
    }
    if (!game.view) return 'default';
    if (cabinet.userOpen) { const c = cabinet.cursor(x, y); if (c) return c; }
    if (cabinet.plateDamperAt(x, y)) return 'grab';
    if (isOn('jar') && jar.hit(x, y, false)) return 'grab';
    if (cord.hit(x, y, false)) return 'grab';
    if (bow.hit(x, y, false)) return 'grab';
    if (isOn('phonograph') && phono.hit(x, y, false)) return 'pointer';
    if (isOn('journal') && book.hit(x, y, false)) return 'pointer';
    if (isOn('drawer') && cabinet.hitFront(x, y, false)) return 'pointer';
    if (edgeNear(x, y, SNAP_PX)) return 'grab';
    return 'default';
  }

  function key(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
    const tg = e.target;
    if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 'm') {
      const a = game.audio;
      if (a?.toggleMute) a.toggleMute();
      else if (a?.setMuted) a.setMuted(!a.muted);
    }
    else if (k === 'escape' && cabinet.userOpen && !game.journal?.isOpen) cabinet.toggle(false);
  }

  function reveal(what, instant = false) {
    if (!(what in want)) return;
    want[what] = true;
    if (instant) shown[what] = 1;
    if (what === 'drawer' || what === 'dampers' || what === 'forks') cabinet.layout();
  }

  // ---- update ----------------------------------------------------------------------------------------
  function ptrFor(id) { return id >= 0 ? ptrs.get(id) || null : null; }

  function update(dt) {
    if (!game.view?.plate) return;
    if (game.view !== lastView) layout();
    dt = dt > 0 ? Math.min(dt, 0.05) : 0;
    lamp.update();
    for (let i = 0; i < KEYS.length; i++) { const w = KEYS[i]; if (want[w] && shown[w] < 1) shown[w] = Math.min(1, shown[w] + dt / FADE_S); }
    // the cord is always there, faintly
    if (!want.cord && shown.cord < 0.55) shown.cord = Math.min(0.55, shown.cord + dt / FADE_S);

    // presses: the resting finger (timed in real time: stillness is the hand's, not the frame's)
    const now = performance.now();
    for (let i = 0; i < plist.length; i++) {
      const p = plist[i];
      if (p.kind !== 'press') continue;
      if (!p.hold) {
        if (now - p.st >= HOLD_S * 1000 && env.plateHit(p.x, p.y)) setHold(p);
      } else {
        toPlateInto(game.view, p.x, p.y, uvs);
        const nu = clamp(uvs.u, -0.98, 0.98), nv = clamp(uvs.v, -0.98, 0.98);
        const spd = Math.hypot(nu - holdObj.u, nv - holdObj.v) / Math.max(dt, 1e-3);
        p.spd += (spd - p.spd) * Math.min(1, dt * 8);
        holdObj.u = nu; holdObj.v = nv;
        if (p.spd > 0.9 || !env.plateHit(p.x, p.y, 4)) { clearHold(); p.kind = 'none'; }
      }
    }
    // fingertip visual
    let pend = 0;
    for (let i = 0; i < plist.length; i++) { const p = plist[i]; if (p.kind === 'press' && !p.hold) pend = Math.max(pend, smooth(0.25, HOLD_S, (now - p.st) / 1000)); }
    holdPend += (pend - holdPend) * Math.min(1, dt * 10);
    const hv = game.hold === holdObj ? 1 : 0;
    holdVis += (hv - holdVis) * Math.min(1, dt * (hv ? 3 : 5));
    if (holdPtr) { holdX = holdPtr.x; holdY = holdPtr.y; }
    else for (let i = 0; i < plist.length; i++) { const p = plist[i]; if (p.kind === 'press') { holdX = p.x; holdY = p.y; } }

    bow.update(dt, ptrFor(bow.heldBy));
    jar.update(dt, ptrFor(jar.heldBy));
    book.update(dt);
    cord.update(dt, ptrFor(cord.heldBy));
    cabinet.update(dt, ptrs);
    phono.update(dt);
    moth.update(dt);

    // label
    if (label.mote && (label.mote.dead || label.mote.state === 'die' || label.mote.state === 'fall')) label.target = 0;
    if (labelHold > 0) { labelHold -= dt; if (labelHold <= 0) label.target = 0; }
    else if (hoverX >= 0 && label.target > 0 && label.mote) hoverLabel(hoverX, hoverY);
    label.a += (label.target - label.a) * Math.min(1, dt * (label.target > label.a ? 5 : 1.6));
    if (label.a < 0.01 && label.target === 0) label.mote = null;

    // dust
    const damp = Math.exp(-dt * 2.2);
    for (let i = 0; i < DUST_N; i++) {
      if (dl[i] <= 0) continue;
      dl[i] -= dt;
      dvx[i] *= damp; dvy[i] *= damp;
      if (dk[i] === 1) dvy[i] += 30 * dt;
      dx[i] += dvx[i] * dt; dy[i] += dvy[i] * dt;
    }
    for (let i = 0; i < RING_N; i++) if (rings[i].t < 9) rings[i].t += dt;
  }

  // ---- render ----------------------------------------------------------------------------------------
  // rosin dust is soft and catches the light; sand splashes are hard grains
  function drawDust(ctx) {
    const I = 0.15 + 0.85 * lamp.intensity;
    if (!dot) dot = bake(8, 8, 4, 4, game.view.dpr || 1, (g) => {
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, 4);
      rg.addColorStop(0, 'rgba(255,250,238,1)'); rg.addColorStop(0.35, 'rgba(255,246,228,0.6)'); rg.addColorStop(1, 'rgba(255,240,220,0)');
      g.fillStyle = rg; g.fillRect(-4, -4, 8, 8);
    });
    for (let i = 0; i < DUST_N; i++) {
      if (dl[i] <= 0) continue;
      const k = dl[i] / dl0[i];
      if (dk[i] === 1) {
        ctx.globalAlpha = 0.7 * k * I;
        ctx.fillStyle = '#e8dcbf';
        const s = ds[i];
        ctx.fillRect(dx[i] - s * 0.5, dy[i] - s * 0.5, s, s);
      } else {
        const a = 0.95 * k * (1.3 - k) * I;
        if (a <= 0.01) continue;
        ctx.globalAlpha = a;
        const s = ds[i] * (1.4 + (1 - k) * 2.2);
        ctx.drawImage(dot.cv, dx[i] - s, dy[i] - s, s * 2, s * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawRings(ctx) {
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = '#ffe6bd';
    for (let i = 0; i < RING_N; i++) {
      const r = rings[i];
      if (r.t > 0.6) continue;
      const k = r.t / 0.6;
      ctx.globalAlpha = (1 - k) * (1 - k) * 0.45 * r.s * (0.2 + 0.8 * lamp.intensity);
      ctx.beginPath();
      ctx.arc(r.x, r.y, 3 + k * 26 * (0.6 + r.s * 0.5), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const off = { x: 0, y: 0 };
  function drawFinger(ctx) {
    const a = Math.max(holdVis, holdPend * 0.7);
    if (a < 0.01 || !fingerSh) return;
    const S = game.view.plate.size;
    // the fingertip's own shadow on the bronze, cast away from the lamp
    lamp.offset(holdX, holdY, S * 0.06, off);
    ctx.save();
    ctx.translate(holdX + off.x, holdY + off.y);
    ctx.rotate(Math.atan2(off.y, off.x));
    blit(ctx, fingerSh, a * 0.36 * (0.25 + 0.75 * lamp.intensity));
    ctx.restore();
    // a small pool of stillness gathering round the touch
    if (holdVis > 0.01) {
      const breathe = 0.85 + 0.15 * Math.sin(game.t * 1.6);
      const sc = 0.55 + 0.45 * holdVis;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(holdX, holdY);
      ctx.scale(sc, sc);
      blit(ctx, fingerRing, holdVis * 0.32 * breathe);
      ctx.restore();
    }
  }

  function drawLabel(ctx) {
    if (label.a < 0.01 || !label.mote || !label.text) return;
    const m = label.mote;
    const unit = game.view.unit || game.view.plate.size / 2;
    const p = toScreenInto(game.view, m.u, m.v, xys);
    const r = (m.r || 0.045) * unit;
    const lx = p.x + r * 0.8 + 14, ly = p.y - r * 0.8 - 12;
    const a = label.a;
    ctx.save();
    ctx.globalAlpha = a * 0.5;
    ctx.strokeStyle = '#e9dfc8';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(p.x + r * 0.75, p.y - r * 0.75);
    ctx.quadraticCurveTo(lx - 8, ly + 9, lx - 2, ly + 3);
    ctx.stroke();
    ctx.font = labelFont;
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.globalAlpha = a * 0.9;
    ctx.fillStyle = '#efe4cc';
    ctx.fillText(label.text, lx, ly);
    ctx.restore();
  }

  function render(ctx) {
    if (!game.view?.plate || !ctx) return;
    ctx.save();
    // on the plate
    cabinet.drawPlate(ctx, lamp);
    moth.drawLanded(ctx, lamp);
    drawRings(ctx);
    drawFinger(ctx);
    // on the felt
    if (shown.journal > 0) book.draw(ctx, lamp, alphaOf('journal'));
    if (shown.phonograph > 0) phono.draw(ctx, lamp, alphaOf('phonograph'));
    if (shown.jar > 0 && jar.heldBy < 0 && !jar.lifted) jar.draw(ctx, lamp, alphaOf('jar'));
    if (shown.drawer > 0) cabinet.drawFront(ctx, lamp, alphaOf('drawer'));
    bow.draw(ctx, lamp);
    drawDust(ctx);
    cord.draw(ctx, lamp, alphaOf('cord'));
    // lifted things
    if (shown.drawer > 0) cabinet.drawTray(ctx, lamp, alphaOf('drawer'));
    if (shown.jar > 0 && (jar.heldBy >= 0 || jar.lifted)) { jar.drawStream(ctx, lamp); jar.draw(ctx, lamp, alphaOf('jar')); }
    cabinet.drawHeld(ctx, lamp);
    moth.drawFlying(ctx, lamp);
    drawLabel(ctx);
    ctx.restore();
  }

  const tools = {
    bow: bowPub,
    get moth() { return moth.pub; },
    get phono() { return phono.pub; },
    phonograph: { record: () => phono.record(), stop: () => phono.stop(), play: (i) => phono.play(i), get mode() { return phono.mode; } },
    update, render, pointerDown, pointerMove, pointerUp, cursor, key, reveal,
    revealed: (w) => !!want[w],
    get trayOpen() { return cabinet.trayOpen; },
    openDrawer(open = true) { cabinet.toggle(open); },
    // harness / debug hooks (stable names; used by dev/tools.html)
    _dev: { bow, jar, book, cord, cabinet, phono, moth, lamp, shown, want, ptrs, summonMoth: () => moth.summon(), tap },
  };
  return tools;
}

