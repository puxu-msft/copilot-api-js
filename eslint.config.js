import config from "@echristian/eslint-config"

export default [
  {
    ignores: [
      //
      "src/routes/history/ui-v2/**",
      "src/routes/history/ui/**",
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
