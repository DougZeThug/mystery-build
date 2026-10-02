// Vibration modes of a square plate (free edges, clamped at the centre).
// Classic Chladni approximation, x,y in [0,1]:
//   M(n,m,s) = cos(nπx)cos(mπy) + s·cos(mπx)cos(nπy)
// k = n² + m² is the mode's harmonic number; freq = 27.5·k Hz.

const PI = Math.PI;
export const BASE_FREQ = 27.5;

export const MODES = [];
for (let n = 1; n <= 7; n++) {
  for (let m = n; m <= 7; m++) {
    for (const s of n === m ? [1] : [1, -1]) {
      const k = n * n + m * m;
      MODES.push({ id: `${n}.${m}${s > 0 ? '+' : '-'}`, n, m, s, k, freq: BASE_FREQ * k,
        bowable: k >= 5 && k <= 65, special: false, norm: 1, index: MODES.length });
    }
  }
}
// The floor: one antinode at the centre, stillness at the rim. Never bowable.
MODES.push({ id: 'floor', n: 0, m: 0, s: 1, k: 2, freq: BASE_FREQ * 2, bowable: false, special: true, norm: 1,
  index: MODES.length });

const BY_ID = new Map(MODES.map((m) => [m.id, m]));
export const modeById = (id) => BY_ID.get(id) || null;
export const modesWithK = (k) => MODES.filter((m) => m.k === k && !m.special);
export const BOWABLE = MODES.filter((m) => m.bowable);
export const K_VALUES = [...new Set(MODES.filter((m) => !m.special).map((m) => m.k))].sort((a, b) => a - b);

function rawEval(mode, u, v) {
  if (mode.special) {
    const r = Math.min(1.0, Math.hypot(u, v));
    return Math.cos(r * PI * 0.5);
  }
  const x = (u + 1) * 0.5, y = (v + 1) * 0.5;
  const { n, m, s } = mode;
  return Math.cos(n * PI * x) * Math.cos(m * PI * y) + s * Math.cos(m * PI * x) * Math.cos(n * PI * y);
}

// normalise so that max |M| over the plate is 1
for (const mode of MODES) {
  let mx = 0;
  for (let j = 0; j <= 64; j++) for (let i = 0; i <= 64; i++) {
    mx = Math.max(mx, Math.abs(rawEval(mode, -1 + (2 * i) / 64, -1 + (2 * j) / 64)));
  }
  mode.norm = mx > 1e-9 ? 1 / mx : 1;
}

export function evalMode(mode, u, v) {
  return rawEval(mode, u, v) * mode.norm;
}

// Edges run clockwise: top (left→right), right (top→bottom), bottom (right→left), left (bottom→top).
export function edgePoint(edge, t) {
  switch (edge) {
    case 'top': return { u: -1 + 2 * t, v: -1 };
    case 'right': return { u: 1, v: -1 + 2 * t };
    case 'bottom': return { u: 1 - 2 * t, v: 1 };
    default: return { u: -1, v: 1 - 2 * t };
  }
}

export function edgeResponse(mode, edge, t) {
  const p = edgePoint(edge, t);
  return Math.abs(evalMode(mode, p.u, p.v));
}

// Which mode does a bow at (edge, t) moving at speed01 excite?
export function bowPick(edge, t, speed01, currentId = null, suppress = null) {
  const kStar = 5 + (65 - 5) * Math.pow(Math.max(0, Math.min(1, speed01)), 0.85);
  let best = null, bestScore = -1;
  for (const mode of BOWABLE) {
    let score = Math.pow(edgeResponse(mode, edge, t), 1.5) * Math.exp(-(((mode.k - kStar) / 7) ** 2));
    if (suppress) score *= 1 - suppress(mode);
    if (mode.id === currentId) score *= 1.35;
    if (score > bestScore) { bestScore = score; best = mode; }
  }
  return best ? best.id : null;
}

// GLSL twin of evalMode (without normalisation). uv in [-1,1]; nms = (n, m, s). n == 0 -> floor.
export const GLSL_MODE = `
float chladni(vec2 uv, vec3 nms) {
  if (nms.x < 0.5) { float r = min(1.0, length(uv)); return cos(r * 1.5707963); }
  vec2 p = (uv + 1.0) * 0.5;
  return cos(nms.x * 3.14159265 * p.x) * cos(nms.y * 3.14159265 * p.y)
       + nms.z * cos(nms.y * 3.14159265 * p.x) * cos(nms.x * 3.14159265 * p.y);
}
`;
