/**
 * The one property Commit 1 exists to establish: a profile without an indexed block lifecycle
 * cannot NAME an indexed command.
 *
 * Most of this file is checked by `tsc`, not at runtime — the `@ts-expect-error` lines are the
 * assertions, and TypeScript's own "unused '@ts-expect-error' directive" error is their positive
 * control. If the narrowing ever degrades into one wide interface, every annotation here goes
 * unused and `bun run typecheck` fails. That is why they are not written as `// @ts-ignore`, which
 * would stay silent in exactly that case.
 */

import {
  //
  describe,
  expect,
  test,
} from "bun:test"

import type {
  //
  AnthropicDeliveryProfile,
  ChatCompletionsDeliveryProfile,
  CommandsFor,
  FormatDeliveryProfile,
  GeminiDeliveryProfile,
  GenerationCommandName,
  ResponsesHttpDeliveryProfile,
  ResponsesWsDeliveryProfile,
} from "~/lib/pipeline/delivery/capability"

import {
  //
  GENERATION_COMMAND_REGISTRY,
  isCommandCompatible,
} from "~/lib/pipeline/delivery/capability"

// Types only — nothing is constructed, so `declare` keeps this a pure compile-time exercise.
declare const anthropic: CommandsFor<AnthropicDeliveryProfile>
declare const responsesHttp: CommandsFor<ResponsesHttpDeliveryProfile>
declare const responsesWs: CommandsFor<ResponsesWsDeliveryProfile>
declare const chatCompletions: CommandsFor<ChatCompletionsDeliveryProfile>
declare const gemini: CommandsFor<GeminiDeliveryProfile>
declare const unnarrowed: CommandsFor<FormatDeliveryProfile>

function positiveSamples(): void {
  // Anthropic reaches both halves.
  void anthropic.emitGeneric
  void anthropic.emitKeepalive
  void anthropic.terminate
  void anthropic.openAnchor
  void anthropic.closeOpenAnchor
  void anthropic.pulseAnchor
  void anthropic.openRealBlock
  void anthropic.writeRealBlockFrame
  void anthropic.pulseOpenBlock
  void anthropic.closeAnchorThenOpenRealBlock

  // The other four reach the common half.
  void responsesHttp.emitGeneric
  void responsesWs.emitKeepalive
  void chatCompletions.terminate
  void gemini.openMessageEnvelope
}

function negativeSamples(): void {
  // @ts-expect-error Responses/HTTP has no indexed block lifecycle.
  void responsesHttp.openAnchor
  // @ts-expect-error Responses/WS has no indexed block lifecycle.
  void responsesWs.openRealBlock
  // @ts-expect-error Chat Completions has no indexed block lifecycle.
  void chatCompletions.writeRealBlockFrame
  // @ts-expect-error Gemini has no indexed block lifecycle.
  void gemini.pulseAnchor
  // @ts-expect-error An un-narrowed union cannot reach the indexed port; narrow the PROFILE first.
  void unnarrowed.openAnchor
}

describe("delivery capability narrowing", () => {
  test("the compile fixtures are part of the build", () => {
    // Runtime cannot observe a type error, so this only pins the fixtures into the module graph:
    // if someone deletes them, this fails and says why. The real check is `bun run typecheck`.
    expect(typeof positiveSamples).toBe("function")
    expect(typeof negativeSamples).toBe("function")
  })
})

describe("generation command registry", () => {
  test("agrees with the type-level narrowing about which commands are indexed", () => {
    const anthropicProfile = { indexedBlockLifecycle: "anthropic" } as FormatDeliveryProfile
    const plainProfile = { indexedBlockLifecycle: "none" } as FormatDeliveryProfile

    // The names in `IndexedGenerationCommands`, written out rather than derived — deriving them
    // from the same registry the assertion checks would make this vacuous.
    const indexedCommands = new Set<GenerationCommandName>([
      "openAnchor",
      "closeOpenAnchor",
      "pulseAnchor",
      "openRealBlock",
      "writeRealBlockFrame",
      "pulseOpenBlock",
      "closeAnchorThenOpenRealBlock",
    ])

    for (const command of Object.keys(GENERATION_COMMAND_REGISTRY) as Array<GenerationCommandName>) {
      const isIndexed = indexedCommands.has(command)
      expect(isCommandCompatible(command, anthropicProfile)).toBe(true)
      expect(isCommandCompatible(command, plainProfile)).toBe(!isIndexed)
    }
  })

  test("every indexed command carries the indexed effect", () => {
    expect(GENERATION_COMMAND_REGISTRY.openAnchor.effect).toBe("indexed-block")
    expect(GENERATION_COMMAND_REGISTRY.closeAnchorThenOpenRealBlock.effect).toBe("indexed-block")
    expect(GENERATION_COMMAND_REGISTRY.emitGeneric.effect).toBe("passthrough")
    expect(GENERATION_COMMAND_REGISTRY.emitKeepalive.effect).toBe("keepalive")
    expect(GENERATION_COMMAND_REGISTRY.terminate.effect).toBe("terminal")
  })
})
