//! hello — greeting banner + runtime info.
//!
//! Demonstrates:
//!  - Multiple independent writes to stdout (each println! → one fd_write call)
//!  - Unicode box-drawing characters rendered by xterm.js
//!  - Clean WASI proc_exit(0)
//!
//! Compile:
//!   cargo build --release --target wasm32-wasip1

fn main() {
    println!();
    println!("  ╭────────────────────────────────╮");
    println!("  │  🟢  Hello from Isolator-V!    │");
    println!("  ╰────────────────────────────────╯");
    println!();
    println!("  runtime  : wasmtime 25.0 (Cranelift)");
    println!("  ABI      : WASI snapshot_preview1");
    println!("  sandbox  : isolator-v / wasm-worker-manager");
    println!("  memory   : 1 page (64 KiB)");
    println!();
    println!("  ✔  execution successful");
    println!();
}
