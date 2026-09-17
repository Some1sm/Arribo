(function (global) {
  'use strict';
  global.JourneyControls = class {
    constructor(app) {
      this.app = app;
      this.root = document.getElementById('journey-library');
      this.click = event => this.handle(event);
      this.root?.addEventListener('click', this.click);
      this.render();
    }
    endpoint(id) {
      const el = document.getElementById(id);
      return { query: el.value.trim(), name: el.value.trim(), ...el.dataset };
    }
    walkingSettings() {
      return { walkingSpeed: Number(document.getElementById('plan-walking-speed')?.value) || 80,
        maxWalkingDistance: Number(document.getElementById('plan-max-walk')?.value) || 2000 };
    }
    record() {
      global.TransitJourneys.addRecent(this.endpoint('page-planner-origin'), this.endpoint('page-planner-dest'), this.app.selectedPreference, this.walkingSettings());
      this.render();
    }
    render() {
      if (!this.root) return;
      const esc = global.TransitUtils.esc;
      const rows = (list, saved) => list.map(item => `<div class="journey-row"><button type="button" data-journey="${esc(item.id)}" data-saved="${saved}">${esc(item.label || `${item.from.name} → ${item.to.name}`)}</button>${saved ? `<button type="button" data-rename="${esc(item.id)}" aria-label="Canviar el nom">✎</button><button type="button" data-remove="${esc(item.id)}" aria-label="Eliminar trajecte">×</button>` : ''}</div>`).join('');
      this.root.innerHTML = `<h3>Els teus trajectes</h3><p>Desats només en aquest dispositiu; poden contenir ubicacions personals.</p><button type="button" data-save>Desar trajecte actual</button><label><input type="checkbox" id="journey-keep-time"> Conservar data i hora</label><button type="button" data-clear>Esborrar tot</button><h4>Desats</h4>${rows(global.TransitJourneys.listSaved(), true)}<h4>Recents</h4>${rows(global.TransitJourneys.listRecent(), false)}`;
    }
    handle(event) {
      const button = event.target.closest('button');
      if (!button) return;
      const journeys = global.TransitJourneys;
      if (button.hasAttribute('data-save')) {
        const from = this.endpoint('page-planner-origin'), to = this.endpoint('page-planner-dest');
        if (!from.query || !to.query) return;
        const keep = document.getElementById('journey-keep-time')?.checked;
        journeys.save(from, to, null, { ...this.walkingSettings(), preference: this.app.selectedPreference, departureDate: keep ? document.getElementById('plan-date-val')?.value : null, departureTime: keep ? document.getElementById('plan-time-val')?.value : null });
      } else if (button.hasAttribute('data-clear')) {
        if (!global.confirm('Esborrar tots els trajectes desats i recents?')) return;
        journeys.clearAll();
      } else if (button.dataset.remove) journeys.remove(button.dataset.remove);
      else if (button.dataset.rename) journeys.rename(button.dataset.rename, global.prompt('Nom del trajecte:'));
      else if (button.dataset.journey) {
        const list = button.dataset.saved === 'true' ? journeys.listSaved() : journeys.listRecent();
        const item = list.find(entry => entry.id === button.dataset.journey);
        if (!item) return;
        for (const [id, endpoint] of [['page-planner-origin', item.from], ['page-planner-dest', item.to]]) {
          const el = document.getElementById(id);
          for (const key of Object.keys(el.dataset)) delete el.dataset[key];
          el.value = endpoint.name || endpoint.query;
          for (const key of ['stopId', 'lat', 'lon']) if (endpoint[key] != null) el.dataset[key] = endpoint[key];
        }
        document.getElementById('plan-walking-speed').value = item.walkingSpeed || 80;
        document.getElementById('plan-max-walk').value = item.maxWalkingDistance || 2000;
        this.app.selectedPreference = item.preference || 'fastest';
        document.querySelectorAll('[data-pref]').forEach(el => el.classList.toggle('active', el.dataset.pref === this.app.selectedPreference));
        document.getElementById(item.departureDate || item.departureTime ? 'btn-time-future' : 'btn-time-now')?.click();
        if (item.departureDate) document.getElementById('plan-date-val').value = item.departureDate;
        if (item.departureTime) document.getElementById('plan-time-val').value = item.departureTime;
        this.app.runSearch();
      }
      this.render();
    }
    dispose() { this.root?.removeEventListener('click', this.click); }
  };
})(window);
