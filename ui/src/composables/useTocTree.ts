import { computed, ref, type ComputedRef, type Ref } from "vue"

import type { HistoryEntry, MessageContent } from "@/types"

export interface TocNode {
  id: string
  label: string
  icon: string
  children?: Array<TocNode>
}

export interface UseTocTreeReturn {
  tocTree: ComputedRef<Array<TocNode>>
  activeId: Ref<string>
  expandedNodes: Ref<Set<string>>
  scrollTo: (id: string) => void
  toggleNode: (id: string) => void
}

function roleIcon(role: string): string {
  if (role === "user") return "mdi-account"
  if (role === "assistant") return "mdi-robot"
  if (role === "system") return "mdi-cog"
  if (role === "tool") return "mdi-wrench"
  return "mdi-message-text"
}

function blockTypeIcon(type: string): string {
  if (type === "text") return "mdi-text"
  if (type === "thinking" || type === "redacted_thinking") return "mdi-brain"
  if (type === "tool_use") return "mdi-wrench"
  if (type === "tool_result") return "mdi-clipboard-check"
  if (type === "image") return "mdi-image"
  return "mdi-code-braces"
}

function blockLabel(block: {
  type: string
  text?: string
  thinking?: string
  name?: string
  tool_use_id?: string
}): string {
  if (block.type === "text" && typeof block.text === "string") {
    const preview = block.text.slice(0, 30).replace(/\n/g, " ")
    return `text: ${preview}${block.text.length > 30 ? "…" : ""}`
  }
  if (block.type === "thinking") return "thinking"
  if (block.type === "redacted_thinking") return "redacted_thinking"
  if (block.type === "tool_use" && block.name) return `tool_use: ${block.name}`
  if (block.type === "tool_result") return `tool_result`
  return block.type
}

function msgContentBlocks(
  msg: MessageContent,
): Array<{ type: string; text?: string; thinking?: string; name?: string; tool_use_id?: string }> {
  if (typeof msg.content === "string") return [{ type: "text", text: msg.content }]
  if (Array.isArray(msg.content))
    return msg.content as Array<{ type: string; text?: string; thinking?: string; name?: string; tool_use_id?: string }>
  return []
}

function msgSummary(msg: MessageContent): string {
  const blocks = msgContentBlocks(msg)
  if (blocks.length === 1 && blocks[0].type === "text") {
    const preview = (blocks[0].text ?? "").slice(0, 30).replace(/\n/g, " ")
    return preview + ((blocks[0].text ?? "").length > 30 ? "…" : "")
  }
  return `${blocks.length} blocks`
}

/** Build TOC tree, manage expand/collapse, and handle scroll-to navigation */
export function useTocTree(entry: Ref<HistoryEntry | null> | ComputedRef<HistoryEntry | null>): UseTocTreeReturn {
  const activeId = ref("")
  const expandedNodes = ref<Set<string>>(new Set(["request"]))

  const tocTree = computed<Array<TocNode>>(() => {
    if (!entry.value) return []
    const nodes: Array<TocNode> = []

    // ── request ──
    const messages = entry.value.request.messages ?? []
    const requestChildren: Array<TocNode> = []

    if (entry.value.request.system) {
      requestChildren.push({ id: "request", label: "system", icon: "mdi-cog" })
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const role = msg.role ?? "unknown"
      const blocks = msgContentBlocks(msg)
      const contentChildren: Array<TocNode> =
        blocks.length > 1
          ? blocks.map((block, j) => ({
              id: `request.messages.${i}.content.${j}`,
              label: blockLabel(block),
              icon: blockTypeIcon(block.type),
            }))
          : []

      requestChildren.push({
        id: `request.messages.${i}`,
        label: `#${i + 1} ${role}: ${msgSummary(msg)}`,
        icon: roleIcon(role),
        children: contentChildren.length > 0 ? contentChildren : undefined,
      })
    }

    nodes.push({
      id: "request",
      label: `request (${messages.length} msgs)`,
      icon: "mdi-arrow-up-bold",
      children: requestChildren,
    })

    // ── response ──
    const hasResponse = entry.value.response?.content || entry.value.response?.error
    if (hasResponse) {
      const responseChildren: Array<TocNode> = []
      if (entry.value.response?.error) {
        responseChildren.push({ id: "response", label: "error", icon: "mdi-alert-circle" })
      }
      if (entry.value.response?.content) {
        responseChildren.push({ id: "response.content", label: "content", icon: "mdi-robot" })
      }
      nodes.push({
        id: "response",
        label: "response",
        icon: "mdi-arrow-down-bold",
        children: responseChildren,
      })
    }

    // ── sseEvents ──
    if (entry.value.sseEvents?.length) {
      nodes.push({
        id: "section-sse-events",
        label: `sseEvents (${entry.value.sseEvents.length})`,
        icon: "mdi-broadcast",
      })
    }

    // ── httpHeaders ──
    if (entry.value.httpHeaders) {
      const headersChildren: Array<TocNode> = []
      if (entry.value.httpHeaders.inboundRequest || entry.value.httpHeaders.outboundRequest) {
        headersChildren.push({ id: "httpHeaders.request", label: "request headers", icon: "mdi-arrow-up" })
      }
      if (entry.value.httpHeaders.outboundResponse) {
        headersChildren.push({ id: "httpHeaders.response", label: "response headers", icon: "mdi-arrow-down" })
      }
      nodes.push({
        id: "httpHeaders",
        label: "httpHeaders",
        icon: "mdi-web",
        children: headersChildren.length > 0 ? headersChildren : undefined,
      })
    }

    // ── attempts ──
    if (entry.value.attempts && entry.value.attempts.length > 1) {
      nodes.push({
        id: "attempts",
        label: `attempts (${entry.value.attempts.length})`,
        icon: "mdi-refresh",
      })
    }

    // ── meta ──
    nodes.push({ id: "meta", label: "meta", icon: "mdi-information" })

    return nodes
  })

  /** Expand the clicked TOC node and all its ancestors so children are visible */
  function ensureExpanded(id: string): void {
    if (!expandedNodes.value.has(id)) {
      expandedNodes.value.add(id)
    }
    // Expand ancestors by checking parent path segments
    const dotIndex = id.indexOf(".")
    if (dotIndex !== -1) {
      const parentId = id.slice(0, dotIndex)
      if (!expandedNodes.value.has(parentId)) {
        expandedNodes.value.add(parentId)
      }
    }
    // Force reactivity
    expandedNodes.value = new Set(expandedNodes.value)
  }

  function scrollTo(id: string): void {
    activeId.value = id
    ensureExpanded(id)

    let el = document.getElementById(id)
    // Fall back to parent message when content-block element doesn't exist in DOM
    if (!el && id.includes(".content.")) {
      el = document.getElementById(id.replace(/\.content\.\d+$/, ""))
    }
    if (!el) return

    // Dispatch custom event so the target component can auto-expand if collapsed.
    // bubbles: true so parent SectionBlocks also expand when navigating to a nested child.
    el.dispatchEvent(new CustomEvent("toc-navigate", { bubbles: true }))

    // Wait a tick for expand animation, then scroll and highlight
    requestAnimationFrame(() => {
      el.scrollIntoView({ behavior: "smooth", block: "start" })
      el.classList.remove("highlight-flash")
      void el.offsetWidth
      el.classList.add("highlight-flash")
    })
  }

  function toggleNode(id: string): void {
    if (expandedNodes.value.has(id)) {
      expandedNodes.value.delete(id)
    } else {
      expandedNodes.value.add(id)
    }
    // Force reactivity
    expandedNodes.value = new Set(expandedNodes.value)
  }

  return {
    tocTree,
    activeId,
    expandedNodes,
    scrollTo,
    toggleNode,
  }
}
