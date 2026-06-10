package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/dnvie/MoneroVis/datagen/coinbase"
	"github.com/dnvie/MoneroVis/datagen/database"
	"github.com/dnvie/MoneroVis/datagen/inputs"
	"github.com/dnvie/MoneroVis/datagen/outputs"
	"github.com/dnvie/MoneroVis/datagen/ring_members"
)

const (
	defaultNodeURL  = "http://localhost:18081"
	defaultNodeUser = ""
	defaultNodePass = ""
)

type nodeConfig struct {
	URL      string
	Username string
	Password string
}

func runGenerate(isPi bool, cfg nodeConfig) {
	db := database.InitDb(isPi)
	defer db.Close()

	client := outputs.NewClient(cfg.URL, cfg.Username, cfg.Password, isPi)
	defer client.Close()

	outputs.Generate(isPi, db, client)
	inputs.Generate(isPi, db, client)
	ring_members.Generate(isPi, db)
}

func main() {
	flags := flag.NewFlagSet(os.Args[0], flag.ExitOnError)
	nodeURL := flags.String("node-url", defaultNodeURL, "Monero node RPC URL")
	nodeUser := flags.String("node-user", defaultNodeUser, "Monero node RPC username")
	nodePass := flags.String("node-pass", defaultNodePass, "Monero node RPC password")
	flags.Usage = func() {
		fmt.Fprintf(flags.Output(), "Usage: go run main.go [--node-url URL] [--node-user USER] [--node-pass PASS] <command> [args...] [pi]\n")
		flags.PrintDefaults()
	}
	flags.Parse(os.Args[1:])

	if flags.NArg() < 1 {
		flags.Usage()
		os.Exit(1)
	}

	cfg := nodeConfig{
		URL:      *nodeURL,
		Username: *nodeUser,
		Password: *nodePass,
	}
	if strings.TrimSpace(cfg.URL) == "" {
		fmt.Println("Error: node-url must not be empty.")
		os.Exit(1)
	}

	args := flags.Args()

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
		runGenerate(isPi, cfg)
	case "autogen":
		if len(commandArgs) != 1 {
			fmt.Println("Usage: go run main.go [--node-url URL] [--node-user USER] [--node-pass PASS] autogen <minutes> [pi]")
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
			runGenerate(isPi, cfg)
			fmt.Printf("--- Cycle complete. Next run in %s at %s ---\n\n", interval, time.Now().Add(interval).Format("2006-01-02 15:04:05"))
			time.Sleep(interval)
		}
	case "coinbase":
		db := database.InitDb(isPi)
		coinbase.Start(db, cfg.URL, cfg.Username, cfg.Password, isPi)
	default:
		fmt.Println("Unknown command:", command)
		os.Exit(1)
	}
}
