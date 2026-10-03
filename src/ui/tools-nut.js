// The clamp at the centre of the plate. Press and hold it and the plate is driven from its stem:
// a steady note that holds its figure for as long as the hand stays. Turning the hand round the
// nut (or drawing it up and down) tunes the note through the plate's figures; let it rest and it
// settles on the nearest clean one.
import { MODES } from '../sim/modes.js';
import { clamp, TAU } from './tools-art.js';

// one voice per harmonic number, low to high (the '+' figure where there is a choice)
const SEQ = (() => {
  const byK = new Map();
  for (const m of MODES) {
    if (!m.bowable) continue;
    const cur = byK.get(m.k);
    if (!cur || (m.s > 0 && cur.s < 0)) byK.set(m.k, m);
  }
  return [...byK.values()].sort((a, b) => a.k - b.k).map((m) => m.id);
})();
const PER_TURN = 6;        // figures passed in one full turn of the hand round the nut
const AMP = 0.58;

export function createNut(env) {
  const { game } = env;
  const st = game.state.tools || (game.state.tools = {});
  let pos = Number.isFinite(st.nutPos) ? clamp(st.nutPos, 0, SEQ.length - 1) : 1;   // starts on the k=8 figure
  let held = -1;             // pointer id holding it
  let amp = 0, still = 0, lastAng = null, lastY = 0, glow = 0, spin = 0;
  const comps = [{ mode: null, amp: 0 }, { mode: null, amp: 0 }];
  const one = [comps[0]];

  const radiusPx = () => Math.max(15, game.view.unit * 0.09);

  function hit(x, y) {
    const pl = game.view.plate;
    return Math.hypot(x - pl.cx, y - pl.cy) <= radiusPx();
  }

  function press(id, x, y) {
    held = id; still = 0; lastAng = null; lastY = y;
    st.nutUsed = true;
    env.emit('sfx', { name: 'tick', soft: true });
  }

  function move(x, y) {
    if (held < 0) return;
    const pl = game.view.plate;
    const dx = x - pl.cx, dy = y - pl.cy, r = Math.hypot(dx, dy);
    let d = 0;
    if (r > radiusPx() * 1.4) {
      // turning round the nut: clockwise is upward in pitch
      const a = Math.atan2(dy, dx);
      if (lastAng !== null) {
        let da = a - lastAng;
        if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
        d = (da / TAU) * PER_TURN;
      }
      lastAng = a;
    } else {
      lastAng = null;
      d = -(y - lastY) / Math.max(30, game.view.unit * 0.22);
    }
    lastY = y;
    if (Math.abs(d) > 1e-4) { pos = clamp(pos + d, 0, SEQ.length - 1); still = 0; }
  }

  function release() {
    if (held < 0) return;
    held = -1; lastAng = null;
    st.nutPos = Math.round(pos);
  }

  function update(dt) {
    still += dt;
    // left alone for a moment, the tuning settles onto the nearest clean figure
    if (still > 0.35) pos += (Math.round(pos) - pos) * (1 - Math.exp(-dt / 0.25));
    const target = held >= 0 ? AMP : 0;
    amp += (target - amp) * (1 - Math.exp(-dt / (held >= 0 ? 0.25 : 1.2)));
    glow += ((held >= 0 ? 1 : 0) - glow) * (1 - Math.exp(-dt / 0.2));
    spin += ((pos / PER_TURN) * TAU - spin) * (1 - Math.exp(-dt / 0.08));
    if (amp < 0.004) { if (game.field?.getSource?.('drive')) game.field.setSource('drive', []); return; }
    const i0 = Math.floor(pos), f = pos - i0;
    if (f < 0.02 || i0 >= SEQ.length - 1) {
      comps[0].mode = SEQ[Math.min(SEQ.length - 1, Math.round(pos))]; comps[0].amp = amp;
      game.field?.setSource?.('drive', one);
    } else {
      // between two figures the plate sings both, and the sand morphs from one into the other
      comps[0].mode = SEQ[i0]; comps[0].amp = amp * Math.cos(f * Math.PI / 2);
      comps[1].mode = SEQ[i0 + 1]; comps[1].amp = amp * Math.sin(f * Math.PI / 2);
      game.field?.setSource?.('drive', comps);
    }
  }

  // a warm press-ring on the nut, and a notch that turns with the tuning
  function draw(ctx, lamp) {
    const hover = env.hoverNut?.() ? 1 : 0;
    const k = Math.max(glow, hover * 0.35);
    if (k < 0.01) return;
    const pl = game.view.plate, r = radiusPx() * 0.72;
    const li = 0.35 + 0.65 * (lamp?.intensity ?? 1);
    ctx.save();
    ctx.translate(pl.cx, pl.cy);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r * 2.4);
    g.addColorStop(0, `rgba(255, 210, 140, ${0.22 * k * li})`);
    g.addColorStop(1, 'rgba(255, 200, 120, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r * 2.4, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.rotate(spin);
    ctx.strokeStyle = `rgba(255, 228, 180, ${0.55 * k * li})`;
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(0, 0, r * 1.25, -0.35, 0.35); ctx.stroke();
    ctx.fillStyle = `rgba(255, 236, 200, ${0.8 * k * li})`;
    ctx.beginPath(); ctx.arc(r * 1.25, 0, 1.6, 0, TAU); ctx.fill();
    ctx.restore();
  }

  return {
    hit, press, move, release, update, draw,
    get held() { return held; },
    get mode() { return amp > 0.004 ? SEQ[Math.round(pos)] : null; },
  };
}
