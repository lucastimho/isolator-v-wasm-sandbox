;; fixtures/hello.wat
;;
;; A well-behaved guest that:
;;  1. Writes "Hello from WASM sandbox!\n" to stdout (fd 1).
;;  2. Creates /workspace/result.json in the VFS.
;;  3. Calls proc_exit(0) cleanly.
;;
;; Compile with:
;;   wat2wasm fixtures/hello.wat -o fixtures/hello.wasm
;;
;; Then Base64-encode for the API:
;;   base64 -i fixtures/hello.wasm | tr -d '\n' > fixtures/hello.wasm.b64

(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close"
    (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; ── String constants ─────────────────────────────────────────────────────
  ;; [offset 0..26]  "Hello from WASM sandbox!\n"
  ;; [offset 32..56] "/workspace/result.json"
  ;; [offset 64..118] JSON payload
  (data (i32.const 0)  "Hello from WASM sandbox!\n")
  (data (i32.const 32) "/workspace/result.json")
  (data (i32.const 64) "{\"status\":\"ok\",\"sandbox\":true}")

  ;; ── Scratch space ────────────────────────────────────────────────────────
  ;; [128]  iovec for stdout write { buf:u32, buf_len:u32 }
  ;; [136]  nwritten (output)
  ;; [140]  opened_fd (output of path_open)
  ;; [148]  iovec for file write
  ;; [156]  nwritten (file)

  (func $start (local $file_fd i32)

    ;; ── 1. Write greeting to stdout ───────────────────────────────────────
    (i32.store (i32.const 128) (i32.const 0))   ;; iov.buf    = 0
    (i32.store (i32.const 132) (i32.const 26))  ;; iov.buf_len = 26
    (drop
      (call $fd_write
        (i32.const 1)    ;; fd = stdout
        (i32.const 128)  ;; iovs ptr
        (i32.const 1)    ;; iovs_len
        (i32.const 136)  ;; nwritten ptr
      )
    )

    ;; ── 2. Create /workspace/result.json in VFS ───────────────────────────
    (call $path_open
      (i32.const 3)   ;; dirfd (ignored by VFS interceptor)
      (i32.const 0)   ;; dirflags
      (i32.const 32)  ;; path ptr
      (i32.const 22)  ;; path len (strlen "/workspace/result.json")
      (i32.const 1)   ;; oflags: O_CREAT
      (i64.const 64)  ;; rights_base: FD_WRITE (bit 6)
      (i64.const 0)   ;; rights_inh
      (i32.const 0)   ;; fdflags
      (i32.const 140) ;; opened_fd_ptr
    )
    drop

    (local.set $file_fd (i32.load (i32.const 140)))

    ;; ── 3. Write JSON to the file ─────────────────────────────────────────
    (i32.store (i32.const 148) (i32.const 64))  ;; iov.buf
    (i32.store (i32.const 152) (i32.const 30))  ;; iov.buf_len
    (drop
      (call $fd_write
        (local.get $file_fd)
        (i32.const 148)
        (i32.const 1)
        (i32.const 156)
      )
    )
    (drop (call $fd_close (local.get $file_fd)))

    ;; ── 4. Clean exit ─────────────────────────────────────────────────────
    (call $proc_exit (i32.const 0))
  )
)
