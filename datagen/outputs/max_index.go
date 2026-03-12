package outputs

import (
	"bytes"
	"encoding/json"
)

func FindMaxOutputIndex(client *Client, start uint64) uint64 {
	low := start
	high := low + 1

	for {
		if !probeOutputIndex(client, high) {
			break
		}
		low = high
		high *= 2
	}

	for low < high {
		mid := (low + high + 1) / 2
		if probeOutputIndex(client, mid) {
			low = mid
		} else {
			high = mid - 1
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

	resp, err := client.client.Post(client.RPCURL+"/get_outs", "application/json", bytes.NewBuffer(body))
	if err != nil {
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
