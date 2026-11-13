package main

import (
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "difftest" {
		os.Exit(runDifftest(os.Args[2:]))
	}
	os.Exit(runServer())
}
