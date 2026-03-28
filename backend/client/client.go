package client

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/icholy/digest"

	"github.com/dnvie/MoneroVis/backend/data"
	"github.com/dnvie/MoneroVis/shared"
)

type Client struct {
	pool   *shared.NodePool
	client *http.Client
}

func NewClient(pool *shared.NodePool) *Client {
	transport := &digest.Transport{
		Username: data.Username,
		Password: data.Password,
	}

	httpClient := &http.Client{
		Transport: transport,
		Timeout:   10 * time.Second,
	}

	return &Client{
		pool:   pool,
		client: httpClient,
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
			resp, reqErr = c.client.Post(url+endpoint, "application/json", reqBody)
		} else {
			resp, reqErr = c.client.Post(url+endpoint, "application/json", nil)
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

func (c *Client) GetBlock(height uint64) (*data.GetBlockResponse, error) {
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

	var result data.GetBlockResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode block response: %w", err)
	}

	if result.Result.Status != "OK" {
		return nil, fmt.Errorf("API returned non-OK status: %s", result.Result.Status)
	}

	return &result, nil
}

func (c *Client) GetBlockByHash(hash string) (*data.GetBlockResponse, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block",
		"params":  map[string]string{"hash": hash},
	}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return nil, fmt.Errorf("failed to get block by hash: %w", err)
	}
	defer resp.Body.Close()

	var result data.GetBlockResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode block response: %w", err)
	}

	if result.Result.Status != "OK" {
		return nil, fmt.Errorf("API returned non-OK status: %s", result.Result.Status)
	}

	return &result, nil
}

func (c *Client) GetMinerTransactionSize(hash string) (float64, error) {
	payload := map[string]any{
		"txs_hashes": []string{hash},
	}

	resp, err := c.doPost("/get_transactions", payload)
	if err != nil {
		return 0, fmt.Errorf("failed to get miner transaction size: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Txs []struct {
			AsHex string `json:"pruned_as_hex"`
		} `json:"txs"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return 0, fmt.Errorf("failed to decode response: %w", err)
	}

	if len(result.Txs) == 0 {
		return 0, fmt.Errorf("transaction not found")
	}

	txSize := float64(len(result.Txs[0].AsHex)) / 2 / 1024.0
	return txSize, nil
}

func (c *Client) GetTransaction(hash string) (*data.Tx, error) {
	payload := map[string]any{
		"txs_hashes":     []string{hash},
		"decode_as_json": true,
	}

	resp, err := c.doPost("/get_transactions", payload)
	if err != nil {
		return nil, fmt.Errorf("failed to get transaction: %w", err)
	}
	defer resp.Body.Close()

	var result data.NodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode transaction response: %w", err)
	}

	if result.Status != "OK" {
		return nil, fmt.Errorf("get_transactions status not OK: %v", result.Status)
	}

	if len(result.Txs) == 0 {
		return nil, fmt.Errorf("transaction not found")
	}

	return &result.Txs[0], nil
}

func (c *Client) GetTransactions(hashes []string) ([]data.Tx, error) {
	if len(hashes) == 0 {
		return nil, nil
	}

	var allTxs []data.Tx
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

		var result data.NodeResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode transaction response: %w", decodeErr)
		}

		if result.Status != "OK" {
			return nil, fmt.Errorf("get_transactions status not OK: %v", result.Status)
		}

		allTxs = append(allTxs, result.Txs...)
	}

	return allTxs, nil
}

func (c *Client) GetRawMinimalTransactions(hashes []string) ([]data.RawMinimalTransaction, error) {
	if len(hashes) == 0 {
		return nil, nil
	}

	var allMinimalTxs []data.RawMinimalTransaction
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
			return nil, fmt.Errorf("failed to get minimal transactions batch: %w", err)
		}

		var result map[string]any
		decodeErr := json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode transactions response: %w", decodeErr)
		}

		if status, ok := result["status"].(string); !ok || status != "OK" {
			return nil, fmt.Errorf("get_transactions status not OK: %v", result)
		}

		rawTxHex, ok := result["txs_as_hex"]
		if !ok {
			return nil, fmt.Errorf("txs_as_hex missing from response")
		}

		txHexSlice, ok := rawTxHex.([]string)
		if !ok {
			anySlice, ok := rawTxHex.([]any)
			if !ok {
				return nil, fmt.Errorf("txs_as_hex is not []string or []any")
			}
			txHexSlice = make([]string, 0, len(anySlice))
			for _, v := range anySlice {
				strVal, ok := v.(string)
				if !ok {
					return nil, fmt.Errorf("element in txs_as_hex is not a string")
				}
				txHexSlice = append(txHexSlice, strVal)
			}
		}

		sizes := make([]float64, len(batch))
		for j, hexString := range txHexSlice {
			binaryData, err := hex.DecodeString(hexString)
			if err != nil {
				fmt.Printf("  Error decoding hex: %v", err)
				continue
			}
			sizes[j] = float64(len(binaryData)) / 1024.0
		}

		rawTxsInterface, ok := result["txs_as_json"]
		if !ok {
			return nil, fmt.Errorf("txs_as_json missing from response")
		}

		txsAsJSON, ok := rawTxsInterface.([]any)
		if !ok {
			return nil, fmt.Errorf("txs_as_json is not an array of strings")
		}

		var batchMinimalTxs []data.RawMinimalTransaction
		for _, txJSONStr := range txsAsJSON {
			txStr, ok := txJSONStr.(string)
			if !ok {
				return nil, fmt.Errorf("element in txs_as_json is not a string")
			}

			var tx data.RawMinimalTransaction
			if err := json.Unmarshal([]byte(txStr), &tx); err != nil {
				return nil, fmt.Errorf("failed to unmarshal single transaction: %w", err)
			}
			batchMinimalTxs = append(batchMinimalTxs, tx)
		}

		for j := range batchMinimalTxs {
			if j < len(batch) {
				batchMinimalTxs[j].Hash = batch[j]
			}
			batchMinimalTxs[j].Size = sizes[j]
			fee := batchMinimalTxs[j].RCTSignatures.TxnFee
			if fee == 0 {
				var inSum uint64 = 0
				for _, in := range batchMinimalTxs[j].Vin {
					inSum += in.Key.Amount
				}
				var outSum uint64 = 0
				for _, out := range batchMinimalTxs[j].Vout {
					outSum += out.Amount
				}
				if inSum > outSum {
					fee = inSum - outSum
				}
			}

			batchMinimalTxs[j].Fee = fee
			batchMinimalTxs[j].NumInputs = len(batchMinimalTxs[j].Vin)
			batchMinimalTxs[j].NumOutputs = len(batchMinimalTxs[j].Vout)
		}

		allMinimalTxs = append(allMinimalTxs, batchMinimalTxs...)
	}

	return allMinimalTxs, nil
}

func (c *Client) GetOuts(indices []int, amount int) (*data.GetOutsResponse, error) {
	if len(indices) == 0 {
		return &data.GetOutsResponse{Status: "OK"}, nil
	}

	var combinedResponse *data.GetOutsResponse
	batchSize := 500

	for i := 0; i < len(indices); i += batchSize {
		end := min(i+batchSize, len(indices))
		batch := indices[i:end]

		outputs := make([]map[string]any, len(batch))
		for j, index := range batch {
			outputs[j] = map[string]any{"amount": amount, "index": index}
		}

		payload := map[string]any{"outputs": outputs, "get_txid": true}

		resp, err := c.doPost("/get_outs", payload)
		if err != nil {
			return nil, fmt.Errorf("failed to get outs batch: %w", err)
		}

		var result data.GetOutsResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode get_outs response: %w", decodeErr)
		}

		if result.Status != "OK" {
			return nil, fmt.Errorf("get_outs status not OK: %s", result.Status)
		}

		if combinedResponse == nil {
			combinedResponse = &result
		} else {
			combinedResponse.Outs = append(combinedResponse.Outs, result.Outs...)
		}
	}

	return combinedResponse, nil
}

func (c *Client) GetOutsMixed(reqs []data.OutRequest) (*data.GetOutsResponse, error) {
	if len(reqs) == 0 {
		return &data.GetOutsResponse{Status: "OK"}, nil
	}

	var combinedResponse *data.GetOutsResponse
	batchSize := 500

	for i := 0; i < len(reqs); i += batchSize {
		end := min(i+batchSize, len(reqs))
		batch := reqs[i:end]

		payload := map[string]any{"outputs": batch, "get_txid": true}

		resp, err := c.doPost("/get_outs", payload)
		if err != nil {
			return nil, fmt.Errorf("failed to get outs mixed batch: %w", err)
		}

		var result data.GetOutsResponse
		decodeErr := json.NewDecoder(resp.Body).Decode(&result)
		resp.Body.Close()

		if decodeErr != nil {
			return nil, fmt.Errorf("failed to decode get_outs response: %w", decodeErr)
		}

		if result.Status != "OK" {
			return nil, fmt.Errorf("get_outs status not OK: %s", result.Status)
		}

		if combinedResponse == nil {
			combinedResponse = &result
		} else {
			combinedResponse.Outs = append(combinedResponse.Outs, result.Outs...)
		}
	}

	return combinedResponse, nil
}

func (c *Client) GetDecoyCounts(ids []int) (map[string]int, error) {
	if len(ids) == 0 {
		return make(map[string]int), nil
	}

	baseURL := data.DatagenBaseURL + "/decoy_count"

	idStrs := make([]string, len(ids))
	for i, id := range ids {
		idStrs[i] = strconv.Itoa(id)
	}
	idsParam := strings.Join(idStrs, ",")

	req, err := http.NewRequest("GET", baseURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create decoy count request: %w", err)
	}

	q := req.URL.Query()
	q.Add("ids", idsParam)
	req.URL.RawQuery = q.Encode()

	httpClient := &http.Client{Timeout: 30 * time.Second}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to execute decoy count request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("decoy count server returned non-200 status: %s", resp.Status)
	}

	var counts map[string]int
	if err := json.NewDecoder(resp.Body).Decode(&counts); err != nil {
		return nil, fmt.Errorf("failed to decode decoy count response: %w", err)
	}

	return counts, nil
}

func (c *Client) GetCoinbaseStatus(hashes []string) (map[string]bool, error) {
	if len(hashes) == 0 {
		return make(map[string]bool), nil
	}

	uniqueHashesMap := make(map[string]struct{})
	var uniqueHashes []string
	for _, h := range hashes {
		if _, exists := uniqueHashesMap[h]; !exists {
			uniqueHashesMap[h] = struct{}{}
			uniqueHashes = append(uniqueHashes, h)
		}
	}

	payload := map[string]any{
		"hashes": uniqueHashes,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal coinbase payload: %w", err)
	}

	url := fmt.Sprintf("%s/is_coinbase", data.DatagenBaseURL)

	resp, err := c.client.Post(url, "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to call is_coinbase: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("is_coinbase returned non-200 status: %s", resp.Status)
	}

	var coinbaseMap map[string]bool
	if err := json.NewDecoder(resp.Body).Decode(&coinbaseMap); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return coinbaseMap, nil
}

func (c *Client) GetInfo() (*data.GetInfoResponse, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_info",
	}

	resp, err := c.doPost("/json_rpc", payload)
	if err != nil {
		return nil, fmt.Errorf("failed to get info: %w", err)
	}
	defer resp.Body.Close()

	var result data.GetInfoResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode get_info response: %w", err)
	}

	if result.Result.Status != "OK" {
		return nil, fmt.Errorf("API returned non-OK status: %s", result.Result.Status)
	}

	return &result, nil
}

func (c *Client) GetBlockHeadersRange(startHeight, endHeight uint64) (*data.GetBlockHeadersRangeResponse, error) {
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

	var result data.GetBlockHeadersRangeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode get_block_headers_range response: %w", err)
	}

	if result.Result.Status != "OK" {
		return nil, fmt.Errorf("API returned non-OK status: %s", result.Result.Status)
	}

	return &result, nil
}

func (c *Client) GetTransactionPool() (*data.GetTransactionPoolResponse, error) {
	resp, err := c.doPost("/get_transaction_pool", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to get transaction pool: %w", err)
	}
	defer resp.Body.Close()

	var result data.GetTransactionPoolResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode get_transaction_pool response: %w", err)
	}

	if result.Status != "OK" {
		return nil, fmt.Errorf("API returned non-OK status: %s", result.Status)
	}

	return &result, nil
}
