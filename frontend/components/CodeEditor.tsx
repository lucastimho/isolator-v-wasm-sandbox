"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Play,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Code2,
  RotateCcw,
} from "lucide-react";

// ── Default starter code ─────────────────────────────────────────────────────

const DEFAULT_SOURCE = `fn main() {
    println!("Hello from my custom WASM agent!");

    // Write a file to the sandbox VFS
    let data = r#"{"status": "complete", "answer": 42}"#;
    std::fs::create_dir_all("/workspace/output").unwrap();
    std::fs::write("/workspace/output/result.json", data).unwrap();

    println!("Wrote result.json to /workspace/output/");
    println!("Agent finished successfully.");
}
`;

// ── Types ────────────────────────────────────────────────────────────────────

type CompileState = "idle" | "compiling" | "success" | "error";

interface CompileResult {
  wasmB64: string;
  wasmBytes: number;
  compileMs: number;
  warnings: string;
}

interface CompileError {
  stderr: string;
  compileMs: number;
}

interface CodeEditorProps {
  /** Called when compilation succeeds — parent wires this to the execution pipeline. */
  onCompiled: (wasmB64: string) => void;
  /** Whether a sandbox session is currently running (disables compile+run). */
  running: boolean;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CodeEditor({ onCompiled, running }: CodeEditorProps) {
  const [source, setSource] = useState(DEFAULT_SOURCE);
  const [compileState, setCompileState] = useState<CompileState>("idle");
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null);
  const [compileError, setCompileError] = useState<CompileError | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Handle Tab key for indentation inside the textarea
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.currentTarget;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const value = ta.value;
        const newValue = value.substring(0, start) + "    " + value.substring(end);
        setSource(newValue);
        // Restore cursor position after React re-renders
        requestAnimationFrame(() => {
          ta.selectionStart = ta.selectionEnd = start + 4;
        });
      }
    },
    []
  );

  // ── Compile + Run ────────────────────────────────────────────────────

  const handleCompileAndRun = useCallback(async () => {
    if (running || compileState === "compiling") return;

    setCompileState("compiling");
    setCompileResult(null);
    setCompileError(null);

    try {
      const resp = await fetch("/api/v1/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, edition: "2021" }),
      });

      const body = await resp.json();

      if (!resp.ok) {
        // Compilation failed (400) — show rustc errors
        setCompileState("error");
        setCompileError({
          stderr: body.stderr ?? body.error ?? "Unknown compilation error",
          compileMs: body.compile_ms ?? 0,
        });
        return;
      }

      // Compilation succeeded
      setCompileState("success");
      setCompileResult({
        wasmB64: body.wasm_b64,
        wasmBytes: body.wasm_bytes,
        compileMs: body.compile_ms,
        warnings: body.warnings ?? "",
      });

      // Hand the compiled WASM to the parent for execution
      onCompiled(body.wasm_b64);
    } catch (err) {
      setCompileState("error");
      setCompileError({
        stderr: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        compileMs: 0,
      });
    }
  }, [source, running, compileState, onCompiled]);

  // ── Ctrl/Cmd+Enter shortcut to compile+run ────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleCompileAndRun();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCompileAndRun]);

  // ── Reset ──────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    setSource(DEFAULT_SOURCE);
    setCompileState("idle");
    setCompileResult(null);
    setCompileError(null);
  }, []);

  // Detect Mac for keyboard hint
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl";

  return (
    <div className="flex h-full flex-col bg-[var(--color-void)]">
      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3">
        <Code2 className="h-3.5 w-3.5 text-[var(--color-accent)]" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Rust Editor
        </span>

        <div className="flex-1" />

        {/* Compile status badge */}
        {compileState === "compiling" && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--color-text-muted)]">
            <Loader2 className="h-3 w-3 animate-spin" />
            compiling…
          </span>
        )}
        {compileState === "success" && compileResult && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--color-ok)]">
            <CheckCircle2 className="h-3 w-3" />
            {(compileResult.wasmBytes / 1024).toFixed(1)} KB in {compileResult.compileMs}ms
          </span>
        )}
        {compileState === "error" && (
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-[var(--color-danger)]">
            <AlertTriangle className="h-3 w-3" />
            compile failed
          </span>
        )}

        {/* Reset button */}
        <button
          onClick={handleReset}
          className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-secondary)]"
          aria-label="Reset editor to starter code"
          title="Reset to starter code"
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>

        {/* Compile + Run button */}
        <button
          onClick={handleCompileAndRun}
          disabled={running || compileState === "compiling"}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-2.5 py-1 font-mono text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="Compile Rust source and run in sandbox"
        >
          {compileState === "compiling" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Play className="h-3 w-3" />
          )}
          Compile &amp; Run
          <kbd className="ml-1 rounded border border-white/20 px-1 py-px text-[9px] opacity-60">
            {mod}↵
          </kbd>
        </button>
      </div>

      {/* ── Editor area ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <textarea
          ref={textareaRef}
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            // Clear previous compile state when source changes
            if (compileState !== "idle" && compileState !== "compiling") {
              setCompileState("idle");
            }
          }}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-full w-full resize-none bg-[var(--color-void)] p-4 font-mono text-[13px] leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] caret-[var(--color-accent)]"
          placeholder="Write your Rust program here…"
          aria-label="Rust source code editor"
        />
      </div>

      {/* ── Compiler output panel (shown on error) ──────────────────── */}
      {compileState === "error" && compileError && (
        <div className="max-h-48 shrink-0 overflow-auto border-t border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-danger)]">
            <AlertTriangle className="h-3 w-3" />
            Compiler Output
            {compileError.compileMs > 0 && (
              <span className="ml-auto text-[var(--color-text-muted)]">
                {compileError.compileMs}ms
              </span>
            )}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-danger)]">
            {compileError.stderr}
          </pre>
        </div>
      )}

      {/* ── Warnings panel (shown on success with warnings) ──────────── */}
      {compileState === "success" && compileResult?.warnings && (
        <div className="max-h-32 shrink-0 overflow-auto border-t border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-[var(--color-warn)]">
            <AlertTriangle className="h-3 w-3" />
            Warnings
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-[var(--color-warn)]">
            {compileResult.warnings}
          </pre>
        </div>
      )}
    </div>
  );
}
