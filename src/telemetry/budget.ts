import { loadConfig } from "../config/config.js";

/**
 * Budget ledger (forge-issue: budget ceilings with an exceed action).
 *
 * A per-process spend tracker fed by the telemetry install (each priced LLM call
 * records its USD cost) and read by the model router before issuing a call.
 * Keeps the router free of telemetry plumbing: the ledger is the only shared
 * contact point between cost accounting (telemetry) and spend gating (router).
 */

export interface LedgerState {
  spentUsd: number;
  /** Epoch ms of the most recent spend recorded (diagnostics). */
  lastSpendAt?: number;
}

let ledger: LedgerState = { spentUsd: 0 };

/** Current cumulative USD spend recorded this process. */
export function spentUsd(): number {
  return ledger.spentUsd;
}

/** Record a priced call's cost (best-effort; unpriced `null` costs are ignored). */
export function recordSpend(costUsd: number | null | undefined): void {
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd <= 0) return;
  ledger.spentUsd += costUsd;
  ledger.lastSpendAt = Date.now();
}

/** Reset the ledger (process lifecycle / tests). */
export function resetBudgetLedger(): void {
  ledger = { spentUsd: 0 };
}

/** The configured ceiling, or undefined when disabled (no ceiling set). */
export function ceilingUsd(): number | undefined {
  const max = loadConfig().budget?.maxUsdPerRun;
  return typeof max === "number" && max > 0 ? max : undefined;
}

/** True when the configured ceiling (if any) has been met or exceeded. */
export function budgetExceeded(): boolean {
  const max = ceilingUsd();
  return max !== undefined && ledger.spentUsd >= max;
}

/** Set the ledger to a known baseline (used when resuming a priced session). */
export function __setLedger(state: LedgerState): void {
  ledger = state;
}