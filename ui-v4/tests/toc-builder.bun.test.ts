/**
 * Pure-logic tests for the TOC tree-model builder.
 *
 * Asserts the real anchor-id scheme (CONTRACT with the renderer), block-label
 * derivation, role-prefixed message labels, preview truncation + whitespace
 * collapse, and index incrementing across messages.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type { MessageContent } from "@/lib/content/types"

import {
  //
  blockLabel,
  buildMessageTocNodes,
  messagePreview,
} from "@/lib/content/toc"

describe("buildMessageTocNodes", () => {
  test("user message with string content → one node + one text-block child, correct anchor ids", () => {
    // Arrange
    const messages: Array<MessageContent> = [{ role: "user", content: "hello" }]

    // Act
    const nodes = buildMessageTocNodes(messages, "pfx")

    // Assert
    expect(nodes).toHaveLength(1)
    expect(nodes[0].anchorId).toBe("pfx-msg-0")
    expect(nodes[0].kind).toBe("user")
    expect(nodes[0].label.startsWith("user · ")).toBe(true)

    expect(nodes[0].children).toHaveLength(1)
    expect(nodes[0].children![0].anchorId).toBe("pfx-msg-0-blk-0")
    expect(nodes[0].children![0].kind).toBe("text")
    expect(nodes[0].children![0].label).toBe("hello")
  })

  test("assistant message with text + tool_use blocks → two children with blk-indexed anchors", () => {
    // Arrange
    const messages: Array<MessageContent> = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", id: "x", name: "Edit", input: {} },
        ],
      },
    ]

    // Act
    const nodes = buildMessageTocNodes(messages, "pfx")

    // Assert
    expect(nodes[0].anchorId).toBe("pfx-msg-0")
    expect(nodes[0].kind).toBe("assistant")
    expect(nodes[0].children).toHaveLength(2)

    const [textChild, toolChild] = nodes[0].children!
    expect(textChild.anchorId).toBe("pfx-msg-0-blk-0")
    expect(textChild.kind).toBe("text")
    expect(textChild.label).toBe("hi")

    expect(toolChild.anchorId).toBe("pfx-msg-0-blk-1")
    expect(toolChild.kind).toBe("tool_use")
    expect(toolChild.label).toBe("tool_use: Edit")
  })

  test("a message normalizing to 0 blocks omits children", () => {
    // Arrange: empty string content → normalizeToContentBlocks yields []
    const messages: Array<MessageContent> = [{ role: "assistant", content: "" }]

    // Act
    const nodes = buildMessageTocNodes(messages, "pfx")

    // Assert
    expect(nodes).toHaveLength(1)
    expect(nodes[0].children).toBeUndefined()
  })

  test("multiple messages → indices increment", () => {
    // Arrange
    const messages: Array<MessageContent> = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]

    // Act
    const nodes = buildMessageTocNodes(messages, "pfx")

    // Assert
    expect(nodes.map((n) => n.anchorId)).toEqual(["pfx-msg-0", "pfx-msg-1"])
    expect(nodes[0].children![0].anchorId).toBe("pfx-msg-0-blk-0")
    expect(nodes[1].children![0].anchorId).toBe("pfx-msg-1-blk-0")
  })
})

describe("messagePreview", () => {
  test("truncates strings longer than 40 chars with an ellipsis", () => {
    // Arrange
    const long = "x".repeat(50)

    // Act
    const preview = messagePreview({ role: "user", content: long })

    // Assert
    expect(preview).toBe(`${"x".repeat(40)}…`)
    expect(preview.length).toBe(41)
  })

  test("collapses newlines and whitespace runs to single spaces", () => {
    // Arrange
    const content = "line one\n\n  line   two\tline three"

    // Act
    const preview = messagePreview({ role: "user", content })

    // Assert
    expect(preview).toBe("line one line two line three")
  })

  test("block content projects joined text of text blocks", () => {
    // Arrange
    const content: MessageContent = {
      role: "assistant",
      content: [
        { type: "text", text: "alpha" },
        { type: "tool_use", id: "x", name: "Edit", input: {} },
        { type: "text", text: "beta" },
      ],
    }

    // Act / Assert
    expect(messagePreview(content)).toBe("alpha beta")
  })
})

describe("blockLabel", () => {
  test("derives the right label per block type", () => {
    expect(blockLabel({ type: "text", text: "  some\ntext  " })).toBe("some text")
    expect(blockLabel({ type: "tool_use", id: "x", name: "Bash", input: {} })).toBe("tool_use: Bash")
    expect(blockLabel({ type: "tool_result", tool_use_id: "x", content: "ok" })).toBe("tool_result")
    expect(blockLabel({ type: "thinking", thinking: "...", signature: "s" })).toBe("thinking")
    expect(blockLabel({ type: "redacted_thinking", data: "d" })).toBe("thinking (redacted)")
    expect(blockLabel({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } })).toBe("image")
  })

  test("truncates long text-block labels", () => {
    // Arrange
    const text = "y".repeat(60)

    // Act / Assert
    expect(blockLabel({ type: "text", text })).toBe(`${"y".repeat(40)}…`)
  })
})
