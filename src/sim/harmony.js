// Consonance between harmonic numbers. Simple ratios agree; complex ratios beat.

export function gcd(a, b) {
  a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
  while (b) { [a, b] = [b, a % b]; }
  return a || 1;
}

const cache = new Map();
export function consonance(k1, k2) {
  const key = k1 < k2 ? k1 * 1000 + k2 : k2 * 1000 + k1;
  let c = cache.get(key);
  if (c !== undefined) return c;
  const g = gcd(k1, k2);
  const p = k1 / g, q = k2 / g;
  const T = Math.log2(p * q);
  c = Math.max(-1, Math.min(1, 1 - T / 5));
  cache.set(key, c);
  return c;
}

// Mean consonance of a (possibly chordal) singer against an amplitude-weighted spectrum.
export function consonanceWithSpectrum(ks, spectrum, selfWeight = null) {
  let acc = 0, wsum = 0;
  for (const s of spectrum) {
    let a = s.amp;
    if (selfWeight && selfWeight[s.mode] !== undefined) a *= selfWeight[s.mode];
    if (a <= 0) continue;
    let c = 0;
    for (const k of ks) c += consonance(k, s.k);
    acc += a * (c / ks.length);
    wsum += a;
  }
  return { value: wsum > 0 ? acc / Math.max(wsum, 0.35) : 0, weight: wsum };
}

export function meanConsonance(ksA, ksB) {
  let c = 0;
  for (const a of ksA) for (const b of ksB) c += consonance(a, b);
  return c / (ksA.length * ksB.length);
}

// Octave class: divide out powers of two.
export function clanOf(k) {
  let x = Math.round(k);
  while (x > 1 && x % 2 === 0) x /= 2;
  return String(x);
}

export function detuned(k, detune) {
  return k * (1 + detune);
}
