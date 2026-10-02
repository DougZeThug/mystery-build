// localStorage persistence. Every access is guarded: storage may be absent or throw.
const KEY = 'stillpoint.v1';

export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s && s.v === 1 ? s : null;
  } catch { return null; }
}

export function saveState(state) {
  try {
    if (state.log && state.log.length > 400) state.log = state.log.slice(-400);
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch { return false; }
}

export function clearState() {
  try { localStorage.removeItem(KEY); } catch {}
}

export function newState() {
  const now = Date.now();
  return {
    v: 1, created: now, lastVisit: now, visits: 0, playSeconds: 0,
    plate: { fatigue: 0, cracks: [], wear: null },
    sand: null, life: null, species: {}, seen: {}, log: [], cylinders: [],
    stats: { births: 0, deaths: 0, fusions: 0, devoured: 0, fell: 0, choirs: 0, cracks: 0, heals: 0, maxPop: 0, splits: 0 },
  };
}
