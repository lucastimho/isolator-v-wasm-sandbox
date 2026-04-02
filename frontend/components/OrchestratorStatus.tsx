"use client";

/**
 * OrchestratorStatus.tsx
 *
 * Live health-indicator dot for the top chrome bar.
 *
 * Replaces the static always-green dot in page.tsx with a component that
 * actually polls GET /api/v1/health every 10 s (with exponential back-off
 * when unreachable) and reflects the real reachability of the Go orchestrator.
 *
 * States
 * ──────
 *  checking  (initial)  – grey pulsing dot, "Checking orchestrator…"
 *  online               – green dot, "Orchestrator reachable"
 *  offline              – amber dot, "Orchestrator offline — retrying in Xs"
 *
 * Design principle: "Visibility of system status" (Nielsen #1).
 * The indicator is intentionally tiny (8 px dot) so it does not compete with
 * primary content, but colour-codes the backend health at a glance.
 */

import { useEffect, useRef, useState } from "react";
import Tooltip from "@/components/Tooltip";

// ── Config ─────────────────────────────────────────────────────────────────

const POLL_BASE_MS = 10_000;
const POLL_MAX_MS  = 120_000; // 2 min cap when orchestrator is down

// ── Types ──────────────────────────────────────────────────────────────────

type HealthState = "checking" | "online" | "offline";

// ── Fetch ──────────────────────────────────────────────────────────────────

async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/v1/health", {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Component ──────────────────────────────────────────────────────────────

export default function OrchestratorStatus() {
  const [status, setStatus]       = useState<HealthState>("checking");
  const [retryIn, setRetryIn]     = useState<number | null>(null);
  const backoffMsRef              = useRef(POLL_BASE_MS);
  const countdownRef              = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef                  = useRef<ReturnType<typeof setTimeout>  | null>(null);

  useEffect(() => {
    let cancelled = false;

    const clearCountdown = () => {
      if (countdownRef.current !== null) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      setRetryIn(null);
    };

    const startCountdown = (totalMs: number) => {
      clearCountdown();
      let remaining = Math.round(totalMs / 1000);
      setRetryIn(remaining);
      countdownRef.current = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearCountdown();
        } else {
          setRetryIn(remaining);
        }
      }, 1_000);
    };

    const poll = async () => {
      if (cancelled) return;

      const alive = await checkHealth();
      if (cancelled) return;

      if (alive) {
        backoffMsRef.current = POLL_BASE_MS;
        clearCountdown();
        setStatus("online");
        timerRef.current = setTimeout(poll, POLL_BASE_MS);
      } else {
        setStatus("offline");
        backoffMsRef.current = Math.min(backoffMsRef.current * 2, POLL_MAX_MS);
        startCountdown(backoffMsRef.current);
        timerRef.current = setTimeout(poll, backoffMsRef.current);
      }
    };

    // Initial probe
    poll();

    return () => {
      cancelled = true;
      if (timerRef.current    !== null) clearTimeout(timerRef.current);
      if (countdownRef.current !== null) clearInterval(countdownRef.current);
    };
  }, []);

  // ── Derived display ──────────────────────────────────────────────────────

  const dotClass =
    status === "online"
      ? "bg-[var(--color-ok)]"
      : status === "offline"
      ? "bg-[var(--color-warn)] animate-pulse"
      : "bg-[var(--color-text-muted)] animate-pulse";

  const tipText =
    status === "online"
      ? "Orchestrator reachable"
      : status === "offline"
      ? retryIn !== null
        ? `Orchestrator offline — retrying in ${retryIn}s`
        : "Orchestrator offline — retrying…"
      : "Checking orchestrator…";

  return (
    <Tooltip content={tipText} side="bottom">
      <span
        className={`h-2 w-2 rounded-full transition-colors ${dotClass}`}
        aria-label={tipText}
      />
    </Tooltip>
  );
}
