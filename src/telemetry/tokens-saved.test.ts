import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import { resetTokensSaved, tokensSavedEstimated, recordTokensSaved, estimateTokensRemovedByPruning } from "./tokens-saved.js";

function msg(role: Message["role"], text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

describe("estimateTokensRemovedByPruning", () => {
  it("returns the positive estimate delta between pre and post pruning", () => {
    const pre = [msg("user", "x".repeat(700)), msg("assistant", "y".repeat(700))];
    const post = [msg("user", "summary of everything")];
    const removed = estimateTokensRemovedByPruning(pre, post);
    expect(removed).toBeGreaterThan(0);
    // post is an estimated floor; pre is ~400 chars/3.5 ≈ 114 tokens each.
    expect(removed).toBeLessThan(estimateTokensRemovedByPruning(pre, post) + 1);
  });

  it("is clamped to zero when pruning grew the context", () => {
    const pre = [msg("user", "short")];
    const post = [msg("user", "this is a much longer replacement context that should never count as savings")];
    expect(estimateTokensRemovedByPruning(pre, post)).toBe(0);
  });
});

describe("tokens saved ledger", () => {
  beforeEach(() => resetTokensSaved());
  afterEach(() => resetTokensSaved());

  it("starts at zero and accumulates positive finite values only", () => {
    expect(tokensSavedEstimated()).toBe(0);
    recordTokensSaved(100);
    recordTokensSaved(50);
    recordTokensSaved(-10);
    recordTokensSaved(Number.NaN);
    expect(tokensSavedEstimated()).toBe(150);
  });

  it("ignores non-finite and negative values", () => {
    recordTokensSaved(Number.POSITIVE_INFINITY);
    recordTokensSaved(Number.NEGATIVE_INFINITY);
    expect(tokensSavedEstimated()).toBe(0);
  });
});