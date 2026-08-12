import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import type { LanguageModel } from "ai";
import type { Message } from "../types.js";
import { CircuitBreaker } from "./router.js";
import type { Provider } from "./types.js";
import type { AssistantMessage, StreamAssistantFn } from "./types.js";

const sentinelModel = { id: "sentinel" } as unknown as LanguageModel;

function makeFakeProvider(id: string, configured = true): Provider {
  return {
    id,
    displayName: id,
    authStrategy: "api-key",
    isConfigured: () => configured,
    normalizeModelId: (modelId) => modelId,
    languageModel: () => sentinelModel,
    metadata: {
      id,
      supportsModel: () => true,
      getContextWindow: async () => 4242,
      listModelIds: async () => [],
    },
    pickerModels: [],
    defaultSlots: { main: `${id}/main`, explore: `${id}/open`, delegate_read: `${id}/open`, compaction: `${id}/open` },
  };
}

const emptyMessages: Message[] = [];
const doneMessage = (model: string, provider: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  model,
  provider,
});

describe("CircuitBreaker", () => {
  it("trips after the failure threshold and recovers after cooldown", () => {
    vi.useFakeTimers();
    try {
      const breaker = new CircuitBreaker(2, 60);
      expect(breaker.isOpen("p1")).toBe(false);
      breaker.recordFailure("p1");
      breaker.recordFailure("p1");
      expect(breaker.isOpen("p1")).toBe(true);

      vi.advanceTimersByTime(60_000 + 1);
      expect(breaker.isOpen("p1")).toBe(false);

      breaker.recordSuccess("p1");
      expect(breaker.state("p1").failures).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tracks failures independently per provider", () => {
    const breaker = new CircuitBreaker(3, 60);
    breaker.recordFailure("a");
    breaker.recordFailure("a");
    breaker.recordFailure("b");
    expect(breaker.isOpen("a")).toBe(false);
    expect(breaker.isOpen("b")).toBe(false);
    breaker.recordFailure("a");
    expect(breaker.isOpen("a")).toBe(true);
    expect(breaker.isOpen("b")).toBe(false);
  });
});

describe("isRetryableFailure", () => {
  it("returns true for HTTP 429/503/500 statuses", async () => {
    const { isRetryableFailure } = await import("./router.js");
    expect(isRetryableFailure({ status: 429 })).toBe(true);
    expect(isRetryableFailure({ status: 503 })).toBe(true);
    expect(isRetryableFailure({ statusCode: 500 })).toBe(true);
  });

  it("returns false for auth, malformed, and critical errors", async () => {
    const { isRetryableFailure } = await import("./router.js");
    expect(isRetryableFailure({ status: 401 })).toBe(false);
    expect(isRetryableFailure({ status: 402 })).toBe(false);
    expect(isRetryableFailure({ status: 403 })).toBe(false);
    expect(isRetryableFailure({ status: 400 })).toBe(false);
  });

  it("returns false for abort-style cancellations", async () => {
    const { isRetryableFailure } = await import("./router.js");
    const abort = new Error("AbortError");
    abort.name = "AbortError";
    expect(isRetryableFailure(abort)).toBe(false);
  });
});

describe("routeStreamAssistant", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = nodeOs.tmpdir() + "/reever-router-test-" + Math.random().toString(36).slice(2);
    nodeFs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    nodeFs.rmSync(home, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function setup() {
    const router = await import("./router.js");
    const registry = await import("./registry.js");
    const config = await import("../config/config.js");
    registry.registerProvider(makeFakeProvider("primary"));
    registry.registerProvider(makeFakeProvider("fallback"));
    return { router, registry, config };
  }

  it("when routing is disabled, calls the underlying fn with the requested model", async () => {
    const { router, config } = await setup();
    config.saveConfig({ provider: { active: "primary" } });
    config.reloadConfig();
    const inner: StreamAssistantFn = vi.fn(async (_m, opts) => doneMessage(opts.model, "primary"));
    const routed = router.routeStreamAssistant(inner);
    const msg = await routed(emptyMessages, { model: "primary/main" }, () => {});
    expect(inner).toHaveBeenCalledTimes(1);
    expect((inner as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ model: "primary/main" });
    expect(msg.provider).toBe("primary");
  });

  it("with routing enabled, tries the lowest-priority candidate first", async () => {
    const { router, config } = await setup();
    config.saveConfig({
      provider: { active: "primary" },
      routing: {
        enabled: true,
        profile: "balanced",
        profiles: {
          balanced: {
            taskRoutes: {
              main: [
                { provider: "primary", model: "primary/main", priority: 2 },
                { provider: "fallback", model: "fallback/main", priority: 1 },
              ],
            },
          },
        },
      },
    });
    config.reloadConfig();
    const inner: StreamAssistantFn = vi.fn(
      async (_m, opts) => doneMessage(opts.model ?? "", opts.providerId ?? ""),
    );
    const routed = router.routeStreamAssistant(inner);
    const msg = await routed(emptyMessages, { model: "primary/main" }, () => {});
    // sorted by priority ascending: fallback (1) first, and it succeeds
    expect((inner as ReturnType<typeof vi.fn>).mock.calls.map((c: Parameters<StreamAssistantFn>[1][]) => c[1].model))
      .toEqual(["fallback/main"]);
    expect(msg.model).toBe("fallback/main");
  });

  it("fails over to the next candidate on a retryable rate-limit error", async () => {
    const { router, config } = await setup();
    config.saveConfig({
      provider: { active: "primary" },
      routing: {
        enabled: true,
        profile: "balanced",
        profiles: {
          balanced: {
            taskRoutes: {
              main: [
                { provider: "primary", model: "primary/main", priority: 1 },
                { provider: "fallback", model: "fallback/main", priority: 2 },
              ],
            },
          },
        },
        backoffMs: 1,
      },
    });
    config.reloadConfig();
    const inner: StreamAssistantFn = vi.fn(async (_m, opts) => {
      if (opts.providerId === "primary") {
        const err = new Error("rate limited") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      return doneMessage(opts.model ?? "", opts.providerId ?? "");
    });
    const routed = router.routeStreamAssistant(inner);
    const msg = await routed(emptyMessages, { model: "primary/main" }, () => {});
    expect(msg.model).toBe("fallback/main");
    expect(msg.provider).toBe("fallback");
  });

  it("does not fail over on auth errors — surfaces the first error", async () => {
    const { router, config } = await setup();
    config.saveConfig({
      provider: { active: "primary" },
      routing: {
        enabled: true,
        profile: "balanced",
        profiles: {
          balanced: {
            taskRoutes: {
              main: [
                { provider: "primary", model: "primary/main", priority: 1 },
                { provider: "fallback", model: "fallback/main", priority: 2 },
              ],
            },
          },
        },
      },
    });
    config.reloadConfig();
    const inner: StreamAssistantFn = vi.fn(async () => {
      const err = new Error("unauthorized") as Error & { status?: number };
      err.status = 401;
      throw err;
    });
    const routed = router.routeStreamAssistant(inner);
    await expect(routed(emptyMessages, { model: "primary/main" }, () => {}))
      .rejects.toThrow("unauthorized");
    expect((inner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("opens the circuit for a provider and skips it on the next call", async () => {
    const { router, config } = await setup();
    config.saveConfig({
      provider: { active: "primary" },
      routing: {
        enabled: true,
        profile: "balanced",
        profiles: {
          balanced: {
            taskRoutes: {
              main: [
                { provider: "primary", model: "primary/main", priority: 1 },
                { provider: "fallback", model: "fallback/main", priority: 2 },
              ],
            },
          },
        },
        retryAttempts: 0,
        circuitBreaker: { failureThreshold: 1, cooldownSeconds: 60 },
      },
    });
    config.reloadConfig();
    const inner: StreamAssistantFn = vi.fn(async (_m, opts) => {
      if (opts.providerId === "primary") {
        const err = new Error("down") as Error & { status?: number };
        err.status = 503;
        throw err;
      }
      return doneMessage(opts.model ?? "", opts.providerId ?? "");
    });
    const routed = router.routeStreamAssistant(inner);

    // First call: primary fails once → circuit trips, fallback answers.
    await routed(emptyMessages, { model: "primary/main" }, () => {});

    // Second call: primary is open, only fallback is attempted.
    const buffered: string[] = [];
    await routed(emptyMessages, { model: "primary/main" }, (e) => { if (e.type === "text_delta") buffered.push(e.text); });
    expect((inner as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1].providerId === "primary").length)
      .toBe(1); // only the first call's attempt
  });

  it("applies the downgrade_model budget action by skipping the primary candidate", async () => {
    const { router, config } = await setup();
    const budget = await import("../telemetry/budget.js");
    budget.resetBudgetLedger();
    config.saveConfig({
      provider: { active: "primary" },
      routing: {
        enabled: true,
        profile: "balanced",
        profiles: {
          balanced: {
            taskRoutes: {
              main: [
                { provider: "primary", model: "primary/main", priority: 1 },
                { provider: "fallback", model: "fallback/main", priority: 2 },
              ],
            },
          },
        },
      },
      budget: { maxUsdPerRun: 0.01, actionOnExceed: "downgrade_model" },
    });
    config.reloadConfig();
    budget.__setLedger({ spentUsd: 0.02 });

    const inner: StreamAssistantFn = vi.fn(
      async (_m, opts) => doneMessage(opts.model ?? "", opts.providerId ?? ""),
    );
    const routed = router.routeStreamAssistant(inner);
    const msg = await routed(emptyMessages, { model: "primary/main" }, () => {});
    expect(msg.provider).toBe("fallback");
    expect((inner as ReturnType<typeof vi.fn>).mock.calls.every((c) => c[1].providerId === "fallback")).toBe(true);
  });

  it("throws BudgetExceededError with the abort action", async () => {
    const { router, config } = await setup();
    const budget = await import("../telemetry/budget.js");
    budget.resetBudgetLedger();
    config.saveConfig({
      provider: { active: "primary" },
      routing: { enabled: true, profiles: {}, profile: "balanced" },
      budget: { maxUsdPerRun: 0.01, actionOnExceed: "abort" },
    });
    config.reloadConfig();
    budget.__setLedger({ spentUsd: 0.02 });

    const inner: StreamAssistantFn = vi.fn(async (_m) => doneMessage(_m[0]?.role ? "x" : "x", "primary"));
    const routed = router.routeStreamAssistant(inner);
    await expect(routed(emptyMessages, { model: "primary/main" }, () => {}))
      .rejects.toThrowError(/budget/i);
    expect(inner).not.toHaveBeenCalled();
  });
});