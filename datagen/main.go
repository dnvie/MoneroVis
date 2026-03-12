package main

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/dnvie/MoneroVis/datagen/coinbase"
	"github.com/dnvie/MoneroVis/datagen/database"
	"github.com/dnvie/MoneroVis/datagen/inputs"
	"github.com/dnvie/MoneroVis/datagen/outputs"
	"github.com/dnvie/MoneroVis/datagen/ring_members"
)

func runGenerate(isPi bool) {
	db := database.InitDb(isPi)
	defer db.Close()

	outputs.Generate(isPi, db)
	inputs.Generate(isPi, db)
	ring_members.Generate(isPi, db)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("Usage: go run main.go <command> [args...] [pi]")
		os.Exit(1)
	}

	args := os.Args[1:]

	isPi := false
	if len(args) > 0 && args[len(args)-1] == "pi" {
		isPi = true
		args = args[:len(args)-1]
	}

	if len(args) == 0 {
		fmt.Println("No command specified.")
		os.Exit(1)
	}

	command := args[0]
	commandArgs := args[1:]

	switch command {
	case "generate":
		runGenerate(isPi)
	case "autogen":
		if len(commandArgs) != 1 {
			fmt.Println("Usage: go run main.go autogen <minutes> [pi]")
			return
		}
		minutes, err := strconv.Atoi(commandArgs[0])
		if err != nil || minutes <= 0 {
			fmt.Println("Error: <minutes> must be a positive integer.")
			return
		}

		interval := time.Duration(minutes) * time.Minute
		fmt.Printf("Starting autogen process. Running every %d minutes.\n", minutes)

		for {
			fmt.Printf("--- Running generation cycle at %s ---\n", time.Now().Format("2006-01-02 15:04:05"))
			runGenerate(isPi)
			fmt.Printf("--- Cycle complete. Next run in %s at %s ---\n\n", interval, time.Now().Add(interval).Format("2006-01-02 15:04:05"))
			time.Sleep(interval)
		}
	case "coinbase":
		db := database.InitDb(isPi)
		coinbase.Start(db)
	default:
		fmt.Println("Unknown command:", command)
		os.Exit(1)
	}
}
