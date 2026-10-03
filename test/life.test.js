// Invariants for the singers and their names. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bus } from '../src/core/bus.js';
import { makeRng } from '../src/core/rng.js';
import { newState } from '../src/core/persist.js';
import { createField } from '../src/sim/field.js';
import { createSand } from '../src/sim/sand.js';
import { createLife, TUNE, STATE_CODE, FLAG, KEEPER_ID } from '../src/sim/life.js';
import { nameFor, noteFor, speciesRatioText, NOTE_COUNT, colourFor, KEEPER } from '../src/sim/naming.js';
import { MODES, modeById, evalMode } from '../src/sim/modes.js';

function makeGame(seed = 5, state = newState(), grains = 9000) {
  const rng = makeRng(seed);
  const field = createField({ state, bus, rng });
  const sand = createSand(field, { state, bus });
  sand.seedScatter(grains);
  const game = { t: 0, rng, bus, state, field, sand, light: { on: true, level: 1 }, fx: {}, hold: null,
    wear: new Uint8Array(128 * 128), WEAR: 128, wearVersion: 0 };
  game.life = createLife(game);
  return game;
}
function step(game, secs, bow = null, amp = 0.8) {
  const dt = 1 / 30;
  for (let i = 0; i < Math.round(secs / dt); i++) {
    game.field.setSource('bow', bow ? [{ mode: bow, amp }] : []);
    game.field.setSource('chorus', game.life.chorus());
    game.field.update(dt);
    game.sand.update(dt);
    game.life.update(dt);
    game.t += dt;
  }
}
function listen(types) {
  const seen = Object.fromEntries(types.map((t) => [t, []]));
  const offs = types.map((t) => bus.on(t, (p) => seen[t].push(p)));
  return { seen, off: () => offs.forEach((f) => f()) };
}
const finite = (m) => [m.u, m.v, m.vx, m.vy, m.hx, m.hy, m.e, m.age, m.r].every(Number.isFinite);

test('a held note quickens a singer, with events and a record', () => {
  const ev = listen(['mote:birth', 'species:new']);
  const g = makeGame(3);
  step(g, 45, '2.5-');
  ev.off(); g.life.destroy();
  assert.ok(ev.seen['mote:birth'].length >= 1, 'no birth');
  const first = ev.seen['mote:birth'][0];
  assert.equal(first.species.id, '2.5-');
  assert.equal(first.isNew, true);
  assert.equal(ev.seen['species:new'].length >= 1, true);
  const rec = g.state.species['2.5-'];
  assert.ok(rec && rec.name && rec.genus && rec.epithet && rec.note, 'record incomplete');
  assert.ok(rec.firstSeen > 0 && rec.peak >= 1);
});

test('no NaN, cap respected, instance data consistent under violent and long play', () => {
  const g = makeGame(9);
  for (let i = 0; i < 90; i++) g.life.spawn(i % 2 ? '1.3+' : '2.4-', Math.random() * 1.6 - 0.8, Math.random() * 1.6 - 0.8, 0.9, { silent: true });
  assert.ok(g.life.motes.length <= TUNE.cap);
  step(g, 20, '1.3+', 0.9);
  step(g, 10, '3.7-', 1.5);
  step(g, 30);
  assert.ok(g.life.motes.length <= TUNE.cap);
  for (const m of g.life.motes) assert.ok(finite(m), `non-finite mote ${JSON.stringify(m.state)}`);
  const inst = g.life.instanceData();
  assert.equal(inst.stride, 16);
  assert.equal(inst.count, g.life.motes.length);
  for (let i = 0; i < inst.count * 16; i++) assert.ok(Number.isFinite(inst.data[i]));
  for (let i = 0; i < inst.count; i++) {
    const code = Math.floor(inst.data[i * 16 + 5]);
    assert.ok(code >= 0 && code <= STATE_CODE.cling);
  }
  for (const c of g.life.chorus()) assert.ok(c.amp > 0 && c.amp <= 1.0 && typeof c.mode === 'string');
  g.life.destroy();
});

test('chorus() and populations() return pooled arrays (no per-frame allocation)', () => {
  const g = makeGame(2);
  g.life.spawn('1.3+', 0.3, 0.3, 0.8, { silent: true });
  step(g, 1);
  const a = g.life.chorus(), p = g.life.populations();
  step(g, 1);
  assert.equal(g.life.chorus(), a);
  assert.equal(g.life.populations(), p);
  assert.equal(p[0].count, 1);
  g.life.destroy();
});

test('serialize -> JSON -> deserialize round trip', () => {
  const g = makeGame(4);
  for (let i = 0; i < 8; i++) g.life.spawn(['1.3+', '2.4-', '1.2+|1.3+'][i % 3].split('|'), -0.5 + i * 0.12, 0.3, 0.7, { silent: true });
  step(g, 5);
  const before = g.life.motes.map((m) => ({ id: m.id, sp: m.sp, u: m.u, v: m.v, e: m.e }));
  const blob = JSON.parse(JSON.stringify(g.life.serialize()));
  g.life.destroy();
  const g2 = makeGame(4, g.state);
  g2.life.deserialize(blob);
  assert.equal(g2.life.motes.length, before.length);
  for (const b of before) {
    const m = g2.life.motes.find((x) => x.id === b.id);
    assert.ok(m, 'mote lost');
    assert.equal(m.sp, b.sp);
    assert.ok(Math.abs(m.u - b.u) < 1e-3 && Math.abs(m.e - b.e) < 2e-3);
  }
  assert.ok(g2.life.species['1.2+|1.3+'], 'hybrid species not restored');
  step(g2, 2);
  g2.life.destroy();
  // garbage in: no throw
  const g3 = makeGame(1);
  g3.life.deserialize({ v: 1, motes: [[1, 'nonsense', NaN, 0, 0, 0, 0.5, 1, 300, 0, 0, 0, 0]], species: [] });
  g3.life.deserialize(null);
  assert.equal(g3.life.motes.length, 0);
  g3.life.destroy();
});

test('old age crumbles into sand and gold (flag 128 while dying); only a throw goes over the edge', () => {
  const ev = listen(['mote:death', 'mote:fall']);
  const g = makeGame(6);
  const old = g.life.spawn('1.3+', 0.4, 0.4, 0.8, { silent: true });
  old.age = old.life - 0.1;
  const goldBefore = countGold(g.sand);
  let ageFlag = false;
  for (let i = 0; i < 90; i++) {
    step(g, 1 / 30);
    const inst = g.life.instanceData();
    for (let j = 0; j < inst.count; j++) if (inst.data[j * 16 + 15] & FLAG.ageDeath) ageFlag = true;
  }
  assert.ok(ev.seen['mote:death'].some((d) => d.cause === 'age' && d.mote === old));
  assert.ok(ageFlag, 'no death-by-age flag (128) while crumbling');
  assert.ok(countGold(g.sand) > goldBefore, 'no gold left behind');
  // an ordinary jolt (a tap, a flinch) never carries a singer over the edge
  const a = g.life.spawn('1.3+', 0.93, 0, 0.8, { silent: true });
  a.state = 'startle'; a.dur = 0.55; a.st = 0; a.kx = 3; a.scool = 5;
  step(g, 2);
  assert.ok(!a.dead && a.state !== 'fall' && Math.abs(a.u) <= 0.95, 'a jolt threw a singer off');
  // a throw does
  const m = g.life.spawn('1.3+', 0.93, 0, 0.8, { silent: true });
  m.state = 'startle'; m.dur = 0.8; m.st = 0; m.kx = 3; m.scool = 5; m.thrown = true;
  step(g, 2);
  assert.ok(ev.seen['mote:fall'].some((d) => d.mote === m));
  assert.ok(ev.seen['mote:death'].some((d) => d.cause === 'fall' && d.mote === m));
  ev.off(); g.life.destroy();
});

test('first births are quick: a steady figure at amp .45 quickens within 8-14 s; later ones keep their pace', () => {
  for (const amp of [0.45, 0.8]) {
    const ev = listen(['mote:birth']);
    const g = makeGame(31, newState(), 20000);
    let t = 0;
    const times = [];
    const off = bus.on('mote:birth', () => { g.state.stats.births++; times.push(t); });   // as progress.js does
    while (t < 30) { step(g, 0.1, '2.5-', amp); t += 0.1; }
    off(); ev.off(); g.life.destroy();
    assert.ok(times.length >= 4, `amp ${amp}: only ${times.length} births in 30 s`);
    assert.ok(times[0] >= 7 && times[0] <= 14, `amp ${amp}: first birth at ${times[0].toFixed(1)} s`);
    assert.ok(times[2] <= 22, `amp ${amp}: third birth at ${times[2].toFixed(1)} s`);
    // after the third, a familiar kind quickens at its ordinary pace (about 3.4 s apart at .8)
    for (let i = 3; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 2.9, `amp ${amp}: births ${i} and ${i + 1} only ${(times[i] - times[i - 1]).toFixed(1)} s apart`);
  }
  // an experienced plate (three births already) keeps the old, slower gestation
  const st = newState(); st.stats.births = 3;
  st.species['1.2+'] = { id: '1.2+', name: 'x' }; st.species['1.3+'] = { id: '1.3+', name: 'y' }; st.species['2.3+'] = { id: '2.3+', name: 'z' };
  const ev = listen(['mote:birth']);
  const g = makeGame(31, st, 20000);
  step(g, 18, '2.5-', 0.8);
  ev.off(); g.life.destroy();
  assert.equal(ev.seen['mote:birth'].length, 0, 'late births should not be hurried');
});

// a point near the rim where a mode is loudest (a strong antinode)
function loudSpot(modeId, rimMin = 0.8) {
  const md = modeById(modeId);
  let best = null, bv = -1;
  for (let i = 0; i <= 40; i++) for (let j = 0; j <= 40; j++) {
    const u = -0.9 + 1.8 * i / 40, v = -0.9 + 1.8 * j / 40;
    if (Math.max(Math.abs(u), Math.abs(v)) < rimMin || Math.hypot(u, v) < 0.3) continue;
    const f = Math.abs(evalMode(md, u, v));
    if (f > bv) { bv = f; best = { u, v }; }
  }
  return best;
}

test('violence: a singer clings (state, flag 256) for seconds before it can fall; still points shelter it', () => {
  const ev = listen(['mote:cling', 'mote:fall', 'mote:throw']);
  const g = makeGame(41);
  const modes = ['4.6+', '3.7-', '5.6-', '2.7+'];
  const spot = loudSpot(modes[0]);
  const ms = [];
  for (let i = 0; i < 6; i++) ms.push(g.life.spawn('1.3+', spot.u + (i % 3 - 1) * 0.05, spot.v + (i > 2 ? 0.05 : -0.05), 0.5 + i * 0.08, { silent: true }));
  const firstCling = new Map(), fellAt = new Map();
  let clingFlag = false, t = 0;
  for (let i = 0; i < 25 * 30; i++) {
    const md = modes[Math.floor(t / 1.5) % modes.length];
    step(g, 1 / 30, md, 1.15); t += 1 / 30;
    for (const m of ms) {
      if (m.state === 'cling' && !firstCling.has(m)) firstCling.set(m, t);
      if (m.state === 'fall' && !fellAt.has(m)) fellAt.set(m, t);
    }
    if (!clingFlag) {
      const inst = g.life.instanceData();
      for (let j = 0; j < inst.count; j++) if (inst.data[j * 16 + 15] & FLAG.cling) {
        clingFlag = true;
        assert.equal(Math.floor(inst.data[j * 16 + 5]), STATE_CODE.cling, 'cling has its own state code for the renderer');
      }
    }
  }
  assert.ok(firstCling.size >= 4, `only ${firstCling.size} clung`);
  assert.ok(clingFlag, 'no cling flag (256) in the instance data');
  assert.ok(ev.seen['mote:cling'].length >= firstCling.size);
  for (const [m, tf] of fellAt) {
    assert.ok(firstCling.has(m), 'fell without clinging first');
    assert.ok(tf - firstCling.get(m) >= 1.5, `fell ${(tf - firstCling.get(m)).toFixed(2)} s after it began to cling`);
  }
  assert.ok(ev.seen['mote:fall'].length <= ev.seen['mote:throw'].length, 'every fall follows a throw');
  assert.ok(fellAt.size < ms.length, 'all six fell: too harsh');
  ev.off(); g.life.destroy();

  // the same violence beside a resting finger, or a felt damper: no one falls
  for (const shelter of ['hold', 'damper']) {
    const ev2 = listen(['mote:fall', 'mote:throw']);
    const g2 = makeGame(41);
    const ms2 = [];
    for (let i = 0; i < 5; i++) ms2.push(g2.life.spawn('1.3+', spot.u + (i % 3 - 1) * 0.05, spot.v + (i > 2 ? 0.05 : -0.05), 0.5, { silent: true }));
    if (shelter === 'hold') g2.hold = { u: spot.u, v: spot.v, t: 0 };
    else g2.field.dampers = [{ u: spot.u, v: spot.v, r: 0.06 }];
    let t2 = 0;
    for (let i = 0; i < 25 * 30; i++) {
      if (shelter === 'damper') g2.field.dampers = [{ u: spot.u, v: spot.v, r: 0.06 }];
      step(g2, 1 / 30, modes[Math.floor(t2 / 1.5) % modes.length], 1.15); t2 += 1 / 30;
    }
    assert.equal(ev2.seen['mote:fall'].filter((e) => ms2.includes(e.mote)).length, 0, `${shelter}: a sheltered singer fell`);
    ev2.off(); g2.life.destroy();
  }

  // pinned at an antinode (no creeping away): every throw follows a visible cling of at least
  // clingMin s, and the strong hold on longer than the weak
  const creep = TUNE.clingCreep;
  TUNE.clingCreep = 0;
  try {
    const held = {};
    for (const e0 of [0.2, 0.95]) {
      const g3 = makeGame(43);
      const md = modeById('4.7+');
      let best = null, bf = 0;
      for (let u = -0.6; u <= 0.6; u += 0.02) for (let v = -0.6; v <= 0.6; v += 0.02) {
        const f = Math.abs(evalMode(md, u, v));
        if (Math.hypot(u, v) > 0.25 && f > bf) { bf = f; best = { u, v }; }
      }
      step(g3, 1.5, '4.7+', 1.15);
      const m = g3.life.spawn('1.3+', best.u, best.v, e0, { silent: true });
      let tc = null, tt = null, t3 = 0, lastCling = null;
      for (let i = 0; i < 12 * 30 && tt === null; i++) {
        step(g3, 1 / 30, '4.7+', 1.15); t3 += 1 / 30;
        if (m.state === 'cling') { if (tc === null) tc = t3; if (lastCling === null) lastCling = t3; } else if (m.state !== 'startle') lastCling = null;
        if (m.thrown) tt = t3;
      }
      assert.ok(tc !== null && tt !== null, `e=${e0}: clung ${tc}, thrown ${tt}`);
      assert.ok(tt - lastCling >= TUNE.clingMin + TUNE.clingMinE * 0.1 - 0.05, `e=${e0}: thrown after only ${(tt - lastCling).toFixed(2)} s of clinging`);
      held[e0] = tt - tc;
      g3.life.destroy();
    }
    assert.ok(held[0.95] > held[0.2] + 0.8, `strong held ${held[0.95].toFixed(2)} s, weak ${held[0.2].toFixed(2)} s`);
    assert.ok(held[0.2] >= 1.2 && held[0.95] <= 5, `cling times ${held[0.2].toFixed(2)} / ${held[0.95].toFixed(2)} s`);
  } finally { TUNE.clingCreep = creep; }
});

test('the keeper: arrives once after the Floor, at the centre, immortal, silent, persistent', () => {
  const ev = listen(['species:new', 'keeper:arrive', 'mote:eat', 'mote:fuse', 'mote:death', 'mote:fall', 'mote:cling']);
  const g = makeGame(51);
  for (let i = 0; i < 6; i++) g.life.spawn('1.3+', -0.5 + i * 0.2, 0.45, 0.8, { silent: true });
  step(g, 3, '1.3+');
  bus.emit('floor:end', {});
  assert.equal(g.life.keeper, null, 'she waits a moment');
  assert.equal(g.state.seen.keeperDue, true);
  step(g, TUNE.keeperDelay + 0.5);
  const k = g.life.keeper;
  assert.ok(k, 'no keeper');
  assert.equal(ev.seen['keeper:arrive'].length, 1);
  assert.equal(ev.seen['keeper:arrive'][0].mote, k);
  const spNew = ev.seen['species:new'].find((e) => e.species.id === KEEPER_ID);
  assert.ok(spNew, 'no species:new for the keeper');
  assert.equal(spNew.species.name, 'Vossia fundamentalis');
  assert.deepEqual(spNew.species.comps, ['floor']);
  assert.ok(Math.hypot(k.u, k.v) < 0.02, 'born at the centre');
  assert.equal(k.state, 'born');
  assert.equal(g.state.seen.keeper, true);
  const rec = g.state.species[KEEPER_ID];
  assert.equal(rec.name, KEEPER.name);
  assert.match(rec.note, /^Walks the rim\. Does not eat, does not fade\./);
  assert.equal(rec.ratio, 'k 2 · below the lowest note');
  // flag 64, and she is big
  step(g, TUNE.keeperBorn + 0.5);
  assert.ok(Math.abs(k.r - TUNE.rBase * TUNE.keeperR) < 1e-6, `radius ${k.r}`);
  let kFlag = 0;
  const inst = g.life.instanceData();
  for (let j = 0; j < inst.count; j++) if (inst.data[j * 16 + 15] & FLAG.keeper) { kFlag++; assert.equal(inst.data[j * 16 + 6], 0, 'n1 = 0: the fundamental'); }
  assert.equal(kFlag, 1);
  // a second Floor's end brings no second keeper
  bus.emit('floor:end', {});
  step(g, 5);
  assert.equal(g.life.motes.filter((m) => m.keeper).length, 1);
  assert.equal(ev.seen['keeper:arrive'].length, 1);
  // she sings nothing into the plate, and counts for no choir
  assert.ok(!g.life.chorus().some((c) => c.mode === 'floor'));
  assert.equal(g.life.count, g.life.motes.filter((m) => !m.keeper && !m.dead && m.state !== 'die' && m.state !== 'fall').length);
  const kp = g.life.populations().find((p) => p.keeper);
  assert.ok(kp && kp.id === KEEPER_ID && kp.count === 1 && kp.amp === 0);
  // immortal: discordant company, violent bowing, a long time
  const foes = [];
  for (let i = 0; i < 4; i++) foes.push(g.life.spawn(['2.3-', '2.4-', '1.3+|2.4+'.split('|')[0], '3.4+'][i], k.u + 0.03, k.v, 0.9, { silent: true }));
  k.age = 1e6;
  step(g, 8, '3.7-', 1.15);
  step(g, 20, '2.3-', 0.9);
  assert.ok(!k.dead && g.life.keeper === k && !['die', 'fall', 'cling', 'startle'].includes(k.state), `keeper state ${k.state}`);
  assert.ok(!ev.seen['mote:eat'].some((e) => e.prey === k || e.pred === k), 'the keeper ate or was eaten');
  assert.ok(!ev.seen['mote:fuse'].some((e) => e.a === k || e.b === k), 'the keeper fused');
  assert.ok(!ev.seen['mote:death'].some((e) => e.mote === k) && !ev.seen['mote:cling'].some((e) => e.mote === k));
  assert.equal(g.state.species[KEEPER_ID].extinct, false);
  // persisted: exactly one, where she was
  const blob = JSON.parse(JSON.stringify(g.life.serialize()));
  const where = { u: k.u, v: k.v };
  ev.off(); g.life.destroy();
  const g2 = makeGame(52, g.state);
  const ev2 = listen(['keeper:arrive', 'species:new']);
  g2.life.deserialize(blob);
  assert.ok(g2.life.keeper, 'keeper not restored');
  assert.ok(Math.abs(g2.life.keeper.u - where.u) < 1e-3 && Math.abs(g2.life.keeper.v - where.v) < 1e-3);
  step(g2, 3);
  bus.emit('floor:end', {});
  step(g2, 5);
  assert.equal(g2.life.motes.filter((m) => m.keeper).length, 1);
  assert.equal(ev2.seen['keeper:arrive'].length, 0, 'a restored keeper is not announced again');
  ev2.off(); g2.life.destroy();
  // a save without her (but with the flag) still has her: she is immortal
  const g3 = makeGame(53, g.state);
  g3.life.deserialize({ ...blob, kp: null });
  step(g3, 0.5);
  assert.equal(g3.life.motes.filter((m) => m.keeper).length, 1);
  g3.life.destroy();
});

test('the keeper walks the rim clockwise, comforts those near her, and comes first to a still finger', () => {
  const g = makeGame(61);
  for (let i = 0; i < 8; i++) g.life.spawn('1.3+', -0.4 + i * 0.1, 0.3, 0.6, { silent: true });
  const k = g.life.summonKeeper(true);
  step(g, TUNE.keeperBorn + 30, '1.3+', 0.6);
  assert.ok(Math.hypot(k.u, k.v) > 0.62, `still at radius ${Math.hypot(k.u, k.v).toFixed(2)} after 30 s`);
  // clockwise on screen = polar angle rising (v points down)
  let turned = 0, prev = Math.atan2(k.v, k.u);
  for (let i = 0; i < 60; i++) {
    step(g, 1, '1.3+', 0.6);
    const a = Math.atan2(k.v, k.u);
    let d = a - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
    turned += d; prev = a;
    assert.ok(Math.abs(k.u) <= 0.9 && Math.abs(k.v) <= 0.9);
  }
  assert.ok(turned > 0.25, `turned ${turned.toFixed(2)} rad in 60 s (should be clockwise, slowly)`);
  assert.ok(turned < 2.5, `turned ${turned.toFixed(2)} rad in 60 s (too fast)`);
  // comfort: a singer beside her gains a little
  const c = g.life.spawn('1.3+', k.u * 0.85, k.v * 0.85, 0.5, { silent: true });
  step(g, 0.2);
  assert.ok(c.comfort > 0, 'no comfort beside the keeper');
  // the finger: across the plate from her; singers already near it wait for her
  const hu = -Math.sign(k.u || 1) * 0.15, hv = -Math.sign(k.v || 1) * 0.15;
  for (const m of g.life.motes) if (!m.keeper && !m.dead) { m.u = hu + (Math.random() - 0.5) * 0.4; m.v = hv + (Math.random() - 0.5) * 0.4; }
  g.hold = { u: hu, v: hv, t: g.t };
  let kAt = null, otherAt = null;
  for (let i = 0; i < 20 * 30 && (kAt === null || otherAt === null); i++) {
    step(g, 1 / 30);
    if (kAt === null && k.state === 'nestle') kAt = g.t;
    if (otherAt === null && g.life.motes.some((m) => !m.keeper && m.state === 'nestle')) otherAt = g.t;
  }
  assert.ok(kAt !== null, 'she never came to the finger');
  assert.ok(otherAt === null || otherAt >= kAt - 1.5, `another came first (${otherAt?.toFixed(1)} vs ${kAt.toFixed(1)})`);
  g.hold = null;
  g.life.destroy();
});

test('the keeper does not stand up in the dark; she waits for the light', () => {
  const g = makeGame(71);
  g.light.on = false;
  bus.emit('floor:end', {});
  step(g, TUNE.keeperDelay + 4);
  assert.equal(g.life.keeper, null);
  assert.equal(g.life.keeperDue, true);
  g.light.on = true;
  step(g, TUNE.keeperDelay - 0.5);
  assert.equal(g.life.keeper, null, 'she waits a moment in the light first');
  step(g, 1);
  assert.ok(g.life.keeper);
  g.life.destroy();
});
function countGold(sand) { let n = 0; for (let i = 0; i < sand.n; i++) if (sand.kind[i] === 1) n++; return n; }

test('disagreement devours; agreement fuses into a recorded hybrid', () => {
  const ev = listen(['mote:eat', 'mote:fuse', 'species:new', 'species:extinct']);
  const g = makeGame(8);
  const a = g.life.spawn('2.4-', 0.3, 0.3, 0.8, { silent: true });     // k20
  const b = g.life.spawn('2.3-', 0.33, 0.3, 0.4, { silent: true });    // k13: 20:13 is sour
  step(g, 2);
  assert.equal(ev.seen['mote:eat'].length, 1);
  assert.equal(ev.seen['mote:eat'][0].pred, a);
  assert.equal(ev.seen['mote:eat'][0].prey, b);
  step(g, 2);
  assert.ok(ev.seen['species:extinct'].some((e) => e.species.id === '2.3-'));
  assert.equal(g.state.species['2.3-'].extinct, true);
  // fusion: an octave pair, well fed, side by side
  const c = g.life.spawn('1.3+', -0.4, -0.3, 0.95, { silent: true });
  const d = g.life.spawn('2.4+', -0.37, -0.3, 0.95, { silent: true });
  let fused = false;
  for (let i = 0; i < 40 && !fused; i++) {
    c.e = d.e = 0.95;
    if (!c.dead && !d.dead && c.state !== 'fuse') { d.u = c.u + 0.03; d.v = c.v; }
    step(g, 0.5);
    fused = ev.seen['mote:fuse'].length > 0;
  }
  assert.ok(fused, 'no fusion');
  const f = ev.seen['mote:fuse'][0];
  assert.equal(f.species.id, '1.3+|2.4+');
  assert.equal(f.isNew, true);
  const rec = g.state.species['1.3+|2.4+'];
  assert.deepEqual(rec.parents.slice().sort(), ['1.3+', '2.4+']);
  assert.equal(rec.gen, 1);
  ev.off(); g.life.destroy();
});

test('darkness: metabolism halves, no births, singers sleep', () => {
  const g = makeGame(10);
  step(g, 40, '1.3+');
  const ev = listen(['mote:birth', 'mote:split']);
  g.light.on = false;
  const n = g.life.motes.length;
  step(g, 30, '1.3+');
  assert.equal(ev.seen['mote:birth'].length, 0);
  assert.equal(ev.seen['mote:split'].length, 0);
  assert.ok(g.life.motes.length <= n);
  const inst = g.life.instanceData();
  let sleeping = 0;
  for (let i = 0; i < inst.count; i++) if (inst.data[i * 16 + 15] & 2) sleeping++;
  assert.ok(sleeping > 0, 'nobody sleeping');
  ev.off(); g.life.destroy();
});

test('in the dark the plate dreams of the dead, even with sleepers on it; they wake to full voice', () => {
  const g = makeGame(14, newState(), 14000);
  const gone = g.life.spawn('3.4+', 0.5, 0.5, 0.05, { silent: true });
  step(g, 0.2); gone.e = -0.001; step(g, 2);
  assert.equal(g.state.species['3.4+'].extinct, true);
  step(g, 40, '1.3+');
  step(g, 6);
  const living = g.life.count;
  assert.ok(living >= 4, `only ${living} singers`);
  const lit = g.field.total;
  const ev = listen(['mote:birth', 'mote:split']);
  g.light.on = false;
  step(g, 3);
  const dreamt = g.life.dreamingOf && g.state.species[g.life.dreamingOf];
  assert.ok(dreamt, 'no dream');
  const stillFrac = () => {
    const mds = dreamt.comps.map(modeById);
    let n = 0;
    for (let i = 0; i < g.sand.n; i++) {
      let f = 0; for (const md of mds) f += evalMode(md, g.sand.x[i], g.sand.y[i]);
      if (Math.abs(f / mds.length) < 0.12) n++;
    }
    return n / g.sand.n;
  };
  const before = stillFrac();
  const e0 = g.life.populations().reduce((s, p) => s + p.meanE * p.count, 0) / living;
  step(g, 60);
  assert.ok(g.field.total < 0.03, `the bronze still sings at ${g.field.total.toFixed(3)} in the dark`);
  assert.ok(g.sand.dreaming !== false, 'the sand is not dreaming');
  const after = stillFrac();
  assert.ok(after > before + 0.08, `the sand did not drift toward ${dreamt.name}: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  // the sleepers still hear one another: a minute of darkness costs them little
  const n1 = g.life.count;
  const e1 = g.life.populations().reduce((s, p) => s + (p.keeper ? 0 : p.meanE * p.count), 0) / Math.max(1, n1);
  assert.ok(n1 >= living - 1 && e1 > e0 - 0.15, `darkness starved them: ${living} -> ${n1}, e ${e0.toFixed(2)} -> ${e1.toFixed(2)}`);
  assert.equal(ev.seen['mote:birth'].length + ev.seen['mote:split'].length, 0, 'born in the dark');
  // morning: hushed for a moment (the dream can be seen), then their full voice
  g.light.on = true;
  step(g, 1);
  assert.ok(g.field.total < lit * 0.6, 'woke at full voice at once');
  step(g, 12);
  assert.ok(g.field.total > lit * 0.7, `voice did not come back: ${g.field.total.toFixed(2)} vs ${lit.toFixed(2)}`);
  ev.off(); g.life.destroy();
});

test('walking polishes the bronze', () => {
  const g = makeGame(12);
  for (let i = 0; i < 6; i++) g.life.spawn('1.3+', -0.6 + i * 0.2, 0.2, 0.8, { silent: true });
  step(g, 8, '1.3+');
  let sum = 0;
  for (const w of g.wear) sum += w;
  assert.ok(sum > 0 && g.wearVersion > 0);
  assert.ok(g.wearVersion <= 8 / 0.25 + 1, 'wearVersion bumped too often');
  g.life.destroy();
});

test('resting finger gathers singers', () => {
  const g = makeGame(13);
  for (let i = 0; i < 5; i++) g.life.spawn('1.3+', 0.2 + i * 0.05, -0.2, 0.8, { silent: true });
  g.hold = { u: 0.3, v: 0.1, t: 0 };
  step(g, 12, '1.3+', 0.5);
  const near = g.life.motes.filter((m) => Math.hypot(m.u - 0.3, m.v - 0.1) < 0.16).length;
  assert.ok(near >= 3, `only ${near} came to the finger`);
  assert.ok(g.life.motes.some((m) => m.state === 'nestle'));
  g.life.destroy();
});

test('simulateOffline: quick, sane, and writes field notes', () => {
  const g = makeGame(14);
  for (let i = 0; i < 20; i++) g.life.spawn(['1.3+', '2.4-', '3.4+'][i % 3], Math.random() - 0.5, Math.random() - 0.5, 0.7, { silent: true });
  step(g, 2);
  const t0 = performance.now();
  const notes = g.life.simulateOffline(3 * 3600);
  const ms = performance.now() - t0;
  assert.ok(ms < 150, `offline took ${ms.toFixed(0)} ms`);
  assert.ok(Array.isArray(notes) && notes.length >= 1);
  for (const n of notes) { assert.equal(typeof n.text, 'string'); assert.ok(!n.text.includes('!')); assert.ok(n.kind); }
  for (const m of g.life.motes) assert.ok(finite(m));
  assert.ok(g.life.motes.length <= TUNE.cap);
  for (const r of Object.values(g.state.species)) assert.equal(r.count, g.life.motes.filter((m) => m.sp === r.id).length);
  g.life.destroy();
});

test('names: deterministic, distinct for every single mode, sensible hybrids', () => {
  const seen = new Map();
  for (const m of MODES) {
    if (m.special || m.k < 5) continue;
    const a = nameFor([m.id]), b = nameFor([m.id]);
    assert.equal(a.name, b.name);
    assert.match(a.name, /^[A-Z][a-z]+ [a-z]+$/);
    assert.ok(!seen.has(a.name), `${a.name} used twice (${seen.get(a.name)}, ${m.id})`);
    seen.set(a.name, m.id);
  }
  assert.equal(nameFor(['2.5-']).genus, 'Dyapentas');
  assert.equal(nameFor(['1.3+', '2.4-']).epithet, 'diapasonica');
  assert.match(nameFor(['1.2+', '1.3+', '2.4-']).genus, /^(Scala|Symphonia|Polyphonia)$/);
  assert.match(nameFor(['2.5-'], true).name, / aurata$/);
  assert.equal(nameFor(['floor']).name, 'Vossia fundamentalis');
  assert.match(noteFor({ id: 'keeper', comps: ['floor'], ks: [2] }, { stats: {} }), /^Walks the rim\. Does not eat, does not fade\. Comes to a still finger before the others do\.$/);
  assert.ok(!noteFor({ id: 'keeper' }, { stats: { nestles: 3 } }).includes('!'));
  assert.ok(nameFor(['1.3+', '2.4-'], false, true).name.split(' ').length === 3);
  assert.equal(speciesRatioText({ ks: [10, 20] }), 'k 10, 20 (1:2)');
  assert.ok(colourFor('1.3+').every((x) => x >= 0 && x <= 1));
});

test('notes: plenty of templates, varied, Victorian (no exclamations)', () => {
  assert.ok(NOTE_COUNT >= 40);
  const texts = new Set();
  for (const m of MODES) {
    if (m.special || m.k < 5) continue;
    for (const stats of [{}, { devoured: 4 }, { eaten: 3 }, { fusions: 2 }, { ageDeaths: 3, lifeSum: 1300 }, { fell: 1 }]) {
      const sp = { id: m.id, comps: [m.id], ks: [m.k] };
      const t = noteFor(sp, { name: 'X y', peak: 5, stats }, {});
      assert.ok(t.length > 20 && !t.includes('!') && !t.includes('undefined') && !t.includes('NaN'), t);
      texts.add(t);
    }
  }
  assert.ok(texts.size > 60, `only ${texts.size} distinct notes`);
});

test('beside a mended seam the plate quickens gilded (aurata) singers', () => {
  const state = newState();
  // two healed seams along the still cross of mode 1.3+ (u = 0 and v = 0)
  state.plate.cracks = [
    { pts: [[-0.95, 0], [-0.3, 0.004], [0.3, -0.004], [0.95, 0]], gold: [1, 1, 1], healed: true, born: 0 },
    { pts: [[0, -0.95], [0.004, -0.3], [-0.004, 0.3], [0, 0.95]], gold: [1, 1, 1], healed: true, born: 0 },
  ];
  const ev = listen(['mote:birth']);
  const g = makeGame(21, state);
  step(g, 60, '1.3+');
  ev.off();
  const gilded = ev.seen['mote:birth'].filter((b) => b.species.aurata);
  assert.ok(gilded.length >= 1, `no aurata among ${ev.seen['mote:birth'].length} births`);
  assert.ok(gilded[0].species.id.endsWith('*'));
  assert.match(gilded[0].species.name, / aurata$/);
  assert.ok(gilded[0].mote.life >= TUNE.lifeMin * TUNE.aurataLife, 'aurata should outlive plain singers');
  g.life.destroy();
});

test('a landed moth is a small stillness that singers gather round', () => {
  const g = makeGame(22);
  for (let i = 0; i < 5; i++) g.life.spawn('1.3+', 0.1 + i * 0.06, 0.45, 0.8, { silent: true });
  g.moth = { landed: true, u: 0.35, v: 0.3 };
  step(g, 12, '1.3+', 0.5);
  const near = g.life.motes.filter((m) => Math.hypot(m.u - 0.35, m.v - 0.3) < 0.18).length;
  assert.ok(near >= 3, `only ${near} gathered round the moth`);
  g.moth = null;
  g.life.destroy();
});
