package main

// Returning freed heap to the kernel. After a burst (a month of incident
// history, a full planner cache rebuild) the Go runtime keeps the freed pages
// and its background scavenger hands them back only slowly, so the resident
// size stays near the burst's peak. Every 30 s, when more than 8 MiB of heap
// is free but still resident, debug.FreeOSMemory returns it: one full
// collection of a heap of a few tens of MB, a few milliseconds of CPU.

import (
	"runtime/debug"
	"runtime/metrics"
	"time"
)

const (
	memTrimInterval  = 30 * time.Second
	memTrimThreshold = 8 << 20
)

func startMemTrimmer() {
	sample := []metrics.Sample{{Name: "/memory/classes/heap/free:bytes"}}
	go func() {
		for range time.Tick(memTrimInterval) {
			metrics.Read(sample)
			if sample[0].Value.Kind() == metrics.KindUint64 && sample[0].Value.Uint64() > memTrimThreshold {
				debug.FreeOSMemory()
			}
		}
	}()
}
