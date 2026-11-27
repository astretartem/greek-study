package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func startServer(t *testing.T) (*hub, string) {
	t.Helper()
	h := newHub(originChecker("https://astretartem.github.io"))
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return h, "ws" + strings.TrimPrefix(srv.URL, "http")
}

func dial(t *testing.T, url string, origin string) *websocket.Conn {
	t.Helper()
	hdr := http.Header{}
	if origin != "" {
		hdr.Set("Origin", origin)
	}
	c, _, err := websocket.DefaultDialer.Dial(url, hdr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func sendJSON(t *testing.T, c *websocket.Conn, v any) {
	t.Helper()
	if err := c.WriteJSON(v); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// recv waits for a message; ok=false means nothing arrived within d.
func recv(c *websocket.Conn, d time.Duration) (map[string]any, bool) {
	_ = c.SetReadDeadline(time.Now().Add(d))
	var m map[string]any
	if err := c.ReadJSON(&m); err != nil {
		return nil, false
	}
	return m, true
}

func sub(t *testing.T, c *websocket.Conn, topics ...string) {
	sendJSON(t, c, map[string]any{"type": "subscribe", "topics": topics})
}

// settle makes sure the server has processed the earlier messages (it handles a connection's messages in order).
func settle(t *testing.T, c *websocket.Conn) {
	t.Helper()
	sendJSON(t, c, map[string]any{"type": "ping"})
	if m, ok := recv(c, time.Second); !ok || m["type"] != "pong" {
		t.Fatalf("expected pong, got %v", m)
	}
}

func TestPublishReachesRoomOnly(t *testing.T) {
	_, url := startServer(t)
	a, b, c := dial(t, url, ""), dial(t, url, ""), dial(t, url, "")
	sub(t, a, "room1")
	sub(t, b, "room1")
	sub(t, c, "room2")
	settle(t, a)
	settle(t, b)
	settle(t, c)

	sendJSON(t, a, map[string]any{"type": "publish", "topic": "room1", "data": map[string]any{"sdp": "x"}})

	for name, conn := range map[string]*websocket.Conn{"a": a, "b": b} {
		m, ok := recv(conn, time.Second)
		if !ok {
			t.Fatalf("%s: message not received", name)
		}
		if m["topic"] != "room1" || m["clients"] != float64(2) {
			t.Fatalf("%s: unexpected message %v", name, m)
		}
		if d, _ := m["data"].(map[string]any); d["sdp"] != "x" {
			t.Fatalf("%s: data lost: %v", name, m)
		}
	}
	if m, ok := recv(c, 200*time.Millisecond); ok {
		t.Fatalf("a client from another room got a message: %v", m)
	}
}

func TestPublishWithoutSubscribeIgnored(t *testing.T) {
	_, url := startServer(t)
	a, intruder := dial(t, url, ""), dial(t, url, "")
	sub(t, a, "room1")
	settle(t, a)
	sendJSON(t, intruder, map[string]any{"type": "publish", "topic": "room1", "data": "spam"})
	settle(t, intruder)
	if m, ok := recv(a, 200*time.Millisecond); ok {
		t.Fatalf("a non-subscriber was able to publish: %v", m)
	}
}

func TestUnsubscribe(t *testing.T) {
	_, url := startServer(t)
	a, b := dial(t, url, ""), dial(t, url, "")
	sub(t, a, "r")
	sub(t, b, "r")
	sendJSON(t, b, map[string]any{"type": "unsubscribe", "topics": []string{"r"}})
	settle(t, a)
	settle(t, b)
	sendJSON(t, a, map[string]any{"type": "publish", "topic": "r"})
	if m, ok := recv(a, time.Second); !ok || m["clients"] != float64(1) {
		t.Fatalf("expected clients=1, got %v", m)
	}
	if m, ok := recv(b, 200*time.Millisecond); ok {
		t.Fatalf("an unsubscribed client got a message: %v", m)
	}
}

func TestTopicLimit(t *testing.T) {
	h, url := startServer(t)
	a := dial(t, url, "")
	topics := make([]string, maxTopicsPerConn+10)
	for i := range topics {
		topics[i] = "t" + string(rune('A'+i))
	}
	sub(t, a, topics...)
	settle(t, a)
	if _, n := h.stats(); n != maxTopicsPerConn {
		t.Fatalf("expected %d rooms, got %d", maxTopicsPerConn, n)
	}
}

func TestCleanupOnClose(t *testing.T) {
	h, url := startServer(t)
	a := dial(t, url, "")
	sub(t, a, "room")
	settle(t, a)
	a.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if conns, rooms := h.stats(); conns == 0 && rooms == 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	conns, rooms := h.stats()
	t.Fatalf("not cleaned up after close: conns=%d rooms=%d", conns, rooms)
}

func TestOversizedMessageDisconnects(t *testing.T) {
	_, url := startServer(t)
	a := dial(t, url, "")
	big, _ := json.Marshal(map[string]any{"type": "ping", "pad": strings.Repeat("x", maxMessageBytes)})
	_ = a.WriteMessage(websocket.TextMessage, big)
	if _, ok := recv(a, time.Second); ok {
		t.Fatal("the connection should be closed after an oversized message")
	}
}

func TestOriginCheck(t *testing.T) {
	_, url := startServer(t)
	dial(t, url, "https://astretartem.github.io")
	dial(t, url, "http://localhost:8765")
	if _, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {"https://evil.example"}}); err == nil {
		t.Fatal("a foreign site should not be able to connect")
	}
}

func TestPerIPLimit(t *testing.T) {
	_, url := startServer(t)
	for i := 0; i < maxConnsPerIP; i++ {
		dial(t, url, "")
	}
	if _, _, err := websocket.DefaultDialer.Dial(url, nil); err == nil {
		t.Fatal("expected a refusal over the per-IP connection limit")
	}
}
