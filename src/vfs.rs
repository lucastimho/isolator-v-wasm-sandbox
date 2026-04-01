//! # Virtual File System (VFS) — WASI Interceptor Layer
//!
//! ## Design
//!
//! The VFS intercepts the WASI `fd_*` and `path_*` syscalls that Wasmtime would
//! normally forward to the OS and instead satisfies them entirely from an
//! **in-memory BTreeMap**, providing `O(log n)` path lookup speed.
//!
//! ```text
//!  Guest WASM
//!     │ path_open / fd_read / fd_write / fd_seek / fd_close
//!     ▼
//!  [ VfsInterceptor ]  ←── registered on the Wasmtime Linker
//!     │
//!     ├─ fd == STDOUT (1) ──► RingBuffer  ──► SSE / WebSocket bridge
//!     ├─ fd == STDERR (2) ──► RingBuffer
//!     └─ fd >= 3          ──► VfsState (BTreeMap<path, VfsNode>)
//!                                │
//!                                └─ Occasionally flushed to Turso/LibSQL
//! ```
//!
//! ## Security guarantees
//!
//! * **Zero host paths** — the VFS root is a hermetic BTreeMap; no `open(2)`
//!   ever touches the host filesystem.
//! * **No symlink escape** — path canonicalisation rejects `..` traversals.
//! * **Quota-enforced writes** — cumulative bytes written is tracked; exceeding
//!   the quota returns `ERRNO_NOSPC` to the guest.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use parking_lot::{Mutex, RwLock};
use tracing::{debug, trace};

use crate::error::{Result, SandboxError};

// ─── Constants ───────────────────────────────────────────────────────────────

/// Maximum simultaneous open file descriptors per sandbox.
const MAX_FDS: usize = 256;
/// Maximum total bytes that may be written to the VFS per sandbox session.
const WRITE_QUOTA_BYTES: u64 = 64 * 1024 * 1024; // 64 MB
/// First non-stdio file descriptor number.
const FIRST_GUEST_FD: u32 = 3;

// ─── WASI errno constants ────────────────────────────────────────────────────

pub mod errno {
    pub const SUCCESS:  i32 = 0;
    pub const BADF:     i32 = 8;
    pub const EXIST:    i32 = 20;
    pub const INVAL:    i32 = 24;
    pub const IO:       i32 = 27;
    pub const ISDIR:    i32 = 29;
    pub const NOENT:    i32 = 44;
    pub const NOMEM:    i32 = 48;
    pub const NOSPC:    i32 = 52;
    pub const NOTDIR:   i32 = 54;
    pub const NOTSUP:   i32 = 58;
    pub const OVERFLOW: i32 = 63;
    pub const ROFS:     i32 = 70;
}

// ─── VFS data model ──────────────────────────────────────────────────────────

/// A single node in the virtual filesystem tree.
#[derive(Debug, Clone)]
pub enum VfsNode {
    File(VfsFile),
    Directory(VfsDirectory),
}

/// In-memory file: content is a plain `Vec<u8>` — no paging needed at the
/// 50 MB sandbox budget.
#[derive(Debug, Clone)]
pub struct VfsFile {
    /// File contents — append/write/truncate all operate on this buffer.
    pub data:        Vec<u8>,
    /// POSIX-style permission bits (e.g. 0o644).
    pub mode:        u32,
    /// Creation timestamp (seconds since Unix epoch).
    pub created_at:  u64,
    /// Last-modification timestamp.
    pub modified_at: u64,
}

impl VfsFile {
    fn new(mode: u32) -> Self {
        let now = unix_now();
        Self {
            data:        Vec::new(),
            mode,
            created_at:  now,
            modified_at: now,
        }
    }

    fn touch(&mut self) {
        self.modified_at = unix_now();
    }
}

/// In-memory directory: stores child names in a BTreeMap for sorted iteration
/// (mirrors real `readdir` ordering).
#[derive(Debug, Clone)]
pub struct VfsDirectory {
    /// Child nodes keyed by filename (no path separators).
    pub children:    BTreeMap<String, VfsNode>,
    pub mode:        u32,
    pub created_at:  u64,
    pub modified_at: u64,
}

impl VfsDirectory {
    fn new(mode: u32) -> Self {
        let now = unix_now();
        Self {
            children:    BTreeMap::new(),
            mode,
            created_at:  now,
            modified_at: now,
        }
    }
}

// ─── Open-file tracking ───────────────────────────────────────────────────────

/// WASI `oflags` bit-flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenFlags(pub u16);

impl OpenFlags {
    pub const CREAT:     u16 = 0x0001;
    pub const DIRECTORY: u16 = 0x0002;
    pub const EXCL:      u16 = 0x0004;
    pub const TRUNC:     u16 = 0x0008;

    pub fn has(self, flag: u16) -> bool { self.0 & flag != 0 }
}

/// `fdflags` passed to `path_open`.
#[derive(Debug, Clone, Copy)]
pub struct FdFlags(pub u16);

impl FdFlags {
    pub const APPEND: u16 = 0x0001;
    pub fn has(self, flag: u16) -> bool { self.0 & flag != 0 }
}

/// Rights bitmap (subset used here).
#[derive(Debug, Clone, Copy)]
pub struct Rights(pub u64);

impl Rights {
    pub const FD_READ:        u64 = 1 << 1;
    pub const FD_WRITE:       u64 = 1 << 6;
    pub const FD_SEEK:        u64 = 1 << 2;
    pub const PATH_OPEN:      u64 = 1 << 12;
    pub const FD_READDIR:     u64 = 1 << 22;
    pub fn has(self, r: u64) -> bool { self.0 & r != 0 }
}

/// An entry in the open-file-descriptor table.
#[derive(Debug)]
pub struct OpenHandle {
    /// Canonical, normalised absolute path inside the VFS.
    pub path:     String,
    /// Byte offset for the next read/write.
    pub position: u64,
    /// Rights this descriptor was opened with.
    pub rights:   Rights,
    /// Fd-level flags (APPEND, etc.).
    pub fd_flags: FdFlags,
    /// Whether this handle refers to a directory (for readdir support).
    pub is_dir:   bool,
}

// ─── Ring buffer for stdout/stderr ───────────────────────────────────────────

/// Fixed-capacity ring buffer.  The WASM module writes to `fd 1` / `fd 2`;
/// the host reads from here and forwards bytes to the SSE/WebSocket bridge.
pub struct RingBuffer {
    buf:      Mutex<Vec<u8>>,
    capacity: usize,
    written:  AtomicU64,
}

impl RingBuffer {
    pub fn new(capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            buf:      Mutex::new(Vec::with_capacity(capacity)),
            capacity,
            written:  AtomicU64::new(0),
        })
    }

    /// Append bytes; silently drops oldest data when at capacity (lossy).
    pub fn write(&self, data: &[u8]) {
        let mut buf = self.buf.lock();
        let available = self.capacity - buf.len();
        if data.len() <= available {
            buf.extend_from_slice(data);
        } else {
            // Make room by evicting the oldest bytes.
            let needed = data.len() - available;
            let buf_len = buf.len();
            buf.drain(..needed.min(buf_len));
            buf.extend_from_slice(data);
        }
        self.written.fetch_add(data.len() as u64, Ordering::Relaxed);
    }

    /// Drain all buffered bytes (called by the SSE bridge on each poll).
    pub fn drain(&self) -> Vec<u8> {
        let mut buf = self.buf.lock();
        std::mem::take(&mut *buf)
    }

    /// Total bytes written since creation (monotonic, never wraps).
    pub fn total_written(&self) -> u64 {
        self.written.load(Ordering::Relaxed)
    }
}

// ─── Core VfsState ───────────────────────────────────────────────────────────

/// The per-sandbox VFS state.  One instance is created per sandbox slot and
/// stored in the `Store<SandboxData>` via `SandboxData`.
pub struct VfsState {
    /// The filesystem tree, rooted at "/".
    root:          RwLock<BTreeMap<String, VfsNode>>,
    /// Open file-descriptor table.
    open_fds:      Mutex<HashMap<u32, OpenHandle>>,
    /// Monotonically increasing fd counter (starts at `FIRST_GUEST_FD`).
    next_fd:       AtomicU32,
    /// Total bytes written across all fds this session (quota enforcement).
    pub bytes_written: AtomicU64,

    /// Captured stdout stream — drained by the streaming bridge.
    pub stdout: Arc<RingBuffer>,
    /// Captured stderr stream.
    pub stderr: Arc<RingBuffer>,
}

impl VfsState {
    /// Create a new, empty VFS with a root directory pre-populated.
    pub fn new() -> Arc<Self> {
        let mut root: BTreeMap<String, VfsNode> = BTreeMap::new();

        // Pre-create canonical POSIX directories so guests don't have to.
        for dir in &["/tmp", "/home", "/workspace"] {
            root.insert(dir.to_string(), VfsNode::Directory(VfsDirectory::new(0o755)));
        }

        Arc::new(Self {
            root:          RwLock::new(root),
            open_fds:      Mutex::new(HashMap::new()),
            next_fd:       AtomicU32::new(FIRST_GUEST_FD),
            bytes_written: AtomicU64::new(0),
            stdout:        RingBuffer::new(256 * 1024), // 256 KB stdout ring
            stderr:        RingBuffer::new(64 * 1024),  // 64 KB stderr ring
        })
    }

    // ── Path helpers ─────────────────────────────────────────────────────────

    /// Canonicalise a guest-supplied path:
    /// * Prepend "/" if relative.
    /// * Collapse "." and ".." components, rejecting escapes above root.
    /// * Returns `Err(SandboxError::CapabilityDenied)` on `..` escape attempts.
    pub fn canonicalise(raw: &str) -> Result<String> {
        let mut parts: Vec<&str> = Vec::new();
        let path = if raw.starts_with('/') { raw } else { &format!("/{}", raw) };

        for component in path.split('/') {
            match component {
                "" | "." => {}
                ".." => {
                    if parts.pop().is_none() {
                        // Tried to escape above root — deny immediately.
                        return Err(SandboxError::CapabilityDenied {
                            capability: format!("path traversal: '{}'", raw),
                        });
                    }
                }
                name => parts.push(name),
            }
        }

        Ok(if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        })
    }

    /// Split a canonical path into (parent_dir, filename).
    fn split_path(path: &str) -> (String, String) {
        match path.rfind('/') {
            Some(0) | None => ("/".to_string(), path.trim_start_matches('/').to_string()),
            Some(idx)      => (path[..idx].to_string(), path[idx + 1..].to_string()),
        }
    }

    // ── fd allocation ─────────────────────────────────────────────────────────

    fn alloc_fd(&self) -> Result<u32> {
        let fds = self.open_fds.lock();
        if fds.len() >= MAX_FDS {
            return Err(SandboxError::VfsFdExhausted { max: MAX_FDS });
        }
        // Simple monotonic counter; wrap-around would need a free-list in
        // production, but u32 exhaustion at 500+ sandboxes is theoretical.
        Ok(self.next_fd.fetch_add(1, Ordering::Relaxed))
    }

    // ── Public VFS operations (called by the WASI interceptor) ───────────────

    /// `path_open(dirfd, path, oflags, fs_rights_base, fd_flags) -> fd`
    pub fn path_open(
        &self,
        raw_path:   &str,
        oflags:     OpenFlags,
        rights:     Rights,
        fd_flags:   FdFlags,
    ) -> Result<u32> {
        let path = Self::canonicalise(raw_path)?;
        trace!(path = %path, "vfs::path_open");

        let mut root = self.root.write();

        let node_exists = root.contains_key(&path);

        if !node_exists {
            if oflags.has(OpenFlags::CREAT) {
                // Ensure parent directory exists.
                let (parent, _) = Self::split_path(&path);
                if parent != "/" && !root.contains_key(&parent) {
                    return Err(SandboxError::VfsNotFound { path: parent });
                }
                root.insert(path.clone(), VfsNode::File(VfsFile::new(0o644)));
            } else {
                return Err(SandboxError::VfsNotFound { path });
            }
        } else {
            // File already exists.
            // Honour O_EXCL — fail if CREAT|EXCL and file already exists.
            if oflags.has(OpenFlags::CREAT) && oflags.has(OpenFlags::EXCL) {
                return Err(SandboxError::VfsInternal {
                    msg: format!("O_EXCL: '{}' already exists", path),
                });
            }
            if oflags.has(OpenFlags::TRUNC) {
                // Truncate existing file to zero length.
                if let Some(VfsNode::File(f)) = root.get_mut(&path) {
                    f.data.clear();
                    f.touch();
                }
            }
        }

        let is_dir = matches!(root.get(&path), Some(VfsNode::Directory(_)));

        let fd = self.alloc_fd()?;
        self.open_fds.lock().insert(fd, OpenHandle {
            path,
            position: 0,
            rights,
            fd_flags,
            is_dir,
        });

        Ok(fd)
    }

    /// `fd_read(fd, iovs) -> bytes_read`
    ///
    /// Reads up to `buf.len()` bytes at the current position into `buf`.
    /// Returns number of bytes actually read (0 = EOF).
    pub fn fd_read(&self, fd: u32, buf: &mut [u8]) -> Result<usize> {
        let mut fds = self.open_fds.lock();
        let handle = fds.get_mut(&fd).ok_or(SandboxError::VfsReadOnly { fd })?;

        if !handle.rights.has(Rights::FD_READ) {
            return Err(SandboxError::VfsReadOnly { fd });
        }
        if handle.is_dir {
            return Err(SandboxError::VfsInternal {
                msg: "cannot fd_read a directory".into(),
            });
        }

        let root = self.root.read();
        let file = match root.get(&handle.path) {
            Some(VfsNode::File(f)) => f,
            _ => return Err(SandboxError::VfsNotFound { path: handle.path.clone() }),
        };

        let start = handle.position as usize;
        if start >= file.data.len() {
            return Ok(0); // EOF
        }

        let end = (start + buf.len()).min(file.data.len());
        let n   = end - start;
        buf[..n].copy_from_slice(&file.data[start..end]);
        handle.position += n as u64;

        trace!(fd, bytes = n, "vfs::fd_read");
        Ok(n)
    }

    /// `fd_write(fd, iovs) -> bytes_written`
    ///
    /// Writes `data` at the current position (or appends if `APPEND` flag set).
    /// Enforces the per-session write quota.
    pub fn fd_write(&self, fd: u32, data: &[u8]) -> Result<usize> {
        // ── Quota guard ──────────────────────────────────────────────────────
        let prev = self.bytes_written.fetch_add(data.len() as u64, Ordering::Relaxed);
        if prev + data.len() as u64 > WRITE_QUOTA_BYTES {
            // Roll back the counter to avoid accumulating past the limit.
            self.bytes_written.fetch_sub(data.len() as u64, Ordering::Relaxed);
            return Err(SandboxError::VfsInternal {
                msg: format!(
                    "write quota ({} MB) exceeded",
                    WRITE_QUOTA_BYTES / (1024 * 1024)
                ),
            });
        }

        let mut fds = self.open_fds.lock();
        let handle = fds.get_mut(&fd).ok_or(SandboxError::VfsReadOnly { fd })?;

        if !handle.rights.has(Rights::FD_WRITE) {
            return Err(SandboxError::VfsReadOnly { fd });
        }

        let mut root = self.root.write();
        let file = match root.get_mut(&handle.path) {
            Some(VfsNode::File(f)) => f,
            _ => return Err(SandboxError::VfsNotFound { path: handle.path.clone() }),
        };

        if handle.fd_flags.has(FdFlags::APPEND) {
            // APPEND mode: always write to end, regardless of position.
            handle.position = file.data.len() as u64;
        }

        let pos = handle.position as usize;

        // Extend file if we're writing past its current end.
        if pos > file.data.len() {
            file.data.resize(pos, 0);
        }

        let end = pos + data.len();
        if end > file.data.len() {
            file.data.resize(end, 0);
        }
        file.data[pos..end].copy_from_slice(data);
        handle.position = end as u64;
        file.touch();

        trace!(fd, bytes = data.len(), "vfs::fd_write");
        Ok(data.len())
    }

    /// `fd_seek(fd, offset, whence) -> new_offset`
    pub fn fd_seek(&self, fd: u32, offset: i64, whence: u8) -> Result<u64> {
        let mut fds = self.open_fds.lock();
        let handle  = fds.get_mut(&fd).ok_or_else(|| SandboxError::VfsReadOnly { fd })?;

        if !handle.rights.has(Rights::FD_SEEK) {
            return Err(SandboxError::CapabilityDenied {
                capability: format!("fd_seek on fd={fd}"),
            });
        }

        let root = self.root.read();
        let file_len = match root.get(&handle.path) {
            Some(VfsNode::File(f)) => f.data.len() as u64,
            _                      => return Err(SandboxError::VfsNotFound { path: handle.path.clone() }),
        };

        // WASI whence: 0 = SET, 1 = CUR, 2 = END
        let new_pos: i64 = match whence {
            0 => offset,
            1 => handle.position as i64 + offset,
            2 => file_len as i64 + offset,
            _ => return Err(SandboxError::VfsInternal { msg: format!("invalid whence={whence}") }),
        };

        if new_pos < 0 {
            return Err(SandboxError::VfsInternal { msg: "seek before start of file".into() });
        }
        handle.position = new_pos as u64;
        Ok(handle.position)
    }

    /// `fd_close(fd)`
    pub fn fd_close(&self, fd: u32) -> Result<()> {
        let removed = self.open_fds.lock().remove(&fd);
        if removed.is_none() {
            debug!(fd, "vfs::fd_close on unknown fd (ignored)");
        }
        Ok(())
    }

    /// `fd_filestat_get(fd) -> Filestat`
    ///
    /// Returns (filetype, size, atim, mtim) as a tuple.
    /// filetype: 1 = regular file, 3 = directory
    pub fn fd_filestat_get(&self, fd: u32) -> Result<(u8, u64, u64, u64)> {
        let fds  = self.open_fds.lock();
        let handle = fds.get(&fd).ok_or(SandboxError::VfsReadOnly { fd })?;
        let root = self.root.read();

        match root.get(&handle.path) {
            Some(VfsNode::File(f)) => Ok((1, f.data.len() as u64, f.created_at, f.modified_at)),
            Some(VfsNode::Directory(d)) => Ok((3, 0, d.created_at, d.modified_at)),
            None => Err(SandboxError::VfsNotFound { path: handle.path.clone() }),
        }
    }

    /// Convenience: read the entire contents of a file by path (used by tests
    /// and the optional Turso flush path).
    pub fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        let canon = Self::canonicalise(path)?;
        let root  = self.root.read();
        match root.get(&canon) {
            Some(VfsNode::File(f)) => Ok(f.data.clone()),
            Some(VfsNode::Directory(_)) => Err(SandboxError::VfsInternal {
                msg: format!("'{}' is a directory", canon),
            }),
            None => Err(SandboxError::VfsNotFound { path: canon }),
        }
    }

    /// List a directory (used by `fd_readdir` host shim).
    pub fn list_dir(&self, path: &str) -> Result<Vec<String>> {
        let canon = Self::canonicalise(path)?;
        let root  = self.root.read();

        // Collect all keys that are direct children of `canon`.
        let prefix = if canon == "/" { "/".to_string() } else { format!("{}/", canon) };
        let mut entries: Vec<String> = root
            .range(prefix.clone()..)
            .take_while(|(k, _)| k.starts_with(&prefix))
            .filter_map(|(k, _)| {
                let suffix = &k[prefix.len()..];
                if !suffix.contains('/') { Some(suffix.to_string()) } else { None }
            })
            .collect();
        entries.sort(); // BTreeMap gives sorted keys, but explicit sort is cheap.
        Ok(entries)
    }

    /// Snapshot all VFS content (used for Turso/LibSQL edge persistence flush).
    pub fn snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        let root = self.root.read();
        root.iter()
            .filter_map(|(k, v)| {
                if let VfsNode::File(f) = v { Some((k.clone(), f.data.clone())) } else { None }
            })
            .collect()
    }
}

// ─── WASI host-function shims ─────────────────────────────────────────────────
//
// These are standalone `fn` pointers (not methods) so they can be passed
// directly to `wasmtime::Linker::func_wrap`.  They receive a `Caller<SandboxData>`
// so they can reach both the linear memory and the `VfsState` attached to the
// store's data.
//
// Each function reads the iovec array from guest linear memory, dispatches to
// `VfsState`, then writes back the result pointer.

/// Read `n * 8` bytes from WASM linear memory at offset `ptr`.
/// Returns a slice of `[u8]`; caller must bound-check.
///
/// # Safety
/// `offset + len` must be within `mem.data(caller)` bounds — callers must verify.
pub fn read_mem_slice(mem_data: &[u8], offset: usize, len: usize) -> Option<&[u8]> {
    mem_data.get(offset..offset + len)
}

/// Write a `u32` in little-endian format into WASM linear memory.
pub fn write_u32_le(mem_data: &mut [u8], offset: usize, val: u32) -> bool {
    if offset + 4 > mem_data.len() { return false; }
    mem_data[offset..offset + 4].copy_from_slice(&val.to_le_bytes());
    true
}

/// Write a `u64` in little-endian format into WASM linear memory.
pub fn write_u64_le(mem_data: &mut [u8], offset: usize, val: u64) -> bool {
    if offset + 8 > mem_data.len() { return false; }
    mem_data[offset..offset + 8].copy_from_slice(&val.to_le_bytes());
    true
}

/// Read a `u32` in little-endian format from WASM linear memory.
pub fn read_u32_le(mem_data: &[u8], offset: usize) -> Option<u32> {
    mem_data.get(offset..offset + 4)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()))
}

// ─── Helper ───────────────────────────────────────────────────────────────────

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_vfs() -> Arc<VfsState> { VfsState::new() }

    #[test]
    fn canonicalise_rejects_traversal() {
        assert!(VfsState::canonicalise("/../etc/passwd").is_err());
        assert!(VfsState::canonicalise("../../etc").is_err());
    }

    #[test]
    fn canonicalise_normalises_dots() {
        assert_eq!(VfsState::canonicalise("/a/./b/../c").unwrap(), "/a/c");
        assert_eq!(VfsState::canonicalise("relative/path").unwrap(), "/relative/path");
    }

    #[test]
    fn create_write_read_file() {
        let vfs = make_vfs();
        let rights = Rights(Rights::FD_READ | Rights::FD_WRITE | Rights::FD_SEEK);
        let fd = vfs.path_open(
            "/workspace/hello.txt",
            OpenFlags(OpenFlags::CREAT),
            rights,
            FdFlags(0),
        ).unwrap();

        let written = vfs.fd_write(fd, b"hello, wasm world!").unwrap();
        assert_eq!(written, 18);

        vfs.fd_seek(fd, 0, 0).unwrap(); // rewind
        let mut buf = vec![0u8; 18];
        let read = vfs.fd_read(fd, &mut buf).unwrap();
        assert_eq!(read, 18);
        assert_eq!(&buf, b"hello, wasm world!");

        vfs.fd_close(fd).unwrap();
    }

    #[test]
    fn write_quota_enforced() {
        let vfs = make_vfs();
        // Exhaust the quota by artificially bumping the counter.
        vfs.bytes_written.fetch_add(WRITE_QUOTA_BYTES, Ordering::Relaxed);

        let rights = Rights(Rights::FD_READ | Rights::FD_WRITE);
        let fd = vfs.path_open("/tmp/x", OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        let result = vfs.fd_write(fd, b"overflow");
        assert!(result.is_err());
    }

    #[test]
    fn ring_buffer_drains() {
        let rb = RingBuffer::new(1024);
        rb.write(b"line one\n");
        rb.write(b"line two\n");
        let drained = rb.drain();
        assert_eq!(drained, b"line one\nline two\n");
        assert!(rb.drain().is_empty());
    }

    #[test]
    fn list_dir_returns_children() {
        let vfs = make_vfs();
        let rights = Rights(Rights::FD_READ | Rights::FD_WRITE);
        vfs.path_open("/tmp/a.txt", OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();
        vfs.path_open("/tmp/b.txt", OpenFlags(OpenFlags::CREAT), rights, FdFlags(0)).unwrap();

        let entries = vfs.list_dir("/tmp").unwrap();
        assert!(entries.contains(&"a.txt".to_string()));
        assert!(entries.contains(&"b.txt".to_string()));
    }
}
