const prettierConfig = {
  // printWidth is prettier's ONLY line-wrap control and it's all-or-nothing:
  // too low force-wraps long strings/error-messages/comments (ugly — never
  // shorten wording to appease it, raise this instead); too high (e.g. 1000)
  // reverse-collapses existing multi-line code into one giant line (breaks lint
  // repo-wide). There is no "keep the author's line breaks" mode. 160 is the
  // chosen trade-off (raised from 120 on 2026-06-06, normalizing 176 files).
  printWidth: 160,
  semi: false,
  singleAttributePerLine: true,
  singleQuote: false,
  plugins: ["prettier-plugin-packagejson"],
}

export default prettierConfig
