# Reever — Interview Prep Guide

A study guide for **Reever**, a terminal coding-agent CLI. Every section leads with a
*plain-words* explanation, then gives you the real technical details (names, numbers,
file locations) so you can sound like you shipped it yourself.

---

## 1. What is this project? (The 30-second pitch)

**Plain words:** Reever is a robot that does coding tasks inside your terminal. You type a
task like "fix the failing test in `src/foo`", and it searches your code, reads files,
edits them, runs commands, and checks its own work — looping until it's done. It lives
entirely in a terminal window with a real UI.

**Why people use it:**

| Property | Meaning |
|---|---|
| **Safe by default** | Nothing gets written or run without your OK (three modes: `normal`, `allow-all`, `plan`). Plan mode is strictly read-only |
| **Cheap by design** | Two-model trick: an expensive smart model thinks; a cheap model does the boring file-reading work |
| **Observable** | Every turn is traceable — cost, tokens, tool durations — locally and to OTLP tools like Langfuse |
| **Undo-able** | Every change is snapshotted to a hidden git repo, so `/undo` rolls your files back at any point |

It's modeled on tools like `opencode`, `pi.dev`, and Claude Code but deliberately
differentiates on: per-turn BM25 tool ranking, E2B OS-level sandboxing, shadow-git undo,
the two-model split, an offline demo mode, and an EU provider.

---

## 2. Tech stack (commit to memory)

| Layer | Choice | Why (plain words) |
|---|---|---|
| Runtime | **Bun ≥ 1.1** | The terminal UI needs Bun's FFI + a special SolidJS preload transform. Plain `node` won't run it |
| Language | **TypeScript** (ESM) | `tsc --noEmit` for typecheck |
| AI orchestration | **Vercel AI SDK** (`ai` v6, `streamText`) | One API for streaming across all LLM providers; each provider just hands back a model handle |
| LLM providers | OpenRouter (default), OpenAI, Anthropic, Regolo (EU), Cerebras, Vercel, Cloudflare, Command Code, opencode-go/zen | A provider registry you can switch at runtime |
| Tool pre-filtering | **Ratel** (`@ratel-ai/sdk`) | Native Rust BM25 search — picks the relevant tools each turn (see §16) |
| Symbol indexing | **Tree-sitter** (WASM) + JS/TS/Python grammars | Structural code search over the repo, cached |
| TUI | **SolidJS + `@opentui/core` / `@opentui/solid`** | Reactive UI components rendered live in the terminal |
| MCP | `@modelcontextprotocol/sdk` | Plug in external tool servers (GitHub, databases) |
| Sandboxing | `e2b` SDK | Ephemeral cloud VMs — real isolation from your machine |
| Search | `@vscode/ripgrep` | Fast grep binary for the `grep` tool |
| Validation | `zod` v4 | Describes and checks every tool's arguments |
| Observability | `@opentelemetry/*` (lazy-loaded) | OTLP trace export; only loads if you enable it |
| Diffs | `diff` | Unified diffs for the edit tool's output |
| Test | `vitest` + one Bun TUI test | `src/tui/approval-bar.test.tsx` |

Scripts (`package.json`): `start`/`dev` = `bun src/cli.ts`, `build` = `bun scripts/build.mjs`, `typecheck` = `tsc --noEmit`, `test` = `vitest run` + the TUI test.

---

## 3. Architecture at a glance  

```
src/cli.ts (tiny bootstrap that loads the entrypoint)
   └─ src/main.ts (parses args, picks a mode)
        ├─ --headless → runHeadless      (no UI, prints to stdout, exits)
        ├─ --chat     → runOneShotMode   (single AI reply, no loop)
        └─ default    → runInteractive    (the TUI)
              └─ src/tui/session.ts  (runs a session)
                    └─ src/agent/loop.ts  (the core agent loop)
                          ├─ provider/   (talks to the LLM, streaming)
                          ├─ tools/      (read, write, edit, bash, ...)
                          ├─ approval/   (asks you before risky actions)
                          └─ hooks/      (event system listeners)
```

**The one idea that unlocks everything:** *the agent loop is headless — it never touches
the terminal.* It just emits events, and the TUI (or headless mode, or a subagent, or the
demo) subscribes to those events. One loop, four front-ends.

The loop, in code-shaped English:

```
runLoop(ctx, emit):
  loop:
    message = await streamAssistant(ctx, emit)   # ask the model, stream the answer
    ctx.messages.push(message)
    toolCalls = message.content.filter(toolCall) # did it call tools?
    if no toolCalls: break                        # done answering
    results = await executeTools(toolCalls, ctx, emit)
    ctx.messages.push(...results)                 # give results back
    if any result terminates: break
```

---

## 4. Core data model (`src/types.ts`)

**Plain words:** the whole agent is just a list of messages, and each message is a list of
typed "blocks". A block is either text, reasoning (hidden thinking), a tool call, or a
tool result.

```ts
type Role = "system" | "user" | "assistant" | "tool";

type ContentBlock =
  | { type: "text";       text: string }
  | { type: "reasoning";  text: string }
  | { type: "toolCall";   id: string; name: string; arguments: unknown }
  | { type: "toolResult"; toolCallId: string; toolName: string; output: string; isError?: boolean };

interface Message { role: Role; content: ContentBlock[] }
```

Design notes worth mentioning in an interview:

- **`arguments: unknown`** on `toolCall` — args are stored as an untyped blob; they're only
  validated later when the tool's zod schema parses them at execution time.
- **`toolResult` also carries `toolName`** (not just the call id) — deliberate
  denormalization so results are self-describing.
- **`output` is always a string** — makes serialization trivial (sessions are JSONL) and
  matches how the AI SDK expects tool results.
- **`reasoning` is shown to you but never sent back to the model** — it's stripped before
  every provider call. The UI shows "thinking"; the model doesn't re-read it (saves tokens).

Other core types:
- `AgentContext` — a per-session bag of everything the tools need: messages, cwd, workspace
  backend, todos, nesting depth (0 = main agent), `loopHost`, `askUser`, symbol index, etc.
- `LoopHost` — the wiring a parent passes down to child subagents: provider, model, session
  id, hooks, approval, telemetry, so children reuse the same plumbing.
- `SessionEvent` — the persisted event union written to the session log: `user_message`,
  `assistant_chunk`, `tool_result`, `session_meta`, `checkpoint`, `metric`, etc.

---

## 5. Entry points & CLI

### `src/cli.ts` — the bootstrap shim (29 lines)

**Plain words:** a tiny file whose *import order matters*. It fixes two things before the
app starts:

1. Disables a terminal-graphics probe that misbehaves on macOS Terminal (`terminal-env-preload.js`).
2. Registers a SolidJS build trick that only works from the repo directory — that's why the
   globally-installed `reever` command needs this shim.
3. Then dynamically imports the real entrypoint `./main.js`.

### `src/cli-args.ts` — flag parsing

Flags: `--faux` (offline demo with scripted AI, implies `--auto-accept`), `--auto-accept`,
`--plan`, `--headless`, `--list-sessions`/`-l`, `--chat`, `--resume`/`-r <id>`,
`--worktree`. Anything that isn't a flag becomes the prompt. Approval precedence:
`--plan` > `--auto-accept` > the config's base mode.

### `src/main.ts` — mode dispatch

1. Ensure the user's `~/.reever/config.json` exists (seed from defaults).
2. `argv[0] === "mcp"` → the MCP management subcommand.
3. `--list-sessions` → print a table of saved sessions.
4. `--headless` → run one task to completion, stream to stdout, exit.
5. `prompt + --chat` → one AI completion, no agent loop.
6. otherwise → the interactive TUI.

Provider resolution always goes through the registry: `repairActiveProviderIfNeeded()` will
silently fall back to a working provider if the saved one is broken, and the model comes
from `resolveProviderSlot(activeProviderId(), "main")`.

---

## 6. The agent loop (`src/agent/loop.ts`) — the heart

**Plain words:** `runLoop` is the robot's brain. It keeps an "ask the model → run its tool
calls → feed results back" cycle going until the model stops needing tools (or a cap hits).
Below, the turn flow with the *why* after each step.

**Turn flow, step by step:**

1. **Entry guards** — stop if aborted; stop if `maxTurns` (25 by default) is hit.
2. **Context window** — figure out how big this model's memory is (`getContextWindow`).
3. **Stale eviction** — cheap cleanup every turn: old tool results (>3 turns back) that are
   big (>2000 tokens) get replaced with `[result elided — N lines…]`. Keeps memory from
   quietly filling up.
4. **Prompt resolution** — runs `before_prompt` hooks and, if Ratel is on, computes which
   tools to show this turn (BM25, §16).
5. **Cache invalidation** — if the prompt's shape changed (different system/tools/injections),
   forget the cached token count so the next estimate is honest (issue #380).
6. **Compaction check** — is memory >85% full? If yes, summarize old turns with the cheap
   model (§11). If still full after that, append `CONTEXT_FULL_MESSAGE` and stop with an
   error rather than thrash.
7. **LLM call** — emit `llm_start`, then call the provider (streaming). Every text/reasoning
   delta is forwarded to hooks (→ UI updates live).
8. **Usage tracking** — remember the provider-reported input-token count for the next
   compaction check.
9. **Enrichment** — if the model forgot to use proper tool-call formatting and instead wrote
   tool calls inside its text (XML/JSON), recover them. Saves flaky models.
10. **Validation with retry** — zod-check each tool call's arguments. Bad args → append a
    user message explaining the error and loop again (up to 2 fixes) so the model corrects itself.
11. **Empty-response handling** — model said nothing? Nudge it once; a second silence = done.
12. **Persist** — save the assistant message. No tool calls → the loop ends `complete`.
13. **Parallel tool execution** — run all tool calls in parallel, but with per-file
    read/write locks so two writes to the same file never race (§14). One shared stop signal.
14. **Fold results back** — append results; a `terminate` (e.g. a subagent finishing) ends
    the loop; a system failure ends it as `error`.
15. **`maxToolCalls` cap** — total tool calls capped (50 by default).

**Error handling taxonomy (interview gold):**

- **Rate-limit errors** → retry up to 3× with exponential backoff (`1s`, then `2s`, then `4s`).
- **Critical system errors** (disk full, auth failure, out of memory, out of file
  descriptors) → *stop the Loop* with `systemError: true`. Retrying is futile, so don't burn
  tokens on it. The distinction between "annoying but retryable" and "fatal" is a deliberate
  design decision.

---

## 7. Provider layer (`src/provider/`)

**Plain words:** Reever talks to lots of LLM companies (OpenRouter, Anthropic, OpenAI,
Regolo...). Instead of writing a special integration for each, there's one shared streaming
implementation and each provider is just a small adapter that returns a "model handle".
Switching providers mid-session = changing a config value; the next model call just uses it.

**The abstraction** — `Provider` interface: `id`, `authStrategy`, `isConfigured()`,
`normalizeModelId()`, and the crux `languageModel(modelId): LanguageModel`. The transport
is the shared Vercel AI SDK; a provider only hands back a model handle. Optional extras:
`streamProviderOptions` (prompt-cache/session hints) and `markCacheBreakpoints`.

**The registry** — a `Map<string, Provider>`. Default is `openrouter`. The key mechanism:
`resolveLanguageModel(modelId)` resolves the active provider **at call time**, so you can
switch models/providers live with zero rewiring. `repairActiveProviderIfNeeded()` persists
a fallback when the configured one is broken. Registered: openrouter, openai, anthropic,
regolo, cerebras, vercel, cloudflare, command-code, opencode-go, opencode-zen.

**`streamAssistant`** (the single streaming implementation for all providers):

1. `toAiMessages` — convert the block model to AI SDK messages; **strip reasoning**.
2. Add prompt-cache breakpoints, then `streamText({...})`.
3. Consume the stream, buffering text, reasoning, tool calls, and a running char count of
   each tool's arguments (powers the live "Writing… (2.1 KB so far)" progress).
4. `normalizeToolInput` — a tolerant parser so malformed tool-arg JSON never throws.
5. Return the final message with `usage` and `finishReason`.

**Model slots** — different models for different jobs. `resolveProviderSlot(providerId,
slot)`: config pin when the provider supports that model, else the provider's bundled
defaults. Slots: `main`, `explore` (cheap), `delegate_read` (cheap), `compaction` (cheap),
`review` (same as main), `implement`. Default pairing: Claude Sonnet (main) + DeepSeek (cheap).

**Context-window resolution chain** (`getContextWindow`): ask the provider's metadata
whether it knows the model → `provider.getContextWindow(model)` (live catalog with 1h cache)
→ user config override → fallback `32000` tokens.

**Tool-call parsing** — belt and braces: if a provider returns no structured tool calls,
`enrichAssistantMessage` tries XML first (`<tool_call name="...">`), then JSON (fenced blocks
or a top-level object, accepting several spellings of "name" and "arguments"). Tool calls
that come from text get fabricated ids like `parsed-<timestamp>-<n>`.

---

## 8. The tool contract (`src/tools/types.ts`)

**Plain words:** every tool (read a file, run a command, inject a todo) is the same shape:
a name, a description, a zod schema for its arguments, an optional "should I ask for
approval?" check, and an `execute` function. The model sees the name + description + schema.

```ts
interface Tool<A> {
  name: string;
  description: string;
  schema: z.ZodType<A>;                          // zod validation
  providerInputSchema?: Record<string, unknown>; // raw MCP JSON schema for approval UI
  providerSchemaMeta?: ProviderSchemaMeta;       // sha-256 schema digest (approval audit)
  needsApproval?: (args, ctx) => boolean;
  approvalDisplayArgs?: (args) => { name, args };
  execute(args, ctx, signal): Promise<ToolResult>;  // { output, isError?, terminate? }
}
```

**The tool set** (deliberately small): `read`, `write`, `edit`, `bash`, `grep`, `find`,
`ls`, `fetch`, `web_search`, `search_symbols`, `file_op`, `delegate_read`, `todowrite`,
`propose_todo` (child-only), `task`, `task_parallel`, `askuser`, `skill_list/use/write`,
`bash_status/bash_kill`.

- **Subagents get a restricted menu** — no `todowrite` (parent owns the plan), no
  `task`/`task_parallel` (no recursion), no `file_op`, no `askuser` (no talking to the user).
  They get `propose_todo` instead, which just *suggests* plan items to the parent.
- **Approval is per-tool and optional** — `read` never asks; `write`/`edit`/`bash`/`file_op`
  always ask (they're `WRITE_TOOLS`).

Small but memorable details:

- **read** — 2000-line default limit, 256 KiB hard cap; when it truncates it tells the model
  exactly how to continue (`re-read with offset X`).
- **fetch** — SSRF guard: blocks localhost/private/link-local IPs by default so it can't be
  used to probe internal networks; redirect targets are re-checked too.
- **bash** — 120s timeout, 256 KiB output cap (process killed at the cap), and background
  jobs via `bash_status`/`bash_kill`.
- **grep** — shells out to the `@vscode/ripgrep` binary.
- **find** — pure TS walk, no shell; skips `node_modules` and `.git`.
- **file_op** — files only (directories go through bash `rm`/`mv`); refuses paths that escape
  the workspace root.
- **askuser** — asks you a 2–4 choice question; if there's no interactive user (headless,
  subagent) it degrades to "decide yourself".

---

## 9. The edit tool — fuzzy replacer chain (`src/edit/replacers.ts`)

**Plain words:** AI models are sloppy — they return "old text to find" that doesn't exactly
match the file (extra spaces, different indent, weird escapes, typos). The edit tool is
*fuzzy*: it tries progressively looser ways to find the text, from "exact match" down to
"close enough". Rule: **if a match isn't unique, it refuses to guess** — ambiguous means error.

**The chain, simplest → fuzziest:**

1. `simpleMatch` — exact `indexOf`.
2. `lineTrimmedMatch` — ignore trailing spaces per line.
3. `blockAnchorMatch` — anchor the first/last lines, trim interior lines fully.
4. `whitespaceNormalizedMatch` — collapse runs of spaces/tabs.
5. `indentationFlexibleMatch` — ignore leading whitespace (matches regardless of indent level).
6. `escapeNormalizedMatch` — decode `\n`, `\t`, `\uXXXX`, HTML entities before comparing.
7. `levenshteinMatch` — the "nuclear option": minimum edit-distance window, accepted only if
   ≤20% difference and the best window is unique.
8. `anchorMatch` (when a `startLine` hint exists) — search a window around that line.
9. `middleOutFuzzyMatch` — search outward from the file's middle; accept a unique window with
   ≥80% similarity.

If all matchers fail, `findMatch` throws `EditMismatchError` carrying `{triedMatchers,
closestCandidate, similarity}` — the model is told exactly which matchers ran and how close
the best candidate was, and can retry with better `oldText`.

**Applying edits:** every match is computed against the *unmodified* original; overlapping
ranges are rejected; then edits apply in sorted order with a running offset. A unified diff
is returned to the model — except for huge files (>256 KiB), because a synchronous diff on a
giant file would freeze the UI for seconds.

**Adjacent safety:** the **read-staleness tracker** — before `edit`/`write`, Reever checks
the file was read this session and hasn't changed on disk since. It warns, or blocks when
`tools.edit.requireFreshRead` is on. That's why the agent re-reads a file right before
editing it.

---

## 10. Approval system (`src/approval/`)

**Plain words:** the "seatbelt". Before anything risky runs, Reever asks you. There are
three modes you flip with `/mode`:

- `normal` — write-style tools prompt you.
- `auto-accept` (**"allow all"**) — skip the prompts.
- `plan` — **strictly read-only**: all write tools *and all MCP tools* are blocked, no
  prompt, just denied.

**Implementation:** the approval gate is a `before_tool` **hook** — the *first* hook
installed, so it runs before any other logic. `ApprovalGateRef` holds live session state
(`mode`, tools, a `confirm` callback), so `/mode` takes effect instantly, mid-session.

**Decision order:**
1. auto-accept → approve.
2. plan-mode + blocked tool → deny.
3. bash command matches an auto-approved pattern (config `approval.autoApprovedCommands`) → approve.
4. otherwise → follow the tool's `needsApproval`.

When approval is needed, the gate emits `approval_required` and waits on the TUI's
confirmation modal (or a plain `y/N` prompt in headless). Denial → the tool never runs and
the model just sees `[Blocked: reason]`. Stopping a turn cancels a pending approval dialog.

Subtlety: inner Ratel `invoke_tool` calls skip *their own* approval dialog but still honor
the underlying tool's `needsApproval` — so no double-prompting and no escape hatch.

---

## 11. Compaction (`src/agent/compaction.ts`) — memory management

**Plain words:** LLMs have a fixed memory size (context window). When it's ~85% full
(`COMPACT_THRESHOLD`), Reever condenses: it crops giant tool outputs, then hands the *old*
conversation to a cheap model to write a short summary, keeping the recent part verbatim.
That frees memory to keep working.

**Token estimation without a tokenizer:** `chars / 3.5`, counting text/tool calls/results
(not reasoning). But it *prefers* the provider-reported `usage.input`, taking the **max of
known vs estimated** — so neither a stale count nor a rough estimate can ever hide an
overflow (issue #380).

**The pipeline** (`compactMessages`), using the cheap compaction-slot model:

1. **`capOversizedToolResults`** — crop any single tool result bigger than ~16k tokens.
2. **`pruneOverflowToolResults`** — walk backward protecting the most recent ~40k tokens;
   only commits a prune if ≥20k tokens are freed (don't churn for tiny wins).
3. **`summariseOldTurns`** — keep the last 20 turns verbatim; send the older turns to the
   cheap model with a meta-prompt ("compressed summary preserving decisions, file paths,
   errors, task state"). Big conversations are chunked and summarized piece by piece. Result:
   one synthetic assistant summary prepended to the recent turns.
4. **`summariseOldMessages`** (up to 3 passes) — for sessions with no clean turn boundaries;
   walks backward to a cut point, halving its recent-token budget each pass until it fits.

**Failure is non-fatal** — any summarize error just logs a warning and keeps the original
messages. Compaction is best-effort, never fatal.

**Budgets scale to the window** (`scaleToWindow`) — the headline fix for issue #183:
hard-coded budgets tuned for ~200k windows broke small windows (a 32k explore subagent).

---

## 12. `delegate_read` — the cheap-model read path (`src/delegate/`)

**Plain words:** reading files costs money. Reading a 5000-line file into the smart model's
context is expensive. So Reever gives read-heavy work to a *cheap* model in a one-off call:
the cheap model reads the file, understands it, and returns only a concise summary. The raw
file content never touches the expensive main context. The cheap model even has **no write
tools** — it physically can't change anything.

**How it works:**
1. Resolve the paths (globs expanded) and load each file.
2. **Crop using the symbol index** — extract identifier-ish words from the task, find
   matching functions/classes in the files, and send only those *line ranges + 5 lines of
   context* instead of the whole file. Files with no matches stay full.
3. Build a `<corpus><file ...>...</file></corpus>` message + the task as a second message.
4. Use the cheap `delegate_read` model slot, cap output at 8192 tokens, record the cost as
   `source: "delegate_read"`.

**Enforcement:** a sibling hook blocks "broad reads" (more than 200 lines) of files over
500 lines / 64 KiB and *instructs the model* to use `delegate_read` or a bounded
`read offset/limit` instead. The main agent literally can't accidentally pull a huge file
into context.

---

## 13. Checkpoints / shadow-git undo (`src/checkpoint/`)

**Plain words:** an "undo button" for the agent. Normal undo tools only track file edits
Reever makes with its own edit tool — but bash commands can change *anything* (delete files,
run migrations). So Reever snapshots the **whole working tree with git** before/after risky
actions. `/undo` = "restore the snapshot before the last action".

**The mechanism:** each session gets its **own private git repo** at
`~/.reever/checkpoints/<sessionId>`:

- The git *data* lives **outside** your project (pointed at it via `--git-dir`/`--work-tree`),
  so your project's own `.git` history is untouched.
- Hermetic git config: no user hooks, no GPG signing, built-in identity
  (`user.name=reever`) — works even with no global git config.
- **Guardrail:** refuses to checkpoint inside `~`, `/`, `Desktop`, `Documents`, `Downloads`
  (a past incident — opencode #8577 — git-init'd someone's home and filled their disk).

**Flow:**
- `snapshot(label)` — `git add -A`; **no commit if nothing changed** (bash that didn't
  mutate = no useless snapshot).
- `restore(id)` — `git reset --hard <id>` + `git clean -fd`. Note: `-d` removes untracked
  dirs, but **no `-x`** — `.gitignore`d files survive.
- `baseline()` — an initial empty snapshot so even the *first* edit is undoable.
- `afterTool(tool)` — snapshot after each mutating main-agent tool. Subagents are skipped
  (they're isolated anyway).
- **Restore is itself reversible:** before restoring, it takes a "pre-restore safety"
  snapshot — so you can undo an undo.

**Retention:** repos older than 30 days or beyond the newest 50 are pruned; git garbage
collection runs asynchronously in the background so it never stalls the UI.

---

## 14. Mutation queue — parallel tool safety (`src/agent/mutation-queue.ts`)

**Plain words:** tools run in parallel for speed. But two tools editing the same file, or a
read racing a write, would corrupt things. So Reever keeps a per-file queue: **writes are
exclusive, reads are shared.** Two reads on different files run in parallel; a read and a
write on the *same* file take turns, in request order.

- `runExclusive(key, fn)` — a writer waits for the last write **and any reads enqueued
  since**, then runs; it records itself as the new last write.
- `runShared(key, fn)` — a reader waits only for the last write, then runs alongside other
  readers; it registers itself so the next writer waits for it.
- FIFO order guarantees: a read queued after a write sees the write's result.

**Which locks a tool takes** (`mutationLocks`):
- `write`/`edit`/`file_op` → exclusive (`file_op` locks both source *and* destination).
- `read`/`grep`/`find`/`ls`/`search_symbols` → shared.
- `bash` → **`bashMutationLocks`**: a hand-rolled, quote-aware shell tokenizer that guesses
  which files a command touches *without running it*:
  - redirection targets (`> file`, `>>`) → exclusive;
  - write verbs (`rm mv cp touch mkdir sed -i git checkout/merge/...`) → exclusive;
  - read verbs (`cat tail grep ls diff`) → shared.
- Ratel `invoke_tool` unwraps to the inner tool's locks.

**Deadlock avoidance:** locks are deduped (exclusive wins) and **acquired in a consistent
sorted order** (by path, exclusive first) — deterministic ordering means no deadlock.

---

## 15. Subagents & isolation (`src/tools/task.ts`, `src/agent/isolation.ts`)

**Plain words:** for big tasks, Reever can spawn child agents. Three flavors, and — the key
design rule — **isolation can only get stronger, never weaker.**

| Preset | Tools | Changes files? | Model slot |
|---|---|---|---|
| `explore` | read-only (read, grep, find, ls, search_symbols) | no | cheap `explore` slot |
| `review` | read-only | no | main slot |
| `implement` | full child tool set | yes | code-tuned Kimi K2.7 when supported |

Caps to stop runaway recursion: depth ≤ 1, turns ≤ 25, tool calls ≤ 128.

**Isolation ladder** — `shared` → `worktree` → `sandbox`:

- **`shared`** — the child edits the host working tree directly (fine for read-only work).
- **`worktree`** — the child runs in a **fresh git worktree** on branch `reever/subagent-<id>`.
  At the end, `harvest()` commits the child's changes to that branch and reports a
  `git diff --stat` to the parent; then the *folder* is deleted — **the branch survives, the
  directory does not**. If the commit fails, the dir is kept for manual rescue.
- **`sandbox`** — an **E2B ephemeral cloud VM**: the host repo is shallow-cloned into the VM
  and the child works there; `dispose()` kills the VM. Real OS-level isolation — whatever the
  child runs, it's on a throwaway machine.

**The rule:** "floor + escalate, never weaken." The config sets a floor; children can only
be *more* isolated, never less. Plus, **parallel + mutating** children force the floor up to
`worktree` automatically (siblings can't collide on the host tree). `shared` is *forbidden*
in `task_parallel`.

**`task_parallel`** — a bounded worker pool (default `maxParallel: 4`, workers pull tasks
from a shared cursor), one shared abort signal, and all siblings branch from a common base.
When the parent tree is *dirty* (uncommitted edits), the base is an **ephemeral commit-tree
snapshot**: children branch from the parent's work *including uncommitted edits*, and the
parent's git index is restored afterward.

**Child events** (tool calls, LLM calls, messages, todo proposals) are forwarded to the
parent's hooks tagged with `subagentId` — so **one** cost accumulator and **one** trace
record all subagent spend.

---

## 16. Ratel — BM25 tool pre-filtering (`src/ratel/`)

**The problem, in plain words:** the tool catalog can have hundreds of entries (native tools
+ MCP servers). Sending *all* of them to the model on every call is expensive (more tokens)
and confusing (more chances to misuse a tool). So Reever only sends the tools that look
relevant to *this turn's* task.

**The mechanism, in plain words:** every turn, Reever runs a quick **word-matching search**
over all tool names + descriptions, using the latest user prompt as the query, and keeps
only the top matches (default 5 tools, 3 skills). A few essential tools are always kept, no
matter what ("pinned"). The full catalog never reaches the model.

**The BM25 part, explained simply:** BM25 = "Best Matching 25", the classic search-ranking
formula (it powers Lucene/Elasticsearch). It ranks documents against a query by scoring how
often words match — with two smart tweaks:

- **Term frequency + inverse document frequency** — a tool that mentions a rare, specific
  word (e.g. `docker`) scores higher than one full of common words like "file".
- **Length normalization** — a short, focused description matches better than a long, generic
  wall of text.

Ratel ships BM25 as a **native Rust index** (`@ratel-ai/sdk`) behind a JS `ToolCatalog`, so
the search runs **in memory in microseconds** — cheap enough to run before every LLM call.

**Why BM25 and not fancier search?** (a good interview answer)

- The catalog is small (~20–25 tools, up to ~500 with MCP). The prompt and tool descriptions
  already share vocabulary ("grep", "edit", "bash"), so simple lexical matching is enough —
  you don't need AI/vector search.
- It runs **on the hot path (every turn)** and is **offline & free**: no embedding model, no
  network, ~microseconds. Embedding/vector search would add an API call + latency + cost to
  every single turn.
- It's **deterministic** — same prompt, same result — which makes debugging and A/B testing
  easy. It also pairs with the alphabetical-sort trick below that keeps the prompt cacheable.
- Project rule (in `docs/reference/command-code.md`): *"never use vector infrastructure until
  lexical retrieval proves insufficient."* BM25 is the simplest tool that works.

**Known weakness (levels it as "optimal fit", not "best possible"):** BM25 is dumb about
**synonyms** — if the model asks to "list files" but a tool's description says "show
directory", it may miss. That risk is contained: the essential tools are pinned, the model
can search the full catalog itself (gateway below), and telemetry logs any wrongly-dropped
tool (Guardrail below). The repo also documents a "plan B" (recall mode) if prompt-caching
ever regresses.

**Per turn** (`resolveToolsForTurn`): pinned tools (gateway + the core reads/writes) **+
BM25 top-K hits**. The injected set is then **alphabetically sorted so the `tools:` block is
byte-identical across turns** — the same tool list is resent, which maximizes Anthropic
prompt-cache hit rate (worth watching; the integration doc flags this).

**The gateway** — instead of a flat list, the model gets two discovery tools:

- `search_capabilities` — search for tools/skills by keyword, grouped by server (skills are
  ranked separately so they're never starved out by tools).
- `invoke_tool` — invoke a found tool by id. Inner execution still runs through the normal
  hooks/approval path, so MCP and native tools keep identical governance.

(`search_capabilities` + `invoke_tool` are always pinned, so the model is never locked out
of a needed tool — it just has to look it up.)

**A/B testing built in:** a deterministic SHA-256 hash of the session id splits sessions into
**control** (full flat tool list, `feature_flag: "tool_pool=full"`) vs **treatment**
(`tool_pool=ratel`) — you measure whether BM25 actually saves tokens/cost in telemetry,
rather than trusting the theory.

**Guardrail:** if the model calls a tool *not* injected this turn but present in the
catalog, telemetry records a `ratel.unavailable_tool_call` event — surfacing any tools the
filter wrongly dropped (an early warning that the pinned core is missing something).

---

## 17. Symbol index — Tree-sitter (`src/symbols/`)

**Plain words:** `search_symbols` gives the model a *structural* view of the codebase —
"find the definition of `foo`", "who calls `bar`?" — instead of raw text grepping. The
files are parsed into real syntax trees, so it knows functions, classes, and callers, and
it caches that index so restarts are instant.

- **What:** definitions, references, and callers of functions/classes/methods, cached across
  sessions.
- **How:** `web-tree-sitter` WASM grammars (TypeScript/TSX/JavaScript/Python) parse source
  into concrete syntax trees; tree-sitter queries extract definitions and references.
  Symbols are keyed `file:startLine:kind:name`; a **call graph** (who calls whom) powers the
  "callers" query.
- **Cache:** per-repo fingerprint (`sha256(cwd)`) → `~/.reever/index/<repoHash>.json`. Each
  file is fingerprinted by `mtimeMs` + content hash; unchanged files skip re-hashing. Writes
  are atomic (tmp + rename). Warm scans use an 8-worker pool.
- **Lifecycle:** the index warms on `session_start`; edits and file deletes/moves update or
  remove cached entries.

Bonus: it also powers `delegate_read`'s line-range cropping — sending only the
symbol-relevant parts of a file to the cheap model.

---

## 18. MCP support (`src/mcp/`)

**Plain words:** MCP (Model Context Protocol) is a standard way to plug external tool
servers (GitHub, databases) into an AI agent. Config lives in `~/.reever/mcp.json` merged
with project `.mcp.json`. The trust default is **untrusted** — an MCP tool needs your
approval unless its server opts into auto-approve.

- **Transports:** stdio, HTTP (streamable, with OAuth 2.1), WebSocket.
- **Security:** env variables are expanded only at load time (raw placeholders stay on disk,
  so saving config can't leak secrets); missing vars skip the server with a warning.
- **Naming:** tools are named `server__tool` (the `__` separator is load-bearing everywhere).
  Each tool gets a zod schema from the server's JSON schema plus a sha-256 schema digest for
  the approval audit trail. **Default: `needsApproval: () => true`**.
- **In plan mode MCP tools are blocked outright**, like write tools.
- **Two ingestion paths:** flat mode adapts each tool individually; Ratel mode registers the
  whole server into the BM25 catalog. Functionally identical afterward: MCP tools flow
  through the same approval gate, mutation queue, and BM25 filter.
- **OAuth 2.1** with a local callback server (`http://127.0.0.1/callback`) and a token store
  at `~/.reever/secrets/mcp/<server>.json` (dir `0o700`, file `0o600`). Failures are
  classified as auth vs network vs stdio so the user gets pointed to `/mcp`.

---

## 19. Telemetry & OTLP (`src/telemetry/`)

**Plain words:** two kinds of observability. **(1) Local metrics** — cost/tokens/tool
durations appended to a local file, always on, never leaves your machine. **(2) Trace
export (OTLP)** — if you configure an endpoint (Langfuse, Grafana Tempo...), every turn is
exported as a trace you can inspect; off by default and lazy-loaded, so "off" costs nothing.

**Local metrics (always on):** append to `~/.reever/metrics.jsonl` *and* mirror into the
session log. `SessionCostAccumulator` sums cost (only priced calls) and tokens, per model
and per source. `lastContextTokens` is a **gauge, not a sum** — so compaction visibly
"drops" the context fill instead of accumulating it.

**OTLP trace export (off, lazy-loaded):** each turn = one trace:
- an **AGENT** root span (per OpenInference `openinference.span.kind`),
- child **LLM** generation spans (`gen_ai.*` GenAI semantic conventions: model, tokens, cost),
- **TOOL** spans (duration, ok/error),
- **SUBAGENT** spans parented on the running task tool span.

A `session.id` links all turns of a conversation. **Content capture is opt-in
(`captureContent`)** — by default only metadata leaves the process: no message bodies, tool
args, or results.

Implementation gotcha worth naming: **no `context.with()`** — because hook observers are
detached async and tools run under `Promise.all`, the exporter keeps explicit
`Map<id, Span>` tables and parents spans *explicitly*. OTel is lazy-imported only when an
endpoint is configured — "zero cost when off."

---

## 20. Session persistence (`src/session/log.ts`)

**Plain words:** every session is an append-only log file (JSONL). You can quit the app and
resume later — including after a crash. Safety comes from *synchronous* writes: each event
is flushed to disk before the next thing happens, so not even a hard kill loses data.

- Append-only **JSONL** at `~/.reever/sessions/<id>.jsonl`; id = base36 timestamp + 4 random chars.
- **Synchronous appends** — the write completes before the call returns, so a crash can't
  drop a tool result mid-turn.
- **Resume correctness:** on load, if the log has no `session_completed` tail marker (i.e. a
  crash/interrupt), `repairDanglingToolCalls` **synthesizes `[interrupted — no result
  recorded]` results** for any tool call without a matching result — otherwise the next
  provider call would fail with "Tool results are missing". This is the crux of crash-safety.
- `replaySessionMeta` re-binds worktree isolation; `replayCheckpoints` restores the
  `/restore` list; `rebuildSessionCost` re-seeds the cost accumulator so the TUI header is
  accurate after resume.
- `resolveStartupSessionId` reuses the newest *zero-turn* session for the same cwd — re-run
  reever in a directory and it picks up where you left off.

---

## 21. Configuration (`src/config/config.ts`)

**Plain words:** one file — `~/.reever/config.json` — deep-merged over built-in defaults.
Anything you don't set, you get a sensible default for. You can edit most of it live from
the TUI (`/settings`, `/model`, `/providers`).

- **Deep merge:** user values win, recursively, over `DEFAULT_CONFIG`; arrays are replaced
  wholesale.
- **Defaults:** provider openrouter, approval `normal`, subagent `shared`/`maxParallel: 4`,
  agent `maxTurns: 25`/`maxToolCalls: 50`, Ratel enabled, telemetry on, OTLP off. Ships a
  `pricing` table (~25 public models' input/output/cache per-million-token rates) so cost is
  computed without an API call.
- **Migrations:** legacy config layouts (old `models.roles` maps, old picker lists) are
  detected and normalized onto the current format.
- **Atomic writes:** every save is tmp+rename, and every save clears the in-memory cache so
  the next read is fresh. Tests point `HOME` at a temp dir to isolate config.
- **"Sensible defaults" is a stated design principle** (SPEC §2.1): default provider, default
  models per provider, config-in-TUI.

---

## 22. Hooks (`src/hooks/`)

**Plain words:** hooks are the event listeners of the agent — like middleware. They can be
bolted on to *intercept* life events: before a tool runs (approve it, block it, rewrite its
arguments), after a tool runs (rewrite its output), before the prompt is sent (inject
context), or at session start/end.

The typed slots:

- `before_tool {id, name, args}` → `{block, reason} | {args}` — can block *or rewrite* args.
  Handlers run in registration order; the first `block` wins; rewritten args feed the next
  handler.
- `after_tool {name, args, output, isError}` → `{output}` — can rewrite a tool's output.
- `before_prompt {messages, model}` → `{messages}` — can rewrite the prompt.
- `before_compact`, `session_start`, `session_end` (void).

**Order of `installCoreHooks`:** approval-gate → delegate-read-gate → rtk-rewrite →
prompt-inject → todo-inject → propose-todo → skill-inject → symbol-index → read-staleness.
Meaning: **the approval gate runs before everything else.**

Two dispatch modes: observers run **fire-and-forget** (`Promise.resolve().then(fn)`) unless
`strictObservers`; telemetry is always non-strict so a metrics bug can never block the agent loop.

**Real hook examples:**
- **approval-gate** — enforces the three modes (§10).
- **delegate-read-gate** — blocks broad reads of big files (§12).
- **rtk-rewrite** — rewrites `bash` commands (git/ls/cat/grep/tsc/jest/vitest/docker/npm/yarn…)
  to prepend `rtk` (a tool-caching shell) when it's installed.
- **prompt-inject** — injects environment info + project instructions into the prompt.
- **propose-todo** — relays a child's `todo_proposal` to the parent.
- **read-staleness** — warns/blocks edits to files that changed since last read (§9).

---

## 23. TUI architecture (`src/tui/`)

**Plain words:** the loop is the brain, the TUI is the display. A **`SessionController`**
sits between them as a pure state machine (loop events in → view state out), and a single
SolidJS `App` component tree renders it: past turns, the live turn, header, footer, todo
sidebar, command palettes, and approval/question dialogs.

- **Data flow:** you type → `runTurn` pushes your message, writes it to the JSONL log, tells
  the controller a turn started, and runs `runLoop`. Every stream delta and tool event fires
  hooks (drives the UI) and an onEvent (persists to the log).
- **Render coalescing (three real performance bugs, solved):**
  1. **Microtask-deferred listener dispatch** — events fire *mid-render*; Solid crashes on
     "depends on itself in the same turn", so listeners dispatch in `queueMicrotask`.
  2. **16ms streaming throttle** — re-rendering on every text delta exhausted OpenTUI's
     native `TextBufferView` pool ("Failed to create TextBufferView"); deltas are throttled
     to ~one render per frame.
  3. **Approval/question FIFO queues** — parallel tool calls can fire several approval
     dialogs at once; one modal shows at a time, head-of-line resolution.
- **Terminal hygiene:** the first frame sets the terminal's colors (OSC 10/11) so the
  emulator padding matches the warm cream/dark-ink theme; pre-input handlers swallow stray
  terminal capability probes; `process.exit(0)` after teardown because the renderer leaves
  native handles alive.

---

## 24. Build pipeline (`scripts/build.mjs`)

**Plain words:** a straightforward compile step. Walk `src`, skip tests, run Babel:

- **TSX** files get the **Solid "universal" preset** + TypeScript preset (aliasing
  `@opentui/solid`).
- **Plain TS** gets the TypeScript preset only.
- Output goes to `dist/` (cleared first); `bin` points at `dist/cli.js`.

`bunfig.toml` applies the SolidJS preload transform to `src/**/*.ts*` for dev runs — which is
why dev/source runs need Bun and the repo directory.

---

## 25. Design decisions & trade-offs (interview talking points)

1. **Safety by default.** File writes and shell commands always prompt (normal/allow-all/plan).
   Plan mode *blocks* writes and all MCP tools instead of prompting — a strict "read-only" promise.
2. **Cheap where it counts (two-model split).** The expensive model reasons; `delegate_read`
   and compaction use a cheap model. Side-path calls are labeled (`source: "compaction"` /
   `"delegate_read"`) in telemetry, so cost is attributable.
3. **Shadow-git undo > plain git undo.** Snapshots capture every change — *including bash* —
   and restore is itself reversible (pre-restore safety snapshot).
4. **BM25 per-turn tool filtering.** Competitors use static allow/deny lists; Reever ranks
   tools per turn, cutting tokens and enabling A/B testing.
5. **Estimate-or-measure token accounting (max of known/estimated).** A pragmatic correctness
   fix: neither a stale provider count nor a rough estimate can hide a window overflow.
6. **Verifiable parallelism via per-path locks.** "Parallel tools" = a real per-file
   read/write FIFO queue, not naive `Promise.all` — with deadlock-proof ordering and a
   conservative bash-command parser for lock inference.
7. **Floor + escalate isolation.** Subagent isolation only ever gets stronger; parallel
   mutating children are lifted to worktree isolation automatically.
8. **Event-driven headless loop + reactive UI.** One decision powers headless mode, demos,
   subagents, telemetry, and the TUI from a single code path.
9. **Observability by default.** Local metrics always on; OTLP opt-in with content capture
   strictly off by default (privacy-preserving).
10. **Best-effort everywhere.** Telemetry never throws into the loop; compaction failure is
    non-fatal; export failure never stalls the agent. Resilience is a first-class property.

---

## 26. Comparison to competitors (from README)

| | Reever | opencode | pi.dev | Claude Code |
|---|:---:|:---:|:---:|:---:|
| Per-turn BM25 tool ranking | ✅ | ❌ | ❌ | ❌ |
| OS-level sandbox (E2B) | ✅ | ❌ | ❌ | ❌ |
| `/undo` incl. bash-modified files | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Two-model cost split | ✅ | ❌ | ❌ | ✅ |
| Native OTLP (no plugin) | ✅ | ❌ | ❌ | ✅ |
| Parallel subagents (worktree-isolated) | ✅ | ❌ | ❌ | ✅ |
| MCP server support | ✅ | ✅ | ⚠️ | ✅ |
| Offline demo mode (`--faux`) | ✅ | ❌ | ❌ | ❌ |
| EU provider (Regolo) | ✅ | ❌ | ❌ | ❌ |
| Local / self-hosted models | ❌ | ✅ | ✅ | ❌ |
| LSP diagnostics fed back to model | ❌ | ✅ | ❌ | ❌ |

---

## 27. Likely interview questions (with short answers)

**Q: Walk me through how an agent turn works.**
A: The loop checks abort/maxTurns, evicts stale tool results, resolves the per-turn tool set
(Ratel BM25) and prompt (before_prompt hooks), checks compaction against the model's context
window, calls the provider via `streamAssistant` (which strips reasoning blocks), recovers
structured tool calls from free text if needed, validates each with zod (up to 2
self-correction rounds), then executes tools that may run in parallel under per-path
read/write locks, folding results back until the model stops calling tools or a `terminate`
result ends the loop.

**Q: How do you keep the context window from blowing up?**
A: Three layers: (1) per-turn eviction of stale large tool results, (2) pruning/capping
oversized tool results near the window, (3) LLM summarization of old turns using a *cheap*
model, with budgets that scale to the window size (issue #183) and a `max(known, estimated)`
token count so provider usage doesn't hide an overflow.

**Q: Why Bun and not Node?**
A: The TUI depends on Bun FFI and a SolidJS preload transform applied via `bunfig.toml`;
Bun is also the runtime for the build/dev pipeline and the background-jobs
process-group handling. The global `reever` shim exists precisely because the preload is
only honored inside the repo.

**Q: How does the edit tool handle imperfect `oldText` from the model?**
A: A chain of progressively fuzzier matchers (exact → line-trimmed → whitespace-normalized →
indentation-flexible → escape-normalized → Levenshtein ≤20% → middle-out similarity ≥0.8),
each required to be *unique*; ambiguity yields null, not a guess. On total failure an
`EditMismatchError` with the tried matchers and closest candidate is fed back to the model.

**Q: How is subagent isolation enforced?**
A: A ladder shared → worktree → sandbox with a "floor + escalate only" rule. Config sets the
floor; parallel mutating children are forced to at least worktree; sandbox runs an E2B cloud
VM seeded by a shallow git clone. Child changes are committed to a surviving branch and the
worktree directory removed.

**Q: What is the Ratel BM25 filter and why?**
A: Every turn, a BM25 retrieval pass ranks the full tool catalog (native + MCP + skills) and
exposes only pinned + top-K tools, plus `search_capabilities`/`invoke_tool` gateway tools. It
cuts per-turn token cost, reduces misuse, and is A/B-testable (`tool_pool=ratel` vs
`tool_pool=full`).

**Q: How does the mutation queue prevent dataraces between parallel tools?**
A: A per-path FIFO read/write lock. Reads wait on the last write; writes wait on the last
write plus all queued reads. Bash dependencies are inferred from a conservative parser of
the command string (redirects + read/write verb allowlists). Locks sort deterministically
(key, exclusive-first) so there's no deadlock.

**Q: Where does the cheap model earn its keep?**
A: Three places: `delegate_read` (read-heavy exploration distilled into a summary, cropped to
symbol-relevant ranges), compaction summarization, and the `explore` subagent preset. All bill
as side-path (`source:`) LLM calls in telemetry so cost is attributable.

**Q: How are sessions made resumable and crash-safe?**
A: Append-only JSONL, synchronous writes per event, a `session_completed` tail marker, and on
resume a repair pass that synthesizes `[interrupted — no result recorded]` results for
dangling tool calls so the next provider call has complete tool results.

**Q: What's the most interesting engineering problem you solved here?**
A: (Pick any) — OTel spans without `context.with()` (explicit span tables under detached async
hook dispatch), the fuzzy replacer chain uniqueness rules, window-scaled compaction budgets,
the per-path mutation queue with bash-command lock inference, or the ephemeral `commit-tree`
base ref for parallel worktree subagents.

**Q: What would you improve or do differently?**
A: Ideas grounded in the repo: wire the Ratel JSONL trace sink (`~/.reever/ratel-traces/<sessionId>.jsonl`
exists but is not wired — a documented "Gap 4"), add LSP diagnostics feeding back to the
model (a competitor feature the table shows as ❌), layer a real tokenizer onto compaction's
char-count estimate, and add caching of the OTLP transport across turns.

---

## 28. Key file reference map

| Topic | File |
|---|---|
| Agent loop | `src/agent/loop.ts` (`runLoop` :329) |
| Compaction | `src/agent/compaction.ts` (`shouldCompact` :186, `compactMessages` :567) |
| Mutation queue | `src/agent/mutation-queue.ts` |
| Bash lock inference | `src/agent/bash-mutation-paths.ts` |
| Subagent presets | `src/agent/presets.ts`, `src/agent/isolation.ts` |
| Streaming transport | `src/provider/stream.ts` (`streamAssistant` :89, `toAiMessages` :12) |
| Provider registry | `src/provider/registry.ts` |
| Slot resolution | `src/config/models.ts:22` |
| Context window | `src/provider/context-window.ts:33` |
| Tool contract / registry | `src/tools/types.ts`, `src/tools/registry.ts` |
| Edit fuzzy chain | `src/edit/replacers.ts` (chain :433) |
| Approval policy | `src/approval/policy.ts`, `src/hooks/approval-gate.ts` |
| delegate_read | `src/delegate/delegate-read.ts`, `src/hooks/delegate-read-gate.ts` |
| Checkpoints | `src/checkpoint/tracker.ts`, `src/checkpoint/manager.ts` |
| Ratel BM25 | `src/ratel/catalog.ts`, `src/ratel/session.ts` |
| Symbol index | `src/symbols/index.ts`, `src/symbols/cache.ts`, `src/symbols/service.ts` |
| MCP | `src/mcp/loader.ts`, `src/mcp/adapter.ts`, `src/mcp/client.ts` |
| Telemetry | `src/telemetry/install.ts`, `src/telemetry/accumulator.ts`, `src/telemetry/otel/exporter.ts` |
| Session log | `src/session/log.ts` |
| Config | `src/config/config.ts` |
| Hooks | `src/hooks/registry.ts`, `src/hooks/install.ts` |
| TUI session orchestration | `src/tui/session.ts` (`runTurn` :649) |
| TUI state machine | `src/tui/controller.ts` |
| CLI dispatch | `src/main.ts:37`, `src/cli-args.ts` |
| Build | `scripts/build.mjs` |
| Design + phased plan | `SPEC.md` |

---

*Last generated from source exploration. File/line numbers refer to the repo at the time of
writing; verify before quoting verbatim in an interview.*