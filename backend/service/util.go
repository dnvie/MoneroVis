package service

import (
	"time"

	"github.com/dnvie/MoneroVis/backend/data"
	"github.com/nleeper/goment"
)

func GetRelativeTime(timestamp uint64) string {
	g, _ := goment.New(time.UnixMilli(int64(timestamp) * 1000))
	relativeTime := g.FromNow()
	if relativeTime == "a few seconds ago" {
		relativeTime = "seconds ago"
	}
	return relativeTime
}

func GetFormattedDateTime(timestamp uint64) string {
	t := time.Unix(int64(timestamp), 0)

	g, err := goment.New(t)
	if err != nil {
		return "Invalid Time"
	}
	layout := "YYYY-MM-DD HH:mm:ss"
	formattedTime := g.Local().Format(layout)

	return formattedTime
}

func GetTotalOutputs(vout []data.RawVout) float64 {
	var res uint64 = 0
	for i := range vout {
		res += vout[i].Amount
	}
	return float64(res) / 1_000_000_000_000.0
}
