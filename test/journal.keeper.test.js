// The previous keeper's pages: unlocking, the torn last page, and the notebook's tone rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEPER_PAGES, ENGRAVINGS, FLOOR_ENGRAVING, isUnlocked, keeperPagesFor } from '../src/ui/keeper.js';

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

test('a fresh keeping shows the always-there pages, and the torn page last', () => {
  const pages = keeperPagesFor({});
  assert.ok(pages.length >= 8);
  assert.equal(pages[pages.length - 1].id, 'below');
  assert.ok(pages[pages.length - 1].torn);
  assert.ok(!pages.some((p) => p.id === 'crack' || p.id === 'dark' || p.id === 'organ' || p.id === 'floor'));
});

test('pages come unstuck from flags, stats or the plate itself', () => {
  assert.ok(isUnlocked('firstCrack', { seen: { firstCrack: true } }));
  assert.ok(isUnlocked('firstCrack', { stats: { cracks: 1 } }));
  assert.ok(isUnlocked('firstCrack', { plate: { cracks: [{ pts: [] }] } }));
  assert.ok(isUnlocked('firstChoir', { seen: { choir: true } }));
  assert.ok(isUnlocked(['firstGold', 'firstCrack'], { stats: { cracks: 2 } }));
  assert.ok(!isUnlocked('firstDark', { seen: {} }));
  const all = keeperPagesFor({ seen: { firstCrack: true, firstDark: true, firstChoir: true, firstGold: true } });
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
  assert.ok(ENGRAVINGS.some((l) => /5 · 10 · 20 · 40/.test(l)));
});
