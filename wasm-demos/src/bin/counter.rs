//! counter — counts 1 → 20, one fd_write per line.
//!
//! Demonstrates:
//!  - Dynamic numeric output (integer formatting in WASM)
//!  - Streamed output: each println! flushes immediately through the
//!    WASI fd_write syscall, which the orchestrator forwards as a
//!    separate binary WebSocket frame to the terminal.
//!
//! Compile:
//!   cargo build --release --target wasm32-wasip1

fn main() {
    println!("Counting from 1 to 20:");
    println!();
    for n in 1..=20 {
        println!("  {:>3}", n);
    }
    println!();
    println!("Done ✔");
    println!();
}
