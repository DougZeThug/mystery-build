// The phonograph: a small hand-cranked cylinder machine on an oak base, with a brass horn and a rack
// of three wax cylinders, each with a pencilled label. Click the machine: the needle drops and it
// RECORDS what the plate is singing (up to 20 s). Click a stored cylinder: it is mounted and PLAYED
// once, driving the plate with the old song again (an extinct figure can come back this way).
// Drawn in the same way as the other objects: sprites baked on layout, a few live strokes per frame.
import * as Modes from '../sim/modes.js';
import { clamp, clamp01, smooth, lerp, TAU, bake, bakeShadow, bakeTint, blit, blitLit, seeded, speckle, roundRectPath, spring } from './tools-art.js';
import { woodGrain, brassGrad, uprightShadow } from './tools-objects.js';

const REC_DT = 0.25;          // one frame of the plate's spectrum every quarter second
const REC_MAX = 20;           // seconds of wax on a cylinder
const MAX_CYL = 3;            // the rack holds three
const TOP_N = 4;              // modes kept per frame
const PLAY_GAIN = 0.85;
const PLAY_NORM_MAX = 0.62;   // a memory never drives the plate hard enough to tire the bronze
const MIN_FRAMES = 3;         // shorter than this is a slip of the hand, not a recording
const FLY_S = 0.5;            // a cylinder carried between the rack and the mandrel
const SPIN = 2.6;             // revolutions per second (about 160 rpm)
const EMPTY = [];

// The plate's song on a cylinder at time t (seconds), eased linearly between quarter-second frames,
// scaled by PLAY_GAIN, faded in/out over the first/last .35 s and capped at PLAY_NORM_MAX.
// Writes into `comps` (a pool of {mode, amp}) and pushes the audible ones onto `live` (cleared).
// Returns the resulting amplitude norm. Pure (no game state): unit-tested.
export function mixFrames(frames, dt, t, dur, comps, live, valid = null) {
  const F = frames || [];
  live.length = 0;
  if (!F.length) return 0;
  dt = dt > 0 ? dt : REC_DT;
  const f = Math.min(Math.max(t / dt, 0), F.length - 1);
  const i = Math.floor(f), w = f - i;
  const A = F[i] || EMPTY, B = F[Math.min(F.length - 1, i + 1)] || EMPTY;
  let n = 0;
  for (let a = 0; a < A.length && n < comps.length; a++) {
    const id = A[a][0];
    let bv = 0;
    for (let b = 0; b < B.length; b++) if (B[b][0] === id) { bv = B[b][1]; break; }
    comps[n].mode = id; comps[n].amp = A[a][1] * (1 - w) + bv * w; n++;
  }
  for (let b = 0; b < B.length && n < comps.length; b++) {
    const id = B[b][0];
    let seen = false;
    for (let a = 0; a < A.length; a++) if (A[a][0] === id) { seen = true; break; }
    if (!seen) { comps[n].mode = id; comps[n].amp = B[b][1] * w; n++; }
  }
  // ease in and out so the needle never clicks the plate
  const envl = Math.max(0, Math.min(1, t / 0.35, (dur - t) / 0.35 + 0.15));
  let s2 = 0;
  for (let k = 0; k < n; k++) { const a = +comps[k].amp; comps[k].amp = (a > 0 ? a : 0) * PLAY_GAIN * envl; s2 += comps[k].amp * comps[k].amp; }
  const norm = Math.sqrt(s2);
  const sc = norm > PLAY_NORM_MAX ? PLAY_NORM_MAX / norm : 1;
  for (let k = 0; k < n; k++) { comps[k].amp *= sc; if (comps[k].amp > 0.003 && (!valid || valid(comps[k].mode))) live.push(comps[k]); }
  return Math.min(norm, PLAY_NORM_MAX);
}

// Spectrum entries [{mode, amp}] (loudest first) -> one compact frame [[modeId, amp .01], ...] (top 4).
export function compactFrame(spectrum, n = TOP_N) {
  const fr = [];
  for (let i = 0; spectrum && i < spectrum.length && fr.length < n; i++) {
    const e = spectrum[i];
    const a = Math.round((+e.amp || 0) * 100) / 100;
    if (a >= 0.01 && e.mode) fr.push([e.mode, a]);
  }
  return fr;
}

// A short pencilled note for a cylinder, from what was heard while it turned.
//   rec = { n, choir, floor, dark, w: {genus: weight}, frames }, k(modeId) -> harmonic number
export function cylinderLabel(rec, date = new Date(), k = null) {
  const tw = timeWord(date);
  const n = Math.max(1, rec.n || 0);
  if ((rec.floor || 0) > n * 0.25) return 'below the floor';
  if ((rec.choir || 0) > n * 0.4) return `the choir, ${tw}`;
  const w = rec.w || {};
  const gs = Object.keys(w).sort((a, b) => w[b] - w[a]);
  const dark = (rec.dark || 0) > n * 0.5;
  if (!gs.length) {
    if (dark) return 'the dark plate';
    let best = null, ba = 0;
    for (const f of rec.frames || EMPTY) for (const [id, a] of f) if (a > ba) { ba = a; best = id; }
    const kk = best && k ? k(best) : 0;
    return kk ? `a bare plate, ${kk}` : `a silence, ${tw}`;
  }
  if (dark) return `the ${gs[0]} asleep`;
  if (gs.length > 1 && w[gs[1]] >= w[gs[0]] * 0.5) {
    const two = `${gs[0]} & ${gs[1]}`;
    if (two.length <= 22) return two;
  }
  return `the ${gs[0]} ${tw}`;
}

const genusOf = (sp) => (sp && (sp.genus || (sp.name || '').split(' ')[0])) || '';
function timeWord(d = new Date()) {
  const h = d.getHours();
  return h >= 5 && h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
}

export function createPhonograph(env) {
  const { game } = env;
  const st0 = game.state;
  if (!Array.isArray(st0.cylinders)) st0.cylinders = [];
  const cyls = () => (Array.isArray(game.state.cylinders) ? game.state.cylinders : (game.state.cylinders = []));
  // keep only well-formed records (a save from an older build may hold anything)
  game.state.cylinders = cyls().filter((c) => c && Array.isArray(c.frames) && c.frames.length >= 2).slice(-MAX_CYL);

  // ---- geometry (CSS px; body-local origin = centre of the top face) -----------------------------
  let x = 0, y = 0, Pw = 100, Pd = 56, Pf = 13, Lc = 52, Dc = 19, cyX = 0, cyY = 0, Hl = 100, Rb = 34, r0 = 3.5, th = -Math.PI / 2;
  let rodY = 0, Rr = 8.5, crankX = 0, crankY = 0, Ra = 9;
  let rackX = 0, rackY = 0, Rw = 140, Rh = 90, Bw = 36, slotH = 26, rc = 10, lw = 100;   // Rw: rail + tags; Bw: the rail
  let spr = null, slots = [], slotsSig = '', fontTries = 0;
  const tmp = { x: 0, y: 0 };

  // ---- state -----------------------------------------------------------------------------------
  let mode = 'idle';                    // 'idle' | 'rec' | 'play'
  const st = { needle: 0, vneedle: 0, prog: 0, vprog: 0, crank: 0, vcrank: 0, blank: 1, vblank: 0, press: 0, vpress: 0, glow: 0 };
  let spin = 0, needleHeard = false, wind = 0;
  let pressed = null;
  const rec = { t: 0, next: 0, frames: [], w: Object.create(null), choir: 0, floor: 0, dark: 0, n: 0 };
  const play = { cyl: null, t: 0, dur: 0, started: false, amp: 0, wound: false };
  const fly = { on: false, t: 0, cyl: null, toRack: true, slot: 0 };
  const comps = [];
  for (let i = 0; i < TOP_N * 2; i++) comps.push({ mode: null, amp: 0 });
  const live = [];                      // the slice of comps in use this frame (reused)
  const pub = { recording: false, playing: false, index: -1, progress: 0, amp: 0 };

  // ---- layout: where it stands, and which way the horn points ---------------------------------
  function place() {
    const v = game.view, S = v.plate.size, vw = v.vw, vh = v.vh;
    const an = v.anchors?.phonograph || { x: v.plate.x + S * 1.34, y: v.plate.y + S * 0.22 };
    // obstacles: the plate, the resting bow, the jar, the notebook, the cord, the drawer front
    const obs = [];
    const R = (x0, y0, x1, y1) => obs.push([x0, y0, x1, y1]);
    const p = v.plate;
    R(p.x - 18, p.y - 18, p.x + p.size + 18, p.y + p.size + 18);
    const br = env.bowRest?.();
    if (br) for (let i = 0; i <= 24; i++) { const t = i / 24, bx = br.x + Math.cos(br.a) * br.L * t, by = br.y + Math.sin(br.a) * br.L * t; R(bx - 14, by - 14, bx + 14, by + 14); }
    const A = v.anchors || {};
    if (A.jar) { const jw = clamp(S * 0.145, 44, 96), jh = jw * 1.42; R(A.jar.x - jw * 0.62, A.jar.y - jh * 0.68, A.jar.x + jw * 0.62, A.jar.y + jh * 0.55); }
    if (A.journal) { const bw = clamp(S * 0.2, 64, 132), bh = bw * 1.42, m = Math.max(bw, bh) * 0.58; R(A.journal.x - m, A.journal.y - m, A.journal.x + m, A.journal.y + m * 1.15); }
    if (A.cord) R(A.cord.x - 16, 0, A.cord.x + 16, (A.cord.len || 80) + 40);
    if (A.drawer) R(A.drawer.x - S * 0.1, vh - (A.drawer.h || 30) - 10, A.drawer.x + (A.drawer.w || S) + S * 0.1, vh);
    const over = (a) => {
      let s = 0;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];
        const w = Math.min(a[2], o[2]) - Math.max(a[0], o[0]), h = Math.min(a[3], o[3]) - Math.max(a[1], o[1]);
        if (w > 0 && h > 0) s += w * h;
      }
      const m = 8;
      const ow = Math.max(0, m - a[0]) + Math.max(0, a[2] - (vw - m)), oh = Math.max(0, m - a[1]) + Math.max(0, a[3] - (vh - m));
      return s + (ow * (a[3] - a[1]) + oh * (a[2] - a[0])) * 3;
    };
    const inter = (a, b) => { const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]); return w > 0 && h > 0 ? w * h : 0; };
    const ANG = [-Math.PI / 2, -Math.PI / 2 + 0.55, -Math.PI / 2 - 0.55, -0.35, -Math.PI + 0.35, 0, Math.PI, Math.PI / 2 - 0.4, Math.PI / 2 + 0.4];
    const SIDE = ['below', 'right', 'left', 'above'];
    const body = [0, 0, 0, 0], horn = [0, 0, 0, 0], rack = [0, 0, 0, 0];
    let best = null, bs = Infinity;
    const step = S * 0.05;
    for (let gy = -12; gy <= 12; gy++) {
      for (let gx = -12; gx <= 12; gx++) {
        const bx = an.x + gx * step, by = an.y + gy * step;
        const dist = Math.hypot(gx, gy) * step;
        body[0] = bx - Pw / 2 - 2; body[1] = by - Pd / 2 - 4; body[2] = bx + Pw / 2 + Pw * 0.17; body[3] = by + Pd / 2 + Pf + 4;
        const ob = over(body);
        if (ob > bs) continue;
        for (let ai = 0; ai < ANG.length; ai++) {
          const a = ANG[ai], ca = Math.cos(a), sa = Math.sin(a);
          // the throat travels with the carriage along the cylinder
          const tx0 = bx + cyX - Lc / 2, tx1 = bx + cyX + Lc / 2, ty = by + cyY;
          const ex0 = tx0 + ca * Hl, ex1 = tx1 + ca * Hl, ey = ty + sa * Hl;
          horn[0] = Math.min(tx0, ex0 - Rb); horn[2] = Math.max(tx1, ex1 + Rb);
          horn[1] = Math.min(ty, ey - Rb); horn[3] = Math.max(ty, ey + Rb);
          const oh = over(horn);
          const pref = (1 + sa) * 0.5 * S * 0.5 + (Math.abs(ca) > 0.9 ? S * 0.06 : 0);   // up is the classic way
          const base = ob * 4 + oh * 2 + dist * 0.9 + pref;
          if (base > bs) continue;
          for (let si = 0; si < SIDE.length; si++) {
            const sd = SIDE[si];
            if (sd === 'below') { rack[0] = bx - Pw / 2; rack[1] = by + Pd / 2 + Pf + 10; }
            else if (sd === 'above') { rack[0] = bx - Pw / 2; rack[1] = by - Pd / 2 - 10 - Rh; }
            else if (sd === 'right') { rack[0] = bx + Pw / 2 + Pw * 0.22; rack[1] = by - Rh / 2 + Pf / 2; }
            else { rack[0] = bx - Pw / 2 - 12 - Rw; rack[1] = by - Rh / 2 + Pf / 2; }
            rack[2] = rack[0] + Rw; rack[3] = rack[1] + Rh;
            const sc = base + over(rack) * 3 + inter(rack, horn) * 6 + (sd === 'below' ? 0 : sd === 'right' || sd === 'left' ? S * 0.03 : S * 0.06);
            if (sc < bs) { bs = sc; best = { bx, by, a, sd, rx: rack[0], ry: rack[1] }; }
          }
        }
      }
    }
    if (best) { x = best.bx; y = best.by; th = best.a; rackX = best.rx; rackY = best.ry; }
    else { x = an.x; y = an.y; th = -Math.PI / 2; rackX = x - Pw / 2; rackY = y + Pd / 2 + Pf + 10; }
    x = Math.round(x); y = Math.round(y); rackX = Math.round(rackX); rackY = Math.round(rackY);
  }

  function layout() {
    const v = game.view, S = v.plate.size, dpr = v.dpr || 1;
    Pw = Math.round(clamp(S * 0.19, 54, 116));
    Pd = Math.round(Pw * 0.56); Pf = Math.round(Pw * 0.13);
    Lc = Math.round(Pw * 0.5); Dc = Math.round(Pw * 0.19);
    cyX = -Pw * 0.03; cyY = Pd * 0.1;
    rodY = cyY - Dc / 2 - Pd * 0.2;
    Rr = Pw * 0.085;
    Hl = Pw * 1.02; Rb = Pw * 0.34; r0 = Math.max(2.5, Pw * 0.034);
    crankX = Pw / 2; crankY = Pd * 0.12; Ra = Pw * 0.09;
    slotH = Math.round(Math.max(19, Pw * 0.25)); rc = Math.min(slotH * 0.36, Pw * 0.1);
    lw = Math.round(Math.max(100, Pw * 1.0));
    Bw = Math.round(rc * 2 + 14); Rw = Bw + 6 + lw; Rh = Math.round(slotH * MAX_CYL + 10);
    place();
    bakeAll(dpr);
  }

  // ---- sprites ---------------------------------------------------------------------------------
  // the lamp's side of a body at angle `a` (for highlights baked into rotated sprites)
  function lampSide(a) {
    const lx = (env.lamp?.x ?? game.view.plate.cx) - x, ly = (env.lamp?.y ?? game.view.plate.cy) - y;
    // local -y axis of a sprite rotated by a, in world space: (sin a, -cos a)
    return Math.sin(a) * lx - Math.cos(a) * ly >= 0 ? 1 : -1;
  }

  function bakeBody(dpr) {
    const rnd = seeded(1877);
    const W = Pw * 1.5, H = (Pd + Pf) * 1.6, ox = W / 2, oy = Pd / 2 + (Pd + Pf) * 0.3;
    const lit = bake(W, H, ox, oy, dpr, (g) => {
      const x0 = -Pw / 2, y0 = -Pd / 2;
      // front face: quarter-sawn oak in shadow, a moulded plinth, a small blank brass plate
      woodGrain(g, rnd, x0, Pd / 2, Pw, Pf, '#4e3219', '#26160a', '#73502c', true, 14);
      const fg = g.createLinearGradient(0, Pd / 2, 0, Pd / 2 + Pf);
      fg.addColorStop(0, 'rgba(0,0,0,0.15)'); fg.addColorStop(1, 'rgba(0,0,0,0.5)');
      g.fillStyle = fg; g.fillRect(x0, Pd / 2, Pw, Pf);
      g.fillStyle = 'rgba(255,220,170,0.12)'; g.fillRect(x0, Pd / 2 + Pf * 0.62, Pw, 0.7);
      g.beginPath(); roundRectPath(g, -Pw * 0.09, Pd / 2 + Pf * 0.18, Pw * 0.18, Pf * 0.42, 1);
      g.fillStyle = brassGrad(g, -Pw * 0.09, 0, Pw * 0.09, Pf); g.fill();
      g.strokeStyle = 'rgba(40,25,5,0.5)'; g.lineWidth = 0.4; g.stroke();
      // top face: lighter oak, a bevelled edge catching the lamp
      woodGrain(g, rnd, x0, y0, Pw, Pd, '#8a5f35', '#4a2f15', '#b58552', true, 34);
      speckle(g, rnd, x0, y0, Pw, Pd, Math.round(Pw * Pd * 0.04), '#3a2410', 0.08, 0.25, 0.4, 0.9);
      g.fillStyle = 'rgba(255,225,180,0.28)'; g.fillRect(x0, y0, Pw, 1.2); g.fillRect(x0, y0, 1.2, Pd);
      g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x0, Pd / 2 - 1.4, Pw, 1.4); g.fillRect(x0 + Pw - 1.2, y0, 1.2, Pd);
      g.strokeStyle = 'rgba(30,18,6,0.45)'; g.lineWidth = 0.7; g.strokeRect(x0 + 3.5, y0 + 3.5, Pw - 7, Pd - 7);
      g.strokeStyle = 'rgba(255,220,170,0.14)'; g.strokeRect(x0 + 4.3, y0 + 4.3, Pw - 7, Pd - 7);
      // the japanned iron bed with its gold pinstripe
      const ix = x0 + Pw * 0.07, iy = y0 + Pd * 0.1, iw = Pw * 0.86, ih = Pd * 0.78;
      g.beginPath(); roundRectPath(g, ix + 1, iy + 1.4, iw, ih, Pw * 0.03); g.fillStyle = 'rgba(0,0,0,0.45)'; g.fill();
      g.beginPath(); roundRectPath(g, ix, iy, iw, ih, Pw * 0.03);
      const bg = g.createLinearGradient(ix, iy, ix + iw * 0.4, iy + ih);
      bg.addColorStop(0, '#2b2622'); bg.addColorStop(0.5, '#151210'); bg.addColorStop(1, '#0c0a09');
      g.fillStyle = bg; g.fill();
      g.strokeStyle = 'rgba(200,160,80,0.5)'; g.lineWidth = 0.55;
      g.beginPath(); roundRectPath(g, ix + 2.2, iy + 2.2, iw - 4.4, ih - 4.4, Pw * 0.022); g.stroke();
      // little gilt flourishes in the corners
      g.strokeStyle = 'rgba(210,170,90,0.45)'; g.lineWidth = 0.5;
      for (const [cx, cy, sx, sy] of [[ix + 5, iy + 5, 1, 1], [ix + iw - 5, iy + 5, -1, 1], [ix + 5, iy + ih - 5, 1, -1], [ix + iw - 5, iy + ih - 5, -1, -1]]) {
        g.beginPath(); g.moveTo(cx, cy + sy * Pw * 0.05); g.quadraticCurveTo(cx, cy, cx + sx * Pw * 0.05, cy); g.stroke();
      }
      // the back rod (feed screw), threaded
      const rx0 = -Pw * 0.38, rx1 = Pw * 0.38;
      g.strokeStyle = '#1a1a1b'; g.lineWidth = Math.max(1.6, Pw * 0.022); g.beginPath(); g.moveTo(rx0, rodY + 0.6); g.lineTo(rx1, rodY + 0.6); g.stroke();
      g.strokeStyle = '#9ea3a6'; g.lineWidth = Math.max(1.1, Pw * 0.015); g.beginPath(); g.moveTo(rx0, rodY); g.lineTo(rx1, rodY); g.stroke();
      g.strokeStyle = 'rgba(30,30,32,0.6)'; g.lineWidth = 0.4;
      for (let xx = rx0; xx < rx1; xx += 1.3) { g.beginPath(); g.moveTo(xx, rodY - 0.8); g.lineTo(xx + 0.6, rodY + 0.8); g.stroke(); }
      for (const ex of [rx0, rx1]) { g.beginPath(); roundRectPath(g, ex - 2, rodY - 2.6, 4, 5.2, 1); g.fillStyle = '#2a2826'; g.fill(); }
      // the mandrel shaft, its pulley and belt at the left, the bearing at the right
      const cx0 = cyX - Lc / 2, cx1 = cyX + Lc / 2;
      g.strokeStyle = '#7d8286'; g.lineWidth = Math.max(1.2, Dc * 0.16);
      g.beginPath(); g.moveTo(-Pw * 0.42, cyY); g.lineTo(cx1 + Pw * 0.06, cyY); g.stroke();
      const px = -Pw * 0.39, pw = Pw * 0.035, ph = Dc * 1.25;
      g.fillStyle = '#121110'; g.fillRect(px - pw * 0.6, cyY - ph / 2 + 1, pw * 1.2, ph);
      const pg = g.createLinearGradient(0, cyY - ph / 2, 0, cyY + ph / 2);
      pg.addColorStop(0, '#3b3d3f'); pg.addColorStop(0.35, '#c9cdd0'); pg.addColorStop(1, '#2a2c2e');
      g.fillStyle = pg; g.fillRect(px - pw / 2, cyY - ph / 2, pw, ph);
      g.strokeStyle = 'rgba(70,40,20,0.85)'; g.lineWidth = Math.max(1, Pw * 0.012);
      g.beginPath(); g.moveTo(px - pw * 0.2, cyY + ph / 2); g.lineTo(px - pw * 0.4, iy + ih - 3); g.stroke();
      g.beginPath(); g.moveTo(px + pw * 0.2, cyY + ph / 2); g.lineTo(px + pw * 0.5, iy + ih - 3); g.stroke();
      g.beginPath(); roundRectPath(g, cx1 + Pw * 0.05, cyY - Dc * 0.32, Pw * 0.04, Dc * 0.64, 1.2);
      g.fillStyle = '#26231f'; g.fill(); g.strokeStyle = 'rgba(200,160,80,0.35)'; g.lineWidth = 0.4; g.stroke();
      // a shallow cradle under the cylinder
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(cx0 - 1, cyY - Dc / 2 + 1.5, Lc + 2, Dc);
      // the crank's boss on the right side
      g.beginPath(); g.arc(crankX + 1, crankY, Pw * 0.03, 0, TAU); g.fillStyle = '#2a2826'; g.fill();
    });
    return { lit, dark: bakeTint(lit, '#0d0a08'), sh: bakeShadow(lit, Math.max(2, Pw * 0.05)) };
  }

  // a wax cylinder lying on the mandrel (seen from above: its length across, its round under the light)
  function bakeCylinder(dpr, colour, recorded) {
    const rnd = seeded(recorded ? 52 : 51);
    const W = Lc + 4, H = Dc + 4;
    const side = lampSide(0);
    return bake(W, H, W / 2, H / 2, dpr, (g) => {
      g.beginPath(); roundRectPath(g, -Lc / 2, -Dc / 2, Lc, Dc, Dc * 0.14);
      const cg = g.createLinearGradient(0, -Dc / 2 * side, 0, Dc / 2 * side);
      cg.addColorStop(0, colour[0]); cg.addColorStop(0.22, colour[1]); cg.addColorStop(0.32, colour[2]);
      cg.addColorStop(0.5, colour[1]); cg.addColorStop(0.85, colour[3]); cg.addColorStop(1, colour[4]);
      g.fillStyle = cg; g.fill();
      g.save(); g.clip();
      // the groove: a fine spiral, read from above as close lines round the cylinder
      g.lineWidth = 0.35;
      for (let xx = -Lc / 2 + 2; xx < Lc / 2 - 2; xx += recorded ? 0.9 : 1.6) {
        g.strokeStyle = recorded ? (rnd() < 0.5 ? 'rgba(255,230,190,0.16)' : 'rgba(0,0,0,0.22)') : 'rgba(255,235,200,0.06)';
        g.beginPath(); g.moveTo(xx, -Dc / 2); g.lineTo(xx + 0.5, Dc / 2); g.stroke();
      }
      speckle(g, rnd, -Lc / 2, -Dc / 2, Lc, Dc, Math.round(Lc * Dc * 0.03), '#fff3dc', 0.04, 0.14, 0.3, 0.8);
      g.restore();
      // bevelled ends
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(-Lc / 2, -Dc / 2 + 1, 1.2, Dc - 2); g.fillRect(Lc / 2 - 1.2, -Dc / 2 + 1, 1.2, Dc - 2);
      g.strokeStyle = 'rgba(20,10,4,0.6)'; g.lineWidth = 0.5; g.beginPath(); roundRectPath(g, -Lc / 2, -Dc / 2, Lc, Dc, Dc * 0.14); g.stroke();
    });
  }
  const WAX_BLANK = ['#3e2a16', '#a07c4e', '#e3c79a', '#7a5a34', '#2a1a0c'];
  const WAX_REC = ['#1e120a', '#5e3d22', '#b48a5c', '#3e2614', '#140b05'];

  function bakeReproducer(dpr) {
    const R = Rr, W = R * 2.8;
    return bake(W, W, W / 2, W / 2, dpr, (g) => {
      // brass ring, a mica diaphragm, the centre screw and the stylus bar
      g.beginPath(); g.arc(0, 0, R, 0, TAU);
      g.fillStyle = brassGrad(g, -R, -R, R, R); g.fill();
      g.strokeStyle = 'rgba(40,25,5,0.7)'; g.lineWidth = 0.6; g.stroke();
      g.beginPath(); g.arc(0, 0, R * 0.72, 0, TAU);
      const mg = g.createRadialGradient(-R * 0.25, -R * 0.3, R * 0.05, 0, 0, R * 0.72);
      mg.addColorStop(0, '#d9d6c8'); mg.addColorStop(0.5, '#7d7a70'); mg.addColorStop(1, '#3b3934');
      g.fillStyle = mg; g.fill();
      g.strokeStyle = 'rgba(255,255,240,0.5)'; g.lineWidth = 0.5;
      g.beginPath(); g.arc(0, 0, R * 0.55, Math.PI * 1.1, Math.PI * 1.55); g.stroke();
      g.beginPath(); g.arc(0, 0, R * 0.16, 0, TAU); g.fillStyle = brassGrad(g, -R * 0.16, -R * 0.16, R * 0.16, R * 0.16); g.fill();
      g.strokeStyle = '#1b1a19'; g.lineWidth = Math.max(0.8, R * 0.12);
      g.beginPath(); g.moveTo(0, R * 0.2); g.lineTo(R * 0.18, R * 1.05); g.stroke();
    });
  }

  // the horn: a flared brass cone of soldered panels, throat at the origin, opening toward +x
  const hornR = (s) => r0 + (Rb - r0) * Math.pow(clamp01(s / Hl), 2.5);
  function bakeHorn(dpr) {
    const side = lampSide(th);
    const mx = Rb * 0.42, pad = 4;
    const W = Hl + mx + pad * 2 + r0, H = Rb * 2 + pad * 2;
    const N = 64;
    const outline = (g) => {
      g.beginPath(); g.moveTo(0, -hornR(0));
      for (let i = 1; i <= N; i++) { const s = (Hl * i) / N; g.lineTo(s, -hornR(s)); }
      g.ellipse(Hl, 0, mx, Rb, 0, -Math.PI / 2, Math.PI / 2, false);
      for (let i = N; i >= 0; i--) { const s = (Hl * i) / N; g.lineTo(s, hornR(s)); }
      g.closePath();
    };
    const lit = bake(W, H, pad + r0, H / 2, dpr, (g) => {
      // body in slices, each shaded across its own width (dark flanks, the lamp's streak)
      for (let i = 0; i < N; i++) {
        const s0 = (Hl * i) / N, s1 = (Hl * (i + 1)) / N + 0.6, r = hornR((s0 + s1) / 2) + 0.3;
        const gr = g.createLinearGradient(0, -r * side, 0, r * side);
        gr.addColorStop(0, '#3a2709'); gr.addColorStop(0.1, '#80591e'); gr.addColorStop(0.27, '#f6dc96');
        gr.addColorStop(0.38, '#c99f4f'); gr.addColorStop(0.68, '#8a6226'); gr.addColorStop(1, '#2e1e07');
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(s0, -hornR(s0) - 0.3); g.lineTo(s1, -hornR(s1) - 0.3); g.lineTo(s1, hornR(s1) + 0.3); g.lineTo(s0, hornR(s0) + 0.3); g.closePath(); g.fill();
      }
      // the far lip of the bell beyond the panels
      const lg = g.createLinearGradient(0, -Rb * side, 0, Rb * side);
      lg.addColorStop(0, '#4a330e'); lg.addColorStop(0.3, '#e8c97c'); lg.addColorStop(1, '#3a2709');
      g.beginPath(); g.ellipse(Hl, 0, mx, Rb, 0, -Math.PI / 2, Math.PI / 2, false); g.closePath(); g.fillStyle = lg; g.fill();
      // panel seams
      g.save(); outline(g); g.clip();
      for (const deg of [-72, -44, -15, 15, 44, 72]) {
        const k = Math.sin((deg * Math.PI) / 180);
        g.strokeStyle = 'rgba(40,24,4,0.35)'; g.lineWidth = 0.55;
        g.beginPath(); for (let i = 0; i <= N; i++) { const s = (Hl * i) / N; g[i ? 'lineTo' : 'moveTo'](s, hornR(s) * k); } g.stroke();
        g.strokeStyle = 'rgba(255,240,200,0.18)'; g.lineWidth = 0.4;
        g.beginPath(); for (let i = 0; i <= N; i++) { const s = (Hl * i) / N; g[i ? 'lineTo' : 'moveTo'](s, hornR(s) * k + 0.6); } g.stroke();
      }
      // a dent and a little tarnish: it has been handled
      speckle(g, seeded(66), 0, -Rb, Hl, Rb * 2, Math.round(Hl * Rb * 0.05), '#3d5a40', 0.05, 0.16, 0.6, 1.6);
      g.restore();
      // collars near the throat
      for (const fs of [0.06, 0.18]) {
        const s = Hl * fs, r = hornR(s) + 0.9;
        g.fillStyle = brassGrad(g, s, -r, s + 2, r); g.fillRect(s - 1, -r, 2.4, r * 2);
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(s + 1.4, -r, 0.6, r * 2);
      }
      // the mouth: dark brass inside, a rolled rim
      g.beginPath(); g.ellipse(Hl, 0, mx * 0.92, Rb * 0.95, 0, 0, TAU);
      const ig = g.createRadialGradient(Hl + mx * 0.3, 0, Rb * 0.05, Hl, 0, Rb);
      ig.addColorStop(0, '#0d0803'); ig.addColorStop(0.55, '#2c1d08'); ig.addColorStop(0.9, '#7a5520'); ig.addColorStop(1, '#a87c34');
      g.fillStyle = ig; g.fill();
      g.lineWidth = Math.max(1.4, Rb * 0.08);
      g.strokeStyle = brassGrad(g, Hl - mx, -Rb * side, Hl + mx, Rb * side);
      g.beginPath(); g.ellipse(Hl, 0, mx, Rb, 0, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,245,210,0.6)'; g.lineWidth = 0.6;
      g.beginPath(); g.ellipse(Hl, 0, mx, Rb, 0, side > 0 ? Math.PI * 1.05 : Math.PI * 0.2, side > 0 ? Math.PI * 1.6 : Math.PI * 0.75); g.stroke();
      // the elbow where it meets the reproducer
      g.beginPath(); g.arc(0, 0, r0 * 1.35, 0, TAU); g.fillStyle = brassGrad(g, -r0, -r0, r0, r0); g.fill();
      g.strokeStyle = 'rgba(40,25,5,0.6)'; g.lineWidth = 0.5; g.stroke();
    });
    const sil = bake(W, H, pad + r0, H / 2, dpr, (g) => { outline(g); g.fillStyle = '#000'; g.fill(); });
    // a soft warm glow over the mouth for playback
    const glow = bake(W + Rb * 2, H + Rb, pad + r0 + Rb, H / 2 + Rb * 0.5, dpr, (g) => {
      const rg = g.createRadialGradient(Hl, 0, 0, Hl, 0, Rb * 1.5);
      rg.addColorStop(0, 'rgba(255,225,160,0.7)'); rg.addColorStop(0.5, 'rgba(255,210,140,0.22)'); rg.addColorStop(1, 'rgba(255,200,130,0)');
      g.fillStyle = rg; g.fillRect(Hl - Rb * 1.6, -Rb * 1.6, Rb * 3.2, Rb * 3.2);
    });
    return { lit, dark: bakeTint(lit, '#0d0a08'), sh: bakeShadow(sil, Math.max(3, Rb * 0.3)), glow };
  }

  function bakeRack(dpr) {
    const rnd = seeded(1903);
    // a narrow oak rail with three turned pegs; the tags lie on the felt beside it
    return bake(Bw + 4, Rh + 4, 2, 2, dpr, (g) => {
      g.beginPath(); roundRectPath(g, 0, 0, Bw, Rh, 3);
      g.save(); g.clip();
      woodGrain(g, rnd, 0, 0, Bw, Rh, '#80562f', '#43290f', '#ad7d4a', false, 16);
      g.fillStyle = 'rgba(255,225,180,0.3)'; g.fillRect(0, 0, Bw, 1.2); g.fillRect(0, 0, 1.2, Rh);
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, Rh - 1.6, Bw, 1.6); g.fillRect(Bw - 1.4, 0, 1.4, Rh);
      g.restore();
      g.strokeStyle = 'rgba(30,16,6,0.55)'; g.lineWidth = 0.6; g.beginPath(); roundRectPath(g, 0.3, 0.3, Bw - 0.6, Rh - 0.6, 3); g.stroke();
      for (let i = 0; i < MAX_CYL; i++) {
        const cx = Bw / 2, cy = 5 + slotH * (i + 0.5);
        // a shallow turned recess and the peg a cylinder slips over
        const rg = g.createRadialGradient(cx - rc * 0.2, cy - rc * 0.2, rc * 0.2, cx, cy, rc * 1.15);
        rg.addColorStop(0, '#3a2410'); rg.addColorStop(0.8, '#24150a'); rg.addColorStop(1, '#120a04');
        g.beginPath(); g.arc(cx, cy, rc * 1.1, 0, TAU); g.fillStyle = rg; g.fill();
        g.strokeStyle = 'rgba(255,220,170,0.3)'; g.lineWidth = 0.6;
        g.beginPath(); g.arc(cx, cy, rc * 1.1, Math.PI * 0.05, Math.PI * 0.8); g.stroke();
        g.beginPath(); g.arc(cx + 0.6, cy + 0.8, rc * 0.42, 0, TAU); g.fillStyle = 'rgba(0,0,0,0.45)'; g.fill();
        g.beginPath(); g.arc(cx, cy, rc * 0.4, 0, TAU);
        const pg = g.createRadialGradient(cx - rc * 0.15, cy - rc * 0.15, rc * 0.04, cx, cy, rc * 0.4);
        pg.addColorStop(0, '#c99a64'); pg.addColorStop(1, '#5e3c1e');
        g.fillStyle = pg; g.fill();
      }
    });
  }

  // one stored cylinder standing in the rack, with its pencilled tag
  function bakeSlot(dpr, c, i) {
    const rnd = seeded(((c.t || 0) % 100000) + i * 7);
    const H = slotH;
    return bake(Rw + 4, H, 0, H / 2, dpr, (g) => {
      const cx = Bw / 2;
      // wax, upright: a ring round its hollow core, lit from the lamp's side
      g.beginPath(); g.arc(cx + 0.8, 1.2, rc, 0, TAU); g.fillStyle = 'rgba(0,0,0,0.5)'; g.fill();
      g.beginPath(); g.arc(cx, 0, rc, 0, TAU);
      const wg = g.createRadialGradient(cx - rc * 0.35, -rc * 0.4, rc * 0.1, cx, 0, rc);
      wg.addColorStop(0, '#e2b87c'); wg.addColorStop(0.45, '#8f6034'); wg.addColorStop(1, '#3a2210');
      g.fillStyle = wg; g.fill();
      g.strokeStyle = 'rgba(30,16,6,0.6)'; g.lineWidth = 0.5; g.stroke();
      g.strokeStyle = 'rgba(255,240,210,0.55)'; g.lineWidth = 0.7;
      g.beginPath(); g.arc(cx, 0, rc * 0.8, Math.PI * 1.05, Math.PI * 1.6); g.stroke();
      g.beginPath(); g.arc(cx, 0, rc * 0.5, 0, TAU); g.fillStyle = '#100a06'; g.fill();
      g.strokeStyle = 'rgba(255,220,180,0.25)'; g.lineWidth = 0.5;
      g.beginPath(); g.arc(cx, 0, rc * 0.52, Math.PI * 0.1, Math.PI * 0.7); g.stroke();
      // the tag: a strip of cream card on a twist of thread, written in graphite
      const tx = Bw + 6, tw = lw - 4, thh = Math.min(H - 4, Math.max(14, H * 0.74));
      g.strokeStyle = 'rgba(200,185,150,0.55)'; g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(cx + rc * 0.75, -rc * 0.3); g.quadraticCurveTo(cx + rc + 4, rc * 0.6, tx + 4, 0); g.stroke();
      g.save();
      g.translate(tx, 0); g.rotate((rnd() - 0.5) * 0.05);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(1, -thh / 2 + 1.2, tw, thh);
      g.beginPath(); g.moveTo(0, -thh / 2);
      for (let k = 0; k <= 8; k++) g.lineTo((tw * k) / 8, -thh / 2 + (rnd() - 0.5) * 0.8);
      g.lineTo(tw, thh / 2); g.lineTo(0, thh / 2); g.closePath();
      const pg = g.createLinearGradient(0, -thh / 2, tw, thh / 2);
      pg.addColorStop(0, '#e9dcbc'); pg.addColorStop(1, '#d6c59f');
      g.fillStyle = pg; g.fill();
      speckle(g, rnd, 0, -thh / 2, tw, thh, Math.round(tw * thh * 0.02), '#8a6a40', 0.06, 0.2, 0.4, 1);
      g.beginPath(); g.arc(4, 0, 1.3, 0, TAU); g.fillStyle = '#5a4a30'; g.fill();
      let fs = clamp(H * 0.62, 11, 17);
      const text = String(c.label || 'untitled').slice(0, 40);
      g.font = `${fs}px Caveat, 'Segoe Print', cursive`;
      const maxW = tw - 12;
      const w0 = g.measureText(text).width;
      if (w0 > maxW) { fs = Math.max(8, fs * maxW / w0); g.font = `${fs}px Caveat, 'Segoe Print', cursive`; }
      g.textBaseline = 'middle';
      g.fillStyle = 'rgba(48,44,42,0.85)';
      g.fillText(text, 9, 0.5);
      g.restore();
    });
  }

  function bakeAll(dpr) {
    spr = {
      body: bakeBody(dpr),
      blank: bakeCylinder(dpr, WAX_BLANK, false),
      waxRec: bakeCylinder(dpr, WAX_REC, true),
      repro: bakeReproducer(dpr),
      horn: bakeHorn(dpr),
      rack: bakeRack(dpr),
    };
    spr.reproSh = bakeShadow(spr.repro, 1.5);
    slotsSig = '';
    rebakeSlots();
  }
  function rebakeSlots() {
    const cs = cyls();
    const sig = cs.map((c) => `${c.t}|${c.label}`).join('/');
    if (sig === slotsSig && slots.length === cs.length) return;
    slotsSig = sig;
    const dpr = game.view.dpr || 1;
    slots = cs.map((c, i) => bakeSlot(dpr, c, i));
    // the tags want their hand: bake again once Caveat has arrived
    try {
      if (document.fonts && !document.fonts.check('14px Caveat') && fontTries < 3) {
        fontTries++;
        document.fonts.load('14px Caveat').then(() => { slotsSig = ''; rebakeSlots(); }).catch(() => {});
      }
    } catch { /* no font loading API */ }
  }

  // ---- recording -------------------------------------------------------------------------------
  function capture() {
    rec.frames.push(compactFrame(game.field?.spectrum?.() || EMPTY));
    // who was singing, for the label
    const pops = game.life?.populations?.() || EMPTY;
    for (const p of pops) {
      if (p.keeper || !(p.count > 0)) continue;
      const g = genusOf(p.species || game.state.species?.[p.id]);
      if (g) rec.w[g] = (rec.w[g] || 0) + p.count;
    }
    if ((game.fx?.choir || 0) > 0.5) rec.choir++;
    if ((game.fx?.floor || 0) > 0.4) rec.floor++;
    if (game.light && !game.light.on) rec.dark++;
    rec.n++;
  }
  function labelFor() { return cylinderLabel(rec, new Date(), (id) => Modes.modeById(id)?.k || 0); }
  function startRecord() {
    if (mode === 'play') stopPlay(true);
    mode = 'rec';
    rec.t = 0; rec.next = 0; rec.frames = []; rec.w = Object.create(null); rec.choir = rec.floor = rec.dark = rec.n = 0;
    needleHeard = false; wind = 0.7;
    pub.recording = true; pub.index = -1;
    env.emit('phono:record', { on: true });
  }
  function stopRecord() {
    if (mode !== 'rec') return null;
    mode = 'idle';
    pub.recording = false;
    env.emit('sfx', { name: 'phonoStop', pan: env.panOf(x) });
    let cyl = null, index = -1;
    if (rec.frames.length >= MIN_FRAMES) {
      cyl = { t: Date.now(), label: labelFor(), frames: rec.frames, dt: REC_DT };
      const cs = cyls();
      cs.push(cyl);
      while (cs.length > MAX_CYL) cs.shift();
      index = cs.indexOf(cyl);
      rebakeSlots();
      // carried from the mandrel to its place in the rack; a fresh blank goes on
      startFly(cyl, true, index);
      st.blank = 0; st.vblank = 0;
    }
    rec.frames = [];
    env.emit('phono:record', { on: false, index, label: cyl?.label || null, frames: cyl ? cyl.frames.length : 0 });
    return cyl;
  }

  // ---- playback --------------------------------------------------------------------------------
  function startPlay(index) {
    const cs = cyls();
    let cyl = cs[index];
    if (mode === 'rec') { stopRecord(); index = cs.indexOf(cyl); }
    if (!cyl) return;
    if (mode === 'play') { if (play.cyl === cyl) { stopPlay(); return; } stopPlay(true); }
    mode = 'play';
    play.cyl = cyl; play.t = -(FLY_S + 0.3); play.started = false; play.amp = 0; play.wound = false;
    st.blank = 0; st.vblank = 0;
    play.dur = Math.max(REC_DT, (cyl.frames.length - 1) * (cyl.dt || REC_DT));
    needleHeard = false;
    pub.playing = true; pub.index = index;
    startFly(cyl, false, index);
  }
  function stopPlay(quiet = false) {
    if (mode !== 'play') return;
    const cyl = play.cyl, index = cyls().indexOf(cyl);
    mode = 'idle';
    game.field?.setSource?.('phono', EMPTY);
    pub.playing = false; pub.amp = 0;
    if (play.started) env.emit('phono:play', { on: false, index });
    if (!quiet || play.started) env.emit('sfx', { name: 'phonoStop', pan: env.panOf(x) });
    play.started = false;
    if (cyl && index >= 0) startFly(cyl, true, index);
    play.cyl = null;
  }
  // the modes a cylinder holds, loudest first (summed over its frames)
  function modesOf(cyl, n = 3) {
    const acc = Object.create(null);
    for (const f of cyl.frames || EMPTY) for (const e of f) if (Array.isArray(e)) acc[e[0]] = (acc[e[0]] || 0) + (+e[1] || 0);
    return Object.keys(acc).sort((a, b) => acc[b] - acc[a]).slice(0, n);
  }
  const validMode = (id) => !!Modes.modeById(id);
  function frameAt(cyl, t) { return mixFrames(cyl.frames, cyl.dt || REC_DT, t, play.dur, comps, live, validMode); }

  // ---- the carried cylinder --------------------------------------------------------------------
  function startFly(cyl, toRack, slot) { fly.on = true; fly.t = 0; fly.cyl = cyl; fly.toRack = toRack; fly.slot = slot; }
  const slotPos = (i, o) => { o.x = rackX + Bw / 2; o.y = rackY + 5 + slotH * (i + 0.5); return o; };
  const mandrelPos = (o) => { o.x = x + cyX; o.y = y + cyY; return o; };

  // ---- pointer ---------------------------------------------------------------------------------
  function hitBody(px, py, pad) {
    const lx = px - x, ly = py - y;
    if (lx > -Pw / 2 - pad && lx < Pw / 2 + Pw * 0.17 + pad && ly > -Pd / 2 - pad && ly < Pd / 2 + Pf + pad) return true;
    // the horn (it travels with the carriage)
    const hx = px - (x + cyX - Lc / 2 + Lc * st.prog), hy = py - (y + cyY);
    const c = Math.cos(th), s = Math.sin(th);
    const u = hx * c + hy * s, w = -hx * s + hy * c;
    return u > 0 && u < Hl + Rb * 0.45 + pad && Math.abs(w) < hornR(u) + pad;
  }
  function hitSlot(px, py, pad) {
    const cs = cyls();
    if (px < rackX - pad || px > rackX + Rw + pad || py < rackY - pad || py > rackY + Rh + pad) return -1;
    const i = Math.floor((py - rackY - 5) / slotH);
    return i >= 0 && i < cs.length ? i : -1;
  }
  // 'body' | 'slot:<i>' | null
  function hit(px, py, touch) {
    if (!spr) return null;
    const pad = touch ? 10 : 3;
    const i = hitSlot(px, py, pad);
    if (i >= 0) return 'slot:' + i;
    if (hitBody(px, py, pad)) return 'body';
    return null;
  }
  function press(what) { pressed = what; }
  function release() { pressed = null; }
  function click(what) {
    pressed = null;
    if (!what) return;
    if (what === 'body') {
      if (mode === 'rec') stopRecord();
      else if (mode === 'play') stopPlay();
      else startRecord();
    } else if (what.startsWith('slot:')) {
      const i = +what.slice(5);
      if (Number.isFinite(i)) startPlay(i);
    }
  }

  // ---- update ----------------------------------------------------------------------------------
  let sigT = 0;
  function update(dt) {
    if (!spr) return;
    sigT -= dt;
    if (sigT <= 0) { sigT = 0.5; rebakeSlots(); }
    const recording = mode === 'rec', playing = mode === 'play' && play.t >= 0;
    if (recording) {
      rec.t += dt;
      while (rec.t >= rec.next && rec.frames.length < REC_MAX / REC_DT + 1) { capture(); rec.next += REC_DT; }
      if (rec.t >= REC_MAX) stopRecord();
    }
    if (mode === 'play') {
      play.t += dt;
      if (play.t >= 0) {
        if (!play.started) { play.started = true; env.emit('phono:play', { on: true, index: cyls().indexOf(play.cyl), modes: modesOf(play.cyl), label: play.cyl.label || null }); }
        const a = frameAt(play.cyl, Math.min(play.t, play.dur));
        play.amp = a; pub.amp = a;
        game.field?.setSource?.('phono', live.length ? live : EMPTY);
        if (play.t >= play.dur) stopPlay();
      }
    }
    // the needle: down while the wax is turning under it
    const down = mode === 'rec' || (mode === 'play' && play.t > -0.22);
    spring(st, 'needle', 'vneedle', down ? 1 : 0, down ? 16 : 12, dt);
    if (down && !needleHeard && st.needle > 0.8) { needleHeard = true; env.emit('sfx', { name: 'phonoNeedle', pan: env.panOf(x) }); }
    if (!down) needleHeard = false;
    // the carriage follows the groove; at rest it runs back to the start
    const progT = mode === 'rec' ? rec.t / REC_MAX : mode === 'play' ? Math.max(0, play.t) / REC_MAX : 0;
    if (mode === 'idle') spring(st, 'prog', 'vprog', 0, 5, dt); else { st.prog = clamp01(progT); st.vprog = 0; }
    pub.progress = mode === 'rec' ? rec.t / REC_MAX : mode === 'play' && play.dur > 0 ? clamp01(play.t / play.dur) : 0;
    // turning: a little wind of the crank to start, then the wax spins
    const spinning = mode === 'rec' || playing;
    spin = (spin + (spinning ? SPIN * dt * clamp01(st.needle * 1.5) : 0)) % 1;
    if (wind > 0) { wind = Math.max(0, wind - dt); st.crank += dt * TAU * 3.2; }
    if (mode === 'play' && play.t < 0 && play.t > -0.6 && wind <= 0 && !play.wound) { play.wound = true; wind = 0.6; }
    if (mode !== 'play') play.wound = false;
    // a fresh blank fades onto the mandrel after a recording is carried away
    spring(st, 'blank', 'vblank', fly.on && fly.toRack ? 0 : 1, 6, dt);
    spring(st, 'press', 'vpress', pressed ? 1 : 0, 25, dt);
    st.glow += ((playing ? clamp01(play.amp / 0.35) : mode === 'rec' ? 0.35 : 0) - st.glow) * Math.min(1, dt * 4);
    if (fly.on) { fly.t += dt; if (fly.t >= FLY_S) fly.on = false; }
    // a curl of wax shaving from the cutter now and then
    if (recording && st.needle > 0.9 && Math.random() < dt * 6) {
      const sx = x + cyX - Lc / 2 + Lc * st.prog, sy = y + cyY;
      env.dust(sx + (Math.random() - 0.5) * 2, sy + 1, (Math.random() - 0.5) * 18, 8 + Math.random() * 10, 0.5 + Math.random() * 0.4, 0.7, 1);
    }
  }

  // ---- drawing ---------------------------------------------------------------------------------
  const off = { x: 0, y: 0 };
  // a few marks on the turning wax so the eye can see it go round
  const MARKS = [[0.12, 0.3], [0.31, 2.1], [0.47, 4.0], [0.6, 1.2], [0.74, 5.1], [0.88, 3.3], [0.22, 5.8], [0.66, 0.4]];
  function drawSpin(ctx, alpha, f) {
    ctx.strokeStyle = '#f3dfba';
    ctx.lineWidth = 0.7;
    for (let i = 0; i < MARKS.length; i++) {
      const ph = MARKS[i][1] + spin * TAU;
      const c = Math.cos(ph);
      if (c < 0.12) continue;
      const yy = -Math.sin(ph) * Dc * 0.46, xx = -Lc / 2 + 3 + MARKS[i][0] * (Lc - 6);
      ctx.globalAlpha = alpha * f * 0.6 * c;
      ctx.beginPath(); ctx.moveTo(xx, yy - c * 1.4); ctx.lineTo(xx + 0.3, yy + c * 1.4); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function drawCylinderAt(ctx, sp, cx, cy, alpha, f, spinning) {
    ctx.save(); ctx.translate(cx, cy);
    blit(ctx, sp, alpha * clamp01(f * 1.05));
    if (f < 0.985) { ctx.globalAlpha = alpha * (1 - f) * 0.9; ctx.fillStyle = '#0a0807'; ctx.fillRect(-Lc / 2, -Dc / 2, Lc, Dc); ctx.globalAlpha = 1; }
    if (spinning) drawSpin(ctx, alpha, f);
    ctx.restore();
  }

  function draw(ctx, lamp, alpha) {
    if (!spr || alpha <= 0.002) return;
    const S = game.view.plate.size;
    const f = lamp.at(x, y);
    const sa = lamp.shadowAt(x, y) * alpha * 0.7;
    const carX = x + cyX - Lc / 2 + Lc * st.prog, carY = y + cyY;
    const hornH = Pw * 0.6;
    // shadows on the felt: the rack, the box, then the raised horn
    const fr = lamp.at(rackX + Rw / 2, rackY + Rh / 2);
    ctx.save(); ctx.globalAlpha = lamp.shadowAt(rackX, rackY) * alpha * 0.45; ctx.fillStyle = '#000';
    lamp.offset(rackX + Rw / 2, rackY + Rh / 2, S * 0.012, off);
    ctx.fillRect(rackX + off.x + 1, rackY + off.y + 1.5, Bw, Rh); ctx.restore();
    ctx.save(); ctx.globalAlpha = sa * 0.6; ctx.fillStyle = '#000'; ctx.fillRect(x - Pw / 2 + 2, y + Pd / 2 + Pf - 2, Pw - 4, 4); ctx.restore();
    uprightShadow(ctx, spr.body.sh, lamp, x, y + Pd / 2 + Pf, Pd / 2 + Pf, Pf * 1.4, sa * 0.6);
    lamp.offset(carX, carY, hornH, off);
    ctx.save(); ctx.translate(carX + off.x, carY + off.y); ctx.rotate(th); blit(ctx, spr.horn.sh, sa * 0.5); ctx.restore();

    // the rack and its cylinders
    ctx.save(); ctx.translate(rackX, rackY); blitLit(ctx, spr.rack, null, alpha, 1); ctx.restore();
    if (fr < 0.985) { ctx.save(); ctx.globalAlpha = alpha * (1 - fr) * 0.92; ctx.fillStyle = '#0a0807'; ctx.fillRect(rackX, rackY, Bw, Rh); ctx.restore(); }
    const cs = cyls();
    for (let i = 0; i < slots.length && i < cs.length; i++) {
      const c = cs[i];
      if ((mode === 'play' && play.cyl === c) || (fly.on && fly.cyl === c)) continue;   // it is on the mandrel or in the hand
      slotPos(i, tmp);
      ctx.save(); ctx.translate(rackX, tmp.y);
      const lift = pressed === 'slot:' + i ? 0.6 : 0;
      if (lift) ctx.translate(0, -0.6);
      // over the felt the tag simply dims (no dark card behind it)
      blit(ctx, slots[i], alpha * clamp01(fr * (1.05 + lift * 0.15)));
      ctx.restore();
    }

    // the machine
    ctx.save(); ctx.translate(x, y);
    const sc = 1 - 0.01 * st.press; ctx.scale(sc, sc);
    blitLit(ctx, spr.body.lit, spr.body.dark, alpha, f);
    ctx.restore();
    // the cylinder on the mandrel: a blank, or the record being played
    const spinning = mode === 'rec' || (mode === 'play' && play.t >= 0);
    const onMandrel = mode === 'play' ? (play.t > -0.3 ? spr.waxRec : null) : spr.blank;
    if (onMandrel) drawCylinderAt(ctx, onMandrel, x + cyX, y + cyY, alpha * (mode === 'play' ? 1 : st.blank), f, spinning);
    // the groove already cut, brighter where the cutter has passed
    if (mode === 'rec' && st.prog > 0.005) {
      ctx.save(); ctx.globalAlpha = alpha * f * 0.22; ctx.fillStyle = '#ffe9c4';
      ctx.fillRect(x + cyX - Lc / 2 + 1, y + cyY - Dc * 0.36, Lc * st.prog - 1, Dc * 0.18); ctx.restore();
    }
    // the carriage arm from the back rod and the reproducer riding the wax
    const nz = 1 - st.needle;                      // lifted when 1
    const jit = spinning ? Math.sin((game.t || 0) * 71) * clamp01((mode === 'play' ? play.amp : game.field?.total || 0) * 1.5) * 0.5 : 0;
    const rpx = carX, rpy = carY - Dc * 0.05 - nz * Pw * 0.05 + jit;
    ctx.save();
    ctx.globalAlpha = alpha * Math.max(0.15, f);
    ctx.strokeStyle = '#0c0b0a'; ctx.lineWidth = Math.max(2, Pw * 0.03); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(carX, y + rodY); ctx.lineTo(rpx, rpy - Rr * 0.6); ctx.stroke();
    ctx.strokeStyle = '#5c5852'; ctx.lineWidth = Math.max(0.7, Pw * 0.009);
    ctx.beginPath(); ctx.moveTo(carX - 0.6, y + rodY); ctx.lineTo(rpx - 0.6, rpy - Rr * 0.6); ctx.stroke();
    ctx.fillStyle = '#2e2b27'; ctx.fillRect(carX - Pw * 0.045, y + rodY - 2.6, Pw * 0.09, 5.2);
    ctx.fillStyle = 'rgba(255,240,210,0.25)'; ctx.fillRect(carX - Pw * 0.045, y + rodY - 2.6, Pw * 0.09, 0.8);
    ctx.restore();
    lamp.offset(rpx, rpy, Pw * (0.03 + 0.07 * nz), off);
    ctx.save(); ctx.translate(rpx + off.x, rpy + off.y); blit(ctx, spr.reproSh, sa * 0.6); ctx.restore();
    ctx.save(); ctx.translate(rpx, rpy); const rs = 1 + 0.06 * nz; ctx.scale(rs, rs);
    blitLit(ctx, spr.repro, null, alpha, f);
    if (f < 0.985) { ctx.globalAlpha = alpha * (1 - f) * 0.9; ctx.fillStyle = '#0a0807'; ctx.beginPath(); ctx.arc(0, 0, Rr, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
    ctx.restore();
    // the crank on its side
    const ca = st.crank, cxp = x + crankX + Pw * 0.07, cyp = y + crankY;
    const ky = cyp + Math.cos(ca) * Ra, kx = cxp + Math.sin(ca) * Ra * 0.18;
    ctx.save(); ctx.globalAlpha = alpha * Math.max(0.12, f); ctx.lineCap = 'round';
    ctx.strokeStyle = '#1c1b1a'; ctx.lineWidth = Math.max(1.5, Pw * 0.02);
    ctx.beginPath(); ctx.moveTo(x + crankX, cyp); ctx.lineTo(cxp, cyp); ctx.lineTo(kx, ky); ctx.stroke();
    ctx.strokeStyle = '#6a6e72'; ctx.lineWidth = Math.max(0.6, Pw * 0.008);
    ctx.beginPath(); ctx.moveTo(x + crankX, cyp - 0.5); ctx.lineTo(cxp, cyp - 0.5); ctx.stroke();
    ctx.fillStyle = '#5a3820'; ctx.beginPath(); ctx.ellipse(kx + Pw * 0.035, ky, Pw * 0.035, Pw * 0.022, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = 'rgba(255,220,180,0.3)'; ctx.fillRect(kx + Pw * 0.02, ky - Pw * 0.012, Pw * 0.03, 0.7);
    ctx.restore();

    // the horn, raised above it all
    ctx.save(); ctx.translate(carX, carY); ctx.rotate(th);
    blitLit(ctx, spr.horn.lit, spr.horn.dark, alpha, f * 1.05);
    if (st.glow > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const flick = 0.75 + 0.25 * Math.sin((game.t || 0) * 23) * Math.sin((game.t || 0) * 7.3);
      blit(ctx, spr.horn.glow, alpha * st.glow * 0.22 * flick * (0.4 + 0.6 * lamp.intensity + 0.3));
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    drawWaves(ctx, lamp, alpha, carX, carY);
    drawFly(ctx, lamp, alpha);
  }

  // sound leaving the bell (playback), or gathered into it (recording): faint arcs in the air
  function drawWaves(ctx, lamp, alpha, cx, cy) {
    const playing = mode === 'play' && play.t >= 0;
    const k = playing ? clamp01(play.amp / 0.3) : mode === 'rec' ? clamp01((game.field?.total || 0) / 0.5) * 0.6 * st.needle : 0;
    if (k < 0.02 || env.reduced) return;
    const bx = cx + Math.cos(th) * (Hl + Rb * 0.25), by = cy + Math.sin(th) * (Hl + Rb * 0.25);
    const t = game.t || 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ffe8c0';
    ctx.lineWidth = 1;
    const I = 0.35 + 0.65 * lamp.intensity;
    for (let i = 0; i < 3; i++) {
      let ph = (t * 0.7 + i / 3) % 1;
      if (!playing) ph = 1 - ph;                     // gathered in
      const r = Rb * (0.5 + ph * 1.6);
      ctx.globalAlpha = alpha * k * I * 0.22 * (1 - ph) * Math.min(1, ph * 6);
      ctx.beginPath(); ctx.arc(bx, by, r, th - 0.75, th + 0.75); ctx.stroke();
    }
    ctx.restore();
  }

  // a cylinder being carried between the rack and the mandrel
  function drawFly(ctx, lamp, alpha) {
    if (!fly.on || !fly.cyl) return;
    const i = cyls().indexOf(fly.cyl);
    if (i < 0) return;
    const k = smooth(0, 1, fly.t / FLY_S);
    slotPos(i, tmp); const sx = tmp.x, sy = tmp.y;
    const mx = x + cyX, my = y + cyY;
    const a = fly.toRack ? k : 1 - k;          // 0 at the mandrel, 1 at the rack
    const px = lerp(mx, sx, a), py = lerp(my, sy, a);
    const lift = Math.sin(Math.PI * a);
    const S = game.view.plate.size;
    lamp.offset(px, py, S * 0.12 * lift + 2, off);
    const f = lamp.at(px, py);
    // upright near the rack, lying near the mandrel: blend the two views
    ctx.save();
    ctx.globalAlpha = lamp.shadowAt(px, py) * alpha * 0.35; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(px + off.x, py + off.y, lerp(Lc / 2, rc, a), lerp(Dc / 2, rc, a), 0, 0, TAU); ctx.fill();
    ctx.restore();
    const sc = 1 + 0.1 * lift;
    if (a < 0.5) {
      ctx.save(); ctx.translate(px, py - lift * 6); ctx.scale(sc * lerp(1, rc * 2 / Lc, a * 2), sc);
      blit(ctx, spr.waxRec, alpha * clamp01(f * 1.05) * (1 - a * 0.6));
      ctx.restore();
    }
    if (a >= 0.35) {
      ctx.save(); ctx.translate(px, py - lift * 6); ctx.scale(sc, sc);
      ctx.globalAlpha = alpha * clamp01((a - 0.35) / 0.3) * Math.max(0.15, f);
      ctx.beginPath(); ctx.arc(0, 0, rc, 0, TAU);
      const wg = ctx.createRadialGradient(-rc * 0.35, -rc * 0.4, rc * 0.1, 0, 0, rc);
      wg.addColorStop(0, '#b48a5c'); wg.addColorStop(0.5, '#5e3d22'); wg.addColorStop(1, '#24150b');
      ctx.fillStyle = wg; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, rc * 0.52, 0, TAU); ctx.fillStyle = '#0b0705'; ctx.fill();
      ctx.restore();
    }
  }

  function cursor(px, py) { return hit(px, py, false) ? 'pointer' : null; }

  return {
    layout, update, draw, hit, press, release, click, cursor,
    record: startRecord, stopRecord, play: startPlay, stop() { if (mode === 'rec') stopRecord(); else if (mode === 'play') stopPlay(); },
    get mode() { return mode; },
    get pos() { return { x, y, th, rackX, rackY, Rw, Rh, slotH, Pw }; },
    pub,
  };
}
