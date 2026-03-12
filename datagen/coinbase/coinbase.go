package coinbase

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/dnvie/MoneroVis/datagen/client"
	"github.com/gorilla/websocket"
)

const (
	moneroNodeBaseURL = ""    // Add Monero Node URL
	wsURL             = "ws:" // Add Monero Node websocket URL
	batchSize         = 1000
)

func Start(db *sql.DB) {
	c := client.NewClient(moneroNodeBaseURL)

	log.Println("Starting Coinbase Tracker...")

	log.Println("Performing initial sync...")
	for {
		synced, err := Init(db, c)
		if err != nil {
			log.Printf("Initial sync warning: %v. Retrying in 5s...", err)
			time.Sleep(5 * time.Second)
			continue
		}
		if synced {
			break
		}
	}
	log.Println("Initial sync complete.")

	go Update(db, c)
	ticker := time.NewTicker(2 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		if _, err := Init(db, c); err != nil {
			log.Printf("Periodic sync error: %v", err)
		}
	}
}

func Init(db *sql.DB, c *client.Client) (bool, error) {
	var lastHeight uint64
	var startHeight uint64

	err := db.QueryRow("SELECT value FROM metadata WHERE key = 'coinbase_last_block'").Scan(&lastHeight)
	if err != nil {
		if err == sql.ErrNoRows {
			startHeight = 0
		} else {
			return false, fmt.Errorf("failed to query metadata: %w", err)
		}
	} else {
		startHeight = lastHeight + 1
	}

	networkHeight, err := c.GetInfo()
	if err != nil {
		return false, fmt.Errorf("failed to get node info: %w", err)
	}

	if networkHeight == 0 {
		return false, fmt.Errorf("node returned height 0, impossible")
	}
	targetHeight := networkHeight - 1

	if startHeight > targetHeight {
		return true, nil
	}

	log.Printf("Syncing from height %d to %d...", startHeight, targetHeight)

	currentHeight := startHeight

	for currentHeight <= targetHeight {
		endHeight := currentHeight + batchSize - 1
		if endHeight > targetHeight {
			endHeight = targetHeight
		}

		headers, err := c.GetBlockHeadersRange(currentHeight, endHeight)
		if err != nil {
			log.Printf("RPC Error fetching range %d-%d: %v", currentHeight, endHeight, err)
			time.Sleep(1 * time.Second)
			continue
		}

		txHashes := make([]string, 0, len(headers))
		for _, h := range headers {
			txHashes = append(txHashes, h.MinerTxHash)
		}

		if err := saveBatch(db, txHashes, endHeight); err != nil {
			return false, fmt.Errorf("failed to save batch ending at %d: %w", endHeight, err)
		}

		log.Printf("Synced range %d -> %d", currentHeight, endHeight)

		currentHeight = endHeight + 1
	}

	return false, nil
}

func Update(db *sql.DB, c *client.Client) {
	log.Printf("Connecting to WebSocket: %s", wsURL)

	for {
		err := listenOnce(db, c)

		log.Printf("WebSocket connection lost: %v. Reconnecting in 5s...", err)
		time.Sleep(5 * time.Second)
	}
}

func listenOnce(db *sql.DB, c *client.Client) error {
	conn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	log.Println("WebSocket connected. Listening for 'new_block' events...")

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			return fmt.Errorf("read error: %w", err)
		}

		var event struct {
			Event string          `json:"event"`
			Data  json.RawMessage `json:"data"`
		}

		if err := json.Unmarshal(message, &event); err != nil {
			continue
		}

		if event.Event == "new_block" {
			var blockData struct {
				Height float64 `json:"height"`
			}
			if err := json.Unmarshal(event.Data, &blockData); err == nil {
				processNewBlock(db, c, uint64(blockData.Height))
			}
		}
	}
}

func processNewBlock(db *sql.DB, c *client.Client, height uint64) {
	var minerTxHash string

	for i := 0; i < 5; i++ {
		resp, err := c.GetBlockHeaderByHeight(height)
		if err == nil && resp != nil {
			minerTxHash = resp.Result.BlockHeader.MinerTxHash
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	if minerTxHash == "" {
		log.Printf("Failed to fetch header for new block %d after retries", height)
		return
	}

	tx, err := db.Begin()
	if err != nil {
		log.Printf("DB Begin error: %v", err)
		return
	}

	_, err = tx.Exec("INSERT OR IGNORE INTO coinbase_txs (tx_hash) VALUES (?)", minerTxHash)
	if err != nil {
		tx.Rollback()
		log.Printf("Insert error for block %d: %v", height, err)
		return
	}

	_, err = tx.Exec("INSERT OR REPLACE INTO metadata (key, value) VALUES ('coinbase_last_block', ?)", height)
	if err != nil {
		tx.Rollback()
		log.Printf("Metadata update error for block %d: %v", height, err)
		return
	}

	if err := tx.Commit(); err != nil {
		log.Printf("DB Commit error for block %d: %v", height, err)
		return
	}

	log.Printf("Live Update: Added coinbase tx for block %d", height)
}

func saveBatch(db *sql.DB, hashes []string, endHeight uint64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}

	stmt, err := tx.Prepare("INSERT OR IGNORE INTO coinbase_txs (tx_hash) VALUES (?)")
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()

	for _, h := range hashes {
		if _, err := stmt.Exec(h); err != nil {
			log.Printf("Warning: Failed to insert hash %s: %v", h, err)
		}
	}

	_, err = tx.Exec("INSERT OR REPLACE INTO metadata (key, value) VALUES ('coinbase_last_block', ?)", endHeight)
	if err != nil {
		tx.Rollback()
		return err
	}

	return tx.Commit()
}
