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
  /** Base64-encoded WASM binary to execute.  Sent as the first WebSocket frame. */
  wasmB64?: string;
}

// The maximum number of bytes we'll batch into a single write call.
// Anything beyond this is deferred to the next rAF tick so the browser
// stays responsive even during log floods.
const MAX_BYTES_PER_FRAME = 32_768; // 32 KB

// ── Component ──────────────────────────────────────────────────────────────

export default function Terminal({ sessionId, running, wasmB64 }: TerminalProps) {
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
        theme: {
          background:  "#08080a",
          foreground:  "#e8e8f0",
          cursor:      "#6366f1",
          cursorAccent:"#f1f5f9",
          selectionBackground: "rgba(99,102,241,0.3)",
          black:   "#1e1e26", red:     "#f87171", green:  "#4ade80",
          yellow:  "#facc15", blue:    "#60a5fa", magenta:"#c084fc",
          cyan:    "#22d3ee", white:   "#e8e8f0",
          brightBlack:   "#404060", brightRed:    "#ef4444",
          brightGreen:   "#22c55e", brightYellow: "#f59e0b",
          brightBlue:    "#818cf8", brightMagenta:"#a855f7",
          brightCyan:    "#06b6d4", brightWhite:  "#f1f5f9",
        },
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
            console.log("[Terminal] exit frame received, code:", msg.code);
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
      xtermRef.current?.writeln(
        "\r\n\x1b[31m[terminal] WebSocket error — connection lost\x1b[0m\r\n"
      );
    };

    ws.onclose = (ev) => {
      console.log("[Terminal] WebSocket onclose:", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      if (ev.wasClean) return;
      xtermRef.current?.writeln(
        `\r\n\x1b[38;5;240m[terminal] disconnected (code ${ev.code})\x1b[0m\r\n`
      );
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
      className="h-full w-full overflow-hidden"
      style={{ background: "#08080a" }}
      aria-label="Execution terminal"
    />
  );
}
