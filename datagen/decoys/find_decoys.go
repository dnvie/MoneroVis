package decoys

import (
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"strings"

	"github.com/dnvie/MoneroVis/datagen/client"
	_ "github.com/mattn/go-sqlite3"
)

type GraphData struct {
	MainTransaction   *Transaction  `json:"mainTransaction,omitempty"`
	ChildTransactions []Transaction `json:"childTransactions"`
}

type Transaction struct {
	ID      string   `json:"id"`
	Inputs  []Input  `json:"inputs"`
	Outputs []Output `json:"outputs,omitempty"`
}

type Input struct {
	ID                 string       `json:"id"`
	SourceRingMemberID string       `json:"sourceRingMemberId,omitempty"`
	RingMembers        []RingMember `json:"ringMembers"`
}

type RingMember struct {
	ID          string `json:"id"`
	IsTrueSpend bool   `json:"isTrueSpend,omitempty"`
}

type Output struct {
	ID string `json:"id"`
}

func getAbsoluteOffsets(keyOffsets []uint64) []uint64 {
	absoluteOffsets := make([]uint64, len(keyOffsets))
	if len(keyOffsets) > 0 {
		absoluteOffsets[0] = keyOffsets[0]
		for i := 1; i < len(keyOffsets); i++ {
			absoluteOffsets[i] = absoluteOffsets[i-1] + keyOffsets[i]
		}
	}
	return absoluteOffsets
}

func BuildGraphDataNew(db *sql.DB, c *client.Client, mainTxHash, trueSpendKey string, globalOutputIndex int64) (*GraphData, error) {

	childTxHashes, err := findTransactionsUsingIndex(db, globalOutputIndex)
	if err != nil {
		return nil, fmt.Errorf("Could not find transactions using global_output_index: %v", err)
	}
	fmt.Printf("Found %d potential child transactions.\n", len(childTxHashes))

	if len(childTxHashes) > 100 {
		return nil, fmt.Errorf("too many child transactions found (%d), aborting request for performance reasons", len(childTxHashes))
	}

	graphData := &GraphData{}

	allTxHashes := []string{mainTxHash}
	uniqueHashes := map[string]bool{mainTxHash: true}

	for _, h := range childTxHashes {
		if !uniqueHashes[h] {
			allTxHashes = append(allTxHashes, h)
			uniqueHashes[h] = true
		}
	}

	fmt.Printf("Fetching %d transactions from Daemon...\n", len(allTxHashes))
	rawTxsMap, err := c.GetTransactions(allTxHashes)
	if err != nil {
		return nil, fmt.Errorf("RPC Batch GetTransactions failed: %v", err)
	}
	fmt.Println("Retrieved transactions from daemon")

	neededIndices := make(map[uint64]bool)

	for _, rawTx := range rawTxsMap {
		for _, vin := range rawTx.Vin {
			absOffsets := getAbsoluteOffsets(vin.Key.KeyOffsets)
			for _, offset := range absOffsets {
				neededIndices[offset] = true
			}
		}
	}

	var indicesToFetch []uint64
	for idx := range neededIndices {
		indicesToFetch = append(indicesToFetch, idx)
	}

	fmt.Printf("Resolving %d unique ring members...\n", len(indicesToFetch))

	const batchSize = 500
	totalIndices := len(indicesToFetch)

	var allOuts []client.Output

	for i := 0; i < totalIndices; i += batchSize {
		end := min(i+batchSize, totalIndices)

		batch := indicesToFetch[i:end]

		batchOuts, err := c.GetOutsBatch(batch)
		if err != nil {
			return nil, fmt.Errorf("RPC Batch GetOutsBatch failed at index %d: %v", i, err)
		}

		allOuts = append(allOuts, batchOuts...)
	}

	outsList := allOuts

	globalKeyMap := make(map[uint64]string)

	if len(outsList) != len(indicesToFetch) {
		return nil, fmt.Errorf("RPC Mismatch: requested %d indices but got %d outputs",
			len(indicesToFetch), len(outsList))
	}

	for i, out := range outsList {
		originalIndex := indicesToFetch[i]
		globalKeyMap[originalIndex] = out.Key
	}

	buildTransaction := func(txHash string, isMain bool) (Transaction, error) {
		rawTx, ok := rawTxsMap[txHash]
		if !ok {
			return Transaction{}, fmt.Errorf("tx %s missing from RPC response", txHash)
		}

		processedTx := Transaction{ID: txHash}

		for _, vin := range rawTx.Vin {
			input := Input{
				ID:          vin.Key.KImage,
				RingMembers: []RingMember{},
			}

			absOffsets := getAbsoluteOffsets(vin.Key.KeyOffsets)

			for _, offset := range absOffsets {
				key, found := globalKeyMap[offset]
				if !found {
					key = "?"
					log.Printf("Warning: Key for index %d missing in batch response", offset)
				}

				rm := RingMember{ID: key}
				if key == trueSpendKey {
					rm.IsTrueSpend = true
				}
				input.RingMembers = append(input.RingMembers, rm)
			}
			processedTx.Inputs = append(processedTx.Inputs, input)
		}

		if isMain {
			for _, vout := range rawTx.Vout {
				key := vout.Target.GetKey()
				if key != "" {
					processedTx.Outputs = append(processedTx.Outputs, Output{ID: key})
				}
			}
		}

		return processedTx, nil
	}

	mainTxObj, err := buildTransaction(mainTxHash, true)
	if err != nil {
		return nil, err
	}
	graphData.MainTransaction = &mainTxObj

	for _, childHash := range childTxHashes {
		if childHash == mainTxHash {
			continue
		}

		childTxObj, err := buildTransaction(childHash, false)
		if err != nil {
			log.Printf("Skipping child tx %s: %v", childHash, err)
			continue
		}

		for i, inp := range childTxObj.Inputs {
			for _, rm := range inp.RingMembers {
				if rm.IsTrueSpend {
					childTxObj.Inputs[i].SourceRingMemberID = trueSpendKey
				}
			}
		}
		graphData.ChildTransactions = append(graphData.ChildTransactions, childTxObj)
	}
	fmt.Println("done")
	return graphData, nil
}

func findTransactionsUsingIndex(db *sql.DB, globalOutputIndex int64) ([]string, error) {
	rows, err := db.Query(`
		SELECT tx_hash
		FROM ring_members
		WHERE output_id = ?`, globalOutputIndex)
	if err != nil {
		return nil, fmt.Errorf("query error for finding decoy txs: %w", err)
	}
	defer rows.Close()

	var result []string
	for rows.Next() {
		var txHash []byte
		if err := rows.Scan(&txHash); err != nil {
			log.Printf("Warning: failed to scan tx_hash: %v", err)
			continue
		}
		result = append(result, hex.EncodeToString(txHash))
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during rows iteration: %w", err)
	}

	return result, nil
}

func BuildDecoyMapByIndex(db *sql.DB, c *client.Client, globalOutputIndex int64) (*GraphData, error) {

	targetOuts, err := c.GetOutsBatch([]uint64{uint64(globalOutputIndex)})
	if err != nil {
		return nil, fmt.Errorf("Could not fetch target output key: %v", err)
	}
	if len(targetOuts) == 0 {
		return nil, fmt.Errorf("Output index %d does not exist on chain", globalOutputIndex)
	}

	targetKey := targetOuts[0].Key

	childTxHashes, err := findTransactionsUsingIndex(db, globalOutputIndex)
	if err != nil {
		return nil, fmt.Errorf("Database query failed: %v", err)
	}
	fmt.Printf("Found %d transactions using output index %d.\n", len(childTxHashes), globalOutputIndex)

	if len(childTxHashes) > 100 {
		return nil, fmt.Errorf("too many transactions found (%d), aborting request for performance reasons", len(childTxHashes))
	}

	if len(childTxHashes) == 0 {
		return &GraphData{
			MainTransaction:   nil,
			ChildTransactions: []Transaction{},
		}, nil
	}

	fmt.Printf("Fetching details for %d child transactions...\n", len(childTxHashes))
	rawTxsMap, err := c.GetTransactions(childTxHashes)
	if err != nil {
		return nil, fmt.Errorf("RPC Batch GetTransactions failed: %v", err)
	}

	neededIndices := make(map[uint64]bool)

	neededIndices[uint64(globalOutputIndex)] = true

	for _, rawTx := range rawTxsMap {
		for _, vin := range rawTx.Vin {
			absOffsets := getAbsoluteOffsets(vin.Key.KeyOffsets)
			for _, offset := range absOffsets {
				neededIndices[offset] = true
			}
		}
	}

	var indicesToFetch []uint64
	for idx := range neededIndices {
		indicesToFetch = append(indicesToFetch, idx)
	}

	fmt.Printf("Resolving %d unique ring members...\n", len(indicesToFetch))

	const batchSize = 500
	var allOuts []client.Output

	for i := 0; i < len(indicesToFetch); i += batchSize {
		end := min(i+batchSize, len(indicesToFetch))

		batch := indicesToFetch[i:end]
		batchOuts, err := c.GetOutsBatch(batch)
		if err != nil {
			return nil, fmt.Errorf("RPC Batch GetOutsBatch failed at index %d: %v", i, err)
		}

		allOuts = append(allOuts, batchOuts...)
	}

	globalKeyMap := make(map[uint64]string)
	for i, out := range allOuts {
		if i < len(indicesToFetch) {
			globalKeyMap[indicesToFetch[i]] = out.Key
		}
	}

	graphData := &GraphData{}

	for _, childHash := range childTxHashes {
		rawTx, ok := rawTxsMap[childHash]
		if !ok {
			log.Printf("Warning: tx %s missing from RPC response, skipping.", childHash)
			continue
		}

		processedTx := Transaction{ID: childHash}

		for _, vin := range rawTx.Vin {
			input := Input{
				ID:          vin.Key.KImage,
				RingMembers: []RingMember{},
			}

			absOffsets := getAbsoluteOffsets(vin.Key.KeyOffsets)

			for _, offset := range absOffsets {
				key, found := globalKeyMap[offset]
				if !found {
					key = "?"
				}

				rm := RingMember{ID: key}

				if key == targetKey {
					rm.IsTrueSpend = true
					input.SourceRingMemberID = targetKey
				}

				input.RingMembers = append(input.RingMembers, rm)
			}
			processedTx.Inputs = append(processedTx.Inputs, input)
		}
		graphData.ChildTransactions = append(graphData.ChildTransactions, processedTx)
	}

	return graphData, nil
}

func FindTransactionsForIndices(db *sql.DB, outputIndices []int64) (map[int64][]string, error) {
	if len(outputIndices) == 0 {
		return make(map[int64][]string), nil
	}

	placeholders := make([]string, len(outputIndices))
	args := make([]any, len(outputIndices))
	for i, id := range outputIndices {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT output_id, tx_hash
		FROM ring_members
		WHERE output_id IN (%s)
		ORDER BY output_id, tx_hash`,
		strings.Join(placeholders, ","))

	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("query error fetching ring members: %w", err)
	}
	defer rows.Close()

	results := make(map[int64][]string, len(outputIndices))

	for rows.Next() {
		var outputID int64
		var txHashBytes []byte

		if err := rows.Scan(&outputID, &txHashBytes); err != nil {
			return nil, fmt.Errorf("scan error: %w", err)
		}

		txHashStr := hex.EncodeToString(txHashBytes)

		results[outputID] = append(results[outputID], txHashStr)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error during rows iteration: %w", err)
	}

	return results, nil
}
