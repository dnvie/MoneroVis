package rest

import (
	"net/http"

	"github.com/go-chi/chi"
	"github.com/go-chi/chi/middleware"
	"github.com/go-chi/cors"
)

func Serve(h *ApiHandler) {
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: []string{
			"http://localhost:4200",
			"http://127.0.0.1:4200",
			"http://192.168.1.158:4200",
			"https://www.monerovis.com",
			"https://*.monerovis.com",
			"https://monerovis.com",
			"https://*.monerovis.pages.dev",
			"https://monerovis.pages.dev",
		},
		AllowedMethods: []string{"GET", "POST"},
		AllowedHeaders: []string{"*"},
	}))

	r.Get("/block/{height:[0-9]+}", h.GetBlock)
	r.Get("/block/{hash}", h.GetBlock)
	r.Get("/blocks", h.GetBlocks)
	r.Get("/home", h.GetHome)
	r.Get("/transaction/{hash}", h.GetTransaction)
	r.Get("/transactionJson/{hash}", h.GetTransactionJSON)
	r.Post("/transactions", h.GetTransactions)
	r.Post("/automateOutputMerging", h.AutomateOutputMerging)
	r.Get("/search/{query}", h.GetSearchResult)

	http.ListenAndServe(":8080", r)
}
