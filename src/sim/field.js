// The plate's vibration: modal amplitudes driven by sources, and the resulting field on a grid.
import { MODES, modeById, evalMode } from './modes.js';

const PI = Math.PI;

export function createField({ G = 160, state = null, bus = null, rng = Math.random } = {}) {
  const NM = MODES.length;
  const amps = new Float32Array(NM);      // smoothed driven amplitudes
  const targets = new Float32Array(NM);
  const impulses = new Float32Array(NM);  // transient amplitudes (taps)
  const eff = new Float32Array(NM);       // amps + impulses (what the plate is doing)
  const suppress = new Float32Array(NM);  // damper suppression per mode
  const sources = new Map();              // id -> [{mode, amp}]
  let impulseDecay = 0.6;

  // per-mode grid tables: cos(n*PI*x_i) for n=1..7 on grid coords
  const xs = new Float32Array(G);
  for (let i = 0; i < G; i++) xs[i] = (i + 0.5) / G; // x in (0,1)
  const cosT = [];
  for (let n = 0; n <= 7; n++) {
    const t = new Float32Array(G);
    for (let i = 0; i < G; i++) t[i] = Math.cos(n * PI * xs[i]);
    cosT.push(t);
  }
  // radial table for the floor mode
  const floorT = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const u = xs[i] * 2 - 1, v = xs[j] * 2 - 1;
    floorT[j * G + i] = Math.cos(Math.min(1, Math.hypot(u, v)) * PI * 0.5);
  }

  const grid = new Float32Array(G * G);   // f
  const Fx = new Float32Array(G * G);     // dF/du  (F = f^2)
  const Fy = new Float32Array(G * G);     // dF/dv
  const crackMask = new Float32Array(G * G).fill(1);
  const crackNear = new Uint8Array(G * G); // 1 = within drain distance of an unhealed crack
  let crackVersion = -1;
  let gridDirty = true;
  let lastEffSig = '';

  const field = {
    G, grid, Fx, Fy, crackMask, crackNear,
    modes: MODES,
    dampers: [],
    total: 0,
    detune: 0,
    coherence: { dominant: null, share: 0, second: null, secondShare: 0, stable: 0 },
    version: 0,

    setSource(id, comps) {
      if (!comps || comps.length === 0) sources.delete(id);
      else sources.set(id, comps);
    },
    getSource(id) { return sources.get(id) || null; },

    impulse(comps, decay = 0.6) {
      impulseDecay = decay;
      for (const c of comps) {
        const m = modeById(c.mode);
        if (m) impulses[m.index] = Math.min(1.6, impulses[m.index] + c.amp);
      }
    },

    amp(modeId) { const m = modeById(modeId); return m ? eff[m.index] : 0; },
    ampIndex(i) { return eff[i]; },

    spectrum() {
      const out = [];
      for (let i = 0; i < NM; i++) {
        if (eff[i] > 0.004) { const m = MODES[i]; out.push({ mode: m.id, k: m.k, freq: m.freq, amp: eff[i], index: i }); }
      }
      out.sort((a, b) => b.amp - a.amp);
      return out;
    },

    suppression(mode) {
      let s = 0;
      for (const d of field.dampers) s = Math.max(s, Math.abs(evalMode(mode, d.u, d.v)));
      return s;
    },

    update(dt) {
      // damper suppression
      for (let i = 0; i < NM; i++) suppress[i] = field.dampers.length ? field.suppression(MODES[i]) : 0;
      targets.fill(0);
      for (const comps of sources.values()) {
        for (const c of comps) {
          const m = modeById(c.mode);
          if (m) targets[m.index] += c.amp;
        }
      }
      const ka = 1 - Math.exp(-dt / 0.35), kr = 1 - Math.exp(-dt / 1.4);
      const kImp = Math.exp(-dt / impulseDecay);
      let sum2 = 0;
      for (let i = 0; i < NM; i++) {
        const tg = Math.min(1.6, targets[i]) * (1 - 0.92 * suppress[i]);
        amps[i] += (tg - amps[i]) * (tg > amps[i] ? ka : kr);
        if (amps[i] < 1e-4) amps[i] = 0;
        impulses[i] *= kImp * (1 - 0.6 * suppress[i] * dt);
        if (impulses[i] < 1e-4) impulses[i] = 0;
        eff[i] = amps[i] + impulses[i];
        sum2 += eff[i] * eff[i];
      }
      field.total = Math.sqrt(sum2);

      // coherence
      let d = -1, dv = 0, s2 = -1, sv = 0;
      for (let i = 0; i < NM; i++) {
        const e2 = eff[i] * eff[i];
        if (e2 > dv) { s2 = d; sv = dv; d = i; dv = e2; } else if (e2 > sv) { s2 = i; sv = e2; }
      }
      const coh = field.coherence;
      const share = sum2 > 1e-6 ? dv / sum2 : 0;
      const dom = d >= 0 && dv > 1e-6 ? MODES[d].id : null;
      if (dom && dom === coh.dominant && share > 0.55 && field.total > 0.12) coh.stable += dt;
      else coh.stable = dom && share > 0.55 && field.total > 0.12 ? Math.min(coh.stable, 0.2) : 0;
      coh.dominant = dom; coh.share = share;
      coh.second = s2 >= 0 && sv > 1e-6 ? MODES[s2].id : null;
      coh.secondShare = sum2 > 1e-6 ? sv / sum2 : 0;

      // cracks / fatigue
      const plate = state?.plate;
      if (plate) {
        const unhealed = plate.cracks.filter((c) => !c.healed).length;
        field.detune = 0.006 * unhealed;
        if (field.total > 1.2) {
          plate.fatigue += dt * (field.total - 1.2) ** 2 * 2.0;
          if (plate.fatigue > 1 && plate.cracks.length < 7) {
            plate.fatigue = 0.2;
            const crack = makeCrack(rng);
            plate.cracks.push(crack);
            bus?.emit('plate:crack', { crack: plate.cracks.length - 1 });
          }
        } else {
          plate.fatigue = Math.max(0, plate.fatigue - dt * 0.004);
        }
        const ver = crackSig(plate.cracks);
        if (ver !== crackVersion) { crackVersion = ver; rebuildCrackMask(plate.cracks); gridDirty = true; }
      }

      // recompute grid if amplitudes changed meaningfully
      let sig = '';
      for (let i = 0; i < NM; i++) if (eff[i] > 0.003) sig += i + ':' + Math.round(eff[i] * 400) + ',';
      if (sig !== lastEffSig || gridDirty) { lastEffSig = sig; gridDirty = false; recomputeGrid(); field.version++; }
    },

    sample(u, v) {
      const gx = (u + 1) * 0.5 * G - 0.5, gy = (v + 1) * 0.5 * G - 0.5;
      const i0 = Math.max(0, Math.min(G - 2, Math.floor(gx))), j0 = Math.max(0, Math.min(G - 2, Math.floor(gy)));
      const fx = Math.max(0, Math.min(1, gx - i0)), fy = Math.max(0, Math.min(1, gy - j0));
      const a = j0 * G + i0, b = a + 1, c = a + G, dd = c + 1;
      const lerp2 = (arr) => (arr[a] * (1 - fx) + arr[b] * fx) * (1 - fy) + (arr[c] * (1 - fx) + arr[dd] * fx) * fy;
      const f = lerp2(grid);
      return { f, F: f * f, gx: lerp2(Fx), gy: lerp2(Fy) };
    },

    // f at a point from modal sum directly (exact, slower)
    evalAt(u, v) {
      let f = 0;
      for (let i = 0; i < NM; i++) if (eff[i] > 0.003) f += eff[i] * evalMode(MODES[i], u, v);
      return f;
    },
  };

  function recomputeGrid() {
    grid.fill(0);
    for (let mi = 0; mi < NM; mi++) {
      const a = eff[mi];
      if (a <= 0.003) continue;
      const mode = MODES[mi];
      const w = a * mode.norm;
      if (mode.special) {
        for (let p = 0; p < G * G; p++) grid[p] += w * floorT[p];
        continue;
      }
      const cn = cosT[mode.n], cm = cosT[mode.m], s = mode.s;
      for (let j = 0; j < G; j++) {
        const cnj = cn[j], cmj = cm[j], row = j * G;
        for (let i = 0; i < G; i++) grid[row + i] += w * (cn[i] * cmj + s * cm[i] * cnj);
      }
    }
    if (crackVersion !== 0) for (let p = 0; p < G * G; p++) grid[p] *= crackMask[p];
    // gradients of F = f^2 in plate units (grid spacing = 2/G)
    const inv = G / 2;
    for (let j = 0; j < G; j++) {
      const jm = j > 0 ? j - 1 : j, jp = j < G - 1 ? j + 1 : j;
      for (let i = 0; i < G; i++) {
        const im = i > 0 ? i - 1 : i, ip = i < G - 1 ? i + 1 : i;
        const p = j * G + i;
        const fl = grid[j * G + im], fr = grid[j * G + ip], fu = grid[jm * G + i], fd = grid[jp * G + i];
        Fx[p] = (fr * fr - fl * fl) / ((ip - im) || 1) * inv;
        Fy[p] = (fd * fd - fu * fu) / ((jp - jm) || 1) * inv;
      }
    }
  }

  function rebuildCrackMask(cracks) {
    crackMask.fill(1); crackNear.fill(0);
    if (!cracks.length) return;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const u = xs[i] * 2 - 1, v = xs[j] * 2 - 1;
      let m = 1, near = 0;
      for (const c of cracks) {
        const d = distToPolyline(u, v, c.pts);
        const strength = c.healed ? 0.5 : 0.85;
        m = Math.min(m, 1 - strength * Math.exp(-(d * d) / 0.0016));
        if (!c.healed && d < 0.014) near = 1;
      }
      crackMask[j * G + i] = m;
      crackNear[j * G + i] = near;
    }
  }

  return field;
}

function crackSig(cracks) {
  let s = cracks.length * 1000;
  for (const c of cracks) s += (c.healed ? 7 : 1) * c.pts.length;
  return s;
}

export function distToPolyline(u, v, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy || 1e-9;
    let t = ((u - ax) * dx + (v - ay) * dy) / L;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx - u, py = ay + t * dy - v;
    best = Math.min(best, px * px + py * py);
  }
  return Math.sqrt(best);
}

export function nearestSegment(u, v, pts) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = distToPolyline(u, v, [pts[i], pts[i + 1]]);
    if (d < best) { best = d; bi = i; }
  }
  return { index: bi, dist: best };
}

export function makeCrack(rng = Math.random) {
  const r = typeof rng === 'function' ? rng : () => rng.next();
  const edge = Math.floor(r() * 4);
  const t = 0.15 + r() * 0.7;
  let u, v;
  if (edge === 0) { u = -1 + 2 * t; v = -1; } else if (edge === 1) { u = 1; v = -1 + 2 * t; }
  else if (edge === 2) { u = 1 - 2 * t; v = 1; } else { u = -1; v = 1 - 2 * t; }
  const pts = [[u, v]];
  let ang = Math.atan2(-v, -u) + (r() - 0.5) * 0.9;
  const len = 0.3 + r() * 0.6;
  let walked = 0;
  while (walked < len) {
    const step = 0.025 + r() * 0.03;
    ang += (r() - 0.5) * 0.9;
    const toC = Math.atan2(-v, -u);
    ang += (toC - ang) * 0.15;
    u += Math.cos(ang) * step; v += Math.sin(ang) * step;
    if (Math.hypot(u, v) < 0.1) break;
    pts.push([+u.toFixed(4), +v.toFixed(4)]);
    walked += step;
  }
  return { pts, gold: new Array(Math.max(1, pts.length - 1)).fill(0), healed: false, born: Date.now() };
}
