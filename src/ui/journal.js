// The field book: a DOM overlay over the dimmed room. The previous keeper's notes, your
// specimens and your observations, bound in one worn notebook that turns its pages.
//
// It is also the observer: it listens to the bus and keeps state.log in the player's own terse
// hand (rate-limited: firsts, milestones, every new form, every extinction, the rare states).
//
// createJournal(game, rootEl) -> { open(page?), close(), isOpen, update(dt), toggle(), note(kind, text, data) }
//   open(page): page = 'flyleaf' | 'keeper' | 'specimens' | 'observations' | <page index>
// Persistent bookkeeping lives in state.notebook (see nbState()).
import * as Modes from '../sim/modes.js';
import * as Harmony from '../sim/harmony.js';
import * as Naming from '../sim/naming.js';
import { keeperPagesFor } from './keeper.js';

const TURN_MS = 760;
const OPEN_MS = 560, CLOSE_MS = 380;
const MILESTONE = [10, 25, 50, 100, 250, 500, 1000];
const ORD = ['nought', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth',
  'nineteenth', 'twentieth'];
const ORD_BIG = { 25: 'twenty-fifth', 50: 'fiftieth', 100: 'hundredth', 250: 'two hundred and fiftieth', 500: 'five hundredth', 1000: 'thousandth' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const INK = '74,47,28';        // the keeper's iron-gall brown
const LEAD = '58,58,64';       // graphite

// --- small pure helpers ---------------------------------------------------------------------------
function hashStr(s) {
  let h = 2166136261 >>> 0;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
function seeded(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
}
const pick = (arr, key) => arr[hashStr(key) % arr.length];
// the keeper: the one creature of the fundamental (life.js KEEPER_ID 'keeper', comps ['floor'])
const isKeeper = (x) => !!x && (x.id === 'keeper' || x.keeper === true ||
  (Array.isArray(x.comps) && x.comps.length === 1 && x.comps[0] === 'floor'));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const words = (n) => { try { return Naming.numberWord ? Naming.numberWord(n) : String(n); } catch { return String(n); } };
function ordinal(n) {
  if (n >= 0 && n < ORD.length) return ORD[n];
  if (ORD_BIG[n]) return ORD_BIG[n];
  const t = n % 100, u = n % 10;
  return n + (t > 10 && t < 14 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th');
}
function dateOrdinal(d) { const t = d % 100, u = d % 10; return d + (t > 10 && t < 14 ? 'th' : u === 1 ? 'st' : u === 2 ? 'nd' : u === 3 ? 'rd' : 'th'); }
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const article = (w) => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;
function gcd(a, b) { try { return Harmony.gcd(a, b); } catch { while (b) [a, b] = [b, a % b]; return a || 1; } }
function clanOf(k) { try { return Harmony.clanOf(k); } catch { let x = k | 0; while (x > 1 && x % 2 === 0) x /= 2; return String(x); } }

// '9:14 pm'
function clock(t) {
  const d = new Date(t);
  let h = d.getHours();
  const m = d.getMinutes(), ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m < 10 ? '0' : ''}${m} ${ap}`;
}
// Which day of the keeping, and which part of it ('the third evening'). Small hours belong to the
// night before.
function keeping(t, created) {
  const d = new Date(t), h = d.getHours();
  const day = new Date(t);
  if (h < 4) day.setDate(day.getDate() - 1);
  day.setHours(0, 0, 0, 0);
  const d0 = new Date(Math.min(created || t, t));
  if (d0.getHours() < 4) d0.setDate(d0.getDate() - 1);
  d0.setHours(0, 0, 0, 0);
  const n = Math.max(1, Math.round((day - d0) / 86400000) + 1);
  const period = h < 4 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  return { n, period, key: n + period, label: `the ${ordinal(n)} ${period}` };
}

// Keep log data small and JSON-safe (never a mote: they are cyclic).
function cleanData(d) {
  if (!d || typeof d !== 'object') return undefined;
  const out = {};
  let any = false;
  for (const k of Object.keys(d)) {
    const v = d[k];
    if (v == null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') { out[k] = v; any = true; }
    else if (Array.isArray(v) && v.length <= 8 && v.every((x) => typeof x === 'string' || typeof x === 'number')) { out[k] = v.slice(); any = true; }
  }
  return any ? out : undefined;
}

// Her markup: ~~struck~~, __underlined__, blank line = paragraph.
function inkMarkup(text) {
  return String(text || '').split(/\n\s*\n/).map((para) => '<p>' + esc(para)
    .replace(/~~(.+?)~~/g, '<s class="nb-x">$1</s>')
    .replace(/__(.+?)__/g, '<u class="nb-u">$1</u>') + '</p>').join('');
}
// The player's markup: *Binomial* is underlined, as one does by hand.
function penMarkup(text) {
  return esc(text).replace(/\*(.+?)\*/g, '<u class="nb-bin">$1</u>');
}

// ===================================================================================================
export function createJournal(game, rootEl) {
  const bus = game.bus || { on() { return () => {}; }, emit() {} };
  const offs = [];
  const on = (type, fn) => { try { const off = bus.on(type, (e) => { try { fn(e || {}); } catch (err) { report(err); } }); if (off) offs.push(off); } catch {} };
  let reported = false;
  function report(err) { if (!reported) { reported = true; console.error('[journal]', err); } }

  const st = () => game.state || (game.state = {});
  function nbState() {
    const s = st();
    const n = s.notebook || (s.notebook = {});
    n.f ||= {}; n.ms ||= {};
    // readT: when the book was last read (epoch ms). A book opened before this was kept counts as
    // read up to its last line.
    if (n.readT == null && n.opened) {
      const log = Array.isArray(s.log) ? s.log : [];
      n.readT = log.length ? log[log.length - 1].t || Date.now() : Date.now();
    }
    return n;
  }
  // What has been written since the book was last read: new specimens and new observation lines.
  function news() {
    const s = st(), T = nbState().readT || 0;
    let lines = 0, specimens = 0;
    const log = Array.isArray(s.log) ? s.log : [];
    for (let i = log.length - 1; i >= 0; i--) { const e = log[i]; if (!e || !(e.t > T)) break; lines++; }
    const sp = s.species || {};
    for (const id in sp) if (sp[id] && sp[id].firstSeen > T) specimens++;
    return { specimens, lines };
  }
  const speciesList = () => {
    const sp = st().species || {};
    return Object.values(sp).filter((r) => r && r.id != null)
      .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0) || (String(a.id) < String(b.id) ? -1 : 1));
  };
  const speciesName = (sp) => sp?.name || st().species?.[sp?.id]?.name || null;

  // =================================================================================================
  // The observations log
  // =================================================================================================
  function note(kind, text, data) {
    const s = st();
    if (!text) return;
    const log = Array.isArray(s.log) ? s.log : (s.log = []);
    const now = Date.now();
    const last = log[log.length - 1];
    if (last && last.text === text && now - last.t < 4000) return;
    const entry = { t: now, kind: kind || 'note', text: String(text) };
    const d = cleanData(data);
    if (d) entry.data = d;
    log.push(entry);
    if (log.length > 600) log.splice(0, log.length - 600);
  }
  // a first, once ever
  function first(flag, kind, text, data) {
    const f = nbState().f;
    if (f[flag]) return false;
    f[flag] = Date.now();
    note(kind, text, data);
    return true;
  }

  // ---- new forms: species:new arrives just before the event that made it; hold it a moment so the
  // line can say how it came about.
  let pending = null;
  const SAND_TAILS = [
    'Rose out of the sand at a crossing of lines.',
    'Walked at once toward the centre.',
    'Stood up out of a heap of sand and looked about.',
    'Gathered itself out of the sand in a few seconds, and sang.',
    'Came up out of the sand quite small, and then less small.',
    'Stood up where two lines cross, as the others did.',
    'Shook the sand off and set out along the nearest line.',
  ];
  const FUSE_TAILS = ['It sings both their notes at once.', 'Both notes, in one body.', 'It walked off humming a chord.'];
  function voiceRemark(ks, key) {
    if (!ks?.length || ks.length > 1 || hashStr(key + 'v') % 2) return '';
    const k = ks[0];
    if (k >= 45) return 'A high, thin voice.';
    if (k <= 8) return 'A low voice, in no hurry.';
    return '';
  }
  function speciesLine(sp, origin, ctx) {
    const name = speciesName(sp) || 'an unnamed form';
    const ks = sp.ks || [];
    let s = `A new form. *${name}*`;
    if (origin === 'fuse') {
      const a = speciesName(ctx?.a?.spec) || speciesName({ id: ctx?.a?.sp });
      const b = speciesName(ctx?.b?.spec) || speciesName({ id: ctx?.b?.sp });
      s += a && b && a !== b ? `, of *${a}* × *${b}*. ` : '. ';
      s += ks.length >= 3 ? 'Three voices in one body.' : pick(FUSE_TAILS, sp.id);
    } else if (sp.aurata) {
      s += '. Born beside the seam, and veined all through with gold.';
    } else if (origin === 'error') {
      s += '. One of them divided, and one half came out not quite the same.';
    } else if (origin === 'waver') {
      s += '. Rose from the sand, not quite matching the note I held.';
    } else if (origin === 'sand') {
      s += '. ' + pick(SAND_TAILS, sp.id);
      const v = voiceRemark(ks, sp.id);
      if (v) s += ' ' + v;
    } else s += '.';
    const n = Object.keys(st().species || {}).length;
    if (n === 5 || n === 10 || n === 20 || n === 30 || n === 50 || n === 100) s += ` That makes ${words(n)}.`;
    return s;
  }
  function flushPending(origin, ctx) {
    const p = pending;
    pending = null;
    if (!p) return;
    if (isKeeper(p.sp)) { keeperArrived(); return; }
    note('species', speciesLine(p.sp, origin, ctx), { id: p.sp.id });
  }
  // she is not a new form; she is someone
  function keeperArrived() { first('keeper', 'keeper', 'Someone is walking the rim.', { id: 'keeper' }); }
  const pendingIs = (sp) => !!(pending && sp && pending.sp.id === sp.id);

  on('species:new', (e) => {
    if (pending) flushPending('unknown');
    if (e.species) pending = { sp: e.species };
  });
  on('keeper:arrive', () => { if (pending && isKeeper(pending.sp)) pending = null; keeperArrived(); });
  on('mote:birth', (e) => {
    first('birth', 'birth', 'The sand heaped up where two lines crossed, and stood up, and walked.');
    const sp = e.species;
    if (pendingIs(sp)) {
      const waver = sp.parents && sp.parents[0] === sp.parents[1];
      flushPending(waver ? 'waver' : 'sand');
    }
  });
  on('mote:split', (e) => {
    first('split', 'split', 'One of them divided. The two halves walked off in opposite directions, without a word.');
    const sp = e.child?.spec || (e.child && { id: e.child.sp });
    if (pendingIs(sp)) flushPending('error');
  });

  // causes, so an extinction can say how the last one went
  const lastCause = new Map();
  const lastExtinct = new Map();
  on('mote:fuse', (e) => {
    if (e.a?.sp != null) lastCause.set(e.a.sp, 'fused');
    if (e.b?.sp != null) lastCause.set(e.b.sp, 'fused');
    const a = speciesName(e.a?.spec) || speciesName({ id: e.a?.sp });
    const b = speciesName(e.b?.spec) || speciesName({ id: e.b?.sp });
    first('fuse', 'fuse', a && b && a !== b
      ? `A *${a}* and a *${b}* met, and went in two and came out one.`
      : 'Two of them met, and went in two and came out one.');
    if (pendingIs(e.species)) flushPending('fuse', e);
  });
  on('mote:eat', (e) => {
    const a = speciesName(e.pred?.spec) || speciesName({ id: e.pred?.sp });
    const b = speciesName(e.prey?.spec) || speciesName({ id: e.prey?.sp });
    first('eat', 'eat', a && b
      ? `Saw one eat another. A *${a}* took a *${b}* whole, and sang the louder for it.`
      : 'Saw one eat another. It sang the louder for it.');
  });
  on('mote:death', (e) => {
    if (e.mote?.sp != null) lastCause.set(e.mote.sp, e.cause);
    if (e.cause === 'age') first('age', 'gold', 'The first of them grew old. It went golden, then crumbled, and left a few grains of gold.');
    else if (e.cause === 'hunger') first('hunger', 'death', 'One went dim and thin, and then there was only sand.');
    else if (e.cause === 'fall') first('fall', 'fall', 'One was thrown over the edge into the dark. I did not hear it land.');
  });

  // extinctions: always, but a sudden collapse is summed rather than listed
  let extWindow = 0, extInWindow = 0, extSuppressed = 0;
  on('species:extinct', (e) => {
    const sp = e.species;
    if (!sp || isKeeper(sp)) return;
    const now = Date.now();
    if (now - (lastExtinct.get(sp.id) || 0) < 60000) return;
    lastExtinct.set(sp.id, now);
    if (now - extWindow > 10000) { extWindow = now; extInWindow = 0; }
    if (++extInWindow > 3) { extSuppressed++; return; }
    const n = speciesName(sp) || 'that form';
    const cause = lastCause.get(sp.id);
    const text = cause === 'age' ? `The last *${n}* grew old and crumbled. None remain.`
      : cause === 'hunger' ? `The last *${n}* went dim, and then there was only sand. None remain.`
      : cause === 'eaten' ? `The last *${n}* was eaten. None remain.`
      : cause === 'fall' ? `The last *${n}* went over the edge. None remain.`
      : cause === 'fused' ? `The last *${n}* married into another kind. None remain as they were.`
      : `*${n}*: none remain.`;
    note('extinct', text, { id: sp.id });
  });

  // the plate itself
  on('plate:crack', (e) => {
    const s = st();
    const cracks = s.plate?.cracks || [];
    const n = Math.max(1, cracks.length);
    const c = cracks[e.crack]?.pts?.[0];
    let edge = '';
    if (c) edge = Math.abs(c[0]) > Math.abs(c[1]) ? (c[0] > 0 ? 'right' : 'left') : (c[1] > 0 ? 'near' : 'far');
    if (first('crack', 'crack', `Bowed too hard. A crack, fine as a hair, running in from the ${edge || 'outer'} edge. Every note sounds a little sour now.`)) return;
    note('crack', n === 2 ? 'A second crack.' : `A ${ordinal(n)} crack. The plate rings sour.`);
  });
  on('plate:heal', () => {
    if (first('heal', 'heal', 'The gold ran into the crack and stayed there. The seam glows, and the plate rings true along it.')) return;
    const healed = (st().plate?.cracks || []).filter((c) => c && c.healed).length;
    note('heal', healed >= 3 ? `${cap(words(healed))} seams now, all gold.` : 'Another seam filled with gold.');
  });

  // rare states
  on('life:choir', (e) => {
    if (!e.on) return;
    const nb = nbState(), now = Date.now();
    const names = (e.species || []).map((id) => st().species?.[id]?.name).filter(Boolean);
    if (first('choir', 'choir', 'Three kinds agreed at once. The sand became one figure, and they rose into a ring, and the light went gold.')) { nb.lastChoir = now; return; }
    if (now - (nb.lastChoir || 0) < 240000) return;
    nb.lastChoir = now;
    const list = names.length >= 3 ? `*${names.slice(0, -1).slice(0, 3).join('*, *')}* and *${names[names.length - 1]}*` : '';
    note('choir', list ? `A choir: ${list}.` : 'A choir again. They rose into the ring.');
  });
  on('life:floor', (e) => {
    if (!e.on) return;
    const nb = nbState(), now = Date.now();
    if (first('floor', 'floor', 'Below the lowest note, a lower one. The whole plate hummed, and the sand ran to the rim, and there was writing under it.')) {
      nb.lastFloor = now;
      nb.psT ||= now;
      nb.newKeeper = 'below';
      return;
    }
    if (now - (nb.lastFloor || 0) < 300000) return;
    nb.lastFloor = now;
    note('floor', 'The lower note again. I read her writing a second time.');
  });
  on('floor:end', () => {
    if (!st().seen?.floor && !nbState().f.floor) return;
    first('lastPage', 'keeper', 'Her last page has come clear. There is a line at the foot of it I do not remember.');
  });
  on('light', (e) => {
    if (e.on === false) first('dark', 'dark', 'Put out the lamp. In the dark they glow, and sing an octave lower. There are marks in the bronze I had not seen.');
  });
  on('moth', (e) => {
    if (e.state === 'arrive') {
      if (first('moth', 'moth', 'A moth came to the lamp.')) return;
      const nb = nbState(), k = keeping(Date.now(), st().created).key;
      if (nb.mothDay !== k) { nb.mothDay = k; note('moth', 'The moth again.'); }
    } else if (e.state === 'land') first('mothLand', 'moth', 'The moth settled on the plate, and they gathered round it.');
  });
  const REVEAL = {
    jar: 'There is a jar of sand at the edge of the light. My eyes must be adjusting.',
    journal: 'Found this book beside the plate. The first pages are not mine.',
    drawer: 'A drawer in the cabinet beneath the plate. Felt discs inside, like draughtsmen.',
    forks: 'Tuning forks in the drawer, each stamped with a number.',
    phonograph: 'A phonograph at the edge of the light. I do not think it was there before.',
  };
  on('reveal', (e) => { if (REVEAL[e.what]) first('reveal_' + e.what, 'reveal', REVEAL[e.what]); });
  on('bow:start', () => first('bow', 'bow', 'Drew the bow along the edge. The plate sang.'));
  on('fork:touch', () => first('fork', 'fork', 'Struck a fork and touched it to the plate. It held the note by itself for a while.'));
  on('damper:place', () => first('damper', 'damper', 'Set a felt disc on the plate. The figure bent around it.'));
  // the phonograph: the first few recordings and playings, then only now and then
  const OFTEN = 600000;
  const quote = (label) => (label ? `\u2018${String(label).slice(0, 40)}\u2019` : '');
  on('phono:record', (e) => {
    if (e.on !== false || !(e.index >= 0)) return;            // stopped without keeping anything
    const nb = nbState(), now = Date.now(), label = quote(e.label);
    const n = nb.phonoRec = (nb.phonoRec || 0) + 1;
    if (e.label === 'below the floor' && first('phonoFloor', 'phono', 'Recorded the floor. I do not know whether wax can hold a note that low.')) return;
    if (/^the choir/.test(e.label || '') && first('phonoChoir', 'phono', 'Recorded the choir.')) return;
    const secs = Math.round((e.frames || 0) * 0.25);
    let text = null;
    if (n === 1) text = `Recorded the plate for ${secs >= 19 ? 'twenty seconds' : secs < 2 ? 'a second or two' : words(secs) + ' seconds'}.`;
    else if (n === 2) text = label ? `Recorded another cylinder, and pencilled ${label} on the end.` : 'Recorded another cylinder.';
    else if (n === 3) text = label ? `A third cylinder: ${label}.` : 'A third cylinder.';
    else if (n % 4 === 0 && now - (nb.phonoT || 0) > OFTEN) text = label ? `Recorded ${label}.` : 'Recorded the plate again.';
    if (text) { nb.phonoT = now; note('phono', text, { index: e.index }); }
  });
  // which kind, now gone, would the sand draw for a cylinder whose loudest notes are these?
  function ghostOf(modes) {
    if (!Array.isArray(modes) || !modes.length) return null;
    let best = null;
    for (const r of speciesList()) {
      if (!r.extinct || isKeeper(r) || !r.comps?.length || !r.comps.includes(modes[0])) continue;
      if (!r.comps.every((c) => modes.includes(c))) continue;
      if (!best || r.comps.length > best.comps.length) best = r;
    }
    return best;
  }
  on('phono:play', (e) => {
    if (!e.on) return;
    const s = st(), nb = nbState(), now = Date.now(), label = quote(e.label);
    const cyl = Array.isArray(s.cylinders) ? s.cylinders[e.index] : null;
    let from = 'the cylinder';
    if (cyl?.t) {
      const k = keeping(cyl.t, s.created), k0 = keeping(now, s.created);
      from = k.key === k0.key ? `the cylinder I made earlier this ${k.period}` : `the cylinder from ${k.label}`;
    }
    const n = nb.phonoPlay = (nb.phonoPlay || 0) + 1;
    const ghost = ghostOf(e.modes);
    if (ghost && first('ghost_' + ghost.id, 'phono', `Played back ${from}. For a while the sand drew *${ghost.name}* again.`, { id: ghost.id })) { nb.phonoT = now; return; }
    let text = null;
    if (n === 1) text = `Played back ${from}. The sand remembered.`;
    else if (n === 2) text = label ? `Played back ${label}. The sand went back into the figure it had then.` : `Played back ${from}. The sand went back into the figure it had then.`;
    else if (n === 3) text = `Played back ${from}.`;
    else if (n % 4 === 0 && now - (nb.phonoT || 0) > OFTEN) text = label ? `Put on ${label} and listened.` : `Played back ${from}.`;
    if (text) { nb.phonoT = now; note('phono', text, { index: e.index }); }
  });
  // anyone may write in the book (the time away, the dream)
  on('log', (e) => { if (e.text) note(e.kind || 'note', e.text, e.data); });

  // periodic observations: milestones, silences, the resting finger, her pages coming unstuck
  const MS_TEXT = {
    fusions: (n) => `The ${ordinal(n)} union.`,
    devoured: (n) => (n >= 100 ? `${cap(words(n))} eaten, all told. It is not a gentle place.` : `${cap(words(n))} have now been eaten.`),
    fell: (n) => (n === 10 ? 'The tenth lost over the edge. I must bow more gently.' : `${cap(words(n))} lost over the edge.`),
    births: (n) => `The ${ordinal(n)} birth.`,
  };
  const KEEPER_FOUND = [
    'Found another of her pages, folded in among the others.',
    'A page of hers I had missed; it was stuck to the one before.',
    'Another of her pages came loose. I have put it back where it belongs.',
  ];
  let keeperClock = 2, silentFor = 0, hadLife = false, silenced = false;
  function watch(dt) {
    const s = st(), nb = nbState(), stats = s.stats || {};
    // milestones (stats are kept by progress; jumps log only the highest crossed)
    for (const key in MS_TEXT) {
      const v = stats[key] || 0;
      let best = 0;
      for (const m of MILESTONE) if (v >= m && m > (nb.ms[key] || 0)) best = m;
      if (key === 'births' && best < 50) best = 0;
      if (best) { nb.ms[key] = best; note('milestone', MS_TEXT[key](best)); }
    }
    // the first clean figure
    const coh = game.field?.coherence;
    if (!nb.f.figure && coh && coh.stable > 3) first('figure', 'figure', 'Kept to one note. The sand settled into a figure, and stayed so.');
    // silence: everything alive has gone
    const life = game.life;
    let alive = 0, keeperHere = false;
    if (life) {
      if (Array.isArray(life.motes) && life.motes.length) {
        for (const m of life.motes) { if (m.dead) continue; if (m.keeper) keeperHere = true; else alive++; }
      } else if (typeof life.count === 'number') alive = life.count;
    }
    if (alive > 0) { hadLife = true; silentFor = 0; silenced = false; }
    else if (hadLife && !silenced) {
      silentFor += dt;
      if (silentFor > 4) {
        silenced = true;
        note('silence', keeperHere ? 'The plate fell silent. None remain but her, walking the rim.' : 'The plate fell silent. None remain.');
      }
    }
    if (extSuppressed && Date.now() - extWindow > 10000) {
      note('extinct', extSuppressed === 1 ? 'And one other kind went the same way.' : `And ${words(extSuppressed)} other kinds went the same way.`);
      extSuppressed = 0;
    }
    // the resting finger
    if (game.hold && life?.motes && (!nb.f.nestle || (!nb.f.keeperNestle && nb.f.keeper))) {
      for (const m of life.motes) {
        if (m.state !== 'nestle') continue;
        if (m.keeper) { first('keeperNestle', 'nestle', 'Held my finger still. She came first, and the others waited until she had sat down.'); break; }
        if (!nb.f.nestle) { first('nestle', 'nestle', 'Held my finger still on the plate. They came, one by one, and sat against it.'); break; }
      }
    }
    // her pages (looked at every couple of seconds; nothing here needs to be prompt)
    keeperClock += dt;
    if (keeperClock < 2) return;
    keeperClock = 0;
    returns(s, nb);
    const kp = keeperPagesFor(s);
    if (nb.keeperN == null) nb.keeperN = kp.length;
    if (kp.length > nb.keeperN) {
      const fresh = kp.filter((p) => !(nb.keeperIds || []).includes(p.id));
      nb.keeperN = kp.length;
      nb.keeperIds = kp.map((p) => p.id);
      if (fresh.length) {
        nb.newKeeper = fresh[0].id;
        note('keeper', nb.f.keeperFound ? pick(KEEPER_FOUND, fresh[0].id) : 'Two of her pages had stuck together. I have parted them.');
        nb.f.keeperFound = Date.now();
      }
    } else if (!nb.keeperIds) nb.keeperIds = kp.map((p) => p.id);
  }

  // a kind written off that walks again (the phonograph, a dream, a lucky mutation)
  function returns(s, nb) {
    const recs = s.species || {};
    const gone = [];
    for (const id in recs) if (recs[id]?.extinct && !isKeeper(recs[id])) gone.push(id);
    if (!Array.isArray(nb.gone)) { nb.gone = gone; return; }
    const back = nb.back || (nb.back = {});
    const day = keeping(Date.now(), s.created).key;
    for (const id of nb.gone) {
      const r = recs[id];
      if (!r || r.extinct || back[id] === day) continue;
      back[id] = day;
      note('return', r.stats?.returns > 1 ? `*${r.name}* back again.` : `A *${r.name}* again, which I had thought gone.`, { id });
    }
    nb.gone = gone;
  }

  // =================================================================================================
  // The book
  // =================================================================================================
  const host = rootEl || document.body;
  const root = document.createElement('div');
  root.className = 'nb';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = `
    <div class="nb-scrim"></div>
    <div class="nb-stage">
      <div class="nb-book" role="dialog" aria-modal="true" aria-label="Field book" tabindex="-1">
        <div class="nb-board"></div>
        <div class="nb-stack nb-stack-l"></div><div class="nb-stack nb-stack-r"></div>
        <div class="nb-slot nb-slot-l"></div><div class="nb-slot nb-slot-r"></div>
        <div class="nb-cast nb-cast-l"></div><div class="nb-cast nb-cast-r"></div>
        <div class="nb-gutter"></div>
        <div class="nb-leaf"><div class="nb-face nb-front"><div class="nb-shade"></div></div><div class="nb-face nb-back"><div class="nb-shade"></div></div></div>
        <button class="nb-turn nb-prev" type="button" aria-label="Previous page"><i></i></button>
        <button class="nb-turn nb-next" type="button" aria-label="Next page"><i></i></button>
        <div class="nb-ribbons">
          <button class="nb-rib nb-rib-keeper" type="button" data-sec="keeper" aria-label="Her notes" title="Her notes"><span>V</span></button>
          <button class="nb-rib nb-rib-specimens" type="button" data-sec="specimens" aria-label="Specimens" title="Specimens"><span>№</span></button>
          <button class="nb-rib nb-rib-observations" type="button" data-sec="observations" aria-label="Observations" title="Observations"><span>¶</span></button>
        </div>
        <button class="nb-close" type="button" aria-label="Close the book" title="Close"><span>×</span></button>
      </div>
    </div>
    <div class="nb-measure" aria-hidden="true"></div>`;
  host.appendChild(root);
  const $ = (sel) => root.querySelector(sel);
  const scrim = $('.nb-scrim'), book = $('.nb-book'), slotL = $('.nb-slot-l'), slotR = $('.nb-slot-r');
  const leaf = $('.nb-leaf'), faceF = $('.nb-front'), faceB = $('.nb-back');
  const shadeF = faceF.firstElementChild, shadeB = faceB.firstElementChild;
  const castL = $('.nb-cast-l'), castR = $('.nb-cast-r');
  const btnPrev = $('.nb-prev'), btnNext = $('.nb-next'), measure = $('.nb-measure');
  const ribbons = [...root.querySelectorAll('.nb-rib')];

  let isOpen = false, closing = null;
  let markT = Infinity;         // lines and specimens written after this were unread when the book opened
  let L = null;                 // layout { spread, pw, ph, s, lh, dpr, key }
  let pages = [];               // page descriptors
  let secStart = {};
  let cur = 0;                  // current view (spread index, or page index when single)
  let turn = null;              // { anims, done }
  let sig = '';                 // content signature (rebuild when it changes)
  let reduced = false;
  try { reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch {}

  // fonts: ask early so the first open measures with the right faces
  const fontsReady = (() => {
    try {
      if (!document.fonts?.load) return Promise.resolve();
      return Promise.all(['20px Caveat', '500 20px Caveat', '20px "IM Fell English"', 'italic 20px "IM Fell English"',
        '20px "IM Fell English SC"', '20px "Old Standard TT"', 'italic 20px "Old Standard TT"']
        .map((f) => document.fonts.load(f).catch(() => null))).then(() => null, () => null);
    } catch { return Promise.resolve(); }
  })();
  let fontsLoaded = false;
  fontsReady.then(() => { fontsLoaded = true; if (isOpen) { hCache.clear(); rebuild(true); } });

  // ---- layout ---------------------------------------------------------------------------------------
  function computeLayout() {
    const vw = window.innerWidth || 1024, vh = window.innerHeight || 768;
    const margin = clamp(vh * 0.15, 60, 132);          // room for the close tab above, the ribbons below
    const spread = vw >= 700 && vw / vh >= 1.05 && vh - margin >= 430;
    let pw, ph;
    if (spread) {
      ph = Math.min(vh - margin, 860);
      pw = ph * 0.7;
      const maxW = Math.min(vw * 0.94, 1500) - 36;
      if (pw * 2 > maxW) { pw = maxW / 2; ph = pw / 0.7; }
    } else {
      pw = Math.min(vw * 0.88, 560);
      ph = Math.min(vh - margin, pw * 1.72);
      if (ph < pw * 1.15) pw = Math.max(Math.min(pw, ph / 1.15), Math.min(vw * 0.88, 300));
    }
    pw = Math.floor(pw); ph = Math.floor(ph);
    const s = Math.min(pw / 440, ph / 640);
    const lh = Math.max(23, Math.round(30 * s));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    return { spread, pw, ph, s, lh, dpr, vw, vh, key: `${spread ? 's' : 'p'}${pw}x${ph}@${dpr}` };
  }
  function applyLayout() {
    const prevKey = L?.key;
    L = computeLayout();
    const r = root.style;
    r.setProperty('--pw', L.pw + 'px');
    r.setProperty('--ph', L.ph + 'px');
    r.setProperty('--bw', (L.spread ? L.pw * 2 : L.pw) + 'px');
    r.setProperty('--s', L.s.toFixed(4));
    r.setProperty('--lh', L.lh + 'px');
    root.classList.toggle('nb-spread', L.spread);
    root.classList.toggle('nb-single', !L.spread);
    if (prevKey !== L.key) { hCache.clear(); deckleCache.clear(); skCache.clear(); }
  }

  // ---- paper ----------------------------------------------------------------------------------------
  // Deckled edges: the spine edge is cut straight, the other three are torn by hand.
  const deckleCache = new Map();
  function deckle(side, variant) {
    const key = side + variant;
    let v = deckleCache.get(key);
    if (v) return v;
    const w = L.pw, h = L.ph, rnd = seeded(hashStr('deckle' + key));
    const J = Math.max(1.4, w * 0.0042);
    const ph1 = rnd() * 6, ph2 = rnd() * 6;
    const d = (t) => clamp(J * (0.45 + 0.3 * Math.sin(t * 0.045 + ph1) + 0.2 * Math.sin(t * 0.19 + ph2) + 0.5 * (rnd() - 0.5)), 0, J * 1.6);
    const pts = [];
    const step = 6;
    const left = side === 'l';                       // the spine is on the right of a left page
    // top edge, from spine to fore-edge
    for (let x = 0; x <= w; x += step) pts.push([left ? w - x : x, d(x)]);
    // fore-edge
    for (let y = step; y <= h; y += step) pts.push([left ? d(y + 900) : w - d(y + 900), y]);
    // tail
    for (let x = w; x >= 0; x -= step) pts.push([left ? w - x : x, h - d(x + 1900)]);
    if (left) pts.reverse();
    v = `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})`;
    deckleCache.set(key, v);
    return v;
  }
  // Her last page: the lower part is torn away. The tear runs from the fore-edge down toward the
  // spine; the same line clips the page and draws the pale, fibrous rim of the torn paper.
  function tearLine(side) {
    const w = L.pw, h = L.ph, rnd = seeded(hashStr('tear' + side));
    const pts = [];
    let drift = 0;
    for (let x = 0; x <= w + 0.1; x += 3) {
      const t = x / w;
      drift += (rnd() - 0.5) * 2.2; drift *= 0.93;
      const yy = h * (0.66 + 0.13 * t * t) + drift * 3 + Math.sin(t * 9 + 1) * h * 0.012 + (rnd() - 0.5) * 2.5;
      pts.push([x, yy]);
    }
    // x runs from the fore-edge (0) to the spine (w)
    return pts.map(([x, yy]) => [side === 'l' ? x : w - x, yy]);
  }
  function tornClip(side) {
    const key = 'torn' + side;
    let v = deckleCache.get(key);
    if (v) return v;
    const w = L.pw, rnd = seeded(hashStr('deckle-torn' + side));
    const J = Math.max(1.4, w * 0.0042);
    const d = () => J * (0.4 + 0.6 * rnd());
    const left = side === 'l', tear = tearLine(side);
    const pts = [];
    if (!left) {
      for (let x = 0; x <= w; x += 6) pts.push([x, d()]);
      for (let y = 6; y < tear[0][1]; y += 6) pts.push([w - d(), y]);
      for (const p of tear) pts.push(p);
    } else {
      for (let x = w; x >= 0; x -= 6) pts.push([x, d()]);
      for (let y = 6; y < tear[0][1]; y += 6) pts.push([d(), y]);
      for (const p of tear) pts.push(p);
    }
    v = `polygon(${pts.map(([x, y]) => `${x.toFixed(1)}px ${y.toFixed(1)}px`).join(',')})`;
    deckleCache.set(key, v);
    return v;
  }
  function tornRim(side) {
    return sketchCanvas(L.pw, L.ph, 'tornrim' + side, (g) => {
      const tear = tearLine(side), rnd = seeded(31);
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      tear.forEach(([x, y], i) => (i ? g.lineTo(x, y - 1.2) : g.moveTo(x, y - 1.2)));
      g.strokeStyle = 'rgba(252,247,234,0.95)'; g.lineWidth = 3.2; g.stroke();
      g.beginPath();
      tear.forEach(([x, y], i) => (i ? g.lineTo(x, y - 3.4) : g.moveTo(x, y - 3.4)));
      g.strokeStyle = 'rgba(160,120,70,0.16)'; g.lineWidth = 1.4; g.stroke();
      for (let i = 0; i < tear.length; i += 2) {              // loose fibres
        if (rnd() < 0.5) continue;
        const [x, y] = tear[i], l = 1 + rnd() * 3.5, a = Math.PI / 2 + (rnd() - 0.5) * 1.4;
        g.beginPath(); g.moveTo(x, y - 1); g.lineTo(x + Math.cos(a) * l, y - 1 + Math.sin(a) * l);
        g.strokeStyle = 'rgba(250,244,228,0.9)'; g.lineWidth = 0.7; g.stroke();
      }
    });
  }

  // Foxing: rust-brown age spots, more of them toward the edges.
  function foxing(key, heavy = 1) {
    const rnd = seeded(hashStr('fox' + key));
    const layers = [];
    const n = Math.round((3 + rnd() * 7) * heavy);
    for (let i = 0; i < n; i++) {
      const edge = rnd() < 0.7;
      let x = rnd(), y = rnd();
      if (edge) { if (rnd() < 0.5) x = rnd() < 0.5 ? rnd() * 0.12 : 1 - rnd() * 0.12; else y = rnd() < 0.5 ? rnd() * 0.1 : 1 - rnd() * 0.1; }
      const r = (1.5 + Math.pow(rnd(), 3) * 16) * (L?.s || 1);
      const a = 0.08 + rnd() * 0.16;
      layers.push(`radial-gradient(circle ${r.toFixed(1)}px at ${(x * 100).toFixed(1)}% ${(y * 100).toFixed(1)}%, rgba(146,88,36,${a.toFixed(3)}) 0, rgba(146,88,36,${(a * 0.45).toFixed(3)}) 55%, rgba(146,88,36,0) 100%)`);
      if (rnd() < 0.4) {                                  // a cluster of pin-point specks
        for (let j = 0; j < 4; j++) {
          const xx = clamp(x + (rnd() - 0.5) * 0.05, 0, 1), yy = clamp(y + (rnd() - 0.5) * 0.04, 0, 1);
          layers.push(`radial-gradient(circle ${(0.8 + rnd() * 1.6).toFixed(1)}px at ${(xx * 100).toFixed(1)}% ${(yy * 100).toFixed(1)}%, rgba(120,70,30,${(0.2 + rnd() * 0.2).toFixed(2)}) 0, rgba(120,70,30,0) 100%)`);
        }
      }
    }
    if (rnd() < 0.3 * heavy) {                            // a faint tide-mark
      const x = 15 + rnd() * 70, y = 10 + rnd() * 80, r = (40 + rnd() * 70) * (L?.s || 1);
      layers.push(`radial-gradient(circle ${r.toFixed(0)}px at ${x.toFixed(0)}% ${y.toFixed(0)}%, rgba(160,120,60,0) 0, rgba(160,120,60,0) 88%, rgba(150,105,50,0.10) 95%, rgba(160,120,60,0) 100%)`);
    }
    return layers.join(',');
  }

  // ---- sketches ---------------------------------------------------------------------------------------
  const skCache = new Map();
  function sketchCanvas(cssW, cssH, key, draw) {
    const k = `${key}@${cssW}x${cssH}`;
    let src = skCache.get(k);
    if (!src) {
      src = document.createElement('canvas');
      src.width = Math.max(1, Math.round(cssW * L.dpr)); src.height = Math.max(1, Math.round(cssH * L.dpr));
      const g = src.getContext('2d');
      if (g) { g.scale(L.dpr, L.dpr); try { draw(g, cssW, cssH); } catch (err) { report(err); } }
      skCache.set(k, src);
    }
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.style.width = cssW + 'px'; c.style.height = cssH + 'px';
    c.getContext('2d')?.drawImage(src, 0, 0);
    return c;
  }
  const modeList = (comps) => (comps || []).map((id) => { try { return Modes.modeById(id); } catch { return null; } }).filter(Boolean);
  function evalSum(ms, u, v) {
    let f = 0;
    for (let i = 0; i < ms.length; i++) f += Modes.evalMode(ms[i], u, v);
    return f / Math.sqrt(ms.length || 1);
  }
  // a line drawn by a careful, not mechanical, hand
  function handLine(g, pts, rnd, width, rgba, wob = 0.6) {
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0] + (rnd() - 0.5) * wob, y = pts[i][1] + (rnd() - 0.5) * wob;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.lineWidth = width; g.strokeStyle = rgba; g.lineCap = 'round'; g.lineJoin = 'round';
    g.stroke();
  }
  function handRect(g, x, y, w, h, rnd, width, rgba) {
    const seg = (x0, y0, x1, y1) => {
      const pts = [], n = 10, ov = 0.03;
      for (let i = 0; i <= n; i++) {
        const t = -ov + (1 + 2 * ov) * (i / n);
        pts.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
      }
      handLine(g, pts, rnd, width * (0.8 + rnd() * 0.4), rgba, 0.8);
    };
    seg(x, y, x + w, y); seg(x + w, y, x + w, y + h); seg(x + w, y + h, x, y + h); seg(x, y + h, x, y);
  }
  // Her figures: sand stippled where the plate is still, as if she had sprinkled it on the page.
  function stippleFigure(g, w, h, comps, seed, inkRGB = INK) {
    const rnd = seeded(seed);
    const ms = modeList(comps);
    const pad = w * 0.07, span = Math.min(w, h) - pad * 2, ox = (w - span) / 2, oy = (h - span) / 2;
    handRect(g, ox, oy, span, span, rnd, Math.max(0.7, span * 0.008), `rgba(${inkRGB},0.62)`);
    if (!ms.length) return;
    const tries = Math.round(span * span * 0.45);
    const floor = ms.length === 1 && ms[0].special;
    for (let i = 0; i < tries; i++) {
      const u = rnd() * 2 - 1, v = rnd() * 2 - 1;
      const f = Math.abs(evalSum(ms, u, v));
      const lim = floor ? 0.12 : 0.085;
      if (f > lim * (0.4 + rnd() * 0.8)) continue;
      const x = ox + (u + 1) * 0.5 * span, y = oy + (v + 1) * 0.5 * span;
      g.fillStyle = `rgba(${inkRGB},${(0.35 + rnd() * 0.5).toFixed(2)})`;
      g.beginPath(); g.arc(x, y, 0.35 + rnd() * 0.55, 0, 6.2832); g.fill();
    }
    // the clamp
    g.strokeStyle = `rgba(${inkRGB},0.7)`; g.lineWidth = 0.8;
    g.beginPath(); g.arc(ox + span / 2, oy + span / 2, span * 0.035, 0, 6.2832); g.stroke();
  }
  // Fallback specimen sketch (when the renderer has none to lend): ink along the still lines.
  function inkFigure(g, w, comps, aurata) {
    const ms = modeList(comps);
    const rnd = seeded(hashStr(String(comps)));
    const pad = w * 0.08, span = w - pad * 2;
    handRect(g, pad, pad, span, span, rnd, Math.max(0.7, w * 0.006), `rgba(${INK},0.45)`);
    if (!ms.length) return;
    const N = Math.round(w * 0.9);
    const img = g.getImageData(0, 0, Math.round(w * L.dpr), Math.round(w * L.dpr));
    const d = img.data, W = img.width;
    const inv = 1 / W;
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) * inv * w - pad) / span * 2 - 1, v = ((y + 0.5) * inv * w - pad) / span * 2 - 1;
      if (u < -1 || u > 1 || v < -1 || v > 1) continue;
      const f = Math.abs(evalSum(ms, u, v));
      const a = clamp(1 - f / (2.4 / N * 6), 0, 1);
      if (a <= 0) continue;
      const i = (y * W + x) * 4;
      d[i] = aurata ? 150 : 74; d[i + 1] = aurata ? 104 : 47; d[i + 2] = aurata ? 30 : 28;
      d[i + 3] = Math.max(d[i + 3], Math.round(a * a * 215));
    }
    g.putImageData(img, 0, 0);
  }
  function specimenSketch(rec, px) {
    const comps = rec.comps || [];
    const aur = !!rec.aurata;
    return sketchCanvas(px, px, 'sp:' + comps.join('+') + (aur ? '*' : ''), (g, w) => {
      let src = null;
      try { src = game.gfx?.figureCanvas?.(comps, Math.round(w * L.dpr)); } catch { src = null; }
      if (src && src.width) {
        g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
        g.drawImage(src, 0, 0, Math.round(w * L.dpr), Math.round(w * L.dpr));
        if (aur) {                                         // gilded forms are drawn in gold ink
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = 'rgba(176,122,34,0.85)';
          g.fillRect(0, 0, Math.round(w * L.dpr), Math.round(w * L.dpr));
        }
        g.restore();
      } else inkFigure(g, w, comps, aur);
    });
  }

  // her marginal drawings
  function keeperSketch(sk, w, h, seed) {
    return sketchCanvas(w, h, `k:${sk.kind}:${sk.mode || ''}:${seed}`, (g) => {
      const rnd = seeded(seed);
      const ink = (a) => `rgba(${INK},${a})`;
      if (sk.kind === 'mode') { stippleFigure(g, w, h, [sk.mode], seed); return; }
      if (sk.kind === 'ring') {
        const cx = w / 2, cy = h / 2, R = Math.min(w, h);
        // the finger: a soft oval, hatched
        g.save();
        g.beginPath(); g.ellipse(cx, cy, R * 0.11, R * 0.13, 0.3, 0, 6.2832); g.clip();
        for (let i = -20; i < 20; i++) handLine(g, [[cx + i * 2.2 - R * 0.2, cy - R * 0.2], [cx + i * 2.2 + R * 0.2, cy + R * 0.2]], rnd, 0.6, ink(0.35), 0.4);
        g.restore();
        g.beginPath(); g.ellipse(cx, cy, R * 0.11, R * 0.13, 0.3, 0, 6.2832); g.strokeStyle = ink(0.75); g.lineWidth = 1; g.stroke();
        // seven of them, sitting close
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * 6.2832 + 0.4 + (rnd() - 0.5) * 0.25, rr = R * (0.24 + (rnd() - 0.5) * 0.02);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr, r0 = R * 0.045;
          g.beginPath(); g.arc(x, y, r0, 0, 6.2832); g.strokeStyle = ink(0.8); g.lineWidth = 0.9; g.stroke();
          handLine(g, [[x - r0 * 0.6, y], [x + r0 * 0.6, y]], rnd, 0.6, ink(0.6), 0.3);
          handLine(g, [[x, y - r0 * 0.6], [x, y + r0 * 0.6]], rnd, 0.6, ink(0.6), 0.3);
          if (i % 3 === 0) {                              // the way it came
            const pts = [];
            for (let t = 0; t <= 8; t++) {
              const q = 1 + t * 0.09;
              pts.push([cx + Math.cos(a + t * 0.05) * rr * q * 1.05, cy + Math.sin(a + t * 0.05) * rr * q * 1.05]);
            }
            g.setLineDash([1.2, 2.6]); handLine(g, pts, rnd, 0.7, ink(0.45), 0.3); g.setLineDash([]);
          }
        }
        return;
      }
      if (sk.kind === 'crack') {
        // the plate, and the crack running in from its edge: sharp zigzags, thinning as it goes
        const pad = w * 0.07, span = Math.min(w, h) - pad * 2, ox = (w - span) / 2, oy = (h - span) / 2;
        handRect(g, ox, oy, span, span, rnd, 0.9, ink(0.6));
        const run = (x, y, base, n, w0) => {
          const pts = [[x, y]];
          for (let i = 0; i < n; i++) {
            const a = base + (i % 2 ? 0.55 : -0.55) * (0.4 + rnd() * 0.8);
            const l = span * 0.042 * (0.6 + rnd() * 0.8);
            x += Math.cos(a) * l; y += Math.sin(a) * l;
            pts.push([x, y]);
          }
          for (let i = 1; i < pts.length; i++) {
            g.beginPath(); g.moveTo(pts[i - 1][0], pts[i - 1][1]); g.lineTo(pts[i][0], pts[i][1]);
            g.lineWidth = Math.max(0.45, w0 * (1 - i / pts.length)); g.strokeStyle = ink(0.88); g.lineCap = 'round'; g.stroke();
          }
          return pts;
        };
        const main = run(ox + span, oy + span * 0.34, Math.PI + 0.32, 15, 1.9);
        run(main[6][0], main[6][1], Math.PI + 1.1, 5, 0.9);
        run(main[10][0], main[10][1], Math.PI - 0.5, 3, 0.7);
        // the clamp, for scale
        g.beginPath(); g.arc(ox + span / 2, oy + span / 2, span * 0.035, 0, 6.2832); g.strokeStyle = ink(0.6); g.lineWidth = 0.8; g.stroke();
        return;
      }
      if (sk.kind === 'thimble') {
        const cx = w * 0.42, base = h * 0.84, tw = w * 0.36, th = h * 0.58;
        g.beginPath();
        g.moveTo(cx - tw / 2, base);
        g.bezierCurveTo(cx - tw * 0.48, base - th * 0.6, cx - tw * 0.42, base - th, cx, base - th);
        g.bezierCurveTo(cx + tw * 0.42, base - th, cx + tw * 0.48, base - th * 0.6, cx + tw / 2, base);
        g.strokeStyle = ink(0.8); g.lineWidth = 1.1; g.stroke();
        g.beginPath(); g.ellipse(cx, base, tw / 2, tw * 0.12, 0, 0, 6.2832); g.stroke();
        g.beginPath(); g.ellipse(cx, base - th * 0.06, tw * 0.49, tw * 0.1, 0, Math.PI, 0); g.lineWidth = 0.7; g.stroke();
        for (let row = 0; row < 6; row++) {                // the dimples
          const yy = base - th * (0.18 + row * 0.13), half = tw * (0.46 - row * row * 0.012);
          for (let x = -half + 3; x < half - 2; x += 3.6) {
            g.fillStyle = ink(0.45); g.beginPath(); g.arc(cx + x + (row % 2) * 1.8, yy, 0.55, 0, 6.2832); g.fill();
          }
        }
        for (let i = 0; i < 9; i++) {                      // nine grains of gold
          g.fillStyle = ink(0.85);
          g.beginPath(); g.arc(w * 0.74 + (rnd() - 0.5) * w * 0.16, base - rnd() * h * 0.12, 0.9 + rnd() * 0.5, 0, 6.2832); g.fill();
        }
        return;
      }
      if (sk.kind === 'tally') {
        // five, ten, twenty, forty: gated tallies, spaced to fit whatever width the page allows
        const groups = [5, 10, 20, 40];
        const strokes = 75, gates = 15;
        const u = (w * 0.94) / (strokes * 3.4 + gates * 3 + groups.length * 12);
        let x = w * 0.03;
        const y = h * 0.2, hh = h * 0.42;
        g.font = `${Math.round(Math.min(h * 0.26, 15))}px Caveat, cursive`;
        g.fillStyle = ink(0.75);
        for (const n of groups) {
          const x0 = x;
          for (let k = 0; k < n; k++) {
            if (k % 5 === 4) {
              handLine(g, [[x - 13 * u, y + hh * 0.75], [x + u, y + hh * 0.2]], rnd, 0.9, ink(0.8), 0.6);
              x += 3 * u;
            } else {
              handLine(g, [[x, y], [x + (rnd() - 0.5) * 1.5, y + hh]], rnd, 0.9, ink(0.8), 0.6);
              x += 3.4 * u;
            }
          }
          g.fillText(String(n), (x0 + x) / 2 - 6, y + hh + h * 0.3);
          x += 12 * u;
        }
        return;
      }
    });
  }
  // a pressed flower that left its ghost in the paper
  function flowerStain(w, h, seed) {
    return sketchCanvas(w, h, 'flower:' + seed, (g) => {
      const rnd = seeded(seed);
      const cx = w * 0.55, cy = h * 0.32;
      g.globalCompositeOperation = 'multiply';
      const blot = (x, y, rx, ry, a, rot) => {
        g.save(); g.translate(x, y); g.rotate(rot);
        const gr = g.createRadialGradient(0, 0, 0, 0, 0, Math.max(rx, ry));
        gr.addColorStop(0, `rgba(150,105,55,${a * 0.5})`); gr.addColorStop(0.75, `rgba(140,95,48,${a})`); gr.addColorStop(1, 'rgba(140,95,48,0)');
        g.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
        g.fillStyle = gr; g.beginPath(); g.arc(0, 0, Math.max(rx, ry), 0, 6.2832); g.fill();
        g.restore();
      };
      // the oily halo it pressed into the page
      blot(cx, cy + h * 0.16, w * 0.36, h * 0.42, 0.06, 0.1);
      // stem and leaves
      g.strokeStyle = 'rgba(120,88,48,0.32)'; g.lineWidth = 1.6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx, cy + 4); g.bezierCurveTo(cx - w * 0.06, cy + h * 0.25, cx + w * 0.05, cy + h * 0.45, cx - w * 0.03, cy + h * 0.66); g.stroke();
      blot(cx - w * 0.1, cy + h * 0.33, w * 0.11, h * 0.035, 0.22, -0.6);
      blot(cx + w * 0.08, cy + h * 0.47, w * 0.1, h * 0.03, 0.2, 0.5);
      // five petals
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * 6.2832 + rnd() * 0.3;
        blot(cx + Math.cos(a) * w * 0.07, cy + Math.sin(a) * w * 0.07, w * 0.085, w * 0.05, 0.22 + rnd() * 0.08, a);
      }
      blot(cx, cy, w * 0.03, w * 0.03, 0.4, 0);
    });
  }
  // Marbled endpaper, Turkish stone: dark inks floated first, then smaller drops of ochre, slate and
  // gall-white that crowd the earlier ones into fine veins; then a slow wave drawn through it all.
  // Rendered by inverse mapping (undo the wave, then each drop, newest first), a few rows at a time
  // while the browser is idle, so it is ready long before the book is opened.
  const MW = 300, MH = 429;
  let marble = null;
  function marbleInit() {
    const rnd = seeded(1891);
    // first the veins (they will be crowded thin), then the stones, each pushing the last aside
    const veins = [[184, 140, 64], [62, 88, 78], [232, 220, 192], [232, 220, 192], [150, 58, 42], [204, 170, 98], [28, 34, 56]];
    const stones = [[110, 36, 30], [120, 42, 33], [36, 48, 78], [30, 38, 62], [46, 62, 90], [110, 36, 30], [36, 48, 78], [176, 132, 60]];
    const NV = 170, N = 440, drops = new Float32Array(N * 3), cols = [];
    for (let i = 0; i < N; i++) {
      const vein = i < NV;
      drops[i * 3] = rnd() * MW; drops[i * 3 + 1] = rnd() * MH;
      drops[i * 3 + 2] = vein ? 5 + rnd() * 6 : 10 + rnd() * 11;
      cols.push(vein ? veins[Math.floor(rnd() * veins.length)] : stones[Math.floor(rnd() * stones.length)]);
    }
    const canvas = document.createElement('canvas');
    canvas.width = MW; canvas.height = MH;
    const ctx = canvas.getContext('2d');
    marble = { canvas, ctx, img: ctx ? ctx.createImageData(MW, MH) : null, row: 0, done: !ctx, drops, cols, N, rnd };
  }
  function marbleRows(n) {
    if (!marble) marbleInit();
    const M = marble;
    if (M.done) return;
    const d = M.img.data, drops = M.drops, cols = M.cols, N = M.N;
    const end = Math.min(MH, M.row + n);
    for (let y = M.row; y < end; y++) for (let x = 0; x < MW; x++) {
      let px = x - 3 * Math.sin(y * 0.05 + 0.7);
      let py = y - 7 * Math.sin(px * 0.034 + 1.3) - 2 * Math.sin(px * 0.11);
      let col = null;
      for (let i = N - 1; i >= 0; i--) {
        const cx = drops[i * 3], cy = drops[i * 3 + 1], r = drops[i * 3 + 2];
        const dx = px - cx, dy = py - cy, d2 = dx * dx + dy * dy, r2 = r * r;
        if (d2 < r2) { col = cols[i]; break; }
        if (d2 < r2 * 40) { const f = Math.sqrt(1 - r2 / d2); px = cx + dx * f; py = cy + dy * f; }
      }
      col ||= [226, 212, 182];
      const i4 = (y * MW + x) * 4, nz = (M.rnd() - 0.5) * 7;
      d[i4] = col[0] + nz; d[i4 + 1] = col[1] + nz; d[i4 + 2] = col[2] + nz; d[i4 + 3] = 255;
    }
    M.row = end;
    if (M.row >= MH) { M.ctx.putImageData(M.img, 0, 0); M.done = true; M.img = null; }
  }
  function marbleSource() { while (!marble || !marble.done) marbleRows(MH); return marble.canvas; }
  function marbleCanvas(w, h) {
    const src = marbleSource();
    const c = document.createElement('canvas');
    c.width = Math.round(w * L.dpr); c.height = Math.round(h * L.dpr);
    const g = c.getContext('2d');
    if (g) {
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
      try { g.filter = `blur(${(0.45 * c.width / MW).toFixed(2)}px)`; } catch {}
      g.drawImage(src, 0, 0, c.width, c.height);
    }
    return c;
  }
  try {
    const idle = window.requestIdleCallback || ((f) => setTimeout(() => f({ timeRemaining: () => 8 }), 200));
    const tick = (dl) => {
      try { do marbleRows(12); while (!marble.done && dl?.timeRemaining?.() > 4); } catch { return; }
      if (!marble.done) idle(tick);
    };
    setTimeout(() => idle(tick), 2500);
  } catch {}

  // ---- page content -------------------------------------------------------------------------------
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const recordCount = () => Object.keys(st().species || {}).length;
  const sizedBox = (px) => { const b = el('div'); b.style.width = b.style.height = px + 'px'; return b; };

  function livingMap() {
    const m = new Map();
    let pops = null;
    try { pops = game.life?.populations?.(); } catch { pops = null; }
    if (pops) for (const p of pops) if (p && p.id != null) m.set(p.id, p.count || 0);
    return m;
  }

  function buildFlyleaf(body) {
    const s = st();
    const fly = el('div', 'nb-fly');
    fly.appendChild(el('div', 'nb-fly-k',
      '<div class="nb-fly-name">M. A. Voss.</div><div class="nb-fly-title">Observations upon<br>the Still Places.</div>' +
      '<div class="nb-fly-year">— 1891 —</div>'));
    const firstRec = speciesList()[0];
    if (firstRec) {
      const d = new Date(firstRec.firstSeen || s.created || Date.now());
      fly.appendChild(el('div', 'nb-fly-p', `Continued, the ${dateOrdinal(d.getDate())} of ${MONTHS[d.getMonth()]}.`));
    }
    body.appendChild(fly);
  }

  function buildEndpaper(page) {
    const m = marbleCanvas(L.pw, L.ph);
    m.className = 'nb-marble';
    page.appendChild(m);
    page.appendChild(el('div', 'nb-ticket', '<b>J. Ritter</b><span>Physikalische Instrumente</span><span>Leipzig</span>'));
  }

  function buildKeeper(body, entry, idx, page) {
    const s = st();
    const wrap = el('div', 'nb-k');
    wrap.appendChild(el('div', 'nb-k-date', esc(entry.date)));
    const sk = entry.sketch || [];
    const skW = Math.round(clamp(L.pw * 0.34, 96, 190));
    if (sk.length === 1 && sk[0].kind !== 'tally') {
      const fig = el('figure', 'nb-sk ' + (idx % 2 ? 'nb-sk-l' : 'nb-sk-r'));
      const h = sk[0].kind === 'thimble' ? Math.round(skW * 0.8) : skW;
      fig.appendChild(keeperSketch(sk[0], skW, h, hashStr(entry.id)));
      if (sk[0].label) fig.appendChild(el('figcaption', '', esc(sk[0].label)));
      wrap.appendChild(fig);
    }
    const text = el('div', 'nb-k-text', inkMarkup(entry.text));
    wrap.appendChild(text);
    if (sk.length > 1) {
      const row = el('div', 'nb-sk-row');
      sk.forEach((k, i) => {
        const fig = el('figure', 'nb-sk');
        fig.appendChild(keeperSketch(k, Math.round(skW * 0.74), Math.round(skW * 0.74), hashStr(entry.id + i)));
        fig.appendChild(el('figcaption', '', `fig. ${i + 1}${k.label ? ' — ' + esc(k.label) : ''}`));
        row.appendChild(fig);
      });
      wrap.appendChild(row);
    }
    if (sk.length === 1 && sk[0].kind === 'tally') {
      const fig = el('figure', 'nb-sk nb-sk-wide');
      fig.appendChild(keeperSketch(sk[0], Math.round(L.pw * 0.74), Math.round(L.lh * 2.4), hashStr(entry.id)));
      wrap.appendChild(fig);
    }
    if (entry.post) wrap.appendChild(el('div', 'nb-k-post', inkMarkup(entry.post)));
    if (entry.torn) {
      const floorHeard = !!s.seen?.floor;
      const rest = el('div', 'nb-k-rest' + (floorHeard ? ' nb-legible' : ''), inkMarkup(entry.rest || ''));
      wrap.appendChild(rest);
      if (floorHeard && entry.after) {
        const nb = nbState();
        const d = new Date(nb.psT ||= nb.f.floor || Date.now());
        const ps = el('div', 'nb-k-after');
        ps.appendChild(el('div', 'nb-k-after-d', `${dateOrdinal(d.getDate())} ${MONTHS[d.getMonth()]}`));
        ps.appendChild(el('div', 'nb-k-after-t', inkMarkup(entry.after)));
        wrap.appendChild(ps);
      }
      page.classList.add('nb-torn');
      page.appendChild(el('div', 'nb-water' + (floorHeard ? ' nb-dry' : '')));
    }
    if (entry.stain === 'flower') {
      const fl = flowerStain(Math.round(L.pw * 0.5), Math.round(L.ph * 0.42), hashStr(entry.id + 'fl'));
      fl.className = 'nb-flower';
      page.appendChild(fl);
    }
    body.appendChild(wrap);
  }

  // specimens ---------------------------------------------------------------------------------------
  function ratioLabel(r) {
    const ks = (r.ks || []).slice().sort((a, b) => a - b);
    if (ks.length <= 1) {
      let t = r.ratio || '';
      if (!t) { try { t = Naming.speciesRatioText?.(r) || ''; } catch { t = ''; } }
      return t || (ks[0] ? `k ${ks[0]}` : '');
    }
    let g = 0;
    for (const k of ks) g = gcd(g, k);
    const rat = ks.map((k) => k / g).join(' : ');
    let iv = '';
    try { iv = ks.length === 2 ? Naming.intervalName?.(ks[0], ks[1]) || '' : ''; } catch { iv = ''; }
    return `k ${ks.join(', ')} · ${rat}${iv && !/:/.test(iv) ? ', ' + article(iv) : ks.length > 2 ? ', a chord' : ''}`;
  }
  function clanLabel(r) {
    const ks = r.ks || [];
    const clans = [...new Set((ks.length ? ks.map(clanOf) : [r.clan]).filter((c) => c && c !== '0'))];
    if (!clans.length) return '';
    const w = clans.map((c) => words(+c));
    return clans.length === 1 ? `clan\u00a0of\u00a0${w[0]}` : `clans\u00a0of\u00a0${w.slice(0, -1).join(', ')} and\u00a0${w[w.length - 1]}`;
  }
  function parentsLabel(r) {
    const sp = st().species || {};
    const p = r.parents;
    if (p && p.length === 2 && p[0] === p[1]) {
      const n = sp[p[0]]?.name;
      return n ? `a sport of <i>${esc(n)}</i>` : '';
    }
    let names = r.parentNames ? String(r.parentNames).split(' × ') : (p || []).map((id) => sp[id]?.name).filter(Boolean);
    if (names.length < 2) return '';
    return 'of ' + names.map((n) => `<i>${esc(n)}</i>`).join(' × ');
  }
  function noteOf(r) {
    if (r.note) return r.note;
    try { return Naming.noteFor?.(game.life?.species?.[r.id] || r, r, st().stats) || ''; } catch { return ''; }
  }
  function specimenItems() {
    const s = st(), recs = speciesList();
    const items = recs.map((r, i) => (isKeeper(r) ? {
      key: `vossia|${(noteOf(r) || '').length}`,
      id: r.id,
      build: (meas) => buildVossia(r, i + 1, meas),
    } : {
      key: `sp|${r.id}|${(noteOf(r) || '').length}|${r.extinct ? 1 : 0}|${r.parents ? 1 : 0}`,
      id: r.id,
      build: (meas) => buildSpecimen(r, i + 1, meas),
    }));
    // what is not yet in the book: pencilled question marks
    const has3 = recs.some((r) => (r.comps || []).length >= 3);
    const hasGold = recs.some((r) => r.aurata);
    const floorHeard = !!s.seen?.floor;
    const seam = keeperPagesFor(s).some((p) => p.id === 'seam');
    if (floorHeard && !recs.some(isKeeper)) items.push({ key: 'floor|heard', build: (meas) => buildFloorEntry(meas) });
    if (!hasGold && seam) items.push({ key: 'q|gold', build: (meas) => buildTeaser('gold', 'Veined with gold? She writes of one born along a mended seam.', meas) });
    if (!has3) items.push({ key: 'q|three', build: (meas) => buildTeaser('three', 'Three voices in one body. Not yet seen.', meas) });
    if (!floorHeard) items.push({ key: 'q|floor', build: (meas) => buildTeaser('floor', 'Something below the lowest note. She heard it once.', meas) });
    return items;
  }
  function buildSpecimen(r, no, meas) {
    const created = st().created;
    const e = el('div', 'nb-sp' + (r.extinct ? ' nb-gone' : '') + ((r.firstSeen || 0) > markT ? ' nb-new' : ''));
    e.dataset.id = r.id;
    const px = Math.round(clamp(92 * L.s, 72, 116));
    const fig = el('div', 'nb-sp-fig');
    fig.style.width = px + 'px';
    fig.appendChild(meas ? sizedBox(px) : specimenSketch(r, px));
    fig.appendChild(el('span', 'nb-sp-no', `No. ${no}`));
    e.appendChild(fig);
    const t = el('div', 'nb-sp-txt');
    t.appendChild(el('div', 'nb-sp-name', esc(r.name || 'Incertae sedis')));
    const ratio = ratioLabel(r), clan = clanLabel(r);
    t.appendChild(el('div', 'nb-lab', `${esc(ratio)}${clan ? ` <span class="nb-dot">·</span> <span class="nb-lk">${esc(clan)}</span>` : ''}`));
    const ks = keeping(r.firstSeen || Date.now(), created);
    t.appendChild(el('div', 'nb-lab', `<span class="nb-lk">first seen</span> ${esc(ks.label)}, ${clock(r.firstSeen || Date.now())}`));
    const living = r.extinct ? 0 : r.count || 0;
    t.appendChild(el('div', 'nb-lab',
      `<span class="nb-lk">peak</span> <b data-peak="${esc(r.id)}">${r.peak || 0}</b> <span class="nb-dot">·</span> ` +
      `<span class="nb-lk">living</span> <b data-live="${esc(r.id)}">${living ? living : 'none'}</b>`));
    const par = parentsLabel(r);
    if (par) t.appendChild(el('div', 'nb-sp-par', par));
    e.appendChild(t);
    const n = noteOf(r);
    if (n) e.appendChild(el('div', 'nb-sp-note', esc(n)));
    if (r.extinct) {
      const a = -4 - (hashStr(r.id) % 9);
      const stamp = el('div', 'nb-stamp', '<span>Extinct</span>');
      stamp.style.transform = `rotate(${a}deg)`;
      e.appendChild(stamp);
    }
    return e;
  }
  // Vossia fundamentalis. The entry is begun in the usual way, and finished in her hand: her figure,
  // her note, and in place of the count a line of her own. She is never counted and never extinct.
  function buildVossia(r, no, meas) {
    const e = el('div', 'nb-sp nb-vossia' + ((r.firstSeen || 0) > markT ? ' nb-new' : ''));
    e.dataset.id = r.id;
    const px = Math.round(clamp(92 * L.s, 72, 116));
    const fig = el('div', 'nb-sp-fig');
    fig.style.width = px + 'px';
    fig.appendChild(meas ? sizedBox(px) : sketchCanvas(px, px, 'vossia', (g, w, h) => vossiaSketch(g, w, h)));
    fig.appendChild(el('span', 'nb-sp-no', `No. ${no}`));
    e.appendChild(fig);
    const t = el('div', 'nb-sp-txt');
    t.appendChild(el('div', 'nb-sp-name', esc(r.name || 'Vossia fundamentalis')));
    const ratio = ratioLabel(r) || 'k 2';
    t.appendChild(el('div', 'nb-lab', `${esc(ratio)} <span class="nb-dot">·</span> <span class="nb-lk">clan&nbsp;of&nbsp;one</span>`));
    const ks = keeping(r.firstSeen || Date.now(), st().created);
    t.appendChild(el('div', 'nb-lab', `<span class="nb-lk">first seen</span> ${esc(ks.label)}, ${clock(r.firstSeen || Date.now())}`));
    t.appendChild(el('div', 'nb-vh nb-vh-count', 'Do not trouble to count me.'));
    e.appendChild(t);
    const n = noteOf(r);
    if (n) e.appendChild(el('div', 'nb-sp-note nb-vh', esc(n)));
    return e;
  }
  // the floor's figure in her ink: every grain at the rim, and her on it, going round
  function vossiaSketch(g, w, h) {
    stippleFigure(g, w, h, ['floor'], 1891, INK);
    const rnd = seeded(18910714);
    const pad = w * 0.07, span = Math.min(w, h) - pad * 2, ox = (w - span) / 2, oy = (h - span) / 2;
    const X = (u) => ox + (u + 1) * 0.5 * span, Y = (v) => oy + (v + 1) * 0.5 * span;
    const ink = (a) => `rgba(${INK},${a})`;
    // the way she came, dotted, along the top
    const trail = [];
    for (let i = 0; i <= 12; i++) trail.push([X(-0.62 + i * 0.055), Y(-0.83 + Math.sin(i * 0.9) * 0.008)]);
    g.setLineDash([1, 2.2]); handLine(g, trail, rnd, 0.85, ink(0.6), 0.25); g.setLineDash([]);
    // her: a pale disc with the floor's own figure in it (a ring), and well ahead of her an arrow
    const cx = X(0.12), cy = Y(-0.83), r0 = span * 0.075;
    g.fillStyle = 'rgba(243,235,214,1)';
    g.beginPath(); g.arc(cx, cy, r0 * 1.25, 0, 6.2832); g.fill();
    g.beginPath(); g.arc(cx, cy, r0, 0, 6.2832); g.strokeStyle = ink(0.85); g.lineWidth = 0.95; g.stroke();
    g.beginPath(); g.arc(cx, cy, r0 * 0.55, 0, 6.2832); g.strokeStyle = ink(0.6); g.lineWidth = 0.6; g.stroke();
    const ax = X(0.6), ay = Y(-0.83), al = span * 0.05;
    handLine(g, [[ax - al * 1.6, ay], [ax, ay]], rnd, 0.8, ink(0.7), 0.2);
    handLine(g, [[ax - al * 0.7, ay - al * 0.55], [ax, ay], [ax - al * 0.7, ay + al * 0.55]], rnd, 0.8, ink(0.7), 0.2);
  }
  function buildTeaser(which, text, meas) {
    const e = el('div', 'nb-sp nb-q');
    const px = Math.round(clamp(92 * L.s, 72, 116));
    const fig = el('div', 'nb-sp-fig nb-q-fig', '<span>?</span>');
    fig.style.width = px + 'px';
    fig.style.setProperty('--qs', px + 'px');
    e.appendChild(fig);
    const t = el('div', 'nb-sp-txt');
    t.appendChild(el('div', 'nb-sp-name nb-q-name', '— ? —'));
    t.appendChild(el('div', 'nb-sp-note', esc(text)));
    e.appendChild(t);
    return e;
  }
  function buildFloorEntry(meas) {
    const s = st();
    const e = el('div', 'nb-sp nb-floor');
    const px = Math.round(clamp(92 * L.s, 72, 116));
    const fig = el('div', 'nb-sp-fig');
    fig.style.width = px + 'px';
    fig.appendChild(meas ? sizedBox(px) : sketchCanvas(px, px, 'floorfig', (g, w, h) => stippleFigure(g, w, h, ['floor'], 22, LEAD)));
    e.appendChild(fig);
    const t = el('div', 'nb-sp-txt');
    t.appendChild(el('div', 'nb-sp-name', 'the floor'));
    t.appendChild(el('div', 'nb-lab', 'k 2 <span class="nb-dot">·</span> <span class="nb-lk">below the lowest note</span>'));
    const heard = nbState().f.floor;
    if (heard) t.appendChild(el('div', 'nb-lab', `<span class="nb-lk">heard</span> ${esc(keeping(heard, s.created).label)}, ${clock(heard)}`));
    e.appendChild(t);
    e.appendChild(el('div', 'nb-sp-note', 'Five, ten, twenty, forty, all at once. The sand ran to the rim. There was writing under it.'));
    return e;
  }

  // observations ------------------------------------------------------------------------------------
  // Somebody keeps the book while the reader is away, and addresses them as 'you'. Those lines are in
  // her hand. (A run of away-lines is all one hand.)
  function awayHands(log) {
    const hers = new Set();
    for (let i = 0; i < log.length; i++) {
      if (log[i]?.kind !== 'away') continue;
      let j = i;
      while (j + 1 < log.length && log[j + 1]?.kind === 'away') j++;
      let you = false;
      for (let k = i; k <= j; k++) if (/\byou(r)?\b/i.test(log[k].text || '')) { you = true; break; }
      if (you) for (let k = i; k <= j; k++) hers.add(k);
      i = j;
    }
    return hers;
  }
  // the binomials in a line nobody marked up, underlined as they would be by hand
  function nameMarkup(text) {
    if (/\*/.test(text)) return penMarkup(text);
    const names = speciesList().map((r) => r.name).filter((n) => n && n.length > 3).sort((a, b) => b.length - a.length);
    const h = esc(text);
    if (!names.length) return h;
    const re = new RegExp(names.map((n) => esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    return h.replace(re, (m) => `<u class="nb-bin">${m}</u>`);
  }
  function obsItems() {
    const s = st(), log = Array.isArray(s.log) ? s.log : [];
    const items = [];
    const hers = awayHands(log);
    let lastKey = '';
    for (let i = 0; i < log.length; i++) {
      const e = log[i];
      if (!e || !e.text) continue;
      const k = keeping(e.t || Date.now(), s.created);
      if (k.key !== lastKey) {
        lastKey = k.key;
        items.push({ key: `day|${k.label}`, keepNext: true, lead: 1, build: () => el('div', 'nb-o-day', esc(cap(k.label)) + '.') });
      }
      const her = hers.has(i);
      items.push({
        key: `o|${e.t}|${e.text.length}|${i === 0 ? 0 : 1}|${her ? 1 : 0}`,
        t: e.t || 0,
        build: () => el('div', 'nb-o' + (e.kind === 'away' ? ' nb-o-away' : '') + (her ? ' nb-o-hers' : '') + (e.t > markT ? ' nb-new' : ''),
          `<span class="nb-o-t">${clock(e.t || Date.now())}</span> — ${e.kind === 'away' ? nameMarkup(e.text) : penMarkup(e.text)}`),
      });
    }
    return items;
  }

  // ---- pagination ---------------------------------------------------------------------------------
  const hCache = new Map();
  function measurePage(kind) {
    measure.replaceChildren();
    const page = el('div', `nb-page nb-r nb-kind-${kind}`);
    const body = el('div', 'nb-body');
    page.appendChild(body);
    measure.appendChild(page);
    return body;
  }
  function heights(kind, items, extra) {
    const body = measurePage(kind);
    const todo = [];
    for (const it of items) if (!hCache.has(it.key)) todo.push(it);
    for (const it of extra) if (!hCache.has(it.key)) todo.push(it);
    if (todo.length) {
      const els = todo.map((it) => { const e = it.build(true); body.appendChild(e); return e; });
      for (let i = 0; i < els.length; i++) hCache.set(todo[i].key, els[i].getBoundingClientRect().height);
    }
    const avail = body.getBoundingClientRect().height;
    measure.replaceChildren();
    return avail;
  }
  function paginate(kind, sec, items, title) {
    const head = { key: `head|${kind}`, build: () => el('h2', 'nb-head', esc(title)) };
    const run = { key: `run|${kind}`, build: () => el('div', 'nb-run', esc(title)) };
    const avail = heights(kind, items, [head, run]) - 2;
    const out = [];
    let curItems = [], used = hCache.get(head.key) || 0, firstPage = true;
    const close = () => { out.push({ kind, sec, items: curItems, first: firstPage, title }); curItems = []; firstPage = false; used = hCache.get(run.key) || 0; };
    for (let i = 0; i < items.length; i++) {
      // a day heading carries a blank line above it, except at the head of a page
      const lead = items[i].lead ? L.lh * items[i].lead : 0;
      let h = hCache.get(items[i].key) || 0;
      if (lead && curItems.length === 0) h -= lead;
      let need = h;
      if (items[i].keepNext && items[i + 1]) need += hCache.get(items[i + 1].key) || 0;
      if (curItems.length && used + need > avail) { close(); if (lead) { h -= lead; } }
      curItems.push(items[i]);
      used += h;
    }
    close();
    return out;
  }
  function contentSig() {
    const s = st();
    const recs = s.species || {};
    let ext = 0, notes = 0;
    for (const id in recs) { const r = recs[id]; if (r?.extinct) ext++; notes += (r?.note || '').length; }
    return `${L?.key}|${Object.keys(recs).length}|${ext}|${notes}|${(s.log || []).length}|${keeperPagesFor(s).length}|${s.seen?.floor ? 1 : 0}|${fontsLoaded ? 1 : 0}`;
  }
  function buildPages() {
    const s = st();
    const out = [];
    secStart = {};
    if (L.spread) out.push({ kind: 'endpaper', sec: 'flyleaf' });
    secStart.flyleaf = out.length;
    out.push({ kind: 'flyleaf', sec: 'flyleaf' });
    secStart.keeper = out.length;
    keeperPagesFor(s).forEach((entry, i) => out.push({ kind: 'keeper', sec: 'keeper', entry, idx: i }));
    if (L.spread && out.length % 2) out.push({ kind: 'blank', sec: 'keeper', flower: true });
    secStart.specimens = out.length;
    out.push(...paginate('specimens', 'specimens', specimenItems(), 'Specimens'));
    if (L.spread && out.length % 2) out.push({ kind: 'blank', sec: 'specimens' });
    secStart.observations = out.length;
    out.push(...paginate('observations', 'observations', obsItems(), 'Observations'));
    if (L.spread && out.length % 2) out.push({ kind: 'blank', sec: 'observations' });
    out.forEach((p, i) => { p.n = i; });
    pages = out;
  }
  const nViews = () => (L.spread ? Math.ceil(pages.length / 2) : pages.length);
  const viewOf = (pi) => (L.spread ? Math.floor(pi / 2) : pi);
  const pagesOf = (v) => (L.spread ? [pages[v * 2] || null, pages[v * 2 + 1] || null] : [null, pages[v] || null]);

  // ---- rendering -------------------------------------------------------------------------------------
  function renderPage(desc, side) {
    const page = el('div', `nb-page nb-${side}`);
    if (!desc) { page.classList.add('nb-kind-none'); page.style.clipPath = deckle(side, 0); return page; }
    page.classList.add('nb-kind-' + desc.kind);
    if (desc.kind === 'endpaper') { buildEndpaper(page); return page; }
    page.style.clipPath = deckle(side, desc.n % 2);
    const fox = el('div', 'nb-fox');
    fox.style.backgroundImage = foxing(desc.kind + (desc.entry?.id || desc.n), desc.kind === 'keeper' ? 1.4 : 1);
    page.appendChild(fox);
    if (desc.kind === 'keeper' || desc.kind === 'observations') page.appendChild(el('div', 'nb-rules'));
    if (desc.kind === 'specimens') page.appendChild(el('div', 'nb-grid'));
    const body = el('div', 'nb-body');
    page.appendChild(body);
    if (desc.kind === 'flyleaf') buildFlyleaf(body);
    else if (desc.kind === 'keeper') {
      buildKeeper(body, desc.entry, desc.idx, page);
      if (desc.entry.torn) {
        page.style.clipPath = tornClip(side);
        const rim = tornRim(side);
        rim.className = 'nb-tornrim';
        page.appendChild(rim);
      }
    }
    else if (desc.kind === 'blank') {
      if (desc.flower) { const fl = flowerStain(Math.round(L.pw * 0.6), Math.round(L.ph * 0.5), 77); fl.className = 'nb-flower nb-flower-big'; page.appendChild(fl); }
    } else if (desc.kind === 'specimens' || desc.kind === 'observations') {
      body.appendChild(desc.first ? el('h2', 'nb-head', esc(desc.title)) : el('div', 'nb-run', esc(desc.title)));
      for (const it of desc.items) body.appendChild(it.build(false));
    }
    // folio, in the hand of whoever wrote the page
    if (desc.kind === 'keeper' || desc.kind === 'specimens' || desc.kind === 'observations') {
      const no = desc.kind === 'keeper' ? desc.idx + 1 : desc.n - (secStart.specimens || 0) + 1;
      page.appendChild(el('div', `nb-folio nb-folio-${desc.kind === 'keeper' ? 'k' : 'p'}`, String(no)));
    }
    return page;
  }
  // Her pages are not paginated; on a cramped screen her hand shrinks a little, then the drawings go.
  function fit(container) {
    for (const page of container.querySelectorAll('.nb-kind-keeper')) {
      const body = page.querySelector('.nb-body');
      const over = () => body.scrollHeight > body.clientHeight + 2;
      if (!body || !over()) continue;
      for (const c of page.querySelectorAll('.nb-sk canvas')) {      // first the drawings shrink
        c.style.width = Math.round(parseFloat(c.style.width) * 0.72) + 'px';
        c.style.height = Math.round(parseFloat(c.style.height) * 0.72) + 'px';
      }
      if (!over()) continue;
      page.classList.add('nb-tight');
      if (over()) page.classList.add('nb-tighter');
    }
  }
  function fillLive(container) {
    const live = container.querySelectorAll('[data-live]');
    if (!live.length) return;
    const m = livingMap(), recs = st().species || {};
    for (const b of live) {
      const id = b.dataset.live, r = recs[id];
      const n = m.has(id) ? m.get(id) : r && !r.extinct ? r.count || 0 : 0;
      const t = n > 0 ? String(n) : 'none';
      if (b.textContent !== t) b.textContent = t;
    }
    for (const b of container.querySelectorAll('[data-peak]')) {
      const r = recs[b.dataset.peak];
      const t = String(r?.peak || 0);
      if (r && b.textContent !== t) b.textContent = t;
    }
  }
  function renderView() {
    const [a, b] = pagesOf(cur);
    slotL.replaceChildren(L.spread ? renderPage(a, 'l') : '');
    slotR.replaceChildren(renderPage(b, L.spread ? 'r' : 's'));
    fit(slotL); fit(slotR);
    fillLive(slotL); fillLive(slotR);
    chrome();
  }
  function chrome() {
    // the page block thins on one side and thickens on the other as you read
    const n = nViews(), frac = n > 1 ? cur / (n - 1) : 0, T = 7 * L.s;
    book.style.setProperty('--tl', (L.spread ? 1.5 + T * frac : 0).toFixed(1) + 'px');
    book.style.setProperty('--tr', (1.5 + T * (1 - frac)).toFixed(1) + 'px');
    book.classList.toggle('nb-at-cover', L.spread && pagesOf(cur)[0]?.kind === 'endpaper');
    btnPrev.classList.toggle('nb-hide', cur <= 0);
    btnNext.classList.toggle('nb-hide', cur >= nViews() - 1);
    const [a, b] = pagesOf(cur);
    const sec = (b && b.sec !== 'flyleaf' ? b.sec : a?.sec) || b?.sec || 'flyleaf';
    for (const r of ribbons) r.classList.toggle('nb-on', r.dataset.sec === sec);
  }
  function saveSpot() {
    const nb = nbState();
    const [a, b] = pagesOf(cur);
    const p = (L.spread ? (a && a.kind !== 'endpaper' ? a : b) : b) || a;
    if (!p) return;
    nb.sec = p.sec;
    nb.pi = p.n - (secStart[p.sec] || 0);
    nb.atEnd = cur >= nViews() - 1;
  }
  function rebuild(keep) {
    if (!L) applyLayout();
    const nb = nbState();
    if (keep) saveSpot();
    buildPages();
    sig = contentSig();
    if (keep) cur = resolveSpot(nb);
    cur = clamp(cur, 0, Math.max(0, nViews() - 1));
    if (isOpen && !turn) renderView();
  }
  function resolveSpot(nb) {
    if (nb.sec === 'observations' && nb.atEnd) return nViews() - 1;
    const base = secStart[nb.sec];
    if (base == null) return 0;
    const nextSec = { flyleaf: 'keeper', keeper: 'specimens', specimens: 'observations' }[nb.sec];
    const limit = nextSec ? secStart[nextSec] - 1 : pages.length - 1;
    return viewOf(clamp(base + (nb.pi || 0), base, Math.max(base, limit)));
  }
  function resolveTarget(page) {
    if (typeof page === 'number' && isFinite(page)) return viewOf(clamp(Math.round(page), 0, pages.length - 1));
    if (page === 'observations') return nViews() - 1;
    if (typeof page === 'string' && secStart[page] != null) return viewOf(secStart[page]);
    return null;
  }

  // ---- turning -------------------------------------------------------------------------------------
  function finishTurn() {
    if (!turn) return;
    const t = turn;
    turn = null;
    for (const a of t.anims) { try { a.cancel(); } catch {} }
    t.done();
  }
  function go(v, instant) {
    if (!pages.length) return;
    v = clamp(v, 0, nViews() - 1);
    finishTurn();
    if (v === cur) return;
    const from = cur, dir = v > from ? 1 : -1;
    cur = v;
    saveSpot();
    if (!isOpen) return;
    if (instant || reduced || typeof leaf.animate !== 'function') {
      renderView();
      if (!instant) bus.emit('sfx', { name: 'page' });
      return;
    }
    bus.emit('sfx', { name: 'page' });
    if (L.spread) turnSpread(from, v, dir); else turnSingle(from, v, dir);
    chrome();
  }
  const ease = 'cubic-bezier(.42,.02,.3,1)';
  function animateTurn(rot0, rot1, opts = {}) {
    const anims = [];
    const T = TURN_MS;
    anims.push(leaf.animate([
      { transform: `rotateY(${rot0}deg)` },
      { transform: `rotateY(${(rot0 + rot1) / 2}deg) translateZ(${(L.pw * 0.04).toFixed(0)}px)`, offset: 0.5 },
      { transform: `rotateY(${rot1}deg)` },
    ], { duration: T, easing: ease, fill: 'both' }));
    anims.push(shadeF.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0.6 }], { duration: T, easing: ease, fill: 'both' }));
    anims.push(shadeB.animate([{ opacity: 0.6 }, { opacity: 0.5, offset: 0.5 }, { opacity: 0 }], { duration: T, easing: ease, fill: 'both' }));
    if (opts.castUnder) anims.push(opts.castUnder.animate([{ opacity: 0.55 }, { opacity: 0.18, offset: 0.45 }, { opacity: 0, offset: 0.6 }, { opacity: 0 }], { duration: T, easing: ease, fill: 'both' }));
    if (opts.castLand) anims.push(opts.castLand.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 0.45, offset: 0.85 }, { opacity: 0 }], { duration: T, easing: ease, fill: 'both' }));
    if (opts.fadeFront) anims.push(faceF.animate([{ opacity: 1 }, { opacity: 1, offset: 0.55 }, { opacity: 0 }], { duration: T, easing: ease, fill: 'both' }));
    if (opts.fadeInFront) anims.push(faceF.animate([{ opacity: 0 }, { opacity: 1, offset: 0.45 }, { opacity: 1 }], { duration: T, easing: ease, fill: 'both' }));
    return anims;
  }
  function placeLeaf(left, origin, frontEl, backEl) {
    shadeF.remove(); shadeB.remove();
    faceF.replaceChildren(frontEl || ''); faceB.replaceChildren(backEl || '');
    faceF.appendChild(shadeF); faceB.appendChild(shadeB);
    shadeF.className = 'nb-shade ' + (origin === 'left' ? 'nb-shade-r' : 'nb-shade-l');
    shadeB.className = 'nb-shade ' + (origin === 'left' ? 'nb-shade-l' : 'nb-shade-r');
    leaf.style.left = left + 'px';
    leaf.style.transformOrigin = `${origin} center`;
    leaf.classList.add('nb-on');
    fit(leaf);
  }
  function endLeaf() {
    leaf.classList.remove('nb-on');
    faceF.replaceChildren(shadeF); faceB.replaceChildren(shadeB);
    faceF.style.opacity = ''; leaf.style.transform = '';
  }
  function turnSpread(from, to, dir) {
    const [oL, oR] = pagesOf(from), [nL, nR] = pagesOf(to);
    if (dir > 0) {
      slotR.replaceChildren(renderPage(nR, 'r')); fit(slotR); fillLive(slotR);
      placeLeaf(L.pw, 'left', renderPage(oR, 'r'), renderPage(nL, 'l'));
      fillLive(leaf);
      turn = { anims: animateTurn(0, -180, { castUnder: castR, castLand: castL }), done: () => {
        slotL.replaceChildren(renderPage(nL, 'l')); fit(slotL); fillLive(slotL); endLeaf(); chrome();
      } };
    } else {
      slotL.replaceChildren(renderPage(nL, 'l')); fit(slotL); fillLive(slotL);
      placeLeaf(0, 'right', renderPage(oL, 'l'), renderPage(nR, 'r'));
      fillLive(leaf);
      turn = { anims: animateTurn(0, 180, { castUnder: castL, castLand: castR }), done: () => {
        slotR.replaceChildren(renderPage(nR, 'r')); fit(slotR); fillLive(slotR); endLeaf(); chrome();
      } };
    }
    armTurn();
  }
  function armTurn() {
    const t = turn;
    t.anims[0].onfinish = () => { if (turn === t) finishTurn(); };
    setTimeout(() => { if (turn === t) finishTurn(); }, TURN_MS + 250);
  }
  function turnSingle(from, to, dir) {
    const o = pagesOf(from)[1], n = pagesOf(to)[1];
    const verso = el('div', 'nb-page nb-s nb-verso');
    if (dir > 0) {
      slotR.replaceChildren(renderPage(n, 's')); fit(slotR); fillLive(slotR);
      placeLeaf(0, 'left', renderPage(o, 's'), verso);
      fillLive(leaf);
      turn = { anims: animateTurn(0, -112, { castUnder: castR, fadeFront: true }), done: () => { endLeaf(); chrome(); } };
    } else {
      placeLeaf(0, 'left', renderPage(n, 's'), verso);
      fillLive(leaf);
      turn = { anims: animateTurn(-112, 0, { fadeInFront: true }), done: () => {
        slotR.replaceChildren(renderPage(n, 's')); fit(slotR); fillLive(slotR); endLeaf(); chrome();
      } };
    }
    armTurn();
  }

  // ---- open / close ----------------------------------------------------------------------------------
  function bookFromAnchor() {
    const a = game.view?.anchors?.journal;
    if (!a || !L) return 'translateY(24px) scale(.92)';
    const cx = L.vw / 2, cy = L.vh / 2;
    const sc = clamp(110 / (L.spread ? L.pw * 2 : L.pw), 0.08, 0.5);
    return `translate(${(a.x - cx).toFixed(0)}px, ${(a.y - cy).toFixed(0)}px) scale(${sc.toFixed(3)}) rotate(${game.view.mode === 'landscape' ? -9 : 7}deg)`;
  }
  // The most relevant new thing: one of her pages come loose, else the first new specimen, else the
  // first new line of the observations; failing all that, wherever the reader left off.
  function newsTarget(nb) {
    if (!nb.opened) return viewOf(secStart.flyleaf);
    if (nb.newKeeper) {
      const pi = pages.findIndex((p) => p.kind === 'keeper' && p.entry.id === nb.newKeeper);
      if (pi >= 0) return viewOf(pi);
    }
    const fresh = speciesList().find((r) => (r.firstSeen || 0) > markT);
    if (fresh) {
      const pi = pages.findIndex((p) => p.kind === 'specimens' && p.items.some((it) => it.id === fresh.id));
      if (pi >= 0) return viewOf(pi);
    }
    const pi = pages.findIndex((p) => p.kind === 'observations' && p.items.some((it) => it.t > markT));
    if (pi >= 0) return viewOf(pi);
    return resolveSpot(nb);
  }
  function open(page) {
    if (closing) { try { closing.cancel(); } catch {} closing = null; finishClose(); }
    if (isOpen) { const v = page != null ? resolveTarget(page) : null; if (v != null) go(v); return; }
    const nb = nbState();
    root.classList.add('nb-live');
    applyLayout();
    buildPages();
    sig = contentSig();
    const count = recordCount();
    // what is new since the last reading (ticked in the margin while the book is open)
    markT = nb.opened ? nb.readT || 0 : Infinity;
    let v = page != null ? resolveTarget(page) : null;
    if (v == null) v = newsTarget(nb);
    nb.opened = (nb.opened || 0) + 1;
    nb.known = count;
    nb.newKeeper = null;
    nb.readT = Date.now();
    cur = clamp(v ?? 0, 0, Math.max(0, nViews() - 1));
    isOpen = true;
    root.setAttribute('aria-hidden', 'false');
    renderView();
    saveSpot();
    // force a style flush so the scrim fades rather than snaps
    void root.offsetWidth;
    root.classList.add('nb-open');
    if (!reduced && typeof book.animate === 'function') {
      book.animate([
        { transform: bookFromAnchor(), opacity: 0 },
        { opacity: 1, offset: 0.35 },
        { transform: 'none', opacity: 1 },
      ], { duration: OPEN_MS, easing: 'cubic-bezier(.2,.75,.25,1)' });
    }
    try { book.focus({ preventScroll: true }); } catch {}
    window.addEventListener('keydown', onKey, true);
    bus.emit('journal:open', {});
  }
  function finishClose() {
    root.classList.remove('nb-live');
    slotL.replaceChildren(); slotR.replaceChildren();
    closing = null;
  }
  function close() {
    if (!isOpen) return;
    finishTurn();
    saveSpot();
    nbState().readT = Date.now();
    isOpen = false;
    root.classList.remove('nb-open');
    root.setAttribute('aria-hidden', 'true');
    window.removeEventListener('keydown', onKey, true);
    try { if (root.contains(document.activeElement)) document.activeElement.blur(); } catch {}
    bus.emit('journal:close', {});
    if (!reduced && typeof book.animate === 'function') {
      closing = book.animate([{ transform: 'none', opacity: 1 }, { opacity: 1, offset: 0.5 }, { transform: bookFromAnchor(), opacity: 0 }],
        { duration: CLOSE_MS, easing: 'cubic-bezier(.5,0,.75,.4)', fill: 'forwards' });
      const done = () => { if (!isOpen && closing) { const c = closing; finishClose(); try { c.cancel(); } catch {} } };
      closing.onfinish = done;
      setTimeout(done, CLOSE_MS + 200);        // frames may be starved (a busy machine, a hidden tab)
    } else finishClose();
  }

  // ---- input ---------------------------------------------------------------------------------------
  function onKey(e) {
    if (!isOpen) return;
    const k = e.key;
    let used = true;
    if (k === 'Escape') close();
    else if (k === 'ArrowRight' || k === 'PageDown' || k === 'ArrowDown' || k === ' ') go(cur + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'ArrowUp') go(cur - 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(nViews() - 1);
    else if (k === 'Tab') used = false;
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); }
  }
  scrim.addEventListener('pointerdown', (e) => { if (isOpen) { e.preventDefault(); close(); } });
  btnPrev.addEventListener('click', (e) => { e.stopPropagation(); go(cur - 1); });
  btnNext.addEventListener('click', (e) => { e.stopPropagation(); go(cur + 1); });
  $('.nb-close').addEventListener('click', (e) => { e.stopPropagation(); close(); });
  for (const r of ribbons) r.addEventListener('click', (e) => {
    e.stopPropagation();
    const v = resolveTarget(r.dataset.sec);
    if (v != null) go(v);
  });
  // swipes, and a tap on a page's outer margin
  let sw = null;
  book.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    sw = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  book.addEventListener('pointerup', (e) => {
    if (!sw || sw.id !== e.pointerId) return;
    const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
    sw = null;
    if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.2) { go(cur + (dx < 0 ? 1 : -1)); return; }
    if (Math.abs(dx) < 6 && Math.abs(dy) < 6) {
      const r = book.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      if (fx > 0.9) go(cur + 1);
      else if (fx < 0.1 && (L.spread || cur > 0)) go(cur - 1);
    }
  });
  book.addEventListener('pointercancel', () => { sw = null; });
  let wheelAt = 0;
  book.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - wheelAt < 480 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 8) return;
    wheelAt = now;
    go(cur + ((e.deltaY || e.deltaX) > 0 ? 1 : -1));
  }, { passive: false });
  let resizeT = 0;
  const onResize = () => {
    if (!isOpen) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { if (!isOpen) return; finishTurn(); applyLayout(); rebuild(true); }, 120);
  };
  on('resize', onResize);
  window.addEventListener('resize', onResize);

  // ---- per frame -----------------------------------------------------------------------------------
  let watchAcc = 0, liveAcc = 0;
  function update(dt) {
    if (pending) flushPending('unknown');
    watchAcc += dt;
    if (watchAcc >= 0.5) { try { watch(watchAcc); } catch (err) { report(err); } watchAcc = 0; }
    if (!isOpen) return;
    liveAcc += dt;
    if (liveAcc < 0.5) return;
    liveAcc = 0;
    if (turn) return;
    // new forms, new lines, pages come unstuck: re-paginate in place (the reader keeps their page)
    if (contentSig() !== sig) { rebuild(true); return; }
    fillLive(slotL); fillLive(slotR);
  }

  const journal = {
    open, close, update, note,
    toggle(page) { if (isOpen) close(); else open(page); },
    get isOpen() { return isOpen; },
    // new specimens + new observation lines since the book was last read (0 while it is open)
    get unread() { if (isOpen) return 0; const n = news(); return n.specimens + n.lines; },
    get news() { return isOpen ? { specimens: 0, lines: 0 } : news(); },
    get page() { return cur; },
    get pageCount() { return L ? nViews() : 0; },
    goTo(page) { const v = resolveTarget(page); if (v != null) go(v, !isOpen); },
    goView(v, instant) { if (L && pages.length) go(v, instant || !isOpen); },
    destroy() { for (const off of offs) try { off(); } catch {} window.removeEventListener('resize', onResize); root.remove(); },
  };
  return journal;
}
