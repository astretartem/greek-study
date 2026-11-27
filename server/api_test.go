package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var (
	testID    = strings.Repeat("ab", 32)
	testToken = strings.Repeat("cd", 32)
	otherTok  = strings.Repeat("ef", 32)
)

func newTestAPI(t *testing.T, maxBlobs int) (*store, *httptest.Server) {
	t.Helper()
	st, err := openStore(filepath.Join(t.TempDir(), "data.db"), maxBlobs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	srv := httptest.NewServer(&blobAPI{st: st, allow: originChecker("https://astretartem.github.io"), lim: newLimiter(6000, 1000)})
	t.Cleanup(srv.Close)
	return st, srv
}

func do(t *testing.T, method, url, token, ifMatch string, body []byte) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(method, url, bytes.NewReader(body))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if ifMatch != "" {
		req.Header.Set("If-Match", ifMatch)
	}
	req.Header.Set("Origin", "https://astretartem.github.io")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func expect(t *testing.T, res *http.Response, code int) {
	t.Helper()
	if res.StatusCode != code {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("%s %s: expected %d, got %d: %s", res.Request.Method, res.Request.URL.Path, code, res.StatusCode, b)
	}
}

func TestBlobLifecycle(t *testing.T) {
	_, srv := newTestAPI(t, 10)
	url := srv.URL + "/v1/blob/" + testID

	expect(t, do(t, "GET", url, "", "", nil), 404)

	res := do(t, "PUT", url, testToken, `"0"`, []byte("v1"))
	expect(t, res, 200)
	if res.Header.Get("ETag") != `"1"` {
		t.Fatalf("ETag after create: %q", res.Header.Get("ETag"))
	}

	res = do(t, "GET", url, "", "", nil)
	expect(t, res, 200)
	if b, _ := io.ReadAll(res.Body); string(b) != "v1" || res.Header.Get("ETag") != `"1"` {
		t.Fatalf("GET: %q %q", b, res.Header.Get("ETag"))
	}

	expect(t, do(t, "PUT", url, testToken, `"1"`, []byte("v2")), 200)

	// A stale version gets a conflict carrying the current one.
	res = do(t, "PUT", url, testToken, `"1"`, []byte("stale"))
	expect(t, res, 409)
	if res.Header.Get("ETag") != `"2"` {
		t.Fatalf("ETag on conflict: %q", res.Header.Get("ETag"))
	}
	// Creating over an existing copy is also a conflict.
	expect(t, do(t, "PUT", url, testToken, `"0"`, []byte("x")), 409)

	// Someone else's token cannot overwrite or delete.
	expect(t, do(t, "PUT", url, otherTok, `"2"`, []byte("evil")), 403)
	expect(t, do(t, "DELETE", url, otherTok, "", nil), 403)

	expect(t, do(t, "DELETE", url, testToken, "", nil), 204)
	expect(t, do(t, "GET", url, "", "", nil), 404)
}

func TestBlobValidation(t *testing.T) {
	_, srv := newTestAPI(t, 10)
	url := srv.URL + "/v1/blob/" + testID
	expect(t, do(t, "PUT", url, "", `"0"`, []byte("x")), 401)                         // no token
	expect(t, do(t, "PUT", url, "short", `"0"`, []byte("x")), 401)                    // bad token
	expect(t, do(t, "PUT", url, testToken, "", []byte("x")), 428)                     // no If-Match
	expect(t, do(t, "PUT", url, testToken, `"0"`, nil), 400)                          // empty body
	expect(t, do(t, "PUT", url, testToken, `"0"`, make([]byte, maxBlobBytes+1)), 413) // too large
	expect(t, do(t, "GET", srv.URL+"/v1/blob/NOT-HEX", "", "", nil), 404)             // bad id
	expect(t, do(t, "POST", url, testToken, "", []byte("x")), 405)                    // wrong method
}

func TestStorageFull(t *testing.T) {
	_, srv := newTestAPI(t, 1)
	expect(t, do(t, "PUT", srv.URL+"/v1/blob/"+testID, testToken, `"0"`, []byte("a")), 200)
	expect(t, do(t, "PUT", srv.URL+"/v1/blob/"+strings.Repeat("00", 32), testToken, `"0"`, []byte("b")), 507)
}

func TestCORS(t *testing.T) {
	_, srv := newTestAPI(t, 10)
	req, _ := http.NewRequest("OPTIONS", srv.URL+"/v1/blob/"+testID, nil)
	req.Header.Set("Origin", "https://astretartem.github.io")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Origin") != "https://astretartem.github.io" ||
		!strings.Contains(res.Header.Get("Access-Control-Expose-Headers"), "ETag") {
		t.Fatalf("preflight: %d %v", res.StatusCode, res.Header)
	}
	req, _ = http.NewRequest("GET", srv.URL+"/v1/blob/"+testID, nil)
	req.Header.Set("Origin", "https://evil.example")
	res, _ = http.DefaultClient.Do(req)
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("a foreign site should be refused, got %d", res.StatusCode)
	}
}

func TestRateLimit(t *testing.T) {
	st, err := openStore(filepath.Join(t.TempDir(), "d.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	srv := httptest.NewServer(&blobAPI{st: st, allow: originChecker(""), lim: newLimiter(60, 3)})
	defer srv.Close()
	codes := []int{}
	for i := 0; i < 5; i++ {
		res, _ := http.Get(srv.URL + "/v1/blob/" + testID)
		res.Body.Close()
		codes = append(codes, res.StatusCode)
	}
	if codes[2] != 404 || codes[3] != 429 {
		t.Fatalf("expected 3 requests then 429, got %v", codes)
	}
}

func TestPruneAndBackup(t *testing.T) {
	dir := t.TempDir()
	st, err := openStore(filepath.Join(dir, "data.db"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()
	if _, err := st.put(ctx, testID, []byte("tok"), 0, []byte("x")); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.prune(ctx, time.Hour); n != 0 {
		t.Fatalf("a fresh copy was deleted")
	}
	if _, err := st.db.Exec(`UPDATE blobs SET updated_at = ?`, time.Now().Add(-48*time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	if n, _ := st.prune(ctx, 24*time.Hour); n != 1 {
		t.Fatalf("a stale copy was not deleted: %d", n)
	}
	bdir := filepath.Join(dir, "backups")
	for i := 0; i < 2; i++ { // a repeated backup on the same day overwrites the file
		if err := st.backup(ctx, bdir, 7); err != nil {
			t.Fatal(err)
		}
	}
	files, _ := os.ReadDir(bdir)
	if len(files) != 1 {
		t.Fatalf("expected 1 backup, got %d", len(files))
	}
}
