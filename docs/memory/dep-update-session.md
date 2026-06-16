# Dependency Update Session (2026-02-27) - COMPLETED

## All Done

### Main project (package.json)
- `bun update --ignore-scripts` to update semver-range deps
- `@anthropic-ai/sdk`: `^0.74.0` → `^0.78.0` (breaking: ToolUseBlock now requires `caller` field)
- `proxy-from-env`: `^1.1.0` → `^2.0.0` (API compatible, still exports `getProxyForUrl`)
- Fixed SDK v0.78 type errors (AssistantMessage, sanitize, non-stream, stream)
- Fixed @types/bun 1.3.9 Buffer→string errors in test files
- **Main project typecheck passes**

### History-v3 (ui/history-v3/package.json)
- Upgraded: vite 7, plugin-vue 6, vue-tsc 3, typescript 5.9
- Fixed pre-existing type errors (ContentRenderer, MessageBlock, useHistoryStore, SseEventsSection)
- **History-v3 typecheck passes**

### Caller field verification
- `caller: { type: "direct" }` confirmed correct, matches vscode-copilot-chat anthropicAdapter.ts
- Coverage is complete: only non-stream.ts and stream.ts construct ToolUseBlock

### Not upgraded (intentionally):
- `eslint`: 9 → 10 (major, @echristian/eslint-config compatibility unknown)
- `tsdown`: 0.20.3 → 0.21.0-beta.2 (only beta available)

### Remaining: run `bun test tests/unit/` and `bun test tests/component/` to verify
