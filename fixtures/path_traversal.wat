;; fixtures/path_traversal.wat
;;
;; Security test: guest tries to open "/../etc/passwd" via path_open.
;; The VFS canonicaliser must reject this with ERRNO_NOTSUP (58) / ERRNO_NOENT (44).
;; The module writes the errno to stdout so the test can assert on it.
;;
;; Compile: wat2wasm fixtures/path_traversal.wat -o fixtures/path_traversal.wasm

(module
  (import "wasi_snapshot_preview1" "path_open"
    (func $path_open
      (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; "/../etc/passwd" — 14 bytes at offset 0
  (data (i32.const 0) "/../etc/passwd")

  ;; Response strings
  ;; "BLOCKED" at offset 32, "ALLOWED" at offset 48
  (data (i32.const 32) "BLOCKED")
  (data (i32.const 48) "ALLOWED")

  ;; Scratch: iovec at [64], nwritten at [72], opened_fd at [80]

  (func $start (local $errno i32)
    ;; Try to open "/../etc/passwd"
    (local.set $errno
      (call $path_open
        (i32.const 3)   ;; dirfd
        (i32.const 0)   ;; dirflags
        (i32.const 0)   ;; path ptr ("/../etc/passwd")
        (i32.const 14)  ;; path len
        (i32.const 0)   ;; oflags (no O_CREAT)
        (i64.const 2)   ;; rights: FD_READ
        (i64.const 0)
        (i32.const 0)   ;; fdflags
        (i32.const 80)  ;; opened_fd_ptr
      )
    )

    ;; errno == 0 means the traversal succeeded (BAD); anything else is GOOD.
    (if (i32.eqz (local.get $errno))
      (then
        ;; Write "ALLOWED" — this should never happen.
        (i32.store (i32.const 64) (i32.const 48))
        (i32.store (i32.const 68) (i32.const 7))
      )
      (else
        ;; Write "BLOCKED" — expected result.
        (i32.store (i32.const 64) (i32.const 32))
        (i32.store (i32.const 68) (i32.const 7))
      )
    )
    (drop (call $fd_write (i32.const 1) (i32.const 64) (i32.const 1) (i32.const 72)))
    (call $proc_exit (i32.const 0))
  )
)
