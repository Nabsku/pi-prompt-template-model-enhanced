---
name: prompt-templates
description: |
  Write, manage, and run custom Pi prompt templates (slash commands). Create reusable
  prompts with model selection, deterministic pre-steps, subagent delegation, chains,
  loops, and conditional content. Templates live as markdown files in ~/.pi/agent/prompts
  and register as /commands.
---

# Prompt Templates Skill

Use this skill when you need to create, edit, or understand custom prompt templates
for Pi. Prompt templates are markdown files that register as slash commands and can
include structured frontmatter for model selection, execution flow, and conditional
content.

## Quick Start

Create a file at `~/.pi/agent/prompts/my-command.md`:

```markdown
---
model: claude-sonnet-4-20250514
---
Your prompt body here. Use $@ to capture user arguments.
```

Restart Pi, then type `/my-command` to run it.

## Frontmatter Reference

### Model Selection

```yaml
---
model: claude-sonnet-4-20250514   # specific model
model: claude-opus-4, gpt-5.4     # rotate between models
model: claude-*                   # wildcard match
---
```

Omit `model:` to inherit the currently active model.

### Deterministic Steps (Pre-LLM Execution)

Run a command or script before the LLM turn. The model only sees the output when you want it to.

**Shorthand form** — put `run`, `script`, `handoff`, `timeout`, `cwd`, `env`, and `nonInteractive` directly in frontmatter:

```yaml
---
run: git status --short
handoff: on-failure
timeout: 30000
---
Something looks wrong. Diagnose and suggest a fix.
```

**Nested form** — group under `deterministic:`:

```yaml
---
deterministic:
  run: ./deploy.sh
  handoff: never
  timeout: 120000
  env:
    CI: "1"
---
```

**Handoff values:**
- `never` — run, show result, done. No LLM turn.
- `on-failure` — only hand off to model if command exits non-zero
- `on-success` — only hand off if command exits zero
- `always` — always hand result to model after the run

**Structured command form** — explicit args instead of shell string:

```yaml
---
deterministic:
  run:
    command: git
    args: [status, --short]
  handoff: always
---
```

**Script form** — run a file with optional args:

```yaml
---
deterministic:
  script:
    path: ./scripts/ship.sh
    args: [--fast]
  handoff: always
  cwd: ~/src/my-repo
---
```

Do not mix top-level shorthand with nested `deterministic:` in the same prompt.

### Subagent Delegation

Delegate to another Pi agent instead of running inline:

```yaml
---
model: claude-sonnet-4-20250514
subagent: delegate
inheritContext: true   # optional: fork or preserve context
cwd: /path/to/target   # optional: run in different directory
---
```

Use `subagent: true` as shorthand for `subagent: delegate`.

### Loops

Run the prompt multiple times:

```yaml
---
model: claude-sonnet-4-20250514
loop: 5               # run 5 times
converge: true        # stop early if no changes (default)
---
```

CLI override: `/my-command --loop 5`

### Chains

Reference multiple templates in sequence:

```yaml
---
model: claude-sonnet-4-20250514
---
$@
```

Then invoke: `/chain-prompts analyze -> fix -> test`

### Conditional Content

Show different prompt content based on model:

```markdown
#if-model claude-*
Use Claude's XML-style thinking tags.
#else
Use standard reasoning.
#endif
```

### Best-of-N Compare

Run multiple workers in parallel and review:

```yaml
---
description: Best-of-N code review
bestOfN:
  worktree: true
  workers:
    - model: gpt-5.3-codex-spark:low
      count: 3
    - model: gpt-5.4-mini:high
      count: 2
  reviewers:
    - model: claude-sonnet-4-20250514:medium
      count: 2
---
$@
```

## Template Body

Everything after the second `---` is the prompt body.

**Argument substitution:**
- `$@` — all user arguments
- `$1`, `$2` — positional arguments
- `$1-` — argument 1 and everything after

Example:
```markdown
---
model: claude-sonnet-4-20250514
---
Review the code in $1. Focus on $2.
```

Usage: `/review src/auth.ts security`

## File Locations

Templates are discovered from (in priority order):

1. `~/.pi/agent/prompts/` — user prompts (highest priority)
2. Project `.pi/prompts/` — project-specific prompts
3. Extension `examples/` — shipped examples

## Command Descriptions

The `description:` field appears in the slash-command picker. Keep it concise:

```yaml
---
description: Review code for security issues
---
```

## Common Patterns

### Pattern 1: Validation Gate

Run checks first, only involve the model on failure:

```yaml
---
run: npm run typecheck && npm run test -- --run
handoff: on-failure
timeout: 60000
---
The validation failed. Read the output above, identify the root cause, and suggest the smallest fix.
```

### Pattern 2: Deploy Without LLM

Run deploy script, show result, done:

```yaml
---
run: ./scripts/deploy.sh
handoff: never
timeout: 120000
---
```

### Pattern 3: Status → Interpretation

Always hand off so the model interprets:

```yaml
---
run: git status --short
handoff: always
---
Summarize the current repository state. Call out anything risky.
```

### Pattern 4: Multi-Model Review

Use best-of-N to get multiple perspectives:

```yaml
---
description: Security review with multiple models
bestOfN:
  workers:
    - model: claude-opus-4:high
    - model: gpt-5.4:high
  reviewers:
    - model: claude-sonnet-4-20250514:medium
---
Review this code for security vulnerabilities. Check for:
- SQL injection
- XSS
- Auth bypasses
- Unsafe deserialization
```

## Runtime Flags

Override frontmatter at invocation:

```bash
/command --model gpt-5.4          # override model
/command --subagent                # delegate even if not in template
/command --loop 5                  # run 5 times
/command --fresh                   # reset context each iteration
/command --no-converge             # run all iterations
/command --cwd /path/to/dir        # run in different directory
```

## Important Constraints

- Deterministic steps only work on single prompts (v1). No chains, loops, or subagents combined.
- Chain templates cannot reference other chain templates (no nesting).
- `bestOfN` requires `worktree: true` if using `finalApplier`.
- `--loop` on chains applies per-step, not to the whole chain.

## Troubleshooting

### Template not appearing

1. Check filename: must end in `.md`
2. Check location: `~/.pi/agent/prompts/` or project `.pi/prompts/`
3. Restart Pi after adding new files
4. Check diagnostics: invalid frontmatter shows warnings in the UI

### Deterministic step fails silently

- Check `timeout` — default is none, but long commands may need one
- Check `cwd` — relative paths resolve from prompt file first
- Use `nonInteractive: false` if the command needs a normal TTY

### Model not switching

- Explicit `model:` in frontmatter overrides current model
- Omit `model:` to inherit current model
- Check that the model identifier is valid
