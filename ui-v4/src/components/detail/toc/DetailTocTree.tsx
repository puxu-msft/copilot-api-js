import { useState } from "react"

import type { TocNode } from "@/lib/content/toc"

interface DetailTocTreeProps {
  nodes: Array<TocNode>
  onSelect: (anchorId: string) => void
  activeAnchor?: string
}

/** Collect the anchorIds of every node that has children (for default-collapse). */
function collectParentAnchors(nodes: Array<TocNode>): Array<string> {
  return nodes.flatMap((node) => (node.children && node.children.length > 0 ? [node.anchorId, ...collectParentAnchors(node.children)] : []))
}

interface TocRowProps {
  node: TocNode
  depth: number
  collapsed: Set<string>
  onToggle: (anchorId: string) => void
  onSelect: (anchorId: string) => void
  activeAnchor?: string
}

function TocRow({ node, depth, collapsed, onToggle, onSelect, activeAnchor }: TocRowProps) {
  const children = node.children ?? []
  const hasChildren = children.length > 0
  const isCollapsed = collapsed.has(node.anchorId)
  const isActive = activeAnchor === node.anchorId

  return (
    <div>
      <div
        className={`mono flex items-center text-[12px] leading-tight ${isActive ? "bg-[#3a2f1a] text-[var(--color-primary)]" : "text-[#999]"}`}
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {hasChildren ?
          <button
            type="button"
            aria-label={isCollapsed ? "expand" : "collapse"}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.anchorId)
            }}
            className="w-4 shrink-0 text-left text-[var(--color-muted)]"
          >
            {isCollapsed ? "▸" : "▾"}
          </button>
        : <span className="w-4 shrink-0" />}
        <button
          type="button"
          onClick={() => onSelect(node.anchorId)}
          className="flex-1 truncate px-1 py-0.5 text-left"
        >
          {node.label}
        </button>
      </div>
      {hasChildren && !isCollapsed ?
        children.map((child) => (
          <TocRow
            key={child.anchorId}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            onToggle={onToggle}
            onSelect={onSelect}
            activeAnchor={activeAnchor}
          />
        ))
      : null}
    </div>
  )
}

/**
 * Presentational TOC tree: recursive rows + per-node collapse + onSelect +
 * active highlight. No data fetching and no scroll/anchor logic (Task 3's hook
 * owns that). Block children start COLLAPSED so the tree shows message-level
 * nodes first; clicking a node's toggle reveals its children.
 */
export function DetailTocTree({ nodes, onSelect, activeAnchor }: DetailTocTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(collectParentAnchors(nodes)))

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

  return (
    <div className="flex flex-col">
      {nodes.map((node) => (
        <TocRow
          key={node.anchorId}
          node={node}
          depth={0}
          collapsed={collapsed}
          onToggle={toggle}
          onSelect={onSelect}
          activeAnchor={activeAnchor}
        />
      ))}
    </div>
  )
}
