"use client";

/**
 * Tooltip.tsx
 *
 * Lightweight, accessible tooltip with optional keyboard-shortcut badge.
 * Renders above the trigger by default; flips below when near the top edge.
 *
 * Usage:
 *   <Tooltip content="Start sandbox" shortcut="⌘↵">
 *     <button>Run</button>
 *   </Tooltip>
 */

import { useState, useRef, useEffect, useCallback, ReactNode } from "react";

interface TooltipProps {
  content: string;
  shortcut?: string;           // e.g. "⌘↵"  "Esc"  "⌘⇧R"
  children: ReactNode;
  side?: "top" | "bottom";
  delay?: number;              // ms before showing (default 600)
  disabled?: boolean;          // suppress tooltip when true
}

export default function Tooltip({
  content,
  shortcut,
  children,
  side = "bottom",
  delay = 600,
  disabled = false,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    if (disabled) return;
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [disabled, delay]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  // Hide on scroll or focus-loss
  useEffect(() => {
    if (!visible) return;
    const handler = () => setVisible(false);
    window.addEventListener("scroll", handler, true);
    window.addEventListener("keydown", handler, true);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("keydown", handler, true);
    };
  }, [visible]);

  const popupClasses =
    side === "top"
      ? "bottom-full mb-2"
      : "top-full mt-2";

  return (
    <span
      ref={wrapperRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}

      {visible && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 whitespace-nowrap
            rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)]
            px-2.5 py-1.5 shadow-lg ${popupClasses}`}
        >
          <span className="flex items-center gap-2">
            <span className="text-[11px] text-[var(--color-text-secondary)]">
              {content}
            </span>
            {shortcut && (
              <kbd className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-px font-mono text-[10px] text-[var(--color-text-muted)]">
                {shortcut}
              </kbd>
            )}
          </span>
          {/* Arrow */}
          <span
            className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${
              side === "top"
                ? "top-full border-t-[var(--color-elevated)]"
                : "bottom-full border-b-[var(--color-elevated)]"
            }`}
          />
        </span>
      )}
    </span>
  );
}
