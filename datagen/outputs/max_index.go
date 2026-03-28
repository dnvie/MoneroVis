package outputs

import (
	"bytes"
	"encoding/json"
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

	url, rpcerr := client.pool.Get()
	if rpcerr != nil {
		return false
	}

	resp, err := client.client.Post(url+"/get_outs", "application/json", bytes.NewBuffer(body))
	if err != nil {
		client.pool.ReportFailure(url, err)
		return false
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return false
	}

	status, _ := result["status"].(string)
	return status == "OK"
}
