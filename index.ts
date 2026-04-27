import { exec } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type SkillRecord = {
	name: string;
	filePath: string;
	baseDir: string;
};

const RESOURCE_DIRS = ["scripts", "reference", "resources", "assets", "data", "templates"];
const DYNAMIC_BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const DYNAMIC_INLINE_PATTERN = /(^|\s)!`([^`]+)`/gm;
const MAX_DYNAMIC_OUTPUT_CHARS = 50_000;
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
			out.push({ name: dir.split(/[\\/]/).pop() || dir, filePath: join(dir, "SKILL.md"), baseDir: dir });
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

export default function skillRelativePaths(pi: ExtensionAPI) {
	let skills = new Map<string, SkillRecord>();
	let activeSkill: SkillRecord | undefined;

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
		for (const skill of scanSkillRoots(roots)) {
			if (!next.has(skill.name)) next.set(skill.name, skill);
		}
		skills = next;
	}

	function isTrustedForDynamicShell(skill: SkillRecord): boolean {
		const base = realpathOrResolve(skill.baseDir);
		const trustedRoots = [realpathOrResolve(homePath("~/.pi/agent/skills")), realpathOrResolve(homePath("~/.agents/skills"))];
		const trusted = trustedRoots.some((root) => base === root || base.startsWith(`${root}/`));
		if (trusted) return true;
		return /^(1|true|yes)$/i.test(process.env.PI_TRUST_PROJECT_SKILL_SHELL ?? "");
	}

	function findSkillForPath(path: string): SkillRecord | undefined {
		const target = realpathOrResolve(path);
		return Array.from(skills.values()).find((skill) => realpathOrResolve(skill.filePath) === target);
	}

	function resolveRelativeResource(relPath: string): string | undefined {
		const clean = relPath.replace(/^\.\//, "");
		const matches: string[] = [];
		for (const skill of skills.values()) {
			const candidate = join(skill.baseDir, clean);
			if (existsSync(candidate)) matches.push(candidate);
		}
		return matches.length === 1 ? matches[0] : undefined;
	}

	function ensureSkillResourceLinks(cwd: string) {
		for (const skill of skills.values()) {
			for (const resourceDir of RESOURCE_DIRS) {
				const sourceRoot = join(skill.baseDir, resourceDir);
				if (!existsSync(sourceRoot)) continue;

				const linkFiles = (dir: string, relDir = "") => {
					let entries: ReturnType<typeof readdirSync>;
					try {
						entries = readdirSync(dir, { withFileTypes: true });
					} catch {
						return;
					}

					for (const entry of entries) {
						const source = join(dir, entry.name);
						const rel = join(relDir, entry.name);
						const target = join(cwd, resourceDir, rel);
						if (entry.isDirectory()) {
							linkFiles(source, rel);
							continue;
						}
						try {
							if (existsSync(target)) continue;
							mkdirSync(dirname(target), { recursive: true });
							symlinkSync(source, target);
						} catch {
							// Never let convenience symlink creation break agent startup.
						}
					}
				};

				linkFiles(sourceRoot);
			}
		}
	}

	function cwdPathExists(cwd: string, relPath: string): boolean {
		return !isAbsolute(relPath) && existsSync(resolve(cwd, relPath));
	}

	function substitutePiPathVars(value: string, cwd: string, skill?: SkillRecord): string {
		let substituted = value.replace(/\$\{PI_WORKSPACE\}|\$PI_WORKSPACE\b/g, cwd);
		if (skill) substituted = substituted.replace(/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/g, skill.baseDir);
		return substituted;
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

		// Fix paths relative to the skill root, e.g. scripts/exa.sh or
		// reference/troubleshooting.md, when the target is unique across skills.
		const dirs = RESOURCE_DIRS.join("|");
		const resourceRegex = new RegExp("(^|[\\\\s\\\"'(=;|&])((?:\\\\./)?(?:" + dirs + ")\\\\/[^\\\\s\\\"'`;|&<>)]*)", "g");
		rewritten = rewritten.replace(resourceRegex, (match, prefix: string, relPath: string) => {
			if (isAbsolute(relPath) || cwdPathExists(cwd, relPath)) return match;
			const absolute = resolveRelativeResource(relPath);
			return absolute ? `${prefix}${maybeQuote(absolute, match)}` : match;
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

	pi.on("session_start", async (_event, ctx) => {
		refreshSkills(ctx.cwd);
		ensureSkillResourceLinks(ctx.cwd);
	});

	pi.on("resources_discover", async (_event, ctx) => {
		refreshSkills(ctx.cwd);
		ensureSkillResourceLinks(ctx.cwd);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const loaded = Array.isArray(event.systemPromptOptions?.skills) ? event.systemPromptOptions.skills : undefined;
		refreshSkills(ctx.cwd, loaded);
		ensureSkillResourceLinks(ctx.cwd);
		return {
			systemPrompt:
				event.systemPrompt +
				`\n\n<agent_skills>
  <path_policy>
    Workspace-relative paths run from the current pi workspace.
    Skill references are relative to the skill directory shown in the loaded skill block.
    Use $PI_SKILL_DIR/path when an explicit bundled-skill path is needed.
    Existing skill docs using scripts/... or reference/... are supported; do not explain or rewrite them unless a tool call fails or the path is ambiguous.
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
			if (!isAbsolute(input.path) && !cwdPathExists(ctx.cwd, input.path)) {
				const absolute = resolveRelativeResource(input.path);
				if (absolute) input.path = absolute;
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const inputPath = typeof event.input.path === "string" ? event.input.path : undefined;
		if (!inputPath) return;
		const skill = findSkillForPath(inputPath);
		if (!skill) return;
		activeSkill = skill;

		let changed = false;
		let addedSkillContext = false;
		const content = await Promise.all(
			event.content.map(async (block) => {
				if (block.type !== "text") return block;
				let text = block.text;
				if (!addedSkillContext) {
					text = `<skill_context>\nBase directory for this skill: ${skill.baseDir}\nWorkspace directory: ${ctx.cwd}\nUse $PI_SKILL_DIR for bundled skill files. Use $PI_WORKSPACE for workspace files.\n</skill_context>\n\n${text}`;
					addedSkillContext = true;
					changed = true;
				}
				text = await executeDynamicShell(text, skill, ctx.cwd);
				if (text !== block.text) changed = true;
				return { ...block, text };
			}),
		);
		if (changed) return { content };
	});

	pi.registerCommand("skill-paths", {
		description: "Show loaded skill directories used for relative path rewriting",
		handler: async (_args, ctx) => {
			refreshSkills(ctx.cwd);
			const lines = Array.from(skills.values())
				.sort((a, b) => a.name.localeCompare(b.name))
				.map((skill) => `${skill.name}: ${skill.baseDir}`);
			ctx.ui.notify(lines.length ? lines.join("\n") : "No skills found", "info");
		},
	});
}
