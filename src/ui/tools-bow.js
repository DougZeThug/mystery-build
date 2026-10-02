// The violin bow: proportions of a real bow (pernambuco stick with camber, ebony frog with a
// mother-of-pearl eye, silver winding, leather grip, ivory-faced head, a ribbon of pale hair),
// baked once per resize; the hair is stroked live so it can press against the plate and blur.
// Physics: the bow follows the hand with a little lag, turns tangent to the nearest plate edge as it
// approaches, and BOWS when the hair is on an edge and the hand moves along it.
import * as Modes from '../sim/modes.js';
import { clamp, clamp01, smooth, angDiff, bake, bakeShadow, bakeTint, blit, seeded, spring, springAngle } from './tools-art.js';

// ---- proportions (fractions of the bow length L; local x frog→tip, y = 0 is the hair line, the
// stick lies at negative y) -------------------------------------------------------------------------
const P = {
  btn0: 0, btn1: 0.027, btnR: 0.0068,
  frog0: 0.0235, frog1: 0.0868,
  lea0: 0.074, lea1: 0.097,
  win0: 0.097, win1: 0.172,
  head0: 0.93,
  hair0: 0.086, hair1: 0.983,
};
const EDGE_NAMES = ['top', 'right', 'bottom', 'left'];
const G_FROG = 0.036, G_MID = 0.0135, G_TIP = 0.0215, X_MID = 0.53;
// hair-to-stick-centreline distance: wide over the frog, narrowest past the middle (camber), rising at the head
export function gapAt(x) {
  if (x <= 0.09) return G_FROG;
  if (x < X_MID) { const s = (X_MID - x) / (X_MID - 0.09); return G_MID + (G_FROG - G_MID) * s * s * (1.35 - 0.35 * s); }
  const s = Math.min(1, (x - X_MID) / (0.955 - X_MID));
  return G_MID + (G_TIP - G_MID) * Math.pow(s, 2.2);
}
// stick diameter: 8.6 mm at the frog tapering to 5.5 mm under the head (on a 750 mm bow)
export function thickAt(x) {
  if (x <= 0.1) return 0.0118;
  return 0.0118 - 0.0044 * Math.pow(clamp01((x - 0.1) / 0.85), 0.85);
}
const stickTop = (x) => -gapAt(x) - thickAt(x) * 0.5;
const stickBot = (x) => -gapAt(x) + thickAt(x) * 0.5;

// ---- palette -------------------------------------------------------------------------------------
const WOOD = '#6b2e17', WOOD_DK = '#3a150a', WOOD_HI = '#b0603a', WOOD_SPEC = '#f6c9a0';
const EBONY = '#141011', EBONY_HI = '#4a4246';
const SILVER = '#a8a9a5', SILVER_HI = '#f4f4ef', SILVER_DK = '#56574f';
const IVORY = '#efe6cf', IVORY_DK = '#b9ac8c';
const LEATHER = '#3b2416';
const HAIR = '#e9e1cb', HAIR_HI = '#fffaf0', HAIR_DK = '#b4a88d', HAIR_BASE = '#15100b';

// ---- the baked bow ---------------------------------------------------------------------------------
function bakeBow(L, dpr) {
  const pad = 4;
  const top = (G_FROG + P.btnR) * L + pad, bot = 0.006 * L + pad;
  const left = 0.006 * L + pad, right = 0.012 * L + pad;
  const W = L + left + right, H = top + bot;
  const rnd = seeded(0x5b0e);
  const X = (f) => f * L, Y = (f) => f * L;

  const lit = bake(W, H, left, top, dpr, (g) => {
    g.lineJoin = 'round'; g.lineCap = 'round';
    // --- stick: a cambered, tapering pernambuco rod ---
    const N = 96, x0 = 0.0, x1 = 0.985;
    const stickPath = () => {
      g.beginPath();
      for (let i = 0; i <= N; i++) { const f = x0 + (x1 - x0) * (i / N); g[i ? 'lineTo' : 'moveTo'](X(f), Y(stickTop(f))); }
      for (let i = N; i >= 0; i--) { const f = x0 + (x1 - x0) * (i / N); g.lineTo(X(f), Y(stickBot(f))); }
      g.closePath();
    };
    const along = (off, xa = x0, xb = x1, wav = 0, ph = 0) => {   // a line following the stick at a fractional offset of its thickness
      g.beginPath();
      const n = 60;
      for (let i = 0; i <= n; i++) {
        const f = xa + (xb - xa) * (i / n);
        const y = -gapAt(f) + thickAt(f) * (off + wav * Math.sin(f * 90 + ph));
        g[i ? 'lineTo' : 'moveTo'](X(f), Y(y));
      }
    };
    stickPath(); g.fillStyle = WOOD; g.fill();
    g.save(); stickPath(); g.clip();
    // grain: long fibres with slow waviness, darker and lighter
    for (let i = 0; i < 16; i++) {
      const off = (rnd() - 0.5) * 0.85;
      along(off, rnd() * 0.3, 0.7 + rnd() * 0.3, 0.04 + rnd() * 0.05, rnd() * 6);
      g.strokeStyle = rnd() < 0.6 ? WOOD_DK : '#a4552e';
      g.globalAlpha = 0.18 + rnd() * 0.25;
      g.lineWidth = 0.35 + rnd() * 0.5;
      g.stroke();
    }
    // a few short dark flecks (pores)
    for (let i = 0; i < 70; i++) {
      const f = 0.02 + rnd() * 0.95, y = -gapAt(f) + thickAt(f) * (rnd() - 0.5) * 0.8;
      g.globalAlpha = 0.25 + rnd() * 0.3; g.fillStyle = WOOD_DK;
      g.fillRect(X(f), Y(y), 1.2 + rnd() * 2.5, 0.45);
    }
    g.globalAlpha = 1;
    // round shading: dark edges, warm body, a highlight down the middle (the lamp is overhead)
    along(-0.5); g.strokeStyle = WOOD_DK; g.lineWidth = Math.max(0.8, thickAt(0.5) * L * 0.38); g.globalAlpha = 0.55; g.stroke();
    along(0.5); g.stroke();
    along(-0.06); g.strokeStyle = WOOD_HI; g.lineWidth = Math.max(0.9, thickAt(0.5) * L * 0.42); g.globalAlpha = 0.5; g.stroke();
    along(-0.14, 0.03, 0.97); g.strokeStyle = WOOD_SPEC; g.lineWidth = Math.max(0.5, thickAt(0.5) * L * 0.12); g.globalAlpha = 0.55; g.stroke();
    // octagonal facets near the frog
    along(-0.27, 0.02, 0.36); g.strokeStyle = '#c27248'; g.lineWidth = 0.5; g.globalAlpha = 0.35; g.stroke();
    along(0.24, 0.02, 0.36); g.strokeStyle = WOOD_DK; g.globalAlpha = 0.3; g.stroke();
    g.restore();
    g.globalAlpha = 1;
    stickPath(); g.strokeStyle = '#2a0f06'; g.lineWidth = 0.6; g.globalAlpha = 0.7; g.stroke(); g.globalAlpha = 1;

    // --- head (hatchet) with its ivory face ---
    const hx = (f) => X(f), hy = (f) => Y(f);
    const tTop = stickTop(0.985), bA = stickBot(0.93);
    const headPath = () => {
      g.beginPath();
      g.moveTo(hx(0.925), hy(stickTop(0.925)));
      g.lineTo(hx(0.992), hy(tTop));
      g.quadraticCurveTo(hx(1.0), hy(tTop), hx(1.0), hy(tTop + 0.004));
      g.lineTo(hx(1.0), hy(-0.0015));
      g.lineTo(hx(0.9975), hy(0.0029));
      g.lineTo(hx(0.984), hy(0.0029));
      g.bezierCurveTo(hx(0.976), hy(-0.006), hx(0.962), hy(bA), hx(0.925), hy(stickBot(0.925)));
      g.closePath();
    };
    headPath(); g.fillStyle = WOOD; g.fill();
    g.save(); headPath(); g.clip();
    const hg = g.createLinearGradient(hx(0.93), 0, hx(1.0), 0);
    hg.addColorStop(0, 'rgba(176,96,58,0)'); hg.addColorStop(0.6, 'rgba(176,96,58,0.45)'); hg.addColorStop(1, 'rgba(58,21,10,0.5)');
    g.fillStyle = hg; g.fillRect(hx(0.92), hy(tTop) - 2, hx(0.09), hy(0.03) + 4);
    for (let i = 0; i < 5; i++) { g.strokeStyle = WOOD_DK; g.globalAlpha = 0.25; g.lineWidth = 0.4; g.beginPath(); g.moveTo(hx(0.93), hy(tTop + 0.002 + i * 0.004)); g.quadraticCurveTo(hx(0.975), hy(tTop + 0.003 + i * 0.0045), hx(0.995), hy(tTop + 0.006 + i * 0.006)); g.stroke(); }
    g.restore(); g.globalAlpha = 1;
    headPath(); g.strokeStyle = '#2a0f06'; g.lineWidth = 0.6; g.stroke();
    // ivory tip plate: the front face and the underside
    g.beginPath();
    g.moveTo(hx(0.985), hy(0.0031));
    g.lineTo(hx(0.9985), hy(0.0031));
    g.lineTo(hx(1.0015), hy(-0.0015));
    g.lineTo(hx(1.0015), hy(tTop + 0.0045));
    g.strokeStyle = IVORY; g.lineWidth = Math.max(1.1, 0.0034 * L); g.lineJoin = 'round'; g.stroke();
    g.strokeStyle = IVORY_DK; g.lineWidth = 0.45; g.globalAlpha = 0.8;
    g.beginPath(); g.moveTo(hx(0.986), hy(0.0013)); g.lineTo(hx(0.997), hy(0.0013)); g.lineTo(hx(0.9993), hy(-0.0015)); g.lineTo(hx(0.9993), hy(tTop + 0.004)); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = '#fffaf0'; g.globalAlpha = 0.7; g.fillRect(hx(1.0012), hy(tTop + 0.006), 0.6, hy(0.009)); g.globalAlpha = 1;

    // --- button (adjuster): ebony with two silver collars ---
    const by = Y(-G_FROG), br = Y(P.btnR);
    g.beginPath(); g.roundRect ? g.roundRect(X(P.btn0) - 1, by - br, X(P.btn1 - P.btn0) + 1, br * 2, [br * 0.9, 1, 1, br * 0.9]) : g.rect(X(P.btn0) - 1, by - br, X(P.btn1), br * 2);
    g.fillStyle = EBONY; g.fill();
    const collar = (a, b) => {
      const sg = g.createLinearGradient(0, by - br, 0, by + br);
      sg.addColorStop(0, SILVER_DK); sg.addColorStop(0.35, SILVER_HI); sg.addColorStop(0.6, SILVER); sg.addColorStop(1, SILVER_DK);
      g.fillStyle = sg; g.fillRect(X(a), by - br - 0.3, X(b - a), br * 2 + 0.6);
    };
    collar(0.0035, 0.0068); collar(0.0195, 0.0245);
    g.fillStyle = EBONY_HI; g.globalAlpha = 0.6; g.fillRect(X(0.007), by - br * 0.35, X(0.012), br * 0.25); g.globalAlpha = 1;

    // --- frog ---
    const fTop = Y(stickBot(0.05));
    const frogPath = () => {
      g.beginPath();
      g.moveTo(X(0.027), fTop);
      g.lineTo(X(0.0855), fTop);
      g.bezierCurveTo(X(0.0765), Y(-0.019), X(0.0735), Y(-0.010), X(0.0795), Y(-0.0075));
      g.lineTo(X(0.0866), Y(-0.006));
      g.lineTo(X(0.0866), Y(0.0025));
      g.lineTo(X(0.029), Y(0.0036));
      g.quadraticCurveTo(X(0.0232), Y(0.0036), X(0.0232), Y(-0.004));
      g.lineTo(X(0.0232), fTop + Y(0.005));
      g.quadraticCurveTo(X(0.0232), fTop, X(0.027), fTop);
      g.closePath();
    };
    frogPath(); g.fillStyle = EBONY; g.fill();
    g.save(); frogPath(); g.clip();
    const eg = g.createLinearGradient(0, fTop, 0, Y(0.004));
    eg.addColorStop(0, 'rgba(90,80,86,0.55)'); eg.addColorStop(0.3, 'rgba(40,34,37,0)'); eg.addColorStop(0.85, 'rgba(0,0,0,0.3)');
    g.fillStyle = eg; g.fillRect(X(0.02), fTop, X(0.07), Y(0.04));
    // ebony figure: faint dark streaks
    for (let i = 0; i < 9; i++) { g.strokeStyle = '#2c2528'; g.globalAlpha = 0.5; g.lineWidth = 0.5; const yy = fTop + rnd() * Y(0.03); g.beginPath(); g.moveTo(X(0.023), yy); g.lineTo(X(0.087), yy + (rnd() - 0.5) * 3); g.stroke(); }
    g.restore(); g.globalAlpha = 1;
    // silver heel plate (back face) and underslide
    g.strokeStyle = SILVER; g.lineWidth = Math.max(0.9, 0.0028 * L);
    g.beginPath(); g.moveTo(X(0.0236), fTop + Y(0.005)); g.lineTo(X(0.0236), Y(-0.004)); g.quadraticCurveTo(X(0.0236), Y(0.0032), X(0.029), Y(0.0032)); g.stroke();
    g.strokeStyle = SILVER_HI; g.lineWidth = 0.5; g.stroke();
    // pearl slide along the hair side
    const pg = g.createLinearGradient(X(0.03), 0, X(0.08), 0);
    pg.addColorStop(0, '#e8e2d6'); pg.addColorStop(0.3, '#d6e4e6'); pg.addColorStop(0.55, '#eadcec'); pg.addColorStop(0.8, '#d9ecdd'); pg.addColorStop(1, '#efe9de');
    g.fillStyle = pg; g.fillRect(X(0.029), Y(0.0008), X(0.0505), Y(0.0027));
    g.fillStyle = SILVER_DK; g.fillRect(X(0.029), Y(0.0003), X(0.0505), 0.5);
    // ferrule: the silver band the hair fans out of
    const fg = g.createLinearGradient(0, Y(-0.0075), 0, Y(0.0035));
    fg.addColorStop(0, SILVER_DK); fg.addColorStop(0.3, SILVER_HI); fg.addColorStop(0.65, SILVER); fg.addColorStop(1, SILVER_DK);
    g.beginPath(); g.moveTo(X(0.0795), Y(-0.0076)); g.lineTo(X(0.0868), Y(-0.0062)); g.lineTo(X(0.0868), Y(0.0026)); g.lineTo(X(0.0795), Y(0.0036)); g.closePath();
    g.fillStyle = fg; g.fill();
    // the eye: a silver ring around a disc of mother-of-pearl
    const ex = X(0.052), ey = Y(-0.0138), er = Y(0.0054);
    g.beginPath(); g.arc(ex, ey, er, 0, Math.PI * 2); g.fillStyle = SILVER; g.fill();
    g.beginPath(); g.arc(ex, ey, er * 0.78, 0, Math.PI * 2);
    const rg = g.createRadialGradient(ex - er * 0.3, ey - er * 0.35, er * 0.05, ex, ey, er * 0.8);
    rg.addColorStop(0, '#ffffff'); rg.addColorStop(0.3, '#c8f1ef'); rg.addColorStop(0.55, '#f2c9f0'); rg.addColorStop(0.8, '#c6f0d2'); rg.addColorStop(1, '#93a9c4');
    g.fillStyle = rg; g.fill();
    g.beginPath(); g.arc(ex - er * 0.3, ey - er * 0.32, er * 0.18, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.9)'; g.fill();
    g.beginPath(); g.arc(ex, ey, er, 0, Math.PI * 2); g.strokeStyle = SILVER_HI; g.lineWidth = 0.45; g.stroke();
    frogPath(); g.strokeStyle = '#000'; g.lineWidth = 0.5; g.globalAlpha = 0.8; g.stroke(); g.globalAlpha = 1;

    // --- leather thumb grip ---
    const wrap = (a, b, extra, fill) => {
      g.beginPath();
      const n = 12;
      for (let i = 0; i <= n; i++) { const f = a + (b - a) * i / n; g[i ? 'lineTo' : 'moveTo'](X(f), Y(-gapAt(f) - thickAt(f) / 2 - extra)); }
      for (let i = n; i >= 0; i--) { const f = a + (b - a) * i / n; g.lineTo(X(f), Y(-gapAt(f) + thickAt(f) / 2 + extra)); }
      g.closePath();
      g.fillStyle = fill; g.fill();
    };
    wrap(P.lea0, P.lea1, 0.0012, LEATHER);
    g.save(); wrap(P.lea0, P.lea1, 0.0012, LEATHER); g.clip();
    for (let i = 0; i < 40; i++) { g.fillStyle = rnd() < 0.5 ? '#25150c' : '#5a3a26'; g.globalAlpha = 0.5; g.fillRect(X(P.lea0 + rnd() * (P.lea1 - P.lea0)), Y(-G_FROG - 0.008 + rnd() * 0.016), 0.8, 0.8); }
    g.globalAlpha = 0.35; g.strokeStyle = '#7a5538'; g.lineWidth = Math.max(0.6, thickAt(0.08) * L * 0.25);
    g.beginPath(); g.moveTo(X(P.lea0), Y(-G_FROG - 0.0015)); g.lineTo(X(P.lea1), Y(-G_FROG - 0.0015)); g.stroke();
    g.restore(); g.globalAlpha = 1;

    // --- silver winding: fine wire lapping ---
    wrap(P.win0, P.win1, 0.0007, SILVER);
    g.save(); wrap(P.win0, P.win1, 0.0007, SILVER); g.clip();
    const wy0 = Y(stickTop(0.13) - 0.002), wy1 = Y(stickBot(0.13) + 0.002);
    const sg = g.createLinearGradient(0, wy0, 0, wy1);
    sg.addColorStop(0, SILVER_DK); sg.addColorStop(0.32, SILVER_HI); sg.addColorStop(0.5, '#d3d4cf'); sg.addColorStop(1, '#4a4b45');
    g.fillStyle = sg; g.fillRect(X(P.win0), wy0 - 4, X(P.win1 - P.win0), wy1 - wy0 + 8);
    // fine silver wire: tight turns, a bright band where the lamp catches the round
    g.strokeStyle = '#4a4b45'; g.lineWidth = 0.28; g.globalAlpha = 0.45;
    const step = Math.max(0.6, L * 0.0011);
    for (let xx = X(P.win0) - 6; xx < X(P.win1) + 6; xx += step) { g.beginPath(); g.moveTo(xx, wy0 - 3); g.lineTo(xx + 1.2, wy1 + 3); g.stroke(); }
    g.globalAlpha = 0.55; g.fillStyle = '#ffffff';
    g.fillRect(X(P.win0), wy0 + (wy1 - wy0) * 0.28, X(P.win1 - P.win0), Math.max(0.5, (wy1 - wy0) * 0.12));
    g.restore(); g.globalAlpha = 1;
  });

  // silhouette including the hair ribbon, for the cast shadows
  const silSrc = bake(W, H, left, top, dpr, (g) => {
    g.drawImage(lit.cv, -left, -top, W, H);
    g.strokeStyle = '#000'; g.lineWidth = Math.max(1.6, L * 0.0056);
    g.beginPath(); g.moveTo(P.hair0 * L, 0); g.lineTo(P.hair1 * L, 0); g.stroke();
  });
  const gr = Math.max(8, L * 0.03);
  const glow = bake(gr * 2, gr * 2, gr, gr, dpr, (g) => {
    const rg = g.createRadialGradient(0, 0, 0, 0, 0, gr);
    rg.addColorStop(0, 'rgba(255,246,225,0.95)'); rg.addColorStop(0.18, 'rgba(255,236,200,0.45)'); rg.addColorStop(1, 'rgba(255,220,170,0)');
    g.fillStyle = rg; g.fillRect(-gr, -gr, gr * 2, gr * 2);
  });
  return {
    lit, glow,
    dark: bakeTint(lit, '#0d0a08'),
    shSharp: bakeShadow(silSrc, Math.max(1.2, L * 0.003)),
    shSoft: bakeShadow(silSrc, Math.max(5, L * 0.016)),
  };
}

// ---- the bow as an object -------------------------------------------------------------------------
export function createBow(env) {
  const { game } = env;
  const out = env.publicBow;           // tools.bow: read by audio and the field each frame
  const EMPTY = [];
  const comps = [{ mode: null, amp: 0 }];
  const evMove = { edge: null, t: 0, speed: 0, mode: null };   // reused: emitted every frame while bowing
  const suppressFn = (m) => (game.field?.suppression ? game.field.suppression(m) : 0);
  const selector = typeof Modes.createBowSelector === 'function' ? Modes.createBowSelector(0.16) : null;
  const pick = (edge, t, s, dt) => {
    if (selector) return selector.pick(edge, t, s, dt, suppressFn);
    return Modes.bowPick(edge, t, s, out.mode, suppressFn);
  };

  let L = 400, sprites = null, dprBaked = 0, Lbaked = 0;
  const pose = { x: 0, y: 0, a: 0, f: 1, vx: 0, vy: 0, va: 0, vf: 0, lift: 0, vlift: 0, sc: 1, vsc: 0 };
  const rest = { x: 0, y: 0, a: 0, f: 1 };
  const grab = { id: -1, sx: 0, sy: 0, aFree: 0, snapped: false, fast: false };
  const tgt = { x: 0, y: 0, a: 0, f: 1 };
  const E = { name: null, d: 1e9, t: 0, tx: 0, ty: 0, nx: 0, ny: 0, ex: 0, ey: 0, inside: 0 };
  const tmp = { x: 0, y: 0 };
  let curEdge = null;
  let contact = false, contactLX = 0, pressure = 0, amp = 0, sp = 0, spFast = 0, spPick = 0, tPick = -1, pickEdge = null;
  let lastPx = 0, lastPy = 0, lastT = 0, vpx = 0, vpy = 0;
  let returning = false, travelled = 0;
  let glintT = 0, idle = 0;
  let pressT = 0;

  function layout() {
    const v = game.view, S = v.plate.size, X0 = v.plate.x, Y0 = v.plate.y;
    const an = v.anchors?.bow || { x: X0 + S * 1.02, y: Y0 + S * 0.62, angle: -1.2 };
    if (v.mode === 'landscape') {
      // tip resting against the right edge, the frog away up and to the right
      const ar = Number.isFinite(an.angle) ? an.angle : -1.2;
      const th = ar + Math.PI;                     // frog→tip direction
      const cx = X0 + S + 1;
      const sinA = Math.abs(Math.sin(ar)) || 0.9, cosA = Math.abs(Math.cos(ar)) || 0.4;
      const marginTop = Math.max(16, v.vh * 0.05), marginR = 16;
      let yc = clamp(an.y, Y0 + S * 0.3, Y0 + S * 0.88);
      let Lmax = Math.min((yc - marginTop) / sinA, (v.vw - marginR - cx) / Math.max(0.05, cosA));
      if (Lmax < S * 0.95) { yc = Y0 + S * 0.88; Lmax = Math.min((yc - marginTop) / sinA, (v.vw - marginR - cx) / Math.max(0.05, cosA)); }
      L = Math.round(clamp(Math.min(S * 1.0, Lmax), S * 0.55, S * 1.1));
      rest.a = th; rest.f = 1;
      rest.x = cx - Math.cos(th) * L; rest.y = yc - Math.sin(th) * L;
    } else {
      // lying along the bottom edge, hair touching it, frog to the right
      const ar = Number.isFinite(an.angle) ? an.angle : -0.08;
      const th = ar + Math.PI;
      L = Math.round(clamp(Math.min(v.vw - 28, S * 1.12), S * 0.6, S * 1.2));
      const c = Math.cos(th), s = Math.sin(th);
      let mx = clamp(an.x, 14 + L * 0.5 * Math.abs(c), v.vw - 14 - L * 0.5 * Math.abs(c));
      rest.a = th; rest.f = 1;
      rest.x = mx - c * L * 0.5; rest.y = an.y - s * L * 0.5;
      // touch: the highest point of the hair sits on the bottom edge
      const hy0 = rest.y + s * P.hair0 * L, hy1 = rest.y + s * P.hair1 * L;
      rest.y += (Y0 + S + 1.5) - Math.min(hy0, hy1);
    }
    const dpr = v.dpr || 1;
    if (!sprites || Math.abs(L - Lbaked) > 0.5 || dpr !== dprBaked) { sprites = bakeBow(L, dpr); Lbaked = L; dprBaked = dpr; }
    if (grab.id < 0) { pose.x = rest.x; pose.y = rest.y; pose.a = rest.a; pose.f = rest.f; pose.vx = pose.vy = pose.va = pose.vf = 0; }
  }

  // nearest plate edge to a point (with hysteresis for the edge in use)
  function edgeAt(px, py, out) {
    const pl = game.view.plate, X0 = pl.x, Y0 = pl.y, S = pl.size;
    let best = null, bd = 1e9;
    for (let i = 0; i < 4; i++) {
      const name = EDGE_NAMES[i];
      let d, t;
      if (i === 0) { d = Math.abs(py - Y0); t = (px - X0) / S; }
      else if (i === 1) { d = Math.abs(px - (X0 + S)); t = (py - Y0) / S; }
      else if (i === 2) { d = Math.abs(py - (Y0 + S)); t = (X0 + S - px) / S; }
      else { d = Math.abs(px - X0); t = (Y0 + S - py) / S; }
      if (t < -0.05 || t > 1.05) continue;
      const dd = name === curEdge ? d - 6 : d;
      if (dd < bd) { bd = dd; best = name; }
    }
    out.name = best;
    if (!best) { out.d = 1e9; return out; }
    switch (best) {
      case 'top': out.t = (px - X0) / S; out.tx = 1; out.ty = 0; out.nx = 0; out.ny = -1; out.ex = px; out.ey = Y0; out.d = Math.abs(py - Y0); out.inside = py - Y0; break;
      case 'right': out.t = (py - Y0) / S; out.tx = 0; out.ty = 1; out.nx = 1; out.ny = 0; out.ex = X0 + S; out.ey = py; out.d = Math.abs(px - X0 - S); out.inside = X0 + S - px; break;
      case 'bottom': out.t = (X0 + S - px) / S; out.tx = -1; out.ty = 0; out.nx = 0; out.ny = 1; out.ex = px; out.ey = Y0 + S; out.d = Math.abs(py - Y0 - S); out.inside = Y0 + S - py; break;
      default: out.t = (Y0 + S - py) / S; out.tx = 0; out.ty = -1; out.nx = -1; out.ny = 0; out.ex = X0; out.ey = py; out.d = Math.abs(px - X0); out.inside = px - X0;
    }
    // keep the contact on the edge itself near the corners
    const tc = clamp(out.t, 0, 1);
    if (tc !== out.t) {
      const dt = (tc - out.t) * S;
      out.ex += out.tx * dt; out.ey += out.ty * dt;
    }
    return out;
  }

  const band = () => game.view.plate.size * 0.08;

  function hit(px, py, touch) {
    const pad = touch ? 16 : 9;
    const dx = px - pose.x, dy = py - pose.y, c = Math.cos(pose.a), s = Math.sin(pose.a);
    const sc = pose.sc || 1;
    const lx = (dx * c + dy * s) / sc;
    let ly = (-dx * s + dy * c) / sc;
    const fa = Math.abs(pose.f);
    ly = ly / Math.max(0.3, fa) * (pose.f < 0 ? -1 : 1);
    if (lx < -pad || lx > L + pad) return false;
    const f = clamp01(lx / L);
    const topY = -(gapAt(f) + thickAt(f) * 0.6) * L - pad;
    return ly >= topY && ly <= pad + 2;
  }

  function localOf(px, py, o) {
    const dx = px - pose.x, dy = py - pose.y, c = Math.cos(pose.a), s = Math.sin(pose.a);
    o.x = dx * c + dy * s;
    o.y = (-dx * s + dy * c) * (pose.f < 0 ? -1 : 1);
    return o;
  }

  function pickUp(id, px, py, fast) {
    grab.id = id; grab.fast = !!fast; grab.snapped = false; returning = false; travelled = 0;
    localOf(px, py, tmp);
    grab.sx = clamp(tmp.x, 0, L); grab.sy = clamp(tmp.y, -G_FROG * L, 0);
    grab.aFree = pose.a;
    if (fast) { grab.sx = L * 0.56; grab.sy = 0; }
    lastPx = px; lastPy = py; lastT = performance.now(); vpx = vpy = 0;
    sp = 0; spFast = 0; spPick = 0; amp = 0; curEdge = null;
    out.held = true;
    idle = 0;
    env.emit('sfx', { name: 'grab', pan: panOf(px) });
  }

  function drop() {
    if (contact) endContact();
    grab.id = -1; out.held = false; returning = true; travelled = 0;
    curEdge = null;
  }

  const panOf = (x) => clamp((x / Math.max(1, game.view.vw)) * 2 - 1, -1, 1) * 0.8;

  function startContact() {
    contact = true; spPick = 0; sp = 0; tPick = -1;
    out.bowing = true; out.edge = E.name; out.t = clamp(E.t, 0, 1);
    env.emit('bow:start', { edge: out.edge, t: out.t });
    if (game.state) { game.state.tools ||= {}; game.state.tools.bowed = true; }
  }
  function endContact() {
    contact = false;
    out.bowing = false;
    selector?.reset?.();
    game.field?.setSource?.('bow', EMPTY);
    amp = 0;
    env.emit('bow:end', {});
  }

  function update(dt, ptr) {
    const S = game.view.plate.size;
    const fullSpeed = 900 * clamp(S / 576, 0.6, 1.3);
    let omegaP = 9, omegaA = 7, liftT = 0;
    let wEdge = 0;
    if (grab.id >= 0 && ptr) {
      const px = ptr.x, py = ptr.y;
      // pointer velocity, measured in real time (the frame dt is clamped on slow machines, and
      // the hand's speed is what picks the note)
      const now = performance.now();
      const rdt = clamp((now - lastT) / 1000, 0.004, 0.25);
      lastT = now;
      const ivx = (px - lastPx) / rdt, ivy = (py - lastPy) / rdt;
      lastPx = px; lastPy = py;
      const kv = 1 - Math.exp(-rdt / 0.05);
      vpx += (ivx - vpx) * kv; vpy += (ivy - vpy) * kv;
      edgeAt(px, py, E);
      const B = band();
      if (E.name) wEdge = 1 - smooth(B, B * 2.4, E.d);
      if (grab.fast && E.name) wEdge = Math.max(wEdge, 1 - smooth(B * 1.2, B * 2.6, E.d));
      if (wEdge > 0.999) curEdge = E.name; else if (wEdge < 0.5) curEdge = null;

      // free carry: the grip point under the hand; the bow trails a little when swung sideways
      const c0 = Math.cos(grab.aFree), s0 = Math.sin(grab.aFree);
      const vperp = -vpx * s0 + vpy * c0;
      const lever = (L * 0.5 - grab.sx) / L;
      const swing = clamp(-vperp * 0.00045 * lever * 2, -0.3, 0.3);
      const aF = grab.aFree + swing;
      const cf = Math.cos(aF), sf = Math.sin(aF), ff = pose.f < 0 ? -1 : 1;
      let fx = px - (cf * grab.sx - sf * grab.sy * ff), fy = py - (sf * grab.sx + cf * grab.sy * ff);
      tgt.x = fx; tgt.y = fy; tgt.a = aF; tgt.f = ff;

      if (wEdge > 0) {
        // tangent to the edge, whichever way round is closer; stick outside, hair on the edge
        const te = Math.atan2(E.ty, E.tx);
        const ta = Math.abs(angDiff(pose.a, te)) <= Math.PI / 2 ? te : te + Math.PI;
        const fe = Math.sin(ta) * E.nx - Math.cos(ta) * E.ny >= 0 ? 1 : -1;
        if (grab.fast && !grab.snapped) {
          // snapped in from the edge: lay the bow centred along the edge, the hand on its hair
          const pl = game.view.plate, ecx = E.name === 'left' ? pl.x : E.name === 'right' ? pl.x + pl.size : pl.cx;
          const ecy = E.name === 'top' ? pl.y : E.name === 'bottom' ? pl.y + pl.size : pl.cy;
          grab.sx = clamp(L * 0.5 + (px - ecx) * Math.cos(ta) + (py - ecy) * Math.sin(ta), (P.hair0 + 0.06) * L, (P.hair1 - 0.06) * L);
          grab.snapped = true;
        }
        const sxC = clamp(grab.sx, (P.hair0 + 0.04) * L, (P.hair1 - 0.04) * L);
        const insideP = clamp01((E.inside + B * 0.25) / (B * 1.15));
        const defl = (1.1 + 2.4 * insideP) * (L / 560);
        const ox = E.nx * (defl - 1.2), oy = E.ny * (defl - 1.2);
        const ex = E.ex + ox - Math.cos(ta) * sxC, ey = E.ey + oy - Math.sin(ta) * sxC;
        const w = wEdge * wEdge * (3 - 2 * wEdge);
        tgt.x = fx + (ex - fx) * w; tgt.y = fy + (ey - fy) * w;
        tgt.a = aF + angDiff(aF, ta) * w;
        tgt.f = w > 0.5 ? fe : ff;
        pressure = insideP;
      }

      const far = Math.hypot(tgt.x - pose.x, tgt.y - pose.y);
      omegaP = wEdge > 0.99 ? (far > 70 ? 22 : 36) : 20;
      omegaA = wEdge > 0.5 ? 20 : 15;
      liftT = wEdge > 0.99 ? 0.22 : 1;
    } else {
      tgt.x = rest.x; tgt.y = rest.y; tgt.a = rest.a; tgt.f = rest.f;
    }

    const px0 = pose.x, py0 = pose.y;
    spring(pose, 'x', 'vx', tgt.x, omegaP, dt);
    spring(pose, 'y', 'vy', tgt.y, omegaP, dt);
    springAngle(pose, 'a', 'va', tgt.a, omegaA, dt);
    spring(pose, 'f', 'vf', tgt.f, 18, dt);
    spring(pose, 'lift', 'vlift', liftT, grab.id >= 0 ? 16 : 8, dt);
    spring(pose, 'sc', 'vsc', 1 + 0.035 * pose.lift, 14, dt);
    // after visiting an edge the bow keeps that orientation when carried away from it
    if (grab.id >= 0 && wEdge > 0.6) grab.aFree = pose.a;
    travelled += Math.hypot(pose.x - px0, pose.y - py0);

    // contact and bowing
    // the hair is on the edge when the bow sits on the edge line (its lag along the edge is just
    // the hand's inertia), lies along it, and has finished rolling hair-side in
    let onEdge = false;
    if (grab.id >= 0 && E.name && wEdge > (contact ? 0.95 : 0.999)) {
      const dn = Math.abs((pose.x - tgt.x) * E.nx + (pose.y - tgt.y) * E.ny);
      const da = Math.abs(angDiff(pose.a, tgt.a)), df = Math.abs(pose.f - tgt.f);
      onEdge = contact ? dn < 24 && da < 0.35 && df < 0.6 : dn < 10 && da < 0.2 && df < 0.35;
    }
    if (onEdge && !contact) startContact();
    else if (!onEdge && contact) endContact();

    if (contact) {
      const vt = vpx * E.tx + vpy * E.ty;
      if (sp === 0) sp = Math.abs(vt);              // a stroke starts at the speed it starts at
      const kS = 1 - Math.exp(-dt / 0.14), kF = 1 - Math.exp(-dt / 0.045);
      sp += (Math.abs(vt) - sp) * kS;
      spFast += (Math.abs(vt) - spFast) * kF;
      const moving = spFast > 28;
      out.speed01 = clamp01(sp / fullSpeed);
      out.edge = E.name; out.t = clamp(E.t, 0, 1);
      if (moving) {
        // the note follows the stroke's vigour over half a second, so turning the bow at the
        // end of a stroke keeps the same note
        if (spPick <= 0) spPick = out.speed01;
        spPick += (out.speed01 - spPick) * (1 - Math.exp(-dt / 0.5));
        // ... and the place it sounds is where the strokes are centred, not where the hair is
        // this instant (back-and-forth strokes cross nodal points without changing the figure)
        if (tPick < 0 || pickEdge !== out.edge) { tPick = out.t; pickEdge = out.edge; }
        tPick += (out.t - tPick) * (1 - Math.exp(-dt / 0.7));
        const m = pick(out.edge, tPick, spPick, dt);
        if (m) out.mode = m;
      }
      const target = moving ? 0.25 + 0.9 * out.speed01 : 0;
      amp += (target - amp) * (1 - Math.exp(-dt / (moving ? 0.07 : 0.35)));
      if (out.mode && amp > 0.008) { comps[0].mode = out.mode; comps[0].amp = amp; game.field?.setSource?.('bow', comps); }
      else game.field?.setSource?.('bow', EMPTY);
      out.x = E.ex; out.y = E.ey;
      evMove.edge = out.edge; evMove.t = out.t; evMove.speed = out.speed01; evMove.mode = out.mode;
      if (moving) env.emit('bow:move', evMove);
      // rosin dust at the contact, more with vigour
      const rate = amp * (8 + 60 * out.speed01) * (env.reduced ? 0.4 : 1);
      pressT += dt * rate;
      while (pressT > 1) {
        pressT -= 1;
        // most of the rosin powders onto the bronze beside the hair; a little floats off
        const side = (Math.random() - 0.5) * 2, inward = Math.random() < 0.75 ? -1 : 1;
        const sp0 = inward < 0 ? 6 + Math.random() * 22 : 10 + Math.random() * 30;
        env.dust(E.ex + E.tx * side * 4 - E.nx * 1.5, E.ey + E.ty * side * 4 - E.ny * 1.5,
          E.nx * sp0 * inward + E.tx * vt * 0.06 + (Math.random() - 0.5) * 12,
          E.ny * sp0 * inward + E.ty * vt * 0.06 + (Math.random() - 0.5) * 12,
          0.6 + Math.random() * 1.1, 0.5 + Math.random() * 0.7);
      }
      localOf(E.ex, E.ey, tmp); contactLX = clamp(tmp.x, (P.hair0 + 0.02) * L, (P.hair1 - 0.02) * L);
    } else {
      out.speed01 += (0 - out.speed01) * Math.min(1, dt * 6);
      if (!out.bowing) out.mode = null;
      const mx = pose.x + Math.cos(pose.a) * L * 0.5, my = pose.y + Math.sin(pose.a) * L * 0.5;
      out.x = mx; out.y = my;
    }
    out.angle = pose.a;

    // settle back at rest: a soft knock on the felt
    if (returning) {
      const d = Math.hypot(pose.x - rest.x, pose.y - rest.y);
      if (d < 1.5 && Math.abs(pose.vx) + Math.abs(pose.vy) < 20) {
        returning = false;
        if (travelled > 30) env.emit('sfx', { name: 'drop', pan: panOf(pose.x), soft: true });
      }
    }

    // a glint runs down the stick now and then, until the bow has first been played
    const bowed = game.state?.tools?.bowed;
    if (!bowed && grab.id < 0) { idle += dt; if (idle > 7 && glintT <= 0) { glintT = 1.3; idle = 0; } }
    if (glintT > 0) glintT -= dt;
  }

  // light varies along a bow this long: it is lit in K slices, each by the lamp at its own place
  const K = 10;
  const sliceF = new Float32Array(K);
  let fMin = 1, fAvg = 1;
  function computeSlices(lamp) {
    const c = Math.cos(pose.a), s = Math.sin(pose.a);
    fMin = 1; fAvg = 0;
    for (let i = 0; i < K; i++) {
      const lx = ((i + 0.5) / K) * L, ly = -0.02 * L * pose.f;
      const f = lamp.at(pose.x + c * lx - s * ly, pose.y + s * lx + c * ly);
      sliceF[i] = f; fAvg += f / K; if (f < fMin) fMin = f;
    }
  }
  function blitSliced(ctx, lit, dark) {
    if (fMin < 0.985) blit(ctx, dark, 1);
    const ga = ctx.globalAlpha, d = lit.dpr, cv = lit.cv;
    for (let i = 0; i < K; i++) {
      const x0 = i === 0 ? -lit.ox : (i / K) * L;
      const x1 = i === K - 1 ? lit.w - lit.ox : ((i + 1) / K) * L;
      const s0 = Math.round((x0 + lit.ox) * d), s1 = Math.min(cv.width, Math.round((x1 + lit.ox) * d));
      if (s1 <= s0) continue;
      ctx.globalAlpha = ga * clamp01(sliceF[i]);
      ctx.drawImage(cv, s0, 0, s1 - s0, cv.height, s0 / d - lit.ox, -lit.oy, (s1 - s0) / d, lit.h);
    }
    ctx.globalAlpha = ga;
  }

  // the hair ribbon: straight from frog to head, pressed into a shallow V at the contact
  let hx0 = 0, hx1 = 0, hdefl = 0, hcx = 0;
  function hairY(x) {
    if (hdefl <= 0) return 0;
    return x < hcx ? -hdefl * (x - hx0) / (hcx - hx0) : -hdefl * (hx1 - x) / (hx1 - hcx);
  }
  function hairPath(ctx, dy) {
    ctx.beginPath();
    ctx.moveTo(hx0, dy);
    if (hdefl > 0) ctx.lineTo(hcx, dy - hdefl);
    ctx.lineTo(hx1, dy);
  }
  function drawHair(ctx) {
    hx0 = P.hair0 * L; hx1 = P.hair1 * L;
    hdefl = contact ? (1.1 + 2.4 * pressure) * (L / 560) : 0;
    hcx = contactLX;
    const hw = Math.max(1.5, L * 0.0056);
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    const ga = ctx.globalAlpha;
    // dark base, then the lit hair slice by slice
    ctx.lineWidth = hw;
    if (fMin < 0.985) { ctx.strokeStyle = HAIR_BASE; hairPath(ctx, 0); ctx.stroke(); }
    // vibration blur while bowing
    if (contact && amp > 0.05) {
      const vib = (0.5 + 1.6 * out.speed01) * amp * (L / 560) * (env.reduced ? 0.4 : 1);
      ctx.globalAlpha = ga * fAvg * 0.32; ctx.strokeStyle = HAIR;
      hairPath(ctx, vib); ctx.stroke(); hairPath(ctx, -vib); ctx.stroke();
    }
    ctx.strokeStyle = HAIR;
    for (let i = 0; i < K; i++) {
      const a = Math.max(hx0, (i / K) * L), b = Math.min(hx1, ((i + 1) / K) * L);
      if (b <= a) continue;
      ctx.globalAlpha = ga * clamp01(sliceF[i]);
      ctx.beginPath();
      ctx.moveTo(a, hairY(a));
      if (hdefl > 0 && hcx > a && hcx < b) ctx.lineTo(hcx, -hdefl);
      ctx.lineTo(b, hairY(b));
      ctx.stroke();
    }
    ctx.lineWidth = hw * 0.26;
    ctx.globalAlpha = ga * fAvg * 0.55; ctx.strokeStyle = HAIR_HI; hairPath(ctx, -hw * 0.2); ctx.stroke();
    ctx.globalAlpha = ga * fAvg * 0.5; ctx.strokeStyle = HAIR_DK; hairPath(ctx, hw * 0.32); ctx.stroke();
    ctx.globalAlpha = ga;
  }

  function drawGlint(ctx) {
    if (glintT <= 0 || glintT > 1.1) return;
    const ph = 1 - glintT / 1.1;
    const xf = 0.14 + ph * 0.8;
    const a = Math.sin(ph * Math.PI) * 0.6;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = a;
    ctx.strokeStyle = '#fff0d0';
    ctx.lineWidth = Math.max(1, thickAt(xf) * L * 0.4);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo((xf - 0.035) * L, -gapAt(xf - 0.035) * L - thickAt(xf) * L * 0.1);
    ctx.lineTo(xf * L, -gapAt(xf) * L - thickAt(xf) * L * 0.1);
    ctx.lineTo((xf + 0.035) * L, -gapAt(xf + 0.035) * L - thickAt(xf) * L * 0.1);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function draw(ctx, lamp) {
    if (!sprites) return;
    const S = game.view.plate.size;
    const mx = pose.x + Math.cos(pose.a) * L * 0.55, my = pose.y + Math.sin(pose.a) * L * 0.55;
    computeSlices(lamp);
    // shadow: lying on the felt it is crisp; lifted toward the lamp it softens and drifts away
    const h = S * (0.004 + 0.2 * pose.lift);
    lamp.offset(mx, my, h, tmp);
    const sa = lamp.shadowAt(mx, my) * 0.75;
    const shs = 1 + h / lamp.z;
    ctx.save();
    ctx.translate(pose.x + tmp.x, pose.y + tmp.y);
    ctx.rotate(pose.a);
    ctx.scale(pose.sc * shs, pose.sc * shs * pose.f);
    const soft = clamp01(pose.lift * 1.4);
    blit(ctx, sprites.shSharp, sa * (1 - soft));
    blit(ctx, sprites.shSoft, sa * soft * (1 - pose.lift * 0.35));
    ctx.restore();

    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.a);
    ctx.scale(pose.sc, pose.sc * pose.f);
    drawHair(ctx);
    blitSliced(ctx, sprites.lit, sprites.dark);
    drawGlint(ctx);
    ctx.restore();
    // the bite of hair on bronze: a small warm brightness where they meet
    if (contact && amp > 0.03) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(E.ex, E.ey);
      const k = clamp01(amp) * (0.75 + 0.25 * Math.random()) * (0.3 + 0.7 * lamp.intensity);
      ctx.scale(0.7 + 0.5 * out.speed01, 0.7 + 0.5 * out.speed01);
      blit(ctx, sprites.glow, k * 0.85);
      ctx.restore();
    }
  }

  return {
    get L() { return L; },
    pose, rest, layout, update, draw, hit, pickUp, drop, edgeAt,
    get heldBy() { return grab.id; },
    get contact() { return contact; },
    get amp() { return amp; },
  };
}
