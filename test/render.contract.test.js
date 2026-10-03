// The renderer reads singer instances by state NAME and flag NAME (remapped from life.js's own
// STATES / FLAG every frame). These checks keep the two sides from drifting apart silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CANON_STATES, CANON_FLAGS } from '../src/render/gl.js';
import { STATES, FLAG } from '../src/sim/life.js';
import { FS_SINGER, VS_SINGER } from '../src/render/shaders.js';

test('every life state has a look', () => {
  for (const s of STATES) assert.ok(CANON_STATES.includes(s), `renderer has no look for state '${s}'`);
});

test('life flags the renderer draws are known by name', () => {
  for (const name of ['aurata', 'sleep', 'flash', 'nestle', 'float', 'lunge', 'keeper', 'ageDeath', 'cling']) {
    assert.ok(FLAG[name] > 0, `life.FLAG.${name} missing`);
    assert.ok(CANON_FLAGS[name] > 0, `renderer has no canonical bit for '${name}'`);
  }
});

test('the singer shaders read the keeper, gold-death and cling bits', () => {
  const src = VS_SINGER + FS_SINGER;
  for (const b of [CANON_FLAGS.keeper, CANON_FLAGS.ageDeath, CANON_FLAGS.cling]) {
    assert.ok(src.includes(`${b}.0`), `shader never tests flag ${b}`);
  }
});
