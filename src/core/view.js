// Screen layout: where the plate sits and where the objects rest around it (CSS px).

// insets: the safe area (notches, home indicator) in CSS px; the plate is framed inside it.
export function computeView(vw, vh, dpr, insets = null) {
  const ins = { t: insets?.t || 0, r: insets?.r || 0, b: insets?.b || 0, l: insets?.l || 0 };
  const sw = Math.max(1, vw - ins.l - ins.r), sh = Math.max(1, vh - ins.t - ins.b);
  const mode = sw / sh >= 0.9 ? 'landscape' : 'portrait';
  let size, cx, cy;
  if (mode === 'landscape') {
    size = Math.min(sh * 0.72, sw * 0.5);
    cx = ins.l + sw / 2; cy = ins.t + sh * 0.5;
  } else {
    size = Math.min(sw * 0.86, sh * 0.5);
    cx = ins.l + sw / 2; cy = ins.t + sh * 0.45;
  }
  size = Math.round(size);
  const x = Math.round(cx - size / 2), y = Math.round(cy - size / 2);
  const plate = { x, y, size, cx: x + size / 2, cy: y + size / 2 };
  const unit = size / 2;
  const L = mode === 'landscape';
  const anchors = L ? {
    bow: { x: x + size + size * 0.02, y: y + size * 0.62, angle: -1.2 },
    jar: { x: x - size * 0.34, y: y + size * 0.2 },
    journal: { x: x - size * 0.36, y: y + size * 0.78 },
    drawer: { x: plate.cx - size * 0.42, y: vh - ins.b - Math.max(30, size * 0.06), w: size * 0.84, h: Math.max(30, size * 0.06) },
    // the cord always ends well above the plate; on short screens it hangs beside it instead
    cord: y >= 90 ? { x: plate.cx + size * 0.16, y: 0, len: Math.max(24, Math.min(y * 0.7, y - 46)) }
      : { x: x - Math.max(26, size * 0.12), y: 0, len: Math.max(24, Math.min(y + size * 0.1, 70)) },
    phonograph: { x: x + size + size * 0.34, y: y + size * 0.22 },
  } : {
    bow: { x: plate.cx + size * 0.12, y: y + size + size * 0.07, angle: -0.08 },
    jar: { x: x + size * 0.12, y: Math.max(40, y - size * 0.2) },
    journal: { x: x + size * 0.14, y: y + size + size * 0.3 },
    drawer: { x: plate.cx - size * 0.42, y: vh - ins.b - 30, w: size * 0.84, h: 30 },
    cord: { x: plate.cx + size * 0.3, y: 0, len: Math.max(24, Math.min(y * 0.55, y - 46)) },
    phonograph: { x: x + size * 0.86, y: y + size + size * 0.3 },
  };
  return {
    vw, vh, dpr, mode, plate, unit, anchors, insets: ins,
    toPlate(px, py) { return { u: (px - plate.cx) / unit, v: (py - plate.cy) / unit }; },
    toScreen(u, v) { return { x: plate.cx + u * unit, y: plate.cy + v * unit }; },
  };
}
