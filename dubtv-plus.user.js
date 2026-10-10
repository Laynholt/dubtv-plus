// ==UserScript==
// @name         DubTV+
// @namespace    dubtv-plus
// @version      1.0.0
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
function createLibraryTools(panel) {
  'use strict';
  const labels = {WATCHING:'Смотрю', PLANNED:'В планах', COMPLETED:'Просмотрено', ON_HOLD:'Отложено', DROPPED:'Брошено'};
  let hidden = {};
  let hideCompleted = false;
  try {
    const saved = JSON.parse(localStorage.getItem('dubtv-plus-hidden'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      hidden = Object.fromEntries(Object.entries(saved).filter(([slug,title]) => /^[a-z0-9-]+$/.test(slug) && typeof title === 'string'));
    }
    hideCompleted = localStorage.getItem('dubtv-plus-hide-completed') === 'true';
  } catch { /* Invalid preferences use defaults. */ }
  let statuses = new Map();
  let request;
  let attempted = false;
  let previousPath = location.pathname;
  let cards = [];
  let cardSignature = '';
  let hoverCard;
  let hoverTimer;
  const makeButton = (text, action) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.addEventListener('click', action); return b;
  };
  const style = document.createElement('style');
  style.textContent = '.dtvp-hidden-card{display:none!important}.dtvp-status{display:block;font:600 12px system-ui;color:#a8e5b7;padding:5px 0}.dtvp-library-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0}.dtvp-library-row span{min-width:0;overflow-wrap:anywhere}.dtvp-library-row button{flex-shrink:0}#dtvp-card-action{position:fixed;z-index:10002;background:#26262c;color:white;border:1px solid #aaa;border-radius:5px;padding:7px 10px;font:12px system-ui;cursor:pointer}#dtvp-card-action[hidden]{display:none!important}#dtvp-hide-choice{width:100%;min-width:0;max-width:100%}';
  document.head.append(style);
  const heading = document.createElement('h3'); heading.textContent = 'Каталог и скрытые тайтлы'; panel.append(heading);
  const completedLabel = document.createElement('label');
  const completedInput = document.createElement('input'); completedInput.type = 'checkbox'; completedInput.id = 'dtvp-hide-completed'; completedInput.checked = hideCompleted;
  completedLabel.append(completedInput,'Скрывать просмотренное в каталоге'); panel.append(completedLabel);
  const state = document.createElement('p'); state.id = 'dtvp-list-state'; state.setAttribute('role','status'); panel.append(state);
  const reload = makeButton('Обновить статусы', () => loadLists()); reload.id = 'dtvp-refresh-lists'; panel.append(reload);
  const chooserLabel = document.createElement('label'); chooserLabel.className = 'dtvp-field'; chooserLabel.textContent = 'Не интересно — тайтл на этой странице';
  const chooser = document.createElement('select'); chooser.id = 'dtvp-hide-choice'; chooserLabel.append(chooser); panel.append(chooserLabel);
  const hideButton = makeButton('Скрыть выбранный тайтл', () => {
    const card = cards.find(c => c.slug === chooser.value); if (card) hide(card.slug,card.title);
  }); hideButton.id = 'dtvp-hide-title'; panel.append(hideButton);
  const hiddenList = document.createElement('div'); panel.append(hiddenList);
  const action = makeButton('Не интересно', () => { if (hoverCard) hide(hoverCard.slug,hoverCard.title); });
  action.id = 'dtvp-card-action'; action.hidden = true; document.body.append(action);
  function persist() {
    try { localStorage.setItem('dubtv-plus-hidden',JSON.stringify(hidden)); localStorage.setItem('dubtv-plus-hide-completed',String(hideCompleted)); } catch { /* Session-only preferences. */ }
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
  function hide(slug,title) { hidden[slug] = title; persist(); showHidden(); action.hidden = true; refresh(); }
  function supported() { return ['/', '/catalog', '/ongoing'].includes(location.pathname) || location.pathname.startsWith('/release/'); }
  function eligibleLinks() {
    if (!supported()) return [];
    let scope = document.querySelector('main, #main');
    if (location.pathname.startsWith('/release/')) {
      const related = Array.from(scope?.querySelectorAll('h2') ?? []).find(h => h.childNodes[0]?.textContent.trim() === 'Похожее');
      scope = related?.closest('section');
    }
    return Array.from(scope?.querySelectorAll('a[href^="/release/"]') ?? []).filter(a => a.querySelector('img,h3') && !a.querySelector('button'));
  }
  // The server-rendered profile already contains native lists. Parse JSON only; never execute downloaded scripts.
  function parseLists(html) {
    const doc = new DOMParser().parseFromString(html,'text/html');
    let stream = '';
    for (const script of doc.scripts) {
      const match = script.textContent.match(/^self\.__next_f\.push\((\[.*\])\)\s*;?$/s);
      if (!match) continue;
      try { const part = JSON.parse(match[1]); if (part[0] === 1 && typeof part[1] === 'string') stream += part[1]; } catch { /* Other stream records are not profile data. */ }
    }
    for (const line of stream.split('\n')) {
      const colon = line.indexOf(':'); if (colon < 0) continue;
      let root; try { root = JSON.parse(line.slice(colon+1)); } catch { continue; }
      const stack = [root];
      while (stack.length) {
        const item = stack.pop(); if (!item || typeof item !== 'object') continue;
        if (item.user?.id && item.lists && Object.keys(labels).every(key => Array.isArray(item.lists[key]))) {
          const result = new Map();
          for (const key of Object.keys(labels)) for (const entry of item.lists[key]) {
            if (!entry || typeof entry.slug !== 'string' || !/^[a-z0-9-]+$/.test(entry.slug)) throw new Error('Unexpected list item');
            result.set(entry.slug,key);
          }
          return result;
        }
        stack.push(...Object.values(item));
      }
    }
    throw new Error('Profile data not found');
  }
  async function loadLists() {
    if (request) return;
    attempted = true; statuses = new Map();
    state.textContent = 'Загружаю статусы из профиля…'; reload.disabled = true;
    const controller = new AbortController(); request = controller;
    const timeout = setTimeout(() => controller.abort(),10000);
    refresh();
    try {
      const response = await fetch('/profile',{method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('Profile unavailable');
      const result = parseLists(await response.text());
      if (request !== controller) return;
      statuses = result; state.textContent = `Статусы обновлены · в списках ${statuses.size}`;
    } catch {
      if (request === controller) { statuses = new Map(); state.textContent = 'Не удалось прочитать списки. Проверьте вход в DubTV и нажмите «Обновить статусы».'; }
    } finally {
      clearTimeout(timeout);
      if (request === controller) { request = undefined; reload.disabled = false; refresh(); }
    }
  }
  function refresh() {
    if (previousPath !== location.pathname) {
      previousPath = location.pathname; statuses = new Map(); attempted = false;
      request?.abort(); request = undefined; reload.disabled = false; action.hidden = true;
    }
    for (const element of document.querySelectorAll('.dtvp-hidden-card,.dtvp-status')) {
      if (!supported() || location.pathname.startsWith('/release/') && !eligibleLinks().some(a=>a===element||a.contains(element))) {
        if (element.classList.contains('dtvp-status')) element.remove(); else element.classList.remove('dtvp-hidden-card');
      }
    }
    cards = eligibleLinks().map(link => ({link,slug:link.getAttribute('href').split('/')[2]?.split(/[?#]/)[0],title:link.querySelector('h3')?.textContent.trim() || link.querySelector('img')?.alt || ''})).filter(c=>/^[a-z0-9-]+$/.test(c.slug));
    for (const card of cards) {
      const status = location.pathname === '/catalog' ? statuses.get(card.slug) : undefined;
      card.link.classList.toggle('dtvp-hidden-card',Object.hasOwn(hidden,card.slug) || hideCompleted && status === 'COMPLETED');
      let badge = card.link.querySelector('.dtvp-status');
      if (status) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'dtvp-status'; card.link.append(badge); }
        if (badge.textContent !== labels[status]) badge.textContent = labels[status];
      } else badge?.remove();
    }
    const choices = [...new Map(cards.filter(c=>!Object.hasOwn(hidden,c.slug)).map(c=>[c.slug,c])).values()];
    const signature = JSON.stringify(choices.map(c=>[c.slug,c.title]));
    if (signature !== cardSignature) {
      cardSignature = signature; const selected = chooser.value; chooser.replaceChildren();
      for (const card of choices) chooser.add(new Option(card.title,card.slug));
      if (choices.some(c=>c.slug===selected)) chooser.value = selected;
      hideButton.disabled = choices.length === 0;
    }
    if (location.pathname === '/catalog' && !attempted) loadLists();
    else if (!attempted && !request) { const text = 'Статусы загружаются при открытии каталога.'; if (state.textContent!==text) state.textContent=text; }
  }
  function reveal(event) {
    const link = event.target.closest?.('a[href^="/release/"]');
    const card = cards.find(c=>c.link===link);
    if (!card || card.link.classList.contains('dtvp-hidden-card')) return;
    clearTimeout(hoverTimer); hoverCard = card;
    const rect = card.link.getBoundingClientRect();
    action.textContent = 'Не интересно'; action.setAttribute('aria-label',`Не интересно: ${card.title}`);
    action.style.top = `${Math.max(4,rect.top+6)}px`; action.style.left = `${Math.max(4,Math.min(innerWidth-130,rect.right-125))}px`; action.hidden = false;
  }
  document.addEventListener('pointerover',reveal); document.addEventListener('focusin',reveal);
  document.addEventListener('pointerout',event=>{
    if (event.relatedTarget===action || hoverCard?.link.contains(event.relatedTarget)) return;
    hoverTimer=setTimeout(()=>{action.hidden=true;},250);
  });
  action.addEventListener('pointerenter',()=>clearTimeout(hoverTimer));
  window.addEventListener('scroll',()=>{action.hidden=true;},true);
  showHidden(); refresh(); return refresh;
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
    #dubtv-plus-open{position:fixed;right:16px;bottom:80px;z-index:10001;display:flex;align-items:center;gap:8px;background:#252529;color:#fff;border:1px solid #777;border-radius:10px;padding:8px 12px;font:600 13px system-ui;cursor:grab;touch-action:none;user-select:none}
    #dubtv-plus-open:active{cursor:grabbing}#dubtv-plus-open img{width:28px;height:28px;pointer-events:none}
    .dtvp-dialog{position:fixed;inset:0;margin:auto;color:#eee;background:#18181c;border:1px solid #45454e;border-radius:16px;padding:24px;width:min(560px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:85dvh;overflow:auto;font:14px/1.5 system-ui;box-sizing:border-box;box-shadow:0 20px 80px #0008;color-scheme:dark;text-align:left}
    .dtvp-dialog *{box-sizing:border-box}.dtvp-dialog::backdrop{background:#0009}.dtvp-dialog h2{font:700 22px/1.3 system-ui;margin:0}.dtvp-dialog h3{font:600 15px/1.4 system-ui;margin:20px 0 12px}
    .dtvp-dialog label{display:flex;align-items:center;gap:12px;margin:14px 0;min-width:0}.dtvp-dialog .dtvp-field{display:flex;flex-direction:column;align-items:stretch;gap:8px}
    .dtvp-dialog button,.dtvp-dialog select,.dtvp-dialog input:not([type=checkbox]){background:#2a2a31;color:#eee;border:1px solid #51515e;border-radius:8px;padding:9px 12px;font:inherit;min-width:0;max-width:100%}
    .dtvp-dialog select,.dtvp-dialog input:not([type=checkbox]){width:100%}.dtvp-dialog input[type=checkbox]{appearance:auto;width:18px;height:18px;flex:0 0 18px;margin:0;accent-color:#eb512c}.dtvp-dialog button{cursor:pointer;white-space:normal}.dtvp-dialog button:disabled{opacity:.5;cursor:default}
    .dtvp-dialog :focus-visible,#dubtv-plus-open:focus-visible,.dtvp-expand:focus-visible{outline:2px solid #ff886a;outline-offset:3px}
    .dtvp-dialog p{color:#b9b9c4;margin:12px 0;overflow-wrap:anywhere}.dtvp-dialog a{color:#ff997e;text-decoration:underline}.dtvp-dialog [hidden]{display:none!important}
    .dtvp-heading,.dtvp-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.dtvp-heading{margin-bottom:20px}.dtvp-heading h2{display:flex;align-items:center;gap:10px}.dtvp-heading img{width:40px;height:40px}
    .dtvp-actions{justify-content:flex-end;margin-top:20px;flex-wrap:wrap}.dtvp-dialog .dtvp-primary{background:#ca3c1c;border-color:#ed5937;color:white}
    .dtvp-tabs{display:flex;gap:6px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid #35353e}.dtvp-dialog [role=tab]{flex:1;padding:8px;font-size:13px}.dtvp-dialog [aria-selected=true]{background:#562a22;border-color:#eb6949;color:#ffb39e}
    .dtvp-shortcuts{display:grid;grid-template-columns:max-content 1fr;gap:10px 16px}.dtvp-shortcuts dt{font-weight:600;color:#ffb39e}.dtvp-shortcuts dd{margin:0}
    @media(max-width:420px){.dtvp-dialog{padding:18px}.dtvp-dialog [role=tab]{flex-basis:40%}.dtvp-heading{align-items:flex-start}}
    #dubtv-plus-remaining{display:block;font:11px system-ui;color:white;white-space:nowrap;padding:0}
    #dubtv-plus-remaining[hidden]{display:none!important}
    #dubtv-plus-undo{position:absolute;bottom:95px;left:16px;z-index:35;padding:9px 12px;background:#222e;color:#fff;border:1px solid #999;border-radius:6px;font:14px system-ui;cursor:pointer}
    #dubtv-plus-undo[hidden]{display:none!important}
    .dtvp-collapsed-content{display:none!important}.dtvp-expand{font:12px system-ui;color:inherit;background:transparent;border:1px solid #777;border-radius:4px;padding:4px 8px;margin-left:10px;cursor:pointer}
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
  settings.innerHTML = '<div class="dtvp-heading"><h2><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KICA8cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTgxODFjIi8+CiAgPGcgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI5MDAiIGZvbnQtc2l6ZT0iMzkiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgPGcgZmlsbD0iI2I4M2IyYiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMiAzKSI+PHRleHQgeD0iNjQiIHk9IjU2Ij5EVUI8L3RleHQ+PHRleHQgeD0iNDgiIHk9Ijk2Ij5UVjwvdGV4dD48L2c+CiAgICA8ZyBmaWxsPSIjZjRmMmVlIj48dGV4dCB4PSI2NCIgeT0iNTYiPkRVQjwvdGV4dD48dGV4dCB4PSI0OCIgeT0iOTYiPlRWPC90ZXh0PjwvZz4KICA8L2c+CiAgPHBhdGggZD0iTTk2IDcwdjI2bS0xMy0xM2gyNiIgc3Ryb2tlPSIjZmY2ODQyIiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K" alt="">DubTV+</h2></div><div class="dtvp-tabs" role="tablist" aria-label="Разделы настроек"></div>';
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
  panels.about.innerHTML = '<h3>DubTV+ · 1.0.0</h3><p>Автор: <a href="https://github.com/Laynholt" target="_blank" rel="noopener noreferrer">laynholt</a></p><p>Неофициальные улучшения DubTV для Violentmonkey.</p><p><a href="https://github.com/Laynholt/dubtv-plus" target="_blank" rel="noopener noreferrer">Исходный код</a> · <a href="https://github.com/Laynholt/dubtv-plus/releases" target="_blank" rel="noopener noreferrer">Релизы</a></p><p>Обновления из релизов проверяет Violentmonkey. Настройки и скрытые тайтлы сохраняются в этом браузере.</p>';
  document.body.append(settings);
  const refreshLibrary = typeof createLibraryTools === 'function' ? createLibraryTools(panels.library) : () => {};
  let dragged = false;
  const openSettings = button('', event => {
    if (dragged && event.detail !== 0) { dragged = false; return; }
    settings.showModal();
  });
  openSettings.innerHTML = '<img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij4KICA8cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTgxODFjIi8+CiAgPGcgZm9udC1mYW1pbHk9IkFyaWFsLHNhbnMtc2VyaWYiIGZvbnQtd2VpZ2h0PSI5MDAiIGZvbnQtc2l6ZT0iMzkiIHRleHQtYW5jaG9yPSJtaWRkbGUiPgogICAgPGcgZmlsbD0iI2I4M2IyYiIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMiAzKSI+PHRleHQgeD0iNjQiIHk9IjU2Ij5EVUI8L3RleHQ+PHRleHQgeD0iNDgiIHk9Ijk2Ij5UVjwvdGV4dD48L2c+CiAgICA8ZyBmaWxsPSIjZjRmMmVlIj48dGV4dCB4PSI2NCIgeT0iNTYiPkRVQjwvdGV4dD48dGV4dCB4PSI0OCIgeT0iOTYiPlRWPC90ZXh0PjwvZz4KICA8L2c+CiAgPHBhdGggZD0iTTk2IDcwdjI2bS0xMy0xM2gyNiIgc3Ryb2tlPSIjZmY2ODQyIiBzdHJva2Utd2lkdGg9IjgiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K" alt="" draggable="false"><span>DubTV+</span>';
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
    if (!onRelease() || !control || control.getAttribute('aria-label') !== 'Режим кинотеатра') return;
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
    for (const [label, title, symbol] of [
      ['Пред.', 'Предыдущая серия', '⏮'],
      ['След.', 'Следующая серия', '⏭'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.dataset.nativeLabel = label;
      button.className = playButton.className;
      button.style.cssText = 'width:36px;height:40px;flex-shrink:0;font-size:21px;line-height:1';
      button.textContent = symbol;
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

  function refresh() {
    if (route !== location.pathname) {
      route = location.pathname; theatre = false;
      if (activeVideo) clearUndo(activeVideo);
      activeVideo = null; settings.close(); jump.close();
      document.querySelectorAll('.dtvp-collapsed-content').forEach(e => e.classList.remove('dtvp-collapsed-content'));
    }
    refreshLibrary();
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
