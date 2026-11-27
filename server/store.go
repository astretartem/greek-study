package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	_ "modernc.org/sqlite" // pure Go, no cgo: cross-compiles to linux/arm64 with one command
)

var (
	errNotFound  = errors.New("not found")
	errConflict  = errors.New("version conflict")
	errForbidden = errors.New("forbidden")
	errFull      = errors.New("storage full")
)

// store keeps encrypted progress copies. The server cannot read them: data is
// encrypted on the device with a key only the paired devices know.
// Writes are guarded by a token, of which the server stores only a hash, and by a
// version number (optimistic locking): a device that wrote over a stale version gets
// a conflict, downloads the fresh copy, merges and writes again.
type store struct {
	db       *sql.DB
	maxBlobs int
}

func openStore(path string, maxBlobs int) (*store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // SQLite has one writer; one connection means no SQLITE_BUSY
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS blobs (
		id         TEXT PRIMARY KEY,
		token_hash BLOB    NOT NULL,
		version    INTEGER NOT NULL,
		data       BLOB    NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`); err != nil {
		db.Close()
		return nil, err
	}
	return &store{db: db, maxBlobs: maxBlobs}, nil
}

func (s *store) Close() error { return s.db.Close() }

func hashToken(token []byte) []byte {
	h := sha256.Sum256(token)
	return h[:]
}

func (s *store) get(ctx context.Context, id string) ([]byte, int64, error) {
	var data []byte
	var ver int64
	err := s.db.QueryRowContext(ctx, `SELECT data, version FROM blobs WHERE id = ?`, id).Scan(&data, &ver)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, errNotFound
	}
	return data, ver, err
}

// put writes a new copy if the client knows the current version (0 means "create").
// On a conflict it returns the current version.
func (s *store) put(ctx context.Context, id string, token []byte, ifVersion int64, data []byte) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	now := time.Now().Unix()
	var th []byte
	var ver int64
	err = tx.QueryRowContext(ctx, `SELECT token_hash, version FROM blobs WHERE id = ?`, id).Scan(&th, &ver)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if ifVersion != 0 {
			return 0, errConflict
		}
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM blobs`).Scan(&n); err != nil {
			return 0, err
		}
		if n >= s.maxBlobs {
			return 0, errFull
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO blobs (id, token_hash, version, data, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)`,
			id, hashToken(token), data, now, now); err != nil {
			return 0, err
		}
		return 1, tx.Commit()
	case err != nil:
		return 0, err
	}
	if subtle.ConstantTimeCompare(th, hashToken(token)) != 1 {
		return 0, errForbidden
	}
	if ver != ifVersion {
		return ver, errConflict
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE blobs SET data = ?, version = version + 1, updated_at = ? WHERE id = ?`, data, now, id); err != nil {
		return 0, err
	}
	return ver + 1, tx.Commit()
}

func (s *store) delete(ctx context.Context, id string, token []byte) error {
	var th []byte
	err := s.db.QueryRowContext(ctx, `SELECT token_hash FROM blobs WHERE id = ?`, id).Scan(&th)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if subtle.ConstantTimeCompare(th, hashToken(token)) != 1 {
		return errForbidden
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM blobs WHERE id = ?`, id)
	return err
}

func (s *store) count(ctx context.Context) (n int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM blobs`).Scan(&n)
	return
}

// prune removes copies that have not been updated for longer than maxAge (data minimization, GDPR).
func (s *store) prune(ctx context.Context, maxAge time.Duration) (int64, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM blobs WHERE updated_at < ?`, time.Now().Add(-maxAge).Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// backup makes a consistent DB copy (VACUUM INTO) and keeps the last `keep` copies.
func (s *store) backup(ctx context.Context, dir string, keep int) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	dst := filepath.Join(dir, "data-"+time.Now().UTC().Format("20060102")+".db")
	_ = os.Remove(dst) // VACUUM INTO does not overwrite an existing file
	if _, err := s.db.ExecContext(ctx, `VACUUM INTO ?`, dst); err != nil {
		return fmt.Errorf("vacuum into: %w", err)
	}
	old, _ := filepath.Glob(filepath.Join(dir, "data-*.db"))
	sort.Strings(old)
	for len(old) > keep {
		_ = os.Remove(old[0])
		old = old[1:]
	}
	return nil
}
