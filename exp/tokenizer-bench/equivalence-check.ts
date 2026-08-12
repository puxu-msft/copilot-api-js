const m = await import("gpt-tokenizer/encoding/o200k_base")
const raw = (t: string) => m.encode(t, { disallowedSpecial: new Set() }).length
const { collapseLongRuns, collapsibleTokens, learnBytesPerToken } = await import("../../src/lib/models/run-collapse.ts")

const ratios = new Map<string, number | undefined>()
const collapsed = (t: string) => {
  const { remainder, removedTokens } = collapseLongRuns(t, (run) => {
    if (!ratios.has(run.char)) ratios.set(run.char, learnBytesPerToken(run.char, raw))
    const bpt = ratios.get(run.char)
    return bpt === undefined ? { tokens: 0, chars: 0 } : collapsibleTokens(run.length, bpt)
  })
  return raw(remainder) + removedTokens
}

const cases: Array<[string, string]> = [
  ["纯空格 60KB", " ".repeat(60 * 1024)],
  ["纯空格 33333", " ".repeat(33333)],
  ["= 线 60KB", "=".repeat(60 * 1024)],
  ["a 60KB", "a".repeat(60 * 1024)],
  ["前后夹文本", "hello world " + " ".repeat(30000) + " goodbye world"],
  ["夹文本无空格", "hello world" + "=".repeat(30000) + "goodbye world"],
  ["多段游程", "abc" + "=".repeat(5000) + "def" + " ".repeat(9000) + "ghi" + "-".repeat(3000)],
  ["游程在开头", " ".repeat(9000) + "trailing text here"],
  ["游程在结尾", "leading text here" + " ".repeat(9000)],
  ["短游程不折叠", "x".repeat(100) + " tail"],
  ["制表符 40KB", "\t".repeat(40 * 1024)],
  ["换行 40KB", "\n".repeat(40 * 1024)],
  ["中文夹全角空格", "你好世界" + "　".repeat(8000) + "再见"],
]

let bad = 0
for (const [tag, text] of cases) {
  const a = raw(text)
  const b = collapsed(text)
  if (a !== b) bad++
  console.log(`${a === b ? "OK  " : "DIFF"} ${tag.padEnd(16)} raw=${String(a).padStart(6)}  collapsed=${String(b).padStart(6)}`)
}
console.log(bad === 0 ? "\n全部精确相等" : `\n${bad} 处不一致`)
