package main

// Port of src/core/WorkerBridge.js: the server's side of the worker. Its
// state belongs to the server World and is touched holding that lock;
// historyQuery is called with it released (it blocks until the answer).
//
// Node can SIGKILL a hung child two seconds after asking it to shut down.
// A goroutine cannot be killed, so here a hung worker is replaced only once
// it gets round to the SHUTDOWN message.

import (
	"errors"
	"log"
	"math"
	"os"
	"sync"
	"time"
)

type dbResult struct {
	val any
	err error
}

type WorkerBridge struct {
	s       *World
	reports *ReportCache // the server's

	// mu guards worker, pending and nextID (historyQuery runs unlocked).
	mu      sync.Mutex
	worker  *Worker
	pending map[float64]chan dbResult
	nextID  float64

	pingInterval time.Duration
	pingTimeout  float64

	isHealthy           bool
	isShuttingDown      bool
	receivedReady       bool
	pendingReplacement  bool
	restarts            float64
	consecutiveRestarts float64
	lastHeartbeat       any
	lastHeartbeatAck    any
	workerPid           any
	startedAt           float64
	workerMetrics       any // *Obj or nil
	restartTimer        *time.Timer
	stabilityTimer      *time.Timer
	heartbeatStop       chan struct{}

	fleetListeners []func(*Obj)
	outbox         *msgQueue[serverMsg]
}

func newWorkerBridge(s *World, reports *ReportCache) *WorkerBridge {
	b := &WorkerBridge{
		s:             s,
		reports:       reports,
		pending:       map[float64]chan dbResult{},
		pingInterval:  15 * time.Second,
		pingTimeout:   60000,
		lastHeartbeat: nil,
		workerPid:     nil,
		workerMetrics: nil,
		outbox:        newMsgQueue[serverMsg](),
	}
	b.lastHeartbeatAck = nil
	go b.consume()
	return b
}

func (b *WorkerBridge) onFleetUpdate(fn func(*Obj)) { b.fleetListeners = append(b.fleetListeners, fn) }

// start is called holding the server lock.
func (b *WorkerBridge) start() {
	b.mu.Lock()
	running := b.worker != nil
	b.mu.Unlock()
	if running || b.isShuttingDown {
		return
	}
	log.Printf("[WorkerBridge] Starting Ingestion Worker Supervisor...")
	b.spawnWorker()
	b.startHeartbeat()
}

func (b *WorkerBridge) spawnWorker() {
	b.mu.Lock()
	if b.worker != nil || b.isShuttingDown {
		b.mu.Unlock()
		return
	}
	b.mu.Unlock()
	b.receivedReady = false
	k := newWorker(func(m serverMsg) { b.outbox.push(m) })
	b.mu.Lock()
	b.worker = k
	b.mu.Unlock()
	now := float64(nowMs())
	b.workerPid = float64(os.Getpid())
	b.startedAt = now
	b.lastHeartbeatAck = now
	log.Printf("[WorkerBridge] 🚀 Spawned ingestion worker (PID: %d)", os.Getpid())
	go k.boot()
	go func() {
		<-k.exited
		b.s.mu.Lock()
		defer b.s.mu.Unlock()
		b.handleWorkerExit(k)
	}()
	if b.stabilityTimer != nil {
		b.stabilityTimer.Stop()
	}
	b.stabilityTimer = time.AfterFunc(30*time.Second, func() {
		b.s.mu.Lock()
		defer b.s.mu.Unlock()
		b.mu.Lock()
		alive := b.worker != nil
		b.mu.Unlock()
		if b.isHealthy && alive {
			b.consecutiveRestarts = 0
		}
	})
}

// consume handles the worker's messages in order. A DB answer only wakes
// its waiter; everything else runs on the server's event loop.
func (b *WorkerBridge) consume() {
	for {
		m, ok := b.outbox.pop()
		if !ok {
			return
		}
		if m.typ == "DB_RESPONSE" {
			b.resolve(m)
			continue
		}
		b.s.mu.Lock()
		b.handleWorkerMessage(m)
		b.s.mu.Unlock()
	}
}

func (b *WorkerBridge) resolve(m serverMsg) {
	b.mu.Lock()
	ch := b.pending[m.requestID]
	delete(b.pending, m.requestID)
	b.mu.Unlock()
	if ch == nil {
		return
	}
	if m.ok {
		ch <- dbResult{val: m.result}
		return
	}
	msg := m.errMsg
	if msg == "" {
		msg = "DB request failed"
	}
	ch <- dbResult{err: errors.New(msg)}
}

func (b *WorkerBridge) handleWorkerMessage(m serverMsg) {
	payload, _ := m.payload.(*Obj)
	now := float64(nowMs())
	switch m.typ {
	case "WORKER_READY":
		b.receivedReady = true
		b.isHealthy = true
		b.lastHeartbeat = now
		b.lastHeartbeatAck = now
		if payload != nil && truthy(payload.Get("pid")) {
			b.workerPid = payload.Get("pid")
		}
		log.Printf("[WorkerBridge] ✅ Worker confirmed READY (PID: %s)", jsString(b.workerPid))
		b.send("PING")
	case "FLEET_UPDATE":
		if payload == nil {
			return
		}
		vehicles, ok := payload.Get("vehicles").([]any)
		if !ok {
			return
		}
		b.s.fr.syncFleetFromWorker(vehicles)
		if !payload.IsUndef("upstreamCanary") || !payload.IsUndef("anomaly") || !payload.IsUndef("scheduleDrift") {
			metrics, _ := b.workerMetrics.(*Obj)
			if metrics == nil {
				metrics = O()
				b.workerMetrics = metrics
			}
			if !payload.IsUndef("upstreamCanary") {
				metrics.Set("upstreamCanary", payload.Get("upstreamCanary"))
			}
			if !payload.IsUndef("anomaly") {
				metrics.Set("fleetAnomaly", payload.Get("anomaly"))
			}
			if !payload.IsUndef("scheduleDrift") {
				metrics.Set("scheduleDrift", payload.Get("scheduleDrift"))
			}
		}
		for _, fn := range b.fleetListeners {
			fn(payload)
		}
	case "SCHEDULE_DRIFT_UPDATE":
		metrics, _ := b.workerMetrics.(*Obj)
		if metrics == nil {
			metrics = O()
			b.workerMetrics = metrics
		}
		metrics.Set("scheduleDrift", m.payload)
	case "REPORT_CACHE_UPDATE":
		if payload != nil && truthy(payload.Get("timeframeHours")) && m.report != nil {
			b.reports.updateMemoryCache(payload.Get("timeframeHours"), m.report)
		}
	case "DISRUPTIONS_UPDATE":
		if payload == nil {
			return
		}
		list, ok := payload.Get("disruptions").([]any)
		if !ok {
			return
		}
		ts := now
		if t := payload.Get("timestamp"); truthy(t) {
			ts = jsNumber(t)
		}
		b.s.tracker.syncAvisos(list, ts)
	case "PONG":
		b.lastHeartbeat = now
		b.lastHeartbeatAck = now
		b.isHealthy = true
		if truthy(m.payload) {
			b.workerMetrics = m.payload
		} else {
			b.workerMetrics = nil
		}
	}
}

func (b *WorkerBridge) handleWorkerExit(k *Worker) {
	k.w.mu.Lock()
	k.w.fr.setAutoExtrapolation(false)
	k.w.mu.Unlock()
	b.mu.Lock()
	if b.worker != k {
		b.mu.Unlock()
		return
	}
	b.worker = nil
	pending := b.pending
	b.pending = map[float64]chan dbResult{}
	b.mu.Unlock()
	b.isHealthy = false
	b.workerPid = nil
	b.pendingReplacement = false
	for _, ch := range pending {
		ch <- dbResult{err: errors.New("Worker exited before DB response")}
	}
	if b.stabilityTimer != nil {
		b.stabilityTimer.Stop()
		b.stabilityTimer = nil
	}
	if b.isShuttingDown {
		log.Printf("[WorkerBridge] Worker exited cleanly during shutdown.")
		return
	}
	log.Printf("[WorkerBridge] ⚠️ Worker exited unexpectedly.")
	b.restarts++
	b.consecutiveRestarts++
	b.scheduleRestart("Worker exit (0/null)")
}

func (b *WorkerBridge) scheduleRestart(reason string) {
	if b.isShuttingDown || b.restartTimer != nil {
		return
	}
	exp := math.Max(0, b.consecutiveRestarts-1)
	delay := math.Min(1000*math.Pow(2, exp), 15000)
	log.Printf("[WorkerBridge] 🔄 Auto-restarting worker in %sms (attempt #%s, reason: %s)...", numToString(delay), numToString(b.restarts), reason)
	b.restartTimer = time.AfterFunc(time.Duration(delay)*time.Millisecond, func() {
		b.s.mu.Lock()
		defer b.s.mu.Unlock()
		b.restartTimer = nil
		if !b.isShuttingDown {
			b.spawnWorker()
		}
	})
}

func (b *WorkerBridge) startHeartbeat() {
	b.stopHeartbeat()
	stop := make(chan struct{})
	b.heartbeatStop = stop
	go func() {
		ping := time.NewTicker(b.pingInterval)
		dog := time.NewTicker(5 * time.Second)
		defer ping.Stop()
		defer dog.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ping.C:
				b.s.mu.Lock()
				if !b.isShuttingDown {
					b.send("PING")
				}
				b.s.mu.Unlock()
			case <-dog.C:
				b.s.mu.Lock()
				b.watchdog()
				b.s.mu.Unlock()
			}
		}
	}()
}

func (b *WorkerBridge) watchdog() {
	b.mu.Lock()
	alive := b.worker != nil
	b.mu.Unlock()
	if !alive || b.isShuttingDown || !b.receivedReady {
		return
	}
	now := float64(nowMs())
	ref := now
	if ack, ok := b.lastHeartbeatAck.(float64); ok && ack != 0 {
		ref = ack
	} else if b.startedAt != 0 {
		ref = b.startedAt
	}
	if since := now - ref; since > b.pingTimeout {
		log.Printf("[WorkerBridge] ⚠️ Worker heartbeat timed out (%ss without PONG). Restarting hung worker...", numToString(jsRound(since/1000)))
		b.isHealthy = false
		b.restartWorker()
	}
}

func (b *WorkerBridge) stopHeartbeat() {
	if b.heartbeatStop != nil {
		close(b.heartbeatStop)
		b.heartbeatStop = nil
	}
}

func (b *WorkerBridge) restartWorker() {
	if b.isShuttingDown || b.pendingReplacement {
		return
	}
	b.mu.Lock()
	alive := b.worker != nil
	b.mu.Unlock()
	if alive {
		b.pendingReplacement = true
		b.send("SHUTDOWN")
		return
	}
	b.isHealthy = false
	b.scheduleRestart("Heartbeat timeout")
}

func (b *WorkerBridge) send(typ string) bool {
	b.mu.Lock()
	k := b.worker
	b.mu.Unlock()
	if k == nil {
		return false
	}
	return k.inbox.push(workerMsg{typ: typ})
}

// historyQuery is called with the server lock released.
func (b *WorkerBridge) historyQuery(op string, args any, timeoutMs float64) (any, error) {
	b.mu.Lock()
	k := b.worker
	if k == nil {
		b.mu.Unlock()
		return nil, errors.New("Worker not running")
	}
	b.nextID++
	id := b.nextID
	ch := make(chan dbResult, 1)
	b.pending[id] = ch
	b.mu.Unlock()
	if !k.inbox.push(workerMsg{typ: "DB_REQUEST", requestID: id, op: op, args: passJSON(args)}) {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
		return nil, errors.New("Channel closed")
	}
	t := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer t.Stop()
	select {
	case r := <-ch:
		return r.val, r.err
	case <-t.C:
		b.mu.Lock()
		if b.pending[id] == ch {
			delete(b.pending, id)
			b.mu.Unlock()
			return nil, errors.New("DB request " + op + " timed out after " + numToString(timeoutMs) + "ms")
		}
		b.mu.Unlock()
		r := <-ch
		return r.val, r.err
	}
}

// shutdown is called holding the server lock; it waits with it released.
func (b *WorkerBridge) shutdown(timeout time.Duration) {
	if b.isShuttingDown {
		return
	}
	b.isShuttingDown = true
	b.isHealthy = false
	b.stopHeartbeat()
	if b.restartTimer != nil {
		b.restartTimer.Stop()
		b.restartTimer = nil
	}
	if b.stabilityTimer != nil {
		b.stabilityTimer.Stop()
		b.stabilityTimer = nil
	}
	b.pendingReplacement = false
	b.mu.Lock()
	k := b.worker
	b.mu.Unlock()
	if k == nil {
		return
	}
	log.Printf("[WorkerBridge] Initiating graceful shutdown of ingestion worker...")
	b.send("SHUTDOWN")
	b.s.await(func() {
		select {
		case <-k.exited:
		case <-time.After(timeout):
			log.Printf("[WorkerBridge] Worker did not exit gracefully within timeout.")
		}
	})
	b.mu.Lock()
	if b.worker == k {
		b.worker = nil
	}
	b.mu.Unlock()
	b.workerPid = nil
}

func (b *WorkerBridge) isRunning() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.worker != nil
}

func (b *WorkerBridge) getStatus() *Obj {
	running := b.isRunning()
	var pid any = b.workerPid
	if !truthy(pid) {
		if running {
			pid = float64(os.Getpid())
		} else {
			pid = nil
		}
	}
	uptime := 0.0
	if b.startedAt != 0 {
		uptime = math.Floor((float64(nowMs()) - b.startedAt) / 1000)
	}
	return O(
		"isHealthy", b.isHealthy,
		"pid", pid,
		"isRunning", running,
		"restarts", b.restarts,
		"consecutiveRestarts", b.consecutiveRestarts,
		"lastHeartbeat", b.lastHeartbeat,
		"lastHeartbeatAck", b.lastHeartbeatAck,
		"uptime", uptime,
		"mode", "fork",
		"metrics", b.workerMetrics,
	)
}
