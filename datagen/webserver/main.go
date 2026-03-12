package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/dnvie/MoneroVis/datagen/client"
	"github.com/dnvie/MoneroVis/datagen/database"
	"github.com/dnvie/MoneroVis/datagen/decoys"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
)

type App struct {
	DB     *sql.DB
	Client *client.Client
}

func (app *App) getDecoysHandlerNew(w http.ResponseWriter, r *http.Request) {
	txHash := r.URL.Query().Get("tx_hash")
	if txHash == "" {
		http.Error(w, "tx_hash query parameter is required", http.StatusBadRequest)
		return
	}

	trueSpendKey := r.URL.Query().Get("key")
	if trueSpendKey == "" {
		http.Error(w, "key query parameter is required", http.StatusBadRequest)
		return
	}

	globalOutputIndexString := r.URL.Query().Get("global_output_index")
	if globalOutputIndexString == "" {
		http.Error(w, "key query parameter is required", http.StatusBadRequest)
		return
	}

	globalOutputIndex, err := strconv.ParseInt(globalOutputIndexString, 0, 64)
	if err != nil {
		http.Error(w, "given global_output_index is not valid", http.StatusBadRequest)
		return
	}

	log.Printf("Received decoy graph request for tx_hash: %s, key: %s, global_output_index: %v", txHash, trueSpendKey, globalOutputIndex)

	graphData, err := decoys.BuildGraphDataNew(app.DB, app.Client, txHash, trueSpendKey, globalOutputIndex)
	if err != nil {
		if strings.Contains(err.Error(), "too many transactions") {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			log.Printf("Error building graph data: %v", err)
			http.Error(w, fmt.Sprintf("Failed to get decoy data: %v", err), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	err = json.NewEncoder(w).Encode(graphData)
	if err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

func (app *App) getDecoysByIndexHandler(w http.ResponseWriter, r *http.Request) {
	globalOutputIndexString := r.URL.Query().Get("global_output_index")
	if globalOutputIndexString == "" {
		http.Error(w, "global_output_index query parameter is required", http.StatusBadRequest)
		return
	}

	globalOutputIndex, err := strconv.ParseInt(globalOutputIndexString, 10, 64)
	if err != nil {
		http.Error(w, "given global_output_index is not a valid integer", http.StatusBadRequest)
		return
	}

	log.Printf("Received index-based decoy request for global_output_index: %v", globalOutputIndex)

	graphData, err := decoys.BuildDecoyMapByIndex(app.DB, app.Client, globalOutputIndex)
	if err != nil {
		if strings.Contains(err.Error(), "too many transactions") {
			http.Error(w, err.Error(), http.StatusBadRequest)
		} else {
			log.Printf("Error building graph data from index: %v", err)
			http.Error(w, fmt.Sprintf("Failed to get decoy data: %v", err), http.StatusInternalServerError)
		}
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	err = json.NewEncoder(w).Encode(graphData)
	if err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

func (app *App) getDecoyCountHandler(w http.ResponseWriter, r *http.Request) {
	idsParam := r.URL.Query().Get("ids")
	if idsParam == "" {
		http.Error(w, "ids query parameter is required", http.StatusBadRequest)
		return
	}

	rawIDs := strings.Split(idsParam, ",")

	var outputIDs []int64
	counts := make(map[string]int)
	for _, idStr := range rawIDs {
		id, err := strconv.ParseInt(idStr, 10, 64)
		if err != nil {
			counts[idStr] = -1
			continue
		}
		outputIDs = append(outputIDs, id)
		counts[idStr] = 0
	}

	if len(outputIDs) > 0 {
		chunkSize := 500
		for i := 0; i < len(outputIDs); i += chunkSize {
			end := min(i+chunkSize, len(outputIDs))

			if err := fetchDecoyCountsBatch(app.DB, outputIDs[i:end], counts); err != nil {
				log.Printf("Batch query failed: %v", err)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(counts)
}

func (app *App) getDecoysByIndicesHandler(w http.ResponseWriter, r *http.Request) {
	indicesParam := r.URL.Query().Get("indices")
	if indicesParam == "" {
		http.Error(w, "indices query parameter is required (comma separated)", http.StatusBadRequest)
		return
	}

	strIndices := strings.Split(indicesParam, ",")
	var inputIndices []int64

	inputIndices = make([]int64, 0, len(strIndices))

	for _, s := range strIndices {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}

		val, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			http.Error(w, fmt.Sprintf("invalid integer found in list: %s", s), http.StatusBadRequest)
			return
		}
		inputIndices = append(inputIndices, val)
	}

	if len(inputIndices) > 1000 {
		http.Error(w, "too many indices requested at once (max 1000)", http.StatusBadRequest)
		return
	}

	log.Printf("Received bulk request for %d indices", len(inputIndices))

	resultsMap, err := decoys.FindTransactionsForIndices(app.DB, inputIndices)
	if err != nil {
		log.Printf("Error fetching bulk transactions: %v", err)
		http.Error(w, "Failed to retrieve transaction data", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if err := json.NewEncoder(w).Encode(resultsMap); err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

func (app *App) getDecoysByTxHashesHandler(w http.ResponseWriter, r *http.Request) {
	hashesParam := r.URL.Query().Get("hashes")
	if hashesParam == "" {
		http.Error(w, "hashes query parameter is required (comma separated)", http.StatusBadRequest)
		return
	}

	strHashes := strings.Split(hashesParam, ",")
	var inputHashes []string

	inputHashes = make([]string, 0, len(strHashes))

	for _, h := range strHashes {
		cleanHash := strings.TrimSpace(h)
		if cleanHash != "" {
			inputHashes = append(inputHashes, cleanHash)
		}
	}

	txs, err := app.Client.GetTransactionOutputIndices(inputHashes)
	if err != nil {
		http.Error(w, "Failed to retrieve transactions", http.StatusInternalServerError)
		return
	}

	outputKeys := make([]int64, 0)

	for _, tx := range txs {
		for _, out := range tx {
			outputKeys = append(outputKeys, int64(out))
		}
	}

	if len(outputKeys) != 0 && outputKeys != nil {

	}

	if len(outputKeys) > 1000 {
		http.Error(w, "too many indices requested at once (max 1000)", http.StatusBadRequest)
		return
	}

	log.Printf("Received bulk request for %d indices", len(outputKeys))

	resultsMap, err := decoys.FindTransactionsForIndices(app.DB, outputKeys)
	if err != nil {
		log.Printf("Error fetching bulk transactions: %v", err)
		http.Error(w, "Failed to retrieve transaction data", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)

	if err := json.NewEncoder(w).Encode(resultsMap); err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

func fetchDecoyCountsBatch(db *sql.DB, ids []int64, results map[string]int) error {
	if len(ids) == 0 {
		return nil
	}

	placeholders := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT output_id, COUNT(*)
		FROM ring_members
		WHERE output_id IN (%s)
		GROUP BY output_id`,
		strings.Join(placeholders, ","))

	rows, err := db.Query(query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var outputID int64
		var count int
		if err := rows.Scan(&outputID, &count); err != nil {
			continue
		}
		results[strconv.FormatInt(outputID, 10)] = count
	}

	return rows.Err()
}

func (app *App) getIsCoinbaseHandler(w http.ResponseWriter, r *http.Request) {
	hashesParam := r.URL.Query().Get("hashes")
	if hashesParam == "" {
		http.Error(w, "hashes query parameter is required", http.StatusBadRequest)
		return
	}

	hashes := strings.Split(hashesParam, ",")
	cleanHashes := make([]string, 0, len(hashes))
	for _, h := range hashes {
		h = strings.TrimSpace(h)
		if h != "" {
			cleanHashes = append(cleanHashes, h)
		}
	}

	if len(cleanHashes) == 0 {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{})
		return
	}

	results, err := checkCoinbaseBatch(app.DB, cleanHashes)
	if err != nil {
		log.Printf("Error checking coinbase status: %v", err)
		http.Error(w, "Database query failed", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(results)
}

func checkCoinbaseBatch(db *sql.DB, hashes []string) (map[string]bool, error) {
	results := make(map[string]bool, len(hashes))
	// Default to false
	for _, h := range hashes {
		results[h] = false
	}

	if len(hashes) == 0 {
		return results, nil
	}

	placeholders := make([]string, len(hashes))
	args := make([]any, len(hashes))
	for i, h := range hashes {
		placeholders[i] = "?"
		args[i] = h
	}

	query := fmt.Sprintf("SELECT tx_hash FROM coinbase_txs WHERE tx_hash IN (%s)", strings.Join(placeholders, ","))

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var foundHash string
		if err := rows.Scan(&foundHash); err != nil {
			continue
		}
		results[foundHash] = true
	}

	return results, rows.Err()
}

var heavyRequestLimiter = make(chan struct{}, 5)

func limitMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case heavyRequestLimiter <- struct{}{}:
			defer func() { <-heavyRequestLimiter }()
			next.ServeHTTP(w, r)
		default:
			http.Error(w, "Server busy, please try again in a second", http.StatusTooManyRequests)
		}
	})
}

func quietLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		uri := r.RequestURI
		if len(uri) > 200 {
			parts := strings.SplitN(uri, "?", 2)
			if len(parts) == 2 {
				uri = parts[0] + "?..."
			} else {
				uri = uri[:200] + "..."
			}
		}

		next.ServeHTTP(w, r)

		log.Printf("%s %s %v", r.Method, uri, time.Since(start))
	})
}

func main() {

	isPi := false
	db := database.InitDb(isPi)

	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	defer db.Close()

	rpcURL := "http://192.168.1.158:18081"

	rpcClient := client.NewClient(rpcURL)

	app := &App{
		DB:     db,
		Client: rpcClient,
	}

	r := chi.NewRouter()
	r.Use(quietLogger)

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
		AllowedMethods: []string{"GET", "OPTIONS"},
		AllowedHeaders: []string{"Content-Type", "CF-Access-Client-Id", "CF-Access-Client-Secret"},
	}))

	r.Use(limitMiddleware)

	r.Get("/decoys", app.getDecoysHandlerNew)
	r.Get("/decoysByIndex", app.getDecoysByIndexHandler)
	r.Get("/decoy_count", app.getDecoyCountHandler)
	r.Get("/batchDecoyTxs", app.getDecoysByIndicesHandler)
	r.Get("/batchTxs", app.getDecoysByTxHashesHandler)
	r.Get("/is_coinbase", app.getIsCoinbaseHandler)

	port := "8081"
	log.Printf("Starting server on port %s...", port)
	log.Fatal(http.ListenAndServe(":"+port, r))
}
