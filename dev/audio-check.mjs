// Runs dev/audio-check.html in headless Chromium and prints the offline audio report.
//   node dev/audio-check.mjs [baseUrl=http://localhost:8104] [screenshot.png] [only=mix|cont|shots]
// Needs a static server on the repo root (npx http-server . -p 8104 -c-1 -s).
// Exit code 1 if any render peaks at or above 0.9, contains NaN, has DC offset, is silent when it
// should sound, or a one-shot fails to free its nodes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const base = process.argv[2] || 'http://localhost:8104';
const shot = process.argv[3] || null;
const only = process.argv[4] || '';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(`${base}/dev/audio-check.html${only ? '?only=' + only : ''}`);
await page.waitForFunction(() => window.__report, null, { timeout: 240000 });
const r = await page.evaluate(() => window.__report);
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close();

const db = (x) => (x > 1e-9 ? (20 * Math.log10(x)).toFixed(1) : '-inf').padStart(6);
const row = (name, a, extra = '') => console.log(`${name.padEnd(28)} peak ${db(a.peak)}  rms ${db(a.rms)}  loud ${db(a.loud)}  tail ${db(a.tail)}  cent ${String(Math.round(a.centroid)).padStart(5)}  dc ${a.dc.toExponential(1).padStart(8)}  nan ${a.nan}${extra}`);
if (r.unity) console.log('chain gain (in -> out dB):', r.unity.map((u) => `${(20 * Math.log10(u.in)).toFixed(0)}dB->${u.gainDb.toFixed(2)}`).join('  '));
if (r.dcWindows) console.log('floor per-second mean:', r.dcWindows.join(' '));
if (r.mix) {
  console.log(`== mixed scene (${r.mix.dur || 12} s) ==`);
  row('mix', r.mix, `  nodes<=${r.mix.maxNodes} shots<=${r.mix.maxShots} comp meter ${r.mix.maxReductionDb.toFixed(1)} dB`);
  console.log('  per second rms:', r.mix.perSec.map((p) => db(p.rms).trim()).join(' '));
  console.log('  per second peak:', r.mix.perSec.map((p) => db(p.peak).trim()).join(' '));
  console.log(`  typical scene (bow + 3 species): nodes median ${r.typical.median}, max ${r.typical.max}; comp meter ${r.typical.maxReductionDb.toFixed(1)} dB`);
  row('typical', r.typical);
}
if (r.continuous.length) { console.log('== continuous =='); for (const a of r.continuous) row(a.name, a); }
if (r.oneShots.length) { console.log('== one-shots =='); for (const a of r.oneShots) row(a.name, a, a.leaked || a.nodesLeft ? `  LEAK ${a.leaked}/${a.nodesLeft}` : a.played ? '' : '  NOT PLAYED'); }
if (r.error) console.log('ERROR', r.error);
if (errors.length) console.log('console:', errors.join('\n  '));
console.log(r.failures.length ? `FAILURES: ${r.failures.join(', ')}` : 'all clear');
process.exit(r.failures.length || r.error ? 1 : 0);
