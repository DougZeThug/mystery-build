// Vibration modes of a square plate (free edges, clamped at the centre).
// Classic Chladni approximation, x,y in [0,1]:
//   M(n,m,s) = cos(nπx)cos(mπy) + s·cos(mπx)cos(nπy)
// k = n² + m² is the mode's harmonic number; freq = 27.5·k Hz.
// Plate space is u,v in [-1,1] with x = (u+1)/2, y = (v+1)/2 (v points down the screen).

const PI = Math.PI;
const HALF_PI = PI * 0.5;
export const BASE_FREQ = 27.5;
export const K_MIN_BOW = 5;
export const K_MAX_BOW = 65;

export const MODES = [];
for (let n = 1; n <= 7; n++) {
  for (let m = n; m <= 7; m++) {
    for (const s of n === m ? [1] : [1, -1]) {
      const k = n * n + m * m;
      MODES.push({ id: `${n}.${m}${s > 0 ? '+' : '-'}`, n, m, s, k, freq: BASE_FREQ * k,
        bowable: k >= K_MIN_BOW && k <= K_MAX_BOW, special: false, norm: 1, index: MODES.length });
    }
  }
}
// The floor: the whole plate is one antinode, the rim is the only still place.
// f = cos(πu/2)·cos(πv/2) = sin(πx)·sin(πy). Never bowable.
MODES.push({ id: 'floor', n: 0, m: 0, s: 1, k: 2, freq: BASE_FREQ * 2, bowable: false, special: true, norm: 1,
  index: MODES.length });

const BY_ID = new Map(MODES.map((m) => [m.id, m]));
export const modeById = (id) => (typeof id === 'string' ? BY_ID.get(id) || null : (id && BY_ID.get(id.id)) || null);
export const modesWithK = (k) => MODES.filter((m) => m.k === k && !m.special);
export const BOWABLE = MODES.filter((m) => m.bowable);
export const K_VALUES = [...new Set(MODES.filter((m) => !m.special).map((m) => m.k))].sort((a, b) => a - b);

function rawEval(mode, u, v) {
  if (mode.special) return Math.cos(HALF_PI * u) * Math.cos(HALF_PI * v);
  const x = (u + 1) * 0.5, y = (v + 1) * 0.5;
  const n = mode.n, m = mode.m;
  return Math.cos(n * PI * x) * Math.cos(m * PI * y) + mode.s * Math.cos(m * PI * x) * Math.cos(n * PI * y);
}

// Normalise so that max |M| over the plate is exactly 1. |raw| <= 2 everywhere; most modes reach 2 at
// a corner. Same-parity antisymmetric modes (1.3-, 3.5-, ...) peak inside: coarse search + hill climb.
function findMax(mode) {
  let mx = 0;
  for (const cu of [-1, 1]) for (const cv of [-1, 1]) mx = Math.max(mx, Math.abs(rawEval(mode, cu, cv)));
  if (mx > 2 - 1e-9) return 2;
  let bu = 0, bv = 0;
  const N = 96;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const u = -1 + (2 * i) / N, v = -1 + (2 * j) / N;
    const a = Math.abs(rawEval(mode, u, v));
    if (a > mx) { mx = a; bu = u; bv = v; }
  }
  for (let step = 2 / N; step > 1e-7; step *= 0.5) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [du, dv] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const u = Math.max(-1, Math.min(1, bu + du)), v = Math.max(-1, Math.min(1, bv + dv));
        const a = Math.abs(rawEval(mode, u, v));
        if (a > mx) { mx = a; bu = u; bv = v; improved = true; }
      }
    }
  }
  return mx;
}
for (const mode of MODES) {
  const mx = findMax(mode);
  mode.norm = mx > 1e-9 ? 1 / mx : 1;
}

export function evalMode(mode, u, v) {
  if (!mode) return 0;
  return rawEval(mode, u, v) * mode.norm;
}

// Edges run clockwise: top (left→right), right (top→bottom), bottom (right→left), left (bottom→top).
export const EDGES = ['top', 'right', 'bottom', 'left'];
export function edgePoint(edge, t) {
  switch (edge) {
    case 'top': return { u: -1 + 2 * t, v: -1 };
    case 'right': return { u: 1, v: -1 + 2 * t };
    case 'bottom': return { u: 1 - 2 * t, v: 1 };
    default: return { u: -1, v: 1 - 2 * t };
  }
}

const clamp01 = (t) => (t > 0 ? (t < 1 ? t : 1) : 0); // NaN -> 0

// |M| at a point on an edge (allocation free; called ~45× per frame while bowing).
export function edgeResponse(mode, edge, t) {
  if (!mode) return 0;
  t = clamp01(t);
  let u, v;
  if (edge === 'top') { u = -1 + 2 * t; v = -1; } else if (edge === 'right') { u = 1; v = -1 + 2 * t; }
  else if (edge === 'bottom') { u = 1 - 2 * t; v = 1; } else { u = -1; v = 1 - 2 * t; }
  return Math.abs(rawEval(mode, u, v) * mode.norm);
}

// Bow speed -> the harmonic number it naturally excites. The mapping is linear in √k (spatial
// wavenumber) rather than k, so the sparse low modes (5, 8, 10, 13) get a fair share of slow,
// gentle strokes and the crowded high modes need real vigour.
// The range runs a little beyond both ends so k=5 and k=65 own a full window, not half of one.
const SK0 = Math.sqrt(K_MIN_BOW) - 0.24, SK1 = Math.sqrt(K_MAX_BOW) + 0.24;
export function bowTargetK(speed01) {
  const sk = SK0 + (SK1 - SK0) * Math.pow(clamp01(speed01), 1.1);
  return sk * sk;
}
const SQRT_K = new Float64Array(MODES.length);
for (const m of MODES) SQRT_K[m.index] = Math.sqrt(m.k);
const BOW_WIDTH = 0.55;      // gaussian width in √k units
const BOW_HYSTERESIS = 2.0;  // the mode already sounding is favoured (stick-slip locks in)

// Which mode does a bow at (edge, t) moving at speed01 excite? Deterministic.
// score = edgeResponse^1.5 · exp(-((√k-√k*)/w)^2) · (1 - suppress(mode)), ×2 for currentId.
export function bowPick(edge, t, speed01, currentId = null, suppress = null) {
  const sk = Math.sqrt(bowTargetK(speed01));
  let best = null, bestScore = -1;
  for (let i = 0; i < BOWABLE.length; i++) {
    const mode = BOWABLE[i];
    const d = (SQRT_K[mode.index] - sk) / BOW_WIDTH;
    let score = Math.pow(edgeResponse(mode, edge, t), 1.5) * Math.exp(-d * d);
    if (suppress) {
      const sp = +suppress(mode);
      if (sp > 0) score *= 1 - Math.min(1, sp);
    }
    if (mode.id === currentId) score *= BOW_HYSTERESIS;
    if (score > bestScore) { bestScore = score; best = mode; }
  }
  return best ? best.id : null;
}

// Optional stateful wrapper for the bow: a newly picked mode must keep winning for `hold` seconds
// before it replaces the sounding one, so a wavering hand does not make the plate stutter.
export function createBowSelector(hold = 0.18) {
  let current = null, candidate = null, candT = 0;
  return {
    get current() { return current; },
    reset() { current = null; candidate = null; candT = 0; },
    pick(edge, t, speed01, dt = 1 / 60, suppress = null) {
      const id = bowPick(edge, t, speed01, current, suppress);
      if (current === null || id === current) { current = id; candidate = null; candT = 0; return current; }
      if (id === candidate) candT += dt > 0 ? dt : 0; else { candidate = id; candT = dt > 0 ? dt : 0; }
      if (candT >= hold) { current = id; candidate = null; candT = 0; }
      return current;
    },
  };
}

// [n, m, s, norm] for passing a mode to a shader (floor: n = 0).
export function modeVec(mode) {
  mode = modeById(mode);
  return mode ? [mode.n, mode.m, mode.s, mode.norm] : [0, 0, 0, 0];
}

// GLSL twin of evalMode. uv in [-1,1]; nms = (n, m, s); n == 0 -> floor.
//   chladni(uv, nms)   raw value (in [-2,2] for the regular modes, [0,1] for the floor)
//   chladniN(uv, nms)  normalised exactly like evalMode (max |value| = 1)
// Written in scalar style on purpose (the unit test ports it to JS textually).
const normCases = MODES.filter((m) => !m.special && Math.abs(m.norm - 0.5) > 1e-6)
  .map((m) => `  if (abs(key - ${(m.n * 8 + m.m).toFixed(1)}) < 0.5 && nms.z < 0.0) return ${m.norm.toFixed(6)};`)
  .join('\n');
export const GLSL_MODE = `
float chladni(vec2 uv, vec3 nms) {
  if (nms.x < 0.5) return cos(1.5707963 * uv.x) * cos(1.5707963 * uv.y);
  float px = (uv.x + 1.0) * 0.5;
  float py = (uv.y + 1.0) * 0.5;
  return cos(nms.x * 3.14159265 * px) * cos(nms.y * 3.14159265 * py)
       + nms.z * cos(nms.y * 3.14159265 * px) * cos(nms.x * 3.14159265 * py);
}
float chladniNorm(vec3 nms) {
  if (nms.x < 0.5) return 1.0;
  float key = nms.x * 8.0 + nms.y;
${normCases}
  return 0.5;
}
float chladniN(vec2 uv, vec3 nms) {
  return chladni(uv, nms) * chladniNorm(nms);
}
`;
