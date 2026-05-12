# pi-better-skills

`pi-better-skills` makes Pi skills resolve their bundled files from the skill directory, not from whatever project you are working in.

Pi implements the [Agent Skills standard](https://agentskills.io): small capability packages with a `SKILL.md`, helper scripts, reference files, templates, and assets. Many skills assume relative paths start at the skill folder. Pi runs tools from your current workspace, so a skill can say:

```bash
scripts/search.sh "query"
```

and the agent may try `./scripts/search.sh` in your project instead of the skill's own `scripts/search.sh`.

This extension gives the model the missing path context.

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

## Install

```bash
pi install git:github.com/edxeth/pi-better-skills
```

New sessions load it automatically. Existing sessions need:

```text
/reload
```

