import config from "@echristian/eslint-config"
import { defineConfigWithVueTs } from "@vue/eslint-config-typescript"
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
)
