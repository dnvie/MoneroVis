package service

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/dnvie/MoneroVis/backend/client"
	"github.com/dnvie/MoneroVis/backend/data"
	"github.com/go-chi/chi"
)

func GetHomeData(c *client.Client) (*data.HomeData, error) {
	info, err := c.GetInfo()
	if err != nil {
		return nil, fmt.Errorf("failed to get node info: %w", err)
	}
	chainHeight := info.Result.Height

	endHeight := int64(chainHeight) - 1
	startHeight := max(endHeight-14, 0)

	headersResp, err := c.GetBlockHeadersRange(uint64(startHeight), uint64(endHeight))
	if err != nil {
		return nil, fmt.Errorf("failed to get block headers: %w", err)
	}

	mempoolResp, err := c.GetTransactionPool()
	if err != nil {
		return nil, fmt.Errorf("failed to get transaction pool: %w", err)
	}

	var homeBlocks []data.HomeBlock
	headers := headersResp.Result.Headers
	for i := len(headers) - 1; i >= 0; i-- {
		h := headers[i]
		homeBlocks = append(homeBlocks, data.HomeBlock{
			Height:       h.Height,
			TxCount:      h.NumTxes,
			Hash:         h.Hash,
			Reward:       float64(h.Reward) / 1_000_000_000_000.0,
			RelativeTime: GetRelativeTime(h.Timestamp),
			Timestamp:    h.Timestamp,
		})
	}

	var homeMempool []data.HomeMempoolTx
	for _, tx := range mempoolResp.Transactions {
		var txJSON struct {
			Vin  []any `json:"vin"`
			Vout []any `json:"vout"`
		}
		if err := json.Unmarshal([]byte(tx.TxJSON), &txJSON); err != nil {
			fmt.Printf("Error unmarshalling tx json for %s: %v\n", tx.IdHash, err)
		}

		homeMempool = append(homeMempool, data.HomeMempoolTx{
			Hash:    tx.IdHash,
			Size:    float64(tx.BlobSize) / 1024.0,
			Fee:     float64(tx.Fee) / 1_000_000_000_000.0,
			Inputs:  len(txJSON.Vin),
			Outputs: len(txJSON.Vout),
		})
	}

	if homeMempool == nil {
		homeMempool = []data.HomeMempoolTx{}
	}
	if homeBlocks == nil {
		homeBlocks = []data.HomeBlock{}
	}

	return &data.HomeData{
		Blocks:           homeBlocks,
		Mempool:          homeMempool,
		BlockWeightLimit: info.Result.BlockWeightLimit,
	}, nil
}

func GetBlock(r *http.Request, c *client.Client) (*data.Block, error) {

	var blockData *data.GetBlockResponse
	var err error
	heightParam := chi.URLParam(r, "height")

	if heightParam != "" {
		u, parseErr := strconv.ParseUint(heightParam, 10, 64)
		if parseErr != nil {
			return nil, fmt.Errorf("failed to convert height to a number: %w", parseErr)
		}
		blockData, err = c.GetBlock(u)
	} else {
		hashParam := chi.URLParam(r, "hash")
		if hashParam == "" {
			return nil, fmt.Errorf("neither height nor hash provided")
		}
		blockData, err = c.GetBlockByHash(hashParam)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Block from RPC: %w", err)
	}

	var rawBlock data.RawBlock
	err = json.Unmarshal([]byte(blockData.Result.Json), &rawBlock)
	if err != nil {
		return nil, fmt.Errorf("Failed to unmarshal block JSON string into RawBlock struct: %w", err)
	}

	var txs []data.MinimalTransaction
	minimalTxs, err := c.GetRawMinimalTransactions(blockData.Result.TxHashes)
	if err != nil {
		return nil, fmt.Errorf("Failed to get minimalTransactions: %w", err)
	}

	minerTxSize, err := c.GetMinerTransactionSize(blockData.Result.BlockHeader.MinerTxHash)
	if err != nil {
		return nil, fmt.Errorf("Failed to get miner transaction size: %w", err)
	}

	var lowestFee uint64 = 0
	var highestFee uint64 = 0
	var totalFees uint64 = 0

	for i := range minimalTxs {
		currentFee := minimalTxs[i].Fee

		if i == 0 {
			lowestFee = currentFee
			highestFee = currentFee
		} else {
			if currentFee < lowestFee {
				lowestFee = currentFee
			}
			if currentFee > highestFee {
				highestFee = currentFee
			}
		}

		txs = append(txs, data.MinimalTransaction{
			Hash: minimalTxs[i].Hash,
			Size: minimalTxs[i].Size,
			Fee:  float64(currentFee) / 1_000_000_000_000.0,
			In:   minimalTxs[i].NumInputs,
			Out:  minimalTxs[i].NumOutputs,
		})
		totalFees += currentFee
	}

	header := blockData.Result.BlockHeader
	block := &data.Block{
		Height:       header.Height,
		Hash:         header.Hash,
		Timestamp:    GetFormattedDateTime(header.Timestamp),
		RelativeTime: GetRelativeTime(header.Timestamp),
		BlockSize:    float64(header.BlockSize) / 1024.0,
		Depth:        header.Depth,
		Nonce:        header.Nonce,
		MinerTx: data.MinerTransaction{
			Hash:    blockData.Result.BlockHeader.MinerTxHash,
			Size:    minerTxSize,
			Outputs: GetTotalOutputs(rawBlock.MinerTx.Vout),
		},
		Transactions: txs,
		TotalFees:    float64(totalFees) / 1_000_000_000_000.0,
		MinFee:       float64(lowestFee) / 1_000_000_000_000.0,
		MaxFee:       float64(highestFee) / 1_000_000_000_000.0,
		Status:       blockData.Result.Status,
	}

	return block, nil
}

func GetBlocks(page int, c *client.Client) (*data.BlocksResponse, error) {
	pageSize := 25
	info, err := c.GetInfo()
	if err != nil {
		return nil, fmt.Errorf("failed to get node info: %w", err)
	}

	chainHeight := info.Result.Height

	if page < 1 {
		page = 1
	}

	lastBlockIndex := chainHeight - 1
	endHeight := int64(lastBlockIndex) - int64(page-1)*int64(pageSize)
	startHeight := endHeight - int64(pageSize) + 1

	if endHeight < 0 {
		return &data.BlocksResponse{
			Blocks:      []data.BlockListEntry{},
			Page:        page,
			TotalPages:  int((chainHeight + uint64(pageSize) - 1) / uint64(pageSize)),
			TotalBlocks: chainHeight,
		}, nil
	}

	if startHeight < 0 {
		startHeight = 0
	}

	headersResp, err := c.GetBlockHeadersRange(uint64(startHeight), uint64(endHeight))
	if err != nil {
		return nil, fmt.Errorf("failed to get block headers: %w", err)
	}

	var blocks []data.BlockListEntry
	for i := len(headersResp.Result.Headers) - 1; i >= 0; i-- {
		h := headersResp.Result.Headers[i]
		blocks = append(blocks, data.BlockListEntry{
			Height:       h.Height,
			Hash:         h.Hash,
			Timestamp:    GetFormattedDateTime(h.Timestamp),
			TimestampRaw: h.Timestamp,
			RelativeTime: GetRelativeTime(h.Timestamp),
			Size:         float64(h.BlockSize) / 1024.0,
			TxCount:      h.NumTxes,
			Reward:       float64(h.Reward) / 1_000_000_000_000.0,
		})
	}

	totalPages := int((chainHeight + uint64(pageSize) - 1) / uint64(pageSize))

	return &data.BlocksResponse{
		Blocks:      blocks,
		Page:        page,
		TotalPages:  totalPages,
		TotalBlocks: chainHeight,
	}, nil
}

func GetTransaction(r *http.Request, c *client.Client) (*data.Transaction, error) {
	hash := chi.URLParam(r, "hash")

	txData, err := c.GetTransaction(hash)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Transaction from RPC: %w", err)
	}

	return processTransaction(txData, c, true)
}

func GetTransactionLite(r *http.Request, c *client.Client) (*data.Transaction, error) {
	hash := chi.URLParam(r, "hash")

	txData, err := c.GetTransaction(hash)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Transaction from RPC: %w", err)
	}

	return &data.Transaction{
		TxHash:      txData.TxHash,
		BlockHeight: txData.BlockHeight,
	}, nil
}

func GetTransactionJSON(r *http.Request, c *client.Client) (map[string]any, error) {
	hash := chi.URLParam(r, "hash")

	txData, err := c.GetTransaction(hash)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Transaction from RPC: %w", err)
	}

	var result map[string]any
	if err := json.Unmarshal([]byte(txData.AsJSON), &result); err != nil {
		return nil, fmt.Errorf("failed to unmarshal transaction JSON: %w", err)
	}

	return result, nil
}

func GetBlockLite(r *http.Request, c *client.Client) (*data.Block, error) {
	var blockData *data.GetBlockResponse
	var err error
	heightParam := chi.URLParam(r, "height")

	if heightParam != "" {
		u, parseErr := strconv.ParseUint(heightParam, 10, 64)
		if parseErr != nil {
			return nil, fmt.Errorf("failed to convert height to a number: %w", parseErr)
		}
		blockData, err = c.GetBlock(u)
	} else {
		hashParam := chi.URLParam(r, "hash")
		if hashParam == "" {
			return nil, fmt.Errorf("neither height nor hash provided")
		}
		blockData, err = c.GetBlockByHash(hashParam)
	}

	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Block from RPC: %w", err)
	}

	return &data.Block{
		Height: blockData.Result.BlockHeader.Height,
		Hash:   blockData.Result.BlockHeader.Hash,
	}, nil
}

func GetTransactions(hashes []string, c *client.Client) ([]*data.Transaction, error) {
	txsData, err := c.GetTransactions(hashes)
	if err != nil {
		return nil, fmt.Errorf("failed to retrieve Transactions from RPC: %w", err)
	}

	var transactions []*data.Transaction
	for _, txData := range txsData {
		processedTx, err := processTransaction(&txData, c, false)
		if err != nil {
			fmt.Printf("error processing transaction %s: %v\n", txData.TxHash, err)
			continue
		}
		transactions = append(transactions, processedTx)
	}

	return transactions, nil
}

func processTransaction(txData *data.Tx, c *client.Client, includeCoinbase bool) (*data.Transaction, error) {
	var txDetail data.TransactionDetail
	err := json.Unmarshal([]byte(txData.AsJSON), &txDetail)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal transaction JSON: %w", err)
	}

	var inputs []data.TxInput

	globalIndices := make([]int, 0)
	ringMemberIndexMap := make(map[int]*data.RingMember)

	var allOutRequests []data.OutRequest
	type inputInfo struct {
		keyImage        string
		amount          uint64
		absoluteOffsets []int
	}
	var inputsInfo []inputInfo

	for _, vin := range txDetail.Vin {
		absoluteOffsets := make([]int, len(vin.Key.KeyOffsets))
		if len(vin.Key.KeyOffsets) > 0 {
			absoluteOffsets[0] = vin.Key.KeyOffsets[0]
			for i := 1; i < len(vin.Key.KeyOffsets); i++ {
				absoluteOffsets[i] = absoluteOffsets[i-1] + vin.Key.KeyOffsets[i]
			}
		}

		for _, offset := range absoluteOffsets {
			allOutRequests = append(allOutRequests, data.OutRequest{
				Amount: uint64(vin.Key.Amount),
				Index:  uint64(offset),
			})
		}

		inputsInfo = append(inputsInfo, inputInfo{
			keyImage:        vin.Key.KImage,
			amount:          uint64(vin.Key.Amount),
			absoluteOffsets: absoluteOffsets,
		})
	}

	var allOuts []data.Out
	batchSize := 500
	for i := 0; i < len(allOutRequests); i += batchSize {
		end := min(i+batchSize, len(allOutRequests))

		batch := allOutRequests[i:end]
		outsResp, err := c.GetOutsMixed(batch)
		if err != nil {
			return nil, fmt.Errorf("failed to get outs for transaction inputs (batch %d-%d): %w", i, end, err)
		}
		allOuts = append(allOuts, outsResp.Outs...)
	}

	outsIndex := 0
	for _, info := range inputsInfo {
		var currentRingMembers []data.RingMember
		offsetCount := len(info.absoluteOffsets)
		endIndex := outsIndex + offsetCount

		if endIndex > len(allOuts) {
			return nil, fmt.Errorf("mismatch in batched outs response length")
		}

		for k := range offsetCount {
			out := allOuts[outsIndex+k]
			currentRingMembers = append(currentRingMembers, data.RingMember{
				Hash:              out.Key,
				BlockHeight:       int(out.Height),
				ParentTransaction: out.TxID,
			})
		}

		inputs = append(inputs, data.TxInput{
			KeyImage:    info.keyImage,
			Amount:      info.amount,
			RingMembers: currentRingMembers,
		})

		currentInputIndex := len(inputs) - 1
		for j, globalIdx := range info.absoluteOffsets {
			if _, exists := ringMemberIndexMap[globalIdx]; !exists {
				globalIndices = append(globalIndices, globalIdx)
				ringMemberIndexMap[globalIdx] = &inputs[currentInputIndex].RingMembers[j]
			}
		}

		outsIndex = endIndex
	}

	if includeCoinbase {
		parentHashesMap := make(map[string]struct{})
		for _, input := range inputs {
			for _, rm := range input.RingMembers {
				parentHashesMap[rm.ParentTransaction] = struct{}{}
			}
		}

		var parentHashes []string
		for h := range parentHashesMap {
			parentHashes = append(parentHashes, h)
		}

		if len(parentHashes) > 0 {
			coinbaseStatus, err := c.GetCoinbaseStatus(parentHashes)
			if err != nil {
				fmt.Printf("Warning: failed to get coinbase status: %v\n", err)
			} else {
				for i := range inputs {
					for j := range inputs[i].RingMembers {
						parentTx := inputs[i].RingMembers[j].ParentTransaction
						if isCoinbase, ok := coinbaseStatus[parentTx]; ok {
							inputs[i].RingMembers[j].IsCoinbase = isCoinbase
						}
					}
				}
			}
		}
	}

	if len(globalIndices) > 0 {
		decoyCounts, err := c.GetDecoyCounts(globalIndices)
		if err != nil {
			fmt.Printf("Warning: failed to get decoy counts: %v\n", err)
		} else {
			for idStr, count := range decoyCounts {
				idInt, _ := strconv.Atoi(idStr)
				if ringMember, ok := ringMemberIndexMap[idInt]; ok {
					ringMember.DecoyCount = count
				}
			}
		}
	}

	var outputs []data.TxOutput
	for i, vout := range txDetail.Vout {
		outputIndex := -1
		if i < len(txData.OutputIndices) {
			outputIndex = txData.OutputIndices[i]
		}

		stealthAddress := vout.Target.Key
		var viewTag string
		if stealthAddress == "" {
			stealthAddress = vout.Target.TaggedKey.Key
			viewTag = vout.Target.TaggedKey.ViewTag
		}

		outputs = append(outputs, data.TxOutput{
			StealthAddress: stealthAddress,
			ViewTag:        viewTag,
			Amount:         uint64(vout.Amount),
			OutputIndex:    outputIndex,
		})
	}

	extraBytes := make([]byte, len(txDetail.Extra))
	for i, v := range txDetail.Extra {
		extraBytes[i] = byte(v)
	}
	extraHex := hex.EncodeToString(extraBytes)

	fee := txDetail.RctSignatures.TxnFee
	if fee == 0 {
		var inSum uint64 = 0
		for _, in := range txDetail.Vin {
			inSum += uint64(in.Key.Amount)
		}
		var outSum uint64 = 0
		for _, out := range txDetail.Vout {
			outSum += uint64(out.Amount)
		}
		if inSum > outSum {
			fee = int(inSum - outSum)
		}
	}

	transaction := &data.Transaction{
		BlockHeight:    txData.BlockHeight,
		BlockTimestamp: txData.BlockTimestamp,
		RelativeTime:   GetRelativeTime(uint64(txData.BlockTimestamp)),
		Confirmations:  txData.Confirmations,
		Version:        txDetail.Version,
		Inputs:         inputs,
		Outputs:        outputs,
		TxHash:         txData.TxHash,
		Extra:          extraHex,
		Type:           txDetail.RctSignatures.Type,
		TxnFee:         fee,
		Size:           float64(len(txData.AsHex)) / 2 / 1024.0,
	}

	return transaction, nil
}

func AutomateOutputMerging(initialHashes []string, c *client.Client) ([][]*data.Transaction, error) {
	var allStepsDuplicates [][]string
	currentHashes := initialHashes

	for {
		if len(currentHashes) == 0 {
			break
		}

		resp, err := http.Get(data.DatagenBaseURL + "/batchTxs?hashes=" + strings.Join(currentHashes, ","))
		if err != nil {
			return nil, fmt.Errorf("failed to call datagen batchTxs: %w", err)
		}
		defer resp.Body.Close()

		var datagenResp map[string][]string
		if err := json.NewDecoder(resp.Body).Decode(&datagenResp); err != nil {
			return nil, fmt.Errorf("failed to decode datagen response: %w", err)
		}

		hashCounts := make(map[string]int)
		for _, hashes := range datagenResp {
			for _, hash := range hashes {
				hashCounts[hash]++
			}
		}

		var duplicates []string
		for hash, count := range hashCounts {
			if count > 1 {
				duplicates = append(duplicates, hash)
			}
		}

		if len(duplicates) == 0 {
			break
		}

		allStepsDuplicates = append(allStepsDuplicates, duplicates)
		currentHashes = duplicates
	}

	var result [][]*data.Transaction

	initialTxs, err := GetTransactions(initialHashes, c)
	if err != nil {
		return nil, fmt.Errorf("failed to get initial transactions: %w", err)
	}
	result = append(result, initialTxs)

	for _, stepDuplicates := range allStepsDuplicates {
		txs, err := GetTransactions(stepDuplicates, c)
		if err != nil {
			return nil, fmt.Errorf("failed to get transactions for step: %w", err)
		}
		result = append(result, txs)
	}

	for i := len(result) - 1; i > 0; i-- {
		currentStep := result[i]
		previousStep := result[i-1]

		neededParentHashes := make(map[string]bool)
		for _, tx := range currentStep {
			for _, input := range tx.Inputs {
				for _, rm := range input.RingMembers {
					neededParentHashes[rm.ParentTransaction] = true
				}
			}
		}

		var prunedPreviousStep []*data.Transaction
		for _, tx := range previousStep {
			if neededParentHashes[tx.TxHash] {
				prunedPreviousStep = append(prunedPreviousStep, tx)
			}
		}
		result[i-1] = prunedPreviousStep
	}

	return result, nil
}
