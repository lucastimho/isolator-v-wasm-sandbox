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
  XCircle,
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

type SandboxState = "idle" | "running" | "crashed" | "complete" | "nonzero";

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

/** exit1 — prints a message then calls proc_exit(1). Exit code shows red in terminal. */
const EXIT1_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3" +
  "MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgEC" +
  "BQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKIgEgAEEAQRA2AgBBBEGqATYCAEEBQQBB" +
  "AUEIEAAaQQEQAQsLsQEBAEEQC6oBRXhpdCBDb2RlIERlbW8KPT09PT09PT09PT09PT0K" +
  "VGhpcyBwcm9ncmFtIGNhbGxzIHByb2NfZXhpdCgxKSB0byB0ZXN0CnRoZSBub24temVy" +
  "byBleGl0IHBhdGggb2YgdGhlIHBpcGVsaW5lLgoKVGhlIGV4aXQgY29kZSBiZWxvdyBz" +
  "aG91bGQgYmUgcmVkLgoKRXhpdGluZyB3aXRoIGNvZGUgMS4uLgo=";

/** trap — prints then executes WASM unreachable, triggering a hardware trap. */
const TRAP_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3" +
  "MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgEC" +
  "BQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKHwEdAEEAQRA2AgBBBEGvATYCAEEBQQBB" +
  "AUEIEAAaAAsLtgEBAEEQC68BVHJhcCBEZW1vCj09PT09PT09PQpUaGlzIHByb2dyYW0g" +
  "ZXhlY3V0ZXMgdGhlIFdBU00gJ3VucmVhY2hhYmxlJwppbnN0cnVjdGlvbiB0byB0cmln" +
  "Z2VyIGEgaGFyZHdhcmUgdHJhcC4KClRoZSBzYW5kYm94IHNob3VsZCByZXBvcnQgYSBj" +
  "cmFzaGVkIHN0YXRlLgoKRXhlY3V0aW5nIHVucmVhY2hhYmxlLi4uCg==";

/** unicode — emoji, CJK, box-drawing, Cyrillic, Arabic in a single fd_write. */
const UNICODE_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3" +
  "MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgEC" +
  "BQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKIgEgAEEAQRA2AgBBBEHeAzYCAEEBQQBB" +
  "AUEIEAAaQQAQAQsL5QMBAEEQC94DVW5pY29kZSAmIEVtb2ppIFJlbmRlcmluZyBUZXN0" +
  "Cj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQoKICBFbW9qaTogICAg8J+agCDi" +
  "nIUg4p2MIOKaoO+4jyAg8J+SoSDwn5SlIPCfjq8g8J+nqgogIE1hdGg6ICAgICDOsSDO" +
  "siDOsyDOtCDOtSDOtiDOtyDOuCDOuSDOuiDOuyDOvAogIEFycm93czogICDihpAg4oaS" +
  "IOKGkSDihpMg4oaUIOKHkiDin7kg4pyTIOKclwogIEJveDogICAgICDilIzilIDilIDi" +
  "lIDilIDilIDilIDilIDilIDilIDilJAKICAgICAgICAgICAg4pSCIHNhbmRib3gg4pSC" +
  "CiAgICAgICAgICAgIOKUlOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUmAogIEph" +
  "cGFuZXNlOiDjgZPjgpPjgavjgaHjga/kuJbnlYwKICBSdXNzaWFuOiAg0J/RgNC40LLQ" +
  "tdGCLCDQvNC40YAhCiAgQXJhYmljOiAgINmF2LHYrdio2Kcg2KjYp9mE2LnYp9mE2YUK" +
  "CkFsbCBjaGFyYWN0ZXJzIHJlbmRlcmVkIGNvcnJlY3RseT8g4pyTCg==";

/** longlines — ~90-char lines to test terminal wrap / horizontal scroll. */
const LONGLINES_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3" +
  "MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgEC" +
  "BQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKIgEgAEEAQRA2AgBBBEH7BzYCAEEBQQBB" +
  "AUEIEAAaQQAQAQsLgggBAEEQC/sHTG9uZyBMaW5lcyBUZXN0Cj09PT09PT09PT09PT09" +
  "PQpMaW5lcyBiZWxvdyBhcmUgfjkwIGNoYXJzLiBUZXN0cyB0ZXJtaW5hbCB3cmFwL3Nj" +
  "cm9sbCBiZWhhdmlvdXIuCgogICAgICAgICAgICAgICAgICAxICAgICAgICAgMiAgICAg" +
  "ICAgIDMgICAgICAgICA0ICAgICAgICAgNSAgICAgICAgIDYgICAgICAgICA3ICAgICAg" +
  "ICAgOCAgICAgICAgIDkKMCAgICAgICAgMDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2" +
  "Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3" +
  "ODkwMTIzNDU2Nzg5Ci0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t" +
  "LS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0t" +
  "LQoKICBMaW5lICAxIHwgQUJDREVGR0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVG" +
  "R0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSgogIExpbmUgIDIgfCBBQkNE" +
  "RUZHSElKQUJDREVGR0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSkFCQ0RF" +
  "RkdISUpBQkNERUZHSElKCiAgTGluZSAgMyB8IEFCQ0RFRkdISUpBQkNERUZHSElKQUJD" +
  "REVGR0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSkFCQ0RFRkdISUoKICBM" +
  "aW5lICA0IHwgQUJDREVGR0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSkFC" +
  "Q0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSgogIExpbmUgIDUgfCBBQkNERUZHSElK" +
  "QUJDREVGR0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSkFCQ0RFRkdISUpB" +
  "QkNERUZHSElKCiAgTGluZSAgNiB8IEFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJ" +
  "SkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSkFCQ0RFRkdISUoKICBMaW5lICA3" +
  "IHwgQUJDREVGR0hJSkFCQ0RFRkdISUpBQkNERUZHSElKQUJDREVGR0hJSkFCQ0RFRkdI" +
  "SUpBQkNERUZHSElKQUJDREVGR0hJSgoKRG9uZS4gQ2hlY2sgZm9yIGhvcml6b250YWwg" +
  "c2Nyb2xsIG9yIHdyYXBwaW5nLgo=";

/** large — single fd_write of 300 numbered lines (~9.7 KB) to test buffer handling. */
const LARGE_WASM_B64 =
  "AGFzbQEAAAABEANgBH9/f38Bf2ABfwBgAAACRgIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3" +
  "MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAEDAgEC" +
  "BQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAIKIwEhAEEAQRA2AgBBBEG1ygA2AgBBAUEA" +
  "QQFBCBAAGkEAEAELC7xKAQBBEAu1SkxhcmdlIE91dHB1dCBUZXN0Cj09PT09PT09PT09" +
  "PT09PT09ClN0cmVhbWluZyAzMDAgbnVtYmVyZWQgbGluZXMgdG8gZXhlcmNpc2UgdGhl" +
  "IHRlcm1pbmFsIGJ1ZmZlci4KCiAgICAxOiBicmF2byBjaGFybGllIGRlbHRhIGVjaG8K" +
  "ICAgIDI6IGNoYXJsaWUgZGVsdGEgZWNobyBmb3h0cm90CiAgICAzOiBkZWx0YSBlY2hv" +
  "IGZveHRyb3QgZ29sZgogICAgNDogZWNobyBmb3h0cm90IGdvbGYgaG90ZWwKICAgIDU6" +
  "IGZveHRyb3QgZ29sZiBob3RlbCBpbmRpYQogICAgNjogZ29sZiBob3RlbCBpbmRpYSBq" +
  "dWxpZXQKICAgIDc6IGhvdGVsIGluZGlhIGp1bGlldCBraWxvCiAgICA4OiBpbmRpYSBq" +
  "dWxpZXQga2lsbyBsaW1hCiAgICA5OiBqdWxpZXQga2lsbyBsaW1hIGFscGhhCiAgIDEw" +
  "OiBraWxvIGxpbWEgYWxwaGEgYnJhdm8KICAgMTE6IGxpbWEgYWxwaGEgYnJhdm8gY2hh" +
  "cmxpZQogICAxMjogYWxwaGEgYnJhdm8gY2hhcmxpZSBkZWx0YQogICAxMzogYnJhdm8g" +
  "Y2hhcmxpZSBkZWx0YSBlY2hvCiAgIDE0OiBjaGFybGllIGRlbHRhIGVjaG8gZm94dHJv" +
  "dAogICAxNTogZGVsdGEgZWNobyBmb3h0cm90IGdvbGYKICAgMTY6IGVjaG8gZm94dHJv" +
  "dCBnb2xmIGhvdGVsCiAgIDE3OiBmb3h0cm90IGdvbGYgaG90ZWwgaW5kaWEKICAgMTg6" +
  "IGdvbGYgaG90ZWwgaW5kaWEganVsaWV0CiAgIDE5OiBob3RlbCBpbmRpYSBqdWxpZXQg" +
  "a2lsbwogICAyMDogaW5kaWEganVsaWV0IGtpbG8gbGltYQogICAyMToganVsaWV0IGtp" +
  "bG8gbGltYSBhbHBoYQogICAyMjoga2lsbyBsaW1hIGFscGhhIGJyYXZvCiAgIDIzOiBs" +
  "aW1hIGFscGhhIGJyYXZvIGNoYXJsaWUKICAgMjQ6IGFscGhhIGJyYXZvIGNoYXJsaWUg" +
  "ZGVsdGEKICAgMjU6IGJyYXZvIGNoYXJsaWUgZGVsdGEgZWNobwogICAyNjogY2hhcmxp" +
  "ZSBkZWx0YSBlY2hvIGZveHRyb3QKICAgMjc6IGRlbHRhIGVjaG8gZm94dHJvdCBnb2xm" +
  "CiAgIDI4OiBlY2hvIGZveHRyb3QgZ29sZiBob3RlbAogICAyOTogZm94dHJvdCBnb2xm" +
  "IGhvdGVsIGluZGlhCiAgIDMwOiBnb2xmIGhvdGVsIGluZGlhIGp1bGlldAogICAzMTog" +
  "aG90ZWwgaW5kaWEganVsaWV0IGtpbG8KICAgMzI6IGluZGlhIGp1bGlldCBraWxvIGxp" +
  "bWEKICAgMzM6IGp1bGlldCBraWxvIGxpbWEgYWxwaGEKICAgMzQ6IGtpbG8gbGltYSBh" +
  "bHBoYSBicmF2bwogICAzNTogbGltYSBhbHBoYSBicmF2byBjaGFybGllCiAgIDM2OiBh" +
  "bHBoYSBicmF2byBjaGFybGllIGRlbHRhCiAgIDM3OiBicmF2byBjaGFybGllIGRlbHRh" +
  "IGVjaG8KICAgMzg6IGNoYXJsaWUgZGVsdGEgZWNobyBmb3h0cm90CiAgIDM5OiBkZWx0" +
  "YSBlY2hvIGZveHRyb3QgZ29sZgogICA0MDogZWNobyBmb3h0cm90IGdvbGYgaG90ZWwK" +
  "ICAgNDE6IGZveHRyb3QgZ29sZiBob3RlbCBpbmRpYQogICA0MjogZ29sZiBob3RlbCBp" +
  "bmRpYSBqdWxpZXQKICAgNDM6IGhvdGVsIGluZGlhIGp1bGlldCBraWxvCiAgIDQ0OiBp" +
  "bmRpYSBqdWxpZXQga2lsbyBsaW1hCiAgIDQ1OiBqdWxpZXQga2lsbyBsaW1hIGFscGhh" +
  "CiAgIDQ2OiBraWxvIGxpbWEgYWxwaGEgYnJhdm8KICAgNDc6IGxpbWEgYWxwaGEgYnJh" +
  "dm8gY2hhcmxpZQogICA0ODogYWxwaGEgYnJhdm8gY2hhcmxpZSBkZWx0YQogICA0OTog" +
  "YnJhdm8gY2hhcmxpZSBkZWx0YSBlY2hvCiAgIDUwOiBjaGFybGllIGRlbHRhIGVjaG8g" +
  "Zm94dHJvdAogICA1MTogZGVsdGEgZWNobyBmb3h0cm90IGdvbGYKICAgNTI6IGVjaG8g" +
  "Zm94dHJvdCBnb2xmIGhvdGVsCiAgIDUzOiBmb3h0cm90IGdvbGYgaG90ZWwgaW5kaWEK" +
  "ICAgNTQ6IGdvbGYgaG90ZWwgaW5kaWEganVsaWV0CiAgIDU1OiBob3RlbCBpbmRpYSBq" +
  "dWxpZXQga2lsbwogICA1NjogaW5kaWEganVsaWV0IGtpbG8gbGltYQogICA1NzoganVs" +
  "aWV0IGtpbG8gbGltYSBhbHBoYQogICA1ODoga2lsbyBsaW1hIGFscGhhIGJyYXZvCiAg" +
  "IDU5OiBsaW1hIGFscGhhIGJyYXZvIGNoYXJsaWUKICAgNjA6IGFscGhhIGJyYXZvIGNo" +
  "YXJsaWUgZGVsdGEKICAgNjE6IGJyYXZvIGNoYXJsaWUgZGVsdGEgZWNobwogICA2Mjog" +
  "Y2hhcmxpZSBkZWx0YSBlY2hvIGZveHRyb3QKICAgNjM6IGRlbHRhIGVjaG8gZm94dHJv" +
  "dCBnb2xmCiAgIDY0OiBlY2hvIGZveHRyb3QgZ29sZiBob3RlbAogICA2NTogZm94dHJv" +
  "dCBnb2xmIGhvdGVsIGluZGlhCiAgIDY2OiBnb2xmIGhvdGVsIGluZGlhIGp1bGlldAog" +
  "ICA2NzogaG90ZWwgaW5kaWEganVsaWV0IGtpbG8KICAgNjg6IGluZGlhIGp1bGlldCBr" +
  "aWxvIGxpbWEKICAgNjk6IGp1bGlldCBraWxvIGxpbWEgYWxwaGEKICAgNzA6IGtpbG8g" +
  "bGltYSBhbHBoYSBicmF2bwogICA3MTogbGltYSBhbHBoYSBicmF2byBjaGFybGllCiAg" +
  "IDcyOiBhbHBoYSBicmF2byBjaGFybGllIGRlbHRhCiAgIDczOiBicmF2byBjaGFybGll" +
  "IGRlbHRhIGVjaG8KICAgNzQ6IGNoYXJsaWUgZGVsdGEgZWNobyBmb3h0cm90CiAgIDc1" +
  "OiBkZWx0YSBlY2hvIGZveHRyb3QgZ29sZgogICA3NjogZWNobyBmb3h0cm90IGdvbGYg" +
  "aG90ZWwKICAgNzc6IGZveHRyb3QgZ29sZiBob3RlbCBpbmRpYQogICA3ODogZ29sZiBo" +
  "b3RlbCBpbmRpYSBqdWxpZXQKICAgNzk6IGhvdGVsIGluZGlhIGp1bGlldCBraWxvCiAg" +
  "IDgwOiBpbmRpYSBqdWxpZXQga2lsbyBsaW1hCiAgIDgxOiBqdWxpZXQga2lsbyBsaW1h" +
  "IGFscGhhCiAgIDgyOiBraWxvIGxpbWEgYWxwaGEgYnJhdm8KICAgODM6IGxpbWEgYWxw" +
  "aGEgYnJhdm8gY2hhcmxpZQogICA4NDogYWxwaGEgYnJhdm8gY2hhcmxpZSBkZWx0YQog" +
  "ICA4NTogYnJhdm8gY2hhcmxpZSBkZWx0YSBlY2hvCiAgIDg2OiBjaGFybGllIGRlbHRh" +
  "IGVjaG8gZm94dHJvdAogICA4NzogZGVsdGEgZWNobyBmb3h0cm90IGdvbGYKICAgODg6" +
  "IGVjaG8gZm94dHJvdCBnb2xmIGhvdGVsCiAgIDg5OiBmb3h0cm90IGdvbGYgaG90ZWwg" +
  "aW5kaWEKICAgOTA6IGdvbGYgaG90ZWwgaW5kaWEganVsaWV0CiAgIDkxOiBob3RlbCBp" +
  "bmRpYSBqdWxpZXQga2lsbwogICA5MjogaW5kaWEganVsaWV0IGtpbG8gbGltYQogICA5" +
  "MzoganVsaWV0IGtpbG8gbGltYSBhbHBoYQogICA5NDoga2lsbyBsaW1hIGFscGhhIGJy" +
  "YXZvCiAgIDk1OiBsaW1hIGFscGhhIGJyYXZvIGNoYXJsaWUKICAgOTY6IGFscGhhIGJy" +
  "YXZvIGNoYXJsaWUgZGVsdGEKICAgOTc6IGJyYXZvIGNoYXJsaWUgZGVsdGEgZWNobwog" +
  "ICA5ODogY2hhcmxpZSBkZWx0YSBlY2hvIGZveHRyb3QKICAgOTk6IGRlbHRhIGVjaG8g" +
  "Zm94dHJvdCBnb2xmCiAgMTAwOiBlY2hvIGZveHRyb3QgZ29sZiBob3RlbAogIDEwMTog" +
  "Zm94dHJvdCBnb2xmIGhvdGVsIGluZGlhCiAgMTAyOiBnb2xmIGhvdGVsIGluZGlhIGp1" +
  "bGlldAogIDEwMzogaG90ZWwgaW5kaWEganVsaWV0IGtpbG8KICAxMDQ6IGluZGlhIGp1" +
  "bGlldCBraWxvIGxpbWEKICAxMDU6IGp1bGlldCBraWxvIGxpbWEgYWxwaGEKICAxMDY6" +
  "IGtpbG8gbGltYSBhbHBoYSBicmF2bwogIDEwNzogbGltYSBhbHBoYSBicmF2byBjaGFy" +
  "bGllCiAgMTA4OiBhbHBoYSBicmF2byBjaGFybGllIGRlbHRhCiAgMTA5OiBicmF2byBj" +
  "aGFybGllIGRlbHRhIGVjaG8KICAxMTA6IGNoYXJsaWUgZGVsdGEgZWNobyBmb3h0cm90" +
  "CiAgMTExOiBkZWx0YSBlY2hvIGZveHRyb3QgZ29sZgogIDExMjogZWNobyBmb3h0cm90" +
  "IGdvbGYgaG90ZWwKICAxMTM6IGZveHRyb3QgZ29sZiBob3RlbCBpbmRpYQogIDExNDog" +
  "Z29sZiBob3RlbCBpbmRpYSBqdWxpZXQKICAxMTU6IGhvdGVsIGluZGlhIGp1bGlldCBr" +
  "aWxvCiAgMTE2OiBpbmRpYSBqdWxpZXQga2lsbyBsaW1hCiAgMTE3OiBqdWxpZXQga2ls" +
  "byBsaW1hIGFscGhhCiAgMTE4OiBraWxvIGxpbWEgYWxwaGEgYnJhdm8KICAxMTk6IGxp" +
  "bWEgYWxwaGEgYnJhdm8gY2hhcmxpZQogIDEyMDogYWxwaGEgYnJhdm8gY2hhcmxpZSBk" +
  "ZWx0YQogIDEyMTogYnJhdm8gY2hhcmxpZSBkZWx0YSBlY2hvCiAgMTIyOiBjaGFybGll" +
  "IGRlbHRhIGVjaG8gZm94dHJvdAogIDEyMzogZGVsdGEgZWNobyBmb3h0cm90IGdvbGYK" +
  "ICAxMjQ6IGVjaG8gZm94dHJvdCBnb2xmIGhvdGVsCiAgMTI1OiBmb3h0cm90IGdvbGYg" +
  "aG90ZWwgaW5kaWEKICAxMjY6IGdvbGYgaG90ZWwgaW5kaWEganVsaWV0CiAgMTI3OiBo" +
  "b3RlbCBpbmRpYSBqdWxpZXQga2lsbwogIDEyODogaW5kaWEganVsaWV0IGtpbG8gbGlt" +
  "YQogIDEyOToganVsaWV0IGtpbG8gbGltYSBhbHBoYQogIDEzMDoga2lsbyBsaW1hIGFs" +
  "cGhhIGJyYXZvCiAgMTMxOiBsaW1hIGFscGhhIGJyYXZvIGNoYXJsaWUKICAxMzI6IGFs" +
  "cGhhIGJyYXZvIGNoYXJsaWUgZGVsdGEKICAxMzM6IGJyYXZvIGNoYXJsaWUgZGVsdGEg" +
  "ZWNobwogIDEzNDogY2hhcmxpZSBkZWx0YSBlY2hvIGZveHRyb3QKICAxMzU6IGRlbHRh" +
  "IGVjaG8gZm94dHJvdCBnb2xmCiAgMTM2OiBlY2hvIGZveHRyb3QgZ29sZiBob3RlbAog" +
  "IDEzNzogZm94dHJvdCBnb2xmIGhvdGVsIGluZGlhCiAgMTM4OiBnb2xmIGhvdGVsIGlu" +
  "ZGlhIGp1bGlldAogIDEzOTogaG90ZWwgaW5kaWEganVsaWV0IGtpbG8KICAxNDA6IGlu" +
  "ZGlhIGp1bGlldCBraWxvIGxpbWEKICAxNDE6IGp1bGlldCBraWxvIGxpbWEgYWxwaGEK" +
  "ICAxNDI6IGtpbG8gbGltYSBhbHBoYSBicmF2bwogIDE0MzogbGltYSBhbHBoYSBicmF2" +
  "byBjaGFybGllCiAgMTQ0OiBhbHBoYSBicmF2byBjaGFybGllIGRlbHRhCiAgMTQ1OiBi" +
  "cmF2byBjaGFybGllIGRlbHRhIGVjaG8KICAxNDY6IGNoYXJsaWUgZGVsdGEgZWNobyBm" +
  "b3h0cm90CiAgMTQ3OiBkZWx0YSBlY2hvIGZveHRyb3QgZ29sZgogIDE0ODogZWNobyBm" +
  "b3h0cm90IGdvbGYgaG90ZWwKICAxNDk6IGZveHRyb3QgZ29sZiBob3RlbCBpbmRpYQog" +
  "IDE1MDogZ29sZiBob3RlbCBpbmRpYSBqdWxpZXQKICAxNTE6IGhvdGVsIGluZGlhIGp1" +
  "bGlldCBraWxvCiAgMTUyOiBpbmRpYSBqdWxpZXQga2lsbyBsaW1hCiAgMTUzOiBqdWxp" +
  "ZXQga2lsbyBsaW1hIGFscGhhCiAgMTU0OiBraWxvIGxpbWEgYWxwaGEgYnJhdm8KICAx" +
  "NTU6IGxpbWEgYWxwaGEgYnJhdm8gY2hhcmxpZQogIDE1NjogYWxwaGEgYnJhdm8gY2hh" +
  "cmxpZSBkZWx0YQogIDE1NzogYnJhdm8gY2hhcmxpZSBkZWx0YSBlY2hvCiAgMTU4OiBj" +
  "aGFybGllIGRlbHRhIGVjaG8gZm94dHJvdAogIDE1OTogZGVsdGEgZWNobyBmb3h0cm90" +
  "IGdvbGYKICAxNjA6IGVjaG8gZm94dHJvdCBnb2xmIGhvdGVsCiAgMTYxOiBmb3h0cm90" +
  "IGdvbGYgaG90ZWwgaW5kaWEKICAxNjI6IGdvbGYgaG90ZWwgaW5kaWEganVsaWV0CiAg" +
  "MTYzOiBob3RlbCBpbmRpYSBqdWxpZXQga2lsbwogIDE2NDogaW5kaWEganVsaWV0IGtp" +
  "bG8gbGltYQogIDE2NToganVsaWV0IGtpbG8gbGltYSBhbHBoYQogIDE2Njoga2lsbyBs" +
  "aW1hIGFscGhhIGJyYXZvCiAgMTY3OiBsaW1hIGFscGhhIGJyYXZvIGNoYXJsaWUKICAx" +
  "Njg6IGFscGhhIGJyYXZvIGNoYXJsaWUgZGVsdGEKICAxNjk6IGJyYXZvIGNoYXJsaWUg" +
  "ZGVsdGEgZWNobwogIDE3MDogY2hhcmxpZSBkZWx0YSBlY2hvIGZveHRyb3QKICAxNzE6" +
  "IGRlbHRhIGVjaG8gZm94dHJvdCBnb2xmCiAgMTcyOiBlY2hvIGZveHRyb3QgZ29sZiBo" +
  "b3RlbAogIDE3MzogZm94dHJvdCBnb2xmIGhvdGVsIGluZGlhCiAgMTc0OiBnb2xmIGhv" +
  "dGVsIGluZGlhIGp1bGlldAogIDE3NTogaG90ZWwgaW5kaWEganVsaWV0IGtpbG8KICAx" +
  "NzY6IGluZGlhIGp1bGlldCBraWxvIGxpbWEKICAxNzc6IGp1bGlldCBraWxvIGxpbWEg" +
  "YWxwaGEKICAxNzg6IGtpbG8gbGltYSBhbHBoYSBicmF2bwogIDE3OTogbGltYSBhbHBo" +
  "YSBicmF2byBjaGFybGllCiAgMTgwOiBhbHBoYSBicmF2byBjaGFybGllIGRlbHRhCiAg" +
  "MTgxOiBicmF2byBjaGFybGllIGRlbHRhIGVjaG8KICAxODI6IGNoYXJsaWUgZGVsdGEg" +
  "ZWNobyBmb3h0cm90CiAgMTgzOiBkZWx0YSBlY2hvIGZveHRyb3QgZ29sZgogIDE4NDog" +
  "ZWNobyBmb3h0cm90IGdvbGYgaG90ZWwKICAxODU6IGZveHRyb3QgZ29sZiBob3RlbCBp" +
  "bmRpYQogIDE4NjogZ29sZiBob3RlbCBpbmRpYSBqdWxpZXQKICAxODc6IGhvdGVsIGlu" +
  "ZGlhIGp1bGlldCBraWxvCiAgMTg4OiBpbmRpYSBqdWxpZXQga2lsbyBsaW1hCiAgMTg5" +
  "OiBqdWxpZXQga2lsbyBsaW1hIGFscGhhCiAgMTkwOiBraWxvIGxpbWEgYWxwaGEgYnJh" +
  "dm8KICAxOTE6IGxpbWEgYWxwaGEgYnJhdm8gY2hhcmxpZQogIDE5MjogYWxwaGEgYnJh" +
  "dm8gY2hhcmxpZSBkZWx0YQogIDE5MzogYnJhdm8gY2hhcmxpZSBkZWx0YSBlY2hvCiAg" +
  "MTk0OiBjaGFybGllIGRlbHRhIGVjaG8gZm94dHJvdAogIDE5NTogZGVsdGEgZWNobyBm" +
  "b3h0cm90IGdvbGYKICAxOTY6IGVjaG8gZm94dHJvdCBnb2xmIGhvdGVsCiAgMTk3OiBm" +
  "b3h0cm90IGdvbGYgaG90ZWwgaW5kaWEKICAxOTg6IGdvbGYgaG90ZWwgaW5kaWEganVs" +
  "aWV0CiAgMTk5OiBob3RlbCBpbmRpYSBqdWxpZXQga2lsbwogIDIwMDogaW5kaWEganVs" +
  "aWV0IGtpbG8gbGltYQogIDIwMToganVsaWV0IGtpbG8gbGltYSBhbHBoYQogIDIwMjog" +
  "a2lsbyBsaW1hIGFscGhhIGJyYXZvCiAgMjAzOiBsaW1hIGFscGhhIGJyYXZvIGNoYXJs" +
  "aWUKICAyMDQ6IGFscGhhIGJyYXZvIGNoYXJsaWUgZGVsdGEKICAyMDU6IGJyYXZvIGNo" +
  "YXJsaWUgZGVsdGEgZWNobwogIDIwNjogY2hhcmxpZSBkZWx0YSBlY2hvIGZveHRyb3QK" +
  "ICAyMDc6IGRlbHRhIGVjaG8gZm94dHJvdCBnb2xmCiAgMjA4OiBlY2hvIGZveHRyb3Qg" +
  "Z29sZiBob3RlbAogIDIwOTogZm94dHJvdCBnb2xmIGhvdGVsIGluZGlhCiAgMjEwOiBn" +
  "b2xmIGhvdGVsIGluZGlhIGp1bGlldAogIDIxMTogaG90ZWwgaW5kaWEganVsaWV0IGtp" +
  "bG8KICAyMTI6IGluZGlhIGp1bGlldCBraWxvIGxpbWEKICAyMTM6IGp1bGlldCBraWxv" +
  "IGxpbWEgYWxwaGEKICAyMTQ6IGtpbG8gbGltYSBhbHBoYSBicmF2bwogIDIxNTogbGlt" +
  "YSBhbHBoYSBicmF2byBjaGFybGllCiAgMjE2OiBhbHBoYSBicmF2byBjaGFybGllIGRl" +
  "bHRhCiAgMjE3OiBicmF2byBjaGFybGllIGRlbHRhIGVjaG8KICAyMTg6IGNoYXJsaWUg" +
  "ZGVsdGEgZWNobyBmb3h0cm90CiAgMjE5OiBkZWx0YSBlY2hvIGZveHRyb3QgZ29sZgog" +
  "IDIyMDogZWNobyBmb3h0cm90IGdvbGYgaG90ZWwKICAyMjE6IGZveHRyb3QgZ29sZiBo" +
  "b3RlbCBpbmRpYQogIDIyMjogZ29sZiBob3RlbCBpbmRpYSBqdWxpZXQKICAyMjM6IGhv" +
  "dGVsIGluZGlhIGp1bGlldCBraWxvCiAgMjI0OiBpbmRpYSBqdWxpZXQga2lsbyBsaW1h" +
  "CiAgMjI1OiBqdWxpZXQga2lsbyBsaW1hIGFscGhhCiAgMjI2OiBraWxvIGxpbWEgYWxw" +
  "aGEgYnJhdm8KICAyMjc6IGxpbWEgYWxwaGEgYnJhdm8gY2hhcmxpZQogIDIyODogYWxw" +
  "aGEgYnJhdm8gY2hhcmxpZSBkZWx0YQogIDIyOTogYnJhdm8gY2hhcmxpZSBkZWx0YSBl" +
  "Y2hvCiAgMjMwOiBjaGFybGllIGRlbHRhIGVjaG8gZm94dHJvdAogIDIzMTogZGVsdGEg" +
  "ZWNobyBmb3h0cm90IGdvbGYKICAyMzI6IGVjaG8gZm94dHJvdCBnb2xmIGhvdGVsCiAg" +
  "MjMzOiBmb3h0cm90IGdvbGYgaG90ZWwgaW5kaWEKICAyMzQ6IGdvbGYgaG90ZWwgaW5k" +
  "aWEganVsaWV0CiAgMjM1OiBob3RlbCBpbmRpYSBqdWxpZXQga2lsbwogIDIzNjogaW5k" +
  "aWEganVsaWV0IGtpbG8gbGltYQogIDIzNzoganVsaWV0IGtpbG8gbGltYSBhbHBoYQog" +
  "IDIzODoga2lsbyBsaW1hIGFscGhhIGJyYXZvCiAgMjM5OiBsaW1hIGFscGhhIGJyYXZv" +
  "IGNoYXJsaWUKICAyNDA6IGFscGhhIGJyYXZvIGNoYXJsaWUgZGVsdGEKICAyNDE6IGJy" +
  "YXZvIGNoYXJsaWUgZGVsdGEgZWNobwogIDI0MjogY2hhcmxpZSBkZWx0YSBlY2hvIGZv" +
  "eHRyb3QKICAyNDM6IGRlbHRhIGVjaG8gZm94dHJvdCBnb2xmCiAgMjQ0OiBlY2hvIGZv" +
  "eHRyb3QgZ29sZiBob3RlbAogIDI0NTogZm94dHJvdCBnb2xmIGhvdGVsIGluZGlhCiAg" +
  "MjQ2OiBnb2xmIGhvdGVsIGluZGlhIGp1bGlldAogIDI0NzogaG90ZWwgaW5kaWEganVs" +
  "aWV0IGtpbG8KICAyNDg6IGluZGlhIGp1bGlldCBraWxvIGxpbWEKICAyNDk6IGp1bGll" +
  "dCBraWxvIGxpbWEgYWxwaGEKICAyNTA6IGtpbG8gbGltYSBhbHBoYSBicmF2bwogIDI1" +
  "MTogbGltYSBhbHBoYSBicmF2byBjaGFybGllCiAgMjUyOiBhbHBoYSBicmF2byBjaGFy" +
  "bGllIGRlbHRhCiAgMjUzOiBicmF2byBjaGFybGllIGRlbHRhIGVjaG8KICAyNTQ6IGNo" +
  "YXJsaWUgZGVsdGEgZWNobyBmb3h0cm90CiAgMjU1OiBkZWx0YSBlY2hvIGZveHRyb3Qg" +
  "Z29sZgogIDI1NjogZWNobyBmb3h0cm90IGdvbGYgaG90ZWwKICAyNTc6IGZveHRyb3Qg" +
  "Z29sZiBob3RlbCBpbmRpYQogIDI1ODogZ29sZiBob3RlbCBpbmRpYSBqdWxpZXQKICAy" +
  "NTk6IGhvdGVsIGluZGlhIGp1bGlldCBraWxvCiAgMjYwOiBpbmRpYSBqdWxpZXQga2ls" +
  "byBsaW1hCiAgMjYxOiBqdWxpZXQga2lsbyBsaW1hIGFscGhhCiAgMjYyOiBraWxvIGxp" +
  "bWEgYWxwaGEgYnJhdm8KICAyNjM6IGxpbWEgYWxwaGEgYnJhdm8gY2hhcmxpZQogIDI2" +
  "NDogYWxwaGEgYnJhdm8gY2hhcmxpZSBkZWx0YQogIDI2NTogYnJhdm8gY2hhcmxpZSBk" +
  "ZWx0YSBlY2hvCiAgMjY2OiBjaGFybGllIGRlbHRhIGVjaG8gZm94dHJvdAogIDI2Nzog" +
  "ZGVsdGEgZWNobyBmb3h0cm90IGdvbGYKICAyNjg6IGVjaG8gZm94dHJvdCBnb2xmIGhv" +
  "dGVsCiAgMjY5OiBmb3h0cm90IGdvbGYgaG90ZWwgaW5kaWEKICAyNzA6IGdvbGYgaG90" +
  "ZWwgaW5kaWEganVsaWV0CiAgMjcxOiBob3RlbCBpbmRpYSBqdWxpZXQga2lsbwogIDI3" +
  "MjogaW5kaWEganVsaWV0IGtpbG8gbGltYQogIDI3MzoganVsaWV0IGtpbG8gbGltYSBh" +
  "bHBoYQogIDI3NDoka2lsbyBsaW1hIGFscGhhIGJyYXZvCiAgMjc1OiBsaW1hIGFscGhh" +
  "IGJyYXZvIGNoYXJsaWUKICAyNzY6IGFscGhhIGJyYXZvIGNoYXJsaWUgZGVsdGEKICAy" +
  "Nzc6IGJyYXZvIGNoYXJsaWUgZGVsdGEgZWNobwogIDI3ODogY2hhcmxpZSBkZWx0YSBl" +
  "Y2hvIGZveHRyb3QKICAyNzk6IGRlbHRhIGVjaG8gZm94dHJvdCBnb2xmCiAgMjgwOiBl" +
  "Y2hvIGZveHRyb3QgZ29sZiBob3RlbAogIDI4MTogZm94dHJvdCBnb2xmIGhvdGVsIGlu" +
  "ZGlhCiAgMjgyOiBnb2xmIGhvdGVsIGluZGlhIGp1bGlldAogIDI4MzogaG90ZWwgaW5k" +
  "aWEganVsaWV0IGtpbG8KICAyODQ6IGluZGlhIGp1bGlldCBraWxvIGxpbWEKICAyODU6" +
  "IGp1bGlldCBraWxvIGxpbWEgYWxwaGEKICAyODY6IGtpbG8gbGltYSBhbHBoYSBicmF2" +
  "bwogIDI4NzogbGltYSBhbHBoYSBicmF2byBjaGFybGllCiAgMjg4OiBhbHBoYSBicmF2" +
  "byBjaGFybGllIGRlbHRhCiAgMjg5OiBicmF2byBjaGFybGllIGRlbHRhIGVjaG8KICAy" +
  "OTA6IGNoYXJsaWUgZGVsdGEgZWNobyBmb3h0cm90CiAgMjkxOiBkZWx0YSBlY2hvIGZv" +
  "eHRyb3QgZ29sZgogIDI5MjogZWNobyBmb3h0cm90IGdvbGYgaG90ZWwKICAyOTM6IGZv" +
  "eHRyb3QgZ29sZiBob3RlbCBpbmRpYQogIDI5NDogZ29sZiBob3RlbCBpbmRpYSBqdWxp" +
  "ZXQKICAyOTU6IGhvdGVsIGluZGlhIGp1bGlldCBraWxvCiAgMjk2OiBpbmRpYSBqdWxp" +
  "ZXQga2lsbyBsaW1hCiAgMjk3OiBqdWxpZXQga2lsbyBsaW1hIGFscGhhCiAgMjk4OiBr" +
  "aWxvIGxpbWEgYWxwaGEgYnJhdm8KICAyOTk6IGxpbWEgYWxwaGEgYnJhdm8gY2hhcmxp" +
  "ZQogIDMwMDogYWxwaGEgYnJhdm8gY2hhcmxpZSBkZWx0YQoKRG9uZS4gMzAwIGxpbmVz" +
  "IHdyaXR0ZW4uCg==";

/** csv — writes /workspace/sales.csv (48 rows) for the DataGrid previewer. */
const CSV_WASM_B64 =
  "AGFzbQEAAAABIgVgCX9/f39/fn5/fwF/YAR/f39/AX9gAX8Bf2ABfwBgAAACiwEEFndh" +
  "c2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAAWd2FzaV9zbmFwc2hvdF9wcmV2" +
  "aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UAAhZ3" +
  "YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAADAwIBBAUDAQABBxMCBm1lbW9y" +
  "eQIABl9zdGFydAAECl4BXABBAEEQNgIAQQRB9wA2AgBBAUEAQQFBCBABGkEDQQBBhwFB" +
  "FEEJQn9Cf0EAQQwQABpBAEGbATYCAEEEQb0HNgIAQQwoAgBBAEEBQQgQARpBDCgCABAC" +
  "GkEAEAMLC88IAQBBEAvICENTViBGaWxlIERlbW8KPT09PT09PT09PT09PQogIFdyaXRp" +
  "bmcgL3dvcmtzcGFjZS9zYWxlcy5jc3YgLi4uCiAgUHJldmlldyBpdCBpbiB0aGUgbGVm" +
  "dCBwYW5lbCB1c2luZyB0aGUgRGF0YUdyaWQgdmlldy4KL3dvcmtzcGFjZS9zYWxlcy5j" +
  "c3Ztb250aCxyZWdpb24scmV2ZW51ZSx1bml0cwpKYW4sTm9ydGgsOTM4MTAsMTA3Ckph" +
  "bixTb3V0aCwxMzI3OCw0MjkKSmFuLEVhc3QsNDYwNDgsMTc1CkphbixXZXN0LDM5MjU2" +
  "LDEyMQpGZWIsTm9ydGgsMjM0MzQsMzk2CkZlYixTb3V0aCw4MTQ4Miw5NApGZWIsRWFz" +
  "dCw4NzM5NywyNjYKRmViLFdlc3QsMTQxNjUsNjUKTWFyLE5vcnRoLDIyMjgwLDE2MQpN" +
  "YXIsU291dGgsNDA0OTUsMzA4Ck1hcixFYXN0LDg4OTA3LDYzCk1hcixXZXN0LDgzNTYz" +
  "LDE1MQpBcHIsTm9ydGgsOTUxODEsNDA5CkFwcixTb3V0aCw4MTQyNiwyNjQKQXByLEVh" +
  "c3QsMzg4OTMsMjc5CkFwcixXZXN0LDg3MjM2LDE5MgpNYXksTm9ydGgsMTA4NTEsNDM4" +
  "Ck1heSxTb3V0aCwzMDkyNiw0MDcKTWF5LEVhc3QsNjUzOTIsMjI0Ck1heSxXZXN0LDQ2" +
  "NDIxLDEyOQpKdW4sTm9ydGgsMzgyMjEsNDQwCkp1bixTb3V0aCw1NDExOCwxMDIKSnVu" +
  "LEVhc3QsMjIxNTYsMjQ0Ckp1bixXZXN0LDIyNjc2LDIzMwpKdWwsTm9ydGgsNTUwODIs" +
  "MzU5Ckp1bCxTb3V0aCw0NDY3MSw0NjMKSnVsLEVhc3QsMTU2OTUsNDIzCkp1bCxXZXN0" +
  "LDcwMjE3LDMyNApBdWcsTm9ydGgsMjYzNjEsMjQzCkF1ZyxTb3V0aCwyMDMyOCwzMzIK" +
  "QXVnLEVhc3QsNDg0MjcsNDc0CkF1ZyxXZXN0LDkyMzk3LDM2NgpTZXAsTm9ydGgsNTc0" +
  "MDAsMzQ1ClNlcCxTb3V0aCwzNTIwMyw0MTAKU2VwLEVhc3QsMTkxMTYsNzMKU2VwLFdl" +
  "c3QsOTY2NzMsMTY2Ck9jdCxOb3J0aCw0NzkzMCw5MApPY3QsU291dGgsNDA1MTIsNDkz" +
  "Ck9jdCxFYXN0LDIzMjM4LDI0NApPY3QsV2VzdCw0NjQzNCwyODIKTm92LE5vcnRoLDkz" +
  "MzIwLDQ3NwpOb3YsU291dGgsNTc4MTksMTMzCk5vdixFYXN0LDU4NTIwLDIzMQpOb3Ys" +
  "V2VzdCwzNzQ2MCwzOTMKRGVjLE5vcnRoLDQ0OTkzLDQwOQpEZWMsU291dGgsOTQ5Mzks" +
  "ODYKRGVjLEVhc3QsODk4NDAsMzc1CkRlYyxXZXN0LDMyNDMxLDMyMwo=";

/** chart — writes /workspace/metrics.json (timeseries) for the ChartView previewer. */
const CHART_WASM_B64 =
  "AGFzbQEAAAABIgVgCX9/f39/fn5/fwF/YAR/f39/AX9gAX8Bf2ABfwBgAAACiwEEFndh" +
  "c2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAAWd2FzaV9zbmFwc2hvdF9wcmV2" +
  "aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEIZmRfY2xvc2UAAhZ3" +
  "YXNpX3NuYXBzaG90X3ByZXZpZXcxCXByb2NfZXhpdAADAwIBBAUDAQABBxMCBm1lbW9y" +
  "eQIABl9zdGFydAAECl4BXABBAEEQNgIAQQRB+gA2AgBBAUEAQQFBCBABGkEDQQBBigFB" +
  "F0EJQn9Cf0EAQQwQABpBAEGhATYCAEEEQbQCNgIAQQwoAgBBAEEBQQgQARpBDCgCABAC" +
  "GkEAEAMLC8wDAQBBEAvFA0pTT04gQ2hhcnQgRGVtbwo9PT09PT09PT09PT09PT0KICBX" +
  "cml0aW5nIC93b3Jrc3BhY2UvbWV0cmljcy5qc29uIC4uLgogIFByZXZpZXcgaXQgaW4g" +
  "dGhlIGxlZnQgcGFuZWwgdXNpbmcgdGhlIENoYXJ0Vmlldy4KL3dvcmtzcGFjZS9tZXRy" +
  "aWNzLmpzb257InR5cGUiOiJ0aW1lc2VyaWVzIiwibGFiZWxzIjpbIkphbiIsIkZlYiIs" +
  "Ik1hciIsIkFwciIsIk1heSIsIkp1biIsIkp1bCIsIkF1ZyIsIlNlcCIsIk9jdCIsIk5v" +
  "diIsIkRlYyJdLCJzZXJpZXMiOlt7Im5hbWUiOiJSZXF1ZXN0cyIsImRhdGEiOlsxMjAs" +
  "MTQ1LDEzMiwxNzgsMjAxLDE4OSwyMTUsMTk4LDIzMCwyNDUsMjIwLDI2MF19LHsibmFt" +
  "ZSI6IkVycm9ycyIsImRhdGEiOls1LDgsMywxMiw3LDQsOSw2LDExLDgsNSw3XX0seyJu" +
  "YW1lIjoiUDk1IG1zIiwiZGF0YSI6WzQyLDM4LDQ1LDUxLDQ4LDQ0LDUyLDQ3LDU1LDQ5" +
  "LDQzLDU4XX1dfQ==";

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
type DemoKey =
  | "noop" | "hello" | "counter" | "fibonacci" | "primes" | "files"
  | "exit1" | "trap" | "unicode" | "longlines" | "large" | "csv" | "chart";

const DEMOS: Record<DemoKey, { label: string; description: string; wasmB64: string }> = {
  // ── Core demos ──────────────────────────────────────────────────────────
  noop:      { label: "noop",      description: "No output — pipeline smoke test",               wasmB64: NOOP_WASM_B64      },
  hello:     { label: "hello",     description: "Greeting banner + runtime info",                wasmB64: HELLO_WASM_B64     },
  counter:   { label: "counter",   description: "Count 1→20 (streamed per fd_write call)",       wasmB64: COUNTER_WASM_B64   },
  fibonacci: { label: "fibonacci", description: "First 20 Fibonacci numbers",                    wasmB64: FIBONACCI_WASM_B64 },
  primes:    { label: "primes",    description: "Sieve of Eratosthenes up to 100",               wasmB64: PRIMES_WASM_B64    },
  files:     { label: "files",     description: "Writes 2 files to /workspace — tests VFS I/O",  wasmB64: FILES_WASM_B64     },
  // ── Error-path tests ─────────────────────────────────────────────────────
  exit1:     { label: "exit1",     description: "proc_exit(1) — exit code shown in red",         wasmB64: EXIT1_WASM_B64     },
  trap:      { label: "trap",      description: "WASM unreachable trap — tests crashed state",   wasmB64: TRAP_WASM_B64      },
  // ── Terminal rendering tests ──────────────────────────────────────────────
  unicode:   { label: "unicode",   description: "Emoji, CJK, Arabic, box-drawing characters",    wasmB64: UNICODE_WASM_B64   },
  longlines: { label: "longlines", description: "~90-char lines — tests wrap/horizontal scroll", wasmB64: LONGLINES_WASM_B64 },
  large:     { label: "large",     description: "300 lines in one write (~9.7 KB buffer)",       wasmB64: LARGE_WASM_B64     },
  // ── File previewer tests ──────────────────────────────────────────────────
  csv:       { label: "csv",       description: "Writes sales.csv — tests DataGrid previewer",   wasmB64: CSV_WASM_B64       },
  chart:     { label: "chart",     description: "Writes metrics.json — tests ChartView",         wasmB64: CHART_WASM_B64     },
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
  /** Exit code from the last completed execution (proc_exit value). */
  const [lastExitCode, setLastExitCode] = useState<number>(0);

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
    setLastExitCode(0);
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
                  : sandboxState === "nonzero"
                  ? `Session ended — non-zero exit (code ${lastExitCode})`
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
                      : sandboxState === "crashed" || sandboxState === "nonzero"
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
                          lastExitCode={lastExitCode}
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
                          onEnd={(outcome, vfsSnapshot, exitCode) => {
                            if (outcome !== "complete") {
                              setSandboxState("crashed");
                            } else {
                              const code = exitCode ?? 0;
                              setLastExitCode(code);
                              setSandboxState(code === 0 ? "complete" : "nonzero");
                            }
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
  lastExitCode,
  mod,
}: {
  onRun:  () => void;
  onHelp: () => void;
  sandboxState: SandboxState;
  lastExitCode: number;
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

  if (sandboxState === "nonzero") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <XCircle className="h-10 w-10 text-[var(--color-danger)]" />
        <div className="space-y-1">
          <p className="font-mono text-sm font-semibold text-[var(--color-danger)]">
            Exited with code {lastExitCode}
          </p>
          <p className="font-mono text-[11px] text-[var(--color-text-muted)]">
            The process terminated with a non-zero exit code. See terminal output above for details.
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
