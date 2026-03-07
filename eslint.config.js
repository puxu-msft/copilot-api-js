import config from "@echristian/eslint-config"

export default [
  {
    ignores: [
      //
      "archive/**",
      "ui/**",
      "refs/**",
      "eslint.config.js",
      "tsdown.config.ts",
    ],
  },
  ...config({
    prettier: {
      printWidth: 120,
      plugins: ["prettier-plugin-packagejson"],
    },
  }),
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
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Tests use flexible typing for mock data and assertions
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Mock functions need async signatures to match interfaces without awaiting
      "@typescript-eslint/require-await": "off",
      // expect(mock.method).toHaveBeenCalled() is standard test assertion pattern
      "@typescript-eslint/unbound-method": "off",
      // bun:test expect().rejects returns a Promise — false positive from TS eslint
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      // Catch callbacks in tests often need specific types for assertions
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-callback-reference": "off",
    },
  },
]
