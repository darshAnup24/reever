import { loadConfig, type ModelSlot, type RoutingChainEntry, type RoutingConfig } from "../config/config.js";
import { isCriticalSystemError, isRateLimitError } from "../util/system-error.js";
import { isAbortError } from "../util/abort.js";
import { activeProviderId, getProvider } from "./registry.js";
import { resolveProviderSlot } from "../config/models.js";
import { budgetExceeded, spentUsd, ceilingUsd } from "../telemetry/budget.js";
import type { AssistantMessage, StreamAssistantFn, StreamAssistantOptions } from "./types.js";
import type { Message } from "../types.js";

/**
 * Model router (forge-issue: per-task-type provider chains with failover).
 *
 * Reever historically resolved one active provider and a single model per slot.
 * This module lets a routing profile pin each model slot to an ordered list of
 * `{ provider, model }` candidates. The router tries candidates in priority
 * order and fails over to the next retryable provider on transient failures
 * (rate limit, 5xx) rather than surfacing the raw error to the loop. A circuit
 * breaker per provider halts repeated attempts against a dying backend instead
 * of hammering it (the loop's existing rate-limit retry on *tool* calls is a
 * different mechanism — this one covers *LLM* calls).
 *
 * Non-retryable failures (auth, billing, malformed requests) abort failover:
 * the agent should be told the request is genuinely bad, not routed around it.
 */

/** A fully-resolved chain candidate (provider id + concrete model id). */
export interface ResolvedCandidate {
  providerId: string;
  model: string;
  priority: number;
}

export interface CircuitState {
  /** Consecutive retryable failures seen for the provider. */
  failures: number;
  /** Epoch ms until the circuit is half-open again. 0 = closed. */
  openUntil: number;
}

/**
 * Per-provider circuit breaker. Purely in-memory (per process); deliberately
 * not persisted — a restarting process should not inherit a stale open state
 * for a network glitch that has since cleared.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<string, CircuitState>();
  constructor(
    public readonly failureThreshold: number,
    public readonly cooldownSeconds: number,
  ) {}

  state(providerId: string): CircuitState {
    let state = this.circuits.get(providerId);
    if (!state) {
      state = { failures: 0, openUntil: 0 };
      this.circuits.set(providerId, state);
    }
    return state;
  }

  /** True when the provider is tripped (open/half-open window active). */
  isOpen(providerId: string): boolean {
    const state = this.state(providerId);
    return state.openUntil > Date.now();
  }

  recordFailure(providerId: string): void {
    const state = this.state(providerId);
    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.failures = 0;
      state.openUntil = Date.now() + this.cooldownSeconds * 1000;
    }
  }

  recordSuccess(providerId: string): void {
    this.state(providerId).failures = 0;
  }

  /** Expose the full state map (diagnostics/summaries). */
  snapshot(): Record<string, CircuitState> {
    return Object.fromEntries(this.circuits);
  }
}

let breakerInstance: CircuitBreaker | undefined;

/** Circuit breaker bound to the loaded routing config (rebuilt on reload). */
export function circuitBreaker(): CircuitBreaker {
  const cfg = loadConfig().routing;
  if (
    !breakerInstance ||
    breakerInstance.failureThreshold !== cfg?.circuitBreaker.failureThreshold ||
    breakerInstance.cooldownSeconds !== cfg?.circuitBreaker.cooldownSeconds
  ) {
    breakerInstance = new CircuitBreaker(
      cfg?.circuitBreaker.failureThreshold ?? 3,
      cfg?.circuitBreaker.cooldownSeconds ?? 120,
    );
  }
  return breakerInstance;
}

const MODEL_SLOTS: ModelSlot[] = [
  "main",
  "explore",
  "review",
  "implement",
  "delegate_read",
  "compaction",
];

/** Map a model id to the slot that resolves to it for the active provider. */
export function slotForModel(model: string): ModelSlot {
  const active = activeProviderId();
  for (const slot of MODEL_SLOTS) {
    if (resolveProviderSlot(active, slot) === model) return slot;
  }
  return "main";
}

/** Resolve the routing profile chain for a slot, falling back to the active provider. */
export function chainForSlot(slot: ModelSlot, model: string): RoutingChainEntry[] {
  const cfg = loadConfig().routing;
  const profile = cfg?.profiles?.[cfg?.profile ?? "balanced"]?.taskRoutes?.[slot];
  if (profile && profile.length > 0) {
    return filterChain(profile);
  }
  // No chain for this slot (or routing disabled): the historical behaviour —
  // the active provider, either with the requested model or its slot default.
  return [{
    provider: activeProviderId(),
    model,
    priority: 1,
  }];
}

/** Drop chain entries for providers that are unregistered or unconfigured. */
function filterChain(chain: RoutingChainEntry[]): RoutingChainEntry[] {
  const seen = new Set<string>();
  const result: RoutingChainEntry[] = [];
  for (const entry of chain) {
    const provider = getProvider(entry.provider);
    if (!provider || !provider.isConfigured()) continue;
    const sig = `${entry.provider}|${entry.model ?? ""}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push({ ...entry, model: entry.model ?? undefined });
  }
  return result;
}

export function resolveCandidates(
  slot: ModelSlot,
  model: string,
  budgetExceeded = false,
): ResolvedCandidate[] {
  const chain = chainForSlot(slot, model);
  const candidates = chain
    .sort((a, b) => a.priority - b.priority)
    .map((entry) => ({
      providerId: entry.provider,
      model: entry.model ?? resolveProviderSlot(entry.provider, slot),
      priority: entry.priority,
    }));

  if (!budgetExceeded) return candidates;

  // Budget "downgrade_model" action: skip the primary (priority 1) candidate
  // and use the cheaper fallbacks; the "abort" action is handled by the caller.
  const fallbacks = candidates.filter((c) => c.priority > 1);
  return fallbacks.length > 0 ? fallbacks : candidates;
}

/**
 * Whether a stream failure should trigger failover to the next chain candidate.
 * Rate limits and 5xx are transient — retry against the next provider. Auth and
 * billing failures (401/402/403) and critical system errors are not retryable
 * over the network; surface the error to the caller instead.
 */
export function isRetryableFailure(err: unknown): boolean {
  if (isCriticalSystemError(err)) return false;
  if (isRateLimitError(err)) return true;
  return hasHttp5xx(err);
}

function hasHttp5xx(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const status = (current as { status?: unknown; statusCode?: unknown }).status
        ?? (current as { statusCode?: unknown }).statusCode;
      if (typeof status === "number" && status >= 500 && status < 600) return true;
    }
    current = current instanceof Error && "cause" in current
      ? (current as Error & { cause?: unknown }).cause
      : undefined;
  }
  return false;
}

/**
 * Raised when the budget ledger exceeds the RunBudget ceiling and the
 * configured action is `abort`. The agent loop treats this as a session-ending
 * condition: a prompt instead of a generic failure.
 */
export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsdValue: number,
    public readonly ceilingUsdValue: number,
  ) {
    super(
      `Run budget exceeded — spent $${spentUsdValue.toFixed(4)} of the $${ceilingUsdValue.toFixed(4)} ceiling. `
      + `Raise "budget.maxUsdPerRun" or clear the ledger to continue.`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Wrap the base stream function with budget gating + model routing + failover +
 * circuit breaking. Runs even when routing is disabled so the budget ceiling
 * still applies; the routing resolution just falls back to the single active
 * provider in that case (zero behavioural drift — same call, same model).
 */
export function routeStreamAssistant(fn: StreamAssistantFn): StreamAssistantFn {
  return async function routedStream(
    messages: Message[],
    options: StreamAssistantOptions,
    emit,
  ): Promise<AssistantMessage> {
    const cfg = loadConfig().routing;
    const breaker = circuitBreaker();
    const exceeded = budgetExceeded();
    if (exceeded) {
      const action = loadConfig().budget?.actionOnExceed ?? "abort";
      if (action === "abort") {
        throw new BudgetExceededError(spentUsd(), ceilingUsd() ?? 0);
      }
      // downgrade_model: skip the primary candidate, allow cheaper fallbacks.
    }

    const slot = slotForModel(options.model);
    const candidates = resolveCandidates(slot, options.model, exceeded);
    let lastError: unknown;

    for (const candidate of candidates) {
      if (breaker.isOpen(candidate.providerId)) {
        continue;
      }

      try {
        const attempts = (cfg?.retryAttempts ?? 0) + 1;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          try {
            const message = await fn(messages, {
              ...options,
              model: candidate.model,
              providerId: candidate.providerId,
            }, emit);
            breaker.recordSuccess(candidate.providerId);
            return message;
          } catch (err) {
            if (isAbortErrorLike(err)) throw err;
            if (!isRetryableFailure(err) || attempt >= attempts - 1) throw err;
            await sleep((cfg?.backoffMs ?? 1_000) * 2 ** attempt);
          }
        }
      } catch (err) {
        if (isAbortErrorLike(err)) throw err;
        breaker.recordFailure(candidate.providerId);
        lastError = err;
        // Auth/billing errors and budget aborts are not retryable — do not
        // silently route around a genuinely bad request.
        if (!isRetryableFailure(err)) break;
      }
    }

    if (lastError !== undefined) throw lastError;
    throw new Error(
      `All providers in the routing chain for slot "${slot}" are unavailable or in a cooldown window.`,
    );
  };
}

function isAbortErrorLike(err: unknown): boolean {
  return isAbortError(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort: expose the resolver for `/providers test`-style diagnostics later. */
export function routingDiagnostics(cfg?: RoutingConfig) {
  const config = cfg ?? loadConfig().routing;
  return {
    enabled: config?.enabled === true,
    profile: config?.profile,
    breaker: breakerInstance?.snapshot() ?? {},
  };
}