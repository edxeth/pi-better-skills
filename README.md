# pi-better-skills

`pi-better-skills` improves pi's Agent Skills runtime behavior for skills that ship scripts, reference files, and dynamic prompt content.

The extension exists because many skills are authored as if their `SKILL.md` is the working directory. In practice, pi may be launched from anywhere, such as `/tmp` or a project root, so documented commands like `scripts/exa.sh ...` or references like `reference/troubleshooting.md` can fail unless the model manually resolves the path against the skill directory.

This extension makes those skill resources behave more like they do in Claude Code / OpenClaude-inspired skill runtimes.

## Features

### Skill-local base directory context

When a `SKILL.md` is read, the extension prepends a small skill-local context block, similar to Claude Code / OpenClaude:

```xml
<skill_context>
Base directory for this skill: /path/to/skill
Workspace directory: /path/to/workspace
Use $PI_SKILL_DIR for bundled skill files. Use $PI_WORKSPACE for workspace files.
</skill_context>
```

This is the primary way the model learns where the active skill lives. It is local to the skill content instead of being only global policy.

### XML-scoped system guidance

The extension also appends a small XML-scoped block to the system prompt:

```xml
<pi_better_skills>
  <path_policy>...</path_policy>
  <dynamic_skill_shell>...</dynamic_skill_shell>
</pi_better_skills>
```

This keeps the guidance visually bounded and easier for models to follow without turning it into free-floating prose.

### Skill-relative resource resolution

When a skill references files under common resource directories, the extension resolves them against the skill root only if the same relative path does not already exist under the current pi cwd. Project/cwd-relative files always take precedence.

Recognized resource directories:

- `scripts/`
- `reference/`
- `resources/`
- `assets/`
- `data/`
- `templates/`

Examples that are supported:

```bash
scripts/exa.sh search "query" 5
scripts/alphaxiv.sh search "agent skills" 8
```

```text
reference/troubleshooting.md
```

### cwd-local resource symlinks

On session start and resource discovery, the extension creates convenience symlinks from the current pi cwd back to skill resources when those target paths do not already exist.

For example, if pi is launched from `/tmp`, the extension may create:

```text
/tmp/scripts/exa.sh -> ~/.pi/agent/skills/exa/scripts/exa.sh
```

This lets model-emitted commands that follow a skill literally still work, even if pi was launched outside the skill directory.

Existing files are never overwritten. If the project already has `scripts/foo.sh`, that project script wins over any skill script with the same relative path.

### Sibling skill path handling

Composite skills sometimes reference sibling skills, for example:

```bash
../exa/scripts/exa.sh search "query" 10
../firecrawl/scripts/firecrawl.sh scrape "https://example.com"
```

If the same `../exa/scripts/exa.sh` path exists relative to the current pi cwd, it is left alone. Otherwise, pi's current `tool_call` extension API can block tool execution and mutate arguments, but mutation is not reliable for this case in all observed runs. Therefore, `pi-better-skills` blocks unresolved sibling-skill commands and returns a clear retry instruction with the absolute resolved command.

The model then retries with the correct absolute path.

### Dynamic shell placeholders in `SKILL.md`

The extension supports Claude Code-style dynamic prompt placeholders inside trusted `SKILL.md` files.

Inline syntax:

```md
Current branch: !`git branch --show-current`
```

Fenced syntax:

````md
Changed files:
```!
git diff --name-only
```
````

When the model reads a trusted `SKILL.md`, the extension replaces those placeholders with command output before the model sees the content.

Dynamic shell commands run with:

- `cwd` set to the current pi workspace
- `PI_SKILL_DIR` set to the skill directory
- `PI_WORKSPACE` set to the current pi workspace

The extension also supports `${PI_SKILL_DIR}` and `${PI_WORKSPACE}` substitution inside dynamic command text.

Use only these extension-provided names:

- `PI_SKILL_DIR` for bundled skill files
- `PI_WORKSPACE` for the current project/workspace

### Useful path/environment variables

| Variable | Provided by | Meaning | Use it for |
|---|---|---|---|
| `$PI_SKILL_DIR` | `pi-better-skills` | directory containing the active `SKILL.md` | bundled skill scripts/resources |
| `$PI_WORKSPACE` | `pi-better-skills` | current pi workspace/session cwd | project files from dynamic skill shell |
| `$PWD` | shell | current shell working directory, changes after `cd` | "where this command is right now" |
| `$HOME` | system/shell | user home directory | user config and global files |
| `$PATH` | system/shell | executable lookup path | invoking installed CLIs by name |
| `$SHELL` | system/shell | user's shell path/name when set | shell-aware diagnostics only |
| `$USER` | system/shell | current username when set | user-scoped paths/logging |
| `$TMPDIR` | system/shell, optional | preferred temp directory when set | temporary files; fall back to `/tmp` if unset |

Examples:

```bash
# Skill-bundled helper
$PI_SKILL_DIR/scripts/exa.sh search "agent skills" 5

# Workspace/project helper
$PI_WORKSPACE/scripts/build.sh

# Current shell cwd, which may differ after cd
pwd && echo "$PWD"

# User-global config/resource
ls "$HOME/.pi/agent/skills"
```

For normal bash/read tool calls, `PI_SKILL_DIR` is resolved from the most recently read `SKILL.md`. If no active skill is known yet, read the relevant `SKILL.md` first or use an absolute skill path.

Safety limits:

- command timeout: 30 seconds
- max output included in prompt: 50,000 characters
- project-local dynamic shell is opt-in only

## Trust model

Dynamic shell execution is enabled by default only for user/global skill roots:

- `~/.pi/agent/skills`
- `~/.agents/skills`

Project-local skills under `.pi/skills` can come from cloned repositories, so their dynamic shell placeholders are skipped by default.

To opt in for project-local skill shell execution:

```zsh
export PI_TRUST_PROJECT_SKILL_SHELL=1
```

This is intentionally explicit because a repository-controlled `SKILL.md` could otherwise run arbitrary shell commands just by being read.

## Claude Code / OpenClaude inspiration

Claude Code-style skills include two useful runtime ideas:

1. Skill content knows its base directory.
2. Skill markdown can inject dynamic shell output with `!\`command\`` / fenced shell blocks.

OpenClaude's skill loader similarly stores a skill root, injects base-directory context, substitutes its own skill-directory variable, and executes shell placeholders when skill content is loaded. `pi-better-skills` intentionally uses pi-specific names instead: `PI_SKILL_DIR` and `PI_WORKSPACE`.

`pi-better-skills` brings those ergonomics to pi without forking pi or patching pi's installed node modules. It is implemented entirely as a pi extension.

## Why this exists

Without this extension, skills that document commands like this are fragile:

```bash
scripts/exa.sh search "latest LLM research" 5
```

They only work if the agent happens to run from the skill directory. But pi normally runs from the user's project directory, or wherever it was launched. That mismatch causes unnecessary failures and model recovery loops.

`pi-better-skills` makes skill-authored resources portable across cwd, while preserving ordinary project/cwd-relative file and script behavior and keeping project-local shell execution behind an explicit trust flag.

## Installation

Folder-style extension location:

```text
~/.pi/agent/extensions/pi-better-skills/index.ts
```

pi auto-discovers this folder-style extension. In an existing interactive pi session, run:

```text
/reload
```

New pi sessions load it automatically.
