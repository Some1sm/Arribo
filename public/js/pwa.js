(function (global) {
  'use strict';
  let initialized = false;
  let accepted = false;
  let reloaded = false;
  function init() {
    if (initialized) return;
    initialized = true;
    const banner = document.createElement('div');
    banner.className = 'connection-banner';
    banner.setAttribute('role', 'status');
    banner.hidden = true;
    document.body.appendChild(banner);
    const update = document.createElement('button');
    update.type = 'button';
    update.className = 'update-banner';
    update.textContent = 'Nova versió disponible · Actualitzar';
    update.hidden = true;
    update.addEventListener('click', applyUpdate);
    document.body.appendChild(update);
    const state = () => {
      const offline = global.navigator.onLine === false;
      document.documentElement.classList.toggle('is-offline', offline);
      banner.hidden = !offline;
      banner.textContent = 'Sense connexió · Les arribades no estan actualitzades. Els trajectes desats continuen disponibles.';
      const planner = global.planApp;
      if (offline) planner?.stopPolling();
      else if (planner?.lastSearchUrl) { planner.refreshLiveDepartures(); planner.startPolling(); }
    };
    global.addEventListener('online', state);
    global.addEventListener('offline', state);
    state();
    if (!('serviceWorker' in global.navigator)) return;
    const register = async () => {
      try {
        const registration = await global.navigator.serviceWorker.register('/sw.js');
        const inspect = () => { update.hidden = !registration.waiting; };
        inspect();
        registration.addEventListener('updatefound', () => {
          registration.installing?.addEventListener('statechange', inspect);
        });
        global.navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!accepted || reloaded) return;
          reloaded = true;
          global.location.reload();
        });
      } catch { /* The regular online app remains usable without a worker. */ }
    };
    if (document.readyState === 'complete') register();
    else global.addEventListener('load', register, { once: true });
  }
  async function applyUpdate() {
    const registration = await global.navigator.serviceWorker?.getRegistration();
    if (!registration?.waiting) return;
    accepted = true;
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  }
  global.TransitPwa = Object.freeze({ init, applyUpdate });
})(window);
