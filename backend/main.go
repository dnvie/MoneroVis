package main

import (
	"time"

	"github.com/dnvie/MoneroVis/backend/client"
	"github.com/dnvie/MoneroVis/backend/rest"
	"github.com/dnvie/MoneroVis/shared"
)

func main() {
	pool := shared.NewNodePool(shared.DefaultNodes())
	pool.StartHealthChecks(30 * time.Second)

	client := client.NewClient(pool)
	apiHandler := rest.NewApiHandler(client)
	rest.Serve(apiHandler)

}
