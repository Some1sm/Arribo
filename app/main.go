package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "difftest" {
		os.Exit(runDifftest(os.Args[2:]))
	}
	fmt.Fprintln(os.Stderr, "server not wired yet")
	os.Exit(1)
}
