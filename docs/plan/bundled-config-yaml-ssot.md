# Bundle a default `config.yaml` as the configuration source of truth

## Context

Today the canonical defaults for every hot-reloadable setting live as hardcoded
constants in [src/lib/state.ts](src/lib/state.ts) (`CONFIG_MANAGED_DEFAULTS`,
`DEFAULT_MODEL_OVERRIDES`, `DEFAULT_MODEL_PREFERENCE`). The user-facing
`config.yaml` is read only from `~/.local/share/copilot-api/config.yaml` and is
allowed to be absent (`loadConfig()` returns `{}` in that case). The repository
ships a `config.example.yaml` purely as documentation — users must copy it
manually.

Goals:

1. Ship the project's recommended defaults as **real YAML**, not constants
   buried in TS, so users can read/diff/grep the source of truth.
2. The bundled YAML must be part of the npm package and resolvable at runtime
   (both from a published `dist/main.mjs` and from `bun run src/main.ts` dev).
3. User's personal `config.yaml` is a *sparse override file*: at startup and on
   every reload, the effective config = **bundled defaults deep-merged with
   user overrides** (user wins per key).
4. Reduce hardcoded defaults in `state.ts` to a minimal safety net — the YAML
   is the canonical source.

User-confirmed decisions:

- **Merge** strategy: bundled defaults + user overrides, user wins.
- **Location**: `/config.yaml` at the repo root (replaces `config.example.yaml`).
- **Migrate all** hardcoded defaults into the bundled YAML; code keeps only
  bare-minimum fallbacks (used only if the bundled YAML is unreadable, which
  should never happen in a healthy install).

## Hot-reload semantic change (intentional)

Today: missing key in user `config.yaml` → retain prior runtime value.
After:  missing key in user `config.yaml` → fall back to bundled default.

This is the natural consequence of "merge bundled + user". It's also more
intuitive: commenting out a line reverts to the project's recommended value
instead of freezing the last-applied state.

## Approach

### 1. Bundled YAML

- Rename `config.example.yaml` → `config.yaml` at repo root. This becomes the
  default config that ships with the npm package.
- Cull the comments-only sections so the file is a true config (defaults take
  effect even if user has no override file). Keep the documentation comments
  inline so it still doubles as a reference. Pre-existing `config.yaml` in the
  workspace (untracked) is unrelated and must not be touched.
- Update [package.json](package.json) `files` field: drop `config.example.yaml`,
  add `config.yaml`.

### 2. Resolving the bundled YAML at runtime

Add to [src/lib/config/paths.ts](src/lib/config/paths.ts):

```ts
import { fileURLToPath } from "node:url"

/** Bundled default config.yaml shipped inside the package. */
export const BUNDLED_CONFIG_YAML = fileURLToPath(
  new URL("../config.yaml", import.meta.url),
)
```

Resolution works in both modes because the relative offset from `src/main.ts`
to repo root, and from `dist/main.mjs` to package root, is identical (`..`).
Actually the file living next to `src/lib/config/paths.ts` is several levels
deep — we resolve from the bundle entry instead. **Concrete plan**: pass the
path in via a small helper that consults `process.argv[1]` / `import.meta.url`
of the **entry module**. Implementation detail: put the resolver in
`src/lib/config/bundled.ts` and import `import.meta.url` from `src/main.ts`
(or compute via `path.resolve(import.meta.dirname, "../../..", "config.yaml")`
which collapses correctly in both dev and dist). Pick whichever the executor
verifies works in both dev (`bun run src/main.ts`) and `node dist/main.mjs`.
Add a unit test that asserts the resolved path exists.

### 3. Loading: bundled + user merge

In [src/lib/config/config.ts](src/lib/config/config.ts):

- Add `loadBundledDefaultConfig(): Promise<Config>` — reads + parses + validates
  `BUNDLED_CONFIG_YAML`, cached forever (immutable on disk during process
  lifetime). On parse/validate failure, log error and return `{}` (safety net).
- Change `loadConfig()` to:
  1. load bundled (cached)
  2. load user file (existing mtime-cached path, returns `{}` if absent)
  3. deep-merge: user wins per key. For object maps (`model_overrides`,
     `efforts_overrides`, `strip_beta_headers`, `reject_body_fields`),
     **per-key shallow merge** (user keys add/replace, bundled keys without
     a user override remain). For array fields and `model_preference.<family>`,
     **whole-list replacement** by user. This matches today's semantics for
     user overrides and is the least surprising.
  4. return merged `Config`
- `loadRawConfigFile()` keeps its current behavior — returns the user file
  contents only, so the existing `/api/config/yaml` GET route still shows the
  user's overrides (not merged effective).
- Add `loadEffectiveConfig()` or expose merged via existing `loadConfig()` —
  decision: `loadConfig()` returns merged; `loadRawConfigFile()` returns user
  raw. The PUT route already uses `loadRawConfigFile()` for round-trip.

### 4. `applyConfigToState()` simplification

With merged config carrying all bundled defaults, the retain-on-absence guard
becomes redundant — every key is always present after merge. Replace each
`if (x !== undefined) setFoo(x)` with unconditional application. The
"reset to default" semantic is now naturally provided by reload (drop a key
from user yaml → next merge picks up the bundled value).

### 5. `state.ts` cleanup

- Reduce `CONFIG_MANAGED_DEFAULTS` to bare safety-net values used only for
  initial `mutableState` construction before the first `applyConfigToState()`.
  Use cheap zero-ish defaults (`false`, `0`, `""`, `[]`, `{}`) where possible;
  for the few values where startup-before-apply would misbehave with zero
  (e.g. timeouts of 0 = "no timeout"), pick conservative non-zero defaults
  and add a short comment that these are overwritten by bundled config before
  the server starts serving.
- Keep `DEFAULT_MODEL_OVERRIDES` and `DEFAULT_MODEL_PREFERENCE` exports for
  back-compat (some tests import them), but their *values* become identical to
  what the bundled YAML declares — extract via a small helper that re-derives
  from the parsed bundled config at module load (sync via lazy initializer
  invoked from `applyConfigToState`).
  - Simpler alternative we prefer: keep the constants but treat them as
    duplicated documentation; add a startup self-check in dev/test that
    `bundled === DEFAULT_MODEL_OVERRIDES` and warns on drift. Discuss with
    user if this hybrid is acceptable; otherwise delete the constants and fix
    every importer.
- `resetConfigManagedState()` keeps its name but its body becomes "apply
  bundled defaults only, ignoring user overrides" — used by the PUT route to
  guarantee a clean baseline before re-applying the merged config.

### 6. Start ordering

`start.ts` already calls `applyConfigToState()` early. Verify (executor) that
this happens **before** any request can be served and before transport
initialization, since now the bundled config sets the real timeouts, history
limits, etc. Document the ordering with a comment in `start.ts`.

### 7. Tests

- [tests/component/config-hot-reload.test.ts](tests/component/config-hot-reload.test.ts):
  the test matrix encodes "missing key → CONFIG_MANAGED_DEFAULTS" (R3 column).
  Rewrite the expected-default source from `CONFIG_MANAGED_DEFAULTS` to a
  fixture **test bundled config** injected via a setter exposed for tests
  (`_setBundledConfigForTests(config)`). Each table row keeps its three
  scenarios but the "after reset / after delete" expectation now comes from
  the test bundled fixture. The completeness guard test stays — it ensures
  every new field is covered.
- Add new tests:
  - `loadBundledDefaultConfig()` parses the shipped file without errors.
  - `loadConfig()` merge semantics: bundled-only, user-only, overlap,
    map-merge (model_overrides), array-replacement (disabled_models,
    model_preference.opus).
  - Bundled YAML JSON-schema validation: feed bundled config through
    `validateConfig()` and assert no warnings.
- [tests/http/config-yaml-routes.test.ts](tests/http/config-yaml-routes.test.ts)
  & [tests/unit/system-prompt-config-integration.test.ts](tests/unit/system-prompt-config-integration.test.ts):
  audit for assumptions that `loadConfig()` returns only user keys; update
  expectations or switch to `loadRawConfigFile()` where appropriate.

### 8. Documentation

- Update [README.md](README.md) and [docs/DESIGN.md](docs/DESIGN.md) sections
  that reference `config.example.yaml` to point to `config.yaml` and explain
  the merge model.
- Add a short "Configuration precedence" note: bundled defaults < user
  `~/.local/share/copilot-api/config.yaml` (key-level user wins; map values
  merged per-key; arrays replaced wholesale).

### 9. JSON-schema generator

[scripts/generate-config-json-schema.ts](scripts/generate-config-json-schema.ts)
is unaffected (schema unchanged) — verify run still succeeds.

## Files touched (representative)

- `config.example.yaml` → renamed to `config.yaml` (repo root)
- `package.json` (`files` field)
- `src/lib/config/paths.ts` (BUNDLED_CONFIG_YAML)
- `src/lib/config/config.ts` (loadBundledDefaultConfig, merge, simplified apply)
- `src/lib/state.ts` (slim CONFIG_MANAGED_DEFAULTS; reset semantics)
- `src/routes/config/route.ts` (verify GET /api/config/yaml still returns user raw, not merged)
- `tests/component/config-hot-reload.test.ts` (fixture-driven expected defaults)
- `tests/unit/system-prompt-config-integration.test.ts`, `tests/http/config-yaml-routes.test.ts` (audit)
- New: `tests/unit/config-merge.test.ts`, `tests/unit/bundled-config.test.ts`
- `README.md`, `docs/DESIGN.md`

## Verification

1. `bun run typecheck`
2. `bun run lint:all`
3. `bun test tests/unit tests/component tests/http` — full hot-reload matrix + new merge tests
4. Manual: `bun run src/main.ts start --help` (verify bundled config resolves in dev)
5. `npm pack --dry-run` — confirm `config.yaml` is in the tarball, `config.example.yaml` is not
6. After `npm run build`: `node dist/main.mjs --help` to confirm bundled path resolves from the built bundle
7. Spot-check: delete `~/.local/share/copilot-api/config.yaml`, start server, hit `GET /api/config` — values should reflect bundled defaults (e.g. `model_overrides.opus = claude-opus-4.7-1m-internal`, not the previous `claude-opus-4.6`)

## Open questions

- `DEFAULT_MODEL_OVERRIDES` / `DEFAULT_MODEL_PREFERENCE` export removal vs.
  keep-as-duplicate-with-drift-check (Section 5). Defer to executor if both
  are mechanically straightforward, otherwise ask user.
- Are there downstream packages or scripts importing these constants? Quick
  grep before deletion is mandatory.
