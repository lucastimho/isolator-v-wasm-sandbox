"use client";

/**
 * HelpOverlay.tsx
 *
 * Full-screen help modal opened by pressing ? or clicking the help button.
 *
 * Sections:
 *  1. Getting Started  — three-step visual workflow
 *  2. Keyboard Shortcuts — full reference table
 *  3. Panel Guide       — what each UI region does
 *  4. File Previews     — supported formats and how they render
 */

import { useEffect, useCallback } from "react";
import {
  X,
  Play,
  Square,
  RotateCcw,
  FolderOpen,
  Terminal,
  Activity,
  Cpu,
  FileText,
  Database,
  Box,
  FileCode,
  HelpCircle,
} from "lucide-react";

interface HelpOverlayProps {
  onClose: () => void;
}

// ── Keyboard shortcut table ────────────────────────────────────────────────

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ["⌘", "↵"],     description: "Start sandbox session" },
  { keys: ["Esc"],         description: "Stop running session" },
  { keys: ["⌘", "⇧", "R"], description: "Reset — clear session and terminal" },
  { keys: ["?"],           description: "Open this help overlay" },
  { keys: ["⌘", "K"],     description: "Open command palette" },
  { keys: ["⌘", "⇧", "T"], description: "Switch to Terminal tab" },
  { keys: ["⌘", "⇧", "P"], description: "Switch to Preview tab" },
];

// ── Panel guide entries ────────────────────────────────────────────────────

const PANELS = [
  {
    icon: <FolderOpen className="h-4 w-4 text-[var(--color-accent)]" />,
    name: "File Tree",
    location: "Left sidebar",
    desc: "Shows all files written by the sandbox during execution. Updates every 3 s while a session is live. Click any file to open a preview.",
  },
  {
    icon: <Activity className="h-4 w-4 text-[var(--color-ok)]" />,
    name: "Console / Preview",
    location: "Top-right pane",
    desc: "The Console tab shows the welcome screen and execution summary. The Preview tab opens automatically when you click a file in the tree.",
  },
  {
    icon: <Terminal className="h-4 w-4 text-[var(--color-warn)]" />,
    name: "Execution Terminal",
    location: "Bottom-right pane",
    desc: "Live WebSocket-streamed stdout and stderr from the WASM sandbox. Hardware-accelerated with WebGL. Supports keyboard input forwarded as stdin.",
  },
  {
    icon: <Cpu className="h-4 w-4 text-[var(--color-text-muted)]" />,
    name: "Agent Vitals",
    location: "Toolbar (right) + Left sidebar (bottom)",
    desc: "Real-time memory usage, CPU load, and wall-clock elapsed time. Sparklines are drawn at 60 FPS on a canvas element.",
  },
];

// ── File preview types ─────────────────────────────────────────────────────

const PREVIEWS = [
  { icon: <Database className="h-3.5 w-3.5" />, ext: ".csv",        label: "Sortable, paginated data grid" },
  { icon: <Activity className="h-3.5 w-3.5" />, ext: ".json / .plot", label: "Auto-detected timeseries bar chart" },
  { icon: <Box className="h-3.5 w-3.5" />,      ext: ".wasm",       label: "Sections, exports & imports inspector" },
  { icon: <FileText className="h-3.5 w-3.5" />, ext: ".log / .txt", label: "Line-numbered log viewer (ANSI stripped)" },
  { icon: <FileCode className="h-3.5 w-3.5" />, ext: ".md",         label: "Markdown rendered as plain text" },
  { icon: <Activity className="h-3.5 w-3.5" />, ext: ".png / .svg", label: "Image viewer" },
];

// ── Component ──────────────────────────────────────────────────────────────

export default function HelpOverlay({ onClose }: HelpOverlayProps) {
  // Close on Escape
  const handleKey = useCallback(
    (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); },
    [onClose]
  );
  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Panel */}
      <div className="relative flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-6 py-4">
          <div className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5 text-[var(--color-accent)]" />
            <span className="font-mono font-semibold text-[var(--color-text-primary)]">
              Help &amp; Reference
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-primary)]"
            aria-label="Close help"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* ── Scrollable body ──────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* ── 1. Getting Started ────────────────────────────────────── */}
          <Section title="Getting Started">
            <div className="grid grid-cols-3 gap-4">
              {[
                {
                  step: "1",
                  icon: <Play className="h-5 w-5 text-[var(--color-accent)]" />,
                  heading: "Start a Session",
                  body: 'Press Run (⌘↵) to create a new sandbox session. A unique session ID appears in the toolbar.',
                },
                {
                  step: "2",
                  icon: <Terminal className="h-5 w-5 text-[var(--color-ok)]" />,
                  heading: "Watch the Terminal",
                  body: "The execution terminal streams live stdout and stderr from your WASM module. You can type to send stdin.",
                },
                {
                  step: "3",
                  icon: <FolderOpen className="h-5 w-5 text-[var(--color-warn)]" />,
                  heading: "Inspect Output Files",
                  body: "Files written by the sandbox appear in the left panel. Click any file to open an interactive preview.",
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="relative rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] p-4"
                >
                  <span className="absolute right-3 top-3 font-mono text-[10px] text-[var(--color-text-muted)]">
                    {item.step} / 3
                  </span>
                  <div className="mb-3">{item.icon}</div>
                  <p className="mb-1 text-[12px] font-semibold text-[var(--color-text-primary)]">
                    {item.heading}
                  </p>
                  <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    {item.body}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          {/* ── 2. Keyboard Shortcuts ─────────────────────────────────── */}
          <Section title="Keyboard Shortcuts">
            <table className="w-full text-[12px]">
              <tbody className="divide-y divide-[var(--color-border)]">
                {SHORTCUTS.map((s, i) => (
                  <tr key={i} className="group">
                    <td className="py-2 pr-4 text-[var(--color-text-secondary)]">
                      <div className="flex items-center gap-1">
                        {s.keys.map((k, ki) => (
                          <kbd
                            key={ki}
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-muted)]"
                          >
                            {k}
                          </kbd>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 text-[var(--color-text-secondary)]">
                      {s.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-[var(--color-text-muted)]">
              On Windows / Linux replace ⌘ with Ctrl.
            </p>
          </Section>

          {/* ── 3. Panel Guide ────────────────────────────────────────── */}
          <Section title="Panel Guide">
            <div className="space-y-3">
              {PANELS.map((p) => (
                <div
                  key={p.name}
                  className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] p-3"
                >
                  <div className="mt-0.5 shrink-0">{p.icon}</div>
                  <div>
                    <div className="mb-0.5 flex items-baseline gap-2">
                      <span className="text-[12px] font-semibold text-[var(--color-text-primary)]">
                        {p.name}
                      </span>
                      <span className="text-[10px] text-[var(--color-text-muted)]">
                        {p.location}
                      </span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                      {p.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ── 4. File Preview Types ─────────────────────────────────── */}
          <Section title="File Previews">
            <div className="grid grid-cols-2 gap-2">
              {PREVIEWS.map((fp) => (
                <div
                  key={fp.ext}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-3 py-2"
                >
                  <span className="text-[var(--color-text-muted)]">{fp.icon}</span>
                  <div>
                    <span className="mr-2 font-mono text-[11px] text-[var(--color-accent)]">
                      {fp.ext}
                    </span>
                    <span className="text-[11px] text-[var(--color-text-muted)]">
                      {fp.label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* ── 5. Resizable Panels tip ───────────────────────────────── */}
          <Section title="Tips">
            <ul className="space-y-2 text-[12px] text-[var(--color-text-secondary)]">
              <li className="flex gap-2">
                <span className="mt-0.5 text-[var(--color-accent)]">›</span>
                Drag the resize handles between panels to customise the layout to your workflow.
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-[var(--color-accent)]">›</span>
                The file tree polls for new files every 3 s. Ghost files (faded, "pending" badge) are optimistically shown before the server confirms them.
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-[var(--color-accent)]">›</span>
                Opening the same session in multiple tabs keeps the file trees in sync automatically using CRDT merge (Automerge).
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-[var(--color-accent)]">›</span>
                The terminal supports full ANSI colour sequences and passes keystrokes back to the sandbox as stdin.
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 text-[var(--color-accent)]">›</span>
                If the terminal crashes with a Kernel Panic screen, click Reconnect to reinitialise the renderer without losing the session.
              </li>
            </ul>
          </Section>

        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-center justify-between border-t border-[var(--color-border)] bg-[var(--color-elevated)] px-6 py-3">
          <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
            isolator-v / execution console — v0.1.0-alpha
          </span>
          <button
            onClick={onClose}
            className="rounded bg-[var(--color-accent)] px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dim)]"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Section wrapper ────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[var(--color-border)] px-6 py-5 last:border-b-0">
      <h2 className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]">
        {title}
      </h2>
      {children}
    </div>
  );
}
