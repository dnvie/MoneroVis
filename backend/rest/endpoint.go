package rest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/dnvie/MoneroVis/backend/client"
	"github.com/dnvie/MoneroVis/backend/service"
	"github.com/go-chi/chi"
)

type ApiHandler struct {
	client *client.Client
}

func NewApiHandler(c *client.Client) *ApiHandler {
	return &ApiHandler{client: c}
}

func (h *ApiHandler) GetHome(w http.ResponseWriter, r *http.Request) {
	homeData, err := service.GetHomeData(h.client)
	if err != nil {
		fmt.Println(err)
		h.sendError(w, http.StatusInternalServerError, "Failed to fetch home data")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(homeData); err != nil {
		fmt.Println("Failed to encode response:", err)
	}
}

func (h *ApiHandler) GetBlocks(w http.ResponseWriter, r *http.Request) {
	pageParam := r.URL.Query().Get("page")
	page := 1
	if pageParam != "" {
		p, err := strconv.Atoi(pageParam)
		if err == nil && p > 0 {
			page = p
		}
	}

	blocksResp, err := service.GetBlocks(page, h.client)
	if err != nil {
		fmt.Println(err)
		h.sendError(w, http.StatusInternalServerError, "Failed to fetch blocks")
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(blocksResp); err != nil {
		fmt.Println("Failed to encode response:", err)
	}
}

func (h *ApiHandler) GetBlock(w http.ResponseWriter, r *http.Request) {
	block, err := service.GetBlock(r, h.client)
	if err != nil {
		fmt.Println(err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error": "Invalid Block Height/Hash"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	if block.Status == "fail" {
		io.WriteString(w, "\nError: Invalid Block ID\n")
	} else {
		blockJSON, err := json.Marshal(block)
		if err != nil {
			io.WriteString(w, "Received Invalid Block JSON Object")
		} else {
			w.Write(blockJSON)
		}
	}
}

func (h *ApiHandler) GetTransaction(w http.ResponseWriter, r *http.Request) {
	transaction, err := service.GetTransaction(r, h.client)
	if err != nil {
		fmt.Println(err)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error": "Invalid Transaction Hash"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)

	txJSON, err := json.Marshal(transaction)
	if err != nil {
		io.WriteString(w, "Received Invalid Block JSON Object")
	} else {
		w.Write(txJSON)
	}
}

func (h *ApiHandler) GetTransactionJSON(w http.ResponseWriter, r *http.Request) {
	txJSON, err := service.GetTransactionJSON(r, h.client)
	if err != nil {
		fmt.Println(err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error": "Invalid Transaction Hash or JSON"}`)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(txJSON); err != nil {
		fmt.Println("Failed to encode response:", err)
	}
}

func (h *ApiHandler) GetTransactions(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Hashes []string `json:"hashes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		h.sendError(w, http.StatusBadRequest, "Invalid JSON in request body")
		return
	}

	transactions, err := service.GetTransactions(payload.Hashes, h.client)
	if err != nil {
		h.sendError(w, http.StatusBadRequest, "Failed to get transactions")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)

	txJSON, err := json.Marshal(transactions)
	if err != nil {
		io.WriteString(w, "Received Invalid Block JSON Object")
	} else {
		w.Write(txJSON)
	}
}

func (h *ApiHandler) AutomateOutputMerging(w http.ResponseWriter, r *http.Request) {
	var payload struct {
		Hashes []string `json:"hashes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		h.sendError(w, http.StatusBadRequest, "Invalid JSON in request body")
		return
	}

	result, err := service.AutomateOutputMerging(payload.Hashes, h.client)
	if err != nil {
		h.sendError(w, http.StatusInternalServerError, "Failed to automate output merging: "+err.Error())
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(result)
}

func (h *ApiHandler) GetSearchResult(w http.ResponseWriter, r *http.Request) {
	query := chi.URLParam(r, "query")
	w.Header().Set("Content-Type", "application/json")

	if isNumeric(query) {

		ctx := chi.RouteContext(r.Context())

		ctx.URLParams.Add("height", query)

		if h.tryBlockSearch(w, r) {
			return
		}

		h.sendError(w, http.StatusNotFound, "Block height not found")
		return
	}

	if len(query) == 64 {

		ctx := chi.RouteContext(r.Context())

		ctx.URLParams.Add("hash", query)

		if h.tryTransactionSearch(w, r) {
			return
		}

		if h.tryBlockSearch(w, r) {
			return
		}

		h.sendError(w, http.StatusNotFound, "Hash not found in blocks or transactions")
		return
	}

	h.sendError(w, http.StatusBadRequest, "Invalid search query (must be height or 64-char hash)")
}

func (h *ApiHandler) tryBlockSearch(w http.ResponseWriter, r *http.Request) bool {
	block, err := service.GetBlockLite(r, h.client)

	if err != nil || block == nil {
		return false
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(block)
	return true
}

func (h *ApiHandler) tryTransactionSearch(w http.ResponseWriter, r *http.Request) bool {
	tx, err := service.GetTransactionLite(r, h.client)

	if err != nil || tx == nil {
		return false
	}

	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(tx)
	return true
}

func (h *ApiHandler) sendError(w http.ResponseWriter, code int, message string) {
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}

func isNumeric(s string) bool {
	if len(s) == 0 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
