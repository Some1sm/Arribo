package main

// Diagnostics, off unless ARRIBO_PPROF names a listen address (for example
// 127.0.0.1:6060). It has its own mux, never the public server's.

import (
	"log"
	"net/http"
	"net/http/pprof"
	"os"
)

func startPprof() {
	addr := os.Getenv("ARRIBO_PPROF")
	if addr == "" {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	go func() {
		if err := http.ListenAndServe(addr, mux); err != nil {
			log.Printf("[pprof] %v", err)
		}
	}()
}
