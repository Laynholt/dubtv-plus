// ==UserScript==
// @name         DubTV+
// @namespace    dubtv-plus
// @version      1.1.0
// @author       laynholt
// @icon         data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KICA8cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTgxODFjIi8+CiAgPGcgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI5MDAiIGZvbnQtc2l6ZT0iMzkiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgPGcgZmlsbD0iI2I4M2IyYiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMiAzKSI+PHRleHQgeD0iNjQiIHk9IjU2Ij5EVUI8L3RleHQ+PHRleHQgeD0iNDgiIHk9Ijk2Ij5UVjwvdGV4dD48L2c+CiAgICA8ZyBmaWxsPSIjZjRmMmVlIj48dGV4dCB4PSI2NCIgeT0iNTYiPkRVQjwvdGV4dD48dGV4dCB4PSI0OCIgeT0iOTYiPlRWPC90ZXh0PjwvZz4KICA8L2c+CiAgPHBhdGggZD0iTTk2IDcwdjI2bS0xMy0xM2gyNiIgc3Ryb2tlPSIjZmY2ODQyIiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K
// @homepageURL  https://github.com/Laynholt/dubtv-plus
// @supportURL   https://github.com/Laynholt/dubtv-plus/issues
// @downloadURL  https://github.com/Laynholt/dubtv-plus/releases/latest/download/dubtv-plus.user.js
// @updateURL    https://github.com/Laynholt/dubtv-plus/releases/latest/download/dubtv-plus.meta.js
// @description  Скорость и качество, кинотеатр с прокруткой, переключение серий, горячие клавиши и удобный каталог.
// @match        https://dubtv.pro/*
// @grant        none
// @noframes
// @run-at       document-end
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const navigationId = 'dubtv-plus-navigation';
  const boundVideos = new WeakSet();
  const onRelease = () => location.pathname.startsWith('/release/');
  const qualityKey = 'dubtv-plus-quality';
  let preferredQuality;
  try { preferredQuality = localStorage.getItem(qualityKey); } catch { /* Session-only if storage is blocked. */ }
  let pendingQuality = true;
  let qualityRestore;
  let applyingQuality = false;
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
  let previousPath = location.pathname;
  let cards = [];
  let cardSignature = '';
  let hoverCard;
  let hoverTimer;
  let listsReady = false;
  let saving = false;
  let routeGeneration = 0;
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
    const generation = routeGeneration;
    saving = true; reload.disabled = true; updateStatusChoice();
    actionState.textContent = `Сохраняю: ${card.title}…`;
    const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10000);
    try {
      const response = await fetch('/api/user/lists',{method:value?'POST':'DELETE',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(value?{releaseId:entry.id,listStatus:value}:{releaseId:entry.id}),signal:controller.signal});
      if (!response.ok) throw new Error(response.status===401?'auth':'save');
      if (generation === routeGeneration) {
        if (value) statuses.set(card.slug,value); else statuses.delete(card.slug);
        state.textContent = `Статусы обновлены · в списках ${statuses.size}`;
      }
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
    attempted = true; listsReady=false; statuses = new Map(); updateStatusChoice();
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
    if (previousPath !== location.pathname) {
      previousPath = location.pathname; routeGeneration++;statuses = new Map(); attempted = false;listsReady=false;
      request?.abort(); request = undefined; reload.disabled = saving; hideTools();hoverCard=undefined;
    }
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
    if (listPage() && cards.length && !attempted) loadLists();
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

/* Bundled mux.js 6.3.0 — https://github.com/videojs/mux.js

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright Brightcove, Inc.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

*/
const muxmp4 = (() => { const module = {exports:{}}; const exports = module.exports; const require = name => { if (name !== 'global/window') throw new Error('Unexpected mux.js dependency'); return window; };
/*! @name mux.js @version 6.3.0 @license Apache-2.0 */
!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?module.exports=e(require("global/window")):"function"==typeof define&&define.amd?define(["global/window"],e):(t="undefined"!=typeof globalThis?globalThis:t||self).muxjs=e(t.window)}(this,(function(t){"use strict";function e(t){return t&&"object"==typeof t&&"default"in t?t:{default:t}}var i,n,a,r,s,o,d,h,p,u,l,c,f,g,m,y,S,v,b,_,w,T,C,k,P,A,U,D,E,L,x,O,I,R,M,N,B,W,G,z,F=e(t),V=Math.pow(2,32),Y={getUint64:function(t){var e,i=new DataView(t.buffer,t.byteOffset,t.byteLength);return i.getBigUint64?(e=i.getBigUint64(0))<Number.MAX_SAFE_INTEGER?Number(e):e:i.getUint32(0)*V+i.getUint32(4)},MAX_UINT32:V},X=Y.MAX_UINT32;!function(){var t;if(T={avc1:[],avcC:[],btrt:[],dinf:[],dref:[],esds:[],ftyp:[],hdlr:[],mdat:[],mdhd:[],mdia:[],mfhd:[],minf:[],moof:[],moov:[],mp4a:[],mvex:[],mvhd:[],pasp:[],sdtp:[],smhd:[],stbl:[],stco:[],stsc:[],stsd:[],stsz:[],stts:[],styp:[],tfdt:[],tfhd:[],traf:[],trak:[],trun:[],trex:[],tkhd:[],vmhd:[]},"undefined"!=typeof Uint8Array){for(t in T)T.hasOwnProperty(t)&&(T[t]=[t.charCodeAt(0),t.charCodeAt(1),t.charCodeAt(2),t.charCodeAt(3)]);C=new Uint8Array(["i".charCodeAt(0),"s".charCodeAt(0),"o".charCodeAt(0),"m".charCodeAt(0)]),P=new Uint8Array(["a".charCodeAt(0),"v".charCodeAt(0),"c".charCodeAt(0),"1".charCodeAt(0)]),k=new Uint8Array([0,0,0,1]),A=new Uint8Array([0,0,0,0,0,0,0,0,118,105,100,101,0,0,0,0,0,0,0,0,0,0,0,0,86,105,100,101,111,72,97,110,100,108,101,114,0]),U=new Uint8Array([0,0,0,0,0,0,0,0,115,111,117,110,0,0,0,0,0,0,0,0,0,0,0,0,83,111,117,110,100,72,97,110,100,108,101,114,0]),D={video:A,audio:U},x=new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,12,117,114,108,32,0,0,0,1]),L=new Uint8Array([0,0,0,0,0,0,0,0]),O=new Uint8Array([0,0,0,0,0,0,0,0]),I=O,R=new Uint8Array([0,0,0,0,0,0,0,0,0,0,0,0]),M=O,E=new Uint8Array([0,0,0,1,0,0,0,0,0,0,0,0])}}(),i=function(t){var e,i,n=[],a=0;for(e=1;e<arguments.length;e++)n.push(arguments[e]);for(e=n.length;e--;)a+=n[e].byteLength;for(i=new Uint8Array(a+8),new DataView(i.buffer,i.byteOffset,i.byteLength).setUint32(0,i.byteLength),i.set(t,4),e=0,a=8;e<n.length;e++)i.set(n[e],a),a+=n[e].byteLength;return i},n=function(){return i(T.dinf,i(T.dref,x))},a=function(t){return i(T.esds,new Uint8Array([0,0,0,0,3,25,0,0,0,4,17,64,21,0,6,0,0,0,218,192,0,0,218,192,5,2,t.audioobjecttype<<3|t.samplingfrequencyindex>>>1,t.samplingfrequencyindex<<7|t.channelcount<<3,6,1,2]))},m=function(t){return i(T.hdlr,D[t])},g=function(t){var e=new Uint8Array([0,0,0,0,0,0,0,2,0,0,0,3,0,1,95,144,t.duration>>>24&255,t.duration>>>16&255,t.duration>>>8&255,255&t.duration,85,196,0,0]);return t.samplerate&&(e[12]=t.samplerate>>>24&255,e[13]=t.samplerate>>>16&255,e[14]=t.samplerate>>>8&255,e[15]=255&t.samplerate),i(T.mdhd,e)},f=function(t){return i(T.mdia,g(t),m(t.type),o(t))},s=function(t){return i(T.mfhd,new Uint8Array([0,0,0,0,(4278190080&t)>>24,(16711680&t)>>16,(65280&t)>>8,255&t]))},o=function(t){return i(T.minf,"video"===t.type?i(T.vmhd,E):i(T.smhd,L),n(),S(t))},d=function(t,e){for(var n=[],a=e.length;a--;)n[a]=b(e[a]);return i.apply(null,[T.moof,s(t)].concat(n))},h=function(t){for(var e=t.length,n=[];e--;)n[e]=l(t[e]);return i.apply(null,[T.moov,u(4294967295)].concat(n).concat(p(t)))},p=function(t){for(var e=t.length,n=[];e--;)n[e]=_(t[e]);return i.apply(null,[T.mvex].concat(n))},u=function(t){var e=new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,2,0,1,95,144,(4278190080&t)>>24,(16711680&t)>>16,(65280&t)>>8,255&t,0,1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,255,255,255,255]);return i(T.mvhd,e)},y=function(t){var e,n,a=t.samples||[],r=new Uint8Array(4+a.length);for(n=0;n<a.length;n++)e=a[n].flags,r[n+4]=e.dependsOn<<4|e.isDependedOn<<2|e.hasRedundancy;return i(T.sdtp,r)},S=function(t){return i(T.stbl,v(t),i(T.stts,M),i(T.stsc,I),i(T.stsz,R),i(T.stco,O))},v=function(t){return i(T.stsd,new Uint8Array([0,0,0,0,0,0,0,1]),"video"===t.type?N(t):B(t))},N=function(t){var e,n,a=t.sps||[],r=t.pps||[],s=[],o=[];for(e=0;e<a.length;e++)s.push((65280&a[e].byteLength)>>>8),s.push(255&a[e].byteLength),s=s.concat(Array.prototype.slice.call(a[e]));for(e=0;e<r.length;e++)o.push((65280&r[e].byteLength)>>>8),o.push(255&r[e].byteLength),o=o.concat(Array.prototype.slice.call(r[e]));if(n=[T.avc1,new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,(65280&t.width)>>8,255&t.width,(65280&t.height)>>8,255&t.height,0,72,0,0,0,72,0,0,0,0,0,0,0,1,19,118,105,100,101,111,106,115,45,99,111,110,116,114,105,98,45,104,108,115,0,0,0,0,0,0,0,0,0,0,0,0,0,24,17,17]),i(T.avcC,new Uint8Array([1,t.profileIdc,t.profileCompatibility,t.levelIdc,255].concat([a.length],s,[r.length],o))),i(T.btrt,new Uint8Array([0,28,156,128,0,45,198,192,0,45,198,192]))],t.sarRatio){var d=t.sarRatio[0],h=t.sarRatio[1];n.push(i(T.pasp,new Uint8Array([(4278190080&d)>>24,(16711680&d)>>16,(65280&d)>>8,255&d,(4278190080&h)>>24,(16711680&h)>>16,(65280&h)>>8,255&h])))}return i.apply(null,n)},B=function(t){return i(T.mp4a,new Uint8Array([0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,(65280&t.channelcount)>>8,255&t.channelcount,(65280&t.samplesize)>>8,255&t.samplesize,0,0,0,0,(65280&t.samplerate)>>8,255&t.samplerate,0,0]),a(t))},c=function(t){var e=new Uint8Array([0,0,0,7,0,0,0,0,0,0,0,0,(4278190080&t.id)>>24,(16711680&t.id)>>16,(65280&t.id)>>8,255&t.id,0,0,0,0,(4278190080&t.duration)>>24,(16711680&t.duration)>>16,(65280&t.duration)>>8,255&t.duration,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,64,0,0,0,(65280&t.width)>>8,255&t.width,0,0,(65280&t.height)>>8,255&t.height,0,0]);return i(T.tkhd,e)},b=function(t){var e,n,a,r,s,o;return e=i(T.tfhd,new Uint8Array([0,0,0,58,(4278190080&t.id)>>24,(16711680&t.id)>>16,(65280&t.id)>>8,255&t.id,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0])),s=Math.floor(t.baseMediaDecodeTime/X),o=Math.floor(t.baseMediaDecodeTime%X),n=i(T.tfdt,new Uint8Array([1,0,0,0,s>>>24&255,s>>>16&255,s>>>8&255,255&s,o>>>24&255,o>>>16&255,o>>>8&255,255&o])),92,"audio"===t.type?(a=w(t,92),i(T.traf,e,n,a)):(r=y(t),a=w(t,r.length+92),i(T.traf,e,n,a,r))},l=function(t){return t.duration=t.duration||4294967295,i(T.trak,c(t),f(t))},_=function(t){var e=new Uint8Array([0,0,0,0,(4278190080&t.id)>>24,(16711680&t.id)>>16,(65280&t.id)>>8,255&t.id,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,1]);return"video"!==t.type&&(e[e.length-1]=0),i(T.trex,e)},z=function(t,e){var i=0,n=0,a=0,r=0;return t.length&&(void 0!==t[0].duration&&(i=1),void 0!==t[0].size&&(n=2),void 0!==t[0].flags&&(a=4),void 0!==t[0].compositionTimeOffset&&(r=8)),[0,0,i|n|a|r,1,(4278190080&t.length)>>>24,(16711680&t.length)>>>16,(65280&t.length)>>>8,255&t.length,(4278190080&e)>>>24,(16711680&e)>>>16,(65280&e)>>>8,255&e]},G=function(t,e){var n,a,r,s,o,d;for(e+=20+16*(s=t.samples||[]).length,r=z(s,e),(a=new Uint8Array(r.length+16*s.length)).set(r),n=r.length,d=0;d<s.length;d++)o=s[d],a[n++]=(4278190080&o.duration)>>>24,a[n++]=(16711680&o.duration)>>>16,a[n++]=(65280&o.duration)>>>8,a[n++]=255&o.duration,a[n++]=(4278190080&o.size)>>>24,a[n++]=(16711680&o.size)>>>16,a[n++]=(65280&o.size)>>>8,a[n++]=255&o.size,a[n++]=o.flags.isLeading<<2|o.flags.dependsOn,a[n++]=o.flags.isDependedOn<<6|o.flags.hasRedundancy<<4|o.flags.paddingValue<<1|o.flags.isNonSyncSample,a[n++]=61440&o.flags.degradationPriority,a[n++]=15&o.flags.degradationPriority,a[n++]=(4278190080&o.compositionTimeOffset)>>>24,a[n++]=(16711680&o.compositionTimeOffset)>>>16,a[n++]=(65280&o.compositionTimeOffset)>>>8,a[n++]=255&o.compositionTimeOffset;return i(T.trun,a)},W=function(t,e){var n,a,r,s,o,d;for(e+=20+8*(s=t.samples||[]).length,r=z(s,e),(n=new Uint8Array(r.length+8*s.length)).set(r),a=r.length,d=0;d<s.length;d++)o=s[d],n[a++]=(4278190080&o.duration)>>>24,n[a++]=(16711680&o.duration)>>>16,n[a++]=(65280&o.duration)>>>8,n[a++]=255&o.duration,n[a++]=(4278190080&o.size)>>>24,n[a++]=(16711680&o.size)>>>16,n[a++]=(65280&o.size)>>>8,n[a++]=255&o.size;return i(T.trun,n)},w=function(t,e){return"audio"===t.type?W(t,e):G(t,e)};var j,q,H,$,Z,K,J,Q={ftyp:r=function(){return i(T.ftyp,C,k,C,P)},mdat:function(t){return i(T.mdat,t)},moof:d,moov:h,initSegment:function(t){var e,i=r(),n=h(t);return(e=new Uint8Array(i.byteLength+n.byteLength)).set(i),e.set(n,i.byteLength),e}},tt=function(t){return t>>>0},et=function(t){var e="";return e+=String.fromCharCode(t[0]),e+=String.fromCharCode(t[1]),e+=String.fromCharCode(t[2]),e+=String.fromCharCode(t[3])},it=tt,nt=function t(e,i){var n,a,r,s,o,d=[];if(!i.length)return null;for(n=0;n<e.byteLength;)a=it(e[n]<<24|e[n+1]<<16|e[n+2]<<8|e[n+3]),r=et(e.subarray(n+4,n+8)),s=a>1?n+a:e.byteLength,r===i[0]&&(1===i.length?d.push(e.subarray(n+8,s)):(o=t(e.subarray(n+8,s),i.slice(1))).length&&(d=d.concat(o))),n=s;return d},at=function(t){for(var e=0,i=String.fromCharCode(t[e]),n="";"\0"!==i;)n+=i,e++,i=String.fromCharCode(t[e]);return n+=i},rt=Y.getUint64,st=function(t,e){var i="\0"!==e.scheme_id_uri,n=0===t&&ot(e.presentation_time_delta)&&i,a=1===t&&ot(e.presentation_time)&&i;return!(t>1)&&n||a},ot=function(t){return void 0!==t||null!==t},dt=function(t){var e,i,n,a,r,s,o,d=4,h=t[0];if(0===h)d+=(e=at(t.subarray(d))).length,d+=(i=at(t.subarray(d))).length,n=(p=new DataView(t.buffer)).getUint32(d),d+=4,r=p.getUint32(d),d+=4,s=p.getUint32(d),d+=4,o=p.getUint32(d),d+=4;else if(1===h){var p;n=(p=new DataView(t.buffer)).getUint32(d),d+=4,a=rt(t.subarray(d)),d+=8,s=p.getUint32(d),d+=4,o=p.getUint32(d),d+=4,d+=(e=at(t.subarray(d))).length,d+=(i=at(t.subarray(d))).length}var u={scheme_id_uri:e,value:i,timescale:n||1,presentation_time:a,presentation_time_delta:r,event_duration:s,id:o,message_data:new Uint8Array(t.subarray(d,t.byteLength))};return st(h,u)?u:void 0},ht=function(t,e,i,n){return t||0===t?t/e:n+i/e},pt=function(t){var e,i=new DataView(t.buffer,t.byteOffset,t.byteLength),n={version:t[0],flags:new Uint8Array(t.subarray(1,4)),trackId:i.getUint32(4)},a=1&n.flags[2],r=2&n.flags[2],s=8&n.flags[2],o=16&n.flags[2],d=32&n.flags[2],h=65536&n.flags[0],p=131072&n.flags[0];return e=8,a&&(e+=4,n.baseDataOffset=i.getUint32(12),e+=4),r&&(n.sampleDescriptionIndex=i.getUint32(e),e+=4),s&&(n.defaultSampleDuration=i.getUint32(e),e+=4),o&&(n.defaultSampleSize=i.getUint32(e),e+=4),d&&(n.defaultSampleFlags=i.getUint32(e)),h&&(n.durationIsEmpty=!0),!a&&p&&(n.baseDataOffsetIsMoof=!0),n},ut=function(t){return{isLeading:(12&t[0])>>>2,dependsOn:3&t[0],isDependedOn:(192&t[1])>>>6,hasRedundancy:(48&t[1])>>>4,paddingValue:(14&t[1])>>>1,isNonSyncSample:1&t[1],degradationPriority:t[2]<<8|t[3]}},lt=function(t){var e,i={version:t[0],flags:new Uint8Array(t.subarray(1,4)),samples:[]},n=new DataView(t.buffer,t.byteOffset,t.byteLength),a=1&i.flags[2],r=4&i.flags[2],s=1&i.flags[1],o=2&i.flags[1],d=4&i.flags[1],h=8&i.flags[1],p=n.getUint32(4),u=8;for(a&&(i.dataOffset=n.getInt32(u),u+=4),r&&p&&(e={flags:ut(t.subarray(u,u+4))},u+=4,s&&(e.duration=n.getUint32(u),u+=4),o&&(e.size=n.getUint32(u),u+=4),h&&(1===i.version?e.compositionTimeOffset=n.getInt32(u):e.compositionTimeOffset=n.getUint32(u),u+=4),i.samples.push(e),p--);p--;)e={},s&&(e.duration=n.getUint32(u),u+=4),o&&(e.size=n.getUint32(u),u+=4),d&&(e.flags=ut(t.subarray(u,u+4)),u+=4),h&&(1===i.version?e.compositionTimeOffset=n.getInt32(u):e.compositionTimeOffset=n.getUint32(u),u+=4),i.samples.push(e);return i},ct=tt,ft=Y.getUint64,gt=function(t){var e={version:t[0],flags:new Uint8Array(t.subarray(1,4))};return 1===e.version?e.baseMediaDecodeTime=ft(t.subarray(4)):e.baseMediaDecodeTime=ct(t[4]<<24|t[5]<<16|t[6]<<8|t[7]),e},mt=function(t,e,i){if(!t)return-1;for(var n=i;n<t.length;n++)if(t[n]===e)return n;return-1},yt=3,St=function(t,e,i){var n,a="";for(n=e;n<i;n++)a+="%"+("00"+t[n].toString(16)).slice(-2);return a},vt=function(t,e,i){return decodeURIComponent(St(t,e,i))},bt=function(t,e,i){return unescape(St(t,e,i))},_t=function(t){return t[0]<<21|t[1]<<14|t[2]<<7|t[3]},wt={APIC:function(t){var e,i,n=1;t.data[0]===yt&&((e=mt(t.data,0,n))<0||(t.mimeType=bt(t.data,n,e),n=e+1,t.pictureType=t.data[n],n++,(i=mt(t.data,0,n))<0||(t.description=vt(t.data,n,i),n=i+1,"--\x3e"===t.mimeType?t.url=bt(t.data,n,t.data.length):t.pictureData=t.data.subarray(n,t.data.length))))},"T*":function(t){t.data[0]===yt&&(t.value=vt(t.data,1,t.data.length).replace(/\0*$/,""),t.values=t.value.split("\0"))},TXXX:function(t){var e;t.data[0]===yt&&-1!==(e=mt(t.data,0,1))&&(t.description=vt(t.data,1,e),t.value=vt(t.data,e+1,t.data.length).replace(/\0*$/,""),t.data=t.value)},"W*":function(t){t.url=bt(t.data,0,t.data.length).replace(/\0.*$/,"")},WXXX:function(t){var e;t.data[0]===yt&&-1!==(e=mt(t.data,0,1))&&(t.description=vt(t.data,1,e),t.url=bt(t.data,e+1,t.data.length).replace(/\0.*$/,""))},PRIV:function(t){var e;for(e=0;e<t.data.length;e++)if(0===t.data[e]){t.owner=bt(t.data,0,e);break}t.privateData=t.data.subarray(e+1),t.data=t.privateData}},Tt={parseId3Frames:function(t){var e,i=10,n=0,a=[];if(!(t.length<10||t[0]!=="I".charCodeAt(0)||t[1]!=="D".charCodeAt(0)||t[2]!=="3".charCodeAt(0))){n=_t(t.subarray(6,10)),n+=10,64&t[5]&&(i+=4,i+=_t(t.subarray(10,14)),n-=_t(t.subarray(16,20)));do{if((e=_t(t.subarray(i+4,i+8)))<1)break;var r={id:String.fromCharCode(t[i],t[i+1],t[i+2],t[i+3]),data:t.subarray(i+10,i+e+10)};r.key=r.id,wt[r.id]?wt[r.id](r):"T"===r.id[0]?wt["T*"](r):"W"===r.id[0]&&wt["W*"](r),a.push(r),i+=10,i+=e}while(i<n);return a}},parseSyncSafeInteger:_t,frameParsers:wt},Ct=tt,kt=function(t){return("00"+t.toString(16)).slice(-2)},Pt=Y.getUint64,At=Tt.parseId3Frames;j=function(t){return nt(t,["moov","trak"]).reduce((function(t,e){var i,n,a,r,s;return(i=nt(e,["tkhd"])[0])?(n=i[0],r=Ct(i[a=0===n?12:20]<<24|i[a+1]<<16|i[a+2]<<8|i[a+3]),(s=nt(e,["mdia","mdhd"])[0])?(a=0===(n=s[0])?12:20,t[r]=Ct(s[a]<<24|s[a+1]<<16|s[a+2]<<8|s[a+3]),t):null):null}),{})},q=function(t,e){var i=nt(e,["moof","traf"]).reduce((function(e,i){var n,a,r=nt(i,["tfhd"])[0],s=Ct(r[4]<<24|r[5]<<16|r[6]<<8|r[7]),o=t[s]||9e4,d=nt(i,["tfdt"])[0],h=new DataView(d.buffer,d.byteOffset,d.byteLength);return"bigint"==typeof(n=1===d[0]?Pt(d.subarray(4,12)):h.getUint32(4))?a=n/F.default.BigInt(o):"number"!=typeof n||isNaN(n)||(a=n/o),a<Number.MAX_SAFE_INTEGER&&(a=Number(a)),a<e&&(e=a),e}),1/0);return"bigint"==typeof i||isFinite(i)?i:0},H=function(t,e){var i,n=nt(e,["moof","traf"]),a=0,r=0;if(n&&n.length){var s=nt(n[0],["tfhd"])[0],o=nt(n[0],["trun"])[0],d=nt(n[0],["tfdt"])[0];if(s)i=pt(s).trackId;if(d)a=gt(d).baseMediaDecodeTime;if(o){var h=lt(o);h.samples&&h.samples.length&&(r=h.samples[0].compositionTimeOffset||0)}}var p=t[i]||9e4;"bigint"==typeof a&&(r=F.default.BigInt(r),p=F.default.BigInt(p));var u=(a+r)/p;return"bigint"==typeof u&&u<Number.MAX_SAFE_INTEGER&&(u=Number(u)),u},$=function(t){var e=nt(t,["moov","trak"]),i=[];return e.forEach((function(t){var e=nt(t,["mdia","hdlr"]),n=nt(t,["tkhd"]);e.forEach((function(t,e){var a,r,s=et(t.subarray(8,12)),o=n[e];"vide"===s&&(r=0===(a=new DataView(o.buffer,o.byteOffset,o.byteLength)).getUint8(0)?a.getUint32(12):a.getUint32(20),i.push(r))}))})),i},Z=function(t){var e=nt(t,["moov","trak"]),i=[];return e.forEach((function(t){var e,n,a={},r=nt(t,["tkhd"])[0];r&&(n=(e=new DataView(r.buffer,r.byteOffset,r.byteLength)).getUint8(0),a.id=0===n?e.getUint32(12):e.getUint32(20));var s=nt(t,["mdia","hdlr"])[0];if(s){var o=et(s.subarray(8,12));a.type="vide"===o?"video":"soun"===o?"audio":o}var d=nt(t,["mdia","minf","stbl","stsd"])[0];if(d){var h=d.subarray(8);a.codec=et(h.subarray(4,8));var p,u=nt(h,[a.codec])[0];u&&(/^[asm]vc[1-9]$/i.test(a.codec)?(p=u.subarray(78),"avcC"===et(p.subarray(4,8))&&p.length>11?(a.codec+=".",a.codec+=kt(p[9]),a.codec+=kt(p[10]),a.codec+=kt(p[11])):a.codec="avc1.4d400d"):/^mp4[a,v]$/i.test(a.codec)?(p=u.subarray(28),"esds"===et(p.subarray(4,8))&&p.length>20&&0!==p[19]?(a.codec+="."+kt(p[19]),a.codec+="."+kt(p[20]>>>2&63).replace(/^0/,"")):a.codec="mp4a.40.2"):a.codec=a.codec.toLowerCase())}var l=nt(t,["mdia","mdhd"])[0];l&&(a.timescale=K(l)),i.push(a)})),i},J=function(t,e){return void 0===e&&(e=0),nt(t,["emsg"]).map((function(t){var i=dt(new Uint8Array(t)),n=At(i.message_data);return{cueTime:ht(i.presentation_time,i.timescale,i.presentation_time_delta,e),duration:ht(i.event_duration,i.timescale),frames:n}}))};var Ut={findBox:nt,parseType:et,timescale:j,startTime:q,compositionStartTime:H,videoTrackIds:$,tracks:Z,getTimescaleFromMediaHeader:K=function(t){var e=0===t[0]?12:20;return Ct(t[e]<<24|t[e+1]<<16|t[e+2]<<8|t[e+3])},getEmsgID3:J},Dt=function(){this.init=function(){var t={};this.on=function(e,i){t[e]||(t[e]=[]),t[e]=t[e].concat(i)},this.off=function(e,i){var n;return!!t[e]&&(n=t[e].indexOf(i),t[e]=t[e].slice(),t[e].splice(n,1),n>-1)},this.trigger=function(e){var i,n,a,r;if(i=t[e])if(2===arguments.length)for(a=i.length,n=0;n<a;++n)i[n].call(this,arguments[1]);else{for(r=[],n=arguments.length,n=1;n<arguments.length;++n)r.push(arguments[n]);for(a=i.length,n=0;n<a;++n)i[n].apply(this,r)}},this.dispose=function(){t={}}}};Dt.prototype.pipe=function(t){return this.on("data",(function(e){t.push(e)})),this.on("done",(function(e){t.flush(e)})),this.on("partialdone",(function(e){t.partialFlush(e)})),this.on("endedtimeline",(function(e){t.endTimeline(e)})),this.on("reset",(function(e){t.reset(e)})),t},Dt.prototype.push=function(t){this.trigger("data",t)},Dt.prototype.flush=function(t){this.trigger("done",t)},Dt.prototype.partialFlush=function(t){this.trigger("partialdone",t)},Dt.prototype.endTimeline=function(t){this.trigger("endedtimeline",t)},Dt.prototype.reset=function(t){this.trigger("reset",t)};var Et,Lt,xt,Ot,It,Rt,Mt,Nt,Bt=Dt,Wt=function(t,e){var i={size:0,flags:{isLeading:0,dependsOn:1,isDependedOn:0,hasRedundancy:0,degradationPriority:0,isNonSyncSample:1}};return i.dataOffset=e,i.compositionTimeOffset=t.pts-t.dts,i.duration=t.duration,i.size=4*t.length,i.size+=t.byteLength,t.keyFrame&&(i.flags.dependsOn=2,i.flags.isNonSyncSample=0),i},Gt=function(t){var e,i,n=[],a=[];for(a.byteLength=0,a.nalCount=0,a.duration=0,n.byteLength=0,e=0;e<t.length;e++)"access_unit_delimiter_rbsp"===(i=t[e]).nalUnitType?(n.length&&(n.duration=i.dts-n.dts,a.byteLength+=n.byteLength,a.nalCount+=n.length,a.duration+=n.duration,a.push(n)),(n=[i]).byteLength=i.data.byteLength,n.pts=i.pts,n.dts=i.dts):("slice_layer_without_partitioning_rbsp_idr"===i.nalUnitType&&(n.keyFrame=!0),n.duration=i.dts-n.dts,n.byteLength+=i.data.byteLength,n.push(i));return a.length&&(!n.duration||n.duration<=0)&&(n.duration=a[a.length-1].duration),a.byteLength+=n.byteLength,a.nalCount+=n.length,a.duration+=n.duration,a.push(n),a},zt=function(t){var e,i,n=[],a=[];for(n.byteLength=0,n.nalCount=0,n.duration=0,n.pts=t[0].pts,n.dts=t[0].dts,a.byteLength=0,a.nalCount=0,a.duration=0,a.pts=t[0].pts,a.dts=t[0].dts,e=0;e<t.length;e++)(i=t[e]).keyFrame?(n.length&&(a.push(n),a.byteLength+=n.byteLength,a.nalCount+=n.nalCount,a.duration+=n.duration),(n=[i]).nalCount=i.length,n.byteLength=i.byteLength,n.pts=i.pts,n.dts=i.dts,n.duration=i.duration):(n.duration+=i.duration,n.nalCount+=i.length,n.byteLength+=i.byteLength,n.push(i));return a.length&&n.duration<=0&&(n.duration=a[a.length-1].duration),a.byteLength+=n.byteLength,a.nalCount+=n.nalCount,a.duration+=n.duration,a.push(n),a},Ft=function(t){var e;return!t[0][0].keyFrame&&t.length>1&&(e=t.shift(),t.byteLength-=e.byteLength,t.nalCount-=e.nalCount,t[0][0].dts=e.dts,t[0][0].pts=e.pts,t[0][0].duration+=e.duration),t},Vt=function(t,e){var i,n,a,r,s,o=e||0,d=[];for(i=0;i<t.length;i++)for(r=t[i],n=0;n<r.length;n++)s=r[n],o+=(a=Wt(s,o)).size,d.push(a);return d},Yt=function(t){var e,i,n,a,r,s,o=0,d=t.byteLength,h=t.nalCount,p=new Uint8Array(d+4*h),u=new DataView(p.buffer);for(e=0;e<t.length;e++)for(a=t[e],i=0;i<a.length;i++)for(r=a[i],n=0;n<r.length;n++)s=r[n],u.setUint32(o,s.data.byteLength),o+=4,p.set(s.data,o),o+=s.data.byteLength;return p},Xt=[33,16,5,32,164,27],jt=[33,65,108,84,1,2,4,8,168,2,4,8,17,191,252],qt=function(t){for(var e=[];t--;)e.push(0);return e},Ht=function(){if(!Et){var t={96e3:[Xt,[227,64],qt(154),[56]],88200:[Xt,[231],qt(170),[56]],64e3:[Xt,[248,192],qt(240),[56]],48e3:[Xt,[255,192],qt(268),[55,148,128],qt(54),[112]],44100:[Xt,[255,192],qt(268),[55,163,128],qt(84),[112]],32e3:[Xt,[255,192],qt(268),[55,234],qt(226),[112]],24e3:[Xt,[255,192],qt(268),[55,255,128],qt(268),[111,112],qt(126),[224]],16e3:[Xt,[255,192],qt(268),[55,255,128],qt(268),[111,255],qt(269),[223,108],qt(195),[1,192]],12e3:[jt,qt(268),[3,127,248],qt(268),[6,255,240],qt(268),[13,255,224],qt(268),[27,253,128],qt(259),[56]],11025:[jt,qt(268),[3,127,248],qt(268),[6,255,240],qt(268),[13,255,224],qt(268),[27,255,192],qt(268),[55,175,128],qt(108),[112]],8e3:[jt,qt(268),[3,121,16],qt(47),[7]]};e=t,Et=Object.keys(e).reduce((function(t,i){return t[i]=new Uint8Array(e[i].reduce((function(t,e){return t.concat(e)}),[])),t}),{})}var e;return Et},$t=9e4;Rt=function(t,e){return Lt(It(t,e))},Mt=function(t,e){return xt(Ot(t),e)},Nt=function(t,e,i){return Ot(i?t:t-e)};var Zt=$t,Kt=(Lt=function(t){return t*$t},xt=function(t,e){return t*e},Ot=function(t){return t/$t},It=function(t,e){return t/e},Rt),Jt=Mt,Qt=Nt,te=function(t,e,i,n){var a,r,s,o,d,h=0,p=0,u=0;if(e.length&&(a=Kt(t.baseMediaDecodeTime,t.samplerate),r=Math.ceil(Zt/(t.samplerate/1024)),i&&n&&(h=a-Math.max(i,n),u=(p=Math.floor(h/r))*r),!(p<1||u>Zt/2))){for((s=Ht()[t.samplerate])||(s=e[0].data),o=0;o<p;o++)d=e[0],e.splice(0,0,{data:s,dts:d.dts-r,pts:d.pts-r});return t.baseMediaDecodeTime-=Math.floor(Jt(u,t.samplerate)),u}},ee=function(t,e,i){return e.minSegmentDts>=i?t:(e.minSegmentDts=1/0,t.filter((function(t){return t.dts>=i&&(e.minSegmentDts=Math.min(e.minSegmentDts,t.dts),e.minSegmentPts=e.minSegmentDts,!0)})))},ie=function(t){var e,i,n=[];for(e=0;e<t.length;e++)i=t[e],n.push({size:i.data.byteLength,duration:1024});return n},ne=function(t){var e,i,n=0,a=new Uint8Array(function(t){var e,i=0;for(e=0;e<t.length;e++)i+=t[e].data.byteLength;return i}(t));for(e=0;e<t.length;e++)i=t[e],a.set(i.data,n),n+=i.data.byteLength;return a},ae=Zt,re=function(t){delete t.minSegmentDts,delete t.maxSegmentDts,delete t.minSegmentPts,delete t.maxSegmentPts},se=function(t,e){var i,n=t.minSegmentDts;return e||(n-=t.timelineStartInfo.dts),i=t.timelineStartInfo.baseMediaDecodeTime,i+=n,i=Math.max(0,i),"audio"===t.type&&(i*=t.samplerate/ae,i=Math.floor(i)),i},oe=function(t,e){"number"==typeof e.pts&&(void 0===t.timelineStartInfo.pts&&(t.timelineStartInfo.pts=e.pts),void 0===t.minSegmentPts?t.minSegmentPts=e.pts:t.minSegmentPts=Math.min(t.minSegmentPts,e.pts),void 0===t.maxSegmentPts?t.maxSegmentPts=e.pts:t.maxSegmentPts=Math.max(t.maxSegmentPts,e.pts)),"number"==typeof e.dts&&(void 0===t.timelineStartInfo.dts&&(t.timelineStartInfo.dts=e.dts),void 0===t.minSegmentDts?t.minSegmentDts=e.dts:t.minSegmentDts=Math.min(t.minSegmentDts,e.dts),void 0===t.maxSegmentDts?t.maxSegmentDts=e.dts:t.maxSegmentDts=Math.max(t.maxSegmentDts,e.dts))},de=function(t){for(var e=0,i={payloadType:-1,payloadSize:0},n=0,a=0;e<t.byteLength&&128!==t[e];){for(;255===t[e];)n+=255,e++;for(n+=t[e++];255===t[e];)a+=255,e++;if(a+=t[e++],!i.payload&&4===n){if("GA94"===String.fromCharCode(t[e+3],t[e+4],t[e+5],t[e+6])){i.payloadType=n,i.payloadSize=a,i.payload=t.subarray(e,e+a);break}i.payload=void 0}e+=a,n=0,a=0}return i},he=function(t){return 181!==t.payload[0]||49!=(t.payload[1]<<8|t.payload[2])||"GA94"!==String.fromCharCode(t.payload[3],t.payload[4],t.payload[5],t.payload[6])||3!==t.payload[7]?null:t.payload.subarray(8,t.payload.length-1)},pe=function(t,e){var i,n,a,r,s=[];if(!(64&e[0]))return s;for(n=31&e[0],i=0;i<n;i++)r={type:3&e[(a=3*i)+2],pts:t},4&e[a+2]&&(r.ccData=e[a+3]<<8|e[a+4],s.push(r));return s},ue=function(t){for(var e,i,n=t.byteLength,a=[],r=1;r<n-2;)0===t[r]&&0===t[r+1]&&3===t[r+2]?(a.push(r+2),r+=2):r++;if(0===a.length)return t;e=n-a.length,i=new Uint8Array(e);var s=0;for(r=0;r<e;s++,r++)s===a[0]&&(s++,a.shift()),i[r]=t[s];return i},le=4,ce=function t(e){e=e||{},t.prototype.init.call(this),this.parse708captions_="boolean"!=typeof e.parse708captions||e.parse708captions,this.captionPackets_=[],this.ccStreams_=[new Te(0,0),new Te(0,1),new Te(1,0),new Te(1,1)],this.parse708captions_&&(this.cc708Stream_=new Se({captionServices:e.captionServices})),this.reset(),this.ccStreams_.forEach((function(t){t.on("data",this.trigger.bind(this,"data")),t.on("partialdone",this.trigger.bind(this,"partialdone")),t.on("done",this.trigger.bind(this,"done"))}),this),this.parse708captions_&&(this.cc708Stream_.on("data",this.trigger.bind(this,"data")),this.cc708Stream_.on("partialdone",this.trigger.bind(this,"partialdone")),this.cc708Stream_.on("done",this.trigger.bind(this,"done")))};(ce.prototype=new Bt).push=function(t){var e,i,n;if("sei_rbsp"===t.nalUnitType&&(e=de(t.escapedRBSP)).payload&&e.payloadType===le&&(i=he(e)))if(t.dts<this.latestDts_)this.ignoreNextEqualDts_=!0;else{if(t.dts===this.latestDts_&&this.ignoreNextEqualDts_)return this.numSameDts_--,void(this.numSameDts_||(this.ignoreNextEqualDts_=!1));n=pe(t.pts,i),this.captionPackets_=this.captionPackets_.concat(n),this.latestDts_!==t.dts&&(this.numSameDts_=0),this.numSameDts_++,this.latestDts_=t.dts}},ce.prototype.flushCCStreams=function(t){this.ccStreams_.forEach((function(e){return"flush"===t?e.flush():e.partialFlush()}),this)},ce.prototype.flushStream=function(t){this.captionPackets_.length?(this.captionPackets_.forEach((function(t,e){t.presortIndex=e})),this.captionPackets_.sort((function(t,e){return t.pts===e.pts?t.presortIndex-e.presortIndex:t.pts-e.pts})),this.captionPackets_.forEach((function(t){t.type<2?this.dispatchCea608Packet(t):this.dispatchCea708Packet(t)}),this),this.captionPackets_.length=0,this.flushCCStreams(t)):this.flushCCStreams(t)},ce.prototype.flush=function(){return this.flushStream("flush")},ce.prototype.partialFlush=function(){return this.flushStream("partialFlush")},ce.prototype.reset=function(){this.latestDts_=null,this.ignoreNextEqualDts_=!1,this.numSameDts_=0,this.activeCea608Channel_=[null,null],this.ccStreams_.forEach((function(t){t.reset()}))},ce.prototype.dispatchCea608Packet=function(t){this.setsTextOrXDSActive(t)?this.activeCea608Channel_[t.type]=null:this.setsChannel1Active(t)?this.activeCea608Channel_[t.type]=0:this.setsChannel2Active(t)&&(this.activeCea608Channel_[t.type]=1),null!==this.activeCea608Channel_[t.type]&&this.ccStreams_[(t.type<<1)+this.activeCea608Channel_[t.type]].push(t)},ce.prototype.setsChannel1Active=function(t){return 4096==(30720&t.ccData)},ce.prototype.setsChannel2Active=function(t){return 6144==(30720&t.ccData)},ce.prototype.setsTextOrXDSActive=function(t){return 256==(28928&t.ccData)||4138==(30974&t.ccData)||6186==(30974&t.ccData)},ce.prototype.dispatchCea708Packet=function(t){this.parse708captions_&&this.cc708Stream_.push(t)};var fe={127:9834,4128:32,4129:160,4133:8230,4138:352,4140:338,4144:9608,4145:8216,4146:8217,4147:8220,4148:8221,4149:8226,4153:8482,4154:353,4156:339,4157:8480,4159:376,4214:8539,4215:8540,4216:8541,4217:8542,4218:9168,4219:9124,4220:9123,4221:9135,4222:9126,4223:9121,4256:12600},ge=function(t){return 32<=t&&t<=127||160<=t&&t<=255},me=function(t){this.windowNum=t,this.reset()};me.prototype.reset=function(){this.clearText(),this.pendingNewLine=!1,this.winAttr={},this.penAttr={},this.penLoc={},this.penColor={},this.visible=0,this.rowLock=0,this.columnLock=0,this.priority=0,this.relativePositioning=0,this.anchorVertical=0,this.anchorHorizontal=0,this.anchorPoint=0,this.rowCount=1,this.virtualRowCount=this.rowCount+1,this.columnCount=41,this.windowStyle=0,this.penStyle=0},me.prototype.getText=function(){return this.rows.join("\n")},me.prototype.clearText=function(){this.rows=[""],this.rowIdx=0},me.prototype.newLine=function(t){for(this.rows.length>=this.virtualRowCount&&"function"==typeof this.beforeRowOverflow&&this.beforeRowOverflow(t),this.rows.length>0&&(this.rows.push(""),this.rowIdx++);this.rows.length>this.virtualRowCount;)this.rows.shift(),this.rowIdx--},me.prototype.isEmpty=function(){return 0===this.rows.length||1===this.rows.length&&""===this.rows[0]},me.prototype.addText=function(t){this.rows[this.rowIdx]+=t},me.prototype.backspace=function(){if(!this.isEmpty()){var t=this.rows[this.rowIdx];this.rows[this.rowIdx]=t.substr(0,t.length-1)}};var ye=function(t,e,i){this.serviceNum=t,this.text="",this.currentWindow=new me(-1),this.windows=[],this.stream=i,"string"==typeof e&&this.createTextDecoder(e)};ye.prototype.init=function(t,e){this.startPts=t;for(var i=0;i<8;i++)this.windows[i]=new me(i),"function"==typeof e&&(this.windows[i].beforeRowOverflow=e)},ye.prototype.setCurrentWindow=function(t){this.currentWindow=this.windows[t]},ye.prototype.createTextDecoder=function(t){if("undefined"==typeof TextDecoder)this.stream.trigger("log",{level:"warn",message:"The `encoding` option is unsupported without TextDecoder support"});else try{this.textDecoder_=new TextDecoder(t)}catch(e){this.stream.trigger("log",{level:"warn",message:"TextDecoder could not be created with "+t+" encoding. "+e})}};var Se=function t(e){e=e||{},t.prototype.init.call(this);var i,n=this,a=e.captionServices||{},r={};Object.keys(a).forEach((function(t){i=a[t],/^SERVICE/.test(t)&&(r[t]=i.encoding)})),this.serviceEncodings=r,this.current708Packet=null,this.services={},this.push=function(t){3===t.type?(n.new708Packet(),n.add708Bytes(t)):(null===n.current708Packet&&n.new708Packet(),n.add708Bytes(t))}};Se.prototype=new Bt,Se.prototype.new708Packet=function(){null!==this.current708Packet&&this.push708Packet(),this.current708Packet={data:[],ptsVals:[]}},Se.prototype.add708Bytes=function(t){var e=t.ccData,i=e>>>8,n=255&e;this.current708Packet.ptsVals.push(t.pts),this.current708Packet.data.push(i),this.current708Packet.data.push(n)},Se.prototype.push708Packet=function(){var t=this.current708Packet,e=t.data,i=null,n=null,a=0,r=e[a++];for(t.seq=r>>6,t.sizeCode=63&r;a<e.length;a++)n=31&(r=e[a++]),7===(i=r>>5)&&n>0&&(i=r=e[a++]),this.pushServiceBlock(i,a,n),n>0&&(a+=n-1)},Se.prototype.pushServiceBlock=function(t,e,i){var n,a=e,r=this.current708Packet.data,s=this.services[t];for(s||(s=this.initService(t,a));a<e+i&&a<r.length;a++)n=r[a],ge(n)?a=this.handleText(a,s):24===n?a=this.multiByteCharacter(a,s):16===n?a=this.extendedCommands(a,s):128<=n&&n<=135?a=this.setCurrentWindow(a,s):152<=n&&n<=159?a=this.defineWindow(a,s):136===n?a=this.clearWindows(a,s):140===n?a=this.deleteWindows(a,s):137===n?a=this.displayWindows(a,s):138===n?a=this.hideWindows(a,s):139===n?a=this.toggleWindows(a,s):151===n?a=this.setWindowAttributes(a,s):144===n?a=this.setPenAttributes(a,s):145===n?a=this.setPenColor(a,s):146===n?a=this.setPenLocation(a,s):143===n?s=this.reset(a,s):8===n?s.currentWindow.backspace():12===n?s.currentWindow.clearText():13===n?s.currentWindow.pendingNewLine=!0:14===n?s.currentWindow.clearText():141===n&&a++},Se.prototype.extendedCommands=function(t,e){var i=this.current708Packet.data[++t];return ge(i)&&(t=this.handleText(t,e,{isExtended:!0})),t},Se.prototype.getPts=function(t){return this.current708Packet.ptsVals[Math.floor(t/2)]},Se.prototype.initService=function(t,e){var i,n,a=this;return(i="SERVICE"+t)in this.serviceEncodings&&(n=this.serviceEncodings[i]),this.services[t]=new ye(t,n,a),this.services[t].init(this.getPts(e),(function(e){a.flushDisplayed(e,a.services[t])})),this.services[t]},Se.prototype.handleText=function(t,e,i){var n,a,r,s,o=i&&i.isExtended,d=i&&i.isMultiByte,h=this.current708Packet.data,p=o?4096:0,u=h[t],l=h[t+1],c=e.currentWindow;return e.textDecoder_&&!o?(d?(a=[u,l],t++):a=[u],n=e.textDecoder_.decode(new Uint8Array(a))):(s=fe[r=p|u]||r,n=4096&r&&r===s?"":String.fromCharCode(s)),c.pendingNewLine&&!c.isEmpty()&&c.newLine(this.getPts(t)),c.pendingNewLine=!1,c.addText(n),t},Se.prototype.multiByteCharacter=function(t,e){var i=this.current708Packet.data,n=i[t+1],a=i[t+2];return ge(n)&&ge(a)&&(t=this.handleText(++t,e,{isMultiByte:!0})),t},Se.prototype.setCurrentWindow=function(t,e){var i=7&this.current708Packet.data[t];return e.setCurrentWindow(i),t},Se.prototype.defineWindow=function(t,e){var i=this.current708Packet.data,n=i[t],a=7&n;e.setCurrentWindow(a);var r=e.currentWindow;return n=i[++t],r.visible=(32&n)>>5,r.rowLock=(16&n)>>4,r.columnLock=(8&n)>>3,r.priority=7&n,n=i[++t],r.relativePositioning=(128&n)>>7,r.anchorVertical=127&n,n=i[++t],r.anchorHorizontal=n,n=i[++t],r.anchorPoint=(240&n)>>4,r.rowCount=15&n,n=i[++t],r.columnCount=63&n,n=i[++t],r.windowStyle=(56&n)>>3,r.penStyle=7&n,r.virtualRowCount=r.rowCount+1,t},Se.prototype.setWindowAttributes=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.winAttr;return n=i[++t],a.fillOpacity=(192&n)>>6,a.fillRed=(48&n)>>4,a.fillGreen=(12&n)>>2,a.fillBlue=3&n,n=i[++t],a.borderType=(192&n)>>6,a.borderRed=(48&n)>>4,a.borderGreen=(12&n)>>2,a.borderBlue=3&n,n=i[++t],a.borderType+=(128&n)>>5,a.wordWrap=(64&n)>>6,a.printDirection=(48&n)>>4,a.scrollDirection=(12&n)>>2,a.justify=3&n,n=i[++t],a.effectSpeed=(240&n)>>4,a.effectDirection=(12&n)>>2,a.displayEffect=3&n,t},Se.prototype.flushDisplayed=function(t,e){for(var i=[],n=0;n<8;n++)e.windows[n].visible&&!e.windows[n].isEmpty()&&i.push(e.windows[n].getText());e.endPts=t,e.text=i.join("\n\n"),this.pushCaption(e),e.startPts=t},Se.prototype.pushCaption=function(t){""!==t.text&&(this.trigger("data",{startPts:t.startPts,endPts:t.endPts,text:t.text,stream:"cc708_"+t.serviceNum}),t.text="",t.startPts=t.endPts)},Se.prototype.displayWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&(e.windows[a].visible=1);return t},Se.prototype.hideWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&(e.windows[a].visible=0);return t},Se.prototype.toggleWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&(e.windows[a].visible^=1);return t},Se.prototype.clearWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&e.windows[a].clearText();return t},Se.prototype.deleteWindows=function(t,e){var i=this.current708Packet.data[++t],n=this.getPts(t);this.flushDisplayed(n,e);for(var a=0;a<8;a++)i&1<<a&&e.windows[a].reset();return t},Se.prototype.setPenAttributes=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.penAttr;return n=i[++t],a.textTag=(240&n)>>4,a.offset=(12&n)>>2,a.penSize=3&n,n=i[++t],a.italics=(128&n)>>7,a.underline=(64&n)>>6,a.edgeType=(56&n)>>3,a.fontStyle=7&n,t},Se.prototype.setPenColor=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.penColor;return n=i[++t],a.fgOpacity=(192&n)>>6,a.fgRed=(48&n)>>4,a.fgGreen=(12&n)>>2,a.fgBlue=3&n,n=i[++t],a.bgOpacity=(192&n)>>6,a.bgRed=(48&n)>>4,a.bgGreen=(12&n)>>2,a.bgBlue=3&n,n=i[++t],a.edgeRed=(48&n)>>4,a.edgeGreen=(12&n)>>2,a.edgeBlue=3&n,t},Se.prototype.setPenLocation=function(t,e){var i=this.current708Packet.data,n=i[t],a=e.currentWindow.penLoc;return e.currentWindow.pendingNewLine=!0,n=i[++t],a.row=15&n,n=i[++t],a.column=63&n,t},Se.prototype.reset=function(t,e){var i=this.getPts(t);return this.flushDisplayed(i,e),this.initService(e.serviceNum,t)};var ve={42:225,92:233,94:237,95:243,96:250,123:231,124:247,125:209,126:241,127:9608,304:174,305:176,306:189,307:191,308:8482,309:162,310:163,311:9834,312:224,313:160,314:232,315:226,316:234,317:238,318:244,319:251,544:193,545:201,546:211,547:218,548:220,549:252,550:8216,551:161,552:42,553:39,554:8212,555:169,556:8480,557:8226,558:8220,559:8221,560:192,561:194,562:199,563:200,564:202,565:203,566:235,567:206,568:207,569:239,570:212,571:217,572:249,573:219,574:171,575:187,800:195,801:227,802:205,803:204,804:236,805:210,806:242,807:213,808:245,809:123,810:125,811:92,812:94,813:95,814:124,815:126,816:196,817:228,818:214,819:246,820:223,821:165,822:164,823:9474,824:197,825:229,826:216,827:248,828:9484,829:9488,830:9492,831:9496},be=function(t){return null===t?"":(t=ve[t]||t,String.fromCharCode(t))},_e=[4352,4384,4608,4640,5376,5408,5632,5664,5888,5920,4096,4864,4896,5120,5152],we=function(){for(var t=[],e=15;e--;)t.push("");return t},Te=function t(e,i){t.prototype.init.call(this),this.field_=e||0,this.dataChannel_=i||0,this.name_="CC"+(1+(this.field_<<1|this.dataChannel_)),this.setConstants(),this.reset(),this.push=function(t){var e,i,n,a,r;if((e=32639&t.ccData)!==this.lastControlCode_){if(4096==(61440&e)?this.lastControlCode_=e:e!==this.PADDING_&&(this.lastControlCode_=null),n=e>>>8,a=255&e,e!==this.PADDING_)if(e===this.RESUME_CAPTION_LOADING_)this.mode_="popOn";else if(e===this.END_OF_CAPTION_)this.mode_="popOn",this.clearFormatting(t.pts),this.flushDisplayed(t.pts),i=this.displayed_,this.displayed_=this.nonDisplayed_,this.nonDisplayed_=i,this.startPts_=t.pts;else if(e===this.ROLL_UP_2_ROWS_)this.rollUpRows_=2,this.setRollUp(t.pts);else if(e===this.ROLL_UP_3_ROWS_)this.rollUpRows_=3,this.setRollUp(t.pts);else if(e===this.ROLL_UP_4_ROWS_)this.rollUpRows_=4,this.setRollUp(t.pts);else if(e===this.CARRIAGE_RETURN_)this.clearFormatting(t.pts),this.flushDisplayed(t.pts),this.shiftRowsUp_(),this.startPts_=t.pts;else if(e===this.BACKSPACE_)"popOn"===this.mode_?this.nonDisplayed_[this.row_]=this.nonDisplayed_[this.row_].slice(0,-1):this.displayed_[this.row_]=this.displayed_[this.row_].slice(0,-1);else if(e===this.ERASE_DISPLAYED_MEMORY_)this.flushDisplayed(t.pts),this.displayed_=we();else if(e===this.ERASE_NON_DISPLAYED_MEMORY_)this.nonDisplayed_=we();else if(e===this.RESUME_DIRECT_CAPTIONING_)"paintOn"!==this.mode_&&(this.flushDisplayed(t.pts),this.displayed_=we()),this.mode_="paintOn",this.startPts_=t.pts;else if(this.isSpecialCharacter(n,a))r=be((n=(3&n)<<8)|a),this[this.mode_](t.pts,r),this.column_++;else if(this.isExtCharacter(n,a))"popOn"===this.mode_?this.nonDisplayed_[this.row_]=this.nonDisplayed_[this.row_].slice(0,-1):this.displayed_[this.row_]=this.displayed_[this.row_].slice(0,-1),r=be((n=(3&n)<<8)|a),this[this.mode_](t.pts,r),this.column_++;else if(this.isMidRowCode(n,a))this.clearFormatting(t.pts),this[this.mode_](t.pts," "),this.column_++,14==(14&a)&&this.addFormatting(t.pts,["i"]),1==(1&a)&&this.addFormatting(t.pts,["u"]);else if(this.isOffsetControlCode(n,a))this.column_+=3&a;else if(this.isPAC(n,a)){var s=_e.indexOf(7968&e);"rollUp"===this.mode_&&(s-this.rollUpRows_+1<0&&(s=this.rollUpRows_-1),this.setRollUp(t.pts,s)),s!==this.row_&&(this.clearFormatting(t.pts),this.row_=s),1&a&&-1===this.formatting_.indexOf("u")&&this.addFormatting(t.pts,["u"]),16==(16&e)&&(this.column_=4*((14&e)>>1)),this.isColorPAC(a)&&14==(14&a)&&this.addFormatting(t.pts,["i"])}else this.isNormalChar(n)&&(0===a&&(a=null),r=be(n),r+=be(a),this[this.mode_](t.pts,r),this.column_+=r.length)}else this.lastControlCode_=null}};Te.prototype=new Bt,Te.prototype.flushDisplayed=function(t){var e=this.displayed_.map((function(t,e){try{return t.trim()}catch(t){return this.trigger("log",{level:"warn",message:"Skipping a malformed 608 caption at index "+e+"."}),""}}),this).join("\n").replace(/^\n+|\n+$/g,"");e.length&&this.trigger("data",{startPts:this.startPts_,endPts:t,text:e,stream:this.name_})},Te.prototype.reset=function(){this.mode_="popOn",this.topRow_=0,this.startPts_=0,this.displayed_=we(),this.nonDisplayed_=we(),this.lastControlCode_=null,this.column_=0,this.row_=14,this.rollUpRows_=2,this.formatting_=[]},Te.prototype.setConstants=function(){0===this.dataChannel_?(this.BASE_=16,this.EXT_=17,this.CONTROL_=(20|this.field_)<<8,this.OFFSET_=23):1===this.dataChannel_&&(this.BASE_=24,this.EXT_=25,this.CONTROL_=(28|this.field_)<<8,this.OFFSET_=31),this.PADDING_=0,this.RESUME_CAPTION_LOADING_=32|this.CONTROL_,this.END_OF_CAPTION_=47|this.CONTROL_,this.ROLL_UP_2_ROWS_=37|this.CONTROL_,this.ROLL_UP_3_ROWS_=38|this.CONTROL_,this.ROLL_UP_4_ROWS_=39|this.CONTROL_,this.CARRIAGE_RETURN_=45|this.CONTROL_,this.RESUME_DIRECT_CAPTIONING_=41|this.CONTROL_,this.BACKSPACE_=33|this.CONTROL_,this.ERASE_DISPLAYED_MEMORY_=44|this.CONTROL_,this.ERASE_NON_DISPLAYED_MEMORY_=46|this.CONTROL_},Te.prototype.isSpecialCharacter=function(t,e){return t===this.EXT_&&e>=48&&e<=63},Te.prototype.isExtCharacter=function(t,e){return(t===this.EXT_+1||t===this.EXT_+2)&&e>=32&&e<=63},Te.prototype.isMidRowCode=function(t,e){return t===this.EXT_&&e>=32&&e<=47},Te.prototype.isOffsetControlCode=function(t,e){return t===this.OFFSET_&&e>=33&&e<=35},Te.prototype.isPAC=function(t,e){return t>=this.BASE_&&t<this.BASE_+8&&e>=64&&e<=127},Te.prototype.isColorPAC=function(t){return t>=64&&t<=79||t>=96&&t<=127},Te.prototype.isNormalChar=function(t){return t>=32&&t<=127},Te.prototype.setRollUp=function(t,e){if("rollUp"!==this.mode_&&(this.row_=14,this.mode_="rollUp",this.flushDisplayed(t),this.nonDisplayed_=we(),this.displayed_=we()),void 0!==e&&e!==this.row_)for(var i=0;i<this.rollUpRows_;i++)this.displayed_[e-i]=this.displayed_[this.row_-i],this.displayed_[this.row_-i]="";void 0===e&&(e=this.row_),this.topRow_=e-this.rollUpRows_+1},Te.prototype.addFormatting=function(t,e){this.formatting_=this.formatting_.concat(e);var i=e.reduce((function(t,e){return t+"<"+e+">"}),"");this[this.mode_](t,i)},Te.prototype.clearFormatting=function(t){if(this.formatting_.length){var e=this.formatting_.reverse().reduce((function(t,e){return t+"</"+e+">"}),"");this.formatting_=[],this[this.mode_](t,e)}},Te.prototype.popOn=function(t,e){var i=this.nonDisplayed_[this.row_];i+=e,this.nonDisplayed_[this.row_]=i},Te.prototype.rollUp=function(t,e){var i=this.displayed_[this.row_];i+=e,this.displayed_[this.row_]=i},Te.prototype.shiftRowsUp_=function(){var t;for(t=0;t<this.topRow_;t++)this.displayed_[t]="";for(t=this.row_+1;t<15;t++)this.displayed_[t]="";for(t=this.topRow_;t<this.row_;t++)this.displayed_[t]=this.displayed_[t+1];this.displayed_[this.row_]=""},Te.prototype.paintOn=function(t,e){var i=this.displayed_[this.row_];i+=e,this.displayed_[this.row_]=i};var Ce={CaptionStream:ce,Cea608Stream:Te,Cea708Stream:Se},ke={H264_STREAM_TYPE:27,ADTS_STREAM_TYPE:15,METADATA_STREAM_TYPE:21},Pe="shared",Ae=function(t,e){var i=1;for(t>e&&(i=-1);Math.abs(e-t)>4294967296;)t+=8589934592*i;return t},Ue=function t(e){var i,n;t.prototype.init.call(this),this.type_=e||Pe,this.push=function(t){this.type_!==Pe&&t.type!==this.type_||(void 0===n&&(n=t.dts),t.dts=Ae(t.dts,n),t.pts=Ae(t.pts,n),i=t.dts,this.trigger("data",t))},this.flush=function(){n=i,this.trigger("done")},this.endTimeline=function(){this.flush(),this.trigger("endedtimeline")},this.discontinuity=function(){n=void 0,i=void 0},this.reset=function(){this.discontinuity(),this.trigger("reset")}};Ue.prototype=new Bt;var De,Ee=Ue;(De=function(t){var e,i={descriptor:t&&t.descriptor},n=0,a=[],r=0;if(De.prototype.init.call(this),this.dispatchType=ke.METADATA_STREAM_TYPE.toString(16),i.descriptor)for(e=0;e<i.descriptor.length;e++)this.dispatchType+=("00"+i.descriptor[e].toString(16)).slice(-2);this.push=function(t){var e,i,s,o,d;if("timed-metadata"===t.type)if(t.dataAlignmentIndicator&&(r=0,a.length=0),0===a.length&&(t.data.length<10||t.data[0]!=="I".charCodeAt(0)||t.data[1]!=="D".charCodeAt(0)||t.data[2]!=="3".charCodeAt(0)))this.trigger("log",{level:"warn",message:"Skipping unrecognized metadata packet"});else if(a.push(t),r+=t.data.byteLength,1===a.length&&(n=Tt.parseSyncSafeInteger(t.data.subarray(6,10)),n+=10),!(r<n)){for(e={data:new Uint8Array(n),frames:[],pts:a[0].pts,dts:a[0].dts},d=0;d<n;)e.data.set(a[0].data.subarray(0,n-d),d),d+=a[0].data.byteLength,r-=a[0].data.byteLength,a.shift();i=10,64&e.data[5]&&(i+=4,i+=Tt.parseSyncSafeInteger(e.data.subarray(10,14)),n-=Tt.parseSyncSafeInteger(e.data.subarray(16,20)));do{if((s=Tt.parseSyncSafeInteger(e.data.subarray(i+4,i+8)))<1){this.trigger("log",{level:"warn",message:"Malformed ID3 frame encountered. Skipping remaining metadata parsing."});break}if((o={id:String.fromCharCode(e.data[i],e.data[i+1],e.data[i+2],e.data[i+3]),data:e.data.subarray(i+10,i+s+10)}).key=o.id,Tt.frameParsers[o.id]?Tt.frameParsers[o.id](o):"T"===o.id[0]?Tt.frameParsers["T*"](o):"W"===o.id[0]&&Tt.frameParsers["W*"](o),"com.apple.streaming.transportStreamTimestamp"===o.owner){var h=o.data,p=(1&h[3])<<30|h[4]<<22|h[5]<<14|h[6]<<6|h[7]>>>2;p*=4,p+=3&h[7],o.timeStamp=p,void 0===e.pts&&void 0===e.dts&&(e.pts=o.timeStamp,e.dts=o.timeStamp),this.trigger("timestamp",o)}e.frames.push(o),i+=10,i+=s}while(i<n);this.trigger("data",e)}}}).prototype=new Bt;var Le,xe,Oe,Ie=De,Re=Ee,Me=188;(Le=function(){var t=new Uint8Array(Me),e=0;Le.prototype.init.call(this),this.push=function(i){var n,a=0,r=Me;for(e?((n=new Uint8Array(i.byteLength+e)).set(t.subarray(0,e)),n.set(i,e),e=0):n=i;r<n.byteLength;)71!==n[a]||71!==n[r]?(a++,r++):(this.trigger("data",n.subarray(a,r)),a+=Me,r+=Me);a<n.byteLength&&(t.set(n.subarray(a),0),e=n.byteLength-a)},this.flush=function(){e===Me&&71===t[0]&&(this.trigger("data",t),e=0),this.trigger("done")},this.endTimeline=function(){this.flush(),this.trigger("endedtimeline")},this.reset=function(){e=0,this.trigger("reset")}}).prototype=new Bt,(xe=function(){var t,e,i,n;xe.prototype.init.call(this),n=this,this.packetsWaitingForPmt=[],this.programMapTable=void 0,t=function(t,n){var a=0;n.payloadUnitStartIndicator&&(a+=t[a]+1),"pat"===n.type?e(t.subarray(a),n):i(t.subarray(a),n)},e=function(t,e){e.section_number=t[7],e.last_section_number=t[8],n.pmtPid=(31&t[10])<<8|t[11],e.pmtPid=n.pmtPid},i=function(t,e){var i,a;if(1&t[5]){for(n.programMapTable={video:null,audio:null,"timed-metadata":{}},i=3+((15&t[1])<<8|t[2])-4,a=12+((15&t[10])<<8|t[11]);a<i;){var r=t[a],s=(31&t[a+1])<<8|t[a+2];r===ke.H264_STREAM_TYPE&&null===n.programMapTable.video?n.programMapTable.video=s:r===ke.ADTS_STREAM_TYPE&&null===n.programMapTable.audio?n.programMapTable.audio=s:r===ke.METADATA_STREAM_TYPE&&(n.programMapTable["timed-metadata"][s]=r),a+=5+((15&t[a+3])<<8|t[a+4])}e.programMapTable=n.programMapTable}},this.push=function(e){var i={},n=4;if(i.payloadUnitStartIndicator=!!(64&e[1]),i.pid=31&e[1],i.pid<<=8,i.pid|=e[2],(48&e[3])>>>4>1&&(n+=e[n]+1),0===i.pid)i.type="pat",t(e.subarray(n),i),this.trigger("data",i);else if(i.pid===this.pmtPid)for(i.type="pmt",t(e.subarray(n),i),this.trigger("data",i);this.packetsWaitingForPmt.length;)this.processPes_.apply(this,this.packetsWaitingForPmt.shift());else void 0===this.programMapTable?this.packetsWaitingForPmt.push([e,n,i]):this.processPes_(e,n,i)},this.processPes_=function(t,e,i){i.pid===this.programMapTable.video?i.streamType=ke.H264_STREAM_TYPE:i.pid===this.programMapTable.audio?i.streamType=ke.ADTS_STREAM_TYPE:i.streamType=this.programMapTable["timed-metadata"][i.pid],i.type="pes",i.data=t.subarray(e),this.trigger("data",i)}}).prototype=new Bt,xe.STREAM_TYPES={h264:27,adts:15},(Oe=function(){var t,e=this,i=!1,n={data:[],size:0},a={data:[],size:0},r={data:[],size:0},s=function(t,i,n){var a,r,s=new Uint8Array(t.size),o={type:i},d=0,h=0;if(t.data.length&&!(t.size<9)){for(o.trackId=t.data[0].pid,d=0;d<t.data.length;d++)r=t.data[d],s.set(r.data,h),h+=r.data.byteLength;var p,u,l,c;u=o,c=(p=s)[0]<<16|p[1]<<8|p[2],u.data=new Uint8Array,1===c&&(u.packetLength=6+(p[4]<<8|p[5]),u.dataAlignmentIndicator=0!=(4&p[6]),192&(l=p[7])&&(u.pts=(14&p[9])<<27|(255&p[10])<<20|(254&p[11])<<12|(255&p[12])<<5|(254&p[13])>>>3,u.pts*=4,u.pts+=(6&p[13])>>>1,u.dts=u.pts,64&l&&(u.dts=(14&p[14])<<27|(255&p[15])<<20|(254&p[16])<<12|(255&p[17])<<5|(254&p[18])>>>3,u.dts*=4,u.dts+=(6&p[18])>>>1)),u.data=p.subarray(9+p[8])),a="video"===i||o.packetLength<=t.size,(n||a)&&(t.size=0,t.data.length=0),a&&e.trigger("data",o)}};Oe.prototype.init.call(this),this.push=function(o){({pat:function(){},pes:function(){var t,e;switch(o.streamType){case ke.H264_STREAM_TYPE:t=n,e="video";break;case ke.ADTS_STREAM_TYPE:t=a,e="audio";break;case ke.METADATA_STREAM_TYPE:t=r,e="timed-metadata";break;default:return}o.payloadUnitStartIndicator&&s(t,e,!0),t.data.push(o),t.size+=o.data.byteLength},pmt:function(){var n={type:"metadata",tracks:[]};null!==(t=o.programMapTable).video&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.video,codec:"avc",type:"video"}),null!==t.audio&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.audio,codec:"adts",type:"audio"}),i=!0,e.trigger("data",n)}})[o.type]()},this.reset=function(){n.size=0,n.data.length=0,a.size=0,a.data.length=0,this.trigger("reset")},this.flushStreams_=function(){s(n,"video"),s(a,"audio"),s(r,"timed-metadata")},this.flush=function(){if(!i&&t){var n={type:"metadata",tracks:[]};null!==t.video&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.video,codec:"avc",type:"video"}),null!==t.audio&&n.tracks.push({timelineStartInfo:{baseMediaDecodeTime:0},id:+t.audio,codec:"adts",type:"audio"}),e.trigger("data",n)}i=!1,this.flushStreams_(),this.trigger("done")}}).prototype=new Bt;var Ne={PAT_PID:0,MP2T_PACKET_LENGTH:Me,TransportPacketStream:Le,TransportParseStream:xe,ElementaryStream:Oe,TimestampRolloverStream:Re,CaptionStream:Ce.CaptionStream,Cea608Stream:Ce.Cea608Stream,Cea708Stream:Ce.Cea708Stream,MetadataStream:Ie};for(var Be in ke)ke.hasOwnProperty(Be)&&(Ne[Be]=ke[Be]);var We,Ge=Ne,ze=Zt,Fe=[96e3,88200,64e3,48e3,44100,32e3,24e3,22050,16e3,12e3,11025,8e3,7350];(We=function(t){var e,i=0;We.prototype.init.call(this),this.skipWarn_=function(t,e){this.trigger("log",{level:"warn",message:"adts skiping bytes "+t+" to "+e+" in frame "+i+" outside syncword"})},this.push=function(n){var a,r,s,o,d,h=0;if(t||(i=0),"audio"===n.type){var p;for(e&&e.length?(s=e,(e=new Uint8Array(s.byteLength+n.data.byteLength)).set(s),e.set(n.data,s.byteLength)):e=n.data;h+7<e.length;)if(255===e[h]&&240==(246&e[h+1])){if("number"==typeof p&&(this.skipWarn_(p,h),p=null),r=2*(1&~e[h+1]),a=(3&e[h+3])<<11|e[h+4]<<3|(224&e[h+5])>>5,d=(o=1024*(1+(3&e[h+6])))*ze/Fe[(60&e[h+2])>>>2],e.byteLength-h<a)break;this.trigger("data",{pts:n.pts+i*d,dts:n.dts+i*d,sampleCount:o,audioobjecttype:1+(e[h+2]>>>6&3),channelcount:(1&e[h+2])<<2|(192&e[h+3])>>>6,samplerate:Fe[(60&e[h+2])>>>2],samplingfrequencyindex:(60&e[h+2])>>>2,samplesize:16,data:e.subarray(h+7+r,h+a)}),i++,h+=a}else"number"!=typeof p&&(p=h),h++;"number"==typeof p&&(this.skipWarn_(p,h),p=null),e=e.subarray(h)}},this.flush=function(){i=0,this.trigger("done")},this.reset=function(){e=void 0,this.trigger("reset")},this.endTimeline=function(){e=void 0,this.trigger("endedtimeline")}}).prototype=new Bt;var Ve,Ye,Xe,je=We,qe=function(t){var e=t.byteLength,i=0,n=0;this.length=function(){return 8*e},this.bitsAvailable=function(){return 8*e+n},this.loadWord=function(){var a=t.byteLength-e,r=new Uint8Array(4),s=Math.min(4,e);if(0===s)throw new Error("no bytes available");r.set(t.subarray(a,a+s)),i=new DataView(r.buffer).getUint32(0),n=8*s,e-=s},this.skipBits=function(t){var a;n>t?(i<<=t,n-=t):(t-=n,t-=8*(a=Math.floor(t/8)),e-=a,this.loadWord(),i<<=t,n-=t)},this.readBits=function(t){var a=Math.min(n,t),r=i>>>32-a;return(n-=a)>0?i<<=a:e>0&&this.loadWord(),(a=t-a)>0?r<<a|this.readBits(a):r},this.skipLeadingZeros=function(){var t;for(t=0;t<n;++t)if(0!=(i&2147483648>>>t))return i<<=t,n-=t,t;return this.loadWord(),t+this.skipLeadingZeros()},this.skipUnsignedExpGolomb=function(){this.skipBits(1+this.skipLeadingZeros())},this.skipExpGolomb=function(){this.skipBits(1+this.skipLeadingZeros())},this.readUnsignedExpGolomb=function(){var t=this.skipLeadingZeros();return this.readBits(t+1)-1},this.readExpGolomb=function(){var t=this.readUnsignedExpGolomb();return 1&t?1+t>>>1:-1*(t>>>1)},this.readBoolean=function(){return 1===this.readBits(1)},this.readUnsignedByte=function(){return this.readBits(8)},this.loadWord()};(Ye=function(){var t,e,i=0;Ye.prototype.init.call(this),this.push=function(n){var a;e?((a=new Uint8Array(e.byteLength+n.data.byteLength)).set(e),a.set(n.data,e.byteLength),e=a):e=n.data;for(var r=e.byteLength;i<r-3;i++)if(1===e[i+2]){t=i+5;break}for(;t<r;)switch(e[t]){case 0:if(0!==e[t-1]){t+=2;break}if(0!==e[t-2]){t++;break}i+3!==t-2&&this.trigger("data",e.subarray(i+3,t-2));do{t++}while(1!==e[t]&&t<r);i=t-2,t+=3;break;case 1:if(0!==e[t-1]||0!==e[t-2]){t+=3;break}this.trigger("data",e.subarray(i+3,t-2)),i=t-2,t+=3;break;default:t+=3}e=e.subarray(i),t-=i,i=0},this.reset=function(){e=null,i=0,this.trigger("reset")},this.flush=function(){e&&e.byteLength>3&&this.trigger("data",e.subarray(i+3)),e=null,i=0,this.trigger("done")},this.endTimeline=function(){this.flush(),this.trigger("endedtimeline")}}).prototype=new Bt,Xe={100:!0,110:!0,122:!0,244:!0,44:!0,83:!0,86:!0,118:!0,128:!0,138:!0,139:!0,134:!0},(Ve=function(){var t,e,i,n,a,r,s,o=new Ye;Ve.prototype.init.call(this),t=this,this.push=function(t){"video"===t.type&&(e=t.trackId,i=t.pts,n=t.dts,o.push(t))},o.on("data",(function(s){var o={trackId:e,pts:i,dts:n,data:s,nalUnitTypeCode:31&s[0]};switch(o.nalUnitTypeCode){case 5:o.nalUnitType="slice_layer_without_partitioning_rbsp_idr";break;case 6:o.nalUnitType="sei_rbsp",o.escapedRBSP=a(s.subarray(1));break;case 7:o.nalUnitType="seq_parameter_set_rbsp",o.escapedRBSP=a(s.subarray(1)),o.config=r(o.escapedRBSP);break;case 8:o.nalUnitType="pic_parameter_set_rbsp";break;case 9:o.nalUnitType="access_unit_delimiter_rbsp"}t.trigger("data",o)})),o.on("done",(function(){t.trigger("done")})),o.on("partialdone",(function(){t.trigger("partialdone")})),o.on("reset",(function(){t.trigger("reset")})),o.on("endedtimeline",(function(){t.trigger("endedtimeline")})),this.flush=function(){o.flush()},this.partialFlush=function(){o.partialFlush()},this.reset=function(){o.reset()},this.endTimeline=function(){o.endTimeline()},s=function(t,e){var i,n=8,a=8;for(i=0;i<t;i++)0!==a&&(a=(n+e.readExpGolomb()+256)%256),n=0===a?n:a},a=function(t){for(var e,i,n=t.byteLength,a=[],r=1;r<n-2;)0===t[r]&&0===t[r+1]&&3===t[r+2]?(a.push(r+2),r+=2):r++;if(0===a.length)return t;e=n-a.length,i=new Uint8Array(e);var s=0;for(r=0;r<e;s++,r++)s===a[0]&&(s++,a.shift()),i[r]=t[s];return i},r=function(t){var e,i,n,a,r,o,d,h,p,u,l,c,f=0,g=0,m=0,y=0,S=[1,1];if(i=(e=new qe(t)).readUnsignedByte(),a=e.readUnsignedByte(),n=e.readUnsignedByte(),e.skipUnsignedExpGolomb(),Xe[i]&&(3===(r=e.readUnsignedExpGolomb())&&e.skipBits(1),e.skipUnsignedExpGolomb(),e.skipUnsignedExpGolomb(),e.skipBits(1),e.readBoolean()))for(l=3!==r?8:12,c=0;c<l;c++)e.readBoolean()&&s(c<6?16:64,e);if(e.skipUnsignedExpGolomb(),0===(o=e.readUnsignedExpGolomb()))e.readUnsignedExpGolomb();else if(1===o)for(e.skipBits(1),e.skipExpGolomb(),e.skipExpGolomb(),d=e.readUnsignedExpGolomb(),c=0;c<d;c++)e.skipExpGolomb();if(e.skipUnsignedExpGolomb(),e.skipBits(1),h=e.readUnsignedExpGolomb(),p=e.readUnsignedExpGolomb(),0===(u=e.readBits(1))&&e.skipBits(1),e.skipBits(1),e.readBoolean()&&(f=e.readUnsignedExpGolomb(),g=e.readUnsignedExpGolomb(),m=e.readUnsignedExpGolomb(),y=e.readUnsignedExpGolomb()),e.readBoolean()&&e.readBoolean()){switch(e.readUnsignedByte()){case 1:S=[1,1];break;case 2:S=[12,11];break;case 3:S=[10,11];break;case 4:S=[16,11];break;case 5:S=[40,33];break;case 6:S=[24,11];break;case 7:S=[20,11];break;case 8:S=[32,11];break;case 9:S=[80,33];break;case 10:S=[18,11];break;case 11:S=[15,11];break;case 12:S=[64,33];break;case 13:S=[160,99];break;case 14:S=[4,3];break;case 15:S=[3,2];break;case 16:S=[2,1];break;case 255:S=[e.readUnsignedByte()<<8|e.readUnsignedByte(),e.readUnsignedByte()<<8|e.readUnsignedByte()]}S&&(S[0],S[1])}return{profileIdc:i,levelIdc:n,profileCompatibility:a,width:16*(h+1)-2*f-2*g,height:(2-u)*(p+1)*16-2*m-2*y,sarRatio:S}}}).prototype=new Bt;var He,$e={H264Stream:Ve,NalByteStream:Ye},Ze=function(t,e){var i=t[e+6]<<21|t[e+7]<<14|t[e+8]<<7|t[e+9];return i=i>=0?i:0,(16&t[e+5])>>4?i+20:i+10},Ke=function t(e,i){return e.length-i<10||e[i]!=="I".charCodeAt(0)||e[i+1]!=="D".charCodeAt(0)||e[i+2]!=="3".charCodeAt(0)?i:t(e,i+=Ze(e,i))},Je=function(t){var e=Ke(t,0);return t.length>=e+2&&255==(255&t[e])&&240==(240&t[e+1])&&16==(22&t[e+1])},Qe=Ze,ti=function(t,e){var i=(224&t[e+5])>>5,n=t[e+4]<<3;return 6144&t[e+3]|n|i};(He=function(){var t=new Uint8Array,e=0;He.prototype.init.call(this),this.setTimestamp=function(t){e=t},this.push=function(i){var n,a,r,s,o=0,d=0;for(t.length?(s=t.length,(t=new Uint8Array(i.byteLength+s)).set(t.subarray(0,s)),t.set(i,s)):t=i;t.length-d>=3;)if(t[d]!=="I".charCodeAt(0)||t[d+1]!=="D".charCodeAt(0)||t[d+2]!=="3".charCodeAt(0))if(255!=(255&t[d])||240!=(240&t[d+1]))d++;else{if(t.length-d<7)break;if(d+(o=ti(t,d))>t.length)break;r={type:"audio",data:t.subarray(d,d+o),pts:e,dts:e},this.trigger("data",r),d+=o}else{if(t.length-d<10)break;if(d+(o=Qe(t,d))>t.length)break;a={type:"timed-metadata",data:t.subarray(d,d+o)},this.trigger("data",a),d+=o}n=t.length-d,t=n>0?t.subarray(d):new Uint8Array},this.reset=function(){t=new Uint8Array,this.trigger("reset")},this.endTimeline=function(){t=new Uint8Array,this.trigger("endedtimeline")}}).prototype=new Bt;var ei,ii,ni,ai,ri=He,si=["audioobjecttype","channelcount","samplerate","samplingfrequencyindex","samplesize"],oi=["width","height","profileIdc","levelIdc","profileCompatibility","sarRatio"],di=$e.H264Stream,hi=Je,pi=Zt,ui=function(t,e){e.stream=t,this.trigger("log",e)},li=function(t,e){for(var i=Object.keys(e),n=0;n<i.length;n++){var a=i[n];"headOfPipeline"!==a&&e[a].on&&e[a].on("log",ui.bind(t,a))}},ci=function(t,e){var i;if(t.length!==e.length)return!1;for(i=0;i<t.length;i++)if(t[i]!==e[i])return!1;return!0},fi=function(t,e,i,n,a,r){return{start:{dts:t,pts:t+(i-e)},end:{dts:t+(n-e),pts:t+(a-i)},prependedContentDuration:r,baseMediaDecodeTime:t}};(ii=function(t,e){var i,n=[],a=0,r=0,s=1/0;i=(e=e||{}).firstSequenceNumber||0,ii.prototype.init.call(this),this.push=function(e){oe(t,e),t&&si.forEach((function(i){t[i]=e[i]})),n.push(e)},this.setEarliestDts=function(t){a=t},this.setVideoBaseMediaDecodeTime=function(t){s=t},this.setAudioAppendStart=function(t){r=t},this.flush=function(){var o,d,h,p,u,l,c;0!==n.length?(o=ee(n,t,a),t.baseMediaDecodeTime=se(t,e.keepOriginalTimestamps),c=te(t,o,r,s),t.samples=ie(o),h=Q.mdat(ne(o)),n=[],d=Q.moof(i,[t]),p=new Uint8Array(d.byteLength+h.byteLength),i++,p.set(d),p.set(h,d.byteLength),re(t),u=Math.ceil(1024*pi/t.samplerate),o.length&&(l=o.length*u,this.trigger("segmentTimingInfo",fi(Kt(t.baseMediaDecodeTime,t.samplerate),o[0].dts,o[0].pts,o[0].dts+l,o[0].pts+l,c||0)),this.trigger("timingInfo",{start:o[0].pts,end:o[0].pts+l})),this.trigger("data",{track:t,boxes:p}),this.trigger("done","AudioSegmentStream")):this.trigger("done","AudioSegmentStream")},this.reset=function(){re(t),n=[],this.trigger("reset")}}).prototype=new Bt,(ei=function(t,e){var i,n,a,r=[],s=[];i=(e=e||{}).firstSequenceNumber||0,ei.prototype.init.call(this),delete t.minPTS,this.gopCache_=[],this.push=function(e){oe(t,e),"seq_parameter_set_rbsp"!==e.nalUnitType||n||(n=e.config,t.sps=[e.data],oi.forEach((function(e){t[e]=n[e]}),this)),"pic_parameter_set_rbsp"!==e.nalUnitType||a||(a=e.data,t.pps=[e.data]),r.push(e)},this.flush=function(){for(var n,a,o,d,h,p,u,l,c=0;r.length&&"access_unit_delimiter_rbsp"!==r[0].nalUnitType;)r.shift();if(0===r.length)return this.resetStream_(),void this.trigger("done","VideoSegmentStream");if(n=Gt(r),(o=zt(n))[0][0].keyFrame||((a=this.getGopForFusion_(r[0],t))?(c=a.duration,o.unshift(a),o.byteLength+=a.byteLength,o.nalCount+=a.nalCount,o.pts=a.pts,o.dts=a.dts,o.duration+=a.duration):o=Ft(o)),s.length){var f;if(!(f=e.alignGopsAtEnd?this.alignGopsAtEnd_(o):this.alignGopsAtStart_(o)))return this.gopCache_.unshift({gop:o.pop(),pps:t.pps,sps:t.sps}),this.gopCache_.length=Math.min(6,this.gopCache_.length),r=[],this.resetStream_(),void this.trigger("done","VideoSegmentStream");re(t),o=f}oe(t,o),t.samples=Vt(o),h=Q.mdat(Yt(o)),t.baseMediaDecodeTime=se(t,e.keepOriginalTimestamps),this.trigger("processedGopsInfo",o.map((function(t){return{pts:t.pts,dts:t.dts,byteLength:t.byteLength}}))),u=o[0],l=o[o.length-1],this.trigger("segmentTimingInfo",fi(t.baseMediaDecodeTime,u.dts,u.pts,l.dts+l.duration,l.pts+l.duration,c)),this.trigger("timingInfo",{start:o[0].pts,end:o[o.length-1].pts+o[o.length-1].duration}),this.gopCache_.unshift({gop:o.pop(),pps:t.pps,sps:t.sps}),this.gopCache_.length=Math.min(6,this.gopCache_.length),r=[],this.trigger("baseMediaDecodeTime",t.baseMediaDecodeTime),this.trigger("timelineStartInfo",t.timelineStartInfo),d=Q.moof(i,[t]),p=new Uint8Array(d.byteLength+h.byteLength),i++,p.set(d),p.set(h,d.byteLength),this.trigger("data",{track:t,boxes:p}),this.resetStream_(),this.trigger("done","VideoSegmentStream")},this.reset=function(){this.resetStream_(),r=[],this.gopCache_.length=0,s.length=0,this.trigger("reset")},this.resetStream_=function(){re(t),n=void 0,a=void 0},this.getGopForFusion_=function(e){var i,n,a,r,s,o=1/0;for(s=0;s<this.gopCache_.length;s++)a=(r=this.gopCache_[s]).gop,t.pps&&ci(t.pps[0],r.pps[0])&&t.sps&&ci(t.sps[0],r.sps[0])&&(a.dts<t.timelineStartInfo.dts||(i=e.dts-a.dts-a.duration)>=-1e4&&i<=45e3&&(!n||o>i)&&(n=r,o=i));return n?n.gop:null},this.alignGopsAtStart_=function(t){var e,i,n,a,r,o,d,h;for(r=t.byteLength,o=t.nalCount,d=t.duration,e=i=0;e<s.length&&i<t.length&&(n=s[e],a=t[i],n.pts!==a.pts);)a.pts>n.pts?e++:(i++,r-=a.byteLength,o-=a.nalCount,d-=a.duration);return 0===i?t:i===t.length?null:((h=t.slice(i)).byteLength=r,h.duration=d,h.nalCount=o,h.pts=h[0].pts,h.dts=h[0].dts,h)},this.alignGopsAtEnd_=function(t){var e,i,n,a,r,o,d;for(e=s.length-1,i=t.length-1,r=null,o=!1;e>=0&&i>=0;){if(n=s[e],a=t[i],n.pts===a.pts){o=!0;break}n.pts>a.pts?e--:(e===s.length-1&&(r=i),i--)}if(!o&&null===r)return null;if(0===(d=o?i:r))return t;var h=t.slice(d),p=h.reduce((function(t,e){return t.byteLength+=e.byteLength,t.duration+=e.duration,t.nalCount+=e.nalCount,t}),{byteLength:0,duration:0,nalCount:0});return h.byteLength=p.byteLength,h.duration=p.duration,h.nalCount=p.nalCount,h.pts=h[0].pts,h.dts=h[0].dts,h},this.alignGopsWith=function(t){s=t}}).prototype=new Bt,(ai=function(t,e){this.numberOfTracks=0,this.metadataStream=e,void 0!==(t=t||{}).remux?this.remuxTracks=!!t.remux:this.remuxTracks=!0,"boolean"==typeof t.keepOriginalTimestamps?this.keepOriginalTimestamps=t.keepOriginalTimestamps:this.keepOriginalTimestamps=!1,this.pendingTracks=[],this.videoTrack=null,this.pendingBoxes=[],this.pendingCaptions=[],this.pendingMetadata=[],this.pendingBytes=0,this.emittedTracks=0,ai.prototype.init.call(this),this.push=function(t){return t.text?this.pendingCaptions.push(t):t.frames?this.pendingMetadata.push(t):(this.pendingTracks.push(t.track),this.pendingBytes+=t.boxes.byteLength,"video"===t.track.type&&(this.videoTrack=t.track,this.pendingBoxes.push(t.boxes)),void("audio"===t.track.type&&(this.audioTrack=t.track,this.pendingBoxes.unshift(t.boxes))))}}).prototype=new Bt,ai.prototype.flush=function(t){var e,i,n,a,r=0,s={captions:[],captionStreams:{},metadata:[],info:{}},o=0;if(this.pendingTracks.length<this.numberOfTracks){if("VideoSegmentStream"!==t&&"AudioSegmentStream"!==t)return;if(this.remuxTracks)return;if(0===this.pendingTracks.length)return this.emittedTracks++,void(this.emittedTracks>=this.numberOfTracks&&(this.trigger("done"),this.emittedTracks=0))}if(this.videoTrack?(o=this.videoTrack.timelineStartInfo.pts,oi.forEach((function(t){s.info[t]=this.videoTrack[t]}),this)):this.audioTrack&&(o=this.audioTrack.timelineStartInfo.pts,si.forEach((function(t){s.info[t]=this.audioTrack[t]}),this)),this.videoTrack||this.audioTrack){for(1===this.pendingTracks.length?s.type=this.pendingTracks[0].type:s.type="combined",this.emittedTracks+=this.pendingTracks.length,n=Q.initSegment(this.pendingTracks),s.initSegment=new Uint8Array(n.byteLength),s.initSegment.set(n),s.data=new Uint8Array(this.pendingBytes),a=0;a<this.pendingBoxes.length;a++)s.data.set(this.pendingBoxes[a],r),r+=this.pendingBoxes[a].byteLength;for(a=0;a<this.pendingCaptions.length;a++)(e=this.pendingCaptions[a]).startTime=Qt(e.startPts,o,this.keepOriginalTimestamps),e.endTime=Qt(e.endPts,o,this.keepOriginalTimestamps),s.captionStreams[e.stream]=!0,s.captions.push(e);for(a=0;a<this.pendingMetadata.length;a++)(i=this.pendingMetadata[a]).cueTime=Qt(i.pts,o,this.keepOriginalTimestamps),s.metadata.push(i);for(s.metadata.dispatchType=this.metadataStream.dispatchType,this.pendingTracks.length=0,this.videoTrack=null,this.pendingBoxes.length=0,this.pendingCaptions.length=0,this.pendingBytes=0,this.pendingMetadata.length=0,this.trigger("data",s),a=0;a<s.captions.length;a++)e=s.captions[a],this.trigger("caption",e);for(a=0;a<s.metadata.length;a++)i=s.metadata[a],this.trigger("id3Frame",i)}this.emittedTracks>=this.numberOfTracks&&(this.trigger("done"),this.emittedTracks=0)},ai.prototype.setRemux=function(t){this.remuxTracks=t},(ni=function(t){var e,i,n=this,a=!0;ni.prototype.init.call(this),t=t||{},this.baseMediaDecodeTime=t.baseMediaDecodeTime||0,this.transmuxPipeline_={},this.setupAacPipeline=function(){var a={};this.transmuxPipeline_=a,a.type="aac",a.metadataStream=new Ge.MetadataStream,a.aacStream=new ri,a.audioTimestampRolloverStream=new Ge.TimestampRolloverStream("audio"),a.timedMetadataTimestampRolloverStream=new Ge.TimestampRolloverStream("timed-metadata"),a.adtsStream=new je,a.coalesceStream=new ai(t,a.metadataStream),a.headOfPipeline=a.aacStream,a.aacStream.pipe(a.audioTimestampRolloverStream).pipe(a.adtsStream),a.aacStream.pipe(a.timedMetadataTimestampRolloverStream).pipe(a.metadataStream).pipe(a.coalesceStream),a.metadataStream.on("timestamp",(function(t){a.aacStream.setTimestamp(t.timeStamp)})),a.aacStream.on("data",(function(r){"timed-metadata"!==r.type&&"audio"!==r.type||a.audioSegmentStream||(i=i||{timelineStartInfo:{baseMediaDecodeTime:n.baseMediaDecodeTime},codec:"adts",type:"audio"},a.coalesceStream.numberOfTracks++,a.audioSegmentStream=new ii(i,t),a.audioSegmentStream.on("log",n.getLogTrigger_("audioSegmentStream")),a.audioSegmentStream.on("timingInfo",n.trigger.bind(n,"audioTimingInfo")),a.adtsStream.pipe(a.audioSegmentStream).pipe(a.coalesceStream),n.trigger("trackinfo",{hasAudio:!!i,hasVideo:!!e}))})),a.coalesceStream.on("data",this.trigger.bind(this,"data")),a.coalesceStream.on("done",this.trigger.bind(this,"done")),li(this,a)},this.setupTsPipeline=function(){var a={};this.transmuxPipeline_=a,a.type="ts",a.metadataStream=new Ge.MetadataStream,a.packetStream=new Ge.TransportPacketStream,a.parseStream=new Ge.TransportParseStream,a.elementaryStream=new Ge.ElementaryStream,a.timestampRolloverStream=new Ge.TimestampRolloverStream,a.adtsStream=new je,a.h264Stream=new di,a.captionStream=new Ge.CaptionStream(t),a.coalesceStream=new ai(t,a.metadataStream),a.headOfPipeline=a.packetStream,a.packetStream.pipe(a.parseStream).pipe(a.elementaryStream).pipe(a.timestampRolloverStream),a.timestampRolloverStream.pipe(a.h264Stream),a.timestampRolloverStream.pipe(a.adtsStream),a.timestampRolloverStream.pipe(a.metadataStream).pipe(a.coalesceStream),a.h264Stream.pipe(a.captionStream).pipe(a.coalesceStream),a.elementaryStream.on("data",(function(r){var s;if("metadata"===r.type){for(s=r.tracks.length;s--;)e||"video"!==r.tracks[s].type?i||"audio"!==r.tracks[s].type||((i=r.tracks[s]).timelineStartInfo.baseMediaDecodeTime=n.baseMediaDecodeTime):(e=r.tracks[s]).timelineStartInfo.baseMediaDecodeTime=n.baseMediaDecodeTime;e&&!a.videoSegmentStream&&(a.coalesceStream.numberOfTracks++,a.videoSegmentStream=new ei(e,t),a.videoSegmentStream.on("log",n.getLogTrigger_("videoSegmentStream")),a.videoSegmentStream.on("timelineStartInfo",(function(e){i&&!t.keepOriginalTimestamps&&(i.timelineStartInfo=e,a.audioSegmentStream.setEarliestDts(e.dts-n.baseMediaDecodeTime))})),a.videoSegmentStream.on("processedGopsInfo",n.trigger.bind(n,"gopInfo")),a.videoSegmentStream.on("segmentTimingInfo",n.trigger.bind(n,"videoSegmentTimingInfo")),a.videoSegmentStream.on("baseMediaDecodeTime",(function(t){i&&a.audioSegmentStream.setVideoBaseMediaDecodeTime(t)})),a.videoSegmentStream.on("timingInfo",n.trigger.bind(n,"videoTimingInfo")),a.h264Stream.pipe(a.videoSegmentStream).pipe(a.coalesceStream)),i&&!a.audioSegmentStream&&(a.coalesceStream.numberOfTracks++,a.audioSegmentStream=new ii(i,t),a.audioSegmentStream.on("log",n.getLogTrigger_("audioSegmentStream")),a.audioSegmentStream.on("timingInfo",n.trigger.bind(n,"audioTimingInfo")),a.audioSegmentStream.on("segmentTimingInfo",n.trigger.bind(n,"audioSegmentTimingInfo")),a.adtsStream.pipe(a.audioSegmentStream).pipe(a.coalesceStream)),n.trigger("trackinfo",{hasAudio:!!i,hasVideo:!!e})}})),a.coalesceStream.on("data",this.trigger.bind(this,"data")),a.coalesceStream.on("id3Frame",(function(t){t.dispatchType=a.metadataStream.dispatchType,n.trigger("id3Frame",t)})),a.coalesceStream.on("caption",this.trigger.bind(this,"caption")),a.coalesceStream.on("done",this.trigger.bind(this,"done")),li(this,a)},this.setBaseMediaDecodeTime=function(n){var a=this.transmuxPipeline_;t.keepOriginalTimestamps||(this.baseMediaDecodeTime=n),i&&(i.timelineStartInfo.dts=void 0,i.timelineStartInfo.pts=void 0,re(i),a.audioTimestampRolloverStream&&a.audioTimestampRolloverStream.discontinuity()),e&&(a.videoSegmentStream&&(a.videoSegmentStream.gopCache_=[]),e.timelineStartInfo.dts=void 0,e.timelineStartInfo.pts=void 0,re(e),a.captionStream.reset()),a.timestampRolloverStream&&a.timestampRolloverStream.discontinuity()},this.setAudioAppendStart=function(t){i&&this.transmuxPipeline_.audioSegmentStream.setAudioAppendStart(t)},this.setRemux=function(e){var i=this.transmuxPipeline_;t.remux=e,i&&i.coalesceStream&&i.coalesceStream.setRemux(e)},this.alignGopsWith=function(t){e&&this.transmuxPipeline_.videoSegmentStream&&this.transmuxPipeline_.videoSegmentStream.alignGopsWith(t)},this.getLogTrigger_=function(t){var e=this;return function(i){i.stream=t,e.trigger("log",i)}},this.push=function(t){if(a){var e=hi(t);e&&"aac"!==this.transmuxPipeline_.type?this.setupAacPipeline():e||"ts"===this.transmuxPipeline_.type||this.setupTsPipeline(),a=!1}this.transmuxPipeline_.headOfPipeline.push(t)},this.flush=function(){a=!0,this.transmuxPipeline_.headOfPipeline.flush()},this.endTimeline=function(){this.transmuxPipeline_.headOfPipeline.endTimeline()},this.reset=function(){this.transmuxPipeline_.headOfPipeline&&this.transmuxPipeline_.headOfPipeline.reset()},this.resetCaptions=function(){this.transmuxPipeline_.captionStream&&this.transmuxPipeline_.captionStream.reset()}}).prototype=new Bt;var gi={Transmuxer:ni,VideoSegmentStream:ei,AudioSegmentStream:ii,AUDIO_PROPERTIES:si,VIDEO_PROPERTIES:oi,generateSegmentTimingInfo:fi},mi=ue,yi=Ce.CaptionStream,Si=function(t,e){for(var i=t,n=0;n<e.length;n++){var a=e[n];if(i<a.size)return a;i-=a.size}return null},vi=function(t,e){var i=nt(t,["moof","traf"]),n=nt(t,["mdat"]),a={},r=[];return n.forEach((function(t,e){var n=i[e];r.push({mdat:t,traf:n})})),r.forEach((function(t){var i,n=t.mdat,r=t.traf,s=nt(r,["tfhd"]),o=pt(s[0]),d=o.trackId,h=nt(r,["tfdt"]),p=h.length>0?gt(h[0]).baseMediaDecodeTime:0,u=nt(r,["trun"]);e===d&&u.length>0&&(i=function(t,e,i){var n,a,r,s,o=new DataView(t.buffer,t.byteOffset,t.byteLength),d={logs:[],seiNals:[]};for(a=0;a+4<t.length;a+=r)if(r=o.getUint32(a),a+=4,!(r<=0))switch(31&t[a]){case 6:var h=t.subarray(a+1,a+1+r),p=Si(a,e);if(n={nalUnitType:"sei_rbsp",size:r,data:h,escapedRBSP:mi(h),trackId:i},p)n.pts=p.pts,n.dts=p.dts,s=p;else{if(!s){d.logs.push({level:"warn",message:"We've encountered a nal unit without data at "+a+" for trackId "+i+". See mux.js#223."});break}n.pts=s.pts,n.dts=s.dts}d.seiNals.push(n)}return d}(n,function(t,e,i){var n=e,a=i.defaultSampleDuration||0,r=i.defaultSampleSize||0,s=i.trackId,o=[];return t.forEach((function(t){var e=lt(t).samples;e.forEach((function(t){void 0===t.duration&&(t.duration=a),void 0===t.size&&(t.size=r),t.trackId=s,t.dts=n,void 0===t.compositionTimeOffset&&(t.compositionTimeOffset=0),"bigint"==typeof n?(t.pts=n+F.default.BigInt(t.compositionTimeOffset),n+=F.default.BigInt(t.duration)):(t.pts=n+t.compositionTimeOffset,n+=t.duration)})),o=o.concat(e)})),o}(u,p,o),d),a[d]||(a[d]={seiNals:[],logs:[]}),a[d].seiNals=a[d].seiNals.concat(i.seiNals),a[d].logs=a[d].logs.concat(i.logs))})),a};return{generator:Q,probe:Ut,Transmuxer:gi.Transmuxer,AudioSegmentStream:gi.AudioSegmentStream,VideoSegmentStream:gi.VideoSegmentStream,CaptionParser:function(){var t,e,i,n,a,r,s=!1;this.isInitialized=function(){return s},this.init=function(e){t=new yi,s=!0,r=!!e&&e.isPartial,t.on("data",(function(t){t.startTime=t.startPts/n,t.endTime=t.endPts/n,a.captions.push(t),a.captionStreams[t.stream]=!0})),t.on("log",(function(t){a.logs.push(t)}))},this.isNewInit=function(t,e){return!(t&&0===t.length||e&&"object"==typeof e&&0===Object.keys(e).length)&&(i!==t[0]||n!==e[i])},this.parse=function(t,r,s){var o;if(!this.isInitialized())return null;if(!r||!s)return null;if(this.isNewInit(r,s))i=r[0],n=s[i];else if(null===i||!n)return e.push(t),null;for(;e.length>0;){var d=e.shift();this.parse(d,r,s)}return(o=function(t,e,i){if(null===e)return null;var n=vi(t,e)[e]||{};return{seiNals:n.seiNals,logs:n.logs,timescale:i}}(t,i,n))&&o.logs&&(a.logs=a.logs.concat(o.logs)),null!==o&&o.seiNals?(this.pushNals(o.seiNals),this.flushStream(),a):a.logs.length?{logs:a.logs,captions:[],captionStreams:[]}:null},this.pushNals=function(e){if(!this.isInitialized()||!e||0===e.length)return null;e.forEach((function(e){t.push(e)}))},this.flushStream=function(){if(!this.isInitialized())return null;r?t.partialFlush():t.flush()},this.clearParsedCaptions=function(){a.captions=[],a.captionStreams={},a.logs=[]},this.resetCaptionStream=function(){if(!this.isInitialized())return null;t.reset()},this.clearAllCaptions=function(){this.clearParsedCaptions(),this.resetCaptionStream()},this.reset=function(){e=[],i=null,n=null,a?this.clearParsedCaptions():a={captions:[],captionStreams:{},logs:[]},this.resetCaptionStream()},this.reset()}}}));

return module.exports; })();
function readDownloadRelease(doc, pathname) {
  const slug = pathname.match(/^\/release\/([a-z0-9-]+)\/?$/)?.[1];
  if (!slug) return;
  for (const item of pageObjects(doc)) {
    if (item.slug !== slug || typeof item.titleRu !== 'string' || !Array.isArray(item.episodes)) continue;
    const episodes = item.episodes.filter(e => Number.isSafeInteger(e?.episodeNumber) && e.episodeNumber > 0 && typeof e.videoUrlM3u8 === 'string' && e.videoUrlM3u8.trim());
    if (episodes.length) return {title: item.titleRu, episodes: episodes.sort((a,b) => a.episodeNumber-b.episodeNumber)};
  }
}

function downloadUrl(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Неподдерживаемый адрес видео.');
  return url.href;
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
    const response = await fetch(url, {signal:controller.signal, credentials:'omit'});
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
  const current = Array.from(document.querySelectorAll('main h3, main span, #main h3, #main span'))
    .map(e => e.textContent.trim()).find(text => /^(?:Серия|Часть)\s*\d+$/i.test(text));
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

async function createDownloadDatabaseCache() {
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('dubtv-plus-downloads',1);let settled=false;
    const timer=setTimeout(()=>{settled=true;reject(Error('Хранилище не ответило за 10 секунд.'));},10000);
    request.onupgradeneeded=()=>request.result.createObjectStore('parts');
    request.onsuccess=()=>{clearTimeout(timer);if(settled){request.result.close();return;}settled=true;resolve(request.result);};
    request.onerror=()=>{clearTimeout(timer);settled=true;reject(request.error);};
    request.onblocked=()=>{clearTimeout(timer);settled=true;reject(Error('Хранилище занято другой вкладкой.'));};
  });
  db.onversionchange=()=>db.close();
  const id=crypto.randomUUID(),range=IDBKeyRange.bound([id,0],[id,Number.MAX_SAFE_INTEGER]);
  function transact(mode,action){
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('parts',mode);let request;
      tx.oncomplete=()=>resolve(request?.result);
      tx.onabort=()=>reject(tx.error??Error('Не удалось записать временное видео.'));
      try{request=action(tx.objectStore('parts'));}catch(error){tx.abort();reject(error);}
    });
  }
  try{await transact('readwrite',store=>{store.put(new Blob([]),[id,-1]);return store.delete([id,-1]);});}
  catch(error){db.close();throw error;}
  let index=0,queue=Promise.resolve(),closing=false,removal;
  const enqueue=action=>{const response=queue.then(action);queue=response.catch(()=>{});return response;};
  return {
    kind:'indexeddb',
    write(bytes){if(closing)throw Error('Загрузка уже закрыта.');const part=new Blob([bytes]);return enqueue(()=>transact('readwrite',store=>store.put(part,[id,index++])));},
    finish(){if(closing)throw Error('Загрузка уже закрыта.');return enqueue(async()=>new Blob(await transact('readonly',store=>store.getAll(range)),{type:'video/mp4'}));},
    remove(){closing=true;return removal??=enqueue(()=>transact('readwrite',store=>store.delete(range))).finally(()=>db.close());},
  };
}

async function createDownloadCache(onUnavailable=()=>{}) {
  let directory, name, worker, writable, workerURL, filesystemError;
  try {
    if(typeof navigator.storage?.getDirectory!=='function')throw Error('API временных файлов недоступен.');
    directory=await (await navigator.storage.getDirectory()).getDirectoryHandle('dubtv-plus-downloads',{create:true});
    name=crypto.randomUUID()+'.mp4';
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
    filesystemError=error;
    worker?.terminate();if(directory&&name)try{await directory.removeEntry(name);}catch{/* Private storage may be unavailable. */}
  }finally{if(workerURL)URL.revokeObjectURL(workerURL);}
  try{return await createDownloadDatabaseCache();}
  catch(error){onUnavailable(`Файлы: ${filesystemError.name}: ${filesystemError.message}. База: ${error.name}: ${error.message}.`);}
}

function createDownloadTools(panel) {
  const progressMarkup = '<section class="dtvp-transfer" hidden><div class="dtvp-transfer-heading"><strong data-episode></strong><span data-queue></span></div><div class="dtvp-transfer-details"><span data-quality></span><span data-size></span></div><div class="dtvp-transfer-meter"><progress max="100" aria-label="Загрузка текущей серии"></progress><span data-percent>—</span></div></section>';
  const dialog = document.createElement('dialog');
  dialog.id = 'dubtv-plus-download'; dialog.className = 'dtvp-dialog';
  dialog.setAttribute('aria-label', 'Скачать серии');
  dialog.innerHTML = '<form><h2>Скачать серии</h2><p data-title></p><div class="dtvp-download-fields"><label class="dtvp-field">Серия<select name="episode"></select></label><label class="dtvp-field">Качество<select name="quality"><option value="max">Максимальное</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label></div>' + progressMarkup + '<p role="status" aria-live="polite"></p><p class="dtvp-download-note">MP4 · На ПК — в выбранную папку. В Safari — по одной серии. При доступном временном хранилище лимита 256 МБ нет.</p><div class="dtvp-actions"><button type="button" data-cancel>Закрыть</button><a data-save hidden>Сохранить MP4</a><button type="button" data-next hidden>Продолжить</button><button type="submit" class="dtvp-primary">Скачать</button></div></form>';
  const toast = document.createElement('div'); toast.id = 'dubtv-plus-download-progress'; toast.hidden = true;
  toast.innerHTML = '<div class="dtvp-transfer-title">Скачивание серии</div>' + progressMarkup + '<div role="status" aria-live="polite"></div><div class="dtvp-transfer-actions"><a hidden>Сохранить MP4</a><button type="button">Закрыть</button></div>';
  const style = document.createElement('style');
  style.textContent = '#dubtv-plus-download-progress{position:fixed;top:16px;right:16px;z-index:10002;width:min(360px,calc(100vw - 32px));box-sizing:border-box;padding:14px;background:var(--color-surface,#141418);color:var(--color-text-primary,#f0f0f0);border:1px solid var(--color-border,#2a2a32);border-radius:10px;font:13px/1.5 system-ui;box-shadow:0 4px 24px #0006}#dubtv-plus-download-progress[hidden]{display:none}#dubtv-plus-download-progress a{display:block;color:var(--color-primary-light,#f08a73);margin-top:8px}#dubtv-plus-download-progress a[hidden]{display:none}#dubtv-plus-download-progress button{display:block;margin-top:10px;background:var(--color-surface-hover,#1c1c22);color:inherit;border:0;border-radius:6px;padding:6px 10px;font:inherit;cursor:pointer}#dubtv-plus-download-progress :focus-visible{outline:2px solid #f08a73;outline-offset:2px}';
  style.textContent += `
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
  let release, releasePath, loading, attemptedPath, operation, pendingSave, blobUrl, quickMode = false, opening = 0, cachedFile;
  function controls() {
    const busy = !!operation;
    if (start.hidden !== busy) start.hidden = busy;
    for (const [element, disabled] of [[start,busy || !release || releasePath !== location.pathname],[quick,busy || !release || releasePath !== location.pathname],[episodeChoice,busy || !!loading],[qualityChoice,busy || !!loading]]) {
      if (element.disabled !== disabled) element.disabled = disabled;
    }
    for (const element of [close,toastClose]) { const text = busy ? 'Отменить' : 'Закрыть'; if (element.textContent !== text) element.textContent = text; }
  }
  function clearBlob() {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = undefined; save.hidden = next.hidden = toastSave.hidden = true;
    save.removeAttribute('href'); toastSave.removeAttribute('href');
    const previous=cachedFile;cachedFile=undefined;previous?.remove().catch(()=>{});
  }
  function stop() { operation?.abort(); pendingSave?.(); pendingSave = undefined; clearBlob(); }
  window.addEventListener('pagehide',stop);
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
      if (!data) throw new Error('Не удалось найти видео. Проверьте вход в аккаунт и обновите страницу.');
      if (location.pathname !== path) return;
      release = data; releasePath = path;
      return data;
    })().finally(() => { clearTimeout(timer); if (loading === request) loading = undefined; controls(); });
    return request.promise;
  }
  open.addEventListener('click', async () => {
    if (operation) return;
    const generation = ++opening;
    clearBlob(); toast.hidden = true; dialog.querySelector('.dtvp-transfer').hidden = true; episodeChoice.replaceChildren(); qualityChoice.value = 'max';
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
  save.addEventListener('click', () => { if (pendingSave) { next.hidden = false; status.textContent = 'После сохранения MP4 нажмите «Продолжить».'; } });
  next.onclick = () => { save.hidden = next.hidden = true; pendingSave?.(); pendingSave = undefined; };
  async function run(episodes, quality, direct = false) {
    if (operation || !release || releasePath !== location.pathname || !episodes.length) return;
    quickMode = direct; clearBlob();
    const targetStatus = direct ? toastStatus : status;
    const targetRoot = direct ? toast : dialog;
    targetRoot.querySelector('.dtvp-transfer').hidden = true;
    if (direct) { positionToast(); toast.hidden = false; }
    const controller = new AbortController(); operation = controller; controls(); targetStatus.textContent = 'Подготовка загрузки…';
    let writable, createdFile, directory, transmuxer, cache, acquiring=false, storageError='';
    let cleanup;
    const clean = () => acquiring || !cache&&!writable&&!createdFile ? Promise.resolve() : cleanup ??= cache ? cache.remove() : cleanupDownloadFile(writable, directory, createdFile);
    // shortcut: pagehide cleanup is best effort; a browser shutdown can interrupt asynchronous deletion.
    const leave = () => { stop(); clean().catch(() => {}); };
    window.addEventListener('pagehide', leave);
    const baseName = release.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g,'').slice(0,100) || 'DubTV';
    try {
      // Pickers must run before fetching to retain user activation; quick download has no custom dialog.
      if (typeof window.showDirectoryPicker === 'function') directory = await window.showDirectoryPicker({mode:'readwrite'});
      controller.signal.throwIfAborted();
      for (let index = 0; index < episodes.length; index++) {
        controller.signal.throwIfAborted();
        const episode = episodes[index]; const masterUrl = downloadUrl(episode.videoUrlM3u8, location.href);
        showProgress(targetRoot, episode, index, episodes.length, quality === 'max' ? 0 : Number(quality), 0);
        targetStatus.textContent = 'Подготовка видео…';
        let playlist = parseDownloadPlaylist(await downloadRead(masterUrl, controller.signal, true, 2*1024*1024), masterUrl);
        let actualQuality = quality === 'max' ? 0 : Number(quality);
        if (playlist.variants) {
          const variant = quality === 'max' ? playlist.variants[0] : playlist.variants.find(v => v.height === Number(quality));
          if (!variant) throw new Error(`Качество ${quality}p недоступно в серии ${episode.episodeNumber}.`);
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
        const chunks = []; let size = 0, initialized = false, output = [];
        transmuxer.on('data', data => {
          if (!initialized) { setDownloadDuration(data.initSegment, playlist.duration); output.push(data.initSegment); initialized = true; }
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
        controller.signal.throwIfAborted(); if (!initialized || !size) throw new Error('Не удалось собрать MP4 из видео и звука.');
        targetStatus.textContent = 'Сохранение MP4…';
        if (writable) { await writable.close(); writable = undefined; createdFile = undefined; }
        else {
          const completed=cache?await cache.finish():new Blob(chunks,{type:'video/mp4'});chunks.length=0;
          controller.signal.throwIfAborted();
          blobUrl = URL.createObjectURL(completed);cachedFile=cache;cache=undefined;
          const link = direct ? toastSave : save; link.href = blobUrl; link.download = name; link.hidden = false;
          if (direct) link.click();
          else { targetStatus.textContent = 'MP4 готов. Сохраните файл, чтобы продолжить.'; await new Promise(resolve => { pendingSave = resolve; }); controller.signal.throwIfAborted(); clearBlob(); }
        }
      }
      targetStatus.textContent = direct && blobUrl ? 'MP4 готов. Если браузер не начал загрузку, нажмите «Сохранить MP4».' : `Готово. Скачано серий: ${episodes.length}.`;
    } catch (error) {
      let cleanupFailed = false;
      try { await clean(); } catch { cleanupFailed = true; }
      targetStatus.textContent = controller.signal.aborted || error.name === 'AbortError' ? 'Загрузка отменена.' : `Не удалось скачать: ${error.message}`;
      if (cleanupFailed) targetStatus.textContent += ' Браузер не разрешил удалить пустой файл — удалите его из папки вручную.';
      clearBlob();
    } finally { window.removeEventListener('pagehide', leave); transmuxer?.dispose(); operation = undefined; pendingSave = undefined; if (!direct) clearBlob(); controls(); }
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
      loading?.controller.abort(); stop(); release = undefined; releasePath = undefined; dialog.close(); toast.hidden = true;
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

function createAutoplayTools() {
  const states = new WeakMap();
  let current;
  document.addEventListener('click',event=>{
    if (!current?.isConnected || !location.pathname.startsWith('/release/')) return;
    const button=event.target.closest?.('button');
    if(button?.getAttribute('data-current')==='true' || button?.getAttribute('aria-current')==='true')return;
    const listHeading=button?.parentElement?.firstElementChild;
    const mobileEpisode=button?.closest('[class~="sm:hidden"][class~="fixed"]') && listHeading?.tagName==='P' && /^(?:Серии|Части)$/.test(listHeading.textContent.trim());
    const episodeRow=button?.closest('.dtvp-series-panel') || mobileEpisode;
    if (button && !button.disabled && (episodeRow || button.closest('[class~="group/eps"]') || button.closest('#dubtv-plus-navigation') || button.closest('main,#main') && /^(?:Пред\.|След\.)$/.test(button.textContent.trim()))) {
      const state=states.get(current); if(state)state.navigation=true;
    }
  },true);
  function episodeKey(video) {
    const label = video.parentElement?.querySelector('button[aria-label^="Серии:"]')?.getAttribute('aria-label');
    const heading = [...document.querySelectorAll('main h3,main span,#main h3,#main span')].find(e=>/^(?:Серия|Часть)\s*\d+$/.test(e.textContent.trim()))?.textContent.trim();
    return label || heading ? `${location.pathname}:${label || heading}` : null;
  }
  function updateEpisode(video, loading = false) {
    if (video !== current || !video.isConnected) return;
    const state = states.get(video), key = episodeKey(video);
    if (loading && state.navigation || (key ? key !== state.episode : loading)) state.pending = true;
    if (loading) state.navigation=false;
    state.episode = key;
  }
  function start(video) {
    const state = states.get(video);
    if (video !== current || !video.isConnected || !location.pathname.startsWith('/release/') || state.navigation || !state.pending || video.readyState < 2 || video.ended) return;
    if (!video.paused) { state.pending = false; return; }
    const play = video.parentElement.querySelector('button[aria-label="Воспроизвести"]');
    if (!play || play.disabled) return;
    state.pending = false;
    // Use the site's handler so its initial play overlay also closes.
    state.clicking = true;
    try { play.click(); } finally { state.clicking = false; }
  }
  return () => {
    current = location.pathname.startsWith('/release/') ? document.querySelector('main video, #main video') : null;
    if (!current) return;
    const video = current;
    if (!states.has(video)) {
      const state = {pending:true,clicking:false,episode:episodeKey(video)}; states.set(video,state);
      video.addEventListener('loadstart', () => updateEpisode(video,true));
      for (const event of ['loadedmetadata','canplay']) video.addEventListener(event, () => start(video));
      video.addEventListener('play', () => { state.pending = false; });
      video.parentElement.addEventListener('click', event => {
        if (!state.clicking && event.target.closest('button[aria-label="Воспроизвести"],button[aria-label="Пауза"]')) {state.pending = false;state.navigation=false;}
      },true);
    }
    updateEpisode(video);
    start(video);
  };
}

function createReleaseLayoutTools() {
  'use strict';
  let route = location.pathname, signature = '', sourceBlock, descriptionBlock, activeRow, collapsed = false;
  try { collapsed = localStorage.getItem('dubtv-plus-franchise-collapsed')==='true'; } catch { /* Keep the session preference. */ }
  const metadata = new Map(), requests = new Map();
  let touchInteraction = matchMedia('(hover: none)').matches, touchPreview = false;
  const marked = new Map();
  const section = document.createElement('section'); section.id = 'dtvp-franchise';
  const preview = document.createElement('div'); preview.id = 'dtvp-franchise-preview'; preview.hidden = true; preview.setAttribute('role','region'); preview.setAttribute('aria-label','Информация о релизе');
  document.body.append(preview);
  const style = document.createElement('style');
  style.textContent = `
    .dtvp-release-hidden{display:none!important}
    .dtvp-series-panel{top:0!important;bottom:var(--dtvp-series-bottom,64px)!important}
    .dtvp-series-panel>div{box-sizing:border-box;padding-bottom:24px!important;mask-image:linear-gradient(black 0,black calc(100% - 32px),transparent 100%)!important;-webkit-mask-image:linear-gradient(black 0,black calc(100% - 32px),transparent 100%)!important}
    #dtvp-series-button{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex-shrink:0;height:40px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:#ffffffe6;font-family:inherit;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer}
    #dtvp-series-button:hover,#dtvp-series-button[aria-expanded=true]{background:#ffffff1f}
    #dtvp-series-button svg{width:18px;height:18px;flex-shrink:0}
    #dtvp-series-button:focus-visible,#dtvp-franchise a:focus-visible,#dtvp-franchise button:focus-visible,#dtvp-franchise-preview a:focus-visible,#dtvp-franchise-preview summary:focus-visible{outline:2px solid var(--color-primary-light,#f08a73);outline-offset:2px}
    #dtvp-franchise{margin-top:24px;padding-top:20px;border-top:1px solid var(--color-border,#2a2a32);font-family:inherit}
    #dtvp-franchise h3{margin:0 0 10px;color:var(--color-text-primary,#f0f0f0);font-size:13px;font-weight:600;letter-spacing:.025em}
    #dtvp-franchise-toggle{font:12px system-ui;color:inherit;background:transparent;border:1px solid var(--color-border,#2a2a32);border-radius:4px;padding:4px 8px;margin-left:10px;cursor:pointer}
    #dtvp-franchise [hidden]{display:none!important}
    #dtvp-franchise a{display:block;padding:7px 0;color:var(--color-text-primary,#f0f0f0);font-size:13px;line-height:1.6;text-decoration:none;overflow-wrap:anywhere}
    #dtvp-franchise a:hover{color:var(--color-primary-light,#f08a73)}
    #dtvp-franchise a span{color:var(--color-text-muted,#8b8b9c);font-size:12px}
    #dtvp-franchise-preview{position:fixed;z-index:10004;display:grid;gap:12px;width:min(460px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;padding:14px;border:1px solid var(--color-border,#2a2a32);border-radius:10px;background:var(--color-surface,#141418);box-shadow:0 12px 35px #0008;color:var(--color-text-primary,#f0f0f0);font:12px/1.5 system-ui;box-sizing:border-box}
    #dtvp-franchise-preview[hidden]{display:none!important}
    #dtvp-franchise-preview .dtvp-preview-top{display:flex;align-items:flex-start;gap:14px;color:inherit;text-decoration:none}
    #dtvp-franchise-preview .dtvp-preview-open{display:block;padding:9px 12px;border-radius:6px;background:#ffffff0b;color:var(--color-primary-light,#f08a73);text-align:center;text-decoration:none}
    #dtvp-franchise-preview img{width:112px;height:168px;flex-shrink:0;border-radius:6px;object-fit:cover}
    #dtvp-franchise-preview .dtvp-preview-content{min-width:0}
    #dtvp-franchise-preview strong{display:block;font-size:15px;line-height:1.4}
    #dtvp-franchise-preview p{margin:7px 0 0;color:var(--color-text-muted,#8b8b9c);overflow-wrap:anywhere}
    #dtvp-franchise-preview .dtvp-preview-tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}
    #dtvp-franchise-preview .dtvp-preview-tags span{border-radius:4px;background:#ffffff0b;padding:2px 6px;color:var(--color-text-secondary,#b5b5c2)}
    #dtvp-franchise-preview dl{display:grid;grid-template-columns:auto minmax(0,1fr) auto minmax(0,1fr);gap:5px 10px;margin:0;font-size:11.5px}
    #dtvp-franchise-preview dt{color:var(--color-text-muted,#8b8b9c)}
    #dtvp-franchise-preview dd{margin:0;overflow-wrap:anywhere}
    #dtvp-franchise-preview details{border-top:1px solid var(--color-border,#2a2a32);padding-top:9px}
    #dtvp-franchise-preview summary{cursor:pointer;color:var(--color-text-secondary,#b5b5c2);width:fit-content}
    #dtvp-franchise-preview details p{max-height:168px;overflow:auto;overscroll-behavior:contain;padding-right:4px;white-space:pre-line}
    @media(max-width:480px){#dtvp-franchise-preview img{width:96px;height:144px}#dtvp-franchise-preview dl{grid-template-columns:auto minmax(0,1fr)}}
    @media(max-width:540px){#dtvp-series-button{padding:0 5px;font-size:11px}#dtvp-series-button svg{display:none}}
  `;
  document.head.append(style);
  const text = value => typeof value === 'string' && !/^\$[a-f\d]+$/i.test(value.trim()) ? value.trim() : '';
  const heading = (doc, title) => [...doc.querySelectorAll('main h2,main h3,#main h2,#main h3')].find(h=>h.childNodes[0]?.textContent.trim()===title);
  function releaseURL(value) {
    try { const url = new URL(value,location.href); return url.origin===location.origin && /^\/release\/[a-z0-9-]+\/?$/.test(url.pathname) && !url.search ? url : null; } catch { return null; }
  }
  function imageURL(value) {
    if (!text(value)) return '';
    try { const url = new URL(value,location.href); return /^https?:$/.test(url.protocol) ? url.href : ''; } catch { return ''; }
  }
  function mark(element, className, next) { if (!element) return; if(!element.classList.contains(className))element.classList.add(className); next.set(element,className); }
  function details(doc) {
    return Object.fromEntries([...doc.querySelectorAll('aside dl dt')].map(dt=>[dt.textContent.trim(),dt.nextElementSibling?.textContent.trim()]).filter(([,v])=>v));
  }
  function readMetadata(doc, slug) {
    let result;
    for (const item of pageObjects(doc)) if (item.slug===slug && typeof item.titleRu==='string') {
      if (!result || Object.keys(item).length>Object.keys(result).length) result = item;
    }
    return result;
  }
  function hidePreview() {
    clearTimeout(closeTimer); activeRow?.removeAttribute('aria-describedby'); activeRow = undefined; preview.hidden = true; touchPreview = false;
  }
  function positionPreview() {
    if (!activeRow?.isConnected) { hidePreview(); return; }
    const rect = activeRow.getBoundingClientRect(), box = preview.getBoundingClientRect();
    preview.style.left = `${Math.max(12,Math.min(rect.left,innerWidth-box.width-12))}px`;
    preview.style.top = `${Math.max(12,Math.min(rect.bottom+6+box.height>innerHeight-12 ? rect.top-box.height-6 : rect.bottom+6,innerHeight-box.height-12))}px`;
  }
  function renderPreview(card) {
    const sameCard = preview.dataset.release===card.url.pathname;
    const expanded = sameCard && !preview.hidden ? preview.querySelector('details')?.open : undefined;
    const focusSummary = sameCard && document.activeElement===preview.querySelector('summary');
    preview.replaceChildren();
    preview.dataset.release = card.url.pathname;
    const data = metadata.get(card.url.pathname) ?? {};
    const info = {...data.details};
    const top = document.createElement('a'); top.className = 'dtvp-preview-top'; top.href = card.url.href;
    const cover = imageURL(card.cover || data.coverUrl);
    if (cover) { const img = document.createElement('img'); img.src = cover; img.alt = ''; top.append(img); }
    const content = document.createElement('div'); content.className = 'dtvp-preview-content';
    const title = document.createElement('strong'); title.textContent = card.title; content.append(title);
    const original = text(data.titleOriginal) || text(info['Оригинал']);
    if (original) { const name = document.createElement('p'); name.textContent = original; content.append(name); delete info['Оригинал']; }
    if (card.brief) { const brief = document.createElement('p'); brief.textContent = card.brief; content.append(brief); }
    if (Array.isArray(data.genres) && data.genres.some(g=>text(g))) {
      const tags = document.createElement('div'); tags.className = 'dtvp-preview-tags';
      for (const genre of data.genres.filter(g=>text(g))) { const tag = document.createElement('span'); tag.textContent = genre; tags.append(tag); } content.append(tags);
    }
    for (const [label,value] of [['Shikimori',data.shikimoriRating],['Рейтинг сайта',data.localRating]]) if (typeof value==='number' && Number.isFinite(value)) info[label] = String(Math.round(value*100)/100);
    if (!info['Дата'] && text(data.releaseDate) && Number.isFinite(Date.parse(data.releaseDate))) info['Дата'] = new Date(data.releaseDate).toLocaleDateString('ru-RU',{timeZone:'UTC'});
    if (!info['Возраст'] && text(data.ageRating)) info['Возраст'] = data.ageRating;
    if (!info['Озвучка']) info['Озвучка'] = {DUB:'Дубляж',ZAKADR:'Закадр'}[data.voiceType];
    const parts = card.brief.split(/\s*·\s*/);
    for (const [index,name] of ['Тип','Серии','Статус'].entries()) if(parts[index])delete info[name];
    top.append(content); preview.append(top);
    if (Object.keys(info).length) {
      const list = document.createElement('dl');
      for (const name of ['Дата','Возраст','Озвучка','Shikimori','Рейтинг сайта','Тип','Серии','Статус']) if(text(info[name])) { const label = document.createElement('dt'), detail = document.createElement('dd'); label.textContent = name; detail.textContent = info[name]; list.append(label,detail); } if(list.children.length)preview.append(list);
    }
    if (touchPreview && text(data.description)) {
      const description = document.createElement('details'), toggle = document.createElement('summary'), summary = document.createElement('p');
      toggle.textContent = 'Описание'; summary.textContent = data.description; description.append(toggle,summary); description.open = expanded ?? true;
      description.addEventListener('toggle',positionPreview); preview.append(description);
      if(focusSummary)toggle.focus();
    }
    if(touchPreview){const open=document.createElement('a');open.className='dtvp-preview-open';open.href=card.url.href;open.textContent='Открыть тайтл →';preview.append(open);}
    preview.hidden = false; positionPreview();
  }
  async function showPreview(row,card,touch=false) {
    if(collapsed)return;
    clearTimeout(closeTimer); touchPreview = touch;
    activeRow?.removeAttribute('aria-describedby'); activeRow = row; row.setAttribute('aria-describedby',preview.id); renderPreview(card);
    const known = metadata.get(card.url.pathname);
    const complete = known && (known.details || text(known.releaseDate) && text(known.ageRating) && ['DUB','ZAKADR'].includes(known.voiceType)) && Array.isArray(known.genres);
    if (complete && (!touch || text(known.description))) return;
    if (!requests.has(card.url.pathname)) {
      const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10000);
      const request = (async()=>{
        try {
          const response = await fetch(card.url.pathname,{credentials:'same-origin',signal:controller.signal});
          if (!response.ok || response.url && releaseURL(response.url)?.pathname!==card.url.pathname) return;
          const doc = new DOMParser().parseFromString(await response.text(),'text/html');
          const found = readMetadata(doc,card.url.pathname.split('/')[2]) ?? {};
          const title = doc.querySelector('main h1,#main h1');
          // A redirected error/login page must not become another release's preview.
          if (!found.titleRu && title?.textContent.trim()!==card.title) return;
          const description = heading(doc,'Описание')?.parentElement.querySelector('p')?.textContent.trim();
          const genres = [...doc.querySelectorAll('main a[href^="/catalog?g="],#main a[href^="/catalog?g="]')].map(a=>a.textContent.trim());
          metadata.set(card.url.pathname,{...known,...found,details:details(doc),...(description?{description}:{}),...(genres.length?{genres}:{})});
        } catch { /* The original card remains usable when public metadata is unavailable. */ }
        finally { clearTimeout(timeout); }
      })();
      requests.set(card.url.pathname,request);
    }
    await requests.get(card.url.pathname);
    if (activeRow===row && row.isConnected) renderPreview(card);
  }
  let closeTimer;
  function deferHide(event) {
    if(touchPreview)return;
    if (event.type==='pointerleave' && preview.contains(document.activeElement)) return;
    if (event.relatedTarget && (preview.contains(event.relatedTarget) || activeRow?.contains(event.relatedTarget))) return;
    clearTimeout(closeTimer); closeTimer = setTimeout(hidePreview,120);
  }
  preview.addEventListener('pointerenter',()=>clearTimeout(closeTimer)); preview.addEventListener('pointerleave',deferHide); preview.addEventListener('focusin',()=>clearTimeout(closeTimer)); preview.addEventListener('focusout',deferHide);
  document.addEventListener('pointerdown',event=>{touchInteraction=event.pointerType==='touch'||event.pointerType==='pen';if(event.target instanceof Node && !preview.contains(event.target) && !activeRow?.contains(event.target))hidePreview();});
  preview.addEventListener('click',event=>{if(touchPreview && event.button===0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !event.target.closest('a,details'))preview.querySelector('a')?.click();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){const focused=preview.contains(document.activeElement),row=activeRow;hidePreview();if(focused)row?.focus();hidePreview();}});
  window.addEventListener('scroll',event=>{
    if (event.target instanceof Node && preview.contains(event.target)) return;
    if (!preview.hidden && (touchPreview || document.activeElement===activeRow || preview.contains(document.activeElement))) positionPreview(); else hidePreview();
  },true);
  window.addEventListener('resize',hidePreview);
  let resizeRoot, resizeProgress;
  function positionPanel() {
    if (!resizeRoot?.isConnected || !resizeProgress?.isConnected) return;
    const value = `${Math.max(0,resizeRoot.getBoundingClientRect().bottom-resizeProgress.getBoundingClientRect().top)}px`;
    if (resizeRoot.style.getPropertyValue('--dtvp-series-bottom')!==value) resizeRoot.style.setProperty('--dtvp-series-bottom',value);
  }
  const resizeObserver = new ResizeObserver(positionPanel);
  const proxy = document.createElement('button'); proxy.type = 'button'; proxy.id = 'dtvp-series-button';
  proxy.addEventListener('click',event=>{
    event.stopPropagation();
    proxy.closest('.dtvp-series-root')?.querySelector('button[aria-label^="Серии:"]:not(#dtvp-series-button)')?.click();
  });
  function refresh() {
    const next = new Map(), release = /^\/release\/[^/]+\/?$/.test(location.pathname);
    if (route!==location.pathname) { route = location.pathname; signature = ''; hidePreview(); }
    if (release) {
      const main = document.querySelector('main,#main'), root = main?.querySelector('video')?.parentElement;
      const carousel = [...main?.querySelectorAll('h3')??[]].find(h=>/^(?:Серия|Часть)\s*\d+/.test(h.textContent.trim()))?.parentElement.parentElement;
      const native = root?.querySelector('button[aria-label^="Серии:"]:not(#dtvp-series-button)');
      if (carousel?.querySelector('button') && carousel.querySelector('[class~="group/eps"]')) mark(carousel,'dtvp-release-hidden',next);
      const quality = root?.querySelector('button[aria-label^="Качество: "]');
      const settings = root?.querySelector('button[aria-label="Настройки"]');
      const anchor = quality ?? settings?.parentElement;
      if (native && anchor) {
        mark(root,'dtvp-series-root',next); mark(native,'dtvp-release-hidden',next);
        if (proxy.nextElementSibling!==anchor) anchor.before(proxy);
        const label = native.getAttribute('aria-label'), expanded = native.getAttribute('aria-expanded') ?? 'false';
        for (const [name,value] of [['aria-label',label],['aria-expanded',expanded]]) if(proxy.getAttribute(name)!==value)proxy.setAttribute(name,value);
        const content = native.innerHTML; if(proxy.innerHTML!==content)proxy.innerHTML = content;
        if (proxy.disabled!==native.disabled) proxy.disabled = native.disabled;
        const panel = [...root.children].find(el=>el.hasAttribute('aria-hidden') && el.querySelector('button[data-current],button[aria-current]'));
        if (panel) mark(panel,'dtvp-series-panel',next);
        const progress = root.querySelector('[aria-label="Прогресс воспроизведения"]');
        if (root!==resizeRoot || progress!==resizeProgress) { resizeObserver.disconnect(); resizeRoot = root; resizeProgress = progress; resizeObserver.observe(root); if(progress)resizeObserver.observe(progress); }
        positionPanel();
      } else proxy.remove();
      const label = [...main?.querySelectorAll('aside div')??[]].find(el=>el.children.length===0 && el.textContent.trim()==='ФРАНШИЗА');
      const source = label?.parentElement, descriptionHeading = heading(document,'Описание'), description = descriptionHeading?.parentElement;
      const commentsHeading = heading(document,'Комментарии');
      const comments = commentsHeading?.closest('div.border-t') ?? commentsHeading?.parentElement.parentElement;
      const placement = description ?? comments;
      if (source && placement) {
        const cards = [...source.querySelectorAll('a[href]')].map(link=>({url:releaseURL(link.getAttribute('href')),title:link.querySelector('p')?.textContent.trim() || link.querySelector('img')?.alt || '',brief:link.querySelectorAll('p')[1]?.textContent.trim() || '',cover:link.querySelector('img')?.getAttribute('src') || ''})).filter(card=>card.url && card.title);
        const nextSignature = JSON.stringify(cards.map(c=>[c.url.pathname,c.title,c.brief,c.cover]));
        if (cards.length) {
          mark(source,'dtvp-release-hidden',next);
          if (source!==sourceBlock || placement!==descriptionBlock || signature!==nextSignature) {
            hidePreview(); sourceBlock = source; descriptionBlock = placement; signature = nextSignature;
            section.replaceChildren(); const title = document.createElement('h3'); title.textContent = 'Франшиза'; title.className = descriptionHeading?.className ?? 'font-display text-[13px] font-semibold tracking-wide text-text-primary mb-3';
            const toggle = document.createElement('button'); toggle.type = 'button'; toggle.id = 'dtvp-franchise-toggle'; toggle.className = 'dtvp-expand'; toggle.setAttribute('aria-controls','dtvp-franchise-rows');
            const rows = document.createElement('div'); rows.id = 'dtvp-franchise-rows';
            function updateCollapse() { rows.hidden = collapsed; toggle.textContent = collapsed?'Показать':'Свернуть'; toggle.setAttribute('aria-expanded',String(!collapsed)); }
            toggle.addEventListener('click',()=>{collapsed=!collapsed;try{localStorage.setItem('dubtv-plus-franchise-collapsed',String(collapsed));}catch{/* Keep the session preference. */}hidePreview();updateCollapse();});
            updateCollapse();title.append(toggle);section.append(title,rows);
            for (const card of cards) {
              const current = readMetadata(document,card.url.pathname.split('/')[2]); if(current)metadata.set(card.url.pathname,current);
              const row = document.createElement('a'); row.href = card.url.href; row.textContent = card.title;
              if (card.brief) { const brief = document.createElement('span'); brief.textContent = ` — ${card.brief}`; row.append(brief); }
              row.addEventListener('pointerenter',event=>{if(event.pointerType==='touch'||event.pointerType==='pen'||matchMedia('(hover: none)').matches)return;touchInteraction=false;showPreview(row,card);}); row.addEventListener('pointerleave',deferHide);
              row.addEventListener('focus',()=>{if(!touchInteraction&&!matchMedia('(hover: none)').matches)showPreview(row,card);}); row.addEventListener('blur',deferHide);
              row.addEventListener('click',event=>{if((touchInteraction||matchMedia('(hover: none)').matches) && event.button===0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey){event.preventDefault();showPreview(row,card,true);}});
              row.addEventListener('keydown',event=>{if(event.key==='ArrowRight' && activeRow===row && !preview.hidden){event.preventDefault();preview.querySelector('a')?.focus();}});rows.append(row);
            }
          }
          if (description) {if(description.nextElementSibling!==section)description.after(section);}
          else if (comments.previousElementSibling!==section) comments.before(section);
        } else {section.remove();hidePreview();}
      } else {section.remove();signature = '';hidePreview();}
    } else {proxy.remove();section.remove();hidePreview();resizeObserver.disconnect();}
    for (const [element,className] of marked) if(!next.has(element)) {element.classList.remove(className);if(className==='dtvp-series-root')element.style.removeProperty('--dtvp-series-bottom');}
    marked.clear(); for(const [element,className] of next)marked.set(element,className);
  }
  return refresh;
}


  function readOptions() {
    try {
      const value = JSON.parse(localStorage.getItem('dubtv-plus-options'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  const options = readOptions();
  const states = new WeakMap();
  let activeVideo;
  let theatre = false;
  let route = location.pathname;
  const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  function saveOptions() {
    try { localStorage.setItem('dubtv-plus-options', JSON.stringify(options)); } catch { /* Session-only settings. */ }
  }
  function button(text, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.addEventListener('click', action);
    return element;
  }
  const style = document.createElement('style');
  style.textContent = `
    #dubtv-plus-open{position:fixed;right:16px;bottom:80px;z-index:10001;display:flex;align-items:center;justify-content:center;background:var(--color-surface,#141418);color:var(--color-text-primary,#f0f0f0);border:1px solid var(--color-border,#2a2a32);border-radius:10px;padding:8px;font-family:inherit;font-size:13px;font-weight:600;cursor:grab;touch-action:none;user-select:none;box-shadow:0 4px 16px #0005;transition:background .15s}
    #dubtv-plus-open:hover{background:var(--color-surface-hover,#1c1c22)}
    #dubtv-plus-open:active{cursor:grabbing}#dubtv-plus-open img{width:28px;height:28px;pointer-events:none}
    .dtvp-dialog{position:fixed;inset:0;margin:auto;color:var(--color-text-primary,#f0f0f0);background:var(--color-surface,#141418);border:1px solid var(--color-border,#2a2a32);border-radius:16px;padding:24px;width:min(560px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:85dvh;overflow:auto;font-family:inherit;font-size:14px;line-height:1.5;box-sizing:border-box;box-shadow:0 20px 80px #0008;color-scheme:dark;text-align:left}
    .dtvp-dialog *{box-sizing:border-box}.dtvp-dialog::backdrop{background:#0009}.dtvp-dialog h2{font-size:22px;font-weight:700;line-height:1.3;margin:0}.dtvp-dialog h3{font-size:15px;font-weight:600;line-height:1.4;margin:20px 0 12px}
    .dtvp-dialog label{display:flex;align-items:center;gap:12px;margin:14px 0;min-width:0}.dtvp-dialog .dtvp-field{display:flex;flex-direction:column;align-items:stretch;gap:8px}
    .dtvp-dialog button,.dtvp-dialog select,.dtvp-dialog input:not([type=checkbox]){background:var(--color-background,#0a0a0c);color:inherit;border:1px solid var(--color-border,#2a2a32);border-radius:8px;padding:9px 12px;font:inherit;min-width:0;max-width:100%;transition:background .15s,border-color .15s}
    .dtvp-dialog select,.dtvp-dialog input:not([type=checkbox]){width:100%}.dtvp-dialog input[type=checkbox]{appearance:auto;width:18px;height:18px;flex:0 0 18px;margin:0;accent-color:var(--color-primary,#d6381c)}.dtvp-dialog button{cursor:pointer;white-space:normal;background:var(--color-surface-hover,#1c1c22);border-color:transparent}.dtvp-dialog button:hover{background:#ffffff0d}.dtvp-dialog button:disabled{opacity:.5;cursor:default}
    .dtvp-dialog :focus-visible,#dubtv-plus-open:focus-visible,.dtvp-expand:focus-visible{outline:2px solid var(--color-primary-light,#f08a73);outline-offset:3px}
    .dtvp-dialog p{color:#9a9aaa;margin:12px 0;overflow-wrap:anywhere}.dtvp-dialog a{color:var(--color-primary-light,#f08a73);text-decoration:underline}.dtvp-dialog [hidden]{display:none!important}
    .dtvp-heading,.dtvp-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.dtvp-heading{margin-bottom:20px}.dtvp-heading h2{display:flex;align-items:center;gap:10px}.dtvp-heading img{width:40px;height:40px}
    .dtvp-actions{justify-content:flex-end;margin-top:20px;flex-wrap:wrap}.dtvp-dialog .dtvp-primary{background:var(--color-primary,#d6381c);border-color:transparent;color:white}.dtvp-dialog .dtvp-primary:hover{background:#bd3018}
    .dtvp-tabs{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid var(--color-border,#2a2a32)}.dtvp-dialog [role=tab]{flex:1;padding:8px;font-size:13px;background:transparent;color:#9a9aaa}.dtvp-dialog [aria-selected=true]{background:#d6381c1a;border-color:transparent;color:var(--color-primary-light,#f08a73)}
    .dtvp-shortcuts{display:grid;grid-template-columns:max-content 1fr;gap:10px 16px}.dtvp-shortcuts dt{font-weight:600;color:var(--color-primary-light,#f08a73)}.dtvp-shortcuts dd{margin:0}
    @media(max-width:420px){.dtvp-dialog{padding:18px}.dtvp-dialog [role=tab]{flex-basis:40%}.dtvp-heading{align-items:flex-start}}
    #dubtv-plus-remaining{display:block;font:11px system-ui;color:white;white-space:nowrap;padding:0}
    #dubtv-plus-remaining[hidden]{display:none!important}
    #dubtv-plus-undo{position:absolute;bottom:95px;left:16px;z-index:35;padding:9px 12px;background:#141418ee;color:#fff;border:1px solid var(--color-border,#2a2a32);border-radius:6px;font:14px system-ui;cursor:pointer}
    #dubtv-plus-undo[hidden]{display:none!important}
    .dtvp-collapsed-content{display:none!important}.dtvp-expand{font:12px system-ui;color:inherit;background:transparent;border:1px solid var(--color-border,#2a2a32);border-radius:4px;padding:4px 8px;margin-left:10px;cursor:pointer}
    .dtvp-player:not(:fullscreen){max-height:var(--dtvp-height,85vh)!important}
    .dtvp-no-glow .dtvp-glow{display:none!important}
    html.dtvp-theatre,html.dtvp-theatre body{overflow-y:auto!important}
    .dtvp-theatre header,.dtvp-theatre nav[aria-label="Разделы сайта"]{display:none!important}
    .dtvp-theatre .dtvp-wide{width:100%!important;max-width:none!important;margin:0!important;padding:0!important;overflow:visible!important;transform:none!important}
    .dtvp-theatre .dtvp-player:not(:fullscreen){position:relative!important;inset:auto!important;transform:none!important;transition:none!important;width:100%!important;height:100dvh!important;max-height:none!important;aspect-ratio:auto!important;border:0!important;border-radius:0!important;box-shadow:none!important}
    .dtvp-theatre .dtvp-player video{object-fit:contain!important;width:100%!important;height:100%!important}
    .dtvp-theatre .dtvp-glow{display:none!important}
    @media(max-width:600px){#dubtv-plus-remaining{font-size:10px}#dubtv-plus-open{right:8px;bottom:76px}}
  `;
  document.head.append(style);
  const settings = document.createElement('dialog');
  settings.id = 'dubtv-plus-settings';
  settings.className = 'dtvp-dialog';
  settings.setAttribute('aria-label', 'Настройки DubTV+');
  settings.innerHTML = '<div class="dtvp-heading"><h2><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KICA8cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTgxODFjIi8+CiAgPGcgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI5MDAiIGZvbnQtc2l6ZT0iMzkiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgPGcgZmlsbD0iI2I4M2IyYiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMiAzKSI+PHRleHQgeD0iNjQiIHk9IjU2Ij5EVUI8L3RleHQ+PHRleHQgeD0iNDgiIHk9Ijk2Ij5UVjwvdGV4dD48L2c+CiAgICA8ZyBmaWxsPSIjZjRmMmVlIj48dGV4dCB4PSI2NCIgeT0iNTYiPkRVQjwvdGV4dD48dGV4dCB4PSI0OCIgeT0iOTYiPlRWPC90ZXh0PjwvZz4KICA8L2c+CiAgPHBhdGggZD0iTTk2IDcwdjI2bS0xMy0xM2gyNiIgc3Ryb2tlPSIjZmY2ODQyIiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K" alt="">Настройки</h2></div><div class="dtvp-tabs" role="tablist" aria-label="Разделы настроек"></div>';
  settings.querySelector('.dtvp-heading').append(button('Закрыть', () => settings.close()));
  const panels = {};
  for (const [id, title] of [['player','Плеер'],['interface','Интерфейс'],['library','Каталог'],['about','О скрипте']]) {
    const panel = document.createElement('section');
    panel.id = `dtvp-panel-${id}`; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',`dtvp-tab-${id}`);
    panel.hidden = id !== 'player';
    const tab = button(title, () => {
      for (const item of settings.querySelectorAll('[role=tab]')) {
        const selected = item === tab;
        item.setAttribute('aria-selected',String(selected)); item.tabIndex = selected ? 0 : -1;
        document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
      }
    });
    tab.id = `dtvp-tab-${id}`; tab.setAttribute('role','tab'); tab.setAttribute('aria-controls',panel.id);
    tab.setAttribute('aria-selected',String(!panel.hidden)); tab.tabIndex = panel.hidden ? -1 : 0;
    settings.querySelector('[role=tablist]').append(tab); settings.append(panel); panels[id] = panel;
  }
  settings.querySelector('[role=tablist]').addEventListener('keydown', event => {
    const tabs = Array.from(settings.querySelectorAll('[role=tab]'));
    const index = tabs.indexOf(event.target);
    if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  });
  panels.player.innerHTML = '<h3>Воспроизведение</h3>';
  panels.interface.innerHTML = '<h3>Внешний вид страницы</h3>';
  function checkbox(panel, key, title, defaultValue = false) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.option = key;
    input.checked = typeof options[key] === 'boolean' ? options[key] : defaultValue;
    options[key] = input.checked;
    input.addEventListener('change', () => { options[key] = input.checked; saveOptions(); refresh(); });
    label.append(input, title);
    panel.append(label);
  }
  checkbox(panels.interface, 'noGlow', 'Убрать размытый фон вокруг плеера');
  checkbox(panels.interface, 'description', 'Сворачивать описание');
  checkbox(panels.interface, 'comments', 'Сворачивать комментарии');
  checkbox(panels.interface, 'related', 'Сворачивать похожие тайтлы');
  checkbox(panels.interface, 'shikimoriRip', 'Открывать Shikimori на shikimori.rip');
  checkbox(panels.interface, 'showListActions', 'Показывать «Добавить в…» на карточках', true);
  checkbox(panels.interface, 'showHideActions', 'Показывать «Не интересно» на карточках', true);
  checkbox(panels.player, 'hotkeys', 'Горячие клавиши DubTV+', true);
  checkbox(panels.player, 'remaining', 'Реальное оставшееся время', true);
  checkbox(panels.player, 'undo', 'Предлагать отмену перемотки', true);
  const heightLabel = document.createElement('label');
  heightLabel.textContent = 'Высота обычного плеера';
  heightLabel.className = 'dtvp-field';
  const height = document.createElement('select');
  for (const value of ['60', '75', '85', '100']) height.add(new Option(`${value}% окна`, value));
  height.value = ['60','75','85','100'].includes(options.height) ? options.height : '85';
  options.height = height.value;
  height.addEventListener('change', () => { options.height = height.value; saveOptions(); refresh(); });
  heightLabel.append(height); panels.interface.append(heightLabel);
  const help = document.createElement('div');
  help.innerHTML = '<h3>Горячие клавиши</h3><dl class="dtvp-shortcuts"><dt>X / C</dt><dd>Скорость −0,25× / +0,25×</dd><dt>G</dt><dd>Перейти к времени</dd><dt>Shift + ← / →</dt><dd>Предыдущая / следующая серия</dd><dt>T / Esc</dt><dd>Кинотеатр / выход</dd><dt>Z</dt><dd>Отменить перемотку</dd></dl><p>Работают и с русской раскладкой. В полях ввода клавиши не перехватываются.</p>';
  panels.player.append(help);
  panels.about.innerHTML = '<h3>DubTV+ · 1.1.0</h3><p>Автор: <a href="https://github.com/Laynholt" target="_blank" rel="noopener noreferrer">laynholt</a></p><p>Неофициальные улучшения DubTV для Violentmonkey.</p><p><a href="https://github.com/Laynholt/dubtv-plus" target="_blank" rel="noopener noreferrer">Исходный код</a> · <a href="https://github.com/Laynholt/dubtv-plus/releases" target="_blank" rel="noopener noreferrer">Релизы</a></p><p>Обновления из релизов проверяет Violentmonkey. Настройки и скрытые тайтлы сохраняются в этом браузере.</p>';
  const report = document.createElement('a'); report.textContent='Сообщить об ошибке'; report.id='dtvp-report-bug'; report.target='_blank'; report.rel='noopener noreferrer';
  report.href='https://github.com/Laynholt/dubtv-plus/issues/new?'+new URLSearchParams({title:'[Ошибка] ',body:'### Устройство и версии\n- Устройство:\n- ОС и версия:\n- Браузер и версия:\n- Менеджер скриптов и версия:\n- DubTV+: 1.1.0\n\n### Ссылка на тайтл или страницу\n\n### Как повторить\n1. \n2. \n\n### Ожидаемое поведение\n\n### Что происходит\n\n### Скриншоты или видео\nПрикрепите файлы к этому сообщению или добавьте ссылки.\n'});
  const sourceLinks=panels.about.querySelector('a[href$="/releases"]').parentElement;sourceLinks.append(' · ',report);
  document.body.append(settings);
  const refreshDownloads = createDownloadTools(panels.player);
  const refreshAutoplay = createAutoplayTools();
  const refreshReleaseLayout = createReleaseLayoutTools();
  const refreshLibrary = typeof createLibraryTools === 'function' ? createLibraryTools(panels.library, options) : () => {};
  let dragged = false;
  const openSettings = button('', event => {
    if (dragged && event.detail !== 0) { dragged = false; return; }
    settings.showModal();
  });
  openSettings.innerHTML = '<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KICA8cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTgxODFjIi8+CiAgPGcgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI5MDAiIGZvbnQtc2l6ZT0iMzkiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgPGcgZmlsbD0iI2I4M2IyYiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMiAzKSI+PHRleHQgeD0iNjQiIHk9IjU2Ij5EVUI8L3RleHQ+PHRleHQgeD0iNDgiIHk9Ijk2Ij5UVjwvdGV4dD48L2c+CiAgICA8ZyBmaWxsPSIjZjRmMmVlIj48dGV4dCB4PSI2NCIgeT0iNTYiPkRVQjwvdGV4dD48dGV4dCB4PSI0OCIgeT0iOTYiPlRWPC90ZXh0PjwvZz4KICA8L2c+CiAgPHBhdGggZD0iTTk2IDcwdjI2bS0xMy0xM2gyNiIgc3Ryb2tlPSIjZmY2ODQyIiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K" alt="" draggable="false">';
  openSettings.id = 'dubtv-plus-open';
  openSettings.setAttribute('aria-label', 'Настройки DubTV+');
  openSettings.title = 'Открыть настройки · перетащите для перемещения · Alt + стрелки при фокусе';
  document.body.append(openSettings);
  function placeButton(x, y) {
    const rect = openSettings.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y, innerHeight - rect.height - 8));
    Object.assign(openSettings.style, {left:`${left}px`, top:`${top}px`, right:'auto', bottom:'auto'});
    options.buttonPosition = {x:left, y:top};
  }
  const position = options.buttonPosition;
  if (Number.isFinite(position?.x) && Number.isFinite(position?.y)) placeButton(position.x, position.y);
  let drag;
  openSettings.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = openSettings.getBoundingClientRect();
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top};
    dragged = false; openSettings.setPointerCapture(event.pointerId);
  });
  openSettings.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!dragged && Math.hypot(dx,dy) < 5) return;
    dragged = true; placeButton(drag.left + dx, drag.top + dy);
  });
  function finishButtonDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    drag = undefined;
    if (dragged) saveOptions();
  }
  for (const name of ['pointerup','pointercancel','lostpointercapture']) openSettings.addEventListener(name, finishButtonDrag);
  openSettings.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const rect = openSettings.getBoundingClientRect();
    placeButton(rect.left + (event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0), rect.top + (event.key === 'ArrowDown' ? 16 : event.key === 'ArrowUp' ? -16 : 0));
    saveOptions();
  });
  window.addEventListener('resize', () => {
    const rect = openSettings.getBoundingClientRect(); placeButton(rect.left,rect.top);
  });
  const positionHelp = document.createElement('p');
  positionHelp.textContent = 'Кнопку DubTV+ можно перетаскивать. С клавиатуры: выделите её Tab и нажимайте Alt + стрелки.';
  panels.interface.append(positionHelp, button('Вернуть кнопку на место', () => {
    openSettings.removeAttribute('style'); delete options.buttonPosition; saveOptions();
  }));
  const jump = document.createElement('dialog');
  jump.id = 'dubtv-plus-jump'; jump.className = 'dtvp-dialog';
  jump.setAttribute('aria-label', 'Перейти к времени');
  jump.innerHTML = '<form><h2>Перейти к времени</h2><label class="dtvp-field">Время или секунды вперёд<input id="dubtv-plus-time" autocomplete="off" placeholder="3 15, 03:15 или 30" aria-describedby="dtvp-time-help" required></label><p id="dtvp-time-help">3 15 или 03:15 → к 3:15<br>1 02 30 → к 1:02:30<br>30 → на 30 секунд вперёд от текущего времени</p><div class="dtvp-actions"><button type="submit" class="dtvp-primary">Перейти</button></div></form>';
  jump.querySelector('.dtvp-actions').prepend(button('Отмена', () => jump.close())); document.body.append(jump);
  const timeInput = jump.querySelector('input');
  timeInput.addEventListener('input', () => timeInput.setCustomValidity(''));
  jump.querySelector('form').addEventListener('submit', event => {
    event.preventDefault();
    const text = timeInput.value.trim();
    const parts = text.split(/:|\s+/).map(Number);
    const seconds = parts.reduce((sum, part) => sum * 60 + part, 0) + (parts.length === 1 ? activeVideo?.currentTime ?? 0 : 0);
    if (!/^(?:\d+|\d+(?::[0-5]?\d){1,2}|\d+(?:\s+[0-5]?\d){1,2})$/.test(text) || !activeVideo || !Number.isFinite(seconds) || !Number.isFinite(activeVideo.duration) || seconds > activeVideo.duration) {
      timeInput.setCustomValidity('Введите время в пределах серии: 3 15, 03:15 или число секунд вперёд.'); timeInput.reportValidity(); return;
    }
    armSeek(activeVideo);
    activeVideo.currentTime = seconds;
    jump.close();
  });
  function toggleTheatre(force) {
    if (!activeVideo || document.fullscreenElement) return;
    theatre = force ?? !theatre;
    applyLayout();
    if (theatre) activeVideo.parentElement.scrollIntoView({block:'start'});
  }
  function applyLayout() {
    document.documentElement.classList.toggle('dtvp-theatre', theatre && onRelease() && !!activeVideo);
    document.documentElement.classList.toggle('dtvp-no-glow', options.noGlow && onRelease());
    for (const element of document.querySelectorAll('.dtvp-player,.dtvp-wide,.dtvp-glow')) {
      if (!activeVideo || !onRelease() || (element.classList.contains('dtvp-player') && element !== activeVideo.parentElement) || (element.classList.contains('dtvp-wide') && !element.contains(activeVideo))) {
        element.classList.remove('dtvp-player','dtvp-wide','dtvp-glow');
        element.style.removeProperty('--dtvp-height');
      }
    }
    if (!activeVideo || !onRelease()) return;
    const root = activeVideo.parentElement;
    root.classList.add('dtvp-player');
    const maxHeight = `${options.height}vh`;
    if (root.style.getPropertyValue('--dtvp-height') !== maxHeight) root.style.setProperty('--dtvp-height', maxHeight);
    const section = root.closest('section');
    if (section) {
      for (let p = root.parentElement; p && p !== document.body; p = p.parentElement) p.classList.add('dtvp-wide');
      for (const p of [section, root.parentElement]) {
        for (const child of p.children) if (child !== root && !child.contains(root) && (child.classList.contains('pointer-events-none') || child.getAttribute('aria-hidden') === 'true')) child.classList.add('dtvp-glow');
      }
    }
    const nativeTheatre = root.querySelector('button[aria-label="Режим кинотеатра"]');
    if (nativeTheatre) {
      const pressed = String(theatre);
      if (nativeTheatre.getAttribute('aria-pressed') !== pressed) nativeTheatre.setAttribute('aria-pressed', pressed);
      nativeTheatre.title = 'Кинотеатр с прокруткой (T)';
    }
  }
  function compactSections() {
    for (const [title, key] of [['Описание','description'],['Комментарии','comments'],['Похожее','related']]) {
      const heading = Array.from(document.querySelectorAll('main h2,main h3,#main h2,#main h3')).find(h => h.childNodes[0]?.textContent.trim() === title);
      if (!heading || !onRelease()) continue;
      let toggle = heading.querySelector('[data-expand]');
      if (!toggle) {
        toggle = button('', () => {
          options[key] = !options[key]; saveOptions();
          settings.querySelector(`[data-option="${key}"]`).checked = options[key];
          compactSections();
        });
        toggle.className = 'dtvp-expand'; toggle.dataset.expand = key; heading.append(toggle);
      }
      setText(toggle, options[key] ? 'Показать' : 'Свернуть');
      const expanded = String(!options[key]);
      if (toggle.getAttribute('aria-expanded') !== expanded) toggle.setAttribute('aria-expanded', expanded);
      const container = key === 'description' ? heading.parentElement : key === 'comments' ? heading.parentElement.parentElement : heading.closest('section');
      if (!container) continue;
      for (const child of container.children) if (child !== heading && !child.contains(heading)) child.classList.toggle('dtvp-collapsed-content', options[key]);
    }
  }
  function armSeek(video, dragging = false) {
    const state = states.get(video);
    if (state) {
      clearTimeout(state.timer);
      state.armed = {from: video.currentTime, until: dragging ? Infinity : performance.now() + 3000};
      state.timer = setTimeout(() => { if (state.armed?.until !== Infinity) clearUndo(video); }, 8000);
    }
  }
  function clearUndo(video) {
    const state = states.get(video);
    if (!state) return;
    clearTimeout(state.timer); state.undo = null; state.armed = null;
    state.root.querySelector('#dubtv-plus-undo')?.setAttribute('hidden','');
  }
  function undoSeek() {
    const state = states.get(activeVideo);
    if (!state || state.undo === null) return;
    const target = state.undo; clearUndo(activeVideo); activeVideo.currentTime = target;
  }
  function remainingTime(video) {
    if (video !== activeVideo || !video.isConnected) return;
    const label = video.parentElement?.querySelector('#dubtv-plus-remaining');
    if (!label) return;
    const seconds = Math.ceil(Math.max(0, video.duration - video.currentTime) / video.playbackRate);
    label.hidden = !options.remaining || !Number.isFinite(seconds);
    if (!label.hidden) {
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor(seconds / 60) % 60;
      const time = `${hours ? hours + ':' + String(minutes).padStart(2,'0') : minutes}:${String(seconds % 60).padStart(2,'0')}`;
      setText(label, `Осталось ≈${time}`);
      label.title = `С учётом фактической скорости ${video.playbackRate}×`;
    }
  }
  function bindExtras(video) {
    if (states.has(video)) return;
    const state = {root:video.parentElement, armed:null, undo:null, timer:null}; states.set(video, state);
    for (const name of ['timeupdate','durationchange','ratechange']) video.addEventListener(name, () => remainingTime(video));
    for (const event of ['loadstart','emptied']) video.addEventListener(event, () => { if (video === activeVideo) clearUndo(video); });
    video.addEventListener('seeking', () => {
      if (video !== activeVideo || !video.isConnected || !options.undo || !state.armed || state.armed.until < performance.now() || Math.abs(video.currentTime - state.armed.from) < 1) return;
      state.undo = state.armed.from;
      let undo = video.parentElement.querySelector('#dubtv-plus-undo');
      if (!undo) { undo = button('Вернуть назад (Z)', undoSeek); undo.id = 'dubtv-plus-undo'; video.parentElement.append(undo); }
      undo.hidden = false;
      clearTimeout(state.timer);
      if (state.armed.until !== Infinity) state.timer = setTimeout(() => clearUndo(video), 8000);
    });
  }
  document.addEventListener('pointerdown', event => {
    if (!activeVideo || !options.undo || !onRelease()) return;
    const root = activeVideo.parentElement;
    if (root.contains(event.target) && event.target.closest('[aria-label="Прогресс воспроизведения"]')) armSeek(activeVideo, true);
  }, true);
  function finishDrag() {
    const video = activeVideo;
    const state = states.get(video);
    if (state?.armed) {
      state.armed.until = performance.now() + 1000;
      clearTimeout(state.timer); state.timer = setTimeout(() => clearUndo(video), 8000);
    }
  }
  document.addEventListener('pointerup', finishDrag, true);
  document.addEventListener('pointercancel', finishDrag, true);
  window.addEventListener('blur', finishDrag);
  window.addEventListener('click', event => {
    const control = event.target.closest?.('button');
    if (!onRelease() || !control) return;
    if (control.getAttribute('aria-label') === 'Полный экран') {
      const video = activeVideo;
      // iPad can identify as a Mac when requesting the desktop site.
      const appleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
      if (!appleMobile || !video?.isConnected || !video.parentElement.contains(control) || document.fullscreenElement || video.webkitDisplayingFullscreen || typeof video.webkitEnterFullscreen !== 'function' || video.webkitSupportsFullscreen === false) return;
      try {
        // Keep the native call inside the tap handler to retain user activation.
        video.webkitEnterFullscreen();
        event.preventDefault(); event.stopImmediatePropagation();
      } catch { /* Let the site's fullscreen handler run if native entry is unavailable. */ }
      return;
    }
    if (control.getAttribute('aria-label') !== 'Режим кинотеатра') return;
    event.preventDefault(); event.stopImmediatePropagation(); toggleTheatre();
  }, true);
  async function changeSpeed(delta) {
    const video = activeVideo;
    const rate = Math.min(2, Math.max(0.25, Math.round((video.playbackRate + delta) * 4) / 4));
    const root = video.parentElement;
    const settingsButton = root.querySelector('button[aria-label="Настройки"]');
    if (settingsButton?.getAttribute('aria-expanded') === 'true') return;
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const speedBadge = root.querySelector('button[aria-label^="Скорость "]');
    if (speedBadge) speedBadge.click();
    else if (settingsButton) {
      settingsButton.click(); await frame();
      Array.from(root.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('Скорость'))?.click();
    }
    await frame();
    if (video !== activeVideo || !video.isConnected) return;
    const speedChoice = Array.from(document.querySelectorAll('button')).find(b => b.getClientRects().length && b.textContent.trim() === (rate === 1 ? 'Обычная' : `${rate}×`));
    if (speedChoice) speedChoice.click();
    else { document.cookie = `player_speed=${rate};path=/;max-age=31536000;SameSite=Lax`; restoreSpeed(video); }
    await frame();
    if (settingsButton?.getAttribute('aria-expanded') === 'true') settingsButton.click();
  }
  window.addEventListener('keydown', event => {
    if (!onRelease() || !activeVideo || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || document.querySelector('dialog[open]')) return;
    if (event.code === 'Escape' && theatre) { event.preventDefault(); event.stopImmediatePropagation(); toggleTheatre(false); return; }
    if (!options.hotkeys) return;
    let action;
    if (event.shiftKey && ['ArrowRight','ArrowLeft'].includes(event.code)) action = () => nativeNavigation(event.code === 'ArrowRight' ? 'След.' : 'Пред.')?.click();
    else if (!event.shiftKey && event.code === 'KeyT') action = () => toggleTheatre();
    else if (!event.shiftKey && ['KeyX','KeyC'].includes(event.code)) action = () => changeSpeed(event.code === 'KeyC' ? 0.25 : -0.25);
    else if (!event.shiftKey && event.code === 'KeyZ') action = undoSeek;
    else if (!event.shiftKey && event.code === 'KeyG') action = () => { timeInput.value = ''; timeInput.setCustomValidity(''); jump.showModal(); timeInput.focus(); };
    else if (!event.shiftKey && ['ArrowRight','ArrowLeft'].includes(event.code)) armSeek(activeVideo);
    if (action) { event.preventDefault(); event.stopImmediatePropagation(); if (!event.repeat) action(); }
  }, true);

  function qualityOptions() {
    return Array.from(document.querySelectorAll('button[aria-label="Назад к настройкам"]'))
      .filter(back => back.textContent.trim() === 'Качество' && back.getClientRects().length)
      .flatMap(back => Array.from(back.parentElement.querySelectorAll('button')))
      .filter(button => /^(?:Авто|\d{3,4}p)$/.test(button.textContent.trim()));
  }

  document.addEventListener('click', event => {
    if (!onRelease() || applyingQuality) return;
    const button = event.target.closest?.('button');
    if (!button || !qualityOptions().includes(button)) return;
    preferredQuality = button.textContent.trim();
    pendingQuality = false;
    qualityRestore = undefined;
    try { localStorage.setItem(qualityKey, preferredQuality); } catch { /* Keep this session's choice. */ }
  }, true);

  function restoreQuality(video) {
    if (!pendingQuality || !/^(?:Авто|\d{3,4}p)$/.test(preferredQuality ?? '')) return;
    const root = video.parentElement;
    const badge = root.querySelector('button[aria-label^="Качество: "]');
    if (!badge) return;
    if (qualityRestore) {
      if (qualityRestore.video !== video) {
        qualityRestore = undefined;
        return;
      }
      const options = qualityOptions();
      if (!options.length) return;
      const resolutions = options.filter(button => /p$/.test(button.textContent.trim()))
        .sort((a, b) => parseInt(b.textContent) - parseInt(a.textContent));
      const choice = options.find(button => button.textContent.trim() === preferredQuality)
        ?? resolutions.find(button => parseInt(button.textContent) <= parseInt(preferredQuality))
        ?? resolutions.at(-1);
      const settings = qualityRestore.settings;
      qualityRestore = undefined;
      pendingQuality = false;
      applyingQuality = true;
      try {
        if (choice) {
          // Avoid reloading the same fallback source (notably on native HLS).
          if (choice.textContent.trim() !== badge.textContent.trim()) choice.click();
        }
        if (settings.getAttribute('aria-expanded') === 'true') settings.click();
      } finally { applyingQuality = false; }
      return;
    }
    const current = badge.textContent.trim();
    if (current === preferredQuality) {
      pendingQuality = false;
      return;
    }
    const settings = root.querySelector('button[aria-label="Настройки"]');
    // Never take over a menu the viewer is currently using.
    if (!settings || settings.getAttribute('aria-expanded') === 'true') return;
    const attempt = {video, settings};
    qualityRestore = attempt;
    // shortcut: DOM menus are site-owned; abandon if they change, retry on the next video load.
    setTimeout(() => {
      if (qualityRestore !== attempt) return;
      qualityRestore = undefined;
      pendingQuality = false;
    }, 2000);
    badge.click();
  }

  function restoreSpeed(video) {
    if (!onRelease() || !video.isConnected) return;
    const saved = Number(document.cookie.match(/(?:^|;\s*)player_speed=([\d.]+)(?:;|$)/)?.[1]);
    const rate = Number.isFinite(saved) && saved >= 0.25 && saved <= 2 ? saved : 1;
    // load() resets playbackRate to defaultPlaybackRate when the source changes.
    if (video.defaultPlaybackRate !== rate) video.defaultPlaybackRate = rate;
    if (video.playbackRate !== rate) video.playbackRate = rate;
  }

  function nativeNavigation(label) {
    return Array.from(document.querySelectorAll('main button, #main button'))
      .find(button => !button.closest(`#${navigationId}`) && button.textContent.trim() === label);
  }

  function addNavigation(playButton) {
    const navigation = document.createElement('span');
    navigation.id = navigationId;
    navigation.setAttribute('role', 'group');
    navigation.setAttribute('aria-label', 'Переключение серий');
    navigation.style.cssText = 'display:inline-flex;flex-shrink:0;align-items:center';
    for (const [label, title, path] of [
      ['Пред.', 'Предыдущая серия', 'M5 4h3v16H5zM19 4v16L9 12z'],
      ['След.', 'Следующая серия', 'M16 4h3v16h-3zM5 4l10 8-10 8z'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.dataset.nativeLabel = label;
      button.className = playButton.className;
      button.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:36px;height:40px;flex-shrink:0';
      button.innerHTML = `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="${path}"/></svg>`;
      button.addEventListener('click', event => {
        event.stopPropagation();
        const target = nativeNavigation(label);
        if (target && !target.disabled) target.click();
      });
      navigation.append(button);
    }
    playButton.after(navigation);
    return navigation;
  }

  const changedShikimoriLinks = new WeakMap();
  function refreshPageInterface() {
    for (const field of document.querySelectorAll('main textarea[placeholder="Написать комментарий..."],#main textarea[placeholder="Написать комментарий..."]')) if(field.rows!==6)field.rows=6;
    for (const link of document.querySelectorAll('a[href]')) {
      const changed=changedShikimoriLinks.get(link);
      if (!options.shikimoriRip) {
        if(changed && link.href===changed.replacement)link.href=changed.original;
        changedShikimoriLinks.delete(link);continue;
      }
      let url;try{url=new URL(link.href);}catch{continue;}
      if (url.hostname!=='shikimori.one' || !['http:','https:'].includes(url.protocol))continue;
      const original=link.href;url.hostname='shikimori.rip';link.href=url.href;
      changedShikimoriLinks.set(link,{original,replacement:link.href});
    }
  }

  function refresh() {
    if (route !== location.pathname) {
      route = location.pathname; theatre = false;
      if (activeVideo) clearUndo(activeVideo);
      activeVideo = null; settings.close(); jump.close();
      document.querySelectorAll('.dtvp-collapsed-content').forEach(e => e.classList.remove('dtvp-collapsed-content'));
    }
    refreshLibrary(); refreshDownloads(); refreshReleaseLayout(); refreshAutoplay();refreshPageInterface();
    let navigation = document.getElementById(navigationId);
    if (!onRelease()) {
      if (activeVideo) clearUndo(activeVideo);
      activeVideo = null; applyLayout();
      navigation?.remove();
      qualityRestore = undefined;
      pendingQuality = true;
      return;
    }
    const video = document.querySelector('main video, #main video');
    if (!video) {
      if (activeVideo) clearUndo(activeVideo);
      activeVideo = null; applyLayout();
      navigation?.remove();
      return;
    }
    if (activeVideo && activeVideo !== video) clearUndo(activeVideo);
    activeVideo = video;
    bindExtras(video); applyLayout(); compactSections();
    if (!options.undo) clearUndo(video);
    if (!boundVideos.has(video)) {
      boundVideos.add(video);
      pendingQuality = true;
      for (const name of ['loadstart', 'loadedmetadata', 'canplay']) {
        video.addEventListener(name, () => {
          pendingQuality = true;
          queueMicrotask(refresh);
        });
      }
      for (const name of ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'ratechange']) {
        // The site's speed click writes its cookie after setting playbackRate.
        video.addEventListener(name, () => queueMicrotask(() => restoreSpeed(video)));
      }
      restoreSpeed(video);
    }
    restoreQuality(video);
    const playButton = video.parentElement.querySelector(
      'button[aria-label="Воспроизвести"], button[aria-label="Пауза"], button[aria-label="Смотреть заново"]',
    );
    if (!playButton) return;
    let remaining = video.parentElement.querySelector('#dubtv-plus-remaining');
    if (!remaining) {
      remaining = document.createElement('span'); remaining.id = 'dubtv-plus-remaining';
      const clock = playButton.parentElement.querySelector('span.tabular-nums');
      (clock ?? playButton.parentElement).append(remaining);
    }
    remainingTime(video);
    if (!navigation && (nativeNavigation('Пред.') || nativeNavigation('След.'))) {
      navigation = addNavigation(playButton);
    }
    for (const button of navigation?.querySelectorAll('button') ?? []) {
      const target = nativeNavigation(button.dataset.nativeLabel);
      const disabled = !target || target.disabled;
      if (button.disabled !== disabled) {
        button.disabled = disabled;
        button.style.opacity = disabled ? '0.3' : '1';
      }
    }
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      refresh();
    });
  });
  observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'aria-label', 'aria-expanded']});
  window.addEventListener('popstate', refresh);
  refresh();
})();
