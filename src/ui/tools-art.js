// Shared drawing helpers for the overlay objects: offscreen sprites, baked shadows, the lamp's
// light falloff (matching the renderer's spotlight pool), small maths and a seeded random source.
// Everything heavy happens at bake time (on resize); per-frame drawing only blits sprites and
// strokes a few paths with constant styles.

export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const TAU = Math.PI * 2;
export const SIDES = [-1, 1];          // left/right pairs, without a fresh array every frame
// allocation-free view conversions (view.toPlate/toScreen return new objects)
export function toPlateInto(view, x, y, out) {
  const p = view.plate, u = view.unit || p.size / 2;
  out.u = (x - p.cx) / u; out.v = (y - p.cy) / u;
  return out;
}
export function toScreenInto(view, u, v, out) {
  const p = view.plate, k = view.unit || p.size / 2;
  out.x = p.cx + u * k; out.y = p.cy + v * k;
  return out;
}
// shortest signed angle from a to b
export const angDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU; return d; };

// mulberry32: deterministic textures (the same bow every visit)
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

// A sprite is a canvas plus the CSS-px geometry of its local origin:
// drawn with ctx.drawImage(cv, -ox, -oy, w, h) under the object's transform.
export function bake(w, h, ox, oy, dpr, draw) {
  const s = Math.max(1, dpr);
  const cv = makeCanvas(w * s, h * s);
  const g = cv.getContext('2d');
  g.setTransform(s, 0, 0, s, s * ox, s * oy);
  draw(g);
  return { cv, ox, oy, w, h, dpr: s };
}

export function blit(ctx, sp, alpha = 1) {
  if (!sp || alpha <= 0.002) return;
  if (alpha < 1) { const ga = ctx.globalAlpha; ctx.globalAlpha = ga * alpha; ctx.drawImage(sp.cv, -sp.ox, -sp.oy, sp.w, sp.h); ctx.globalAlpha = ga; }
  else ctx.drawImage(sp.cv, -sp.ox, -sp.oy, sp.w, sp.h);
}

// Soft black silhouette of a sprite, blurred by `blur` CSS px. Uses the shadowBlur trick (draw the
// sprite far off-canvas, let only its shadow land) so it works without ctx.filter (old Safari).
export function bakeShadow(sp, blur) {
  const m = Math.ceil(blur * 2 + 2);
  const s = sp.dpr;
  const cv = makeCanvas((sp.w + m * 2) * s, (sp.h + m * 2) * s);
  const g = cv.getContext('2d');
  const OFF = 10000;
  g.shadowColor = '#000';
  g.shadowBlur = blur * s;
  g.shadowOffsetX = OFF;
  g.drawImage(sp.cv, m * s - OFF, m * s);
  return { cv, ox: sp.ox + m, oy: sp.oy + m, w: sp.w + m * 2, h: sp.h + m * 2, dpr: s };
}

// The same sprite filled with one flat colour (dark base for lighting, glow masks).
export function bakeTint(sp, colour) {
  const cv = makeCanvas(sp.cv.width, sp.cv.height);
  const g = cv.getContext('2d');
  g.drawImage(sp.cv, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, cv.width, cv.height);
  return { cv, ox: sp.ox, oy: sp.oy, w: sp.w, h: sp.h, dpr: sp.dpr };
}

// Draw an object lit by factor f: a near-black base, then the lit sprite at alpha f.
// Over the black felt this is the same as darkening; over the bright plate it keeps the object
// solid instead of letting it turn transparent.
export function blitLit(ctx, lit, dark, alpha, f) {
  if (alpha <= 0.002) return;
  if (dark && f < 0.985) blit(ctx, dark, alpha);
  blit(ctx, lit, alpha * clamp01(f));
}

// ---- the lamp --------------------------------------------------------------------------------
// The renderer hangs the lamp a little up and left of the plate centre, 1.6 plate widths above the
// felt, with a pool radius of 0.9 plate widths. Objects are raised and catch more light than the
// flat felt, so their falloff is wider and never quite reaches zero inside the room.
export function createLamp(game) {
  const lamp = { x: 0, y: 0, z: 1, poolR: 1, size: 1, intensity: 1, level: 1 };
  lamp.layout = () => {
    const v = game.view, s = v.plate.size;
    lamp.size = s;
    lamp.x = v.plate.cx - s * 0.08;
    lamp.y = v.plate.cy - s * 0.14;
    lamp.z = s * 1.6;
    lamp.poolR = s * 0.9;
  };
  // per frame: same flicker formula as the renderer
  lamp.update = () => {
    const L = game.light || {};
    const level = clamp01(Number.isFinite(L.level) ? L.level : 1);
    const flick = clamp01(+L.flicker || 0);
    lamp.level = level;
    lamp.intensity = level * (1 - 0.6 * flick * (0.55 + 0.45 * Math.sin((game.t || 0) * 47.3)));
  };
  // the renderer's pool() profile
  lamp.pool = (x, y, widen = 1) => {
    const r = Math.hypot(x - lamp.x, y - lamp.y) / (lamp.poolR * widen);
    const e = 1 - smooth(0.3, 1.1, r);
    return e * e * (0.7 + 0.3 * Math.exp(-r * r * 4));
  };
  // brightness factor for an object at (x, y): 0.03 in darkness, ~1 under the lamp
  lamp.at = (x, y) => 0.03 + lamp.intensity * (0.3 + 0.7 * lamp.pool(x, y, 1.5)) * 0.97;
  // how strongly shadows read at (x, y)
  lamp.shadowAt = (x, y) => lamp.intensity * (0.3 + 0.7 * lamp.pool(x, y, 1.3));
  // shadow offset of a point at height h above the felt (CSS px), written into out
  lamp.offset = (x, y, h, out) => {
    const k = h / Math.max(1, lamp.z - h);
    out.x = (x - lamp.x) * k; out.y = (y - lamp.y) * k;
    return out;
  };
  return lamp;
}

// ---- texture helpers (bake time only) -----------------------------------------------------------
// fine speckle noise over the current path's bounding box: n dots of colour `c` with alpha range
export function speckle(g, rnd, x, y, w, h, n, colour, a0, a1, r0 = 0.3, r1 = 0.9) {
  g.fillStyle = colour;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = a0 + (a1 - a0) * rnd();
    const r = r0 + (r1 - r0) * rnd();
    g.fillRect(x + rnd() * w, y + rnd() * h, r, r);
  }
  g.globalAlpha = 1;
}

// soft mottling: overlapping translucent blobs
export function mottle(g, rnd, x, y, w, h, n, colour, a0, a1, rMin, rMax) {
  g.fillStyle = colour;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = a0 + (a1 - a0) * rnd();
    const r = rMin + (rMax - rMin) * rnd();
    g.beginPath();
    g.ellipse(x + rnd() * w, y + rnd() * h, r, r * (0.5 + rnd() * 0.6), rnd() * Math.PI, 0, TAU);
    g.fill();
  }
  g.globalAlpha = 1;
}

export function roundRectPath(g, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Exact critically damped spring: moves o[k] (velocity o[vk]) toward target. Unconditionally stable,
// so stiff springs (a bow pressed to an edge) stay calm at any frame rate.
export function spring(o, k, vk, target, omega, dt) {
  const c1 = o[k] - target, c2 = o[vk] + omega * c1;
  const e = Math.exp(-omega * dt);
  o[k] = target + (c1 + c2 * dt) * e;
  o[vk] = (c2 - omega * (c1 + c2 * dt)) * e;
  return o[k];
}
// the same for an angle (takes the short way round)
export function springAngle(o, k, vk, target, omega, dt) {
  return spring(o, k, vk, o[k] + angDiff(o[k], target), omega, dt);
}

// preload the canvas fonts (they are declared in the stylesheet; canvas text waits for them)
export function loadFonts() {
  try {
    if (document.fonts && document.fonts.load) {
      return Promise.all([
        document.fonts.load('16px Caveat'),
        document.fonts.load('10px "Old Standard TT"'),
        document.fonts.load('italic 12px "IM Fell English"'),
        document.fonts.load('12px "IM Fell English SC"'),
      ]).catch(() => {});
    }
  } catch { /* no font loading API */ }
  return Promise.resolve();
}
