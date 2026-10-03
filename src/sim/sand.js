// Sand and gold grains on the plate. Grains seek stillness (nodes) and are kicked at antinodes.
//
// Per step, a grain feels:   (all scaled so a figure forms in a few seconds whatever the mode)
//   drift    −∇F (+ a little −∇Fb, which slides it along a line towards the stillest spots → beads),
//            aimed a hair to one side of the exact node (per grain), so lines pile into ridges
//   bounce   random kicks ∝ |f| (violent at antinodes) plus a faint floor ∝ A
//   pressure −∇density while the plate is vibrating (piles slump into ridges a few px thick)
//   friction strong; on a silent plate overwhelming, so grains freeze where they lie
// A few percent of the finest dust (Faraday's observation) gathers at the antinodes instead and
// trembles there when the plate is loud. Gold is heavier: slower, calmer, and it lodges in cracks.
// On a hushed plate an optional, inaudible "dream" field (setDream) can move the sand very slowly.
// Hot loop: typed arrays only, no allocation; resting grains are stepped every other frame.
import { nearestSegment, createField } from './field.js';

// --- tuning (override per instance with createSand(field, { tuning: {...} })) ---------------------
export const SAND_TUNING = Object.freeze({
  A_SLEEP: 0.02,      // below this amplitude the plate is still: nothing moves
  DRIVE: 26,          // gradient drift (normalised by kEff·A, see update)
  J_ANTI: 0.95,       // bounce ∝ |f|  (velocity kick per √s)
  J_BASE: 0.012,      // bounce floor ∝ A
  PRESS: 0.0018,      // pile pressure (per unit of normalised density gradient)
  GAMMA: 7.5,         // friction while fluidised (1/s)
  GAMMA_STILL: 38,    // extra friction on a silent plate
  VMAX: 0.9,          // speed cap (units/s)
  GOLD_MOB: 0.6,      // gold drifts slower ...
  GOLD_KICK: 0.55,    // ... and bounces less
  DANCER: 8,          // grains with personality < DANCER (≈3%) are fine dust
  EDGE_HOLD: 0.07,    // grains reaching the rim slower than this stay on it
  DRAIN_RATE: 0.15,   // per second, for sand lying in an unhealed crack while it vibrates
  DRAIN_MAX: 30,      // grains per second per unhealed crack (branches share their parent's), at most
  LODGE_D: 0.015,     // gold this close to an unhealed crack lodges
  GILD_LEN: 0.03,     // crack length (units) one lodged gold grain gilds
  GILD_SPREAD: 0.03,  // ... spread along the crack over ± this arc length; what a full stretch cannot
                      // hold runs on along the seam into the nearest gaps
  HEAL_AT: 0.9,       // a crack heals once this share of its length is gilded
  SORT_EVERY: 1.5,    // re-order grains by cell this often (s) for memory locality; 0 = never
  SETTLE_V: 0.02,     // grains slower than this are stepped at half rate (2·dt); 0 = off
  DREAM_RATE: 0.3,    // drift of a dreaming plate relative to a singing one (with heavy friction)
  DREAM_HUSH: 0.08,   // a dreaming plate ignores a real field quieter than this (the sleepers' whisper,
                      // ≤ 0.054 however many sing); a bow, fork, phonograph or tap wakes it
  LINE_W: 0.022,      // ridge body: grains rest where |f| ≲ LINE_W·A beside the node
});

// Deterministic unit-variance gaussian table (Box–Muller from a fixed LCG).
const GAUSS = new Float32Array(4096);
{
  let s = 98765;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  for (let i = 0; i < GAUSS.length; i += 2) {
    const r = Math.sqrt(-2 * Math.log(u())), a = 2 * Math.PI * u();
    GAUSS[i] = r * Math.cos(a); GAUSS[i + 1] = r * Math.sin(a);
  }
}

const finite = (x, d = 0) => (Number.isFinite(x) ? x : d);
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createSand(field, { cap = 26000, D = 256, state = null, bus = null, seed = 1234567, tuning = null } = {}) {
  const T = Object.assign({}, SAND_TUNING, tuning || {});
  const { A_SLEEP, DRIVE, J_ANTI, J_BASE, PRESS, GAMMA, GAMMA_STILL, VMAX, GOLD_MOB, GOLD_KICK, DANCER, EDGE_HOLD,
    DRAIN_RATE, DRAIN_MAX, LODGE_D, GILD_LEN, GILD_SPREAD, HEAL_AT, SORT_EVERY, SETTLE_V, DREAM_RATE, DREAM_HUSH, LINE_W } = T;
  cap = Math.max(1, Math.min(200000, Math.round(finite(cap, 26000))));
  D = Math.max(16, Math.min(1024, Math.round(finite(D, 256))));
  const DD = D * D;
  const x = new Float32Array(cap), y = new Float32Array(cap);
  const vx = new Float32Array(cap), vy = new Float32Array(cap);
  const kind = new Uint8Array(cap);
  const pers = new Uint8Array(cap);              // per-grain personality: mobility, resting offset, fine dust
  const density = new Float32Array(DD), gold = new Float32Array(DD);
  const P = D;                                   // pile pressure grid (same as the density grid)
  const pgrad = new Float32Array(DD * 2);        // interleaved ∂density/∂u, ∂density/∂v per texel
  const tmp = new Float32Array(DD);
  const tex = new Uint8Array(DD * 4);
  for (let q = 3; q < tex.length; q += 4) tex[q] = 255;
  const CG = 48;                                 // coarse count grid
  const counts = new Uint16Array(CG * CG);
  // per coarse cell: smallest field.saddle inside it and where (for crossing-aware peaks)
  const crossQ = new Float32Array(CG * CG), crossU = new Float32Array(CG * CG), crossV = new Float32Array(CG * CG);
  const peakScore = new Float32Array(CG * CG), peakCross = new Float32Array(CG * CG), peakArg = new Int32Array(CG * CG);
  let crossVersion = -1;
  const seg = { index: 0, dist: 0, t: 0 };       // scratch for nearestSegment
  const crackGeo = new WeakMap();                // crack -> { n, len: Float32Array, cum: Float32Array }

  let rs = (seed >>> 0) || 0x2545f491;           // xorshift32 state
  const rnd = () => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; return (rs >>> 0) / 4294967296; };
  const gauss = () => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; return GAUSS[rs >>> 20]; };

  // spatial sort scratch (grains are re-ordered by cell now and then so memory access stays local)
  const SORT_S = 64;
  const sortKey = new Uint16Array(cap), sortIdx = new Uint32Array(cap), sortCnt = new Uint32Array(SORT_S * SORT_S + 1);
  const scratchF = new Float32Array(cap), scratchB = new Uint8Array(cap);
  let sortClock = 0, frame = 0, drainCarry = 0;
  const dream = { field: null, on: false, strength: 1, now: false, time: 0 };

  let dirty = true;          // grain set changed since grids were built
  let asleep = false;        // nothing is moving: update can skip the grain loop
  let gridVersion = 0, texVersion = -1;

  const sand = {
    cap, D, CG, x, y, vx, vy, kind, pers, density, gold, counts, n: 0, tuning: T,
    lost: 0, drained: 0, lodged: 0, version: 0, goldCount: 0,
    get gridVersion() { return gridVersion; },
    get asleep() { return asleep; },

    add(u, v, k = 0) {
      if (sand.n >= cap || !Number.isFinite(u) || !Number.isFinite(v)) return false;
      const i = sand.n++;
      x[i] = Math.max(-0.9995, Math.min(0.9995, u)); y[i] = Math.max(-0.9995, Math.min(0.9995, v));
      vx[i] = 0; vy[i] = 0; kind[i] = k === 1 ? 1 : 0;
      pers[i] = (rnd() * 256) | 0;
      if (kind[i]) sand.goldCount++;
      dirty = true;
      return true;
    },

    removeAt(i) {
      if (i < 0 || i >= sand.n) return;
      if (kind[i]) sand.goldCount--;
      const last = --sand.n;
      if (i !== last) {
        x[i] = x[last]; y[i] = y[last]; vx[i] = vx[last]; vy[i] = vy[last]; kind[i] = kind[last]; pers[i] = pers[last];
      }
      dirty = true;
    },

    clear() { sand.n = 0; sand.goldCount = 0; dirty = true; rebuildGrids(); },

    // The plate dreams: while the plate itself is hushed (quieter than DREAM_HUSH: silent, or only the
    // sleepers' whisper), sand very slowly drifts into the figure of `comps` ([{mode, amp}], e.g. extinct
    // species' modes). Inaudible and invisible to the field; a strength of 1 forms a figure in roughly
    // a minute. null / [] wakes the plate from its dream.
    setDream(comps, strength = 1) {
      const list = Array.isArray(comps) ? comps.filter((c) => c && c.mode && +c.amp > 0) : [];
      if (!list.length) { dream.on = false; dream.now = false; dream.time = 0; dream.field?.setSource('dream', []); return; }
      if (!dream.field) dream.field = createField({ G: 96 });
      dream.field.setSource('dream', list.map((c) => ({ mode: c.mode, amp: Math.min(1.2, +c.amp) })));
      dream.strength = Math.max(0, Math.min(4, finite(+strength, 1)));
      dream.on = true;
      asleep = false;
    },
    // true while the dream is what moves the sand (set, the real plate hushed, grains moving)
    get dreaming() { return dream.on && dream.now; },
    // seconds the dream has actually moved the sand since it was set (0 once it ends)
    get dreamTime() { return dream.on ? dream.time : 0; },

    // initial dusting: uniform, gently uneven (low-frequency noise) with a few small clumps
    seedScatter(count) {
      count = Math.max(0, Math.round(finite(count)));
      const o1 = rnd() * 50, o2 = rnd() * 50;
      for (let c = 0, tries = 0; c < count && tries < count * 4; tries++) {
        let u, v;
        if (rnd() < 0.12) {
          const cu = rnd() * 1.8 - 0.9, cv = rnd() * 1.8 - 0.9;
          u = cu + gauss() * 0.04; v = cv + gauss() * 0.04;
        } else {
          u = rnd() * 1.96 - 0.98; v = rnd() * 1.96 - 0.98;
          const nz = valueNoise(u * 2.2 + o1, v * 2.2 + o2) * 0.6 + valueNoise(u * 5.1 + o2, v * 5.1 + o1) * 0.4;
          if (rnd() > 0.55 + 0.45 * nz) continue;
        }
        if (Math.abs(u) < 0.985 && Math.abs(v) < 0.985) { if (sand.add(u, v, 0)) c++; else break; }
      }
      asleep = false;
      rebuildGrids();
    },

    pour(u, v, n, k = 0, spread = 0.03) {
      u = finite(u, NaN); v = finite(v, NaN);
      if (!Number.isFinite(u) || !Number.isFinite(v)) return 0;
      n = Math.max(0, Math.min(cap, Math.round(finite(n))));
      spread = Math.max(0, Math.min(1, finite(spread, 0.03)));
      let added = 0;
      for (let c = 0; c < n; c++) {
        const pu = u + gauss() * spread, pv = v + gauss() * spread;
        if (Math.abs(pu) < 0.995 && Math.abs(pv) < 0.995 && sand.add(pu, pv, k)) {
          vx[sand.n - 1] = gauss() * 0.12; vy[sand.n - 1] = gauss() * 0.12; added++;
        }
      }
      if (added) asleep = false;
      return added;
    },

    drop(u, v, n, k = 0, spread = 0.02) { return sand.pour(u, v, n, k, spread); },

    // remove up to n grains within r of (u,v), plain sand first
    take(u, v, r, n) {
      if (!Number.isFinite(u) || !Number.isFinite(v)) return 0;
      n = Math.max(0, Math.round(finite(n)));
      const r2 = Math.max(0, finite(r)) ** 2;
      let taken = 0;
      for (let pass = 0; pass < 2 && taken < n; pass++) {
        for (let i = sand.n - 1; i >= 0 && taken < n; i--) {
          if (pass === 0 && kind[i] !== 0) continue;
          const dx = x[i] - u, dy = y[i] - v;
          if (dx * dx + dy * dy < r2) { sand.removeAt(i); taken++; }
        }
      }
      if (taken) rebuildGrids();
      return taken;
    },

    countNear(u, v, r) {
      if (!Number.isFinite(u) || !Number.isFinite(v) || !(r > 0)) return 0;
      if (dirty) rebuildGrids();
      const cell = 2 / CG;
      const i0 = Math.max(0, Math.floor((u - r + 1) / cell)), i1 = Math.min(CG - 1, Math.floor((u + r + 1) / cell));
      const j0 = Math.max(0, Math.floor((v - r + 1) / cell)), j1 = Math.min(CG - 1, Math.floor((v + r + 1) / cell));
      const rr = (r + cell * 0.5) ** 2;
      let s = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const du = -1 + (i + 0.5) * cell - u, dv = -1 + (j + 0.5) * cell - v;
        if (du * du + dv * dv <= rr) s += counts[j * CG + i];
      }
      return s;
    },

    // radial kick (a tap)
    scatter(u, v, strength = 1) {
      if (!Number.isFinite(u) || !Number.isFinite(v)) return;
      strength = Math.max(0, Math.min(4, finite(strength, 1)));
      for (let i = 0; i < sand.n; i++) {
        const dx = x[i] - u, dy = y[i] - v;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.25) continue;
        const d = Math.sqrt(d2) + 0.02;
        const k = (strength * 0.9 * Math.exp(-d2 / 0.03)) / d * (kind[i] ? GOLD_KICK : 1);
        vx[i] += dx * k + gauss() * 0.25 * strength; vy[i] += dy * k + gauss() * 0.25 * strength;
      }
      asleep = false;
    },

    update(dt) {
      dt = dt > 0 ? Math.min(dt, 0.1) : 0;
      if (!dt || !sand.n) { if (dirty) rebuildGrids(); return; }
      let A = +field.total;
      A = A > 0 ? (A < 2 ? A : 2) : 0;
      const vib = A > A_SLEEP;
      // dreaming: while the real plate is hushed (silent, or the sleepers' whisper), an optional ghost
      // field (setDream) moves the sand very slowly instead
      let dreaming = false;
      if (dream.field && dream.on) { dream.field.update(dt); dreaming = A < DREAM_HUSH && dream.field.total > A_SLEEP; }
      dream.now = dreaming;
      const active = vib || dreaming;
      if (!active && asleep) { if (dirty) rebuildGrids(); return; }

      const src = dreaming ? dream.field : field;
      const G = src.G, G4 = G * 4, pack = src.pack;
      const Ad = dreaming ? Math.min(2, src.total) : A;
      const fluid = dreaming ? 0 : smooth(A_SLEEP, 0.14, A);   // a dream moves the sand on a still plate
      const kEff = Math.max(2, finite(src.kEff, 20));
      const drive = active ? ((DRIVE * dt) / (kEff * Math.max(Ad, 0.15))) * (dreaming ? DREAM_RATE * dream.strength : 1) : 0;
      const sq = Math.sqrt(dt) * (dreaming ? 0.06 : 1);
      const kickBaseA = J_BASE * Ad * (dreaming ? 2 : 1);
      const press = PRESS * fluid * dt * (P / 2);
      const damp = Math.exp(-dt * (GAMMA + GAMMA_STILL * (1 - fluid)));
      // settled grains (barely moving, i.e. resting on a line) are stepped every other frame with 2·dt
      const parity = (frame++) & 1, settle2 = active ? SETTLE_V * SETTLE_V : -1;
      const dt2 = 2 * dt, drive2 = 2 * drive, sq2 = Math.SQRT2 * sq, press2 = 2 * press, damp2 = damp * damp;
      // fine dust turns towards the antinodes when loud (not under the floor: that sweeps the plate bare)
      const floorAmp = field.amp ? +field.amp('floor') || 0 : 0;
      const dance = smooth(0.65, 1.05, A) * (1 - Math.min(1, (floorAmp * floorAmp) / (A * A + 1e-6)));
      const halfG = 0.5 * G, halfP = 0.5 * P;
      const lineW2 = 4 * LINE_W * Ad;      // ∇(f − eA)² = ∇F − 2eA∇f, with e ∈ ±LINE_W
      const vmax2 = VMAX * VMAX;

      const cracks = state?.plate?.cracks;
      const crackIdx = field.crackIdx, crackNear = field.crackNear;
      const FG = field.G, halfF = 0.5 * FG;    // crack grids live on the real field's grid (not a dream's)
      let unhealed = 0, unhealedMain = 0;
      if (cracks && crackIdx) for (let c = 0; c < cracks.length; c++) {
        const cr = cracks[c];
        if (cr && !cr.healed) { unhealed++; if (cr.branchOf === undefined || cr.branchOf === null) unhealedMain++; }
      }
      const doCracks = vib && unhealed > 0;
      let drainBudget = DRAIN_MAX * Math.max(1, unhealedMain) * dt + drainCarry;
      const drainP = DRAIN_RATE * dt * (0.5 + fluid);

      let s = rs, maxSp2 = 0, changed = false;
      for (let i = sand.n - 1; i >= 0; i--) {
        let ux = vx[i], uy = vy[i];
        let h = dt, hDrive = drive, hSq = sq, hPress = press, hDamp = damp;
        if (ux * ux + uy * uy < settle2) {
          if ((i & 1) !== parity) continue;
          h = dt2; hDrive = drive2; hSq = sq2; hPress = press2; hDamp = damp2;
        }
        let px = x[i], py = y[i];
        if (active) {
          // field (bilinear on the interleaved pack: f, Gx, Gy, Fb)
          let gx = (px + 1) * halfG - 0.5, gy = (py + 1) * halfG - 0.5;
          let i0 = gx | 0, j0 = gy | 0;
          if (gx < 0) { i0 = 0; gx = 0; } else if (i0 > G - 2) { i0 = G - 2; if (gx > G - 1) gx = G - 1; }
          if (gy < 0) { j0 = 0; gy = 0; } else if (j0 > G - 2) { j0 = G - 2; if (gy > G - 1) gy = G - 1; }
          const ax = gx - i0, ay = gy - j0;
          const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
          const q = (j0 * G + i0) * 4;
          const f00 = pack[q], f10 = pack[q + 4], f01 = pack[q + G4], f11 = pack[q + G4 + 4];
          const f = f00 * w00 + f10 * w10 + f01 * w01 + f11 * w11;
          const gxF = pack[q + 1] * w00 + pack[q + 5] * w10 + pack[q + G4 + 1] * w01 + pack[q + G4 + 5] * w11;
          const gyF = pack[q + 2] * w00 + pack[q + 6] * w10 + pack[q + G4 + 2] * w01 + pack[q + G4 + 6] * w11;

          const k = kind[i], ps = pers[i];
          const mob = k ? GOLD_MOB : 0.8 + ps * 0.0016;
          let dir = 1, kick = (J_ANTI * (f < 0 ? -f : f) + kickBaseA) * hSq * (k ? GOLD_KICK : 1);
          if (ps < DANCER && k === 0 && dance > 0) { dir = 1 - 2.2 * dance; kick *= 1 + 0.8 * dance; }
          const dr = hDrive * mob * dir;
          // each grain rests a little to one side of the exact node (target f = e·A, e from its
          // personality, triangular in ±LINE_W): sand piles into ridges with a body, not hairlines
          const e = (((ps & 15) + (ps >> 4)) * (1 / 30) - 0.5) * lineW2;
          const dfu = ((1 - ay) * (f10 - f00) + ay * (f11 - f01)) * halfG;
          const dfv = ((1 - ax) * (f01 - f00) + ax * (f11 - f10)) * halfG;
          ux -= (gxF - e * dfu) * dr; uy -= (gyF - e * dfv) * dr;

          // pressure: piles slump down the density gradient while fluidised
          if (hPress > 0) {
            let dx = (px + 1) * halfP - 0.5, dy = (py + 1) * halfP - 0.5;
            let di = dx | 0, dj = dy | 0;
            if (dx < 0) { di = 0; dx = 0; } else if (di > P - 2) { di = P - 2; if (dx > P - 1) dx = P - 1; }
            if (dy < 0) { dj = 0; dy = 0; } else if (dj > P - 2) { dj = P - 2; if (dy > P - 1) dy = P - 1; }
            const bx = dx - di, by = dy - dj;
            const e00 = (1 - bx) * (1 - by), e10 = bx * (1 - by), e01 = (1 - bx) * by, e11 = bx * by;
            const p = (dj * P + di) * 2, D2 = P * 2;
            const pm = hPress * (k ? GOLD_MOB : 1);
            ux -= (pgrad[p] * e00 + pgrad[p + 2] * e10 + pgrad[p + D2] * e01 + pgrad[p + D2 + 2] * e11) * pm;
            uy -= (pgrad[p + 1] * e00 + pgrad[p + 3] * e10 + pgrad[p + D2 + 1] * e01 + pgrad[p + D2 + 3] * e11) * pm;
          }

          s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
          ux += GAUSS[s >>> 20] * kick;
          uy += GAUSS[(s >>> 8) & 4095] * kick;
        }
        ux *= hDamp; uy *= hDamp;
        let sp2 = ux * ux + uy * uy;
        if (sp2 > vmax2) { const sc = VMAX / Math.sqrt(sp2); ux *= sc; uy *= sc; sp2 = vmax2; }
        else if (!active && sp2 < 1e-10) { ux = 0; uy = 0; sp2 = 0; }
        if (sp2 > maxSp2) maxSp2 = sp2;
        if (sp2 > 0) changed = true;
        px += ux * h; py += uy * h;

        // the rim: slow grains stay on the plate, fast ones fly off into the dark
        if (!(px >= -1 && px <= 1 && py >= -1 && py <= 1)) {        // (also catches NaN)
          const outU = px < -1 ? -ux : px > 1 ? ux : 0, outV = py < -1 ? -uy : py > 1 ? uy : 0;
          if (outU > EDGE_HOLD || outV > EDGE_HOLD || !Number.isFinite(px) || !Number.isFinite(py)) {
            sand.removeAt(i); sand.lost++; continue;
          }
          if (px < -1) { px = -0.9995; ux = 0; } else if (px > 1) { px = 0.9995; ux = 0; }
          if (py < -1) { py = -0.9995; uy = 0; } else if (py > 1) { py = 0.9995; uy = 0; }
        }
        x[i] = px; y[i] = py; vx[i] = ux; vy[i] = uy;

        if (doCracks) {
          let ci = ((px + 1) * halfF) | 0, cj = ((py + 1) * halfF) | 0;
          if (ci > FG - 1) ci = FG - 1; if (cj > FG - 1) cj = FG - 1;
          const c = cj * FG + ci;
          if (kind[i] === 1) {
            const idx = crackIdx[c];
            if (idx >= 0 && lodge(i, idx, px, py)) continue;
          } else if (crackNear[c] && drainBudget >= 1) {
            s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
            if ((s >>> 0) / 4294967296 < drainP) { sand.removeAt(i); sand.drained++; drainBudget--; continue; }
          }
        }
      }
      rs = s;
      drainCarry = doCracks ? Math.min(1, drainBudget) : 0;   // fractional budget carries over
      if (dreaming && changed) dream.time += dt;
      asleep = !active && maxSp2 < 1e-8;
      if (active && SORT_EVERY > 0 && (sortClock += dt) > SORT_EVERY) { sortClock = 0; spatialSort(); }
      if (changed) dirty = true;
      if (dirty) rebuildGrids();
    },

    // Birth sites, at most 12, best first, at least 0.09 apart: [{u, v, n, score, cross}]. n is the grain count in the
    // 3×3 block of the 48×48 count grid (≥ minCount). The score favours real nodal crossings (where the
    // field and its gradient both vanish) over plain stretches of line, and the interior over the rim;
    // at a crossing u,v sits exactly on it, otherwise on the block's count centroid.
    peaks(minCount = 22) {
      if (dirty) rebuildGrids();
      minCount = finite(minCount, 22);
      updateCrossMap();
      const A = Math.max(0, finite(field.total));
      const norm = A > 0.02 ? 1 / (A * A * Math.max(2, finite(field.kEff, 20))) : 0;
      const cell = 2 / CG;
      peakScore.fill(0);
      for (let j = 1; j < CG - 1; j++) for (let i = 1; i < CG - 1; i++) {
        const idx = j * CG + i;
        let s = 0, qmin = Infinity, qi = idx;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const ni = idx + dj * CG + di;
          s += counts[ni];
          if (crossQ[ni] < qmin) { qmin = crossQ[ni]; qi = ni; }
        }
        if (s < minCount) continue;
        const gn2 = qmin * norm;                       // (|∇f| / (A·√k))² at the stillest point
        const cross = Math.exp(-gn2 / 0.0625);         // ≈1 at a crossing, ≈0 on a plain line
        const cu = -1 + (i + 0.5) * cell, cv = -1 + (j + 0.5) * cell;
        const rim = 0.4 + 0.6 * smooth(0.97, 0.8, Math.max(Math.abs(cu), Math.abs(cv)));
        peakScore[idx] = s * (0.2 + 0.8 * cross) * rim;
        peakCross[idx] = cross; peakArg[idx] = qi;
      }
      const out = [];
      for (let j = 1; j < CG - 1; j++) for (let i = 1; i < CG - 1; i++) {
        const idx = j * CG + i, sc = peakScore[idx];
        if (sc <= 0) continue;
        let isMax = true;
        for (let dj = -1; dj <= 1 && isMax; dj++) for (let di = -1; di <= 1; di++) {
          const ni = idx + dj * CG + di;
          if ((di || dj) && (peakScore[ni] > sc || (peakScore[ni] === sc && ni < idx))) { isMax = false; break; }
        }
        if (!isMax) continue;
        let s = 0, su = 0, sv = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const q = counts[idx + dj * CG + di]; s += q; su += q * di; sv += q * dj;
        }
        const cross = peakCross[idx];
        let u = -1 + (i + 0.5 + su / s) * cell, v = -1 + (j + 0.5 + sv / s) * cell;
        if (cross > 0.5) { u = crossU[peakArg[idx]]; v = crossV[peakArg[idx]]; }
        out.push({ u, v, n: s, score: sc, cross });
      }
      out.sort((a, b) => b.score - a.score);
      // one site per crossing: drop candidates that snapped next to a better one
      const kept = [];
      for (const p of out) {
        let near = false;
        for (const k of kept) if ((k.u - p.u) ** 2 + (k.v - p.v) ** 2 < 0.0081) { near = true; break; }
        if (!near) kept.push(p);
        if (kept.length >= 12) break;
      }
      return kept;
    },

    // RGBA: R sand density, G gold density (0..255), B 0, A 255. Rebuilt only when grains changed.
    texture() {
      if (dirty) rebuildGrids();
      if (texVersion === gridVersion) return tex;
      texVersion = gridVersion;
      for (let p = 0, q = 0; p < DD; p++, q += 4) {
        const d = density[p] * 255, g = gold[p] * 255;
        tex[q] = d < 255 ? d : 255;
        tex[q + 1] = g < 255 ? g : 255;
      }
      return tex;
    },

    // Compact snapshot: 128×128 counts per kind as a nibble stream (see encodeCounts), < 20 KB.
    serialize() {
      const S = 128;
      const a = new Uint16Array(S * S), b = new Uint16Array(S * S);
      for (let i = 0; i < sand.n; i++) {
        const ci = Math.max(0, Math.min(S - 1, ((x[i] + 1) * 0.5 * S) | 0));
        const cj = Math.max(0, Math.min(S - 1, ((y[i] + 1) * 0.5 * S) | 0));
        const arr = kind[i] === 1 ? b : a;
        if (arr[cj * S + ci] < 65535) arr[cj * S + ci]++;
      }
      return { v: 2, S, n: sand.n, sand: encodeCounts(a), gold: encodeCounts(b) };
    },

    // Regenerate grains from a snapshot (new or the original 64×64 byte format). Grains are placed
    // with a bilinear (not blocky) distribution so figures survive the round trip softly.
    // Returns the number of grains restored. A malformed snapshot gives a fresh dusting.
    deserialize(obj) {
      sand.n = 0; sand.goldCount = 0; dirty = true;
      if (!obj || typeof obj !== 'object' || typeof obj.sand !== 'string') { rebuildGrids(); return 0; }
      let a, b, S;
      try {
        if (obj.v === 2) {
          S = Math.max(8, Math.min(512, obj.S | 0));
          a = decodeCounts(obj.sand, S * S);
          b = typeof obj.gold === 'string' ? decodeCounts(obj.gold, S * S) : new Uint16Array(S * S);
        } else {
          S = Math.max(8, Math.min(512, obj.S | 0 || 64));
          a = Uint16Array.from(unb64(obj.sand).subarray(0, S * S));
          b = obj.gold ? Uint16Array.from(unb64(obj.gold).subarray(0, S * S)) : new Uint16Array(S * S);
          if (a.length < S * S) throw new Error('short snapshot');
        }
      } catch {
        sand.seedScatter(15000);
        return sand.n;
      }
      placeFromCounts(a, S, 0);
      placeFromCounts(b, S, 1);
      asleep = true;
      rebuildGrids();
      return sand.n;
    },
  };

  // Place counts[c] grains in each cell, with a linear ramp towards the neighbours in u and v.
  function placeFromCounts(arr, S, k) {
    const cell = 2 / S;
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const c = arr[j * S + i];
      if (!c) continue;
      const l = arr[j * S + Math.max(0, i - 1)], r = arr[j * S + Math.min(S - 1, i + 1)];
      const t = arr[Math.max(0, j - 1) * S + i], b = arr[Math.min(S - 1, j + 1) * S + i];
      const a0 = (c + l) * 0.5, a1 = (c + r) * 0.5, b0 = (c + t) * 0.5, b1 = (c + b) * 0.5;
      for (let q = 0; q < c; q++) {
        const fu = rampSample(a0, a1, rnd()), fv = rampSample(b0, b1, rnd());
        if (!sand.add(-1 + (i + fu) * cell, -1 + (j + fv) * cell, k)) return;
      }
    }
  }

  // Gold lodges into crack `ci` near (px,py): it gilds GILD_LEN of crack length, spread over
  // ±GILD_SPREAD of arc length; what full segments cannot take flows on along the crack into the
  // nearest unfilled segments either way (molten gold finds the gaps, the rim end included).
  // The crack heals once HEAL_AT of its length is gilded.
  function lodge(i, ci, px, py) {
    const crack = state?.plate?.cracks?.[ci];
    if (!crack || crack.healed || !crack.pts || crack.pts.length < 2) return false;
    nearestSegment(px, py, crack.pts, seg);
    if (seg.dist > LODGE_D) return false;
    const geo = geometry(crack);
    const g = crack.gold, len = geo.len, cum = geo.cum, n = geo.n;
    const s0 = cum[seg.index] + seg.t * len[seg.index];
    const mid = (k) => cum[k] + len[k] * 0.5;
    // add `amt` (crack length) to segment k; returns what it could not hold
    const fill = (k, amt) => {
      const room = (1 - (g[k] || 0)) * len[k];
      if (amt < room) { g[k] = (g[k] || 0) + amt / len[k]; return 0; }
      g[k] = 1;
      return amt - Math.max(0, room);
    };
    // triangular weights at segment midpoints within the spread
    let wsum = 0;
    let lo = seg.index, hi = seg.index;
    while (lo > 0 && s0 - cum[lo] < GILD_SPREAD) lo--;
    while (hi < n - 1 && cum[hi + 1] - s0 < GILD_SPREAD) hi++;
    for (let k = lo; k <= hi; k++) wsum += Math.max(0.05, 1 - Math.abs(mid(k) - s0) / GILD_SPREAD) * len[k];
    let spill = wsum > 0 ? 0 : GILD_LEN;
    if (wsum > 0) for (let k = lo; k <= hi; k++) {
      spill += fill(k, (GILD_LEN * Math.max(0.05, 1 - Math.abs(mid(k) - s0) / GILD_SPREAD) * len[k]) / wsum);
    }
    // the overflow runs along the seam, nearest segments first, in both directions
    for (let l = seg.index, r = seg.index + 1; spill > 1e-7 && (l >= 0 || r < n);) {
      const k = r >= n || (l >= 0 && s0 - mid(l) <= mid(r) - s0) ? l-- : r++;
      if (!(g[k] >= 1)) spill = fill(k, spill);
    }
    sand.removeAt(i);
    sand.lodged++;
    let gilt = 0;
    for (let k = 0; k < n; k++) gilt += Math.min(1, g[k] || 0) * len[k];
    if (gilt >= HEAL_AT * cum[n] - 1e-9) {
      for (let k = 0; k < g.length; k++) g[k] = 1;
      crack.healed = true;
      bus?.emit('plate:heal', { crack: ci });
    }
    return true;
  }

  function geometry(crack) {
    let geo = crackGeo.get(crack);
    const pts = crack.pts, n = Math.max(1, pts.length - 1);
    if (geo && geo.n === n && geo.pts === pts) return geo;
    const len = new Float32Array(n), cum = new Float32Array(n + 1);
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[k + 1] || a;
      len[k] = Math.hypot(b[0] - a[0], b[1] - a[1]);
      cum[k + 1] = cum[k] + len[k];
    }
    geo = { n, len, cum, pts };
    crackGeo.set(crack, geo);
    return geo;
  }

  function updateCrossMap() {
    const sad = field.saddle, G = field.G;
    if (!sad || crossVersion === field.version) { if (!sad) crossQ.fill(0); return; }
    crossVersion = field.version;
    crossQ.fill(Infinity);
    for (let j = 0; j < G; j++) {
      const cj = Math.min(CG - 1, (((j + 0.5) / G) * CG) | 0), v = ((j + 0.5) / G) * 2 - 1;
      for (let i = 0; i < G; i++) {
        const ci = Math.min(CG - 1, (((i + 0.5) / G) * CG) | 0), c = cj * CG + ci, q = sad[j * G + i];
        if (q < crossQ[c]) { crossQ[c] = q; crossU[c] = ((i + 0.5) / G) * 2 - 1; crossV[c] = v; }
      }
    }
  }

  // counting sort of all grains by 64×64 cell (row-major); O(n), a fraction of a millisecond
  function spatialSort() {
    const n = sand.n, S = SORT_S;
    if (n < 2) return;
    sortCnt.fill(0);
    for (let i = 0; i < n; i++) {
      let ci = ((x[i] + 1) * 0.5 * S) | 0, cj = ((y[i] + 1) * 0.5 * S) | 0;
      ci = ci < 0 ? 0 : ci > S - 1 ? S - 1 : ci; cj = cj < 0 ? 0 : cj > S - 1 ? S - 1 : cj;
      const c = cj * S + ci;
      sortKey[i] = c; sortCnt[c + 1]++;
    }
    for (let c = 0; c < S * S; c++) sortCnt[c + 1] += sortCnt[c];
    for (let i = 0; i < n; i++) sortIdx[sortCnt[sortKey[i]]++] = i;
    for (const arr of [x, y, vx, vy]) {
      for (let i = 0; i < n; i++) scratchF[i] = arr[sortIdx[i]];
      arr.set(scratchF.subarray(0, n));
    }
    for (const arr of [kind, pers]) {
      for (let i = 0; i < n; i++) scratchB[i] = arr[sortIdx[i]];
      arr.set(scratchB.subarray(0, n));
    }
  }

  let goldDirty = true, pressureReady = false;
  function rebuildGrids() {
    counts.fill(0); density.fill(0);
    if (goldDirty || sand.goldCount) { gold.fill(0); goldDirty = false; }
    let goldN = 0;
    const halfD = 0.5 * D;
    for (let i = 0; i < sand.n; i++) {
      const px = x[i], py = y[i];
      let ci = ((px + 1) * 0.5 * CG) | 0, cj = ((py + 1) * 0.5 * CG) | 0;
      ci = ci < 0 ? 0 : ci > CG - 1 ? CG - 1 : ci;
      cj = cj < 0 ? 0 : cj > CG - 1 ? CG - 1 : cj;
      counts[cj * CG + ci]++;
      let fx = (px + 1) * halfD - 0.5, fy = (py + 1) * halfD - 0.5;
      let i0 = fx | 0, j0 = fy | 0;
      if (fx < 0) { i0 = 0; fx = 0; } else if (i0 > D - 2) { i0 = D - 2; if (fx > D - 1) fx = D - 1; }
      if (fy < 0) { j0 = 0; fy = 0; } else if (j0 > D - 2) { j0 = D - 2; if (fy > D - 1) fy = D - 1; }
      const ax = fx - i0, ay = fy - j0;
      const arr = kind[i] === 1 ? gold : density;
      if (kind[i] === 1) goldN++;
      const p = j0 * D + i0;
      arr[p] += (1 - ax) * (1 - ay); arr[p + 1] += ax * (1 - ay);
      arr[p + D] += (1 - ax) * ay; arr[p + D + 1] += ax * ay;
    }
    sand.goldCount = goldN;
    blur(density, 1 / 3.2);
    if (goldN) { blur(gold, 1 / 1.6); goldDirty = true; }
    // pile pressure changes slowly: refresh its gradient every other rebuild
    if ((gridVersion & 1) === 0 || !pressureReady) { densityGradient(); pressureReady = true; }
    dirty = false;
    gridVersion++;
    sand.version++;
  }

  function blur(arr, scale) {
    // separable [1 2 1] blur (edges clamped), then normalise
    const L = D - 1;
    for (let j = 0; j < D; j++) {
      const row = j * D;
      tmp[row] = (3 * arr[row] + arr[row + 1]) * 0.25;
      for (let i = row + 1, e = row + L; i < e; i++) tmp[i] = (arr[i - 1] + 2 * arr[i] + arr[i + 1]) * 0.25;
      tmp[row + L] = (arr[row + L - 1] + 3 * arr[row + L]) * 0.25;
    }
    const k = 0.25 * scale;
    for (let i = 0; i < D; i++) arr[i] = (3 * tmp[i] + tmp[i + D]) * k;
    for (let p = D, e = D * L; p < e; p++) arr[p] = (tmp[p - D] + 2 * tmp[p] + tmp[p + D]) * k;
    for (let i = D * L; i < DD; i++) arr[i] = (tmp[i - D] + 3 * tmp[i]) * k;
  }

  // pile pressure field: central-difference gradient of the sand density (density units per texel)
  function densityGradient() {
    const L = D - 1;
    for (let j = 0; j < D; j++) {
      const row = j * D;
      const up = j > 0 ? row - D : row, dn = j < L ? row + D : row, sy = j > 0 && j < L ? 0.5 : 1;
      let q = row * 2;
      pgrad[q] = density[row + 1] - density[row];
      pgrad[q + 1] = (density[dn] - density[up]) * sy;
      for (let i = 1; i < L; i++) {
        q += 2;
        pgrad[q] = (density[row + i + 1] - density[row + i - 1]) * 0.5;
        pgrad[q + 1] = (density[dn + i] - density[up + i]) * sy;
      }
      q += 2;
      pgrad[q] = density[row + L] - density[row + L - 1];
      pgrad[q + 1] = (density[dn + L] - density[up + L]) * sy;
    }
  }

  return sand;
}

// Inverse CDF of a linear density on [0,1] going from a0 to a1.
function rampSample(a0, a1, r) {
  const d = a1 - a0;
  if (Math.abs(d) < 1e-6 * (a0 + a1 + 1e-9)) return r;
  const t = (-a0 + Math.sqrt(Math.max(0, a0 * a0 + d * (a0 + a1) * r))) / d;
  return t > 0 ? (t < 1 ? t : 0.999) : 0;
}

// cheap smooth 2D value noise in [0,1] (seedScatter only)
function valueNoise(px, py) {
  const i = Math.floor(px), j = Math.floor(py), fx = px - i, fy = py - j;
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

// Count grids as a nibble stream:  1..12 literal · 0 r: run of r+1 empty cells (1..16)
// · 13 b b: 13..268 · 14 b b b b: 269..65804. High nibble first, then base64.
export function encodeCounts(arr) {
  const nib = [];
  for (let i = 0; i < arr.length;) {
    const c = arr[i];
    if (c === 0) {
      let r = 1;
      while (r < 16 && i + r < arr.length && arr[i + r] === 0) r++;
      nib.push(0, r - 1); i += r; continue;
    }
    if (c <= 12) nib.push(c);
    else if (c <= 268) { const b = c - 13; nib.push(13, b >> 4, b & 15); }
    else { const b = Math.min(65535, c - 269); nib.push(14, (b >> 12) & 15, (b >> 8) & 15, (b >> 4) & 15, b & 15); }
    i++;
  }
  if (nib.length & 1) nib.push(15);              // padding
  const bytes = new Uint8Array(nib.length >> 1);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (nib[2 * i] << 4) | nib[2 * i + 1];
  return b64(bytes);
}

export function decodeCounts(str, len) {
  const bytes = unb64(str);
  const out = new Uint16Array(len);
  const N = bytes.length * 2;
  const nibAt = (k) => (k & 1 ? bytes[k >> 1] & 15 : bytes[k >> 1] >> 4);
  let k = 0, i = 0;
  while (i < len && k < N) {
    const c = nibAt(k++);
    if (c === 0) { i += nibAt(k++) + 1; continue; }
    if (c <= 12) out[i++] = c;
    else if (c === 13) { out[i++] = 13 + ((nibAt(k) << 4) | nibAt(k + 1)); k += 2; }
    else if (c === 14) { out[i++] = 269 + ((nibAt(k) << 12) | (nibAt(k + 1) << 8) | (nibAt(k + 2) << 4) | nibAt(k + 3)); k += 4; }
    else break;                                  // padding
  }
  return out;
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
