// greek-signaling is the server for the greek-study site. It does two things:
//
//  1. WebRTC signaling (path /, WebSocket, y-webrtc protocol): introduces devices so they
//     can sync progress directly. It stores nothing.
//  2. Encrypted progress copies (path /v1/blob/, SQLite): devices store their progress
//     encrypted, so they can sync without being online at the same time. The server
//     cannot read the data.
//
// No rooms, ids or IPs are written to the logs.
//
// Local run (no HTTPS):        greek-signaling -addr :4444
// On a server (Let's Encrypt): greek-signaling -domain 1-2-3-4.sslip.io
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"
)

func main() {
	stateDir := os.Getenv("STATE_DIRECTORY") // set by systemd (StateDirectory=)
	if stateDir == "" {
		stateDir = "."
	}
	var (
		addr    = flag.String("addr", ":4444", "address for HTTP without TLS (when -domain is not set)")
		domain  = flag.String("domain", "", "domain for HTTPS via Let's Encrypt; enables ports 80 and 443")
		cache   = flag.String("cache", filepath.Join(stateDir, "certs"), "certificate directory")
		origins = flag.String("origins", "https://astretartem.github.io", "allowed site origins, comma-separated (localhost is always allowed)")
		dbPath  = flag.String("db", filepath.Join(stateDir, "data.db"), "SQLite database of encrypted progress copies")
		maxBlob = flag.Int("max-blobs", 100000, "maximum number of stored copies")
		keep    = flag.Int("keep-days", 365, "delete copies not updated for this many days")
	)
	flag.Parse()

	allow := originChecker(*origins)
	st, err := openStore(*dbPath, *maxBlob)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer st.Close()

	h := newHub(allow)
	mux := http.NewServeMux()
	mux.Handle("/v1/blob/", &blobAPI{st: st, allow: allow, lim: newLimiter(ratePerMin, rateBurst)})
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		conns, rooms := h.stats()
		blobs, _ := st.count(r.Context())
		fmt.Fprintf(w, "ok conns=%d rooms=%d blobs=%d\n", conns, rooms, blobs)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if websocketRequested(r) {
			h.ServeHTTP(w, r)
			return
		}
		fmt.Fprintln(w, "greek-study signaling: ok")
	})

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          log.New(os.Stderr, "http: ", 0),
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go maintenance(ctx, st, filepath.Join(filepath.Dir(*dbPath), "backups"), time.Duration(*keep)*24*time.Hour)

	errc := make(chan error, 2)
	if *domain == "" {
		srv.Addr = *addr
		log.Printf("listening on http://%s", *addr)
		go func() { errc <- srv.ListenAndServe() }()
	} else {
		m := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(*domain),
			Cache:      autocert.DirCache(*cache),
		}
		srv.Addr = ":443"
		srv.TLSConfig = m.TLSConfig()
		srv.TLSConfig.MinVersion = tls.VersionTLS12
		// Port 80: Let's Encrypt HTTP-01 challenge plus redirect to https.
		acme := &http.Server{Addr: ":80", Handler: m.HTTPHandler(nil), ReadHeaderTimeout: 10 * time.Second}
		go func() { errc <- acme.ListenAndServe() }()
		go func() { errc <- srv.ListenAndServeTLS("", "") }()
		defer acme.Close()
		log.Printf("listening on https://%s", *domain)
	}

	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Print("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}
}

func websocketRequested(r *http.Request) bool {
	return strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
}

// originChecker allows the listed origins plus any localhost (for local development).
func originChecker(list string) func(string) bool {
	allowed := make(map[string]bool)
	for _, o := range strings.Split(list, ",") {
		if o = strings.TrimSpace(strings.TrimSuffix(o, "/")); o != "" {
			allowed[o] = true
		}
	}
	return func(origin string) bool {
		if allowed[origin] {
			return true
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		host := u.Hostname()
		return host == "localhost" || host == "127.0.0.1" || host == "::1"
	}
}

// maintenance runs once a day: deletes stale copies and takes a DB backup (keeping 7).
func maintenance(ctx context.Context, st *store, backupDir string, maxAge time.Duration) {
	run := func() {
		if n, err := st.prune(ctx, maxAge); err != nil {
			log.Printf("prune: %v", err)
		} else if n > 0 {
			log.Printf("prune: removed %d stale copies", n)
		}
		if err := st.backup(ctx, backupDir, 7); err != nil {
			log.Printf("backup: %v", err)
		}
	}
	run()
	t := time.NewTicker(24 * time.Hour)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			run()
		}
	}
}
