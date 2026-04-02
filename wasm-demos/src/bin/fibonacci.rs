//! fibonacci — first 20 Fibonacci numbers.
//!
//! Demonstrates:
//!  - Iterative computation inside a WASM sandbox
//!  - Formatted tabular output with right-aligned numbers
//!  - Integer arithmetic entirely within the WASM linear memory model
//!
//! Compile:
//!   cargo build --release --target wasm32-wasip1

fn main() {
    println!("Fibonacci sequence (first 20 terms):");
    println!();

    let mut a: u64 = 1;
    let mut b: u64 = 1;

    for i in 1..=20 {
        println!("  F({:>2}) = {:>7}", i, a);
        let next = a + b;
        a = b;
        b = next;
    }

    // Sum of first 20 Fibonacci numbers = F(22) - 1
    let sum: u64 = {
        let (mut x, mut y) = (1u64, 1u64);
        let mut s = 0u64;
        for _ in 0..20 {
            s += x;
            let nx = x + y;
            x = y;
            y = nx;
        }
        s
    };

    println!();
    println!("  Sum of first 20 terms = {}", sum);
    println!();
}
