package outputs

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dnvie/MoneroVis/shared"
	lru "github.com/hashicorp/golang-lru"
)

type Client struct {
	pool       *shared.NodePool
	client     *http.Client
	blockCache *lru.Cache
}

func NewClient(pool *shared.NodePool) *Client {
	cache, err := lru.New(10_000)
	if err != nil {
		log.Fatalf("Failed to create LRU cache: %v", err)
	}

	transport := &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	}

	return &Client{
		pool: pool,
		client: &http.Client{
			Timeout:   3600 * time.Second,
			Transport: transport,
		},
		blockCache: cache,
	}
}

func (c *Client) Close() {
	c.client.CloseIdleConnections()
}

func (c *Client) GetOutsBatch(indices []uint64) []map[string]any {
	outputs := make([]any, len(indices))
	for i, index := range indices {
		outputs[i] = map[string]any{"amount": 0, "index": index}
	}
	payload := map[string]any{"outputs": outputs}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Fatalf("Failed to marshal payload: %v", err)
	}

	var resp *http.Response
	var reqErr error
	var url string

	for range 3 {
		url, reqErr = c.pool.Get()
		if reqErr != nil {
			log.Fatalf("No healthy nodes available in pool: %v", reqErr)
		}

		reqBody := bytes.NewBuffer(body)

		resp, reqErr = c.client.Post(url+"/get_outs", "application/json", reqBody)
		if reqErr != nil {
			c.pool.ReportFailure(url, reqErr)
			log.Printf("[Warning] Node %s network error (EOF): %v. Retrying...", url, reqErr)
			continue
		}

		if resp.StatusCode != 200 {
			c.pool.ReportFailure(url, fmt.Errorf("bad status: %d", resp.StatusCode))
			resp.Body.Close()
			log.Printf("[Warning] Node %s returned status %d. Retrying...", url, resp.StatusCode)
			continue
		}

		break
	}

	if resp == nil {
		log.Fatalf("Failed to get outputs after 3 retries. Last error: %v", reqErr)
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Fatalf("Failed to decode response: %v", err)
	}

	if status, ok := result["status"].(string); !ok || status != "OK" {
		log.Fatalf("Failed to get outputs: Status not OK: %v", result)
	}

	outsArr, ok := result["outs"].([]any)
	if !ok {
		log.Fatalf("Failed to get outputs: output array missing")
	}

	res := make([]map[string]any, len(outsArr))
	for i, o := range outsArr {
		out, ok := o.(map[string]any)
		if !ok {
			log.Fatalf("Output %d is not a valid map", i)
		}

		heightF, ok := out["height"].(float64)
		if !ok {
			log.Fatalf("Output %d has invalid height type", i)
		}
		key, ok := out["key"].(string)
		if !ok {
			log.Fatalf("Output %d has invalid key type", i)
		}

		res[i] = map[string]any{
			"height": uint64(heightF),
			"key":    key,
		}
	}
	return res
}

func (c *Client) GetBlock(height uint64) map[string]any {
	if cached, ok := c.blockCache.Get(height); ok {
		return cached.(map[string]any)
	}

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block",
		"params":  map[string]uint64{"height": height},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		log.Fatalf("Failed to marshal block payload: %v", err)
	}

	var resp *http.Response
	var reqErr error
	var url string

	for range 3 {
		url, reqErr = c.pool.Get()
		if reqErr != nil {
			log.Fatalf("No healthy nodes available in pool: %v", reqErr)
		}

		reqBody := bytes.NewBuffer(body)
		resp, reqErr = c.client.Post(url+"/json_rpc", "application/json", reqBody)

		if reqErr != nil {
			c.pool.ReportFailure(url, reqErr)
			log.Printf("[Warning] Node %s network error getting block %d: %v. Retrying...", url, height, reqErr)
			continue
		}

		if resp.StatusCode != 200 {
			c.pool.ReportFailure(url, fmt.Errorf("bad status: %d", resp.StatusCode))
			resp.Body.Close()
			log.Printf("[Warning] Node %s returned status %d getting block %d. Retrying...", url, resp.StatusCode, height)
			continue
		}

		break
	}

	if resp == nil {
		log.Fatalf("Failed to post block request after 3 retries. Last error: %v", reqErr)
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Fatalf("Failed to decode block response: %v", err)
	}

	resultBlock, ok := result["result"].(map[string]any)
	if !ok {
		log.Fatalf("Invalid block result for height %d", height)
	}

	minerTxHash, ok := resultBlock["miner_tx_hash"].(string)
	if !ok || minerTxHash == "" {
		log.Fatalf("Block %d missing miner_tx_hash", height)
	}

	txHashes, ok := resultBlock["tx_hashes"].([]any)
	if !ok {
		numTxesF, ok := resultBlock["block_header"].(map[string]any)["num_txes"].(float64)
		if !ok {
			log.Fatalf("Block %d missing tx_hashes and num_txes", height)
		}
		if numTxesF == 0 {
			txHashes = []any{}
		} else {
			log.Fatalf("Block %d has %d txs but no tx_hashes array", height, int(numTxesF))
		}
	}

	simpleBlock := map[string]any{
		"miner_tx_hash": minerTxHash,
		"tx_hashes":     txHashes,
	}

	c.blockCache.Add(height, simpleBlock)
	return simpleBlock
}

func (c *Client) GetBlockCount() uint64 {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block_count",
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Fatalf("Failed to marshal block count payload: %v", err)
	}

	var resp *http.Response
	var reqErr error
	var url string

	for range 3 {
		url, reqErr = c.pool.Get()
		if reqErr != nil {
			log.Fatalf("No healthy nodes available in pool: %v", reqErr)
		}

		reqBody := bytes.NewBuffer(body)
		resp, reqErr = c.client.Post(url+"/json_rpc", "application/json", reqBody)

		if reqErr != nil {
			c.pool.ReportFailure(url, reqErr)
			log.Printf("[Warning] Node %s network error getting block count: %v. Retrying...", url, reqErr)
			continue
		}

		if resp.StatusCode != 200 {
			c.pool.ReportFailure(url, fmt.Errorf("bad status: %d", resp.StatusCode))
			resp.Body.Close()
			log.Printf("[Warning] Node %s returned status %d getting block count. Retrying...", url, resp.StatusCode)
			continue
		}

		break
	}

	if resp == nil {
		log.Fatalf("Failed to post block count request after 3 retries. Last error: %v", reqErr)
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		log.Fatalf("Failed to decode block count response: %v", err)
	}

	resultData, ok := result["result"].(map[string]any)
	if !ok {
		log.Fatalf("Invalid block count result")
	}

	countFloat, ok := resultData["count"].(float64)
	if !ok {
		log.Fatalf("Block count missing or invalid")
	}

	return uint64(countFloat)
}

func (c *Client) GetTransactions(hashes []string) map[string]map[string]any {
	txsMap := make(map[string]map[string]any, len(hashes))
	if len(hashes) == 0 {
		return txsMap
	}

	const maxTxsPerRequest = 50

	for i := 0; i < len(hashes); i += maxTxsPerRequest {
		end := min(i+maxTxsPerRequest, len(hashes))
		batchHashes := hashes[i:end]

		payload := map[string]any{
			"txs_hashes":     batchHashes,
			"decode_as_json": true,
		}

		body, err := json.Marshal(payload)
		if err != nil {
			log.Fatalf("Failed to marshal transactions payload: %v", err)
		}

		var resp *http.Response
		var reqErr error
		var url string

		for range 3 {
			url, reqErr = c.pool.Get()
			if reqErr != nil {
				log.Fatalf("No healthy nodes available in pool: %v", reqErr)
			}

			reqBody := bytes.NewBuffer(body)

			resp, reqErr = c.client.Post(url+"/get_transactions", "application/json", reqBody)
			if reqErr != nil {
				c.pool.ReportFailure(url, reqErr)
				log.Printf("[Warning] Node %s network error fetching txs: %v. Retrying...", url, reqErr)
				continue
			}

			if resp.StatusCode != 200 {
				c.pool.ReportFailure(url, fmt.Errorf("bad status: %d", resp.StatusCode))
				resp.Body.Close()
				log.Printf("[Warning] Node %s returned status %d fetching txs. Retrying...", url, resp.StatusCode)
				continue
			}

			break
		}

		if resp == nil {
			log.Fatalf("Failed to get transactions batch after 3 retries. Last error: %v", reqErr)
		}

		var result map[string]any
		decodeErr := json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()

		if decodeErr != nil {
			log.Fatalf("Failed to decode transactions response: %v", decodeErr)
		}

		if status, ok := result["status"].(string); !ok || status != "OK" {
			log.Fatalf("get_transactions status not OK: %v", result)
		}

		rawTxs, ok := result["txs_as_json"].([]any)
		if !ok {
			log.Fatalf("txs_as_json missing")
		}

		if len(rawTxs) != len(batchHashes) {
			log.Fatalf("Mismatch between requested hashes and returned transactions in batch")
		}

		for j, raw := range rawTxs {
			str, ok := raw.(string)
			if !ok {
				log.Fatalf("txs_as_json[%d] is not a string", j)
			}

			var tx map[string]any
			if err := json.Unmarshal([]byte(str), &tx); err != nil {
				log.Fatalf("Failed to decode transaction %d: %v", j, err)
			}

			txsMap[batchHashes[j]] = tx
		}
	}

	return txsMap
}

func getAllTxsFromBlock(block map[string]any) []string {
	miner, ok := block["miner_tx_hash"].(string)
	if !ok {
		log.Fatalf("miner_tx_hash missing")
	}

	allTxs := []string{miner}
	for _, h := range block["tx_hashes"].([]any) {
		hash, ok := h.(string)
		if !ok {
			log.Fatalf("tx_hashes contains non-string element")
		}
		allTxs = append(allTxs, hash)
	}
	return allTxs
}

func getVoutKeys(hashes []string, txs map[string]map[string]any) map[string]string {
	keyToTx := make(map[string]string)

	for _, hash := range hashes {
		tx, ok := txs[hash]
		if !ok {
			log.Fatalf("Transaction not found: %s", hash)
		}

		vouts, ok := tx["vout"].([]any)
		if !ok || len(vouts) == 0 {
			log.Fatalf("Transaction %s has no vout", hash)
		}

		for _, v := range vouts {
			voutMap, ok := v.(map[string]any)
			if !ok {
				log.Fatalf("vout in tx %s is not a map", hash)
			}
			target, ok := voutMap["target"].(map[string]any)
			if !ok {
				log.Fatalf("vout in tx %s missing target", hash)
			}

			var key string
			if k, ok := target["key"]; ok {
				key, ok = k.(string)
				if !ok {
					log.Fatalf("vout key in tx %s invalid", hash)
				}
			} else if tk, ok := target["tagged_key"].(map[string]any); ok {
				key, ok = tk["key"].(string)
				if !ok {
					log.Fatalf("vout tagged_key in tx %s invalid", hash)
				}
			} else {
				log.Fatalf("vout in tx %s has neither key nor tagged_key", hash)
			}

			if existing, exists := keyToTx[key]; exists {
				fmt.Printf("[INFO] Duplicate key %s found in txs %s and %s — overwriting\n", key, existing, hash)
			}
			keyToTx[key] = hash
		}
	}

	return keyToTx
}

const batchSizeInsert = 500

type batchRow struct {
	index      uint64
	lookupHash []byte
}

func insertBatch(db *sql.DB, rows []batchRow) {
	if len(rows) == 0 {
		return
	}

	tx, err := db.Begin()
	if err != nil {
		log.Fatalf("Failed to begin transaction: %v", err)
	}

	stmt, err := tx.Prepare("INSERT INTO outputs (global_output_index, lookup_hash) VALUES (?, ?)")
	if err != nil {
		log.Fatalf("Failed to prepare batch statement: %v", err)
	}

	for _, r := range rows {
		if _, err := stmt.Exec(r.index, r.lookupHash); err != nil {
			log.Printf("Warning: Failed to insert row in batch, may be a duplicate: %v", err)
		}
	}

	if err := stmt.Close(); err != nil {
		log.Fatalf("Failed to close statement: %v", err)
	}
	if err := tx.Commit(); err != nil {
		log.Fatalf("Failed to commit batch transaction: %v", err)
	}
}

type Job struct {
	startIndex uint64
	batchSize  uint64
}

func worker(id int, client *Client, jobs <-chan Job, processed *uint64, db *sql.DB, mu *sync.Mutex, wg *sync.WaitGroup) {
	defer wg.Done()

	var batch []batchRow

	for job := range jobs {
		outs := client.GetOutsBatch(createIndices(job.startIndex, job.batchSize))
		blockTxCache := make(map[uint64]map[string]map[string]any)

		for i, out := range outs {
			height := out["height"].(uint64)
			key := out["key"].(string)

			// These outputs are not real and unspendable
			if key == "0000000000000000000000000000000000000000000000000000000000000000" ||
				key == "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead000f" {
				continue
			}

			if _, ok := blockTxCache[height]; !ok {
				block := client.GetBlock(height)
				hashes := getAllTxsFromBlock(block)
				txs := client.GetTransactions(hashes)
				blockTxCache[height] = txs
			}

			txs := blockTxCache[height]
			voutMap := getVoutKeys(getAllTxsFromBlock(client.GetBlock(height)), txs)
			txHash, ok := voutMap[key]
			if !ok || txHash == "" {
				log.Fatalf("[Worker %d] Could not find tx hash for key %s at height %d", id, key, height)
			}

			txHashBytes, err := hex.DecodeString(txHash)
			if err != nil {
				log.Fatalf("[Worker %d] Failed to decode txHash %s: %v", id, txHash, err)
			}

			keyBytes, err := hex.DecodeString(key)
			if err != nil {
				log.Fatalf("[Worker %d] Failed to decode key %s: %v", id, key, err)
			}

			dataToHash := append(txHashBytes, keyBytes...)
			lookupHash := sha256.Sum256(dataToHash)
			batch = append(batch, batchRow{index: job.startIndex + uint64(i), lookupHash: lookupHash[:]})

			if len(batch) >= batchSizeInsert {
				mu.Lock()
				insertBatch(db, batch)
				mu.Unlock()
				batch = batch[:0]
			}

			total := atomic.AddUint64(processed, 1)
			if total%10_000 == 0 {
				fmt.Printf("[Worker %d] Total processed: %d\n", id, total)
			}
		}
	}

	if len(batch) > 0 {
		mu.Lock()
		insertBatch(db, batch)
		mu.Unlock()
	}
}

func createIndices(start, count uint64) []uint64 {
	arr := make([]uint64, count)
	for i := range count {
		arr[i] = start + i
	}
	return arr
}

func Generate(isPi bool, db *sql.DB, client *Client) {
	defer client.Close()

	totalProcessed := uint64(0)
	numWorkers := 8
	batchSize := uint64(1_000)

	// SQLite Setup
	var startIndex uint64 = 0
	var gapStartIndex uint64 = 0
	row := db.QueryRow("SELECT MAX(global_output_index) FROM outputs")
	var maxIndex sql.NullInt64
	if err := row.Scan(&maxIndex); err != nil {
		if err != sql.ErrNoRows {
			log.Fatalf("Failed to get max index: %v", err)
		}
	}
	if maxIndex.Valid {
		startIndex = uint64(maxIndex.Int64) + 1
		totalProcessed = startIndex
		gapStartIndex = startIndex
	}

	fmt.Printf("\nStarting processing from index %d\n", startIndex)

	endIndex := FindMaxOutputIndex(client, startIndex)

	fmt.Printf("\nCurrent end index: %d", endIndex)

	jobs := make(chan Job, numWorkers*2)
	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := range numWorkers {
		wg.Add(1)
		go worker(i, client, jobs, &totalProcessed, db, &mu, &wg)
	}

	for i := startIndex; i < endIndex; i += batchSize {
		size := batchSize
		if i+size > endIndex {
			size = endIndex - i
		}
		jobs <- Job{startIndex: i, batchSize: size}
	}
	close(jobs)

	wg.Wait()
	fmt.Printf("\nAll done. Total outputs processed: %d", totalProcessed)

	if !isPi {
		fmt.Printf("\nChecking for gaps starting from index %d...", gapStartIndex)
		gaps := FindGaps(gapStartIndex, db)
		FillGaps(client, gaps, db)
	}

	_, err := db.Exec("PRAGMA wal_checkpoint(FULL)")
	if err != nil {
		log.Fatalf("Failed to checkpoint WAL: %v", err)
	}
}

func FillGaps(client *Client, ranges []MissingRange, db *sql.DB) {
	if len(ranges) == 0 {
		fmt.Println("\nNo gaps found. Populating of outputs database is complete.")
		return
	}

	pragmas := []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA synchronous=OFF;",
		"PRAGMA temp_store=MEMORY;",
		"PRAGMA mmap_size=30000000000;",
		"PRAGMA cache_size=-2000000;",
	}
	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			log.Printf("PRAGMA failed: %v", err)
		}
	}

	jobs := make(chan Job, 16)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var totalProcessed uint64

	numWorkers := 8
	for i := range numWorkers {
		wg.Add(1)
		go gapWorker(i, client, jobs, &totalProcessed, db, &mu, &wg)
	}

	batchSize := uint64(10_000)
	for _, r := range ranges {
		fmt.Printf("\nQueueing missing range %d – %d", r.Start, r.End)

		for i := r.Start; i <= r.End; i += batchSize {
			size := batchSize
			if i+size-1 > r.End {
				size = r.End - i + 1
			}
			jobs <- Job{startIndex: i, batchSize: size}
		}
	}

	close(jobs)
	wg.Wait()

	fmt.Printf("\nGap filling completed. Total processed: %d", totalProcessed)
}

func gapWorker(id int, client *Client, jobs <-chan Job, processed *uint64, db *sql.DB, mu *sync.Mutex, wg *sync.WaitGroup) {
	defer wg.Done()

	var batch []batchRow

	for job := range jobs {
		indices := createIndices(job.startIndex, job.batchSize)

		outs := client.GetOutsBatch(indices)
		blockTxCache := make(map[uint64]map[string]map[string]any)

		for i, out := range outs {
			height := out["height"].(uint64)
			key := out["key"].(string)

			if key == "0000000000000000000000000000000000000000000000000000000000000000" || key == "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead000f" {
				continue
			}

			if _, ok := blockTxCache[height]; !ok {
				block := client.GetBlock(height)
				hashes := getAllTxsFromBlock(block)
				txs := client.GetTransactions(hashes)
				blockTxCache[height] = txs
			}

			txs := blockTxCache[height]
			voutMap := getVoutKeys(getAllTxsFromBlock(client.GetBlock(height)), txs)
			txHash, ok := voutMap[key]
			if !ok || txHash == "" {
				log.Fatalf("[Gap Worker %d] Could not find tx hash for key %s at height %d", id, key, height)
			}

			txHashBytes, err := hex.DecodeString(txHash)
			if err != nil {
				log.Fatalf("[Gap Worker %d] Failed to decode txHash %s: %v", id, txHash, err)
			}

			keyBytes, err := hex.DecodeString(key)
			if err != nil {
				log.Fatalf("[Gap Worker %d] Failed to decode key %s: %v", id, key, err)
			}

			dataToHash := append(txHashBytes, keyBytes...)
			lookupHash := sha256.Sum256(dataToHash)
			batch = append(batch, batchRow{
				index:      job.startIndex + uint64(i),
				lookupHash: lookupHash[:],
			})

			if len(batch) >= batchSizeInsert {
				mu.Lock()
				insertBatch(db, batch)
				mu.Unlock()
				batch = batch[:0]
			}

			total := atomic.AddUint64(processed, 1)
			if total%10_000 == 0 {
				fmt.Printf("[Gap Worker %d] Processed: %d\n", id, total)
			}
		}
	}

	if len(batch) > 0 {
		mu.Lock()
		insertBatch(db, batch)
		mu.Unlock()
	}
}
