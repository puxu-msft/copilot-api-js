# Compatibility Cleanup Inventory

This document records the currently confirmed backward-compatibility layers in the project.

Scope rules:
- Include real compatibility shims, legacy routes, legacy config handling, legacy data-shape fallbacks, and deprecated compatibility entry points.
- Exclude normal error handling, generic fallback messages, and other defensive programming that is not preserving an older external contract.

## High Priority

### 1. Legacy Web UI routes and pages still exist

Status:
- Intentional design
- Not a cleanup target

The project still ships and tests a full legacy UI alongside the Vuetify UI.

Evidence:
- `ui/history-v3/src/router.ts`
- `ui/history-v3/src/components/layout/NavBar.vue`
- `ui/history-v3/src/pages/DashboardPage.vue`
- `tests/e2e-ui/legacy-pages.pw.ts`

Current behavior:
- `/ui#/history`, `/ui#/logs`, `/ui#/dashboard`, `/ui#/models`, `/ui#/usage` still resolve.
- NavBar still exposes a Legacy/Vuetify switch.
- Legacy pages are marked `@deprecated` but remain active.

Rationale:
- The legacy Web UI remains intentionally shipped and tested.
- This should not be treated as accidental compatibility baggage.

### 2. Legacy models without `supported_endpoints` are treated as universally reachable

The backend still preserves old model metadata behavior where missing `supported_endpoints` means "allow everything".

Evidence:
- `src/lib/models/endpoint.ts`
- `tests/e2e/model-endpoint-completeness.test.ts`
- `tests/component/supported-endpoints.test.ts`

Current behavior:
- `isEndpointSupported()` returns `true` when `model?.supported_endpoints` is absent.
- This is explicitly documented in code comments as legacy behavior.
- E2E tests still assert that legacy models are reachable via this fallback.

Cleanup direction:
- Require explicit `supported_endpoints`.
- Decide whether missing `supported_endpoints` should mean "unsupported" or "invalid model metadata".
- Remove legacy tests that assert implicit reachability.

## Medium Priority

### 3. Model name resolution still preserves legacy and shorthand inputs

Status:
- Intentional design
- Not a cleanup target

Model resolution supports multiple non-canonical forms to preserve old caller behavior.

Evidence:
- `src/lib/models/resolver.ts`
- `src/routes/chat-completions/handler.ts`
- `src/routes/messages/handler.ts`
- `src/routes/responses/handler.ts`
- `src/routes/responses/ws.ts`

Current behavior:
- Short aliases are accepted: `opus`, `sonnet`, `haiku`.
- Date-suffixed names are normalized.
- Hyphenated/dot-version variants are normalized.
- Family-level override fallback propagates across model family members.

Rationale:
- The project intentionally accepts shorthand and normalized model identifiers as part of its request UX.
- This behavior should not be treated as accidental compatibility baggage.

### 4. Config still contains an explicit backward-compatibility normalization

Status:
- Intentional design
- Not a cleanup target

The config loader still rewrites an old boolean form into the newer enum-like form.

Evidence:
- `src/lib/config/config.ts`

Current behavior:
- `anthropic.dedup_tool_calls: true` is normalized to `"input"`.
- This compatibility remains necessary.

Cleanup direction:
- Do not remove unless boolean `true` is proven unnecessary across real user configs.

### 5. History WebSocket module is still a compatibility wrapper

Status:
- Removed

Evidence:
- Former wrapper: `src/lib/history/ws.ts`

Current behavior:
- Removed. Consumers now import the canonical topic-aware WebSocket module from `~/lib/ws`.

Cleanup direction:
- Completed.

## Low Priority

### 6. Environment token provider still accepts legacy/common variable names

Status:
- Intentional design
- Not a cleanup target

The environment token provider still accepts more than the project-specific variable.

Evidence:
- `src/lib/token/providers/env.ts`

Current behavior:
- Checks `COPILOT_API_GITHUB_TOKEN`
- Also checks `GH_TOKEN`
- Also checks `GITHUB_TOKEN`

Rationale:
- Accepting `GH_TOKEN` and `GITHUB_TOKEN` is an intentional interoperability choice.
- This improves integration with existing developer environments and GitHub CLI conventions.

### 7. Deprecated E2E helper still exists

Status:
- Removed

Evidence:
- `tests/e2e/config.ts`

Current behavior:
- Removed. Tests now use `getE2EMode()` directly.

Rationale:
- Removed per cleanup request.

## Protocol / Upstream Compatibility

These are not necessarily internal legacy leftovers, but they are still compatibility logic and should be tracked separately.

### 8. Anthropic `context_management` downgrade retry

Evidence:
- `src/lib/request/strategies/context-management-retry.ts`
- `src/lib/anthropic/request-preparation.ts`

Current behavior:
- If upstream rejects `context_management` as an extra input, the request is retried with it disabled.
- Unsupported status is cached per model.

Why this is different:
- This is protocol compatibility with lagging upstream behavior, not purely internal historical baggage.

Cleanup direction:
- Keep if upstream inconsistency is still expected.
- Remove only if strict failure is preferred over adaptive retry.

## Tests That Still Encode Compatibility Assumptions

These tests are useful cleanup guides because they currently lock compatibility behavior in place.

Key files:
- `tests/e2e/model-endpoint-completeness.test.ts`
- `tests/component/supported-endpoints.test.ts`
- `tests/component/model-resolver.test.ts`
- `tests/e2e-ui/legacy-pages.pw.ts`

## Suggested Removal Order

1. Remove implicit legacy model endpoint fallback.
2. Re-evaluate whether upstream protocol downgrade logic should remain.

## Notes

- OpenAI-compatible and Anthropic-compatible route surfaces are not listed here as "backward compatibility".
  They are core product behavior, not historical shims.
- Generic error-message fallback logic is also intentionally excluded.
- Item `#1` is also an intentional design choice and should not be removed as part of compatibility cleanup.
- Item `#4` is intentionally retained.
- Items `#5` and `#7` have been removed.
