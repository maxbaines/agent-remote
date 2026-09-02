package server

import (
	cryptorand "crypto/rand"
	"encoding/base64"
	"fmt"
	"math/rand/v2"
	"sync"
)

const tunnelIDAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
const tunnelIDLen = 5

// tunnelInfoServer is the unexported struct returned by TunnelRegistry.List.
type tunnelInfoServer struct {
	id    string
	port  int
	token string
}

// TunnelRegistry tracks active tunnels by ID→port. It is safe for concurrent
// use. Tunnel IDs are 5-char random strings drawn from [a-z0-9].
type TunnelRegistry struct {
	mu      sync.RWMutex
	tunnels map[string]tunnelInfoServer
}

// NewTunnelRegistry returns an empty, ready-to-use TunnelRegistry.
func NewTunnelRegistry() *TunnelRegistry {
	return &TunnelRegistry{
		tunnels: make(map[string]tunnelInfoServer),
	}
}

// Create registers port under a freshly-generated 5-char random ID.
// It retries up to 20 times to avoid collisions. Returns (id, nil) on
// success or an error if no unique ID could be generated.
func (r *TunnelRegistry) Create(port int) (string, error) {
	tokenBytes := make([]byte, 32)
	if _, err := cryptorand.Read(tokenBytes); err != nil {
		return "", fmt.Errorf("tunnel: generate access token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)

	r.mu.Lock()
	defer r.mu.Unlock()

	for range 20 {
		id := tunnelGenID()
		if _, exists := r.tunnels[id]; !exists {
			r.tunnels[id] = tunnelInfoServer{id: id, port: port, token: token}
			return id, nil
		}
	}
	return "", fmt.Errorf("tunnel: could not generate unique ID after 20 attempts")
}

// Close removes the tunnel with the given ID. Returns false if the ID is not
// registered.
func (r *TunnelRegistry) Close(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if _, ok := r.tunnels[id]; !ok {
		return false
	}
	delete(r.tunnels, id)
	return true
}

// Port returns the port registered for id, and whether id exists.
func (r *TunnelRegistry) Port(id string) (int, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	entry, ok := r.tunnels[id]
	return entry.port, ok
}

// Token returns the capability token for id, or an empty string when the
// tunnel is unknown. Tokens live only in Gateway memory and disappear when a
// tunnel closes or the Gateway restarts.
func (r *TunnelRegistry) Token(id string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tunnels[id].token
}

// Entry returns the complete private tunnel record used by host routing.
func (r *TunnelRegistry) Entry(id string) (tunnelInfoServer, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	entry, ok := r.tunnels[id]
	return entry, ok
}

// List returns all registered tunnels as a slice of unexported tunnelInfoServer
// values. Order is undefined.
func (r *TunnelRegistry) List() []tunnelInfoServer {
	r.mu.RLock()
	defer r.mu.RUnlock()

	out := make([]tunnelInfoServer, 0, len(r.tunnels))
	for _, entry := range r.tunnels {
		out = append(out, entry)
	}
	return out
}

// tunnelGenID builds a random 5-character string from tunnelIDAlphabet.
func tunnelGenID() string {
	b := make([]byte, tunnelIDLen)
	for i := range b {
		b[i] = tunnelIDAlphabet[rand.IntN(len(tunnelIDAlphabet))]
	}
	return string(b)
}
