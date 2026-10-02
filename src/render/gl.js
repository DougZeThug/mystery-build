// WebGL2 renderer: a black room, one warm spotlight, bronze, sand, and the singers.
//
// Passes per frame (all sizes in device pixels):
//   light map   256², plate space: the singers' glow falling on the bronze (additive quads)
//   scene       full res (RGBA16F when renderable): felt, spotlight, plate, sand, cracks,
//               engravings, the nut — one fullscreen triangle
//   singers     instanced quads into the scene: shadow + feet (alpha), then glow (additive)
//   dust        procedural points in the beam (additive)
//   bloom       bright pass at 1/4, blur; 1/8, blur
//   composite   bloom + beam rays + grade + tonemap + vignette + grain → canvas
// Static surfaces (bronze micro-texture, felt fibres) are baked once into textures. Dynamic data
// (field grid, sand density, wear, cracks) is uploaded only when its version changes.
// No allocation in the hot path. Falls back to a Canvas2D rendition if WebGL2 is unavailable.
import { MODES, modeById, evalMode } from '../sim/modes.js';
import { colourFor } from '../sim/naming.js';
import * as keeper from '../ui/keeper.js';
import * as SH from './shaders.js';

const LM_SIZE = 256;          // singer light map (plate space)
const LM_EXT = 1.25;          // ... covering plate units [-1.25, 1.25]
const DUST_N = 150;
const MAX_SINGERS = 64;

// Canonical singer state codes and flag bits as the shaders read them. life.js owns the real
// encoding (STATES / FLAG); instance data is remapped to these names every frame, so a reordered
// or extended list on the life side cannot scramble the look.
const CANON_STATES = ['walk', 'feed', 'split', 'fuse', 'eat', 'startle', 'sleep', 'nestle', 'fall', 'die', 'born', 'cling'];
const CANON_FLAGS = { aurata: 1, sleep: 2, flash: 4, nestle: 8, float: 16, lunge: 32, keeper: 64, gold: 128 };

const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const num = (x, d = 0) => (Number.isFinite(x) ? x : d);

// Colour of each mode for the singers' figures, indexed n*8 + m (+64 for s < 0).
function modeColourTable() {
  const tab = new Float32Array(128 * 3);
  const fallback = [[1.0, 0.94, 0.82], [0.66, 0.92, 1.0], [1.0, 0.72, 0.76]];
  for (let i = 0; i < 128; i++) tab.set(fallback[i % 3], i * 3);
  for (const m of MODES) {
    let c = null;
    try { c = colourFor(m.id, false); } catch { c = null; }
    if (!Array.isArray(c) || c.length < 3 || !c.every(Number.isFinite)) c = fallback[m.k % 3];
    const idx = m.special ? 0 : m.n * 8 + m.m + (m.s < 0 ? 64 : 0);
    tab[idx * 3] = c[0]; tab[idx * 3 + 1] = c[1]; tab[idx * 3 + 2] = c[2];
  }
  return tab;
}

export function createRenderer(canvas, game) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
  } catch { gl = null; }

  const engr = { lines: null, floor: null, fontReady: false };
  const api = {
    kind: 'webgl2',
    resize() {}, render() {},
    figureCanvas: (comps, px) => figureCanvas(comps, px),
    // Override the engraving texts (harnesses); null = use keeper.js.
    setEngravings(lines, floor) { engr.lines = lines || null; engr.floor = floor || null; engravingsDirty = true; },
    info() { return info; },
    debug(n) { debugMode = n | 0; },
    // The spotlight as the renderer draws it (CSS px), for overlays that want to sit in the same
    // light: lamp position/height, the aim point of the beam, and pool(x, y) -> 0..1 falloff.
    lamp: { x: 0, y: 0, z: 1, aimX: 0, aimY: 0, size: 1, poolR: 1 },
    pool(x, y) {
      const L = api.lamp;
      const d = Math.hypot(x - L.aimX, y - L.aimY) / Math.max(1, L.size);
      return (0.76 * Math.exp(-d * d * 5.4) + 0.24 * Math.exp(-d * d * 1.75)) * (1 - smooth(0.8, 1.38, d));
    },
  };
  let debugMode = 0;
  let engravingsDirty = true;
  const info = { hdr: false, matSize: 0, ckSize: 0, frames: 0, ms: 0, scale: 1 };

  if (!gl) return createFallback(canvas, game, api);
  try {
    setup();
  } catch (e) {
    console.error('[gfx] WebGL2 setup failed, using Canvas2D', e);
    return createFallback(canvas, game, api, true);
  }
  return api;

  // =============================================================================================
  function setup() {
    const P = {};               // programs
    const T = {};               // textures
    const R = {};               // render targets
    let vaoEmpty = null, vaoSing = null, instBuf = null, instCap = 0;
    let lost = false;
    let W = 0, H = 0, matSize = 0, ckSize = 0, enSize = 0;
    // internal resolution of the scene (bloom follows); drops a step if the GPU cannot keep up
    let scale = 1, sceneW = 0, sceneH = 0, lastNow = 0, frameEma = 16.7, slowFor = 0, fastFor = 0;
    let hdrFmt = null;
    let aniso = null;
    const modeCols = modeColourTable();

    // dynamic data bookkeeping
    let fieldVer = -1, fieldG = 0, sandVer = -1, sandD = 0, wearVer = -1;
    const ckBox = [0, 0, -1, -1], ckBB = [0, 0, -1, -1];
    let ckSig = NaN, ckAt = -1, ckBuf = null, ckDist = null, ckW = null, ckGold = null, ckHeal = null;
    let engrOn = 0, floorEngr = 0, lastT = 0, phonoK = 0;
    let fontsAsked = false, keeperSig = '', keeperAt = -10;
    // singer instances, remapped to the canonical codes (see CANON_STATES / CANON_FLAGS)
    let instLocal = new Float32Array(MAX_SINGERS * 16);
    const stateMap = new Float32Array(32);
    const flagMap = new Float32Array(16);           // life bit index -> canonical bit value
    let mapStates = null, mapFlags = null;
    const dampArr = new Float32Array(24);

    function buildMaps(life) {
      const S = life && Array.isArray(life.STATES) ? life.STATES : null;
      if (S !== mapStates) {
        mapStates = S;
        for (let i = 0; i < 32; i++) {
          const name = S ? S[i] : CANON_STATES[i];
          const c = CANON_STATES.indexOf(name);
          stateMap[i] = c >= 0 ? c : (S ? 0 : i);
        }
      }
      const F = life && life.FLAG && typeof life.FLAG === 'object' ? life.FLAG : null;
      if (F !== mapFlags) {
        mapFlags = F;
        for (let b = 0; b < 16; b++) flagMap[b] = F ? 0 : (b < 8 ? 1 << b : 0);
        if (F) {
          for (const [name, val] of Object.entries(F)) {
            const v = val | 0;
            if (!(v > 0) || (v & (v - 1))) continue;          // single bits only
            const b = Math.round(Math.log2(v));
            if (b >= 16) continue;
            let c = CANON_FLAGS[name] || 0;
            if (!c && /keeper/i.test(name)) c = 64;
            else if (!c && /gold|crumble|agedeath|death/i.test(name)) c = 128;
            flagMap[b] = c;                               // unknown names (e.g. 'old') are dropped
          }
        }
      }
    }
    function remapInstances(src, count, life) {
      buildMaps(life);
      if (instLocal.length < count * 16) instLocal = new Float32Array(count * 16);
      const dst = instLocal;
      for (let i = 0; i < count; i++) {
        const o = i * 16;
        for (let k = 0; k < 16; k++) dst[o + k] = src[o + k];
        const st = num(src[o + 5]);
        const code = Math.max(0, Math.min(31, Math.floor(st + 1e-4)));
        dst[o + 5] = stateMap[code] + Math.min(0.99, Math.max(0, st - code));
        const fl = num(src[o + 15]) | 0;
        let out = 0;
        for (let b = 0; b < 16; b++) if (fl & (1 << b)) out |= flagMap[b];
        dst[o + 15] = out;
      }
      return dst;
    }

    function init() {
      lost = false;
      if (gl.getExtension('EXT_color_buffer_float')) hdrFmt = { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT };
      aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      gl.getExtension('OES_texture_float_linear');

      P.bakePlate = program(SH.VS_FULL, SH.FS_BAKE_PLATE, 'bakePlate');
      P.bakeFelt = program(SH.VS_FULL, SH.FS_BAKE_FELT, 'bakeFelt');
      P.scene = program(SH.VS_FULL, SH.FS_SCENE, 'scene');
      P.singer = program(SH.VS_SINGER, SH.FS_SINGER, 'singer');
      P.dust = program(SH.VS_DUST, SH.FS_DUST, 'dust');
      P.bright = program(SH.VS_FULL, SH.FS_BRIGHT, 'bright');
      P.blur = program(SH.VS_FULL, SH.FS_BLUR, 'blur');
      P.down = program(SH.VS_FULL, SH.FS_DOWN, 'down');
      P.comp = program(SH.VS_FULL, SH.FS_COMPOSITE, 'composite');

      gl.useProgram(P.scene.p);
      ['tMatA', 'tMatB', 'tFelt', 'tField', 'tSand', 'tWear', 'tCrack', 'tEngr', 'tLight']
        .forEach((n, i) => gl.uniform1i(P.scene.u[n], i));
      gl.useProgram(P.singer.p);
      gl.uniform3fv(P.singer.u.uModeCol, modeCols);
      gl.useProgram(P.comp.p);
      gl.uniform1i(P.comp.u.tScene, 0); gl.uniform1i(P.comp.u.tBloomA, 1); gl.uniform1i(P.comp.u.tBloomB, 2);
      for (const p of [P.bright, P.blur, P.down]) { gl.useProgram(p.p); gl.uniform1i(p.u.tSrc, 0); }

      vaoEmpty = gl.createVertexArray();
      // singers: a unit quad + one instance stream of 16 floats
      vaoSing = gl.createVertexArray();
      gl.bindVertexArray(vaoSing);
      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      instBuf = gl.createBuffer();
      instCap = MAX_SINGERS;
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, instCap * 64, gl.DYNAMIC_DRAW);
      for (let a = 0; a < 4; a++) {
        gl.enableVertexAttribArray(1 + a);
        gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, 64, a * 16);
        gl.vertexAttribDivisor(1 + a, 1);
      }
      gl.bindVertexArray(null);

      // placeholder textures until real data arrives
      T.field = tex(1, 1, gl.R16F, gl.RED, gl.FLOAT, new Float32Array(1));
      T.sand = tex(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      T.wear = tex(game.WEAR || 128, game.WEAR || 128, gl.R8, gl.RED, gl.UNSIGNED_BYTE, null);
      T.felt = null; T.matA = null; T.matB = null; T.crack = null; T.engr = null;
      fieldVer = -1; fieldG = 0; sandVer = -1; sandD = 0; wearVer = -1; ckSig = NaN; engravingsDirty = true;
      W = 0; H = 0; sceneW = 0; sceneH = 0; matSize = 0; ckSize = 0; enSize = 0;

      R.lm = target(LM_SIZE, LM_SIZE, hdrFmt);
      bakeFelt();
      resize();
    }

    // ---- GL helpers -----------------------------------------------------------------------------
    function shader(type, src, name) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        const log = gl.getShaderInfoLog(s) || '';
        const lines = String(src).split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`);
        const m = /0:(\d+)/.exec(log);
        const at = m ? +m[1] : 0;
        throw new Error(`${name} shader: ${log}\n${lines.slice(Math.max(0, at - 4), at + 2).join('\n')}`);
      }
      return s;
    }
    function program(vs, fs, name) {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs, name + '.vs'));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs, name + '.fs'));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(`${name} link: ${gl.getProgramInfoLog(p)}`);
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) {
        const a = gl.getActiveUniform(p, i);
        if (a) u[a.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, a.name);
      }
      return { p, u };
    }
    function tex(w, h, internal, format, type, data, { filter = gl.LINEAR, wrap = gl.CLAMP_TO_EDGE } = {}) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      return t;
    }
    function target(w, h, fmt) {
      const f = fmt || { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
      const t = tex(w, h, f.internal, f.format, f.type, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok) {
        gl.deleteFramebuffer(fb); gl.deleteTexture(t);
        if (fmt) { hdrFmt = null; return target(w, h, null); }     // half float not renderable here
        throw new Error('framebuffer incomplete');
      }
      return { tex: t, fb, w, h };
    }
    function freeTarget(t) { if (t) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.tex); } }
    function bind(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
    function drawFull(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
      gl.viewport(0, 0, t ? t.w : W, t ? t.h : H);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---- bakes ----------------------------------------------------------------------------------
    function bakeFelt() {
      const S = 512;
      if (T.felt) gl.deleteTexture(T.felt);
      T.felt = tex(S, S, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, { filter: gl.LINEAR_MIPMAP_LINEAR, wrap: gl.REPEAT });
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.felt, 0);
      gl.disable(gl.BLEND);
      gl.useProgram(P.bakeFelt.p);
      gl.viewport(0, 0, S, S);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.bindTexture(gl.TEXTURE_2D, T.felt);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    function bakePlate(S) {
      for (const k of ['matA', 'matB']) if (T[k]) gl.deleteTexture(T[k]);
      const opts = { filter: gl.LINEAR_MIPMAP_LINEAR };
      T.matA = tex(S, S, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, opts);
      T.matB = tex(S, S, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, opts);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, T.matA, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, T.matB, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.disable(gl.BLEND);
      gl.useProgram(P.bakePlate.p);
      gl.uniform1f(P.bakePlate.u.uTpu, S / 2);
      gl.uniform1f(P.bakePlate.u.uSeed, 3.7);
      gl.viewport(0, 0, S, S);
      gl.bindVertexArray(vaoEmpty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      for (const k of ['matA', 'matB']) {
        gl.bindTexture(gl.TEXTURE_2D, T[k]);
        gl.generateMipmap(gl.TEXTURE_2D);
        if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));
      }
    }

    // ---- resize -----------------------------------------------------------------------------------
    function resize() {
      if (lost) return;
      const v = game.view;
      W = Math.max(1, canvas.width | 0); H = Math.max(1, canvas.height | 0);
      const sw = Math.max(1, Math.round(W * scale)), sh = Math.max(1, Math.round(H * scale));
      if (sw !== sceneW || sh !== sceneH) {
        sceneW = sw; sceneH = sh;
        for (const k of ['scene', 'a1', 'a2', 'b1', 'b2']) freeTarget(R[k]);
        R.scene = target(sceneW, sceneH, hdrFmt);
        const aw = Math.max(1, Math.ceil(sceneW / 4)), ah = Math.max(1, Math.ceil(sceneH / 4));
        const bw = Math.max(1, Math.ceil(sceneW / 8)), bh = Math.max(1, Math.ceil(sceneH / 8));
        R.a1 = target(aw, ah, hdrFmt); R.a2 = target(aw, ah, hdrFmt);
        R.b1 = target(bw, bh, hdrFmt); R.b2 = target(bw, bh, hdrFmt);
        info.hdr = !!hdrFmt;
      }
      const platePx = v ? v.plate.size * v.dpr : 1000;
      const ms = platePx > 1100 ? 2048 : 1024;
      if (ms !== matSize) { matSize = ms; bakePlate(ms); info.matSize = ms; }
      const cs = platePx > 1300 ? 2048 : 1024;
      if (cs !== ckSize) {
        ckSize = cs; info.ckSize = cs;
        if (T.crack) gl.deleteTexture(T.crack);
        ckBuf = new Uint8Array(cs * cs * 4);
        for (let q = 2; q < ckBuf.length; q += 4) ckBuf[q] = 128;
        ckDist = new Float32Array(cs * cs); ckW = new Float32Array(cs * cs);
        ckGold = new Float32Array(cs * cs); ckHeal = new Uint8Array(cs * cs);
        T.crack = tex(cs, cs, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, ckBuf);
        ckSig = NaN; ckBox[0] = 0; ckBox[1] = 0; ckBox[2] = cs - 1; ckBox[3] = cs - 1;
      }
      if (cs !== enSize) { enSize = cs; engravingsDirty = true; }
    }

    // ---- dynamic uploads ------------------------------------------------------------------------
    function uploadField() {
      const f = game.field;
      if (!f || !f.grid || !(f.G > 0)) return;
      if (f.version === fieldVer && f.G === fieldG) return;
      fieldVer = f.version;
      gl.bindTexture(gl.TEXTURE_2D, T.field);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (f.G !== fieldG) { fieldG = f.G; gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, fieldG, fieldG, 0, gl.RED, gl.FLOAT, f.grid); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, fieldG, fieldG, gl.RED, gl.FLOAT, f.grid);
    }
    function uploadSand() {
      const s = game.sand;
      if (!s || typeof s.texture !== 'function') return;
      const D = s.D | 0;
      if (s.version === sandVer && D === sandD) return;
      const data = s.texture();
      if (!data || data.length < D * D * 4) return;
      sandVer = s.version;
      gl.bindTexture(gl.TEXTURE_2D, T.sand);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (D !== sandD) { sandD = D; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, D, D, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); }
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, D, D, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }
    function uploadWear() {
      const w = game.wear, n = game.WEAR || 128;
      if (!w || w.length < n * n) return;
      const ver = game.wearVersion | 0;
      if (ver === wearVer) return;
      wearVer = ver;
      gl.bindTexture(gl.TEXTURE_2D, T.wear);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n, n, gl.RED, gl.UNSIGNED_BYTE, w);
    }

    // Cracks: rasterised on the CPU into a plate-space RGBA texture when they change.
    //   R hairline core (unhealed) · G gold in the crack · B lip height (0.5 = flat) · A gold glow
    function crackSignature(cracks) {
      let s = cracks.length * 1000.5;
      for (let i = 0; i < cracks.length; i++) {
        const c = cracks[i];
        if (!c || !c.pts) continue;
        s += (c.healed ? 7.3 : 1.1) * (c.pts.length + 1) * (i + 1.7);
        const g = c.gold;
        if (g) for (let j = 0; j < g.length; j++) s += num(g[j]) * (j + 1) * 0.013;
      }
      return s;
    }
    function updateCracks(t) {
      const cracks = game.state?.plate?.cracks;
      const list = Array.isArray(cracks) ? cracks : [];
      const sig = crackSignature(list);
      if (sig === ckSig) return;
      // gilding creeps grain by grain: rebuild at most a few times a second unless the set changed
      const structural = Math.floor(sig / 1000.5) !== Math.floor(ckSig / 1000.5) || !Number.isFinite(ckSig);
      if (!structural && t - ckAt < 0.35) return;
      ckSig = sig; ckAt = t;
      const bb = rasterCracks(list);
      // cracks only ever grow or gild, so the region that changed lies inside today's bounds
      const x0 = Math.min(bb[0], ckBox[0]), y0 = Math.min(bb[1], ckBox[1]);
      const x1 = Math.max(bb[2], ckBox[2]), y1 = Math.max(bb[3], ckBox[3]);
      ckBox[0] = bb[0]; ckBox[1] = bb[1]; ckBox[2] = bb[2]; ckBox[3] = bb[3];
      if (x1 < x0 || y1 < y0) return;
      gl.bindTexture(gl.TEXTURE_2D, T.crack);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, ckSize);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1, gl.RGBA, gl.UNSIGNED_BYTE, ckBuf);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }
    function rasterCracks(cracks) {
      const S = ckSize, sc = S / 1024;
      ckBuf.fill(0);
      for (let q = 2; q < ckBuf.length; q += 4) ckBuf[q] = 128;      // B: flat
      ckDist.fill(1e9);
      let bx0 = S, by0 = S, bx1 = -1, by1 = -1;
      for (let ci = 0; ci < cracks.length; ci++) {
        const c = cracks[ci];
        const pts = c && c.pts;
        if (!pts || pts.length < 2) continue;
        const branch = c.branchOf !== undefined && c.branchOf !== null;
        const healed = !!c.healed;
        let total = 0;
        for (let i = 0; i < pts.length - 1; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        total = Math.max(total, 1e-6);
        const wBase = (branch ? 0.8 : 1.15) * sc;
        let walked = 0;
        for (let i = 0; i < pts.length - 1; i++) {
          const ax = (pts[i][0] + 1) * 0.5 * S, ay = (pts[i][1] + 1) * 0.5 * S;
          const bx = (pts[i + 1][0] + 1) * 0.5 * S, by = (pts[i + 1][1] + 1) * 0.5 * S;
          const segL = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
          const s01 = (walked + segL * 0.5) / total;
          walked += segL;
          // the crack opens widest where it started (the rim) and thins to nothing at its tip
          const w = wBase * (0.35 + 0.85 * Math.pow(1 - s01, 0.7)) * (0.9 + 0.2 * Math.sin(walked * 40 + ci));
          const gold = healed ? 1 : clamp01(num(c.gold?.[i]));
          const reach = w * (healed ? 6 : 3.5) + 3;
          const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach)), x1 = Math.min(S - 1, Math.ceil(Math.max(ax, bx) + reach));
          const y0 = Math.max(0, Math.floor(Math.min(ay, by) - reach)), y1 = Math.min(S - 1, Math.ceil(Math.max(ay, by) + reach));
          if (x0 < bx0) bx0 = x0; if (y0 < by0) by0 = y0; if (x1 > bx1) bx1 = x1; if (y1 > by1) by1 = y1;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1e-9;
          for (let y = y0; y <= y1; y++) {
            const py = y + 0.5 - ay;
            for (let x = x0; x <= x1; x++) {
              const pxx = x + 0.5 - ax;
              let tt = (pxx * dx + py * dy) / L2;
              tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
              const ex = pxx - tt * dx, ey = py - tt * dy;
              const d = Math.sqrt(ex * ex + ey * ey);
              const p = y * S + x;
              // a healed seam's glow wins over a neighbouring raw crack only where it is closer
              if (d < ckDist[p]) { ckDist[p] = d; ckW[p] = w; ckGold[p] = gold; ckHeal[p] = healed ? 1 : 0; }
            }
          }
        }
      }
      if (bx1 < 0) { ckBB[0] = S; ckBB[1] = S; ckBB[2] = -1; ckBB[3] = -1; return ckBB; }
      for (let y = by0; y <= by1; y++) {
        for (let x = bx0; x <= bx1; x++) {
          const p = y * S + x;
          const d = ckDist[p];
          if (d >= 1e8) continue;
          const w = ckW[p], g = ckGold[p], hl = ckHeal[p];
          // gold lodges grain by grain: a partly gilded crack glints in flecks
          const fleck = hl ? 1 : (((x * 73856093) ^ (y * 19349663)) >>> 0) % 997 / 997 < g * 1.15 ? 1 : 0.12;
          const core = (1 - smooth(w * 0.4, w * 1.0, d)) * (1 - (hl ? 1 : g * fleck));
          const fill = g * fleck * (1 - smooth(w * 0.7, w * 1.25, d));
          const lip = 0.32 * Math.exp(-(((d - w * 1.5) / (w * 0.8)) ** 2)) * (hl ? 0.3 : 1);
          const groove = (hl ? 0.2 : 0.75) * Math.exp(-((d / (w * 0.85)) ** 2));
          const hgt = 0.5 + 0.5 * (lip - groove);
          const glow = hl ? Math.exp(-((d / (w * 3.2)) ** 2)) : g * fleck * 0.2 * Math.exp(-((d / (w * 1.8)) ** 2));
          const q = p * 4;
          ckBuf[q] = Math.round(clamp01(core) * 255);
          ckBuf[q + 1] = Math.round(clamp01(fill) * 255);
          ckBuf[q + 2] = Math.round(clamp01(hgt) * 255);
          ckBuf[q + 3] = Math.round(clamp01(glow) * 255);
        }
      }
      ckBB[0] = bx0; ckBB[1] = by0; ckBB[2] = bx1; ckBB[3] = by1;
      return ckBB;
    }

    // Engravings: the keeper's phosphor marks (R sharp, G soft) and her last message (B sharp, A soft).
    function updateEngravings(t) {
      // the notebook module may fill its texts after we start: look again now and then
      if (t - keeperAt > 2) {
        keeperAt = t;
        const e = keeper.ENGRAVINGS, f = keeper.FLOOR_ENGRAVING;
        const sig = `${Array.isArray(e) ? e.length : typeof e}:${Array.isArray(f) ? f.length : typeof f}:${(e && e[0]) || ''}`;
        if (sig !== keeperSig) { keeperSig = sig; engravingsDirty = true; }
      }
      if (!engravingsDirty) return;
      engravingsDirty = false;
      const lines = toLines(engr.lines ?? keeper.ENGRAVINGS);
      const floor = toLines(engr.floor ?? keeper.FLOOR_ENGRAVING);
      if (!fontsAsked && document.fonts?.load && (lines.length || floor.length)) {
        fontsAsked = true;
        Promise.all([document.fonts.load('48px "IM Fell English"'), document.fonts.load('italic 48px "IM Fell English"')])
          .then(() => { engr.fontReady = true; engravingsDirty = true; }).catch(() => {});
      }
      const data = drawEngravings(enSize, lines, floor);
      if (T.engr) gl.deleteTexture(T.engr);
      T.engr = tex(enSize, enSize, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    // ---- frame ----------------------------------------------------------------------------------
    function render() {
      if (lost || gl.isContextLost()) return;
      const v = game.view;
      if (!v || !v.plate) return;
      if ((canvas.width | 0) !== W || (canvas.height | 0) !== H) resize();
      const t0 = performance.now();
      adapt(t0);
      const t = num(game.t), dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      const Lt = game.light || {}, fx = game.fx || {};
      const level = clamp01(num(Lt.level, 1));
      const flick = clamp01(num(Lt.flicker));
      const lightI = level * (1 - 0.6 * flick * (0.55 + 0.45 * Math.sin(t * 47.3)));
      const choir = clamp01(num(fx.choir)), floorFx = clamp01(num(fx.floor));
      const shake = clamp01(num(fx.shake)), flash = clamp01(num(fx.flash));
      const dpr = v.dpr || 1;
      const size = v.plate.size, unit = size / 2;
      const sa = shake * 5;
      const cx = v.plate.cx + sa * (Math.sin(t * 71.3) + Math.sin(t * 43.7 + 1.3)) * 0.5;
      const cy = v.plate.cy + sa * (Math.cos(t * 67.1) + Math.sin(t * 51.9 + 0.4)) * 0.5;
      // the lamp hangs a little up and left of the plate's centre, swaying almost imperceptibly; its
      // beam is aimed just above the plate's centre
      const swx = Math.sin(t * 0.31) * size * 0.004, swy = Math.cos(t * 0.23) * size * 0.003;
      const lx = v.plate.cx - size * 0.08 + swx;
      const ly = v.plate.cy - size * 0.14 + swy;
      const lz = size * 1.6, poolR = size * 0.9;
      const ax = v.plate.cx - size * 0.03 + swx * 1.4, ay = v.plate.cy - size * 0.06 + swy * 1.4;
      const LA = api.lamp;
      LA.x = lx; LA.y = ly; LA.z = lz; LA.aimX = ax; LA.aimY = ay; LA.size = size; LA.poolR = poolR;
      // phonograph playback (eases in and out)
      const ph = game.field?.getSource?.('phono');
      let phOn = 0;
      if (Array.isArray(ph)) for (const c of ph) if (num(c?.amp) > 0.02) { phOn = 1; break; }
      phonoK += (phOn - phonoK) * Math.min(1, dt * (phOn ? 0.8 : 1.5));
      // felt dampers on the plate (the moth is not felt)
      dampArr.fill(0);
      const dl = game.field?.dampers;
      if (Array.isArray(dl)) {
        let n = 0;
        for (const d of dl) {
          if (n >= 6) break;
          if (!d || d.moth || !Number.isFinite(d.u) || !Number.isFinite(d.v)) continue;
          dampArr[n * 4] = d.u; dampArr[n * 4 + 1] = d.v; dampArr[n * 4 + 2] = Math.max(0.03, num(d.r, 0.06)) * 1.03; dampArr[n * 4 + 3] = 1;
          n++;
        }
      }

      // darkness reveals the phosphor marks slowly; light hides them quickly
      const dark = Lt.on === false ? 1 : 0;
      engrOn += (dark - engrOn) * Math.min(1, dt * (dark ? 0.35 : 1.4));
      const engrVis = engrOn * (1 - level) * (1 - level);
      const floorTarget = game.state?.seen?.floor ? 1 : floorFx;
      floorEngr += (floorTarget - floorEngr) * Math.min(1, dt * 0.25);

      uploadField(); uploadSand(); uploadWear(); updateCracks(t); updateEngravings(t);

      // singers
      let count = 0;
      const inst = game.life?.instanceData?.();
      if (inst && inst.data && inst.count > 0 && (inst.stride | 0 || 16) === 16) {
        count = Math.min(inst.count | 0, (inst.data.length / 16) | 0);
        if (count > instCap) {
          instCap = count;
          gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
          gl.bufferData(gl.ARRAY_BUFFER, instCap * 64, gl.DYNAMIC_DRAW);
        }
        if (count > 0) {
          const data = remapInstances(inst.data, count, game.life);
          gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 16);
        }
      }

      // --- singer light map ---
      const Ps = P.singer;
      if (count > 0) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, R.lm.fb);
        gl.viewport(0, 0, LM_SIZE, LM_SIZE);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(Ps.p);
        singerUniforms(Ps, cx, cy, unit, lx, ly, lz, t, dpr * sceneW / W, level, choir);
        gl.uniform1i(Ps.u.uPass, 2);
        gl.bindVertexArray(vaoSing);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      }

      // --- scene ---
      gl.disable(gl.BLEND);
      const Pc = P.scene;
      gl.useProgram(Pc.p);
      const f = game.field;
      const sdpr = dpr * sceneW / W;
      gl.uniform2f(Pc.u.uRes, sceneW, sceneH);
      gl.uniform1f(Pc.u.uDpr, sdpr);
      gl.uniform3f(Pc.u.uPlate, cx, cy, unit);
      gl.uniform3f(Pc.u.uLamp, lx, ly, lz);
      gl.uniform1f(Pc.u.uPoolR, poolR);
      gl.uniform1f(Pc.u.uLightI, lightI);
      gl.uniform1f(Pc.u.uLevel, level);
      gl.uniform1f(Pc.u.uTime, t);
      gl.uniform1f(Pc.u.uAmp, num(f?.total));
      gl.uniform1f(Pc.u.uK, num(f?.kEff, 20));
      gl.uniform1f(Pc.u.uChoir, choir);
      gl.uniform1f(Pc.u.uFloor, floorFx);
      gl.uniform1f(Pc.u.uEngr, engrVis);
      gl.uniform1f(Pc.u.uFloorEngr, floorEngr);
      gl.uniform1f(Pc.u.uLmOn, count > 0 ? 1 : 0);
      gl.uniform1f(Pc.u.uLmExt, LM_EXT);
      gl.uniform2f(Pc.u.uSandTexel, 1 / Math.max(1, sandD), 1 / Math.max(1, sandD));
      gl.uniform2f(Pc.u.uFieldTexel, 1 / Math.max(1, fieldG), 1 / Math.max(1, fieldG));
      gl.uniform2f(Pc.u.uCkTexel, 1 / ckSize, 1 / ckSize);
      gl.uniform2f(Pc.u.uEnTexel, 1 / enSize, 1 / enSize);
      gl.uniform2f(Pc.u.uWearTexel, 1 / (game.WEAR || 128), 1 / (game.WEAR || 128));
      gl.uniform2f(Pc.u.uAim, ax, ay);
      if (Pc.u.uDamp) gl.uniform4fv(Pc.u.uDamp, dampArr);
      bind(0, T.matA); bind(1, T.matB); bind(2, T.felt); bind(3, T.field); bind(4, T.sand);
      bind(5, T.wear); bind(6, T.crack); bind(7, T.engr); bind(8, R.lm.tex);
      drawFull(R.scene);

      // --- singers into the scene ---
      gl.enable(gl.BLEND);
      if (count > 0) {
        gl.useProgram(Ps.p);
        singerUniforms(Ps, cx, cy, unit, lx, ly, lz, t, sdpr, level, choir);
        gl.bindVertexArray(vaoSing);
        gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
        gl.uniform1i(Ps.u.uPass, 0);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        gl.uniform1i(Ps.u.uPass, 1);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
      }
      // --- dust in the beam ---
      if (lightI > 0.01) {
        gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
        const Pd = P.dust;
        gl.useProgram(Pd.p);
        gl.uniform2f(Pd.u.uRes, sceneW, sceneH);
        gl.uniform1f(Pd.u.uDpr, sdpr);
        gl.uniform3f(Pd.u.uLamp, ax, ay, lz);
        gl.uniform1f(Pd.u.uPoolR, size * 0.72);
        gl.uniform1f(Pd.u.uTime, t);
        gl.uniform1f(Pd.u.uLightI, lightI * (1 + 0.6 * choir));
        gl.bindVertexArray(vaoEmpty);
        gl.drawArrays(gl.POINTS, 0, DUST_N);
      }
      gl.disable(gl.BLEND);

      // --- bloom ---
      gl.useProgram(P.bright.p);
      gl.uniform2f(P.bright.u.uTexel, 1 / sceneW, 1 / sceneH);
      gl.uniform1f(P.bright.u.uThresh, (hdrFmt ? 1.25 : 0.62) - 0.3 * choir - 0.1 * floorFx);
      bind(0, R.scene.tex);
      drawFull(R.a1);
      gl.useProgram(P.blur.p);
      gl.uniform2f(P.blur.u.uDir, 1 / R.a1.w, 0); bind(0, R.a1.tex); drawFull(R.a2);
      gl.uniform2f(P.blur.u.uDir, 0, 1 / R.a1.h); bind(0, R.a2.tex); drawFull(R.a1);
      gl.useProgram(P.down.p);
      gl.uniform2f(P.down.u.uTexel, 1 / R.a1.w, 1 / R.a1.h);
      bind(0, R.a1.tex); drawFull(R.b1);
      gl.useProgram(P.blur.p);
      gl.uniform2f(P.blur.u.uDir, 1.4 / R.b1.w, 0); bind(0, R.b1.tex); drawFull(R.b2);
      gl.uniform2f(P.blur.u.uDir, 0, 1.4 / R.b1.h); bind(0, R.b2.tex); drawFull(R.b1);

      // --- composite ---
      const Pq = P.comp;
      gl.useProgram(Pq.p);
      gl.uniform2f(Pq.u.uRes, W, H);
      gl.uniform1f(Pq.u.uDpr, dpr);
      gl.uniform1f(Pq.u.uTime, t);
      gl.uniform3f(Pq.u.uLamp, lx, ly, lz);
      gl.uniform1f(Pq.u.uPoolR, poolR);
      gl.uniform1f(Pq.u.uLightI, lightI);
      gl.uniform1f(Pq.u.uChoir, choir);
      gl.uniform1f(Pq.u.uFloor, floorFx);
      gl.uniform1f(Pq.u.uFlash, flash);
      gl.uniform1f(Pq.u.uBloomK, 0.65 + 0.55 * choir + 0.25 * floorFx);
      gl.uniform1f(Pq.u.uFade, Math.min(1, t / 0.6));
      gl.uniform1f(Pq.u.uPhono, phonoK);
      gl.uniform2f(Pq.u.uAim, ax, ay);
      gl.uniform1f(Pq.u.uPlateW, size);
      gl.uniform1i(Pq.u.uDebug, debugMode);
      bind(0, R.scene.tex); bind(1, R.a1.tex); bind(2, R.b1.tex);
      drawFull(null);
      gl.bindVertexArray(null);

      info.frames++;
      info.ms = info.ms * 0.95 + (performance.now() - t0) * 0.05;
    }

    // Frame pacing: if frames run long for a couple of seconds, render the scene at a lower internal
    // resolution (0.85, then 0.7; the composite upsamples); climb back when there is headroom.
    function adapt(now) {
      const dtm = lastNow ? now - lastNow : 16.7;
      lastNow = now;
      if (dtm <= 0 || dtm > 120) return;               // hidden tab, a hitch, or the first frame
      frameEma += (dtm - frameEma) * 0.05;
      const dts = dtm / 1000;
      if (frameEma > 21) { slowFor += dts; fastFor = 0; } else if (frameEma < 13.5) { fastFor += dts; slowFor = 0; } else { slowFor = 0; fastFor = 0; }
      let next = scale;
      if (slowFor > 2.5 && scale > 0.71) next = scale > 0.9 ? 0.85 : 0.7;
      else if (fastFor > 8 && scale < 0.99) next = scale < 0.8 ? 0.85 : 1;
      if (next !== scale) { scale = next; slowFor = 0; fastFor = 0; info.scale = scale; resize(); }
    }

    function singerUniforms(Ps, cx, cy, unit, lx, ly, lz, t, dpr, level, choir) {
      gl.uniform2f(Ps.u.uRes, sceneW, sceneH);
      gl.uniform1f(Ps.u.uDpr, dpr);
      gl.uniform3f(Ps.u.uPlate, cx, cy, unit);
      gl.uniform3f(Ps.u.uLamp, lx, ly, lz);
      gl.uniform1f(Ps.u.uTime, t);
      gl.uniform1f(Ps.u.uLmExt, LM_EXT);
      gl.uniform1f(Ps.u.uLevel, level);
      gl.uniform1f(Ps.u.uChoir, choir);
    }

    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
    canvas.addEventListener('webglcontextrestored', () => {
      // everything from the old context is gone: forget it rather than delete it
      for (const k of Object.keys(T)) T[k] = null;
      for (const k of Object.keys(R)) R[k] = null;
      try { init(); } catch (err) { console.error('[gfx] restore failed', err); }
    });

    init();
    api.resize = resize;
    api.render = () => { try { render(); } catch (e) { reportOnce(e); } };
  }

  // ---- engraving artwork (Canvas2D, then packed into one RGBA texture) -----------------------
  function drawEngravings(S, lines, floor) {
    const out = new Uint8Array(S * S * 4);
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return out;
    const a = paintLayer(S, (ctx) => paintMarks(ctx, S, lines), 6);
    const b = floor.length ? paintLayer(S, (ctx) => paintFloor(ctx, S, floor), 2) : null;
    const pa = a.sharp, qa = a.soft, pb = b?.sharp, qb = b?.soft;
    for (let p = 0, q = 0; p < S * S; p++, q += 4) {
      out[q] = pa[q];
      out[q + 1] = qa[q];
      out[q + 2] = pb ? pb[q] : 0;
      out[q + 3] = pb ? qb[q] : 0;
    }
    return out;
  }

  function paintLayer(S, paint, k) {
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';
    paint(ctx);
    ctx.globalCompositeOperation = 'source-over';
    const sharp = ctx.getImageData(0, 0, S, S).data;
    // a soft copy (cheap blur: down by k and up again)
    const s = document.createElement('canvas');
    s.width = s.height = Math.max(8, S / k | 0);
    const sx = s.getContext('2d');
    sx.imageSmoothingEnabled = true;
    sx.drawImage(c, 0, 0, s.width, s.height);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(s, 0, 0, S, S);
    const soft = ctx.getImageData(0, 0, S, S).data;
    return { sharp, soft };
  }

  // tiny seeded rng for hand-cut jitter (deterministic per text)
  function rngFrom(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    let s = h >>> 0 || 1;
    return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  }

  // Hand-cut letters: each glyph cut separately (a little rotation and wander), re-scored, with the
  // occasional slip of the graver.
  function cutText(ctx, text, x, y, fs, rnd, align = 'center') {
    const font = `${fs}px "IM Fell English", "Iowan Old Style", "Palatino Linotype", Georgia, serif`;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    let width = 0;
    const adv = [];
    for (const ch of text) { const w = ctx.measureText(ch).width * 1.04 + fs * 0.02; adv.push(w); width += w; }
    let px = align === 'center' ? x - width / 2 : x;
    let i = 0;
    for (const ch of text) {
      const w = adv[i++];
      if (ch !== ' ') {
        ctx.save();
        ctx.translate(px + w / 2, y + (rnd() - 0.5) * fs * 0.06);
        ctx.rotate((rnd() - 0.5) * 0.07);
        ctx.fillStyle = 'rgba(255,255,255,0.42)';
        for (let pass = 0; pass < 2; pass++) ctx.fillText(ch, -w / 2 + (rnd() - 0.5) * fs * 0.025, (rnd() - 0.5) * fs * 0.025);
        ctx.lineWidth = Math.max(0.6, fs * 0.022);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.strokeText(ch, -w / 2, 0);
        if (rnd() < 0.12) {                                           // a slip of the graver
          ctx.beginPath();
          const sx = (rnd() - 0.5) * w, sy = -rnd() * fs * 0.6;
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + (rnd() - 0.3) * fs * 0.5, sy + (rnd() - 0.5) * fs * 0.3);
          ctx.lineWidth = Math.max(0.5, fs * 0.015);
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.stroke();
        }
        ctx.restore();
      }
      px += w;
    }
    return width;
  }

  function fitSize(ctx, text, fs, maxW) {
    ctx.font = `${fs}px "IM Fell English", Georgia, serif`;
    const w = ctx.measureText(text).width * 1.06 + text.length * fs * 0.02;
    return w > maxW ? fs * maxW / w : fs;
  }

  // The keeper's marks: inscriptions around the rim, notes in the quarters, and a few scratched
  // tallies and diagrams of her own.
  function paintMarks(ctx, S, lines) {
    const U = S / 2;                              // texels per plate unit
    const toT = (u, v) => [(u + 1) * U, (v + 1) * U];
    const rnd = rngFrom(lines.join('|') || 'voss');
    const slots = [
      { u: 0, v: -0.885, a: 0, w: 1.5, fs: 0.05 },
      { u: 0.885, v: 0, a: Math.PI / 2, w: 1.5, fs: 0.05 },
      { u: 0, v: 0.885, a: Math.PI, w: 1.5, fs: 0.05 },
      { u: -0.885, v: 0, a: -Math.PI / 2, w: 1.5, fs: 0.05 },
      { u: -0.44, v: -0.56, a: -0.1, w: 0.72, fs: 0.042 },
      { u: 0.46, v: 0.56, a: 0.08, w: 0.72, fs: 0.042 },
      { u: 0.47, v: -0.5, a: 0.16, w: 0.62, fs: 0.04 },
      { u: -0.48, v: 0.5, a: -0.18, w: 0.62, fs: 0.04 },
      { u: 0.0, v: -0.34, a: 0.03, w: 0.8, fs: 0.036 },
      { u: 0.0, v: 0.34, a: -0.04, w: 0.8, fs: 0.036 },
      { u: -0.6, v: 0.0, a: -0.06, w: 0.5, fs: 0.034 },
      { u: 0.6, v: 0.0, a: 0.05, w: 0.5, fs: 0.034 },
    ];
    lines.forEach((text, i) => {
      if (!text) return;
      const s = slots[i % slots.length];
      const ring = Math.floor(i / slots.length);
      const [x, y] = toT(s.u * (1 - ring * 0.12), s.v * (1 - ring * 0.12) + ring * 0.05);
      let fs = s.fs * U;
      fs = fitSize(ctx, text, fs, s.w * U);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(s.a);
      cutText(ctx, text, 0, fs * 0.35, fs, rnd);
      ctx.restore();
    });

    // scratched tallies near a corner: five, ten, twenty, forty
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineCap = 'round';
    let [tx, ty] = toT(-0.82, 0.62);
    const groups = [5, 10, 20, 40];
    for (let gi = 0; gi < groups.length; gi++) {
      const n = groups[gi];
      const h = U * 0.045 * (1 - gi * 0.12);
      let x = tx;
      for (let k = 0; k < n; k++) {
        if (k % 5 === 4) {                                          // the gate across four strokes
          ctx.lineWidth = Math.max(0.7, U * 0.0035);
          ctx.beginPath();
          ctx.moveTo(x - U * 0.05 + (rnd() - 0.5) * 2, ty + h * 0.75);
          ctx.lineTo(x + U * 0.004, ty + h * 0.2 + (rnd() - 0.5) * 2);
          ctx.stroke();
          x += U * 0.022;
        } else {
          ctx.lineWidth = Math.max(0.7, U * 0.003);
          ctx.beginPath();
          ctx.moveTo(x + (rnd() - 0.5) * 2, ty + (rnd() - 0.5) * 2);
          ctx.lineTo(x + (rnd() - 0.5) * 3, ty + h + (rnd() - 0.5) * 2);
          ctx.stroke();
          x += U * 0.0125;
        }
      }
      ty += h * 1.5;
    }
    ctx.restore();

    // a ring around a point: where she rested her finger
    ctx.save();
    const [rx, ry] = toT(0.7, -0.74);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(0.7, U * 0.003);
    for (let k = 0; k < 2; k++) {
      ctx.beginPath();
      for (let a = 0; a <= 6.4; a += 0.2) {
        const rr = U * 0.04 * (1 + (rnd() - 0.5) * 0.08);
        const px = rx + Math.cos(a) * rr, py = ry + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.beginPath(); ctx.arc(rx, ry, U * 0.006, 0, 6.2832); ctx.fill();
    ctx.restore();

    // a little figure she drew of one of them: a square, its still lines, a circle about it
    ctx.save();
    const [fx, fy] = toT(0.74, 0.7);
    const r = U * 0.05;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(0.7, U * 0.0028);
    ctx.beginPath();
    ctx.moveTo(fx - r, fy - r); ctx.lineTo(fx + r, fy + r);
    ctx.moveTo(fx + r, fy - r); ctx.lineTo(fx - r, fy + r);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(fx, fy, r * 1.45, 0, 6.2832); ctx.stroke();
    ctx.beginPath(); ctx.arc(fx, fy, r * 0.6, 0, 6.2832); ctx.stroke();
    ctx.restore();
  }

  // Her last message: centred on the plate, parted around the clamp.
  function paintFloor(ctx, S, lines) {
    const U = S / 2;
    const rnd = rngFrom(lines.join('|'));
    let fs = U * 0.058;
    for (const l of lines) fs = Math.min(fs, fitSize(ctx, l, fs, 1.3 * U));
    const lh = fs * 1.45;
    const top = Math.ceil(lines.length / 2), bottom = lines.length - top;
    const gap = U * 0.15;
    const maxH = U * 0.8;
    const scale = Math.min(1, maxH / Math.max(lh * top, lh * bottom, 1));
    fs *= scale;
    const lh2 = fs * 1.45;
    lines.forEach((l, i) => {
      let y;
      if (i < top) y = U - gap - (top - 1 - i) * lh2;
      else y = U + gap + fs * 0.8 + (i - top) * lh2;
      cutText(ctx, l, U, y, fs, rnd);
    });
  }

  function reportOnce(e) {
    const k = String(e && e.message);
    if (reportOnce.seen?.has(k)) return;
    (reportOnce.seen ||= new Set()).add(k);
    console.error('[gfx]', e);
  }
}

function toLines(x) {
  if (!x) return [];
  if (typeof x === 'string') return x.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!Array.isArray(x)) return [];
  return x.map((s) => (typeof s === 'string' ? s : s && typeof s.text === 'string' ? s.text : '')).filter(Boolean);
}

// =============================================================================================
// Notebook sketch of a species' figure: sepia ink where the summed modes are still, drawn with a
// slightly unsteady hand, on a transparent ground.
export function figureCanvas(comps, px = 160) {
  px = Math.max(16, Math.min(1024, Math.round(num(+px, 160))));
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const list = (Array.isArray(comps) ? comps : [comps])
    .map((x) => modeById(typeof x === 'string' ? x : x?.mode ?? x?.id ?? x))
    .filter(Boolean);
  const key = list.map((m) => m.id).join('+') || 'blank';
  let s = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { s ^= key.charCodeAt(i); s = Math.imul(s, 16777619); }
  s = (s >>> 0) || 7;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
  const k = px / 160;                       // line weights scale with the sketch
  const m0 = px * 0.08, span = px - 2 * m0;
  const toX = (u) => m0 + (u + 1) * 0.5 * span;
  const ink = (a) => `rgba(74,47,28,${a})`;
  // a slow wobble, as from a hand that is careful but not mechanical
  const ph = [rnd() * 9, rnd() * 9, rnd() * 9, rnd() * 9];
  const wob = (x, y) => [
    x + (Math.sin(y * 0.045 / k + ph[0]) + 0.5 * Math.sin(y * 0.11 / k + ph[1])) * 0.55 * k,
    y + (Math.sin(x * 0.05 / k + ph[2]) + 0.5 * Math.sin(x * 0.13 / k + ph[3])) * 0.55 * k,
  ];

  // the plate, drawn freehand: four strokes that overshoot a little at the corners
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [u0, v0] = corners[i], [u1, v1] = corners[(i + 1) % 4];
    const ov = 0.035;
    const du = (u1 - u0) * ov, dv = (v1 - v0) * ov;
    ctx.beginPath();
    const steps = 12;
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      const [x, y] = wob(toX(u0 - du + (u1 - u0 + 2 * du) * t), toX(v0 - dv + (v1 - v0 + 2 * dv) * t));
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = ink(0.42);
    ctx.lineWidth = 0.9 * k;
    ctx.stroke();
  }
  if (!list.length) return c;

  // the summed figure on a grid; zero contour by marching squares
  const N = Math.max(48, Math.min(180, Math.round(px / 1.6)));
  const val = new Float32Array((N + 1) * (N + 1));
  const inv = 1 / Math.sqrt(list.length);
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const u = -1 + (2 * i) / N, v = -1 + (2 * j) / N;
    let f = 0;
    for (const m of list) f += evalMode(m, u, v);
    val[j * (N + 1) + i] = f * inv;
  }
  const at = (i, j) => val[j * (N + 1) + i];
  const segs = [];
  const lerp = (a, b) => (Math.abs(a - b) < 1e-9 ? 0.5 : a / (a - b));
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = at(i, j), b = at(i + 1, j), cc = at(i + 1, j + 1), d = at(i, j + 1);
    const idx = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (cc > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
    if (idx === 0 || idx === 15) continue;
    const e = [
      [i + lerp(a, b), j], [i + 1, j + lerp(b, cc)], [i + 1 - lerp(cc, d), j + 1], [i, j + 1 - lerp(d, a)],
    ];
    const pairs = {
      1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]],
      11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[0, 3]],
    }[idx];
    let ps = pairs;
    if (idx === 5 || idx === 10) {
      const centre = (a + b + cc + d) * 0.25;
      ps = (idx === 5) === (centre > 0) ? [[3, 2], [0, 1]] : [[3, 0], [1, 2]];
    }
    for (const [p, q] of ps) segs.push([e[p][0], e[p][1], e[q][0], e[q][1]]);
  }
  // chain the segments into strokes
  const keyOf = (x, y) => `${Math.round(x * 64)},${Math.round(y * 64)}`;
  const ends = new Map();
  segs.forEach((sg, si) => {
    for (const end of [0, 1]) {
      const kk = keyOf(sg[end * 2], sg[end * 2 + 1]);
      if (!ends.has(kk)) ends.set(kk, []);
      ends.get(kk).push(si);
    }
  });
  const used = new Uint8Array(segs.length);
  const strokes = [];
  for (let si = 0; si < segs.length; si++) {
    if (used[si]) continue;
    used[si] = 1;
    const pts = [[segs[si][0], segs[si][1]], [segs[si][2], segs[si][3]]];
    for (const dirn of [1, 0]) {
      for (;;) {
        const tip = dirn ? pts[pts.length - 1] : pts[0];
        const cand = ends.get(keyOf(tip[0], tip[1])) || [];
        let next = -1;
        for (const ci of cand) if (!used[ci]) { next = ci; break; }
        if (next < 0) break;
        used[next] = 1;
        const sg = segs[next];
        const same = keyOf(sg[0], sg[1]) === keyOf(tip[0], tip[1]);
        const np = same ? [sg[2], sg[3]] : [sg[0], sg[1]];
        if (dirn) pts.push(np); else pts.unshift(np);
      }
    }
    strokes.push(pts);
  }
  const g2p = (gx) => m0 + (gx / N) * span;
  // ink: a faint wash where the pen paused, then the line itself in short irregular strokes
  for (const pts of strokes) {
    if (pts.length < 2) continue;
    const P = pts.map(([gx, gy]) => wob(g2p(gx), g2p(gy)));
    ctx.beginPath();
    P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = ink(0.16);
    ctx.lineWidth = 2.6 * k;
    ctx.stroke();
    let i = 0;
    while (i < P.length - 1) {
      const n = 3 + Math.floor(rnd() * 6);
      const j = Math.min(P.length - 1, i + n);
      ctx.beginPath();
      ctx.moveTo(P[i][0], P[i][1]);
      for (let q = i + 1; q <= j; q++) ctx.lineTo(P[q][0], P[q][1]);
      ctx.strokeStyle = ink(0.7 + rnd() * 0.25);
      ctx.lineWidth = (0.85 + rnd() * 0.6) * k;
      ctx.stroke();
      i = j;
    }
  }
  // stipple: sand lying along the still lines
  const dots = Math.round(px * px * 0.045);
  ctx.fillStyle = ink(0.45);
  for (let n = 0; n < dots; n++) {
    const u = rnd() * 2 - 1, v = rnd() * 2 - 1;
    let f = 0;
    for (const m of list) f += evalMode(m, u, v);
    f = Math.abs(f * inv);
    if (f > 0.09 || rnd() > 0.5 * (1 - f / 0.09)) continue;
    ctx.beginPath();
    ctx.arc(toX(u), toX(v), (0.35 + rnd() * 0.5) * k, 0, 6.2832);
    ctx.fill();
  }
  // the clamp
  ctx.beginPath();
  ctx.arc(toX(0), toX(0), 2.4 * k, 0, 6.2832);
  ctx.strokeStyle = ink(0.6);
  ctx.lineWidth = 0.9 * k;
  ctx.stroke();
  return c;
}

// =============================================================================================
// Canvas2D fallback: the plate in its pool of light, sand from the density texture, singers as
// small glowing beads. Modest, but never a crash.
function createFallback(canvas, game, api, replace = false) {
  let cv = canvas;
  if (replace && canvas.parentNode) {
    // a canvas that already handed out a WebGL context cannot give a 2D one: swap in a twin
    cv = canvas.cloneNode(false);
    canvas.parentNode.replaceChild(cv, canvas);
  }
  const ctx = cv.getContext('2d');
  const sandCv = document.createElement('canvas');
  const sctx = sandCv.getContext('2d');
  let sandImg = null, sandVer = -1;
  api.kind = 'canvas2d';
  api.resize = () => {
    const v = game.view;
    if (!v) return;
    const w = Math.round(v.vw * v.dpr), h = Math.round(v.vh * v.dpr);
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    cv.style.width = v.vw + 'px'; cv.style.height = v.vh + 'px';
  };
  api.render = () => {
    const v = game.view;
    if (!v || !ctx) return;
    if (replace) api.resize();
    const { dpr, vw, vh, plate } = v;
    const L = clamp01(num(game.light?.level, 1));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0a0807';
    ctx.fillRect(0, 0, vw, vh);
    const lx = plate.cx - plate.size * 0.08, ly = plate.cy - plate.size * 0.14;
    const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, plate.size * 0.95);
    g.addColorStop(0, `rgba(70,52,36,${0.9 * L})`);
    g.addColorStop(1, 'rgba(10,8,7,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, vw, vh);
    // shadow + plate
    ctx.fillStyle = `rgba(0,0,0,${0.5 * L})`;
    ctx.fillRect(plate.x + plate.size * 0.03, plate.y + plate.size * 0.04, plate.size, plate.size);
    const pg = ctx.createLinearGradient(plate.x, plate.y, plate.x + plate.size, plate.y + plate.size);
    pg.addColorStop(0, '#b4884a'); pg.addColorStop(0.45, '#8a6534'); pg.addColorStop(1, '#5d4322');
    ctx.globalAlpha = 0.08 + 0.92 * L;
    ctx.fillStyle = pg;
    ctx.fillRect(plate.x, plate.y, plate.size, plate.size);
    // sand
    const s = game.sand;
    if (s && typeof s.texture === 'function') {
      const D = s.D | 0;
      if (s.version !== sandVer) {
        sandVer = s.version;
        const t = s.texture();
        if (sandCv.width !== D) { sandCv.width = sandCv.height = D; sandImg = sctx.createImageData(D, D); }
        const px = sandImg.data;
        for (let p = 0, q = 0; p < D * D; p++, q += 4) {
          const d = t[q], gd = t[q + 1];
          const gold = gd > d;
          px[q] = gold ? 255 : 233; px[q + 1] = gold ? 204 : 223; px[q + 2] = gold ? 102 : 200;
          px[q + 3] = Math.min(255, Math.max(d, gd) * 2.2);
        }
        sctx.putImageData(sandImg, 0, 0);
      }
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sandCv, plate.x, plate.y, plate.size, plate.size);
    }
    ctx.globalAlpha = 1;
    // cracks
    const unit = plate.size / 2;
    for (const c of game.state?.plate?.cracks || []) {
      if (!c?.pts || c.pts.length < 2) continue;
      ctx.beginPath();
      c.pts.forEach(([u, vv], i) => (i ? ctx.lineTo(plate.cx + u * unit, plate.cy + vv * unit) : ctx.moveTo(plate.cx + u * unit, plate.cy + vv * unit)));
      ctx.strokeStyle = c.healed ? 'rgba(255,204,102,0.9)' : `rgba(20,12,6,${0.3 + 0.6 * L})`;
      ctx.lineWidth = c.healed ? 1.6 : 1;
      ctx.stroke();
    }
    // nut
    ctx.fillStyle = '#1a1a1c';
    ctx.beginPath(); ctx.arc(plate.cx, plate.cy, unit * 0.06, 0, 6.2832); ctx.fill();
    // singers
    const inst = game.life?.instanceData?.();
    if (inst && inst.count > 0) {
      const d = inst.data;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < inst.count; i++) {
        const o = i * 16;
        const x = plate.cx + d[o] * unit, y = plate.cy + d[o + 1] * unit, r = Math.max(2, d[o + 2] * unit);
        const e = clamp01(d[o + 3]);
        const rg = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
        rg.addColorStop(0, `rgba(255,240,210,${0.35 + 0.5 * e})`);
        rg.addColorStop(0.4, `rgba(255,220,170,${0.2 + 0.3 * e})`);
        rg.addColorStop(1, 'rgba(255,200,140,0)');
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }
  };
  api.resize();
  return api;
}
