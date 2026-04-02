"use client";

/**
 * StatusBar.tsx
 *
 * Thin bar pinned to the bottom of the page.  Shows:
 *  - Left:   state icon + human-readable status message
 *  - Centre: contextual tip that changes based on sandbox state
 *  - Right:  the two most relevant keyboard shortcuts for the current state
 *
 * Principle applied: "Visibility of system status" (Nielsen #1) and
 * "Recognition over recall" (Nielsen #6) — shortcuts are always visible.
 */

import { Circle, Loader2, AlertTriangle, CheckCircle2 } from "lucide-react";

type SandboxState = "idle" | "running" | "crashed" | "complete";

interface StatusBarProps {
  sandboxState: SandboxState;
  sessionId: string | null;
  onOpenHelp: () => void;
}

// ── Per-state content ──────────────────────────────────────────────────────

const STATE_CONFIG: Record<
  SandboxState,
  {
    icon: React.ReactNode;
    label: string;
    tip: string;
    shortcuts: { keys: string; desc: string }[];
  }
> = {
  idle: {
    icon: <Circle className="h-3 w-3 text-[var(--color-text-muted)]" />,
    label: "Ready",
    tip: "Select a WASM module from the file tree, then start a session.",
    shortcuts: [
      { keys: "⌘↵", desc: "Run" },
      { keys: "?",   desc: "Help" },
    ],
  },
  running: {
    icon: <Loader2 className="h-3 w-3 animate-spin text-[var(--color-ok)]" />,
    label: "Executing",
    tip: "Sandbox is live. Output streams to the terminal — type to send stdin.",
    shortcuts: [
      { keys: "Esc",   desc: "Stop" },
      { keys: "⌘⇧R", desc: "Reset" },
    ],
  },
  crashed: {
    icon: <AlertTriangle className="h-3 w-3 text-[var(--color-danger)]" />,
    label: "Crashed",
    tip: 'Terminal renderer crashed. Click "Reconnect" in the terminal pane to restart.',
    shortcuts: [
      { keys: "⌘⇧R", desc: "Reset" },
      { keys: "?",    desc: "Help" },
    ],
  },
  complete: {
    icon: <CheckCircle2 className="h-3 w-3 text-[var(--color-ok)]" />,
    label: "Complete",
    tip: "Execution finished. Click files in the tree to inspect outputs.",
    shortcuts: [
      { keys: "⌘⇧R", desc: "Reset" },
      { keys: "⌘↵",  desc: "Run again" },
    ],
  },
};

// ── Component ──────────────────────────────────────────────────────────────

export default function StatusBar({ sandboxState, sessionId, onOpenHelp }: StatusBarProps) {
  const cfg = STATE_CONFIG[sandboxState];

  return (
    <div className="flex h-6 shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-[10px]">

      {/* ── Left: state indicator ──────────────────────────────────── */}
      <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
        {cfg.icon}
        <span className="font-mono font-medium text-[var(--color-text-secondary)]">
          {cfg.label}
        </span>
        {sessionId && (
          <>
            <span className="text-[var(--color-border)]">·</span>
            <span className="font-mono text-[var(--color-text-muted)] opacity-70">
              {sessionId}
            </span>
          </>
        )}
      </div>

      {/* ── Centre: contextual tip ─────────────────────────────────── */}
      <p className="hidden flex-1 truncate px-4 text-center text-[var(--color-text-muted)] sm:block">
        {cfg.tip}
      </p>

      {/* ── Right: shortcut hints + help link ─────────────────────── */}
      <div className="flex items-center gap-3">
        {cfg.shortcuts.map((s) => (
          <span key={s.keys} className="flex items-center gap-1 text-[var(--color-text-muted)]">
            <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-elevated)] px-1 font-mono text-[9px]">
              {s.keys}
            </kbd>
            <span className="hidden sm:inline">{s.desc}</span>
          </span>
        ))}
        <span className="h-3 w-px bg-[var(--color-border)]" />
        <button
          onClick={onOpenHelp}
          className="text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          aria-label="Open help"
        >
          ?
        </button>
      </div>
    </div>
  );
}
