package outputs

import (
	"database/sql"
	"log"

	_ "github.com/mattn/go-sqlite3"
)

type MissingRange struct {
	Start uint64
	End   uint64
}

func FindGaps(startGlobalOutputIndex uint64, db *sql.DB) []MissingRange {
	rows, err := db.Query(`
			SELECT global_output_index
			FROM outputs
			WHERE global_output_index >= ?
			ORDER BY global_output_index ASC
		`, startGlobalOutputIndex)
	if err != nil {
		log.Fatalf("Query failed: %v", err)
	}
	defer rows.Close()

	var expected = startGlobalOutputIndex
	var found uint64
	var missing []MissingRange

	for rows.Next() {
		if err := rows.Scan(&found); err != nil {
			log.Fatalf("Row scan failed: %v", err)
		}

		if expected < found {
			missing = append(missing, MissingRange{
				Start: expected,
				End:   found - 1,
			})
		}

		expected = found + 1
	}

	if err := rows.Err(); err != nil {
		log.Fatalf("Row iteration error: %v", err)
	}

	return missing
}
