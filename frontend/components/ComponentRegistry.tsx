"use client";

/**
 * ComponentRegistry.tsx
 *
 * Generative UI layer: maps VFS file extensions to specialised preview
 * components that are dynamically imported only when needed.
 *
 * Supported file types:
 *   .csv              → DataGrid   (sortable, paginated table)
 *   .json / .plot     → ChartView  (auto-detects Recharts-compatible shape)
 *   .wasm             → WasmInspector (sections, exports, imports)
 *   .log / .txt / .md → LogViewer  (ANSI-stripped, virtual scroll)
 *   .png / .jpg / .svg → ImageViewer
 *   (fallback)        → RawViewer  (hex dump for unknown types)
 *
 * All content is fetched from GET /api/v1/vfs/:sessionId/file?path=<path>.
 * Each previewer handles its own loading / error states so the registry
 * just wires up routing.
 */

import { useMemo, useState, useEffect, useCallback, memo } from "react";
import {
  AlertCircle,
  FileQuestion,
  Loader2,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

interface RegistryProps {
  filePath:  string;
  sessionId: string | null;
}

type FetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: T };

// ── File type detection ────────────────────────────────────────────────────

type FileKind = "csv" | "json" | "wasm" | "log" | "image" | "raw";

function detectKind(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "csv")                           return "csv";
  if (["json", "plot"].includes(ext))          return "json";
  if (ext === "wasm")                          return "wasm";
  if (["log", "txt", "md"].includes(ext))      return "log";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext)) return "image";
  return "raw";
}

// ── API file content fetch ─────────────────────────────────────────────────

/**
 * Fetches file content from GET /api/v1/vfs/:sessionId/file?path=<path>.
 * WASM files are fetched as ArrayBuffer; everything else as text.
 */
async function fetchFileContent(
  sessionId: string,
  path: string
): Promise<string | ArrayBuffer> {
  const url = `/api/v1/vfs/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return detectKind(path) === "wasm" ? res.arrayBuffer() : res.text();
}

// ── Shared: toolbar ────────────────────────────────────────────────────────

function PreviewToolbar({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-3">
      <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {title}
      </span>
      {right}
    </div>
  );
}

// ── CSV → DataGrid ─────────────────────────────────────────────────────────

type SortDir = "asc" | "desc" | null;

const DataGrid = memo(function DataGrid({ raw }: { raw: string }) {
  const [page, setPage]       = useState(0);
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const PAGE_SIZE = 20;

  const { headers, rows } = useMemo(() => {
    const lines   = raw.trim().split("\n");
    const headers = lines[0].split(",");
    const rows    = lines.slice(1).map((l) => l.split(","));
    return { headers, rows };
  }, [raw]);

  const sorted = useMemo(() => {
    if (sortCol === null || sortDir === null) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol] ?? "";
      const bv = b[sortCol] ?? "";
      const n  = Number(av) - Number(bv);
      const cmp = isNaN(n) ? av.localeCompare(bv) : n;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [rows, sortCol, sortDir]);

  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.ceil(sorted.length / PAGE_SIZE);

  const handleSort = (i: number) => {
    if (sortCol !== i) { setSortCol(i); setSortDir("asc"); return; }
    setSortDir((d) => d === "asc" ? "desc" : d === "desc" ? null : "asc");
    if (sortDir === "desc") setSortCol(null);
  };

  const SortIcon = ({ i }: { i: number }) => {
    if (sortCol !== i || sortDir === null) return <ArrowUpDown className="h-3 w-3 opacity-30" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 text-[var(--color-accent)]" />
      : <ArrowDown className="h-3 w-3 text-[var(--color-accent)]" />;
  };

  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar
        title={`CSV — ${rows.length} rows × ${headers.length} cols`}
        right={
          <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
            page {page + 1} / {pageCount}
          </span>
        }
      />
      <div className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead className="sticky top-0 bg-[var(--color-elevated)]">
            <tr>
              {headers.map((h, i) => (
                <th
                  key={i}
                  onClick={() => handleSort(i)}
                  className="cursor-pointer border-b border-[var(--color-border)] px-3 py-1.5 text-left font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  <div className="flex items-center gap-1">
                    {h}
                    <SortIcon i={i} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, ri) => (
              <tr
                key={ri}
                className="border-b border-[var(--color-border)] transition-colors hover:bg-[var(--color-elevated)]"
              >
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 font-mono text-[var(--color-text-secondary)]"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex h-8 shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border)] px-3">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="rounded px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] disabled:opacity-30 hover:bg-[var(--color-elevated)]"
          >
            ← prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={page >= pageCount - 1}
            className="rounded px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)] disabled:opacity-30 hover:bg-[var(--color-elevated)]"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
});

// ── JSON → ChartView ───────────────────────────────────────────────────────

const CHART_COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#38bdf8", "#c084fc"];

const ChartView = memo(function ChartView({ raw }: { raw: string }) {
  const data = useMemo(() => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }, [raw]);

  if (!data || data.type !== "timeseries" || !Array.isArray(data.series)) {
    return (
      <div className="flex h-full flex-col">
        <PreviewToolbar title="JSON" />
        <pre className="flex-1 overflow-auto p-3 font-mono text-[11px] text-[var(--color-text-secondary)] whitespace-pre-wrap">
          {JSON.stringify(data, null, 2)}
        </pre>
      </div>
    );
  }

  const labels  = data.labels as string[];
  const series  = data.series as { name: string; data: number[] }[];
  const maxVals = series.map((s) => Math.max(...s.data));
  const globalMax = Math.max(...maxVals, 1);

  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar title="Timeseries Chart" />
      <div className="flex-1 overflow-auto p-4 space-y-6">
        {series.map((s, si) => {
          const color  = CHART_COLORS[si % CHART_COLORS.length];
          const serMax = Math.max(...s.data, 1);
          return (
            <div key={s.name} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{s.name}</span>
              </div>
              <div className="flex h-20 items-end gap-0.5">
                {s.data.map((v, i) => (
                  <div key={i} className="group relative flex flex-1 flex-col items-center justify-end">
                    <div
                      className="w-full rounded-t-sm transition-all"
                      style={{
                        height:          `${(v / serMax) * 100}%`,
                        backgroundColor: color + "cc",
                        minHeight:       "2px",
                      }}
                    />
                    <span className="absolute -top-4 hidden text-[9px] text-[var(--color-text-muted)] group-hover:block">
                      {v}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex justify-between">
                {labels.map((l, i) => (
                  <span key={i} className="flex-1 text-center font-mono text-[9px] text-[var(--color-text-muted)]">
                    {l}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

// ── WASM → WasmInspector ───────────────────────────────────────────────────

const WasmInspector = memo(function WasmInspector({ raw }: { raw: string }) {
  const info = useMemo(() => {
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
  }, [raw]);

  if (!info) {
    return <RawViewer raw={raw} label="WASM (parse error)" />;
  }

  const sections = info.sections as { id: number; name: string; size: number; entries: number }[];
  const exports_ = info.exports as string[];
  const imports  = info.imports as { module: string; name: string }[];

  function fmt(n: number) {
    return n > 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
  }

  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar
        title="WASM Inspector"
        right={
          <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
            magic: 0x{info.magic as string}
          </span>
        }
      />
      <div className="flex-1 overflow-auto divide-y divide-[var(--color-border)]">
        {/* Sections */}
        <div className="p-3">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Sections ({sections.length})
          </p>
          <div className="space-y-1">
            {sections.map((sec) => (
              <div key={sec.id} className="flex items-center justify-between rounded bg-[var(--color-elevated)] px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-6 text-center font-mono text-[10px] text-[var(--color-text-muted)]">{sec.id}</span>
                  <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">{sec.name}</span>
                </div>
                <div className="flex gap-3">
                  <span className="font-mono text-[10px] text-[var(--color-text-muted)]">{sec.entries} entries</span>
                  <span className="font-mono text-[10px] text-[var(--color-accent)]">{fmt(sec.size)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Exports */}
        <div className="p-3">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Exports ({exports_.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {exports_.map((e) => (
              <span key={e} className="rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ansi-green)]">
                {e}
              </span>
            ))}
          </div>
        </div>

        {/* Imports */}
        <div className="p-3">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Imports ({imports.length})
          </p>
          <div className="space-y-1">
            {imports.map((imp, i) => (
              <div key={i} className="flex items-center gap-2 font-mono text-[10px]">
                <span className="text-[var(--color-ansi-cyan)]">{imp.module}</span>
                <span className="text-[var(--color-text-muted)]">::</span>
                <span className="text-[var(--color-text-secondary)]">{imp.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

// ── Log / text → LogViewer ─────────────────────────────────────────────────

// Strip ANSI escape sequences for plain rendering
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function logLineColor(line: string): string {
  const l = line.toLowerCase();
  if (l.includes("error") || l.includes("fatal") || l.includes("panic")) return "var(--color-danger)";
  if (l.includes("warn"))  return "var(--color-warn)";
  if (l.includes("debug")) return "var(--color-text-muted)";
  return "var(--color-text-secondary)";
}

const LogViewer = memo(function LogViewer({ raw }: { raw: string }) {
  const lines = useMemo(() => raw.split("\n").map(stripAnsi), [raw]);

  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar title={`Log — ${lines.length} lines`} />
      <div className="flex-1 overflow-auto p-3">
        {lines.map((line, i) => (
          <div key={i} className="flex gap-3">
            <span className="w-8 shrink-0 text-right font-mono text-[9px] text-[var(--color-text-muted)] select-none">
              {i + 1}
            </span>
            <span
              className="font-mono text-[11px] leading-relaxed"
              style={{ color: logLineColor(line) }}
            >
              {line}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

// ── Image viewer ───────────────────────────────────────────────────────────

const ImageViewer = memo(function ImageViewer({ path, sessionId }: { path: string; sessionId: string | null }) {
  const src = sessionId
    ? `/api/v1/vfs/${sessionId}/file?path=${encodeURIComponent(path)}`
    : "";

  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar title={path.split("/").pop() ?? "Image"} />
      <div className="flex flex-1 items-center justify-center overflow-auto p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={path}
          className="max-h-full max-w-full rounded border border-[var(--color-border)] object-contain"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      </div>
    </div>
  );
});

// ── Raw / hex fallback ─────────────────────────────────────────────────────

const RawViewer = memo(function RawViewer({ raw, label = "Raw" }: { raw: string; label?: string }) {
  return (
    <div className="flex h-full flex-col">
      <PreviewToolbar title={label} />
      <pre className="flex-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-secondary)] whitespace-pre-wrap break-all">
        {raw}
      </pre>
    </div>
  );
});

// ── Loading / error states ─────────────────────────────────────────────────

function LoadingPane() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-[var(--color-text-muted)]">
      <Loader2 className="h-5 w-5 animate-spin text-[var(--color-accent)]" />
      <span className="font-mono text-xs tracking-widest uppercase">Loading…</span>
    </div>
  );
}

function ErrorPane({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <AlertCircle className="h-6 w-6 text-[var(--color-danger)]" />
      <p className="font-mono text-xs text-[var(--color-danger)]">Failed to load preview</p>
      <p className="font-mono text-[10px] text-[var(--color-text-muted)]">{message}</p>
    </div>
  );
}

function UnsupportedPane({ path }: { path: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileQuestion className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
      <p className="font-mono text-xs text-[var(--color-text-muted)]">
        No previewer for <span className="text-[var(--color-text-secondary)]">{path.split("/").pop()}</span>
      </p>
      <p className="font-mono text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest">
        Select a CSV, JSON, WASM, or log file
      </p>
    </div>
  );
}

// ── Main registry ──────────────────────────────────────────────────────────

export default function ComponentRegistry({ filePath, sessionId }: RegistryProps) {
  const kind = useMemo(() => detectKind(filePath), [filePath]);
  const [fetchState, setFetchState] = useState<FetchState<string>>({ status: "idle" });

  // Images are served directly by URL — no fetch needed
  const needsFetch = kind !== "image";

  const load = useCallback(async () => {
    if (!needsFetch) return;
    if (!sessionId) { setFetchState({ status: "error", message: "No active session" }); return; }
    setFetchState({ status: "loading" });
    try {
      const raw = await fetchFileContent(sessionId, filePath);
      setFetchState({ status: "ok", data: typeof raw === "string" ? raw : "[binary data]" });
    } catch (err) {
      setFetchState({ status: "error", message: String(err) });
    }
  }, [needsFetch, sessionId, filePath]);

  useEffect(() => {
    setFetchState({ status: "idle" });
    load();
  }, [load]);

  // Image preview bypasses fetch
  if (kind === "image") {
    return <ImageViewer path={filePath} sessionId={sessionId} />;
  }

  if (fetchState.status === "idle" || fetchState.status === "loading") {
    return <LoadingPane />;
  }

  if (fetchState.status === "error") {
    return <ErrorPane message={fetchState.message} />;
  }

  const raw = fetchState.data;

  switch (kind) {
    case "csv":  return <DataGrid raw={raw} />;
    case "json": return <ChartView raw={raw} />;
    case "wasm": return <WasmInspector raw={raw} />;
    case "log":  return <LogViewer raw={raw} />;
    default:     return <RawViewer raw={raw} />;
  }
}
