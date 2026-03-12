package ring_members

import (
	"bytes"
	"database/sql"
	"encoding/gob"
	"fmt"
	"log"
	"runtime"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

type RingMember struct {
	input_id  uint64
	output_id uint64
	tx_hash   []byte
}

type InputRing struct {
	input_id     uint64
	tx_hash      []byte
	key_offsets  []byte
	block_height int
}

func Generate(isPi bool, db *sql.DB) {
	const metadataKey = "last_processed_ring_member_input_id"

	var startIndex uint64 = 0
	row := db.QueryRow("SELECT value FROM metadata WHERE key = ?", metadataKey)
	var lastProcessedInput sql.NullInt64
	if err := row.Scan(&lastProcessedInput); err != nil {
		if err != sql.ErrNoRows {
			log.Fatalf("Failed to get last processed input_id from metadata: %v", err)
		}
	}
	if lastProcessedInput.Valid {
		startIndex = uint64(lastProcessedInput.Int64)
	}

	var maxInputID uint64
	row = db.QueryRow("SELECT MAX(input_id) FROM inputs")
	if err := row.Scan(&maxInputID); err != nil {
		log.Fatalf("Failed to query max input_id from inputs: %v", err)
	}

	fmt.Println("Retrieved ending index: ", maxInputID)

	startID := startIndex + 1
	if startID > maxInputID {
		fmt.Println("All inputs already processed, nothing to do.")
		return
	}
	fmt.Printf("Resuming ring member generation from input_id %d (max %d)\n", startID, maxInputID)

	jobs := make(chan []InputRing, 10)
	results := make(chan []RingMember, 10)

	numWorkers := runtime.NumCPU()
	var wg sync.WaitGroup
	wg.Add(numWorkers)
	for range numWorkers {
		go func() {
			defer wg.Done()
			for batch := range jobs {
				var all []RingMember
				for _, input := range batch {
					all = append(all, processInputRing(input)...)
				}
				results <- all
			}
		}()
	}

	var writerWg sync.WaitGroup
	writerWg.Go(func() {
		stmt, err := db.Prepare("INSERT OR IGNORE INTO ring_members (output_id, tx_hash, input_id) VALUES (?, ?, ?)")
		if err != nil {
			log.Fatalf("Failed to prepare insert statement: %v", err)
		}
		defer stmt.Close()

		tx, err := db.Begin()
		if err != nil {
			log.Fatalf("Writer failed to begin transaction: %v", err)
		}

		txStmt := tx.Stmt(stmt)
		txCount := 0
		totalCount := 0
		var lastInputID uint64 = 0

		for rmBatch := range results {
			for _, rm := range rmBatch {
				_, err := txStmt.Exec(rm.output_id, rm.tx_hash, rm.input_id)
				if err != nil {
					tx.Rollback()
					log.Fatalf("Failed insert: %v", err)
				}
				txCount++
				totalCount++

				if totalCount%10000 == 0 {
					fmt.Printf("[Writer] Inserted %d total ring members...\n", totalCount)
				}

				if txCount >= 100000 && rm.input_id != lastInputID {
					if err := tx.Commit(); err != nil {
						log.Fatalf("Commit failed: %v", err)
					}
					tx, _ = db.Begin()
					txStmt = tx.Stmt(stmt)
					txCount = 0
				}
				lastInputID = rm.input_id
			}
		}

		if err := tx.Commit(); err != nil {
			log.Fatalf("Final commit failed: %v", err)
		}
	})

	const batchSize = 100_000
	for start := startID; start <= maxInputID; start += batchSize {
		end := min(start+batchSize-1, maxInputID)

		rows, err := db.Query("SELECT input_id, tx_hash, key_offsets, block_height FROM inputs WHERE input_id BETWEEN ? AND ?", start, end)
		if err != nil {
			log.Fatalf("Query failed: %v", err)
		}

		var batch []InputRing
		for rows.Next() {
			var in InputRing
			if err := rows.Scan(&in.input_id, &in.tx_hash, &in.key_offsets, &in.block_height); err != nil {
				log.Fatalf("Scan failed: %v", err)
			}
			batch = append(batch, in)
		}
		rows.Close()

		if len(batch) > 0 {
			jobs <- batch
		}

		if start%100000 == 1 || start == startID {
			fmt.Printf("Dispatched up to input_id %d\n", end)
		}
	}

	close(jobs)
	wg.Wait()
	close(results)
	writerWg.Wait()

	if startID <= maxInputID {
		metaStmt, err := db.Prepare(`INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;`)
		if err != nil {
			log.Fatalf("Failed to prepare final metadata statement: %v", err)
		}
		defer metaStmt.Close()

		if _, err := metaStmt.Exec(metadataKey, maxInputID); err != nil {
			log.Fatalf("Failed to write final metadata: %v", err)
		}

		fmt.Printf("Metadata updated to input_id %d. All processing complete.\n", maxInputID)
	}

	fmt.Println("ring_members database successfully processed.")
}

func processInputRing(input InputRing) []RingMember {
	buffer := bytes.NewBuffer(input.key_offsets)
	decoder := gob.NewDecoder(buffer)
	var decodedOffsets []uint64
	if err := decoder.Decode(&decodedOffsets); err != nil {
		log.Fatalf("Failed to decode key_offsets: %v", err)
	}

	globalOffsets := calculateKeyOffsets(decodedOffsets)

	var result []RingMember
	for _, out := range globalOffsets {
		result = append(result, RingMember{
			input_id:  input.input_id,
			output_id: out,
			tx_hash:   input.tx_hash,
		})
	}
	return result
}

func calculateKeyOffsets(offsets []uint64) []uint64 {
	result := make([]uint64, len(offsets))
	for i, off := range offsets {
		if i == 0 {
			result[i] = off
		} else {
			result[i] = off + result[i-1]
		}
	}
	return result
}
