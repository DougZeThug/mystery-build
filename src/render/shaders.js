// GLSL sources for the WebGL2 renderer (see gl.js for the passes that use them).
//
// Conventions shared by every shader:
//   css      CSS-pixel position on screen, y DOWN (computed from gl_FragCoord and uRes / uDpr)
//   pu       plate units: u right, v down, [-1,1] across the plate (same as the sims)
//   uvP      (pu + 1) / 2: texture coordinate for every plate-space texture (row 0 = top of plate)
// The scene is lit in linear light; the composite pass tonemaps and encodes to sRGB.
import { GLSL_MODE } from '../sim/modes.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

// Small, fast noise kit (hash without sine; value noise; fbm).
const NOISE = `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), w.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), w.x), w.y);
}
float vnoise1(float x) {
  float i = floor(x), f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
// tileable value noise / fbm (period in cells)
float vnoiseP(vec2 p, float per) {
  vec2 i = floor(p), f = fract(p);
  vec2 w = f * f * (3.0 - 2.0 * f);
  vec2 i1 = i + 1.0;
  i = mod(i, per); i1 = mod(i1, per);
  return mix(mix(hash12(i), hash12(vec2(i1.x, i.y)), w.x),
             mix(hash12(vec2(i.x, i1.y)), hash12(i1), w.x), w.y);
}
float fbmP(vec2 p, float per) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoiseP(p, per); p *= 2.0; per *= 2.0; a *= 0.5; }
  return s;
}
`;

// Fullscreen triangle (no attributes; gl_VertexID).
export const VS_FULL = `${HEAD}
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Bake: the bronze's static surface, once per plate resolution. Two targets:
//   A = albedo (sRGB-ish, gamma 2.2) + verdigris amount
//   B = brush slope across the grain (0.5 = flat), fine scratches, roughness, cavity
export const FS_BAKE_PLATE = `${HEAD}
in vec2 vUv;
uniform float uTpu;      // texels per plate unit (size / 2)
uniform float uSeed;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
${NOISE}
const float BRUSH_ANG = 0.11;

float brushAt(vec2 p) {
  vec2 dir = vec2(cos(BRUSH_ANG), sin(BRUSH_ANG));
  float b = dot(p, dir), c = dot(p, vec2(-dir.y, dir.x));
  float fA = uTpu * 0.42, fB = uTpu * 0.21, fC = uTpu * 0.07;
  float s = vnoise(vec2(b * 14.0, c * fA)) * 0.55
          + vnoise(vec2(b * 6.0 + 3.1, c * fB)) * 0.30
          + vnoise(vec2(b * 2.5 - 7.0, c * fC)) * 0.15;
  // long hairlines: a few rows of the grain carry a finer continuous scratch
  float row = floor(c * uTpu * 0.5);
  float hl = step(0.992, hash11(row * 1.37 + uSeed)) * (0.5 + 0.5 * vnoise(vec2(b * 3.0, row)));
  return s - hl * 0.3;
}

// sparse straight scratches: one short segment per lucky cell
float scratches(vec2 p, float cells, float seed, float density) {
  vec2 g = p * cells;
  vec2 i = floor(g);
  float best = 0.0;
  float px = cells / uTpu;                 // one texel in cell units
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i + vec2(float(x), float(y));
    float h = hash12(c + seed);
    if (h > density) continue;
    vec2 o = hash22(c * 1.7 + seed);
    float a = hash12(c * 1.3 + seed + 2.0) * 3.14159;
    vec2 d = vec2(cos(a), sin(a));
    float len = 0.35 + 1.1 * hash12(c + seed + 5.0);
    vec2 q = g - (c + o);
    float t = clamp(dot(q, d), -len, len);
    float dist = length(q - d * t);
    float line = 1.0 - smoothstep(0.0, px * 0.9, dist);
    line *= 1.0 - abs(t) / len;
    best = max(best, line * (0.35 + 0.65 * h / density));
  }
  return best;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;                                   // plate units (v down)
  float e = 1.0 / uTpu;
  vec2 dir = vec2(cos(BRUSH_ANG), sin(BRUSH_ANG));
  vec2 perp = vec2(-dir.y, dir.x);
  float br = brushAt(p);
  float slope = (brushAt(p + perp * e) - brushAt(p - perp * e)) * 0.5;

  // casting: an old statuary bronze, dark and brown, with soft clouds of redder copper and a
  // cleaner, warmer face where it was worked
  float lf = fbm(p * 1.1 + uSeed);
  float mf = fbm(p * 4.2 - 11.0 + uSeed);
  vec3 base = vec3(0.082, 0.038, 0.014);
  vec3 hi   = vec3(0.235, 0.112, 0.040);
  vec3 alb = mix(base, hi, clamp(0.42 + (lf - 0.5) * 0.75, 0.0, 1.0));
  alb *= mix(vec3(1.09, 0.92, 0.82), vec3(0.97, 1.0, 1.03), smoothstep(0.3, 0.7, mf));
  alb *= 0.955 + 0.09 * br;

  // tarnish: darker, browner blooms, more toward the rim
  float rim = max(abs(p.x), abs(p.y));
  float tn = fbm(p * 2.6 + vec2(5.2, -3.1));
  float tarn = smoothstep(0.50, 0.78, tn + 0.20 * smoothstep(0.55, 1.0, rim));
  alb *= mix(vec3(1.0), vec3(0.62, 0.52, 0.46), tarn * 0.5);

  // verdigris: small, sparse and organic. It starts in the pits and in the tarnish near the rim,
  // creeps along the brushing, and never quite covers the metal.
  vec2 w = vec2(fbm(p * 5.5 + 1.7), fbm(p * 5.5 - 4.2));
  float pn = fbm(p * 9.0 + w * 1.4 + 8.0);
  float pit = vnoise(p * 48.0) * 0.55 + vnoise(p * 131.0) * 0.45;
  float edgeB = smoothstep(0.72, 1.0, rim) + 0.5 * smoothstep(1.2, 1.38, length(p));
  float th = 0.75 - 0.12 * edgeB - 0.04 * tarn;
  float grow = pn + (pit - 0.5) * 0.16 + (br - 0.5) * 0.05;
  float pat = smoothstep(th, th + 0.06, grow);
  float ring = smoothstep(th - 0.05, th, grow) - pat;
  pat *= smoothstep(0.22, 0.62, pit);                        // speckled, never a solid fill
  float spk = smoothstep(0.9975 - 0.003 * edgeB, 1.0, hash12(floor(p * uTpu * 0.4) + uSeed));
  pat = max(pat, spk * 0.55);
  alb *= 1.0 - 0.18 * ring;

  float scr = max(scratches(p, 5.0, 3.0 + uSeed, 0.30), max(scratches(p, 9.0, 11.0 + uSeed, 0.22), scratches(p, 17.0, 23.0 + uSeed, 0.16)));
  float rough = clamp(0.40 + 0.16 * tarn + 0.08 * (mf - 0.5) + 0.6 * pat, 0.0, 1.0);
  float cav = 1.0 - 0.14 * ring - 0.14 * tarn;

  oA = vec4(pow(clamp(alb, 0.0, 1.0), vec3(1.0 / 2.2)), clamp(pat, 0.0, 1.0));
  oB = vec4(clamp(0.5 + slope * 2.2, 0.0, 1.0), scr, rough, cav);
}`;

// Bake: tileable felt (fibres, mottling).
export const FS_BAKE_FELT = `${HEAD}
in vec2 vUv;
out vec4 oC;
${NOISE}
float fibres(vec2 p, float cells, float seed) {
  vec2 g = p * cells;
  vec2 i = floor(g);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = i + vec2(float(x), float(y));
    vec2 cw = mod(c, cells);
    for (int k = 0; k < 2; k++) {
      vec2 key = cw + seed + float(k) * 7.31;
      vec2 o = hash22(key);
      float a = hash12(key + 3.3) * 6.2832;
      float bend = (hash12(key + 9.1) - 0.5) * 1.6;
      float len = 0.4 + 0.7 * hash12(key + 1.9);
      vec2 q = g - (c + o);
      vec2 d = vec2(cos(a), sin(a));
      float t = clamp(dot(q, d), -len, len);
      vec2 nrm = vec2(-d.y, d.x);
      float dist = abs(dot(q, nrm) - bend * t * t * 0.5);
      float wid = 0.035 + 0.03 * hash12(key + 4.4);
      float f = (1.0 - smoothstep(wid * 0.4, wid, dist)) * (1.0 - abs(t) / len);
      acc = max(acc, f * (0.4 + 0.6 * hash12(key + 6.6)));
    }
  }
  return acc;
}
void main() {
  vec2 p = vUv;
  float f = fibres(p, 22.0, 1.0) * 0.55 + fibres(p, 41.0, 5.0) * 0.45 + fibres(p, 9.0, 13.0) * 0.25;
  float mottle = fbmP(p * 6.0, 6.0);
  float grain = vnoiseP(p * 256.0, 256.0);
  oC = vec4(clamp(f, 0.0, 1.0), mottle, grain, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// The scene: felt, spotlight, plate shadow, bronze, vibration shimmer, sand, gold, cracks,
// engravings, the centre nut, and the singers' light on the metal. One fullscreen pass.
export const FS_SCENE = `${HEAD}
in vec2 vUv;
out vec4 oC;
uniform vec2 uRes;
uniform float uDpr;
uniform vec3 uPlate;       // cx, cy, unit (css px)
uniform vec3 uLamp;        // x, y, height (css px)
uniform float uPoolR;
uniform float uLightI;     // spotlight intensity (level, flicker)
uniform float uLevel;
uniform float uTime;
uniform float uAmp;        // field.total
uniform float uK;          // field.kEff
uniform float uChoir;
uniform float uFloor;
uniform float uEngr;       // phosphor reveal (darkness)
uniform float uFloorEngr;  // the keeper's last message
uniform float uLmOn;
uniform float uLmExt;      // light map covers plate units [-ext, ext]
uniform vec2 uSandTexel;
uniform vec2 uFieldTexel;
uniform vec2 uCkTexel;
uniform vec2 uEnTexel;
uniform vec2 uWearTexel;
uniform vec2 uAim;         // where the beam's axis meets the plate (css px)
uniform vec4 uDamp[6];     // felt dampers on the plate: u, v, r, on
uniform sampler2D tMatA, tMatB, tFelt, tField, tSand, tWear, tCrack, tEngr, tLight;
${NOISE}
#define T0(s, uv) textureLod(s, uv, 0.0)
const vec3 LAMP_COL = vec3(1.0, 0.85, 0.68);
const vec3 SAND_LIT = vec3(0.815, 0.737, 0.578);   // #e9dfc8
const vec3 SAND_SHD = vec3(0.258, 0.198, 0.125);   // #8b7b63
const vec3 GOLD = vec3(1.0, 0.604, 0.133);         // #ffcc66
const vec3 SEAM = vec3(1.0, 0.70, 0.34);           // kintsugi glow
const vec3 PHOS = vec3(0.27, 1.0, 0.63);           // #8fffd0
const vec3 VERD = vec3(0.060, 0.074, 0.062);       // old verdigris, greyed by a century of dust
const vec3 VERD_CRUST = vec3(0.120, 0.138, 0.118);
const float BRUSH_ANG = 0.11;

float sdBox(vec2 q, vec2 b, float r) {
  vec2 d = abs(q) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}
vec2 sdBoxGrad(vec2 q, vec2 b, float r) {
  vec2 d = abs(q) - b + r;
  vec2 s = sign(q);
  if (d.x > 0.0 && d.y > 0.0) return s * normalize(d);
  return d.x > d.y ? vec2(s.x, 0.0) : vec2(0.0, s.y);
}
float sdHex(vec2 p, float r) {        // r = inradius (flat-to-centre)
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// spotlight pool: a theatrical spot aimed at the plate. A bright core about half a plate wide,
// a long faint skirt that leaves the corners in half-shadow, and then the felt falls to black.
float pool(vec2 css) {
  float d = length(css - uAim) / (uPlate.z * 2.0);            // in plate widths
  float core = exp(-d * d * 5.4);
  float skirt = exp(-d * d * 1.75);
  return (0.76 * core + 0.24 * skirt) * (1.0 - smoothstep(0.80, 1.38, d));
}

void main() {
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  float unit = uPlate.z;
  vec2 q = css - uPlate.xy;
  vec2 pu = q / unit;
  vec2 uvP = pu * 0.5 + 0.5;
  float px = 1.0 / uDpr;                      // one device pixel in css px
  float pxU = px / unit;                      // one device pixel in plate units
  // plate-space texture footprint of one device pixel (analytic: the plate is never rotated)
  vec2 gdx = vec2(pxU * 0.5, 0.0), gdy = vec2(0.0, pxU * 0.5);

  // light
  float rr = length(css - uAim) / (unit * 2.0);
  vec3 lampCol = mix(LAMP_COL, vec3(1.0, 0.74, 0.42), uChoir * 0.55);
  lampCol *= mix(vec3(1.0), vec3(1.05, 0.90, 0.76), smoothstep(0.3, 0.8, rr));    // warmer, redder skirt
  float E = pool(css) * uLightI * (1.0 + 0.14 * uChoir);
  vec3 Lv = vec3(uLamp.xy - css, uLamp.z);
  vec3 L = normalize(Lv);
  float amb = 0.004 + 0.022 * uLevel;

  // ---- felt -----------------------------------------------------------------------------------
  vec4 fl = texture(tFelt, css / 300.0);
  vec4 fl2 = texture(tFelt, css / 83.0 + 0.37);
  vec3 felt = vec3(0.070, 0.050, 0.037) * (0.72 + 0.45 * fl.r + 0.35 * fl2.r) * (0.8 + 0.4 * fl.g);
  // plate shadow: the plate floats on its stand; project onto its plane toward the lamp
  float hp = unit * 0.11;
  vec2 qs = css + (uLamp.xy - css) * (hp / uLamp.z) - uPlate.xy;
  float pen = unit * 0.035 + hp * 0.25;
  float sShadow = smoothstep(-pen, pen * 1.4, sdBox(qs, vec2(unit), unit * 0.012));
  float dEdge = sdBox(q, vec2(unit), unit * 0.012);
  float ao = 1.0 - 0.55 * exp(-max(dEdge, 0.0) / (unit * 0.09));
  vec3 col = felt * (lampCol * E * L.z * sShadow * 1.15 + amb) * ao;

  // ---- plate ----------------------------------------------------------------------------------
  float inPlate = 1.0 - smoothstep(-px * 0.5, px * 0.5, dEdge);
  vec3 emiss = vec3(0.0);
  float lm = 0.0;
  if (inPlate > 0.0) {
    float din = -dEdge;
    vec4 mA = textureGrad(tMatA, uvP, gdx, gdy);
    vec4 mB = textureGrad(tMatB, uvP, gdx, gdy);
    vec4 en = T0(tEngr, uvP);
    vec4 ck = T0(tCrack, uvP);
    vec4 sd = T0(tSand, uvP);
    float bw = max(2.2, unit * 0.013);
    vec2 g = sdBoxGrad(q, vec2(unit), unit * 0.012);
    float t = clamp(1.0 - din / bw, 0.0, 1.0);
    float tilt = t * t * 1.6;
    vec3 N = vec3(g * tilt, 1.0);

    vec3 alb = pow(mA.rgb, vec3(2.2));
    float pat = mA.a;
    float slope = mB.r * 2.0 - 1.0;
    float scr = mB.g;
    float rough = mB.b;
    float cav = mB.a;

    // polish where singers have walked
    vec2 wo = uWearTexel * 0.5;
    float wr = (T0(tWear, uvP + wo).r + T0(tWear, uvP - wo).r
              + T0(tWear, uvP + vec2(wo.x, -wo.y)).r + T0(tWear, uvP + vec2(-wo.x, wo.y)).r) * 0.25;
    float pol = smoothstep(0.08, 0.5, wr) * (0.55 + 0.45 * smoothstep(0.5, 0.9, wr));
    // felt dampers sitting on the bronze: a soft contact shadow, and a faint polished ring where
    // the felt has been turned and slid
    float dampSh = 1.0;
    for (int i = 0; i < 6; i++) {
      vec4 dm = uDamp[i];
      if (dm.w < 0.5) continue;
      vec2 dv = pu - dm.xy;
      float dd = length(dv);
      float r0 = dm.z;
      vec2 awayP = normalize(css - uLamp.xy);
      float dCast = length(dv - awayP * r0 * 0.16);
      dampSh *= 1.0 - 0.5 * (1.0 - smoothstep(r0 * 0.92, r0 * 1.42, dCast));
      dampSh *= 1.0 - 0.35 * exp(-max(dd - r0 * 0.97, 0.0) / (r0 * 0.09));
      pol = max(pol, 0.55 * exp(-pow((dd - r0 * 1.2) / (r0 * 0.13), 2.0)) * (0.6 + 0.4 * vnoise(dv / r0 * 9.0)));
    }
    alb = mix(alb, alb * vec3(1.38, 1.24, 1.06) + vec3(0.016, 0.008, 0.002), pol);
    pat *= 1.0 - pol;
    rough = mix(rough, 0.3, pol * 0.5);
    slope *= 1.0 - 0.75 * pol;
    scr *= 1.0 - 0.8 * pol;
    vec3 verd = mix(VERD, VERD_CRUST, smoothstep(0.3, 0.9, mA.a) * (0.35 + 0.65 * vnoise(pu * 90.0)));
    alb = mix(alb, verd, pat * 0.72);
    // the edge was handled for a century: a little brighter, a little cleaner
    alb *= 1.0 + 0.12 * smoothstep(bw * 3.0, bw, din);

    // vibration: the plate moves where it is not still
    float f = T0(tField, uvP).r;
    float fxg = T0(tField, uvP + vec2(uFieldTexel.x, 0.0)).r - T0(tField, uvP - vec2(uFieldTexel.x, 0.0)).r;
    float fyg = T0(tField, uvP + vec2(0.0, uFieldTexel.y)).r - T0(tField, uvP - vec2(0.0, uFieldTexel.y)).r;
    float ph = sin(uTime * (40.0 + uK));
    float vib = min(1.0, abs(f));
    vec2 dir = vec2(cos(BRUSH_ANG), sin(BRUSH_ANG));
    vec2 perp = vec2(-dir.y, dir.x);
    N.xy += perp * slope * 0.05 * (1.0 - 0.75 * vib);
    N.xy += vec2(fxg, fyg) * ph * 0.3;

    // sand (sampled early: it shades the metal around it and hides the engravings)
    float dS = sd.r, gS = sd.g;
    vec2 toLamp = normalize(uLamp.xy - css);
    float dOcc = T0(tSand, uvP + toLamp * 0.0042).r;
    float sandShadow = 1.0 - 0.55 * smoothstep(0.06, 0.55, dOcc) * (1.0 - smoothstep(0.1, 0.4, dS));

    // cracks
    float ckx = T0(tCrack, uvP + vec2(uCkTexel.x, 0.0)).b - T0(tCrack, uvP - vec2(uCkTexel.x, 0.0)).b;
    float cky = T0(tCrack, uvP + vec2(0.0, uCkTexel.y)).b - T0(tCrack, uvP - vec2(0.0, uCkTexel.y)).b;
    N.xy -= vec2(ckx, cky) * 0.7;

    // engravings: grooves (the last message, once revealed) and the phosphor marks
    if (uFloorEngr > 0.0) {
      // a V-cut groove: walls from the gradient of the softened letterforms
      float ex = T0(tEngr, uvP + vec2(uEnTexel.x, 0.0)).a - T0(tEngr, uvP - vec2(uEnTexel.x, 0.0)).a;
      float ey = T0(tEngr, uvP + vec2(0.0, uEnTexel.y)).a - T0(tEngr, uvP - vec2(0.0, uEnTexel.y)).a;
      N.xy += vec2(ex, ey) * 1.4 * uFloorEngr;
      cav *= 1.0 - 0.45 * en.b * uFloorEngr;
    }

    N = normalize(N);
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float NdL = max(dot(N, L), 0.0);
    float NdH = max(dot(N, H), 0.0);
    vec3 T = normalize(vec3(dir, 0.0) - N * dot(N, vec3(dir, 0.0)));
    float TH = dot(T, H);
    // lobes sized for a lamp 1.6 plate-widths up: a tight hotspot, a soft sheen, the brushed streak.
    // Bronze reflects its own warm colour: copper-amber, never lemon.
    float hot = pow(NdH, mix(170.0, 560.0, 1.0 - rough)) * mix(0.22, 0.62, 1.0 - rough);
    float sheen = pow(NdH, 34.0) * 0.075;
    float aniso = pow(sqrt(max(0.0, 1.0 - TH * TH)), mix(400.0, 1400.0, 1.0 - rough)) * pow(NdH, 16.0) * 0.75;
    vec3 specCol = mix(alb * 2.4, vec3(0.56, 0.36, 0.22), 0.42) * (1.0 - pat * 0.92) + vec3(0.035, 0.026, 0.018) * pol;
    vec3 Ed = lampCol * E * sandShadow * dampSh;

    float shim = 1.0 + 0.16 * f * ph;
    vec3 metal = alb * Ed * (mix(0.46, 0.95, pat) * NdL + 0.03) * cav;
    metal += specCol * Ed * (hot + sheen + aniso * (1.0 - 0.6 * vib)) * cav;
    metal += specCol * Ed * scr * 0.4 * pow(NdH, 30.0) * (1.0 - vib);
    metal *= shim;
    metal += alb * amb * cav;

    // the bevel: it catches the lamp's housing on the near side and falls into shade on the far side
    vec2 toward = normalize(uLamp.xy - uPlate.xy + vec2(-0.35, -0.6) * unit);
    float bev = t * (1.0 - smoothstep(0.0, 1.0, t) * 0.3);
    float catchL = bev * max(0.0, dot(g, toward));
    float shadeL = bev * max(0.0, -dot(g, toward));
    metal += specCol * lampCol * (0.04 + E * 1.1) * catchL * catchL * 1.2;
    metal *= 1.0 - 0.6 * shadeL;
    // a fine dark outline where the plate's side begins
    metal *= 1.0 - 0.6 * smoothstep(1.2 * px, 0.0, din);

    // singers' light on the bronze
    if (uLmOn > 0.0) {
      // in full light the glow is a whisper; in the dark it is all there is
      vec3 sl = T0(tLight, (pu / uLmExt) * 0.5 + 0.5).rgb * (2.0 - 1.6 * smoothstep(0.0, 0.8, uLevel));
      metal += sl * (alb * 4.6 + specCol * 0.18) * cav;
      lm = dot(sl, vec3(0.33));
    }

    // cracks: dark hairline, lip, gold
    float core = ck.r;
    metal *= 1.0 - 0.9 * core;
    float gpulse = 0.62 + 0.38 * sin(uTime * 1.7 + pu.x * 3.0 - pu.y * 2.0);
    float gAmp = 0.45 + 0.55 * clamp(uAmp, 0.0, 1.0);
    vec3 goldMetal = GOLD * (Ed * (0.45 + 1.4 * pow(NdH, 30.0)) + amb * 2.0);
    metal = mix(metal, goldMetal, ck.g);
    emiss += SEAM * (ck.a * 0.32 + ck.g * ck.a * 0.55) * gpulse * gAmp;

    // ---- sand ---------------------------------------------------------------------------------
    // grain cells (~0.9 css px) on a lattice turned off the pixel grid, riding the plate
    vec2 gp = mat2(0.8415, -0.5403, 0.5403, 0.8415) * pu * unit * 1.15;
    vec2 cell = floor(gp);
    float gr = hash12(cell);
    vec2 gpos = cell + 0.12 + 0.76 * hash22(cell + 5.1);  // the grain sits anywhere in its cell
    float grad0 = 0.36 + 0.14 * hash12(cell + 8.3);
    float dense = smoothstep(0.22, 0.5, dS);              // thick sand closes the gaps
    float disc = mix(1.0 - smoothstep(grad0 - 0.18, grad0 + 0.12, length(gp - gpos)), 1.0, dense);
    float has = smoothstep(gr * 0.24, gr * 0.24 + 0.05, dS);
    float cov = has * disc;
    // each grain throws a speck of shadow away from the lamp
    vec2 sOff = mat2(0.8415, -0.5403, 0.5403, 0.8415) * -toLamp * 0.45;
    float sdisc = 1.0 - smoothstep(grad0 - 0.1, grad0 + 0.25, length(gp - gpos - sOff));
    metal *= 1.0 - 0.5 * has * sdisc * (1.0 - dense) * smoothstep(0.0, 0.3, E);
    vec3 sandCol = vec3(0.0);
    float sandA = 0.0;
    if (cov > 0.0) {
      float dl = T0(tSand, uvP - vec2(uSandTexel.x, 0.0)).r;
      float dr = T0(tSand, uvP + vec2(uSandTexel.x, 0.0)).r;
      float du = T0(tSand, uvP - vec2(0.0, uSandTexel.y)).r;
      float dd = T0(tSand, uvP + vec2(0.0, uSandTexel.y)).r;
      vec2 sg = vec2(dr - dl, dd - du);
      vec3 Ns = normalize(vec3(-sg * 3.6, 1.0));
      // each grain its own little facet; when the plate sings, they tumble
      float tumble = floor(uTime * (6.0 + 10.0 * vib)) * step(0.06, vib);
      vec2 fct = hash22(cell + tumble * 0.731) - 0.5;
      vec3 Ng = normalize(Ns + vec3(fct * 0.9, 0.0));
      float lam = max(dot(Ng, L), 0.0);
      float lamS = max(dot(Ns, L), 0.0);
      float tone = hash12(cell + 17.0);
      vec3 albS = mix(SAND_SHD, SAND_LIT, 0.55 + 0.45 * smoothstep(0.0, 1.0, lamS));
      albS *= 0.9 + 0.3 * tone;
      albS = mix(albS, vec3(0.30, 0.22, 0.15), step(0.965, tone) * 0.7);   // a few dark mineral grains
      float aoS = 0.86 + 0.14 * smoothstep(0.05, 0.6, dS);
      sandCol = albS * (Ed / max(sandShadow, 0.01)) * (0.3 + 1.05 * lam * lam) * aoS;
      float glint = pow(max(dot(reflect(-L, Ng), vec3(0.0, 0.0, 1.0)), 0.0), 90.0) * step(0.5, hash12(cell + 3.0));
      sandCol += lampCol * E * glint * 2.2;
      // sand is matte and pale: it gathers the room's stray light, so the figure still reads in the
      // half-shadow at the corners
      sandCol += albS * (amb * 0.35 + 0.045 * uLightI * (1.0 - smoothstep(0.1, 0.7, E)));
      sandCol *= shim;
      if (uLmOn > 0.0) sandCol += albS * lm * 1.4 * vec3(0.9, 0.95, 1.0);
      sandA = cov;
    }
    // gold grains: heavier, brighter, they glitter
    float gr2 = hash12(cell + 91.7);
    float covG = smoothstep(gr2 * 0.12, gr2 * 0.12 + 0.03, gS);
    if (covG > 0.0) {
      float tw = hash12(cell + floor(uTime * (2.0 + 6.0 * vib) + gr2 * 13.0));
      vec3 gc = GOLD * (E * lampCol * (0.35 + 0.65 * dot(L, vec3(0.0, 0.0, 1.0))) + amb + lm * 0.8);
      gc += GOLD * E * pow(tw, 14.0) * 7.0;
      emiss += GOLD * covG * pow(tw, 22.0) * 1.6 * (0.3 + 0.7 * uLevel);
      sandCol = mix(sandCol, gc, covG);
      sandA = max(sandA, covG);
    }

    vec3 plateCol = mix(metal, sandCol, sandA);
    float bare = 1.0 - sandA;

    // phosphor marks of the previous keeper, visible as the light dies
    float breathe = 0.65 + 0.35 * sin(uTime * 0.55 + pu.x * 1.3 + pu.y * 0.7);
    if (uEngr > 0.002) {
      float scratchy = 0.55 + 0.45 * vnoise(pu * vec2(310.0, 290.0));
      emiss += PHOS * (en.r * 0.24 * scratchy + en.g * 0.12) * uEngr * breathe * (0.1 + 0.9 * bare);
    }
    emiss += PHOS * (en.b * 0.5 + en.a * 0.3) * uFloorEngr * (0.25 + 0.75 * uEngr) * breathe * bare * 0.5;

    // the floor: the whole plate one slow white-gold breath
    if (uFloor > 0.0) {
      float pulse = 0.6 + 0.4 * sin(uTime * 2.2);
      emiss += vec3(1.0, 0.86, 0.6) * uFloor * (0.04 + 0.2 * vib * vib) * pulse * bare;
    }

    // ---- centre clamp: steel hex nut on a turned washer ----------------------------------------
    float rc = length(pu);
    if (rc < 0.16) {
      // its shadow on the plate
      vec2 so = -toLamp * 0.022;
      float nsh = 1.0 - 0.6 * (1.0 - smoothstep(0.055, 0.1, length(pu - so)));
      plateCol *= mix(1.0, nsh, smoothstep(0.0, 0.2, uLightI));
      if (rc < 0.084) {
        vec3 Nn = vec3(0.0, 0.0, 1.0);
        vec3 stAlb = vec3(0.045, 0.045, 0.05);
        float sharp = 900.0, sk = 0.25;
        vec2 rd = pu / max(rc, 1e-4);
        float hx = sdHex(pu, 0.05);
        if (hx < 0.0) {
          if (rc < 0.021) {                                     // bolt end, slightly domed
            Nn = normalize(vec3(pu / 0.021 * 0.8, 1.0));
            stAlb = vec3(0.05, 0.05, 0.055);
            sharp = 260.0; sk = 3.0;
          } else if (rc < 0.026) {                              // thread shoulder
            Nn = normalize(vec3(rd * 0.5 * sin(rc * 1400.0), 1.0));
            stAlb = vec3(0.025);
          } else if (rc > 0.047) {                              // chamfered corners
            Nn = normalize(vec3(rd * 0.75, 1.0));
          } else {
            Nn = normalize(vec3(rd * 0.03 * sin(rc * 900.0), 1.0));   // lathe rings on the top face
          }
          float he = smoothstep(-0.004, 0.0, hx);                 // bevelled hex edge
          Nn = normalize(Nn + vec3(rd * he * 0.6, 0.0));
        } else {                                                // washer
          float wt = (rc - 0.068) / 0.016;
          Nn = normalize(vec3(rd * wt * 0.35, 1.0));
          stAlb = vec3(0.04, 0.039, 0.038);
          sharp = 400.0; sk = 0.35;
        }
        float nL = max(dot(Nn, L), 0.0);
        float nH = max(dot(Nn, H), 0.0);
        vec3 steel = stAlb * (lampCol * E * (0.35 + 0.9 * nL) + amb * 2.0);
        steel += lampCol * E * (pow(nH, sharp) * sk + pow(nH, 10.0) * 0.05);
        if (uLmOn > 0.0) steel += lm * 0.25 * vec3(0.8, 0.85, 0.9);
        float nutA = 1.0 - smoothstep(0.083 - pxU, 0.083 + pxU, rc);
        float hexA = 1.0 - smoothstep(-pxU, pxU, hx);
        // dark seam between nut and washer, and washer and plate
        steel *= 1.0 - 0.7 * (1.0 - smoothstep(0.0, 0.0025, abs(hx))) ;
        steel *= 1.0 - 0.6 * smoothstep(0.079, 0.083, rc) * (1.0 - hexA);
        plateCol = mix(plateCol, steel, nutA);
        emiss *= 1.0 - nutA;
      }
    }

    col = mix(col, plateCol, inPlate);
    emiss *= inPlate;
  }

  oC = vec4(col + emiss, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Singers: one instanced quad each. uPass 0 = shadow + feet (alpha), 1 = glow (additive),
// 2 = light they cast on the bronze (additive, into the plate-space light map).
export const VS_SINGER = `${HEAD}
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;      // u v r e
layout(location = 2) in vec4 aB;      // age01 state n1 m1
layout(location = 3) in vec4 aC;      // s1 n2 m2 s2
layout(location = 4) in vec4 aD;      // n3 m3 s3 flags
uniform vec2 uRes;
uniform float uDpr;
uniform vec3 uPlate;
uniform vec3 uLamp;
uniform float uTime;
uniform int uPass;
uniform float uLmExt;
uniform vec3 uModeCol[128];
out vec2 vQ;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
flat out vec3 vC1;
flat out vec3 vC2;
flat out vec3 vC3;
flat out vec2 vSh;
flat out vec3 vNorm;
${GLSL_MODE}
vec3 modeCol(float n, float m, float s) {
  int idx = int(n + 0.5) * 8 + int(m + 0.5) + (s < 0.0 ? 64 : 0);
  return uModeCol[clamp(idx, 0, 127)];
}
float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
void main() {
  vA = aA; vB = aB; vC = aC; vD = aD;
  vNorm = vec3(chladniNorm(vec3(aB.z, aB.w, aC.x)), chladniNorm(vec3(aC.y, aC.z, aC.w)), chladniNorm(vec3(aD.x, aD.y, aD.z)));
  vC1 = modeCol(aB.z, aB.w, aC.x);
  vC2 = aC.y > 0.5 ? modeCol(aC.y, aC.z, aC.w) : vC1;
  vC3 = aD.x > 0.5 ? modeCol(aD.x, aD.y, aD.z) : vC2;
  // a second component too close in colour to the first is nudged toward pale cyan / rose
  if (aC.y > 0.5 && distance(vC2, vC1) < 0.12) vC2 = mix(vC2, vec3(0.62, 0.92, 1.0), 0.55);
  if (aD.x > 0.5 && (distance(vC3, vC1) < 0.12 || distance(vC3, vC2) < 0.12)) vC3 = mix(vC3, vec3(1.0, 0.70, 0.74), 0.55);
  float r = max(aA.z, 0.005);
  float code = floor(aB.y + 0.001);
  float flags = aD.w;
  float lift = mod(floor(flags / 16.0), 2.0);
  // the keeper (flag 64, or a singer of the fundamental itself): larger, slower, a long halo
  float keeper = max(mod(floor(flags / 64.0), 2.0), 1.0 - step(0.5, aB.z));
  if (keeper > 0.5) r *= 2.2;
  vec2 c = aA.xy;
  if (code > 4.5 && code < 5.5) {                       // startled: a shiver
    float ph = h11(r * 5000.0);
    c += vec2(sin(uTime * 61.0 + ph * 9.0), cos(uTime * 53.0 + ph * 7.0)) * r * 0.18 * (1.0 - fract(aB.y));
  }
  if (code > 10.5 && code < 11.5) {                     // clinging on: a constant fine tremble
    float ph = h11(r * 7919.0);
    c += vec2(sin(uTime * 83.0 + ph * 11.0) + 0.5 * sin(uTime * 131.0), cos(uTime * 71.0 + ph * 5.0) + 0.5 * cos(uTime * 117.0)) * r * 0.05;
  }
  vec2 ccss = uPlate.xy + c * uPlate.z;
  vec2 away = ccss - uLamp.xy;
  vSh = normalize(away + 1e-4) * (0.28 + 0.6 * lift) * (0.6 + 0.4 * clamp(length(away) / uLamp.z, 0.0, 1.0));
  if (uPass == 2) {
    float R = keeper > 0.5 ? 1.2 : 0.55;
    vec2 p = c + aCorner * R;
    vQ = aCorner * R;
    gl_Position = vec4(p / uLmExt, 0.0, 1.0);
    return;
  }
  float ext = uPass == 0 ? 2.4 : (keeper > 0.5 ? 5.2 : 3.4);
  vQ = aCorner * ext;
  vec2 css = ccss + aCorner * ext * r * uPlate.z;
  vec2 vp = uRes / uDpr;
  gl_Position = vec4(css.x / vp.x * 2.0 - 1.0, 1.0 - css.y / vp.y * 2.0, 0.0, 1.0);
}`;

export const FS_SINGER = `${HEAD}
in vec2 vQ;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
flat in vec3 vC1;
flat in vec3 vC2;
flat in vec3 vC3;
flat in vec2 vSh;
flat in vec3 vNorm;
uniform float uTime;
uniform int uPass;
uniform float uLevel;
uniform float uChoir;
out vec4 oC;
${NOISE}
${GLSL_MODE}
const vec3 GOLD = vec3(1.0, 0.68, 0.22);

float bit(float flags, float b) { return mod(floor(flags / b), 2.0); }
vec3 sat(vec3 c, float k) { float l = dot(c, vec3(0.299, 0.587, 0.114)); return max(mix(vec3(l), c, k), 0.0); }

// the keeper's figure: the fundamental's own contours (concentric, still at the rim) crossed by
// faint radial lines
float floorFigure(vec2 lq) {
  float f = cos(1.5707963 * lq.x) * cos(1.5707963 * lq.y);
  float fr = f * 4.0;
  float wr = fwidth(fr);
  float rings = 1.0 - smoothstep(0.0, wr * 1.3 + 0.05, abs(fract(fr + 0.5) - 0.5));
  rings *= smoothstep(0.92, 0.6, f);                     // the centre stays a clear bright eye
  float ld = length(lq);
  float a = atan(lq.y, lq.x);
  float sa = abs(fract(a * 1.2732395 + 0.5) - 0.5) * 0.7853982 * ld;   // distance to the nearest of 8 spokes
  float ws = fwidth(ld);
  float spokes = (1.0 - smoothstep(0.0, ws * 1.3 + 0.012, sa)) * smoothstep(0.18, 0.4, ld) * 0.55;
  return mix(max(rings, spokes), 0.3, smoothstep(0.3, 0.7, wr));
}

// one component's luminous figure: anti-aliased lines where the mode is still
float figure(vec2 lq, float n, float m, float s, float norm) {
  float val = chladni(lq, vec3(n, m, s)) * norm;
  float w = fwidth(val);
  float ln = 1.0 - smoothstep(0.0, w * 1.25 + 0.03, abs(val));
  return mix(ln, 0.28, smoothstep(0.25, 0.7, w));       // too fine to resolve: a soft glow instead
}

void main() {
  float r = vA.z, e = clamp(vA.w, 0.0, 1.0), age = vB.x;
  float code = floor(vB.y + 0.001), prog = fract(vB.y);
  float flags = vD.w;
  float aur = bit(flags, 1.0), slp = bit(flags, 2.0), fls = bit(flags, 4.0), nst = bit(flags, 8.0);
  float lift = bit(flags, 16.0), lunge = bit(flags, 32.0), old = step(0.8, age);
  float keeper = max(bit(flags, 64.0), 1.0 - step(0.5, vB.z));
  float goldDeath = max(bit(flags, 128.0), step(0.97, age));
  bool cling = code > 10.5 && code < 11.5;
  float phase = fract(r * 9173.31 + vB.z * 0.137 + vB.w * 0.071 + vC.x * 0.05);
  float nc = 1.0 + step(0.5, vC.y) + step(0.5, vD.x);
  vec3 cAvg = (vC1 + (nc > 1.5 ? vC2 : vec3(0.0)) + (nc > 2.5 ? vC3 : vec3(0.0))) / nc;
  float oldT = smoothstep(0.72, 1.0, age) * (0.4 + 0.6 * old);
  cAvg = mix(cAvg, GOLD * 1.1, oldT * 0.65);
  if (aur > 0.5) cAvg = mix(cAvg, GOLD, 0.25);
  if (nst > 0.5) cAvg = mix(cAvg, vec3(1.0, 0.86, 0.66), 0.25);
  // the palette is pale (it is also the notebook's); in the dark room it wants more colour
  vec3 c1 = sat(vC1, 1.9), c2 = sat(vC2, 1.9), c3 = sat(vC3, 1.9);
  vec3 cHalo = sat(cAvg, 2.2);
  const vec3 KEEP = vec3(1.0, 0.86, 0.62);                 // golden white
  if (keeper > 0.5) { cAvg = KEEP; cHalo = vec3(1.0, 0.80, 0.52); c1 = vec3(1.0, 0.95, 0.85); }

  // state shaping
  float scale = 1.0, alpha = 1.0, boost = 0.0, crumble = 0.0;
  bool born = code > 9.5 && code < 10.5;
  bool dying = code > 8.5 && code < 9.5;
  bool falling = code > 7.5 && code < 8.5;
  if (born) { scale = 0.25 + 0.75 * smoothstep(0.2, 1.0, prog); alpha = smoothstep(0.25, 0.85, prog); }
  else if (falling) { scale = 1.0 - 0.85 * prog; alpha = (1.0 - prog) * (1.0 - prog); }
  else if (dying) { crumble = prog; alpha = 1.0 - prog * prog; }
  else if (code > 3.5 && code < 4.5) { boost = sin(prog * 3.14159) * 0.9; scale = 1.0 + 0.12 * sin(prog * 6.2832); }
  else if (code > 1.5 && code < 2.5) { boost = sin(prog * 3.14159) * 0.6; }
  else if (code > 2.5 && code < 3.5) { boost = sin(prog * 3.14159) * (0.5 + fls); }
  if (fls > 0.5 && !(code > 2.5 && code < 3.5)) boost += 0.8;
  if (keeper > 0.5) scale *= 1.0 + 0.05 * sin(uTime * 0.7 + phase * 6.2832);   // she breathes, slowly

  float inten = 0.32 + 0.68 * e;
  inten *= 0.88 + 0.12 * sin(uTime * (1.1 + vB.z * 0.12 + vB.w * 0.05) + phase * 6.2832);   // halo pulse, by mode
  float hunger = smoothstep(0.26, 0.04, e);
  inten *= mix(1.0, 0.45 + 0.55 * step(0.32, vnoise1(uTime * 9.0 + phase * 40.0)), hunger);
  if (slp > 0.5) inten *= 0.62 + 0.12 * sin(uTime * 0.7 + phase * 6.2832);
  inten *= 1.0 + 0.15 * lunge + 0.25 * lift + 0.2 * uChoir;
  if (cling) inten *= 1.08 + 0.1 * sin(uTime * 37.0 + phase * 20.0);
  if (keeper > 0.5) inten = (0.75 + 0.25 * e) * (0.9 + 0.1 * sin(uTime * 0.7 + phase * 6.2832));

  if (uPass == 2) {                       // light on the bronze (plate units)
    float d = length(vQ);
    if (keeper > 0.5) {                   // she lights a wide, warm stretch of the plate
      float r0 = 0.17;
      float x2 = d * d / (r0 * r0);
      float fall = 1.0 / ((1.0 + x2) * sqrt(1.0 + x2));
      fall *= 1.0 - smoothstep(0.35, 1.15, d);
      oC = vec4(vec3(1.0, 0.72, 0.42) * inten * fall * alpha * 1.25, 1.0);
      return;
    }
    float r0 = 0.05 * (0.6 + 0.4 * r / 0.045);
    float x2 = d * d / (r0 * r0);
    float fall = 1.0 / ((1.0 + x2) * sqrt(1.0 + x2));
    fall *= 1.0 - smoothstep(0.12, 0.5, d);
    oC = vec4(sat(cAvg, 1.4) * inten * fall * alpha * (1.0 + boost) * 1.1 * scale * (cling ? 1.3 : 1.0), 1.0);
    return;
  }

  vec2 q = vQ;
  float d = length(q);

  if (uPass == 0) {                       // soft shadow and small dark feet, in the spotlight only
    float sh = 1.0 - smoothstep(0.55, 1.35 + lift * 0.7, length(q - vSh) * (1.0 + lift * 0.3) / max(scale, 0.2));
    sh *= 0.42 * alpha * (1.0 - 0.5 * lift);
    float walk = code < 0.5 ? prog : 0.15;
    float feet = 0.0;
    for (int i = 0; i < 6; i++) {
      float fi = float(i);
      float a = fi * 1.0472 + phase * 6.2832 + sin(uTime * (7.0 + walk * 16.0) + fi * 2.1) * 0.16 * (0.3 + walk);
      vec2 fp = vec2(cos(a), sin(a)) * (1.0 + 0.08 * sin(uTime * 13.0 + fi * 1.7) * (0.3 + walk)) * scale;
      feet = max(feet, 1.0 - smoothstep(0.07, 0.14, length(q - fp)));
    }
    feet *= (1.0 - lift) * alpha * (1.0 - crumble);
    float lit = smoothstep(0.02, 0.5, uLevel);
    float bodyD = (1.0 - smoothstep(0.9, 1.02, d / max(scale, 0.05))) * 0.55 * alpha * (1.0 - crumble);
    float a = max(max(sh, bodyD) * lit, feet * 0.85);
    oC = vec4(vec3(0.03, 0.022, 0.014) * feet * 0.85, a);
    return;
  }

  // glow pass
  float spin = uTime * mix(0.16, 0.04, slp) * (vC.x < 0.0 ? -1.0 : 1.0) + phase * 6.2832;
  float cs = cos(spin), sn = sin(spin);
  vec2 lq = mat2(cs, sn, -sn, cs) * q / max(scale, 0.05);
  if (code > 1.5 && code < 2.5) lq.x /= 1.0 + 0.35 * sin(prog * 3.14159);    // dividing: it stretches
  if (dying) lq /= 1.0 + crumble * 0.5;
  float ld = length(lq);
  float aa = fwidth(ld) * 1.2;
  float body = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, ld);
  if (dying) body *= step(crumble * 1.1, vnoise(lq * 4.0 + phase * 31.0) * 0.9 + 0.1 * (1.0 - ld));

  vec3 col = vec3(0.0);
  float halo = exp(-(d * d) / (scale * scale + 1e-3) * 0.62);
  col += cHalo * halo * 0.42 * inten * (1.0 + boost * 1.6);
  float rimK = cling ? 1.9 : 0.85;
  col += cHalo * body * (0.05 + rimK * pow(ld, 7.0)) * inten;              // glassy body, brighter rim
  if (cling) col += mix(cHalo, vec3(1.0), 0.5) * exp(-pow((ld - 1.0) * 11.0, 2.0)) * 0.55 * inten;
  if (keeper > 0.5) {
    // a long, faint halo, and a body of warm light rather than glass
    col += cHalo * exp(-d * 0.85) * 0.16 * inten * (1.0 - smoothstep(3.6, 5.2, d));
    col += KEEP * body * (0.16 + 0.3 * (1.0 - ld * ld)) * inten;
  }

  vec2 fq = lq * 0.98;
  vec3 lines = keeper > 0.5 ? c1 * floorFigure(fq) : c1 * figure(fq, vB.z, vB.w, vC.x, vNorm.x);
  if (nc > 1.5) lines += c2 * figure(fq, vC.y, vC.z, vC.w, vNorm.y);
  if (nc > 2.5) lines += c3 * figure(fq, vD.x, vD.y, vD.z, vNorm.z);
  lines = mix(lines, lines * mix(vec3(1.0), GOLD * 1.3, 0.8), oldT * 0.6);
  col += lines * body * (1.6 - 0.6 * pow(ld, 6.0)) * inten * mix(1.0, 1.6, oldT * 0.3);

  if (aur > 0.5) {                                                          // gold veins
    float vn = abs(sin(lq.x * 3.9 + sin(lq.y * 3.1 + phase * 6.0 + uTime * 0.2) * 1.5) * cos(lq.y * 2.3 - lq.x * 1.4));
    float vw = fwidth(vn);
    col += GOLD * (1.0 - smoothstep(0.0, vw + 0.07, vn)) * body * 0.9 * inten;
  }
  if (nst > 0.5) {                                                          // purr
    float pr = fract(uTime * 0.45 + phase);
    col += cAvg * exp(-pow((d - 1.15 - 0.9 * pr) * 7.0, 2.0)) * (1.0 - pr) * 0.18 * inten;
  }
  if (fls > 0.5 || (code > 2.5 && code < 3.5)) {                            // fusion flash
    float fa = code > 2.5 && code < 3.5 ? sin(prog * 3.14159) : 0.7;
    col += vec3(1.0, 0.95, 0.85) * exp(-d * d * 0.9) * fa * 1.6;
  }
  if (born) {                                                               // assembled from sparkles
    float conv = smoothstep(0.0, 0.8, prog);
    for (int i = 0; i < 12; i++) {
      float fi = float(i);
      float a = phase * 6.2832 + fi * 2.39996 + prog * 4.0;
      float rad = mix(2.9, 0.15, conv) * (0.65 + 0.35 * hash11(fi + phase * 17.0));
      vec2 sp = vec2(cos(a), sin(a)) * rad;
      vec2 dq = q - sp;
      col += mix(cAvg, vec3(1.0), 0.4) * exp(-dot(dq, dq) * 70.0) * 1.3 * (1.0 - smoothstep(0.75, 1.0, prog));
    }
    col += cAvg * exp(-d * d * 2.0) * smoothstep(0.6, 1.0, prog) * (1.0 - prog) * 1.5;
  }
  if (dying) {                                                              // crumbling grains
    vec3 cc = mix(cAvg * 0.6, GOLD, goldDeath * 0.75);
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      if (fi > 9.5 && goldDeath < 0.5) break;
      float a = phase * 6.2832 + fi * 2.39996;
      vec2 sp = vec2(cos(a), sin(a)) * (0.3 + crumble * (0.9 + 0.8 * hash11(fi + phase * 9.0))) + vec2(0.0, crumble * crumble * 0.8);
      vec2 dq = q - sp;
      float tw = goldDeath > 0.5 ? 0.7 + 0.6 * pow(hash11(fi + floor(uTime * 9.0)), 6.0) : 1.0;
      col += cc * exp(-dot(dq, dq) * 90.0) * (1.0 - crumble) * (0.8 + goldDeath * 1.2) * tw;
    }
    // a death of old age leaves a brief warm glow where the body was
    col += GOLD * goldDeath * exp(-d * d * 1.6) * sin(crumble * 3.14159) * 0.35;
  }

  oC = vec4(col * alpha, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Dust motes drifting in the beam (procedural; no CPU state).
export const VS_DUST = `${HEAD}
uniform vec2 uRes;
uniform float uDpr;
uniform vec3 uLamp;
uniform float uPoolR;
uniform float uTime;
uniform float uLightI;
out float vA;
out float vSoft;
float h(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  float id = float(gl_VertexID);
  float a = h(id * 1.31) * 6.2832;
  float rad = sqrt(h(id * 2.17)) * 1.25;
  vec2 base = vec2(cos(a), sin(a)) * rad * uPoolR;
  float sp = 0.006 + 0.012 * h(id * 3.7);
  vec2 drift = vec2(sin(uTime * sp * 6.0 + id), cos(uTime * sp * 4.7 + id * 1.7)) * uPoolR * 0.08;
  drift += vec2(uTime * sp * 3.0, -uTime * sp * 1.6) * uPoolR * 0.25;
  vec2 p = base + drift;
  vec2 box = vec2(uPoolR * 2.6);
  p = mod(p + box * 0.5, box) - box * 0.5;
  vec2 css = uLamp.xy + p;
  float r = length(p) / uPoolR;
  float lit = pow(max(0.0, 1.0 - smoothstep(0.2, 1.05, r)), 2.0) * uLightI;
  float flake = pow(0.5 + 0.5 * sin(uTime * (0.7 + 1.9 * h(id * 5.3)) + id * 3.1), 5.0);
  float bokeh = step(0.86, h(id * 7.7));
  vSoft = bokeh;
  vA = lit * (0.2 + 0.8 * flake) * mix(1.1, 0.16, bokeh);
  gl_PointSize = mix(1.4 + 1.8 * h(id * 9.1), 5.0 + 6.0 * h(id * 4.4), bokeh) * uDpr;
  vec2 vp = uRes / uDpr;
  gl_Position = vec4(css.x / vp.x * 2.0 - 1.0, 1.0 - css.y / vp.y * 2.0, 0.0, 1.0);
}`;

export const FS_DUST = `${HEAD}
in float vA;
in float vSoft;
out vec4 oC;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float m = vSoft > 0.5 ? (1.0 - smoothstep(0.55, 1.0, d)) * (0.6 + 0.4 * smoothstep(0.4, 0.95, d)) : exp(-d * d * 4.0);
  oC = vec4(vec3(1.0, 0.86, 0.68) * vA * m, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Bloom: bright pass (4-tap downsample with soft knee), separable blur, 2x downsample.
export const FS_BRIGHT = `${HEAD}
in vec2 vUv;
out vec4 oC;
uniform sampler2D tSrc;
uniform vec2 uTexel;       // source texel
uniform float uThresh;
void main() {
  vec3 c = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = uThresh * 0.5;
  float s = clamp(l - uThresh + k, 0.0, 2.0 * k);
  s = s * s / (4.0 * k + 1e-4);
  float w = max(s, l - uThresh) / max(l, 1e-4);
  oC = vec4(c * w, 1.0);
}`;

export const FS_BLUR = `${HEAD}
in vec2 vUv;
out vec4 oC;
uniform sampler2D tSrc;
uniform vec2 uDir;         // texel step * direction
void main() {
  vec3 c = texture(tSrc, vUv).rgb * 0.2270270;
  c += (texture(tSrc, vUv + uDir * 1.3846154).rgb + texture(tSrc, vUv - uDir * 1.3846154).rgb) * 0.3162162;
  c += (texture(tSrc, vUv + uDir * 3.2307692).rgb + texture(tSrc, vUv - uDir * 3.2307692).rgb) * 0.0702703;
  oC = vec4(c, 1.0);
}`;

export const FS_DOWN = `${HEAD}
in vec2 vUv;
out vec4 oC;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 c = texture(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb + texture(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb
         + texture(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb + texture(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  oC = vec4(c * 0.25, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Composite: bloom, beam rays, grade, tonemap, vignette, grain.
export const FS_COMPOSITE = `${HEAD}
in vec2 vUv;
out vec4 oC;
uniform sampler2D tScene, tBloomA, tBloomB;
uniform vec2 uRes;
uniform float uDpr;
uniform float uTime;
uniform vec3 uLamp;
uniform float uPoolR;
uniform float uLightI;
uniform float uChoir;
uniform float uFloor;
uniform float uFlash;
uniform float uBloomK;
uniform float uFade;       // global fade (boot)
uniform float uPhono;      // the phonograph is playing: an old film's flicker and grain
uniform vec2 uAim;         // the spot's aim point (css px)
uniform float uPlateW;     // plate width (css px)
uniform int uDebug;        // 0 normal, 1 scene only, 2 bloom only
${NOISE}
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float acesL(float x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
// Per-channel ACES turns bright orange into lemon. Blend it with a hue-keeping curve (tonemap the
// luminance, keep the ratios, scale down rather than clip), so warm highlights stay copper.
vec3 tonemap(vec3 x) {
  x = max(x, 0.0);
  float l = max(dot(x, vec3(0.2126, 0.7152, 0.0722)), 1e-5);
  vec3 hp = x * (acesL(l) / l);
  hp /= max(1.0, max(hp.r, max(hp.g, hp.b)));
  return mix(aces(x), hp, 0.62);
}
void main() {
  vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec3 c = texture(tScene, vUv).rgb;
  vec3 b = texture(tBloomA, vUv).rgb * 0.55 + texture(tBloomB, vUv).rgb * 0.85;
  if (uDebug == 1) { oC = vec4(pow(clamp(texture(tScene, vUv).rgb, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0); return; }
  if (uDebug == 2) { oC = vec4(pow(clamp(b, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0); return; }
  c += b * uBloomK;

  // the beam: faint shafts in the dusty air, seen from below the lamp
  vec2 d = css - uLamp.xy;
  float r = length(d) / uPoolR;
  float ra = length(css - uAim) / uPlateW;
  vec2 dirv = d / max(length(d), 1e-3);
  float ang = vnoise(dirv * 9.0 + vec2(uTime * 0.021, -uTime * 0.017)) * 0.55 + vnoise(dirv * 23.0 - vec2(uTime * 0.035, uTime * 0.012)) * 0.45;
  float rays = smoothstep(0.5, 0.95, ang) * exp(-r * 1.8) * smoothstep(0.05, 0.45, r);
  float haze = exp(-ra * ra * 3.2);
  c += vec3(1.0, 0.84, 0.62) * uLightI * (rays * (0.005 + 0.028 * uChoir) + haze * (0.005 + 0.018 * uChoir));

  // grade: choir warms everything toward gold; the floor whitens it
  c *= mix(vec3(1.0), vec3(1.10, 0.97, 0.74), uChoir * 0.6);
  c = mix(c, c * vec3(1.05, 1.02, 0.95) + vec3(0.012, 0.01, 0.006), uFloor * 0.5);
  c += vec3(1.0, 0.95, 0.86) * uFlash * 0.18;

  // vignette
  vec2 vq = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float vig = 1.0 - smoothstep(0.35, 1.05, length(vq));
  c *= 0.55 + 0.45 * vig;

  c = tonemap(c) * 0.97;                     // white sits just under the rail: nothing clips
  c = pow(c, vec3(1.0 / 2.2));
  c *= uFade;

  // phonograph playback: the room remembers itself like an old film. A faint sepia cast, the
  // projector's uneven flicker, a lifted black and coarser grain. Barely there.
  float gseed = floor(uTime * 24.0);
  if (uPhono > 0.001) {
    float fl = vnoise1(uTime * 15.0) * 0.6 + vnoise1(uTime * 41.0 + 7.0) * 0.4;
    float lum = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 sep = vec3(lum * 1.07 + 0.012, lum * 0.96 + 0.008, lum * 0.80 + 0.004);
    c = mix(c, sep, 0.16 * uPhono);
    c *= 1.0 + (fl - 0.5) * 0.05 * uPhono;
    c += vec3(0.010, 0.008, 0.005) * uPhono;
  }

  // film grain + dither
  float gn = hash12(gl_FragCoord.xy + gseed * 37.0) + hash12(gl_FragCoord.xy * 1.37 - gseed * 11.0) - 1.0;
  c += gn * (0.018 + 0.012 * (1.0 - c.g)) * (0.6 + 0.45 * uPhono);
  oC = vec4(c, 1.0);
}`;
