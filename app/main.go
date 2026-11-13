package main

import (
	"net/http"
	"os"
	"time"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "difftest":
			os.Exit(runDifftest(os.Args[2:]))
		case "healthcheck":
			os.Exit(runHealthcheck())
		}
	}
	os.Exit(runServer())
}

// runHealthcheck is the container probe (the image has no shell or wget):
// /api/health answers 200 while the HTTP server is up.
func runHealthcheck() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	c := &http.Client{Timeout: 4 * time.Second}
	resp, err := c.Get("http://127.0.0.1:" + port + "/api/health")
	if err != nil {
		return 1
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}
