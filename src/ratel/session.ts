import { createHash } from "node:crypto";
import type { AnyTool } from "../tools/registry.js";
import { getCoreTools } from "../tools/registry.js";
import { loadMcpServers, type McpLoadResult } from "../mcp/loader.js";
import { isRatelEnabled, resolveRatelSettings } from "./config.js";
import { ReeverRatelBundle } from "./catalog.js";

export interface ReeverToolingBootstrap {
  tools: AnyTool[];
  ratel?: ReeverRatelBundle;
  /** True when this session is in the A/B control arm (no Ratel, full tool list). */
  controlArm?: boolean;
  mcpTools: AnyTool[];
  mcpDispose: () => Promise<void>;
  mcpServers: McpLoadResult["servers"];
  mcpWarnings: string[];
  mcpStatusHint?: string;
}

/**
 * Deterministic [0, 1) hash of a sessionId for A/B arm assignment.
 * Uses the first 8 hex chars of SHA-256 — stable across restarts.
 */
function controlHash(sessionId: string): number {
  const hex = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return parseInt(hex, 16) / 0x100000000;
}

/** Load flat MCP or Ratel hybrid session (registerMcpServer when enabled). */
export async function bootstrapReeverTooling(
  cwd: string,
  sessionId?: string,
): Promise<ReeverToolingBootstrap> {
  if (isRatelEnabled()) {
    const settings = resolveRatelSettings();
    const inControl =
      settings.controlFraction > 0 &&
      sessionId !== undefined &&
      controlHash(sessionId) < settings.controlFraction;

    if (inControl) {
      // Control arm: full flat tool list, no pre-filter. Tags traces tool_pool=full.
      const mcp = await loadMcpServers(cwd);
      return {
        tools: [...getCoreTools(), ...mcp.tools],
        controlArm: true,
        mcpTools: mcp.tools,
        mcpDispose: mcp.dispose,
        mcpServers: mcp.servers,
        mcpWarnings: mcp.warnings,
        mcpStatusHint: mcp.statusHint,
      };
    }

    const session = await ReeverRatelBundle.create(cwd, { sessionId });
    return {
      tools: session.tools,
      ratel: session.bundle,
      mcpTools: [],
      mcpDispose: session.mcpDispose,
      mcpServers: session.mcpServers,
      mcpWarnings: session.mcpWarnings,
      mcpStatusHint: session.mcpStatusHint,
    };
  }

  const mcp = await loadMcpServers(cwd);
  return {
    tools: [...getCoreTools(), ...mcp.tools],
    mcpTools: mcp.tools,
    mcpDispose: mcp.dispose,
    mcpServers: mcp.servers,
    mcpWarnings: mcp.warnings,
    mcpStatusHint: mcp.statusHint,
  };
}

/** Rebuild tooling after MCP config change. */
export async function reloadReeverTooling(
  cwd: string,
  sessionId?: string,
): Promise<ReeverToolingBootstrap> {
  return bootstrapReeverTooling(cwd, sessionId);
}

/** Tools passed to runLoop — full execution registry, Ratel-aware. */
export function loopTools(
  flatTools: AnyTool[],
  ratel: ReeverRatelBundle | undefined,
): AnyTool[] {
  return ratel ? ratel.executionTools() : flatTools;
}

/** Child subagent Ratel bundle — filtered tool preset, no MCP upstreams. */
export function buildChildRatelBundle(childTools: AnyTool[], cwd: string): ReeverRatelBundle | undefined {
  if (!isRatelEnabled()) return undefined;
  return ReeverRatelBundle.buildForChild(childTools, cwd);
}
