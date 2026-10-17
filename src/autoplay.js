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
    const label = video.parentElement?.querySelector('button[aria-label^="Серии:"]')?.getAttribute('aria-label') || currentEpisodeLabel();
    return label ? `${location.pathname}:${label}` : null;
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
