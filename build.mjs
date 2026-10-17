import {readFileSync, writeFileSync} from 'node:fs';
const player = readFileSync(new URL('./src/player.js', import.meta.url), 'utf8');
const library = readFileSync(new URL('./src/library.js', import.meta.url), 'utf8');
const download = readFileSync(new URL('./src/download.js', import.meta.url), 'utf8');
const autoplay = readFileSync(new URL('./src/autoplay.js', import.meta.url), 'utf8');
const releaseLayout = readFileSync(new URL('./src/release-layout.js', import.meta.url), 'utf8');
const mux = readFileSync(new URL('./vendor/mux-mp4.min.js', import.meta.url), 'utf8');
const muxLicense = readFileSync(new URL('./vendor/mux-LICENSE', import.meta.url), 'utf8');
const converter = `/* Bundled mux.js 6.3.0 — https://github.com/videojs/mux.js\n${muxLicense}\n*/\nconst muxmp4 = (() => { const module = {exports:{}}; const exports = module.exports; const require = name => { if (name !== 'global/window') throw new Error('Unexpected mux.js dependency'); return window; };\n${mux}\nreturn module.exports; })();`;
const icon = readFileSync(new URL('./assets/icon.svg', import.meta.url)).toString('base64');
const version = player.match(/@version\s+(\S+)/)[1];
const output = player.replaceAll('__VERSION__', version).replace('  // LIBRARY_MODULE', () => library).replace('  // DOWNLOAD_MODULE', () => converter + '\n' + download).replace('  // AUTOPLAY_MODULE', () => autoplay).replace('  // RELEASE_LAYOUT_MODULE', () => releaseLayout).replaceAll('__ICON__', icon).replace(/\r\n/g, '\n');
const metadata = output.slice(0, output.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length) + '\n';
for (const [name, content] of [['dubtv-plus.user.js', output], ['dubtv-plus.meta.js', metadata]]) {
  const target = new URL(name, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) throw new Error(`${name} is stale: run node build.mjs`);
  } else writeFileSync(target, content);
}
