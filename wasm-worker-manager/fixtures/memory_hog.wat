;; fixtures/memory_hog.wat
;;
;; Adversarial guest: tries to grow linear memory to 100 MB (1600 pages × 64KB).
;; The ResourceLimiter in the Store will deny the grow — memory.grow returns -1.
;; The guest handles the failure gracefully and writes "denied" to stdout.
;;
;; Expected: exit_code=0, stdout="denied", no crash.
;;
;; Compile: wat2wasm fixtures/memory_hog.wat -o fixtures/memory_hog.wasm

(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit"
    (func $proc_exit (param i32)))

  (memory 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  ;; "denied" = 6 bytes at offset 0
  ;; "grown"  = 5 bytes at offset 16
  (data (i32.const 0)  "denied")
  (data (i32.const 16) "grown!")

  ;; iovec at [32], nwritten at [40]

  (func $start (local $result i32)
    ;; Attempt to grow by 1600 pages = 100 MB.  Limit is 50 MB (800 pages).
    (local.set $result (memory.grow (i32.const 1600)))

    ;; memory.grow returns -1 on failure, ≥0 on success.
    (if (i32.eq (local.get $result) (i32.const -1))
      (then
        ;; Write "denied" to stdout.
        (i32.store (i32.const 32) (i32.const 0))
        (i32.store (i32.const 36) (i32.const 6))
        (drop (call $fd_write (i32.const 1) (i32.const 32) (i32.const 1) (i32.const 40)))
      )
      (else
        ;; Write "grown!" (should never happen).
        (i32.store (i32.const 32) (i32.const 16))
        (i32.store (i32.const 36) (i32.const 6))
        (drop (call $fd_write (i32.const 1) (i32.const 32) (i32.const 1) (i32.const 40)))
      )
    )
    (call $proc_exit (i32.const 0))
  )
)
