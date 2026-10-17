import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Release metadata matches the installable script and keeps its identity', () => {
  const script = readFileSync(new URL('../dubtv-plus.user.js', import.meta.url), 'utf8');
  const meta = readFileSync(new URL('../dubtv-plus.meta.js', import.meta.url), 'utf8');
  assert.ok(script.startsWith(meta));
  assert.match(meta, /@name\s+DubTV\+\n/);
  assert.match(meta, /@namespace\s+dubtv-plus\n/);
  assert.match(meta, /@author\s+laynholt\n/);
  assert.match(meta, /@downloadURL\s+https:\/\/github\.com\/Laynholt\/dubtv-plus\/releases\/latest\/download\/dubtv-plus\.user\.js\n/);
  assert.match(meta, /@updateURL\s+https:\/\/github\.com\/Laynholt\/dubtv-plus\/releases\/latest\/download\/dubtv-plus\.meta\.js\n/);
  const icon = meta.match(/@icon\s+data:image\/svg\+xml;base64,(\S+)/)[1];
  assert.equal(Buffer.from(icon, 'base64').toString(), readFileSync(new URL('../assets/icon.svg', import.meta.url), 'utf8'));
  const version = meta.match(/@version\s+(\S+)/)[1];
  assert.ok(script.includes(`<h3>DubTV+ · ${version}</h3>`) && script.includes(`DubTV+: ${version}\\n`));
  assert.ok(!script.includes('__ICON__') && !script.includes('__VERSION__') && !script.includes('// LIBRARY_MODULE') && !script.includes('// DOWNLOAD_MODULE') && !script.includes('// AUTOPLAY_MODULE') && !script.includes('// RELEASE_LAYOUT_MODULE'));
});
