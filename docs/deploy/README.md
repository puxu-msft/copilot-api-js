# Deployment templates

## `history-search.service`

systemd unit template for the **optional, independent** history-search sidecar
service (history-search-out-of-process plan). See the unit file's own header
comment for install steps and rationale.

Key facts:

- **Independent process, no parent/child relationship with the main server.**
  The main `copilot-api start` process never spawns, supervises, or restarts
  this service — it only holds a Unix-domain-socket client that queries it.
- **Optional.** Without this service running, the main server still works
  fully; full-text History search (`GET /history/api/search`) simply returns
  empty results (`partial: true`) instead of an error. `GET /api/status`'s
  `history_search` field reports whether the sidecar is currently reachable.
- **Zero-flag defaults.** `history-search-daemon` (the service's own citty
  sub-command) defaults its `--db`/`--socket`/`--index` args to the exact same
  `PATHS.HISTORY_V3_DB` / `PATHS.HISTORY_SEARCH_SOCKET` / `PATHS.
  HISTORY_SEARCH_DIR` constants the main process's UDS client reads — both
  sides derive the socket path from one shared source of truth
  (`src/lib/config/paths.ts`), so there is nothing to keep in sync between the
  two independently-started units.
- **Crash recovery is entirely systemd's job.** `Restart=on-failure` +
  `RestartSec=`/`StartLimitIntervalSec=`/`StartLimitBurst=` replace what an
  earlier (retired) design attempted to reimplement in-process (an exponential-
  backoff supervisor with its own crash-loop-abandon logic) — systemd already
  solves this well, visibly, and without adding a second process whose own
  death could itself need supervising.
