import {
  //
  useMemo,
  useState,
} from "react"

import type { TocNode } from "@/lib/content/toc"

interface DetailTocTreeProps {
  nodes: Array<TocNode>
  onSelect: (anchorId: string) => void
  activeAnchor?: string
  /** Start with all parent nodes expanded (default: collapsed — message-level first). */
  defaultExpanded?: boolean
  /** Show a header button that expands/collapses all parents at once. */
  showExpandAllToggle?: boolean
}

/**
 * `kind` → text-tint color. Role kinds mirror `MessageBlock`'s `ROLE_COLOR`
 * for cross-view consistency; block kinds reuse existing theme tokens / the
 * code-highlight palette (purple thinking, olive-green ok) so the tree reads in
 * the same Terminal Amber vocabulary as the content pane. The color tints the
 * row's label text (no separate dot) so numbered rows stay uncluttered.
 */
const KIND_COLOR: Record<string, string> = {
  // roles (mirror MessageBlock ROLE_COLOR)
  user: "var(--content-accent)",
  assistant: "var(--content-role-assistant)",
  system: "var(--content-muted)",
  tool: "var(--content-tool-dim)",
  // Stages leg
  leg: "var(--content-accent)",
  // block types
  text: "var(--content-muted)",
  tool_use: "var(--content-tool)",
  tool_result: "var(--content-tool)",
  thinking: "var(--content-thinking-accent)",
  redacted_thinking: "var(--content-thinking-accent)",
  image: "var(--content-role-assistant)",
}

/** Resolve a kind's tint color, falling back to muted for unknown kinds. */
function kindColor(kind: string): string {
  return KIND_COLOR[kind] ?? "var(--content-muted)"
}

/** Collect the anchorIds of every node that has children (for default-collapse). */
function collectParentAnchors(nodes: Array<TocNode>): Array<string> {
  return nodes.flatMap((node) => (node.children && node.children.length > 0 ? [node.anchorId, ...collectParentAnchors(node.children)] : []))
}

interface TocRowProps {
  node: TocNode
  /** Hierarchical, presentational sequence number (e.g. `1`, `1.2`, `1.2.3`). */
  number: string
  collapsed: Set<string>
  onToggle: (anchorId: string) => void
  onSelect: (anchorId: string) => void
  activeAnchor?: string
}

function TocRow({ node, number, collapsed, onToggle, onSelect, activeAnchor }: TocRowProps) {
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const isCollapsed = collapsed.has(node.anchorId)
  const isActive = activeAnchor === node.anchorId

  return (
    <div>
      <div
        data-active={isActive ? "" : undefined}
        className={`mono flex items-center border-l-2 text-[13px] leading-tight transition-colors ${
          isActive ?
            "border-l-[var(--content-accent)] bg-[var(--surface-toc-active)] text-[var(--content-accent)]"
          : "border-l-transparent hover:bg-[var(--surface-toc-hover)]"
        }`}
      >
        {hasChildren ?
          <button
            type="button"
            aria-label={isCollapsed ? "expand" : "collapse"}
            aria-expanded={!isCollapsed}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.anchorId)
            }}
            className="flex w-4 shrink-0 items-center justify-center text-[12px] font-bold text-[var(--content-muted)] hover:text-[var(--content-text)]"
          >
            {isCollapsed ? "+" : "−"}
          </button>
        : <span className="w-4 shrink-0" />}
        <span
          aria-hidden="true"
          className="mr-1.5 shrink-0 text-[12px] text-[var(--content-muted)] select-none"
        >
          {number}
        </span>
        <button
          type="button"
          title={node.label}
          onClick={() => onSelect(node.anchorId)}
          className="flex-1 truncate py-0.5 pr-1 text-left"
          style={isActive ? undefined : { color: kindColor(node.kind) }}
        >
          {node.label}
        </button>
      </div>
      {hasChildren && !isCollapsed ?
        <div className="ml-2 border-l border-[var(--surface-border)]/60 pl-1">
          {children.map((child, j) => (
            <TocRow
              key={child.anchorId}
              node={child}
              number={`${number}.${j + 1}`}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
              activeAnchor={activeAnchor}
            />
          ))}
        </div>
      : null}
    </div>
  )
}

/**
 * Presentational TOC tree: recursive rows + per-node collapse + onSelect +
 * active highlight. No data fetching and no scroll/anchor logic (Task 3's hook
 * owns that). Block children start COLLAPSED so the tree shows message-level
 * nodes first; clicking a node's toggle reveals its children.
 *
 * Each row carries a hierarchical sequence number (`1`, `1.1`, `1.1.1`…)
 * computed during render, a `+`/`−` collapse toggle, and a `kind`-tinted label
 * (the active row instead gets a left accent bar + soft amber tint). The label
 * gets a `title` so truncated rows reveal their full text on hover.
 */
export function DetailTocTree({ nodes, onSelect, activeAnchor, defaultExpanded = false, showExpandAllToggle = false }: DetailTocTreeProps) {
  const allParents = useMemo(() => collectParentAnchors(nodes), [nodes])
  const [collapsed, setCollapsed] = useState<Set<string>>(() => (defaultExpanded ? new Set<string>() : new Set(allParents)))

  function toggle(anchorId: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(anchorId)) {
        next.delete(anchorId)
      } else {
        next.add(anchorId)
      }
      return next
    })
  }

  // "All expanded" means no parent is collapsed; the toggle flips between fully
  // expanded and fully collapsed (a partially-collapsed tree reads as "not all
  // expanded", so the button offers to expand all).
  const allExpanded = collapsed.size === 0
  function toggleAll(): void {
    setCollapsed(allExpanded ? new Set(allParents) : new Set<string>())
  }

  return (
    <div className="flex flex-col">
      {showExpandAllToggle && allParents.length > 0 ?
        <button
          type="button"
          onClick={toggleAll}
          className="mono mb-0.5 self-start px-1 text-[11px] text-[var(--content-muted)] hover:text-[var(--content-text)]"
        >
          {allExpanded ? "− 全部收起" : "+ 全部展开"}
        </button>
      : null}
      {nodes.map((node, i) => (
        <TocRow
          key={node.anchorId}
          node={node}
          number={`${i + 1}`}
          collapsed={collapsed}
          onToggle={toggle}
          onSelect={onSelect}
          activeAnchor={activeAnchor}
        />
      ))}
    </div>
  )
}
