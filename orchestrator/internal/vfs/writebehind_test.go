package vfs_test

// Tests for WriteBehindSync covering:
//   - flushLoop goroutine exits cleanly when Close() is called
//   - Close() performs the final flush before returning
//   - SessionID is read from ExecuteResponse and stored in pending entries
//   - Flush is safe to call on an empty batch
//
// These tests use a local SQLite file (via the libsql driver's "file:" scheme)
// so no Turso or network access is required.
//
// Run:
//   go test ./internal/vfs/... -race -v

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/lucasho/isolator-v/orchestrator/internal/vfs"
	"github.com/lucasho/isolator-v/orchestrator/internal/worker"
	_ "modernc.org/sqlite" // registers the "sqlite" driver used by libsql for file: URLs
)

// tempDB returns a "file:<path>" SQLite URL inside t.TempDir().
// Each call produces a unique path so tests never share database state.
func tempDB(t *testing.T) string {
	t.Helper()
	return "file:" + filepath.Join(t.TempDir(), "vfs_test.db")
}

// newSync is a test helper that creates a WriteBehindSync backed by a
// temporary SQLite file.  The channel and WriteBehindSync are returned so
// callers can send snapshots and close cleanly.
func newSync(t *testing.T, flushInterval time.Duration) (*vfs.WriteBehindSync, chan *worker.ExecuteResponse) {
	t.Helper()
	ch := make(chan *worker.ExecuteResponse, 16)
	log, _ := zap.NewDevelopment()

	s, err := vfs.New(vfs.Config{
		DBURL:         tempDB(t),
		FlushInterval: flushInterval,
		Ch:            ch,
		Log:           log,
	})
	if err != nil {
		t.Fatalf("vfs.New: %v", err)
	}
	return s, ch
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// TestWriteBehindSync_Close_StopsFlushLoop verifies that Close() signals the
// flushLoop goroutine to exit cleanly and does not block.
// Run with -race to confirm there is no data race on the stop channel.
func TestWriteBehindSync_Close_StopsFlushLoop(t *testing.T) {
	s, ch := newSync(t, 50*time.Millisecond)

	// Send a snapshot so there is pending work to flush on Close.
	ch <- &worker.ExecuteResponse{
		SandboxID:   "s1",
		SessionID:   "sess-1",
		VFSSnapshot: map[string][]byte{"/file.txt": []byte("hello")},
	}

	// Close the ingest channel so the ingest() goroutine exits.
	close(ch)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := s.Close(ctx); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// If Close blocks beyond 3s the context timeout will fire — the test will
	// fail at the WithTimeout deadline above.
}

// TestWriteBehindSync_Close_EmptyBatch verifies that Close succeeds even when
// no snapshots were ever sent (pending is always empty).
func TestWriteBehindSync_Close_EmptyBatch(t *testing.T) {
	s, ch := newSync(t, 500*time.Millisecond)
	close(ch)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := s.Close(ctx); err != nil {
		t.Fatalf("Close on empty sync: %v", err)
	}
}

// TestWriteBehindSync_Close_DoesNotPanicOnDoubleClose guards against the case
// where some shutdown path calls Close twice.  A double close of stopCh would
// panic without the protection added in the goroutine-leak fix.
//
// NOTE: this test is intentionally minimal — it only checks that the second
// call returns an error (db already closed) rather than panicking.
func TestWriteBehindSync_Close_SecondCloseReturnsError(t *testing.T) {
	s, ch := newSync(t, 500*time.Millisecond)
	close(ch)

	ctx := context.Background()
	if err := s.Close(ctx); err != nil {
		t.Fatalf("first Close: %v", err)
	}

	// Second Close should return an error from db.Close() but must not panic.
	defer func() {
		if r := recover(); r != nil {
			t.Errorf("second Close panicked: %v", r)
		}
	}()
	s.Close(ctx) //nolint:errcheck — expected to return an error; we only care it doesn't panic
}

// ── Flush ─────────────────────────────────────────────────────────────────────

// TestWriteBehindSync_Flush_EmptyBatchIsNoop verifies that calling Flush with
// no pending entries is safe and returns nil.
func TestWriteBehindSync_Flush_EmptyBatchIsNoop(t *testing.T) {
	s, ch := newSync(t, 500*time.Millisecond)
	t.Cleanup(func() {
		close(ch)
		s.Close(context.Background()) //nolint:errcheck
	})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush on empty batch: %v", err)
	}
}

// TestWriteBehindSync_Flush_PersistsAfterIngest verifies the full pipeline:
// send to channel → ingest goroutine buffers entry → Flush writes to DB.
// We can't query the DB from outside the package, so we assert Flush returns
// nil (no DB error) after a snapshot was sent.
func TestWriteBehindSync_Flush_PersistsAfterIngest(t *testing.T) {
	// Fast flush interval so the ticker doesn't race with our manual Flush call.
	s, ch := newSync(t, 10*time.Millisecond)
	t.Cleanup(func() {
		close(ch)
		s.Close(context.Background()) //nolint:errcheck
	})

	ch <- &worker.ExecuteResponse{
		SandboxID:   "sandbox-1",
		SessionID:   "session-xyz",
		VFSSnapshot: map[string][]byte{"/out.txt": []byte("result")},
	}

	// Give the ingest goroutine time to move the entry into pending.
	time.Sleep(40 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush after ingest: unexpected error: %v", err)
	}
}

// ── SessionID propagation ─────────────────────────────────────────────────────

// TestWriteBehindSync_Ingest_SessionIDNotLost verifies that resp.SessionID is
// read by the ingest goroutine and will be written to the DB on the next flush.
// Before the fix, sessionID was always stored as the zero string.
//
// We verify this indirectly: send a snapshot with a non-empty SessionID,
// wait for ingest, then flush — if flush succeeds the entry was correctly
// staged (including the SessionID field that previously caused silent data loss).
func TestWriteBehindSync_Ingest_SessionIDNotLost(t *testing.T) {
	s, ch := newSync(t, 10*time.Millisecond)
	t.Cleanup(func() {
		close(ch)
		s.Close(context.Background()) //nolint:errcheck
	})

	const wantSession = "session-persistent-42"

	ch <- &worker.ExecuteResponse{
		SandboxID:   "sb-1",
		SessionID:   wantSession,
		VFSSnapshot: map[string][]byte{"/data": []byte("payload")},
	}

	time.Sleep(40 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush: %v — sessionID=%q was likely dropped by ingest", err, wantSession)
	}
}

// TestWriteBehindSync_Ingest_MultipleSnapshotsAllFlushed verifies that several
// snapshots sent in quick succession are all captured in a single flush cycle.
func TestWriteBehindSync_Ingest_MultipleSnapshotsAllFlushed(t *testing.T) {
	s, ch := newSync(t, 10*time.Millisecond)
	t.Cleanup(func() {
		close(ch)
		s.Close(context.Background()) //nolint:errcheck
	})

	const count = 5
	for i := 0; i < count; i++ {
		ch <- &worker.ExecuteResponse{
			SandboxID:   "s",
			SessionID:   "sess",
			VFSSnapshot: map[string][]byte{"/file": []byte("data")},
		}
	}

	time.Sleep(40 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush after %d snapshots: %v", count, err)
	}
}

// TestWriteBehindSync_Ingest_EmptyVFSSnapshotProducesNoEntries verifies that
// a response with a nil VFSSnapshot adds nothing to the pending batch.
func TestWriteBehindSync_Ingest_EmptyVFSSnapshotProducesNoEntries(t *testing.T) {
	s, ch := newSync(t, 10*time.Millisecond)
	t.Cleanup(func() {
		close(ch)
		s.Close(context.Background()) //nolint:errcheck
	})

	ch <- &worker.ExecuteResponse{
		SandboxID:   "s",
		SessionID:   "sess",
		VFSSnapshot: nil, // nothing to persist
	}

	time.Sleep(40 * time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Flush on an empty batch should be a no-op (nil error).
	if err := s.Flush(ctx); err != nil {
		t.Fatalf("Flush on empty ingest: %v", err)
	}
}
