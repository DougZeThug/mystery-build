// Consonance between harmonic numbers. Simple ratios agree; complex ratios beat.
// p/q = k1/k2 reduced; T = log2(p·q); C = clamp(1 − T/5, −1, 1)
//   unison 1 · octave .8 · 5:4 ≈ .14 · 13:10 ≈ −.4 · 25:26 ≈ −.87

const toK = (k) => {
  const r = Math.round(+k);
  return r > 0 && r < 100000 ? r : 0;
};

export function gcd(a, b) {
  a = Math.abs(Math.round(+a)) || 0; b = Math.abs(Math.round(+b)) || 0;
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

// Reduced ratio k1:k2 as {p, q} (p = k1 side). Non-positive input -> {p: 0, q: 0}.
export function ratio(k1, k2) {
  const a = toK(k1), b = toK(k2);
  if (!a || !b) return { p: 0, q: 0 };
  const g = gcd(a, b);
  return { p: a / g, q: b / g };
}

const cache = new Map();
export function consonance(k1, k2) {
  const a = toK(k1), b = toK(k2);
  if (!a || !b) return 0;                       // silence / nonsense is neutral
  const key = a < b ? a * 100000 + b : b * 100000 + a;
  let c = cache.get(key);
  if (c !== undefined) return c;
  const g = gcd(a, b);
  const T = Math.log2((a / g) * (b / g));
  c = Math.max(-1, Math.min(1, 1 - T / 5));
  cache.set(key, c);
  return c;
}

// The result of consonanceWithSpectrum: behaves as a number (valueOf) and also carries the
// amplitude weight it was computed from, so both `c > 0` and `c.value` / `c.weight` work.
class SpectrumConsonance {
  constructor(value, weight) { this.value = value; this.weight = weight; }
  valueOf() { return this.value; }
  toString() { return String(this.value); }
  toFixed(d) { return this.value.toFixed(d); }
  toJSON() { return this.value; }
}

function entryWeight(selfWeight, entry, ks) {
  if (!selfWeight) return 1;
  if (typeof selfWeight === 'function') { const w = +selfWeight(entry); return w > 0 ? w : 0; }
  if (selfWeight === true) return ks.includes(entry.k) ? 0 : 1;      // exclude own pitches
  if (typeof selfWeight === 'number') return ks.includes(entry.k) ? Math.max(0, selfWeight) : 1;
  const w = selfWeight[entry.mode];
  return w === undefined ? 1 : Math.max(0, +w || 0);
}

// Mean consonance of a (possibly chordal) singer against an amplitude-weighted spectrum.
// selfWeight (optional): {modeId: factor} | (entry) => factor | true (ignore entries at the singer's
// own k) | number (factor for entries at the singer's own k).
// Returns a number-like {value, weight}; value ∈ [−1, 1] (weighted mean, damped when the plate is quiet).
export function consonanceWithSpectrum(ks, spectrum, selfWeight = null) {
  let acc = 0, wsum = 0;
  if (ks && ks.length && spectrum) {
    for (const s of spectrum) {
      let a = +s.amp;
      if (!(a > 0)) continue;
      a *= entryWeight(selfWeight, s, ks);
      if (a <= 0) continue;
      let c = 0;
      for (const k of ks) c += consonance(k, s.k);
      acc += a * (c / ks.length);
      wsum += a;
    }
  }
  const value = wsum > 0 ? Math.max(-1, Math.min(1, acc / Math.max(wsum, 0.35))) : 0;
  return new SpectrumConsonance(value, wsum);
}

// The bible's feeding sum: Σ amp · meanConsonance(ks, k_src), clamped to [−1, 1].
export function feedFromSpectrum(ks, spectrum, selfWeight = null) {
  let acc = 0;
  if (!ks || !ks.length || !spectrum) return 0;
  for (const s of spectrum) {
    let a = +s.amp;
    if (!(a > 0)) continue;
    a *= entryWeight(selfWeight, s, ks);
    if (a <= 0) continue;
    let c = 0;
    for (const k of ks) c += consonance(k, s.k);
    acc += a * (c / ks.length);
  }
  return Math.max(-1, Math.min(1, acc));
}

export function meanConsonance(ksA, ksB) {
  if (!ksA || !ksB || !ksA.length || !ksB.length) return 0;
  let c = 0;
  for (const a of ksA) for (const b of ksB) c += consonance(a, b);
  return c / (ksA.length * ksB.length);
}

// Octave class: divide out powers of two. 5,10,20,40 -> '5'; 25,50 -> '25'; 13,26,52 -> '13'.
export function clanOf(k) {
  let x = toK(k);
  if (!x) return '0';
  while (x > 1 && x % 2 === 0) x /= 2;
  return String(x);
}

export function detuned(k, detune) {
  const d = +detune;
  return (+k || 0) * (1 + (d > -0.5 && d < 0.5 ? d : 0));
}
