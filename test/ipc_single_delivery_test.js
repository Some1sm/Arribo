const assert = require('assert');

// Focused regression: emitIpc must deliver each event exactly once.
// Callback wins when present; process.send is the fallback when no callback
// is installed (e.g. running ingestionDaemon standalone or in tests).

function makeSendSink() {
  const sent = [];
  const originalSend = process.send;
  process.send = (msg) => { sent.push(msg); };
  return {
    sent,
    restore() {
      if (originalSend === undefined) delete process.send;
      else process.send = originalSend;
    }
  };
}

async function run() {
  const ingestionDaemon = require('../src/ingestionDaemon');
  const reportCacheService = require('../src/reportCacheService');

  // 1. Daemon: callback present -> exactly one delivery, no direct process.send
  {
    const sink = makeSendSink();
    const deliveries = [];
    ingestionDaemon.setIpcCallback((type, payload) => deliveries.push({ type, payload }));
    ingestionDaemon.emitIpc('FLEET_UPDATE', { vehicles: [] });
    assert.strictEqual(deliveries.length, 1, 'daemon callback must receive exactly one delivery');
    assert.strictEqual(deliveries[0].type, 'FLEET_UPDATE');
    assert.strictEqual(sink.sent.length, 0, 'daemon must not double-send via process.send when callback installed');
    ingestionDaemon.setIpcCallback(null);
    sink.restore();
  }

  // 2. Daemon: no callback -> falls back to process.send
  {
    const sink = makeSendSink();
    ingestionDaemon.emitIpc('FLEET_UPDATE', { vehicles: [1] });
    assert.strictEqual(sink.sent.length, 1, 'daemon must deliver once via process.send fallback');
    assert.strictEqual(sink.sent[0].type, 'FLEET_UPDATE');
    sink.restore();
  }

  // 3. Daemon: throwing callback -> falls back to process.send (transport failure resilience)
  {
    const sink = makeSendSink();
    ingestionDaemon.setIpcCallback(() => { throw new Error('callback boom'); });
    ingestionDaemon.emitIpc('DISRUPTIONS_UPDATE', { disruptions: [] });
    assert.strictEqual(sink.sent.length, 1, 'daemon must fall back to process.send when callback throws');
    ingestionDaemon.setIpcCallback(null);
    sink.restore();
  }

  // 4. Report cache: callback present -> exactly one delivery
  {
    const sink = makeSendSink();
    const deliveries = [];
    const original = reportCacheService.ipcCallback;
    reportCacheService.setIpcCallback((type, payload) => deliveries.push({ type, payload }));
    reportCacheService.emitIpc('REPORT_CACHE_UPDATE', { timeframeHours: 24, report: {} });
    assert.strictEqual(deliveries.length, 1, 'report cache callback must receive exactly one delivery');
    assert.strictEqual(sink.sent.length, 0, 'report cache must not double-send via process.send when callback installed');
    reportCacheService.setIpcCallback(original);
    sink.restore();
  }

  // 5. Report cache: throwing callback -> falls back to process.send
  {
    const sink = makeSendSink();
    reportCacheService.setIpcCallback(() => { throw new Error('callback boom'); });
    reportCacheService.emitIpc('REPORT_CACHE_UPDATE', { timeframeHours: 24, report: {} });
    assert.strictEqual(sink.sent.length, 1, 'report cache must fall back to process.send when callback throws');
    reportCacheService.setIpcCallback(null);
    sink.restore();
  }

  console.log('🎉 ALL SINGLE-IPC-DELIVERY TESTS PASSED! 🎉');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
