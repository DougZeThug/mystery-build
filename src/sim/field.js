// The plate's vibration: modal amplitudes driven by sources, and the resulting field on a grid.
//
// f(u,v) = Σ amp_i · M_i(u,v) is evaluated on a G×G grid. Every regular mode is a sum of products
// cos(pπx)·cos(qπy) with p,q ∈ 0..7, so the whole superposition collapses into an 8×8 coefficient
// matrix and the grid costs at most 8·G² multiply-adds however many modes are sounding.
// F = f² is the local violence (normalised so one mode at amp 1 peaks at 1). Sand descends ∇F.
// Fb is F blurred over ~0.035 units: low where the whole neighbourhood is still; a little of its
// gradient slides sand along the lines into beads. saddle = (f/h)² + |∇f|² vanishes only where nodal
// lines cross (birth sites). The grid is rebuilt only when amplitudes move by ~1% of the total.
import { MODES, modeById, evalMode } from './modes.js';

const PI = Math.PI;
const NM = MODES.length;

const ATTACK = 0.35, RELEASE = 1.4;   // amplitude time constants (s)
const AMP_MAX = 1.6;
const EPS_AMP = 0.003;                // modes below this do not shape the grid
const BEAD = 0.25;                    // weight of ∇Fb in the sand drive (pulls grains along lines to crossings)
const BLUR_R = 3;                     // box radius (cells) for Fb, applied twice
const CRACK_DRAIN_D = 0.014;          // grains this close to an unhealed crack can fall through
const CRACK_LODGE_D = 0.02;           // gold this close is looked up for lodging
const MAX_CRACKS = 7;                 // main cracks (branches do not count)

const finite = (x, d = 0) => (Number.isFinite(x) ? x : d);

export function createField({ G = 160, state = null, bus = null, rng = Math.random, bead = BEAD } = {}) {
  G = Math.max(32, Math.min(512, Math.round(finite(G, 160))));
  const GG = G * G;
  const amps = new Float32Array(NM);      // smoothed driven amplitudes
  const targets = new Float32Array(NM);
  const impulses = new Float32Array(NM);  // transient amplitudes (taps)
  const eff = new Float32Array(NM);       // amps + impulses (what the plate is doing)
  const lastEff = new Float32Array(NM);   // eff when the grid was last built
  const suppress = new Float32Array(NM);  // damper suppression per mode
  const sources = new Map();              // id -> [{mode, amp}]
  const addSource = (comps) => {          // persistent callback: summing sources allocates nothing
    for (let c = 0; c < comps.length; c++) {
      const comp = comps[c];
      const m = modeById(comp?.mode);
      const a = +comp?.amp;
      if (m && a > 0) targets[m.index] += a;
    }
  };
  let impulseDecay = 0.6;

  // tables on grid coordinates x_i = (i+0.5)/G
  const cosT = new Float32Array(8 * G);   // cos(pπx_i), p = 0..7
  const sinT = new Float32Array(G);       // sin(πx_i) (floor mode)
  for (let i = 0; i < G; i++) {
    const x = (i + 0.5) / G;
    for (let p = 0; p < 8; p++) cosT[p * G + i] = Math.cos(p * PI * x);
    sinT[i] = Math.sin(PI * x);
  }
  const C = new Float64Array(64);         // coefficient matrix C[p*8+q] of cos(pπx)cos(qπy)
  const Rt = new Float32Array(8 * G);     // R_q(x_i) = Σ_p C[p][q]·cos(pπx_i), transposed [i*8 + slot]
  const activeQ = new Int8Array(8);
  const cyv = new Float64Array(8);

  const grid = new Float32Array(GG);      // f
  const Fx = new Float32Array(GG);        // ∂F/∂u
  const Fy = new Float32Array(GG);        // ∂F/∂v
  const Fb = new Float32Array(GG);        // blurred F (stillness of the neighbourhood; low = still)
  const saddle = new Float32Array(GG);    // (f/0.015)² + |∇f|²: ≈0 only where nodal lines cross
  const pack = new Float32Array(GG * 4);  // interleaved [f, Gx, Gy, Fb] for the sand loop (G = ∇F + BEAD·∇Fb)
  const tmp = new Float32Array(GG);
  const crackMask = new Float32Array(GG).fill(1);
  const damperMask = new Float32Array(GG).fill(1);
  const mask = new Float32Array(GG).fill(1);
  const crackNear = new Uint8Array(GG);   // 1 = within drain distance of an unhealed crack
  const crackIdx = new Int16Array(GG).fill(-1); // nearest unhealed crack within lodge distance, else -1
  let maskActive = false, crackActive = false, damperActive = false;
  let crackVersion = -1, damperSig = NaN;
  let gridDirty = true;

  const plateState = () => {
    const plate = state?.plate;
    if (!plate) return null;
    if (!Array.isArray(plate.cracks)) plate.cracks = [];
    if (!Number.isFinite(plate.fatigue)) plate.fatigue = 0;
    return plate;
  };
  if (plateState()) for (const c of state.plate.cracks) sanitizeCrack(c);
  if (state?.plate) state.plate.cracks = state.plate.cracks.filter((c) => c && c.pts && c.pts.length >= 2);

  const field = {
    G, grid, Fx, Fy, Fb, saddle, pack, crackMask, crackNear, crackIdx,
    modes: MODES,
    dampers: [],
    total: 0,
    kEff: 0,              // amplitude²-weighted mean harmonic number (≈ wavenumber² of the pattern)
    detune: 0,
    fatigueRate: 0,
    coherence: { dominant: null, share: 0, second: null, secondShare: 0, stable: 0 },
    version: 0,           // bumps whenever the grid is rebuilt
    crackVersion: 0,      // bumps whenever the crack set / healing changes

    get cracks() { return state?.plate?.cracks || EMPTY; },
    get fatigue() { return state?.plate?.fatigue || 0; },

    setSource(id, comps) {
      if (!Array.isArray(comps) || !comps.length) sources.delete(id);
      else sources.set(id, comps);
    },
    getSource(id) { return sources.get(id) || null; },
    clearSources() { sources.clear(); },

    impulse(comps, decay = 0.6) {
      if (!comps) return;
      impulseDecay = Math.max(0.05, Math.min(10, finite(+decay, 0.6)));
      for (const c of comps) {
        const m = modeById(c?.mode);
        const a = +c?.amp;
        if (m && a > 0) impulses[m.index] = Math.min(AMP_MAX, impulses[m.index] + a);
      }
    },

    amp(modeId) { const m = modeById(modeId); return m ? eff[m.index] : 0; },
    ampIndex(i) { return eff[i] || 0; },

    spectrum() {
      const out = [];
      for (let i = 0; i < NM; i++) {
        if (eff[i] > 0.004) { const m = MODES[i]; out.push({ mode: m.id, k: m.k, freq: m.freq, amp: eff[i], index: i }); }
      }
      out.sort((a, b) => b.amp - a.amp);
      return out;
    },

    // the suppression computed at the last update (cheap; e.g. bowPick(edge, t, s, cur, field.suppressed))
    suppressed(mode) { mode = modeById(mode); return mode ? suppress[mode.index] : 0; },

    // max over dampers of |M(at damper)|: how much a damper chokes this mode
    suppression(mode) {
      mode = modeById(mode);
      if (!mode) return 0;
      let s = 0;
      for (const d of field.dampers) {
        if (!d || !Number.isFinite(d.u) || !Number.isFinite(d.v)) continue;
        s = Math.max(s, Math.abs(evalMode(mode, d.u, d.v)));
      }
      return s;
    },

    update(dt) {
      dt = dt > 0 ? Math.min(dt, 0.25) : 0;
      updateDampers();

      targets.fill(0);
      sources.forEach(addSource);
      const ka = 1 - Math.exp(-dt / ATTACK), kr = 1 - Math.exp(-dt / RELEASE);
      const kImp = Math.exp(-dt / impulseDecay);
      let sum2 = 0, ksum = 0;
      for (let i = 0; i < NM; i++) {
        const tg = Math.min(AMP_MAX, targets[i]) * (1 - 0.92 * suppress[i]);
        let a = amps[i] + (tg - amps[i]) * (tg > amps[i] ? ka : kr);
        if (!(a >= 1e-4)) a = 0;                       // also clears NaN
        amps[i] = a;
        let im = impulses[i] * kImp * (1 - Math.min(1, 0.6 * suppress[i] * dt));
        if (!(im >= 1e-4)) im = 0;
        impulses[i] = im;
        const e = Math.min(AMP_MAX * 1.5, a + im);
        eff[i] = e;
        sum2 += e * e;
        ksum += e * e * MODES[i].k;
      }
      field.total = Math.sqrt(sum2);
      field.kEff = sum2 > 1e-9 ? ksum / sum2 : 0;

      // coherence: who dominates, by how much, and for how long
      let d = -1, dv = 0, s2 = -1, sv = 0;
      for (let i = 0; i < NM; i++) {
        const e2 = eff[i] * eff[i];
        if (e2 > dv) { s2 = d; sv = dv; d = i; dv = e2; } else if (e2 > sv) { s2 = i; sv = e2; }
      }
      const coh = field.coherence;
      const share = sum2 > 1e-6 ? dv / sum2 : 0;
      const dom = d >= 0 && dv > 1e-6 ? MODES[d].id : null;
      const holding = dom && share > 0.55 && field.total > 0.12;
      if (holding && dom === coh.dominant) coh.stable += dt;
      else coh.stable = holding ? Math.min(coh.stable, 0.2) : 0;
      coh.dominant = dom; coh.share = share;
      coh.second = s2 >= 0 && sv > 1e-6 ? MODES[s2].id : null;
      coh.secondShare = sum2 > 1e-6 ? sv / sum2 : 0;

      // fatigue and cracks
      const plate = plateState();
      // only the player's violence tires the bronze: the bow/forks/taps, not the singers or the floor
      let v2 = 0;
      for (let i = 0; i < NM; i++) v2 += impulses[i] * impulses[i];
      for (const id of VIOLENT) {
        const comps = sources.get(id);
        if (comps) for (const c of comps) { const a = +c?.amp; if (a > 0) v2 += a * a; }
      }
      const violent = Math.sqrt(v2);
      field.fatigueRate = violent > 0.6 ? Math.max(0, Math.min(field.total, violent + 0.35) - 1.05) ** 2 * 0.9 : 0;
      if (plate) {
        const cracks = plate.cracks;
        let unhealed = 0, mains = 0;
        for (let i = 0; i < cracks.length; i++) {
          const c = cracks[i];
          if (c.branchOf === undefined || c.branchOf === null) { mains++; if (!c.healed) unhealed++; }
        }
        field.detune = Math.min(0.03, 0.006 * unhealed);
        if (field.fatigueRate > 0) {
          plate.fatigue += dt * field.fatigueRate;
          if (plate.fatigue > 1) {
            plate.fatigue = 0.2;
            if (mains < MAX_CRACKS) {
              const fam = makeCrackFamily(rng);
              const index = cracks.length;
              cracks.push(fam[0]);
              for (let b = 1; b < fam.length; b++) { fam[b].branchOf = index; cracks.push(fam[b]); }
              bus?.emit('plate:crack', { crack: index });
            }
          }
        } else {
          plate.fatigue = Math.max(0, plate.fatigue - dt * 0.004);
        }
        const ver = crackSig(cracks);
        if (ver !== crackVersion) { crackVersion = ver; rebuildCrackMask(cracks); field.crackVersion++; }
      } else field.detune = 0;

      if (gridDirty || ampsChanged()) { gridDirty = false; recomputeGrid(); field.version++; }
    },

    // Force the grid to be rebuilt on the next update (e.g. after editing cracks by hand).
    invalidate() { gridDirty = true; crackVersion = -1; damperSig = NaN; },

    sampleInto(u, v, out) {
      u = finite(u); v = finite(v);
      const gx = (u + 1) * 0.5 * G - 0.5, gy = (v + 1) * 0.5 * G - 0.5;
      let i0 = Math.floor(gx), j0 = Math.floor(gy);
      if (i0 < 0) i0 = 0; else if (i0 > G - 2) i0 = G - 2;
      if (j0 < 0) j0 = 0; else if (j0 > G - 2) j0 = G - 2;
      let fx = gx - i0, fy = gy - j0;
      fx = fx < 0 ? 0 : fx > 1 ? 1 : fx; fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
      const a = j0 * G + i0, b = a + 1, c = a + G, e = c + 1;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const f = grid[a] * w00 + grid[b] * w10 + grid[c] * w01 + grid[e] * w11;
      out.f = f; out.F = f * f;
      out.gx = Fx[a] * w00 + Fx[b] * w10 + Fx[c] * w01 + Fx[e] * w11;
      out.gy = Fy[a] * w00 + Fy[b] * w10 + Fy[c] * w01 + Fy[e] * w11;
      out.fb = Fb[a] * w00 + Fb[b] * w10 + Fb[c] * w01 + Fb[e] * w11;
      return out;
    },

    // bilinear sample: { f, F = f², gx = ∂F/∂u, gy = ∂F/∂v, fb = blurred F }
    sample(u, v) { return field.sampleInto(u, v, { f: 0, F: 0, gx: 0, gy: 0, fb: 0 }); },

    // blurred F at a point (low = a still neighbourhood: nodal crossings, beads)
    stillnessAt(u, v) {
      const gx = (finite(u) + 1) * 0.5 * G - 0.5, gy = (finite(v) + 1) * 0.5 * G - 0.5;
      const i = Math.max(0, Math.min(G - 1, Math.round(gx))), j = Math.max(0, Math.min(G - 1, Math.round(gy)));
      return Fb[j * G + i];
    },

    // f at a point from the modal sum directly (exact, slower; ignores cracks and dampers)
    evalAt(u, v) {
      let f = 0;
      for (let i = 0; i < NM; i++) if (eff[i] > EPS_AMP) f += eff[i] * evalMode(MODES[i], u, v);
      return f;
    },
  };

  // rebuild only for changes the sand could notice (~1% of the total)
  function ampsChanged() {
    const tol = 0.003 + 0.008 * field.total;
    for (let i = 0; i < NM; i++) {
      const d = eff[i] - lastEff[i];
      if (d > tol || d < -tol) return true;
    }
    return false;
  }

  function updateDampers() {
    const ds = field.dampers;
    let sig = ds ? ds.length * 1000.5 : 0;
    if (ds) for (let i = 0; i < ds.length; i++) {
      const d = ds[i];
      if (!d) continue;
      sig += (finite(d.u) * 31.71 + finite(d.v) * 17.33 + finite(d.r, 0.06) * 7.13) * (i + 1.37);
    }
    if (sig === damperSig) return;
    damperSig = sig;
    for (let i = 0; i < NM; i++) suppress[i] = ds && ds.length ? field.suppression(MODES[i]) : 0;
    // a damper is also a small pocket of forced stillness
    damperMask.fill(1);
    damperActive = false;
    if (ds) for (const d of ds) {
      if (!d || !Number.isFinite(d.u) || !Number.isFinite(d.v)) continue;
      const r = Math.max(0.01, Math.min(0.3, finite(d.r, 0.06)));
      const inv = 1 / (r * r), reach = r * 2.6;
      const i0 = Math.max(0, Math.floor(((d.u - reach + 1) / 2) * G)), i1 = Math.min(G - 1, Math.ceil(((d.u + reach + 1) / 2) * G));
      const j0 = Math.max(0, Math.floor(((d.v - reach + 1) / 2) * G)), j1 = Math.min(G - 1, Math.ceil(((d.v + reach + 1) / 2) * G));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const du = ((i + 0.5) / G) * 2 - 1 - d.u, dv = ((j + 0.5) / G) * 2 - 1 - d.v;
        const m = 1 - 0.85 * Math.exp(-(du * du + dv * dv) * inv);
        const p = j * G + i;
        if (m < damperMask[p]) damperMask[p] = m;
      }
      damperActive = true;
    }
    rebuildMask();
  }

  function rebuildMask() {
    maskActive = crackActive || damperActive;
    if (maskActive) for (let p = 0; p < GG; p++) mask[p] = crackMask[p] * damperMask[p];
    gridDirty = true;
  }

  function recomputeGrid() {
    lastEff.set(eff);
    C.fill(0);
    let floorW = 0, any = false;
    for (let mi = 0; mi < NM; mi++) {
      const a = eff[mi];
      if (a <= EPS_AMP) continue;
      const mode = MODES[mi];
      const w = a * mode.norm;
      any = true;
      if (mode.special) { floorW += w; continue; }
      C[mode.n * 8 + mode.m] += w;
      C[mode.m * 8 + mode.n] += mode.s * w;
    }
    if (!any) {
      grid.fill(0); Fx.fill(0); Fy.fill(0); Fb.fill(0); saddle.fill(0); pack.fill(0);
      return;
    }
    // rows R_q(x) for every q that has a coefficient, stored transposed: Rt[i*8 + a] for active slot a
    let nq = 0;
    for (let q = 0; q < 8; q++) {
      let has = false;
      for (let p = 0; p < 8; p++) if (Math.abs(C[p * 8 + q]) > 1e-9) { has = true; break; }
      if (!has) continue;
      const a = nq++;
      activeQ[a] = q;
      for (let i = 0; i < G; i++) {
        let acc = 0;
        for (let p = 0; p < 8; p++) acc += C[p * 8 + q] * cosT[p * G + i];
        Rt[i * 8 + a] = acc;
      }
    }
    // f(x_i, y_j) = Σ_q cos(qπy_j)·R_q(x_i) + floorW·sin(πx_i)·sin(πy_j)
    for (let j = 0; j < G; j++) {
      const row = j * G;
      for (let a = 0; a < nq; a++) cyv[a] = cosT[activeQ[a] * G + j];
      for (let a = nq; a < 8; a++) cyv[a] = 0;
      const c0 = cyv[0], c1 = cyv[1], c2 = cyv[2], c3 = cyv[3], c4 = cyv[4], c5 = cyv[5], c6 = cyv[6], c7 = cyv[7];
      const fj = floorW * sinT[j];
      if (nq <= 4) {
        for (let i = 0, b = 0; i < G; i++, b += 8) {
          grid[row + i] = fj * sinT[i] + c0 * Rt[b] + c1 * Rt[b + 1] + c2 * Rt[b + 2] + c3 * Rt[b + 3];
        }
      } else {
        for (let i = 0, b = 0; i < G; i++, b += 8) {
          grid[row + i] = fj * sinT[i] + c0 * Rt[b] + c1 * Rt[b + 1] + c2 * Rt[b + 2] + c3 * Rt[b + 3]
            + c4 * Rt[b + 4] + c5 * Rt[b + 5] + c6 * Rt[b + 6] + c7 * Rt[b + 7];
        }
      }
    }
    if (maskActive) for (let p = 0; p < GG; p++) grid[p] *= mask[p];

    // F = f², Fb = F blurred (two box passes), then ∇F, ∇Fb and the interleaved pack in one pass
    for (let p = 0; p < GG; p++) { const f = grid[p]; tmp[p] = f * f; }
    Fb.set(tmp);
    boxBlur(Fb);
    boxBlur(Fb);
    const inv = G / 2, half = inv * 0.5, L = G - 1;
    for (let j = 0; j < G; j++) {
      const row = j * G;
      const up = j > 0 ? row - G : row, dn = j < L ? row + G : row;
      const sy = j > 0 && j < L ? half : inv;
      for (let i = 0; i < G; i++) {
        const p = row + i;
        const l = i > 0 ? p - 1 : p, r = i < L ? p + 1 : p;
        const sx = i > 0 && i < L ? half : inv;
        const fx = (tmp[r] - tmp[l]) * sx, fy = (tmp[dn + i] - tmp[up + i]) * sy;
        Fx[p] = fx; Fy[p] = fy;
        const dfu = (grid[r] - grid[l]) * sx, dfv = (grid[dn + i] - grid[up + i]) * sy, fs = grid[p] * 66.67;
        saddle[p] = fs * fs + dfu * dfu + dfv * dfv;
        const q = p * 4;
        pack[q] = grid[p];
        pack[q + 1] = fx + bead * (Fb[r] - Fb[l]) * sx;
        pack[q + 2] = fy + bead * (Fb[dn + i] - Fb[up + i]) * sy;
        pack[q + 3] = Fb[p];
      }
    }
  }

  // separable running-sum box blur of radius BLUR_R with clamped edges (in place)
  const blurTmp = new Float32Array(GG);
  const colSum = new Float64Array(G);
  const lodgeD2 = new Float32Array(GG);
  function boxBlur(a) {
    const r = BLUR_R, w = 1 / (2 * r + 1), L = G - 1;
    for (let j = 0; j < G; j++) {
      const row = j * G, last = row + L;
      let s = a[row] * (r + 1);
      for (let i = 1; i <= r; i++) s += a[row + i];
      // i in [0, r]: left edge clamped
      for (let i = 0; i <= r; i++) { blurTmp[row + i] = s * w; s += a[row + i + r + 1] - a[row]; }
      for (let i = r + 1; i < G - r - 1; i++) { blurTmp[row + i] = s * w; s += a[row + i + r + 1] - a[row + i - r]; }
      for (let i = Math.max(r + 1, G - r - 1); i < G; i++) { blurTmp[row + i] = s * w; s += a[last] - a[row + i - r]; }
    }
    // vertical pass, row-major with running column sums (cache friendly)
    for (let i = 0; i < G; i++) {
      let c = blurTmp[i] * (r + 1);
      for (let j = 1; j <= r; j++) c += blurTmp[j * G + i];
      colSum[i] = c;
    }
    for (let j = 0; j < G; j++) {
      const row = j * G;
      const addRow = Math.min(L, j + r + 1) * G, subRow = Math.max(0, j - r) * G;
      for (let i = 0; i < G; i++) {
        a[row + i] = colSum[i] * w;
        colSum[i] += blurTmp[addRow + i] - blurTmp[subRow + i];
      }
    }
  }

  function rebuildCrackMask(cracks) {
    crackMask.fill(1); crackNear.fill(0); crackIdx.fill(-1);
    crackActive = false;
    lodgeD2.fill(Infinity);
    for (let ci = 0; ci < cracks.length; ci++) {
      const c = cracks[ci];
      sanitizeCrack(c);
      const pts = c.pts;
      if (pts.length < 2) continue;
      crackActive = true;
      const strength = c.healed ? 0.5 : 0.85;
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of pts) { minU = Math.min(minU, p[0]); maxU = Math.max(maxU, p[0]); minV = Math.min(minV, p[1]); maxV = Math.max(maxV, p[1]); }
      const m = 0.13;   // exp(-d²/0.0016) is negligible beyond this
      const i0 = Math.max(0, Math.floor(((minU - m + 1) / 2) * G)), i1 = Math.min(G - 1, Math.ceil(((maxU + m + 1) / 2) * G));
      const j0 = Math.max(0, Math.floor(((minV - m + 1) / 2) * G)), j1 = Math.min(G - 1, Math.ceil(((maxV + m + 1) / 2) * G));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const u = ((i + 0.5) / G) * 2 - 1, v = ((j + 0.5) / G) * 2 - 1;
        const d = distToPolyline(u, v, pts);
        const p = j * G + i;
        const mk = 1 - strength * Math.exp(-(d * d) / 0.0016);
        if (mk < crackMask[p]) crackMask[p] = mk;
        if (!c.healed) {
          if (d < CRACK_DRAIN_D) crackNear[p] = 1;
          if (d < CRACK_LODGE_D && d * d < lodgeD2[p]) { lodgeD2[p] = d * d; crackIdx[p] = ci; }
        }
      }
    }
    rebuildMask();
  }

  return field;
}

const VIOLENT = ['bow', 'fork', 'phono'];   // (the nut's steady drive never tires the bronze)
const EMPTY = Object.freeze([]);

function sanitizeCrack(c) {
  if (!c || typeof c !== 'object') return;
  if (!Array.isArray(c.pts)) c.pts = [];
  c.pts = c.pts.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const ns = Math.max(1, c.pts.length - 1);
  if (!Array.isArray(c.gold)) c.gold = [];
  if (c.gold.length !== ns) {
    const g = new Array(ns).fill(0);
    for (let i = 0; i < ns && i < c.gold.length; i++) g[i] = c.gold[i];
    c.gold = g;
  }
  for (let i = 0; i < ns; i++) { const g = +c.gold[i]; c.gold[i] = g > 0 ? Math.min(1, g) : 0; }
  c.healed = !!c.healed;
}

function crackSig(cracks) {
  let s = cracks.length * 7919;
  for (let i = 0; i < cracks.length; i++) {
    const c = cracks[i];
    s += (c.healed ? 7 : 1) * ((c.pts?.length || 0) + 1) * (i + 3);
  }
  return s;
}

// distance from (u,v) to a polyline [[u,v], ...] (allocation free)
export function distToPolyline(u, v, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d2 = segDist2(u, v, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

function segDist2(u, v, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy || 1e-12;
  let t = ((u - ax) * dx + (v - ay) * dy) / L;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * dx - u, py = ay + t * dy - v;
  return px * px + py * py;
}

// nearest segment of a polyline: { index, dist, t } (t = position along that segment, 0..1)
export function nearestSegment(u, v, pts, out = null) {
  let best = Infinity, bi = 0, bt = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1], dx = pts[i + 1][0] - ax, dy = pts[i + 1][1] - ay;
    const L = dx * dx + dy * dy || 1e-12;
    let t = ((u - ax) * dx + (v - ay) * dy) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - u, py = ay + t * dy - v;
    const d2 = px * px + py * py;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  const o = out || {};
  o.index = bi; o.dist = Math.sqrt(best); o.t = bt;
  return o;
}

// ---------------------------------------------------------------------------------------------
// Cracks. A crack is { pts: [[u,v],...], gold: [0..1 per segment], healed, born, branchOf? }.
// A side branch is stored as its own crack object right after its parent, with branchOf = the
// parent's index in state.plate.cracks; it drains, gilds and heals on its own.

const rngFn = (rng) => (typeof rng === 'function' ? rng : rng && typeof rng.next === 'function' ? () => rng.next() : Math.random);
const r4 = (x) => Math.round(x * 10000) / 10000;

// A hairline: a meandering spine, then subdivided with small perpendicular jags.
function growPath(r, u, v, ang, len, { stepLo = 0.06, stepHi = 0.1, wander = 0.6, pull = 0.12, jag = 0.0065 } = {}) {
  const spine = [[u, v]];
  let walked = 0;
  while (walked < len) {
    const step = Math.min(len - walked, stepLo + r() * (stepHi - stepLo));
    if (step < 0.012) break;
    ang += (r() - 0.5) * wander;
    const toC = Math.atan2(-v, -u);
    let dAng = toC - ang;
    while (dAng > PI) dAng -= 2 * PI;
    while (dAng < -PI) dAng += 2 * PI;
    ang += dAng * pull;
    const nu = u + Math.cos(ang) * step, nv = v + Math.sin(ang) * step;
    if (Math.hypot(nu, nv) < 0.12 || Math.abs(nu) > 0.985 || Math.abs(nv) > 0.985) break;
    u = nu; v = nv;
    spine.push([u, v]);
    walked += step;
  }
  const pts = [[r4(spine[0][0]), r4(spine[0][1])]];
  for (let s = 0; s < spine.length - 1; s++) {
    const [ax, ay] = spine[s], [bx, by] = spine[s + 1];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / L, ny = dx / L;
    const k = Math.max(2, Math.ceil(L / 0.016));
    for (let q = 1; q <= k; q++) {
      const t = q / k + (q < k ? (r() - 0.5) * 0.3 / k : 0);
      const off = q < k ? (r() - 0.5) * 2 * jag * (0.6 + 0.4 * Math.sin(t * PI)) : 0;
      pts.push([r4(ax + dx * t + nx * off), r4(ay + dy * t + ny * off)]);
    }
  }
  return pts;
}

function crackObject(pts) {
  return { pts, gold: new Array(Math.max(1, pts.length - 1)).fill(0), healed: false, born: Date.now() };
}

// [mainCrack, branch?] — the branch (if any) has no branchOf yet; the caller assigns it.
export function makeCrackFamily(rng = Math.random) {
  const r = rngFn(rng);
  const edge = Math.floor(r() * 4) % 4;
  const t = 0.15 + r() * 0.7;
  let u, v;
  if (edge === 0) { u = -1 + 2 * t; v = -1; } else if (edge === 1) { u = 1; v = -1 + 2 * t; }
  else if (edge === 2) { u = 1 - 2 * t; v = 1; } else { u = -1; v = 1 - 2 * t; }
  const inward = [PI / 2, PI, -PI / 2, 0][edge];
  const ang = inward + (r() - 0.5) * 0.9;
  const len = 0.3 + r() * 0.6;
  // start a hair inside the rim so the first point is on the plate
  const start = growPath(r, u, v, ang, len);
  start[0] = [r4(Math.max(-1, Math.min(1, u))), r4(Math.max(-1, Math.min(1, v)))];
  const fam = [crackObject(start)];

  if (start.length > 8 && r() < 0.55) {
    const at = Math.floor(start.length * (0.35 + r() * 0.4));
    const [bu, bv] = start[at];
    const [pu, pv] = start[Math.max(0, at - 3)];
    const mainAng = Math.atan2(bv - pv, bu - pu);
    const side = r() < 0.5 ? -1 : 1;
    const bAng = mainAng + side * (0.45 + r() * 0.5);
    const bLen = 0.07 + r() * 0.13;
    const bpts = growPath(r, bu, bv, bAng, bLen, { stepLo: 0.03, stepHi: 0.05, wander: 0.7, pull: 0, jag: 0.005 });
    bpts[0] = [bu, bv];
    if (bpts.length >= 3) fam.push(crackObject(bpts));
  }
  return fam;
}

// The main crack only (kept for compatibility).
export function makeCrack(rng = Math.random) {
  return makeCrackFamily(rng)[0];
}
