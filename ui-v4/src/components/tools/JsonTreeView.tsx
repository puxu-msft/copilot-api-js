import { Collapsible } from "radix-ui"
import {
  //
  useState,
} from "react"

/**
 * Lightweight, dependency-free collapsible tree for an already-parsed JSON value.
 *
 * `JSON.parse` does the heavy lifting upstream; this component only walks the
 * value recursively. Objects and arrays get a clickable header (▾/▸) with an
 * item/key count; primitives render inline, colored by type via the shared
 * Terminal Amber theme tokens. Nodes above `AUTO_COLLAPSE_DEPTH` start collapsed
 * to keep deep structures readable.
 */

const INDENT_PX = 14
const AUTO_COLLAPSE_DEPTH = 3

type Container = Record<string, unknown> | Array<unknown>

/** A non-container JSON value — everything `JSON.parse` yields at a leaf. */
type JsonPrimitive = string | number | boolean | null

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null
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

interface NodeProps {
  /** Object key or array index; omitted for the root. */
  name?: string
  value: unknown
  depth: number
}

function TreeNode({ name, value, depth }: NodeProps) {
  const [open, setOpen] = useState(depth < AUTO_COLLAPSE_DEPTH)

  const label =
    name === undefined ? null : (
      <span className="text-[var(--color-text)]">
        {name}
        <span className="text-[var(--color-muted)]">: </span>
      </span>
    )

  if (!isContainer(value)) {
    return (
      <div style={{ paddingLeft: depth * INDENT_PX }}>
        {label}
        <Primitive value={value as JsonPrimitive} />
      </div>
    )
  }

  const entries = entriesOf(value)
  const empty = entries.length === 0

  // Empty container: nothing to disclose → a plain summary line (no toggle).
  if (empty) {
    return (
      <div style={{ paddingLeft: depth * INDENT_PX }}>
        {label}
        <span className="text-[var(--color-muted)]">{containerSummary(value)}</span>
      </div>
    )
  }

  // Collapsible disclosure (Radix): the trigger is a real <button> → keyboard-
  // focusable + Enter/Space toggle + aria-expanded, which the old <div onClick>
  // lacked. Content mounts only when open (same as the previous `open && …`).
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
    >
      <Collapsible.Trigger
        className="flex w-full cursor-pointer select-none items-center text-left outline-none hover:bg-[#1c1a15]"
        style={{ paddingLeft: depth * INDENT_PX }}
      >
        <span className="mr-1 inline-block w-3 shrink-0 text-[var(--color-muted)]">{open ? "▾" : "▸"}</span>
        {label}
        <span className="text-[var(--color-muted)]">{containerSummary(value)}</span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        {entries.map(([key, child]) => (
          <TreeNode
            key={key}
            name={key}
            value={child}
            depth={depth + 1}
          />
        ))}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}

export function JsonTreeView({ value }: { value: unknown }) {
  return (
    <div className="mono text-[12px] leading-[1.6]">
      <TreeNode
        value={value}
        depth={0}
      />
    </div>
  )
}
