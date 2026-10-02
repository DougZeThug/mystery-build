// STUB tools — replaced by the tools module. Minimal edge bowing + tap for integration tests.
import { bowPick } from '../sim/modes.js';
export function createTools(game) {
  let drag = null, mode = null, lastX = 0, lastY = 0, speed = 0;
  const edgeAt = (u, v) => {
    const d = { top: Math.abs(v + 1), bottom: Math.abs(v - 1), left: Math.abs(u + 1), right: Math.abs(u - 1) };
    const e = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
    if (e[1] > 0.12) return null;
    const t = e[0] === 'top' ? (u + 1) / 2 : e[0] === 'right' ? (v + 1) / 2 : e[0] === 'bottom' ? (1 - u) / 2 : (1 - v) / 2;
    return { edge: e[0], t };
  };
  return {
    bow: { held: false, bowing: false },
    reveal() {},
    update(dt) { speed *= Math.exp(-dt * 4); if (!drag) game.field.setSource('bow', []); },
    render() {},
    pointerDown(x, y) { drag = { x, y, t: performance.now() }; lastX = x; lastY = y; return true; },
    pointerMove(x, y) {
      if (!drag) return;
      const dist = Math.hypot(x - lastX, y - lastY); lastX = x; lastY = y;
      speed = speed * 0.8 + 0.2 * Math.min(1, dist / 15);
      const p = game.view.toPlate(x, y); const e = edgeAt(p.u, p.v);
      if (e) { mode = bowPick(e.edge, e.t, speed, mode); game.field.setSource('bow', [{ mode, amp: 0.25 + 0.9 * speed }]); }
    },
    pointerUp() { drag = null; },
    cursor() { return 'default'; },
  };
}
