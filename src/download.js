function readDownloadRelease(doc, pathname) {
  const slug = pathname.match(/^\/release\/([a-z0-9-]+)\/?$/)?.[1];
  if (!slug) return;
  for (const item of pageObjects(doc)) {
    if (item.slug !== slug || typeof item.titleRu !== 'string' || !Array.isArray(item.episodes)) continue;
    if(item.isLicensed===true)return;
    const episodes = item.episodes.filter(e => Number.isSafeInteger(e?.episodeNumber) && e.episodeNumber > 0 && (typeof e.videoUrlM3u8 === 'string' && e.videoUrlM3u8.trim() || e.hasVideo===true&&typeof e.id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(e.id)));
    if (episodes.length) return {title: item.titleRu, episodes: episodes.sort((a,b) => a.episodeNumber-b.episodeNumber)};
  }
}

function downloadUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Неподдерживаемый адрес видео.');
  return url.href;
}

async function downloadEpisodeUrl(episode, signal) {
  signal.throwIfAborted();
  if(typeof episode.videoUrlM3u8==='string'&&episode.videoUrlM3u8.trim())return downloadUrl(episode.videoUrlM3u8,location.href);
  if(episode.hasVideo!==true||typeof episode.id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(episode.id))throw Error('Не удалось определить серию для скачивания.');
  const controller=new AbortController(),cancel=()=>controller.abort();
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  const timer=setTimeout(cancel,10000);
  try{
    const response=await fetch('/api/episodes/'+encodeURIComponent(episode.id)+'/stream',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    controller.signal.throwIfAborted();
    if(!response.ok)throw Error(typeof data.error==='string'?data.error.slice(0,300):`Ошибка сервера: ${response.status}.`);
    if(typeof data.url!=='string'||!data.url.trim())throw Error('Сервер не вернул ссылку на видео.');
    return downloadUrl(data.url,location.href);
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
}

function parseDownloadPlaylist(text, url) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Сервер не вернул видеоплейлист.');
  // shortcut: support unencrypted MPEG-TS VOD only; other HLS formats need separate handling.
  if (lines.some(line => /^#EXT-X-(?:MAP:|BYTERANGE:|DISCONTINUITY(?:$|:)|I-FRAMES-ONLY)/.test(line)
    || (line.startsWith('#EXT-X-KEY:') && !/^#EXT-X-KEY:METHOD=NONE\s*$/.test(line))
    || (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line) && /URI=/.test(line)))) {
    throw new Error('Этот формат HLS пока не поддерживается для скачивания.');
  }
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const height = Number(lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1]);
    if (!height || !lines[i+1] || lines[i+1].startsWith('#')) throw new Error('Не удалось определить качество видео.');
    variants.push({height, url: downloadUrl(lines[++i], url)});
  }
  if (variants.length) return {variants: variants.sort((a,b) => b.height-a.height)};
  const segments = lines.filter(line => !line.startsWith('#')).map(line => downloadUrl(line, url));
  if (!lines.includes('#EXT-X-ENDLIST') || !segments.length || segments.length > 10000 || !lines.some(line => line.startsWith('#EXTINF:'))) {
    throw new Error('Нужен завершённый плейлист серии.');
  }
  const duration = lines.filter(line => line.startsWith('#EXTINF:')).reduce((total,line) => total + Number(line.slice(8).split(',')[0]), 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Не удалось определить длительность серии.');
  return {segments, duration};
}

async function downloadRead(url, signal, text = false, limit = 32 * 1024 * 1024) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener('abort', cancel, {once:true});
  if (signal.aborted) cancel();
  const timer = setTimeout(cancel, 45000);
  try {
    const response = await fetch(url, {signal:controller.signal, credentials:'omit', cache:'no-store'});
    if (!response.ok) throw new Error(`Ошибка сервера: ${response.status}.`);
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Лимит памяти достигнут. Выберите меньшее качество или скачайте на ПК в папку.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    if (text) return new TextDecoder().decode(bytes);
    if (!size || size % 188 || bytes[0] !== 0x47 || (size > 188 && bytes[188] !== 0x47)) throw new Error('Фрагмент не является MPEG-TS видео.');
    return bytes;
  } catch (error) {
    if (controller.signal.aborted && !signal.aborted) throw new Error('Сервер не ответил за 45 секунд. Попробуйте снова.');
    throw error;
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', cancel);
  }
}

function setDownloadDuration(init, duration) {
  const view = new DataView(init.buffer, init.byteOffset, init.byteLength);
  let movieScale = 90000;
  function walk(start, end) {
    for (let offset = start; offset < end;) {
      const size = view.getUint32(offset);
      if (size < 8 || offset + size > end) throw new Error('Некорректный заголовок MP4.');
      const type = String.fromCharCode(...init.subarray(offset+4, offset+8));
      if (['moov','trak','mdia'].includes(type)) walk(offset+8, offset+size);
      else if (['mvhd','mdhd','tkhd'].includes(type)) {
        if (init[offset+8] !== 0) throw new Error('Неподдерживаемый заголовок MP4.');
        const scale = type === 'tkhd' ? movieScale : view.getUint32(offset+20);
        if (type === 'mvhd') movieScale = scale;
        // The muxer writes an indefinite duration; an offline file needs the playlist's actual duration.
        view.setUint32(offset + (type === 'tkhd' ? 28 : 24), Math.round(duration * scale));
      }
      offset += size;
    }
  }
  walk(0, init.length);
}

function currentDownloadEpisode(release) {
  const current = currentEpisodeLabel();
  return current ? release.episodes.find(e => e.episodeNumber === Number(current.match(/\d+/)[0]))
    : release.episodes.length === 1 ? release.episodes[0] : undefined;
}

async function cleanupDownloadFile(writable, directory, name) {
  if (writable) { try { await writable.abort(); } catch { /* A completed stream cannot be aborted. */ } }
  if (!directory || !name) return;
  try {
    const file = await directory.getFileHandle(name);
    // Writes become visible only on close; preserve files completed before cancellation.
    if ((await file.getFile()).size === 0) await directory.removeEntry(name);
  } catch (error) { if (error.name !== 'NotFoundError') throw error; }
}

function downloadCacheWorker() {
  let access, offset=0;
  self.onmessage=async({data})=>{
    try {
      if(data.action==='open')access=await data.file.createSyncAccessHandle();
      if(data.action==='write'){
        let written=0;
        while(written<data.bytes.length){const count=access.write(data.bytes.subarray(written),{at:offset});if(!count)throw Error('Не удалось записать видео.');written+=count;offset+=count;}
      }
      if(data.action==='close'){access.flush();access.close();access=undefined;}
      if(data.action==='abort'){access?.close();access=undefined;}
      self.postMessage({ok:true});
    }catch(error){self.postMessage({error:error.message});}
  };
}

function openDownloadDatabase() {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('dubtv-plus-downloads',1);let settled=false;
    const timer=setTimeout(()=>{settled=true;reject(Error('Хранилище не ответило за 10 секунд.'));},10000);
    request.onupgradeneeded=()=>request.result.createObjectStore('parts');
    request.onsuccess=()=>{clearTimeout(timer);if(settled){request.result.close();return;}settled=true;resolve(request.result);};
    request.onerror=()=>{clearTimeout(timer);settled=true;reject(request.error);};
    request.onblocked=()=>{clearTimeout(timer);settled=true;reject(Error('Хранилище занято другой вкладкой.'));};
  });
}

async function cleanupDownloadCaches() {
  // A live owner holds its lock until removal; closing a tab releases the lock automatically.
  // shortcut: without Web Locks, skip orphan recovery; add leases if older browsers need it.
  if(typeof navigator.locks?.request!=='function')return;
  const ids=new Set(),uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
  let directory,db;const errors=[];
  try{
    try{directory=await(await navigator.storage.getDirectory()).getDirectoryHandle('dubtv-plus-downloads');for await(const name of directory.keys())if(name.endsWith('.mp4')&&uuid.test(name.slice(0,-4)))ids.add(name.slice(0,-4));}
    catch(error){if(error.name!=='NotFoundError'&&typeof navigator.storage?.getDirectory==='function')errors.push(error);}
    try{db=await openDownloadDatabase();const keys=await new Promise((resolve,reject)=>{const tx=db.transaction('parts'),request=tx.objectStore('parts').getAllKeys();tx.oncomplete=()=>resolve(request.result);tx.onabort=()=>reject(tx.error);});for(const key of keys)if(Array.isArray(key)&&uuid.test(key[0]))ids.add(key[0]);}
    catch(error){errors.push(error);}
    for(const id of ids)await navigator.locks.request('dubtv-plus-download:'+id,{ifAvailable:true},async lock=>{
      if(!lock)return;
      if(directory)try{await directory.removeEntry(id+'.mp4');}catch(error){if(error.name!=='NotFoundError')errors.push(error);}
      if(db)try{await new Promise((resolve,reject)=>{const tx=db.transaction('parts','readwrite');tx.objectStore('parts').delete(IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]));tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}catch(error){errors.push(error);}
    });
  }finally{db?.close();}
  if(errors.length)throw Error(errors.map(error=>error.message).join(' '));
}

async function createDownloadDatabaseCache(id) {
  const db=await openDownloadDatabase();
  db.onversionchange=()=>db.close();
  const range=IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
  function transact(mode,action){
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('parts',mode);let request;
      tx.oncomplete=()=>resolve(request?.result);
      tx.onabort=()=>reject(tx.error??Error('Не удалось записать временное видео.'));
      try{request=action(tx.objectStore('parts'));}catch(error){tx.abort();reject(error);}
    });
  }
  try{await transact('readwrite',store=>{store.put(new Uint8Array(0),[id,-1]);return store.delete([id,-1]);});}
  catch(error){db.close();throw error;}
  const sizes=[];let queue=Promise.resolve(),closing=false,removal;
  const enqueue=action=>{const response=queue.then(action);queue=response.catch(()=>{});return response;};
  return {
    kind:'indexeddb',
    // Safari can return stored Blobs with the right size but unreadable contents; store a byte snapshot instead.
    write(bytes){if(closing)throw Error('Загрузка уже закрыта.');const part=bytes.slice();return enqueue(async()=>{await transact('readwrite',store=>store.put(part,[id,sizes.length]));sizes.push(part.byteLength);});},
    finish(){if(closing)throw Error('Загрузка уже закрыта.');return enqueue(async()=>{
      const parts=[];
      // Read each known key so a bulk result cannot silently omit the first fragment.
      for(let index=0;index<sizes.length;index++){
        const part=await transact('readonly',store=>store.get([id,index]));
        if(!(part instanceof Uint8Array)||part.byteLength!==sizes[index])throw Error(`IndexedDB: фрагмент ${index+1} из ${sizes.length}: ожидалось ${sizes[index]} байт, прочитано ${part?.byteLength??0}.`);
        parts.push(new Blob([part]));
      }
      // An empty byte prefix avoids Safari dropping the first Blob during assembly.
      const expected=sizes.reduce((total,size)=>total+size,0),output=new Blob([new Uint8Array(0),...parts],{type:'video/mp4'});
      if(output.size!==expected)throw Error(`IndexedDB: прочитано ${parts.length} фрагментов (${expected} байт), после сборки ${output.size} байт.`);
      return output;
    });},
    remove(){closing=true;return removal??=enqueue(()=>transact('readwrite',store=>store.delete(range))).finally(()=>db.close());},
  };
}

async function createDownloadCache(onUnavailable=()=>{}) {
  const id=crypto.randomUUID();let unlock;
  if(typeof navigator.locks?.request==='function'){
    try{unlock=await new Promise((resolve,reject)=>{navigator.locks.request('dubtv-plus-download:'+id,()=>new Promise(release=>resolve(release))).catch(reject);});}
    catch(error){onUnavailable(error.message);return;}
  }
  try{
    const cache=await createDownloadCacheStorage(id,onUnavailable);
    if(!cache){unlock?.();return;}
    const remove=cache.remove;let removal;
    cache.remove=()=>removal??=Promise.resolve().then(()=>remove()).finally(()=>unlock?.());
    return cache;
  }catch(error){unlock?.();throw error;}
}

async function createDownloadCacheStorage(id,onUnavailable) {
  const errors=[],firstSize=2*1024*1024,expected=firstSize+65536;
  for(const [label,create] of [['Файлы',createDownloadFileCache],['База',createDownloadDatabaseCache]]){
    let probe;
    try{
      // Verify the first append and exported bytes before committing a whole episode to this backend.
      probe=await create(id);
      await probe.write(new Uint8Array(firstSize).fill(0x47));
      await probe.write(new Uint8Array(65536).fill(0xa5));
      const bytes=new Uint8Array(await(await probe.finish()).arrayBuffer());
      if(bytes.length!==expected||!bytes.every((byte,index)=>byte===(index<firstSize?0x47:0xa5)))throw Error(`Проверка записи: ожидалось ${expected} байт, прочитано ${bytes.length}; данные не совпадают.`);
      await probe.remove();probe=undefined;
      return await create(id);
    }catch(error){
      try{await probe?.remove();}catch(cleanup){errors.push(`${label}: очистка: ${cleanup.message}.`);}
      errors.push(`${label}: ${error.name}: ${error.message}.`);
    }
  }
  onUnavailable(errors.join(' '));
}

async function createDownloadFileCache(id) {
  let directory, name, worker, writable, workerURL;
  try {
    if(typeof navigator.storage?.getDirectory!=='function')throw Error('API временных файлов недоступен.');
    directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('dubtv-plus-downloads',{create:true});
    name=id+'.mp4';
    const file=await directory.getFileHandle(name,{create:true});
    if(typeof file.createWritable==='function')writable=await file.createWritable();
    else {
      workerURL=URL.createObjectURL(new Blob([`(${downloadCacheWorker.toString()})()`],{type:'text/javascript'}));
      worker=new Worker(workerURL);
      let queue=Promise.resolve(),workerError;
      const send=data=>{
        const response=queue.then(()=>new Promise((resolve,reject)=>{
          if(workerError){reject(workerError);return;}
          worker.onmessage=({data:reply})=>reply.ok?resolve():reject(Error(reply.error));
          worker.onerror=event=>{workerError=Error(event.message||'Не удалось записать временный файл.');reject(workerError);};
          worker.postMessage(data);
        }));
        queue=response.catch(()=>{});return response;
      };
      await send({action:'open',file});
      writable={write:bytes=>send({action:'write',bytes}),close:()=>send({action:'close'}),abort:()=>send({action:'abort'})};
    }
    let closed=false;
    return {
      kind:'filesystem',
      write:bytes=>writable.write(bytes),
      async finish(){await writable.close();closed=true;const completed=await file.getFile();return completed.slice(0,completed.size,'video/mp4');},
      async remove(){if(!closed){try{await writable.abort();}catch{/* Always remove the temporary file, including after a failed write. */}finally{closed=true;}}worker?.terminate();await directory.removeEntry(name);},
    };
  }catch(error){
    worker?.terminate();if(directory&&name)try{await directory.removeEntry(name);}catch{/* Private storage may be unavailable. */}
    throw error;
  }finally{if(workerURL)URL.revokeObjectURL(workerURL);}
}

function createDownloadTools(panel) {
  const progressMarkup = '<section class="dtvp-transfer" hidden><div class="dtvp-transfer-heading"><strong data-episode></strong><span data-queue></span></div><div class="dtvp-transfer-details"><span data-quality></span><span data-size></span></div><div class="dtvp-transfer-meter"><progress max="100" aria-label="Загрузка текущей серии"></progress><span data-percent>—</span></div></section>';
  const dialog = document.createElement('dialog');
  dialog.id = 'dubtv-plus-download'; dialog.className = 'dtvp-dialog';
  dialog.setAttribute('aria-label', 'Скачать серии');
  dialog.innerHTML = '<form><h2>Скачать серии</h2><p data-title></p><div class="dtvp-download-fields"><label class="dtvp-field">Серия<select name="episode"></select></label><label class="dtvp-field">Качество<select name="quality"><option value="max">Максимальное</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label></div>' + progressMarkup + '<p role="status" aria-live="polite"></p><p class="dtvp-download-note">MP4 · На ПК — в выбранную папку. В Safari — по одной серии. При доступном временном хранилище лимита 256 МБ нет.</p><div class="dtvp-actions"><button type="button" data-cancel>Закрыть</button><a data-save hidden>Скачать файл</a><button type="button" data-next hidden>Продолжить</button><button type="submit" class="dtvp-primary">Скачать</button></div></form>';
  const toast = document.createElement('div'); toast.id = 'dubtv-plus-download-progress'; toast.hidden = true;
  toast.innerHTML = '<div class="dtvp-transfer-title">Скачивание серии</div>' + progressMarkup + '<div role="status" aria-live="polite"></div><div class="dtvp-transfer-actions"><a hidden>Скачать файл</a><button type="button">Закрыть</button></div>';
  const style = document.createElement('style');
  style.textContent = '#dubtv-plus-download-progress{position:fixed;top:16px;right:16px;z-index:10002;width:min(360px,calc(100vw - 32px));box-sizing:border-box;background:var(--color-surface,#141418);color:var(--color-text-primary,#f0f0f0);border:1px solid var(--color-border,#2a2a32);font:13px/1.5 system-ui;box-shadow:0 4px 24px #0006}#dubtv-plus-download-progress a{display:block;color:var(--color-primary-light,#f08a73);}#dubtv-plus-download-progress button{display:block;background:var(--color-surface-hover,#1c1c22);color:inherit;border:0;border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}#dubtv-plus-download-progress :focus-visible{outline:2px solid #f08a73;outline-offset:2px}';
  style.textContent += `
    #dubtv-plus-download-progress [hidden]{display:none!important}
    #dubtv-plus-download-progress .dtvp-transfer-actions{flex-wrap:wrap}
    #dubtv-plus-download-open{display:inline-flex;align-items:center;gap:8px;font-weight:600;margin-top:6px}#dubtv-plus-download-open[hidden]{display:none!important}
    #dubtv-plus-download .dtvp-download-fields{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:16px}
    #dubtv-plus-download .dtvp-download-note{font-size:12px;margin:16px 0 0;line-height:1.6}
    #dubtv-plus-download [data-title]{margin-bottom:20px}
    .dtvp-transfer{padding:16px;background:var(--color-background,#0a0a0c);border:1px solid var(--color-border,#2a2a32);border-radius:10px;margin-top:8px}
    .dtvp-transfer[hidden]{display:none!important}.dtvp-transfer-heading,.dtvp-transfer-details,.dtvp-transfer-meter{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
    .dtvp-transfer-heading strong{font-size:16px;font-weight:600}.dtvp-transfer-heading [data-queue]{color:var(--color-text-secondary,#9a9aaa);font-size:12px;white-space:nowrap}
    .dtvp-transfer-details{font-size:12px;color:var(--color-text-secondary,#9a9aaa);margin-top:6px}.dtvp-transfer-meter{margin-top:14px}
    .dtvp-transfer progress{appearance:none;display:block;height:6px;min-width:0;width:100%;overflow:hidden;border:0;border-radius:99px;background:var(--color-border,#2a2a32);accent-color:var(--color-primary,#d6381c)}
    .dtvp-transfer progress::-webkit-progress-bar{background:var(--color-border,#2a2a32);border-radius:99px}.dtvp-transfer progress::-webkit-progress-value{background:var(--color-primary,#d6381c);border-radius:99px}.dtvp-transfer progress::-moz-progress-bar{background:var(--color-primary,#d6381c);border-radius:99px}
    .dtvp-transfer [data-percent]{min-width:38px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums}.dtvp-transfer-title{font-weight:600;font-size:14px;margin-bottom:12px}
    #dubtv-plus-download-progress{padding:18px;border-radius:12px;font-family:inherit}#dubtv-plus-download-progress .dtvp-transfer{background:transparent;padding:0;border:0}
    #dubtv-plus-download-progress [role=status]{margin-top:12px;color:var(--color-text-secondary,#9a9aaa);font-size:12px}#dubtv-plus-download-progress [role=status]:empty{display:none}
    #dubtv-plus-download-progress .dtvp-transfer-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;margin-top:16px}#dubtv-plus-download-progress .dtvp-transfer-actions button,#dubtv-plus-download-progress .dtvp-transfer-actions a{margin:0}
    @media(max-width:480px){#dubtv-plus-download .dtvp-download-fields{grid-template-columns:minmax(0,1fr);gap:0}}
  `;
  document.head.append(style); document.body.append(dialog, toast);
  const episodeChoice = dialog.querySelector('[name=episode]');
  const qualityChoice = dialog.querySelector('[name=quality]');
  const start = dialog.querySelector('[type=submit]');
  const close = dialog.querySelector('[data-cancel]');
  const save = dialog.querySelector('[data-save]');
  const next = dialog.querySelector('[data-next]');
  const status = dialog.querySelector('[role=status]');
  const toastStatus = toast.querySelector('[role=status]');
  const toastSave = toast.querySelector('a');
  const toastClose = toast.querySelector('button');
  function showProgress(root, episode, index, total, quality, bytes, percent) {
    const box = root.querySelector('.dtvp-transfer'); box.hidden = false;
    box.querySelector('[data-episode]').textContent = `Серия ${episode.episodeNumber}`;
    box.querySelector('[data-queue]').textContent = `${index + 1} из ${total}`;
    box.querySelector('[data-quality]').textContent = `${quality ? `${quality}p` : 'Исходное качество'} · MP4`;
    box.querySelector('[data-size]').textContent = `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
    box.querySelector('[data-percent]').textContent = percent === undefined ? '—' : `${percent}%`;
    const bar = box.querySelector('progress');
    if (percent === undefined) bar.removeAttribute('value'); else bar.value = percent;
  }
  function positionToast() {
    const fullscreen = document.fullscreenElement;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    if (toast.parentElement !== parent) parent.append(toast);
  }
  document.addEventListener('fullscreenchange', positionToast);
  const open = document.createElement('button');
  open.type = 'button'; open.id = 'dubtv-plus-download-open'; open.className = 'dtvp-primary'; open.textContent = 'Скачать серии'; panel.append(open);
  const quick = document.createElement('button'); quick.type = 'button'; quick.id = 'dubtv-plus-download-current';
  quick.setAttribute('aria-label', 'Скачать текущую серию');
  quick.innerHTML = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4"/></svg>';
  open.prepend(quick.firstElementChild.cloneNode(true));
  quick.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:36px;height:40px;flex-shrink:0';
  let release, releasePath, loading, attemptedPath, operation, pendingSave, blobUrl, quickMode = false, opening = 0, cachedFile, completedFile, browserHandoff=false, recoveryError='';
  const recovery = cleanupDownloadCaches().catch(error=>{recoveryError=error.message;});
  function controls() {
    const busy = !!operation || !!completedFile;
    if (start.hidden !== busy) start.hidden = busy;
    for (const [element, disabled] of [[start,busy || !release || releasePath !== location.pathname],[quick,busy || !release || releasePath !== location.pathname],[episodeChoice,busy || !!loading],[qualityChoice,busy || !!loading]]) {
      if (element.disabled !== disabled) element.disabled = disabled;
    }
    if(open.disabled!==busy)open.disabled=busy;
    for (const element of [close,toastClose]) { const text = operation ? 'Отменить' : 'Закрыть'; if (element.textContent !== text) element.textContent = text; }
  }
  async function clearBlob() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    browserHandoff=false;
    blobUrl = completedFile = undefined; save.hidden = next.hidden = toastSave.hidden = true;
    save.removeAttribute('href'); toastSave.removeAttribute('href');
    const previous=cachedFile;cachedFile=undefined;await previous?.remove();controls();
  }
  function cleanupWarning(error){const message='Не удалось очистить временные данные. Перезагрузите страницу для повторной очистки. '+error.message;status.textContent=toastStatus.textContent=message;}
  function stop() { operation?.abort(); pendingSave?.(); pendingSave = undefined; clearBlob().catch(cleanupWarning); }
  const keepExport=()=>!!completedFile&&browserHandoff;
  window.addEventListener('pagehide',()=>{if(!keepExport())stop();});
  // The site reloads the whole page when a title opens, which ends the download; meanwhile links open in a new tab.
  document.addEventListener('click', event => {
    if (!operation && !completedFile || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href]');
    if (!link || toast.contains(link) || dialog.contains(link) || link.hasAttribute('download') || link.target && link.target !== '_self') return;
    const url = new URL(link.href, location.href);
    if (!/^https?:$/.test(url.protocol) || url.href.split('#')[0] === location.href.split('#')[0]) return;
    event.preventDefault(); event.stopImmediatePropagation();
    window.open(url.href, '_blank', 'noopener');
    if (!toast.hidden && !toastStatus.textContent) toastStatus.textContent = 'Пока идёт загрузка, ссылки открываются в новой вкладке.';
  }, true);
  window.addEventListener('beforeunload', event => { if (operation || completedFile) event.preventDefault(); });
  close.onclick = () => { if (!quickMode) stop(); dialog.close(); };
  toastClose.onclick = () => { stop(); toast.hidden = true; };
  dialog.addEventListener('cancel', () => { if (!quickMode) stop(); });
  dialog.addEventListener('close', () => { if (!quickMode) stop(); });
  async function prepare(force = false) {
    const path = location.pathname;
    if (release && releasePath === path) return release;
    if (loading?.path === path) return loading.promise;
    if (attemptedPath === path && !force) return;
    loading?.controller.abort();
    const request = {path, controller:new AbortController()}; loading = request; attemptedPath = path;
    const timer = setTimeout(() => request.controller.abort(), 10000);
    request.promise = (async () => {
      let data = readDownloadRelease(document, path);
      if (!data) {
        const response = await fetch(path, {credentials:'same-origin', signal:request.controller.signal});
        if (!response.ok) throw new Error(`Не удалось получить серии: ${response.status}.`);
        data = readDownloadRelease(new DOMParser().parseFromString(await response.text(), 'text/html'), path);
      }
      request.controller.signal.throwIfAborted();
      if (!data) throw new Error('Не удалось найти доступные серии в данных страницы. Обновите страницу; возможно, изменился формат сайта.');
      if (location.pathname !== path) return;
      release = data; releasePath = path;
      return data;
    })().finally(() => { clearTimeout(timer); if (loading === request) loading = undefined; controls(); });
    return request.promise;
  }
  open.addEventListener('click', async () => {
    if (operation || completedFile) return;
    const generation = ++opening;
    await clearBlob().catch(cleanupWarning); toast.hidden = true; dialog.querySelector('.dtvp-transfer').hidden = true; episodeChoice.replaceChildren(); qualityChoice.value = 'max';
    dialog.querySelector('[data-title]').textContent = ''; status.textContent = 'Загружаю список серий…'; dialog.showModal(); controls();
    const path = location.pathname;
    try {
      const data = await prepare(true);
      if (!dialog.open || path !== location.pathname || generation !== opening) return;
      if (!data) throw new Error('Не удалось получить список серий.');
      dialog.querySelector('[data-title]').textContent = data.title;
      episodeChoice.add(new Option(`Весь тайтл · серий: ${data.episodes.length}`, 'all'));
      for (const episode of data.episodes) episodeChoice.add(new Option(`Серия ${episode.episodeNumber}`, String(episode.episodeNumber)));
      episodeChoice.value = String(currentDownloadEpisode(data)?.episodeNumber ?? data.episodes[0].episodeNumber);
      status.textContent = '';
    } catch (error) { if (dialog.open && generation === opening) status.textContent = error.name === 'AbortError' ? 'Список серий не загрузился. Попробуйте снова.' : error.message; }
    finally { if (generation === opening) controls(); }
  });
  function browserSave(){
    browserHandoff=true;
    if(pendingSave){next.hidden=false;status.textContent='После сохранения MP4 нажмите «Продолжить».';}
    else toastStatus.textContent='Сохраните файл в меню браузера. После завершения загрузки можно закрыть этот индикатор.';
  }
  for(const link of [save,toastSave])link.addEventListener('click',event=>{if(!completedFile)event.preventDefault();else browserSave();});
  next.onclick = () => { save.hidden = next.hidden = true; pendingSave?.(); pendingSave = undefined; };
  async function run(episodes, quality, direct = false) {
    if (operation || completedFile || !release || releasePath !== location.pathname || !episodes.length) return;
    quickMode = direct;
    const targetStatus = direct ? toastStatus : status;
    const targetRoot = direct ? toast : dialog;
    targetRoot.querySelector('.dtvp-transfer').hidden = true;
    if (direct) { positionToast(); toast.hidden = false; }
    const controller = new AbortController(); operation = controller; controls(); targetStatus.textContent = 'Подготовка загрузки…';
    let writable, createdFile, directory, transmuxer, cache, acquiring=false, storageError='';
    let cleanup;
    const clean = () => acquiring || !cache&&!writable&&!createdFile ? Promise.resolve() : cleanup ??= cache ? cache.remove() : cleanupDownloadFile(writable, directory, createdFile);
    // shortcut: pagehide cleanup is best effort; a browser shutdown can interrupt asynchronous deletion.
    const leave = () => { if(keepExport())return;stop(); clean().catch(() => {}); };
    window.addEventListener('pagehide', leave);
    const baseName = release.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g,'').slice(0,100) || 'DubTV';
    try {
      // Pickers must run before fetching to retain user activation; quick download has no custom dialog.
      if (typeof window.showDirectoryPicker === 'function') directory = await window.showDirectoryPicker({mode:'readwrite'});
      await clearBlob();await recovery;
      controller.signal.throwIfAborted();
      for (let index = 0; index < episodes.length; index++) {
        controller.signal.throwIfAborted();
        const episode = episodes[index];
        showProgress(targetRoot, episode, index, episodes.length, quality === 'max' ? 0 : Number(quality), 0);
        targetStatus.textContent = 'Подготовка видео…';
        const masterUrl = await downloadEpisodeUrl(episode, controller.signal);
        let playlist = parseDownloadPlaylist(await downloadRead(masterUrl, controller.signal, true, 2*1024*1024), masterUrl);
        let actualQuality = quality === 'max' ? 0 : Number(quality);
        if (playlist.variants) {
          // Like the player: the nearest lower quality, else the lowest available.
          const variant = quality === 'max' ? playlist.variants[0] : playlist.variants.find(v => v.height <= Number(quality)) ?? playlist.variants.at(-1);
          actualQuality = variant.height;
          playlist = parseDownloadPlaylist(await downloadRead(variant.url, controller.signal, true, 2*1024*1024), variant.url);
        }
        if (!playlist.segments) throw new Error('Вложенные плейлисты не поддерживаются.');
        showProgress(targetRoot, episode, index, episodes.length, actualQuality, 0, 0);
        targetStatus.textContent = '';
        const name = `${baseName} - ${String(episode.episodeNumber).padStart(2,'0')}${actualQuality ? ` - ${actualQuality}p` : ''}.mp4`;
        let file;acquiring=true;
        try{
        if (directory) {
          try { await directory.getFileHandle(name); throw new Error(`Файл «${name}» уже существует. Выберите другую папку.`); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
          controller.signal.throwIfAborted(); file = await directory.getFileHandle(name, {create:true}); createdFile = name;
        }
        controller.signal.throwIfAborted(); if (file) writable = await file.createWritable();
        if(!file)cache=await createDownloadCache(reason=>{storageError=reason;});
        }finally{acquiring=false;}
        controller.signal.throwIfAborted();
        transmuxer = new muxmp4.Transmuxer({remux:true});
        const chunks = []; let size = 0, init, output = [];
        transmuxer.on('data', data => {
          if (!init) {
            init = data.initSegment; setDownloadDuration(init, playlist.duration);
            // Keep track metadata outside temporary storage until the browser file is assembled.
            if (writable) output.push(init); else size += init.length;
          }
          output.push(data.data);
        });
        for (let i = 0; i < playlist.segments.length; i++) {
          const bytes = await downloadRead(playlist.segments[i], controller.signal);
          controller.signal.throwIfAborted(); output = []; transmuxer.push(bytes); transmuxer.flush();
          for (const part of output) {
            size += part.length;
            if (!writable && !cache && size > 256*1024*1024) throw new Error(`Временное хранилище недоступно, а серия больше 256 МБ. Выберите меньшее качество. ${storageError}`);
            if (writable) await writable.write(part); else if(cache)await cache.write(part);else chunks.push(part);
          }
          showProgress(targetRoot, episode, index, episodes.length, actualQuality, size, Math.round((i+1)/playlist.segments.length*100));
        }
        transmuxer.dispose(); transmuxer = undefined;
        controller.signal.throwIfAborted(); if (!init || size <= init.length) throw new Error('Не удалось собрать MP4 из видео и звука.');
        targetStatus.textContent = 'Сохранение MP4…';
        if (writable) { await writable.close(); writable = undefined; createdFile = undefined; }
        else {
          const completed=cache?await cache.finish():new Blob(chunks,{type:'video/mp4'});chunks.length=0;
          controller.signal.throwIfAborted();
          if(completed.size+init.length!==size)throw Error(`Временный файл записался не полностью (${cache?.kind??'память'}: ожидалось ${size-init.length} байт, записано ${completed.size}). Повторите загрузку.`);
          completedFile=new File([init,completed],name,{type:'application/octet-stream'});
          const header=new Uint8Array(await completedFile.slice(0,init.length).arrayBuffer());
          if(completedFile.size!==size||header.length!==init.length||!header.every((byte,index)=>byte===init[index]))throw Error('Не удалось сохранить заголовок MP4. Повторите загрузку.');
          controller.signal.throwIfAborted();
          blobUrl=URL.createObjectURL(completedFile);cachedFile=cache;cache=undefined;
          const link=direct?toastSave:save;link.href=blobUrl;link.download=completedFile.name;link.hidden=false;
          targetStatus.textContent='MP4 готов. Нажмите «Скачать файл».'+(recoveryError?' Не удалось очистить прежние временные данные: '+recoveryError:'');
          if(!direct) { await new Promise(resolve => { pendingSave = resolve; }); controller.signal.throwIfAborted(); await clearBlob(); }
        }
      }
      if(!blobUrl)targetStatus.textContent = `Готово. Скачано серий: ${episodes.length}.`;
    } catch (error) {
      let cleanupFailed = false;
      try { await clean(); } catch { cleanupFailed = true; }
      targetStatus.textContent = controller.signal.aborted || error.name === 'AbortError' ? 'Загрузка отменена.' : `Не удалось скачать: ${error.message}`;
      if (cleanupFailed) targetStatus.textContent += ' Браузер не разрешил удалить пустой файл — удалите его из папки вручную.';
      await clearBlob().catch(cleanupWarning);
    } finally { window.removeEventListener('pagehide', leave); transmuxer?.dispose(); operation = undefined; pendingSave = undefined; if (!direct) await clearBlob().catch(cleanupWarning); controls(); }
  }
  dialog.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!release) return;
    const episodes = episodeChoice.value === 'all' ? release.episodes : release.episodes.filter(e => String(e.episodeNumber) === episodeChoice.value);
    run(episodes, qualityChoice.value);
  });
  quick.addEventListener('click', () => {
    if (!release) return;
    const episode = currentDownloadEpisode(release);
    if (!episode) { toast.hidden = false; toastStatus.textContent = 'Не удалось определить текущую серию. Откройте выбор серий в настройках.'; return; }
    const badge = document.querySelector('main video, #main video')?.parentElement.querySelector('button[aria-label^="Качество: "]');
    const quality = badge?.textContent.trim().match(/^(\d+)p$/)?.[1] ?? 'max';
    run([episode], quality, true);
  });
  return () => {
    const path = location.pathname;
    if ((releasePath && releasePath !== path) || (loading && loading.path !== path)) {
      loading?.controller.abort(); release = undefined; releasePath = undefined;
      // A quick download keeps running in its toast; the modal dialog belongs to the page it was opened on.
      if (!quickMode || !operation && !completedFile) { stop(); toast.hidden = true; }
      dialog.close();
    }
    open.hidden = !path.startsWith('/release/');
    const video = document.querySelector('main video, #main video');
    const badge = !open.hidden && video?.parentElement.querySelector('button[aria-label^="Качество: "]');
    if (badge) { quick.className = badge.className; if (quick.previousElementSibling !== badge) badge.after(quick); }
    else quick.remove();
    controls();
    if (!open.hidden && attemptedPath !== path) prepare().catch(error => { quick.title = error.message; });
    if (release && releasePath === path) quick.title = 'Скачать текущую серию в выбранном качестве';
  };
}
