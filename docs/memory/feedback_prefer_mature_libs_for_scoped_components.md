---
name: feedback_prefer_mature_libs_for_scoped_components
description: "For well-scoped/algorithmic components, prefer a mature external library over hand-rolling"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a84ec520-05ff-4528-9150-52b84a2eec7e
---

When a component's scope is well-defined and the problem is a solved/algorithmic one (e.g. line+word/char text diff, parsing, date math), **prefer a mature external library over hand-rolling it**. Reserve custom code for the domain-specific parts a library cannot do.

**Why:** mature libs handle the hard edge cases (e.g. line-as-unit diff WITH intra-line word/char significance highlighting) far better than a quick hand-rolled LCS; hand-rolling well-trodden algorithms is a false economy that becomes a maintenance/quality liability.

**How to apply:** Split the design — external lib for the algorithmically-solved leaf; self-build only the domain layer the lib can't express. Concrete case in this repo: the UI block-diff engine uses `diff` (jsdiff) for L3 leaf line/word diff (`diffLines`/`diffWordsWithSpace`/`diffJson`), while L1/L2/L4 (message/block/SSE-frame alignment by role/type/offsetMs) are self-built because no generic diff lib can align our domain model. NOTE: drop only the rendering wrapper (`diff2html` → we render with our own theme), keep the algorithm core (`diff`).

Don't over-apply the "no third-party deps / build it ourselves" instinct — that instinct is right only for genuinely domain-specific or trivial code. Contrast with [[feedback_optimize_long_term_maintainability]] and [[feedback_complete_root_cause_fix]]: the most maintainable, complete solution often IS the battle-tested library.
