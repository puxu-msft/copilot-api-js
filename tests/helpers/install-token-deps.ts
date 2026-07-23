/**
 * Bun test preload — install the token domain's ambient ports (fetch / paths /
 * config) so the token package's free HTTP functions (`getCopilotToken`,
 * `getGitHubUser`, `getDeviceCode`, …) resolve their transport in EVERY test,
 * including files that use only `autoRestoreFetch` and never assemble a runtime.
 *
 * Ordered AFTER `sandbox-paths.ts` in `bunfig.toml [test].preload` so
 * `XDG_DATA_HOME` is already redirected before `PATHS` is (lazily) read. The
 * installed `fetch` port is a thin adapter over the live `upstreamFetch`
 * indirection, so the existing mock harness (`setFetchMock` /
 * `setUpstreamFetchForTests` / the isolated-fixture network guard) keeps
 * flowing through unchanged. The ports are stateless adapters — install once,
 * never reset (the per-test reset is the runtime SINGLETON, see
 * `resetTokenRuntimeForTests` in the RESETTERS table).
 */

import { installDefaultTokenDeps } from "../../src/lib/token-runtime"

installDefaultTokenDeps()
