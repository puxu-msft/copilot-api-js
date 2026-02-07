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
    },
  },
]
