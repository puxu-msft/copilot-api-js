import config from "@echristian/eslint-config"

export default [
  {
    ignores: [
      //
      "src/ui/history-v1/**",
      "src/ui/history-v2/**",
      "refs/**",
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
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-callback-reference": "off",
    },
  },
]
