# Forge-cli plan → Reever retrofit: review and changes

This review evaluates the "forge-cli" plan against the existing Reever implementation
(`src/`, ~337 files). The plan reads like a from-scratch spec; the correct move is not
to rebuild Reever as "forge" but to **retrofit the plan's additive ideas into Reever**
and modify Reever where the plan exposes real gaps. Everything below is one team's
decision record, not a doctrine — the "changes" column is the actionable part.

## Verdict per section

### Tech stack

| Plan proposal | Reever reality | Change |
| --- | --- | --- |
| Node.js + TypeScript | Bun + TypeScript | Keep Bun. It is a drop-in Node runtime already (Node 22 present too) and gives faster installs/startup. No reason to migrate. |
| Ink TUI | OpenTUI + SolidJS TUI (full interactive agent UI) | Keep. Ink would be a downgrade; the plan's "polished TUI" already exists. |
| Web dashboard (Next.js + WS) | None (only a marketing `docs/index.html`) | Defer; the event bus already exists in-process. A dashboard is a nice-to-have, not core. Reuse the `AgentEvent`/`MetricEvent` bus rather than "building one system for the TUI and one for the dashboard". |
| SQLite (better-sqlite3) | JSONL session logs + JSON config + JSON symbol cache | **Keep JSONL, do not add SQLite for sessions.** Reever's append-only JSONL is replayable, resume-friendly, and human-readable; SQLite buys nothing for a single-user CLI except harder debugging. A DB would only be justified for the token-usage dashboard aggregations — and even those can be computed over the metrics JSONL. |
| Knowledge graph on SQLite + graphology | `src/symbols/*` — tree-sitter symbol + reference graph, persisted as JSON index | The graph already exists structurally (semantic version). The plan's added value is *requirements/decision nodes* and *drift detection* (see Phase 3 below). Do not add graphology; the in-memory `SymbolIndex` already covers traversal. |
| Vector store (sqlite-vec/vectra) | None — BM25 tool-catalog filtering only (Ratel); no code embeddings | Defer. At student-project scale (thousands of chunks) BM25 + symbols + grep is adequate. Revisit only if semantic retrieval measurably improves productivity. |
| Sandboxed execution (child_process / Docker) | Local workspace + E2B VM sandbox + git worktree + shadow-git checkpoints | Already exceeds the plan. Keep. |
| Secrets via keytar | Plaintext `~/.reever/config.json` + no-echo prompt; MCP tokens 0600 | **Do not use keytar (deprecated/archived).** Real improvement: OS keychain via `@napi-rs/keyring`, or at minimum an encrypted-vault fallback. Lowest-risk first step: config file permissions 0600 + env-var resolution. |
| commander/yargs | Hand-rolled arg parsing (`cli-args.ts`) + slash commands in TUI | Keep. Reever's CLI surface is intentionally tiny (`mcp` subcommand + flags); commander would be overkill. If subcommands grow, revisit. |
| Python + Textual alternative | Already built TUI | N/A — moot. |

### CLI command surface

The plan's `forge *` commands map poorly to Reever because Reever is
prompt-first, not pipeline-first. Mapping:

| Plan command | Reever today | Action |
| --- | --- | --- |
| `init` | `npm run init-config` (seeds `~/.reever/config.json`) | Keep as-is. |
| `plan / build / docs generate` | N/A | Reever does planning/drafting *in-session* via `todowrite` + agents. Scripting "generate README" as a subcommand is a nice student-mode addition (`reever docs`) but out of scope for the core. |
| `status` | N/A (TUI is the status) | Optional `reever status` that prints the active provider/model profile + recent sessions. Cheap to add, do it in Phase 4. |
| `providers add/list/test` | `/providers` in TUI; `providers test` missing | **Add `reever providers test`** (health check) — the router needs health anyway (see router section). |
| `route set` model routing | `/settings` + `models.providers` | Replaced by the router below. |

### Provider router — THE gap the plan correctly targets

Reever resolves one active provider and a single model per slot; there is **no
per-call failover, no chain of priority-ordered providers, no circuit breaker,
no per-task-type model routing**. Everything else the plan proposes is secondary
to this. This is the one section the plan deserves to be implemented.

Changes to make in Reever:
- Introduce a `routing` config section with named profiles, per-slot chains
  (`main`, `explore`, `review`, `implement`, `delegate_read`, `compaction`),
  priority-ordered `{ provider, model }` entries, retry/backoff policy, and a
  circuit breaker (failure threshold + cooldown).
- Route resolution per *agent call* (not per session) so Coder and Review can
  deliberately use different providers — matching the plan's "review uses a
  different provider family than coding" idea.
- Wire failover into the LLM stream path only for retryable failures
  (429/timeout/5xx); do **not** fail over on 401/402/403 (auth is provider-
  scoped; falling back to another provider that lacks the correct creds is
  pointless — surface the auth error instead). Reever already classifies these
  via `isCriticalSystemError` / `isRateLimitError`.
- Emit one telemetry event per routed attempt (candidate tried, outcome) so the
  TUI/metrics show the actual provider+model used, plus tokens/cost.

### Verification engine (build → test → fix loop)

The plan's `max_fix_retries` loop already exists *informally* (the agent calls
`bash` to run tests, reads output, fixes). What Reever lacks is a **structured
verification step**: run build/test, parse test-runner output into
`{file, line, message}`, hand the Fixer targeted context instead of a wall of
text. Implement as a `verify` tool/session command rather than a new engine.

### Budget ceilings

Reever tracks cost/tokens thoroughly but has **no ceiling/action**. Add a config
ceiling (`maxCostUsdPerRun`) with actions `abort` / `downgrade_model` /
`prompt_user`, enforced at the router layer before each call. This is real,
measurable, and cheap.

### "Tokens saved" metric

Plan correctly flags this as trip-erability. Reever already tracks actual
token/cost. To derive "saved", define the baseline explicitly and
unambiguously: **naive baseline = estimated tokens of the full message history
that would be re-sent if compaction/eviction never pruned it**, computed with
`estimateMessageTokens` (already in `src/agent/compaction.ts`). "Saved" =
baseline − actual. Document the formula in the metric itself; otherwise it *is*
vanity.

### Knowledge graph / memory (Phase 3 placeholders)

Do not bolt on requirements/decision nodes until the economics are clear.
Reever's symbol graph answers "what do I touch this file" well. The single
highest-value memory feature from the plan is **stale-graph detection**
(`forge memory sync` equivalent): diff repo `mtime`/hashes against the symbol
cache and re-index drift. That already partially exists
(`src/symbols/cache.ts` fingerprints by mtime+hash); close the gap by surfacing
drift, not by adding nodes.

### Secrets editing rule

Keep the plan's "nothing in `providers.yaml` is ever a raw secret" principle in
Reever: treat config-file API keys as migration targets toward keychain
resolution, and never log them. Low-risk first change: make config file 0600 and
stop echoing full keys in `/providers configure`.

## Concrete change list (implementation order)

1. **Config**: add `routing` (profiles/chains/retry/circuit-breaker) and `budget`
   (ceiling + action) shapes with sane defaults.
2. **Provider routing module**: chain resolver + failover executor + circuit
   breaker over the existing stream path.
3. **Router telemetry**: per-attempt event with provider/model/tokens, and a
   "tokens saved vs naive baseline" metric with the documented formula.
4. **Budget enforcement** at router layer (abort / downgrade_model).
5. **`reever providers test`** health subcommand (feeds the breaker).
6. **`verify`** step: run build/test, parse into `{file,line,message}`, give the
   fixer targeted context.
7. **Docs update** in CODING_GUIDE/README for routing + budget usage.

## Explicitly deferred (with reason)

- Dashboard/WebSocket — event bus exists; deliver TUI value first.
- SQLite — JSONL is the right store for a single-user tool.
- Vector store — no scale to justify it yet; BM25+symbols suffice.
- keytar — deprecated; a keyring swap is a separate low-priority task.
- Student mode docs generators / interview mode — product differentiation later;
  not core agent plumbing.

## Constraints honored

- No rewiring of the agent loop's established provider resolution for existing
  behavior when routing is off; routing must be opt-in with a documented default
  profile.
- Failover only on retryable failures; circuit breaker prevents hammering a
  dying provider.
- Budget ceiling enforced *before* spend on the routed path; telemetry already
  records every call.
- Tests for router resolution, failover order, breaker thresholds, budget
  actions, and the tokens-saved formula.