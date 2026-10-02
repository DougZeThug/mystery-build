// The moth: on late evenings (20:00–05:00 local), rarely, a dusty moth finds the lamp. It circles
// the light in loops and sudden darts, and sometimes settles on the plate for a while — a small,
// temporary point of stillness the singers gather round. ?moth in the URL summons it for testing.
import { clamp, clamp01, smooth, TAU, SIDES, bake, bakeShadow, bakeTint, blit, seeded, speckle, toScreenInto } from './tools-art.js';

const MIN_GAP = 360, MAX_GAP = 600;   // seconds between chances (6–10 min)
const CHANCE = 0.55;

export function createMoth(env, forced = false) {
  const { game, lamp } = env;
  const pub = { state: 'away', landed: false, u: 0, v: 0, fd: { u: 0, v: 0, r: 0.05, moth: true } };
  const m = {
    phase: 'away', x: -100, y: -100, z: 0.4, vx: 0, vy: 0, head: 0, flap: 0, flapRate: 13,
    timer: 0, orbitA: 0, orbitR: 0.4, orbitW: 1.6, dart: 0, tx: 0, ty: 0, glow: 0, twitch: 0, fold: 0,
    shake: 0, visits: 0, gilded: false, seed: Math.random() * 100,
  };
  let next = forced ? 4 : MIN_GAP * 0.5 + Math.random() * (MAX_GAP - MIN_GAP);
  let W = 30, spr = null;
  const tmp = { x: 0, y: 0 }, scr = { x: 0, y: 0 };

  function layout() {
    const v = game.view, S = v.plate.size, dpr = v.dpr || 1;
    W = Math.round(clamp(S * 0.075, 22, 48));          // wingspan
    const half = W / 2, rnd = seeded(1926);
    // the right-hand wings (mirrored for the left), root at the origin, span along +x
    const wbox = (draw) => bake(half * 1.15, W * 0.95, 1, W * 0.42, dpr, draw);
    const hind = wbox((g) => {
      // hindwing: rounded fan, paler, mostly hidden at rest
      g.beginPath();
      g.moveTo(0, W * 0.0);
      g.bezierCurveTo(half * 0.4, -W * 0.02, half * 0.86, W * 0.06, half * 0.76, W * 0.2);
      g.bezierCurveTo(half * 0.66, W * 0.32, half * 0.28, W * 0.34, 0, W * 0.16);
      g.closePath();
      const hg = g.createLinearGradient(0, 0, half * 0.8, W * 0.2);
      hg.addColorStop(0, '#8b7a65'); hg.addColorStop(1, '#a79782');
      g.fillStyle = hg; g.fill();
      g.save(); g.clip();
      speckle(g, rnd, 0, -W * 0.05, half, W * 0.45, 140, '#6a5b4a', 0.2, 0.5, 0.4, 0.9);
      g.strokeStyle = 'rgba(80,66,52,0.5)'; g.lineWidth = 0.6;
      g.beginPath(); g.moveTo(half * 0.12, W * 0.26); g.quadraticCurveTo(half * 0.55, W * 0.24, half * 0.7, W * 0.06); g.stroke();
      g.restore();
      g.strokeStyle = 'rgba(205,190,165,0.4)'; g.lineWidth = 0.9; g.setLineDash([0.8, 0.8]);
      g.beginPath(); g.moveTo(half * 0.76, W * 0.2); g.bezierCurveTo(half * 0.66, W * 0.32, half * 0.28, W * 0.34, 0, W * 0.16); g.stroke();
      g.setLineDash([]);
    });
    const fore = wbox((g) => {
      // forewing: long, the leading edge nearly straight, a rounded tip, a scalloped fringe
      const fw = () => {
        g.beginPath();
        g.moveTo(0, -W * 0.03);
        g.bezierCurveTo(half * 0.4, -W * 0.16, half * 0.85, -W * 0.25, half * 1.05, -W * 0.2);
        g.bezierCurveTo(half * 1.12, -W * 0.14, half * 1.0, W * 0.05, half * 0.78, W * 0.12);
        g.bezierCurveTo(half * 0.5, W * 0.17, half * 0.2, W * 0.12, 0, W * 0.06);
        g.closePath();
      };
      fw();
      const fg = g.createLinearGradient(0, 0, half, 0);
      fg.addColorStop(0, '#7b6a55'); fg.addColorStop(0.55, '#8f7e67'); fg.addColorStop(1, '#6b5b49');
      g.fillStyle = fg; g.fill();
      g.save(); fw(); g.clip();
      speckle(g, rnd, 0, -W * 0.3, half * 1.1, W * 0.5, 320, '#4d4033', 0.2, 0.55, 0.4, 1);
      speckle(g, rnd, 0, -W * 0.3, half * 1.1, W * 0.5, 160, '#c4b49a', 0.15, 0.4, 0.4, 0.9);
      g.strokeStyle = 'rgba(55,44,34,0.75)'; g.lineWidth = 0.8;
      for (const xf of [0.36, 0.66]) {
        g.beginPath();
        for (let i = 0; i <= 8; i++) {
          const t = i / 8, yy = -W * 0.2 + t * W * 0.33, xx = half * (xf + 0.05 * Math.sin(t * 9 + xf * 7) - t * 0.06);
          g[i ? 'lineTo' : 'moveTo'](xx, yy);
        }
        g.stroke();
      }
      g.beginPath(); g.ellipse(half * 0.52, -W * 0.06, half * 0.06, W * 0.035, 0.3, 0, TAU);
      g.fillStyle = 'rgba(50,40,30,0.7)'; g.fill();
      g.strokeStyle = 'rgba(200,185,160,0.5)'; g.lineWidth = 0.5; g.stroke();
      g.strokeStyle = 'rgba(205,190,165,0.55)'; g.lineWidth = 1.1; g.setLineDash([0.9, 0.9]);
      g.beginPath(); g.moveTo(half * 1.05, -W * 0.2); g.bezierCurveTo(half * 1.12, -W * 0.14, half * 1.0, W * 0.05, half * 0.78, W * 0.12); g.stroke();
      g.setLineDash([]);
      g.restore();
      fw(); g.strokeStyle = 'rgba(40,32,24,0.55)'; g.lineWidth = 0.5; g.stroke();
    });
    const wing = wbox((g) => { g.drawImage(hind.cv, -1, -W * 0.42, half * 1.15, W * 0.95); g.drawImage(fore.cv, -1, -W * 0.42, half * 1.15, W * 0.95); });
    const body = bake(W * 0.5, W * 0.8, W * 0.25, W * 0.3, dpr, (g) => {
      // abdomen: tapered, ringed
      g.beginPath(); g.ellipse(0, W * 0.2, W * 0.055, W * 0.2, 0, 0, TAU);
      g.fillStyle = '#6d5e4c'; g.fill();
      g.strokeStyle = 'rgba(40,32,24,0.6)'; g.lineWidth = 0.6;
      for (let i = 1; i < 6; i++) { const yy = W * (0.06 + i * 0.05); g.beginPath(); g.moveTo(-W * 0.045, yy); g.quadraticCurveTo(0, yy + 1, W * 0.045, yy); g.stroke(); }
      // fuzzy thorax
      for (let i = 0; i < 80; i++) {
        const a = rnd() * TAU, r = rnd() * W * 0.085;
        g.fillStyle = rnd() < 0.5 ? '#8c7b66' : '#5a4c3c'; g.globalAlpha = 0.6;
        g.fillRect(Math.cos(a) * r, Math.sin(a) * r * 1.2, 1, 1);
      }
      g.globalAlpha = 1;
      g.beginPath(); g.ellipse(0, 0, W * 0.07, W * 0.085, 0, 0, TAU); g.fillStyle = '#7d6c58'; g.fill();
      g.beginPath(); g.ellipse(0, -W * 0.1, W * 0.045, W * 0.035, 0, 0, TAU); g.fillStyle = '#5c4d3d'; g.fill();
      // feathered antennae
      g.strokeStyle = '#4d4033'; g.lineWidth = 0.6; g.lineCap = 'round';
      for (const s of [-1, 1]) {
        g.beginPath(); g.moveTo(s * W * 0.02, -W * 0.12); g.quadraticCurveTo(s * W * 0.08, -W * 0.22, s * W * 0.15, -W * 0.27); g.stroke();
        for (let i = 1; i < 6; i++) {
          const t = i / 6, ax = s * W * (0.02 + 0.13 * t), ay = -W * (0.12 + 0.15 * t);
          g.beginPath(); g.moveTo(ax, ay); g.lineTo(ax + s * W * 0.02, ay + W * 0.012); g.moveTo(ax, ay); g.lineTo(ax - s * W * 0.012, ay - W * 0.02); g.stroke();
        }
      }
    });
    const glow = bake(W * 3, W * 3, W * 1.5, W * 1.5, dpr, (g) => {
      const rg = g.createRadialGradient(0, 0, 0, 0, 0, W * 1.4);
      rg.addColorStop(0, 'rgba(255,214,140,0.8)'); rg.addColorStop(0.3, 'rgba(255,200,120,0.3)'); rg.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = rg; g.fillRect(-W * 1.5, -W * 1.5, W * 3, W * 3);
    });
    spr = { hind, fore, hindDark: bakeTint(hind, '#0d0a08'), foreDark: bakeTint(fore, '#0d0a08'), wingSh: bakeShadow(wing, Math.max(2, W * 0.08)),
      body, bodyDark: bakeTint(body, '#0d0a08'), bodySh: bakeShadow(body, Math.max(2, W * 0.08)), glow };
  }

  const isNight = () => { const h = new Date().getHours(); return h >= 20 || h < 5; };

  function emit(state) {
    pub.state = state;
    env.emit('moth', { state, u: pub.u, v: pub.v });
  }

  function summon() {
    const v = game.view;
    const side = Math.floor(Math.random() * 4);
    m.x = side === 0 ? -W : side === 1 ? v.vw + W : Math.random() * v.vw;
    m.y = side < 2 ? Math.random() * v.vh * 0.6 : side === 2 ? -W : v.vh + W;
    m.z = 0.5; m.vx = m.vy = 0; m.phase = 'arrive'; m.timer = 0;
    m.orbitA = Math.atan2(m.y - lamp.y, m.x - lamp.x);
    m.orbitW = (Math.random() < 0.5 ? -1 : 1) * (1.3 + Math.random() * 0.9);
    m.gilded = false; m.visits++;
    pub.landed = false;
    emit('arrive');
  }

  function chooseSpot() {
    let best = null, bs = 1e9;
    const f = game.field;
    for (let i = 0; i < 10; i++) {
      const u = (Math.random() * 2 - 1) * 0.7, v = (Math.random() * 2 - 1) * 0.7;
      if (Math.hypot(u, v) < 0.24) continue;
      let ok = true;
      for (const d of f?.dampers || []) if (d !== pub.fd && Math.hypot(d.u - u, d.v - v) < 0.18) ok = false;
      if (!ok) continue;
      const s = (f?.stillnessAt ? f.stillnessAt(u, v) : 0) + Math.random() * 0.02;
      if (s < bs) { bs = s; best = { u, v }; }
    }
    return best || { u: 0.45, v: -0.4 };
  }

  function takeOff() {
    if (m.phase !== 'landed') return;
    m.phase = 'circle'; m.timer = -(2 + Math.random() * 3);
    m.vx = (Math.random() - 0.5) * 120; m.vy = -60 - Math.random() * 60;
    pub.landed = false;
    env.syncDampers();
    // a moth that rested in the choir's light leaves a little gold behind
    if (m.glow > 0.3 && !m.gilded && game.sand?.drop) { m.gilded = true; game.sand.drop(pub.u, pub.v, 9, 1, 0.03); }
    emit('leave');
    m.leaving = true;
  }

  function startle() {
    if (m.phase === 'landed') takeOff();
    else if (m.phase === 'circle' || m.phase === 'approach') { m.dart = 1; m.vx += (Math.random() - 0.5) * 400; m.vy += (Math.random() - 0.5) * 400; if (m.phase === 'approach') { m.phase = 'circle'; m.timer = 0; } }
  }

  // a tap near the resting moth sends it off
  function disturb(u, v, r) {
    if (m.phase === 'landed' && Math.hypot(u - pub.u, v - pub.v) < r) takeOff();
  }

  function update(dt) {
    const v = game.view;
    if (!v || !spr) return;
    const S = v.plate.size;
    if (m.phase === 'away') {
      next -= dt;
      if (next <= 0) {
        next = forced ? 40 + Math.random() * 30 : MIN_GAP + Math.random() * (MAX_GAP - MIN_GAP);
        if (game.light?.on !== false && (forced || (isNight() && Math.random() < CHANCE))) summon();
      }
      return;
    }
    m.timer += dt;
    const night = game.light?.on !== false;
    m.flap += dt * m.flapRate * (env.reduced ? 0.4 : 1) * TAU;
    m.flapRate += ((m.phase === 'landed' ? 0 : 11 + 5 * Math.sin(m.timer * 1.7 + m.seed)) - m.flapRate) * Math.min(1, dt * 4);
    m.glow += (((game.fx?.choir || 0) > 0.5 && m.phase === 'landed' ? 1 : 0) - m.glow) * Math.min(1, dt * 0.8);

    if (m.phase === 'arrive' || m.phase === 'circle') {
      // loops around the lamp, the radius breathing, sometimes a dart at the bulb
      const jit = env.reduced ? 0.3 : 1;
      m.orbitA += m.orbitW * dt * (0.8 + 0.4 * Math.sin(m.timer * 0.9 + m.seed));
      if (Math.random() < dt * 0.25 * jit) m.orbitW *= -1;
      if (Math.random() < dt * 0.18 * jit) m.dart = 1;
      m.dart = Math.max(0, m.dart - dt * 1.2);
      const R = S * (0.38 + 0.18 * Math.sin(m.timer * 0.6 + m.seed) - 0.3 * smooth(0.2, 1, m.dart));
      m.tx = lamp.x + Math.cos(m.orbitA) * R + Math.sin(m.timer * 3.1 + m.seed) * S * 0.04 * jit;
      m.ty = lamp.y + Math.sin(m.orbitA) * R * 0.75 + Math.cos(m.timer * 2.3 + m.seed) * S * 0.04 * jit;
      if (m.leaving || !night) {
        m.tx = m.x + (m.x - lamp.x) * 4; m.ty = m.y + (m.y - lamp.y) * 4 - S;
        if (m.x < -W * 2 || m.x > v.vw + W * 2 || m.y < -W * 2 || m.y > v.vh + W * 2) {
          m.phase = 'away'; m.leaving = false; pub.state = 'away'; pub.landed = false;
          return;
        }
        if (!m.leaving) { m.leaving = true; emit('leave'); }
      }
      const zT = 0.35 + 0.12 * Math.sin(m.timer * 1.3) - 0.15 * m.dart;
      m.z += (zT - m.z) * Math.min(1, dt * 2);
      if (m.phase === 'arrive' && m.timer > 2.5) { m.phase = 'circle'; m.timer = 0; }
      // after a while, perhaps settle on the plate
      if (m.phase === 'circle' && !m.leaving && m.timer > 9 + (m.seed % 8)) {
        if (Math.random() < 0.7) { const s = chooseSpot(); pub.u = s.u; pub.v = s.v; m.phase = 'approach'; m.timer = 0; }
        else { m.leaving = true; emit('leave'); }
      }
    } else if (m.phase === 'approach') {
      const p = toScreenInto(v, pub.u, pub.v, scr);
      m.tx = p.x + Math.sin(m.timer * 5) * S * 0.02 * (1 - smooth(0.5, 2, m.timer));
      m.ty = p.y + Math.cos(m.timer * 4) * S * 0.02 * (1 - smooth(0.5, 2, m.timer));
      m.z += (0 - m.z) * Math.min(1, dt * 1.6);
      if (m.timer > 1.6 && Math.hypot(m.x - p.x, m.y - p.y) < 3 && m.z < 0.03) {
        m.phase = 'landed'; m.timer = 0; m.z = 0; m.vx = m.vy = 0;
        m.stay = 10 + Math.random() * 20;
        pub.landed = true; pub.fd.u = pub.u; pub.fd.v = pub.v;
        env.syncDampers();
        emit('land');
      }
      if (!night) startle();
    } else if (m.phase === 'landed') {
      const p = toScreenInto(v, pub.u, pub.v, scr);
      m.x = p.x; m.y = p.y;
      // twitches now and then; startled by violence in the bronze or by the dark
      if (Math.random() < dt * 0.3) m.twitch = 1;
      m.twitch = Math.max(0, m.twitch - dt * 3);
      const tot = game.field?.total || 0;
      m.shake = tot > 0.95 ? m.shake + dt : Math.max(0, m.shake - dt);
      if (m.timer > m.stay || m.shake > 0.6 || !night) takeOff();
      return;
    }

    // steering: a fluttering chase of the target point
    const k = m.phase === 'approach' ? 5 : 3.2;
    const ax = (m.tx - m.x) * k * k * 0.25 - m.vx * 1.6 + (env.reduced ? 0 : Math.sin(m.timer * 17 + m.seed) * 220);
    const ay = (m.ty - m.y) * k * k * 0.25 - m.vy * 1.6 + (env.reduced ? 0 : Math.cos(m.timer * 13 + m.seed * 2) * 220);
    m.vx += ax * dt; m.vy += ay * dt;
    const sp = Math.hypot(m.vx, m.vy), max = S * (m.phase === 'approach' ? 0.6 : 1.1);
    if (sp > max) { m.vx *= max / sp; m.vy *= max / sp; }
    m.x += m.vx * dt; m.y += m.vy * dt;
    if (sp > 8) {
      const h = Math.atan2(m.vy, m.vx) + Math.PI / 2;
      let d = h - m.head; d = Math.atan2(Math.sin(d), Math.cos(d));
      m.head += d * Math.min(1, dt * 6);
    }
  }

  function drawMoth(ctx, lamp, flying) {
    const S = game.view.plate.size;
    const f = clamp01(lamp.at(m.x, m.y) * (1 + m.z * 0.8));
    const sc = 1 + m.z * 0.5;
    // shadow: far below a flying moth it is large, soft and pale
    const h = m.z * lamp.z * 0.6;
    lamp.offset(m.x, m.y, h, tmp);
    const sa = lamp.shadowAt(m.x + tmp.x, m.y + tmp.y) * (flying ? 0.28 : 0.6) * (1 - m.z * 0.5);
    const shs = (1 + h / Math.max(1, lamp.z - h)) * sc;
    const span = flying ? 0.25 + 0.75 * Math.abs(Math.cos(m.flap)) : 1;
    const sweep = flying ? 0.25 * Math.sin(m.flap) : 0.95;
    ctx.save();
    ctx.translate(m.x + tmp.x, m.y + tmp.y);
    ctx.rotate(m.head);
    for (let i = 0; i < 2; i++) {
      const side = SIDES[i];
      ctx.save();
      ctx.rotate(side * sweep);
      ctx.scale(side * span * shs, shs);
      blit(ctx, spr.wingSh, sa);
      ctx.restore();
    }
    ctx.save(); ctx.scale(shs, shs); blit(ctx, spr.bodySh, sa); ctx.restore();
    ctx.restore();

    ctx.save();
    ctx.translate(m.x, m.y);
    ctx.rotate(m.head);
    if (m.glow > 0.02) { ctx.globalCompositeOperation = 'lighter'; blit(ctx, spr.glow, m.glow * (0.5 + 0.1 * Math.sin(game.t * 2))); ctx.globalCompositeOperation = 'source-over'; }
    // hindwings, then forewings over them, then the body over their roots. At rest the forewings
    // sweep back into a delta that hides the hindwings.
    const sweepF = flying ? 0.25 * Math.sin(m.flap) : 0.95 + m.twitch * 0.15 * Math.sin(game.t * 40);
    const sweepH = flying ? sweepF * 0.8 - 0.12 : 0.6;
    for (let pass = 0; pass < 2; pass++) {
      const wing = pass ? spr.fore : spr.hind, dark = pass ? spr.foreDark : spr.hindDark, sw = pass ? sweepF : sweepH;
      for (let i = 0; i < 2; i++) {
        const side = SIDES[i];
        ctx.save();
        ctx.rotate(side * sw);
        ctx.scale(side * span * sc, sc);
        if (f < 0.985) blit(ctx, dark, 1);
        blit(ctx, wing, f);
        ctx.restore();
      }
    }
    ctx.scale(sc, sc);
    if (f < 0.985) blit(ctx, spr.bodyDark, 1);
    blit(ctx, spr.body, f);
    ctx.restore();
  }

  return {
    pub, layout, update, summon, startle, disturb,
    hit(x, y, touch) {
      if (m.phase === 'away') return false;
      return Math.hypot(x - m.x, y - m.y) < W * 0.5 * (1 + m.z * 0.5) + (touch ? 12 : 4);
    },
    drawLanded(ctx, lamp) { if (spr && m.phase === 'landed') drawMoth(ctx, lamp, false); },
    drawFlying(ctx, lamp) { if (spr && m.phase !== 'away' && m.phase !== 'landed') drawMoth(ctx, lamp, true); },
    get phase() { return m.phase; },
    state: m,
  };
}
