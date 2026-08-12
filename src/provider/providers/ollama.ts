import { createOpenAI } from "@ai-sdk/openai";
import { loadConfig } from "../../config/config.js";
import {
  fetchWithTimeout,
  type FetchModelsCatalog,
} from "../openai-compatible.js";
import type { ModelMetadataProvider, Provider } from "../types.js";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export const OLLAMA_PICKER_MODELS = [
  "qwen2.5-coder:14b",
  "qwen2.5-coder:7b",
  "llama3.1:8b",
  "deepseek-r1:8b",
] as const;

/**
 * Resolve Ollama's server root. OLLAMA_HOST matches Ollama's own CLI setting;
 * config wins so each Reever installation can explicitly target another host.
 */
export function resolveOllamaBaseUrl(): string {
  let value = loadConfig().provider.ollama?.baseUrl?.trim()
    || process.env.OLLAMA_HOST?.trim()
    || DEFAULT_OLLAMA_URL;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

interface OllamaModelList {
  data?: Array<{ id?: string }>;
}

const discoveredModels = new Set<string>();

/** Return locally pulled models through Ollama's OpenAI-compatible endpoint. */
export async function listOllamaModels(
  fetchImpl: FetchModelsCatalog = fetch,
): Promise<string[]> {
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `${resolveOllamaBaseUrl()}/v1/models`,
    );
    if (!response.ok) return [];
    const body = (await response.json()) as OllamaModelList;
    const ids = (body.data ?? [])
      .map((model) => model.id?.trim())
      .filter((id): id is string => Boolean(id));
    discoveredModels.clear();
    for (const id of ids) discoveredModels.add(id);
    return ids;
  } catch {
    // Model discovery is optional. The curated picker remains usable when the
    // daemon is stopped and the actual generation call will show its error.
    return [];
  }
}

const metadata: ModelMetadataProvider = {
  id: "ollama",
  supportsModel(modelId) {
    const normalized = modelId.startsWith("ollama:")
      ? modelId.slice("ollama:".length)
      : modelId;
    return OLLAMA_PICKER_MODELS.includes(normalized as typeof OLLAMA_PICKER_MODELS[number])
      || discoveredModels.has(normalized);
  },
  async getContextWindow() {
    // Ollama's OpenAI-compatible models response does not consistently expose
    // context length. Reever's normal conservative fallback handles this.
    return undefined;
  },
  listModelIds: listOllamaModels,
};

export const ollamaProvider: Provider = {
  id: "ollama",
  displayName: "Ollama (local, free)",
  authStrategy: "none",
  configFields: [
    {
      key: "baseUrl",
      label: "Ollama URL (default http://127.0.0.1:11434)",
    },
  ],
  isConfigured() {
    // Ollama has no credential to configure. Connectivity is intentionally not
    // checked synchronously so listing providers never blocks the TUI.
    return true;
  },
  normalizeModelId(modelId) {
    return modelId.startsWith("ollama:") ? modelId.slice("ollama:".length) : modelId;
  },
  languageModel(modelId) {
    const client = createOpenAI({
      baseURL: `${resolveOllamaBaseUrl()}/v1`,
      // The SDK requires a value, while Ollama ignores this header.
      apiKey: "ollama-local",
      name: "ollama",
    });
    return client.chat(this.normalizeModelId(modelId));
  },
  metadata,
  pickerModels: OLLAMA_PICKER_MODELS,
  defaultSlots: {
    main: "qwen2.5-coder:14b",
    explore: "qwen2.5-coder:7b",
    delegate_read: "qwen2.5-coder:7b",
    compaction: "llama3.1:8b",
  },
};
