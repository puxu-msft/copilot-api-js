import config from "@echristian/eslint-config"
import { defineConfigWithVueTs } from "@vue/eslint-config-typescript"
import jsxA11y from "eslint-plugin-jsx-a11y"
import reactHooks from "eslint-plugin-react-hooks"
import pluginVue from "eslint-plugin-vue"
import tseslint from "typescript-eslint"
import vueParser from "vue-eslint-parser"
import localPlugin from "./scripts/eslint-rules/import-marker.js"
import prettierConfig from "./prettier.config.mjs"

const disableTypescriptRulesForJson = Object.fromEntries(
  Object.keys(tseslint.plugin.rules).map((ruleName) => [`@typescript-eslint/${ruleName}`, "off"]),
)

export default defineConfigWithVueTs(
  pluginVue.configs["flat/essential"],
  {
    ignores: [
      //
      "archive/**",
      "refs/**",
      "ui/**/dist/**",
      "eslint.config.js",
      "tsdown.config.ts",
      "playwright.config.ts",
      "prettier.config.mjs",
      // Local debug probe scripts at repo root (not in tsconfig project graph).
      "mutation-probe.mjs",
      "probe-loopback-baseline.mjs",
      // Experiment / probe scratch dir — not in the tsconfig project graph, so
      // typed linting can only emit "not found by the project service" parse
      // errors. Experiments are intentionally throwaway (see exp/ convention).
      "exp/**",
      // Local ESLint rule sources — not part of the TS project graph.
      "scripts/eslint-rules/**",
      // Generated declaration files — not in tsconfig either.
      "ui/types/**/*.d.ts",
      // Fixture / config JSON files — typescript-eslint parser rejects them
      // ("non-standard extension") and they need no linting in the first place.
      "**/*.json",
      "**/*.jsonc",
    ],
  },
  ...config({
    prettier: prettierConfig,
  }),
  {
    files: ["ui/**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: [".vue"],
      },
    },
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "vue/multi-word-component-names": "off",
    },
  },
  {
    files: ["**/*.json", "**/*.jsonc", "**/package.json", "**/package-lock.json"],
    rules: disableTypescriptRulesForJson,
  },
  {
    plugins: {
      local: localPlugin,
    },
    rules: {
      // Force imports with >1 specifier to break across lines, with a `{ //`
      // marker so Prettier doesn't fold them back. See the rule source for
      // details.
      "local/multiline-imports": "error",
    },
  },
  {
    rules: {
      // Disable overly restrictive code structure rules
      "max-lines-per-function": "off",
      "max-params": "off",
      "max-depth": "off",
      complexity: "off",
      "max-lines": "off",
      // High false-positive rate in sequential async loops (for-of with await)
      "require-atomic-updates": "off",
      // Redundant with TypeScript — TS compiler handles unused property detection
      "unicorn/no-unused-properties": "off",
      // Intentional pattern: helper functions scoped inside their parent function
      "unicorn/consistent-function-scoping": "off",
      // Conflicts with TypeScript: removing encoding from readFileSync returns Buffer,
      // breaking JSON.parse(string) and other string consumers
      "unicorn/prefer-json-parse-buffer": "off",
      // Ternary is not always more readable than if/else — let developers choose
      "unicorn/prefer-ternary": "off",
      // API proxy handles dynamic JSON payloads extensively — runtime type guards
      // add noise without value when upstream types are already defined
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/await-thenable": "off",
      // Project prefers async/await framing even when a body has no await —
      // keeps signatures uniform and future-proof if the impl later awaits.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // Test files legitimately use `as any` for fixtures, `!` for narrowing
    // known-good test data, and mocks that don't need the same strictness
    // as production code. Mirrors the same relaxations applied to ui/**/*.vue.
    files: ["**/*.test.ts", "**/*.test.js", "tests/**/*.ts", "ui/tests/**/*.ts", "ui/vitest/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "@typescript-eslint/no-unnecessary-type-conversion": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-deprecated": "off",
      "unicorn/no-array-callback-reference": "off",
      "no-nested-ternary": "off",
      "no-useless-assignment": "off",
    },
  },

  // ── React hooks + a11y lints, scoped to the ui-v4 React frontend ──
  //
  // The base preset ships eslint-plugin-react-hooks + eslint-plugin-jsx-a11y but
  // leaves them off. Wire their recommended rules for ui-v4 ONLY (glob-limited so
  // the legacy Vue `ui/` and the backend aren't dragged in — enabling repo-wide
  // would surface a batch of pre-existing warnings needing separate cleanup).
  // rules-of-hooks/exhaustive-deps catch dependency-array + conditional-hook bugs;
  // jsx-a11y recommended catches accessibility regressions.
  {
    files: ["ui-v4/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },

  // ── Observability subsystem dependency direction (RFC docs/rfc/observability-rewrite.md §2.2) ──
  //
  // Low-level subsystems mutate RequestContext and emit via injected scoped
  // publishers received by DI; they never reach into the observability
  // surface. Route handlers mutate ctx exclusively; sinks are off-limits.
  // Sinks may not import each other. Only src/start.ts may construct the
  // bus or mint scoped publishers (enforced by allow-list comment, not
  // ESLint, since the patterns below already cover the access points).
  //
  // Notes:
  // - `lib/context/*` is intentionally exempt — it owns the
  //   `ScopedPublisher<"request">` injection point.
  // - `lib/history/*` is exempt for the same reason (owns
  //   `ScopedPublisher<"history">`).
  // - `lib/shutdown.ts` and `lib/adaptive-rate-limiter.ts` are exempt for
  //   `ScopedPublisher<"system">`.
  {
    files: ["src/lib/request/**/*.ts", "src/lib/anthropic/**/*.ts", "src/lib/openai/**/*.ts", "src/lib/gemini/**/*.ts", "src/lib/ws/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/observability", "~/lib/observability/*"],
              message:
                "Low-level subsystems must not import ~/lib/observability/*. Mutate the injected RequestContext or accept a ScopedPublisher via DI — see RFC docs/rfc/observability-rewrite.md §2.2.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/routes/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/observability/sinks", "~/lib/observability/sinks/*", "~/lib/observability/bus"],
              message:
                "Route handlers must mutate RequestContext exclusively — sinks and the bus are off-limits. Re-introducing direct route→sink calls would resurrect debt D2.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/observability/sinks/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/observability/sinks/*"],
              message:
                "Sinks must not import each other — cross-sink coupling must go through bus events. See RFC docs/rfc/observability-rewrite.md §2.2.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/tui/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/observability/sinks", "~/lib/observability/sinks/*"],
              message:
                "tui/ must not import other sinks — subscribe to the bus (like FileSink). See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
          ],
        },
      ],
    },
  },

  // ── P1 TUI internal layer boundaries (ADR docs/decisions/2026-07-10-tui-terminal-ownership.md) ──
  //
  // The tui subsystem is a set of pure leaves with a strict, one-directional
  // dependency graph so each stays unit-testable without a terminal:
  //   render/*        — presentation builders (no input, no control flow)
  //   input/*         — Buffer→KeyEvent parsing (no rendering, no control flow)
  //   controller.ts   — pure reducer (depends only on the KeyEvent *type*)
  //   terminal-ui.ts  — the integration OWNER that wires all leaves + drives the
  //                     raw-mode lifecycle; intentionally NOT constrained below
  //                     (it is the orchestration layer, allowed to import any leaf).
  //
  // These blocks use @typescript-eslint/no-restricted-imports (a distinct rule
  // id from the core `no-restricted-imports` sink guard above) so both fire
  // together: the tui-wide sink ban still covers every tui file, and the ts
  // variant's per-group `allowTypeImports` lets the controller keep its
  // `import type { KeyEvent }` while runtime input/render imports stay banned.
  // Patterns cover both the `~/lib/tui/*` alias form and the relative form used
  // by the actual sources (`./`, `../`).
  {
    files: ["src/lib/tui/render/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/tui/input", "~/lib/tui/input/*", "../input", "../input/*"],
              message:
                "render/ builds presentation only — it must not import input/ (key parsing). See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
            {
              group: ["~/lib/tui/controller", "../controller"],
              message:
                "render/ must not import the controller (reducer) — presentation is downstream of state, wired by terminal-ui.ts. See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/tui/input/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/tui/render", "~/lib/tui/render/*", "../render", "../render/*"],
              message:
                "input/ parses keys only — it must not import render/ (presentation). See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
            {
              group: ["~/lib/tui/controller", "../controller"],
              message:
                "input/ must not import the controller (reducer) — key parsing is upstream of state, wired by terminal-ui.ts. See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/lib/tui/controller.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["~/lib/tui/render", "~/lib/tui/render/*", "./render", "./render/*"],
              message:
                "controller is a pure reducer — it must not import render/ (presentation). See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
            {
              // Runtime imports from input/ are banned; the KeyEvent *type* is
              // permitted via allowTypeImports — the reducer keys off the
              // KeyEvent shape, never the parser implementation.
              group: ["~/lib/tui/input", "~/lib/tui/input/*", "./input", "./input/*"],
              allowTypeImports: true,
              message:
                "controller may depend only on the KeyEvent *type* from input/ (use `import type`) — never the parser implementation. See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
          ],
        },
      ],
    },
  },
  // ── P2 terminal-coordinator purity (ADR docs/decisions/2026-07-10-tui-terminal-ownership.md) ──
  //
  // `terminal-coordinator.ts` is a module-level singleton that observability
  // (`republish.ts`, `sinks/file.ts`) and `terminal-ui.ts` import — never the
  // reverse. It must stay a pure leaf with zero imports from any other tui/
  // internal (render/, input/, controller.ts, terminal-ui.ts) or from
  // `~/lib/observability/*` (broader than the tui-wide sinks-only ban above),
  // so wiring it back into either can never create the cycle the ADR forbids.
  // Mirrors `tests/tui/layer-boundaries.unit.test.ts`'s coordinator-purity
  // guard — ESLint catches it at edit time, the test formalizes it structurally.
  {
    files: ["src/lib/tui/terminal-coordinator.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "~/lib/tui/render",
                "~/lib/tui/render/*",
                "~/lib/tui/input",
                "~/lib/tui/input/*",
                "~/lib/tui/controller",
                "~/lib/tui/terminal-ui",
                "./render",
                "./render/*",
                "./input",
                "./input/*",
                "./controller",
                "./terminal-ui",
              ],
              message:
                "terminal-coordinator is a pure leaf — it must not import any other tui/ internal (render/, input/, controller, terminal-ui). Observability/terminal-ui import the coordinator, never the reverse. See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
            {
              group: ["~/lib/observability", "~/lib/observability/*"],
              message:
                "terminal-coordinator is a pure leaf — it must not import ~/lib/observability/* (broader than the tui-wide sinks-only ban). See ADR docs/decisions/2026-07-10-tui-terminal-ownership.md.",
            },
          ],
        },
      ],
    },
  },
  // ── Monorepo layer boundary: foundation is a leaf package ──
  // (spec docs/spec/2026-07-22-monorepo-workspace-split.md §4/§6)
  // foundation source may import ONLY foundation-internal modules via relative
  // `./` paths, or bare external packages. It must never import a sibling
  // workspace package, nor use the `~/` root alias at all (which resolves into
  // the app/core tree). Mirrors tests/architecture/package-boundaries.unit.test.ts.
  {
    files: ["packages/foundation/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@hsupu/ghc-proxy-core",
                "@hsupu/ghc-proxy-core/*",
                "@hsupu/ghc-proxy-server",
                "@hsupu/ghc-proxy-server/*",
                "@hsupu/ghc-proxy-cli",
                "@hsupu/ghc-proxy-cli/*",
                "~/*",
              ],
              message:
                "foundation is a leaf package: import only foundation-internal modules via relative `./` paths, or bare external packages. No sibling workspace packages, no `~/` alias. See spec §4.",
            },
          ],
        },
      ],
    },
  },
  // ── Monorepo layer boundary: core/server must NOT import the cli package ──
  // cli is the DAG top (cli → core/server is legal); this guards the reverse.
  // Covers the eventual package name and the transitional `~/<clifile>` alias.
  // (Mirrors the "core/server source never imports the cli package" test.)
  // Uses @typescript-eslint/no-restricted-imports (distinct rule id) so it
  // COEXISTS with the core `no-restricted-imports` blocks already targeting
  // src/lib/** and src/routes/** (flat-config replaces, not merges, same-id
  // rule options — see the tui blocks above for the same technique).
  {
    files: ["src/lib/**/*.ts", "src/routes/**/*.ts", "src/server.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@hsupu/ghc-proxy-cli",
                "@hsupu/ghc-proxy-cli/*",
                "~/main",
                "~/auth",
                "~/debug",
                "~/logout",
                "~/list-claude-code",
                "~/setup-claude-code",
                "~/setup-codex",
                "~/start",
              ],
              message:
                "core/server is below cli in the layer DAG — it must never import cli entry/command files. See spec §3.1/§4.",
            },
          ],
        },
      ],
    },
  },
)
