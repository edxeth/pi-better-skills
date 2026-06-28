# pi-better-skills

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

`pi-better-skills` makes Pi skills resolve their bundled files from the skill directory, not from whatever project you are working in.

Pi implements the [Agent Skills standard](https://agentskills.io): small capability packages with a `SKILL.md`, helper scripts, reference files, templates, and assets. Many skills assume relative paths start at the skill folder. Pi runs tools from your current workspace, so a skill can say:

```bash
scripts/search.sh "query"
```

and the agent may try `./scripts/search.sh` in your project instead of the skill's own `scripts/search.sh`.

This extension gives the model the missing path context.

## Install

```bash
pi install git:github.com/edxeth/pi-better-skills
```

New sessions load it automatically. Existing sessions need:

```text
/reload
```

## What it solves

### Skills can bundle real tools

Good skills are more than prompt text. They often include scripts, examples, templates, reference markdown, or small CLIs. `pi-better-skills` helps the agent find those bundled resources from any project directory.

That means a skill can safely say:

```bash
scripts/exa.sh search "agent skills" 5
```

or:

```md
Read reference/troubleshooting.md before continuing.
```

and the agent gets pointed at the resource inside the active skill, not a coincidentally named file in the workspace.

### Less path babysitting

Without this extension, users and skill authors have to over-explain paths:

- “First cd into the skill directory.”
- “Use the absolute path to this script.”
- “Do not run this from the project root.”
- “If it fails, retry with `/home/.../skills/...`.”

`pi-better-skills` injects skill-local context when a `SKILL.md` is loaded, so the model sees where the skill lives and which paths belong to the skill versus the workspace.

### Better compatibility with Agent Skills

Pi implements the Agent Skills standard, where `SKILL.md` can refer to bundled scripts, references, templates, and assets.

Pi core keeps skills simple and asks the model to resolve relative paths itself. `pi-better-skills` adds the path ergonomics skill authors expect:

- skill-local directory awareness
- safer skill-resource path resolution
- `PI_SKILL_DIR` and `PI_WORKSPACE`
- dynamic `SKILL.md` shell placeholders for trusted skills

## When to use it

Install this if you use skills that include any of the following:

- `scripts/` helpers
- `references/` markdown
- templates, assets, examples, fixtures, or config files
- composite skills that call sibling skills
- skills authored for the Agent Skills standard
- dynamic prompt content such as ``!`git branch --show-current` `` inside `SKILL.md`

You probably do not need it for skills that are only a short prompt with no bundled files.

## How to use it well

### As a user

Use skills normally:

```text
/skill:deep-research compare current browser automation libraries
```

or ask pi naturally:

```text
Research the latest approaches to browser-use agents.
```

When the agent loads a matching skill, `pi-better-skills` adds the missing path context automatically. You should not need to tell the model where the skill folder is.

You can mention multiple skills in one message:

```text
/skill:visual-explainer What's docs.lakebed.dev about? /skill:firecrawl
```

For multi-skill messages, `pi-better-skills` handles the skill expansion itself: each resolvable skill appears as its own `[skill] <name>` conversation row before the cleaned user prompt, and the model receives the skill content before the question. Ordinary single leading `/skill:name` commands still fall through to Pi core.

After installing or editing the extension in an existing pi session, reload pi:

```text
/reload
```

### As a skill author

Write skills as if `SKILL.md` is the home base for bundled resources.

Good:

````md
Run the helper:

```bash
scripts/search.sh "{{query}}"
```

If it fails, read reference/troubleshooting.md.
````

Also good when you want to be explicit:

```bash
$PI_SKILL_DIR/scripts/search.sh "query"
```

Use `$PI_WORKSPACE` when you mean the user's current working dir:

```bash
$PI_WORKSPACE/scripts/build.sh
```

Keep ordinary project commands ordinary:

```bash
git status
bun test
```

Those should still run in the user's workspace, not in the skill folder.

### For dynamic skill content

Trusted global skills can include shell placeholders that are evaluated when the agent reads `SKILL.md`:

```md
Current branch: !`git branch --show-current`
```

or:

````md
Changed files:
```!
git diff --name-only
```
````

Dynamic commands run from the current workspace and receive:

- `PI_SKILL_DIR` — the active skill directory
- `PI_WORKSPACE` — the current pi workspace

Use this for lightweight context that genuinely helps the workflow. Do not use it for slow setup, long-running processes, or surprising side effects.

## Model and thinking overrides

Skills can request a model switch or thinking level change by adding frontmatter fields to `SKILL.md`:

```yaml
---
name: my-skill
description: Heavy analysis task.
model: anthropic/claude-sonnet-4-6
thinking: high
---
```

When the agent loads the skill, `pi-better-skills` switches to that model and thinking level. Both fields are optional. Omit one to leave it unchanged.

Valid thinking levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`.

The switch lasts for one user request. After the agent finishes responding, the original model and thinking level are restored. Sequential skill reads within one request stack correctly — restoring walks back through each override.

### What gets skipped

| Condition | Behavior |
|-----------|----------|
| Model doesn't exist in registry | Skipped, no crash |
| No auth configured for model | Skipped, no crash |
| Invalid thinking level | Skipped, no crash |
| Current context exceeds target model's window | Skipped, no crash |

Invalid values produce a UI notification when pi runs interactively. In print or RPC mode they fail silently.

### Model naming

Use `provider/model-id` format. Match the string you'd pass to `--model`:

```yaml
model: anthropic/claude-sonnet-4-6
model: openai/gpt-5.4-mini
model: google/gemini-3.1-pro-preview
```

### Context window safety

If the running session has more tokens than the target model's `contextWindow`, the model switch is skipped. You can't accidentally shrink the window and lose context.

## Auto-injecting skills with `globs`

Skills with a `globs` field in their frontmatter get injected when you read a matching file. You don't need to load the skill manually. The extension watches `read` tool calls, checks each skill's globs against the file path, and prepends matching skill content to the result.

### Frontmatter format

```yaml
---
name: react-patterns
description: React component best practices
globs: ["**/*.tsx", "**/*.jsx"]
---
```

You can also use YAML list format:

```yaml
---
name: react-patterns
description: React component best practices
globs:
  - "**/*.tsx"
  - "**/*.jsx"
---
```

Or a single pattern:

```yaml
---
name: docker-tips
description: Dockerfile and compose conventions
globs: "Dockerfile*"
---
```

### Deduplication

Skills inject once per turn, not once per file. If you read three `.tsx` files in one turn, matching skills inject on the first read only.

### Supported glob patterns

| Pattern | Matches | Example match |
|---------|---------|---------------|
| `*.tsx` | Files ending in `.tsx` in any directory | `src/Button.tsx` |
| `**/*.tsx` | `.tsx` files at any depth | `src/components/Button.tsx` |
| `src/**/*.ts` | `.ts` files under `src/` | `src/utils/parse.ts` |
| `Dockerfile` | Files named `Dockerfile` anywhere | `project/Dockerfile` |
| `*.{ts,tsx}` | `.ts` or `.tsx` files | `src/utils.ts`, `src/Button.tsx` |
| `**/*.css` | `.css` files at any depth | `src/styles.css` |
| `**/*.test.ts` | Test files at any depth | `src/Button.test.ts` |
| `docs/**` | Everything under `docs/` | `docs/api/overview.md` |
| `**/fixtures/**` | Everything under any `fixtures/` dir | `tests/fixtures/data.json` |

Dot files are matched. Bare patterns without a `/` match against the filename, so `*.tsx` works the same as `**/*.tsx`.

### What gets injected

The extension reads the skill's `SKILL.md`, adds a `<skill_context>` block with path resolution hints, and prepends the result. Dynamic shell placeholders (`!`backtick) are **not** executed for auto-injected skills. They only run when you read the skill directly.

Skills with `disable-model-invocation: true` are not auto-injected by `globs`. They remain available through explicit `/skill:name` commands, matching Pi's opt-out semantics for model-driven invocation.

### When globs don't match

The extension is a no-op. Skills without `globs` behave like before.

## Trust and safety

Skills can instruct the model to run commands, and dynamic skill placeholders can run shell commands when a skill is read.

For that reason, dynamic shell execution is enabled by default only for user/global skill roots:

- `~/.pi/agent/skills`
- `~/.agents/skills`

Project-local skill shell execution is disabled by default because cloned repositories can contain untrusted `.pi/skills` content.

To opt in for project-local dynamic shell placeholders:

```bash
export PI_TRUST_PROJECT_SKILL_SHELL=1
```

Only do this in repositories you trust.

