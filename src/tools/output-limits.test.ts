import { describe, expect, it } from "vitest";
import {
  MAX_DISCOVERY_OUTPUT_BYTES,
  truncateDiscoveryOutput,
} from "./output-limits.js";

describe("discovery output limits", () => {
  it("leaves compact results untouched", () => {
    expect(truncateDiscoveryOutput("src/main.ts:10:hello")).toBe("src/main.ts:10:hello");
  });

  it("caps broad results and tells the agent how to narrow them", () => {
    const output = truncateDiscoveryOutput("x".repeat(MAX_DISCOVERY_OUTPUT_BYTES + 10_000));
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(MAX_DISCOVERY_OUTPUT_BYTES + 300);
    expect(output).toContain(`truncated at ${MAX_DISCOVERY_OUTPUT_BYTES} bytes`);
    expect(output).toContain("Narrow it");
  });

  it("does not leave a broken UTF-8 replacement character at the cut", () => {
    const output = truncateDiscoveryOutput("a".repeat(MAX_DISCOVERY_OUTPUT_BYTES - 1) + "🙂".repeat(20));
    expect(output.slice(0, MAX_DISCOVERY_OUTPUT_BYTES + 5)).not.toContain("�");
  });
});
