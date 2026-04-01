;; fixtures/infinite_loop.wat
;;
;; Adversarial guest: spins in a tight loop forever.
;; Expected result: SandboxError::CpuQuotaExceeded { limit_ms: 50 }
;; This validates that Wasmtime's epoch interruption fires correctly.
;;
;; Compile: wat2wasm fixtures/infinite_loop.wat -o fixtures/infinite_loop.wasm

(module
  (memory 1)
  (export "memory" (memory 0))
  (export "_start" (func $start))

  (func $start
    ;; Unconditional branch-to-self → infinite loop.
    ;; No WASI calls, no fuel consumption — pure spin.
    (loop $spin
      (br $spin)
    )
  )
)
