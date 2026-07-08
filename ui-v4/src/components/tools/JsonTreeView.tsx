import { Collapsible } from "radix-ui"
import {
  //
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import { copyText } from "@/lib/clipboard"

/**
 * Lightweight, dependency-free collapsible tree for an already-parsed JSON value.
 *
 * `JSON.parse` does the heavy lifting upstream; this component only walks the
 * value recursively. Objects and arrays get a clickable header (▾/▸) with an
 * item/key count; primitives render inline, colored by type via the shared
 * Terminal Amber theme tokens. Nodes above `AUTO_COLLAPSE_DEPTH` start collapsed
 * to keep deep structures readable.
 *
 * With `toolbar`, a control row (expand-all / collapse-all / search) is added and
 * every node grows hover-revealed "copy value" / "copy path" actions. Because
 * open state is per-node local state (see `TreeContext`), batch expand/collapse
 * is driven by a monotonically-bumped *bulk signal* rather than lifting every
 * node's boolean up — a newly-mounted node reads the last bulk action to pick its
 * initial open state, so one "expand all" click cascades through branches that
 * were still unmounted when it fired. Existing bare callers pass no `toolbar`, so
 * the default context leaves them byte-behavior-identical to before.
 */

const INDENT_PX = 14
const AUTO_COLLAPSE_DEPTH = 3
/** Containers with more than this many entries render one lazy page at a time. */
const LAZY_THRESHOLD = 200
/** Each "load more" click reveals this many additional entries. */
const LAZY_PAGE_STEP = 200

type Container = Record<string, unknown> | Array<unknown>

/** A non-container JSON value — everything `JSON.parse` yields at a leaf. */
type JsonPrimitive = string | number | boolean | null

/**
 * The last batch expand/collapse action, tagged with a monotonic `seq` so nodes
 * can tell an action they've already applied from a fresh one.
 */
type BulkSignal = { type: "expand" | "collapse"; seq: number } | null

interface TreeContextValue {
  /** Latest expand-all / collapse-all action, or `null` before any. */
  bulk: BulkSignal
  /** Case-folded, trimmed search query; `""` when search is inactive. */
  query: string
  /** Whether the toolbar variant is active (enables per-node copy actions). */
  toolbar: boolean
}

const TreeContext = createContext<TreeContextValue>({ bulk: null, query: "", toolbar: false })

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null
}

/** Text used for matching a primitive against the search query (`null` → "null"). */
function primitiveText(value: JsonPrimitive): string {
  return value === null ? "null" : String(value)
}

/** Does this node's own key or (primitive) value contain the (already-folded) query? */
function nodeSelfMatches(name: string | undefined, value: unknown, query: string): boolean {
  if (query === "") return false
  if (name !== undefined && name.toLowerCase().includes(query)) return true
  if (!isContainer(value))
    return primitiveText(value as JsonPrimitive)
      .toLowerCase()
      .includes(query)
  return false
}

/** Does this node or any descendant match the query? Used to force-expand ancestors. */
function subtreeContains(name: string | undefined, value: unknown, query: string): boolean {
  if (nodeSelfMatches(name, value, query)) return true
  if (!isContainer(value)) return false
  return entriesOf(value).some(([key, child]) => subtreeContains(key, child, query))
}

/** Type-colored inline rendering of a primitive JSON value. */
function Primitive({ value }: { value: JsonPrimitive }) {
  if (value === null) return <span className="text-[var(--color-muted)]">null</span>
  switch (typeof value) {
    case "string": {
      return <span className="text-[var(--color-ok)]">"{value}"</span>
    }
    case "number": {
      return <span className="text-[var(--color-primary)]">{String(value)}</span>
    }
    default: {
      return <span className="text-[#7aa2d0]">{String(value)}</span>
    }
  }
}

/** Entries as `[key, value]` pairs, with array indices as keys. */
function entriesOf(container: Container): Array<[string, unknown]> {
  return Array.isArray(container) ? container.map((v, i) => [String(i), v]) : Object.entries(container)
}

/** `{…} 3 keys` / `[…] 5 items`, or empty markers. */
function containerSummary(container: Container): string {
  const count = Array.isArray(container) ? container.length : Object.keys(container).length
  if (Array.isArray(container)) return count === 0 ? "[]" : `[…] ${count} item${count === 1 ? "" : "s"}`
  return count === 0 ? "{}" : `{…} ${count} key${count === 1 ? "" : "s"}`
}

const ACTION_BTN = "mono border border-[var(--color-border)] px-1 text-[10px] leading-[1.4] text-[var(--color-muted)] hover:text-[var(--color-primary)]"

/**
 * Hover-revealed per-node copy actions. Rendered as SIBLINGS of the collapsible
 * trigger (never nested inside it) so a click copies without also toggling.
 */
function NodeActions({ value, path }: { value: unknown; path: string }) {
  return (
    <span className="ml-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <button
        type="button"
        aria-label={`copy value ${path}`}
        title="复制值"
        className={ACTION_BTN}
        onClick={() => void copyText(JSON.stringify(value, null, 2))}
      >
        ⧉
      </button>
      <button
        type="button"
        aria-label={`copy path ${path}`}
        title="复制 path"
        className={ACTION_BTN}
        onClick={() => void copyText(path)}
      >
        path
      </button>
    </span>
  )
}

interface NodeProps {
  /** Object key or array index; omitted for the root. */
  name?: string
  value: unknown
  depth: number
  /** JSON path to this node: root `"$"`, then `${path}.${key}` / `${path}[${i}]`. */
  path: string
}

function TreeNode({ name, value, depth, path }: NodeProps) {
  const { bulk, query, toolbar } = useContext(TreeContext)

  // Initial open state honors the last bulk action so a node mounting AFTER an
  // "expand all" (its parent was collapsed when the click fired) still opens —
  // the cascade reaches arbitrarily deep branches. No bulk yet → depth default.
  const initialOpen = bulk === null ? depth < AUTO_COLLAPSE_DEPTH : bulk.type === "expand"
  const [open, setOpen] = useState(initialOpen)

  // Apply subsequent bulk actions to already-mounted nodes. `seenSeq` starts at the
  // mount-time seq so this effect no-ops on mount (the initial state already used it).
  const seenSeq = useRef(bulk?.seq)
  useEffect(() => {
    if (bulk !== null && bulk.seq !== seenSeq.current) {
      seenSeq.current = bulk.seq
      setOpen(bulk.type === "expand")
    }
  }, [bulk])

  // Lazy paging for oversized containers (page is independent of bulk/query, so
  // expand-all opens the container but never force-materializes the whole array).
  const [page, setPage] = useState(LAZY_THRESHOLD)

  const container = isContainer(value)
  const entries = useMemo<Array<[string, unknown]>>(() => (isContainer(value) ? entriesOf(value) : []), [value])

  // Force-expand this container when a descendant matches the active search.
  const descendantMatch = useMemo(() => {
    if (query === "" || !container) return false
    return entries.some(([key, child]) => subtreeContains(key, child, query))
  }, [query, container, entries])

  const selfMatch = nodeSelfMatches(name, value, query)
  const forcedOpen = query !== "" && descendantMatch
  const effectiveOpen = forcedOpen || open

  const label =
    name === undefined ? null : (
      <span className="text-[var(--color-text)]">
        {name}
        <span className="text-[var(--color-muted)]">: </span>
      </span>
    )

  const highlight = selfMatch ? "rounded-[2px] bg-[#463a12]" : undefined
  const rowMatch = selfMatch ? "true" : undefined
  // Per-node copy actions are a toolbar-variant affordance; bare callers stay unchanged.
  const actions =
    toolbar ?
      <NodeActions
        value={value}
        path={path}
      />
    : null

  if (!container) {
    return (
      <div
        className="group flex items-center hover:bg-[#1c1a15]"
        style={{ paddingLeft: depth * INDENT_PX }}
        data-json-match={rowMatch}
      >
        <span className={`min-w-0 ${highlight ?? ""}`}>
          {label}
          <Primitive value={value as JsonPrimitive} />
        </span>
        {actions}
      </div>
    )
  }

  const empty = entries.length === 0

  // Empty container: nothing to disclose → a plain summary line (no toggle).
  if (empty) {
    return (
      <div
        className="group flex items-center hover:bg-[#1c1a15]"
        style={{ paddingLeft: depth * INDENT_PX }}
        data-json-match={rowMatch}
      >
        <span className={highlight}>
          {label}
          <span className="text-[var(--color-muted)]">{containerSummary(value)}</span>
        </span>
        {actions}
      </div>
    )
  }

  const isArr = Array.isArray(value)
  const childPath = (key: string) => (isArr ? `${path}[${key}]` : `${path}.${key}`)
  const visible = entries.length > LAZY_THRESHOLD ? entries.slice(0, page) : entries

  // Collapsible disclosure (Radix): the trigger is a real <button> → keyboard-
  // focusable + Enter/Space toggle + aria-expanded. Copy actions sit beside it.
  return (
    <Collapsible.Root
      open={effectiveOpen}
      onOpenChange={setOpen}
    >
      <div
        className="group flex items-center hover:bg-[#1c1a15]"
        style={{ paddingLeft: depth * INDENT_PX }}
        data-json-match={rowMatch}
      >
        <Collapsible.Trigger className="flex min-w-0 flex-1 cursor-pointer select-none items-center text-left outline-none">
          <span className="mr-1 inline-block w-3 shrink-0 text-[var(--color-muted)]">{effectiveOpen ? "▾" : "▸"}</span>
          <span className={highlight}>
            {label}
            <span className="text-[var(--color-muted)]">{containerSummary(value)}</span>
          </span>
        </Collapsible.Trigger>
        {actions}
      </div>
      <Collapsible.Content>
        {visible.map(([key, child]) => (
          <TreeNode
            key={key}
            name={key}
            value={child}
            depth={depth + 1}
            path={childPath(key)}
          />
        ))}
        {page < entries.length && (
          <button
            type="button"
            aria-label={`load more (${entries.length - page} remaining)`}
            className="mono mt-0.5 border border-[var(--color-border)] px-2 py-0.5 text-[11px] text-[var(--color-muted)] hover:text-[var(--color-primary)]"
            style={{ marginLeft: (depth + 1) * INDENT_PX }}
            onClick={() => setPage((p) => p + LAZY_PAGE_STEP)}
          >
            load more (+{LAZY_PAGE_STEP}, {entries.length - page} remaining)
          </button>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

const TOOLBAR_BTN = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px] text-[var(--color-muted)] hover:text-[var(--color-primary)]"

/**
 * Toolbar variant control row: expand-all / collapse-all bump the bulk signal;
 * the search box drives highlight + ancestor force-expand through `TreeContext`.
 */
function Toolbar({
  onExpandAll,
  onCollapseAll,
  query,
  onQuery,
}: {
  onExpandAll: () => void
  onCollapseAll: () => void
  query: string
  onQuery: (q: string) => void
}) {
  return (
    <div className="mb-1 flex items-center gap-1 border-b border-[var(--color-border)] pb-1">
      <button
        type="button"
        aria-label="expand all"
        className={TOOLBAR_BTN}
        onClick={onExpandAll}
      >
        Expand all
      </button>
      <button
        type="button"
        aria-label="collapse all"
        className={TOOLBAR_BTN}
        onClick={onCollapseAll}
      >
        Collapse all
      </button>
      <input
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder="Search keys/values…"
        aria-label="search tree"
        className="mono ml-2 min-w-0 flex-1 border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-[12px] text-[var(--color-text)] outline-none focus:border-[var(--color-primary)]"
      />
    </div>
  )
}

export function JsonTreeView({ value, toolbar = false }: { value: unknown; toolbar?: boolean }) {
  const [bulk, setBulk] = useState<BulkSignal>(null)
  const [queryInput, setQueryInput] = useState("")

  const query = queryInput.trim().toLowerCase()
  const ctx = useMemo<TreeContextValue>(() => ({ bulk, query, toolbar }), [bulk, query, toolbar])

  const expandAll = () => setBulk((b) => ({ type: "expand", seq: (b?.seq ?? 0) + 1 }))
  const collapseAll = () => setBulk((b) => ({ type: "collapse", seq: (b?.seq ?? 0) + 1 }))

  return (
    <TreeContext.Provider value={ctx}>
      <div className="mono text-[12px] leading-[1.6]">
        {toolbar && (
          <Toolbar
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
            query={queryInput}
            onQuery={setQueryInput}
          />
        )}
        <TreeNode
          value={value}
          depth={0}
          path="$"
        />
      </div>
    </TreeContext.Provider>
  )
}
