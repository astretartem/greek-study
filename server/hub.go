package main

import (
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Limits protecting the server from abuse.
const (
	maxMessageBytes   = 64 << 10 // the largest y-webrtc message (an SDP offer) is a few KB
	maxTopicsPerConn  = 20
	maxTopicLen       = 200
	maxConnsTotal     = 2000
	maxConnsPerIP     = 32
	sendQueueLen      = 64 // a slow client whose queue fills up is disconnected
	pingInterval      = 30 * time.Second
	readTimeout       = 70 * time.Second // > pingInterval: the pong must arrive in time
	writeTimeout      = 10 * time.Second
	handshakeDeadline = 10 * time.Second
)

// message is an incoming message in the y-webrtc signaling protocol.
type message struct {
	Type   string   `json:"type"`
	Topics []string `json:"topics,omitempty"`
	Topic  string   `json:"topic,omitempty"`
}

type client struct {
	conn   *websocket.Conn
	send   chan []byte
	topics map[string]struct{} // changed only under hub.mu
	ip     string

	mu     sync.Mutex // guards send against sending after close
	closed bool
}

// close closes the client's send queue exactly once; writePump then closes the connection.
func (c *client) close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.closed {
		c.closed = true
		close(c.send)
	}
}

// hub relays messages between clients in the same topic (room).
// It keeps nothing beyond the current subscriptions in memory.
type hub struct {
	mu       sync.Mutex
	topics   map[string]map[*client]struct{}
	conns    int
	perIP    map[string]int
	upgrader websocket.Upgrader
}

func newHub(allowOrigin func(origin string) bool) *hub {
	h := &hub{
		topics: make(map[string]map[*client]struct{}),
		perIP:  make(map[string]int),
	}
	h.upgrader = websocket.Upgrader{
		HandshakeTimeout: handshakeDeadline,
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			return origin == "" || allowOrigin(origin) // no Origin means a non-browser client, which limits still cover
		},
	}
	return h
}

// register reserves a slot for the connection, or returns false if limits are exceeded.
func (h *hub) register(ip string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns >= maxConnsTotal || h.perIP[ip] >= maxConnsPerIP {
		return false
	}
	h.conns++
	h.perIP[ip]++
	return true
}

func (h *hub) unregister(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for t := range c.topics {
		h.leave(c, t)
	}
	h.conns--
	if h.perIP[c.ip]--; h.perIP[c.ip] <= 0 {
		delete(h.perIP, c.ip)
	}
}

// leave must be called with h.mu held.
func (h *hub) leave(c *client, topic string) {
	delete(c.topics, topic)
	if subs := h.topics[topic]; subs != nil {
		delete(subs, c)
		if len(subs) == 0 {
			delete(h.topics, topic)
		}
	}
}

// ServeHTTP upgrades the connection to WebSocket and serves the client.
func (h *hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if !h.register(ip) {
		http.Error(w, "too many connections", http.StatusServiceUnavailable)
		return
	}
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.mu.Lock()
		h.conns--
		if h.perIP[ip]--; h.perIP[ip] <= 0 {
			delete(h.perIP, ip)
		}
		h.mu.Unlock()
		return // Upgrade has already written the error response
	}
	c := &client{
		conn:   conn,
		send:   make(chan []byte, sendQueueLen),
		topics: make(map[string]struct{}),
		ip:     ip,
	}
	go c.writePump()
	h.readPump(c)
}

func (h *hub) readPump(c *client) {
	defer func() {
		h.unregister(c)
		c.close()
	}()
	c.conn.SetReadLimit(maxMessageBytes)
	_ = c.conn.SetReadDeadline(time.Now().Add(readTimeout))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(readTimeout))
	})
	for {
		kind, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		_ = c.conn.SetReadDeadline(time.Now().Add(readTimeout))
		if kind != websocket.TextMessage {
			continue
		}
		h.handle(c, data)
	}
}

func (h *hub) handle(c *client, data []byte) {
	var m message
	if json.Unmarshal(data, &m) != nil {
		return
	}
	switch m.Type {
	case "subscribe":
		h.mu.Lock()
		for _, t := range m.Topics {
			if t == "" || len(t) > maxTopicLen || len(c.topics) >= maxTopicsPerConn {
				continue
			}
			if h.topics[t] == nil {
				h.topics[t] = make(map[*client]struct{})
			}
			h.topics[t][c] = struct{}{}
			c.topics[t] = struct{}{}
		}
		h.mu.Unlock()

	case "unsubscribe":
		h.mu.Lock()
		for _, t := range m.Topics {
			h.leave(c, t)
		}
		h.mu.Unlock()

	case "publish":
		h.publish(c, m.Topic, data)

	case "ping":
		c.enqueue([]byte(`{"type":"pong"}`))
	}
}

// publish relays a message to every subscriber of the topic (the sender included, as y-webrtc expects),
// adding the "clients" field: the number of subscribers.
func (h *hub) publish(from *client, topic string, data []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := from.topics[topic]; !ok {
		return // publishing only to a topic you have subscribed to
	}
	subs := h.topics[topic]
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil {
		return
	}
	n, _ := json.Marshal(len(subs))
	fields["clients"] = n
	out, err := json.Marshal(fields)
	if err != nil {
		return
	}
	for c := range subs {
		c.enqueue(out)
	}
}

// enqueue queues a message without blocking. If the queue is full, the client is too slow and is disconnected.
func (c *client) enqueue(msg []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	select {
	case c.send <- msg:
	default:
		c.closed = true
		close(c.send)
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if c.conn.WriteMessage(websocket.TextMessage, msg) != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
			if c.conn.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

// stats is for tests and /healthz: number of connections and rooms.
func (h *hub) stats() (conns, topics int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.conns, len(h.topics)
}
