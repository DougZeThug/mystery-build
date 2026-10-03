// The things around the plate: the sand jar, the field notebook, the pull-cord, the cabinet drawer
// (felt-lined tray of dampers and tuning forks). The phonograph lives in tools-phono.js.
// Each object: layout() on resize (bakes its sprites), update(dt, pointer?), draw(ctx, lamp, alpha),
// hit(x, y, touch) for the pointer router in tools.js.
import * as Modes from '../sim/modes.js';
import { clamp, clamp01, smooth, lerp, TAU, SIDES, toPlateInto, toScreenInto, bake, bakeShadow, bakeTint, blit, blitLit, seeded, speckle, mottle,
  roundRectPath, spring, springAngle, makeCanvas } from './tools-art.js';

const EMPTY = [];

// ---- shared bits ------------------------------------------------------------------------------------
// Shadow of an upright object standing on the felt: its silhouette stretched along the felt, away
// from the lamp, from its base point (bx, by). `hgt` is the object's height in px.
export function uprightShadow(ctx, sh, lamp, bx, by, baseY, hgt, alpha) {
  const k = 1 / Math.max(1, lamp.z - hgt);
  const dvx = (bx - lamp.x) * k, dvy = (by - lamp.y) * k;
  ctx.save();
  ctx.translate(bx, by);
  // local y above the base (negative) maps along the light direction; a little squash keeps depth
  ctx.transform(1, 0, -dvx, -dvy + 0.16, 0, 0);
  ctx.translate(0, -baseY);
  blit(ctx, sh, alpha);
  ctx.restore();
}

export function woodGrain(g, rnd, x, y, w, h, base, dark, light, horizontal = true, n = 40) {
  g.fillStyle = base; g.fillRect(x, y, w, h);
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  for (let i = 0; i < n; i++) {
    g.strokeStyle = rnd() < 0.65 ? dark : light;
    g.globalAlpha = 0.12 + rnd() * 0.22;
    g.lineWidth = 0.4 + rnd() * 1.1;
    g.beginPath();
    if (horizontal) {
      const yy = y + rnd() * h, amp = 0.5 + rnd() * 2.5, fr = 0.01 + rnd() * 0.03, ph = rnd() * 6;
      for (let xx = x; xx <= x + w; xx += 4) g[xx === x ? 'moveTo' : 'lineTo'](xx, yy + Math.sin(xx * fr + ph) * amp);
    } else {
      const xx0 = x + rnd() * w, amp = 0.5 + rnd() * 2.5, fr = 0.01 + rnd() * 0.03, ph = rnd() * 6;
      for (let yy = y; yy <= y + h; yy += 4) g[yy === y ? 'moveTo' : 'lineTo'](xx0 + Math.sin(yy * fr + ph) * amp, yy);
    }
    g.stroke();
  }
  g.restore(); g.globalAlpha = 1;
}

export function brassGrad(g, x0, y0, x1, y1) {
  const b = g.createLinearGradient(x0, y0, x1, y1);
  b.addColorStop(0, '#5e4416'); b.addColorStop(0.3, '#e9cd85'); b.addColorStop(0.55, '#b48a3c'); b.addColorStop(1, '#4a3410');
  return b;
}

// ===================================================================================================
// SAND JAR — a stoppered specimen jar; a goose quill through the cork is its pouring spout.
// ===================================================================================================
export function createJar(env) {
  const { game, lamp } = env;
  const JAR_MAX = 8000, POUR_RATE = 300;
  const SN = 320;
  const sx = new Float32Array(SN), sy = new Float32Array(SN), svx = new Float32Array(SN), svy = new Float32Array(SN);
  const sl = new Float32Array(SN), sland = new Float32Array(SN);
  let sHead = 0, sAcc = 0;

  let Jw = 80, Jh = 114, spr = null, interior = null, sandPat = null;
  let restX = 0, restY = 0, side = 1;
  const pose = { x: 0, y: 0, a: 0, vx: 0, vy: 0, va: 0, lift: 0, vlift: 0, pour: 0, vpour: 0 };
  let heldBy = -1, glx = 0, gly = 0, lifted = false, returning = false;
  let lastPx = 0, lastPy = 0, vpx = 0;
  let reserve = Number.isFinite(env.saved.jar) ? clamp(env.saved.jar, 0, JAR_MAX) : JAR_MAX * 0.85;
  let pourAcc = 0, pourEvAcc = 0, pourEvT = 0, pouring = false, landX = 0, landY = 0;
  const pourEv = { u: 0, v: 0, n: 0 };
  // sand-level polygon scratch
  const RX = new Float64Array(4), RY = new Float64Array(4), PX = new Float64Array(10), PY = new Float64Array(10);
  let PN = 0, cutAx = 0, cutAy = 0, cutBx = 0, cutBy = 0;
  const Q = { x: 0, y: 0 };      // quill tip, local
  const tmp = { x: 0, y: 0 }, uv = { u: 0, v: 0 };

  function bodyPath(g, inset) {
    const w = Jw / 2 - inset, nk = Jw * 0.33 - inset, top = -0.40 * Jh, sh = -0.30 * Jh, bot = 0.48 * Jh - inset;
    g.moveTo(-nk, top);
    g.lineTo(-nk, sh);
    g.quadraticCurveTo(-w, sh, -w, -0.18 * Jh);
    g.lineTo(-w, 0.40 * Jh);
    g.quadraticCurveTo(-w, bot, -w + Jw * 0.13, bot);
    g.lineTo(w - Jw * 0.13, bot);
    g.quadraticCurveTo(w, bot, w, 0.40 * Jh);
    g.lineTo(w, -0.18 * Jh);
    g.quadraticCurveTo(w, sh, nk, sh);
    g.lineTo(nk, top);
    g.closePath();
  }

  let bakedKey = '';
  function layout(force = false) {
    const v = game.view, S = v.plate.size, dpr = v.dpr || 1;
    Jw = Math.round(clamp(S * 0.145, 44, 96)); Jh = Math.round(Jw * 1.42);
    const an = v.anchors?.jar || { x: v.plate.x - S * 0.34, y: v.plate.y + S * 0.2 };
    restX = an.x; restY = an.y;
    side = restX < v.plate.cx ? 1 : -1;
    if (heldBy < 0 && !lifted) { pose.x = restX; pose.y = restY; pose.a = 0; }
    // the glass, cork and sand are baked at this size once
    const key = `${Jw}|${dpr}`;
    if (!force && key === bakedKey && spr) return;
    bakedKey = key;
    Q.x = Jw * 0.13; Q.y = -0.665 * Jh;
    interior = new Path2D(); bodyPath(interior, Jw * 0.055);
    RX[0] = -Jw * 0.45; RY[0] = -0.40 * Jh; RX[1] = Jw * 0.45; RY[1] = -0.40 * Jh;
    RX[2] = Jw * 0.45; RY[2] = 0.45 * Jh; RX[3] = -Jw * 0.45; RY[3] = 0.45 * Jh;
    // sand texture (a pattern in local space)
    const pc = makeCanvas(48 * dpr, 48 * dpr), pg = pc.getContext('2d'), rnd = seeded(77);
    pg.scale(dpr, dpr);
    pg.fillStyle = '#d9c59c'; pg.fillRect(0, 0, 48, 48);
    speckle(pg, rnd, 0, 0, 48, 48, 600, '#f6ead0', 0.35, 0.9, 0.5, 1.1);
    speckle(pg, rnd, 0, 0, 48, 48, 300, '#9a8460', 0.25, 0.7, 0.5, 1);
    speckle(pg, rnd, 0, 0, 48, 48, 50, '#fff8e6', 0.6, 1, 0.6, 1);
    const g0 = makeCanvas(1, 1).getContext('2d');
    sandPat = g0.createPattern(pc, 'repeat');
    if (sandPat && sandPat.setTransform && typeof DOMMatrix !== 'undefined') sandPat.setTransform(new DOMMatrix().scale(1 / dpr));

    const ox = Jw * 0.75, oy = Jh * 0.78, W = Jw * 1.5, H = Jh * 1.42;
    const glass = bake(W, H, ox, oy, dpr, (g) => {
      // faint body of old greenish glass
      g.beginPath(); bodyPath(g, 0); g.fillStyle = 'rgba(200,225,210,0.035)'; g.fill();
      // refraction bands along the walls
      g.save(); g.beginPath(); bodyPath(g, 0); g.clip();
      g.lineWidth = Jw * 0.1; g.strokeStyle = 'rgba(215,236,224,0.13)'; g.beginPath(); bodyPath(g, 0); g.stroke();
      const hl = g.createLinearGradient(0, -0.2 * Jh, 0, 0.42 * Jh);
      hl.addColorStop(0, 'rgba(255,255,250,0)'); hl.addColorStop(0.18, 'rgba(255,255,250,0.42)'); hl.addColorStop(0.75, 'rgba(255,255,250,0.28)'); hl.addColorStop(1, 'rgba(255,255,250,0)');
      g.fillStyle = hl; g.fillRect(-Jw * 0.39, -0.2 * Jh, Jw * 0.075, 0.62 * Jh);
      g.globalAlpha = 0.5; g.fillRect(-Jw * 0.28, -0.12 * Jh, Jw * 0.02, 0.5 * Jh); g.globalAlpha = 1;
      const hr = g.createLinearGradient(0, -0.15 * Jh, 0, 0.4 * Jh);
      hr.addColorStop(0, 'rgba(255,255,250,0)'); hr.addColorStop(0.4, 'rgba(255,255,250,0.55)'); hr.addColorStop(1, 'rgba(255,255,250,0)');
      g.fillStyle = hr; g.fillRect(Jw * 0.34, -0.15 * Jh, Jw * 0.028, 0.55 * Jh);
      // thick base
      g.beginPath(); g.ellipse(0, 0.44 * Jh, Jw * 0.46, Jw * 0.07, 0, 0, TAU); g.fillStyle = 'rgba(110,140,120,0.28)'; g.fill();
      g.beginPath(); g.ellipse(0, 0.445 * Jh, Jw * 0.4, Jw * 0.045, 0, 0, Math.PI); g.strokeStyle = 'rgba(235,250,240,0.35)'; g.lineWidth = 0.8; g.stroke();
      g.restore();
      // outline: the glass edge reads dark with a bright inner rim
      g.beginPath(); bodyPath(g, 0); g.strokeStyle = 'rgba(14,20,17,0.45)'; g.lineWidth = 1.1; g.stroke();
      g.beginPath(); bodyPath(g, 1.4); g.strokeStyle = 'rgba(225,240,232,0.22)'; g.lineWidth = 0.7; g.stroke();
      // the lamp's reflection on the shoulder
      g.fillStyle = 'rgba(255,250,235,0.85)';
      g.beginPath(); g.ellipse(-Jw * 0.3, -0.235 * Jh, Jw * 0.06, Jw * 0.025, -0.5, 0, TAU); g.fill();
      // the lip: a thick rolled rim
      g.beginPath(); g.ellipse(0, -0.405 * Jh, Jw * 0.385, Jw * 0.07, 0, 0, TAU);
      g.strokeStyle = 'rgba(200,225,210,0.45)'; g.lineWidth = Jw * 0.05; g.stroke();
      g.strokeStyle = 'rgba(255,255,250,0.5)'; g.lineWidth = 0.7;
      g.beginPath(); g.ellipse(0, -0.41 * Jh, Jw * 0.385, Jw * 0.07, 0, Math.PI * 1.05, Math.PI * 1.7); g.stroke();
    });
    const solid = bake(W, H, ox, oy, dpr, (g) => {
      const rnd = seeded(31);
      // cork: slightly tapered, pitted
      const cT = -0.535 * Jh, cB = -0.405 * Jh, wT = Jw * 0.315, wB = Jw * 0.29;
      g.beginPath(); g.moveTo(-wB, cB); g.lineTo(-wT, cT); g.ellipse(0, cT, wT, Jw * 0.06, 0, Math.PI, 0, false); g.lineTo(wB, cB);
      g.ellipse(0, cB, wB, Jw * 0.055, 0, 0, Math.PI, false); g.closePath();
      const cg = g.createLinearGradient(-wT, 0, wT, 0);
      cg.addColorStop(0, '#c49a64'); cg.addColorStop(0.45, '#a87e4c'); cg.addColorStop(1, '#6a4c2b');
      g.fillStyle = cg; g.fill();
      g.save(); g.clip();
      speckle(g, rnd, -wT, cT - 6, wT * 2, cB - cT + 12, 260, '#5a3e22', 0.35, 0.85, 0.5, 1.5);
      speckle(g, rnd, -wT, cT - 6, wT * 2, cB - cT + 12, 120, '#dcb985', 0.3, 0.7, 0.4, 1.1);
      g.restore();
      g.beginPath(); g.ellipse(0, cT, wT, Jw * 0.06, 0, 0, TAU);
      g.fillStyle = '#b88f5b'; g.fill();
      g.save(); g.clip(); speckle(g, rnd, -wT, cT - 8, wT * 2, 16, 160, '#6b4b2a', 0.3, 0.8, 0.5, 1.4); g.restore();
      g.strokeStyle = 'rgba(60,40,20,0.6)'; g.lineWidth = 0.6; g.stroke();
      // the quill
      g.lineCap = 'round';
      g.strokeStyle = '#d9d2c2'; g.lineWidth = Jw * 0.05;
      g.beginPath(); g.moveTo(Jw * 0.03, cT + 1); g.quadraticCurveTo(Jw * 0.07, -0.6 * Jh, Q.x, Q.y); g.stroke();
      g.strokeStyle = 'rgba(255,255,248,0.8)'; g.lineWidth = Jw * 0.014;
      g.beginPath(); g.moveTo(Jw * 0.02, cT); g.quadraticCurveTo(Jw * 0.06, -0.6 * Jh, Q.x - 1, Q.y + 1); g.stroke();
      g.fillStyle = '#2a241c'; g.beginPath(); g.ellipse(Q.x, Q.y, Jw * 0.022, Jw * 0.012, -0.9, 0, TAU); g.fill();
      // a paper tag on a twist of twine
      g.strokeStyle = '#8c7a5c'; g.lineWidth = 0.8;
      g.beginPath(); g.ellipse(0, -0.335 * Jh, Jw * 0.34, Jw * 0.05, 0, 0.1, Math.PI - 0.1); g.stroke();
      g.beginPath(); g.moveTo(Jw * 0.3, -0.32 * Jh); g.quadraticCurveTo(Jw * 0.42, -0.26 * Jh, Jw * 0.4, -0.2 * Jh); g.stroke();
      g.save(); g.translate(Jw * 0.4, -0.2 * Jh); g.rotate(0.22);
      g.beginPath(); roundRectPath(g, -Jw * 0.1, 0, Jw * 0.2, Jw * 0.27, 1.5); g.fillStyle = '#e4d6b4'; g.fill();
      g.strokeStyle = 'rgba(90,70,40,0.5)'; g.lineWidth = 0.5; g.stroke();
      g.fillStyle = 'rgba(120,90,50,0.25)'; g.fillRect(-Jw * 0.1, Jw * 0.2, Jw * 0.2, Jw * 0.07);
      g.beginPath(); g.arc(0, Jw * 0.04, Jw * 0.018, 0, TAU); g.fillStyle = '#3a2e20'; g.fill();
      g.strokeStyle = 'rgba(70,60,60,0.55)'; g.lineWidth = 0.55;
      g.beginPath(); g.moveTo(-Jw * 0.06, Jw * 0.11); g.bezierCurveTo(-Jw * 0.02, Jw * 0.09, Jw * 0.01, Jw * 0.13, Jw * 0.06, Jw * 0.1); g.stroke();
      g.beginPath(); g.moveTo(-Jw * 0.06, Jw * 0.16); g.bezierCurveTo(-Jw * 0.03, Jw * 0.15, 0, Jw * 0.175, Jw * 0.03, Jw * 0.16); g.stroke();
      g.restore();
    });
    const sil = bake(W, H, ox, oy, dpr, (g) => { g.beginPath(); bodyPath(g, 0); g.fillStyle = '#000'; g.fill(); g.drawImage(solid.cv, -ox, -oy, W, H); });
    spr = { glass, solid, dark: bakeTint(solid, '#0d0a08'), sh: bakeShadow(sil, Math.max(2, Jw * 0.05)), shSoft: bakeShadow(sil, Math.max(5, Jw * 0.14)) };
  }

  function localOf(px, py, o) {
    const dx = px - pose.x, dy = py - pose.y, c = Math.cos(pose.a), s = Math.sin(pose.a);
    o.x = dx * c + dy * s; o.y = -dx * s + dy * c; return o;
  }
  function hit(px, py, touch) {
    const pad = touch ? 14 : 6;
    localOf(px, py, tmp);
    return tmp.x > -Jw * 0.52 - pad && tmp.x < Jw * 0.52 + pad && tmp.y > -0.6 * Jh - pad && tmp.y < 0.5 * Jh + pad;
  }
  function pickUp(id, px, py) {
    heldBy = id; lifted = true; returning = false;
    localOf(px, py, tmp); glx = tmp.x; gly = tmp.y;
    lastPx = px; lastPy = py; vpx = 0;
    env.emit('sfx', { name: 'glass', pan: env.panOf(px), soft: true });
  }
  function drop() { heldBy = -1; returning = true; pouring = false; flushPour(); }

  const avail = () => {
    const room = game.sand ? Math.max(0, (game.sand.cap || 26000) - (game.sand.n || 0)) : JAR_MAX;
    return Math.min(reserve, room);
  };

  function flushPour() {
    if (pourEvAcc > 0) { pourEv.n = pourEvAcc; env.emit('sand:pour', pourEv); pourEvAcc = 0; }
  }

  function update(dt, ptr) {
    const S = game.view.plate.size;
    let tx = restX, ty = restY, ta = 0, tl = 0, tp = 0, wP = 14;
    if (heldBy >= 0 && ptr) {
      const ivx = (ptr.x - lastPx) / Math.max(dt, 1e-3);
      vpx += (ivx - vpx) * Math.min(1, dt * 10);
      lastPx = ptr.x; lastPy = ptr.y;
      const over = env.plateHit(ptr.x, ptr.y, -2);
      tp = over ? 1 : 0;
      const swing = clamp(-vpx * 0.0004, -0.3, 0.3);
      ta = side * (0.08 + 1.88 * smooth(0.05, 0.9, pose.pour)) + swing * (1 - pose.pour);
      const c = Math.cos(pose.a), s = Math.sin(pose.a);
      const fx = ptr.x - (c * glx - s * gly), fy = ptr.y - (s * glx + c * gly);
      const fall = Jh * 0.62;
      const qx = ptr.x - (c * Q.x - s * Q.y), qy = ptr.y - fall - (s * Q.x + c * Q.y);
      const w = smooth(0, 1, pose.pour);
      tx = lerp(fx, qx, w); ty = lerp(fy, qy, w);
      tl = 1; wP = 17;
      landX = ptr.x; landY = ptr.y;
    }
    spring(pose, 'pour', 'vpour', tp, 6, dt);
    spring(pose, 'x', 'vx', tx, wP, dt);
    spring(pose, 'y', 'vy', ty, wP, dt);
    springAngle(pose, 'a', 'va', ta, heldBy >= 0 ? 9 : 8, dt);
    spring(pose, 'lift', 'vlift', tl, 10, dt);

    if (returning && Math.hypot(pose.x - restX, pose.y - restY) < 1 && Math.abs(pose.a) < 0.01) {
      returning = false; lifted = false;
      env.emit('sfx', { name: 'glass', pan: env.panOf(pose.x) });
    }

    // pouring: the jar is tipped over the plate and there is sand to give
    const have = avail();
    pouring = heldBy >= 0 && pose.pour > 0.85 && Math.abs(pose.a) > 1.55 && have > 1;
    const c = Math.cos(pose.a), s = Math.sin(pose.a);
    const qwx = pose.x + c * Q.x - s * Q.y, qwy = pose.y + s * Q.x + c * Q.y;
    if (pouring) {
      pourAcc += POUR_RATE * dt;
      const n = Math.min(Math.floor(pourAcc), Math.floor(have));
      if (n > 0) {
        pourAcc -= n;
        toPlateInto(game.view, landX, landY, uv);
        const added = game.sand?.pour ? game.sand.pour(uv.u, uv.v, n, 0, 0.024) : 0;
        reserve = Math.max(0, reserve - (added || 0));
        pourEvAcc += added || 0; pourEv.u = uv.u; pourEv.v = uv.v;
      }
      pourEvT += dt;
      if (pourEvT > 0.12) { pourEvT = 0; flushPour(); }
      // the visible stream
      sAcc += dt * (env.reduced ? 90 : 240);
      while (sAcc > 1) {
        sAcc -= 1;
        const i = sHead; sHead = (sHead + 1) % SN;
        sx[i] = qwx + (Math.random() - 0.5) * 1.6; sy[i] = qwy + (Math.random() - 0.5) * 1.2;
        svx[i] = (Math.random() - 0.5) * 10 + side * 14; svy[i] = 20 + Math.random() * 40;
        sl[i] = 1.5; sland[i] = landY + (Math.random() - 0.5) * 5;
      }
    } else { pourAcc = 0; if (pourEvAcc) flushPour(); }
    if (!pouring && heldBy < 0) reserve = Math.min(JAR_MAX, reserve + 22 * dt);
    env.saved.jar = Math.round(reserve);

    // stream grains fall and land
    const g = 2400 * (S / 576);
    for (let i = 0; i < SN; i++) {
      if (sl[i] <= 0) continue;
      sl[i] -= dt;
      svy[i] += g * dt;
      sx[i] += svx[i] * dt; sy[i] += svy[i] * dt;
      if (sy[i] >= sland[i]) {
        sl[i] = 0;
        if (Math.random() < 0.18) env.dust(sx[i], sland[i], (Math.random() - 0.5) * 40, -10 - Math.random() * 30, 0.35 + Math.random() * 0.3, 0.9 + Math.random() * 0.7, 1);
      }
    }
  }

  // sand-level polygon: the part of the jar's inner rectangle below a world-horizontal line
  function clipBelow(gx, gy, c) {
    PN = 0; let cut = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) & 3;
      const ai = RX[i] * gx + RY[i] * gy - c, aj = RX[j] * gx + RY[j] * gy - c;
      if (ai >= 0) { PX[PN] = RX[i]; PY[PN] = RY[i]; PN++; }
      if ((ai >= 0) !== (aj >= 0)) {
        const t = ai / (ai - aj);
        const x = RX[i] + (RX[j] - RX[i]) * t, y = RY[i] + (RY[j] - RY[i]) * t;
        PX[PN] = x; PY[PN] = y; PN++;
        if (cut === 0) { cutAx = x; cutAy = y; } else { cutBx = x; cutBy = y; }
        cut++;
      }
    }
    let A = 0;
    for (let i = 0; i < PN; i++) { const j = (i + 1) % PN; A += PX[i] * PY[j] - PX[j] * PY[i]; }
    return Math.abs(A) * 0.5;
  }

  function drawSand(ctx, alpha, f) {
    const fill = clamp01(avail() / JAR_MAX);
    if (fill < 0.004 || !sandPat) return;
    const gx = Math.sin(pose.a), gy = Math.cos(pose.a);
    let lo = 1e9, hi = -1e9;
    for (let i = 0; i < 4; i++) { const d = RX[i] * gx + RY[i] * gy; if (d < lo) lo = d; if (d > hi) hi = d; }
    const total = (RX[1] - RX[0]) * (RY[2] - RY[1]);
    const want = fill * total;
    let a = lo, b = hi;
    for (let it = 0; it < 18; it++) { const m = (a + b) * 0.5; if (clipBelow(gx, gy, m) > want) a = m; else b = m; }
    clipBelow(gx, gy, (a + b) * 0.5);
    if (PN < 3) return;
    ctx.save();
    ctx.clip(interior);
    ctx.beginPath();
    for (let i = 0; i < PN; i++) ctx[i ? 'lineTo' : 'moveTo'](PX[i], PY[i]);
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = sandPat; ctx.fill();
    // the surface catches the light
    const mx = (cutAx + cutBx) * 0.5, my = (cutAy + cutBy) * 0.5;
    const hl = Math.hypot(cutBx - cutAx, cutBy - cutAy) * 0.5;
    ctx.fillStyle = '#e8dab8';
    ctx.globalAlpha = alpha * 0.55;
    ctx.beginPath(); ctx.ellipse(mx, my, hl, Jw * 0.06, Math.atan2(cutBy - cutAy, cutBx - cutAx), 0, TAU); ctx.fill();
    // shading toward the bottom of the pile
    ctx.globalAlpha = alpha * 0.18; ctx.fillStyle = '#3a2c18';
    ctx.beginPath(); for (let i = 0; i < PN; i++) ctx[i ? 'lineTo' : 'moveTo'](PX[i], PY[i]); ctx.closePath();
    ctx.lineWidth = Jw * 0.12; ctx.strokeStyle = '#3a2c18'; ctx.stroke();
    if (f < 0.985) { ctx.globalAlpha = alpha * (1 - f); ctx.fillStyle = '#0a0806'; ctx.fillRect(-Jw, -Jh, Jw * 2, Jh * 2); }
    ctx.restore();
  }

  function draw(ctx, lamp, alpha) {
    if (!spr || alpha <= 0.002) return;
    const f = lamp.at(pose.x, pose.y);
    const S = game.view.plate.size;
    const sa = lamp.shadowAt(pose.x, pose.y) * alpha;
    if (pose.lift < 0.05) {
      // standing: a stretched shadow and contact darkness at the base
      ctx.save();
      ctx.globalAlpha = sa * 0.55; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(pose.x, pose.y + 0.47 * Jh, Jw * 0.5, Jw * 0.1, 0, 0, TAU); ctx.fill();
      ctx.restore();
      uprightShadow(ctx, spr.sh, lamp, pose.x, pose.y + 0.47 * Jh, 0.47 * Jh, Jh, sa * 0.6);
    } else {
      const h = S * 0.18 * pose.lift;
      const o = lamp.offset(pose.x, pose.y, h, tmp);
      ctx.save(); ctx.translate(pose.x + o.x, pose.y + o.y); ctx.rotate(pose.a);
      blit(ctx, spr.shSoft, sa * 0.5 * (0.5 + 0.5 * (1 - pose.lift)));
      ctx.restore();
    }
    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.a);
    const sc = 1 + 0.04 * pose.lift;
    ctx.scale(sc, sc);
    drawSand(ctx, alpha, f);
    blit(ctx, spr.glass, alpha * clamp01(f * 1.05));
    blitLit(ctx, spr.solid, spr.dark, alpha, f);
    ctx.restore();
  }

  function drawStream(ctx, lamp) {
    const I = 0.2 + 0.8 * lamp.intensity;
    if (pouring) {
      const c = Math.cos(pose.a), s = Math.sin(pose.a);
      const qwx = pose.x + c * Q.x - s * Q.y, qwy = pose.y + s * Q.x + c * Q.y;
      ctx.globalAlpha = 0.28 * I;
      ctx.strokeStyle = '#e6d9bc'; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(qwx, qwy); ctx.quadraticCurveTo(qwx + side * 6, qwy + (landY - qwy) * 0.3, landX, landY); ctx.stroke();
    }
    ctx.fillStyle = '#f2e8cf';
    for (let i = 0; i < SN; i++) {
      if (sl[i] <= 0) continue;
      ctx.globalAlpha = (i & 1 ? 0.9 : 0.55) * I;
      const len = Math.min(5, svy[i] * 0.008 + 0.8);
      ctx.fillRect(sx[i] - 0.45, sy[i] - len, 0.9, len);
    }
    ctx.globalAlpha = 1;
  }

  return {
    layout, update, draw, drawStream, hit, pickUp, drop,
    get heldBy() { return heldBy; }, get lifted() { return lifted; }, get pouring() { return pouring; },
    get reserve() { return reserve; }, set reserve(v) { reserve = clamp(+v || 0, 0, JAR_MAX); },
    pose,
  };
}

// ===================================================================================================
// NOTEBOOK — a small worn leather field book with a silk ribbon and a pencil.
// ===================================================================================================
export function createBook(env) {
  const { game } = env;
  let Bw = 100, Bh = 142, spr = null, rx = 0, ry = 0, ra = 0, slipH = 30;
  const st = { lift: 0, vlift: 0, press: 0, vpress: 0, slip: 0, vslip: 0 };
  let hovering = false, pressed = false;
  const tmp = { x: 0, y: 0 };

  let bakedKey = '';
  function layout(force = false) {
    const v = game.view, S = v.plate.size, dpr = v.dpr || 1;
    Bw = Math.round(clamp(S * 0.2, 64, 132)); Bh = Math.round(Bw * 1.42);
    const an = v.anchors?.journal || { x: v.plate.x - S * 0.36, y: v.plate.y + S * 0.78 };
    rx = an.x; ry = an.y; ra = v.mode === 'landscape' ? -0.16 : 0.12;
    const key = `${Bw}|${dpr}`;
    if (!force && key === bakedKey && spr) return;
    bakedKey = key;
    const W = Bw * 1.5, H = Bh * 1.5, ox = W / 2, oy = H / 2 - Bh * 0.08;
    const rnd = seeded(1891);
    const lit = bake(W, H, ox, oy, dpr, (g) => {
      const x0 = -Bw / 2, y0 = -Bh / 2;
      // the ribbon, under the cover, trailing out of the tail
      g.save();
      g.translate(x0 + Bw * 0.64, y0 + Bh - 3);
      g.beginPath();
      g.moveTo(-Bw * 0.035, 0);
      g.bezierCurveTo(-Bw * 0.04, Bh * 0.08, Bw * 0.04, Bh * 0.12, Bw * 0.02, Bh * 0.2);
      g.lineTo(Bw * 0.035, Bh * 0.235); g.lineTo(Bw * 0.06, Bh * 0.19);
      g.bezierCurveTo(Bw * 0.1, Bh * 0.12, Bw * 0.03, Bh * 0.07, Bw * 0.035, 0);
      g.closePath();
      g.fillStyle = '#76261f'; g.fill();
      g.strokeStyle = 'rgba(210,120,100,0.35)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(0, 2); g.bezierCurveTo(0, Bh * 0.08, Bw * 0.06, Bh * 0.12, Bw * 0.04, Bh * 0.19); g.stroke();
      g.restore();
      // page block (a sliver of cream at the fore-edge and tail)
      g.beginPath(); roundRectPath(g, x0 + 2.5, y0 + 2.5, Bw - 1.5, Bh - 1.5, 2);
      g.fillStyle = '#d8ccae'; g.fill();
      g.strokeStyle = 'rgba(120,100,70,0.5)'; g.lineWidth = 0.4;
      for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(x0 + Bw + 0.2 - i * 0.5, y0 + 6); g.lineTo(x0 + Bw + 0.2 - i * 0.5, y0 + Bh - 2); g.stroke(); }
      // the cover
      g.beginPath(); roundRectPath(g, x0, y0, Bw, Bh, 3.5);
      g.fillStyle = '#4b2c1a'; g.fill();
      g.save(); g.beginPath(); roundRectPath(g, x0, y0, Bw, Bh, 3.5); g.clip();
      mottle(g, rnd, x0, y0, Bw, Bh, 50, '#2c180d', 0.08, 0.22, Bw * 0.05, Bw * 0.22);
      mottle(g, rnd, x0, y0, Bw, Bh, 36, '#6c4428', 0.06, 0.18, Bw * 0.04, Bw * 0.16);
      speckle(g, rnd, x0, y0, Bw, Bh, 900, '#1d0f07', 0.15, 0.4, 0.4, 1);
      speckle(g, rnd, x0, y0, Bw, Bh, 380, '#8a6040', 0.1, 0.3, 0.4, 0.9);
      // rubbed corners and edges: the leather wears pale where it is handled
      const corner = (cx, cy, r) => {
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, r);
        rg.addColorStop(0, 'rgba(140,98,62,0.75)'); rg.addColorStop(0.5, 'rgba(118,80,50,0.35)'); rg.addColorStop(1, 'rgba(118,80,50,0)');
        g.fillStyle = rg; g.fillRect(cx - r, cy - r, r * 2, r * 2);
      };
      corner(x0 + Bw, y0, Bw * 0.2); corner(x0 + Bw, y0 + Bh, Bw * 0.26); corner(x0, y0 + Bh, Bw * 0.14); corner(x0, y0, Bw * 0.1);
      g.strokeStyle = 'rgba(150,108,70,0.35)'; g.lineWidth = 2.2;
      g.beginPath(); roundRectPath(g, x0 + 0.5, y0 + 0.5, Bw - 1, Bh - 1, 3); g.stroke();
      // the lamp's sheen across the boards, and the hinge crease beside the spine
      const shn = g.createLinearGradient(x0, y0, x0 + Bw, y0 + Bh);
      shn.addColorStop(0, 'rgba(255,215,170,0.13)'); shn.addColorStop(0.45, 'rgba(255,215,170,0.02)'); shn.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = shn; g.fillRect(x0, y0, Bw, Bh);
      g.strokeStyle = 'rgba(170,125,85,0.35)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x0 + Bw * 0.155, y0 + 2); g.lineTo(x0 + Bw * 0.152, y0 + Bh - 2); g.stroke();
      g.strokeStyle = 'rgba(10,5,2,0.45)'; g.lineWidth = 0.8;
      g.beginPath(); g.moveTo(x0 + Bw * 0.165, y0 + 2); g.lineTo(x0 + Bw * 0.162, y0 + Bh - 2); g.stroke();
      // pebbled grain
      for (let i = 0; i < 700; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(20,10,4,0.22)' : 'rgba(150,108,70,0.12)';
        g.beginPath(); g.ellipse(x0 + rnd() * Bw, y0 + rnd() * Bh, 0.5 + rnd() * 0.9, 0.4 + rnd() * 0.6, rnd() * 3, 0, TAU); g.fill();
      }
      // scuffs
      for (let i = 0; i < 9; i++) {
        g.strokeStyle = rnd() < 0.5 ? 'rgba(160,120,85,0.3)' : 'rgba(20,10,5,0.35)'; g.lineWidth = 0.5 + rnd() * 0.6;
        const sx = x0 + rnd() * Bw, sy = y0 + rnd() * Bh, l = 3 + rnd() * 12, an2 = rnd() * Math.PI;
        g.beginPath(); g.moveTo(sx, sy); g.quadraticCurveTo(sx + Math.cos(an2) * l * 0.5 + 2, sy + Math.sin(an2) * l * 0.5, sx + Math.cos(an2) * l, sy + Math.sin(an2) * l); g.stroke();
      }
      // spine with raised bands
      const sw = Bw * 0.13;
      const sg = g.createLinearGradient(x0, 0, x0 + sw, 0);
      sg.addColorStop(0, 'rgba(15,7,3,0.65)'); sg.addColorStop(0.55, 'rgba(70,40,22,0.25)'); sg.addColorStop(0.85, 'rgba(15,7,3,0.5)'); sg.addColorStop(1, 'rgba(160,110,70,0.25)');
      g.fillStyle = sg; g.fillRect(x0, y0, sw, Bh);
      for (let i = 1; i <= 4; i++) {
        const yy = y0 + Bh * (i / 5);
        g.fillStyle = 'rgba(170,120,80,0.35)'; g.fillRect(x0 + 1, yy - 1.4, sw - 1.5, 1);
        g.fillStyle = 'rgba(10,5,2,0.55)'; g.fillRect(x0 + 1, yy, sw - 1.5, 1.2);
      }
      g.restore();
      // blind-tooled border (pressed: dark line, a hairline of light beside it)
      const ix = x0 + sw + Bw * 0.07, iy = y0 + Bw * 0.08, iw = Bw - sw - Bw * 0.14, ih = Bh - Bw * 0.16;
      g.strokeStyle = 'rgba(15,7,3,0.65)'; g.lineWidth = 0.9; g.strokeRect(ix, iy, iw, ih);
      g.strokeStyle = 'rgba(150,105,68,0.35)'; g.lineWidth = 0.6; g.strokeRect(ix + 0.9, iy + 0.9, iw, ih);
      g.strokeStyle = 'rgba(15,7,3,0.45)'; g.lineWidth = 0.6; g.strokeRect(ix + 3, iy + 3, iw - 6, ih - 6);
      // faded gilt initials
      g.save();
      const fs = Math.max(6, Bw * 0.085);
      g.font = `${fs}px 'IM Fell English SC', 'IM Fell English', Georgia, serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const tx = ix + iw / 2, ty = iy + ih * 0.3;
      g.fillStyle = 'rgba(10,5,2,0.6)'; g.fillText('M · A · V', tx + 0.5, ty + 0.6);
      g.fillStyle = 'rgba(196,160,96,0.6)'; g.fillText('M · A · V', tx, ty);
      g.strokeStyle = 'rgba(196,160,96,0.35)'; g.lineWidth = 0.6;
      g.beginPath(); g.moveTo(tx - iw * 0.22, ty + fs * 0.9); g.lineTo(tx + iw * 0.22, ty + fs * 0.9); g.stroke();
      g.restore();
      // the pencil, tucked in a leather loop at the fore-edge
      g.save();
      g.translate(x0 + Bw + Bw * 0.035, y0 + Bh * 0.14);
      const pw = Math.max(3, Bw * 0.055), pl = Bh * 0.66;
      g.fillStyle = '#c99c64'; g.fillRect(-pw / 2, 0, pw, pl);
      g.fillStyle = 'rgba(255,240,210,0.35)'; g.fillRect(-pw / 2 + pw * 0.2, 0, pw * 0.22, pl);
      g.fillStyle = 'rgba(80,50,20,0.35)'; g.fillRect(pw * 0.18, 0, pw * 0.32, pl);
      g.beginPath(); g.moveTo(-pw / 2, pl); g.lineTo(0, pl + pw * 2.1); g.lineTo(pw / 2, pl); g.closePath(); g.fillStyle = '#d8b383'; g.fill();
      g.beginPath(); g.moveTo(-pw * 0.18, pl + pw * 1.35); g.lineTo(0, pl + pw * 2.1); g.lineTo(pw * 0.18, pl + pw * 1.35); g.closePath(); g.fillStyle = '#2b2a2c'; g.fill();
      g.fillStyle = '#5a3a24'; g.fillRect(-pw / 2 - 1, pl * 0.32, pw + 2, pw * 1.6);
      g.fillStyle = 'rgba(160,110,70,0.4)'; g.fillRect(-pw / 2 - 1, pl * 0.32, pw + 2, 0.7);
      g.restore();
    });
    spr = { lit, dark: bakeTint(lit, '#0d0a08'), sh: bakeShadow(lit, Math.max(1.5, Bw * 0.02)), shSoft: bakeShadow(lit, Math.max(4, Bw * 0.08)) };
    // a loose slip of paper tucked between the leaves: it shows while something new is written
    // (origin = where it enters the book at the head; it extends up, -y, and well down inside)
    const sw = Math.round(Bw * 0.24), sTop = Bh * 0.24, sIn = Bh * 0.36;
    slipH = sTop;
    const rs = seeded(1892);
    const slip = bake(sw + 6, sTop + sIn + 6, sw / 2 + 3, sTop + 3, dpr, (g) => {
      g.beginPath();
      g.moveTo(-sw / 2, sIn);
      g.lineTo(-sw / 2, -sTop + 3);
      // a torn top edge
      const n = 9;
      for (let i = 0; i <= n; i++) g.lineTo(-sw / 2 + (sw * i) / n, -sTop + 1.2 + rs() * 2.6);
      g.lineTo(sw / 2, sIn);
      g.closePath();
      const pg = g.createLinearGradient(-sw / 2, 0, sw / 2, 0);
      pg.addColorStop(0, '#d9ccab'); pg.addColorStop(0.4, '#eee3c8'); pg.addColorStop(1, '#cdbf9d');
      g.fillStyle = pg; g.fill();
      g.save(); g.clip();
      speckle(g, rs, -sw / 2, -sTop, sw, sTop + sIn, 60, '#8a6a40', 0.08, 0.25, 0.4, 1.2);
      // faint ruling and a few words in graphite
      g.strokeStyle = 'rgba(120,140,160,0.22)'; g.lineWidth = 0.5;
      for (let yy = -sTop + 7; yy < 0; yy += 4.5) { g.beginPath(); g.moveTo(-sw / 2, yy); g.lineTo(sw / 2, yy); g.stroke(); }
      g.strokeStyle = 'rgba(55,52,50,0.6)'; g.lineWidth = 0.6;
      for (let yy = -sTop + 6.5, i = 0; yy < -2; yy += 4.5, i++) {
        const x0 = -sw / 2 + 2 + rs() * 2, x1 = sw / 2 - 2 - rs() * sw * (i % 2 ? 0.45 : 0.15);
        g.beginPath(); g.moveTo(x0, yy);
        for (let xx = x0; xx < x1; xx += 2.2) g.lineTo(xx, yy - 0.4 + Math.sin(xx * 1.7 + i) * 0.7 + rs() * 0.3);
        g.stroke();
      }
      // the light catches its top edge; the book's shadow on it lower down
      const sh2 = g.createLinearGradient(0, -6, 0, 4);
      sh2.addColorStop(0, 'rgba(0,0,0,0)'); sh2.addColorStop(1, 'rgba(30,18,8,0.45)');
      g.fillStyle = sh2; g.fillRect(-sw / 2, -6, sw, sIn + 6);
      g.restore();
      g.strokeStyle = 'rgba(90,70,40,0.35)'; g.lineWidth = 0.5;
      g.beginPath(); g.moveTo(-sw / 2, sIn); g.lineTo(-sw / 2, -sTop + 3); g.moveTo(sw / 2, -sTop + 3); g.lineTo(sw / 2, sIn); g.stroke();
    });
    spr.slip = slip; spr.slipDark = bakeTint(slip, '#0d0a08'); spr.slipSh = bakeShadow(slip, 1.5);
  }

  function hit(px, py, touch) {
    const pad = touch ? 12 : 4;
    const dx = px - rx, dy = py - ry, c = Math.cos(ra), s = Math.sin(ra);
    const lx = dx * c + dy * s, ly = -dx * s + dy * c;
    return Math.abs(lx) < Bw / 2 + pad && Math.abs(ly) < Bh / 2 + pad;
  }
  const unread = () => { try { return (+game.journal?.unread || 0) > 0 && !game.journal?.isOpen; } catch { return false; } };
  function update(dt) {
    spring(st, 'lift', 'vlift', hovering ? 1 : 0, 12, dt);
    spring(st, 'press', 'vpress', pressed ? 1 : 0, 25, dt);
    // the slip rises a little slowly (someone has just tucked it in) and is drawn back at once when read
    const want = unread() ? 1 : 0;
    spring(st, 'slip', 'vslip', want, want ? 3.2 : 9, dt);
    if (st.slip < 0.002 && !want) st.slip = st.vslip = 0;
  }
  // the loose slip: sticking out of the head of the book, stirring as if in a draught
  function drawSlip(ctx, lamp, alpha, f) {
    const k = clamp01(st.slip);
    if (k < 0.01 || !spr.slip) return;
    const t = game.t || 0;
    const stir = env.reduced ? 0 : 0.05 * Math.sin(t * 1.15) + 0.025 * Math.sin(t * 2.7 + 1.3) + 0.04 * Math.max(0, Math.sin(t * 0.37)) ** 6 * Math.sin(t * 9);
    ctx.save();
    ctx.translate(Bw * 0.2, -Bh / 2 + 2);
    ctx.rotate(0.13 + stir);
    ctx.translate(0, (1 - k) * slipH * 1.05);
    // its shadow falls on the cover below
    ctx.save(); ctx.translate(1.5, 2.5); blit(ctx, spr.slipSh, alpha * 0.4 * k * lamp.shadowAt(rx, ry)); ctx.restore();
    blitLit(ctx, spr.slip, spr.slipDark, alpha * Math.min(1, k * 1.6), f * 1.05);
    ctx.restore();
  }
  function draw(ctx, lamp, alpha) {
    if (!spr || alpha <= 0.002) return;
    const S = game.view.plate.size;
    const f = lamp.at(rx, ry) * (1 + 0.08 * st.lift);
    const h = S * (0.008 + 0.03 * st.lift - 0.006 * st.press);
    const o = lamp.offset(rx, ry, h, tmp);
    const sa = lamp.shadowAt(rx, ry) * alpha * 0.7;
    ctx.save(); ctx.translate(rx + o.x, ry + o.y); ctx.rotate(ra);
    blit(ctx, spr.sh, sa * (1 - st.lift)); blit(ctx, spr.shSoft, sa * st.lift * 0.8);
    ctx.restore();
    ctx.save(); ctx.translate(rx, ry); ctx.rotate(ra);
    const sc = 1 + 0.018 * st.lift - 0.012 * st.press; ctx.scale(sc, sc);
    // the slip first: the cover hides the part of it tucked inside
    if (st.slip > 0.01) {
      ctx.save(); ctx.beginPath(); ctx.rect(-Bw, -Bh * 1.2, Bw * 2, Bh * 0.7 + 2); ctx.clip();
      drawSlip(ctx, lamp, alpha, f);
      ctx.restore();
    }
    blitLit(ctx, spr.lit, spr.dark, alpha, f);
    ctx.restore();
  }
  return {
    layout, update, draw, hit,
    hover(on) { hovering = !!on; },
    press(on) { pressed = !!on; },
  };
}

// ===================================================================================================
// PULL-CORD — braided cotton cord from the lamp above, a porcelain pull with a dab of luminous paint.
// ===================================================================================================
export function createCord(env) {
  const { game } = env;
  let ax = 0, ay = 0, len = 80, pw = 11, ph = 19, maxS = 40, spr = null, glow = null;
  const st = { a: 0, va: 0, s: 0, vs: 0 };
  let heldBy = -1, maxPull = 0, clicked = false;
  const dash = [1.6, 2.2], dash2 = [1.1, 2.7];

  let bakedKey = '';
  function layout(force = false) {
    const v = game.view, S = v.plate.size, dpr = v.dpr || 1;
    const an = v.anchors?.cord || { x: v.plate.cx + S * 0.16, y: 0, len: Math.max(60, v.plate.y * 0.7) };
    ax = an.x; ay = an.y || 0; len = Math.max(40, an.len || 80);
    pw = Math.round(clamp(S * 0.024, 8, 15)); ph = Math.round(pw * 1.75);
    maxS = clamp(S * 0.09, 28, 64);
    const key = `${pw}|${dpr}`;
    if (!force && key === bakedKey && spr) return;
    bakedKey = key;
    const W = pw * 2.4, H = ph * 1.6;
    const lit = bake(W, H, W / 2, ph * 0.15, dpr, (g) => {
      // a turned brass acorn: a small ring, a cross-hatched cup, a smooth polished nut
      g.beginPath(); g.arc(0, ph * 0.02, pw * 0.13, 0, TAU); g.strokeStyle = '#8a6a2c'; g.lineWidth = 1.1; g.stroke();
      const cupT = ph * 0.1, cupB = ph * 0.42;
      g.beginPath();
      g.moveTo(-pw * 0.14, cupT);
      g.bezierCurveTo(-pw * 0.3, cupT + ph * 0.06, -pw * 0.46, cupB - ph * 0.1, -pw * 0.44, cupB);
      g.lineTo(pw * 0.44, cupB);
      g.bezierCurveTo(pw * 0.46, cupB - ph * 0.1, pw * 0.3, cupT + ph * 0.06, pw * 0.14, cupT);
      g.closePath();
      g.fillStyle = brassGrad(g, -pw * 0.45, 0, pw * 0.45, 0); g.fill();
      g.save(); g.clip();
      g.strokeStyle = 'rgba(50,32,6,0.55)'; g.lineWidth = 0.5;
      for (let i = -6; i <= 6; i++) {
        g.beginPath(); g.moveTo(i * pw * 0.12, cupT); g.lineTo(i * pw * 0.12 + pw * 0.3, cupB); g.stroke();
        g.beginPath(); g.moveTo(i * pw * 0.12, cupT); g.lineTo(i * pw * 0.12 - pw * 0.3, cupB); g.stroke();
      }
      g.restore();
      g.beginPath(); g.ellipse(0, cupB, pw * 0.45, pw * 0.08, 0, 0, TAU); g.fillStyle = '#5a4012'; g.fill();
      // the nut
      g.beginPath();
      g.moveTo(-pw * 0.4, cupB + 0.5);
      g.bezierCurveTo(-pw * 0.42, ph * 0.72, -pw * 0.16, ph * 0.92, 0, ph * 0.98);
      g.bezierCurveTo(pw * 0.16, ph * 0.92, pw * 0.42, ph * 0.72, pw * 0.4, cupB + 0.5);
      g.closePath();
      const ng = g.createRadialGradient(-pw * 0.14, ph * 0.56, pw * 0.03, 0, ph * 0.62, pw * 0.55);
      ng.addColorStop(0, '#fff2c4'); ng.addColorStop(0.25, '#e2bf6e'); ng.addColorStop(0.7, '#9a7330'); ng.addColorStop(1, '#4a3410');
      g.fillStyle = ng; g.fill();
      g.strokeStyle = 'rgba(40,25,5,0.6)'; g.lineWidth = 0.5; g.stroke();
      // the dab of luminous paint at its point
      g.beginPath(); g.ellipse(0, ph * 0.9, pw * 0.1, pw * 0.07, 0, 0, TAU); g.fillStyle = '#cfd8c4'; g.fill();
    });
    glow = bake(W * 2, H * 1.6, W, ph * 0.15 + H * 0.3, dpr, (g) => {
      const rg = g.createRadialGradient(0, ph * 0.9, 0, 0, ph * 0.9, pw * 1.1);
      rg.addColorStop(0, 'rgba(143,255,208,0.9)'); rg.addColorStop(0.25, 'rgba(143,255,208,0.35)'); rg.addColorStop(1, 'rgba(143,255,208,0)');
      g.fillStyle = rg; g.fillRect(-W, -H, W * 2, H * 3);
    });
    spr = { lit, dark: bakeTint(lit, '#0d0a08') };
  }

  function pullPos(o) {
    const L = len + st.s;
    o.x = ax + Math.sin(st.a) * L; o.y = ay + Math.cos(st.a) * L;
    return o;
  }
  const pp = { x: 0, y: 0 };
  function hit(px, py, touch) {
    pullPos(pp);
    const pad = touch ? 16 : 7;
    const c = Math.cos(st.a), s = Math.sin(st.a);
    const lx = (px - pp.x) * c - (py - pp.y) * s, ly = (px - pp.x) * s + (py - pp.y) * c;
    if (Math.abs(lx) < pw * 0.6 + pad && ly > -pad && ly < ph + pad) return true;
    // along the lower part of the cord
    const t = clamp(((px - ax) * s + (py - ay) * c) / (len + st.s), 0, 1);
    if (t < 0.45) return false;
    const cx = ax + s * (len + st.s) * t, cy = ay + c * (len + st.s) * t;
    return Math.hypot(px - cx, py - cy) < (touch ? 12 : 5);
  }
  // how far the hand itself has drawn the cord DOWN since it took hold (a sideways stroke swings the
  // cord but does not pull it): a quick flick on a slow frame counts even if the drawn cord lags
  let gy0 = 0, s0 = 0;
  const handPull = (py) => py - gy0;
  function pickUp(id, px, py) {
    heldBy = id; maxPull = 0; clicked = false; env.foundCord?.();
    gy0 = Number.isFinite(py) ? py : ay + len + ph * 0.45;
    s0 = st.s;
  }
  function release(px, py) {
    heldBy = -1;
    if (Number.isFinite(py)) maxPull = Math.max(maxPull, Math.min(maxS, s0 + handPull(py)));
    if (maxPull >= maxS * 0.5) toggle();
    st.vs = -st.s * 2;
  }
  function toggle() {
    const L = game.light;
    if (!L) return;
    L.on = !L.on;
    if (L.on) L.flicker = Math.max(L.flicker || 0, 0.9);
    env.emit('light', { on: L.on });
    env.emit('sfx', { name: 'cord', pan: env.panOf(ax) });
  }
  // a hand passing across the cord sets it swinging
  function brush(x0, y0, x1, y1) {
    if (heldBy >= 0) return;
    const yy = (y0 + y1) * 0.5;
    if (yy < ay || yy > ay + len + ph) return;
    const t = (yy - ay) / (len + ph);
    const cx = ax + Math.sin(st.a) * (yy - ay);
    if ((x0 - cx) * (x1 - cx) < 0) {
      const k = env.reduced ? 0.0012 : 0.004;
      st.va += clamp((x1 - x0) * k * (0.4 + t), -1.2, 1.2);
      env.foundCord?.();
    }
  }
  function update(dt, ptr) {
    const w0 = 2 * Math.PI / 1.45;
    if (heldBy >= 0 && ptr) {
      const dx = ptr.x - ax, dy = Math.max(1, ptr.y - ay);
      const ta = clamp(Math.atan2(dx, dy), -0.55, 0.55);
      const ts = clamp(s0 + handPull(ptr.y), -len * 0.25, maxS);
      springAngle(st, 'a', 'va', ta, 30, dt);
      spring(st, 's', 'vs', ts, 34, dt);
      if (st.s > maxPull) maxPull = st.s;
      if (!clicked && st.s > maxS * 0.5) { clicked = true; env.emit('sfx', { name: 'tick', pan: env.panOf(ax), soft: true }); }
    } else {
      // a damped pendulum, and a springy cord that bounces back when let go
      const damp = env.reduced ? 3 : 0.55;
      st.va += (-w0 * w0 * Math.sin(st.a) - damp * st.va) * dt;
      st.a += st.va * dt;
      const ws = 24, z = 0.22;
      st.vs += (-ws * ws * st.s - 2 * z * ws * st.vs) * dt;
      st.s += st.vs * dt;
    }
  }
  function draw(ctx, lamp, alpha) {
    if (!spr || alpha <= 0.002) return;
    pullPos(pp);
    const f = lamp.at(pp.x, pp.y);
    const fTop = lamp.at(ax, ay);
    const bend = -st.va * len * 0.05;
    const mx = (ax + pp.x) * 0.5 + Math.cos(st.a) * bend, my = (ay + pp.y) * 0.5 - Math.sin(st.a) * bend;
    ctx.save();
    ctx.lineCap = 'round';
    // one path, stroked four times: dark core, dyed cotton, and two dashed twists of the braid
    ctx.beginPath(); ctx.moveTo(ax, ay - 2); ctx.quadraticCurveTo(mx, my, pp.x, pp.y);
    ctx.globalAlpha = alpha; ctx.strokeStyle = '#120e0a'; ctx.lineWidth = 2.6; ctx.stroke();
    const fc = (f + fTop) * 0.5;
    ctx.globalAlpha = alpha * fc; ctx.strokeStyle = '#7d6a4f'; ctx.lineWidth = 2.3; ctx.stroke();
    ctx.setLineDash(dash); ctx.lineDashOffset = st.s * 0.8;
    ctx.globalAlpha = alpha * fc * 0.8; ctx.strokeStyle = '#c4ab80'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.setLineDash(dash2); ctx.lineDashOffset = 1.3 + st.s * 0.8;
    ctx.globalAlpha = alpha * fc * 0.6; ctx.strokeStyle = '#3a2e20'; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.setLineDash(EMPTY);
    ctx.restore();
    ctx.save();
    ctx.translate(pp.x, pp.y);
    ctx.rotate(-st.a);
    blitLit(ctx, spr.lit, spr.dark, alpha, f);
    // luminous paint: only the dark shows it
    const lum = (1 - lamp.level) * 0.55 * Math.max(alpha, 0.6);
    if (lum > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      blit(ctx, glow, lum * (0.85 + 0.15 * Math.sin((game.t || 0) * 0.7)));
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }
  return {
    layout, update, draw, hit, pickUp, release, brush, toggle,
    get heldBy() { return heldBy; },
    state: st,
  };
}

// ===================================================================================================
// CABINET — the drawer front at the bottom of the room, and the felt-lined tray it holds:
// four grey felt dampers and a rack of steel tuning forks, each engraved with its number.
// ===================================================================================================
const FORK_KS = [5, 10, 13, 17, 20, 25, 40];          // slots, left to right
const FORK_ORDER = [5, 10, 13, 20, 25, 17, 40];       // the order they are given
const FORK_S = 12;                                    // a struck fork drives the plate this long
const STEEL = (g, x0, x1) => {
  const s = g.createLinearGradient(x0, 0, x1, 0);
  s.addColorStop(0, '#4b4f53'); s.addColorStop(0.32, '#dfe3e6'); s.addColorStop(0.55, '#a6abaf'); s.addColorStop(0.85, '#6b7074'); s.addColorStop(1, '#3d4144');
  return s;
};

export function createCabinet(env) {
  const { game } = env;
  const st = { open: 0, vopen: 0 };
  let userOpen = false;
  let TW = 400, TH = 180, FH = 34, TX = 0, ft = 9, rD = 16, divX = 0;
  // 'tall': forks stand upright in a deep tray (room below the plate, portrait). 'flat': a wide,
  // shallow tray that fits under the plate in landscape; the forks lie on their sides in columns.
  let flat = false, dRows = 2, dGap = 8, fRows = 7, fPitch = 20, fColW = 100, fZoneX = 0;
  // each fork's number is stamped in gilt in the baize beside its recess (left of the foot when the
  // forks lie flat, under it when they stand): fs is its size, numW / numH the room kept for it
  let fs = 12, numW = 16, numH = 15;
  let spr = null;
  let nForks = 0, specCheck = 0;
  let hoverFront = false;
  const tmp = { x: 0, y: 0 }, scr = { x: 0, y: 0 }, uv = { u: 0, v: 0 };
  const forkComps = [{ mode: null, amp: 0 }];
  const drive = { on: false, k: 0, mode: null, e0: 0, t0: 0 };

  // geometry of a fork (CSS px), recomputed in layout
  const FG = { tineW: 6, gapW: 7, stemW: 5, footR: 5, stemLen: 50, yokeR: 6.5, tineMax: 100, scale: 1 };
  const tineLen = (k) => FG.tineMax * Math.pow(5 / k, 0.42);
  const forkLen = (k) => FG.stemLen + FG.yokeR + tineLen(k) + FG.tineW * 0.5;

  const dampers = [];
  for (let i = 0; i < 4; i++) dampers.push({ i, state: 'slot', u: 0, v: 0, x: 0, y: 0, vx: 0, vy: 0, lift: 0, vlift: 0, ptr: -1, fromPlate: false, moved: false, fd: { u: 0, v: 0, r: 0.06 } });
  const forks = FORK_KS.map((k, i) => ({ k, i, state: 'slot', x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0, lift: 0, vlift: 0, e: 0, t0: -99, ptr: -1, moved: false, touching: false, lastX: 0, velX: 0 }));
  // restore dampers left on the plate
  if (Array.isArray(env.saved.dampers)) {
    env.saved.dampers.slice(0, 4).forEach((p, i) => {
      if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) { const d = dampers[i]; d.state = 'plate'; d.u = clamp(p[0], -0.94, 0.94); d.v = clamp(p[1], -0.94, 0.94); }
    });
  }

  const trayTop = () => game.view.vh - FH - TH * st.open;
  const slotOf = (d, o) => {
    const cols = 4 / dRows, col = d.i % cols, row = (d.i / cols) | 0;
    o.x = TX + ft + dGap + rD + col * (rD * 2 + dGap);
    o.y = trayTop() + ft + (TH - ft) / 2 + (row - (dRows - 1) / 2) * (rD * 2 + dGap);
    return o;
  };
  // a fork's foot in its slot (upright: tines up; flat: lying with the tines to the right)
  const forkSlot = (fk, o) => {
    if (flat) {
      const col = (fk.i / fRows) | 0, row = fk.i % fRows;
      o.x = fZoneX + col * fColW + 8 + numW;
      o.y = trayTop() + ft + 2 + fPitch * (row + 0.5);
      return o;
    }
    const zx0 = divX + 6, zx1 = TX + TW - ft - 4, sw = (zx1 - zx0) / FORK_KS.length;
    o.x = zx0 + sw * (fk.i + 0.5);
    o.y = trayTop() + TH - 7 - numH;
    return o;
  };
  const slotAngle = () => (flat ? Math.PI / 2 : 0);
  const unlocked = (fk) => env.isOn('forks') && FORK_ORDER.indexOf(fk.k) < nForks;

  function countForks() {
    const n = Object.keys(game.state.species || {}).length;
    nForks = env.alphaOf('forks') > 0 || env.isOn('forks') ? clamp(3 + Math.max(0, n - 5), 3, 7) : 0;
  }

  // ---- sprites ----------------------------------------------------------------------------------
  function bakeDamper(dpr) {
    const R = rD, W = R * 2.6;
    const rnd = seeded(404);
    const lit = bake(W, W, W / 2, W / 2, dpr, (g) => {
      // fuzzy rim
      for (let i = 0; i < 260; i++) {
        const a = rnd() * TAU, r = R * (0.94 + rnd() * 0.1);
        g.fillStyle = rnd() < 0.5 ? '#8b8781' : '#6f6b66'; g.globalAlpha = 0.25 + rnd() * 0.35;
        g.fillRect(Math.cos(a) * r, Math.sin(a) * r, 0.8, 0.8);
      }
      g.globalAlpha = 1;
      g.beginPath(); g.arc(0, 0, R, 0, TAU);
      const rg = g.createRadialGradient(-R * 0.3, -R * 0.35, R * 0.1, 0, 0, R);
      rg.addColorStop(0, '#a8a49d'); rg.addColorStop(0.7, '#8b8780'); rg.addColorStop(1, '#68645f');
      g.fillStyle = rg; g.fill();
      g.save(); g.clip();
      for (let i = 0; i < 520; i++) {
        const x = (rnd() - 0.5) * R * 2, y = (rnd() - 0.5) * R * 2, a = rnd() * Math.PI, l = 0.8 + rnd() * 2.4;
        g.strokeStyle = rnd() < 0.5 ? '#c4c0b8' : '#55524d'; g.globalAlpha = 0.12 + rnd() * 0.22; g.lineWidth = 0.4;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
      g.globalAlpha = 0.35; g.strokeStyle = '#5c5954'; g.lineWidth = R * 0.08;
      g.beginPath(); g.arc(0, 0, R * 0.72, 0, TAU); g.stroke();
      g.restore(); g.globalAlpha = 1;
      // a small turned walnut knob to lift it by
      const kr = R * 0.3;
      g.beginPath(); g.arc(R * 0.06, R * 0.08, kr * 1.05, 0, TAU); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill();
      g.beginPath(); g.arc(0, 0, kr, 0, TAU);
      const kg = g.createRadialGradient(-kr * 0.35, -kr * 0.4, kr * 0.1, 0, 0, kr);
      kg.addColorStop(0, '#9a6b45'); kg.addColorStop(0.5, '#5e3b22'); kg.addColorStop(1, '#2e1b0e');
      g.fillStyle = kg; g.fill();
      g.strokeStyle = 'rgba(255,220,180,0.25)'; g.lineWidth = 0.6;
      g.beginPath(); g.arc(0, 0, kr * 0.6, Math.PI * 1.05, Math.PI * 1.6); g.stroke();
    });
    return { lit, dark: bakeTint(lit, '#0d0a08'), sh: bakeShadow(lit, Math.max(1.5, R * 0.12)), shSoft: bakeShadow(lit, Math.max(4, R * 0.4)) };
  }

  function bakeForks(dpr) {
    const out = {};
    const { tineW, gapW, stemW, footR, stemLen, yokeR } = FG;
    const W = tineW * 2 + gapW + 8;
    // one long tine; drawn cropped to each fork's length
    const tineH = FG.tineMax + tineW;
    const tine = bake(tineW + 2, tineH, (tineW + 2) / 2, 0, dpr, (g) => {
      g.beginPath(); roundRectPath(g, -tineW / 2, 0, tineW, tineH + tineW, tineW * 0.45);
      g.fillStyle = STEEL(g, -tineW / 2, tineW / 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(-tineW * 0.18, tineW * 0.5, tineW * 0.12, tineH);
      g.strokeStyle = 'rgba(20,22,24,0.55)'; g.lineWidth = 0.5;
      g.beginPath(); roundRectPath(g, -tineW / 2, 0, tineW, tineH + tineW, tineW * 0.45); g.stroke();
    });
    out.tine = tine; out.tineDark = bakeTint(tine, '#0d0a08');
    for (const k of FORK_KS) {
      const H = stemLen + yokeR * 2 + tineW + 4;
      const body = bake(W, H, W / 2, H - 2, dpr, (g) => {
        // stem
        g.beginPath(); roundRectPath(g, -stemW / 2, -stemLen - yokeR * 0.3, stemW, stemLen + yokeR * 0.3 - footR * 0.6, stemW * 0.3);
        g.fillStyle = STEEL(g, -stemW / 2, stemW / 2); g.fill();
        g.strokeStyle = 'rgba(20,22,24,0.5)'; g.lineWidth = 0.5; g.stroke();
        // turned foot
        g.beginPath(); g.arc(0, -footR, footR, 0, TAU);
        const fg2 = g.createRadialGradient(-footR * 0.35, -footR * 1.35, footR * 0.1, 0, -footR, footR);
        fg2.addColorStop(0, '#f2f4f5'); fg2.addColorStop(0.5, '#a3a8ac'); fg2.addColorStop(1, '#45494c');
        g.fillStyle = fg2; g.fill(); g.strokeStyle = 'rgba(20,22,24,0.5)'; g.stroke();
        // collar
        g.beginPath(); roundRectPath(g, -stemW * 0.75, -stemLen - 1, stemW * 1.5, stemW * 0.9, 1);
        g.fillStyle = STEEL(g, -stemW * 0.75, stemW * 0.75); g.fill();
        // yoke: the U where the tines meet
        g.beginPath(); g.arc(0, -stemLen - yokeR, yokeR, 0, Math.PI, false);
        g.strokeStyle = '#3d4144'; g.lineWidth = tineW + 1; g.stroke();
        g.strokeStyle = STEEL(g, -yokeR - tineW / 2, yokeR + tineW / 2); g.lineWidth = tineW; g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = tineW * 0.15;
        g.beginPath(); g.arc(0, -stemLen - yokeR, yokeR + tineW * 0.15, Math.PI * 0.2, Math.PI * 0.75); g.stroke();
        // the engraved number, reading up the stem
        g.save();
        g.translate(0.2, -footR * 2 - 2);
        g.rotate(-Math.PI / 2);
        const fs = Math.max(5, Math.min(stemW * 1.05, 10));
        g.font = `${fs}px 'Old Standard TT', Georgia, serif`;
        g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillText(String(k), 0.4, 0.5);
        g.fillStyle = 'rgba(25,27,30,0.85)'; g.fillText(String(k), 0, 0);
        g.restore();
      });
      // whole-fork silhouette (for shadows and the felt recess)
      const L = forkLen(k);
      const sil = bake(W, L + 6, W / 2, L + 3, dpr, (g) => {
        g.drawImage(body.cv, -W / 2, -(H - 2), W, H);
        const tl = tineLen(k), yb = -stemLen - yokeR;
        g.fillStyle = '#000';
        g.fillRect(-yokeR - tineW / 2, yb - tl, tineW, tl);
        g.fillRect(yokeR - tineW / 2, yb - tl, tineW, tl);
      });
      out[k] = { body, dark: bakeTint(body, '#0d0a08'), sil, sh: bakeShadow(sil, 1.5), shSoft: bakeShadow(sil, 5), recess: bakeTint(bakeShadow(sil, 1.2), '#08120d') };
    }
    return out;
  }

  function bakeTray(dpr) {
    const rnd = seeded(2718);
    return bake(TW, TH + 2, 0, 0, dpr, (g) => {
      woodGrain(g, rnd, 0, 0, TW, TH + 2, '#5a2814', '#2e1208', '#8a4a2a', true, 70);
      // rim highlight and the inner edge
      g.fillStyle = 'rgba(255,200,150,0.18)'; g.fillRect(0, 0, TW, 1.2);
      g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, 1, TH); g.fillRect(TW - 1, 0, 1, TH);
      // baize
      const bx = ft, by = ft, bw = TW - ft * 2, bh = TH - ft + 2;
      g.fillStyle = '#1c3426'; g.fillRect(bx, by, bw, bh);
      speckle(g, rnd, bx, by, bw, bh, Math.round(bw * bh * 0.08), '#2f5240', 0.25, 0.6, 0.5, 1.1);
      speckle(g, rnd, bx, by, bw, bh, Math.round(bw * bh * 0.05), '#0d1a13', 0.3, 0.7, 0.5, 1.1);
      // shadow of the frame falling onto the baize
      for (let i = 0; i < 6; i++) {
        g.strokeStyle = 'rgba(0,0,0,' + (0.22 - i * 0.035).toFixed(3) + ')'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(bx + i + 0.5, by + bh); g.lineTo(bx + i + 0.5, by + i + 0.5); g.lineTo(bx + bw - i - 0.5, by + i + 0.5); g.lineTo(bx + bw - i - 0.5, by + bh); g.stroke();
      }
      g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(bx - 1, by - 1, bw + 2, 1);
      // divider batten
      woodGrain(g, rnd, divX - TX, by, 5, bh, '#5a2814', '#2e1208', '#8a4a2a', false, 6);
      g.fillStyle = 'rgba(255,200,150,0.2)'; g.fillRect(divX - TX, by, 1, bh);
      g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(divX - TX + 5, by, 2, bh);
      // damper recesses
      for (const d of dampers) {
        slotOf(d, tmp); const x = tmp.x - TX, y = tmp.y - trayTop();
        const rg = g.createRadialGradient(x - rD * 0.2, y - rD * 0.2, rD * 0.2, x, y, rD * 1.12);
        rg.addColorStop(0, '#16291e'); rg.addColorStop(0.85, '#0b1610'); rg.addColorStop(1, '#050b08');
        g.beginPath(); g.arc(x, y, rD * 1.12, 0, TAU); g.fillStyle = rg; g.fill();
        g.strokeStyle = 'rgba(80,120,95,0.35)'; g.lineWidth = 0.8;
        g.beginPath(); g.arc(x, y, rD * 1.12, Math.PI * 0.05, Math.PI * 0.75); g.stroke();
      }
      // fork recesses (each shaped like its fork)
      for (const fk of forks) {
        forkSlot(fk, tmp); const x = tmp.x - TX, y = tmp.y - trayTop();
        const s = spr?.forks?.[fk.k];
        if (!s) continue;
        g.save(); g.translate(x + 0.7, y + 0.7); g.rotate(slotAngle()); g.globalAlpha = 0.35; blit(g, bakeTintCache(s, 'light'), 1); g.restore();
        g.save(); g.translate(x, y); g.rotate(slotAngle()); blit(g, s.recess, 0.95); g.restore();
      }
      // the slot numbers, stamped in gilt (pressed into the nap: a dark lip under each figure)
      g.font = `${fs}px 'Old Standard TT', Georgia, serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      for (const fk of forks) {
        forkSlot(fk, tmp);
        const x = tmp.x - TX + (flat ? -numW / 2 - 1 : 0), y = tmp.y - trayTop() + (flat ? 0.5 : numH / 2 + 1.5);
        g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillText(String(fk.k), x + 0.5, y + 0.8);
        g.fillStyle = 'rgba(222,196,132,0.82)'; g.fillText(String(fk.k), x, y);
      }
      // until the forks are given, their compartment is closed by a lid
      if (!env.isOn('forks')) {
        const lx = divX - TX + 6, lw = TW - ft - lx, ly = by, lh = bh - 1;
        g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(lx, ly, lw, lh);
        woodGrain(g, rnd, lx + 1, ly + 1, lw - 2, lh - 3, '#4f2412', '#2a1007', '#7c4224', true, 30);
        g.fillStyle = 'rgba(255,200,150,0.16)'; g.fillRect(lx + 1, ly + 1, lw - 2, 1);
        g.strokeStyle = 'rgba(0,0,0,0.45)'; g.lineWidth = 1; g.strokeRect(lx + 4.5, ly + 4.5, lw - 9, lh - 10);
        // hinges and a brass catch
        for (const hx of [lx + lw * 0.2, lx + lw * 0.8]) { g.fillStyle = brassGrad(g, hx - 7, 0, hx + 7, 0); g.fillRect(hx - 7, ly + 1, 14, 4); }
        const cx = lx + lw / 2, cy = ly + lh - 9;
        g.beginPath(); roundRectPath(g, cx - 6, cy - 3, 12, 6, 2); g.fillStyle = brassGrad(g, cx - 6, 0, cx + 6, 0); g.fill();
      }
    });
  }
  // a lighter tint of the recess silhouette (the felt's lit lip)
  const tintCache = new WeakMap();
  function bakeTintCache(s, kind) {
    let c = tintCache.get(s);
    if (!c) { c = bakeTint(s.recess, '#3e6a52'); tintCache.set(s, c); }
    return c;
  }

  function bakeFront(dpr) {
    const rnd = seeded(99);
    return bake(TW, FH + 2, 0, 0, dpr, (g) => {
      woodGrain(g, rnd, 0, 0, TW, FH + 2, '#5c2a15', '#2c1107', '#94522f', true, 50);
      const sh = g.createLinearGradient(0, 0, 0, FH);
      sh.addColorStop(0, 'rgba(255,205,160,0.32)'); sh.addColorStop(0.12, 'rgba(255,205,160,0.06)'); sh.addColorStop(0.2, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.45)');
      g.fillStyle = sh; g.fillRect(0, 0, TW, FH + 2);
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, FH * 0.16, TW, 0.8);
      g.fillStyle = 'rgba(255,210,170,0.15)'; g.fillRect(0, FH * 0.16 + 0.8, TW, 0.6);
      // brass bail pull
      const cx = TW / 2, cy = FH * 0.5, rr = Math.max(3, FH * 0.15), sp = Math.max(14, FH * 0.8);
      for (const s of [-1, 1]) {
        g.beginPath(); g.arc(cx + s * sp, cy - FH * 0.06, rr, 0, TAU);
        g.fillStyle = brassGrad(g, cx + s * sp - rr, cy - rr, cx + s * sp + rr, cy + rr); g.fill();
        g.strokeStyle = 'rgba(40,25,5,0.7)'; g.lineWidth = 0.6; g.stroke();
        g.beginPath(); g.arc(cx + s * sp, cy - FH * 0.06, rr * 0.35, 0, TAU); g.fillStyle = '#3a2808'; g.fill();
      }
      g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx - sp, cy - FH * 0.06); g.bezierCurveTo(cx - sp, cy + FH * 0.42, cx + sp, cy + FH * 0.42, cx + sp, cy - FH * 0.06);
      g.strokeStyle = 'rgba(0,0,0,0.5)'; g.lineWidth = Math.max(2.2, FH * 0.11); g.stroke();
      g.strokeStyle = brassGrad(g, cx - sp, cy, cx + sp, cy + FH * 0.3); g.lineWidth = Math.max(1.8, FH * 0.085);
      g.beginPath(); g.moveTo(cx - sp, cy - FH * 0.08); g.bezierCurveTo(cx - sp, cy + FH * 0.38, cx + sp, cy + FH * 0.38, cx + sp, cy - FH * 0.08); g.stroke();
      g.strokeStyle = 'rgba(255,240,200,0.6)'; g.lineWidth = 0.6;
      g.beginPath(); g.moveTo(cx - sp * 0.6, cy + FH * 0.2); g.quadraticCurveTo(cx, cy + FH * 0.3, cx + sp * 0.4, cy + FH * 0.22); g.stroke();
    });
  }

  function forkWidths() {
    FG.gapW = FG.tineW * 1.25;
    FG.stemW = FG.tineW * 0.95;
    FG.footR = FG.tineW * 0.85;
    FG.yokeR = (FG.gapW + FG.tineW) / 2;
  }
  // the flat tray at depth th; false if its forks would come out too small to handle
  function layoutFlat(th, v, S) {
    TH = th;
    ft = Math.round(clamp(TH * 0.07, 5, 10));
    TW = Math.round(Math.max(v.anchors?.drawer?.w || S * 0.84, Math.min(v.vw - 24, S * 1.0)));
    const innerH = TH - ft;
    // dampers: a 2 × 2 block if it fits, else a row of four
    dRows = innerH >= rD * 4 + 3 * 4 ? 2 : 1;
    dGap = dRows === 2 ? clamp((innerH - rD * 4) / 3, 4, Math.max(8, rD * 0.75)) : Math.max(6, Math.min(rD * 0.6, (innerH - rD * 2) / 2));
    const dZoneW = (4 / dRows) * rD * 2 + (4 / dRows + 1) * dGap;
    // forks: lying in rows; the fewest rows (the stoutest forks) whose columns keep the drawer
    // no wider than the plate, else whatever fits the window
    const Lf = clamp(S * 0.29, 90, 260);      // the longest fork (k = 5)
    const maxTW = Math.max(TW, S * 1.02);
    let pickRows = 0, fallback = 7;
    for (let rows = 1; rows <= 7; rows++) {
      const tw = ((innerH - 4) / rows - 5) / 3.25;
      if (tw < 3) { fallback = Math.max(1, rows - 1); break; }
      const cols = Math.ceil(FORK_KS.length / rows);
      const nw = Math.round(clamp(((innerH - 4) / rows) * 0.6, 11, 14) * 1.2) + 2;
      if (ft * 2 + dZoneW + 12 + cols * (Lf + 16 + nw) <= maxTW) { pickRows = rows; break; }
      fallback = rows;
    }
    fRows = pickRows || fallback;
    const cols = Math.ceil(FORK_KS.length / fRows);
    fPitch = (innerH - 4) / fRows;
    fs = Math.round(clamp(fPitch * 0.6, 11, 14)); numW = Math.round(fs * 1.2) + 2; numH = 0;
    fColW = Lf + 16 + numW;
    FG.tineW = clamp((fPitch - 5) / 3.25, 2.6, 8);
    forkWidths();
    const need = ft * 2 + dZoneW + 12 + cols * fColW;
    TW = Math.round(Math.min(v.vw - 16, Math.max(TW, need)));
    const fit = (TW - ft * 2 - dZoneW - 12) / cols;
    if (need > TW) fColW = Math.max(60 + numW, fit);
    TX = Math.round(v.plate.cx - TW / 2);
    TX = clamp(TX, 4, Math.max(4, v.vw - TW - 4));
    divX = TX + ft + dZoneW;
    fZoneX = divX + 10;
    const Lk5 = fColW - 16 - numW;
    FG.stemLen = Lk5 * 0.32;
    FG.tineMax = Lk5 - FG.stemLen - FG.yokeR - FG.tineW * 0.6;
    return need <= TW || fit - 16 - numW >= 52;
  }

  let bakedKey = '';
  function layout(force = false) {
    const v = game.view, S = v.plate.size, unit = S / 2, dpr = v.dpr || 1;
    const an = v.anchors?.drawer || { x: v.plate.cx - S * 0.42, y: v.vh - 30, w: S * 0.84, h: 30 };
    FH = Math.round(Math.max(26, an.h || 30));
    TW = Math.round(Math.max(an.w || S * 0.84, Math.min(v.vw - 24, S * 1.0)));
    rD = 0.062 * unit;
    // how deep may the open tray be? It stops at the plate's lower edge, overlapping at most a sliver
    const below = v.vh - FH - (v.plate.y + v.plate.size);
    const tallTH = Math.round(clamp(S * 0.37, 112, 250));
    const room = Math.round(below + S * 0.022);
    flat = room < tallTH && v.mode === 'landscape';
    if (!flat) {
      TH = tallTH;
      ft = Math.round(clamp(TH * 0.055, 6, 12));
      dRows = 2; dGap = Math.max(8, rD * 0.75);
      TX = Math.round((an.x || 0) + (an.w || TW) / 2 - TW / 2);
      TX = clamp(TX, 4, Math.max(4, v.vw - TW - 4));
      divX = TX + ft + dGap * 3 + rD * 4;
      // forks sized to their compartment
      const zoneW = TX + TW - ft - 4 - (divX + 6);
      const slotW = zoneW / FORK_KS.length;
      FG.tineW = clamp(S * 0.0135, 3.2, 8);
      FG.tineW = Math.min(FG.tineW, (slotW - 6) / 3.3);
      forkWidths();
      fs = Math.round(clamp(slotW * 0.36, 11, 14)); numH = fs + 4; numW = 0;
      const avail = TH - ft - 14 - numH;
      FG.stemLen = avail * 0.3;
      FG.tineMax = avail - FG.stemLen - FG.yokeR - FG.tineW * 0.6;
    } else {
      // a wide, shallow tray: no deeper than the room under the plate when one row of dampers and one
      // of forks fit there; else 58 px deep (a narrow window cannot lay all seven forks in one row)
      const minTH = Math.ceil(rD * 2 + 14);
      if (!layoutFlat(Math.max(minTH, room), v, S)) layoutFlat(Math.max(58, room), v, S);
    }
    countForks();
    // rebake only when the tray's geometry changed (a window dragged wider usually moves it, no more)
    const key = [dpr, flat, TW, TH, FH, ft, rD, dRows, dGap, fRows, fPitch, fColW, divX - TX, fZoneX - TX,
      FG.tineW, FG.stemLen, FG.tineMax, fs, numW, numH].map((n) => (typeof n === 'number' ? Math.round(n * 100) : n)).join('|');
    if (force || key !== bakedKey || !spr) {
      bakedKey = key;
      spr = { damper: bakeDamper(dpr) };
      spr.forks = bakeForks(dpr);
      spr.front = bakeFront(dpr);
      spr.frontDark = bakeTint(spr.front, '#0d0a08');
      spr.tray = bakeTray(dpr);
      spr.trayForksOn = env.isOn('forks');
    }
    // what rests in the tray moves with it; what a hand holds (or is on its way back) is left be
    for (const d of dampers) if (d.state === 'slot') { slotOf(d, tmp); d.x = tmp.x; d.y = tmp.y; d.vx = d.vy = 0; }
    for (const fk of forks) if (fk.state === 'slot') { forkSlot(fk, tmp); fk.x = tmp.x; fk.y = tmp.y; fk.a = slotAngle(); fk.vx = fk.vy = fk.va = 0; }
  }

  // ---- interaction ------------------------------------------------------------------------------
  const inTray = (x, y) => x >= TX && x <= TX + TW && y >= trayTop() && y <= game.view.vh;
  function hitFront(x, y, touch) {
    const pad = touch ? 8 : 0;
    const top = game.view.vh - FH;
    return x >= TX - pad && x <= TX + TW + pad && y >= top - pad - (st.open > 0.05 ? 0 : 6);
  }
  function forkAt(x, y, touch) {
    const pad = touch ? 10 : 5;
    for (const fk of forks) {
      if (fk.state !== 'slot' || !unlocked(fk)) continue;
      const L = forkLen(fk.k), hw = FG.yokeR + FG.tineW / 2 + pad;
      if (flat) { if (y > fk.y - hw && y < fk.y + hw && x > fk.x - pad && x < fk.x + L + pad) return fk; }
      else if (x > fk.x - hw && x < fk.x + hw && y < fk.y + pad && y > fk.y - L - pad) return fk;
    }
    return null;
  }
  function damperAt(x, y, touch, state) {
    const pad = touch ? 10 : 4;
    for (let i = dampers.length - 1; i >= 0; i--) {
      const d = dampers[i];
      if (d.state !== state) continue;
      if (Math.hypot(x - d.x, y - d.y) < rD + pad) return d;
    }
    return null;
  }

  function down(p, x, y, touch) {
    if (st.open > 0.6) {
      const fk = forkAt(x, y, touch);
      if (fk) { fk.ptr = p.id; fk.moved = false; p.target = fk; return 'fork'; }
      if (env.isOn('dampers')) {
        const d = damperAt(x, y, touch, 'slot');
        if (d) { d.ptr = p.id; d.fromPlate = false; d.moved = false; p.target = d; return 'damper'; }
      }
    }
    if (hitFront(x, y, touch)) return 'front';
    if (inTray(x, y)) return 'none';
    toggle(false);
    return 'none';
  }
  function downPlateDamper(p, x, y, touch) {
    const d = damperAt(x, y, touch, 'plate');
    if (!d) return null;
    d.ptr = p.id; d.fromPlate = true; d.moved = false; p.target = d;
    return 'pdamper';
  }
  function liftDamper(d) {
    const wasPlate = d.state === 'plate';
    d.state = 'drag'; d.moved = true;
    if (wasPlate) {
      env.syncDampers(); persist();
      env.emit('damper:remove', { u: d.u, v: d.v });
    } else env.emit('sfx', { name: 'grab', pan: env.panOf(d.x), soft: true });
  }
  function move(p, x, y) {
    const t = p.target;
    if (!t) return;
    if (p.kind === 'fork') {
      if (!t.moved && Math.hypot(x - p.x0, y - p.y0) > 6) {
        t.moved = true; t.state = 'drag'; t.lastX = x; t.velX = 0;
        env.emit('sfx', { name: 'grab', pan: env.panOf(x), soft: true });
      }
    } else if (p.kind === 'damper' || p.kind === 'pdamper') {
      if (!t.moved && Math.hypot(x - p.x0, y - p.y0) > 4) liftDamper(t);
    }
  }
  function up(p, x, y, cancel, dur) {
    const t = p.target;
    p.target = null;
    if (!t) return;
    if (p.kind === 'fork') {
      t.ptr = -1;
      if (!t.moved) { if (!cancel && dur < 600) strike(t); return; }
      t.touching = false;
      t.state = 'return';
    } else if (p.kind === 'damper' || p.kind === 'pdamper') {
      t.ptr = -1;
      if (!t.moved) return;                         // a click on a damper leaves it be
      // dropped where the hand is (the disc may still be catching up on a slow frame)
      const hx = Number.isFinite(x) ? x : t.x, hy = Number.isFinite(y) ? y : t.y;
      const { u, v } = game.view.toPlate(hx, hy);
      if (!cancel && Math.abs(u) < 0.97 && Math.abs(v) < 0.97) place(t, u, v);
      else { t.state = 'return'; env.emit('sfx', { name: 'drop', pan: env.panOf(t.x), soft: true }); }
    }
  }

  function place(d, u, v) {
    u = clamp(u, -0.92, 0.92); v = clamp(v, -0.92, 0.92);
    // off the clamp nut, and not on top of another damper
    for (let it = 0; it < 3; it++) {
      const r = Math.hypot(u, v);
      if (r < 0.15) { const k = r > 1e-3 ? 0.15 / r : 0; u = r > 1e-3 ? u * k : 0.15; v = r > 1e-3 ? v * k : 0; }
      for (const o of dampers) {
        if (o === d || o.state !== 'plate') continue;
        const dx = u - o.u, dy = v - o.v, dd = Math.hypot(dx, dy);
        if (dd < 0.13) { const k = (0.13 - dd) / (dd || 1); u += dx * k; v += dy * k; if (dd < 1e-3) u += 0.13; }
      }
      u = clamp(u, -0.92, 0.92); v = clamp(v, -0.92, 0.92);
    }
    d.u = u; d.v = v; d.state = 'plate';
    const s = game.view.toScreen(u, v); d.tx = s.x; d.ty = s.y;
    env.syncDampers(); persist();
    env.emit('damper:place', { u, v });
  }
  function persist() {
    env.saved.dampers = dampers.filter((d) => d.state === 'plate').map((d) => [Math.round(d.u * 1000) / 1000, Math.round(d.v * 1000) / 1000]);
  }
  function collectDampers(list) {
    for (const d of dampers) if (d.state === 'plate') { d.fd.u = d.u; d.fd.v = d.v; d.fd.r = 0.06; list.push(d.fd); }
  }

  function strike(fk) {
    fk.e = 1; fk.t0 = game.t;
    env.emit('fork:strike', { k: fk.k });
  }
  function pickMode(k, u, v) {
    const list = typeof Modes.modesWithK === 'function' ? Modes.modesWithK(k) : Modes.MODES.filter((m) => m.k === k && !m.special);
    let best = null, bs = -1;
    for (const m of list) {
      const s = Math.abs(Modes.evalMode(m, u, v)) + (m.bowable ? 0.05 : 0) + (m.s > 0 ? 0.001 : 0);
      if (s > bs) { bs = s; best = m; }
    }
    return best ? best.id : null;
  }
  function touchFork(fk, u, v) {
    const mode = pickMode(fk.k, u, v);
    if (!mode) return;
    drive.on = true; drive.k = fk.k; drive.mode = mode; drive.e0 = clamp01(fk.e * 1.1); drive.t0 = game.t;
    forkComps[0].mode = mode;
    env.emit('fork:touch', { k: fk.k, mode });
  }

  function toggle(force) {
    const next = force === undefined ? !userOpen : !!force;
    if (next === userOpen) return;
    if (next && !env.isOn('drawer')) return;
    userOpen = next;
    env.emit('sfx', { name: 'drawer', open: next, pan: env.panOf(TX + TW / 2) });
  }

  // ---- update -----------------------------------------------------------------------------------
  function update(dt, ptrs) {
    specCheck -= dt;
    if (specCheck <= 0) {
      specCheck = 1;
      const before = nForks;
      countForks();
      if (spr && (before !== nForks || spr.trayForksOn !== env.isOn('forks'))) { spr.trayForksOn = env.isOn('forks'); spr.tray = bakeTray(game.view.dpr || 1); }
    }
    let dragging = false;
    for (const d of dampers) if (d.state === 'drag' && !d.fromPlate) dragging = true;
    for (const fk of forks) if (fk.state === 'drag') dragging = true;
    const target = userOpen ? (dragging ? 0.4 : 1) : 0;
    // a slightly springy slide
    const w = 12, z = 0.78;
    st.vopen += (w * w * (target - st.open) - 2 * z * w * st.vopen) * dt;
    st.open += st.vopen * dt;
    if (st.open < 0.0005 && target === 0) { st.open = 0; st.vopen = 0; }

    for (const d of dampers) {
      const p = d.ptr >= 0 ? ptrs.get(d.ptr) : null;
      if (d.ptr >= 0 && !p) { d.ptr = -1; if (d.state === 'drag') d.state = 'return'; }   // its hand is gone
      let tx, ty, lt = 0, w0 = 14;
      if (d.state === 'drag' && p) { tx = p.x; ty = p.y; lt = 1; w0 = 30; }
      else if (d.state === 'plate') { toScreenInto(game.view, d.u, d.v, scr); tx = scr.x; ty = scr.y; w0 = 26; }
      else { slotOf(d, tmp); tx = tmp.x; ty = tmp.y; }
      if (d.state === 'slot' && st.open < 0.02) { d.x = tx; d.y = ty; d.vx = d.vy = 0; }
      spring(d, 'x', 'vx', tx, w0, dt); spring(d, 'y', 'vy', ty, w0, dt);
      spring(d, 'lift', 'vlift', lt, 16, dt);
      if (d.state === 'return' && Math.hypot(d.x - tx, d.y - ty) < 1) d.state = 'slot';
    }

    for (const fk of forks) {
      // a struck fork rings down over the same twelve seconds it can drive the plate
      if (fk.e > 0) { const age = game.t - fk.t0; fk.e = age >= FORK_S ? 0 : Math.pow(1 - age / FORK_S, 1.4); }
      const p = fk.ptr >= 0 ? ptrs.get(fk.ptr) : null;
      if (fk.ptr >= 0 && !p) { fk.ptr = -1; fk.touching = false; if (fk.state === 'drag') fk.state = 'return'; }
      let tx, ty, lt = 0, w0 = 13, ta = 0;
      if (fk.state === 'drag' && p) {
        tx = p.x; ty = p.y; lt = fk.touching ? 0.3 : 1; w0 = 28;
        const iv = (p.x - fk.lastX) / Math.max(dt, 1e-3); fk.lastX = p.x;
        fk.velX += (iv - fk.velX) * Math.min(1, dt * 10);
        ta = clamp(-fk.velX * 0.0006, -0.4, 0.4);
        // the foot on the bronze
        toPlateInto(game.view, fk.x, fk.y, uv);
        const on = Math.abs(uv.u) < 0.985 && Math.abs(uv.v) < 0.985;
        if (on && !fk.touching) { fk.touching = true; if (fk.e > 0.03) touchFork(fk, uv.u, uv.v); else env.emit('sfx', { name: 'tick', pan: env.panOf(fk.x), soft: true }); }
        else if (!on && fk.touching) fk.touching = false;
      } else { forkSlot(fk, tmp); tx = tmp.x; ty = tmp.y; ta = slotAngle(); }
      if (fk.state === 'slot' && st.open < 0.02) { fk.x = tx; fk.y = ty; fk.vx = fk.vy = 0; fk.a = ta; fk.va = 0; }
      spring(fk, 'x', 'vx', tx, w0, dt); spring(fk, 'y', 'vy', ty, w0, dt);
      springAngle(fk, 'a', 'va', ta, 14, dt);
      spring(fk, 'lift', 'vlift', lt, 14, dt);
      if (fk.state === 'return' && Math.hypot(fk.x - tx, fk.y - ty) < 1) fk.state = 'slot';
    }

    // the plate, driven by the touched fork
    if (drive.on) {
      const age = game.t - drive.t0;
      const amp = 0.7 * drive.e0 * Math.pow(Math.max(0, 1 - age / FORK_S), 1.3);
      if (age >= FORK_S || amp < 0.004) { drive.on = false; game.field?.setSource?.('fork', EMPTY); }
      else { forkComps[0].amp = amp; game.field?.setSource?.('fork', forkComps); }
    }
  }

  // ---- drawing ----------------------------------------------------------------------------------
  function drawDamper(ctx, lamp, d, f, alpha) {
    const S = game.view.plate.size;
    const sc = 1 + 0.08 * d.lift;
    const h = S * (0.006 + 0.13 * d.lift);
    const o = lamp.offset(d.x, d.y, h, tmp);
    const sa = lamp.shadowAt(d.x, d.y) * alpha * 0.75;
    ctx.save(); ctx.translate(d.x + o.x, d.y + o.y); ctx.scale(sc, sc);
    blit(ctx, spr.damper.sh, sa * (1 - d.lift)); blit(ctx, spr.damper.shSoft, sa * d.lift * 0.7);
    ctx.restore();
    ctx.save(); ctx.translate(d.x, d.y); ctx.scale(sc, sc);
    blitLit(ctx, spr.damper.lit, spr.damper.dark, alpha, f);
    ctx.restore();
  }

  // one tine, cropped from the long tine sprite to this fork's length (dark base, then lit)
  function drawTine(ctx, tine, dark, sh, dh, x, yb, a, f) {
    if (f < 0.985) { ctx.globalAlpha = a; ctx.drawImage(dark.cv, 0, 0, dark.cv.width, sh, x - tine.ox, yb - dh, tine.w, dh); }
    ctx.globalAlpha = a * clamp01(f);
    ctx.drawImage(tine.cv, 0, 0, tine.cv.width, sh, x - tine.ox, yb - dh, tine.w, dh);
  }
  function drawFork(ctx, lamp, fk, f, alpha, inTrayNow) {
    const s = spr.forks[fk.k];
    if (!s) return;
    const S = game.view.plate.size;
    const tl = tineLen(fk.k), yb = -FG.stemLen - FG.yokeR;
    if (!inTrayNow || fk.lift > 0.02) {
      const h = S * (0.01 + 0.14 * fk.lift);
      const o = lamp.offset(fk.x, fk.y, h, tmp);
      ctx.save(); ctx.translate(fk.x + o.x, fk.y + o.y); ctx.rotate(fk.a);
      blit(ctx, fk.lift > 0.3 ? s.shSoft : s.sh, lamp.shadowAt(fk.x, fk.y) * alpha * 0.6);
      ctx.restore();
    }
    ctx.save();
    ctx.translate(fk.x, fk.y);
    ctx.rotate(fk.a);
    const sc = 1 + 0.05 * fk.lift; ctx.scale(sc, sc);
    blitLit(ctx, s.body, s.dark, alpha, f);
    // tines: blurred by their own vibration while it rings
    const vib = fk.e * FG.tineW * 0.32 * (env.reduced ? 0.4 : 1);
    const tine = spr.forks.tine, dark = spr.forks.tineDark, dpr = tine.dpr;
    const sh = Math.min(tine.cv.height, Math.ceil((tl + FG.tineW * 0.4) * dpr));
    const dh = sh / dpr;
    const ga = ctx.globalAlpha;
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i], x0 = side * FG.yokeR;
      if (vib > 0.25) {
        drawTine(ctx, tine, dark, sh, dh, x0 - vib * side, yb, ga * alpha * 0.34, f);
        drawTine(ctx, tine, dark, sh, dh, x0 - vib * side * 0.33, yb, ga * alpha * 0.34, f);
        drawTine(ctx, tine, dark, sh, dh, x0 + vib * side * 0.33, yb, ga * alpha * 0.34, f);
        drawTine(ctx, tine, dark, sh, dh, x0 + vib * side, yb, ga * alpha * 0.34, f);
      } else drawTine(ctx, tine, dark, sh, dh, x0, yb, ga * alpha, f);
    }
    ctx.globalAlpha = ga;
    // a faint shimmer at the tips while it sings
    if (fk.e > 0.05) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = '#dfe9ff';
      ctx.lineWidth = 0.7;
      for (let i = 1; i <= 2; i++) {
        ctx.globalAlpha = fk.e * 0.25 * alpha * (0.3 + 0.7 * f) / i;
        ctx.beginPath(); ctx.arc(0, yb - dh * 0.92, FG.yokeR + FG.tineW * (1 + i * 1.2) + Math.sin(game.t * 20 + i) * 0.6, -Math.PI * 0.85, -Math.PI * 0.15); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
  }

  function drawPlate(ctx, lamp) {
    if (!spr) return;
    for (const d of dampers) if (d.state === 'plate' && d.lift < 0.5) drawDamper(ctx, lamp, d, lamp.at(d.x, d.y), 1);
  }
  function drawFront(ctx, lamp, alpha) {
    if (!spr || st.open > 0.001) return;
    const top = game.view.vh - FH;
    const f = lamp.at(TX + TW / 2, top) * (hoverFront ? 1.35 : 1);
    ctx.save(); ctx.translate(TX, top);
    blitLit(ctx, spr.front, spr.frontDark, alpha, f);
    ctx.restore();
  }
  function drawTray(ctx, lamp, alpha) {
    if (!spr || st.open <= 0.001) return;
    const top = trayTop();
    const f = 0.04 + lamp.intensity * 0.6;
    ctx.save();
    // the tray's own shadow on the felt above it
    ctx.globalAlpha = alpha * 0.5 * lamp.intensity;
    ctx.fillStyle = '#000';
    ctx.fillRect(TX + 3, top - 5, TW - 6, 6);
    ctx.globalAlpha = 1;
    ctx.translate(TX, top);
    blit(ctx, spr.tray, alpha);
    if (f < 0.985) { ctx.globalAlpha = alpha * (1 - f) * 0.92; ctx.fillStyle = '#0a0807'; ctx.fillRect(0, 0, TW, TH + 2); ctx.globalAlpha = 1; }
    ctx.restore();
    if (env.isOn('dampers')) for (const d of dampers) if (d.state === 'slot') drawDamper(ctx, lamp, d, f, alpha);
    for (const fk of forks) if (fk.state === 'slot' && unlocked(fk)) drawFork(ctx, lamp, fk, f, alpha, true);
    // the front rides at the bottom edge
    ctx.save(); ctx.translate(TX, game.view.vh - FH);
    blitLit(ctx, spr.front, spr.frontDark, alpha, lamp.at(TX + TW / 2, game.view.vh - FH) * (hoverFront ? 1.35 : 1));
    ctx.restore();
  }
  function drawHeld(ctx, lamp) {
    if (!spr) return;
    for (const d of dampers) {
      if (d.state === 'drag' || d.state === 'return' || (d.state === 'plate' && d.lift >= 0.5)) {
        let a = 1;
        if (d.state === 'return' && st.open < 0.3) a = clamp01((game.view.vh - FH - d.y) / 40 + 0.2);
        drawDamper(ctx, lamp, d, lamp.at(d.x, d.y), a);
      }
    }
    for (const fk of forks) {
      if (fk.state === 'drag' || fk.state === 'return') {
        let a = 1;
        if (fk.state === 'return' && st.open < 0.3) a = clamp01((game.view.vh - FH - fk.y) / 40 + 0.2);
        drawFork(ctx, lamp, fk, lamp.at(fk.x, fk.y - forkLen(fk.k) * 0.5), a, false);
      }
    }
  }

  function cursor(x, y) {
    if (st.open > 0.6) {
      if (forkAt(x, y, false)) return 'grab';
      if (env.isOn('dampers') && damperAt(x, y, false, 'slot')) return 'grab';
    }
    if (hitFront(x, y, false)) return 'pointer';
    if (inTray(x, y)) return 'default';
    return null;
  }

  return {
    layout, update, down, move, up, downPlateDamper, collectDampers, toggle, hitFront, cursor,
    inTray: (x, y) => st.open > 0.05 && (inTray(x, y) || hitFront(x, y, false)),
    drawPlate, drawFront, drawTray, drawHeld,
    hover(x, y) { hoverFront = env.isOn('drawer') && hitFront(x, y, false); },
    plateDamperAt: (x, y) => !!damperAt(x, y, false, 'plate'),
    get trayOpen() { return userOpen || st.open > 0.05; },
    get userOpen() { return userOpen; },
    get open() { return st.open; },
    get nForks() { return nForks; },
    dampers, forks, drive, strike,
  };
}
