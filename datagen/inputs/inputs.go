package inputs

import (
	"bytes"
	"database/sql"
	"encoding/gob"
	"encoding/hex"
	"fmt"
	"log"
	"sync"

	"github.com/dnvie/MoneroVis/datagen/outputs"

	_ "github.com/mattn/go-sqlite3"
)

type InputOffsets struct {
	KeyOffsets []uint64
}

type BlockBatch struct {
	BlockHeight uint64
	Rows        []struct {
		TxHash         string
		KeyOffsetsBlob []byte
	}
}

const metadataKey = "last_processed_input_block"

func Generate(isPi bool, db *sql.DB, client *outputs.Client) {

	var startIndex uint64 = 0
	row := db.QueryRow("SELECT value FROM metadata WHERE key = ?", metadataKey)
	var lastProcessedBlock sql.NullInt64
	if err := row.Scan(&lastProcessedBlock); err != nil {
		if err != sql.ErrNoRows {
			log.Fatalf("Failed to get last processed block from metadata: %v", err)
		}
	}
	if lastProcessedBlock.Valid {
		startIndex = uint64(lastProcessedBlock.Int64) + 1
	}

	endIndex := client.GetBlockCount()
	fmt.Printf("Starting input processing from block %d up to %d\n", startIndex, endIndex)

	if startIndex >= endIndex {
		fmt.Println("Inputs database is up-to-date.")
		return
	}

	const numWorkers = 8
	jobs := make(chan uint64, numWorkers*2)
	results := make(chan BlockBatch, numWorkers*2)

	var wg sync.WaitGroup

	for w := range numWorkers {
		wg.Add(1)
		go worker(w, client, jobs, results, &wg)
	}

	writerDone := make(chan struct{})
	go writer(db, results, writerDone)

	for i := startIndex; i < endIndex; i++ {
		jobs <- i
	}
	close(jobs)

	wg.Wait()
	close(results)
	<-writerDone

	fmt.Printf("Main processing complete. Final block processed: %d\n", endIndex-1)

	if !isPi {
		fmt.Printf("Checking for gaps, starting from block %d\n", startIndex)
		FindGaps(client, int64(startIndex), db)
	}

	metaStmt, err := db.Prepare(`INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;
	`)
	if err != nil {
		log.Fatalf("Failed to prepare final metadata statement: %v", err)
	}
	defer metaStmt.Close()

	if _, err := metaStmt.Exec(metadataKey, endIndex-1); err != nil {
		log.Fatalf("Failed to write final metadata: %v", err)
	}

	fmt.Printf("Metadata updated to block %d. All processing complete.\n", endIndex-1)
}

func worker(id int, client *outputs.Client, jobs <-chan uint64, results chan<- BlockBatch, wg *sync.WaitGroup) {
	defer wg.Done()

	for blockHeight := range jobs {
		block := client.GetBlock(blockHeight)
		txHashesStr := getAllTxsFromBlock(block)
		if len(txHashesStr) == 0 {
			continue
		}

		txs := client.GetTransactions(txHashesStr)
		inputs := ExtractKeyOffsets(txs)

		batch := BlockBatch{
			BlockHeight: blockHeight,
			Rows: make([]struct {
				TxHash         string
				KeyOffsetsBlob []byte
			}, 0),
		}

		for hash, offsets := range inputs {
			for _, offset := range offsets {
				var keyOffsetsBuffer bytes.Buffer
				encoder := gob.NewEncoder(&keyOffsetsBuffer)

				if err := encoder.Encode(offset.KeyOffsets); err != nil {
					log.Printf("[Worker %d] Failed to encode key offsets for block %d: %v", id, blockHeight, err)
					continue
				}

				batch.Rows = append(batch.Rows, struct {
					TxHash         string
					KeyOffsetsBlob []byte
				}{
					TxHash:         hash,
					KeyOffsetsBlob: keyOffsetsBuffer.Bytes(),
				})
			}
		}
		results <- batch
	}
}

func writer(db *sql.DB, results <-chan BlockBatch, done chan<- struct{}) {
	defer close(done)
	var totalRowsInserted uint64 = 0

	insertStmt, err := db.Prepare("INSERT INTO inputs (tx_hash, key_offsets, block_height) VALUES (?, ?, ?)")
	if err != nil {
		log.Fatalf("Writer failed to prepare insert statement: %v", err)
	}
	defer insertStmt.Close()

	for batch := range results {
		tx, err := db.Begin()
		if err != nil {
			log.Fatalf("Failed to begin transaction for block %d: %v", batch.BlockHeight, err)
		}

		txInsertStmt := tx.Stmt(insertStmt)

		for _, row := range batch.Rows {
			txHashBytes, err := hex.DecodeString(row.TxHash)
			if err != nil {
				log.Printf("Error decoding tx_hash %s, skipping: %v", row.TxHash, err)
				continue
			}
			if _, err := txInsertStmt.Exec(txHashBytes, row.KeyOffsetsBlob, batch.BlockHeight); err != nil {
				tx.Rollback()
				log.Fatalf("Failed to insert row in batch for block %d: %v", batch.BlockHeight, err)
			}
			totalRowsInserted++
		}

		if err := tx.Commit(); err != nil {
			log.Fatalf("Failed to commit batch transaction for block %d: %v", batch.BlockHeight, err)
		}

		if batch.BlockHeight%1000 <= 5 {
			fmt.Printf("[Writer] Block %d committed. Total rows inserted: %d\n", batch.BlockHeight, totalRowsInserted)
		}
	}
}

func getAllTxsFromBlock(block map[string]any) []string {
	allTxs := []string{}
	rawHashes, ok := block["tx_hashes"].([]any)
	if !ok {
		return allTxs
	}

	for _, h := range rawHashes {
		hash, ok := h.(string)
		if !ok {
			log.Fatalf("tx_hashes contains non-string element")
		}
		allTxs = append(allTxs, hash)
	}
	return allTxs
}

func ExtractKeyOffsets(txs map[string]map[string]any) map[string][]InputOffsets {
	offsetsMap := make(map[string][]InputOffsets, len(txs))

	for txHash, txBody := range txs {
		var txInputOffsets []InputOffsets

		rawVin, ok := txBody["vin"]
		if !ok {
			continue
		}

		vinArray, ok := rawVin.([]any)
		if !ok {
			log.Fatalf("Fatal Error: Transaction %s 'vin' is not an array type (%T). Expected []any.", txHash, rawVin)
		}

		for _, rawInput := range vinArray {
			inputMap, ok := rawInput.(map[string]any)
			if !ok {
				log.Fatalf("Fatal Error: Transaction %s input is not a map type. Expected map[string]any.", txHash)
			}

			rawKey, ok := inputMap["key"]
			if !ok {
				continue
			}

			keyMap, ok := rawKey.(map[string]any)
			if !ok {
				log.Fatalf("Fatal Error: Transaction %s input 'key' exists but is not a map type.", txHash)
			}

			rawOffsets, ok := keyMap["key_offsets"]
			if !ok {
				continue
			}

			offsetsArray, ok := rawOffsets.([]any)
			if !ok {
				log.Fatalf("Fatal Error: Transaction %s 'key_offsets' is not an array type.", txHash)
			}

			var currentInputOffsets []uint64
			for _, rawOffset := range offsetsArray {
				offsetFloat, ok := rawOffset.(float64)
				if !ok {
					log.Fatalf("Fatal Error: Transaction %s offset is not a float64.", txHash)
				}
				currentInputOffsets = append(currentInputOffsets, uint64(offsetFloat))
			}

			txInputOffsets = append(txInputOffsets, InputOffsets{
				KeyOffsets: currentInputOffsets,
			})
		}

		offsetsMap[txHash] = txInputOffsets
	}

	return offsetsMap
}

func FindGaps(client *outputs.Client, startHeight int64, db *sql.DB) {
	query := `SELECT DISTINCT block_height
			  FROM inputs
			  WHERE block_height >= ?
			  ORDER BY block_height`
	rows, err := db.Query(query, startHeight)
	if err != nil {
		log.Fatalf("FindGaps query failed: %v", err)
	}
	defer rows.Close()

	var last int64 = -1
	var totalMissing int64 = 0

	if startHeight > 0 {
		last = startHeight - 1
	}

	for rows.Next() {
		var h int64
		if err := rows.Scan(&h); err != nil {
			log.Fatalf("FindGaps row scan failed: %v", err)
		}

		if last != -1 && h != last+1 {
			start := last + 1
			end := h - 1

			fmt.Printf("Detected gap between blocks %d and %d. Checking for transactions in these blocks...\n", last, h)

			for i := start; i <= end; i++ {
				block := client.GetBlock(uint64(i))
				txs := getAllTxsFromBlock(block)
				if len(txs) > 0 {
					fmt.Printf("--> Missing block with transactions: %d\n", i)
					totalMissing++
				}
			}
		}
		last = h
	}

	if totalMissing == 0 {
		fmt.Println("No missing blocks found in inputs database.")
	} else {
		fmt.Printf("Total missing blocks with transactions: %d\n", totalMissing)
	}
}
