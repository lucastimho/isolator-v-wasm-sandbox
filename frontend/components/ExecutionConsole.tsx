"use client";

import { useState, useCallback, useEffect } from "react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
} from "react-resizable-panels";
import dynamic from "next/dynamic";
import {
  FolderOpen,
  Terminal as TerminalIcon,
  Activity,
  Play,
  Square,
  RotateCcw,
  ChevronRight,
  HelpCircle,
  CheckCircle2,
  ArrowRight,
  Cpu,
  MemoryStick,
  Zap,
} from "lucide-react";

import VirtualFileTree, { type VFSEntry } from "./VirtualFileTree";
import AgentVitals from "./AgentVitals";
import { TerminalErrorBoundary } from "./TerminalErrorBoundary";
import ComponentRegistry from "./ComponentRegistry";
import Tooltip from "./Tooltip";
import HelpOverlay from "./HelpOverlay";
import StatusBar from "./StatusBar";

// Xterm.js uses browser APIs — always load client-side only
const Terminal = dynamic(() => import("./Terminal"), { ssr: false });

type SandboxState = "idle" | "running" | "crashed" | "complete";

// ── Demo WASM modules ─────────────────────────────────────────────────────
// Each module is a pre-compiled WASI binary (wasm32-wasip1).
// They exercise fd_write / proc_exit and are validated against the wasmtime
// WASI runtime used by wasm-worker-manager.
//
// To recompile from Rust source:  cd wasm-demos && cargo build --release --target wasm32-wasip1
// Or from WAT:  wat2wasm <name>.wat -o <name>.wasm && base64 -i <name>.wasm | tr -d '\n'

/** Noop — minimal 34-byte module, exports _start() → proc_exit(0). No output. */
const NOOP_WASM_B64 = (() => {
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x0a, 0x01, 0x06, 0x5f, 0x73, 0x74, 0x61,
    0x72, 0x74, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
})();

/** Hello — greeting banner + runtime info via multiple fd_write calls. */
const HELLO_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93" +
  "cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVt" +
  "b3J5AgAGX3N0YXJ0AAIK8QIB7gIAQYAEQQA2AgBBhARBAjYCAEEBQYAEQQFBkAQQABpBgARBAjYC" +
  "AEGEBEHqADYCAEEBQYAEQQFBkAQQABpBgARB7AA2AgBBhARBMDYCAEEBQYAEQQFBkAQQABpBgARB" +
  "nAE2AgBBhARB6gA2AgBBAUGABEEBQZAEEAAaQYAEQYYCNgIAQYQEQQI2AgBBAUGABEEBQZAEEAAa" +
  "QYAEQYgCNgIAQYQEQSg2AgBBAUGABEEBQZAEEAAaQYAEQbACNgIAQYQEQSU2AgBBAUGABEEBQZAE" +
  "EAAaQYAEQdUCNgIAQYQEQS82AgBBAUGABEEBQZAEEAAaQYAEQYQDNgIAQYQEQR42AgBBAUGABEEB" +
  "QZAEEAAaQYAEQaIDNgIAQYQEQQI2AgBBAUGABEEBQZAEEAAaQYAEQaQDNgIAQYQEQR02AgBBAUGA" +
  "BEEBQZAEEAAaQYAEQcEDNgIAQYQEQQI2AgBBAUGABEEBQZAEEAAaQQAQAQsLygMBAEEAC8MDDQog" +
  "IOKVreKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKU" +
  "gOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKVrg0KICDilIIgIPCf" +
  "n6IgIEhlbGxvIGZyb20gSXNvbGF0b3ItViEgICAgICAgIOKUgg0KICDilbDilIDilIDilIDilIDi" +
  "lIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDi" +
  "lIDilIDilIDilIDilIDilIDilIDilIDilIDila8NCg0KICBydW50aW1lICA6IHdhc210aW1lIDI1" +
  "LjAgKENyYW5lbGlmdCkNCiAgQUJJICAgICAgOiBXQVNJIHNuYXBzaG90X3ByZXZpZXcxDQogIHNh" +
  "bmRib3ggIDogaXNvbGF0b3ItdiAvIHdhc20td29ya2VyLW1hbmFnZXINCiAgbWVtb3J5ICAgOiAx" +
  "IHBhZ2UgKDY0IEtpQikNCg0KICDinJQgIGV4ZWN1dGlvbiBzdWNjZXNzZnVsDQoNCg==";

/** Counter — prints 1..20 as separate fd_write calls (tests streaming). */
const COUNTER_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93" +
  "cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVt" +
  "b3J5AgAGX3N0YXJ0AAIKlgUBkwUAQYAEQQA2AgBBhARBGjYCAEEBQYAEQQFBkAQQABpBgARBGjYC" +
  "AEGEBEEHNgIAQQFBgARBAUGQBBAAGkGABEEhNgIAQYQEQQc2AgBBAUGABEEBQZAEEAAaQYAEQSg2" +
  "AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARBLzYCAEGEBEEHNgIAQQFBgARBAUGQBBAAGkGABEE2" +
  "NgIAQYQEQQc2AgBBAUGABEEBQZAEEAAaQYAEQT02AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARB" +
  "xAA2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARBywA2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpB" +
  "gARB0gA2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARB2QA2AgBBhARBBzYCAEEBQYAEQQFBkAQQ" +
  "ABpBgARB4AA2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARB5wA2AgBBhARBBzYCAEEBQYAEQQFB" +
  "kAQQABpBgARB7gA2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARB9QA2AgBBhARBBzYCAEEBQYAE" +
  "QQFBkAQQABpBgARB/AA2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARBgwE2AgBBhARBBzYCAEEB" +
  "QYAEQQFBkAQQABpBgARBigE2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARBkQE2AgBBhARBBzYC" +
  "AEEBQYAEQQFBkAQQABpBgARBmAE2AgBBhARBBzYCAEEBQYAEQQFBkAQQABpBgARBnwE2AgBBhARB" +
  "BzYCAEEBQYAEQQFBkAQQABpBgARBpgE2AgBBhARBDDYCAEEBQYAEQQFBkAQQABpBABABCwu5AQEA" +
  "QQALsgFDb3VudGluZyBmcm9tIDEgdG8gMjA6DQoNCiAgICAxDQogICAgMg0KICAgIDMNCiAgICA0" +
  "DQogICAgNQ0KICAgIDYNCiAgICA3DQogICAgOA0KICAgIDkNCiAgIDEwDQogICAxMQ0KICAgMTIN" +
  "CiAgIDEzDQogICAxNA0KICAgMTUNCiAgIDE2DQogICAxNw0KICAgMTgNCiAgIDE5DQogICAyMA0K" +
  "DQpEb25lIOKclA0K";

/** Fibonacci — first 20 Fibonacci numbers with formatted output. */
const FIBONACCI_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93" +
  "cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVt" +
  "b3J5AgAGX3N0YXJ0AAIKmgUBlwUAQYAEQQA2AgBBhARBKDYCAEEBQYAEQQFBkAQQABpBgARBKDYC" +
  "AEGEBEETNgIAQQFBgARBAUGQBBAAGkGABEE7NgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQc4A" +
  "NgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQeEANgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAE" +
  "QfQANgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQYcBNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAa" +
  "QYAEQZoBNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQa0BNgIAQYQEQRM2AgBBAUGABEEBQZAE" +
  "EAAaQYAEQcABNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQdMBNgIAQYQEQRM2AgBBAUGABEEB" +
  "QZAEEAAaQYAEQeYBNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQfkBNgIAQYQEQRM2AgBBAUGA" +
  "BEEBQZAEEAAaQYAEQYwCNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQZ8CNgIAQYQEQRM2AgBB" +
  "AUGABEEBQZAEEAAaQYAEQbICNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQcUCNgIAQYQEQRM2" +
  "AgBBAUGABEEBQZAEEAAaQYAEQdgCNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQesCNgIAQYQE" +
  "QRM2AgBBAUGABEEBQZAEEAAaQYAEQf4CNgIAQYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQZEDNgIA" +
  "QYQEQRM2AgBBAUGABEEBQZAEEAAaQYAEQaQDNgIAQYQEQSU2AgBBAUGABEEBQZAEEAAaQQAQAQsL" +
  "0AMBAEEAC8kDRmlib25hY2NpIHNlcXVlbmNlIChmaXJzdCAyMCB0ZXJtcyk6DQoNCiAgRiggMSkg" +
  "PSAgICAgICAxDQogIEYoIDIpID0gICAgICAgMQ0KICBGKCAzKSA9ICAgICAgIDINCiAgRiggNCkg" +
  "PSAgICAgICAzDQogIEYoIDUpID0gICAgICAgNQ0KICBGKCA2KSA9ICAgICAgIDgNCiAgRiggNykg" +
  "PSAgICAgIDEzDQogIEYoIDgpID0gICAgICAyMQ0KICBGKCA5KSA9ICAgICAgMzQNCiAgRigxMCkg" +
  "PSAgICAgIDU1DQogIEYoMTEpID0gICAgICA4OQ0KICBGKDEyKSA9ICAgICAxNDQNCiAgRigxMykg" +
  "PSAgICAgMjMzDQogIEYoMTQpID0gICAgIDM3Nw0KICBGKDE1KSA9ICAgICA2MTANCiAgRigxNikg" +
  "PSAgICAgOTg3DQogIEYoMTcpID0gICAgMTU5Nw0KICBGKDE4KSA9ICAgIDI1ODQNCiAgRigxOSkg" +
  "PSAgICA0MTgxDQogIEYoMjApID0gICAgNjc2NQ0KDQogIFN1bSBvZiBmaXJzdCAyMCB0ZXJtcyA9" +
  "IDE3NzEwDQoNCg==";

/** Primes — Sieve of Eratosthenes up to 100. */
const PRIMES_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93" +
  "cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgECBQMBAAEHEwIGbWVt" +
  "b3J5AgAGX3N0YXJ0AAIKnQEBmgEAQYAEQQA2AgBBhARBLTYCAEEBQYAEQQFBkAQQABpBgARBLTYC" +
  "AEGEBEEqNgIAQQFBgARBAUGQBBAAGkGABEHXADYCAEGEBEEqNgIAQQFBgARBAUGQBBAAGkGABEGB" +
  "ATYCAEGEBEEWNgIAQQFBgARBAUGQBBAAGkGABEGXATYCAEGEBEEXNgIAQQFBgARBAUGQBBAAGkEA" +
  "EAELC7UBAQBBAAuuAVByaW1lcyB1cCB0byAxMDAgKFNpZXZlIG9mIEVyYXRvc3RoZW5lcyk6DQoN" +
  "CiAgIDIgICAzICAgNSAgIDcgIDExICAxMyAgMTcgIDE5ICAyMyAgMjkNCiAgMzEgIDM3ICA0MSIA" +
  "NDMgIDQ3ICA1MyAgNTkgIDYxICA2NyAgNzENCiAgNzMgIDc5ICA4MyAgODkgIDk3DQoNCiAgRm91" +
  "bmQgMjUgcHJpbWVzDQoNCg==";

/** Files — writes two files to /workspace via raw WASI path_open calls.
 *  The VFS snapshot is delivered inline in the WebSocket exit frame so the
 *  file tree populates without requiring LIBSQL_URL to be configured.
 */
const FILES_WASM_B64 =
  "AGFzbQEAAAABIgVgCX9/f39/fn5/fwF/YAR/f39/AX9gAX8Bf2ABfwBgAAACiwEEFndhc2lfc25h" +
  "cHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0" +
  "ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UAAhZ3YXNpX3NuYXBzaG90X3ByZXZp" +
  "ZXcxCXByb2NfZXhpdAADAwIBBAUDAQABBxMCBm1lbW9yeQIABl9zdGFydAAECpoBAZcBAEEAQRA2" +
  "AgBBAEGdATYCBEEBQQBBAUEIEAEaQQNBAEGtAUEVQQlCf0J/QQBBDBAAGkEAQcIBNgIAQQBBwAA2" +
  "AgRBDCgCAEEAQQFBCBABGkEMKAIAEAIaQQNBAEGCAkEWQQlCf0J/QQBBDBAAGkEAQZgCNgIAQQBB" +
  "LjYCBEEMKAIAQQBBAUEIEAEaQQwoAgAQAhpBABADCwu9AgEAQRALtgJWRlMgRmlsZSBPdXRwdXQg" +
  "RGVtbw0KPT09PT09PT09PT09PT09PT09PT0NCiAgV3JpdGluZyAvd29ya3NwYWNlL291dHB1dC50" +
  "eHQgLi4uDQogIFdyaXRpbmcgL3dvcmtzcGFjZS9yZXBvcnQuanNvbiAuLi4NCkZpbGVzIHdyaXR0" +
  "ZW4uIENoZWNrIHRoZSBsZWZ0IHBhbmVsLg0KL3dvcmtzcGFjZS9vdXRwdXQudHh0V3JpdHRlbiBi" +
  "eSBJc29sYXRvci1WIFdBU00gc2FuZGJveC4KRmlsZTogL3dvcmtzcGFjZS9vdXRwdXQudHh0Ci93" +
  "b3Jrc3BhY2UvcmVwb3J0Lmpzb257ImRlbW8iOiJ2ZnMiLCJzdGF0dXMiOiJvayIsImZpbGVzX3dy" +
  "aXR0ZW4iOjJ9";

// ── Demo registry ─────────────────────────────────────────────────────────────
type DemoKey = "noop" | "hello" | "counter" | "fibonacci" | "primes" | "files";

const DEMOS: Record<DemoKey, { label: string; description: string; wasmB64: string }> = {
  noop:      { label: "noop",      description: "No output — pipeline smoke test",              wasmB64: NOOP_WASM_B64      },
  hello:     { label: "hello",     description: "Greeting banner + runtime info",               wasmB64: HELLO_WASM_B64     },
  counter:   { label: "counter",   description: "Count 1→20 (streamed per fd_write call)",      wasmB64: COUNTER_WASM_B64   },
  fibonacci: { label: "fibonacci", description: "First 20 Fibonacci numbers",                   wasmB64: FIBONACCI_WASM_B64 },
  primes:    { label: "primes",    description: "Sieve of Eratosthenes up to 100",              wasmB64: PRIMES_WASM_B64    },
  files:     { label: "files",     description: "Writes 2 files to /workspace — tests VFS I/O", wasmB64: FILES_WASM_B64     },
};

// Detect Mac so we show ⌘ vs Ctrl in hints
const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const MOD   = isMac ? "⌘" : "Ctrl";

export default function ExecutionConsole() {
  const [sandboxState,     setSandboxState]     = useState<SandboxState>("idle");
  const [sessionId,        setSessionId]        = useState<string | null>(null);
  const [activeTab,        setActiveTab]        = useState<"terminal" | "preview">("terminal");
  const [previewFile,      setPreviewFile]      = useState<string | null>(null);
  const [helpOpen,         setHelpOpen]         = useState(false);
  const [showVitals,       setShowVitals]       = useState(false);
  const [selectedDemo,     setSelectedDemo]     = useState<DemoKey>("hello");
  /** VFS entries delivered inline via the WebSocket exit frame (no LIBSQL_URL needed). */
  const [inlineVfsEntries,  setInlineVfsEntries]  = useState<VFSEntry[]>([]);
  /**
   * Raw vfs_snapshot map (path → base64 content) from the WebSocket exit frame.
   * Used to serve file preview content without hitting the VFS API.
   */
  const [inlineVfsSnapshot, setInlineVfsSnapshot] = useState<Record<string, string>>({});
  /** Decoded content of the currently-previewed inline file, or undefined if using API. */
  const [inlineFileContent, setInlineFileContent] = useState<string | undefined>(undefined);

  // ── Actions ────────────────────────────────────────────────────────────

  const handleRun = useCallback(() => {
    if (sandboxState === "running") return;
    const id = `sess_${Date.now().toString(36)}`;
    setSessionId(id);
    setSandboxState("running");
    setActiveTab("terminal");
  }, [sandboxState]);

  const handleStop = useCallback(() => {
    if (sandboxState !== "running") return;
    setSandboxState("idle");
  }, [sandboxState]);

  const handleReset = useCallback(() => {
    setSandboxState("idle");
    setSessionId(null);
    setPreviewFile(null);
    setActiveTab("terminal");
    setInlineVfsEntries([]);
    setInlineVfsSnapshot({});
    setInlineFileContent(undefined);
  }, []);

  const handleFileSelect = useCallback((path: string) => {
    setPreviewFile(path);
    setActiveTab("preview");
    // If the file was delivered inline via the WebSocket exit frame, decode
    // its base64 content now so the previewer can render without an API call.
    const b64 = inlineVfsSnapshot[path];
    if (b64) {
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        setInlineFileContent(new TextDecoder().decode(bytes));
      } catch {
        // Malformed base64 — fall back to API fetch (which may also fail, but
        // that surfaces a meaningful error message rather than a silent blank).
        setInlineFileContent(undefined);
      }
    } else {
      setInlineFileContent(undefined);
    }
  }, [inlineVfsSnapshot]);

  const handleCrash = useCallback(() => setSandboxState("crashed"), []);
  const handleReconnect = useCallback(() => {
    setSandboxState("idle");
    setSessionId(null);
  }, []);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  // Principle: "Flexibility and efficiency of use" (Nielsen #7)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // ⌘↵ — Run
      if (mod && e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleRun();
        return;
      }
      // Esc — Stop
      if (e.key === "Escape" && !e.shiftKey && !mod) {
        handleStop();
        return;
      }
      // ⌘⇧R — Reset
      if (mod && e.shiftKey && e.key === "R") {
        e.preventDefault();
        handleReset();
        return;
      }
      // ⌘⇧T — Terminal tab
      if (mod && e.shiftKey && e.key === "T") {
        e.preventDefault();
        setActiveTab("terminal");
        return;
      }
      // ⌘⇧P — Preview tab
      if (mod && e.shiftKey && e.key === "P") {
        e.preventDefault();
        if (previewFile) setActiveTab("preview");
        return;
      }
      // ? — Help (when not in a text input)
      if (
        e.key === "?" &&
        !mod &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement)
      ) {
        setHelpOpen((o) => !o);
        return;
      }
      // ⌘K — Help (command palette placeholder)
      if (mod && e.key === "k") {
        e.preventDefault();
        setHelpOpen(true);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleRun, handleStop, handleReset, previewFile]);

  // ── Sidebar vitals panel: show when session is running ────────────────

  useEffect(() => {
    if (sandboxState === "running") setShowVitals(true);
  }, [sandboxState]);

  return (
    <>
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}

      <div className="flex h-full flex-col bg-[var(--color-void)]">

        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <div
          role="toolbar"
          aria-label="Sandbox controls"
          className="flex h-9 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3"
        >
          {/* Run */}
          <Tooltip content="Start sandbox session" shortcut={`${MOD}↵`} side="bottom">
            <ToolbarButton
              icon={<Play className="h-3.5 w-3.5" />}
              label="Run"
              onClick={handleRun}
              disabled={sandboxState === "running"}
              variant="accent"
              aria-label="Run sandbox"
              disabledReason="Session already running"
            />
          </Tooltip>

          {/* Stop */}
          <Tooltip content="Stop the running session" shortcut="Esc" side="bottom">
            <ToolbarButton
              icon={<Square className="h-3.5 w-3.5" />}
              label="Stop"
              onClick={handleStop}
              disabled={sandboxState !== "running"}
              aria-label="Stop sandbox"
              disabledReason="No session is running"
            />
          </Tooltip>

          {/* Reset */}
          <Tooltip content="Reset — clear session and terminal" shortcut={`${MOD}⇧R`} side="bottom">
            <ToolbarButton
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              label="Reset"
              onClick={handleReset}
              aria-label="Reset session"
            />
          </Tooltip>

          <div className="mx-1.5 h-4 w-px bg-[var(--color-border)]" />

          {/* Demo selector */}
          <Tooltip content={DEMOS[selectedDemo].description} side="bottom">
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
                demo
              </span>
              <select
                value={selectedDemo}
                onChange={(e) => setSelectedDemo(e.target.value as DemoKey)}
                disabled={sandboxState === "running"}
                className="rounded border border-[var(--color-border)] bg-[var(--color-elevated)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--color-text-secondary)] outline-none transition-colors hover:border-[var(--color-accent)] focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Select demo WASM program"
              >
                {(Object.keys(DEMOS) as DemoKey[]).map((key) => (
                  <option key={key} value={key}>
                    {DEMOS[key].label}
                  </option>
                ))}
              </select>
            </div>
          </Tooltip>

          <div className="mx-1.5 h-4 w-px bg-[var(--color-border)]" />

          {/* Session badge */}
          {sessionId ? (
            <Tooltip
              content={
                sandboxState === "running"
                  ? "Session active — connected to sandbox"
                  : sandboxState === "crashed"
                  ? "Session crashed — reconnect or reset"
                  : "Session ended"
              }
              side="bottom"
            >
              <span
                className="flex cursor-default items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-text-secondary)]"
                aria-live="polite"
                aria-label={`Session ID: ${sessionId}, status: ${sandboxState}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    sandboxState === "running"
                      ? "bg-[var(--color-ok)] animate-pulse"
                      : sandboxState === "crashed"
                      ? "bg-[var(--color-danger)]"
                      : "bg-[var(--color-text-muted)]"
                  }`}
                />
                {sessionId}
              </span>
            </Tooltip>
          ) : (
            <span
              className="font-mono text-[11px] text-[var(--color-text-muted)]"
              aria-label="No active session"
            >
              no active session
            </span>
          )}

          <div className="flex-1" />

          {/* Compact vitals */}
          <AgentVitals compact sessionId={sessionId} running={sandboxState === "running"} />

          <div className="mx-1.5 h-4 w-px bg-[var(--color-border)]" />

          {/* Help */}
          <Tooltip content="Help & keyboard shortcuts" shortcut="?" side="bottom">
            <button
              onClick={() => setHelpOpen(true)}
              aria-label="Open help"
              className="flex items-center justify-center rounded p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-primary)]"
            >
              <HelpCircle className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        {/* ── Main panel layout ────────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden">
          <PanelGroup direction="horizontal" className="h-full">

            {/* ── Left sidebar ────────────────────────────────────────── */}
            <Panel defaultSize={18} minSize={12} maxSize={35}>
              <div className="flex h-full flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">

                {/* File tree header */}
                <SidebarHeader
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  title="Files"
                  hint={sessionId ? "Click a file to preview" : "Start a session to see files"}
                />
                <div className="flex-1 overflow-y-auto">
                  <VirtualFileTree
                    sessionId={sessionId}
                    onFileSelect={handleFileSelect}
                    inlineEntries={inlineVfsEntries}
                  />
                </div>

                {/* Vitals section — slides in when a session starts */}
                {showVitals && (
                  <div className="border-t border-[var(--color-border)]">
                    <SidebarHeader
                      icon={<Cpu className="h-3.5 w-3.5" />}
                      title="Agent Vitals"
                    />
                    <AgentVitals sessionId={sessionId} running={sandboxState === "running"} />
                  </div>
                )}
              </div>
            </Panel>

            <Tooltip content="Drag to resize panels" side="bottom">
              <PanelResizeHandle className="w-1 bg-[var(--color-border)] transition-colors hover:bg-[var(--color-accent)] active:bg-[var(--color-accent)]" />
            </Tooltip>

            {/* ── Right area ──────────────────────────────────────────── */}
            <Panel defaultSize={82}>
              <PanelGroup direction="vertical" className="h-full">

                {/* ── Top: Console / Preview ───────────────────────── */}
                <Panel defaultSize={55} minSize={20}>
                  <div className="flex h-full flex-col bg-[var(--color-surface)]">
                    {/* Tab bar */}
                    <div className="flex h-8 shrink-0 items-end gap-1 border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-2">
                      <Tooltip content="Console view" shortcut={`${MOD}⇧T`} side="bottom">
                        <Tab
                          active={activeTab === "terminal"}
                          onClick={() => setActiveTab("terminal")}
                          icon={<TerminalIcon className="h-3 w-3" />}
                          label="Console"
                        />
                      </Tooltip>
                      {previewFile ? (
                        <Tooltip content={`Preview: ${previewFile}`} shortcut={`${MOD}⇧P`} side="bottom">
                          <Tab
                            active={activeTab === "preview"}
                            onClick={() => setActiveTab("preview")}
                            icon={<Activity className="h-3 w-3" />}
                            label={previewFile.split("/").pop() ?? "preview"}
                          />
                        </Tooltip>
                      ) : (
                        <span className="ml-auto flex items-center pb-1 text-[10px] text-[var(--color-text-muted)]">
                          Click a file in the tree to open a preview
                        </span>
                      )}
                    </div>

                    {/* Content */}
                    <div className="flex-1 overflow-hidden font-mono text-sm">
                      {activeTab === "preview" && previewFile ? (
                        <ComponentRegistry
                          filePath={previewFile}
                          sessionId={sessionId}
                          inlineContent={inlineFileContent}
                        />
                      ) : (
                        <WelcomePane
                          onRun={handleRun}
                          onHelp={() => setHelpOpen(true)}
                          sandboxState={sandboxState}
                          mod={MOD}
                        />
                      )}
                    </div>
                  </div>
                </Panel>

                <Tooltip content="Drag to resize panels" side="bottom">
                  <PanelResizeHandle className="h-1 bg-[var(--color-border)] transition-colors hover:bg-[var(--color-accent)] active:bg-[var(--color-accent)]" />
                </Tooltip>

                {/* ── Bottom: Terminal ─────────────────────────────── */}
                <Panel defaultSize={45} minSize={15}>
                  <div className="flex h-full flex-col bg-[var(--color-surface)]">
                    <SidebarHeader
                      icon={<TerminalIcon className="h-3.5 w-3.5" />}
                      title="Execution Terminal"
                      hint={
                        sandboxState === "idle"
                          ? "Terminal connects when you start a session"
                          : sandboxState === "running"
                          ? "Type to send stdin — output streams here"
                          : undefined
                      }
                      right={
                        sandboxState === "running" ? (
                          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-ok)]">
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-ok)]" />
                            live
                          </span>
                        ) : null
                      }
                    />
                    <div className="flex-1 overflow-hidden">
                      <TerminalErrorBoundary onCrash={handleCrash} onReconnect={handleReconnect}>
                        <Terminal
                          sessionId={sessionId}
                          running={sandboxState === "running"}
                          wasmB64={DEMOS[selectedDemo].wasmB64}
                          onEnd={(outcome, vfsSnapshot) => {
                            setSandboxState(outcome === "complete" ? "complete" : "crashed");
                            if (vfsSnapshot && Object.keys(vfsSnapshot).length > 0) {
                              // Store raw snapshot for on-demand content decoding when the
                              // user clicks a file in the tree.  Go's JSON encoder auto-
                              // base64-encodes []byte map values, so values are base64 strings.
                              setInlineVfsSnapshot(vfsSnapshot as Record<string, string>);
                              // Build VFSEntry[] for the file tree — size is estimated from
                              // base64 length × 0.75 (bytes per encoded char, approximately).
                              const entries: VFSEntry[] = Object.entries(vfsSnapshot).map(
                                ([path, b64]) => ({
                                  path,
                                  size: Math.round((b64 as string).length * 0.75),
                                })
                              );
                              setInlineVfsEntries(entries);
                            }
                          }}
                        />
                      </TerminalErrorBoundary>
                    </div>
                  </div>
                </Panel>

              </PanelGroup>
            </Panel>

          </PanelGroup>
        </div>

        {/* ── Status bar ──────────────────────────────────────────────── */}
        <StatusBar
          sandboxState={sandboxState}
          sessionId={sessionId}
          onOpenHelp={() => setHelpOpen(true)}
        />
      </div>
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function SidebarHeader({
  icon,
  title,
  hint,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-3">
      <div className="flex min-w-0 items-center gap-2 text-[var(--color-text-secondary)]">
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-widest">
          {title}
        </span>
        {hint && (
          <span className="hidden truncate text-[10px] text-[var(--color-text-muted)] xl:inline">
            — {hint}
          </span>
        )}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

function Tab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-t px-3 pb-1 pt-1 text-[11px] font-medium transition-colors ${
        active
          ? "border-b-2 border-[var(--color-accent)] text-[var(--color-text-primary)]"
          : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]"
      }`}
    >
      {icon}
      <span className="font-mono">{label}</span>
    </button>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  disabled = false,
  variant = "default",
  "aria-label": ariaLabel,
  disabledReason,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "accent";
  "aria-label"?: string;
  disabledReason?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors
        disabled:cursor-not-allowed disabled:opacity-30 ${
        variant === "accent"
          ? "bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-dim)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-primary)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ── WelcomePane ────────────────────────────────────────────────────────────
// Principle: "Match between system and real world" (Nielsen #2) — explains
// concepts in plain language, shows the workflow visually, not just as text.

function WelcomePane({
  onRun,
  onHelp,
  sandboxState,
  mod,
}: {
  onRun:  () => void;
  onHelp: () => void;
  sandboxState: SandboxState;
  mod: string;
}) {
  if (sandboxState === "complete") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <CheckCircle2 className="h-10 w-10 text-[var(--color-ok)]" />
        <div className="space-y-1">
          <p className="font-mono text-sm font-semibold text-[var(--color-ok)]">
            Execution complete
          </p>
          <p className="font-mono text-[11px] text-[var(--color-text-muted)]">
            Terminal output is shown in the console above. Output files, if any,
            appear in the left panel.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={onRun}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[var(--color-accent-dim)]"
          >
            <Play className="h-3.5 w-3.5" />
            Run Again
            <kbd className="ml-1 rounded border border-white/30 px-1 py-px font-mono text-[9px] opacity-70">
              {mod}↵
            </kbd>
          </button>
        </div>
      </div>
    );
  }

  if (sandboxState === "crashed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="font-mono text-xs text-[var(--color-danger)]">Session crashed</p>
        <p className="font-mono text-[11px] text-[var(--color-text-muted)]">
          Click <strong>Reconnect</strong> in the terminal below, or reset and start over.
        </p>
      </div>
    );
  }

  // ── Idle welcome ────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 overflow-auto p-8">

      {/* Brand + tagline */}
      <div className="text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--color-text-muted)]">
          Isolator‑V
        </p>
        <p className="mt-1 font-mono text-xs text-[var(--color-text-secondary)]">
          WebAssembly Execution Sandbox
        </p>
      </div>

      {/* Workflow diagram — 3 steps with arrows */}
      <div className="flex w-full max-w-lg items-center justify-center gap-2">
        {[
          {
            icon: <Play className="h-4 w-4 text-[var(--color-accent)]" />,
            label: "Run",
            sub: "Start a session",
          },
          {
            icon: <TerminalIcon className="h-4 w-4 text-[var(--color-ok)]" />,
            label: "Watch",
            sub: "Live terminal output",
          },
          {
            icon: <FolderOpen className="h-4 w-4 text-[var(--color-warn)]" />,
            label: "Inspect",
            sub: "Preview output files",
          },
        ].map((step, i) => (
          <div key={step.label} className="flex items-center gap-2">
            <div className="flex flex-col items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-elevated)] px-4 py-3">
              {step.icon}
              <span className="font-mono text-[11px] font-semibold text-[var(--color-text-primary)]">
                {step.label}
              </span>
              <span className="text-center font-mono text-[9px] text-[var(--color-text-muted)]">
                {step.sub}
              </span>
            </div>
            {i < 2 && (
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
            )}
          </div>
        ))}
      </div>

      {/* Sandbox limits */}
      <div className="grid w-full max-w-xs grid-cols-3 gap-2.5">
        {[
          { icon: <MemoryStick className="h-3.5 w-3.5" />, label: "Memory", value: "50 MB" },
          { icon: <Zap className="h-3.5 w-3.5" />,         label: "Timeout", value: "30 s" },
          { icon: <Cpu className="h-3.5 w-3.5" />,         label: "Transport", value: "HTTP" },
        ].map(({ icon, label, value }) => (
          <div
            key={label}
            className="flex flex-col items-center gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] py-2.5 text-center"
          >
            <span className="text-[var(--color-text-muted)]">{icon}</span>
            <span className="font-mono text-[9px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {label}
            </span>
            <span className="font-mono text-xs text-[var(--color-accent)]">{value}</span>
          </div>
        ))}
      </div>

      {/* CTA */}
      <div className="flex items-center gap-3">
        <button
          onClick={onRun}
          className="flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-dim)]"
        >
          <ChevronRight className="h-4 w-4" />
          Start Sandbox
          <kbd className="ml-1 rounded border border-white/30 px-1.5 py-px font-mono text-[10px] opacity-70">
            {mod}↵
          </kbd>
        </button>
        <button
          onClick={onHelp}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-text-primary)]"
        >
          <HelpCircle className="h-3.5 w-3.5" />
          How it works
          <kbd className="ml-1 rounded border border-[var(--color-border)] px-1 font-mono text-[9px]">
            ?
          </kbd>
        </button>
      </div>

    </div>
  );
}
