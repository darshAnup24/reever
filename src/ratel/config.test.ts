import { describe, expect, it, vi } from "vitest";

describe("resolveRatelSettings", () => {
  it("pins only the high-frequency primitives by default", async () => {
    vi.resetModules();
    vi.doMock("../config/config.js", () => ({ loadConfig: () => ({}) }));
    const { resolveRatelSettings } = await import("./config.js");

    expect(resolveRatelSettings().pinnedTools).toEqual(["read", "edit", "bash", "grep"]);
  });

  it("strips MCP tools out of a user-supplied pinnedTools override (issue #324)", async () => {
    vi.resetModules();
    vi.doMock("../config/config.js", () => ({
      loadConfig: () => ({
        ratel: {
          pinnedTools: ["read", "fs__list_directory", "context7__query-docs", "search_symbols"],
        },
      }),
    }));
    const { resolveRatelSettings } = await import("./config.js");

    expect(resolveRatelSettings().pinnedTools).toEqual(["read", "search_symbols"]);
  });
});
