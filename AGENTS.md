# AGENTS.md

- **Always use the best, most complete solution.**
  Never take shortcuts or use workaround approaches. Always think deeply and choose the optimal implementation.
  - **Fix root causes, not symptoms.** Investigate why something doesn't work and fix the underlying mechanism, rather than adding workarounds or hardcoding fallback values.
  - **Prefer robust, maintainable solutions.** Even if a quick hack would work, choose the approach that is correct, complete, and future-proof.
  - **Lint serves readability, not the other way around.** If a lint rule doesn't improve readability, disable it rather than contorting the code to satisfy it.

- **Data flows in its richest form; presentation decisions belong to the final consumer.**
  Read-only consumers (TUI, History UI, metrics, etc.) must not require upstream data trimming. Data should be passed in its most complete structure at the point of production; consumers extract what they need.
  - **Producers must not make consumer decisions.** Handlers should not construct different data shapes for different consumers — they emit complete data once, and each consumer extracts from it.
  - **Single data source, multiple consumers.** One data structure serves all read-only systems (TUI, history, future metrics/webhooks), avoiding redundant construction of the same information.
  - **Names must reflect responsibilities.** Function names should accurately describe their actual behavior (e.g., accumulate vs process, collect vs transform) — no misleading names.
