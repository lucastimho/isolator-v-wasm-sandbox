"use client";

/**
 * ThemeToggle.tsx
 *
 * A single icon button that switches between dark and light mode.
 *
 * Strategy:
 *   - On mount, reads the user's saved preference from localStorage.
 *   - On click, toggles the "dark" / "light" class on <html> and saves
 *     the new preference so it survives page refreshes.
 *   - The anti-flash inline script in layout.tsx ensures the correct
 *     class is applied before the first paint, so there is no flicker.
 */

import { useState, useEffect } from "react";
import { Sun, Moon } from "lucide-react";

export default function ThemeToggle() {
  // Default to "dark" — matches the server-rendered <html className="dark">.
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // Sync with the DOM state on mount (the anti-flash script may have already
  // swapped to "light" before React hydrated).
  useEffect(() => {
    const stored = localStorage.getItem("theme") as "dark" | "light" | null;
    if (stored) {
      setTheme(stored);
    } else if (document.documentElement.classList.contains("light")) {
      setTheme("light");
    }
  }, []);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    try { localStorage.setItem("theme", next); } catch { /* private browsing */ }
    const html = document.documentElement;
    html.classList.toggle("dark",  next === "dark");
    html.classList.toggle("light", next === "light");
  };

  return (
    <button
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="flex items-center justify-center rounded p-1.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-primary)]"
    >
      {theme === "dark"
        ? <Sun  className="h-4 w-4" />
        : <Moon className="h-4 w-4" />}
    </button>
  );
}
