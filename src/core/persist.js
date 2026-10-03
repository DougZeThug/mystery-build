// localStorage persistence. Every access is guarded: storage may be absent or throw.
const KEY = 'stillpoint.v1';
const BACKUP = 'stillpoint.v1.unreadable';

export function loadState() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s && typeof s === 'object' && s.v === 1) return normalizeState(s);
  } catch { /* fall through */ }
  // unreadable: keep it aside rather than lose it, and start a new plate
  try { localStorage.setItem(BACKUP, raw); localStorage.removeItem(KEY); } catch {}
  return null;
}

// Save; if storage is full, shed what can be forgotten (passing forms that barely lived, old log lines)
// and try again. Returns true when the state was written.
export function saveState(state) {
  if (state.log && state.log.length > 400) state.log = state.log.slice(-400);
  if (write(state)) return true;
  pruneSpecies(state, 2);
  if (state.log.length > 150) state.log = state.log.slice(-150);
  if (write(state)) return true;
  pruneSpecies(state, Infinity);
  state.log = state.log.slice(-60);
  return write(state);
}

function write(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; } catch { return false; }
}

function pruneSpecies(state, maxPeak) {
  const sp = state.species || {};
  for (const [id, r] of Object.entries(sp)) {
    if (!r || r.keeper || !r.extinct) continue;
    if ((r.peak || 0) <= maxPeak) delete sp[id];
  }
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
    light: { on: true },
    stats: { births: 0, deaths: 0, fusions: 0, devoured: 0, fell: 0, choirs: 0, cracks: 0, heals: 0, maxPop: 0, splits: 0 },
  };
}

const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);

// Bring a loaded state back into shape: whatever is missing or malformed gets its default.
export function normalizeState(s) {
  const d = newState();
  const out = { ...d, ...s };
  out.created = num(s.created, d.created);
  out.lastVisit = num(s.lastVisit, d.lastVisit);
  out.visits = num(s.visits, 0);
  out.playSeconds = num(s.playSeconds, 0);
  const plate = isObj(s.plate) ? s.plate : {};
  out.plate = {
    ...plate,
    fatigue: num(plate.fatigue, 0),
    cracks: Array.isArray(plate.cracks) ? plate.cracks.filter((c) => isObj(c) && Array.isArray(c.pts)) : [],
    wear: typeof plate.wear === 'string' ? plate.wear : null,
  };
  out.species = isObj(s.species) ? s.species : {};
  for (const [id, r] of Object.entries(out.species)) if (!isObj(r) || !Array.isArray(r.comps)) delete out.species[id];
  out.seen = isObj(s.seen) ? s.seen : {};
  out.log = Array.isArray(s.log) ? s.log.filter((l) => isObj(l) && typeof l.text === 'string') : [];
  out.cylinders = Array.isArray(s.cylinders) ? s.cylinders.filter(isObj) : [];
  out.light = isObj(s.light) ? { on: s.light.on !== false } : { on: true };
  const st = isObj(s.stats) ? s.stats : {};
  out.stats = {};
  for (const k of Object.keys(d.stats)) out.stats[k] = num(st[k], 0);
  for (const [k, v] of Object.entries(st)) if (!(k in out.stats) && Number.isFinite(v)) out.stats[k] = v;
  if (!isObj(s.sand)) out.sand = null;
  if (!isObj(s.life)) out.life = null;
  return out;
}
