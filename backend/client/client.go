package client

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"maps"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/icholy/digest"

	"github.com/dnvie/MoneroVis/backend/data"
)

type Client struct {
	RPCURL string
	client *http.Client
}

func NewClient() *Client {

	transport := &digest.Transport{
		Username: data.Username,
		Password: data.Password,
	}

	httpClient := &http.Client{
		Transport: transport,
	}

	return &Client{
		RPCURL: data.Node,
		client: httpClient,
	}
}

func (c *Client) GetBlock(height uint64) (*data.GetBlockResponse, error) {

	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_block",
		"params":  map[string]uint64{"height": height},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal block payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/json_rpc", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post block request: %w", err)
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
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal block payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/json_rpc", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post block request: %w", err)
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

func (c *Client) GetRawMinimalTransactions(hashes []string) ([]data.RawMinimalTransaction, error) {

	if len(hashes) == 0 {
		// No txs
		return nil, nil
	}

	payload := map[string]any{
		"txs_hashes":     hashes,
		"decode_as_json": true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal block payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/get_transactions", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post block request: %w", err)
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode transactions response: %w", err)
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
			return nil, fmt.Errorf("txs_as_hex is not []string or []any, but type %T", rawTxHex)
		}

		txHexSlice = make([]string, 0, len(anySlice))
		for i, v := range anySlice {
			strVal, ok := v.(string)
			if !ok {
				return nil, fmt.Errorf("element %d in txs_as_hex is not a string, but type %T", i, v)
			}
			txHexSlice = append(txHexSlice, strVal)
		}
	}

	sizes := make([]float64, len(hashes))

	for i, hexString := range txHexSlice {
		binaryData, err := hex.DecodeString(hexString)
		if err != nil {
			fmt.Printf("  Error decoding hex: %v", err)
			continue
		}
		sizes[i] = float64(len(binaryData)) / 1024.0
	}

	rawTxsInterface, ok := result["txs_as_json"]
	if !ok {
		return nil, fmt.Errorf("txs_as_json missing from response")
	}

	txsAsJSON, ok := rawTxsInterface.([]any)
	if !ok {
		return nil, fmt.Errorf("txs_as_json is not an array of strings")
	}

	var minimalTransactions []data.RawMinimalTransaction
	for _, txJSONStr := range txsAsJSON {
		txStr, ok := txJSONStr.(string)
		if !ok {
			return nil, fmt.Errorf("element in txs_as_json is not a string")
		}

		var tx data.RawMinimalTransaction
		if err := json.Unmarshal([]byte(txStr), &tx); err != nil {
			return nil, fmt.Errorf("failed to unmarshal single transaction from txs_as_json: %w", err)
		}
		minimalTransactions = append(minimalTransactions, tx)
	}

	if len(hashes) != len(minimalTransactions) {
		log.Printf("Warning: Number of returned transactions (%d) does not match requested hashes (%d)", len(minimalTransactions), len(hashes))
	}

	for i := range minimalTransactions {
		if i < len(hashes) {
			minimalTransactions[i].Hash = hashes[i]
		}
		minimalTransactions[i].Size = sizes[i]
		fee := minimalTransactions[i].RCTSignatures.TxnFee
		if fee == 0 {
			var inSum uint64 = 0
			for _, in := range minimalTransactions[i].Vin {
				inSum += in.Key.Amount
			}
			var outSum uint64 = 0
			for _, out := range minimalTransactions[i].Vout {
				outSum += out.Amount
			}
			if inSum > outSum {
				fee = inSum - outSum
			}
		}

		minimalTransactions[i].Fee = fee
		minimalTransactions[i].NumInputs = len(minimalTransactions[i].Vin)
		minimalTransactions[i].NumOutputs = len(minimalTransactions[i].Vout)
	}

	return minimalTransactions, nil
}

func (c *Client) GetMinerTransactionSize(hash string) (float64, error) {
	hashes := make([]string, 1)
	hashes[0] = hash

	payload := map[string]any{
		"txs_hashes": hashes,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return 0, fmt.Errorf("failed to marshal payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/get_transactions", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return 0, fmt.Errorf("failed to post request: %w", err)
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
	hashes := []string{hash}

	payload := map[string]any{
		"txs_hashes":     hashes,
		"decode_as_json": true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal transaction payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/get_transactions", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post transaction request: %w", err)
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

	payload := map[string]any{
		"txs_hashes":     hashes,
		"decode_as_json": true,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal transaction payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/get_transactions", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post transaction request: %w", err)
	}
	defer resp.Body.Close()

	var result data.NodeResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode transaction response: %w", err)
	}

	if result.Status != "OK" {
		return nil, fmt.Errorf("get_transactions status not OK: %v", result.Status)
	}

	return result.Txs, nil
}

func (c *Client) GetOuts(indices []int, amount int) (*data.GetOutsResponse, error) {
	outputs := make([]map[string]any, len(indices))
	for i, index := range indices {
		outputs[i] = map[string]any{"amount": amount, "index": index}
	}

	payload := map[string]any{"outputs": outputs, "get_txid": true}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal get_outs payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/get_outs", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post get_outs request: %w", err)
	}
	defer resp.Body.Close()

	var result data.GetOutsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode get_outs response: %w", err)
	}

	if result.Status != "OK" {
		return nil, fmt.Errorf("get_outs status not OK: %s", result.Status)
	}

	return &result, nil
}

func (c *Client) GetOutsMixed(reqs []data.OutRequest) (*data.GetOutsResponse, error) {
	payload := map[string]any{"outputs": reqs, "get_txid": true}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal get_outs payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/get_outs", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post get_outs request: %w", err)
	}
	defer resp.Body.Close()

	var result data.GetOutsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode get_outs response: %w", err)
	}

	if result.Status != "OK" {
		return nil, fmt.Errorf("get_outs status not OK: %s", result.Status)
	}

	return &result, nil
}

func (c *Client) GetDecoyCounts(ids []int) (map[string]int, error) {
	if len(ids) == 0 {
		return make(map[string]int), nil
	}

	baseURL := data.DecoyApiUrl + "/decoy_count"

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

	req.Header.Add("CF-Access-Client-Id", "14c19c30a7bf7d9edcc659fe4e2f265a.access")
	req.Header.Add("CF-Access-Client-Secret", "f9a401094aa49114fe7a97daa2edb9947bea88654203971bfbf1d884b76510e8")

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

	coinbaseMap := make(map[string]bool)
	batchSize := 50

	for i := 0; i < len(uniqueHashes); i += batchSize {
		end := min(i+batchSize, len(uniqueHashes))
		batch := uniqueHashes[i:end]

		hashesParam := strings.Join(batch, ",")
		url := fmt.Sprintf("%s/is_coinbase?hashes=%s", data.DatagenBaseURL, hashesParam)

		resp, err := c.client.Get(url)
		if err != nil {
			return nil, fmt.Errorf("failed to call is_coinbase for batch %d: %w", i, err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("is_coinbase returned non-200 status: %s", resp.Status)
		}

		var batchResult map[string]bool
		if err := json.NewDecoder(resp.Body).Decode(&batchResult); err != nil {
			return nil, fmt.Errorf("failed to decode response for batch %d: %w", i, err)
		}

		maps.Copy(coinbaseMap, batchResult)
	}

	return coinbaseMap, nil
}

func (c *Client) GetInfo() (*data.GetInfoResponse, error) {
	payload := map[string]any{
		"jsonrpc": "2.0",
		"id":      "0",
		"method":  "get_info",
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal get_info payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/json_rpc", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post get_info request: %w", err)
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
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal get_block_headers_range payload: %w", err)
	}

	resp, err := c.client.Post(c.RPCURL+"/json_rpc", "application/json", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to post get_block_headers_range request: %w", err)
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
	resp, err := c.client.Post(c.RPCURL+"/get_transaction_pool", "application/json", nil)
	if err != nil {
		return nil, fmt.Errorf("failed to post get_transaction_pool request: %w", err)
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
