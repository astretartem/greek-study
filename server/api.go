package main

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxBlobBytes = 1 << 20 // 1 MiB: a compressed copy of progress takes tens of KB
	rateBurst    = 30      // requests per IP at once
	ratePerMin   = 120     // requests per IP per minute on average
)

var blobID = regexp.MustCompile(`^[0-9a-f]{64}$`)

// blobAPI is the HTTP API for encrypted progress copies:
//
//	GET    /v1/blob/{id}                                 -> 200 data, ETag: "version" | 404
//	PUT    /v1/blob/{id}  Authorization: Bearer <token>  If-Match: "version" ("0" creates)
//	                                                     -> 200 {"version":n} | 409 (ETag = current) | 403 | 413
//	DELETE /v1/blob/{id}  Authorization: Bearer <token>  -> 204 | 403 | 404
//
// id and token are derived on the device from the pairing secret (SHA-256), and the
// server stores only a hash of the token.
type blobAPI struct {
	st    *store
	allow func(origin string) bool
	lim   *limiter
}

func (a *blobAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin != "" {
		if !a.allow(origin) {
			http.Error(w, "origin not allowed", http.StatusForbidden)
			return
		}
		hd := w.Header()
		hd.Set("Access-Control-Allow-Origin", origin)
		hd.Add("Vary", "Origin")
		hd.Set("Access-Control-Allow-Methods", "GET, PUT, DELETE")
		hd.Set("Access-Control-Allow-Headers", "Authorization, If-Match, Content-Type")
		hd.Set("Access-Control-Expose-Headers", "ETag")
		hd.Set("Access-Control-Max-Age", "600")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if !a.lim.allow(clientIP(r)) {
		http.Error(w, "too many requests", http.StatusTooManyRequests)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/v1/blob/")
	if !blobID.MatchString(id) {
		http.Error(w, "bad id", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	ctx := r.Context()

	switch r.Method {
	case http.MethodGet:
		data, ver, err := a.st.get(ctx, id)
		if errors.Is(err, errNotFound) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err != nil {
			a.fail(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("ETag", etag(ver))
		_, _ = w.Write(data)

	case http.MethodPut:
		token, ok := bearer(r)
		if !ok {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		ifVer, ok := parseIfMatch(r.Header.Get("If-Match"))
		if !ok {
			http.Error(w, "If-Match required", http.StatusPreconditionRequired)
			return
		}
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBlobBytes))
		if err != nil {
			http.Error(w, "too large", http.StatusRequestEntityTooLarge)
			return
		}
		if len(data) == 0 {
			http.Error(w, "empty body", http.StatusBadRequest)
			return
		}
		ver, err := a.st.put(ctx, id, token, ifVer, data)
		switch {
		case errors.Is(err, errConflict):
			w.Header().Set("ETag", etag(ver))
			http.Error(w, "version conflict", http.StatusConflict)
		case errors.Is(err, errForbidden):
			http.Error(w, "forbidden", http.StatusForbidden)
		case errors.Is(err, errFull):
			http.Error(w, "storage full", http.StatusInsufficientStorage)
		case err != nil:
			a.fail(w, err)
		default:
			w.Header().Set("ETag", etag(ver))
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"version":%d}`, ver)
		}

	case http.MethodDelete:
		token, ok := bearer(r)
		if !ok {
			http.Error(w, "missing token", http.StatusUnauthorized)
			return
		}
		switch err := a.st.delete(ctx, id, token); {
		case errors.Is(err, errNotFound):
			http.Error(w, "not found", http.StatusNotFound)
		case errors.Is(err, errForbidden):
			http.Error(w, "forbidden", http.StatusForbidden)
		case err != nil:
			a.fail(w, err)
		default:
			w.WriteHeader(http.StatusNoContent)
		}

	default:
		w.Header().Set("Allow", "GET, PUT, DELETE, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *blobAPI) fail(w http.ResponseWriter, err error) {
	log.Printf("store error: %v", err) // no ids or IPs in the logs
	http.Error(w, "internal error", http.StatusInternalServerError)
}

func etag(v int64) string { return `"` + strconv.FormatInt(v, 10) + `"` }

func parseIfMatch(s string) (int64, bool) {
	s = strings.Trim(strings.TrimPrefix(strings.TrimSpace(s), "W/"), `"`)
	v, err := strconv.ParseInt(s, 10, 64)
	return v, err == nil && v >= 0
}

func bearer(r *http.Request) ([]byte, bool) {
	t, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || len(t) != 64 {
		return nil, false
	}
	b, err := hex.DecodeString(t)
	return b, err == nil
}

func clientIP(r *http.Request) string {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

// limiter is a token bucket per IP. Entries idle for a while are dropped so memory does not grow.
type limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	rate    float64 // tokens per second
	burst   float64
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(perMin, burst int) *limiter {
	l := &limiter{buckets: make(map[string]*bucket), rate: float64(perMin) / 60, burst: float64(burst)}
	go func() {
		for range time.Tick(5 * time.Minute) {
			l.mu.Lock()
			for ip, b := range l.buckets {
				if time.Since(b.last) > 10*time.Minute {
					delete(l.buckets, ip)
				}
			}
			l.mu.Unlock()
		}
	}()
	return l
}

func (l *limiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	b := l.buckets[ip]
	if b == nil {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}
	b.tokens = min(l.burst, b.tokens+now.Sub(b.last).Seconds()*l.rate)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
