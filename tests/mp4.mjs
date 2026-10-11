import {readFileSync, writeFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Cancellation removes empty output but preserves committed files and reports denied deletion', async () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../src/download.js', import.meta.url),'utf8'), context);
  let size = 0, aborted = 0, removed = 0;
  const writable = {abort:async()=>{aborted++;}};
  const directory = {getFileHandle:async()=>({getFile:async()=>({size})}),removeEntry:async()=>{removed++;}};
  await context.cleanupDownloadFile(writable,directory,'episode.mp4');
  assert.equal(aborted,1); assert.equal(removed,1);
  size = 1024;
  await context.cleanupDownloadFile(writable,directory,'episode.mp4');
  assert.equal(removed,1);
  size = 0;
  await context.cleanupDownloadFile({abort:async()=>{throw Error('already aborted');}},directory,'episode.mp4');
  assert.equal(removed,2);
  directory.removeEntry = async()=>{throw Error('permission denied');};
  await assert.rejects(context.cleanupDownloadFile(writable,directory,'episode.mp4'),/permission denied/);
  directory.getFileHandle = async()=>{const error=Error('missing');error.name='NotFoundError';throw error;};
  await context.cleanupDownloadFile(writable,directory,'episode.mp4');
});

test('Two TS segments produce one MP4 with audio, video and a finite duration', () => {
  const context = {TextEncoder, TextDecoder, Uint8Array, DataView, window:{BigInt}};
  vm.createContext(context);
  const vendor = readFileSync(new URL('../vendor/mux-mp4.min.js', import.meta.url), 'utf8');
  vm.runInContext(`const module={exports:{}}; const exports=module.exports; const require=()=>window; ${vendor}; const muxmp4=module.exports;` + readFileSync(new URL('../src/download.js', import.meta.url),'utf8'), context);
  const muxer = vm.runInContext('new muxmp4.Transmuxer({remux:true})', context);
  const chunks = []; let init;
  muxer.on('data', part => {
    if (!init) { init = part.initSegment; context.setDownloadDuration(init,2); chunks.push(init); }
    chunks.push(part.data);
  });
  for (const number of ['00','01']) {
    muxer.push(new Uint8Array(readFileSync(new URL(`./fixtures/sample-${number}.ts`, import.meta.url)))); muxer.flush();
  }
  muxer.dispose();
  assert.equal(chunks.length,3);
  assert.equal(Buffer.from(init.subarray(4,8)).toString(),'ftyp');
  const tracks = vm.runInContext('muxmp4.probe.tracks',context)(init);
  assert.deepEqual(Array.from(tracks,t=>t.type).sort(),['audio','video']);
  const movie = Buffer.from(init); const mvhd = movie.indexOf('mvhd');
  assert.equal(movie.readUInt32BE(mvhd+20)/movie.readUInt32BE(mvhd+16),2);
  assert.ok(chunks.slice(1).every(part=>Buffer.from(part.subarray(4,8)).toString()==='moof'));
  if (process.env.DUBTV_MP4_TEST_OUTPUT) writeFileSync(process.env.DUBTV_MP4_TEST_OUTPUT,Buffer.concat(chunks.map(part=>Buffer.from(part))));
});
