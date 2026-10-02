// Sand and gold grains on the plate. Grains seek stillness (nodes) and are kicked at antinodes.
import { nearestSegment } from './field.js';

export function createSand(field, { cap = 26000, D = 256, state = null, bus = null } = {}) {
  const x = new Float32Array(cap), y = new Float32Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap);
  const kind = new Uint8Array(cap);
  const density = new Float32Array(D * D), gold = new Float32Array(D * D);
  const tmp = new Float32Array(D * D);
  const tex = new Uint8Array(D * D * 4);
  const CG = 48;                                   // coarse count grid
  const counts = new Uint16Array(CG * CG);
  const G = field.G;
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.816;

  const sand = {
    cap, D, CG, x, y, vx, vy, kind, density, gold, counts, n: 0,
    lost: 0, drained: 0, lodged: 0, version: 0,

    add(u, v, k = 0) {
      if (sand.n >= cap) return false;
      const i = sand.n++;
      x[i] = u; y[i] = v; vx[i] = 0; vy[i] = 0; kind[i] = k;
      return true;
    },

    removeAt(i) {
      const last = --sand.n;
      if (i !== last) { x[i] = x[last]; y[i] = y[last]; vx[i] = vx[last]; vy[i] = vy[last]; kind[i] = kind[last]; }
    },

    seedScatter(count) {
      for (let c = 0; c < count; c++) {
        // gentle clumping: some grains cluster around random seeds
        let u, v;
        if (rnd() < 0.25) { const cu = rnd() * 1.8 - 0.9, cv = rnd() * 1.8 - 0.9; u = cu + gauss() * 0.05; v = cv + gauss() * 0.05; }
        else { u = rnd() * 1.96 - 0.98; v = rnd() * 1.96 - 0.98; }
        if (Math.abs(u) < 0.985 && Math.abs(v) < 0.985) sand.add(u, v, 0);
      }
      rebuildCounts();
    },

    pour(u, v, n, k = 0, spread = 0.03) {
      let added = 0;
      for (let c = 0; c < n; c++) {
        const pu = u + gauss() * spread, pv = v + gauss() * spread;
        if (Math.abs(pu) < 0.995 && Math.abs(pv) < 0.995 && sand.add(pu, pv, k)) {
          vx[sand.n - 1] = gauss() * 0.15; vy[sand.n - 1] = gauss() * 0.15; added++;
        }
      }
      return added;
    },

    drop(u, v, n, k = 0, spread = 0.02) { return sand.pour(u, v, n, k, spread); },

    take(u, v, r, n) {
      let taken = 0;
      const r2 = r * r;
      // prefer plain sand
      for (let pass = 0; pass < 2 && taken < n; pass++) {
        for (let i = sand.n - 1; i >= 0 && taken < n; i--) {
          if (pass === 0 && kind[i] !== 0) continue;
          const dx = x[i] - u, dy = y[i] - v;
          if (dx * dx + dy * dy < r2) { sand.removeAt(i); taken++; }
        }
      }
      return taken;
    },

    countNear(u, v, r) {
      const cell = 2 / CG;
      const i0 = Math.max(0, Math.floor((u - r + 1) / cell)), i1 = Math.min(CG - 1, Math.floor((u + r + 1) / cell));
      const j0 = Math.max(0, Math.floor((v - r + 1) / cell)), j1 = Math.min(CG - 1, Math.floor((v + r + 1) / cell));
      let s = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const cu = -1 + (i + 0.5) * cell, cv = -1 + (j + 0.5) * cell;
        if ((cu - u) ** 2 + (cv - v) ** 2 <= (r + cell * 0.5) ** 2) s += counts[j * CG + i];
      }
      return s;
    },

    scatter(u, v, strength = 1) {
      for (let i = 0; i < sand.n; i++) {
        const dx = x[i] - u, dy = y[i] - v;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.25) continue;
        const d = Math.sqrt(d2) + 0.02;
        const k = strength * 0.9 * Math.exp(-d2 / 0.03) / d;
        vx[i] += dx * k + gauss() * 0.25 * strength; vy[i] += dy * k + gauss() * 0.25 * strength;
      }
    },

    update(dt) {
      const A = field.total;
      const Fx = field.Fx, Fy = field.Fy, grid = field.grid;
      const crackNear = field.crackNear;
      const cracks = state?.plate?.cracks || [];
      const hasCracks = cracks.some((c) => !c.healed);
      const damp = Math.exp(-dt * 7.5);
      const drive = 0.0065;       // gradient follow
      const jitScale = 1.0;        // antinode bounce
      const vmax = 0.9;
      let moved = false;
      for (let i = sand.n - 1; i >= 0; i--) {
        let px = x[i], py = y[i];
        let ux = vx[i], uy = vy[i];
        let gx = (px + 1) * 0.5 * G - 0.5, gy = (py + 1) * 0.5 * G - 0.5;
        let i0 = gx | 0, j0 = gy | 0;
        if (i0 < 0) i0 = 0; else if (i0 > G - 2) i0 = G - 2;
        if (j0 < 0) j0 = 0; else if (j0 > G - 2) j0 = G - 2;
        let ax = gx - i0, ay = gy - j0;
        if (ax < 0) ax = 0; else if (ax > 1) ax = 1;
        if (ay < 0) ay = 0; else if (ay > 1) ay = 1;
        const p = j0 * G + i0;
        if (A > 0.015) {
          const mob = kind[i] === 1 ? 0.6 : 1;
          const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
          const f = grid[p] * w00 + grid[p + 1] * w10 + grid[p + G] * w01 + grid[p + G + 1] * w11;
          const gxF = Fx[p] * w00 + Fx[p + 1] * w10 + Fx[p + G] * w01 + Fx[p + G + 1] * w11;
          const gyF = Fy[p] * w00 + Fy[p + 1] * w10 + Fy[p + G] * w01 + Fy[p + G + 1] * w11;
          ux -= gxF * drive * mob * 360 * dt;
          uy -= gyF * drive * mob * 360 * dt;
          const kick = (Math.abs(f) * 1.25 + 0.11 * A) * jitScale * dt * mob;
          ux += gauss() * kick; uy += gauss() * kick;
        }
        ux *= damp; uy *= damp;
        const sp = Math.hypot(ux, uy);
        if (sp > vmax) { ux *= vmax / sp; uy *= vmax / sp; }
        if (sp > 1e-5) moved = true;
        px += ux * dt; py += uy * dt;
        x[i] = px; y[i] = py; vx[i] = ux; vy[i] = uy;
        if (px < -1 || px > 1 || py < -1 || py > 1) {
          sand.removeAt(i); sand.lost++; continue;
        }
        if (hasCracks && crackNear[p]) {
          if (kind[i] === 1) {
            // gold lodges into the crack and gilds it
            let best = null, bd = 1;
            for (const c of cracks) {
              if (c.healed) continue;
              const ns = nearestSegment(px, py, c.pts);
              if (ns.dist < bd) { bd = ns.dist; best = { c, ns }; }
            }
            if (best && bd < 0.02) {
              const g = best.c.gold;
              g[best.ns.index] = Math.min(1, g[best.ns.index] + 0.06);
              if (best.ns.index > 0) g[best.ns.index - 1] = Math.min(1, g[best.ns.index - 1] + 0.02);
              if (best.ns.index < g.length - 1) g[best.ns.index + 1] = Math.min(1, g[best.ns.index + 1] + 0.02);
              sand.removeAt(i); sand.lodged++;
              if (g.every((q) => q >= 1)) { best.c.healed = true; bus?.emit('plate:heal', { crack: cracks.indexOf(best.c) }); }
              continue;
            }
          } else if (rnd() < 0.15 * dt * (A > 0.05 ? 3 : 1)) {
            sand.removeAt(i); sand.drained++; continue;
          }
        }
      }
      rebuildCounts();
      rebuildDensity();
      if (moved) sand.version++;
    },

    peaks(minCount = 22) {
      const out = [];
      for (let j = 1; j < CG - 1; j++) for (let i = 1; i < CG - 1; i++) {
        const c = counts[j * CG + i];
        if (c < 4) continue;
        let s = 0, isMax = true;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const q = counts[(j + dj) * CG + i + di];
          s += q;
          if ((di || dj) && q > c) isMax = false;
        }
        if (isMax && s >= minCount) {
          out.push({ u: -1 + ((i + 0.5) * 2) / CG, v: -1 + ((j + 0.5) * 2) / CG, n: s });
        }
      }
      out.sort((a, b) => b.n - a.n);
      return out.slice(0, 12);
    },

    texture() {
      for (let p = 0, q = 0; p < D * D; p++, q += 4) {
        tex[q] = Math.min(255, density[p] * 255) | 0;
        tex[q + 1] = Math.min(255, gold[p] * 255) | 0;
        tex[q + 2] = 0; tex[q + 3] = 255;
      }
      return tex;
    },

    serialize() {
      const S = 64;
      const a = new Uint8Array(S * S), b = new Uint8Array(S * S);
      for (let i = 0; i < sand.n; i++) {
        const ci = Math.min(S - 1, ((x[i] + 1) * 0.5 * S) | 0), cj = Math.min(S - 1, ((y[i] + 1) * 0.5 * S) | 0);
        const arr = kind[i] === 1 ? b : a;
        if (arr[cj * S + ci] < 255) arr[cj * S + ci]++;
      }
      return { S, n: sand.n, sand: b64(a), gold: b64(b) };
    },

    deserialize(obj) {
      sand.n = 0;
      if (!obj || !obj.sand) return;
      const S = obj.S || 64;
      const a = unb64(obj.sand), b = obj.gold ? unb64(obj.gold) : new Uint8Array(S * S);
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
        for (const [arr, k] of [[a, 0], [b, 1]]) {
          const c = arr[j * S + i];
          for (let q = 0; q < c; q++) {
            sand.add(-1 + ((i + rnd()) * 2) / S, -1 + ((j + rnd()) * 2) / S, k);
          }
        }
      }
      rebuildCounts(); rebuildDensity();
    },
  };

  function rebuildCounts() {
    counts.fill(0);
    for (let i = 0; i < sand.n; i++) {
      const ci = Math.min(CG - 1, Math.max(0, ((x[i] + 1) * 0.5 * CG) | 0));
      const cj = Math.min(CG - 1, Math.max(0, ((y[i] + 1) * 0.5 * CG) | 0));
      counts[cj * CG + ci]++;
    }
  }

  function rebuildDensity() {
    density.fill(0); gold.fill(0);
    for (let i = 0; i < sand.n; i++) {
      const fx = (x[i] + 1) * 0.5 * D - 0.5, fy = (y[i] + 1) * 0.5 * D - 0.5;
      const i0 = fx | 0, j0 = fy | 0;
      if (i0 < 0 || j0 < 0 || i0 >= D - 1 || j0 >= D - 1) continue;
      const ax = fx - i0, ay = fy - j0;
      const arr = kind[i] === 1 ? gold : density;
      const p = j0 * D + i0;
      arr[p] += (1 - ax) * (1 - ay); arr[p + 1] += ax * (1 - ay);
      arr[p + D] += (1 - ax) * ay; arr[p + D + 1] += ax * ay;
    }
    blur(density, 1 / 3.2);
    blur(gold, 1 / 1.6);
  }

  function blur(arr, scale) {
    // separable [1 2 1] blur then normalise
    for (let j = 0; j < D; j++) {
      const row = j * D;
      for (let i = 0; i < D; i++) {
        const l = arr[row + (i > 0 ? i - 1 : i)], r = arr[row + (i < D - 1 ? i + 1 : i)];
        tmp[row + i] = (l + 2 * arr[row + i] + r) * 0.25;
      }
    }
    for (let j = 0; j < D; j++) {
      const up = (j > 0 ? j - 1 : j) * D, dn = (j < D - 1 ? j + 1 : j) * D, row = j * D;
      for (let i = 0; i < D; i++) arr[row + i] = (tmp[up + i] + 2 * tmp[row + i] + tmp[dn + i]) * 0.25 * scale;
    }
  }

  return sand;
}

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 4096) s += String.fromCharCode.apply(null, u8.subarray(i, i + 4096));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export { b64, unb64 };
