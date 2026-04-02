"use client";

/**
 * ConsoleLoader.tsx
 *
 * Client-component wrapper that dynamically imports ExecutionConsole with
 * ssr: false.  This must live in a Client Component because `ssr: false` is
 * only allowed inside Client Components in Next.js 15 App Router.
 */

import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

const ExecutionConsole = dynamic(
  () => import("@/components/ExecutionConsole"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center gap-3 text-[var(--color-text-secondary)]">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-accent)]" />
        <span className="font-mono text-sm tracking-widest uppercase">
          Initialising sandbox runtime…
        </span>
      </div>
    ),
  }
);

export default function ConsoleLoader() {
  return <ExecutionConsole />;
}
