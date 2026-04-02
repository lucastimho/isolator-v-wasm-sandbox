/// VFS File Output Demo
///
/// Demonstrates writing files to the virtual filesystem.  Rust's std::fs is
/// NOT used here because the sandbox exposes no preopened directories via
/// fd_prestat_get (which is what std::fs relies on to discover mount points).
/// Instead we call raw WASI syscalls through the `wasi` crate — the VFS
/// interceptor in wasm-worker-manager ignores the dirfd argument and resolves
/// absolute paths directly, so passing "/workspace/output.txt" works fine.

fn write_vfs_file(path: &str, content: &[u8]) -> bool {
    unsafe {
        match wasi::path_open(
            3,                                              // dirfd — ignored by VFS interceptor
            0,                                              // dirflags
            path,
            wasi::OFLAGS_CREAT | wasi::OFLAGS_TRUNC,
            wasi::RIGHTS_FD_WRITE | wasi::RIGHTS_FD_READ,
            wasi::RIGHTS_FD_WRITE | wasi::RIGHTS_FD_READ,
            0,                                              // fdflags
        ) {
            Ok(fd) => {
                let ciov = wasi::Ciovec {
                    buf:     content.as_ptr(),
                    buf_len: content.len(),
                };
                let _ = wasi::fd_write(fd, &[ciov]);
                let _ = wasi::fd_close(fd);
                true
            }
            Err(_) => false,
        }
    }
}

fn main() {
    println!("VFS File Output Demo");
    println!("====================");

    let txt = b"Written by Isolator-V WASM sandbox.\nFile: /workspace/output.txt\n";
    let json = br#"{"demo":"vfs","status":"ok","files_written":2}"#;

    if write_vfs_file("/workspace/output.txt", txt) {
        println!("  Writing /workspace/output.txt ...");
    } else {
        eprintln!("  ERROR: could not write /workspace/output.txt");
    }

    if write_vfs_file("/workspace/report.json", json) {
        println!("  Writing /workspace/report.json ...");
    } else {
        eprintln!("  ERROR: could not write /workspace/report.json");
    }

    println!("Files written. Check the left panel.");
}
