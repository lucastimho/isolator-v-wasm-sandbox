"use client";

/**
 * Terminal.tsx
 *
 * Xterm.js terminal with:
 *  - WebGL hardware-accelerated rendering (WebglAddon)
 *  - FitAddon so the terminal fills its container on resize
 *  - WebSocket connection to /api/v1/ws/execute
 *  - Back-pressure buffer: incoming chunks are queued and flushed
 *    on each animation frame, preventing DOM exhaustion when the
 *    sandbox emits output faster than the browser can paint.
 */

import { useEffect, useRef, useCallback } from "react";
import type { ITheme } from "@xterm/xterm";

// ── Xterm theme palettes ───────────────────────────────────────────────────
// Both themes share the same accent / ANSI hues; only the background,
// foreground and selection colours differ so the terminal adapts naturally
// to the surrounding UI without losing colour-coding in program output.

const XTERM_DARK: ITheme = {
  background:         "#08080a",
  foreground:         "#e8e8f0",
  cursor:             "#6366f1",
  cursorAccent:       "#f1f5f9",
  selectionBackground:"rgba(99,102,241,0.3)",
  black:   "#1e1e26", red:     "#f87171", green:  "#4ade80",
  yellow:  "#facc15", blue:    "#60a5fa", magenta:"#c084fc",
  cyan:    "#22d3ee", white:   "#e8e8f0",
  brightBlack:   "#404060", brightRed:    "#ef4444",
  brightGreen:   "#22c55e", brightYellow: "#f59e0b",
  brightBlue:    "#818cf8", brightMagenta:"#a855f7",
  brightCyan:    "#06b6d4", brightWhite:  "#f1f5f9",
};

const XTERM_LIGHT: ITheme = {
  background:         "#f4f4f8",
  foreground:         "#1a1a2e",
  cursor:             "#6366f1",
  cursorAccent:       "#ffffff",
  selectionBackground:"rgba(99,102,241,0.25)",
  // ANSI colours — darkened / desaturated so they stay readable on light bg
  black:   "#2c2c3e", red:     "#c0392b", green:  "#1a7a40",
  yellow:  "#b7770d", blue:    "#2563eb", magenta:"#7c3aed",
  cyan:    "#0e7490", white:   "#52527a",
  brightBlack:   "#6c6c8c", brightRed:    "#e53e3e",
  brightGreen:   "#16a34a", brightYellow: "#d97706",
  brightBlue:    "#3b82f6", brightMagenta:"#9333ea",
  brightCyan:    "#0891b2", brightWhite:  "#1a1a2e",
};

function getXtermTheme(): ITheme {
  return document.documentElement.classList.contains("light")
    ? XTERM_LIGHT
    : XTERM_DARK;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface TerminalProps {
  /** Opaque session identifier. When it changes a new WS connection is made. */
  sessionId: string | null;
  /** When false the WS is not opened (even if sessionId is set). */
  running: boolean;
  /** Base64-encoded WASM binary to execute.  Sent as the first WebSocket frame. */
  wasmB64?: string;
  /**
   * Called when the WebSocket session ends for any reason.
   * "complete"    → clean exit (WS close code 1000).
   * "error"       → server-side failure (e.g. code 1011 "execution failed").
   * vfsSnapshot   → map of VFS file path → base64-encoded content, present
   *                 when the WASM program wrote files during execution.
   *                 Lets the parent populate the file tree without needing
   *                 VFS persistence (LIBSQL_URL) to be configured.
   * exitCode      → the WASM proc_exit() code (0 = success, non-zero = failure).
   *                 Only meaningful when outcome is "complete".
   */
  onEnd?: (outcome: "complete" | "error", vfsSnapshot?: Record<string, string>, exitCode?: number) => void;
}

// The maximum number of bytes we'll batch into a single write call.
// Anything beyond this is deferred to the next rAF tick so the browser
// stays responsive even during log floods.
const MAX_BYTES_PER_FRAME = 32_768; // 32 KB

// ── Component ──────────────────────────────────────────────────────────────

export default function Terminal({ sessionId, running, wasmB64, onEnd }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Xterm / addon refs — we hold them in refs so the cleanup effect can
  // reach them without stale closure issues.
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);

  // Back-pressure buffer
  const bufferRef = useRef<Uint8Array[]>([]);
  const rafRef = useRef<number | null>(null);
  const pendingBytesRef = useRef(0);

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);

  // Set to true in the effect cleanup before calling ws.close() so that the
  // resulting onerror / onclose callbacks know the close was intentional and
  // must NOT propagate an "error" outcome to the parent.  This prevents:
  //   • React 18 StrictMode double-mount: cleanup fires on the first mount
  //     before the socket is open, producing a spurious 1006 that would
  //     otherwise flip the sandbox into the "crashed" state and prevent the
  //     second (real) mount from ever running.
  //   • handleStop: parent sets sandboxState="idle" → running flips to false
  //     → cleanup runs → without this guard the close would overwrite "idle"
  //     with "crashed".
  const intentionalCloseRef = useRef(false);

  // VFS snapshot received in the exit frame — held until onclose fires so
  // we can pass it to onEnd in one call.
  const vfsSnapshotRef = useRef<Record<string, string> | undefined>(undefined);

  // Exit code from proc_exit() — captured in the exit frame, forwarded via onEnd.
  const exitCodeRef = useRef<number | undefined>(undefined);

  // Set to true when the exit frame contains a "trap" field, so onclose can
  // route to the "crashed" outcome rather than "complete".
  const hasTrapRef = useRef(false);

  // ── Init xterm (once, on mount) ───────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    // Dynamic imports keep Xterm off the server bundle.
    // We intentionally skip the WebglAddon: WebGL renders text on a canvas
    // that can silently produce a blank viewport on some GPU/driver combos
    // (cursor stays visible because it's a DOM overlay, not on the canvas).
    // The Canvas 2D renderer is slower but rock-solid across all hardware.
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]).then(([{ Terminal: XTerm }, { FitAddon }]) => {
      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        fontSize: 13,
        lineHeight: 1.45,
        theme: getXtermTheme(),
        cursorBlink: true,
        scrollback: 5_000,
        convertEol: true,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);

      // Defer the first fit() one frame so react-resizable-panels has time to
      // set its CSS-based panel dimensions before xterm measures the container.
      // Without this, the terminal can open with 0×0 columns and text written
      // before the resize observer fires gets dropped.
      requestAnimationFrame(() => {
        fit.fit();

        xtermRef.current = term;
        fitRef.current = fit;

        console.log("[Terminal] xterm initialised, writing welcome banner");

        // Welcome banner — written after fit() so the canvas is properly sized.
        term.writeln("\x1b[38;5;99m╔══════════════════════════════════════════╗\x1b[0m");
        term.writeln("\x1b[38;5;99m║  \x1b[1mIsolator-V Execution Terminal\x1b[0m\x1b[38;5;99m          ║\x1b[0m");
        term.writeln("\x1b[38;5;99m╚══════════════════════════════════════════╝\x1b[0m");
        term.writeln("\x1b[38;5;240mPress \x1b[0m\x1b[1mRun\x1b[0m\x1b[38;5;240m to start the sandbox session.\x1b[0m\r\n");
      });
    });

    return () => {
      disposed = true;
    };
  }, []); // run once

  // ── Sync xterm theme when light/dark mode is toggled ─────────────────
  // A MutationObserver watches the `class` attribute on <html>.  Whenever
  // the "light" / "dark" class changes, the terminal palette is swapped
  // instantly without needing to remount xterm.

  useEffect(() => {
    const observer = new MutationObserver(() => {
      if (xtermRef.current) {
        xtermRef.current.options.theme = getXtermTheme();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // ── Fit on container resize ───────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      fitRef.current?.fit();
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // ── Back-pressure flush loop ──────────────────────────────────────────

  const flushBuffer = useCallback(() => {
    rafRef.current = null;
    const term = xtermRef.current;
    if (!term) return;

    let written = 0;
    while (bufferRef.current.length > 0 && written < MAX_BYTES_PER_FRAME) {
      const chunk = bufferRef.current.shift()!;
      term.write(chunk);
      written += chunk.byteLength;
      pendingBytesRef.current -= chunk.byteLength;
    }

    // More chunks remain — schedule another flush
    if (bufferRef.current.length > 0) {
      rafRef.current = requestAnimationFrame(flushBuffer);
    }
  }, []);

  const enqueue = useCallback(
    (data: Uint8Array) => {
      bufferRef.current.push(data);
      pendingBytesRef.current += data.byteLength;
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushBuffer);
      }
    },
    [flushBuffer]
  );

  // ── WebSocket lifecycle ───────────────────────────────────────────────

  useEffect(() => {
    if (!running || !sessionId) return;

    // Mark this session's close as unintentional until the cleanup fires.
    intentionalCloseRef.current = false;

    // Snapshot the current xterm instance.  If it's still loading (Promise.all
    // not yet resolved) this will be null; writeln calls below use optional
    // chaining so they silently no-op, but ws.send() does NOT depend on term.
    const term = xtermRef.current;

    console.log("[Terminal] WS effect running", {
      sessionId,
      running,
      termReady: !!term,
      wasmB64Len: wasmB64?.length ?? 0,
    });

    // Build the WebSocket URL.
    //
    // Next.js rewrites cannot proxy WebSocket upgrades — the rewrite proxy
    // wraps http.ResponseWriter in a way that removes http.Hijacker, causing
    // the Go orchestrator's websocket.Accept() to fail.  We therefore connect
    // directly to the orchestrator using NEXT_PUBLIC_ORCHESTRATOR_URL, which
    // is set in .env.local for local dev and in the deployment environment for
    // production.  REST calls still flow through the /api/v1/* rewrite.
    const orchestratorBase = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "";
    let url: string;
    if (orchestratorBase) {
      const wsBase = orchestratorBase.replace(/^http/, "ws");
      url = `${wsBase}/ws/execute?session_id=${encodeURIComponent(sessionId)}`;
    } else {
      // Fallback: same-origin path (works when orchestrator is colocated or
      // behind a reverse proxy that correctly handles WS upgrades).
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      url = `${proto}://${window.location.host}/api/v1/ws/execute?session_id=${encodeURIComponent(sessionId)}`;
    }

    console.log("[Terminal] connecting WebSocket →", url);

    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    // Capture wasmB64 in a local variable to avoid stale-closure issues.
    // (wasmB64 is a prop, so it's safe to read here at effect-run time.)
    const wasmPayload = wasmB64;

    ws.onopen = () => {
      console.log("[Terminal] onopen fired, wasmPayload len:", wasmPayload?.length ?? 0, "ws.readyState:", ws.readyState);

      xtermRef.current?.writeln(
        `\r\n\x1b[38;5;240m┌─ connected \x1b[38;5;99m${sessionId}\x1b[0m\r\n`
      );

      // Send the execute request — this is the first (and only) client→server
      // message.  The server reads it in WSExecute, runs the WASM, and streams
      // output back as binary frames.
      if (wasmPayload) {
        const payload = JSON.stringify({
          wasm_b64:   wasmPayload,
          label:      `session-${sessionId}`,
          session_id: sessionId,
          timeout_ms: 30_000,
        });
        try {
          ws.send(payload);
          console.log("[Terminal] execute payload sent, bytes:", payload.length);
          xtermRef.current?.writeln(
            "\x1b[38;5;240m│  sent execute request — waiting for output…\x1b[0m\r\n"
          );
        } catch (err) {
          console.error("[Terminal] ws.send() threw:", err);
          xtermRef.current?.writeln(
            `\r\n\x1b[31m[terminal] failed to send execute request: ${err}\x1b[0m\r\n`
          );
        }
      } else {
        console.warn("[Terminal] no wasmPayload in onopen — waiting for input");
        xtermRef.current?.writeln(
          "\x1b[38;5;208m│  no WASM binary provided — waiting for input\x1b[0m\r\n"
        );
      }
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        enqueue(new Uint8Array(ev.data));
      } else if (typeof ev.data === "string") {
        // JSON control frames (e.g. { type: "exit", code: 0 })
        try {
          const msg = JSON.parse(ev.data) as { type: string; code?: number };
          if (msg.type === "exit") {
            // Flush any buffered stdout synchronously NOW, before writing the
            // exit footer line.  The rAF-based back-pressure buffer races with
            // React's effect cleanup: onEnd → setSandboxState → re-render →
            // cleanup runs and cancels the pending rAF, discarding the buffer.
            // Flushing here guarantees stdout appears in order, before the
            // footer, and leaves nothing for the cleanup to lose.
            if (rafRef.current !== null) {
              cancelAnimationFrame(rafRef.current);
              rafRef.current = null;
            }
            const term = xtermRef.current;
            if (term) {
              for (const chunk of bufferRef.current) {
                term.write(chunk);
              }
            }
            bufferRef.current = [];
            pendingBytesRef.current = 0;

            // Capture VFS snapshot for the parent.  Go's JSON encoder
            // base64-encodes []byte map values, so the values are already
            // base64 strings — no decoding needed here.
            const snap = (msg as Record<string, unknown>).vfs_snapshot;
            if (snap && typeof snap === "object") {
              vfsSnapshotRef.current = snap as Record<string, string>;
            }

            // Capture exit code so onEnd can surface it to the parent.
            exitCodeRef.current = msg.code ?? 0;

            // Detect WASM trap (unreachable, OOB memory, etc.)
            const trapMsg = (msg as Record<string, unknown>).trap;
            if (typeof trapMsg === "string" && trapMsg.length > 0) {
              hasTrapRef.current = true;
              xtermRef.current?.writeln(
                `\r\n\x1b[31m[wasm trap] ${trapMsg}\x1b[0m`
              );
            }

            console.log("[Terminal] exit frame received, code:", msg.code, "trap:", trapMsg);
            xtermRef.current?.writeln(
              `\r\n\x1b[38;5;240m└─ process exited with code \x1b[${
                msg.code === 0 ? "32" : "31"
              }m${msg.code ?? "?"}\x1b[0m\r\n`
            );
          }
        } catch {
          // Plain text frame — treat as terminal output
          enqueue(new TextEncoder().encode(ev.data));
        }
      }
    };

    ws.onerror = (ev) => {
      console.error("[Terminal] WebSocket onerror:", ev);
      // Suppress errors that result from the effect cleanup closing the socket
      // deliberately (StrictMode double-mount, Stop button, Reset, etc.).
      if (intentionalCloseRef.current) return;
      xtermRef.current?.writeln(
        "\r\n\x1b[31m[terminal] WebSocket error — connection lost\x1b[0m\r\n"
      );
    };

    ws.onclose = (ev) => {
      console.log("[Terminal] WebSocket onclose:", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });

      // Suppress closes that were initiated by our own cleanup handler.
      if (intentionalCloseRef.current) return;

      // NOTE: wasClean only means the TCP handshake closed gracefully — it does
      // NOT mean execution succeeded.  Code 1011 ("execution failed") arrives
      // with wasClean=true because the server sent a proper close frame.
      // We always write a status line and notify the parent.

      if (ev.code !== 1000) {
        // Non-clean exit — show the reason so the user knows what happened.
        const reason = ev.reason ? ` — ${ev.reason}` : "";
        xtermRef.current?.writeln(
          `\r\n\x1b[31m[terminal] session ended with error (code ${ev.code}${reason})\x1b[0m\r\n`
        );
        onEnd?.("error");
      } else {
        // Normal close — the exit frame was already written by onmessage.
        if (hasTrapRef.current) {
          // WASM trap: surface as "error" so the parent shows "crashed" state.
          onEnd?.("error");
        } else {
          // Clean exit — pass VFS snapshot and exit code to the parent.
          onEnd?.("complete", vfsSnapshotRef.current, exitCodeRef.current ?? 0);
        }
        vfsSnapshotRef.current = undefined; // reset for next session
        exitCodeRef.current    = undefined;
        hasTrapRef.current     = false;
      }
    };

    // Forward keyboard input back to the sandbox stdin
    const inputDisposer = xtermRef.current?.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    return () => {
      console.log("[Terminal] WS effect cleanup, ws.readyState:", ws.readyState);
      inputDisposer?.dispose();
      // Mark close as intentional BEFORE calling ws.close() so that the
      // onerror / onclose callbacks that fire synchronously (or microtask-
      // synchronously) see the flag and do not call onEnd("error").
      intentionalCloseRef.current = true;
      ws.close(1000, "session ended");
      wsRef.current = null;
      // Flush any remaining buffered output that wasn't already drained by the
      // exit-frame handler (e.g. sessions that end without a clean exit frame).
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const flushTerm = xtermRef.current;
      if (flushTerm) {
        for (const chunk of bufferRef.current) {
          flushTerm.write(chunk);
        }
      }
      bufferRef.current = [];
      pendingBytesRef.current = 0;
    };
  }, [running, sessionId, wasmB64, enqueue]);

  // ── Dispose xterm on unmount ──────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      wsRef.current?.close(1000, "unmount");
      xtermRef.current?.dispose();
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-[var(--color-void)]"
      aria-label="Execution terminal"
    />
  );
}
