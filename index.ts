import { exec } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SkillInvocationMessageComponent, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import {
	extractDisableModelInvocation,
	extractGlobs,
	hasAutoInjectableGlobs,
	matchesGlobs,
} from "./globs";
import {
	DYNAMIC_BLOCK_PATTERN,
	DYNAMIC_INLINE_PATTERN,
	collectSkillReferences,
	hasResolvableReference,
	neutralizeDynamicPlaceholders,
	type RefDeps,
} from "./skill-refs";
import { setupSkillAutocomplete } from "./skill-autocomplete";

type SkillRecord = {
	name: string;
	filePath: string;
	baseDir: string;
	globs?: string[];
	disableModelInvocation?: boolean;
};

const MAX_DYNAMIC_OUTPUT_CHARS = 50_000;
const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const execAsync = promisify(exec);

function homePath(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function normalizeSkill(raw: unknown): SkillRecord | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const name = typeof obj.name === "string" ? obj.name : undefined;
	const filePath = typeof obj.filePath === "string" ? obj.filePath : typeof obj.location === "string" ? obj.location : undefined;
	const baseDir = typeof obj.baseDir === "string" ? obj.baseDir : filePath ? dirname(filePath) : undefined;
	if (!name || !filePath || !baseDir) return undefined;

	let globs = Array.isArray(obj.globs) ? obj.globs.filter((glob): glob is string => typeof glob === "string") : undefined;
	let disableModelInvocation: boolean | undefined;
	if (typeof obj.disableModelInvocation === "boolean") {
		disableModelInvocation = obj.disableModelInvocation;
	} else if (typeof obj["disable-model-invocation"] === "boolean") {
		disableModelInvocation = obj["disable-model-invocation"];
	}

	if (!globs || disableModelInvocation === undefined) {
		try {
			const content = readFileSync(filePath, "utf-8");
			globs = globs ?? extractGlobs(content);
			disableModelInvocation = disableModelInvocation ?? (extractDisableModelInvocation(content) || undefined);
		} catch {
			// Keep the normalized record without optional frontmatter fields.
		}
	}

	return { name, filePath, baseDir, globs, disableModelInvocation };
}

// ponytail: hand-rolls pi's package cache layout. Only `git:github.com/...`
// specs resolve to ~/.pi/agent/git/...; it does NOT cover npm specs, SSH/https
// git URLs, branch refs (git:...@ref), project-local .pi/settings.json, or
// per-package `skills: []` filters. Discovery also hand-rolls pi's other skill
// locations (settings `skills` arrays, CLI --skill paths, project
// .agents/skills ancestors) because the input event fires before
// before_agent_start merges pi's authoritative loaded set — without this,
// fresh-session /skill:name prompts cannot resolve those skills.
// before_agent_start still merges the authoritative set at runtime. Upgrade to
// an extension API exposing active skill roots when pi provides one.
function packageRootFromSource(source: string): string | undefined {
	if (source.startsWith("/") || source.startsWith("~/")) return homePath(source);
	if (!source.startsWith("git:")) return undefined;
	let spec = source.slice("git:".length).replace(/\.git$/, "");
	spec = spec.replace(/^https?:\/\/github\.com\//, "github.com/");
	if (!spec.startsWith("github.com/")) return undefined;
	return homePath(`~/.pi/agent/git/${spec}`);
}

function activePackageRootsFromSettings(): string[] {
	try {
		const settings = JSON.parse(readFileSync(homePath("~/.pi/agent/settings.json"), "utf-8")) as { packages?: unknown[] };
		const roots: string[] = [];
		for (const entry of settings.packages ?? []) {
			const source = typeof entry === "string" ? entry : entry && typeof entry === "object" ? (entry as { source?: unknown }).source : undefined;
			if (typeof source !== "string") continue;
			const root = packageRootFromSource(source);
			if (root) roots.push(root);
		}
		return roots;
	} catch {
		return [];
	}
}

/** CLI `--skill <path>` / `--skill=<path>` entries from the live pi invocation. */
export function cliSkillPaths(argv: string[] = process.argv): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--skill" && argv[i + 1] !== undefined) {
			out.push(argv[i + 1]!);
			i++;
		} else if (arg.startsWith("--skill=")) {
			out.push(arg.slice("--skill=".length));
		}
	}
	return out.map(homePath).filter(Boolean);
}

/**
 * `skills` array entries (files or directories) from user and project settings.
 * Entries resolve against the session cwd, matching pi's loader
 * (`resolvePath(entry, cwd)`). Project settings are only read for trusted
 * projects, mirroring pi's project-trust gate for project-local content.
 */
export function settingsSkillPaths(cwd: string, trusted = false): string[] {
	const out: string[] = [];
	const sources: Array<{ file: string; project: boolean }> = [
		{ file: homePath("~/.pi/agent/settings.json"), project: false },
		{ file: resolve(cwd, ".pi/settings.json"), project: true },
	];
	for (const { file, project } of sources) {
		if (project && !trusted) continue;
		try {
			const settings = JSON.parse(readFileSync(file, "utf-8")) as { skills?: unknown };
			for (const entry of Array.isArray(settings.skills) ? settings.skills : []) {
				if (typeof entry !== "string") continue;
				const expanded = homePath(entry);
				out.push(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
			}
		} catch {
			// Missing or invalid settings file: skip it.
		}
	}
	return out;
}

/**
 * Project-scoped skill roots (`.pi/skills` and `.agents/skills` ancestors).
 * Empty until the project is trusted: pi only admits project skills after
 * trust, and pre-input discovery must not widen that boundary.
 */
export function projectSkillRoots(cwd: string, trusted: boolean): string[] {
	if (!trusted) return [];
	return [resolve(cwd, ".pi/skills"), ...projectAgentsSkillRoots(cwd)];
}

/** True when the tool result text actually contains the skill's body opening. */
export function resultConfirmsSkillBody(resultText: string, skillBody: string): boolean {
	const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
	const body = collapse(skillBody);
	if (!body) return false;
	return collapse(resultText).includes(body.slice(0, 80));
}

/**
 * Project `.agents/skills` directories in `cwd` and ancestor directories, up to
 * the git repo root (or filesystem root outside a repo), mirroring pi's
 * project skill discovery. Nonexistent dirs are ignored by the scanner.
 */
export function projectAgentsSkillRoots(cwd: string, rootExists: (dir: string) => boolean = existsSync): string[] {
	const out: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		out.push(join(dir, ".agents", "skills"));
		if (rootExists(join(dir, ".git"))) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Multi-skill invocation
// ---------------------------------------------------------------------------
// pi core only expands a *single* leading `/skill:<name>` per message
// (`AgentSession._expandSkillCommand`). For messages that mention multiple
// resolvable skills, the extension handles the whole prompt: it appends visible
// `[skill]` custom messages first, then sends the cleaned user prompt. That
// keeps TUI ordering and LLM context ordering aligned without touching pi core.

export type InlineSkillRef = {
	name: string;
	filePath: string;
	baseDir: string;
};

export type InlineSkillDisplay = InlineSkillRef & {
	content: string;
	block: string;
};

type InlineSkillBatchDetails = {
	skills: InlineSkillDisplay[];
};

const INLINE_SKILL_TOKEN = /\/skill:([A-Za-z0-9._-]+)/g;

function formatInlineSkillDisplay(skill: InlineSkillRef, inner: string): InlineSkillDisplay {
	const content = `References are relative to ${skill.baseDir}.\n\n${inner}`;
	return {
		...skill,
		content,
		block: `<skill name="${skill.name}" location="${skill.filePath}">\n${content}\n</skill>`,
	};
}

function renderInlineSkillDisplay(skill: InlineSkillDisplay, expanded: boolean): SkillInvocationMessageComponent {
	const component = new SkillInvocationMessageComponent({
		name: skill.name,
		location: skill.filePath,
		content: skill.content,
	});
	component.setExpanded(expanded);
	return component;
}

function renderInlineSkillBatch(message: { details?: unknown }, options: { expanded: boolean }) {
	const details = message.details as InlineSkillBatchDetails | undefined;
	if (!details?.skills?.length) return undefined;
	if (details.skills.length === 1) return renderInlineSkillDisplay(details.skills[0], options.expanded);

	const container = new Container();
	details.skills.forEach((skill, index) => {
		if (index > 0) container.addChild(new Spacer(1));
		container.addChild(renderInlineSkillDisplay(skill, options.expanded));
	});
	return container;
}

function inlineSkillMessage(skill: InlineSkillDisplay): {
	customType: "skill";
	content: string;
	display: true;
	details: InlineSkillBatchDetails;
} {
	return {
		customType: "skill",
		content: skill.block,
		display: true,
		details: { skills: [skill] },
	};
}

/**
 * Combine extracted skill blocks with the cleaned user text into a single string.
 * Used for steer/followUp delivery: the steering queue defaults to
 * "one-at-a-time", so separate skill messages would each drain in their own turn
 * and the skill body would be invoked before the user's text ever arrives. Keeping
 * them in one queued entry makes the skill and the instruction travel together.
 */
export function inlineSkillsIntoText(text: string, skills: InlineSkillDisplay[]): string {
	const blocks = skills.map((skill) => skill.block).join("\n\n");
	return blocks ? `${blocks}\n\n${text}` : text;
}

/**
 * Decide how extracted skills are delivered alongside the cleaned user text.
 *
 * Idle: skills ride as separate custom messages (rendered as collapsible
 * `[skill]` rows) that land in the same turn as the user prompt.
 *
 * Streaming: steer/followUp queues drain one entry at a time by default, so a
 * separate skill message would be delivered alone in its own turn and invoked
 * before the user's queued text arrives. Inline the blocks into the single
 * transformed text instead (no `[skill]` row, but skill + instruction stay
 * together). This is the seam the streaming regression turns on.
 *
 * Exception: if the cleaned prompt still starts with a slash-command (e.g. a
 * leading prompt-template `/tmpl ...`), it must stay at position 0 so pi core's
 * prompt-template expansion (which requires `text.startsWith("/")` and replaces
 * the whole message) still fires. Prepending skill XML would bury it. In that
 * rare template+skill combo we fall back to separate skill messages: the
 * template keeps expanding, and the skills may split across one-at-a-time drains
 * as they did before this fix.
 */
export function planInlineSkillDelivery(
	result: { text: string; skills: InlineSkillDisplay[] },
	streaming: boolean,
): { text: string; messages: InlineSkillDisplay[] } {
	if (streaming && !result.text.startsWith("/")) {
		return { text: inlineSkillsIntoText(result.text, result.skills), messages: [] };
	}
	return { text: result.text, messages: result.skills };
}

function isOrdinarySingleLeadingSkillCommand(text: string, skills: InlineSkillDisplay[]): boolean {
	if (skills.length !== 1) return false;
	const token = `/skill:${skills[0].name}`;
	const trimmed = text.trimStart();
	return trimmed === token || (trimmed.startsWith(token) && /\s/.test(trimmed[token.length] ?? ""));
}

/**
 * Collect backticked skill references for a batch of inline skill displays.
 * Referenced skills are appended as their own displays, so they render as
 * separate `[skill]` rows and travel with the same delivery plan as parents.
 * Parent bodies are never rewritten; injection is purely additive.
 *
 * `injected` records every skill whose body enters context this session so the
 * same reference is never injected twice (cleared when compaction may have
 * summarized the earlier bodies away).
 */
export function commitRefExpansion(batch: InlineSkillDisplay[], deps: RefDeps, injected: Set<string>): InlineSkillDisplay[] {
	const out = [...batch];
	for (const display of batch) {
		const refs = collectSkillReferences(display.name, display.content, {
			...deps,
			// Also skip skills already staged in this batch (e.g. a parent referencing
			// another parent) so they are not duplicated as reference rows.
			alreadyInjected: (name) => injected.has(name) || out.some((staged) => staged.name === name),
		});
		injected.add(display.name);
		for (const ref of refs) {
			out.push(formatInlineSkillDisplay(ref.skill, ref.decoratedBody));
			injected.add(ref.skill.name);
		}
	}
	return out;
}

/**
 * Replace resolvable `/skill:<name>` tokens in user text with the bare skill
 * `name`, and return the referenced skills as separate skill-display records.
 * Leaving the bare name keeps the user's sentence readable (no gap) while the
 * skill body is rendered as its own `[skill]` row above the prompt. Replacing
 * (rather than keeping) the `/skill:` sigil also stops pi core from
 * double-expanding a leading token, since the text no longer starts with it.
 *
 * By default the leading token is skipped so pi core can keep handling ordinary
 * single-skill commands. Pass `includeLeading: true` when the extension owns the
 * whole multi-skill prompt. Unknown or unreadable skills are left verbatim so
 * core/pi can report them.
 *
 * `decorate`, if provided, wraps the skill body (e.g. with `<skill_context>`);
 * it receives the body and must return the inner content of the `<skill>` block.
 */
export function extractInlineSkillDisplays(
	text: string,
	resolve: (name: string) => InlineSkillRef | undefined,
	readBody: (skill: InlineSkillRef) => string,
	decorate?: (body: string, skill: InlineSkillRef) => string,
	options?: { includeLeading?: boolean },
): { text: string; skills: InlineSkillDisplay[] } | undefined {
	if (!text.includes("/skill:")) return undefined;

	const matches = [...text.matchAll(INLINE_SKILL_TOKEN)].filter((match) => {
		const start = match.index ?? 0;
		return start === 0 || /\s/.test(text[start - 1] ?? "");
	});
	if (matches.length === 0) return undefined;

	type Replacement = { start: number; end: number; name: string };
	const replacements: Replacement[] = [];
	const skills: InlineSkillDisplay[] = [];

	for (const match of matches) {
		const start = match.index ?? 0;
		if (start === 0 && !options?.includeLeading) continue; // leading skill -> pi core expands ordinary single-skill prompts
		const skill = resolve(match[1] ?? "");
		if (!skill) continue; // unknown skill: leave token verbatim

		let body: string;
		try {
			body = readBody(skill);
		} catch {
			continue; // unreadable SKILL.md: leave token verbatim
		}

		const inner = decorate ? decorate(body, skill) : body;
		skills.push(formatInlineSkillDisplay(skill, inner));
		replacements.push({ start, end: start + match[0].length, name: skill.name });
	}

	if (replacements.length === 0) return undefined;

	replacements.sort((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	for (const { start, end, name } of replacements) {
		out += text.slice(cursor, start) + name;
		cursor = end;
	}
	out += text.slice(cursor);

	return { text: out.trim(), skills };
}

function scanSkillRoots(roots: string[]): SkillRecord[] {
	const out: SkillRecord[] = [];
	const visit = (dir: string) => {
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
			const skillPath = join(dir, "SKILL.md");
			let globs: string[] | undefined;
			let disableModelInvocation: boolean | undefined;
			try {
				const content = readFileSync(skillPath, "utf-8");
				globs = extractGlobs(content);
				disableModelInvocation = extractDisableModelInvocation(content) || undefined;
			} catch {
				// Silently skip unreadable SKILL.md
			}
			out.push({
				name: dir.split(/[\\/]/).pop() || dir,
				filePath: skillPath,
				baseDir: dir,
				globs,
				disableModelInvocation,
			});
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const full = join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (entry.isSymbolicLink()) {
				try {
					isDir = statSync(full).isDirectory();
				} catch {
					continue;
				}
			}
			if (isDir) visit(full);
		}
	};

	for (const root of roots) visit(root);
	return out;
}

/** Skill record for a direct `.md` file entry (CLI/settings), named by frontmatter or filename. */
export function skillRecordForFile(file: string): SkillRecord | undefined {
	let content: string;
	try {
		content = readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const fmName = frontmatter?.[1]?.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
	const fmDescription = frontmatter?.[1]?.match(/^description:\s*(.+)$/m)?.[1]?.trim();
	const name = fmName || file.split(/[\\/]/).pop()?.replace(/\.md$/, "");
	const globs = extractGlobs(content) ?? [];
	// pi does not load skills without a description; match that contract here.
	if (!name || !fmDescription) return undefined;
	return {
		name,
		filePath: file,
		baseDir: dirname(file),
		globs: globs.length ? globs : undefined,
		disableModelInvocation: extractDisableModelInvocation(content) || undefined,
	};
}

function shellQuote(path: string): string {
	return `'${path.replace(/'/g, `'"'"'`)}'`;
}

function maybeQuote(path: string, original: string): string {
	// If the original occurrence was already inside quotes, avoid adding nested quotes.
	return /\s/.test(path) && !/^["']/.test(original) ? shellQuote(path) : path;
}

function formatShellOutput(stdout: string, stderr: string): string {
	const parts: string[] = [];
	if (stdout.trim()) parts.push(stdout.trim());
	if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
	const output = parts.join("\n");
	return output.length > MAX_DYNAMIC_OUTPUT_CHARS ? `${output.slice(0, MAX_DYNAMIC_OUTPUT_CHARS)}\n[output truncated]` : output;
}

/**
 * Extract `model` and `thinking` fields from YAML frontmatter.
 * Returns undefined fields if not present or unparseable.
 */
function extractFrontmatterFields(text: string): { model?: string; thinking?: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const yamlBlock = match[1];
	const result: { model?: string; thinking?: string } = {};

	const modelMatch = yamlBlock.match(/^model:\s*(.+)$/m);
	if (modelMatch) {
		result.model = modelMatch[1].trim().replace(/^["']|["']$/g, "").trim();
	}

	const thinkingMatch = yamlBlock.match(/^thinking:\s*(.+)$/m);
	if (thinkingMatch) {
		result.thinking = thinkingMatch[1].trim().replace(/^["']|["']$/g, "").trim();
	}

	return result;
}

export default function skillRelativePaths(pi: ExtensionAPI) {
	let skills = new Map<string, SkillRecord>();
	let skillList: SkillRecord[] = [];
	let cachedPackageRoots: string[] | undefined;
	let activeSkill: SkillRecord | undefined;
	// Tracks skills auto-injected via globs in the current turn (deduplication).
	let injectedThisTurn = new Set<string>();
	// Tracks skills whose full body is already in context this session, so the
	// same backticked reference is never expanded twice. Cleared on compaction.
	let injectedSkillNames = new Set<string>();

	function refDeps(cwd: string): RefDeps {
		return {
			// Deliberately unfiltered: skills with disable-model-invocation stay
			// referenceable — referencing a sibling from a loaded skill is an
			// explicit author choice, unlike passive globs auto-injection.
			resolve: (name) => skills.get(name),
			readBody(skill) {
				try {
					return stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
				} catch {
					return undefined;
				}
			},
			decorate: (body, skill) => insertSkillContext(body, skill, cwd),
			alreadyInjected: (name) => injectedSkillNames.has(name),
		};
	}

	// ---------------------------------------------------------------------------
	// Model/thinking override state
	// ---------------------------------------------------------------------------
	// Tracks temporary model/thinking switches from SKILL.md frontmatter.
	// Originals are captured before the first override and restored on agent_end.
	// A simple counter handles sequential reads (composite skills): each load that
	// applies a valid override increments the counter; agent_end restores only when
	// the counter reaches zero.

	let overrideCount = 0;
	let originalModelRef: { provider: string; id: string } | undefined;
	let originalThinking: string | undefined;

	async function applyModelOverride(modelStr: string, ctx: ExtensionContext): Promise<boolean> {
		if (!modelStr.includes("/")) return false;

		const slashIndex = modelStr.indexOf("/");
		const provider = modelStr.slice(0, slashIndex);
		const modelId = modelStr.slice(slashIndex + 1);
		const model = ctx.modelRegistry.find(provider, modelId);

		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`Skill references unknown model: ${modelStr}`, "warning");
			return false;
		}

		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (ctx.hasUI) ctx.ui.notify(`Skill wants model ${modelStr} but auth is not configured`, "warning");
			return false;
		}

		// Context window safety: skip if current usage exceeds the target model's window
		const currentModel = ctx.model;
		const usage = ctx.getContextUsage();
		if (currentModel && usage?.tokens != null && usage.tokens > model.contextWindow) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Skill wants model ${modelStr} but context (${usage.tokens} tokens) exceeds its window (${model.contextWindow}). Skipping.`,
					"warning",
				);
			}
			return false;
		}

		return await pi.setModel(model as any);
	}

	async function applySkillOverrides(
		fields: { model?: string; thinking?: string },
		ctx: ExtensionContext,
	): Promise<void> {
		const modelStr = fields.model;
		const thinkingStr = fields.thinking;
		if (!modelStr && !thinkingStr) return;

		// Capture originals on first override within the current nesting scope
		if (overrideCount === 0) {
			const currentModel = ctx.model;
			if (currentModel) {
				originalModelRef = { provider: currentModel.provider as string, id: currentModel.id };
			}
			originalThinking = pi.getThinkingLevel();
		}

		let applied = false;

		if (modelStr) {
			const ok = await applyModelOverride(modelStr, ctx);
			if (ok) applied = true;
		}

		if (thinkingStr) {
			if (VALID_THINKING.has(thinkingStr)) {
				pi.setThinkingLevel(thinkingStr as any);
				applied = true;
			} else if (ctx.hasUI) {
				ctx.ui.notify(`Skill references invalid thinking level: ${thinkingStr}`, "warning");
			}
		}

		if (applied) overrideCount++;
	}

	async function restoreOriginalState(ctx: ExtensionContext): Promise<void> {
		if (overrideCount === 0) return;
		overrideCount = 0;

		if (originalModelRef) {
			const model = ctx.modelRegistry.find(originalModelRef.provider, originalModelRef.id);
			if (model) {
				await pi.setModel(model as any);
			}
		}

		if (originalThinking) {
			pi.setThinkingLevel(originalThinking as any);
		}

		originalModelRef = undefined;
		originalThinking = undefined;
	}

	// ---------------------------------------------------------------------------
	// Skill discovery
	// ---------------------------------------------------------------------------

	function refreshSkills(cwd: string, loaded?: unknown[], trusted = false) {
		const next = new Map<string, SkillRecord>();
		for (const skill of loaded ?? []) {
			const normalized = normalizeSkill(skill);
			if (normalized) next.set(normalized.name, normalized);
		}

		const roots = [
			homePath("~/.pi/agent/skills"),
			homePath("~/.agents/skills"),
			...projectSkillRoots(cwd, trusted),
		];
		// CLI and settings entries can be skill directories or direct .md files.
		// Directory entries join the recursive scan; file entries become records
		// directly so sibling files in the same directory are not over-discovered.
		const fileEntries: string[] = [];
		// CLI --skill entries are explicit user actions (pi loads them even with
			// --no-skills) and are not gated by project trust.
		for (const entry of [...settingsSkillPaths(cwd, trusted), ...cliSkillPaths()]) {
			if (entry.endsWith(".md")) fileEntries.push(entry);
			else roots.push(entry);
		}
		// Active package roots are session-static; parse settings once.
		if (!cachedPackageRoots) cachedPackageRoots = activePackageRootsFromSettings();
		// Package skills live under <pkg>/skills/** (or <pkg>/SKILL.md); don't walk the
		// whole repo tree (src/dist/tests/...) on every turn.
		for (const root of cachedPackageRoots) {
			roots.push(join(root, "skills"));
			if (existsSync(join(root, "SKILL.md"))) roots.push(root);
		}
		for (const skill of [...scanSkillRoots(roots), ...fileEntries.map(skillRecordForFile).filter((s): s is SkillRecord => !!s)]) {
			const existing = next.get(skill.name);
			if (existing) {
				// Filesystem skill may have richer data (e.g. globs and frontmatter flags). Merge it in.
				if ((skill.globs && !existing.globs) || skill.disableModelInvocation !== undefined) {
					next.set(skill.name, {
						...existing,
						globs: existing.globs ?? skill.globs,
						disableModelInvocation: existing.disableModelInvocation ?? skill.disableModelInvocation,
					});
				}
			} else {
				next.set(skill.name, skill);
			}
		}
		skills = next;
		skillList = Array.from(next.values());
	}

	function isTrustedForDynamicShell(skill: SkillRecord): boolean {
		const base = realpathOrResolve(skill.baseDir);
		const trustedRoots = [realpathOrResolve(homePath("~/.pi/agent/skills")), realpathOrResolve(homePath("~/.agents/skills"))];
		const trusted = trustedRoots.some((root) => base === root || base.startsWith(`${root}/`));
		if (trusted) return true;
		return /^(1|true|yes)$/i.test(process.env.PI_TRUST_PROJECT_SKILL_SHELL ?? "");
	}

	function findSkillForPath(path: string): SkillRecord | undefined {
		const targetPath = resolve(path);
		const known = Array.from(skills.values());
		const exact = known.find((skill) => resolve(skill.filePath) === targetPath);
		if (exact) return exact;

		const target = realpathOrResolve(path);
		const matching = known.find((skill) => realpathOrResolve(skill.filePath) === target);
		if (path.endsWith("SKILL.md") && existsSync(path)) {
			const baseDir = dirname(path);
			return { name: matching?.name ?? baseDir.split(/[\\/]/).pop() ?? "skill", filePath: path, baseDir };
		}
		return matching;
	}

	function cleanRelativePath(relPath: string): string | undefined {
		if (isAbsolute(relPath) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(relPath) || relPath.startsWith("$")) return undefined;
		const clean = relPath.replace(/^\.\//, "");
		if (!clean || clean === "." || clean.startsWith("../")) return undefined;
		return clean;
	}

	function isInsideDir(path: string, dir: string): boolean {
		const target = resolve(path);
		const root = resolve(dir);
		return target === root || target.startsWith(`${root}/`);
	}

	function resolveSkillResource(skill: SkillRecord, relPath: string): string | undefined {
		const clean = cleanRelativePath(relPath);
		if (!clean) return undefined;
		const candidate = resolve(skill.baseDir, clean);
		return isInsideDir(candidate, skill.baseDir) && existsSync(candidate) ? candidate : undefined;
	}

	function resolveRelativeResource(relPath: string, preferredSkill?: SkillRecord): string | undefined {
		if (preferredSkill) return resolveSkillResource(preferredSkill, relPath);

		const clean = cleanRelativePath(relPath);
		if (!clean) return undefined;
		const matches: string[] = [];
		for (const skill of skills.values()) {
			const candidate = resolve(skill.baseDir, clean);
			if (isInsideDir(candidate, skill.baseDir) && existsSync(candidate)) matches.push(candidate);
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	function cwdPathExists(cwd: string, relPath: string): boolean {
		return !isAbsolute(relPath) && existsSync(resolve(cwd, relPath));
	}

	function substitutePiPathVars(value: string, cwd: string, skill?: SkillRecord): string {
		let substituted = value.replace(/\$\{PI_WORKSPACE\}|\$PI_WORKSPACE\b/g, cwd);
		if (skill) substituted = substituted.replace(/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/g, skill.baseDir);
		return substituted;
	}

	// ---------------------------------------------------------------------------
	// Skill context injection
	// ---------------------------------------------------------------------------

	function skillContextBlock(skill: { baseDir: string }, workspace: string): string {
		return `<skill_context>\n  <skill_dir>${skill.baseDir}</skill_dir>\n  <workspace_dir>${workspace}</workspace_dir>\n\n  <path_policy>\n    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.\n    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.\n    Use $PI_SKILL_DIR/path for explicit bundled skill files.\n    Use $PI_WORKSPACE/path for explicit workspace/project files.\n  </path_policy>\n</skill_context>`;
	}

	function insertSkillContext(text: string, skill: { baseDir: string }, workspace: string): string {
		if (text.includes("<skill_context>")) return text;
		const context = skillContextBlock(skill, workspace);
		const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
		if (!frontmatter) return `${context}\n\n${text}`;
		const end = frontmatter[0].length;
		const rest = text.slice(end).replace(/^\r?\n/, "");
		return `${text.slice(0, end)}\n${context}\n\n${rest}`;
	}

	function findSkillReferencedByCommand(command: string, cwd: string): SkillRecord | undefined {
		for (const match of command.matchAll(/(?:^|[\s"'])((?:\.?\.?\/|\/)?[^\s"']*SKILL\.md)\b/g)) {
			const rawPath = match[1];
			if (!rawPath) continue;
			const path = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
			const skill = findSkillForPath(path);
			if (skill) return skill;
		}
		return undefined;
	}

	/**
	 * Command-driven skill detection (bash / arbitrary tools) is only a real
	 * skill load when the tool result actually contains the skill's body.
	 * `echo`, `stat`, or `ls` mentioning a SKILL.md path must not trigger
	 * enrichment or mark the skill injected.
	 */
	function confirmedSkillRead(event: { content: Array<{ type: string; text?: string }> }, skill: SkillRecord): boolean {
		let body: string;
		try {
			body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
		} catch {
			return false;
		}
		const text = event.content
			.filter((block) => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n");
		return resultConfirmsSkillBody(text, body);
	}

	function rewriteCommand(command: string, cwd: string): string {
		let rewritten = substitutePiPathVars(command, cwd, activeSkill);

		// Fix sibling-skill references commonly used by composite skills, e.g.
		// ../exa/scripts/exa.sh from deep-research.
		rewritten = rewritten.replace(/(^|[\s"'(=;|&])\.\.\/([a-z0-9-]+)\/([^\s"'`;|&<>)]*)/g, (match, prefix: string, skillName: string, rest: string) => {
			const originalRelPath = `../${skillName}/${rest}`;
			if (cwdPathExists(cwd, originalRelPath)) return match;
			const skill = skills.get(skillName);
			if (!skill) return match;
			const candidate = join(skill.baseDir, rest);
			return existsSync(candidate) ? `${prefix}${maybeQuote(candidate, match)}` : match;
		});

		// Fix relative path tokens against the active skill root when that file
		// exists inside the skill. Tool cwd stays the workspace, and bare commands
		// like git/bun/rg are untouched because they contain no slash.
		const relativePathRegex = /(^|[\s\"'(=;|&])((?:\.\/)?[^\s\"'`;|&<>)]*\/[^\s\"'`;|&<>)]*)/g;
		rewritten = rewritten.replace(relativePathRegex, (match, prefix: string, relPath: string) => {
			const absolute = resolveRelativeResource(relPath, activeSkill);
			if (absolute) return `${prefix}${maybeQuote(absolute, match)}`;
			if (activeSkill || cwdPathExists(cwd, relPath)) return match;
			const uniqueSkillResource = resolveRelativeResource(relPath);
			return uniqueSkillResource ? `${prefix}${maybeQuote(uniqueSkillResource, match)}` : match;
		});

		return rewritten;
	}

	async function executeDynamicShell(content: string, skill: SkillRecord, workspace: string): Promise<string> {
		if (!content.includes("!`") && !content.includes("```!")) return content;
		if (!isTrustedForDynamicShell(skill)) {
			return content.replace(DYNAMIC_BLOCK_PATTERN, "[dynamic shell skipped: untrusted skill root]").replace(DYNAMIC_INLINE_PATTERN, "$1[dynamic shell skipped: untrusted skill root]");
		}

		let transformed = content.replace(/\$\{PI_SKILL_DIR\}/g, skill.baseDir).replace(/\$\{PI_WORKSPACE\}/g, workspace);
		const replacements: Array<{ match: string; replacement: string }> = [];

		for (const match of transformed.matchAll(DYNAMIC_BLOCK_PATTERN)) {
			const command = match[1]?.trim();
			if (!command) continue;
			replacements.push({ match: match[0], replacement: await runDynamicCommand(command, skill, workspace) });
		}
		for (const match of transformed.matchAll(DYNAMIC_INLINE_PATTERN)) {
			const command = match[2]?.trim();
			if (!command) continue;
			replacements.push({ match: match[0], replacement: `${match[1] ?? ""}${await runDynamicCommand(command, skill, workspace)}` });
		}

		for (const { match, replacement } of replacements) {
			transformed = transformed.replace(match, () => replacement);
		}
		return transformed;
	}

	async function runDynamicCommand(command: string, skill: SkillRecord, workspace: string): Promise<string> {
		try {
			const { stdout, stderr } = await execAsync(command, {
				cwd: workspace,
				timeout: 30_000,
				maxBuffer: 2 * 1024 * 1024,
				env: {
					...process.env,
					PI_SKILL_DIR: skill.baseDir,
					PI_WORKSPACE: workspace,
				},
			});
			return formatShellOutput(stdout, stderr);
		} catch (error) {
			const err = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean; signal?: string; code?: number };
			const output = formatShellOutput(err.stdout ?? "", err.stderr ?? "");
			const status = err.killed ? `timed out${err.signal ? ` (${err.signal})` : ""}` : `failed${typeof err.code === "number" ? ` with code ${err.code}` : ""}`;
			return `[dynamic shell ${status}: ${command}${output ? `\n${output}` : err.message ? `\n${err.message}` : ""}]`;
		}
	}

	// ---------------------------------------------------------------------------
	// Event handlers
	// ---------------------------------------------------------------------------

	pi.registerMessageRenderer("skill", renderInlineSkillBatch as any);

	pi.on("session_start", async (_event, ctx) => {
		injectedSkillNames = new Set();
		refreshSkills(ctx.cwd, undefined, ctx.isProjectTrusted());
		if (ctx.hasUI) setupSkillAutocomplete(ctx, () => skillList);
	});

	// Compaction can summarize previously injected skill bodies out of context;
	// allow references to expand again afterwards.
	pi.on("session_compact", async () => {
		injectedSkillNames = new Set();
	});

	// Multi-skill prompts are handled entirely by the extension so both the TUI
	// and the LLM see: skill rows first, cleaned user prompt second. Ordinary
	// single leading `/skill:name` commands still fall through to pi core —
	// unless the skill composes others via backticked `/name` references, in
	// which case the extension owns the whole expansion so parents and their
	// referenced skills share one delivery plan.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return; // don't rewrite extension-injected text
		const result = extractInlineSkillDisplays(
			event.text,
			(name) => skills.get(name),
			(skill) => stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim(),
			// Wrap the body with the same <skill_context> block the extension injects
			// when a SKILL.md is read, so relative-path resolution applies to these
			// multi-skill invocations too (core's own leading-skill block lacks it).
			(body, skill) => insertSkillContext(body, skill, ctx.cwd),
			{ includeLeading: true },
		);
		if (!result) return;
		if (isOrdinarySingleLeadingSkillCommand(event.text, result.skills)) {
			// No resolvable references -> keep pi core's ordinary single-skill expansion.
			if (!hasResolvableReference(result.skills[0].content, (name) => skills.get(name))) return;
		}

		const batch = commitRefExpansion(result.skills, refDeps(ctx.cwd), injectedSkillNames);

		const { text, messages } = planInlineSkillDelivery({ text: result.text, skills: batch }, Boolean(event.streamingBehavior));
		const options = event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined;
		for (const skill of messages) {
			pi.sendMessage(inlineSkillMessage(skill), options);
		}

		return { action: "transform" as const, text };
	});

	pi.on("turn_start", async () => {
		injectedThisTurn.clear();
	});

	pi.on("resources_discover", async (_event, ctx) => {
		refreshSkills(ctx.cwd, undefined, ctx.isProjectTrusted());
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const loaded = Array.isArray(event.systemPromptOptions?.skills) ? event.systemPromptOptions.skills : undefined;
		refreshSkills(ctx.cwd, loaded, ctx.isProjectTrusted());

		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n<agent_skills>
  <path_policy>
    Relative file references in an active SKILL.md normally resolve from that skill's directory when they exist there.
    Plain workspace commands like \`git status\` and \`bun test\` usually run in the workspace unless instructed otherwise.
    Use $PI_SKILL_DIR/path for explicit bundled skill files.
    Use $PI_WORKSPACE/path for explicit workspace/project files.
    Absolute paths are exact and should not be reinterpreted.
  </path_policy>
  <dynamic_skill_shell>
    Dynamic SKILL.md shell placeholders receive PI_SKILL_DIR and PI_WORKSPACE.
    If a SKILL.md contains dynamic shell placeholders like !\`command\` or fenced \`\`\`! blocks, the loaded/read skill content already contains their output; do not run those commands again unless the user asks.
  </dynamic_skill_shell>
</agent_skills>`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "bash" && typeof input.command === "string") {
			const original = input.command;
			process.env.PI_WORKSPACE = ctx.cwd;
			if (activeSkill) process.env.PI_SKILL_DIR = activeSkill.baseDir;
			else delete process.env.PI_SKILL_DIR;
			if (/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(original) && !activeSkill) {
				return {
					block: true,
					reason: "Blocked PI_SKILL_DIR use because no active skill is known yet. Read the relevant SKILL.md first, or use an absolute skill path.",
				};
			}

			// Let the shell expand explicit PI_* variables from process.env. This avoids
			// an unnecessary block/retry for commands like $PI_WORKSPACE/scripts/build.sh.
			if (/\$\{PI_WORKSPACE\}|\$PI_WORKSPACE\b|\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(original)) return;

			const rewritten = rewriteCommand(original, ctx.cwd);
			if (rewritten !== original) {
				return {
					block: true,
					reason: `Blocked unresolved skill-relative resource path. Retry with the resolved command: ${rewritten}`,
				};
			}
			return;
		}

		if (event.toolName === "read" && typeof input.path === "string") {
			if (/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(input.path) && !activeSkill) {
				return {
					block: true,
					reason: "Blocked PI_SKILL_DIR use because no active skill is known yet. Read the relevant SKILL.md first, or use an absolute skill path.",
				};
			}
			if (/\$\{PI_WORKSPACE\}|\$PI_WORKSPACE\b|\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(input.path)) {
				const resolved = substitutePiPathVars(input.path, ctx.cwd, activeSkill);
				return {
					block: true,
					reason: `Blocked unresolved PI path variable. Retry read with the resolved path: ${resolved}`,
				};
			}
			if (!isAbsolute(input.path)) {
				const absolute = resolveRelativeResource(input.path, activeSkill);
				if (absolute) input.path = absolute;
				else if (!activeSkill && !cwdPathExists(ctx.cwd, input.path)) {
					const uniqueSkillResource = resolveRelativeResource(input.path);
					if (uniqueSkillResource) input.path = uniqueSkillResource;
				}
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;

		// Phase 1: Identify the directly targeted skill (SKILL.md read / bash referencing SKILL.md)
		let skill: SkillRecord | undefined;
		let readPath: string | undefined;

		if (event.toolName === "read") {
			const inputPath = typeof event.input.path === "string" ? event.input.path : undefined;
			if (inputPath) {
				skill = findSkillForPath(inputPath);
				readPath = isAbsolute(inputPath) ? inputPath : resolve(ctx.cwd, inputPath);
			}
		} else if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : undefined;
			if (command) skill = findSkillReferencedByCommand(command, ctx.cwd);
			if (skill && !confirmedSkillRead(event, skill)) return;
		} else {
			// Tool-agnostic skill detection: any tool (e.g. an MCP `exec_command`)
			// whose input strings reference a known SKILL.md path counts as a
			// skill read and gets the same enrichment as core `read`/`bash`.
			// Writes are excluded, and the result must actually contain the skill
			// body — commands that merely mention the path (echo/stat/ls) must not
			// mark a skill loaded or receive enrichment.
			if (event.toolName === "edit" || event.toolName === "write") return;
			for (const value of Object.values(event.input ?? {})) {
				if (typeof value !== "string") continue;
				skill = findSkillReferencedByCommand(value, ctx.cwd);
				if (skill) break;
			}
			if (!skill || !confirmedSkillRead(event, skill)) return;
		}

		// Phase 2: Find skills whose globs match the read path (globs-based auto-injection)
		const toInject: SkillRecord[] = [];
		if (event.toolName === "read" && readPath) {
			const resolvedPath = resolve(readPath);
			for (const s of skills.values()) {
				if (!hasAutoInjectableGlobs(s)) continue;
				if (skill && skill.name === s.name) continue;
				// Per-turn deduplication: don't re-inject skills already loaded this turn
				if (injectedThisTurn.has(s.name)) continue;
				if (matchesGlobs(resolvedPath, s.globs!)) {
					toInject.push(s);
				}
			}
		}

		if (!skill && toInject.length === 0) return;
		if (skill) activeSkill = skill;

		// Phase 3: Build result content by prepending injected skills
		let changed = false;
		let frontmatterFields: { model?: string; thinking?: string } | undefined;

		// Start with the original content blocks
		const allBlocks: any[] = [...event.content];

		// Prepend injected skill content (only for read events with globs matches)
		for (const injSkill of toInject) {
			try {
				const rawContent = readFileSync(injSkill.filePath, "utf-8");
				// Passive injection: collect backticked references, add path context,
				// and neutralize (never execute) dynamic shell placeholders. The
				// skill's own text is never rewritten.
				const refs = collectSkillReferences(injSkill.name, rawContent, refDeps(ctx.cwd));
				let injectedText = neutralizeDynamicPlaceholders(insertSkillContext(rawContent, injSkill, ctx.cwd));
				for (const ref of refs) {
					injectedSkillNames.add(ref.skill.name);
					injectedText += `\n\n<skill name="${ref.skill.name}" location="${ref.skill.filePath}">\n${ref.decoratedBody}\n</skill>`;
				}
				allBlocks.unshift({
					type: "text",
					text: injectedText,
				});
				injectedThisTurn.add(injSkill.name);
				injectedSkillNames.add(injSkill.name);
				changed = true;
			} catch {
				// Silently skip unreadable skills
			}
		}

		// Phase 4: Process the main content blocks (skill context + dynamic shell + reference expansion)
		let addedMainContext = false;
		let mainRefs: ReturnType<typeof collectSkillReferences> = [];
		const content = await Promise.all(
			allBlocks.map(async (block) => {
				if (block.type !== "text") return block;
				// Only process blocks from the original read result, not injected skill blocks
				if (!skill || !event.content.includes(block)) return block;
				let text = block.text;
				if (!addedMainContext) {
					addedMainContext = true;
					const fields = extractFrontmatterFields(text);
					if (fields.model || fields.thinking) frontmatterFields = fields;
					text = insertSkillContext(text, skill, ctx.cwd);
					// Collect backticked `/name` references synchronously BEFORE any
					// await and reserve them in the session set: parallel tool_result
					// handlers interleave at await points, and unreserved names would
					// let both handlers append the same child.
					mainRefs = collectSkillReferences(skill.name, text, refDeps(ctx.cwd));
					for (const ref of mainRefs) injectedSkillNames.add(ref.skill.name);
					injectedSkillNames.add(skill.name);
					text = await executeDynamicShell(text, skill, ctx.cwd);
				} else {
					text = await executeDynamicShell(text, skill, ctx.cwd);
				}
				if (text !== block.text) changed = true;
				return { ...block, text };
			}),
		);

		if (mainRefs.length > 0) {
			for (const ref of mainRefs) {
				content.push({
					type: "text",
					text: `<skill name="${ref.skill.name}" location="${ref.skill.filePath}">\n${ref.decoratedBody}\n</skill>`,
				});
			}
			changed = true;
		}

		// Apply model/thinking overrides from frontmatter.
		// Fire-and-forget: takes effect for the next LLM call, not the current in-flight turn.
		if (frontmatterFields) {
			void applySkillOverrides(frontmatterFields, ctx);
		}

		if (changed) return { content };
	});

	// Restore original model/thinking when the agent finishes processing a user request.
	// The counter handles sequential skill reads within one agent loop: each valid override
	// increments; agent_end restores only when the counter drops back to zero.
	pi.on("agent_end", async (_event, ctx) => {
		injectedThisTurn.clear();
		await restoreOriginalState(ctx);
	});
}
