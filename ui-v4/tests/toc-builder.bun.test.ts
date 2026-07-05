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
    expect(nodes[0].label.startsWith("user: ")).toBe(true)

    expect(nodes[0].children).toHaveLength(1)
    expect(nodes[0].children![0].anchorId).toBe("pfx-msg-0-blk-0")
    expect(nodes[0].children![0].kind).toBe("text")
    expect(nodes[0].children![0].label).toBe("text: hello")
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
    expect(textChild.label).toBe("text: hi")

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

  test("tool-only message → label is the bare role (no trailing `: `)", () => {
    // Arrange: no text blocks → empty snippet
    const messages: Array<MessageContent> = [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "Edit", input: {} }] }]

    // Act
    const nodes = buildMessageTocNodes(messages, "pfx")

    // Assert
    expect(nodes[0].label).toBe("assistant")
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

  test("tool_result child resolves the paired tool_use name (call in an earlier message)", () => {
    // Arrange: assistant calls Bash, user turn returns its result.
    const messages: Array<MessageContent> = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ]

    // Act
    const nodes = buildMessageTocNodes(messages, "pfx")

    // Assert: the result block names the tool it answers.
    expect(nodes[1].children![0].kind).toBe("tool_result")
    expect(nodes[1].children![0].label).toBe("tool_result: Bash")
  })

  test("unpaired tool_result (no matching tool_use) stays bare", () => {
    // Arrange
    const messages: Array<MessageContent> = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "orphan", content: "ok" }] }]

    // Act / Assert
    expect(buildMessageTocNodes(messages, "pfx")[0].children![0].label).toBe("tool_result")
  })

  test("a user turn of only tool_results labels the count (plural)", () => {
    // Arrange
    const messages: Array<MessageContent> = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "r1" },
          { type: "tool_result", tool_use_id: "b", content: "r2" },
        ],
      },
    ]

    // Act / Assert
    expect(buildMessageTocNodes(messages, "pfx")[0].label).toBe("user: 2 tool_results")
  })

  test("a single tool_result uses the singular label", () => {
    // Arrange
    const messages: Array<MessageContent> = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r1" }] }]

    // Act / Assert
    expect(buildMessageTocNodes(messages, "pfx")[0].label).toBe("user: 1 tool_result")
  })

  test("a message with text + tool_results prefers the text preview over the count", () => {
    // Arrange
    const messages: Array<MessageContent> = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "tool_result", tool_use_id: "a", content: "r1" },
        ],
      },
    ]

    // Act / Assert
    expect(buildMessageTocNodes(messages, "pfx")[0].label).toBe("user: look at this")
  })

  test("an OpenAI role:'tool' response shows its output preview, not a tool_result count", () => {
    // normalize turns a role:"tool" message into a single tool_result block, but its
    // string content is a useful preview — intentionally shown over "1 tool_result".
    const messages: Array<MessageContent> = [{ role: "tool", tool_call_id: "c1", content: "command output here" } as unknown as MessageContent]

    // Act / Assert
    expect(buildMessageTocNodes(messages, "pfx")[0].label).toBe("tool: command output here")
  })
})

describe("messagePreview", () => {
  test("truncates strings longer than 32 chars with an ellipsis", () => {
    // Arrange
    const long = "x".repeat(50)

    // Act
    const preview = messagePreview({ role: "user", content: long })

    // Assert
    expect(preview).toBe(`${"x".repeat(32)}…`)
    expect(preview.length).toBe(33)
  })

  test("collapses newlines and whitespace runs to single spaces", () => {
    // Arrange
    const content = "one\n\n  two\tthree"

    // Act
    const preview = messagePreview({ role: "user", content })

    // Assert
    expect(preview).toBe("one two three")
  })

  test("tool-only message (no text blocks) projects to empty string", () => {
    // Arrange
    const content: MessageContent = {
      role: "assistant",
      content: [{ type: "tool_use", id: "x", name: "Edit", input: {} }],
    }

    // Act / Assert
    expect(messagePreview(content)).toBe("")
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
    expect(blockLabel({ type: "text", text: "  some\ntext  " })).toBe("text: some text")
    expect(blockLabel({ type: "tool_use", id: "x", name: "Bash", input: {} })).toBe("tool_use: Bash")
    expect(blockLabel({ type: "tool_result", tool_use_id: "x", content: "ok" })).toBe("tool_result")
    expect(blockLabel({ type: "thinking", thinking: "...", signature: "s" })).toBe("thinking")
    expect(blockLabel({ type: "redacted_thinking", data: "d" })).toBe("thinking (redacted)")
    expect(blockLabel({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } })).toBe("image")
  })

  test("truncates long text-block labels to the short cap, keeping the `text:` lead", () => {
    // Arrange
    const text = "y".repeat(60)

    // Act / Assert
    expect(blockLabel({ type: "text", text })).toBe(`text: ${"y".repeat(24)}…`)
  })

  test("tool_result resolves a paired tool name from the map, else stays bare", () => {
    // Arrange
    const names = new Map([["x", "Read"]])

    // Act / Assert
    expect(blockLabel({ type: "tool_result", tool_use_id: "x", content: "ok" }, names)).toBe("tool_result: Read")
    // Unresolved id (or no map) → bare.
    expect(blockLabel({ type: "tool_result", tool_use_id: "y", content: "ok" }, names)).toBe("tool_result")
    expect(blockLabel({ type: "tool_result", tool_use_id: "x", content: "ok" })).toBe("tool_result")
  })
})
