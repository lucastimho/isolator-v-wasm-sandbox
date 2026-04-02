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

// ── Types ──────────────────────────────────────────────────────────────────

interface TerminalProps {
  /** Opaque session identifier. When it changes a new WS connection is made. */
  sessionId: string | null;
  /** When false the WS is not opened (even if sessionId is set). */
  running: boolean;
}

// The maximum number of bytes we'll batch into a single write call.
// Anything beyond this is deferred to the next rAF tick so the browser
// stays responsive even during log floods.
const MAX_BYTES_PER_FRAME = 32_768; // 32 KB

// ── Component ──────────────────────────────────────────────────────────────

export default function Terminal({ sessionId, running }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Xterm / addon refs — we hold them in refs so the cleanup effect can
  // reach them without stale closure issues.
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const webglRef = useRef<import("@xterm/addon-webgl").WebglAddon | null>(null);

  // Back-pressure buffer
  const bufferRef = useRef<Uint8Array[]>([]);
  const rafRef = useRef<number | null>(null);
  const pendingBytesRef = useRef(0);

  // WebSocket
  const wsRef = useRef<WebSocket | null>(null);

  // ── Init xterm (once, on mount) ───────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;

    // Dynamic imports keep Xterm off the server bundle
    Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-webgl"),
    ]).then(([{ Terminal: XTerm }, { FitAddon }, { WebglAddon }]) => {
      if (disposed || !containerRef.current) return;

      const term = new XTerm({
        fontFamily: '"JetBrains Mono", "Fira Code", monospace',
        fontSize: 13,
        lineHeight: 1.45,
        theme: {
          background:  "transparent",
          foreground:  "#e8e8f0",
          cursor:      "#6366f1",
          cursorAccent:"#08080a",
          selectionBackground: "rgba(99,102,241,0.3)",
          black:   "#1e1e26", red:     "#f87171", green:  "#4ade80",
          yellow:  "#facc15", blue:    "#60a5fa", magenta:"#c084fc",
          cyan:    "#22d3ee", white:   "#e8e8f0",
          brightBlack:   "#404060", brightRed:    "#ef4444",
          brightGreen:   "#22c55e", brightYellow: "#f59e0b",
          brightBlue:    "#818cf8", brightMagenta:"#a855f7",
          brightCyan:    "#06b6d4", brightWhite:  "#f1f5f9",
        },
        allowTransparency: true,
        cursorBlink: true,
        scrollback: 5_000,
        convertEol: true,
      });

      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current!);
      fit.fit();

      // WebGL — gracefully falls back if context unavailable
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          webglRef.current = null;
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch {
        // Canvas 2D fallback is fine
      }

      xtermRef.current = term;
      fitRef.current = fit;

      // Welcome banner
      term.writeln(
        "\x1b[38;5;99m╔══════════════════════════════════════════╗\x1b[0m"
      );
      term.writeln(
        "\x1b[38;5;99m║  \x1b[1mIsolator-V Execution Terminal\x1b[0m\x1b[38;5;99m          ║\x1b[0m"
      );
      term.writeln(
        "\x1b[38;5;99m╚══════════════════════════════════════════╝\x1b[0m"
      );
      term.writeln(
        "\x1b[38;5;240mPress \x1b[0m\x1b[1mRun\x1b[0m\x1b[38;5;240m to start the sandbox session.\x1b[0m\r\n"
      );
    });

    return () => {
      disposed = true;
    };
  }, []); // run once

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

    const term = xtermRef.current;

    // Build the WebSocket URL; works for both http and https hosts
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/api/v1/ws/execute?session_id=${encodeURIComponent(sessionId)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      term?.writeln(
        `\r\n\x1b[38;5;240m┌─ connected \x1b[38;5;99m${sessionId}\x1b[0m\r\n`
      );
    };

    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        enqueue(new Uint8Array(ev.data));
      } else if (typeof ev.data === "string") {
        // JSON control frames (e.g. { type: "exit", code: 0 })
        try {
          const msg = JSON.parse(ev.data) as { type: string; code?: number };
          if (msg.type === "exit") {
            term?.writeln(
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

    ws.onerror = () => {
      term?.writeln(
        "\r\n\x1b[31m[terminal] WebSocket error — connection lost\x1b[0m\r\n"
      );
    };

    ws.onclose = (ev) => {
      if (ev.wasClean) return;
      term?.writeln(
        `\r\n\x1b[38;5;240m[terminal] disconnected (code ${ev.code})\x1b[0m\r\n`
      );
    };

    // Forward keyboard input back to the sandbox stdin
    const inputDisposer = term?.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    return () => {
      inputDisposer?.dispose();
      ws.close(1000, "session ended");
      wsRef.current = null;
      // Cancel any pending rAF flush
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      bufferRef.current = [];
      pendingBytesRef.current = 0;
    };
  }, [running, sessionId, enqueue]);

  // ── Dispose xterm on unmount ──────────────────────────────────────────

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      wsRef.current?.close(1000, "unmount");
      webglRef.current?.dispose();
      xtermRef.current?.dispose();
    };
  }, []);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden bg-transparent"
      aria-label="Execution terminal"
    />
  );
}
