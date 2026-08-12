import type { Message } from "../types.js";
import { estimateMessageTokens } from "../agent/compaction.js";

/**
 * "Tokens saved" metric — the honest framing.
 *
 * Reever prunes history (tool-result elision, stale-result eviction, and
 * compaction summarisation) so each subsequent LLM call re-sends a smaller
 * context. The naive baseline is unambiguous: **the estimated tokens of the
 * context as it existed before pruning**. That is what a no-context-management
 * agent would re-send on the next turn. The saving is the delta produced by the
 * pruning step, accumulated per event.
 *
 * Formula (documented, do not change silently):
 *
 *   naiveBaseline(turn) = estimateProviderContextTokens(pre-prune messages, overhead)
 *   tokensSent(turn)    = usage.input (from the provider, in telemetry)
 *   saved(turn)         = max(0, naiveBaseline(turn) - tokensSent(turn))
 *
 * We accumulate `saved(turn)` across the session and expose it on the session
 * summary as `tokensSaved`. Estmates are character-based (chars/3.5, see
 * `compaction.ts`); they are proportional, not tokenizer-exact, and the metric
 * is labelled accordingly.
 */

/** Estimated tokens the pruning step removed from the next call's context. */
export function estimateTokensRemovedByPruning(pre: Message[], post: Message[]): number {
  return Math.max(0, estimateMessageTokens(pre) - estimateMessageTokens(post));
}

let savedTokens = 0;

/** Estimated tokens this process avoided re-sending thanks to context pruning. */
/** Estimated tokens this process avoided re-sending thanks to context pruning. */
export function tokensSavedEstimated(): number {
  return savedTokens;
}

/** Add a measured saving (from a compaction / eviction boundary). */
export function recordTokensSaved(estimatedTokens: number): void {
  if (typeof estimatedTokens !== "number" || !Number.isFinite(estimatedTokens)) return;
  savedTokens += Math.max(0, estimatedTokens);
}

/** Reset the counter (process lifecycle / tests). */
export function resetTokensSaved(): void {
  savedTokens = 0;
}