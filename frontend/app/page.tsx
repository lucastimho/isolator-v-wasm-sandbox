// Server Component — renders the static chrome and delegates the client-heavy
// ExecutionConsole to a Client Component wrapper (ssr: false is not allowed
// directly in Server Components in Next.js 15 App Router).
import { Suspense } from "react";
import ConsoleLoader from "@/components/ConsoleLoader";
import OrchestratorStatus from "@/components/OrchestratorStatus";

export default function HomePage() {
  return (
    <main className="flex h-screen flex-col overflow-hidden bg-[var(--color-void)]">
      {/* ── Top chrome bar ─────────────────────────────────────────────── */}
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
        <div className="flex items-center gap-2">
          {/* Fake traffic lights for aesthetics */}
          <span className="h-3 w-3 rounded-full bg-[var(--color-danger)] opacity-80" />
          <span className="h-3 w-3 rounded-full bg-[var(--color-warn)] opacity-80" />
          <span className="h-3 w-3 rounded-full bg-[var(--color-ok)] opacity-80" />
          <span className="ml-3 font-mono text-xs font-medium tracking-widest text-[var(--color-text-secondary)] uppercase">
            isolator-v / execution console
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]">
          <span className="font-mono">v0.1.0-alpha</span>
          <OrchestratorStatus />
        </div>
      </header>

      {/* ── Main workspace ─────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden">
        <Suspense>
          <ConsoleLoader />
        </Suspense>
      </div>
    </main>
  );
}
