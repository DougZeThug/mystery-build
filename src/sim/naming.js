// Binomials and temperament notes for the singers, after the manner of a Victorian catalogue.
// Everything here is deterministic: the same components always yield the same name, and the
// same behavioural record yields the same note (the note changes as the record accrues).
import { modeById, K_VALUES } from './modes.js';
import { consonance, clanOf, gcd } from './harmony.js';

const ROOT = ['', 'Monas', 'Dyas', 'Trias', 'Tetras', 'Pentas', 'Hexas', 'Heptas'];
const STEM = ['', 'Mono', 'Dya', 'Tria', 'Tetra', 'Penta', 'Hexa', 'Hepta'];
const NUMWORD = ['nought', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const ORDINAL = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

// The keeper: the one creature of the fundamental (mode 'floor', k 2), who stands up out of the
// bare bronze after the first Floor. Named for the previous keeper; her note is in Voss's voice.
export const KEEPER = Object.freeze({ id: 'keeper', comps: ['floor'], genus: 'Vossia', epithet: 'fundamentalis',
  name: 'Vossia fundamentalis' });
const isKeeper = (x) => !!x && (x.id === KEEPER.id || x.keeper === true ||
  (Array.isArray(x.comps) && x.comps.length === 1 && x.comps[0] === 'floor'));

// --- small deterministic helpers -------------------------------------------------------------
function hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return h >>> 0;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = (n) => {
  n = Math.round(n);
  if (n >= 0 && n < NUMWORD.length) return NUMWORD[n];
  if (n > 20 && n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + NUMWORD[n % 10] : '');
  return String(n);
};
const plural = (n, one, many) => (n === 1 ? one : many);

function parseComp(id) {
  const m = modeById(id);
  if (m) return m;
  // tolerate unknown ids of the form 'n.m±'
  const mm = /^(\d)\.(\d)([+-])$/.exec(String(id));
  if (!mm) return { id, n: 1, m: 1, s: 1, k: 2, special: true };
  const n = +mm[1], m2 = +mm[2];
  return { id, n, m: m2, s: mm[3] === '+' ? 1 : -1, k: n * n + m2 * m2 };
}

function sortComps(comps) {
  return comps.map(parseComp).sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// --- single-mode names -----------------------------------------------------------------------
// Genus from the two mode numbers: (2,5) -> Dyapentas, (3,3) -> Isotrias.
function genusOf(c) {
  if (c.special || (c.n === 1 && c.m === 1)) return 'Monas';
  if (c.n === c.m) return 'Iso' + ROOT[c.n].toLowerCase();
  return STEM[c.n] + ROOT[c.m].toLowerCase();
}

// Epithet from the figure's symmetry. For M(n,m,s), the main diagonal is a nodal line when
// s = -1; the anti-diagonal is nodal when (-1)^(n+m)·s = -1. So the two signs of one (n,m)
// always fall into different classes and never share an epithet.
function epithetOf(c) {
  if (c.special || (c.n === 1 && c.m === 1)) return 'primordialis';
  const d = c.m - c.n, even = (c.n + c.m) % 2 === 0;
  if (c.s < 0 && even) return d <= 2 ? 'crucifera' : d <= 4 ? 'stellata' : 'radiata';      // both diagonals
  if (c.s < 0) return d <= 1 ? 'dimidiata' : d <= 3 ? 'lyrata' : 'sinuosa';                // main diagonal
  if (!even) return d <= 1 ? 'obliqua' : d <= 3 ? 'pectinata' : 'cirrata';                 // anti-diagonal
  if (d === 0) return c.n <= 3 ? 'quadrata' : 'tessellata';                                // neither: windows
  if (d === 2) return c.n === 1 ? 'annulata' : 'fenestrata';
  return d === 4 ? 'cancellata' : 'reticulata';
}

// 'Dyapentas' -> 'dyapentina', 'Monotrias' -> 'monotriadina', 'Monodyas' -> 'monodyadina'
function adjectiveOf(genus) {
  const g = genus.toLowerCase();
  if (g.endsWith('yas')) return g.slice(0, -2) + 'adina';
  if (g.endsWith('ias')) return g.slice(0, -2) + 'adina';
  if (g.endsWith('as')) return g.slice(0, -2) + 'ina';
  return g + 'ina';
}

// --- intervals --------------------------------------------------------------------------------
function ratio(k1, k2) {
  const g = gcd(k1, k2);
  let p = Math.round(k1 / g), q = Math.round(k2 / g);
  if (p > q) [p, q] = [q, p];
  return [p, q];
}

const INTERVAL_EPITHET = {
  '1:1': 'gemella', '1:2': 'diapasonica', '1:4': 'bisdiapasonica', '1:8': 'terdiapasonica',
  '2:3': 'diapentica', '3:4': 'diatessarica', '4:5': 'ditonica', '5:6': 'semiditonica',
  '1:3': 'duodecimalis', '2:5': 'decimalis', '1:5': 'quintadecimalis', '3:5': 'hexachordalis',
  '5:8': 'semihexachordalis', '1:9': 'novenaria', '4:9': 'nonaria', '2:9': 'bisnonaria', '5:9': 'septimalis',
};
const INTERVAL_NAME = {
  '1:1': 'unison', '1:2': 'octave', '1:4': 'double octave', '1:8': 'triple octave', '2:3': 'fifth',
  '3:4': 'fourth', '4:5': 'major third', '5:6': 'minor third', '1:3': 'twelfth', '2:5': 'tenth',
  '1:5': 'seventeenth', '3:5': 'major sixth', '5:8': 'minor sixth',
};

// 'a' or 'an' before a word or a number as it is spoken (an 8, an 18, an octave, a fifth)
function art(x) {
  const t = String(x).trim().toLowerCase();
  if (/^\d/.test(t)) return /^(8|11|18)(\D|$)|^8\d|^11\d\d(\D|$)/.test(t) ? 'an' : 'a';
  return /^[aeiou]/.test(t) ? 'an' : 'a';
}
const apart = (iv) => (iv.includes(':') ? `in the ratio ${iv}` : `${art(iv)} ${iv} apart`);

export function intervalName(k1, k2) {
  const [p, q] = ratio(k1, k2);
  return INTERVAL_NAME[`${p}:${q}`] || `${p}:${q}`;
}

function intervalEpithet(k1, k2) {
  const [p, q] = ratio(k1, k2);
  const e = INTERVAL_EPITHET[`${p}:${q}`];
  if (e) return e;
  const c = consonance(k1, k2);
  return c > 0 ? 'concors' : c > -0.4 ? 'dissona' : 'discors';
}

function chordGenus(cs) {
  const ks = cs.map((c) => c.k);
  const clans = new Set(ks.map(clanOf));
  if (clans.size === 1) return 'Scala';                 // a ladder of octaves
  let allCons = true;
  for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) if (consonance(ks[i], ks[j]) <= 0.1) allCons = false;
  return allCons ? 'Symphonia' : 'Polyphonia';
}

// --- public: names ----------------------------------------------------------------------------
// nameFor(comps, aurata?, variant?) -> { genus, epithet, name, third }
//   variant 1 (or true): add the distinguishing third word (used only when a different species
//   already bears the plain name); variant 2: a descriptor drawn from the full signature. Both
//   remain deterministic from the components.
const DESCRIPTORS = ['minor', 'major', 'gracilis', 'robusta', 'pallida', 'obscura', 'vagans', 'tardigrada',
  'elegans', 'pusilla', 'nobilis', 'modesta', 'secunda', 'tertia', 'serotina', 'vespertina', 'tacita', 'canora'];
export function nameFor(comps, aurata = false, variant = false) {
  if (comps && comps.length === 1 && comps[0] === 'floor') return { genus: KEEPER.genus, epithet: KEEPER.epithet, name: KEEPER.name, third: null };
  const cs = sortComps(comps && comps.length ? comps : ['1.1+']);
  let genus, epithet, third;
  if (cs.length === 1) {
    genus = genusOf(cs[0]); epithet = epithetOf(cs[0]);
    third = cs[0].s < 0 ? 'sinistra' : 'dextra';
  } else if (cs.length === 2) {
    const [a, b] = cs;
    if (a.n === b.n && a.m === b.m) genus = genusOf(a);
    else genus = STEM[a.m === b.m ? a.n : a.m] + ROOT[b.m].toLowerCase();
    epithet = intervalEpithet(a.k, b.k);
    third = epithetOf(b);
  } else {
    genus = chordGenus(cs);
    epithet = adjectiveOf(genusOf(cs[0]));
    // the distinguishing word names the first voice of a different family, or the top voice's figure
    const other = cs.find((c) => genusOf(c) !== genusOf(cs[0]));
    third = other ? adjectiveOf(genusOf(other)) : epithetOf(cs[cs.length - 1]);
    if (third === epithet) third = epithetOf(cs[cs.length - 1]);
  }
  if (variant === 2) third = DESCRIPTORS[hash(cs.map((c) => c.id).join('|')) % DESCRIPTORS.length];
  if (variant && third) epithet += ' ' + third;
  if (aurata) epithet += ' aurata';
  return { genus, epithet, name: `${genus} ${epithet}`, third };
}

// 'k 29' · 'k 10, 20 (1:2)' · 'k 10, 20, 25 (2:4:5)'
export function speciesRatioText(species) {
  if (isKeeper(species)) return 'k 2 · below the lowest note';
  const ks = (species?.ks?.length ? species.ks : (species?.comps || []).map((c) => parseComp(c).k)).slice().sort((a, b) => a - b);
  if (!ks.length) return '';
  if (ks.length === 1) {
    const k = ks[0];
    const clan = +clanOf(k);
    if (clan === 1) {
      const oct = Math.round(Math.log2(k / 2));
      return `k ${k} · ${oct === 1 ? 'an octave' : `${words(oct)} octaves`} above the floor`;
    }
    if (clan !== k) {
      const chain = [];
      for (let x = clan; x < k; x *= 2) if (K_VALUES.includes(x)) chain.push(x);
      return chain.length ? `k ${k} · above ${chain.slice(-2).join(' and ')}` : `k ${k} · of the clan of ${words(clan)}`;
    }
    const octave = K_VALUES.includes(k * 2) ? ` · octave ${k * 2}` : ' · no octave upon the plate';
    return `k ${k}${octave}`;
  }
  let g = 0;
  for (const k of ks) g = gcd(g, k);
  return `k ${ks.join(', ')} (${ks.map((k) => k / g).join(':')})`;
}

// Gentle luminous colours per component, by clan; higher octaves paler. Returned 0..1.
const CLAN_HUE = {
  '1': [0.86, 0.9, 1.0], '5': [1.0, 0.92, 0.76], '9': [1.0, 0.86, 0.56], '13': [0.62, 0.9, 1.0],
  '17': [0.68, 1.0, 0.78], '25': [1.0, 0.7, 0.72], '29': [0.82, 0.72, 1.0], '37': [1.0, 0.78, 0.5],
  '41': [0.56, 1.0, 0.9], '45': [1.0, 0.76, 0.6], '49': [0.86, 0.66, 1.0], '53': [0.68, 0.76, 1.0],
  '61': [0.84, 1.0, 0.62], '65': [1.0, 0.62, 0.56], '85': [0.72, 0.96, 1.0],
};
export function colourFor(compId, aurata = false) {
  if (compId === 'floor') return [1.0, 0.93, 0.76];          // the keeper: golden-white
  const c = parseComp(compId);
  const clan = clanOf(c.k);
  let rgb = CLAN_HUE[clan];
  if (!rgb) {
    const h = (hash('clan' + clan) % 360) / 360;
    rgb = [0.75 + 0.25 * Math.cos(6.283 * h), 0.75 + 0.25 * Math.cos(6.283 * (h - 0.33)), 0.75 + 0.25 * Math.cos(6.283 * (h - 0.66))];
  }
  let oct = 0;
  for (let x = +clan; x * 2 <= c.k; x *= 2) oct++;
  const pale = Math.min(0.45, oct * 0.12);
  const tint = c.s < 0 ? 0.04 : -0.02;
  let out = rgb.map((v, i) => Math.min(1, v + (1 - v) * pale + (i === 2 ? tint : -tint * 0.5)));
  if (aurata) out = [out[0] * 0.4 + 0.6, out[1] * 0.4 + 0.48, out[2] * 0.4 + 0.18];
  return out;
}

// --- temperament notes ------------------------------------------------------------------------
// Each template: [predicate(ctx), text(ctx)]. Notes are chosen deterministically from those whose
// predicate holds, keyed on the species and a coarse signature of its record, so a note stays put
// until the creature does something worth a new remark.

const PRIMES = new Set([5, 13, 17, 29, 37, 41, 53, 61]);

function mostDissonantK(ks) {
  let best = null, bv = 2;
  for (const k of K_VALUES) {
    if (k < 5 || k > 65) continue;
    let c = 0;
    for (const x of ks) c += consonance(x, k);
    c /= ks.length;
    if (c < bv) { bv = c; best = k; }
  }
  return best;
}
function bestFriendK(ks) {
  let best = null, bv = -2;
  for (const k of K_VALUES) {
    if (k < 5 || k > 65 || ks.includes(k)) continue;
    let c = 0;
    for (const x of ks) c += consonance(x, k);
    c /= ks.length;
    if (c > bv) { bv = c; best = k; }
  }
  return best;
}

function makeCtx(species, record, stats) {
  const r = record || {};
  const st = r.stats || {};
  const ks = (species?.ks?.length ? species.ks : r.ks) || [];
  const comps = species?.comps || r.comps || [];
  const k = ks[0] || 0;
  const clan = species?.clan || r.clan || clanOf(k);
  const deaths = (st.ageDeaths || 0) + (st.hungerDeaths || 0) + (st.eaten || 0) + (st.fell || 0);
  const meanLife = st.ageDeaths ? (st.lifeSum || 0) / st.ageDeaths : 0;
  const g = global(stats);
  return {
    name: r.name || species?.name || 'this form', genus: r.genus || species?.genus || '', ks, k, comps,
    kmax: ks.length ? ks[ks.length - 1] : 0,
    clan, nc: Math.max(1, comps.length), aurata: !!(species?.aurata || r.aurata), gen: r.gen || 0,
    peak: r.peak || 0, count: r.count || 0, extinct: !!r.extinct, parents: r.parents || null,
    parentNames: r.parentNames || null,
    born: st.births || 0, splits: st.splits || 0, fusions: st.fusions || 0, devoured: st.devoured || 0,
    eaten: st.eaten || 0, fell: st.fell || 0, ageDeaths: st.ageDeaths || 0, hungerDeaths: st.hungerDeaths || 0,
    mutants: st.mutants || 0, returns: st.returns || 0, nestles: st.nestles || 0, choirs: st.choirs || 0,
    deaths, meanLife,
    prime: ks.length === 1 && PRIMES.has(k) && k !== 5,
    clan5: ks.every((x) => clanOf(x) === '5'),
    foe: mostDissonantK(ks.length ? ks : [5]),
    friend: bestFriendK(ks.length ? ks : [5]),
    octaveUp: ks.length === 1 && K_VALUES.includes(k * 2) ? k * 2 : 0,
    octaveDown: ks.length === 1 && k % 2 === 0 && K_VALUES.includes(k / 2) && k / 2 >= 5 ? k / 2 : 0,
    interval: ks.length >= 2 ? intervalName(ks[0], ks[1]) : '',
    g,
  };
}
function global(stats) {
  const s = stats || {};
  return { births: s.births || 0, deaths: s.deaths || 0, fusions: s.fusions || 0, devoured: s.devoured || 0 };
}

const NOTES = [
  // --- general temperament, by clan and pitch
  [(c) => c.clan5 && c.nc === 1, (c) => `Of the clan of five, and sociable with all its octaves. Sings ${art(c.k)} ${c.k} and expects to be answered in kind.`],
  [(c) => c.clan5, (c) => `A creature of the octave chain; it is never more content than when the ${c.friend}s are singing nearby.`],
  [(c) => c.prime, (c) => `A solitary sort. Its ${c.k} agrees with almost nothing upon the plate, and it appears to know this.`],
  [(c) => c.prime, (c) => `Belongs to the clan of ${words(+c.clan)}, a small and private family. It keeps its own counsel and its own line.`],
  [(c) => c.nc === 1 && c.k >= 40, (c) => `A high, thin singer. Walks quickly and never quite settles, as though the ${c.k} were an inconvenience to carry.`],
  [(c) => c.nc === 1 && c.k <= 10, (c) => `A low and unhurried voice. It is the last to be disturbed when the plate grows loud.`],
  [(c) => c.nc === 1 && c.k > 10 && c.k < 40, (c) => `Middling in pitch and in manner. Keeps to the still lines with great propriety.`],
  [(c) => !!c.foe, (c) => `Will not abide ${art(c.foe)} ${c.foe} anywhere upon the plate, and grows thin while one is sung.`],
  [(c) => !!c.friend && c.nc === 1, (c) => `Thrives when ${art(c.friend)} ${c.friend} is sounding; on such evenings it can scarcely be kept to its line.`],
  [(c) => !!c.octaveUp, (c) => `Its octave, the ${c.octaveUp}, is its natural companion. The two have been seen walking the same line in step.`],
  [(c) => !!c.octaveDown, (c) => `Sits an octave above the ${c.octaveDown} and appears to defer to it, as a younger sibling might.`],
  [() => true, (c) => `Walks the nodal lines in short purposeful stretches, pausing at the crossings as if to read a signpost.`],
  [() => true, (c) => `Pauses often, and seems to listen for something below the plate.`],
  [() => true, (c) => `Turns its whole figure toward any new sound, slowly, like a sunflower with opinions.`],
  [(c) => c.peak >= 4, (c) => `Gathers in loose companies of its own kind and hums in near unison. The effect is rather fine.`],

  // --- hybrids and chords
  [(c) => c.nc === 2, (c) => `A chord of two voices, ${apart(c.interval)}. It sings both at once without apparent effort.`],
  [(c) => c.nc === 2 && !!c.parentNames, (c) => `Got of ${c.parentNames}. Holds the ${c.interval} of its parents in a single body.`],
  [(c) => c.nc === 2, (c) => `Its two figures turn against each other within the body, like the wheels of a small and patient clock.`],
  [(c) => c.nc === 3, (c) => `Three voices in one body. It walks as if carrying something that might spill.`],
  [(c) => c.nc === 3, (c) => `A full chord, ${c.ks.join(', ')}. When it sings the sand nearby grows uncommonly orderly.`],
  [(c) => c.nc >= 2 && c.gen >= 2, (c) => `The ${ORDINAL[Math.min(10, c.gen)] || c.gen + 'th'} generation of its line. Each union has left it a little more particular about company.`],
  [(c) => c.nc === 1 && c.gen >= 1, (c) => `Arose from another form by small error in the copying. It does not seem to mind.`],

  // --- behaviour: predation
  [(c) => c.devoured >= 1 && c.devoured < 3, (c) => `Has been seen to devour a neighbour of disagreeable pitch. It was not gracious about it.`],
  [(c) => c.devoured >= 3, (c) => `Has eaten ${words(c.devoured)} of its neighbours to date and shows no remorse.`],
  [(c) => c.devoured >= 2 && !!c.octaveDown, (c) => `Observed to devour its own relations when hungry, which is poor manners.`],
  [(c) => c.devoured >= 2, (c) => `A lunging, opportunistic hunter. Approaches dissonant company sideways, then all at once.`],
  [(c) => c.devoured >= 5, (c) => `The terror of the plate. Lesser voices go quiet when it walks.`],
  [(c) => c.eaten >= 1 && c.eaten < 3 && !c.extinct, (c) => `Has been taken by a hungrier singer. Its kind now keep closer together.`],
  [(c) => c.eaten >= 3, (c) => `Much preyed upon (${words(c.eaten)} lost to the jaws of others). Startles at the slightest discord.`],
  [(c) => c.eaten >= 2 && c.devoured >= 2, (c) => `Both eats and is eaten, with no apparent sense that the two are related.`],

  // --- behaviour: fusion
  [(c) => c.fusions === 1, (c) => `Once seen to merge with a consonant stranger. The courtship was brief and circular.`],
  [(c) => c.fusions >= 2, (c) => `Fuses readily with any agreeable voice; its line is consequently difficult to keep.`],
  [(c) => c.fusions >= 4, (c) => `So given to union that it is rarely itself for long. ${cap(words(c.fusions))} marriages are recorded.`],

  // --- behaviour: numbers and lifespan
  [(c) => c.peak >= 12, (c) => `Prolific. At its height ${words(c.peak)} were counted at once, and the plate fairly rang with them.`],
  [(c) => c.peak >= 8 && c.peak < 12, (c) => `Abundant in season; ${c.peak} have been counted together.`],
  [(c) => c.peak <= 2 && c.born <= 3, (c) => `Rare. Seldom more than one or two abroad at a time.`],
  [(c) => c.splits >= 3, (c) => `Divides freely where sand is plentiful, each half walking off as if the matter were settled.`],
  [(c) => c.meanLife > 380, (c) => `Long-lived, by the standard of the plate; most reach a respectable age and crumble tidily.`],
  [(c) => c.ageDeaths >= 1, (c) => `In age the body warms to gold, and at the end it leaves a few bright grains behind.`],
  [(c) => c.hungerDeaths > c.ageDeaths && c.hungerDeaths >= 2, (c) => `Delicate. More have starved than have grown old; it requires a particular music.`],
  [(c) => c.hungerDeaths >= 1 && c.hungerDeaths <= c.ageDeaths, (c) => `Goes dim and thin when the song turns against it, but recovers quickly once fed.`],
  [(c) => c.fell >= 1, (c) => `Has been lost over the edge in rough playing. ${c.fell > 1 ? 'More than once.' : 'Once is enough.'}`],
  [(c) => c.mutants >= 1, (c) => `Its offspring do not always resemble it. This is not, apparently, a cause of concern.`],
  [(c) => c.nestles >= 1, (c) => `Comes readily to a still finger and settles against it like a cat at a hearth.`],
  [(c) => c.choirs >= 1, (c) => `Has taken its place in the ring when the plate went still and golden.`],
  [(c) => c.returns >= 1, (c) => `Thought lost, and then seen again. The plate appears to remember its figure.`],

  // --- aurata
  [(c) => c.aurata, (c) => `A gilded form, born only beside a mended seam. Carries its gold with some vanity.`],
  [(c) => c.aurata, (c) => `The gold in its veins catches the lamp. It lives longer than its plain cousins and knows it.`],

  // --- extinct
  [(c) => c.extinct, (c) => `Not seen for some time. Its figure still appears, faintly, when the plate is dark.`],
  [(c) => c.extinct && c.peak >= 6, (c) => `Once common; now gone. The plate was quieter afterwards.`],
  [(c) => c.extinct && c.devoured >= 2, (c) => `Ate its way to prominence and then, quite suddenly, there were none.`],

  // --- dry humour
  [(c) => c.nc === 1, (c) => `Sings the same ${c.k} all day. It is impossible to say whether it is happy or merely consistent.`],
  [() => true, (c) => `Observed to stand quite still for long intervals, which in this company counts as conversation.`],
  [(c) => c.peak >= 3, (c) => `Keeps a respectful distance from its neighbours, except when it does not.`],
];

export const NOTE_COUNT = NOTES.length;

// The keeper's own note, in Voss's hand. It grows by a sentence as she is seen to do things.
function keeperNote(record) {
  const st = record?.stats || {};
  let t = 'Walks the rim. Does not eat, does not fade. Comes to a still finger before the others do.';
  if ((st.nestles || 0) >= 2) t += ' Stays there after they have gone.';
  else if ((st.nestles || 0) === 1) t += ' I believe she knows the hand.';
  return t;
}

// noteFor(species, record?, stats?) -> string. `stats` is game.state.stats (optional).
export function noteFor(species, record, stats) {
  if (isKeeper(species) || isKeeper(record)) return keeperNote(record || species?.record);
  const ctx = makeCtx(species, record || species?.record, stats);
  const ok = [];
  for (let i = 0; i < NOTES.length; i++) {
    try { if (NOTES[i][0](ctx)) ok.push(i); } catch {}
  }
  // behavioural notes first when the record has something to say
  const behaviour = ok.filter((i) => i >= 22);
  const pool = behaviour.length && (ctx.devoured || ctx.eaten || ctx.fusions || ctx.extinct || ctx.aurata || ctx.peak >= 8 || ctx.fell || ctx.splits >= 3)
    ? behaviour : ok;
  const sig = `${species?.id || ctx.name}|${ctx.devoured > 0}${ctx.devoured >= 3}${ctx.eaten > 0}${ctx.fusions > 0}${ctx.fusions >= 2}` +
    `${ctx.extinct}${ctx.peak >= 8}${ctx.peak >= 12}${ctx.fell > 0}${ctx.ageDeaths > 0}${ctx.splits >= 3}`;
  const h = hash(sig);
  const a = pool[h % pool.length];
  let text = NOTES[a][1](ctx);
  // occasionally a second sentence from the general pool
  if ((h >>> 8) % 3 === 0 && ok.length > 1) {
    const b = ok[(h >>> 12) % ok.length];
    if (b !== a) {
      const t2 = NOTES[b][1](ctx);
      if (text.length + t2.length < 190) text += ' ' + t2;
    }
  }
  return text;
}

// A terse field-note line for notable events (optional helper for the notebook).
export function observationFor(type, p = {}) {
  const nm = (s) => s?.name || 'an unnamed form';
  switch (type) {
    case 'species:new': return `A new form: ${nm(p.species)}.`;
    case 'species:extinct': return `${cap(nm(p.species))}: none remain.`;
    case 'mote:fuse': return p.isNew ? `Two singers merged. The result is new: ${nm(p.species)}.` : `Two singers merged into ${nm(p.species)}.`;
    case 'mote:eat': return 'One singer devoured another.';
    case 'mote:fall': return 'A singer was thrown from the edge.';
    case 'life:choir': return p.on ? 'The singers formed a ring. The light went gold.' : null;
    case 'life:floor': return p.on ? 'A note below the lowest note. The sand fled to the rim.' : null;
    case 'keeper:arrive': return 'When the low note ended, something large and pale stood up out of the bare bronze at the centre, and walked to the rim.';
    default: return null;
  }
}

export { words as numberWord };
