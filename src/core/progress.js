// What the room reveals, and when. Rare-state orchestration (choir, floor).

export function createProgress(game) {
  const { bus, state } = game;
  state.seen ||= {};
  const st = state.stats;

  const revealed = (w) => !!state.seen['reveal_' + w];
  function reveal(what, instant = false) {
    if (revealed(what) && !instant) return;
    state.seen['reveal_' + what] = true;
    game.tools?.reveal?.(what, instant);
    if (!instant) bus.emit('reveal', { what });
  }

  // restore already-revealed objects silently
  for (const w of ['jar', 'journal', 'drawer', 'dampers', 'forks', 'phonograph']) if (revealed(w)) reveal(w, true);

  let floorTimer = 0;
  let choirOn = false;

  // milestone flags (the notebook unlocks the keeper's pages from these)
  const flag = (f) => { state.seen[f] = true; };
  bus.on('mote:birth', () => flag('firstBirth'));
  bus.on('mote:death', (e) => { if (e.cause === 'age') flag('firstGold'); });
  bus.on('mote:fuse', () => flag('firstFusion'));
  bus.on('plate:crack', () => flag('firstCrack'));
  bus.on('plate:heal', () => flag('firstHeal'));
  bus.on('light', (e) => { if (!e.on) flag('firstDark'); });
  bus.on('life:choir', (e) => { if (e.on) flag('firstChoir'); });

  bus.on('mote:birth', () => { st.births++; });
  bus.on('mote:split', () => { st.splits++; });
  bus.on('mote:fuse', () => { st.fusions++; });
  bus.on('mote:eat', () => { st.devoured++; });
  bus.on('mote:death', (e) => { st.deaths++; if (e.cause === 'fall') st.fell++; });
  bus.on('plate:crack', () => { st.cracks++; });
  bus.on('plate:heal', () => { st.heals++; });
  bus.on('life:choir', (e) => {
    choirOn = !!e.on;
    if (e.on) { st.choirs++; state.seen.choir = true; }
  });
  bus.on('life:floor', (e) => {
    if (!e.on) return;
    floorTimer = 18;
    state.seen.floor = true;
    game.field.setSource('floor', [{ mode: 'floor', amp: 1.2 }]);
  });

  const speciesCount = () => Object.keys(state.species || {}).length;

  // In the dark, with the bow still, the plate dreams: sand drifts into the figures of the extinct.
  let darkFor = 0, dreamIdx = 0, dreamT = 0;
  function dream(dt) {
    const quiet = !game.tools?.bow?.bowing;
    if (!game.light.on && quiet) darkFor += dt; else darkFor = 0;
    if (darkFor < 8) { if (game.field.getSource('dream')) game.field.setSource('dream', []); return; }
    const gone = Object.values(state.species || {}).filter((r) => r.extinct && r.comps?.length);
    if (!gone.length) return;
    dreamT -= dt;
    if (dreamT <= 0) {
      dreamT = 26;
      const rec = gone[dreamIdx++ % gone.length];
      game.field.setSource('dream', rec.comps.map((m) => ({ mode: m, amp: 0.2 / Math.sqrt(rec.comps.length) })));
      if (!state.seen.dreamed) { state.seen.dreamed = true; bus.emit('log', { kind: 'dream', text: 'In the dark the sand moved by itself, into a figure I had not seen in some time.' }); }
    }
  }

  return {
    reveal, revealed,
    update(dt) {
      dream(dt);
      state.playSeconds += dt;
      const pop = game.life?.motes?.length || 0;
      if (pop > st.maxPop) st.maxPop = pop;

      if (!revealed('jar') && (game.field.coherence.stable > 3.5 || state.playSeconds > 100)) reveal('jar');
      if (!revealed('journal') && st.births > 0) reveal('journal');
      if (!revealed('drawer') && (speciesCount() >= 3 || (st.births > 0 && state.playSeconds > 260))) { reveal('drawer'); reveal('dampers'); }
      if (!revealed('forks') && revealed('drawer') && (speciesCount() >= 5 || st.deaths >= 2)) reveal('forks');
      if (!revealed('phonograph') && st.choirs > 0) reveal('phonograph');

      // rare-state visual intensities
      const fx = game.fx;
      fx.choir += ((choirOn ? 1 : 0) - fx.choir) * Math.min(1, dt * 0.6);
      if (floorTimer > 0) {
        floorTimer -= dt;
        fx.floor = Math.min(1, fx.floor + dt * 0.5);
        if (floorTimer <= 0) game.field.setSource('floor', []);
      } else fx.floor = Math.max(0, fx.floor - dt * 0.15);
      fx.shake = Math.max(0, fx.shake - dt * 2);
      fx.flash = Math.max(0, fx.flash - dt * 1.5);
    },
  };
}
