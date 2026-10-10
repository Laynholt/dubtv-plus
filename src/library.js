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
