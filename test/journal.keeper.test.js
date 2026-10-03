// The previous keeper's pages: unlocking, the torn last page, and the notebook's tone rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEPER_PAGES, ENGRAVINGS, FLOOR_ENGRAVING, LONG_SITTING, isUnlocked, keeperPagesFor } from '../src/ui/keeper.js';

const allText = () => [
  ...KEEPER_PAGES.flatMap((p) => [p.date, p.text, p.post, p.rest, p.after, ...(p.sketch || []).map((s) => s.label)]),
  ...ENGRAVINGS, ...FLOOR_ENGRAVING,
].filter(Boolean);

test('page ids are unique and every page has a date and text', () => {
  const ids = new Set();
  for (const p of KEEPER_PAGES) {
    assert.ok(p.id && !ids.has(p.id), `duplicate or missing id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.date && p.text, `page ${p.id} lacks date or text`);
  }
});

test('a fresh keeping shows only what the first birth has shown, and the torn page last', () => {
  const pages = keeperPagesFor({ seen: { firstBirth: true }, stats: { births: 1 }, playSeconds: 120 });
  assert.deepEqual(pages.map((p) => p.id), ['leipzig', 'still', 'believed', 'shape', 'below']);
  assert.ok(pages[pages.length - 1].torn);
  assert.deepEqual(keeperPagesFor({}).map((p) => p.id), pages.map((p) => p.id));
});

test('no page speaks of gold, seams, eating, fusion or the finger before its time', () => {
  const ids = (state) => keeperPagesFor(state).map((p) => p.id);
  const has = (state, id) => ids(state).includes(id);
  // gold: only after the first old age
  assert.ok(!has({ stats: { deaths: 3, devoured: 2, fusions: 1 } }, 'thimble'));
  assert.ok(has({ seen: { firstGold: true } }, 'thimble'));
  assert.ok(has({ species: { a: { stats: { ageDeaths: 1 } } } }, 'thimble'));
  // the seam: a crack, and gold to fill it (both), never before the crack page
  assert.ok(!has({ seen: { firstGold: true } }, 'seam'));
  assert.ok(!has({ stats: { cracks: 1 } }, 'seam'));
  assert.ok(has({ stats: { cracks: 1 }, seen: { firstGold: true } }, 'seam'));
  assert.ok(has({ stats: { cracks: 1, heals: 1 } }, 'seam'));
  for (const st of [{ stats: { cracks: 1 }, seen: { firstGold: true } }, { stats: { cracks: 1, heals: 1 } }]) {
    const order = ids(st);
    assert.ok(order.indexOf('crack') >= 0 && order.indexOf('crack') < order.indexOf('seam'));
  }
  // union: the first fusion, or the first eating
  assert.ok(!has({ stats: { deaths: 2 } }, 'union'));
  assert.ok(has({ stats: { fusions: 1 } }, 'union'));
  assert.ok(has({ stats: { devoured: 1 } }, 'union'));
  assert.ok(has({ species: { a: { stats: { devoured: 1 } } } }, 'union'));
  // the menu: the first death of any kind, or the first eating
  assert.ok(!has({ stats: { births: 5, fusions: 1 } }, 'menu'));
  assert.ok(has({ stats: { deaths: 1 } }, 'menu'));
  assert.ok(has({ species: { a: { stats: { hungerDeaths: 1 } } } }, 'menu'));
  assert.ok(has({ stats: { devoured: 1 } }, 'menu'));
  // the finger: a long sitting, the first gold, or once they have sat against it
  assert.ok(!has({ playSeconds: LONG_SITTING - 1, stats: { deaths: 1, devoured: 1 } }, 'finger'));
  assert.ok(has({ playSeconds: LONG_SITTING }, 'finger'));
  assert.ok(has({ seen: { firstGold: true } }, 'finger'));
  assert.ok(has({ species: { a: { stats: { nestles: 1 } } } }, 'finger'));
});

test('unlocks: any-of arrays, all-of objects, nested', () => {
  assert.ok(isUnlocked({ all: ['firstCrack', ['firstGold', 'firstHeal']] }, { stats: { cracks: 1, heals: 1 } }));
  assert.ok(!isUnlocked({ all: ['firstCrack', ['firstGold', 'firstHeal']] }, { stats: { cracks: 1 } }));
  assert.ok(!isUnlocked({ all: ['firstCrack', 'firstGold'] }, { seen: { firstGold: true } }));
  assert.ok(!isUnlocked({}, {}));
  assert.ok(isUnlocked(undefined, {}));
});

test('pages come unstuck from flags, stats or the plate itself', () => {
  assert.ok(isUnlocked('firstCrack', { seen: { firstCrack: true } }));
  assert.ok(isUnlocked('firstCrack', { stats: { cracks: 1 } }));
  assert.ok(isUnlocked('firstCrack', { plate: { cracks: [{ pts: [] }] } }));
  assert.ok(isUnlocked('firstChoir', { seen: { choir: true } }));
  assert.ok(isUnlocked(['firstGold', 'firstCrack'], { stats: { cracks: 2 } }));
  assert.ok(!isUnlocked('firstDark', { seen: {} }));
  const all = keeperPagesFor({ seen: { firstCrack: true, firstDark: true, firstChoir: true, firstGold: true, firstFusion: true, firstDeath: true } });
  assert.equal(all.length, KEEPER_PAGES.length);
  assert.equal(all[all.length - 1].id, 'below');
});

test('her last page: the first line, the stained rest, and a short postscript', () => {
  const last = KEEPER_PAGES.find((p) => p.id === 'below');
  assert.equal(last.text, 'I am going to listen below the floor.');
  assert.ok(last.rest && last.rest.length > 40);
  assert.ok(last.after && last.after.length < 90, 'the postscript stays short');
});

test('the notebook never exclaims, and has no modern idiom', () => {
  for (const t of allText()) {
    assert.ok(!/!/.test(t), `exclamation in: ${t}`);
    assert.ok(!/\b(okay|OK|awesome|cool|wow)\b/.test(t), `modern idiom in: ${t}`);
  }
});

test('the floor is five, ten, twenty, forty wherever she writes of it', () => {
  const floor = KEEPER_PAGES.find((p) => p.id === 'floor');
  assert.match(floor.text, /Five, ten, twenty, forty/);
  assert.ok(ENGRAVINGS.some((l) => /FIVE · TEN · TWENTY · FORTY/.test(l)));
});
