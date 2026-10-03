// The previous keeper: M. A. Voss, 1891. Her notes (the first pages of the field book), the marks
// she scratched into the bronze (seen only in the dark), and the message under the sand.
//
// Page markup (rendered by journal.js):
//   ~~words~~   crossed out in her hand (she struck it and went on)
//   __words__   underlined
//   \n\n        a new paragraph
//
// KEEPER_PAGES entry: { id, date, text, unlock?, sketch?, post?, stain?, torn?, rest?, after? }
//   unlock   when the page comes unstuck: a flag name; an array (any one of them suffices); or
//            { all: [...] } (every one must hold; an entry may itself be an array or an object).
//            See isUnlocked() below. A page never speaks of a thing before the reader has seen it.
//   post     a later afterthought at the foot of the page, in a hurried hand
//   sketch   marginal drawings: { kind: 'mode', mode, label } | { kind: 'ring' | 'crack' | 'thimble' |
//            'tally' | 'flower', label }
//   torn     the last page: only `text` is legible; `rest` is lost in a water stain until the floor
//            has sounded, after which it reads clearly.
//   after    on the torn page, once the floor has sounded: a postscript in a steadier ink, dated the
//            day the floor sounded (the reader's own date, written as she writes hers).

export const KEEPER_PAGES = [
  {
    id: 'leipzig', date: '14th February 1891',
    text: 'The plate came today from Leipzig, wrapped in a horse blanket and smelling of the train. ' +
      'I clamped it at the centre as Herr Ritter’s letter instructs, sifted a little sand upon it, ' +
      'and drew the bow along the edge. The sand drew a cross; then, when I bore down, a ring. ' +
      'It was like watching a thought decide.',
    sketch: [{ kind: 'mode', mode: '1.3+', label: 'the cross' }, { kind: 'mode', mode: '2.4+', label: 'the ring' }],
    post: 'Ritter writes that the sand must be sea-sand, washed and dried. I have used the kitchen\u2019s, and it seems not to mind.',
  },
  {
    id: 'still', date: '19th February',
    text: 'I had supposed the sand would run to where the plate is most alive. It is quite the reverse. ' +
      'It flees the moving places and goes where the plate is __still__, and there it rests, content. ' +
      'I find this a comfort, and cannot say why.',
    sketch: [{ kind: 'mode', mode: '2.2+', label: 'here, and here: nothing moves' }],
    post: 'N.B. \u2014 the still places are not empty. They are only quiet.',
  },
  {
    id: 'believed', date: '2nd March',
    text: 'Tonight I held a single note for a very long while\u00a0— until the sand believed it. ' +
      'Where two of the lines crossed, the heap grew taller than its neighbours, and shivered, and ' +
      'something stood up. It was the size of a ~~button~~ shirt-stud, and it glowed.\n\n' +
      'I did not drop the bow. I am rather proud of that.',
  },
  {
    id: 'shape', date: '5th March', unlock: 'firstBirth',
    text: 'Each one sings the shape it is made of. Inside it, if you bring the lamp close, is the very ' +
      'figure that made it, turning slowly. When I stop bowing, they keep the plate going by themselves, ' +
      'and the sand goes on arranging itself to their song. I am no longer sure who is ~~playing~~ the player.',
    sketch: [{ kind: 'mode', mode: '1.4-', label: 'drawn from life, much enlarged' }],
  },
  {
    id: 'menu', date: '11th March', unlock: ['firstDeath', 'firstEat'],
    text: 'They eat what they agree with. A fifth feeds them; a near-miss, a note a hair’s breadth ' +
      'wide of their own, ~~starves~~ thins them to nothing. I have begun to hear the whole room as a menu. ' +
      'The kettle, I am sorry to say, is poison to the small bright ones.',
    stain: 'flower',
  },
  {
    id: 'union', date: '17th March', unlock: ['firstFusion', 'firstEat'],
    text: 'Two that agreed walked into one another and came out as one, singing both notes at once.\n\n' +
      'Two that did not agree\u00a0— ~~the smaller~~ I will not describe it. The larger was very pleased.',
    post: 'Later. It has not once stopped singing both notes. I find that I envy it.',
  },
  {
    id: 'thimble', date: '29th March', unlock: 'firstGold',
    text: 'The old ones go golden, and then they go. Each leaves a little gold upon the bronze, finer ' +
      'than the sand and heavier. I sweep it into a thimble. I do not know what else to do with it, and ' +
      'it seems wrong to throw away.',
    sketch: [{ kind: 'thimble', label: 'nine grains' }],
  },
  {
    id: 'crack', date: '9th April', unlock: 'firstCrack',
    text: 'I bowed too hard this evening, out of temper, which is no excuse. There is a crack now, fine as ' +
      'a hair, running in from the edge. The plate sounds as though it has a cold. They do not like it, ' +
      'and neither do I.',
    sketch: [{ kind: 'crack', label: '' }],
    post: 'I have apologised to it. I do not know whether that was foolish.',
  },
  {
    id: 'seam', date: '23rd April', unlock: { all: ['firstCrack', ['firstGold', 'firstHeal']] },
    text: 'The gold found the crack before I did. It went in like water finding a step, and stayed. ' +
      'Where it has sealed, the plate rings __truer__ than it did when it was whole\u00a0— and this morning ' +
      'something new was born along the seam, veined all through with gold.',
    post: 'So nothing here is wasted. Not even the dying.',
  },
  {
    id: 'dark', date: '6th May', unlock: 'firstDark',
    text: 'In the dark they sing lower, an octave down, and slowly. I think they dream. While they sleep ' +
      'the sand moves by itself, very gently, into the shapes of ones who are gone.',
    post: 'I counted them by their glow: eleven. In the morning, eleven still. I had half expected fewer.',
  },
  {
    id: 'finger', date: '20th May', unlock: ['firstGold', 'longSitting', 'firstNestle'],
    text: 'If I hold my finger very still upon the plate, they come. One by one they sit against it, the ' +
      'way cats sit against a door. I stayed so for an hour, until my arm went dead, and would do it again.',
    sketch: [{ kind: 'ring', label: 'my finger' }],
  },
  {
    id: 'organ', date: '2nd June', unlock: 'firstChoir',
    text: 'When three kinds or more agree at once, the whole plate becomes a single figure, and they rise ' +
      'into a ring and hang there in the light. The woman downstairs knocked to ask what the organ was. ' +
      'I told her ~~nothing~~ I had no organ. She did not believe me, and I do not blame her.',
    post: 'I have since bought an organ, a very small one, for the look of the thing.',
  },
  {
    id: 'floor', date: '14th June', unlock: 'firstChoir',
    text: 'Five, ten, twenty, forty. If all four sing at once, the plate hums underneath itself.\n\n' +
      'Below the lowest note there is a lower note. I have heard it once. It sounded like a floor.',
    sketch: [{ kind: 'tally', label: '' }],
  },
  {
    id: 'below', date: '— July', torn: true,
    text: 'I am going to listen below the floor.',
    rest: 'The still places are where they stand. There must be a stillness under all the others, and I ' +
      'mean to find it. If you are reading this, be patient with them. They forgive a great deal, and they ' +
      'remember everything.',
    after: 'I found it. It is very quiet here, and not at all lonely.',
  },
];

// Phosphor marks in the bronze, visible only when the lamp is out. The renderer lays them out in
// slots: four around the rim (long), then the four quarters (short). The slots either side of the
// clamp are left bare on purpose: that is where her last message appears when the floor sounds.
export const ENGRAVINGS = [
  'M · A · VOSS · MDCCCXCI',
  'WHERE IT IS STILL, THERE IS GROUND',
  'FIVE · TEN · TWENTY · FORTY',
  'BELOW THE LOWEST NOTE, A LOWER',
  'HOLD IT TILL THE SAND BELIEVES',
  'GOLD MENDS',
  'THEY REMEMBER',
  'WHAT AGREES, FEEDS',
];

// Her last message, bared when the floor sounds and every grain runs to the rim. The renderer parts
// it around the clamp: the first half above, the rest below.
export const FLOOR_ENGRAVING = [
  'To whoever holds the bow —',
  'I did not leave. I went down one note.',
  'Wherever the plate is still, that is me, holding still.',
  'They have been standing on me all along.',
  'Be gentle with them. Leave a little quiet.',
  '— M.',
];

// Unlock flags, checked against the persistent state (state.seen is set by progress.js; the stats,
// the species records and the plate are consulted too, so a page survives an old save, a missing
// flag, or a thing that happened while the reader was away):
//   firstBirth   seen.firstBirth  | stats.births > 0 | any species recorded
//   firstDeath   seen.firstDeath  | stats.deaths > 0 | any species record with a death of any kind
//   firstEat     seen.firstEat    | stats.devoured > 0 | any species record that has eaten
//   firstGold    seen.firstGold   | any species record with an old-age death
//   firstFusion  seen.firstFusion | stats.fusions > 0 | any species record that has fused
//   firstCrack   seen.firstCrack  | stats.cracks > 0 | state.plate.cracks.length > 0
//   firstHeal    seen.firstHeal   | stats.heals > 0  | any crack healed
//   firstNestle  seen.firstNestle | any species record that has sat against the resting finger
//   longSitting  state.playSeconds >= LONG_SITTING (time at the plate, not time away)
//   firstDark    seen.firstDark
//   firstChoir   seen.firstChoir  | seen.choir | stats.choirs > 0
//   floor        seen.floor
// Any other name is looked up in state.seen directly.
export const LONG_SITTING = 480;
const DEATHS = ['ageDeaths', 'hungerDeaths', 'fell', 'eaten'];
const anyRecord = (s, fn) => Object.values(s.species || {}).some((r) => !!r && fn(r.stats || {}));
export function isUnlocked(flag, state) {
  if (!flag) return true;
  if (Array.isArray(flag)) return flag.some((f) => isUnlocked(f, state));
  if (typeof flag === 'object') return Array.isArray(flag.all) ? flag.all.every((f) => isUnlocked(f, state)) : false;
  const s = state || {}, seen = s.seen || {}, st = s.stats || {};
  if (seen[flag]) return true;
  switch (flag) {
    case 'firstBirth': return (st.births || 0) > 0 || Object.keys(s.species || {}).length > 0;
    case 'firstDeath': return (st.deaths || 0) > 0 || anyRecord(s, (r) => DEATHS.some((k) => (r[k] || 0) > 0));
    case 'firstEat': return (st.devoured || 0) > 0 || anyRecord(s, (r) => (r.devoured || 0) > 0);
    case 'firstGold': return anyRecord(s, (r) => (r.ageDeaths || 0) > 0);
    case 'firstFusion': return (st.fusions || 0) > 0 || anyRecord(s, (r) => (r.fusions || 0) > 0);
    case 'firstCrack': return (st.cracks || 0) > 0 || (s.plate?.cracks?.length || 0) > 0;
    case 'firstHeal': return (st.heals || 0) > 0 || !!s.plate?.cracks?.some?.((c) => c && c.healed);
    case 'firstNestle': return anyRecord(s, (r) => (r.nestles || 0) > 0);
    case 'longSitting': return (s.playSeconds || 0) >= LONG_SITTING;
    case 'firstChoir': return !!seen.choir || (st.choirs || 0) > 0;
    default: return false;
  }
}

// The keeper's pages as the book shows them now (locked pages are simply not there yet; the torn
// page is always last).
export function keeperPagesFor(state) {
  return KEEPER_PAGES.filter((p) => isUnlocked(p.unlock, state));
}
