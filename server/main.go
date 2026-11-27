// greek-signaling is a WebRTC signaling server for syncing progress between devices
// of the greek-study site. The protocol is compatible with y-webrtc. The server only relays
// service messages between devices in the same room; it stores nothing and logs no rooms or IPs.
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
	)
	flag.Parse()

	h := newHub(originChecker(*origins))
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		conns, rooms := h.stats()
		fmt.Fprintf(w, "ok conns=%d rooms=%d\n", conns, rooms)
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
