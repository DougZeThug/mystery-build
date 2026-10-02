// Screen layout: where the plate sits and where the objects rest around it (CSS px).

export function computeView(vw, vh, dpr) {
  const mode = vw / vh >= 0.9 ? 'landscape' : 'portrait';
  let size, cx, cy;
  if (mode === 'landscape') {
    size = Math.min(vh * 0.72, vw * 0.5);
    cx = vw / 2; cy = vh * 0.5;
  } else {
    size = Math.min(vw * 0.86, vh * 0.5);
    cx = vw / 2; cy = vh * 0.45;
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
    drawer: { x: plate.cx - size * 0.42, y: vh - Math.max(30, size * 0.06), w: size * 0.84, h: Math.max(30, size * 0.06) },
    cord: { x: plate.cx + size * 0.16, y: 0, len: Math.max(60, y * 0.7) },
    phonograph: { x: x + size + size * 0.34, y: y + size * 0.22 },
  } : {
    bow: { x: plate.cx + size * 0.12, y: y + size + size * 0.07, angle: -0.08 },
    jar: { x: x + size * 0.12, y: Math.max(40, y - size * 0.2) },
    journal: { x: x + size * 0.14, y: y + size + size * 0.3 },
    drawer: { x: plate.cx - size * 0.42, y: vh - 30, w: size * 0.84, h: 30 },
    cord: { x: plate.cx + size * 0.3, y: 0, len: Math.max(40, y * 0.55) },
    phonograph: { x: x + size * 0.86, y: y + size + size * 0.3 },
  };
  return {
    vw, vh, dpr, mode, plate, unit, anchors,
    toPlate(px, py) { return { u: (px - plate.cx) / unit, v: (py - plate.cy) / unit }; },
    toScreen(u, v) { return { x: plate.cx + u * unit, y: plate.cy + v * unit }; },
  };
}
