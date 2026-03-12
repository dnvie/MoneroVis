package main

import (
	"github.com/dnvie/MoneroVis/backend/client"
	"github.com/dnvie/MoneroVis/backend/rest"
)

func main() {
	client := client.NewClient()
	apiHandler := rest.NewApiHandler(client)
	rest.Serve(apiHandler)

}
