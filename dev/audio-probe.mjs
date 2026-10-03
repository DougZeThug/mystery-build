// Spectral probe: node dev/audio-probe.mjs <baseUrl> <scene[:t0-t1,t0-t1]>... [--shot out.png]
// e.g. node dev/audio-probe.mjs http://localhost:8204 plate playback:1-5 keeper:2-9 --shot /tmp/p.png
// Prints level and octave-band power per window, and the strongest spectral peaks.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const args = process.argv.slice(2);
const base = args.shift() || 'http://localhost:8204';
let shot = null;
const si = args.indexOf('--shot');
if (si >= 0) { shot = args[si + 1]; args.splice(si, 2); }
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1240, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}/dev/audio-probe.html`);
await page.waitForFunction(() => window.ready);
for (const a of args) {
  const [name, w] = a.split(':');
  const windows = w ? w.split(',').map((x) => x.split('-').map(Number)) : null;
  const r = await page.evaluate(([n, ws]) => window.probe(n, ws), [name, windows]);
  console.log(`== ${r.name} (${r.dur.toFixed(1)} s, nodes left ${r.nodes}${r.base !== undefined ? ` of base ${r.base}` : ''}) ${r.live ? JSON.stringify(r.live) : ''}`);
  for (const x of r.windows) {
    console.log(`  ${x.t[0]}-${x.t[1]} s  rms ${x.rms}  peak ${x.peak}`);
    console.log('    bands', Object.entries(x.bands).map(([f, v]) => `${f}:${v}`).join(' '));
    console.log('    peaks', x.peaks.map(([f, v]) => `${f}Hz ${v}`).join(', '));
    console.log('    AM depth', Object.entries(x.mod).map(([f, v]) => `${f}Hz ${v}`).join('  '));
  }
}
if (shot) await page.screenshot({ path: shot, fullPage: true });
if (errors.length) console.log('console:', errors.join('\n  '));
await browser.close();
