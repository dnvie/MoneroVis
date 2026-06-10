package main

import (
	"flag"
	"log"
	"strings"

	"github.com/dnvie/MoneroVis/backend/client"
	"github.com/dnvie/MoneroVis/backend/data"
	"github.com/dnvie/MoneroVis/backend/rest"
)

func main() {
	nodeURL := flag.String("node-url", data.DefaultNodeURL, "Monero node RPC URL")
	nodeUser := flag.String("node-user", data.DefaultNodeUser, "Monero node RPC username")
	nodePass := flag.String("node-pass", data.DefaultNodePass, "Monero node RPC password")
	flag.Parse()

	if strings.TrimSpace(*nodeURL) == "" {
		log.Fatal("node-url must not be empty")
	}

	client := client.NewClient(*nodeURL, *nodeUser, *nodePass)
	apiHandler := rest.NewApiHandler(client)
	rest.Serve(apiHandler)
}
