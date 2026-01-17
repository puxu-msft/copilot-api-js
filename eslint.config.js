import config from "@echristian/eslint-config"

export default [
  ...config({
    prettier: {
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
    },
  },
]
