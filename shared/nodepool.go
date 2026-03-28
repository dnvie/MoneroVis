package shared

import (
	"context"
	"errors"
	"log"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"
)

type Node struct {
	URL              string
	Healthy          bool
	LastError        error
	LastCheck        time.Time
	Latency          time.Duration
	QuarantinedUntil time.Time
	FailCount        int
}

type NodePool struct {
	nodes  []*Node
	mu     sync.RWMutex
	client *http.Client

	currentNode    *Node
	sessionExpires time.Time
}

func NewNodePool(urls []string) *NodePool {
	nodes := make([]*Node, len(urls))
	for i, u := range urls {
		nodes[i] = &Node{
			URL:     u,
			Healthy: true,
		}
	}

	return &NodePool{
		nodes: nodes,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

func (p *NodePool) Get() (string, error) {
	p.mu.RLock()
	now := time.Now()

	if p.currentNode != nil && p.currentNode.Healthy && now.Before(p.sessionExpires) {
		url := p.currentNode.URL
		p.mu.RUnlock()
		return url, nil
	}
	p.mu.RUnlock()

	p.mu.Lock()
	defer p.mu.Unlock()

	now = time.Now()
	if p.currentNode != nil && p.currentNode.Healthy && now.Before(p.sessionExpires) {
		return p.currentNode.URL, nil
	}

	var candidates []*Node
	for _, n := range p.nodes {
		if !n.Healthy || now.Before(n.QuarantinedUntil) {
			continue
		}
		candidates = append(candidates, n)
	}

	if len(candidates) == 0 {
		for _, n := range p.nodes {
			if n.Healthy {
				candidates = append(candidates, n)
			}
		}
	}

	if len(candidates) == 0 {
		return "", errors.New("no healthy nodes available in the pool")
	}

	p.currentNode = candidates[rand.IntN(len(candidates))]
	p.sessionExpires = now.Add(5 * time.Minute)

	log.Printf("Current RPCURL: %s", p.currentNode.URL)
	return p.currentNode.URL, nil
}

func (p *NodePool) ReportFailure(url string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	for _, n := range p.nodes {
		if n.URL == url {
			n.FailCount++

			backoff := time.Duration(n.FailCount) * 1 * time.Hour
			n.Healthy = false
			n.LastError = err
			n.LastCheck = time.Now()
			n.QuarantinedUntil = time.Now().Add(backoff)

			if p.currentNode != nil && p.currentNode.URL == url {
				p.sessionExpires = time.Time{}
			}

			return
		}
	}
}

func (p *NodePool) StartHealthChecks(interval time.Duration) {
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for range ticker.C {
			p.checkAll()
		}
	}()
}

func (p *NodePool) checkAll() {
	p.mu.RLock()
	nodes := make([]*Node, len(p.nodes))
	copy(nodes, p.nodes)
	p.mu.RUnlock()

	for _, n := range nodes {
		go p.checkNode(n)
	}
}

func (p *NodePool) checkNode(n *Node) {
	start := time.Now()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, "GET", n.URL+"/get_height", nil)
	resp, err := p.client.Do(req)

	if err == nil {
		defer resp.Body.Close()
	}

	latency := time.Since(start)

	p.mu.Lock()
	defer p.mu.Unlock()

	n.LastCheck = time.Now()
	n.Latency = latency

	if err != nil || resp.StatusCode != 200 {
		n.Healthy = false
		n.LastError = err
		if err == nil {
			n.LastError = errors.New("node returned non-200 status: " + resp.Status)
		}

		if p.currentNode != nil && p.currentNode.URL == n.URL {
			p.sessionExpires = time.Time{}
		}
		return
	}

	n.Healthy = true
	n.QuarantinedUntil = time.Time{}
	n.FailCount = 0
	n.LastError = nil
}
