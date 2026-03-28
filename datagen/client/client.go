package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/dnvie/MoneroVis/shared"
	lru "github.com/hashicorp/golang-lru"
	"github.com/icholy/digest"
)

type Client struct {
	pool         *shared.NodePool
	httpClient   *http.Client
	blockCache   *lru.Cache
	txDataCache  *lru.Cache
	keyToTxCache *lru.Cache
}

type GetOutsResponse struct {
	Outs   []Output `json:"outs"`
	Status string   `json:"status"`
}

type Output struct {
	Height *uint64 `json:"height"`
	Key    string  `json:"key"`
}

type GetBlockResponse struct {
	Result Block `json:"result"`
}

type Block struct {
	MinerTxHash string   `json:"miner_tx_hash"`
	TxHashes    []string `json:"tx_hashes"`
}

type GetTransactionsResponse struct {
	TxsAsJSON []string `json:"txs_as_json"`
	Status    string   `json:"status"`
}

type Transaction struct {
	Vin  []Vin  `json:"vin"`
	Vout []Vout `json:"vout"`
}

type Vin struct {
	Key VinKey `json:"key"`
}

type VinKey struct {
	KImage     string   `json:"k_image"`
	KeyOffsets []uint64 `json:"key_offsets"`
}

type Vout struct {
	Target Target `json:"target"`
}

type Target struct {
	Key       string     `json:"key"`
	TaggedKey *TaggedKey `json:"tagged_key,omitempty"`
}

type TaggedKey struct {
	Key string `json:"key"`
}

type Tx struct {
	OutputIndices []int  `json:"output_indices"`
	TxHash        string `json:"tx_hash"`
}

type NodeResponse struct {
	Status string `json:"status"`
	Txs    []Tx   `json:"txs"`
}

func (t Target) GetKey() string {
	if t.TaggedKey != nil {
		return t.TaggedKey.Key
	}
	return t.Key
}

func NewClient(pool *shared.NodePool) *Client {
	blockCache, _ := lru.New(1000)
	txDataCache, _ := lru.New(1000)
	keyToTxCache, _ := lru.New(1000)

	transport := &digest.Transport{
		Username: "",
		Password: "",
	}

	return &Client{
		pool:         pool,
		httpClient:   &http.Client{Timeout: 60 * time.Second, Transport: transport},
		blockCache:   blockCache,
		txDataCache:  txDataCache,
		keyToTxCache: keyToTxCache,
	}
}

func (c *Client) doPost(endpoint string, payload any) (*http.Response, error) {
	var body []byte
	var err error

	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal payload: %w", err)
		}
	}

	var resp *http.Response
	var reqErr error
	var url string

	for range 3 {
		url, reqErr = c.pool.Get()
		if reqErr != nil {
			return nil, fmt.Errorf("pool exhausted: %w", reqErr)
		}

		if payload != nil {
			reqBody := bytes.NewBuffer(body)
			resp, reqErr = c.httpClient.Post(url+endpoint, "application/json", reqBody)
		} else {
			resp, reqErr = c.httpClient.Post(url+endpoint, "application/json", nil)
		}

		if reqErr != nil {
			c.pool.ReportFailure(url, reqErr)
			log.Printf("[Warning] Node %s failed (%s): %v. Retrying...", url, endpoint, reqErr)
			continue
		}

		if resp.StatusCode != http.StatusOK {
			c.pool.ReportFailure(url, fmt.Errorf("bad HTTP status: %d", resp.StatusCode))
			resp.Body.Close()
			log.Printf("[Warning] Node %s returned status %d for %s. Retrying...", url, resp.StatusCode, endpoint)
			continue
		}

		return resp, nil
	}

	return nil, fmt.Errorf("all retries failed for %s. Last error: %v", endpoint, reqErr)
}

func (c *Client) FindParentTx(height uint64, key string) (string, error) {
	log.Printf("[Block %d] Finding parent for key %s...", height, key[:10])

	if cachedMap, ok := c.keyToTxCache.Get(height); ok {
		log.Printf("[Block %d] L1 Cache HIT. Searching in pre-computed map.", height)
		if txHash, ok := cachedMap.(map[string]string)[key]; ok {
			return txHash, nil
		}
		return "", fmt.Errorf("key %s not found in cached block %d", key, height)
	}
	log.Printf("[Block %d] L1 Cache MISS.", height)

	var txs map[string]Transaction
	var err error

	if cachedTxData, ok := c.txDataCache.Get(height); ok {
		log.Printf("[Block %d] L2 Cache HIT. Using cached transaction data.", height)
		txs = cachedTxData.(map[string]Transaction)
	} else {
		log.Printf("[Block %d] L2 Cache MISS. Fetching from node.", height)
		log.Printf("[Block %d] Calling GetBlock...", height)
		block, err_b := c.GetBlock(height)
		if err_b != nil {
			return "", fmt.Errorf("failed to get block %d: %w", height, err_b)
		}
		log.Printf("[Block %d] GetBlock finished.", height)

		allTxHashes := append(block.TxHashes, block.MinerTxHash)
		if len(allTxHashes) == 0 {
			c.txDataCache.Add(height, make(map[string]Transaction))
			c.keyToTxCache.Add(height, make(map[string]string))
			return "", fmt.Errorf("block %d contains no transactions", height)
		}

		log.Printf("[Block %d] Calling GetTransactions for %d hashes...", height, len(allTxHashes))
		txs, err = c.GetTransactions(allTxHashes)
		if err != nil {
			return "", fmt.Errorf("failed to get transactions for block %d: %w", height, err)
		}
		log.Printf("[Block %d] GetTransactions finished.", height)

		c.txDataCache.Add(height, txs)
		log.Printf("[Block %d] Populated L2 cache.", height)
	}

	log.Printf("[Block %d] Building key-to-tx map...", height)
	keyToTxMap := make(map[string]string)
	for txHash, tx := range txs {
		for _, vout := range tx.Vout {
			key := vout.Target.GetKey()
			if key != "" {
				keyToTxMap[key] = txHash
			}
		}
	}
	log.Printf("[Block %d] Finished building map.", height)

	c.keyToTxCache.Add(height, keyToTxMap)
	log.Printf("[Block %d] Populated L1 cache.", height)

	if txHash, ok := keyToTxMap[key]; ok {
		return txHash, nil
	}

	return "", fmt.Errorf("key %s not found in any transaction in block %d", key, height)
}

func (c *Client) GetOutsBatch(indices []uint64) ([]Output, error) {
	if len(indices) == 0 {
		return nil, nil
	}

	var allOuts []Output
	batchSize := 500

	for i := 0; i < len(indices); i += batchSize {
		end := min(i+batchSize, len(indices))
		batch := indices[i:end]

		outputs := make([]map[string]uint64, len(batch))
		for j, index := range batch {
			outputs[j] = map[string]uint64{"amount": 0, "index": index}
		}

		payload := map[string]any{"outputs": outputs}

		resp, err := c.doPost("/get_outs", payload)
		if err != nil {
			return nil, fmt.Errorf("failed to get outs batch: %w", err)
		}

		var r GetOutsResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&r)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode get_outs response: %w", decodeErr)
		}
		if r.Status != "OK" {
			return nil, fmt.Errorf("get_outs status not OK: %s", r.Status)
		}

		allOuts = append(allOuts, r.Outs...)
	}

	return allOuts, nil
}

func (c *Client) GetBlock(height uint64) (*Block, error) {
	if cached, ok := c.blockCache.Get(height); ok {
		return cached.(*Block), nil
	}

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block",
		"params":  map[string]uint64{"height": height},
	}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return nil, fmt.Errorf("failed to get block: %w", err)
	}
	defer resp.Body.Close()

	var r GetBlockResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("failed to decode block response: %w", err)
	}

	c.blockCache.Add(height, &r.Result)
	return &r.Result, nil
}

func (c *Client) GetTransactions(hashes []string) (map[string]Transaction, error) {
	if len(hashes) == 0 {
		return make(map[string]Transaction), nil
	}

	resultMap := make(map[string]Transaction, len(hashes))
	batchSize := 50

	for i := 0; i < len(hashes); i += batchSize {
		end := min(i+batchSize, len(hashes))
		batch := hashes[i:end]

		payload := map[string]any{
			"txs_hashes":     batch,
			"decode_as_json": true,
		}

		resp, err := c.doPost("/get_transactions", payload)
		if err != nil {
			return nil, fmt.Errorf("failed to get transactions batch: %w", err)
		}

		var r GetTransactionsResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&r)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode get_transactions response: %w", decodeErr)
		}
		if r.Status != "OK" {
			return nil, fmt.Errorf("get_transactions status not OK: %s", r.Status)
		}

		if len(r.TxsAsJSON) != len(batch) {
			log.Printf("Warning: Mismatched request/response length for get_transactions batch. Requested %d, got %d", len(batch), len(r.TxsAsJSON))
		}

		for j, txJSON := range r.TxsAsJSON {
			var tx Transaction
			if err := json.Unmarshal([]byte(txJSON), &tx); err != nil {
				log.Printf("Warning: could not unmarshal transaction for hash %s: %v", batch[j], err)
				continue
			}
			resultMap[batch[j]] = tx
		}
	}

	return resultMap, nil
}

func (c *Client) GetTransactionOutputIndices(hashes []string) (map[string][]int, error) {
	if len(hashes) == 0 {
		return make(map[string][]int), nil
	}

	outputMap := make(map[string][]int)
	batchSize := 50

	for i := 0; i < len(hashes); i += batchSize {
		end := min(i+batchSize, len(hashes))
		batch := hashes[i:end]

		payload := map[string]any{
			"txs_hashes":     batch,
			"decode_as_json": false,
		}

		resp, err := c.doPost("/get_transactions", payload)
		if err != nil {
			return nil, fmt.Errorf("failed to get transaction output indices batch: %w", err)
		}

		var result NodeResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode transaction response: %w", decodeErr)
		}

		if result.Status != "OK" {
			return nil, fmt.Errorf("get_transactions status not OK: %v", result.Status)
		}

		for _, tx := range result.Txs {
			outputMap[tx.TxHash] = tx.OutputIndices
		}
	}

	return outputMap, nil
}

func (c *Client) GetBlockCount() (uint64, error) {
	payload := map[string]any{"jsonrpc": "2.0", "id": "0", "method": "get_block_count"}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return 0, fmt.Errorf("failed to get block count: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Result struct {
			Count uint64 `json:"count"`
		} `json:"result"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("failed to decode block count response: %w", err)
	}

	return result.Result.Count, nil
}

type GetInfoResponse struct {
	Result struct {
		Height uint64 `json:"height"`
		Status string `json:"status"`
	} `json:"result"`
}

func (c *Client) GetInfo() (uint64, error) {
	payload := map[string]any{"jsonrpc": "2.0", "id": "0", "method": "get_info"}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return 0, fmt.Errorf("failed to get info: %w", err)
	}
	defer resp.Body.Close()

	var r GetInfoResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return 0, fmt.Errorf("failed to decode get_info response: %w", err)
	}
	if r.Result.Status != "OK" {
		return 0, fmt.Errorf("get_info status not OK: %s", r.Result.Status)
	}

	return r.Result.Height, nil
}

type BlockHeader struct {
	Height      uint64 `json:"height"`
	MinerTxHash string `json:"miner_tx_hash"`
	Hash        string `json:"hash"`
	Timestamp   uint64 `json:"timestamp"`
}

type BlockHeaderResponse struct {
	Result struct {
		BlockHeader BlockHeader `json:"block_header"`
		Status      string      `json:"status"`
	} `json:"result"`
}

func (c *Client) GetBlockHeaderByHeight(height uint64) (*BlockHeaderResponse, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block_header_by_height",
		"params":  map[string]uint64{"height": height},
	}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return nil, fmt.Errorf("failed to get block header by height: %w", err)
	}
	defer resp.Body.Close()

	var r BlockHeaderResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("failed to decode block header response: %w", err)
	}

	if r.Result.Status != "OK" {
		return nil, fmt.Errorf("status not OK: %v", r.Result.Status)
	}

	return &r, nil
}

type BlockHeadersRangeResponse struct {
	Result struct {
		Headers []BlockHeader `json:"headers"`
		Status  string        `json:"status"`
	} `json:"result"`
}

func (c *Client) GetBlockHeadersRange(startHeight, endHeight uint64) ([]BlockHeader, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block_headers_range",
		"params": map[string]uint64{
			"start_height": startHeight,
			"end_height":   endHeight,
		},
	}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return nil, fmt.Errorf("failed to get block headers range: %w", err)
	}
	defer resp.Body.Close()

	var r BlockHeadersRangeResponse
	if err := json.NewDecoder(resp.Body).Decode(&r); err != nil {
		return nil, fmt.Errorf("failed to decode block headers range response: %w", err)
	}

	if r.Result.Status != "OK" {
		return nil, fmt.Errorf("status not OK: %v", r.Result.Status)
	}

	return r.Result.Headers, nil
}
