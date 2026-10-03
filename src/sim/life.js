// The singers: small creatures of standing waves.
// Born where a held note piles the sand, nourished by consonance, starved by discord. Agreement
// fuses two singers into a chord; disagreement lets the stronger devour the weaker. Every singer
// sings its own mode back into the plate, so once there are a few of them the plate plays itself.
import { MODES, modeById } from './modes.js';
import { consonance, clanOf } from './harmony.js';
import { distToPolyline } from './field.js';
import { nameFor, noteFor, colourFor, speciesRatioText, numberWord } from './naming.js';

// Renderer encoding: instance 'state' float = code + progress (0..0.99) through the state.
// Free states (walk, feed, sleep, nestle) carry their pace instead; 'cling' (11) carries how much
// of its grip it has spent (0 = just caught hold, 0.99 = about to be thrown), and FLAG.cling.
export const STATES = ['walk', 'feed', 'split', 'fuse', 'eat', 'startle', 'sleep', 'nestle', 'fall', 'die', 'born', 'cling'];
export const STATE_CODE = Object.freeze(Object.fromEntries(STATES.map((s, i) => [s, i])));
// instance flags (bits): aurata 1, sleeping 2, fused-flash 4, nestle 8, floating (choir/floor) 16,
// lunging 32, the keeper 64, dying of old age 128 (only in the 'die' state), clinging 256,
// old (age > 0.8·life) 512. The renderer may also derive 'old' from age01 >= 0.8.
export const FLAG = Object.freeze({ aurata: 1, sleep: 2, flash: 4, nestle: 8, float: 16, lunge: 32, keeper: 64,
  ageDeath: 128, cling: 256, old: 512 });
export const KEEPER_ID = 'keeper';

const DUR = { born: 1.2, split: 0.9, fuse: 1.7, flash: 0.9, eat: 0.8, startle: 0.55, thrown: 0.8, fall: 1.2,
  dieAge: 1.5, dieHunger: 1.0, dieEaten: 0.6 };

// All the numbers that shape the ecosystem (tuned with dev/life-sim.mjs). Mutable for harnesses.
export const TUNE = {
  cap: 64,
  // birth from sand
  birthStable: 2.2, birthShare: 0.55, birthTotal: 0.3, birthGap: 1.6, peakMin: 22, hybridShare: 0.28,
  songTotal: 0.2,       // the population's own song may quicken singers at a softer level than a bow
  songWaver: 0.08,      // ...but the plate's own song wavers: chance a song-born singer is a neighbouring mode
  songCrowd: 48,        // and it quickens mostly when the plate is sparse (rate × (1 - N/songCrowd)^1.5)
  gestation: 23,        // seconds of strong, coherent song to quicken a singer of a new mode
  gestationFew: 17,     // ...while fewer than earlyKinds species are known (the first minutes)
  driveGestation: 11,   // ...and while the player holds that mode (bow, fork, phonograph) at full strength
  familiar: 2.6,        // a mode whose species is already alive quickens this much faster
  // the player's own note quickens by intent, not loudness: its strength is
  // (drive on the dominant mode - driveFrom) / driveRange, so any moving bow counts nearly in full
  driveFrom: 0.1, driveRange: 0.2,
  // the eager plate: while fewer than earlyKinds species are known, a steady played figure quickens
  // a singer in about earlyGestation seconds at full strength (a newcomer will not hold a bow for
  // half a minute); so does a cylinder replaying a vanished kind. A touched tuning fork quickens
  // its exact mode at forkGestation: one fresh strike, fading over 12 s, is about one singer.
  earlyKinds: 3, earlyStable: 1.6, earlyGestation: 7.4, forkGestation: 5,
  quickDrop: 0.42,      // quickening spent by each birth
  quickDecay: 0.05,     // per second, for every mode the plate is not coherently holding
  newbornE: 0.55,
  // chorus (what the population sings into the plate)
  chorusAmp: 0.42, chorusCount: 3, chorusMax: 0.9, breathDepth: 0.2, darkVoice: 0.6, voiceE: 0.4,
  // in darkness the bronze carries only a whisper of their sleep song (so the still plate can dream
  // of the dead); the sleepers still hear one another in full, so it feeds them as before
  darkField: 0.06, wakeVoice: 4,   // ...and on waking they find their full voice over a few seconds
  // energy
  feedGain: 0.1,         // dE/dt from agreeable sound (soft-saturated feed)
  harm: 0.28,            // ...and from disagreeable sound, relative (discord starves more slowly than harmony feeds)
  selfExclude: 0.55,     // share of a species' own song it cannot live on
  hearMax: 0.85,         // they hear the plate's total loudness only up to this (an over-driven plate starves no faster)
  deafen: 0.85,          // discord's harm × (1 - deafen·overdrive): a screaming plate is din, not discord
  beat: 0.5, beatFrom: 10, beatScale: 12,   // a crowded pitch beats: unison value 1 - beat·(voices - from)/scale
  metab: 0.0075, metabBase: 0.45, metabSlope: 1.0,   // metabolism = metab·(base + slope·e): bright singers burn faster
  ageCost: 0.004, crowdK: 21, crowdStress: 0.06, stillPenalty: 0.45, detunePenalty: 9,
  // they sing into the room a bow leaves, and hush when it speaks: by `hush` once the player's
  // drive reaches hushAt, however softly it is played, so the played figure wins the plate
  voiceRoom: 1.0, hush: 0.85, hushAt: 0.2,
  // division
  splitE: 0.86, splitAge: 25, splitSand: 10, splitCool: 22, splitTake: 10, mutate: 0.06,
  lifeMin: 240, lifeMax: 480, aurataLife: 1.5,
  // fusion / predation
  fuseCons: 0.25, fuseE: 0.6, fuseRate: 0.35, eatCons: -0.3, eatGain: 0.55, huntE: 0.93, grace: 3,
  // motion
  speedMin: 0.035, speedMax: 0.09, overdriveA: 0.95, rBase: 0.038, rComp: 0.008,
  // violence: at a strong antinode (V = F·A + clingOver·overdrive > clingV) a singer first CLINGS
  // (trembling, creeping toward stillness). Its grip (clingBase + clingE·e seconds) drains only
  // while the player drives the plate (bow, fork, phonograph), and comes back only as the plate
  // stops screaming; when it runs out, after at least clingMin + clingMinE·e seconds of this
  // cling, the singer is THROWN (the only way to fall: a throw near the rim carries it over).
  // Near a resting finger, a landed moth or a felt damper a singer never loses its grip.
  clingV: 0.55, clingOver: 0.5, clingCalm: 0.8, clingCreep: 0.45, braceHarm: 0.35,
  clingBase: 2.4, clingE: 2.8, clingDrain: 0.7, clingDrainV: 0.6, clingRegen: 0.15, clingDazed: 0.15,
  clingMin: 1.6, clingMinE: 1.0,   // and every throw follows at least this long a cling (s, + clingMinE·e)
  throwBase: 1.25, throwV: 0.9, throwOver: 0.6, shelterHold: 0.26, shelterDamper: 0.15,
  // the keeper (after the first Floor): one, immortal, walks the rim
  keeperR: 2.2, keeperSpeed: 0.028, keeperRun: 0.16, keeperRim: 0.8, keeperDelay: 2.5, keeperBorn: 4.5,
  keeperReach: 0.25, keeperComfort: 0.015, keeperWait: 12, keeperGlow: 0.86,
  // rare states
  choirMin: 3, choirPop: 12, choirCons: 0.1, choirHold: 5, choirLen: 34, choirCool: 600, choirBreak: 3,
  floorKs: [5, 10, 20, 40], floorHold: 6, floorCool: 150,
  dreams: true,         // life drives sand.setDream() in darkness (extinct figures); false to leave it to others
  // time away: the coarse evolution may take this many ms of compute (it runs once, under the fade
  // from black or behind a hidden tab), lengthening its step on a slow device only up to
  // offlineMaxStep seconds: longer steps let a whole plate split at once and then starve together
  // (a quarter of 3-hour absences ended empty at 120 s steps; none at 20). Whatever still does not
  // fit is left unlived: the plate rested.
  offlineBudget: 250, offlineMaxStep: 20,
};

const TAU = Math.PI * 2;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const byCountDesc = (a, b) => b.n - a.n;
const FREE = { walk: 1, feed: 1, sleep: 1, nestle: 1 };
const EXT_SOURCES = ['bow', 'fork', 'phono', 'floor', 'dream'];
const PLAYER_SOURCES = ['bow', 'fork', 'phono'];

export function createLife(game) {
  const field = game.field, sand = game.sand;
  const bus = game.bus || { emit() {}, on() { return () => {}; } };
  const rng = game.rng || fallbackRng();
  const state = game.state || (game.state = {});
  state.species ||= {};
  const NM = MODES.length;
  const CAP = TUNE.cap;

  const gauss = () => (rng.next() + rng.next() + rng.next() - 1.5) * 1.1547;

  // --- runtime registries -------------------------------------------------------------------
  const motes = [];
  const species = {};          // id -> Species
  const speciesList = [];      // by idx
  const alive = [];            // species with living members (rebuilt each step)
  const relCache = new Map();
  let nextId = 1;
  let T = 0;                   // life clock (seconds)
  let N = 0;                   // living (not dying/falling) singers

  // chorus output, pooled
  let toField = 1;             // share of the population's song the bronze carries (TUNE.darkField in darkness)
  const chorusAmp = new Float32Array(NM);
  const chorusPool = MODES.map((m) => ({ mode: m.id, amp: 0 }));
  const chorusOut = [];
  const extAmp = new Float32Array(NM);
  const voicesK = new Float32Array(128);
  // active spectrum scratch
  const actIdx = new Int16Array(NM), actAmp = new Float32Array(NM);
  let actN = 0;
  // populations, pooled
  const popPool = [];
  const popOut = [];
  // instance data
  const inst = new Float32Array((CAP + 16) * 16);
  const instOut = { data: inst, count: 0, stride: 16 };
  // wear accumulation
  const WEAR = game.WEAR || 128;
  const wearAcc = new Float32Array(WEAR * WEAR);
  let wearDirty = false, wearClock = 0;

  // births
  const quickBy = new Float32Array(NM);   // quickening per mode: wandering to a neighbour and back loses little
  let birthGap = 0;
  let ghostRec = null, ghostT = 0;        // an extinct kind a cylinder is replaying, and for how long
  let kindsKnown = -1;         // species records, the keeper aside (refreshed in upkeepRecords)
  let drivenNow = false;       // is the player (bow, fork, phonograph) driving the plate this step?
  // the keeper
  let keeperMote = null, keeperSp = null, keeperDue = null;   // seconds of quiet left before she rises
  // rare states
  let choirOn = false, choirT = 0, choirBreakT = 0, choirCool = 20, choirSince = 0;
  const choirIds = [];
  let choirSeats = 0, choirPhase = 0;
  let floorT = 0, floorCool = 0, floorArmed = true, floorOn = false;
  // resting finger tracking
  let holdPu = 0, holdPv = 0, holdSpeed = 0, holdHad = false, holdReach = 0.45, moth = null;
  // dream (darkness) helper
  const dreamOut = [];
  let dreamSp = null, dreamT = 0;

  // --- species ------------------------------------------------------------------------------
  function speciesId(comps, aurata) { return comps.join('|') + (aurata ? '*' : ''); }

  function normComps(comps) {
    const seen = new Set();
    const out = [];
    for (const c of comps) {
      const m = modeById(c);
      if (!m || seen.has(m.id)) continue;
      seen.add(m.id); out.push(m);
    }
    out.sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : 1));
    return out.map((m) => m.id);
  }

  function getSpecies(compsIn, aurata = false, meta = null) {
    const comps = normComps(compsIn);
    if (!comps.length) return null;
    const id = meta?.id || speciesId(comps, aurata);
    let sp = species[id];
    if (sp) return sp;
    const ms = comps.map(modeById);
    const ks = ms.map((m) => m.k);
    const rec = state.species[id];
    let nm;
    if (rec && rec.name) nm = { genus: rec.genus, epithet: rec.epithet, name: rec.name };
    else {
      const taken = (n) => Object.values(state.species).some((r) => r.name === n && r.id !== id) ||
        speciesList.some((o) => o.name === n && o.id !== id);
      nm = nameFor(comps, aurata, 0);
      if (taken(nm.name)) nm = nameFor(comps, aurata, 1);
      if (taken(nm.name)) nm = nameFor(comps, aurata, 2);
      for (let i = 2; taken(nm.name) && i < 40; i++) {         // last resort: a numbered variety
        const base = nameFor(comps, aurata, 2);
        nm = { genus: base.genus, epithet: `${base.epithet} ${ROMAN[i] || i}`, name: `${base.name} ${ROMAN[i] || i}` };
      }
    }
    const cons = new Float32Array(NM), uni = new Uint8Array(NM);
    for (let i = 0; i < NM; i++) {
      let c = 0;
      for (const k of ks) { c += consonance(k, MODES[i].k); if (k === MODES[i].k) uni[i]++; }
      cons[i] = c / ks.length;
    }
    const colors = comps.map((c) => colourFor(c, aurata));
    const hue = new Array(9).fill(0);
    colors.forEach((rgb, i) => { hue[i * 3] = rgb[0]; hue[i * 3 + 1] = rgb[1]; hue[i * 3 + 2] = rgb[2]; });
    const c0 = colors[0];
    sp = {
      id, comps, ks, clan: [...new Set(ks.map(clanOf))].join('·'), name: nm.name, genus: nm.genus, epithet: nm.epithet,
      hue, colors, css: `rgb(${(c0[0] * 255) | 0},${(c0[1] * 255) | 0},${(c0[2] * 255) | 0})`, aurata,
      nc: comps.length, idx: speciesList.length, compIdx: ms.map((m) => m.index), modes: ms, cons, uni,
      gen: meta?.gen ?? rec?.gen ?? 0, parents: meta?.parents ?? rec?.parents ?? null,
      // runtime aggregates
      n: 0, sumE: 0, su: 0, sv: 0, a: 0, feed: 0,
      breathPh: rng.next() * TAU, breathW: TAU / (60 + rng.next() * 120),
    };
    species[id] = sp;
    speciesList.push(sp);
    return sp;
  }

  function rel(a, b) {
    if (a === b) return 1;
    const key = a.idx < b.idx ? a.idx * 65536 + b.idx : b.idx * 65536 + a.idx;
    let c = relCache.get(key);
    if (c === undefined) {
      c = 0;
      for (const x of a.ks) for (const y of b.ks) c += consonance(x, y);
      c /= a.ks.length * b.ks.length;
      relCache.set(key, c);
    }
    return c;
  }

  // Union of two species' components, capped at 3 (keeping the most mutually consonant set).
  function unionComps(a, b) {
    const set = normComps([...a.comps, ...b.comps]);
    if (set.length <= 3) return set;
    let best = null, bv = -1e9;
    for (let i = 0; i < set.length; i++) for (let j = i + 1; j < set.length; j++) for (let k = j + 1; k < set.length; k++) {
      const ks = [set[i], set[j], set[k]].map((id) => modeById(id).k);
      const v = consonance(ks[0], ks[1]) + consonance(ks[0], ks[2]) + consonance(ks[1], ks[2]);
      if (v > bv) { bv = v; best = [set[i], set[j], set[k]]; }
    }
    return best;
  }
  function fusable(a, b) {
    const u = unionComps(a, b);
    const id = speciesId(u, a.aurata || b.aurata);
    return id !== a.id && id !== b.id;
  }

  // A small copying error: one component moves to a neighbouring mode (n±1, m±1, or its mirror).
  // kin: only to a neighbour its kind would not devour (the plate's own song wavers, it does not lie)
  function mutateComps(sp, kin = false) {
    const i = Math.floor(rng.next() * sp.comps.length);
    const m = modeById(sp.comps[i]);
    const opts = [];
    const tryAdd = (n, mm, s) => {
      if (n > mm) [n, mm] = [mm, n];
      if (n < 1 || mm > 7 || (n === 1 && mm === 1)) return;
      if (n === mm) s = 1;
      const id = `${n}.${mm}${s > 0 ? '+' : '-'}`;
      const md = id !== m.id && !sp.comps.includes(id) ? modeById(id) : null;
      if (md && (!kin || consonance(md.k, m.k) > TUNE.eatCons)) opts.push(id);
    };
    if (m.n !== m.m) { tryAdd(m.n, m.m, -m.s); tryAdd(m.n, m.m, -m.s); }   // the mirror, twice: the commonest error
    tryAdd(m.n + 1, m.m, m.s); tryAdd(m.n - 1, m.m, m.s); tryAdd(m.n, m.m + 1, m.s); tryAdd(m.n, m.m - 1, m.s);
    if (!opts.length) return null;
    const comps = sp.comps.slice();
    comps[i] = opts[Math.floor(rng.next() * opts.length)];
    return comps;
  }

  // --- notebook records -----------------------------------------------------------------------
  function recordFor(sp, create = true) {
    let r = state.species[sp.id];
    if (!r && create) {
      const parentNames = sp.parents ? sp.parents.map((p) => state.species[p]?.name || species[p]?.name).filter(Boolean).join(' × ') : null;
      r = state.species[sp.id] = {
        id: sp.id, comps: sp.comps.slice(), ks: sp.ks.slice(), name: sp.name, genus: sp.genus, epithet: sp.epithet,
        clan: sp.clan, firstSeen: Date.now(), firstPlay: Math.round(state.playSeconds || 0), peak: 0, count: 0,
        extinct: false, note: '', parents: sp.parents ? sp.parents.slice() : null, parentNames: parentNames || null,
        gen: sp.gen, aurata: !!sp.aurata, ratio: speciesRatioText(sp), lastSeen: Date.now(), extinctAt: null,
        stats: { births: 0, splits: 0, fusions: 0, devoured: 0, eaten: 0, fell: 0, ageDeaths: 0, hungerDeaths: 0,
          lifeSum: 0, mutants: 0, returns: 0, nestles: 0, choirs: 0 },
      };
      refreshNote(r, sp);
      kindsKnown = -1;
    }
    if (r && !r.stats) r.stats = { births: 0, splits: 0, fusions: 0, devoured: 0, eaten: 0, fell: 0, ageDeaths: 0,
      hungerDeaths: 0, lifeSum: 0, mutants: 0, returns: 0, nestles: 0, choirs: 0 };
    return r;
  }
  function refreshNote(r, sp) {
    try { r.note = noteFor(sp || species[r.id] || r, r, state.stats); } catch { /* keep the old note */ }
  }
  function bump(sp, key, n = 1) {
    const r = recordFor(sp);
    r.stats[key] = (r.stats[key] || 0) + n;
    return r;
  }

  // Announce a species as living (new or returning). Returns isNew.
  function announce(sp, silent = false) {
    const existed = !!state.species[sp.id];
    const r = recordFor(sp);
    if (r.extinct) {
      r.extinct = false; r.extinctAt = null; r.stats.returns = (r.stats.returns || 0) + 1;
      refreshNote(r, sp);
    }
    if (!existed && !silent) bus.emit('species:new', { species: sp });
    return !existed;
  }

  // --- motes ----------------------------------------------------------------------------------
  function makeMote(sp, u, v, e, gen, st = 'born') {
    const a = rng.next() * TAU;
    const life = (TUNE.lifeMin + rng.next() * (TUNE.lifeMax - TUNE.lifeMin)) * (sp.aurata ? TUNE.aurataLife : 1);
    const m = {
      id: nextId++, sp: sp.id, u, v, vx: 0, vy: 0, hx: Math.cos(a), hy: Math.sin(a), e, age: 0, life,
      r: TUNE.rBase * 0.75, state: st, st: 0, gen, born: Date.now(), phase: rng.next(),
      // internal
      spec: sp, dur: st === 'born' ? DUR.born : 0, kx: 0, ky: 0, spd: 0, walkT: 0.5 + rng.next() * 2, turn: 0,
      cool: TUNE.splitCool * (0.5 + rng.next() * 0.5), scool: 0, grace: TUNE.grace, partner: null, cause: null,
      vig: 0.78 + rng.next() * 0.44,   // vigour: some feed better than others, so hunger thins rather than ends a kind
      flash: 0, lunge: 0, hunt: null, huntD: 9, ou: 0, ov: 0, oa: 0, or: 0, nest: false, f: 0, F: 0, near: 0,
      sx: 0, sy: 0, lsx: 0, lsy: 0, near0: 0, gather: 0, cx: 0, cy: 0, dead: false, ring: 0, _flags: 0,
      grip: TUNE.clingBase + TUNE.clingE * clamp(e, 0, 1), calm: 0, thrown: false, shelter: false, comfort: 0,
      keeper: false,
    };
    motes.push(m);
    return m;
  }

  function setState(m, s, dur = 0) { m.state = s; m.st = 0; m.dur = dur; }

  function die(m, cause) {
    if (m.keeper || m.state === 'die' || m.state === 'fall') return;
    m.cause = cause;
    setState(m, 'die', cause === 'age' ? DUR.dieAge : cause === 'eaten' ? DUR.dieEaten : DUR.dieHunger);
    m.hunt = null;
    if (m.partner && m.partner.partner === m && m.partner.state === 'fuse') { setState(m.partner, 'walk'); m.partner.partner = null; }
    if (cause !== 'eaten') m.partner = null;
  }

  // final removal (crumble / swallowed / lost); quiet: no event (the time away keeps its own tally)
  function remove(m, quiet = false) {
    if (m.dead) return;
    m.dead = true;
    const sp = m.spec;
    if (m.cause === 'age') {
      sand?.drop?.(m.u, m.v, 14, 0, 0.025);
      sand?.drop?.(m.u, m.v, 6 + Math.floor(rng.next() * 5), 1, 0.018);
      const r = bump(sp, 'ageDeaths'); r.stats.lifeSum += m.age;
    } else if (m.cause === 'hunger') {
      sand?.drop?.(m.u, m.v, 10, 0, 0.03);
      bump(sp, 'hungerDeaths');
    } else if (m.cause === 'eaten') {
      sand?.drop?.(m.u, m.v, 6, 0, 0.02);
    }
    if (m.cause && !quiet) bus.emit('mote:death', { mote: m, cause: m.cause });
  }

  // --- field sampling (f and grad f, bilinear over central differences) -----------------------
  let SF = 0, SGU = 0, SGV = 0;
  function sampleField(u, v) {
    const G = field.G, g = field.grid;
    const gx = (u + 1) * 0.5 * G - 0.5, gy = (v + 1) * 0.5 * G - 0.5;
    let i0 = Math.floor(gx), j0 = Math.floor(gy);
    if (i0 < 1) i0 = 1; else if (i0 > G - 3) i0 = G - 3;
    if (j0 < 1) j0 = 1; else if (j0 > G - 3) j0 = G - 3;
    const ax = clamp(gx - i0, 0, 1), ay = clamp(gy - j0, 0, 1);
    const w00 = (1 - ax) * (1 - ay), w10 = ax * (1 - ay), w01 = (1 - ax) * ay, w11 = ax * ay;
    const p = j0 * G + i0;
    SF = g[p] * w00 + g[p + 1] * w10 + g[p + G] * w01 + g[p + G + 1] * w11;
    const du = (g[p + 1] - g[p - 1]) * w00 + (g[p + 2] - g[p]) * w10 + (g[p + G + 1] - g[p + G - 1]) * w01 + (g[p + G + 2] - g[p + G]) * w11;
    const dv = (g[p + G] - g[p - G]) * w00 + (g[p + G + 1] - g[p - G + 1]) * w10 + (g[p + 2 * G] - g[p]) * w01 + (g[p + 2 * G + 1] - g[p + 1]) * w11;
    SGU = du * 0.25 * G; SGV = dv * 0.25 * G;   // 0.5 (central diff) × G/2 (grid → plate units)
  }

  // --- per-step aggregates ----------------------------------------------------------------------
  function aggregate() {
    for (const sp of alive) { sp.n = 0; sp.sumE = 0; sp.su = 0; sp.sv = 0; }
    alive.length = 0;
    N = 0;
    if (keeperSp) keeperSp.n = 0;
    for (const m of motes) {
      if (m.dead || m.state === 'die' || m.state === 'fall') continue;
      const sp = m.spec;
      if (m.keeper) { sp.n = 1; sp.sumE = m.e; sp.su = m.u; sp.sv = m.v; continue; }   // she sings nothing into the plate and counts for no choir
      if (sp.n === 0) { sp.sumE = 0; sp.su = 0; sp.sv = 0; alive.push(sp); }
      sp.n++; sp.sumE += m.e; sp.su += m.u; sp.sv += m.v; N++;
    }
  }

  function buildChorus(dark) {
    chorusAmp.fill(0);
    let sum2 = 0;
    for (const sp of alive) {
      const meanE = sp.sumE / sp.n;
      const breath = 1 + TUNE.breathDepth * Math.sin(sp.breathPh + T * sp.breathW);
      let a = TUNE.chorusAmp * (1 - Math.exp(-sp.n / TUNE.chorusCount)) * (1 - TUNE.voiceE + TUNE.voiceE * meanE) * breath;
      if (dark) a *= TUNE.darkVoice;
      if (choirOn) a = Math.max(a, 0.3);
      sp.a = a;
      const per = a / Math.sqrt(sp.nc);
      for (const i of sp.compIdx) chorusAmp[i] += per;
    }
    // they listen: on a mode the bow (or a fork) already drives hard, they sing only into the room left
    extAmp.fill(0);
    if (field.getSource) for (const id of EXT_SOURCES) {
      const src = field.getSource(id);
      if (src) for (const c of src) { const md = modeById(c.mode); if (md) extAmp[md.index] += c.amp || 0; }
    }
    let ext2 = 0;
    for (let i = 0; i < NM; i++) ext2 += extAmp[i] * extAmp[i];
    const hush = 1 - TUNE.hush * clamp(Math.sqrt(ext2) / TUNE.hushAt, 0, 1);   // when the bow speaks, they listen
    for (let i = 0; i < NM; i++) {
      chorusAmp[i] *= hush;
      if (extAmp[i] > 0) chorusAmp[i] = Math.min(chorusAmp[i], Math.max(0, TUNE.voiceRoom - extAmp[i]));
      sum2 += chorusAmp[i] * chorusAmp[i];
    }
    if (hush < 1) for (const sp of alive) sp.a *= hush;
    const tot = Math.sqrt(sum2);
    const scale = tot > TUNE.chorusMax ? TUNE.chorusMax / tot : 1;
    if (scale < 1) { for (let i = 0; i < NM; i++) chorusAmp[i] *= scale; for (const sp of alive) sp.a *= scale; }
    chorusOut.length = 0;
    for (let i = 0; i < NM; i++) {
      const a = chorusAmp[i] * toField;
      if (a > 0.002) { const c = chorusPool[i]; c.amp = Math.round(a * 500) / 500; chorusOut.push(c); }
    }
  }

  // feed per species: what the plate's sound gives each species (own song partly excluded)
  function computeFeed(fromChorus) {
    actN = 0;
    let heard2 = 0;
    const direct = fromChorus ? 0 : 1 - toField;   // the share of their song the bronze does not carry, heard through the air
    for (let i = 0; i < NM; i++) {
      let a = fromChorus ? chorusAmp[i] : (field.ampIndex ? field.ampIndex(i) : field.amp(MODES[i].id));
      if (direct) a += chorusAmp[i] * direct;
      if (a > 0.003) { actIdx[actN] = i; actAmp[actN] = a; actN++; heard2 += a * a; }
    }
    // past a certain loudness they hear no more (an over-driven plate is noise to them, and starves
    // them no faster than a loud one)
    if (heard2 > TUNE.hearMax * TUNE.hearMax) { const k = TUNE.hearMax / Math.sqrt(heard2); for (let q = 0; q < actN; q++) actAmp[q] *= k; }
    // a crowded note is never quite in tune: many voices on one pitch beat against one another,
    // and to those who share that pitch the unison sours
    voicesK.fill(0);
    for (const sp of alive) for (const k of sp.ks) voicesK[k] += sp.n;
    for (const sp of alive) {
      const own = sp.a / Math.sqrt(sp.nc);
      let raw = 0;
      for (let q = 0; q < actN; q++) {
        const i = actIdx[q];
        let a = actAmp[q], mine = 0;
        for (let c = 0; c < sp.compIdx.length; c++) if (sp.compIdx[c] === i) { mine = Math.min(a, own); break; }
        a -= mine;                                    // others' voices count in full, one's own in part
        let term = sp.cons[i];
        if (sp.uni[i]) {
          const k = MODES[i].k;
          const beat = clamp(1 - TUNE.beat * Math.max(0, voicesK[k] - TUNE.beatFrom) / TUNE.beatScale, -0.6, 1);
          term += (beat - 1) * sp.uni[i] / sp.nc;
        }
        raw += (a + mine * (1 - TUNE.selfExclude)) * term;
      }
      sp.feed = clamp(raw / (1 + 0.3 * Math.abs(raw)), -1, 1.2);   // soft saturation keeps rich and richer apart
    }
  }

  // --- the pair pass: separation, kinship, courtship, the hunt ---------------------------------
  function pairPass(dt, dark) {
    const n = motes.length;
    for (let i = 0; i < n; i++) {
      const m = motes[i];
      m.near0 = m.near; m.sx = 0; m.sy = 0; m.near = 0; m.cx = 0; m.cy = 0; m.comfort = 0;
      if (m.hunt && (m.hunt.dead || !FREE[m.hunt.state])) m.hunt = null;
      m.huntD = m.hunt ? Math.hypot(m.hunt.u - m.u, m.hunt.v - m.v) * 0.8 : 9;   // stickiness
    }
    for (let i = 0; i < n; i++) {
      const a = motes[i];
      if (a.dead || a.state === 'die' || a.state === 'fall') continue;
      for (let j = i + 1; j < n; j++) {
        const b = motes[j];
        if (b.dead || b.state === 'die' || b.state === 'fall') continue;
        const dx = b.u - a.u, dy = b.v - a.v;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.16) continue;                   // 0.4²
        const d = Math.sqrt(d2) + 1e-6, ux = dx / d, uy = dy / d;
        if (a.keeper || b.keeper) {
          // the keeper: heavy (the others make room, she does not), never hunted, never courted;
          // near her the others take a little comfort
          const o = a.keeper ? b : a, sg = a.keeper ? 1 : -1;
          const rr = a.r + b.r;
          if (d < rr * 1.5) { const k = 1 - d / (rr * 1.5); o.sx += ux * sg * k * k * 3.2; o.sy += uy * sg * k * k * 3.2; }
          if (d < TUNE.keeperReach) o.comfort = Math.max(o.comfort, 1 - d / TUNE.keeperReach);
          continue;
        }
        if (d < 0.12) {
          a.near++; b.near++;
          a.cx += dx; a.cy += dy; b.cx -= dx; b.cy -= dy;
          if (d < 0.09 && a.spec !== b.spec) {          // a lunge going by makes bystanders jump
            if (a.lunge > 0 && b !== a.hunt && FREE[b.state] && b.scool <= 0) startle(b, 0.1, ux, uy);
            else if (b.lunge > 0 && a !== b.hunt && FREE[a.state] && a.scool <= 0) startle(a, 0.1, -ux, -uy);
          }
        }
        const rr = a.r + b.r;
        if (d < rr * 1.5) {                          // personal space (soft, steeper when touching)
          const k = 1 - d / (rr * 1.5);
          const s = k * k * 3.2;
          a.sx -= ux * s; a.sy -= uy * s; b.sx += ux * s; b.sy += uy * s;
        }
        if (!FREE[a.state] || !FREE[b.state] || choirOn || floorOn) continue;
        if (a.spec === b.spec) {
          if (d > 0.16 && d < 0.34) {                // loners drift toward kin; a company does not condense
            const s = 0.22 * Math.sin(Math.PI * (d - 0.16) / 0.18);
            if (a.near0 < 3) { a.sx += ux * s; a.sy += uy * s; }
            if (b.near0 < 3) { b.sx -= ux * s; b.sy -= uy * s; }
          }
          continue;
        }
        const c = rel(a.spec, b.spec);
        if (c > 0.1) {
          if (d > 0.16 && d < 0.3) {
            const s = 0.16 * c * Math.sin(Math.PI * (d - 0.16) / 0.14);
            if (a.near0 < 3) { a.sx += ux * s; a.sy += uy * s; }
            if (b.near0 < 3) { b.sx -= ux * s; b.sy -= uy * s; }
          }
          if (d < 1.3 * rr && c > TUNE.fuseCons && a.e > TUNE.fuseE && b.e > TUNE.fuseE && !dark &&
              a.grace <= 0 && b.grace <= 0 && rng.next() < TUNE.fuseRate * dt && fusable(a.spec, b.spec)) {
            beginFuse(a, b);
          }
        } else if (c < -0.1) {
          if (d < 0.22) {
            const s = 0.6 * -c * (1 - d / 0.22);
            const sa = a.e < b.e ? 1.6 : 0.8, sb = b.e < a.e ? 1.6 : 0.8;   // the weaker flees harder
            a.sx -= ux * s * sa; a.sy -= uy * s * sa; b.sx += ux * s * sb; b.sy += uy * s * sb;
          }
          if (c < TUNE.eatCons && !dark) {
            const pred = a.e >= b.e ? a : b, prey = pred === a ? b : a;
            if (pred.e > prey.e + 0.04 && pred.e < TUNE.huntE && pred.grace <= 0 && d < pred.huntD) { pred.hunt = prey; pred.huntD = d; }
            if (d < rr && a.grace <= 0 && b.grace <= 0) beginEat(pred, prey);
          }
        }
      }
    }
  }

  function beginFuse(a, b) {
    setState(a, 'fuse', DUR.fuse); setState(b, 'fuse', DUR.fuse);
    a.partner = b; b.partner = a; a.flash = 0; b.flash = 0;
    a.ou = b.ou = (a.u + b.u) * 0.5; a.ov = b.ov = (a.v + b.v) * 0.5;
    a.oa = Math.atan2(a.v - a.ov, a.u - a.ou);
    a.or = Math.max(0.03, Math.hypot(a.u - b.u, a.v - b.v) * 0.5 + 0.012);
    a.hunt = b.hunt = null;
  }

  function beginEat(pred, prey) {
    setState(pred, 'eat', DUR.eat);
    pred.hunt = null; pred.lunge = 0;
    pred.e = Math.min(1, pred.e + TUNE.eatGain * prey.e);
    prey.partner = pred;
    die(prey, 'eaten');
    bump(pred.spec, 'devoured'); bump(prey.spec, 'eaten');
    refreshNote(recordFor(pred.spec), pred.spec); refreshNote(recordFor(prey.spec), prey.spec);
    bus.emit('mote:eat', { pred, prey });
  }

  function merge(a, b) {
    const comps = unionComps(a.spec, b.spec);
    const aur = a.spec.aurata || b.spec.aurata;
    const gen = Math.max(a.spec.gen, b.spec.gen) + 1;
    const sp = getSpecies(comps, aur, { gen, parents: [a.spec.id, b.spec.id] });
    const child = makeMote(sp, a.ou, a.ov, Math.min(1, (a.e + b.e) * 0.5 + 0.05), Math.max(a.gen, b.gen) + 1, 'fuse');
    child.dur = DUR.flash; child.flash = DUR.flash; child.grace = TUNE.grace;
    child.hx = a.hx; child.hy = a.hy;
    a.dead = true; b.dead = true; a.partner = b.partner = null;
    bump(a.spec, 'fusions'); bump(b.spec, 'fusions');
    refreshNote(recordFor(a.spec), a.spec); refreshNote(recordFor(b.spec), b.spec);
    const isNew = announce(sp);
    bump(sp, 'births');
    bus.emit('mote:fuse', { a, b, child, species: sp, isNew });
  }

  function divide(m) {
    sand?.take?.(m.u, m.v, 0.07, TUNE.splitTake);
    let sp = m.spec, mutated = false;
    if (rng.next() < TUNE.mutate) {
      const comps = mutateComps(sp);
      if (comps) { sp = getSpecies(comps, m.spec.aurata, { gen: m.spec.gen + 1, parents: [m.spec.id, m.spec.id] }); mutated = true; }
    }
    const px = -m.hy, py = m.hx;                       // split across the heading
    const child = makeMote(sp, m.u + px * 0.028, m.v + py * 0.028, 0.45, m.gen + 1, 'split');
    child.dur = 0.5; child.hx = px; child.hy = py; child.age = 0;
    m.u -= px * 0.028; m.v -= py * 0.028; m.e = 0.45;
    m.kx -= px * 0.05; m.ky -= py * 0.05; child.kx = px * 0.05; child.ky = py * 0.05;
    m.cool = TUNE.splitCool; child.cool = TUNE.splitCool; m.grace = child.grace = TUNE.grace;
    bump(m.spec, 'splits');
    if (mutated) { bump(m.spec, 'mutants'); announce(sp); bump(sp, 'births'); }
    else bump(sp, 'births');
    refreshNote(recordFor(m.spec), m.spec);
    bus.emit('mote:split', { parent: m, child });
  }

  // --- one singer, one step -------------------------------------------------------------------
  let A = 0, Aslow = 0, Ajump = 0, overdrive = 0, darkNow = false, crowdMul = 1, detuneMul = 1, keeperFirst = false;

  function startle(m, strength, ax, ay) {
    let dx = ax + gauss() * 0.3, dy = ay + gauss() * 0.3;
    const l = Math.hypot(dx, dy) || 1;
    m.kx += (dx / l) * strength; m.ky += (dy / l) * strength;
    setState(m, 'startle', DUR.startle);
    m.scool = 0.9; m.spd *= 0.3; m.hunt = null;
    if (m.nest) m.nest = false;
  }

  // how long a singer can hold on at a violent spot: the strong hold longer
  function gripMax(m) { return TUNE.clingBase + TUNE.clingE * clamp(m.e, 0, 1); }

  // near a resting finger, a landed moth or a felt damper nothing is ever thrown
  function shelterAt(u, v) {
    const h = game.hold;
    if (h && Math.abs(u - h.u) < TUNE.shelterHold && Math.abs(v - h.v) < TUNE.shelterHold &&
        Math.hypot(u - h.u, v - h.v) < TUNE.shelterHold) return true;
    if (moth && Math.hypot(u - moth.u, v - moth.v) < TUNE.shelterHold) return true;
    const ds = field.dampers;
    if (ds && ds.length) for (const d of ds) if (Math.hypot(u - d.u, v - d.v) < (d.r || 0.06) + TUNE.shelterDamper) return true;
    return false;
  }

  // the grip has failed: flung, mostly outward and away from the loudness. Near the rim that is
  // the edge; further in it lands dazed (a little grip back) and will cling again if it must.
  function throwMote(m, V) {
    const gl = Math.hypot(SGU, SGV) || 1, sg = SF > 0 ? -1 : 1;
    const rr = Math.hypot(m.u, m.v) || 1, a = rng.next() * TAU;
    const ax = 0.45 * Math.cos(a) + 0.35 * sg * SGU / gl + m.u / rr, ay = 0.45 * Math.sin(a) + 0.35 * sg * SGV / gl + m.v / rr;
    startle(m, TUNE.throwBase + TUNE.throwV * clamp(V - TUNE.clingV, 0, 1) + TUNE.throwOver * overdrive, ax, ay);
    m.dur = DUR.thrown; m.thrown = true; m.scool = DUR.thrown + 0.6;
    m.grip = gripMax(m) * TUNE.clingDazed;
    bump(m.spec, 'thrown');
    bus.emit('mote:throw', { mote: m });
  }

  // --- the keeper -----------------------------------------------------------------------------
  // After the first Floor, one singer stands up out of the bare bronze at the centre: the
  // fundamental's own creature. She sings nothing into the plate, never eats, fades, fuses or falls,
  // walks the rim clockwise with pauses, and comes first to a still finger.
  function keeperSpecies() {
    if (keeperSp) return keeperSp;
    keeperSp = species[KEEPER_ID] || getSpecies(['floor'], false, { id: KEEPER_ID, gen: 0, parents: null });
    keeperSp.keeper = true;
    return keeperSp;
  }
  // the path she keeps: a rounded square just inside the rim, by polar angle (clockwise on screen =
  // angle rising, since v points down): r(φ) = R / (cos⁸φ + sin⁸φ)^(1/8)
  let RPU = 0, RPV = 0;
  function rimPoint(th) {
    const c = Math.cos(th), s = Math.sin(th), c2 = c * c, s2 = s * s;
    const r = TUNE.keeperRim / Math.pow(c2 * c2 * c2 * c2 + s2 * s2 * s2 * s2, 0.125);
    RPU = r * c; RPV = r * s;
  }
  function summonKeeper(fresh, u = 0, v = 0) {
    if (keeperMote && !keeperMote.dead) return keeperMote;
    const sp = keeperSpecies();
    if (!fresh && u === 0 && v === 0) { rimPoint(rng.next() * TAU); u = RPU; v = RPV; }
    const m = makeMote(sp, u, v, 0.95, 0, fresh ? 'born' : 'walk');
    m.keeper = true; m.life = 1e9; m.dur = fresh ? TUNE.keeperBorn : 0; m.grace = 1e9; m.vig = 1;
    m.r = TUNE.rBase * TUNE.keeperR * (fresh ? 0.5 : 1); m.walkT = 4 + rng.next() * 4;
    keeperMote = m;
    state.seen ||= {};
    state.seen.keeper = true; delete state.seen.keeperDue;
    keeperDue = null;
    const isNew = announce(sp, !fresh);
    const r = recordFor(sp);
    r.keeper = true; r.count = 1; r.peak = Math.max(1, r.peak || 0); r.extinct = false; r.extinctAt = null;
    if (fresh) { bump(sp, 'births'); refreshNote(r, sp); bus.emit('keeper:arrive', { mote: m, species: sp, isNew }); }
    aggregate();
    return m;
  }

  function stepKeeper(m, dt) {
    m.st += dt; m.age += dt;                           // she keeps time, but does not age
    if (m.flash > 0) m.flash -= dt;
    const R0 = TUNE.rBase * TUNE.keeperR;
    m.e = 0.92 + 0.06 * Math.sin(T * 0.37 + m.phase * TAU);
    if (m.state === 'born') {                          // a slow bloom out of the bare bronze
      const k = clamp(m.st / m.dur, 0, 1);
      m.r = R0 * (0.5 + 0.5 * k * k * (3 - 2 * k));
      if (m.st >= m.dur) { setState(m, 'feed'); m.walkT = 2.5 + rng.next() * 1.5; const a = rng.next() * TAU; m.hx = Math.cos(a); m.hy = Math.sin(a); }
      m._flags = 0;
      return;
    }
    m.r = R0;
    const h = game.hold;
    let tu, tv, want = 0, turnRate = 1.6;
    const pace = TUNE.keeperSpeed * (darkNow ? 0.6 : 1);
    if (h && !floorOn) {
      // the still finger: she goes to it first, from anywhere, and sits against it
      const ang = Math.atan2(m.v - h.v, m.u - h.u);
      const R = 0.075 + R0 * 0.8;
      tu = h.u + Math.cos(ang) * R; tv = h.v + Math.sin(ang) * R;
      steer(m, tu, tv);
      if (STD < 0.025 || (m.state === 'nestle' && STD < 0.06)) {
        if (m.state !== 'nestle') { setState(m, 'nestle'); bump(m.spec, 'nestles'); }
        const k = Math.min(1, dt * 1.5);
        m.u += (tu - m.u) * k; m.v += (tv - m.v) * k;   // settle against it, facing in
        tu = h.u; tv = h.v; want = 0; turnRate = 1;
      } else {
        if (m.state !== 'walk') setState(m, 'walk');
        want = Math.min(TUNE.keeperRun, STD * 0.9 + 0.012); turnRate = 2.4;
      }
    } else {
      if (m.state === 'nestle') { setState(m, 'feed'); m.walkT = 2 + rng.next() * 2; }
      // the rim, clockwise, in long patient stretches; at each pause she turns to look in at them.
      // Away from the rim (newly stood up, or back from a finger) she makes for it without pausing.
      const rr = Math.hypot(m.u, m.v);
      rimPoint(Math.atan2(m.v, m.u));
      const offRim = rr < Math.hypot(RPU, RPV) - 0.1;
      m.walkT -= dt;
      if (offRim && !floorOn) { if (m.state !== 'walk') setState(m, 'walk'); m.walkT = Math.max(m.walkT, 6); }
      else if (m.walkT <= 0) {
        if (m.state === 'walk') { setState(m, 'feed'); m.walkT = (3 + rng.next() * 5) * (darkNow ? 1.6 : 1); }
        else { setState(m, 'walk'); m.walkT = 8 + rng.next() * 9; }
      }
      if (floorOn && m.state === 'walk') { setState(m, 'feed'); m.walkT = 3; }
      rimPoint(offRim ? (rr > 0.05 ? Math.atan2(m.v, m.u) : Math.atan2(m.hy, m.hx)) : Math.atan2(m.v, m.u) + 0.32);
      tu = RPU; tv = RPV;
      if (m.state === 'walk') want = offRim ? pace * 2 : pace;
      else { tu = 0; tv = 0; turnRate = 0.5; }       // turned toward the centre, still
    }
    steer(m, tu, tv);
    let dx = STX, dy = STY;
    const rc = Math.hypot(m.u, m.v), rcl = 0.13 + m.r;   // off the clamp, round the felt
    if (rc < rcl && want > 0) { const k = (rcl - rc) / rcl; dx += (m.u / (rc || 1)) * 3 * k; dy += (m.v / (rc || 1)) * 3 * k; }
    const ds = field.dampers;
    if (ds && ds.length && want > 0) for (const d of ds) {
      const ddx = m.u - d.u, ddy = m.v - d.v, dd = Math.hypot(ddx, ddy) || 1, lim = (d.r || 0.06) + 0.06 + m.r;
      if (dd < lim) { const k = (lim - dd) * 14 / dd; dx += ddx * k; dy += ddy * k; }
    }
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-4) {
      const tx = dx / dl, ty = dy / dl;
      let ang = Math.atan2(m.hx * ty - m.hy * tx, m.hx * tx + m.hy * ty);
      const lim = turnRate * dt;
      if (ang > lim) ang = lim; else if (ang < -lim) ang = -lim;
      const c = Math.cos(ang), sn = Math.sin(ang);
      const hx = m.hx * c - m.hy * sn, hy = m.hx * sn + m.hy * c, hl = Math.hypot(hx, hy) || 1;
      m.hx = hx / hl; m.hy = hy / hl;
      if (want > 0) want *= 0.4 + 0.6 * Math.max(0, m.hx * tx + m.hy * ty);
    }
    m.spd += (want - m.spd) * (1 - Math.exp(-dt / 0.8));
    const mvx = m.hx * m.spd, mvy = m.hy * m.spd;
    m.u = clamp(m.u + mvx * dt, -0.9, 0.9); m.v = clamp(m.v + mvy * dt, -0.9, 0.9);
    m.vx += (mvx - m.vx) * Math.min(1, dt * 4); m.vy += (mvy - m.vy) * Math.min(1, dt * 4);
    m.kx = 0; m.ky = 0;
    m._flags = 0;
  }

  // a singer's energy, as it stands: dE/dt = EA - EB·e (scratch outputs, no allocation). Bright
  // singers burn faster, so energy relaxes toward EA/EB rather than running away.
  let EA = 0, EB = 0;
  function energyRates(m) {
    const sp = m.spec;
    let feed = sp.feed;
    if (m.state === 'cling') feed *= feed > 0 ? 0.5 : TUNE.braceHarm;   // pressed to the bronze, it holds its breath
    if (feed < 0 && overdrive > 0) feed *= 1 - TUNE.deafen * overdrive;  // and a screaming plate is din, not discord
    if (feed > 0) {
      const still = clamp(m.F / (A * A + 0.02), 0, 1);
      feed *= m.vig * crowdMul * (1 - TUNE.stillPenalty * still) * (sp.aurata ? 1 : detuneMul);
    }
    const burn = TUNE.metab * (darkNow ? 0.5 : 1) * (1 + TUNE.crowdStress * Math.max(0, m.near - 3));
    EB = burn * TUNE.metabSlope;
    EA = TUNE.feedGain * (feed > 0 ? feed : feed * TUNE.harm) - burn * TUNE.metabBase - TUNE.ageCost * (m.age / m.life);
    if (m.state === 'nestle' && game.hold) EA += 0.01;   // a faint purr against the finger
    if (m.comfort > 0) EA += TUNE.keeperComfort * m.comfort;   // and a little comfort beside the keeper
  }
  function energy(m, dt) {
    energyRates(m);
    m.e = clamp(m.e + (EA - EB * clamp(m.e, 0, 1)) * dt, -0.01, choirOn ? Math.max(0.84, Math.min(m.e, 1)) : 1);   // the choir holds, it does not breed
  }

  // unit vector toward a point, into scratch (no allocation): STX, STY, STD
  let STX = 0, STY = 0, STD = 0;
  function steer(m, tu, tv) {
    const dx = tu - m.u, dy = tv - m.v;
    STD = Math.hypot(dx, dy) || 1e-6;
    STX = dx / STD; STY = dy / STD;
  }

  function stepMote(m, dt) {
    if (m.keeper) { stepKeeper(m, dt); return; }
    const sp = m.spec;
    m.age += dt; m.st += dt;
    if (m.grace > 0) m.grace -= dt;
    if (m.cool > 0) m.cool -= dt;
    if (m.scool > 0) m.scool -= dt;
    if (m.flash > 0) m.flash -= dt;
    if (m.lunge > 0) { m.lunge -= dt; if (m.lunge <= 0) m.lunge = -1.4; }   // lunge, then recover
    else if (m.lunge < 0) m.lunge = Math.min(0, m.lunge + dt);
    const grow = Math.min(1, 0.72 + (m.age / 40) * 0.28);
    m.r = (TUNE.rBase + TUNE.rComp * (sp.nc - 1)) * grow * (0.9 + 0.14 * clamp(m.e, 0, 1));
    const kd = Math.exp(-dt * 3.2);

    switch (m.state) {
      case 'born':                                      // the sand gathers into the body, then it stands
        if (m.gather > 0 && m.st >= (1 - m.gather / 12) * m.dur * 0.8) { sand?.take?.(m.u, m.v, 0.05, 6); m.gather -= 6; }
        if (m.st >= m.dur) { setState(m, 'walk'); m.walkT = 0.6 + rng.next(); }
        return;
      case 'die':
        if (m.cause === 'eaten' && m.partner) {
          const k = Math.min(1, dt * 5);
          m.u += (m.partner.u - m.u) * k; m.v += (m.partner.v - m.v) * k;
        }
        if (m.st >= m.dur) remove(m);
        return;
      case 'fall':
        m.u += m.kx * dt; m.v += m.ky * dt; m.kx *= kd; m.ky *= kd;
        if (m.st >= m.dur) remove(m);
        return;
      case 'split':
        m.u += m.kx * dt; m.v += m.ky * dt; m.kx *= kd; m.ky *= kd;
        if (m.st >= m.dur) {
          if (m.cool <= 0 && m.e > TUNE.splitE * 0.9 && motes.length < CAP) divide(m);
          setState(m, 'walk'); m.walkT = 0.8 + rng.next() * 1.5;
        }
        return;
      case 'eat':
        energy(m, dt);
        if (m.st >= m.dur) { setState(m, 'walk'); m.walkT = 1 + rng.next() * 2; }
        return;
      case 'fuse': {
        if (m.flash > 0 || !m.partner) {              // the new chord, flashing into being
          if (m.st >= m.dur) { setState(m, 'walk'); m.walkT = 1 + rng.next(); m.flash = 0; }
          return;
        }
        const p = m.partner;
        if (p.dead || p.state !== 'fuse' || p.partner !== m) { m.partner = null; setState(m, 'walk'); return; }
        if (m.id < p.id) {                            // the elder of the pair leads the dance
          const k = clamp(m.st / m.dur, 0, 1);
          m.oa += dt * (2.0 + 6.5 * k * k);
          const R = m.or * Math.pow(1 - k, 1.2) + 0.002;
          const c = Math.cos(m.oa), s = Math.sin(m.oa);
          m.u = m.ou + c * R; m.v = m.ov + s * R; p.u = m.ou - c * R; p.v = m.ov - s * R;
          m.hx = -s; m.hy = c; p.hx = s; p.hy = -c;
          if (m.st >= m.dur) merge(m, p);
        }
        return;
      }
    }

    // free states and startle: metabolism, fate, motion
    sampleField(m.u, m.v);
    m.f = SF; m.F = SF * SF;
    // a flinch when the plate suddenly grows loud under it (the bow biting, a tap, a new figure)
    if (Ajump > 0.1 && m.F > 0.015 && FREE[m.state] && m.scool <= 0 && !choirOn && !floorOn && rng.next() < 4 * dt) {
      const gl = Math.hypot(SGU, SGV) || 1, sg = SF > 0 ? -1 : 1;
      startle(m, 0.06 + rng.next() * 0.06, sg * SGU / gl, sg * SGV / gl);
      m.scool = 1.6 + rng.next();
    }
    energy(m, dt);
    if (m.e <= 0) { die(m, 'hunger'); return; }
    if (m.age >= m.life) { die(m, 'age'); return; }

    // violence: a strong antinode under it, or a plate driven past what the bronze can bear
    const V = m.F * A + TUNE.clingOver * overdrive;
    const hold0 = game.hold;
    m.shelter = shelterAt(m.u, m.v);
    // a singer gets its grip back only as the plate calms: while it still screams, a moment's
    // respite on a still line does not undo what the last minutes took
    if (m.state !== 'cling') m.grip = Math.min(gripMax(m), m.grip + TUNE.clingRegen * (1 - overdrive) * dt);
    if (V > TUNE.clingV && FREE[m.state] && !floorOn && !choirOn && !(m.nest && (hold0 || moth))) {
      setState(m, 'cling'); m.calm = 0; m.hunt = null; m.lunge = 0; m.spd *= 0.4;
      bus.emit('mote:cling', { mote: m });
    }

    const kl = 1 - Math.exp(-dt / 0.3);                  // creatures do not twitch at every jostle
    m.lsx += (m.sx - m.lsx) * kl; m.lsy += (m.sy - m.lsy) * kl;
    let dx = 0, dy = 0, want = 0, turnRate = 3.2;
    const e01 = clamp(m.e, 0, 1);
    const base = (TUNE.speedMin + (TUNE.speedMax - TUNE.speedMin) * e01) * (darkNow ? 0.35 : 1);
    const hold = game.hold && holdSpeed < 0.15 && !keeperFirst ? game.hold : null;
    const still = hold || moth;
    const stillReach = hold ? holdReach : 0.5;
    let flags = 0;

    if (m.state === 'startle') {
      if (m.st >= m.dur) { setState(m, 'walk'); m.walkT = 0.3 + rng.next() * 0.8; m.thrown = false; }
      dx = m.hx; dy = m.hy; want = 0;
    } else if (m.state === 'cling') {
      // holding on: pressed to the bronze, trembling, creeping toward the nearest still line. The
      // grip fails only while the player keeps the plate violent, and never near a still point.
      if (V < TUNE.clingV * 0.8 || floorOn || choirOn) m.calm += dt; else m.calm = 0;
      if (m.calm > TUNE.clingCalm) {
        setState(m, 'walk'); m.walkT = 0.5 + rng.next() * 1.2; m.scool = Math.max(m.scool, 0.5);
        dx = m.hx; dy = m.hy; want = base * 0.5;
      } else {
        if (m.calm === 0 && drivenNow && !m.shelter) {
          m.grip -= dt * (TUNE.clingDrain + TUNE.clingDrainV * clamp((V - TUNE.clingV) / 0.6, 0, 1));
          // and never before it has visibly held on for a while this time (longer if strong)
          if (m.grip <= 0 && m.st >= TUNE.clingMin + TUNE.clingMinE * e01) { throwMote(m, V); return; }
        }
        const gn = Math.hypot(SGU, SGV);
        if (gn > 1e-3) { const sg = SF > 0 ? -1 : 1; dx = sg * SGU / gn; dy = sg * SGV / gn; } else { dx = m.hx; dy = m.hy; }
        dx += m.lsx * 0.3; dy += m.lsy * 0.3;
        want = base * TUNE.clingCreep; turnRate = 5;
        flags |= FLAG.cling;
      }
    } else if (choirOn) {
      // the ring: everyone floats to their place, slowly turning together
      const ang = (m.ring / Math.max(1, choirSeats)) * TAU + choirPhase + T * 0.05;
      const tu = Math.cos(ang) * 0.55, tv = Math.sin(ang) * 0.55;
      steer(m, tu, tv);
      const d = STD;
      dx = STX; dy = STY; want = Math.min(0.24, d * 1.8); turnRate = 6;
      m.state = d < 0.03 ? 'feed' : 'walk';
      if (d < 0.03) { dx = -tu; dy = -tv; }
    } else if (floorOn) {
      // the floor: the whole plate one antinode; they retreat to the still rim and wait
      const rr = Math.hypot(m.u, m.v) || 1;
      const tu = (m.u / rr) * 0.84, tv = (m.v / rr) * 0.84;
      steer(m, tu, tv);
      const d = STD;
      dx = STX; dy = STY; want = Math.min(0.12, d * 1.5); turnRate = 4;
      m.state = d < 0.03 ? 'feed' : 'walk';
    } else if (still && (m.nest || Math.hypot(m.u - still.u, m.v - still.v) < stillReach) && m.e > 0.05) {
      // the resting finger (or a landed moth): come close and settle in a ring against it
      if (!m.nest) { m.nest = true; if (still === hold) bump(sp, 'nestles'); }
      const ang = Math.atan2(m.v - still.v, m.u - still.u);
      const R = (still === hold ? 0.07 : 0.09) + m.r * 0.7;
      const tu = still.u + Math.cos(ang) * R, tv = still.v + Math.sin(ang) * R;
      steer(m, tu, tv);
      const d = STD;
      dx = STX + m.lsx * 0.6; dy = STY + m.lsy * 0.6;
      if (d < 0.02) {
        if (m.state !== 'nestle') setState(m, 'nestle');
        want = 0; dx = still.u - m.u; dy = still.v - m.v;
        m.u += m.lsx * 0.12 * dt; m.v += m.lsy * 0.12 * dt;   // jostle for room
      } else {
        if (m.state !== 'walk') setState(m, 'walk');
        want = Math.min(base * 1.4, d * 1.5 + 0.02);
      }
    } else {
      if (m.nest) { m.nest = false; if (m.state === 'nestle') setState(m, 'walk'); }
      // ordinary life: walk the still lines in purposeful stretches, pause, look about
      m.walkT -= dt;
      const hungry = e01 < 0.35;
      if (m.hunt) {
        if (m.state !== 'walk') setState(m, 'walk');
        m.walkT = Math.max(m.walkT, 0.5);
      } else if (m.walkT <= 0) {
        if (m.state === 'walk') {
          setState(m, darkNow ? 'sleep' : 'feed');
          m.walkT = darkNow ? 3 + rng.next() * 6 : (0.5 + rng.next() * 2.2) * (hungry ? 0.6 : 1.25);
        } else {
          setState(m, 'walk');
          m.walkT = darkNow ? 1 + rng.next() * 2 : (1.6 + rng.next() * 4.5) * (hungry ? 1.5 : 1);
          m.turn += gauss() * 1.4;
        }
      }
      if (darkNow && m.state === 'feed') m.state = 'sleep';
      if (!darkNow && m.state === 'sleep') m.state = 'feed';
      // wake if the ground under a resting singer has turned loud
      if (m.state !== 'walk' && m.F / (A * A + 0.02) > 0.3 && A > 0.08) { setState(m, 'walk'); m.walkT = 1 + rng.next(); }

      const moving = clamp(m.spd / Math.max(0.01, base), 0.15, 1);
      m.turn += (-m.turn * 1.6 + gauss() * 1.1 * moving) * dt;
      const ct = Math.cos(m.turn * dt), stt = Math.sin(m.turn * dt);
      const hx = m.hx * ct - m.hy * stt, hy = m.hx * stt + m.hy * ct;
      m.hx = hx; m.hy = hy;
      dx = m.hx; dy = m.hy;
      const crowd = 1 / (1 + 0.35 * Math.max(0, m.near - 2));   // in a crush, the line matters less than room
      const rc0 = Math.hypot(m.u, m.v);
      const nearClamp = clamp((rc0 - 0.12) / 0.12, 0, 1);       // and the clamp's surroundings are no place to linger
      if (A > 0.025) {
        const gn = Math.hypot(SGU, SGV);
        if (gn > 1e-3) {
          let tx = -SGV / gn, ty = SGU / gn;
          if (tx * m.hx + ty * m.hy < 0) { tx = -tx; ty = -ty; }
          const dn = Math.abs(SF) / gn;                 // distance to the nearest still line
          const pull = clamp(dn / 0.022, 0, 2.6) * crowd * nearClamp;
          const sg = SF > 0 ? -1 : 1;
          dx += tx * 0.95 + sg * (SGU / gn) * pull * 1.35;
          dy += ty * 0.95 + sg * (SGV / gn) * pull * 1.35;
        }
      }
      dx += m.lsx; dy += m.lsy;
      if (m.near >= 4) { const cl = Math.hypot(m.cx, m.cy) || 1; dx -= (m.cx / cl) * 0.5 * (m.near - 3); dy -= (m.cy / cl) * 0.5 * (m.near - 3); }
      want = m.state === 'walk' ? base : 0;
      if (m.hunt) {
        steer(m, m.hunt.u, m.hunt.v);
        dx += STX * 2.6; dy += STY * 2.6;
        want = base * 1.25;
        if (STD < 0.14 && m.lunge === 0) m.lunge = 0.45;
        if (m.lunge > 0) { want = base * 3.2; turnRate = 7; flags |= FLAG.lunge; }
      }
      if (m.state !== 'walk') {                       // standing: shuffle aside only if crowded
        const push = Math.hypot(m.lsx, m.lsy);
        if (push > 0.8) { m.u += m.lsx * 0.02 * dt; m.v += m.lsy * 0.02 * dt; }
      }
    }

    // obstacles: clamp, dampers, edges (all states except floating)
    const rc = Math.hypot(m.u, m.v);
    const rcl = 0.13 + m.r;
    if (rc < rcl) { const k = (rcl - rc) / rcl; const s = (2 + 40 * k) * k / (rc || 1); dx += m.u * s; dy += m.v * s; }
    const dampers = field.dampers;
    if (dampers && dampers.length) for (const dmp of dampers) {
      if (moth && Math.abs(dmp.u - moth.u) < 0.02 && Math.abs(dmp.v - moth.v) < 0.02) continue;   // the moth is welcome
      const ddx = m.u - dmp.u, ddy = m.v - dmp.v, dd = Math.hypot(ddx, ddy) || 1, lim = (dmp.r || 0.06) + 0.1;
      if (dd < lim) { const s = (lim - dd) * 18 / dd; dx += ddx * s; dy += ddy * s; }
    }
    if (!choirOn) {                                   // the rim is felt long before it is reached
      if (m.u > 0.84) dx -= (m.u - 0.84) * 40; else if (m.u < -0.84) dx -= (m.u + 0.84) * 40;
      if (m.v > 0.84) dy -= (m.v - 0.84) * 40; else if (m.v < -0.84) dy -= (m.v + 0.84) * 40;
    }

    // heading turns toward the desire at a limited rate; speed eases
    const dl = Math.hypot(dx, dy);
    if (dl > 1e-4) {
      const tx = dx / dl, ty = dy / dl;
      const cr = m.hx * ty - m.hy * tx, dt2 = m.hx * tx + m.hy * ty;
      let ang = Math.atan2(cr, dt2);
      const lim = turnRate * dt;
      if (ang > lim) ang = lim; else if (ang < -lim) ang = -lim;
      const c = Math.cos(ang), s = Math.sin(ang);
      const hx = m.hx * c - m.hy * s, hy = m.hx * s + m.hy * c;
      const hl = Math.hypot(hx, hy) || 1;
      m.hx = hx / hl; m.hy = hy / hl;
      if (want > 0) want *= 0.35 + 0.65 * Math.max(0, dt2);   // slow down to turn
    }
    m.spd += (want - m.spd) * (1 - Math.exp(-dt / 0.28));
    const mvx = m.hx * m.spd + m.kx, mvy = m.hy * m.spd + m.ky;
    m.u += mvx * dt; m.v += mvy * dt;
    m.kx *= kd; m.ky *= kd;
    m.vx += (mvx - m.vx) * Math.min(1, dt * 8); m.vy += (mvy - m.vy) * Math.min(1, dt * 8);
    m._flags = flags;

    if (m.state !== 'startle' || !m.thrown || m.shelter) {   // only a throw carries a singer over the edge
      if (m.u > 0.94) { m.u = 0.94; if (m.hx > 0) m.hx = -m.hx * 0.5; }
      else if (m.u < -0.94) { m.u = -0.94; if (m.hx < 0) m.hx = -m.hx * 0.5; }
      if (m.v > 0.94) { m.v = 0.94; if (m.hy > 0) m.hy = -m.hy * 0.5; }
      else if (m.v < -0.94) { m.v = -0.94; if (m.hy < 0) m.hy = -m.hy * 0.5; }
    }
    if (Math.abs(m.u) > 1.02 || Math.abs(m.v) > 1.02) {
      setState(m, 'fall', DUR.fall);
      m.cause = 'fall'; m.hunt = null; m.nest = false; m.thrown = false;
      m.kx = mvx * 0.6; m.ky = mvy * 0.6;
      bump(sp, 'fell');
      bus.emit('mote:fall', { mote: m });
      return;
    }

    // division, when well fed and standing in sand
    if (m.e > TUNE.splitE && m.age > TUNE.splitAge && m.cool <= 0 && !darkNow && !choirOn && !floorOn &&
        motes.length < CAP && (m.state === 'feed' || m.state === 'walk') && !m.hunt) {
      if ((sand?.countNear?.(m.u, m.v, 0.06) ?? 0) >= TUNE.splitSand) setState(m, 'split', DUR.split);
      else m.cool = 2;                                  // look again shortly
    }
  }

  // --- birth from the plate -------------------------------------------------------------------
  function nearHealedSeam(u, v) {
    const cracks = state.plate?.cracks;
    if (!cracks) return false;
    for (const c of cracks) if (c.healed && c.pts && distToPolyline(u, v, c.pts) <= 0.05) return true;
    return false;
  }

  function knownKinds() {
    if (kindsKnown < 0) { kindsKnown = 0; for (const id in state.species) if (id !== KEEPER_ID) kindsKnown++; }
    return kindsKnown;
  }

  // is anything but the singers driving the plate? (bow, fork, phonograph)
  function isDriven() {
    if (!field.getSource) return true;
    for (const id of PLAYER_SOURCES) {
      const src = field.getSource(id);
      if (src) for (const c of src) if ((c.amp || 0) > 0.05) return true;
    }
    return false;
  }

  // the mode the player is sounding loudest (bow, fork, phonograph), or -1
  function heldMode() {
    if (!drivenNow || !field.getSource) return -1;
    let best = -1, ba = 0.05;
    for (const sid of PLAYER_SOURCES) {
      const src = field.getSource(sid);
      if (src) for (const c of src) if (c.amp > ba) { const md = modeById(c.mode); if (md) { ba = c.amp; best = md.index; } }
    }
    return best;
  }
  // how hard the player holds one mode (bow, fork and phonograph together); FORKED: a touched
  // tuning fork is sounding it
  let FORKED = false;
  function driveOn(id) {
    FORKED = false;
    if (!field.getSource) return 0;
    let a = 0;
    for (const sid of PLAYER_SOURCES) {
      const src = field.getSource(sid);
      if (src) for (const c of src) if (c.mode === id && c.amp > 0) { a += c.amp; if (sid === 'fork' && c.amp > 0.05) FORKED = true; }
    }
    return a;
  }

  // A cylinder replaying the figure of a vanished kind brings it back quickly, even played softly,
  // and a chord as readily as a single note: the extinct record whose every voice the wax is
  // sounding (the fullest such chord first), held while those voices together hold the plate.
  let GHOST_SHARE = 0, GHOST_DRIVE = 0;
  function findGhost(dt) {
    const src = drivenNow && field.getSource ? field.getSource('phono') : null;
    let best = null, bestMin = 0;
    if (src && src.length) {
      let top = 0;
      for (const c of src) if (c.amp > top) top = c.amp;
      for (const id in state.species) {
        const r = state.species[id];
        if (!r || !r.extinct || r.aurata || r.keeper || id === KEEPER_ID || !Array.isArray(r.comps) || !r.comps.length) continue;
        let mn = Infinity, a2 = 0;
        for (const cm of r.comps) {
          let a = 0;
          for (const c of src) if (c.mode === cm) { a = c.amp; break; }
          if (!(a > 0.04 && a >= 0.3 * top)) { mn = 0; break; }
          if (a < mn) mn = a;
          a2 += a * a;
        }
        if (mn > 0 && (!best || r.comps.length > best.comps.length || (r.comps.length === best.comps.length && mn > bestMin))) { best = r; bestMin = mn; GHOST_DRIVE = Math.sqrt(a2); }
      }
    }
    if (best !== ghostRec) { ghostRec = best; ghostT = 0; }
    if (!best) return null;
    let s2 = 0;
    for (const cm of best.comps) { const a = field.amp ? field.amp(cm) : 0; s2 += a * a; }
    GHOST_SHARE = field.total > 1e-3 ? s2 / (field.total * field.total) : 0;
    ghostT = GHOST_SHARE > TUNE.birthShare ? ghostT + dt : 0;
    return best;
  }

  // every mode but the one the plate is holding, and the one the player is still sounding (a
  // fading fork, a figure settling again), forgets its quickening, slowly
  function fadeQuick(dt, keep, held) {
    const d = TUNE.quickDecay * dt;
    for (let i = 0; i < NM; i++) if (i !== keep && i !== held && quickBy[i] > 0) quickBy[i] = Math.max(0, quickBy[i] - d);
  }

  function tryBirth(dt) {
    birthGap -= dt;
    const coh = field.coherence || {};
    const dom = coh.dominant ? modeById(coh.dominant) : null;
    const lightOn = game.light ? game.light.on !== false : true;
    const driven = drivenNow;
    const awake = lightOn && !floorOn && !choirOn;
    const ghost = awake ? findGhost(dt) : null;
    let share = coh.share, stable = coh.stable, drive = 0, early = false, forked = false;
    if (ghost) { share = GHOST_SHARE; stable = ghostT; drive = GHOST_DRIVE; early = true; }
    else if (driven && dom) {
      // the player's own note wins the plate however softly it is played (the singers hush for
      // it); the plate is eager while it is young, and a touched fork always quickens its mode
      drive = driveOn(dom.id); forked = FORKED;
      early = drive > 0 && (forked || knownKinds() < TUNE.earlyKinds);
    }
    const minTotal = drive > 0 ? TUNE.driveFrom : driven ? TUNE.birthTotal : TUNE.songTotal;
    const coherent = dom && !dom.special && dom.k >= 5 && awake && stable > (early ? TUNE.earlyStable : TUNE.birthStable) &&
      share > TUNE.birthShare && field.total > minTotal;
    const held = heldMode();
    if (!coherent) { fadeQuick(dt, -1, held); return; }
    const domSp = species[dom.id];
    const familiar = domSp && domSp.n > 0;
    let rate;
    if (drive > 0) {
      // a new form at driveGestation, a familiar one (its kind already alive) at its quicker pace
      const gest = forked ? TUNE.forkGestation : early ? TUNE.earlyGestation
        : familiar ? TUNE.gestation / TUNE.familiar : TUNE.driveGestation;
      rate = clamp((drive - TUNE.driveFrom) / TUNE.driveRange, 0, 1) * clamp((share - 0.5) / 0.25, 0, 1) / gest;
    } else {
      // the plate's own song: a new form a little sooner while the plate is young (fewer than
      // earlyKinds known), a familiar one at its usual, quicker pace
      const gest = familiar ? TUNE.gestation / TUNE.familiar : knownKinds() < TUNE.earlyKinds ? TUNE.gestationFew : TUNE.gestation;
      rate = clamp((field.total - minTotal + 0.08) / 0.6, 0, 1.4) * clamp((share - 0.5) / 0.3, 0, 1) / gest;
    }
    if (!driven) {                                   // a starving choir quickens nothing
      let se = 0, sn = 0;
      for (const sp of alive) { se += sp.sumE; sn += sp.n; }
      rate *= clamp((se / Math.max(1, sn) - 0.15) / 0.25, 0, 1);
      rate *= Math.pow(Math.max(0, 1 - N / TUNE.songCrowd), 1.5);
    }
    rate *= Math.pow(Math.max(0, 1 - motes.length / CAP), 0.35);
    const qi = dom.index;
    fadeQuick(dt, qi, held);
    quickBy[qi] += rate * dt;
    if (quickBy[qi] < 1 || birthGap > 0 || motes.length >= CAP) return;

    // choose a pile of sand on a still line
    const peaks = sand?.peaks?.(TUNE.peakMin) || [];
    let best = null, bw = 0;
    const A0 = Math.max(0.05, field.total);
    for (const p of peaks) {
      if (Math.abs(p.u) > 0.86 || Math.abs(p.v) > 0.86 || Math.hypot(p.u, p.v) < 0.14) continue;
      let ok = true;
      for (const dmp of field.dampers || []) if (Math.hypot(p.u - dmp.u, p.v - dmp.v) < (dmp.r || 0.06) + 0.04) ok = false;
      for (const m of motes) if (!m.dead && Math.abs(m.u - p.u) < 0.07 && Math.abs(m.v - p.v) < 0.07) ok = false;
      if (!ok) continue;
      sampleField(p.u, p.v);
      // where still lines cross, the piled sand coalesces best
      let w = (p.score ?? p.n) * (p.cross !== undefined ? 0.3 + p.cross : 1) / (1 + 10 * Math.abs(SF) / A0);
      if (nearHealedSeam(p.u, p.v)) w *= 4;
      w *= 0.6 + rng.next() * 0.8;
      if (w > bw) { bw = w; best = p; }
    }
    if (!best) return;

    let comps = [dom.id];
    if (ghost) comps = ghost.comps.slice();          // the vanished kind itself, chord and all
    else {
      const sec = coh.second ? modeById(coh.second) : null;
      if (sec && !sec.special && sec.k >= 5 && coh.secondShare > TUNE.hybridShare && consonance(dom.k, sec.k) > 0) comps.push(sec.id);
    }
    const aur = nearHealedSeam(best.u, best.v);
    let sp = getSpecies(comps, aur, ghost ? { gen: ghost.gen || 0, parents: ghost.parents || null } : { gen: comps.length > 1 ? 1 : 0, parents: null });
    if (!sp) return;
    if (!driven && rng.next() < TUNE.songWaver) {
      const mc = mutateComps(sp, true);
      if (mc) sp = getSpecies(mc, aur, { gen: sp.gen + 1, parents: [sp.id, sp.id] });
    }
    sand?.take?.(best.u, best.v, 0.05, 6);            // the rest is drawn in while it forms
    const m = makeMote(sp, best.u, best.v, TUNE.newbornE, 0, 'born');
    m.gather = 12;
    quickBy[qi] -= TUNE.quickDrop;
    birthGap = TUNE.birthGap;
    const isNew = announce(sp);
    bump(sp, 'births');
    bus.emit('mote:birth', { mote: m, species: sp, isNew });
  }

  // --- rare states ----------------------------------------------------------------------------
  function checkChoir(dt) {
    if (choirCool > 0) choirCool -= dt;
    if (choirOn) {
      choirT += dt;
      const ok = choirCondition() && !isDriven();      // a bow breaks the spell
      choirBreakT = ok ? 0 : choirBreakT + dt;
      if (choirBreakT > TUNE.choirBreak || choirT > TUNE.choirLen) endChoir();
      return;
    }
    if (choirCool > 0 || floorOn) { choirSince = 0; return; }
    choirSince = !isDriven() && choirCondition() ? choirSince + dt : 0;
    if (choirSince > TUNE.choirHold) startChoir();
  }
  // the choir: the largest group of mutually consonant species (greedy, most numerous first)
  // must number at least three species and hold most of the plate
  const choirScratch = [], choirSet = [];
  function choirCondition() {
    if (N < TUNE.choirPop) return false;
    choirScratch.length = 0; choirSet.length = 0;
    for (const sp of alive) if (sp.n >= 2) choirScratch.push(sp);
    if (choirScratch.length < TUNE.choirMin) return false;
    choirScratch.sort(byCountDesc);
    let pop = 0;
    for (const sp of choirScratch) {
      let ok = true;
      for (const o of choirSet) if (rel(sp, o) <= TUNE.choirCons) { ok = false; break; }
      if (ok) { choirSet.push(sp); pop += sp.n; }
    }
    if (choirSet.length < TUNE.choirMin || pop < TUNE.choirPop || pop < 0.7 * N) return false;
    const k0 = choirSet[0].ks[0];                     // a chord, not a unison
    for (const sp of choirSet) for (const k of sp.ks) if (k !== k0) return true;
    return false;
  }
  function startChoir() {
    choirOn = true; choirT = 0; choirBreakT = 0;
    choirIds.length = 0;
    for (const sp of choirSet) choirIds.push(sp.id);
    // seats on the ring: grouped by species, the groups ordered by where each species stands,
    // and the whole ring turned to sit as close as it can to where everyone already is
    const list = motes.filter((m) => !m.dead && !m.keeper && m.state !== 'die' && m.state !== 'fall');
    const spAng = (sp) => Math.atan2(sp.sv, sp.su);
    const angOf = (m) => Math.atan2(m.v, m.u);
    list.sort((a, b) => (a.spec === b.spec ? angOf(a) - angOf(b) : spAng(a.spec) - spAng(b.spec)));
    choirSeats = list.length;
    let cs = 0, sn = 0;
    list.forEach((m, i) => {
      const d = angOf(m) - (i / choirSeats) * TAU;
      cs += Math.cos(d); sn += Math.sin(d);
      m.ring = i; m.hunt = null; m.nest = false;
      if (m.state === 'fuse' && !m.flash) { m.partner = null; setState(m, 'walk'); }
    });
    choirPhase = Math.atan2(sn, cs) - T * 0.05;
    for (const id of choirIds) bump(species[id], 'choirs');
    bus.emit('life:choir', { on: true, species: choirIds.slice() });
  }
  function endChoir() {
    choirOn = false; choirCool = TUNE.choirCool; choirSince = 0;
    for (const m of motes) { if (m.state === 'feed') { m.walkT = 0.5 + rng.next() * 2; } }
    stagger();
    bus.emit('life:choir', { on: false, species: choirIds.slice() });
  }

  function checkFloor(dt) {
    if (floorCool > 0) floorCool -= dt;
    const fl = field.amp ? field.amp('floor') : 0;
    const wasFloor = floorOn;
    floorOn = fl > 0.2;
    if (wasFloor && !floorOn) stagger();               // fed by the floor, they do not all divide at once after it
    let have = 0;
    for (const k of TUNE.floorKs) {
      for (const sp of alive) if (sp.ks.includes(k)) { have++; break; }
    }
    const full = have === TUNE.floorKs.length;
    if (full && floorArmed && floorCool <= 0) {
      floorT += dt;
      if (floorT > TUNE.floorHold) {
        floorArmed = false; floorT = 0; floorCool = TUNE.floorCool;
        if (choirOn) endChoir();
        bus.emit('life:floor', { on: true });
      }
    } else floorT = 0;
    if (!full && !floorArmed && floorCool <= 0) { floorArmed = true; bus.emit('life:floor', { on: false }); }
  }

  // --- records upkeep -------------------------------------------------------------------------
  let recClock = 0;
  function upkeepRecords(dt) {
    recClock += dt;
    for (const sp of alive) {
      const r = state.species[sp.id];
      if (!r) continue;
      r.count = sp.n;
      if (sp.n > r.peak) {
        const before = r.peak;
        r.peak = sp.n;
        if ((before < 8 && sp.n >= 8) || (before < 12 && sp.n >= 12)) refreshNote(r, sp);
      }
    }
    if (recClock < 0.5) return;
    recClock = 0;
    kindsKnown = -1;
    const now = Date.now();
    for (const sp of speciesList) {
      const r = state.species[sp.id];
      if (!r) continue;
      if (sp.n > 0) { r.lastSeen = now; continue; }
      if (r.count !== 0) r.count = 0;
      if (!r.extinct && !anyMoteOf(sp)) {
        r.extinct = true; r.extinctAt = now;
        refreshNote(r, sp);
        bus.emit('species:extinct', { species: sp });
      }
    }
  }
  function anyMoteOf(sp) { for (const m of motes) if (!m.dead && m.spec === sp) return true; return false; }
  // every record agrees with the plate (after aggregate()): a kind with no living singer is
  // extinct, whatever became of its last one (crumbling as the plate was saved, say)
  function settleRecords(now = Date.now()) {
    for (const id in state.species) {
      const r = state.species[id];
      if (!r || typeof r !== 'object' || r.keeper || id === KEEPER_ID) continue;
      const n = species[id]?.n || 0;
      r.count = n;
      if (n > 0) r.extinct = false;
      else if (!r.extinct) { r.extinct = true; r.extinctAt ||= now; }
    }
  }
  function compactMotes() {
    let w = 0;
    for (let i = 0; i < motes.length; i++) { const m = motes[i]; if (!m.dead) motes[w++] = m; }
    motes.length = w;
  }
  function livingCount() { let n = 0; for (const m of motes) if (!m.dead && !m.keeper && m.state !== 'die' && m.state !== 'fall') n++; return n; }

  // --- wear: walking polishes the bronze ------------------------------------------------------
  function wearStep(dt) {
    const wear = game.wear;
    if (!wear) return;
    const add = dt * 2;                                   // +1 per half second on a texel
    for (const m of motes) {
      if (m.dead || m.state === 'fall' || m.state === 'born') continue;
      const gx = (m.u + 1) * 0.5 * WEAR - 0.5, gy = (m.v + 1) * 0.5 * WEAR - 0.5;
      const i0 = Math.floor(gx), j0 = Math.floor(gy);
      for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const i = i0 + di, j = j0 + dj;
        if (i < 0 || j < 0 || i >= WEAR || j >= WEAR) continue;
        const p = j * WEAR + i;
        let a = wearAcc[p] + add;
        if (a >= 1) {
          a -= 1;
          if (wear[p] < 255) { wear[p]++; wearDirty = true; }
        }
        wearAcc[p] = a;
      }
    }
    wearClock += dt;
    if (wearDirty && wearClock >= 0.25) { wearClock = 0; wearDirty = false; game.wearVersion = (game.wearVersion || 0) + 1; }
  }

  function stagger() { for (const m of motes) m.cool = Math.max(m.cool, rng.next() * TUNE.splitCool); }

  // --- event reactions ------------------------------------------------------------------------
  const offs = [];
  offs.push(bus.on('plate:tap', (p) => {
    if (!p) return;
    for (const m of motes) {
      if (!FREE[m.state] || m.keeper) continue;
      const dx = m.u - p.u, dy = m.v - p.v, d = Math.hypot(dx, dy);
      if (d < 0.38) startle(m, 0.12 + 0.25 * (p.strength ?? 1) * (1 - d / 0.38), dx / (d || 1), dy / (d || 1));
    }
  }));
  offs.push(bus.on('damper:place', (p) => {
    if (!p) return;
    for (const m of motes) {
      if (!FREE[m.state] || m.keeper) continue;
      const dx = m.u - p.u, dy = m.v - p.v, d = Math.hypot(dx, dy);
      if (d < 0.25) startle(m, 0.15, dx / (d || 1), dy / (d || 1));
    }
  }));
  // the first time the Floor falls quiet, the keeper stands up out of the bare bronze
  offs.push(bus.on('floor:end', () => {
    state.seen ||= {};
    if (state.seen.keeper || keeperMote) return;
    state.seen.keeperDue = true;
    keeperDue = TUNE.keeperDelay;
  }));

  // --- main update ----------------------------------------------------------------------------
  function update(dt) {
    if (!(dt > 0)) return;
    T += dt;
    const wasDark = darkNow;
    darkNow = game.light ? game.light.on === false : false;
    if (wasDark && !darkNow) stagger();               // waking: not everyone divides at once
    const voiceT = darkNow ? TUNE.darkField : 1;      // hushed at once in the dark; full voice comes back slowly
    toField += (voiceT - toField) * (1 - Math.exp(-dt / (voiceT > toField ? TUNE.wakeVoice : 0.5)));
    if (Math.abs(voiceT - toField) < 1e-3) toField = voiceT;
    A = field.total || 0;
    Ajump = A - Aslow;
    overdrive = clamp((A - TUNE.overdriveA) / 0.4, 0, 1);
    Aslow += (A - Aslow) * (1 - Math.exp(-dt / 0.6));
    detuneMul = Math.max(0.5, 1 - TUNE.detunePenalty * (field.detune || 0));

    // resting finger speed
    const h = game.hold;
    if (h) {
      if (holdHad) holdSpeed += (Math.hypot(h.u - holdPu, h.v - holdPv) / dt - holdSpeed) * Math.min(1, dt * 6);
      else holdSpeed = 0;
      holdPu = h.u; holdPv = h.v; holdHad = true;
      const held = Number.isFinite(h.t) && Number.isFinite(game.t) ? Math.max(0, game.t - h.t) : 0;
      holdReach = 0.45 + Math.min(0.4, held * 0.03);    // the longer the stillness, the further it calls
    } else { holdHad = false; holdSpeed = 0; holdReach = 0.45; }
    drivenNow = isDriven();

    // the keeper: due after the first Floor (when the plate is quiet and lit), and always present after
    if (!keeperMote || keeperMote.dead) {
      keeperMote = null;
      if (state.seen?.keeper) summonKeeper(false);
      else if (state.seen?.keeperDue) {
        // she rises keeperDelay seconds after the low note has died away, and only in the light
        if (keeperDue === null) keeperDue = TUNE.keeperDelay;
        if (!darkNow && !(field.amp && field.amp('floor') > 0.2)) keeperDue -= dt;
        if (keeperDue <= 0) summonKeeper(true);
      }
    }
    // she comes to a still finger first; the others wait for her (a while)
    keeperFirst = false;
    if (h && keeperMote && keeperMote.state !== 'born') {
      const held = Number.isFinite(h.t) && Number.isFinite(game.t) ? Math.max(0, game.t - h.t) : 99;
      keeperFirst = keeperMote.state !== 'nestle' && Math.hypot(keeperMote.u - h.u, keeperMote.v - h.v) > 0.24 && held < TUNE.keeperWait;
    }

    // a moth resting on the plate is a small, temporary stillness (tools may expose it either way)
    const mo = game.moth || game.tools?.moth;
    moth = mo && (mo.landed || mo.state === 'land' || mo.state === 'landed') && Number.isFinite(mo.u) && Number.isFinite(mo.v) &&
      Math.abs(mo.u) < 1 && Math.abs(mo.v) < 1 ? mo : null;

    aggregate();
    crowdMul = crowdOf(N);
    buildChorus(darkNow);
    computeFeed(false);
    pairPass(dt, darkNow);
    const n0 = motes.length;
    for (let i = 0; i < n0; i++) {
      const m = motes[i];
      if (!m.dead) stepMote(m, dt);
    }
    compactMotes();

    tryBirth(dt);
    aggregate();
    checkChoir(dt);
    checkFloor(dt);
    upkeepRecords(dt);
    wearStep(dt);
    dreamStep(dt);
    buildPopulations();
  }

  // populations: the living species (the keeper last, flagged keeper:true, amp 0: she sings nothing
  // into the plate)
  function buildPopulations() {
    popOut.length = 0;
    const n = alive.length;
    for (let i = 0; i <= n; i++) {
      const sp = i < n ? alive[i] : (keeperMote && !keeperMote.dead ? keeperSp : null);
      if (!sp || !(sp.n > 0)) continue;
      let p = popPool[popOut.length];
      if (!p) p = popPool[popOut.length] = { id: '', count: 0, meanE: 0, cu: 0, cv: 0, comps: null, ks: null, amp: 0, species: null, keeper: false };
      p.id = sp.id; p.count = sp.n; p.meanE = sp.sumE / sp.n; p.cu = sp.su / sp.n; p.cv = sp.sv / sp.n;
      p.comps = sp.comps; p.ks = sp.ks; p.amp = i < n ? sp.a : 0; p.species = sp; p.keeper = i >= n;
      popOut.push(p);
    }
  }

  // --- renderer feed --------------------------------------------------------------------------
  function instanceData() {
    let c = 0;
    const max = inst.length / 16;
    for (const m of motes) {
      if (m.dead || c >= max) continue;
      const o = c * 16;
      const sp = m.spec;
      inst[o] = m.u; inst[o + 1] = m.v; inst[o + 2] = m.r; inst[o + 3] = clamp(m.e, 0, 1);
      // the keeper never ages: a constant warm age reads as golden-white in the shader
      inst[o + 4] = m.keeper ? TUNE.keeperGlow : clamp(m.age / m.life, 0, 1);
      // timed states carry their progress; walking carries its pace (for the feet); a clinging
      // singer carries the share of its grip it has spent (its tremble may grow as its hold fails)
      const code = STATE_CODE[m.state];
      let prog;
      if (m.state === 'cling') prog = m.shelter ? 0 : clamp(1 - m.grip / gripMax(m), 0, 0.99);
      else prog = FREE[m.state] ? clamp(m.spd / (TUNE.speedMax * 3.2), 0, 0.99)
        : m.dur > 0 ? clamp(m.st / m.dur, 0, 0.99) : 0;
      inst[o + 5] = code + prog;
      for (let k = 0; k < 3; k++) {
        const md = sp.modes[k];
        inst[o + 6 + k * 3] = md ? md.n : 0;
        inst[o + 7 + k * 3] = md ? md.m : 0;
        inst[o + 8 + k * 3] = md ? md.s : 0;
      }
      let fl = m._flags || 0;
      if (sp.aurata) fl |= FLAG.aurata;
      if (m.state === 'sleep' || (darkNow && m.state !== 'walk')) fl |= FLAG.sleep;
      if (m.flash > 0) fl |= FLAG.flash;
      if (m.state === 'nestle') fl |= FLAG.nestle;
      if ((choirOn || floorOn) && !m.keeper) fl |= FLAG.float;
      if (m.keeper) fl |= FLAG.keeper;
      else if (m.age > 0.8 * m.life) fl |= FLAG.old;
      if (m.state === 'die' && m.cause === 'age') fl |= FLAG.ageDeath;
      if (m.state === 'cling') fl |= FLAG.cling;
      inst[o + 15] = fl;
      c++;
    }
    instOut.count = c;
    return instOut;
  }

  function moteAt(u, v, r = 0.06) {
    let best = null, bd = r * r;
    for (const m of motes) {
      if (m.dead) continue;
      const d = (m.u - u) ** 2 + (m.v - v) ** 2;
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  // In darkness the plate dreams of the dead: the sand drifts toward the figure of an extinct
  // species (sand.setDream drives a private field, so the singers do not feed on it).
  let dreamKey = '';
  function dream(dt = 0) {
    if (!darkNow) {
      if (dreamSp) { dreamSp = null; dreamOut.length = 0; }
      return dreamOut;
    }
    dreamT -= dt;
    if (!dreamSp || dreamT <= 0) {
      const gone = Object.values(state.species).filter((r) => r.extinct && r.comps?.length && r.id !== dreamSp?.id);
      if (gone.length || !dreamSp) {
        dreamSp = gone.length ? gone[Math.floor(rng.next() * gone.length)] : null;
        dreamOut.length = 0;
        if (dreamSp) for (const c of dreamSp.comps) dreamOut.push({ mode: c, amp: 0.8 / Math.sqrt(dreamSp.comps.length) });
      }
      dreamT = 70 + rng.next() * 60;
    }
    return dreamOut;
  }
  function dreamStep(dt) {
    if (!TUNE.dreams || !sand?.setDream) return;
    dream(dt);
    const key = darkNow && dreamSp ? dreamSp.id : '';
    if (key !== dreamKey) { dreamKey = key; try { sand.setDream(key ? dreamOut : []); } catch { /* the sand may not dream yet */ } }
  }

  // --- persistence ----------------------------------------------------------------------------
  const r4 = (x) => Math.round(x * 1e4) / 1e4, r3 = (x) => Math.round(x * 1e3) / 1e3, r1 = (x) => Math.round(x * 10) / 10;
  function quickSave() {
    const out = [];
    for (let i = 0; i < NM; i++) if (quickBy[i] > 0.005) out.push([MODES[i].id, r3(quickBy[i])]);
    return out;
  }
  function serialize() {
    const ms = [];
    const used = new Set();
    let kp = null;
    for (const m of motes) {
      if (m.dead || m.state === 'die' || m.state === 'fall') continue;
      if (m.keeper) { kp = [m.id, r4(m.u), r4(m.v), r3(m.hx), r3(m.hy), r1(m.age), m.born, r3(m.phase)]; continue; }
      ms.push([m.id, m.sp, r4(m.u), r4(m.v), r3(m.hx), r3(m.hy), r3(clamp(m.e, 0, 1)), r1(m.age), r1(m.life), m.gen, m.born, r3(m.phase), r1(Math.max(0, m.cool))]);
      used.add(m.spec);
    }
    return {
      v: 1, t: r1(T), nextId, qs: quickSave(),
      species: [...used].map((s) => [s.id, s.comps, s.aurata ? 1 : 0, s.gen, s.parents]),
      motes: ms, cc: r1(Math.max(0, choirCool)), fc: r1(Math.max(0, floorCool)), fa: floorArmed ? 1 : 0,
      kp,                                            // the keeper: [id, u, v, hx, hy, age, born, phase] | null
    };
  }

  function deserialize(obj) {
    if (!obj || obj.v !== 1) return;
    for (const m of motes) m.dead = true;
    motes.length = 0;
    keeperMote = null;
    // each part, and each singer, on its own: one damaged entry costs only itself
    const each = (list, fn) => { if (Array.isArray(list)) for (const x of list) { try { fn(x); } catch (e) { console.warn('[life] skipped a damaged entry', e); } } };
    each(obj.species, (s) => { if (s && s[0] !== KEEPER_ID) getSpecies(s[1], !!s[2], { gen: s[3] || 0, parents: s[4] || null }); });
    try {
      const kp = Array.isArray(obj.kp) ? obj.kp : null;
      if (kp && [kp[1], kp[2]].every(Number.isFinite)) {
        const m = summonKeeper(false, clamp(kp[1], -0.9, 0.9), clamp(kp[2], -0.9, 0.9));
        m.id = kp[0] | 0 || m.id;
        if (Number.isFinite(kp[3]) && Number.isFinite(kp[4]) && Math.hypot(kp[3], kp[4]) > 0.1) { const l = Math.hypot(kp[3], kp[4]); m.hx = kp[3] / l; m.hy = kp[4] / l; }
        m.age = Math.max(0, +kp[5] || 0); m.born = kp[6] || Date.now(); m.phase = Number.isFinite(kp[7]) ? kp[7] : m.phase;
      }
    } catch (e) { console.warn('[life] could not restore the keeper', e); }
    each(obj.motes, (a) => {
      const [id, spId, u, v, hx, hy, e, age, life, gen, born, phase, cool] = a;
      if (spId === KEEPER_ID || motes.length >= CAP) return;   // the keeper: exactly one, restored above (or by state.seen.keeper)
      let sp = species[spId];
      if (!sp && typeof spId === 'string') sp = getSpecies(spId.replace('*', '').split('|'), spId.endsWith('*'));
      if (!sp || ![u, v, e, age, life].every(Number.isFinite)) return;
      const m = makeMote(sp, clamp(u, -0.95, 0.95), clamp(v, -0.95, 0.95), clamp(e, 0.01, 1), gen | 0, 'walk');
      m.id = id | 0 || m.id; m.hx = Number.isFinite(hx) ? hx : m.hx; m.hy = Number.isFinite(hy) ? hy : m.hy;
      const hl = Math.hypot(m.hx, m.hy) || 1; m.hx /= hl; m.hy /= hl;
      m.age = Math.max(0, age); m.life = Math.max(60, life); m.born = born || Date.now();
      m.phase = Number.isFinite(phase) ? phase : m.phase; m.cool = Number.isFinite(cool) ? cool : m.cool;
      m.grace = 1; m.dur = 0;
    });
    try {
      for (const m of motes) if (m.id >= nextId) nextId = m.id + 1;
      nextId = Math.max(nextId, obj.nextId | 0);
      T = +obj.t || 0;
      quickBy.fill(0);
      const qs = Array.isArray(obj.qs) ? obj.qs : obj.qm ? [[obj.qm, obj.q]] : [];   // (older saves kept one)
      for (const e of qs) { const md = Array.isArray(e) ? modeById(e[0]) : null; if (md && Number.isFinite(+e[1])) quickBy[md.index] = clamp(+e[1], 0, 2); }
      choirCool = +obj.cc || 0; floorCool = +obj.fc || 0; floorArmed = obj.fa !== 0;
    } catch (e) { console.warn('[life] could not restore the plate\'s timers', e); }
    aggregate();
    settleRecords();
    buildChorus(darkNow);
    buildPopulations();
  }

  // --- time away: a coarse, sand-free evolution -----------------------------------------------
  // Steps of 5-15 s (energy integrated exactly over each); on a slow device the step lengthens a
  // little (to offlineMaxStep) to fit the budget, and if even that does not fit, the rest of the
  // absence is left unlived rather than lived on age alone: nobody dies of a slow device.
  function simulateOffline(seconds) {
    const clock = typeof performance !== 'undefined' ? performance : Date;
    const t0 = clock.now();
    const secs = clamp(+seconds || 0, 0, 3 * 3600);
    const notes = [];
    if (secs < 30) return notes;
    const dark = game.light ? game.light.on === false : false;
    const wasDark = darkNow;
    darkNow = dark; A = 0.35; overdrive = 0; detuneMul = Math.max(0.5, 1 - TUNE.detunePenalty * (field.detune || 0));
    let births = 0, splits = 0, deaths = 0, eaten = 0, fused = 0, oldAge = 0, fell = 0, peak = 0;
    // whoever was crumbling, being swallowed or falling when the plate was left has long gone
    for (const m of motes) {
      if (m.dead || m.keeper || (m.state !== 'die' && m.state !== 'fall')) continue;
      remove(m, true); deaths++;
      if (m.cause === 'age') oldAge++; else if (m.cause === 'fall') fell++;
    }
    compactMotes();
    const startCount = livingCount();
    const startAlive = new Set();
    for (const m of motes) if (!m.keeper) startAlive.add(m.spec);
    const born = new Set(), lost = new Set();
    const nowMs = Date.now();
    let dt = Math.min(secs > 3600 ? 15 : secs > 900 ? 10 : 5, TUNE.offlineMaxStep), simT = 0, steps = 0, rested = 0;
    while (simT < secs - 1e-6) {
      if (steps >= 4) {                               // a slow device: fit what is left into the budget
        const spent = clock.now() - t0;
        if (spent > TUNE.offlineBudget) { rested = secs - simT; break; }
        const room = (TUNE.offlineBudget - spent) / (spent / steps);
        dt = clamp((secs - simT) / Math.max(1, room), dt, Math.max(dt, TUNE.offlineMaxStep));
      }
      const h = Math.min(dt, secs - simT);
      const agoMs = (secs - simT) * 1000;            // how long before the return this step began
      simT += h; steps++;
      aggregate();
      if (!N) break;
      crowdMul = crowdOf(N);
      buildChorus(dark);
      computeFeed(true);
      const n0 = motes.length;
      for (let i = 0; i < n0; i++) {
        const m = motes[i];
        if (m.dead) continue;
        if (m.keeper) {                                // she walks the rim, as ever
          m.age += h; rimPoint(Math.atan2(m.v, m.u) + h * 0.006); m.u = RPU; m.v = RPV;
          m.state = 'walk'; m.st = 0; m.dur = 0;
          continue;
        }
        m.state = 'walk'; m.st = 0; m.dur = 0; m.partner = null; m.hunt = null; m.flash = 0;
        m.F = 0.05 * A * A; m.near = 2; m.comfort = 0;
        energyRates(m);                                // exact over the step: e relaxes toward EA/EB
        if (EB > 1e-9) { const eq = EA / EB; m.e = eq + (m.e - eq) * Math.exp(-EB * h); } else m.e += EA * h;
        m.e = clamp(m.e, -0.01, 1);
        m.age += h; m.cool -= h;
        // wander a little so positions are not frozen
        m.u = clamp(m.u + gauss() * 0.04, -0.85, 0.85); m.v = clamp(m.v + gauss() * 0.04, -0.85, 0.85);
        if (m.e <= 0 || m.age >= m.life) {
          m.dead = true; deaths++;
          if (m.age >= m.life) { oldAge++; sand?.drop?.(m.u, m.v, 3 + Math.floor(rng.next() * 4), 1, 0.02); bump(m.spec, 'ageDeaths').stats.lifeSum += m.age; }
          else bump(m.spec, 'hungerDeaths');
          continue;
        }
        if (!dark && m.e > TUNE.splitE && m.age > TUNE.splitAge && m.cool <= 0 && motes.length < CAP && rng.next() < 1 - Math.exp(-h / 25)) {
          let sp = m.spec;
          if (rng.next() < TUNE.mutate) { const c = mutateComps(sp); if (c) sp = getSpecies(c, sp.aurata, { gen: sp.gen + 1, parents: [sp.id, sp.id] }); }
          const ch = makeMote(sp, clamp(m.u + gauss() * 0.05, -0.85, 0.85), clamp(m.v + gauss() * 0.05, -0.85, 0.85), 0.45, m.gen + 1, 'walk');
          ch.dur = 0; ch.grace = 0; m.e = 0.45; m.cool = ch.cool = TUNE.splitCool;
          splits++; bump(m.spec, 'splits');
          if (!state.species[sp.id]) { recordFor(sp).firstSeen = nowMs - agoMs; born.add(sp); }
          bump(sp, 'births');
        }
      }
      // encounters, by population
      if (!dark) for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i], b = alive[j];
        const c = rel(a, b);
        const meet = 1.2e-4 * a.n * b.n * h;       // encounter rate, calibrated against the live plate
        if (c < TUNE.eatCons && rng.next() < 1 - Math.exp(-meet)) {
          const pa = pickMote(a), pb = pickMote(b);
          if (!pa || !pb) continue;
          const pred = pa.e >= pb.e ? pa : pb, prey = pred === pa ? pb : pa;
          pred.e = Math.min(1, pred.e + TUNE.eatGain * prey.e); prey.dead = true; eaten++; deaths++;
          bump(pred.spec, 'devoured'); bump(prey.spec, 'eaten');
        } else if (c > TUNE.fuseCons && rng.next() < 1 - Math.exp(-meet * 0.3)) {
          const pa = pickMote(a, TUNE.fuseE), pb = pickMote(b, TUNE.fuseE);
          if (!pa || !pb || !fusable(a, b)) continue;
          const sp = getSpecies(unionComps(a, b), a.aurata || b.aurata, { gen: Math.max(a.gen, b.gen) + 1, parents: [a.id, b.id] });
          pa.dead = pb.dead = true;
          const ch = makeMote(sp, (pa.u + pb.u) / 2, (pa.v + pb.v) / 2, (pa.e + pb.e) / 2, Math.max(pa.gen, pb.gen) + 1, 'walk');
          ch.dur = 0; ch.grace = 0; fused++;
          bump(a, 'fusions'); bump(b, 'fusions');
          if (!state.species[sp.id]) { recordFor(sp).firstSeen = nowMs - agoMs; born.add(sp); }
          bump(sp, 'births');
        }
      }
      // the plate's own song, when one mode dominates it, quickens singers of that mode (as on the
      // watched plate: a chord's voices too, so a plate of hybrids does not dwindle to one kind)
      if (!dark && alive.length && motes.length < CAP) {
        let sum2 = 0, bi = -1, bv = 0;
        for (let i = 0; i < NM; i++) { const a2 = chorusAmp[i] * chorusAmp[i]; sum2 += a2; if (a2 > bv) { bv = a2; bi = i; } }
        const sparse = Math.pow(Math.max(0, 1 - N / TUNE.songCrowd), 1.5);
        if (bi >= 0 && MODES[bi].k >= 5 && bv / sum2 > TUNE.birthShare && Math.sqrt(sum2) > TUNE.songTotal && rng.next() < 1 - Math.exp(-sparse * h / 40)) {
          let sp = getSpecies([MODES[bi].id], false, { gen: 0, parents: null });   // and it wavers now and then, as it does while watched
          if (rng.next() < TUNE.songWaver) { const c = mutateComps(sp, true); if (c) sp = getSpecies(c, sp.aurata, { gen: sp.gen + 1, parents: [sp.id, sp.id] }); }
          makeMote(sp, rng.next() * 1.4 - 0.7, rng.next() * 1.4 - 0.7, TUNE.newbornE, 0, 'walk').dur = 0;
          births++;
          if (!state.species[sp.id]) { recordFor(sp).firstSeen = nowMs - agoMs; born.add(sp); }
          bump(sp, 'births');
        }
      }
      compactMotes();
      aggregate();
      peak = Math.max(peak, N);
      for (const sp of alive) { const r = recordFor(sp); r.count = sp.n; if (sp.n > r.peak) r.peak = sp.n; }
    }
    // reconcile records
    compactMotes();
    aggregate();
    const endAlive = new Set(alive);
    const now = Date.now();
    for (const sp of speciesList) {
      const r = recordFor(sp, false);
      if (!r || sp.keeper) continue;
      r.count = sp.n;
      if (sp.n === 0 && !r.extinct && (startAlive.has(sp) || born.has(sp))) { r.extinct = true; r.extinctAt = now; lost.add(sp); }
      if (sp.n > 0) { r.extinct = false; r.lastSeen = now; }
      refreshNote(r, sp);
    }
    settleRecords(now);
    for (const m of motes) { m.state = 'walk'; m.st = 0; m.dur = 0; m.grace = m.keeper ? 1e9 : 1; m.r = TUNE.rBase * (m.keeper ? TUNE.keeperR : 1); m.thrown = false; }
    choirCool = Math.max(0, choirCool - secs); floorCool = Math.max(0, floorCool - secs);
    quickBy.fill(0); ghostRec = null; ghostT = 0;     // whatever figure was forming has long since scattered
    // what the room keeps count of (progress tallies these from events while someone watches)
    const st = state.stats;
    if (st) {
      const add = (k, n) => { if (n) st[k] = (+st[k] || 0) + n; };
      add('births', births); add('splits', splits); add('deaths', deaths); add('devoured', eaten); add('fusions', fused); add('fell', fell);
      st.maxPop = Math.max(+st.maxPop || 0, peak);
    }
    if (births || fused || oldAge) {
      const seen = state.seen && typeof state.seen === 'object' ? state.seen : (state.seen = {});
      if (births) seen.firstBirth = true;
      if (fused) seen.firstFusion = true;
      if (oldAge) seen.firstGold = true;
    }
    darkNow = wasDark;
    buildChorus(dark); buildPopulations();

    // the field notes
    const mins = Math.round(secs / 60);
    const gens = Math.floor((secs - rested) / 340);
    const endCount = livingCount();
    let lead;
    if (!startCount && !endCount) {
      lead = mins >= 90 ? `While you were away: ${timeWords(secs)} of silence. The plate did not stir.` : `The plate lay quiet for ${timeWords(secs)}.`;
      if (keeperMote) lead = `The plate lay quiet for ${timeWords(secs)}. Only the pale one walked, round and round the rim.`;
    }
    else if (gens >= 2) lead = `While you were away: ${numberWord(gens)} generations passed.`;
    else if (gens === 1) lead = 'While you were away: a generation passed.';
    else lead = `While you were away the plate sang to itself for ${timeWords(secs)}.`;
    if (dark && startCount) lead += ' The lamp was out; they slept through most of it.';
    else if (rested >= 600 && endCount) lead += ` For the last ${timeWords(rested)} they seem to have rested.`;
    notes.push({ kind: 'away', text: lead });
    if (startCount || endCount) {
      if (!endCount) notes.push({ kind: 'away', text: keeperMote ? 'None remain but the pale one, who walks the rim as before.' : 'None remain. The sand lies where the last of them crumbled.' });
      else if (endCount !== startCount) notes.push({ kind: 'away', text: `They numbered ${numberWord(startCount)} when you left; there are now ${numberWord(endCount)}.` });
      else notes.push({ kind: 'away', text: `Their number is unchanged at ${numberWord(endCount)}, though not all are the same individuals.` });
    }
    // the forms you knew first, then the newcomers that stayed; the transient ones only in sum
    const knownLost = [...lost].filter((sp) => startAlive.has(sp) && !endAlive.has(sp));
    knownLost.slice(0, 3).forEach((sp) => notes.push({ kind: 'extinct', text: `${sp.name} did not survive.` }));
    if (knownLost.length > 3) notes.push({ kind: 'extinct', text: `Nor did ${numberWord(knownLost.length - 3)} other ${plural(knownLost.length - 3, 'form', 'forms')} you knew.` });
    const stayed = [...born].filter((sp) => endAlive.has(sp));
    stayed.slice(0, 2).forEach((sp) => notes.push({ kind: 'new', text: `A form not seen before has appeared: ${sp.name}.` }));
    const transient = [...born].filter((sp) => !endAlive.has(sp)).length;
    if (transient >= 2) notes.push({ kind: 'away', text: `${cap(numberWord(transient))} other new forms came and went before you returned.` });
    else if (transient === 1) notes.push({ kind: 'away', text: 'One other new form came and went before you returned.' });
    if (eaten >= 2) notes.push({ kind: 'away', text: `${cap(numberWord(eaten))} were devoured.` });
    else if (eaten === 1) notes.push({ kind: 'away', text: 'One was devoured.' });
    if (fused >= 1) notes.push({ kind: 'away', text: fused === 1 ? 'One pair merged.' : `${cap(numberWord(fused))} pairs merged.` });
    if (oldAge >= 3) notes.push({ kind: 'away', text: 'Gold where the old ones crumbled.' });
    return notes;
  }
  function pickMote(sp, minE = 0) {
    let best = null;
    for (const m of motes) if (!m.dead && m.spec === sp && m.e >= minE && (!best || rng.next() < 0.5)) best = m;
    return best;
  }

  const life = {
    motes, species, TUNE, STATES, STATE_CODE, FLAG, KEEPER_ID,
    update,
    chorus() { return chorusOut; },
    populations() { return popOut; },
    moteAt, instanceData, serialize, deserialize, simulateOffline, dream,
    get choir() { return choirOn; },
    get floor() { return floorOn; },
    get quickening() { let q = 0; for (let i = 0; i < NM; i++) if (quickBy[i] > q) q = quickBy[i]; return q; },
    get count() { return N; },
    get dreamingOf() { return dreamKey || null; },
    get keeper() { return keeperMote && !keeperMote.dead ? keeperMote : null; },
    get keeperDue() { return !keeperMote && !!state.seen?.keeperDue; },
    speciesOf(m) { return m?.spec || species[m?.sp] || null; },
    // dev helpers (also used by tests and harnesses)
    spawn(comps, u = 0.4, v = 0.4, e = 0.7, opts = {}) {
      const sp = getSpecies(Array.isArray(comps) ? comps : [comps], !!opts.aurata);
      if (!sp || motes.length >= CAP) return null;
      const m = makeMote(sp, u, v, e, 0, opts.born ? 'born' : 'walk');
      if (!opts.born) { m.dur = 0; m.grace = 0; }
      if (opts.age) m.age = opts.age;
      const isNew = announce(sp, !!opts.silent);
      bump(sp, 'births');
      if (!opts.silent) bus.emit('mote:birth', { mote: m, species: sp, isNew });
      return m;
    },
    // dev: bring the keeper now (fresh = born at the centre with events; once only, like the real thing)
    summonKeeper(fresh = true) { return summonKeeper(!!fresh, 0, 0); },
    destroy() { for (const off of offs) try { off?.(); } catch {} },
  };
  aggregate(); buildChorus(false); buildPopulations();
  return life;
}

// the song is shared: per-singer nourishment falls steeply as the plate crowds
function crowdOf(n) { const x = n / TUNE.crowdK; return 1 / (1 + x * x * x); }

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function plural(n, a, b) { return n === 1 ? a : b; }
function timeWords(secs) {
  const m = Math.round(secs / 60);
  if (m < 2) return 'a minute or so';
  if (m < 55) return `${numberWord(m)} minutes`;
  const h = Math.round(secs / 3600);
  return h <= 1 ? 'an hour' : `${numberWord(h)} hours`;
}

function fallbackRng() {
  let a = 0x9e3779b9;
  return { next() { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } };
}
