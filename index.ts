import { exec } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractGlobs, hasGlobs, matchesGlobs } from "./globs";
import { setupSkillAutocomplete } from "./skill-autocomplete";

type SkillRecord = {
	name: string;
	filePath: string;
	baseDir: string;
	globs?: string[];
};

const DYNAMIC_BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const DYNAMIC_INLINE_PATTERN = /(^|\s)!`([^`]+)`/gm;
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
	return { name, filePath, baseDir };
}

// ponytail: hand-rolls pi's package cache layout (github.com/<owner>/<repo> ->
// ~/.pi/agent/git/...). Only github.com git specs resolve; npm and non-github
// hosts get no pre-prompt discovery (before_agent_start still merges pi's set).
// Upgrade to an extension API exposing active skill roots when pi provides one.
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
			try {
				const content = readFileSync(skillPath, "utf-8");
				globs = extractGlobs(content);
			} catch {
				// Silently skip unreadable SKILL.md
			}
			out.push({
				name: dir.split(/[\\/]/).pop() || dir,
				filePath: skillPath,
				baseDir: dir,
				globs,
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

	function refreshSkills(cwd: string, loaded?: unknown[]) {
		const next = new Map<string, SkillRecord>();
		for (const skill of loaded ?? []) {
			const normalized = normalizeSkill(skill);
			if (normalized) next.set(normalized.name, normalized);
		}

		const roots = [
			homePath("~/.pi/agent/skills"),
			homePath("~/.agents/skills"),
			resolve(cwd, ".pi/skills"),
		];
		// Active package roots are session-static; parse settings once.
		if (!cachedPackageRoots) cachedPackageRoots = activePackageRootsFromSettings();
		// Package skills live under <pkg>/skills/** (or <pkg>/SKILL.md); don't walk the
		// whole repo tree (src/dist/tests/...) on every turn.
		for (const root of cachedPackageRoots) {
			roots.push(join(root, "skills"));
			if (existsSync(join(root, "SKILL.md"))) roots.push(root);
		}
		for (const skill of scanSkillRoots(roots)) {
			const existing = next.get(skill.name);
			if (existing) {
				// Filesystem skill may have richer data (e.g. globs). Merge globs in.
				if (skill.globs && !existing.globs) {
					next.set(skill.name, { ...existing, globs: skill.globs });
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

	function skillContextBlock(skill: SkillRecord, workspace: string): string {
		return `<skill_context>\n  <skill_dir>${skill.baseDir}</skill_dir>\n  <workspace_dir>${workspace}</workspace_dir>\n\n  <path_policy>\n    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.\n    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.\n    Use $PI_SKILL_DIR/path for explicit bundled skill files.\n    Use $PI_WORKSPACE/path for explicit workspace/project files.\n  </path_policy>\n</skill_context>`;
	}

	function insertSkillContext(text: string, skill: SkillRecord, workspace: string): string {
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

	pi.on("session_start", async (_event, ctx) => {
		refreshSkills(ctx.cwd);
		if (ctx.hasUI) setupSkillAutocomplete(ctx, () => skillList);
	});

	pi.on("turn_start", async () => {
		injectedThisTurn.clear();
	});

	pi.on("resources_discover", async (_event, ctx) => {
		refreshSkills(ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const loaded = Array.isArray(event.systemPromptOptions?.skills) ? event.systemPromptOptions.skills : undefined;
		refreshSkills(ctx.cwd, loaded);
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
		} else {
			return;
		}

		// Phase 2: Find skills whose globs match the read path (globs-based auto-injection)
		const toInject: SkillRecord[] = [];
		if (event.toolName === "read" && readPath) {
			const resolvedPath = resolve(readPath);
			for (const s of skills.values()) {
				if (!hasGlobs(s)) continue;
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
				const contextInjected = insertSkillContext(rawContent, injSkill, ctx.cwd);
				// Skip dynamic shell for auto-injected skills — it's a passive injection,
				// not an explicit skill load. Dynamic shell is a side-effect footgun.
				allBlocks.unshift({
					type: "text",
					text: contextInjected,
				});
				injectedThisTurn.add(injSkill.name);
				changed = true;
			} catch {
				// Silently skip unreadable skills
			}
		}

		// Phase 4: Process the main content blocks (skill context + dynamic shell)
		let addedMainContext = false;
		const content = await Promise.all(
			allBlocks.map(async (block) => {
				if (block.type !== "text") return block;
				// Only process blocks from the original read result, not injected skill blocks
				if (!skill || !event.content.includes(block)) return block;
				let text = block.text;
				if (!addedMainContext) {
					const fields = extractFrontmatterFields(text);
					if (fields.model || fields.thinking) frontmatterFields = fields;
					text = insertSkillContext(text, skill, ctx.cwd);
					addedMainContext = true;
				}
				text = await executeDynamicShell(text, skill, ctx.cwd);
				if (text !== block.text) changed = true;
				return { ...block, text };
			}),
		);

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