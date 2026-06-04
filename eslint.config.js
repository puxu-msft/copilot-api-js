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
      // Fixture / config JSON files — typescript-eslint parser rejects them
      // ("non-standard extension") and they need no linting in the first place.
      "tests/fixtures/**/*.json",
      "tests/e2e-ui/tsconfig.json",
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
    },
  },
)
