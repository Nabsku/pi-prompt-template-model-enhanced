<p>
  <img src="banner.png" alt="pi-prompt-template-model" width="1100">
</p>

# Prompt Template Model Extension

Adds `model`, `skill`, and `thinking` frontmatter to pi prompt templates. Define slash commands that switch to the right model, set a thinking level, inject skill context, and auto-restore your session when done.

```
/debug-python my code crashes
  → switches to Sonnet, loads tmux skill, agent responds
  → restores your previous model when finished
```

## Why?

Each prompt template becomes a self-contained agent mode. `/quick-debug` spins up a cheap model with REPL skills. `/deep-analysis` brings in extended thinking with refactoring expertise. When the command finishes, you're back to your daily driver without touching anything.

No more manually switching models, no hoping the agent picks up on the right skill. You define the configuration once, and the slash command handles the rest.

## Installation

```bash
pi install npm:pi-prompt-template-model
```

Restart pi to load the extension.

For delegated subagent execution (`subagent` and `inheritContext` frontmatter), install [pi-subagents](https://github.com/nicobailon/pi-subagents/) separately:

```bash
pi install npm:pi-subagents
```

pi-subagents is optional — everything else works without it. Using `subagent: true` without it installed fails fast with a clear error.

## Quick Start

Add `model` and optionally `skill` to any prompt template:

```markdown
---
description: Debug Python in tmux REPL
model: claude-sonnet-4-20250514
skill: tmux
---
Start a Python REPL session and help me debug: $@
```

Run `/debug-python some issue` and the agent switches to Sonnet, receives the tmux skill as context, and starts working. When it finishes, your previous model is restored.

## Frontmatter Reference

All fields are optional. Templates that don't use any extension features (no `model`, `skill`, `thinking`, etc.) are left to pi's default prompt loader.

### Core Fields

| Field | Default | What it does |
|-------|---------|--------------|
| `model` | current session model | Which model to use. Accepts a single model, a `provider/model-id` pair, or a comma-separated fallback list (see [Model Format](#model-format)). Ignored when `chain` is set. |
| `skill` | — | Injects a skill's content as a context message before the agent handles your task. No extra round-trip — the agent gets the expertise immediately. See [Skill Resolution](#skill-resolution). |
| `thinking` | — | Thinking level for the model: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. |
| `description` | — | Short text shown next to the command in autocomplete. |
| `chain` | — | Declares a reusable pipeline of templates (`step -> step`). When set, the body is ignored. See [Chain Templates](#chain-templates). |
| `chainContext` | — | Chain templates only. Set to `summary` so delegated steps receive a compact summary of what previous steps did. Steps with `inheritContext: true` are excluded. See [Chain context for delegated steps](#chain-context-for-delegated-steps). |

### Execution Control

| Field | Default | What it does |
|-------|---------|--------------|
| `restore` | `true` | After the command finishes, switch back to whatever model and thinking level were active before. Set `false` to stay on the new model. |
| `loop` | — | Run this template multiple times by default (1–999, `true`, or `unlimited`). CLI `--loop` overrides this. See [Loop Execution](#loop-execution). |
| `rotate` | `false` | When `true` and looping, cycle through models in the `model` list instead of using fallback semantics. Thinking levels can also be comma-separated to pair with each model. |
| `fresh` | `false` | When looping, collapse the conversation between iterations to a brief summary instead of carrying the full context forward. Saves tokens on long loops. |
| `converge` | `true` | When looping, stop early if an iteration makes no file changes. Set `false` to always run every iteration. |

### Delegation

| Field | Default | What it does |
|-------|---------|--------------|
| `subagent` | — | Delegate execution to a subagent instead of running in the current session. `true` uses the default `delegate` agent; a string value like `reviewer` targets that specific agent. Requires [pi-subagents](https://github.com/nicobailon/pi-subagents/). |
| `inheritContext` | `false` | Only meaningful with `subagent`. When `true`, the subagent receives a fork of the current conversation context instead of starting fresh. |
| `cwd` | — | Working directory for delegated subagent subprocesses. Must be an absolute path (`~/...` is expanded). Valid with `subagent`, and also on chain templates as the default cwd for delegated steps. |

## Model Format

```yaml
model: claude-sonnet-4-20250514            # bare model ID — auto-selects provider
model: anthropic/claude-sonnet-4-20250514  # explicit provider/model
```

Bare model IDs resolve through a provider priority list: `openai-codex` → `anthropic` → `github-copilot` → `openrouter`. The first provider with valid auth wins.

For explicit control:

```yaml
model: anthropic/claude-opus-4-5        # Direct Anthropic API
model: openai-codex/gpt-5.2             # Via Codex subscription (OAuth)
model: github-copilot/claude-opus-4-5   # Via Copilot subscription
model: openrouter/claude-opus-4-5       # Via OpenRouter
model: openai/gpt-5.2                   # Direct OpenAI API
```

### Model Fallback

Comma-separated lists try each model in order:

```yaml
model: claude-haiku-4-5, claude-sonnet-4-20250514
```

Haiku is tried first. If it can't be found or has no API key, Sonnet is used instead. If the session is already on one of the listed models, that one is kept without switching. When every candidate fails, you get a single error listing what was tried.

You can mix bare IDs and explicit provider specs:

```yaml
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5, claude-sonnet-4-20250514
```

## Skills

Normally, pi lists available skills in the system prompt, the agent reads your task, decides which skill it needs, and loads it with the read tool. That's an extra round-trip, and the agent might not pick the right one.

The `skill` field bypasses all of that:

```markdown
---
description: Browser testing mode
model: claude-sonnet-4-20250514
skill: surf
---
$@
```

The skill content is injected as a context message before the agent processes your task. No decision-making, no tool call — immediate expertise. If the skill file can't be found, the command fails fast instead of running without it.

### Skill Resolution

The `skill` field accepts a bare name or a `skill:` prefix:

```yaml
skill: tmux
skill: skill:tmux    # equivalent
```

Resolution order:

1. Registered skill commands from `pi.getCommands()` (source: `"skill"`)
2. `<cwd>/.pi/skills/<name>/SKILL.md` or `<cwd>/.pi/skills/<name>.md`
3. `.agents/skills` in the current directory and ancestors (up to the git root)
4. `~/.pi/agent/skills/<name>/SKILL.md` or `~/.pi/agent/skills/<name>.md`
5. `~/.agents/skills/<name>/SKILL.md` or `~/.agents/skills/<name>.md`

## Inline Model Conditionals

Prompt bodies can include sections that only render for specific models:

```markdown
---
description: Cross-model code review
model: claude-haiku-4-5, claude-sonnet-4-20250514
---
Summarize the change first.

<if-model is="claude-haiku-4-5">
Keep the answer brief and cost-conscious.
<else>
Do a deeper pass and call out subtle risks.
</if-model>
```

Conditionals evaluate against whichever model actually runs — after fallback resolution for multi-model templates, or against the session model when `model` is omitted.

The `is` attribute supports exact model IDs, `provider/model-id` pairs, provider wildcards like `anthropic/*`, and comma-separated combinations:

```markdown
<if-model is="anthropic/*">Anthropic-specific instructions</if-model>
<if-model is="openai/gpt-5.2, anthropic/*">Either OpenAI or Anthropic</if-model>
```

`<else>` is the fallback branch. Nested `<if-model>` blocks work.

## Argument Substitution

Prompt bodies support placeholders that expand to the arguments passed after the command name:

| Placeholder | Expands to |
|-------------|------------|
| `$1`, `$2`, ... | The Nth argument (1-indexed) |
| `$@` or `@$` or `$ARGUMENTS` | All arguments joined with spaces |
| `${@:N}` | All arguments from position N onward |
| `${@:N:L}` | L arguments starting from position N |

```markdown
---
model: claude-sonnet-4-20250514
---
Analyze $1 focusing on $2. Additional context: ${@:3}
```

`/analyze src/main.ts performance edge cases error handling` expands `$1` to `src/main.ts`, `$2` to `performance`, and `${@:3}` to `edge cases error handling`.

## Delegated Subagent Execution

Instead of running a prompt in the current session, you can hand it off to a subagent:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: true
---
Review and simplify this code: $@
```

`subagent: true` delegates to the default `delegate` agent. To target a specific agent:

```markdown
---
model: anthropic/claude-sonnet-4-20250514
subagent: reviewer
inheritContext: true
---
Audit this diff for correctness and edge cases: $@
```

`inheritContext: true` forks the current conversation so the subagent has full context. Without it, the subagent starts fresh.

To force a subagent into a specific working directory, add `cwd`:

```markdown
---
model: claude-sonnet-4-20250514
subagent: browser-screenshoter
cwd: /tmp/screenshots
---
Use url in the prompt to take screenshot: $@
```

The subagent process runs with `/tmp/screenshots` as its working directory. Paths must be absolute (`~/...` is expanded). The directory is validated at execution time.

During execution, a live progress widget appears above the editor showing elapsed time, tool count, token usage, and the current tool. When the run finishes, it's replaced by a completion card with the task preview, tool call history, output, and usage stats.

You can override delegation at runtime per invocation with `--subagent`, `--subagent=<name>`, `--subagent:<name>`, or `--cwd=<path>`. `--cwd=<path>` must be absolute after optional `~/...` expansion. Runtime flags take precedence for that invocation only.

Two additional runtime flags work for any prompt (not just delegated ones):

- `--model=provider/model-id` — override the template's `model` for this invocation. Works with single execution, loops, and delegation.
- `--fork` — run with `inheritContext` (forked context). Implies `--subagent` if not already set.

```
/double-check --model=anthropic/claude-opus-4-6
/double-check --fork --subagent:worker
/deslop --model=openai/gpt-5.4 --loop 3
```

## Loop Execution

Run a template multiple times with `--loop`:

```
/deslop --loop 5
/deslop --loop=5
/deslop --loop          # unlimited — runs until convergence or cap (999)
```

You can also set a default in frontmatter. CLI `--loop` always overrides:

```markdown
---
loop: 5
---
```

Use `loop: unlimited` (or `loop: true`) for open-ended loops that run until convergence, user interrupt, or the safety cap of 999 iterations:

```markdown
---
loop: unlimited
converge: false
fresh: true
subagent: true
---
```

### How looping works

Each iteration runs the same prompt. By default, context accumulates — iteration 3 sees the full conversation from iterations 1 and 2 and builds on that work.

**Convergence**: If an iteration makes no file changes (no `write` or `edit` tool calls), the loop stops early. This is on by default. Use `--no-converge` or `converge: false` to always run every iteration.

**Fresh context**: Add `--fresh` (or `fresh: true` in frontmatter) to collapse the conversation between iterations. Each iteration gets a clean slate with only brief summaries of what previous iterations did. Good for long loops where accumulated context would blow up the token count.

**Status**: The TUI status bar shows `loop 2/5` during execution.

Model, thinking level, and skill are maintained throughout. If `restore: true` (the default), everything is restored after the final iteration.

## Model Rotation

`rotate: true` turns a comma-separated `model` list from a fallback chain into a cycling list. Each loop iteration uses the next model in the list, wrapping around:

```markdown
---
model: claude-opus-4-6, gpt-5.4, gpt-5.3-codex
thinking: high, xhigh, off
loop: 9
rotate: true
fresh: true
---
Review and fix issues in this codebase.
```

Iteration 1 runs Opus + `high`, iteration 2 runs GPT-5.4 + `xhigh`, iteration 3 runs Codex + `off`, then wraps back to Opus. The status bar shows which model is active: `loop 2/9 · gpt-5.4 xhigh`.

This is especially useful for [ralph-style loops](https://ghuntley.com/ralph/) where different models catch different things. The `subagent` examples below require [pi-subagents](https://github.com/nicobailon/pi-subagents/). A single-model ralph loop that delegates with fresh context each iteration:

```markdown
---
model: claude-sonnet-4-20250514
subagent: true
inheritContext: true
loop: 5
fresh: true
---
Simplify this code: $@
```

Add `rotate` and multiple models to cycle different perspectives on each pass:

```markdown
---
model: claude-opus-4-6, gpt-5.4, gpt-5.3-codex
thinking: xhigh, high, high
loop: 9
rotate: true
fresh: true
subagent: true
---
Review and fix issues in this codebase.
```

Each iteration gets fresh context, a different model, and its own thinking level. Convergence stops the loop when an iteration makes no file changes — use `converge: false` to guarantee every model gets at least one shot.

`thinking` pairing with `rotate: true`:

- Single value (`thinking: high`) — applied to every model.
- Comma-separated (`thinking: high, xhigh, off`) — positional, must match the number of models.
- Omitted — each iteration inherits the session default.

Without `loop`, `rotate` has no effect and comma-separated `model` keeps normal fallback behavior.

## Chaining Templates

`/chain-prompts` runs multiple templates in sequence. Each step uses its own model, skill, and thinking level, while conversation context flows between them:

```
/chain-prompts analyze-code -> fix-plan -> summarize -- src/main.ts
```

This runs `analyze-code`, then `fix-plan` (which sees the analysis), then `summarize`. The ` -- ` separator marks shared args — everything after it is passed to each step as `$@`, unless a step has its own inline args:

```
/chain-prompts analyze-code "error handling" -> fix-plan -> summarize -- src/main.ts
```

Step 1 gets `"error handling"` as its args. Steps 2 and 3 fall back to the shared `"src/main.ts"`.

The chain captures your model and thinking level before starting and restores them when finished (or if any step fails).

### Chain Templates

For reusable pipelines, put the chain in frontmatter:

```markdown
---
description: Review then clean up
chain: double-check --loop 2 -> deslop --loop 2
---
```

This registers the file's name as a command that runs `double-check` twice, then `deslop` twice. Per-step `--loop N` repeats that step before moving to the next, with per-step convergence (stops early if no changes, unless the step's template has `converge: false`).

Chain declarations also support parallel groups with `parallel(...)`:

```markdown
---
chain: parallel(scan-frontend, scan-backend) -> consolidate
---
```

Each entry inside `parallel(...)` runs as a delegated subagent task concurrently. Parallel entries can include per-step args (for example `parallel(scan-frontend, scan-backend "auth")`), but per-step `--loop` is not supported inside parallel groups. Nested `parallel(...)` is rejected. Parallel entries must be delegated templates (`subagent: ...` or runtime `--subagent` override), and all entries in the same parallel group must resolve to the same `inheritContext` mode and `cwd`.

Steps with a `model` field use their own model. Steps without one inherit a snapshot of whatever model was active when the chain started — not the previous step's model. This keeps behavior deterministic regardless of what earlier steps do.

Chain templates support `loop`, `fresh`, `converge`, `restore`, and `cwd` in their frontmatter for controlling the overall execution:

```markdown
---
chain: analyze -> fix
loop: 3
fresh: true
converge: false
---
```

This runs the full analyze → fix chain 3 times, with fresh context between iterations and no early stopping. Chain nesting is not supported — steps can't reference other chain templates.

When a chain template sets `cwd`, it becomes the default delegated subprocess working directory for all delegated steps in that chain. Runtime `--cwd=<path>` overrides the chain template value.

### Chain context for delegated steps

Delegated chain steps start fresh — they don't see what earlier steps did. Chain context prepends a compact summary of previous steps to each delegated task so later steps can build on earlier work.

Enable it chain-wide with `chainContext: summary` in frontmatter or `--chain-context` on the CLI:

```markdown
---
chain: analyze -> fix
chainContext: summary
---
```

```
/chain-prompts analyze -> fix --chain-context
```

To enable it for a single step, attach `--with-context` to that step name:

```
/chain-prompts analyze -> reviewer --with-context -> summarize
```

Here only `reviewer` receives the summary of `analyze`. The `summarize` step does not.

Steps using `inheritContext: true` already fork the full parent conversation and skip the summary preamble. `--with-context` is not supported inside `parallel(...)` groups. When a chain uses `loop`, summaries reset each iteration.

### Parallel and looping from the CLI

Parallel groups work in `/chain-prompts` too:

```
/chain-prompts parallel(scan-fe, scan-be) -> review
```

Looping applies to the entire chain:

```
/chain-prompts analyze -> fix --loop 3
/chain-prompts analyze -> fix --loop 3 --fresh
/chain-prompts analyze -> fix --loop 3 --no-converge
/chain-prompts analyze -> fix --loop
```

Convergence applies across all steps in each iteration — if no step made file changes, the loop stops. Templates are re-read from disk between iterations, so edits take effect live.

## Agent Tool

The agent can invoke prompt templates itself via a `run-prompt` tool. It's off by default:

```
/prompt-tool on
```

Once enabled, the agent sees `run-prompt` in its tool list:

```
run-prompt({ command: "deslop --loop 5 --fresh" })
run-prompt({ command: "chain-prompts analyze -> fix --chain-context" })
run-prompt({ command: "chain-prompts analyze -> fix --loop 3" })
run-prompt({ command: "deslop --subagent" })
```

The tool queues the command for execution after the agent's current turn ends. All loop, chain, and convergence features work the same as slash commands.

You can add guidance to steer when the agent reaches for it:

```
/prompt-tool on Use run-prompt for iterative code improvement tasks
/prompt-tool guidance Use sparingly, only for multi-pass refinement
/prompt-tool guidance clear
/prompt-tool off
/prompt-tool                   # show current status
```

Config persists across sessions in `~/.pi/agent/prompt-template-model.json`.

## Autocomplete

Commands show their configuration in the autocomplete description:

```
/debug-python    Debug Python session [sonnet +tmux] (user)
/deep-analysis   Deep code analysis [sonnet high] (user)
/save-progress   Save progress doc [haiku|sonnet] (user)
/component       Create React component [sonnet] (user:frontend)
```

## Subdirectories

Organize prompts in subdirectories for namespacing:

```
~/.pi/agent/prompts/
├── quick.md                    → /quick (user)
├── debug-python.md             → /debug-python (user)
└── frontend/
    ├── component.md            → /component (user:frontend)
    └── hook.md                 → /hook (user:frontend)
```

The subdirectory shows as the source label in autocomplete. Command names are based on filename only. Duplicates within the same source layer are skipped with a warning, as are reserved names like `model`, `reload`, and `chain-prompts`.

## Print Mode

These commands work in `pi -p` too:

```bash
pi -p "/debug-python my code crashes on line 42"
```

The model switches, skill is injected, the agent responds, and output goes to stdout. Useful for scripting or piping.

## Examples

**Thinking levels** — max thinking for thorny analysis:

```markdown
---
description: Deep code analysis with extended thinking
model: claude-sonnet-4-20250514
thinking: high
---
Analyze this code thoroughly, considering edge cases and potential issues: $@
```

**Sticky mode switch** — switch models for the rest of the session:

```markdown
---
description: Switch to Haiku for this session
model: claude-haiku-4-5
restore: false
---
Switched to Haiku. How can I help?
```

**Cross-provider fallback** — try the same model on different providers:

```markdown
---
description: Quick analysis
model: anthropic/claude-haiku-4-5, openrouter/claude-haiku-4-5
---
$@
```

## Limitations

- Prompt files are reloaded on session start and whenever an extension-owned command runs. If you add a new prompt file mid-session, run any extension command (like `/chain-prompts`), start a new session, or reload pi to pick it up.
- Model restore state is in-memory. Closing pi mid-response loses it.
- In chains, model-less steps inherit the chain-start model snapshot, not the previous step's model. This is intentional for deterministic behavior.
- Delegated `subagent` prompts require [pi-subagents](https://github.com/nicobailon/pi-subagents/).
- `run-prompt` must be explicitly enabled with `/prompt-tool on`.
