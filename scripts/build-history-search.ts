import {
  //
  copyFileSync,
  mkdirSync,
} from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const crate = path.join(root, "native", "history-search")
const manifest = path.join(crate, "Cargo.toml")
const result = Bun.spawnSync(["cargo", "build", "--release", "--locked", "--manifest-path", manifest], {
  cwd: root,
  stderr: "inherit",
  stdout: "inherit",
})
if (result.exitCode !== 0) process.exit(result.exitCode)

let libraryName = "libcopilot_history_search.so"
if (process.platform === "win32") libraryName = "copilot_history_search.dll"
else if (process.platform === "darwin") libraryName = "libcopilot_history_search.dylib"
const source = path.join(crate, "target", "release", libraryName)
const developmentTarget = path.join(crate, "copilot_history_search.node")
const distributionTarget = path.join(root, "dist", "history-search.node")
mkdirSync(path.dirname(distributionTarget), { recursive: true })
copyFileSync(source, developmentTarget)
copyFileSync(source, distributionTarget)
console.log(`[history-search] built ${path.relative(root, distributionTarget)}`)
