// Runs every browser test page in headless Chrome or Edge and fails if any page title reports FAIL.
// Usage: node tests/browser.mjs [page filter]. BROWSER_CHANNEL=chrome|msedge picks the installed browser.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, normalize, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';

// Order matters: pages share cookies and localStorage, and ?persisted reads what the previous page saved.
const pages = [
  'player.html',
  'qol.html',
  'library.html',
  'library.html?catalogFail',
  'library.html?relatedOnly',
  'ongoing.html?integrated',
  'ongoing.html?integrated&navigation',
  'action-settings.html',
  'action-settings.html?persisted',
  'catalog-mobile.html?integrated',
  'fullscreen.html',
  'download.html',
  'download-cache.html',
  'download-lifecycle.html?integrated&deferred',
  'download-lifecycle.html?integrated&deferred&drop-init',
  'download-lifecycle.html?integrated&deferred&worker',
  'download-lifecycle.html?integrated&deferred&blob-first',
  'download-lifecycle.html?integrated&deferred&idb-blob-empty',
  'autoplay.html',
  'release-layout.html',
  'release-layout.html?integrated',
  'release-layout.html?touch',
].filter(page => page.includes(process.argv[2] ?? ''));

const root = fileURLToPath(new URL('..', import.meta.url));
const types = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml', '.ts':'video/mp2t', '.m3u8':'application/vnd.apple.mpegurl'};
const server = createServer(async (request, response) => {
  const path = normalize(root + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
  try {
    if (!path.startsWith(root) || path.includes(`${sep}.git${sep}`)) throw Error('outside');
    const body = await readFile(path);
    response.writeHead(200, {'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store'}).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const channels = process.env.BROWSER_CHANNEL ? [process.env.BROWSER_CHANNEL] : ['chrome', 'msedge'];
let browser;
for (const channel of channels) {
  try { browser = await chromium.launch({channel}); break; } catch (error) { if (channel === channels.at(-1)) throw error; }
}
const context = await browser.newContext();
let failures = 0;
for (const name of pages) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let title;
  try {
    await page.goto(`${origin}/tests/${name}`);
    await page.waitForFunction(() => /^(?:PASS|FAIL)/.test(document.title), null, {timeout: 60000});
    title = await page.title();
  } catch { title = 'FAIL: no result within 60 seconds'; }
  const passed = title.startsWith('PASS');
  console.log(`${passed ? 'ok  ' : 'FAIL'} ${name} — ${title}`);
  if (!passed) {
    failures++;
    for (const line of await page.$$eval('#results li', items => items.map(li => li.textContent).filter(text => !text.startsWith('PASS')))) console.log(`     ${line}`);
    for (const error of errors) console.log(`     page error: ${error}`);
  }
  await page.close();
}
await browser.close();
server.close();
console.log(`${pages.length - failures} of ${pages.length} pages passed`);
process.exitCode = failures ? 1 : 0;
