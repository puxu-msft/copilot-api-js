/**
 * Bidirectional thinking-shape coercion primitives.
 *
 * GHC / Anthropic express "thinking" in two mutually-exclusive shapes:
 *   - enabled:  `{ type: "enabled", budget_tokens }`   — budget-based (e.g. haiku, sonnet)
 *   - adaptive: `{ type: "adaptive" }` + `output_config.effort` — adaptive-only (opus 4.6/4.7/4.8)
 *
 * A model accepts exactly ONE of these; sending the wrong shape is a hard 400.
 * This leaf module owns the two conversions between them so the prepare-time
 * transforms (request-preparation.ts) and the reactive retry strategies
 * (legacy-thinking-retry / adaptive-thinking-rejection-retry) share one
 * definition and cannot drift:
 *
 *   enabled → adaptive : budgetToEffort   (coerceAdaptiveThinking + legacy-thinking-retry)
 *   adaptive → enabled : effortToBudget   (coerceEnabledThinking  + adaptive-thinking-rejection-retry)
 *
 * `budget_tokens` synthesized here is a STARTING point; the caller's
 * adjustThinkingBudget clamps it to the model's min/max window and below
 * max_tokens, so the concrete constants only set the intensity tier.
 */

/**
 * Heuristic mapping from a legacy `budget_tokens` to an effort level.
 *
 * GHC does NOT derive effort from budget (the two are independent dimensions);
 * this is a copilot-api enhancement to preserve the "thinking intensity" intent
 * of old clients that only had `budget_tokens` to express it. Thresholds carry
 * no semantic guarantee — they are an opt-in best effort (config
 * `anthropic.thinking_coerce_adaptive: best_effort`).
 *
 * Only low/medium/high are produced (GHC's construction side accepts only these
 * three); clampEffortLevel later fits the value to the model's actual whitelist.
 */
const EFFORT_BUDGET_THRESHOLDS = [
  { maxBudget: 8_192, effort: "low" },
  { maxBudget: 24_576, effort: "medium" },
] as const

export function budgetToEffort(budget?: number): "low" | "medium" | "high" | undefined {
  if (typeof budget !== "number" || budget <= 0) return undefined
  for (const threshold of EFFORT_BUDGET_THRESHOLDS) {
    if (budget <= threshold.maxBudget) return threshold.effort
  }
  return "high"
}

/**
 * Inverse of {@link budgetToEffort}: map an adaptive `effort` back to a concrete
 * `budget_tokens` for models that only accept the enabled thinking shape.
 *
 * The value is deliberately near the TOP of each tier's threshold band (so a
 * round-trip enabled→adaptive→enabled does not collapse intensity), but the
 * exact number does not matter much: adjustThinkingBudget clamps it to the
 * model's window afterward. An absent/unknown effort defaults to `medium` so a
 * client that turned thinking ON (via `adaptive`) keeps thinking ON after the
 * downgrade — never silently disabled.
 */
const EFFORT_BUDGETS = { low: 8_192, medium: 24_576, high: 32_768 } as const

export function effortToBudget(effort?: string): number {
  if (effort === "low") return EFFORT_BUDGETS.low
  if (effort === "high") return EFFORT_BUDGETS.high
  return EFFORT_BUDGETS.medium
}

/** The enabled thinking shape produced when downgrading from `adaptive`. */
export interface EnabledThinking {
  type: "enabled"
  budget_tokens: number
  display?: string
}

/**
 * Build the enabled-thinking config that replaces `{ type: "adaptive" }` when
 * routing to a model that only accepts budget-based thinking.
 *
 * @param effort  the adaptive intensity (from `output_config.effort`), folded
 *                into `budget_tokens` via {@link effortToBudget}.
 * @param display preserved for multi-turn thinking-signature continuity.
 */
export function adaptiveToEnabledThinking(effort?: string, display?: string | null): EnabledThinking {
  return {
    type: "enabled",
    budget_tokens: effortToBudget(effort),
    ...(display ? { display } : {}),
  }
}
