// STUB renderer (2D) — replaced by the WebGL2 renderer.
export function createRenderer(canvas, game) {
  const ctx = canvas.getContext('2d');
  return {
    resize() {},
    render() {
      const { dpr, vw, vh, plate } = game.view;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0a0807'; ctx.fillRect(0, 0, vw, vh);
      ctx.globalAlpha = game.light.level;
      ctx.fillStyle = '#8a6534'; ctx.fillRect(plate.x, plate.y, plate.size, plate.size);
      ctx.fillStyle = '#e9dfc8';
      const s = game.sand, u = plate.size / 2;
      for (let i = 0; i < s.n; i++) ctx.fillRect(plate.cx + s.x[i] * u, plate.cy + s.y[i] * u, 1, 1);
      ctx.globalAlpha = 1;
    },
    figureCanvas() { return document.createElement('canvas'); },
  };
}
