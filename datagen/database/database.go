package database

import (
	"database/sql"
	"log"

	_ "github.com/mattn/go-sqlite3"
)

func InitDb(isPi bool) *sql.DB {
	db, err := sql.Open("sqlite3", "database/monero.db")
	if err != nil {
		log.Fatalf("Failed to open SQLite database: %v", err)
	}

	var pragmas []string
	if isPi {
		log.Println("Applying Raspberry Pi specific, concurrency-safe optimizations")
		pragmas = []string{
			"PRAGMA journal_mode=WAL;",
			"PRAGMA synchronous=NORMAL;",
			"PRAGMA busy_timeout = 5000;",
			"PRAGMA cache_size=-512000;",
			"PRAGMA mmap_size=2000000000;",
			"PRAGMA foreign_keys=ON;",
		}
	} else {
		log.Println("Applying high-performance PC optimizations")
		pragmas = []string{
			"PRAGMA journal_mode=WAL;",
			"PRAGMA synchronous=OFF;",
			"PRAGMA temp_store=MEMORY;",
			"PRAGMA mmap_size=30000000000;",
			"PRAGMA cache_size=-10000000;", // ~10GB
			"PRAGMA foreign_keys=ON;",
			"PRAGMA busy_timeout = 5000;",
		}
	}

	for _, p := range pragmas {
		if _, err := db.Exec(p); err != nil {
			log.Printf("Failed to set PRAGMA %s: %v", p, err)
		}
	}

	queries := []string{
		`CREATE TABLE IF NOT EXISTS outputs (
			global_output_index INTEGER PRIMARY KEY,
			lookup_hash BLOB NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS inputs (
			input_id INTEGER PRIMARY KEY,
			tx_hash BLOB NOT NULL,
			key_offsets BLOB NOT NULL,
			block_height INTEGER NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS ring_members (
			output_id INTEGER NOT NULL,
			tx_hash BLOB NOT NULL,
			input_id INTEGER NOT NULL,
			PRIMARY KEY (output_id, tx_hash, input_id)
		) WITHOUT ROWID;`,
		`CREATE TABLE IF NOT EXISTS coinbase_txs (
    		tx_hash TEXT PRIMARY KEY
      	) WITHOUT ROWID`,
		`CREATE INDEX IF NOT EXISTS idx_ring_members_reverse ON ring_members(tx_hash, input_id, output_id);`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_outputs_lookup_hash ON outputs(lookup_hash);`,
		`CREATE TABLE IF NOT EXISTS metadata (
			key TEXT PRIMARY KEY,
			value INTEGER NOT NULL
		);`,
	}

	for _, q := range queries {
		if _, err = db.Exec(q); err != nil {
			log.Fatalf("Failed to execute schema query: %v", err)
		}
	}

	log.Println("Database 'monero.db' initialized successfully.")
	return db
}
