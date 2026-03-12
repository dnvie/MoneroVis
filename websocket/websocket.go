package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pebbe/zmq4"
)

const (
	MoneroZmqAddr = "tcp://" // Add Monero Node ZMQ address
	WsPort        = 8085
)

type FrontendBlock struct {
	Height      float64  `json:"height"`
	Hash        string   `json:"hash"`
	Timestamp   uint64   `json:"timestamp"`
	TxCount     int      `json:"tx_count"`
	TotalReward uint64   `json:"total_reward"`
	TxHashes    []string `json:"tx_hashes"`
}

type FrontendTx struct {
	Hash    string  `json:"hash"`
	Fee     float64 `json:"fee"`
	Size    float64 `json:"size_bytes"`
	Inputs  int     `json:"inputs"`
	Outputs int     `json:"outputs"`
}

type PendingBlockBatch struct {
	Height  float64
	Full    []any
	Minimal map[string]any
	Created time.Time
}

type PendingTxBatch struct {
	Full    any
	Minimal any
	Created time.Time
}

var (
	clients     = make(map[*websocket.Conn]bool)
	wsMutex     sync.Mutex
	blockBuffer = make(map[float64]*PendingBlockBatch)
	txBuffer    = []*PendingTxBatch{}
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}

		host := u.Hostname()
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return true
		}
		if host == "monerovis.com" || strings.HasSuffix(host, ".monerovis.com") {
			return true
		}
		if host == "beta.monerovis.pages.dev" {
			return true
		}

		return false
	},
}

func main() {
	subscriber, err := zmq4.NewSocket(zmq4.SUB)
	if err != nil {
		log.Fatal(err)
	}
	defer subscriber.Close()

	if err := subscriber.Connect(MoneroZmqAddr); err != nil {
		log.Fatal(err)
	}

	subscriber.SetSubscribe("json-full-chain_main")
	subscriber.SetSubscribe("json-minimal-chain_main")
	subscriber.SetSubscribe("json-full-txpool_add")
	subscriber.SetSubscribe("json-minimal-txpool_add")

	fmt.Printf("Connected to Monero Node at %s\n", MoneroZmqAddr)
	fmt.Printf("WebSocket Server running on ws://localhost:%d\n", WsPort)

	go func() {
		for {
			msg, err := subscriber.Recv(0)
			if err != nil {
				continue
			}

			parts := strings.SplitN(msg, ":", 2)
			if len(parts) != 2 {
				continue
			}
			topic, payloadStr := parts[0], parts[1]

			var payload any
			if err := json.Unmarshal([]byte(payloadStr), &payload); err != nil {
				log.Println("JSON decode error:", err)
				continue
			}

			if strings.Contains(topic, "chain_main") {
				handleChainEvent(topic, payload)
			} else if strings.Contains(topic, "txpool_add") {
				handleTxEvent(topic, payload)
			}
		}
	}()

	http.HandleFunc("/", wsHandler)
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", WsPort), nil))
}

func handleTxEvent(topic string, data any) {
	txList, ok := data.([]any)
	if !ok {
		return
	}

	isFull := strings.Contains(topic, "full")

	for _, item := range txList {
		matched := false

		for i, pending := range txBuffer {
			if isFull && pending.Full == nil && pending.Minimal != nil {
				pending.Full = item
				finalizeTx(pending, i)
				matched = true
				break
			}
			if !isFull && pending.Minimal == nil && pending.Full != nil {
				pending.Minimal = item
				finalizeTx(pending, i)
				matched = true
				break
			}
		}

		if !matched {
			newEntry := &PendingTxBatch{Created: time.Now()}
			if isFull {
				newEntry.Full = item
			} else {
				newEntry.Minimal = item
			}
			txBuffer = append(txBuffer, newEntry)
		}
	}

	now := time.Now()
	var cleanBuffer []*PendingTxBatch
	for _, pending := range txBuffer {
		if now.Sub(pending.Created) < 15*time.Second {
			cleanBuffer = append(cleanBuffer, pending)
		}
	}
	txBuffer = cleanBuffer
}

func finalizeTx(p *PendingTxBatch, indexToRemove int) {
	txBuffer = append(txBuffer[:indexToRemove], txBuffer[indexToRemove+1:]...)

	fullMap, _ := p.Full.(map[string]any)
	minMap, _ := p.Minimal.(map[string]any)

	if fullMap == nil || minMap == nil {
		return
	}

	hash, _ := minMap["id"].(string)
	fee, _ := minMap["fee"].(float64)
	size, _ := minMap["blob_size"].(float64)

	inputCount := 0
	if inputs, ok := fullMap["inputs"].([]any); ok {
		inputCount = len(inputs)
	}

	outputCount := 0
	if outputs, ok := fullMap["outputs"].([]any); ok {
		outputCount = len(outputs)
	}

	cleanTx := FrontendTx{
		Hash:    hash,
		Fee:     fee,
		Size:    size,
		Inputs:  inputCount,
		Outputs: outputCount,
	}

	broadcast("new_transaction", cleanTx)
}

func handleChainEvent(topic string, data any) {
	var height float64
	var foundHeight bool

	if strings.Contains(topic, "minimal") {
		if m, ok := data.(map[string]any); ok {
			if h, ok := m["first_height"].(float64); ok {
				height = h
				foundHeight = true
			}
		}
	} else if strings.Contains(topic, "full") {
		if list, ok := data.([]any); ok && len(list) > 0 {
			if firstBlock, ok := list[0].(map[string]any); ok {
				if minerTx, ok := firstBlock["miner_tx"].(map[string]any); ok {
					if inputs, ok := minerTx["inputs"].([]any); ok && len(inputs) > 0 {
						if input0, ok := inputs[0].(map[string]any); ok {
							if gen, ok := input0["gen"].(map[string]any); ok {
								if h, ok := gen["height"].(float64); ok {
									height = h
									foundHeight = true
								}
							}
						}
					}
				}
			}
		}
	}

	if !foundHeight {
		return
	}

	if _, exists := blockBuffer[height]; !exists {
		blockBuffer[height] = &PendingBlockBatch{Height: height, Created: time.Now()}
	}
	entry := blockBuffer[height]

	if strings.Contains(topic, "full") {
		entry.Full = data.([]any)
	} else {
		entry.Minimal = data.(map[string]any)
	}

	if entry.Full != nil && entry.Minimal != nil {
		processAndBroadcastBlock(entry)
		delete(blockBuffer, height)
	}

	now := time.Now()
	for k, v := range blockBuffer {
		if now.Sub(v.Created) > 15*time.Second {
			delete(blockBuffer, k)
		}
	}
}

func processAndBroadcastBlock(batch *PendingBlockBatch) {
	idsRaw, ok := batch.Minimal["ids"].([]any)
	if !ok {
		return
	}

	for i, blockRaw := range batch.Full {
		if i >= len(idsRaw) {
			break
		}

		fullMap, ok := blockRaw.(map[string]any)
		if !ok {
			continue
		}

		blockHash, _ := idsRaw[i].(string)
		tsFloat, _ := fullMap["timestamp"].(float64)

		var txHashes []string = make([]string, 0)
		if txHashesRaw, ok := fullMap["tx_hashes"].([]any); ok {
			for _, item := range txHashesRaw {
				if h, ok := item.(string); ok {
					txHashes = append(txHashes, h)
				}
			}
		}
		txCount := len(txHashes)

		var totalReward uint64
		if minerTx, ok := fullMap["miner_tx"].(map[string]any); ok {
			if outputs, ok := minerTx["outputs"].([]any); ok {
				for _, out := range outputs {
					if outMap, ok := out.(map[string]any); ok {
						if amt, ok := outMap["amount"].(float64); ok {
							totalReward += uint64(amt)
						}
					}
				}
			}
		}

		cleanBlock := FrontendBlock{
			Height:      batch.Height + float64(i),
			Hash:        blockHash,
			Timestamp:   uint64(tsFloat),
			TxCount:     txCount,
			TotalReward: totalReward,
			TxHashes:    txHashes,
		}

		broadcast("new_block", cleanBlock)
	}
}

func wsHandler(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	wsMutex.Lock()
	clients[conn] = true
	wsMutex.Unlock()

	go func(c *websocket.Conn) {
		ticker := time.NewTicker(50 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				wsMutex.Lock()
				if _, ok := clients[c]; !ok {
					wsMutex.Unlock()
					return
				}
				if err := c.WriteMessage(websocket.PingMessage, nil); err != nil {
					c.Close()
					delete(clients, c)
					wsMutex.Unlock()
					return
				}
				wsMutex.Unlock()
			}
		}
	}(conn)
}

func broadcast(eventType string, data any) {
	wrapper := map[string]any{
		"event": eventType,
		"data":  data,
	}
	jsonBytes, _ := json.Marshal(wrapper)

	wsMutex.Lock()
	defer wsMutex.Unlock()

	for client := range clients {
		if err := client.WriteMessage(websocket.TextMessage, jsonBytes); err != nil {
			client.Close()
			delete(clients, client)
		}
	}
}
