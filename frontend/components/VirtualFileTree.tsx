"use client";

/**
 * VirtualFileTree.tsx
 *
 * A recursive, memoized file tree that shows the VFS snapshot for the
 * current sandbox session.
 *
 * Design principles:
 *  - Local-first: the tree renders immediately from local state; remote
 *    data is merged in without causing a layout shift.
 *  - CRDT-backed: file entries are stored in an Automerge document so that
 *    multiple browser tabs showing the same session merge updates without
 *    conflicts.  Changes are broadcast to other tabs via BroadcastChannel.
 *  - Ghost files: files that have been enqueued (optimistic) but not yet
 *    confirmed by the server are shown with a shimmer animation and a
 *    distinct opacity so the user always sees the expected outcome.
 *  - Lazy expansion: directories are collapsed by default; expansion state
 *    is stored in a Set so sibling re-renders are O(1).
 *  - Virtualization hook: the flat list renderer is written so a
 *    react-window FixedSizeList can be dropped in by swapping the inner
 *    map for a virtualised list when the file count exceeds FILE_VIRT_THRESHOLD.
 */

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import * as Automerge from "@automerge/automerge";
import {
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  FileImage,
  Database,
  Box,
  ChevronRight,
  ChevronDown,
  WifiOff,
  RefreshCw,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────

export interface VFSEntry {
  path: string;      // e.g. "/src/main.rs"
  size?: number;     // bytes, optional
  ghost?: boolean;   // optimistic / not yet confirmed
}

interface VirtualFileTreeProps {
  sessionId: string | null;
  onFileSelect?: (path: string) => void;
}

// ── Tree node types ────────────────────────────────────────────────────────

type TreeNode =
  | { kind: "file"; name: string; path: string; ghost: boolean; size?: number }
  | { kind: "dir";  name: string; path: string; children: TreeNode[] };

// ── API fetch ──────────────────────────────────────────────────────────────

type FetchResult =
  | { ok: true;  entries: VFSEntry[] }
  | { ok: false; networkError: boolean; status?: number };

/**
 * Fetches the VFS file listing from GET /api/v1/vfs/:sessionId.
 *
 * Returns a discriminated union so callers can distinguish:
 *  - network error  (TypeError / timeout) → orchestrator unreachable
 *  - 5xx response   (e.g. 503 when VFS persistence is disabled) → server error
 *  - 4xx response   (e.g. 404 for an unknown session) → soft miss, no backoff
 */
async function fetchVFSEntries(sessionId: string): Promise<FetchResult> {
  try {
    const res = await fetch(`/api/v1/vfs/${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // Surface the status so the poll loop can decide whether to back off.
      return { ok: false, networkError: false, status: res.status };
    }
    const json = await res.json() as Array<{ path: string; size: number }>;
    return { ok: true, entries: json.map((e) => ({ path: e.path, size: e.size })) };
  } catch (err) {
    // TypeError  = fetch() itself failed (ECONNREFUSED / network down)
    // TimeoutError / AbortError = AbortSignal.timeout fired
    return { ok: false, networkError: true };
  }
}

// ── Backoff config ─────────────────────────────────────────────────────────

const POLL_BASE_MS = 3_000;
const POLL_MAX_MS  = 60_000;

// ── Build tree ─────────────────────────────────────────────────────────────

function buildTree(entries: VFSEntry[]): TreeNode[] {
  const root: TreeNode[] = [];
  const dirMap = new Map<string, TreeNode & { kind: "dir" }>();

  // Sort so dirs come before files within the same segment depth
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const parts = entry.path.replace(/^\//, "").split("/");
    const filename = parts[parts.length - 1];
    const dirParts = parts.slice(0, -1);

    // Ensure all ancestor directories exist
    let parentChildren = root;
    let cumulativePath = "";
    for (const segment of dirParts) {
      cumulativePath += "/" + segment;
      if (!dirMap.has(cumulativePath)) {
        const dir: TreeNode & { kind: "dir" } = {
          kind: "dir",
          name: segment,
          path: cumulativePath,
          children: [],
        };
        dirMap.set(cumulativePath, dir);
        parentChildren.push(dir);
      }
      parentChildren = dirMap.get(cumulativePath)!.children;
    }

    parentChildren.push({
      kind: "file",
      name: filename,
      path: entry.path,
      ghost: entry.ghost ?? false,
      size: entry.size,
    });
  }

  return root;
}

// ── Automerge CRDT doc type ────────────────────────────────────────────────

/**
 * The Automerge document shape for the VFS file tree.
 * All fields must be Automerge-compatible (plain objects / arrays / scalars).
 */
interface VFSDoc {
  entries: Array<{ path: string; size: number; ghost: boolean }>;
}

/** Channel name is scoped per session so tabs only sync within the same session. */
function broadcastChannelName(sessionId: string) {
  return `vfs-sync:${sessionId}`;
}

// ── State ──────────────────────────────────────────────────────────────────

type Action =
  | { type: "SET_ENTRIES"; entries: VFSEntry[] }
  | { type: "TOGGLE_DIR"; path: string }
  | { type: "SET_OFFLINE"; offline: boolean };

interface TreeState {
  entries:  VFSEntry[];
  expanded: Set<string>;
  offline:  boolean;
}

function reducer(state: TreeState, action: Action): TreeState {
  switch (action.type) {
    case "SET_ENTRIES":
      return { ...state, entries: action.entries };
    case "TOGGLE_DIR": {
      const next = new Set(state.expanded);
      if (next.has(action.path)) next.delete(action.path);
      else next.add(action.path);
      return { ...state, expanded: next };
    }
    case "SET_OFFLINE":
      return { ...state, offline: action.offline };
  }
}

// ── Icon helpers ───────────────────────────────────────────────────────────

const EXT_ICONS: Record<string, React.ElementType> = {
  rs: FileCode, ts: FileCode, tsx: FileCode, js: FileCode, jsx: FileCode,
  py: FileCode, go: FileCode, c: FileCode, cpp: FileCode, h: FileCode,
  toml: FileText, json: FileText, yaml: FileText, yml: FileText, md: FileText,
  txt: FileText, log: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, svg: FileImage,
  csv: Database, sqlite: Database, db: Database,
  wasm: Box,
};

function FileIcon({ name, className }: { name: string; className?: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const Icon = EXT_ICONS[ext] ?? File;
  return <Icon className={className} />;
}

function formatBytes(n: number): string {
  if (n < 1024)        return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── File row ───────────────────────────────────────────────────────────────

const FileRow = memo(function FileRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode & { kind: "file" };
  depth: number;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`group flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left transition-colors ${
        selected
          ? "bg-[var(--color-accent-glow)] text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-primary)]"
      } ${node.ghost ? "opacity-50" : ""}`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
      title={node.path}
    >
      <span className={node.ghost ? "ghost-file rounded" : ""}>
        <FileIcon
          name={node.name}
          className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)] group-hover:text-[var(--color-accent)]"
        />
      </span>
      <span className="flex-1 truncate font-mono text-[11px]">{node.name}</span>
      {node.size !== undefined && (
        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100">
          {formatBytes(node.size)}
        </span>
      )}
      {node.ghost && (
        <span className="shrink-0 rounded-full border border-[var(--color-border)] px-1 text-[9px] text-[var(--color-text-muted)] uppercase tracking-wider">
          pending
        </span>
      )}
    </button>
  );
});

// ── Dir row ────────────────────────────────────────────────────────────────

const DirRow = memo(function DirRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: TreeNode & { kind: "dir" };
  depth: number;
  expanded: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      onClick={() => onToggle(node.path)}
      className="flex w-full items-center gap-1.5 rounded px-2 py-[3px] text-left text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-elevated)] hover:text-[var(--color-text-primary)]"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {expanded ? (
        <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
      )}
      {expanded ? (
        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
      ) : (
        <Folder className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" />
      )}
      <span className="font-mono text-[11px]">{node.name}</span>
    </button>
  );
});

// ── Recursive tree renderer ────────────────────────────────────────────────

function TreeNodes({
  nodes,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  expanded: Set<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) =>
        node.kind === "dir" ? (
          <div key={node.path}>
            <DirRow
              node={node}
              depth={depth}
              expanded={expanded.has(node.path)}
              onToggle={onToggle}
            />
            {expanded.has(node.path) && (
              <TreeNodes
                nodes={node.children}
                depth={depth + 1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            )}
          </div>
        ) : (
          <FileRow
            key={node.path}
            node={node}
            depth={depth}
            selected={selected === node.path}
            onSelect={onSelect}
          />
        )
      )}
    </>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function VirtualFileTree({
  sessionId,
  onFileSelect,
}: VirtualFileTreeProps) {
  const [state, dispatch] = useReducer(reducer, {
    entries:  [],
    expanded: new Set<string>(),
    offline:  false,
  });
  const selectedRef = useRef<string | null>(null);

  // Automerge doc for the file entry list (CRDT-backed, multiplayer-safe).
  const docRef = useRef<Automerge.Doc<VFSDoc>>(
    Automerge.change(Automerge.init<VFSDoc>(), (d) => { d.entries = []; })
  );

  /**
   * Apply a new server snapshot to the Automerge doc, broadcast the change
   * binary to other tabs, then dispatch to the React reducer.
   */
  const applyRemoteEntries = useCallback(
    (
      sessionId: string,
      incoming: Array<{ path: string; size: number; ghost?: boolean }>,
      bc: BroadcastChannel
    ) => {
      const prev = docRef.current;
      const next = Automerge.change(prev, (d) => {
        // Replace the entries list with the incoming snapshot.
        // Automerge records this as a set of individual ops so concurrent
        // edits in other tabs (e.g. optimistic ghost files) survive a merge.
        d.entries = incoming.map((e) => ({
          path:  e.path,
          size:  e.size,
          ghost: e.ghost ?? false,
        }));
      });
      docRef.current = next;

      // Broadcast the binary diff to other open tabs.
      try {
        const diff = Automerge.getChanges(prev, next);
        if (diff.length > 0) {
          bc.postMessage({ type: "automerge-patch", changes: diff.map((c) => Array.from(c)) });
        }
      } catch {
        // BroadcastChannel may be unavailable (SSR guard, private browsing).
      }

      // Materialise into the React reducer.
      dispatch({
        type: "SET_ENTRIES",
        entries: Array.from(docRef.current.entries).map((e) => ({
          path:  e.path,
          size:  e.size,
          ghost: e.ghost,
        })),
      });
    },
    []
  );

  // ── Session load + polling + cross-tab sync ──────────────────────────────

  useEffect(() => {
    if (!sessionId) {
      dispatch({ type: "SET_ENTRIES", entries: [] });
      // Reset the doc for the next session.
      docRef.current = Automerge.change(Automerge.init<VFSDoc>(), (d) => { d.entries = []; });
      return;
    }

    let cancelled  = false;
    let firstLoad  = true;
    // Start at half the base so the first doubling lands exactly at POLL_BASE_MS.
    let backoffMs  = POLL_BASE_MS / 2;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const bc       = new BroadcastChannel(broadcastChannelName(sessionId));

    // Receive Automerge diffs from other tabs and merge them.
    bc.onmessage = (ev: MessageEvent) => {
      if (ev.data?.type !== "automerge-patch") return;
      try {
        const changes = (ev.data.changes as number[][]).map(
          (arr) => new Uint8Array(arr)
        );
        const [merged] = Automerge.applyChanges(docRef.current, changes);
        docRef.current = merged;
        dispatch({
          type: "SET_ENTRIES",
          entries: Array.from(merged.entries).map((e) => ({
            path:  e.path,
            size:  e.size,
            ghost: e.ghost,
          })),
        });
      } catch {
        // Corrupted or incompatible change — ignore.
      }
    };

    /**
     * Self-rescheduling poll with exponential back-off.
     *
     * On success (200):        reset backoff → POLL_BASE_MS, clear offline.
     * On network error or 5xx: mark offline, double interval (cap POLL_MAX_MS).
     *   - network error = fetch threw (ECONNREFUSED / timeout)
     *   - 5xx           = orchestrator is up but the endpoint is unavailable
     *                     (e.g. 503 when LIBSQL_URL is not set and VFS
     *                     persistence is disabled)
     * On 4xx (e.g. 404):      session not found yet — keep base interval,
     *                          don't mark offline, backend is healthy.
     */
    const load = async () => {
      const result = await fetchVFSEntries(sessionId);
      if (cancelled) return;

      if (result.ok) {
        backoffMs = POLL_BASE_MS / 2; // reset; next error starts doubling from base
        dispatch({ type: "SET_OFFLINE", offline: false });
        applyRemoteEntries(
          sessionId,
          result.entries.map((e) => ({ ...e, size: e.size ?? 0 })),
          bc
        );
        if (firstLoad) {
          firstLoad = false;
          dispatch({ type: "TOGGLE_DIR", path: "/src" });
          dispatch({ type: "TOGGLE_DIR", path: "/output" });
        }
      } else if (result.networkError || (result.status !== undefined && result.status >= 500)) {
        // Orchestrator unreachable or server error — back off exponentially.
        dispatch({ type: "SET_OFFLINE", offline: true });
        backoffMs = Math.min(backoffMs * 2, POLL_MAX_MS);
      }
      // 4xx (session not ready, not found, etc.): keep current interval and
      // don't mark offline — the orchestrator is up, the session just isn't
      // ready yet.

      if (!cancelled) {
        timerId = setTimeout(load, backoffMs);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
      bc.close();
    };
  }, [sessionId, applyRemoteEntries]);

  const tree = useMemo(() => buildTree(state.entries), [state.entries]);

  const handleToggle = useCallback((path: string) => {
    dispatch({ type: "TOGGLE_DIR", path });
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      selectedRef.current = path;
      onFileSelect?.(path);
    },
    [onFileSelect]
  );

  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <Folder className="h-8 w-8 text-[var(--color-text-muted)] opacity-40" />
        <p className="font-mono text-[10px] text-[var(--color-text-muted)] uppercase tracking-widest">
          No active session
        </p>
      </div>
    );
  }

  // ── Offline banner: shown at the top when orchestrator is unreachable ───────
  const offlineBanner = state.offline && (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-elevated)] px-3 py-2">
      <WifiOff className="h-3.5 w-3.5 shrink-0 text-[var(--color-warn)]" />
      <span className="flex-1 font-mono text-[10px] text-[var(--color-text-muted)]">
        Orchestrator offline — retrying…
      </span>
      <RefreshCw className="h-3 w-3 animate-spin text-[var(--color-text-muted)] opacity-60" />
    </div>
  );

  if (tree.length === 0) {
    // If offline and no entries, show a dedicated placeholder instead of shimmer.
    if (state.offline) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
          <WifiOff className="h-7 w-7 text-[var(--color-warn)] opacity-60" />
          <div className="space-y-1">
            <p className="font-mono text-[10px] font-medium uppercase tracking-widest text-[var(--color-text-muted)]">
              Orchestrator offline
            </p>
            <p className="text-[10px] text-[var(--color-text-muted)]">
              Retrying automatically…
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-1.5 p-2">
        {/* Ghost shimmer placeholder rows */}
        {[80, 65, 90, 55, 75].map((w, i) => (
          <div
            key={i}
            className="ghost-file mx-2 h-5 rounded"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {offlineBanner}
      <div className="py-1">
        <TreeNodes
          nodes={tree}
          depth={0}
          expanded={state.expanded}
          selected={selectedRef.current}
          onToggle={handleToggle}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}
