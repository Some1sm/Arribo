(function (global) {
  'use strict';
  global.TransitRequest = class {
    constructor() { this.generation = 0; this.controller = null; }
    cancel() { this.generation++; this.controller?.abort(); this.controller = null; }
    async json(url) {
      this.cancel();
      const generation = this.generation;
      this.controller = new AbortController();
      const timeout = setTimeout(() => this.controller?.abort(), 15000);
      try {
        const response = await fetch(url, { signal: this.controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (generation !== this.generation) throw new DOMException('Obsolete request', 'AbortError');
        return body;
      } finally { clearTimeout(timeout); }
    }
    dispose() { this.cancel(); }
  };
})(window);
