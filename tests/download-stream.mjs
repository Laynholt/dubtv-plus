import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

function context(fetch) {
  const scope=vm.createContext({TextEncoder,TextDecoder,URL,AbortController,DOMException,setTimeout,clearTimeout,fetch,location:{href:'https://dubtv.pro/release/test'}});
  vm.runInContext(readFileSync(new URL('../src/library.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../src/download.js',import.meta.url),'utf8'),scope);
  return scope;
}
function page(episodes,isLicensed=false){return {scripts:[{textContent:'self.__next_f.push('+JSON.stringify([1,'1:'+JSON.stringify({release:{slug:'test',titleRu:'Тайтл',isLicensed,episodes}})+'\n'])+')'}]};}

test('Current site metadata retains playable episodes with a deferred stream URL',()=>{
  const scope=context();
  const result=scope.readDownloadRelease(page([
    {id:'episode-2',episodeNumber:2,hasVideo:true,videoUrlM3u8:''},
    {id:'episode-1',episodeNumber:1,hasVideo:true,videoUrlM3u8:''},
    {id:'unreleased',episodeNumber:3,hasVideo:false,videoUrlM3u8:''},
    {episodeNumber:4,hasVideo:true,videoUrlM3u8:''},
  ]),'/release/test');
  assert.ok(result,'The new hasVideo format must not be rejected as missing video');
  assert.deepEqual(Array.from(result.episodes,e=>e.id),['episode-1','episode-2']);
  assert.equal(scope.readDownloadRelease(page([{id:'episode-1',episodeNumber:1,hasVideo:true}],true),'/release/test'),undefined);
  assert.equal(scope.readDownloadRelease(page([{episodeNumber:1,videoUrlM3u8:'https://cdn.example/legacy.m3u8'}]),'/release/test').episodes.length,1);
});

test('Deferred streams use the native authenticated endpoint and are resolved again for retries',async()=>{
  const calls=[];const scope=context(async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({url:'https://cdn.example/master.m3u8?attempt='+calls.length})};});
  assert.equal(typeof scope.downloadEpisodeUrl,'function');
  const episode={id:'episode-1',hasVideo:true,videoUrlM3u8:''},signal=new AbortController().signal;
  assert.equal(await scope.downloadEpisodeUrl(episode,signal),'https://cdn.example/master.m3u8?attempt=1');
  assert.equal(await scope.downloadEpisodeUrl(episode,signal),'https://cdn.example/master.m3u8?attempt=2');
  assert.equal(calls[0].url,'/api/episodes/episode-1/stream');
  assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.cache,'no-store');
  assert.ok(calls[0].options.signal);
  assert.equal(await scope.downloadEpisodeUrl({videoUrlM3u8:'https://cdn.example/legacy.m3u8'},signal),'https://cdn.example/legacy.m3u8');
  assert.equal(calls.length,2);
});

test('Stream API failures, unsafe URLs and cancellation remain visible',async()=>{
  let reply={ok:false,status:403,json:async()=>({error:'Видео недоступно в вашем регионе'})};
  const scope=context(async()=>reply);assert.equal(typeof scope.downloadEpisodeUrl,'function');
  const episode={id:'episode-1',hasVideo:true},signal=new AbortController().signal;
  await assert.rejects(scope.downloadEpisodeUrl(episode,signal),/Видео недоступно в вашем регионе/);
  reply={ok:true,json:async()=>({url:'javascript:alert(1)'})};await assert.rejects(scope.downloadEpisodeUrl(episode,signal),/Неподдерживаемый адрес/);
  reply={ok:true,json:async()=>({})};await assert.rejects(scope.downloadEpisodeUrl(episode,signal),/ссылку/);
  const controller=new AbortController();controller.abort();await assert.rejects(scope.downloadEpisodeUrl(episode,controller.signal),{name:'AbortError'});
});
