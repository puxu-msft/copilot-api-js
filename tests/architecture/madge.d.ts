/**
 * Minimal ambient typing for `madge`'s programmatic API — only the surface the
 * SCC ratchet guard uses. `madge` ships no bundled types and there is no
 * maintained `@types/madge`, so we declare just what we call.
 */
declare module "madge" {
  interface MadgeInstance {
    /** Directed import cycles, each an ordered list of module paths (relative to the scanned root). */
    circular(): Array<Array<string>>
  }
  interface MadgeConfig {
    fileExtensions?: Array<string>
    tsConfig?: string
  }
  export default function madge(entry: string, config?: MadgeConfig): Promise<MadgeInstance>
}
