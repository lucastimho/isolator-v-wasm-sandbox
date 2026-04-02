"use client";

/**
 * AgentVitals.tsx
 *
 * Real-time agent health HUD.  Two rendering modes:
 *
 *  compact=false (default / sidebar full mode)
 *    - Memory progress bar (colour-coded: ok / warn / danger)
 *    - CPU progress bar
 *    - Canvas sparkline for the last SPARKLINE_SAMPLES of each metric
 *    - Numeric readouts (MB / %)
 *
 *  compact=true (toolbar corner pill)
 *    - Single canvas sparkline (CPU) + two tiny numeric badges
 *    - Minimal DOM, fits in a 9-px-high toolbar slot
 *
 * Telemetry is polled from GET /api/v1/vitals/:sessionId every 800 ms
 * while `running` is true.  When no session is active it renders a
 * dimmed placeholder.
 *
 * Sparklines are drawn with raw Canvas 2D APIs (no React state) for
 * consistent 60-FPS rendering without triggering component re-renders.
 */

import { useEffect, useRef, useState } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

interface VitalsSnapshot {
  memUsedBytes:  number;   // bytes used
  memLimitBytes: number;   // max bytes
  cpuPct:        number;   // 0–100
  wallMs:        number;   // elapsed wall-clock ms
}

interface AgentVitalsProps {
  sessionId: string | null;
  running:   boolean;
  compact?:  boolean;
}

// ── Config ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS     = 800;
const POLL_BACKOFF_BASE_MS = 5_000;
const POLL_BACKOFF_MAX_MS  = 30_000;
const SPARKLINE_SAMPLES    = 60;
const MEM_LIMIT_BYTES      = 50 * 1024 * 1024; // 50 MB hard cap

// ── API telemetry fetch ─────────────────────────────────────────────────────

type VitalsFetchResult =
  | { ok: true;  snapshot: VitalsSnapshot }
  | { ok: false; networkError: boolean; fallback: VitalsSnapshot };

/**
 * Fetches live vitals from GET /api/v1/vitals/:sessionId.
 *
 * Returns a discriminated union so the poll loop can distinguish a network-
 * level failure (orchestrator unreachable → apply back-off) from an API-level
 * error (4xx/5xx → keep current interval).  The HUD always has a fallback
 * value so it never goes blank.
 */
async function fetchVitals(
  sessionId: string,
  elapsed: number,
  prev: VitalsSnapshot | null
): Promise<VitalsFetchResult> {
  const fallback: VitalsSnapshot = prev
    ? { ...prev, wallMs: elapsed }
    : { memUsedBytes: 0, memLimitBytes: MEM_LIMIT_BYTES, cpuPct: 0, wallMs: elapsed };

  try {
    const res = await fetch(`/api/v1/vitals/${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const json = await res.json() as {
      mem_used_bytes:  number;
      mem_limit_bytes: number;
      cpu_pct:         number;
    };

    return {
      ok: true,
      snapshot: {
        memUsedBytes:  json.mem_used_bytes,
        memLimitBytes: json.mem_limit_bytes,
        cpuPct:        json.cpu_pct,
        wallMs:        elapsed,
      },
    };
  } catch (err) {
    const isNetwork =
      err instanceof TypeError ||
      (err as { name?: string }).name === "TimeoutError" ||
      (err as { name?: string }).name === "AbortError";
    return { ok: false, networkError: isNetwork, fallback };
  }
}

// ── Colour helpers ─────────────────────────────────────────────────────────

function pctColor(pct: number): string {
  if (pct >= 90) return "var(--color-danger)";
  if (pct >= 70) return "var(--color-warn)";
  return "var(--color-ok)";
}

function memColor(usedBytes: number, limitBytes: number): string {
  return pctColor((usedBytes / limitBytes) * 100);
}

function formatMem(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? mb.toFixed(1) + " MB" : Math.round(mb) + " MB";
}

function formatWall(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// ── Canvas sparkline ───────────────────────────────────────────────────────

function drawSparkline(canvas: HTMLCanvasElement, samples: number[], color: string) {
  const dpr = window.devicePixelRatio ?? 1;
  const w   = canvas.offsetWidth;
  const h   = canvas.offsetHeight;
  if (w === 0 || h === 0 || samples.length < 2) return;

  canvas.width  = w * dpr;
  canvas.height = h * dpr;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const max  = Math.max(...samples, 1);
  const step = w / (samples.length - 1);

  // Convert CSS variable colour → hex for alpha-blending
  const computed = getComputedStyle(canvas).getPropertyValue(
    color.startsWith("var(") ? color.slice(4, -1).trim() : color
  ).trim();
  const resolvedColor = computed || "#6366f1";

  ctx.beginPath();
  samples.forEach((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 2) - 1;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = resolvedColor;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = "round";
  ctx.stroke();

  // Gradient fill under the line
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, resolvedColor + "30");
  grad.addColorStop(1, resolvedColor + "00");
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-elevated)]">
      <div
        className="vitals-bar h-full rounded-full"
        style={{ width: `${Math.min(100, pct)}%`, backgroundColor: color }}
      />
    </div>
  );
}

function SparklineCanvas({
  samples,
  color,
  className,
}: {
  samples: number[];
  color: string;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) drawSparkline(ref.current, samples, color);
  }, [samples, color]);

  return <canvas ref={ref} className={className} />;
}

// ── Full panel ─────────────────────────────────────────────────────────────

function FullPanel({ snapshots, latest }: { snapshots: VitalsSnapshot[]; latest: VitalsSnapshot | null }) {
  if (!latest) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <p className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Waiting for session…
        </p>
      </div>
    );
  }

  const memPct    = (latest.memUsedBytes / latest.memLimitBytes) * 100;
  const mColor    = memColor(latest.memUsedBytes, latest.memLimitBytes);
  const cColor    = pctColor(latest.cpuPct);
  const memSeries = snapshots.map((s) => (s.memUsedBytes / s.memLimitBytes) * 100);
  const cpuSeries = snapshots.map((s) => s.cpuPct);

  return (
    <div className="space-y-4 p-3">
      {/* Memory */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            Memory
          </span>
          <span className="font-mono text-[11px]" style={{ color: mColor }}>
            {formatMem(latest.memUsedBytes)}
            <span className="text-[var(--color-text-muted)]"> / {formatMem(latest.memLimitBytes)}</span>
          </span>
        </div>
        <ProgressBar pct={memPct} color={mColor} />
        <SparklineCanvas samples={memSeries} color={mColor} className="h-8 w-full" />
      </div>

      {/* CPU */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            CPU
          </span>
          <span className="font-mono text-[11px]" style={{ color: cColor }}>
            {latest.cpuPct.toFixed(1)}%
          </span>
        </div>
        <ProgressBar pct={latest.cpuPct} color={cColor} />
        <SparklineCanvas samples={cpuSeries} color={cColor} className="h-8 w-full" />
      </div>

      {/* Wall clock */}
      <div className="flex items-center justify-between border-t border-[var(--color-border)] pt-2">
        <span className="text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Elapsed
        </span>
        <span className="font-mono text-[11px] text-[var(--color-text-secondary)]">
          {formatWall(latest.wallMs)}
        </span>
      </div>
    </div>
  );
}

// ── Compact toolbar pill ───────────────────────────────────────────────────

function CompactPill({ snapshots, latest }: { snapshots: VitalsSnapshot[]; latest: VitalsSnapshot | null }) {
  if (!latest) {
    return <span className="font-mono text-[10px] text-[var(--color-text-muted)]">—</span>;
  }

  const memPct    = (latest.memUsedBytes / latest.memLimitBytes) * 100;
  const cColor    = pctColor(latest.cpuPct);
  const mColor    = memColor(latest.memUsedBytes, latest.memLimitBytes);
  const cpuSeries = snapshots.map((s) => s.cpuPct);

  return (
    <div className="flex items-center gap-2">
      <SparklineCanvas samples={cpuSeries} color={cColor} className="h-5 w-16" />
      <span className="font-mono text-[10px]" style={{ color: cColor }}>
        {Math.round(latest.cpuPct)}%
      </span>
      <span className="font-mono text-[10px]" style={{ color: mColor }}>
        {formatMem(latest.memUsedBytes)}
      </span>
      <div className="h-3 w-px bg-[var(--color-border)]" />
      <span className="font-mono text-[10px]" style={{ color: mColor }} title={`Mem: ${memPct.toFixed(0)}%`}>
        {memPct.toFixed(0)}%
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function AgentVitals({ sessionId, running, compact = false }: AgentVitalsProps) {
  // Snapshots stored in a ref so sparkline draws don't need state; a plain
  // counter in state is the minimal render trigger.
  const snapshotsRef = useRef<VitalsSnapshot[]>([]);
  const latestRef    = useRef<VitalsSnapshot | null>(null);
  const startRef     = useRef<number>(0);
  const [, setTick]  = useState(0);

  useEffect(() => {
    if (!running || !sessionId) {
      snapshotsRef.current = [];
      latestRef.current    = null;
      setTick(0);
      return;
    }

    startRef.current = Date.now();
    let cancelled   = false;
    let backoffMs   = POLL_INTERVAL_MS;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (cancelled) return;

      const elapsed = Date.now() - startRef.current;
      const result  = await fetchVitals(sessionId, elapsed, latestRef.current);

      if (cancelled) return;

      if (result.ok) {
        // Success — reset backoff and record the snapshot.
        backoffMs = POLL_INTERVAL_MS;
        latestRef.current = result.snapshot;
        snapshotsRef.current.push(result.snapshot);
      } else {
        // Error — use the fallback value so the HUD stays populated.
        latestRef.current = result.fallback;
        snapshotsRef.current.push(result.fallback);
        if (result.networkError) {
          // Orchestrator unreachable — back off so we don't spam the proxy log.
          backoffMs = Math.min(backoffMs * 2, POLL_BACKOFF_MAX_MS);
          // Start backoff from the base if we haven't already.
          if (backoffMs === POLL_INTERVAL_MS) backoffMs = POLL_BACKOFF_BASE_MS;
        }
      }

      if (snapshotsRef.current.length > SPARKLINE_SAMPLES) {
        snapshotsRef.current.shift();
      }
      setTick((t) => t + 1);

      if (!cancelled) timerId = setTimeout(poll, backoffMs);
    };

    poll();
    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [running, sessionId]);

  return compact ? (
    <CompactPill snapshots={snapshotsRef.current} latest={latestRef.current} />
  ) : (
    <FullPanel snapshots={snapshotsRef.current} latest={latestRef.current} />
  );
}
