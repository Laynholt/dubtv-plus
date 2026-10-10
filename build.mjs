import {readFileSync, writeFileSync} from 'node:fs';
const player = readFileSync(new URL('./src/player.js', import.meta.url), 'utf8');
const library = readFileSync(new URL('./src/library.js', import.meta.url), 'utf8');
const icon = readFileSync(new URL('./assets/icon.svg', import.meta.url)).toString('base64');
const output = player.replace('  // LIBRARY_MODULE', library).replaceAll('__ICON__', icon);
const metadata = output.slice(0, output.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length) + '\n';
for (const [name, content] of [['dubtv-plus.user.js', output], ['dubtv-plus.meta.js', metadata]]) {
  const target = new URL(name, import.meta.url);
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== content) throw new Error(`${name} is stale: run node build.mjs`);
  } else writeFileSync(target, content);
}
