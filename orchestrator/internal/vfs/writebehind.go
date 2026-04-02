// Package vfs implements the Write-Behind (Write-Back) caching pattern for the
// agent Virtual File System.
//
// Design
//
//	Agent writes → in-memory WASM VFS (Rust worker)
//	                   ↓  on execution complete
//	             vfsCh (buffered channel)
//	                   ↓  ingest goroutine
//	             pending []entry  (in-memory batch)
//	                   ↓  every 500 ms  (or on Close)
//	             LibSQL / Turso  (edge SQLite)
//
// This avoids blocking agent execution on disk I/O: the agent sees main-memory
// latency (~100 ns), while persistence happens asynchronously in the
// background.  The tradeoff is a small window of potential data loss on
// unclean shutdown, which is acceptable for ephemeral agent sessions.
package vfs

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "github.com/tursodatabase/libsql-client-go/libsql" // register "libsql" driver
	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
)

const (
	defaultFlushInterval = 500 * time.Millisecond
)

// entry is one VFS file persisted per execution.
type entry struct {
	sandboxID string
	sessionID string
	path      string
	data      []byte
	createdAt time.Time
}

// Config holds WriteBehindSync configuration.
type Config struct {
	// DBURL is the LibSQL / Turso connection string, e.g.:
	//   "libsql://your-db.turso.io?authToken=TOKEN"
	// For local development use "file:vfs.db" (SQLite).
	DBURL         string
	FlushInterval time.Duration // 0 → 500 ms
	// Ch is the channel that receives ExecuteResponse values containing
	// non-empty VFS snapshots.  Manager.Execute() is the producer.
	Ch  chan *worker.ExecuteResponse
	Log *zap.Logger
}

// WriteBehindSync batches in-memory VFS snapshots and flushes them to LibSQL
// on a configurable interval.
type WriteBehindSync struct {
	log           *zap.Logger
	db            *sql.DB
	ch            chan *worker.ExecuteResponse
	flushInterval time.Duration
	stopCh   chan struct{} // closed by Close() to stop the flushLoop goroutine
	stopOnce sync.Once   // ensures stopCh is closed exactly once (safe for double-Close)

	mu      sync.Mutex
	pending []*entry
}

// New creates a WriteBehindSync, runs the schema migration, and starts the
// ingest + flush goroutines.  Call Close() to perform a final flush and
// release the database connection.
func New(cfg Config) (*WriteBehindSync, error) {
	db, err := sql.Open("libsql", cfg.DBURL)
	if err != nil {
		return nil, fmt.Errorf("vfs: open libsql (%s): %w", cfg.DBURL, err)
	}
	// Keep a small connection pool; LibSQL is often a remote HTTP endpoint.
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)

	interval := cfg.FlushInterval
	if interval == 0 {
		interval = defaultFlushInterval
	}

	s := &WriteBehindSync{
		log:           cfg.Log,
		db:            db,
		ch:            cfg.Ch,
		flushInterval: interval,
		stopCh:        make(chan struct{}),
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.migrate(ctx); err != nil {
		return nil, fmt.Errorf("vfs: migrate: %w", err)
	}

	go s.ingest()
	go s.flushLoop()

	cfg.Log.Info("vfs write-behind started",
		zap.String("db", cfg.DBURL),
		zap.Duration("interval", interval),
	)

	return s, nil
}

// ── Schema ────────────────────────────────────────────────────────────────────

func (s *WriteBehindSync) migrate(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS vfs_snapshots (
			id          INTEGER  PRIMARY KEY AUTOINCREMENT,
			sandbox_id  TEXT     NOT NULL,
			session_id  TEXT     NOT NULL DEFAULT '',
			path        TEXT     NOT NULL,
			data        BLOB     NOT NULL,
			created_at  TEXT     NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_vfs_session   ON vfs_snapshots (session_id);
		CREATE INDEX IF NOT EXISTS idx_vfs_sandbox   ON vfs_snapshots (sandbox_id);
		CREATE INDEX IF NOT EXISTS idx_vfs_path      ON vfs_snapshots (path);
	`)
	return err
}

// ── Ingest goroutine ──────────────────────────────────────────────────────────

// ingest reads ExecuteResponse values from the channel, expands their
// VFSSnapshot maps into individual entries, and buffers them in memory.
func (s *WriteBehindSync) ingest() {
	for resp := range s.ch {
		now := time.Now()
		s.mu.Lock()
		for path, data := range resp.VFSSnapshot {
			s.pending = append(s.pending, &entry{
				sandboxID: resp.SandboxID,
				sessionID: resp.SessionID,
				path:      path,
				data:      data,
				createdAt: now,
			})
		}
		s.mu.Unlock()
	}
}

// ── Flush loop ────────────────────────────────────────────────────────────────

func (s *WriteBehindSync) flushLoop() {
	t := time.NewTicker(s.flushInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if err := s.Flush(context.Background()); err != nil {
				s.log.Error("vfs periodic flush failed", zap.Error(err))
			}
		case <-s.stopCh:
			return
		}
	}
}

// Flush writes all pending entries to LibSQL in a single transaction.
// It is safe to call concurrently; the mutex ensures at most one flush
// runs at a time and no entries are lost.
func (s *WriteBehindSync) Flush(ctx context.Context) error {
	s.mu.Lock()
	if len(s.pending) == 0 {
		s.mu.Unlock()
		return nil
	}
	batch := s.pending
	s.pending = nil
	s.mu.Unlock()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		// Put the batch back so it can be retried.
		s.mu.Lock()
		s.pending = append(batch, s.pending...)
		s.mu.Unlock()
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback() //nolint:errcheck

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO vfs_snapshots (sandbox_id, session_id, path, data)
		VALUES (?, ?, ?, ?)
	`)
	if err != nil {
		return fmt.Errorf("prepare: %w", err)
	}
	defer stmt.Close()

	for _, e := range batch {
		if _, err := stmt.ExecContext(ctx, e.sandboxID, e.sessionID, e.path, e.data); err != nil {
			return fmt.Errorf("insert %s/%s: %w", e.sandboxID, e.path, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}

	s.log.Debug("vfs flush complete", zap.Int("entries", len(batch)))
	return nil
}

// ── Read path ─────────────────────────────────────────────────────────────────

// FileEntry is a single VFS file record belonging to a session.
type FileEntry struct {
	Path string
	Size int64
}

// QueryEntries returns all distinct file paths persisted for sessionID,
// along with their most-recent byte-length.  Results are ordered by path.
func (s *WriteBehindSync) QueryEntries(ctx context.Context, sessionID string) ([]FileEntry, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT path, LENGTH(data) AS size
		FROM vfs_snapshots
		WHERE session_id = ?
		GROUP BY path
		ORDER BY path
	`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("vfs: query entries: %w", err)
	}
	defer rows.Close()

	var entries []FileEntry
	for rows.Next() {
		var e FileEntry
		if err := rows.Scan(&e.Path, &e.Size); err != nil {
			return nil, fmt.Errorf("vfs: scan entry: %w", err)
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

// QueryFile returns the most-recent content blob for path within sessionID.
// Returns sql.ErrNoRows (via errors.Is) when the path has not been persisted.
func (s *WriteBehindSync) QueryFile(ctx context.Context, sessionID, path string) ([]byte, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, `
		SELECT data FROM vfs_snapshots
		WHERE session_id = ? AND path = ?
		ORDER BY created_at DESC
		LIMIT 1
	`, sessionID, path).Scan(&data)
	if err != nil {
		return nil, fmt.Errorf("vfs: query file %q: %w", path, err)
	}
	return data, nil
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Close stops the flush goroutine, performs a final flush, and closes the
// database connection.  Safe to call more than once: the second call returns
// an error from db.Close() but does not panic.
func (s *WriteBehindSync) Close(ctx context.Context) error {
	// Signal flushLoop to exit exactly once; a second Close must not panic.
	s.stopOnce.Do(func() { close(s.stopCh) })
	if err := s.Flush(ctx); err != nil {
		s.log.Error("vfs final flush failed", zap.Error(err))
	}
	return s.db.Close()
}
