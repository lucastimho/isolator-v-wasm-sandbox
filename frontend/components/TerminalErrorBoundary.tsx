"use client";

/**
 * TerminalErrorBoundary.tsx
 *
 * Class-based React error boundary that wraps the Xterm.js terminal.
 * When an unhandled JS error propagates up from the terminal subtree the
 * boundary catches it and replaces the pane with a "Kernel Panic" screen —
 * a full-height monospace diagnostic block styled after classic BSOD/oops
 * messages, with a blinking cursor and a reconnect button.
 *
 * Props:
 *   children    — the terminal subtree to protect
 *   onCrash     — called when the boundary catches (e.g. to set sandboxState)
 *   onReconnect — called when the user clicks "Reconnect"
 */

import { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  onCrash?: () => void;
  onReconnect?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class TerminalErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ errorInfo: info });
    this.props.onCrash?.();
    // Log to console so devtools still show the stack
    console.error("[TerminalErrorBoundary] caught:", error, info);
  }

  handleReconnect = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReconnect?.();
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return <KernelPanic error={this.state.error} onReconnect={this.handleReconnect} />;
  }
}

// ── Kernel Panic UI ────────────────────────────────────────────────────────

function KernelPanic({
  error,
  onReconnect,
}: {
  error: Error | null;
  onReconnect: () => void;
}) {
  const message  = error?.message ?? "Unknown error";
  const stack    = error?.stack   ?? "";
  // Grab first two non-blank stack lines for the digest block
  const digest   = stack
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(1, 4)
    .join("\n");

  const timestamp = new Date().toISOString();

  return (
    <div className="flex h-full flex-col items-start justify-start overflow-auto bg-[var(--color-void)] p-6 font-mono text-[var(--color-danger)] select-text">

      {/* ── Header ── */}
      <div className="mb-6 space-y-0.5">
        <p className="text-sm font-semibold uppercase tracking-widest">
          *** KERNEL PANIC — NOT SYNCING
        </p>
        <p className="text-xs text-[var(--color-text-muted)] tracking-widest">
          isolator-v / terminal subsystem
        </p>
      </div>

      {/* ── Panic banner ── */}
      <div className="mb-6 w-full rounded border border-[var(--color-danger)] bg-[rgba(239,68,68,0.06)] p-4 text-xs leading-relaxed text-[var(--color-danger)]">
        <p className="mb-1 font-semibold">[  FATAL  ] Unhandled exception in render tree</p>
        <p className="break-all text-[var(--color-text-secondary)]">{message}</p>
      </div>

      {/* ── Call trace ── */}
      {digest && (
        <div className="mb-6 w-full space-y-0.5">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Call Trace:
          </p>
          {digest.split("\n").map((line, i) => (
            <p key={i} className="text-[11px] text-[var(--color-text-secondary)] break-all">
              <span className="mr-2 text-[var(--color-text-muted)]">[{String(i).padStart(3, "0")}]</span>
              {line.trim()}
            </p>
          ))}
        </div>
      )}

      {/* ── System state ── */}
      <div className="mb-6 grid w-full grid-cols-2 gap-3 text-[11px] sm:grid-cols-3">
        {[
          { label: "PID",       value: "—" },
          { label: "CPU",       value: "0x00" },
          { label: "Signal",    value: "SIGABRT" },
          { label: "Timestamp", value: timestamp.slice(0, 19).replace("T", " ") },
          { label: "Module",    value: "xterm-renderer" },
          { label: "Subsystem", value: "terminal" },
        ].map(({ label, value }) => (
          <div key={label} className="space-y-0.5">
            <p className="text-[9px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {label}
            </p>
            <p className="text-[var(--color-text-secondary)]">{value}</p>
          </div>
        ))}
      </div>

      {/* ── Divider ── */}
      <div className="mb-6 w-full border-t border-[var(--color-border)]" />

      {/* ── Recovery prompt ── */}
      <div className="flex items-center gap-3">
        <p className="text-xs text-[var(--color-text-muted)]">
          Press{" "}
          <kbd className="rounded border border-[var(--color-border)] px-1 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            Reconnect
          </kbd>{" "}
          to restart the terminal subsystem.
        </p>
        <button
          onClick={onReconnect}
          className="rounded border border-[var(--color-danger)] px-3 py-1.5 text-xs font-medium text-[var(--color-danger)] transition-colors hover:bg-[rgba(239,68,68,0.1)]"
        >
          Reconnect
        </button>
      </div>

      {/* ── Blinking cursor ── */}
      <p className="mt-8 text-xs text-[var(--color-danger)]">
        _<span className="kernel-panic-cursor" />
      </p>
    </div>
  );
}
