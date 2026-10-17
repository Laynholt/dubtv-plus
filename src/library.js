// Server-rendered pages contain release metadata and native lists. Parse JSON only; never execute downloaded scripts.
function* pageObjects(doc) {
  let stream = '';
  for (const script of doc.scripts) {
    const match = script.textContent.match(/^self\.__next_f\.push\((\[.*\])\)\s*;?$/s);
    if (!match) continue;
    try { const part = JSON.parse(match[1]); if (part[0] === 1 && typeof part[1] === 'string') stream += part[1]; } catch { /* Other stream records are not profile data. */ }
  }
  const bytes = new TextEncoder().encode(stream);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    let colon = offset;
    while (colon < bytes.length && bytes[colon] !== 58 && bytes[colon] !== 10) colon++;
    if (bytes[colon] !== 58) { offset = colon + 1; continue; }
    offset = colon + 1;
    // Next's T records contain raw UTF-8 text, including newlines, followed immediately by the next record.
    if (bytes[offset] === 84) {
      let comma = offset;
      while (comma < bytes.length && bytes[comma] !== 44) comma++;
      const length = Number.parseInt(decoder.decode(bytes.subarray(offset+1, comma)), 16);
      if (!Number.isSafeInteger(length) || length < 0 || comma+1+length > bytes.length) break;
      offset = comma + 1 + length; continue;
    }
    let end = offset;
    while (end < bytes.length && bytes[end] !== 10) end++;
    const line = decoder.decode(bytes.subarray(offset, end)); offset = end + 1;
    let root; try { root = JSON.parse(line); } catch { continue; }
    const stack = [root];
    while (stack.length) {
      const item = stack.pop(); if (!item || typeof item !== 'object') continue;
      yield item;
      stack.push(...Object.values(item));
    }
  }
}

// The site shows the current episode as a bare "Серия N" / "Часть N" heading.
function currentEpisodeLabel() {
  return [...document.querySelectorAll('main h3,main span,#main h3,#main span')].map(e => e.textContent.trim()).find(text => /^(?:Серия|Часть)\s*\d+$/i.test(text));
}

function createLibraryTools(panel, options) {
  'use strict';
  options ??= {};
  const labels = {WATCHING:'Смотрю', PLANNED:'В планах', COMPLETED:'Просмотрено', ON_HOLD:'Отложено', DROPPED:'Брошено'};
  let hidden = {};
  let hideCompleted = false;
  let blockedGenres = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem('dubtv-plus-hidden'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      hidden = Object.fromEntries(Object.entries(saved).filter(([slug,title]) => /^[a-z0-9-]+$/.test(slug) && typeof title === 'string'));
    }
    hideCompleted = localStorage.getItem('dubtv-plus-hide-completed') === 'true';
    const genres = JSON.parse(localStorage.getItem('dubtv-plus-blocked-genres'));
    if (Array.isArray(genres)) blockedGenres = new Set(genres.filter(g=>typeof g==='string' && g.length<=100));
  } catch { /* Invalid preferences use defaults. */ }
  let statuses = new Map();
  let request;
  let attempted = false;
  let loadedAt = 0;
  let previousPath = location.pathname;
  let cards = [];
  let cardSignature = '';
  let hoverCard;
  let hoverTimer;
  let listsReady = false;
  let saving = false;
  let showListActions = options.showListActions !== false;
  let showHideActions = options.showHideActions !== false;
  let catalog = new Map();
  let genreCounts = new Map();
  let catalogRequest;
  let catalogAttempted = false;
  const hiddenElements = new Set();
  const ongoingButtons = new Map();
  const makeButton = (text, action) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.addEventListener('click', action); return b;
  };
  const style = document.createElement('style');
  style.textContent = `
    .dtvp-hidden-card{display:none!important}
    .dtvp-status{display:block;font:600 12px system-ui;color:#a8e5b7;padding:5px 0}
    .dtvp-library-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0}
    .dtvp-library-row span{min-width:0;overflow-wrap:anywhere}.dtvp-library-row button{flex-shrink:0}
    #dtvp-hide-choice{width:100%;min-width:0;max-width:100%}
    #dtvp-card-tools,#dtvp-card-tools *,#dtvp-genre-block,#dtvp-genre-block *{box-sizing:border-box}
    #dtvp-card-tools{position:fixed;z-index:10002;display:grid;gap:2px;width:190px;padding:4px;border:1px solid var(--color-border,#2a2a32);border-radius:8px;background:#141418ee;backdrop-filter:blur(12px);color:var(--color-text-primary,#f0f0f0);font-family:inherit;font-size:13px;font-weight:500;line-height:20px;box-shadow:0 4px 16px #0005}
    #dtvp-card-tools[hidden],#dtvp-card-tools [hidden],#dtvp-genre-block[hidden],#dtvp-genre-block [hidden]{display:none!important}
    .dtvp-ongoing-grid{position:relative}
    .dtvp-ongoing-card>:last-child{padding-bottom:36px}
    .dtvp-ongoing-add{position:absolute;height:30px;padding:0 10px;border:1px solid var(--color-border,#2a2a32);border-radius:6px;background:var(--color-surface,#141418);color:var(--color-text-primary,#f0f0f0);font-family:inherit;font-size:12px;font-weight:500;line-height:20px;cursor:pointer}
    .dtvp-ongoing-add:disabled{opacity:.5;cursor:wait}
    .dtvp-ongoing-add:focus-visible{outline:2px solid var(--color-primary-light,#f08a73);outline-offset:2px}
    #dtvp-card-tools.dtvp-ongoing-tools{padding:0;border:0;background:transparent;box-shadow:none;backdrop-filter:none}
    #dtvp-card-tools button{position:static;width:100%;min-width:0;height:32px;border:0;border-radius:5px;padding:0 8px;background:transparent;color:inherit;font-family:inherit;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,color .15s}
    #dtvp-card-tools button:hover{background:var(--color-surface-hover,#1c1c22)}
    #dtvp-status-choice{display:flex;align-items:center;justify-content:space-between;gap:6px;text-align:left}
    #dtvp-status-choice span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #dtvp-status-choice svg{width:14px;height:14px;flex-shrink:0;color:var(--color-text-muted,#8b8b9c);transition:transform .15s}
    #dtvp-status-choice[aria-expanded=true] svg{transform:rotate(180deg)}
    #dtvp-status-choice:disabled{opacity:.5;cursor:wait}
    #dtvp-status-menu{position:absolute;z-index:1;display:grid;gap:2px;min-width:180px;max-width:calc(100vw - 8px);padding:4px;border:1px solid var(--color-border,#2a2a32);border-radius:8px;background:var(--color-surface,#141418);box-shadow:0 8px 24px #0006;overflow-y:auto;overscroll-behavior:contain}
    #dtvp-status-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;white-space:nowrap}
    #dtvp-status-menu button[aria-checked=true]{background:#d6381c1a;color:var(--color-primary-light,#f08a73)}
    #dtvp-status-menu button[aria-checked=true]::after{content:'✓'}
    #dtvp-status-menu button:last-child{border-top:1px solid var(--color-border,#2a2a32);border-radius:0 0 5px 5px;margin-top:3px;color:var(--color-text-muted,#8b8b9c)}
    #dtvp-card-tools :focus-visible,#dtvp-genre-block button:focus-visible{outline:2px solid var(--color-primary-light,#f08a73);outline-offset:1px}
    #dtvp-action-state{position:fixed;bottom:16px;left:16px;z-index:10003;max-width:min(440px,calc(100vw - 32px));background:var(--color-surface,#141418);border:1px solid var(--color-border,#2a2a32);color:var(--color-text-primary,#f0f0f0);border-radius:8px;padding:10px;font:14px/1.5 system-ui}
    #dtvp-action-state:empty{display:none}
    #dtvp-genre-block{margin:24px 0 0;padding:0;border:0;color:var(--color-text-muted,#8b8b9c);font-family:inherit;font-size:13px;line-height:20px}
    #dtvp-genre-block h3{margin:0 0 8px;font-size:11px;font-weight:600;line-height:16px;letter-spacing:.12em;text-transform:uppercase;color:var(--color-text-muted,#8b8b9c)}
    :is(#dtvp-genre-search,#dtvp-native-genre-search){display:flex;align-items:center;gap:8px;height:32px;margin-bottom:8px;padding:0 10px;border:1px solid var(--color-border,#2a2a32);border-radius:6px;transition:border-color .15s}
    :is(#dtvp-genre-search,#dtvp-native-genre-search):focus-within{border-color:var(--color-text-muted,#8b8b9c)}
    :is(#dtvp-genre-search,#dtvp-native-genre-search) svg{width:14px;height:14px;flex-shrink:0}
    :is(#dtvp-genre-search,#dtvp-native-genre-search) input{flex:1;width:100%;min-width:0;border:0;padding:0;background:transparent;color:var(--color-text-primary,#f0f0f0);font:inherit;outline:none}
    :is(#dtvp-genre-search,#dtvp-native-genre-search) input::placeholder{color:var(--color-text-muted,#8b8b9c)}
    #dtvp-genre-options{display:grid;gap:2px}
    #dtvp-genre-block button{border:0;background:transparent;font:inherit;cursor:pointer;transition:background .15s,color .15s}
    #dtvp-genre-options button{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:28px;padding:3px 8px;border-radius:5px;color:#9a9aaa;text-align:left}
    #dtvp-genre-options button:hover{background:#ffffff0d;color:var(--color-text-primary,#f0f0f0)}
    #dtvp-genre-options button[aria-pressed=true]{background:#d6381c1a;color:var(--color-primary-light,#f08a73)}
    #dtvp-genre-options button span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #dtvp-genre-options button span:last-child{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--color-text-muted,#8b8b9c)}
    #dtvp-genre-block .dtvp-genre-link{display:inline-flex;align-items:center;gap:8px;min-height:32px;margin-top:8px;padding:0;border-radius:6px;color:#9a9aaa;font-weight:600}
    #dtvp-genre-block .dtvp-genre-link:hover{color:var(--color-text-primary,#f0f0f0)}
    #dtvp-genre-block .dtvp-genre-link svg{width:14px;height:14px}
    #dtvp-genre-state{margin:8px 0 0;font-size:11.5px;line-height:18px}
    #dtvp-genre-state:empty{display:none}
    .dtvp-native-genre-options{display:grid!important;gap:2px!important}
    .dtvp-native-genre-options>button{display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:32px;width:100%;padding:3px 8px;border:0;border-radius:5px;text-align:left;background:transparent;color:var(--color-text-secondary,#9a9aaa)}
    .dtvp-native-genre-options>button[aria-pressed=true]{background:#d6381c1a;color:var(--color-primary-light,#f08a73)}
    .dtvp-native-genre-options>button::after{content:attr(data-dtvp-count);font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--color-text-muted,#8b8b9c)}
    .dtvp-native-genre-toggle{display:inline-flex;align-items:center;min-height:32px;margin-top:8px;padding:0;border:0;background:transparent;color:var(--color-text-secondary,#9a9aaa);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .dtvp-native-genre-options>[hidden],.dtvp-native-genre-toggle[hidden]{display:none!important}
    .dtvp-native-genre-options>button:focus-visible,.dtvp-native-genre-toggle:focus-visible{outline:2px solid var(--color-primary-light,#f08a73);outline-offset:1px}
  `;
  document.head.append(style);
  const heading = document.createElement('h3'); heading.textContent = 'Каталог и скрытые тайтлы'; panel.append(heading);
  const completedLabel = document.createElement('label');
  const completedInput = document.createElement('input'); completedInput.type = 'checkbox'; completedInput.id = 'dtvp-hide-completed'; completedInput.checked = hideCompleted;
  completedLabel.append(completedInput,'Скрывать просмотренное в каталоге'); panel.append(completedLabel);
  const state = document.createElement('p'); state.id = 'dtvp-list-state'; state.setAttribute('role','status'); panel.append(state);
  const reload = makeButton('Обновить статусы', () => {
    loadLists();
    if (!catalog.size) { catalogAttempted=false; loadCatalog(); }
  }); reload.id = 'dtvp-refresh-lists'; panel.append(reload);
  const chooserLabel = document.createElement('label'); chooserLabel.className = 'dtvp-field'; chooserLabel.textContent = 'Не интересно — тайтл на этой странице';
  const chooser = document.createElement('select'); chooser.id = 'dtvp-hide-choice'; chooserLabel.append(chooser); panel.append(chooserLabel);
  const hideButton = makeButton('Скрыть выбранный тайтл', () => {
    const card = cards.find(c => c.slug === chooser.value); if (card) hide(card.slug,card.title);
  }); hideButton.id = 'dtvp-hide-title'; panel.append(hideButton);
  const hiddenList = document.createElement('div'); panel.append(hiddenList);
  const action = makeButton('Не интересно', () => { if (hoverCard) hide(hoverCard.slug,hoverCard.title); });
  action.id = 'dtvp-card-action';
  const tools = document.createElement('div'); tools.id = 'dtvp-card-tools'; tools.hidden = true;
  const statusChoice = makeButton('',()=>statusMenu.hidden?openStatusMenu():closeStatusMenu(true));
  statusChoice.id = 'dtvp-status-choice'; statusChoice.setAttribute('aria-label','Список тайтла');
  statusChoice.setAttribute('aria-haspopup','menu');statusChoice.setAttribute('aria-expanded','false');statusChoice.setAttribute('aria-controls','dtvp-status-menu');
  const statusText = document.createElement('span');
  let statusAnchor = statusChoice;
  statusChoice.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
  statusChoice.prepend(statusText);
  const statusMenu = document.createElement('div');statusMenu.id='dtvp-status-menu';statusMenu.hidden=true;statusMenu.setAttribute('role','menu');statusMenu.setAttribute('aria-label','Список тайтла');
  for (const [value,label] of [...Object.entries(labels),['','Убрать из списка']]) {
    const option = makeButton(label,()=>saveStatus(value));option.value=value;option.tabIndex=-1;
    option.setAttribute('role',value?'menuitemradio':'menuitem');statusMenu.append(option);
  }
  tools.append(action,statusChoice,statusMenu); document.body.append(tools);
  const actionState = document.createElement('div'); actionState.id = 'dtvp-action-state'; actionState.setAttribute('role','status'); document.body.append(actionState);
  const genreBlock = document.createElement('section'); genreBlock.id = 'dtvp-genre-block'; genreBlock.hidden = true;
  const genreSummary = document.createElement('h3'); genreSummary.textContent = 'Исключить жанры';
  const genreSearch = document.createElement('input'); genreSearch.type = 'search'; genreSearch.placeholder = 'Найти жанр'; genreSearch.setAttribute('aria-label','Поиск исключаемого жанра');
  const searchLabel = document.createElement('label'); searchLabel.id = 'dtvp-genre-search';
  searchLabel.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>';
  searchLabel.append(genreSearch);
  const genreOptions = document.createElement('div'); genreOptions.id = 'dtvp-genre-options';
  let allGenres = false;
  const expandGenres = makeButton('',()=>{allGenres=!allGenres;filterGenres();}); expandGenres.className='dtvp-genre-link';
  const genreState = document.createElement('p'); genreState.id='dtvp-genre-state'; genreState.setAttribute('role','status');
  const retryCatalog = makeButton('Повторить загрузку жанров',()=>{catalogAttempted=false;loadCatalog();}); retryCatalog.hidden=true;
  retryCatalog.className='dtvp-genre-link';
  const resetGenres = makeButton('Сбросить блок-лист',()=>{
    blockedGenres.clear();persist();for(const button of genreOptions.children)button.setAttribute('aria-pressed','false');filterGenres();refresh();
  }); resetGenres.className='dtvp-genre-link'; resetGenres.hidden=true;
  genreBlock.append(genreSummary,searchLabel,genreOptions,expandGenres,genreState,retryCatalog,resetGenres);
  function filterGenres() {
    const query = genreSearch.value.trim().toLocaleLowerCase();
    for (const [index,button] of Array.from(genreOptions.children).entries()) {
      button.hidden = !button.dataset.blockGenre.toLocaleLowerCase().includes(query) || !query && !allGenres && index>=10 && button.getAttribute('aria-pressed')!=='true';
    }
    expandGenres.hidden = Boolean(query) || genreOptions.children.length<=10;
    expandGenres.setAttribute('aria-expanded',String(allGenres));
    expandGenres.innerHTML = `${allGenres?'Свернуть':`Все ${genreOptions.children.length} жанров`}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="transform:rotate(${allGenres?180:0}deg)"><path d="m6 9 6 6 6-6"></path></svg>`;
    resetGenres.hidden = blockedGenres.size===0;
  }
  genreSearch.addEventListener('input',filterGenres);
  let nativeGenreSource, allNativeGenres = false;
  const nativeSearchLabel = searchLabel.cloneNode(true);nativeSearchLabel.id='dtvp-native-genre-search';
  const nativeSearch = nativeSearchLabel.querySelector('input');nativeSearch.setAttribute('aria-label','Поиск жанра');
  const nativeExpand = makeButton('',()=>{allNativeGenres=!allNativeGenres;filterNativeGenres();});nativeExpand.className='dtvp-native-genre-toggle';
  function filterNativeGenres() {
    if(!nativeGenreSource?.isConnected)return;
    const query=nativeSearch.value.trim().toLocaleLowerCase('ru'),buttons=[...nativeGenreSource.querySelectorAll(':scope>button')].filter(b=>!/^Все\s+\d+$/.test(b.textContent.trim()));
    for(const [index,button] of buttons.entries()){
      const name=button.textContent.trim(),pressed=button.classList.contains('border-primary'),count=String(genreCounts.get(name)??'');
      if(button.getAttribute('aria-pressed')!==String(pressed))button.setAttribute('aria-pressed',String(pressed));
      if(button.dataset.dtvpCount!==count)button.dataset.dtvpCount=count;
      button.hidden=!name.toLocaleLowerCase('ru').includes(query)||!query&&!allNativeGenres&&index>=10&&!pressed;
    }
    nativeExpand.hidden=Boolean(query)||buttons.length<=10;
    if(nativeExpand.getAttribute('aria-expanded')!==String(allNativeGenres))nativeExpand.setAttribute('aria-expanded',String(allNativeGenres));
    const label=allNativeGenres?'Свернуть':`Все ${buttons.length} жанров`;if(nativeExpand.textContent!==label)nativeExpand.textContent=label;
  }
  nativeSearch.addEventListener('input',filterNativeGenres);
  const nativeGenreObserver=new MutationObserver(filterNativeGenres);
  function updateStatusChoice() {
    statusChoice.hidden = !showListActions || !listPage() || location.pathname==='/ongoing';
    statusChoice.value = statuses.get(hoverCard?.slug) ?? '';
    statusText.textContent = labels[statusChoice.value] ?? 'Добавить в…';
    for (const option of statusMenu.children) {
      if(option.value)option.setAttribute('aria-checked',String(option.value===statusChoice.value));
      else option.hidden=!statusChoice.value;
    }
    statusChoice.disabled = saving || !listsReady || !catalog.has(hoverCard?.slug);
    statusChoice.title = !listsReady ? 'Войдите на сайт и обновите статусы в настройках DubTV+' : !catalog.has(hoverCard?.slug) ? 'Данные тайтла ещё не загружены' : 'Сохранить в списке DubTV';
  }
  function closeStatusMenu(focus = false) {
    statusMenu.hidden=true;
    if(statusChoice.getAttribute('aria-expanded')!=='false')statusChoice.setAttribute('aria-expanded','false');
    if(statusAnchor.getAttribute('aria-expanded')!=='false')statusAnchor.setAttribute('aria-expanded','false');
    if(focus)statusAnchor.focus();
  }
  function hideTools() { closeStatusMenu();tools.hidden=true; }
  function openStatusMenu(anchor = statusChoice) {
    if(!showListActions || statusChoice.disabled)return;
    statusAnchor=anchor;updateStatusChoice();statusMenu.hidden=false;statusAnchor.setAttribute('aria-expanded','true');
    const rect=tools.getBoundingClientRect(),below=innerHeight-rect.bottom-8,above=rect.top-8;
    const upwards=below<statusMenu.scrollHeight && above>below;
    statusMenu.style.maxHeight=`${Math.max(0,upwards?above:below)}px`;
    statusMenu.style.top=upwards?'auto':'calc(100% + 4px)';statusMenu.style.bottom=upwards?'calc(100% + 4px)':'auto';
    const left=Math.max(4,Math.min(innerWidth-statusMenu.offsetWidth-4,rect.left+(rect.width-statusMenu.offsetWidth)/2));
    statusMenu.style.left=`${left-rect.left-tools.clientLeft}px`;
    const options=Array.from(statusMenu.children).filter(b=>!b.hidden);
    (options.find(b=>b.value===statusChoice.value)??options[0])?.focus();
  }
  statusChoice.addEventListener('keydown',event=>{
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();openStatusMenu();}
  });
  statusMenu.addEventListener('keydown',event=>{
    const options=Array.from(statusMenu.children).filter(b=>!b.hidden),index=options.indexOf(document.activeElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();
      const next=event.key==='Home'?0:event.key==='End'?options.length-1:(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;
      options[next]?.focus();
    }else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeStatusMenu(true);}
    else if(event.key==='Tab')closeStatusMenu(true);
  });
  document.addEventListener('pointerdown',event=>{if(!tools.contains(event.target))hideTools();});
  async function saveStatus(value) {
    const card = hoverCard, entry = catalog.get(card?.slug);
    if (!showListActions || saving || !listsReady || !entry || !listPage() || value && !Object.hasOwn(labels,value)) { updateStatusChoice(); return; }
    closeStatusMenu(true);
    saving = true; reload.disabled = true; updateStatusChoice();
    actionState.textContent = `Сохраняю: ${card.title}…`;
    const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10000);
    try {
      const response = await fetch('/api/user/lists',{method:value?'POST':'DELETE',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(value?{releaseId:entry.id,listStatus:value}:{releaseId:entry.id}),signal:controller.signal});
      if (!response.ok) throw new Error(response.status===401?'auth':'save');
      if (value) statuses.set(card.slug,value); else statuses.delete(card.slug);
      state.textContent = `Статусы обновлены · в списках ${statuses.size}`;
      actionState.textContent = `${card.title}: ${value?labels[value]:'убрано из списка'}`;
    } catch (error) {
      actionState.textContent = error.message==='auth' ? 'Войдите в DubTV, чтобы менять списки.' : 'Не удалось подтвердить сохранение. Обновите статусы и попробуйте ещё раз.';
    } finally {
      clearTimeout(timeout); saving=false; reload.disabled=false;updateStatusChoice();refresh();
    }
  }
  function persist() {
    try { localStorage.setItem('dubtv-plus-hidden',JSON.stringify(hidden)); localStorage.setItem('dubtv-plus-hide-completed',String(hideCompleted)); localStorage.setItem('dubtv-plus-blocked-genres',JSON.stringify([...blockedGenres])); } catch { /* Session-only preferences. */ }
  }
  completedInput.addEventListener('change', () => { hideCompleted = completedInput.checked; persist(); refresh(); });
  function showHidden() {
    hiddenList.replaceChildren();
    const title = document.createElement('p'); title.textContent = `Скрыто: ${Object.keys(hidden).length}`; hiddenList.append(title);
    for (const [slug,name] of Object.entries(hidden)) {
      const row = document.createElement('div'); row.className = 'dtvp-library-row';
      const text = document.createElement('span'); text.textContent = name;
      const restore = makeButton('Вернуть', () => { delete hidden[slug]; persist(); showHidden(); refresh(); }); restore.dataset.restoreSlug = slug;
      row.append(text,restore); hiddenList.append(row);
    }
  }
  function hide(slug,title) { hidden[slug] = title; persist(); showHidden(); hideTools(); refresh(); }
  function supported() { return ['/', '/catalog','/ongoing'].includes(location.pathname) || location.pathname.startsWith('/release/'); }
  function listPage() { return ['/catalog','/ongoing'].includes(location.pathname) || location.pathname.startsWith('/release/'); }
  function eligibleLinks() {
    if (!supported()) return [];
    let scope = document.querySelector('main, #main');
    if (location.pathname.startsWith('/release/')) {
      const related = Array.from(scope?.querySelectorAll('h2') ?? []).find(h => h.childNodes[0]?.textContent.trim() === 'Похожее');
      scope = related?.closest('section');
    }
    return Array.from(scope?.querySelectorAll('a[href^="/release/"]') ?? []).filter(a => a.querySelector('img,h3') && !a.querySelector('button'));
  }
  function parseLists(html) {
    for (const item of pageObjects(new DOMParser().parseFromString(html,'text/html'))) {
        if (item.user?.id && item.lists && Object.keys(labels).every(key => Array.isArray(item.lists[key]))) {
          const result = new Map();
          for (const key of Object.keys(labels)) for (const entry of item.lists[key]) {
            if (!entry || typeof entry.slug !== 'string' || !/^[a-z0-9-]+$/.test(entry.slug)) throw new Error('Unexpected list item');
            result.set(entry.slug,key);
          }
          return result;
        }
    }
    throw new Error('Profile data not found');
  }
  function readCatalog(doc) {
    const entries = new Map();
    for (const item of pageObjects(doc)) {
      if (typeof item.id==='string' && /^[a-zA-Z0-9-]+$/.test(item.id) && typeof item.slug==='string' && /^[a-z0-9-]+$/.test(item.slug) && Array.isArray(item.genres) && item.genres.every(g=>typeof g==='string')) entries.set(item.slug,{id:item.id,genres:item.genres});
    }
    return entries;
  }
  async function loadCatalog() {
    if (catalogRequest || catalog.size || catalogAttempted || !listPage()) return;
    catalogAttempted=true;retryCatalog.hidden=true;genreState.textContent='Загружаю жанры…';
    const controller=new AbortController();catalogRequest=controller;
    const timeout=setTimeout(()=>controller.abort(),10000);
    try {
      // SPA navigation may leave only the previous page's partial data in document.scripts.
      const response=await fetch('/catalog',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('Catalog unavailable');
      catalog=readCatalog(new DOMParser().parseFromString(await response.text(),'text/html'));
      if (!catalog.size) throw new Error('Catalog metadata missing');
      genreOptions.replaceChildren();
      const counts=new Map([...blockedGenres].map(g=>[g,0]));
      for(const entry of catalog.values())for(const genre of new Set(entry.genres))counts.set(genre,(counts.get(genre)??0)+1);
      genreCounts=counts;
      for (const [genre,count] of [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'ru'))) {
        const button=makeButton('',()=>{
          if(blockedGenres.has(genre))blockedGenres.delete(genre);else blockedGenres.add(genre);
          button.setAttribute('aria-pressed',String(blockedGenres.has(genre)));persist();filterGenres();refresh();
        });
        button.dataset.blockGenre=genre;button.setAttribute('aria-pressed',String(blockedGenres.has(genre)));
        const name=document.createElement('span');name.textContent=genre;
        const total=document.createElement('span');total.textContent=String(count);total.setAttribute('aria-hidden','true');
        button.append(name,total);genreOptions.append(button);
      }
      filterGenres();
    } catch {genreState.textContent='Не удалось загрузить жанры. Фильтр по жанрам пока не применяется.';retryCatalog.hidden=false;}
    finally {clearTimeout(timeout);catalogRequest=undefined;updateStatusChoice();refresh();}
  }
  function placeGenreBlock() {
    genreBlock.hidden=location.pathname!=='/catalog';
    if (genreBlock.hidden) {nativeGenreObserver.disconnect();nativeSearchLabel.remove();nativeExpand.remove();return;}
    const headings=Array.from(document.querySelectorAll('main h3,#main h3')).filter(h=>h.textContent.trim().startsWith('Жанры'));
    const heading=headings.find(h=>h.closest('[role=dialog],dialog')&&h.getClientRects().length)||headings.find(h=>!h.closest('[role=dialog],dialog'));
    if (heading) { if(heading.parentElement.nextElementSibling!==genreBlock)heading.parentElement.after(genreBlock); }
    else {const main=document.querySelector('main,#main');if(main && genreBlock.parentElement!==main)main.prepend(genreBlock);}
    const source=heading?.closest('[role=dialog],dialog')?heading.parentElement.querySelector(':scope>div'):null;
    if(source){
      if(source!==nativeGenreSource){nativeGenreObserver.disconnect();nativeGenreSource=source;source.classList.add('dtvp-native-genre-options');nativeGenreObserver.observe(source,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});}
      if(source.previousElementSibling!==nativeSearchLabel)source.before(nativeSearchLabel);
      if(source.nextElementSibling!==nativeExpand)source.after(nativeExpand);
      const more=[...source.children].find(b=>/^Все\s+\d+$/.test(b.textContent.trim()));
      if(more){more.hidden=true;if(!more.dataset.dtvpExpanded){more.dataset.dtvpExpanded='true';more.click();}}
      filterNativeGenres();
    }else{nativeGenreObserver.disconnect();nativeSearchLabel.remove();nativeExpand.remove();nativeGenreSource=undefined;}
    const summary=`Исключить жанры${blockedGenres.size?` · ${blockedGenres.size}`:''}`;
    if (genreSummary.textContent!==summary)genreSummary.textContent=summary;
  }
  function cardContainer(link) {
    const wrapper=link.parentElement;
    return wrapper?.classList.contains('snap-start') && wrapper.querySelectorAll('a[href^="/release/"]').length===1 ? wrapper : link;
  }
  async function loadLists() {
    if (request || saving) return;
    attempted = true; loadedAt = Date.now(); listsReady=false; statuses = new Map(); updateStatusChoice();
    state.textContent = 'Загружаю статусы из профиля…'; reload.disabled = true;
    const controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(),10000);
    refresh();
    try {
      const response = await fetch('/profile',{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('Profile unavailable');
      const result = parseLists(await response.text());
      if (request !== controller) return;
      statuses = result; listsReady=true; state.textContent = `Статусы обновлены · в списках ${statuses.size}`;
    } catch {
      if (request === controller) { statuses = new Map(); state.textContent = 'Не удалось прочитать списки. Проверьте вход в DubTV и нажмите «Обновить статусы».'; }
    } finally {
      clearTimeout(timeout);
      if (request === controller) { request = undefined; reload.disabled = false; updateStatusChoice(); refresh(); }
    }
  }
  function refresh() {
    if(showListActions !== (options.showListActions !== false) || showHideActions !== (options.showHideActions !== false)){
      showListActions=options.showListActions !== false;showHideActions=options.showHideActions !== false;hideTools();updateStatusChoice();
    }
    if (previousPath !== location.pathname) { previousPath = location.pathname; hideTools();hoverCard=undefined; }
    cards = eligibleLinks().map(link => ({link,slug:link.getAttribute('href').split('/')[2]?.split(/[?#]/)[0],title:link.querySelector('h3')?.textContent.trim() || link.querySelector('img')?.alt || link.lastElementChild?.firstElementChild?.textContent.trim() || ''})).filter(c=>/^[a-z0-9-]+$/.test(c.slug));
    const ongoing=location.pathname==='/ongoing';
    for(const [link,button] of ongoingButtons)if(!ongoing||!showListActions||!cards.some(c=>c.link===link)){
      const parent=button.parentElement;button.remove();link.classList.remove('dtvp-ongoing-card');ongoingButtons.delete(link);
      if(!parent?.querySelector('.dtvp-ongoing-add'))parent?.classList.remove('dtvp-ongoing-grid');
    }
    const nextHidden=new Set();let genreHidden=0;
    for (const card of cards) {
      const status = listPage() ? statuses.get(card.slug) : undefined;
      const genreBlocked=location.pathname==='/catalog' && catalog.get(card.slug)?.genres.some(g=>blockedGenres.has(g));
      if (genreBlocked) genreHidden++;
      if (!ongoing&&Object.hasOwn(hidden,card.slug) || hideCompleted && location.pathname === '/catalog' && status === 'COMPLETED' || genreBlocked) nextHidden.add(cardContainer(card.link));
      let badge = card.link.querySelector('.dtvp-status');
      if(ongoing){
        if(!showListActions){badge?.remove();continue;}
        let button=ongoingButtons.get(card.link);
        if(!button){
          button=makeButton('Добавить в…',()=>{
            const current=cards.find(c=>c.link===card.link);if(!current||saving)return;
            hideTools();hoverCard=current;updateStatusChoice();if(statusChoice.disabled)return;
            // A catalogue hover puts these controls inside the page that SPA navigation removes.
            if(tools.parentElement!==document.body)document.body.append(tools);
            const rect=button.getBoundingClientRect();tools.classList.add('dtvp-ongoing-tools');action.hidden=true;tools.hidden=false;
            tools.style.width=`${rect.width}px`;tools.style.minHeight=`${rect.height}px`;tools.style.left=`${rect.left}px`;tools.style.top=`${rect.top}px`;
            openStatusMenu(button);
          });button.className='dtvp-ongoing-add';button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.setAttribute('aria-controls','dtvp-status-menu');
          button.addEventListener('keydown',event=>{if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();button.click();}});
          // Keep React's links in their original parent so native updates can remove them safely.
          card.link.classList.add('dtvp-ongoing-card');card.link.parentElement.classList.add('dtvp-ongoing-grid');card.link.after(button);ongoingButtons.set(card.link,button);
        }
        const disabled=saving||!listsReady||!catalog.has(card.slug);if(button.disabled!==disabled)button.disabled=disabled;
        const title= !listsReady?'Войдите на сайт и обновите статусы в настройках DubTV+':!catalog.has(card.slug)?'Данные тайтла ещё не загружены':`${card.title}${status?` · ${labels[status]}`:''}`;
        if(button.title!==title)button.title=title;
        badge?.remove();
      } else if (status) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'dtvp-status'; card.link.append(badge); }
        if (badge.textContent !== labels[status]) badge.textContent = labels[status];
      } else badge?.remove();
    }
    for(const [link,button] of ongoingButtons){
      const padding=getComputedStyle(link),left=link.offsetLeft+parseFloat(padding.paddingLeft)+74,top=link.offsetTop+link.offsetHeight-parseFloat(padding.paddingBottom)-30;
      for(const [name,value] of Object.entries({left:`${left}px`,top:`${top}px`,maxWidth:`${Math.max(0,link.clientWidth-parseFloat(padding.paddingLeft)-parseFloat(padding.paddingRight)-74)}px`}))if(button.style[name]!==value)button.style[name]=value;
    }
    for (const element of hiddenElements) if(!nextHidden.has(element)){element.classList.remove('dtvp-hidden-card');hiddenElements.delete(element);}
    for (const element of nextHidden)if(!element.classList.contains('dtvp-hidden-card'))element.classList.add('dtvp-hidden-card');
    for (const element of nextHidden)hiddenElements.add(element);
    for (const badge of document.querySelectorAll('.dtvp-status')) if(!cards.some(c=>c.link.contains(badge)))badge.remove();
    if(hoverCard && (!cards.some(c=>c.link===hoverCard.link) || nextHidden.has(cardContainer(hoverCard.link))))hideTools();
    placeGenreBlock();
    if(catalog.size){const text=blockedGenres.size?`Скрыто по жанрам: ${genreHidden}`:'';if(genreState.textContent!==text)genreState.textContent=text;}
    if(listPage() && (location.pathname==='/catalog' || cards.length) && !catalogAttempted)loadCatalog();
    const choices = ongoing?[]:[...new Map(cards.filter(c=>!Object.hasOwn(hidden,c.slug)).map(c=>[c.slug,c])).values()];
    const signature = JSON.stringify(choices.map(c=>[c.slug,c.title]));
    if (signature !== cardSignature) {
      cardSignature = signature; const selected = chooser.value; chooser.replaceChildren();
      for (const card of choices) chooser.add(new Option(card.title,card.slug));
      if (choices.some(c=>c.slug===selected)) chooser.value = selected;
      hideButton.disabled = choices.length === 0;
    }
    // Lists belong to the account, not the page: reuse them across routes and re-read at most every 5 minutes.
    if (listPage() && cards.length && (!attempted || Date.now()-loadedAt > 5*60*1000)) loadLists();
    else if (!attempted && !request) { const text = 'Статусы загружаются в каталоге и похожих тайтлах.'; if (state.textContent!==text) state.textContent=text; }
  }
  function reveal(event) {
    if(location.pathname==='/ongoing')return;
    if(!showHideActions && (!showListActions || !listPage())){hideTools();return;}
    const link = event.target.closest?.('a[href^="/release/"]');
    const card = cards.find(c=>c.link===link);
    if (!card || cardContainer(card.link).classList.contains('dtvp-hidden-card') || (saving || !statusMenu.hidden) && hoverCard?.slug!==card.slug) return;
    clearTimeout(hoverTimer); hoverCard = card;
    statusAnchor=statusChoice;tools.classList.remove('dtvp-ongoing-tools');tools.style.minHeight='';action.hidden=!showHideActions;
    const rect = card.link.getBoundingClientRect();
    action.textContent = 'Не интересно'; action.setAttribute('aria-label',`Не интересно: ${card.title}`);
    // Keep the controls next in the tab order of the card they act on.
    if (card.link.nextElementSibling !== tools) card.link.after(tools);
    updateStatusChoice();tools.hidden=false;
    tools.style.width = `${Math.min(190,Math.max(0,rect.width-16),innerWidth-8)}px`;
    tools.style.top = `${Math.max(4,Math.min(innerHeight-tools.offsetHeight-4,rect.top+6))}px`;
    const left = rect.left+(rect.width-tools.offsetWidth)/2;
    tools.style.left = `${Math.max(4,Math.min(innerWidth-tools.offsetWidth-4,left))}px`;
  }
  document.addEventListener('pointerover',reveal); document.addEventListener('focusin',reveal);
  document.addEventListener('pointerout',event=>{
    if (tools.contains(event.relatedTarget) || hoverCard?.link.contains(event.relatedTarget)) return;
    hoverTimer=setTimeout(()=>{if(!tools.contains(document.activeElement))hideTools();},250);
  });
  tools.addEventListener('pointerenter',()=>clearTimeout(hoverTimer));
  tools.addEventListener('focusout',event=>{if(!tools.contains(event.relatedTarget))hideTools();});
  tools.addEventListener('keydown',event=>{if(event.key==='Escape'){hideTools();hoverCard?.link.focus();hideTools();}});
  window.addEventListener('scroll',event=>{if(!tools.contains(event.target))hideTools();},true);
  window.addEventListener('resize',()=>{hideTools();if(location.pathname==='/ongoing')refresh();else placeGenreBlock();});
  showHidden(); refresh(); return refresh;
}
