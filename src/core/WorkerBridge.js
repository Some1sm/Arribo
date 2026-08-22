const { EventEmitter } = require('events');
const { fork } = require('child_process');
const path = require('path');
const flightRecorder = require('../flightRecorder');
const reportCacheService = require('../reportCacheService');
const ambTracker = require('../ambTracker');

class WorkerBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.workerPath = options.workerPath || path.join(__dirname, '..', 'workers', 'ingestionWorker.js');
    this.pingIntervalMs = options.pingIntervalMs || 15000;  // 15s ping
    this.pingTimeoutMs = options.pingTimeoutMs || 30000;    // 30s timeout
    this.baseBackoffMs = options.baseBackoffMs || 1000;     // 1s base
    this.maxBackoffMs = options.maxBackoffMs || 15000;       // 15s max backoff
    this.mode = options.mode || 'fork';

    this.worker = null;
    this._isHealthy = false;
    this.isShuttingDown = false;
    this._restarts = 0;
    this.consecutiveRestarts = 0;
    this._lastHeartbeat = null;
    this.lastHeartbeatAck = null;
    this.workerPid = null;
    this.startedAt = null;
    this.workerMetrics = null;

    this.pingTimer = null;
    this.watchdogTimer = null;
    this.restartTimer = null;
    this.stabilityTimer = null;
  }

  get isHealthy() {
    return this._isHealthy;
  }

  get pid() {
    return this.workerPid || (this.worker ? this.worker.pid : null);
  }

  get restarts() {
    return this._restarts;
  }

  get lastHeartbeat() {
    return this._lastHeartbeat;
  }

  start() {
    if (this.worker || this.isShuttingDown) return;
    this.isShuttingDown = false;
    console.log('[WorkerBridge] Starting Ingestion Worker Supervisor...');
    this.spawnWorker();
    this.startHeartbeat();
  }

  spawnWorker() {
    if (this.worker || this.isShuttingDown) return;

    try {
      this.worker = fork(this.workerPath, [], {
        stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
        env: {
          ...process.env,
          WORKER_MODE: 'true'
        }
      });

      this.workerPid = this.worker.pid;
      this.startedAt = Date.now();
      this.lastHeartbeatAck = Date.now();
      console.log(`[WorkerBridge] 🚀 Spawned ingestion worker process (PID: ${this.workerPid})`);

      this.worker.on('message', (msg) => this.handleWorkerMessage(msg));
      this.worker.on('exit', (code, signal) => this.handleWorkerExit(code, signal));
      this.worker.on('error', (err) => this.handleWorkerError(err));

      // After 30 seconds of stable operation, reset consecutive restart counter
      if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
      this.stabilityTimer = setTimeout(() => {
        if (this._isHealthy && this.worker) {
          this.consecutiveRestarts = 0;
        }
      }, 30000);
      if (this.stabilityTimer && typeof this.stabilityTimer.unref === 'function') {
        this.stabilityTimer.unref();
      }
    } catch (err) {
      console.error('[WorkerBridge] Failed to spawn worker process:', err.message);
      this.scheduleRestart('Spawn error');
    }
  }

  handleWorkerMessage(message) {
    if (!message || typeof message !== 'object') return;
    const { type, payload } = message;

    switch (type) {
      case 'WORKER_READY':
        this._isHealthy = true;
        this._lastHeartbeat = Date.now();
        this.lastHeartbeatAck = Date.now();
        this.workerPid = payload?.pid || this.worker?.pid || this.workerPid;
        console.log(`[WorkerBridge] ✅ Worker confirmed READY (PID: ${this.workerPid})`);
        this.emit('ready', payload);
        break;

      case 'FLEET_UPDATE':
        if (payload && Array.isArray(payload.vehicles)) {
          flightRecorder.syncFleetFromWorker(payload.vehicles);
          this.emit('fleet_update', payload);
        }
        break;

      case 'REPORT_CACHE_UPDATE':
        if (payload && payload.timeframeHours && payload.report) {
          reportCacheService.updateMemoryCache(payload.timeframeHours, payload.report);
          this.emit('report_update', payload);
        }
        break;

      case 'DISRUPTIONS_UPDATE':
        if (payload && Array.isArray(payload.disruptions)) {
          if (ambTracker && ambTracker.disruptionsCache) {
            ambTracker.disruptionsCache = {
              timestamp: payload.timestamp || Date.now(),
              data: payload.disruptions
            };
          }
          this.emit('disruptions_update', payload);
        }
        break;

      case 'PONG':
        this._lastHeartbeat = Date.now();
        this.lastHeartbeatAck = Date.now();
        this._isHealthy = true;
        this.workerMetrics = payload || null;
        this.emit('pong', payload);
        break;

      case 'STATUS':
        this.workerMetrics = payload || null;
        this.emit('status', payload);
        break;

      default:
        this.emit('message', message);
        break;
    }
  }

  handleWorkerExit(code, signal) {
    const exitedPid = this.workerPid;
    this._isHealthy = false;
    this.worker = null;
    this.workerPid = null;

    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }

    if (this.isShuttingDown) {
      console.log(`[WorkerBridge] Worker (PID: ${exitedPid}) exited cleanly during shutdown (code: ${code}, signal: ${signal}).`);
      this.emit('stopped', { code, signal });
      return;
    }

    console.warn(`[WorkerBridge] ⚠️ Worker process (PID: ${exitedPid}) exited unexpectedly (code: ${code}, signal: ${signal}).`);
    this._restarts++;
    this.consecutiveRestarts++;
    this.scheduleRestart(`Worker exit (${code}/${signal})`);
  }

  handleWorkerError(err) {
    console.error('[WorkerBridge] Worker process error:', err.message);
    this.emit('error', err);
  }

  scheduleRestart(reason) {
    if (this.isShuttingDown || this.restartTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, up to 15s
    const backoffExponent = Math.max(0, this.consecutiveRestarts - 1);
    const delay = Math.min(this.baseBackoffMs * Math.pow(2, backoffExponent), this.maxBackoffMs);

    console.log(`[WorkerBridge] 🔄 Auto-restarting worker in ${delay}ms (attempt #${this._restarts}, reason: ${reason})...`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isShuttingDown) {
        this.spawnWorker();
      }
    }, delay);

    if (this.restartTimer && typeof this.restartTimer.unref === 'function') {
      this.restartTimer.unref();
    }

    this.emit('restart', { delay, restarts: this._restarts, consecutive: this.consecutiveRestarts, reason });
  }

  startHeartbeat() {
    this.stopHeartbeat();

    // 1. Send periodic PING
    this.pingTimer = setInterval(() => {
      if (this.worker && !this.isShuttingDown) {
        this.send('PING', { timestamp: Date.now() });
      }
    }, this.pingIntervalMs);

    if (this.pingTimer && typeof this.pingTimer.unref === 'function') {
      this.pingTimer.unref();
    }

    // 2. Watchdog to detect hung/frozen worker
    this.watchdogTimer = setInterval(() => {
      if (!this.worker || this.isShuttingDown) return;

      const timeSinceLastAck = Date.now() - (this.lastHeartbeatAck || this.startedAt || Date.now());
      if (timeSinceLastAck > this.pingTimeoutMs) {
        console.warn(`[WorkerBridge] ⚠️ Worker heartbeat timed out (${Math.round(timeSinceLastAck / 1000)}s without PONG). Restarting hung worker...`);
        this._isHealthy = false;
        this.restartWorker('Heartbeat timeout');
      }
    }, 5000);

    if (this.watchdogTimer && typeof this.watchdogTimer.unref === 'function') {
      this.watchdogTimer.unref();
    }
  }

  stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  restartWorker(reason = 'Manual restart') {
    if (this.worker) {
      const targetWorker = this.worker;
      // Attempt a graceful SHUTDOWN first so the worker can flush its SQLite WAL
      // checkpoint and close the DB cleanly. Escalate to SIGKILL if it hangs.
      try {
        this.send('SHUTDOWN');
      } catch (e) {}
      const killTimer = setTimeout(() => {
        try {
          targetWorker.kill('SIGKILL');
        } catch (e) {}
      }, 2000);
      if (killTimer && typeof killTimer.unref === 'function') killTimer.unref();
      targetWorker.once('exit', () => clearTimeout(killTimer));
    }
    this._isHealthy = false;
    this.worker = null;
    this.workerPid = null;
    this.scheduleRestart(reason);
  }

  send(type, payload = {}) {
    if (!this.worker) return false;
    try {
      if (typeof this.worker.send === 'function') {
        this.worker.send({ type, payload, timestamp: Date.now() });
        return true;
      }
    } catch (err) {
      console.error('[WorkerBridge] Error sending IPC message to worker:', err.message);
    }
    return false;
  }

  triggerReport(hours = 24) {
    return this.send('TRIGGER_REPORT', { hours });
  }

  async shutdown(timeoutMs = 5000) {
    if (this.isShuttingDown) return true;
    this.isShuttingDown = true;
    this._isHealthy = false;
    this.stopHeartbeat();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }

    if (!this.worker) return true;

    console.log('[WorkerBridge] Initiating graceful shutdown of ingestion worker...');

    return new Promise((resolve) => {
      let resolved = false;
      const targetWorker = this.worker;

      const finish = () => {
        if (resolved) return;
        resolved = true;
        this.worker = null;
        this.workerPid = null;
        resolve(true);
      };

      const forceKillTimer = setTimeout(() => {
        if (!resolved && targetWorker) {
          console.warn('[WorkerBridge] Worker did not exit gracefully within timeout. Sending SIGKILL...');
          try {
            targetWorker.kill('SIGKILL');
          } catch (e) {}
          finish();
        }
      }, timeoutMs);

      if (forceKillTimer && typeof forceKillTimer.unref === 'function') {
        forceKillTimer.unref();
      }

      targetWorker.once('exit', () => {
        clearTimeout(forceKillTimer);
        finish();
      });

      // Send SHUTDOWN message
      try {
        this.send('SHUTDOWN');
      } catch (err) {
        try {
          targetWorker.kill('SIGTERM');
        } catch (e) {}
      }
    });
  }

  getStatus() {
    return {
      isHealthy: this._isHealthy,
      pid: this.pid,
      isRunning: !!this.worker,
      restarts: this._restarts,
      consecutiveRestarts: this.consecutiveRestarts,
      lastHeartbeat: this._lastHeartbeat,
      lastHeartbeatAck: this.lastHeartbeatAck,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      mode: this.mode,
      metrics: this.workerMetrics
    };
  }
}

module.exports = new WorkerBridge();
module.exports.WorkerBridge = WorkerBridge;
