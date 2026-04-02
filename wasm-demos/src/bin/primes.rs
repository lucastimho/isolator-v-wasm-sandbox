//! primes — Sieve of Eratosthenes up to 100.
//!
//! Demonstrates:
//!  - Non-trivial algorithm running inside a WASM sandbox
//!  - Stack-allocated array (no heap allocator needed)
//!  - Formatted multi-column output
//!
//! Compile:
//!   cargo build --release --target wasm32-wasip1

fn main() {
    const LIMIT: usize = 100;
    let mut sieve = [true; LIMIT + 1];
    sieve[0] = false;
    sieve[1] = false;

    let mut i = 2;
    while i * i <= LIMIT {
        if sieve[i] {
            let mut j = i * i;
            while j <= LIMIT {
                sieve[j] = false;
                j += i;
            }
        }
        i += 1;
    }

    let primes: Vec<usize> = (2..=LIMIT).filter(|&n| sieve[n]).collect();

    println!("Primes up to {} (Sieve of Eratosthenes):", LIMIT);
    println!();

    for (idx, chunk) in primes.chunks(10).enumerate() {
        let row: Vec<String> = chunk.iter().map(|p| format!("{:>4}", p)).collect();
        let _ = idx; // suppress unused warning
        println!(" {}", row.join(""));
    }

    println!();
    println!("  Found {} primes", primes.len());
    println!();
}
