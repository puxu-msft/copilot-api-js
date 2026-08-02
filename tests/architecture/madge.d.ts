/**
 * Minimal ambient typing for `madge`'s programmatic API — only the surface the
 * SCC ratchet guard uses. `madge` ships no bundled types and there is no
 * maintained `@types/madge`, so we declare just what we call.
 */
declare module "madge" {
  interface MadgeInstance {
    /**
     * Directed import cycles, each an ordered list of module paths.
     *
     * Paths are relative to the scanned root when there is ONE root, and relative to their common
     * ancestor when several are passed — so widening the roots changes every path in the snapshot and
     * the committed baseline has to be regenerated, not merged.
     */
    circular(): Array<Array<string>>
  }
  interface MadgeConfig {
    fileExtensions?: Array<string>
    tsConfig?: string
  }
  /** `entry` accepts one path or several — the guard scans `src/` plus every workspace package. */
  export default function madge(entry: string | Array<string>, config?: MadgeConfig): Promise<MadgeInstance>
}
