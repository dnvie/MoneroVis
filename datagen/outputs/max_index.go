package outputs

import (
	"bytes"
	"encoding/json"
	"net/http"
)

func FindMaxOutputIndex(client *Client, start uint64) uint64 {

	if !probeOutputIndex(client, start) {
		return start - 1
	}

	low := start
	delta := uint64(1)
	for probeOutputIndex(client, low+delta) {
		low += delta
		delta *= 2
	}
	high := low + delta

	for low+1 < high {
		mid := (low + high) / 2
		if probeOutputIndex(client, mid) {
			low = mid
		} else {
			high = mid
		}
	}
	return low
}

func probeOutputIndex(client *Client, index uint64) bool {
	payload := map[string]any{
		"outputs": []map[string]any{{"amount": 0, "index": index}},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return false
	}

	client.rpcMu.Lock()
	resp, err := client.client.Post(client.RPCURL+"/get_outs", "application/json", bytes.NewBuffer(body))
	client.rpcMu.Unlock()
	if err != nil {
		return false
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false
	}

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false
	}

	status, _ := result["status"].(string)
	return status == "OK"
}
