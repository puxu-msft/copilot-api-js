import { readFileSync, writeFileSync } from "node:fs"

const [inputPath, maxLenArg] = process.argv.slice(2)

if (!inputPath) {
  console.error("Usage: node truncate-content.mjs <file> [maxLength]")
  process.exit(1)
}

const maxLen = Number(maxLenArg) || 200

const data = JSON.parse(readFileSync(inputPath, "utf8"))

for (const item of data.content) {
  for (const key of ["content", "text"]) {
    if (typeof item[key] === "string" && item[key].length > maxLen) {
      item[key] = item[key].slice(0, maxLen) + "..."
    }
  }
}

writeFileSync(inputPath, JSON.stringify(data, null, 2) + "\n")
console.log(`Done. Truncated content fields to ${maxLen} chars in ${inputPath}`)
