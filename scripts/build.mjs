// Builds dist/index.html: one self-contained file (JS, CSS and fonts inlined) that opens from disk.
// Also writes dist/artifact.html: the same page without the document skeleton, for hosted embedding.
import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
await mkdir(out, { recursive: true });

const js = await build({
  entryPoints: [join(root, 'src/main.js')],
  bundle: true, format: 'iife', minify: true, target: 'es2020', write: false, legalComments: 'none',
});
const script = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

let css = await readFile(join(root, 'styles/main.css'), 'utf8');
const fontRe = /url\('\.\.\/assets\/fonts\/([^']+)'\)/g;
const fonts = new Map();
for (const m of css.matchAll(fontRe)) {
  if (!fonts.has(m[1])) fonts.set(m[1], (await readFile(join(root, 'assets/fonts', m[1]))).toString('base64'));
}
css = css.replace(fontRe, (_, f) => `url(data:font/woff2;base64,${fonts.get(f)})`);

const body = `<canvas id="gl"></canvas>
<canvas id="fx"></canvas>
<div id="ui"></div>`;

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0807">
<title>Stillpoint</title>
<style>${css}</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>
`;
await writeFile(join(out, 'index.html'), page);

const artifact = `<title>Stillpoint</title>
<style>${css}</style>
${body}
<script>${script}</script>
`;
await writeFile(join(out, 'artifact.html'), artifact);
console.log(`dist/index.html ${(page.length / 1024).toFixed(0)} KB`);
