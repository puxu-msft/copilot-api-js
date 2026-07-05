import {
  //
  useEffect,
  useRef,
  useState,
} from "react"

import { CodeBlock } from "@/components/detail/CodeBlock"
import { Modal } from "@/components/shared/Modal"
import { JsonTreeView } from "@/components/tools/JsonTreeView"
import { copyText } from "@/lib/clipboard"

type JsonView = "source" | "tree"

const TOGGLE_BASE = "mono border border-[var(--color-border)] px-2 py-0.5 text-[12px]"

function toggleClass(active: boolean): string {
  return `${TOGGLE_BASE} ${active ? "text-[var(--color-primary)]" : "text-[var(--color-muted)]"}`
}

/** Best-effort `type` off an arbitrary JSON value, for the modal title. */
function blockType(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const t = (value as { type?: unknown }).type
    if (typeof t === "string") return t
  }
  return "block"
}

interface BlockJsonModalProps {
  value: unknown
  onClose: () => void
}

/**
 * Modal that shows one content block's JSON, with a Source (shiki-highlighted) / Tree
 * (collapsible) toggle and a Copy button. Pure presentation — the caller owns the block
 * object; this only stringifies / walks it. The value is the block *as rendered* (post
 * `normalizeToContentBlocks`): for Anthropic-format content that is the verbatim wire
 * object; for OpenAI-format content it is the canonicalized block. The true unmodified
 * request wire bytes remain available via ConvoSegment's "Raw body" toggle.
 */
export function BlockJsonModal({ value, onClose }: BlockJsonModalProps) {
  const [view, setView] = useState<JsonView>("source")
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const json = JSON.stringify(value, null, 2)

  // Clear a pending "Copied" reset on unmount so it never fires setState after the modal closes.
  useEffect(() => () => clearTimeout(copiedTimer.current), [])

  const onCopy = async () => {
    const ok = await copyText(json)
    setCopied(ok)
    if (ok) {
      clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Modal
      title={`${blockType(value)} JSON`}
      onClose={onClose}
    >
      <div className="mb-2 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setView("source")}
          className={toggleClass(view === "source")}
        >
          Source
        </button>
        <button
          type="button"
          onClick={() => setView("tree")}
          className={toggleClass(view === "tree")}
        >
          Tree
        </button>
        <button
          type="button"
          onClick={onCopy}
          className={`${TOGGLE_BASE} ml-auto ${copied ? "text-[var(--color-ok)]" : "text-[var(--color-muted)]"}`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {view === "source" ?
        <CodeBlock
          code={json}
          lang="json"
        />
      : <JsonTreeView value={value} />}
    </Modal>
  )
}
