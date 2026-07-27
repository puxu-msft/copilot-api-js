/**
 * Bun test preload — install the telemetry domain's ambient ports (paths / live config view /
 * config-change subscription) so the request-telemetry registry resolves its configuration in
 * EVERY test, including the many that drive it directly through
 * `~/lib/telemetry-testing` and never assemble a runtime.
 *
 * Ordered AFTER `sandbox-paths.ts` in `bunfig.toml [test].preload` so `XDG_DATA_HOME` is already
 * redirected before `PATHS` is read — the telemetry db + legacy-JSON paths must land in the temp
 * sandbox, never in the real `~/.local/share/copilot-api`.
 *
 * The installed config view is a stateless LIVE adapter over `state.telemetry*`, so the existing
 * `setStateForTests({ telemetryEnabled, telemetryDbPath, … })` harness keeps flowing through
 * unchanged (telemetry config stays core-owned — there is no SoT reversal here, unlike token).
 * Install once, never reset; the per-test reset is the runtime SINGLETON
 * (`resetTelemetryRuntimeForTests`) plus the registry's module-local state
 * (`_resetRequestTelemetryForTests`), both in the RESETTERS table.
 */

import { installDefaultTelemetryDeps } from "../../src/lib/telemetry-assembly"

installDefaultTelemetryDeps()
