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
