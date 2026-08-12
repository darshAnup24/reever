import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("ollama provider", () => {
  let home: string;
  let previousHome: string | undefined;
  let previousHost: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousHost = process.env.OLLAMA_HOST;
    home = mkdtempSync(join(tmpdir(), "reever-ollama-test-"));
    process.env.HOME = home;
    delete process.env.OLLAMA_HOST;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previousHost;
    rmSync(home, { recursive: true, force: true });
  });

  it("is usable without an API key", async () => {
    const { ollamaProvider } = await import("./ollama.js");
    expect(ollamaProvider.authStrategy).toBe("none");
    expect(ollamaProvider.isConfigured()).toBe(true);
    expect(ollamaProvider.languageModel("qwen2.5-coder:7b")).toBeDefined();
  });

  it("normalizes an optional ollama model prefix", async () => {
    const { ollamaProvider } = await import("./ollama.js");
    expect(ollamaProvider.normalizeModelId("ollama:qwen2.5-coder:7b"))
      .toBe("qwen2.5-coder:7b");
    expect(ollamaProvider.metadata.supportsModel("anthropic/claude-sonnet-4")).toBe(false);
  });

  it("uses OLLAMA_HOST and normalizes its URL", async () => {
    process.env.OLLAMA_HOST = "localhost:22434/v1/";
    const { resolveOllamaBaseUrl } = await import("./ollama.js");
    expect(resolveOllamaBaseUrl()).toBe("http://localhost:22434");
  });

  it("prefers the configured URL over OLLAMA_HOST", async () => {
    process.env.OLLAMA_HOST = "http://localhost:22434";
    const { saveConfig } = await import("../../config/config.js");
    saveConfig({ provider: { ollama: { baseUrl: "http://ollama.test:11434/" } } });
    const { resolveOllamaBaseUrl } = await import("./ollama.js");
    expect(resolveOllamaBaseUrl()).toBe("http://ollama.test:11434");
  });

  it("discovers pulled local models", async () => {
    const { listOllamaModels } = await import("./ollama.js");
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "qwen2.5-coder:7b" }, { id: "llama3.1:8b" }] }),
    })) as unknown as typeof fetch;
    await expect(listOllamaModels(fakeFetch)).resolves.toEqual([
      "qwen2.5-coder:7b",
      "llama3.1:8b",
    ]);
    expect(fakeFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/v1/models",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("merges all pulled models into the picker", async () => {
    const { loadPickerModels } = await import("../picker-models.js");
    const { ollamaProvider } = await import("./ollama.js");
    vi.spyOn(ollamaProvider.metadata, "listModelIds").mockResolvedValue([
      "qwen2.5-coder:7b",
      "my-private-model:latest",
    ]);
    const models = await loadPickerModels("ollama");
    expect(models).toContain("qwen2.5-coder:7b");
    expect(models).toContain("my-private-model:latest");
  });

  it("does not offer unpulled curated models when discovery succeeds", async () => {
    const { loadPickerModels } = await import("../picker-models.js");
    const { ollamaProvider } = await import("./ollama.js");
    vi.spyOn(ollamaProvider.metadata, "listModelIds").mockResolvedValue([
      "my-private-model:latest",
    ]);
    await expect(loadPickerModels("ollama")).resolves.toEqual(["my-private-model:latest"]);
  });

  it("degrades to the curated list when discovery cannot connect", async () => {
    const { listOllamaModels, ollamaProvider } = await import("./ollama.js");
    const fakeFetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    await expect(listOllamaModels(fakeFetch)).resolves.toEqual([]);
    expect(ollamaProvider.pickerModels.length).toBeGreaterThan(0);
  });

  it("is registered as a built-in provider", async () => {
    const { getProvider, providerSummaries } = await import("../registry.js");
    expect(getProvider("ollama")?.displayName).toContain("local");
    expect(providerSummaries()).toContainEqual(expect.objectContaining({
      id: "ollama",
      configured: true,
      authStrategy: "none",
    }));
  });
});
