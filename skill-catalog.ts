import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import picomatch from "picomatch";
import {
	DefaultPackageManager,
	type Skill as PiSkill,
	SettingsManager,
	getAgentDir,
	loadSkills,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { neutralizeDynamicPlaceholders } from "./skill-refs";

/**
 * The skill catalog: immutable SkillDocument records (one parse per file
 * revision), glob matching, skill-resource path resolution, and the catalog
 * state built by canonical bootstrap discovery through pi public APIs.
 * Catalog instances are created per extension instance.
 */

export type SkillRecord = {
	name: string;
	filePath: string;
	baseDir: string;
	globs?: string[];
	disableModelInvocation?: boolean;
};

/** One parsed SKILL.md: identity fields, raw content, bodies, and frontmatter flags. */
export type SkillDocument = {
	filePath: string;
	raw: string;
	body: string;
	normalizedBody: string;
	passiveNormalizedBody: string;
	globs?: string[];
	disableModelInvocation: boolean;
	model?: string;
	thinking?: string;
	name?: string;
	description?: string;
};

export function homePath(path: string): string {
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

export function normalizeSkillText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export type TextBearingContent = { type: string; text?: string };

export function contentText(content: string | readonly TextBearingContent[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** True when the tool result text actually contains the skill's body opening. */
export function resultConfirmsSkillBody(resultText: string, skillBody: string): boolean {
	const body = normalizeSkillText(skillBody);
	if (!body) return false;
	return normalizeSkillText(resultText).includes(body.slice(0, 80));
}

/** True when the result contains the complete normalized skill body. */
export function resultConfirmsFullSkillBody(resultText: string, skillBody: string): boolean {
	const body = normalizeSkillText(skillBody);
	if (!body) return false;
	return normalizeSkillText(resultText).includes(body);
}

const skillDocumentCache = new Map<string, { mtimeMs: number; doc: SkillDocument }>();

/**
 * Parse a SKILL.md once per file revision. Cached on mtime so a turn that
 * confirms bodies, decorates reads, and expands references reads each file
 * at most once. Invalid-YAML files yield undefined: without parseable
 * frontmatter no body can be confirmed from them.
 */
export function skillDocument(filePath: string): SkillDocument | undefined {
	try {
		const { mtimeMs } = statSync(filePath);
		const cached = skillDocumentCache.get(filePath);
		if (cached && cached.mtimeMs === mtimeMs) return cached.doc;
		const doc = buildSkillDocument(filePath, readFileSync(filePath, "utf-8"));
		skillDocumentCache.set(filePath, { mtimeMs, doc });
		return doc;
	} catch {
		skillDocumentCache.delete(filePath);
		return undefined;
	}
}

function buildSkillDocument(filePath: string, raw: string): SkillDocument {
	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);
	const globsValue = frontmatter.globs;
	const globs = Array.isArray(globsValue)
		? globsValue.filter((glob): glob is string => typeof glob === "string" && glob.length > 0)
		: typeof globsValue === "string" && globsValue.length > 0
			? [globsValue]
			: undefined;
	const stringField = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	const trimmed = body.trim();
	return {
		filePath,
		raw,
		body: trimmed,
		normalizedBody: normalizeSkillText(trimmed),
		passiveNormalizedBody: normalizeSkillText(neutralizeDynamicPlaceholders(trimmed)),
		globs: globs && globs.length ? globs : undefined,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		model: stringField(frontmatter.model),
		thinking: stringField(frontmatter.thinking),
		name: stringField(frontmatter.name),
		description: stringField(frontmatter.description),
	};
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
		const doc = skillDocument(filePath);
		if (doc) {
			globs = globs ?? doc.globs;
			disableModelInvocation = disableModelInvocation ?? (doc.disableModelInvocation || undefined);
		}
	}

	return { name, filePath, baseDir, globs, disableModelInvocation };
}

function sameSkillRecords(left: SkillRecord, right: SkillRecord): boolean {
	if (left.filePath !== right.filePath || left.baseDir !== right.baseDir) return false;
	if (left.disableModelInvocation !== right.disableModelInvocation) return false;
	if (left.globs?.length !== right.globs?.length) return false;
	return (left.globs ?? []).every((glob, index) => glob === right.globs?.[index]);
}

function sameSkillMaps(left: Map<string, SkillRecord>, right: Map<string, SkillRecord>): boolean {
	if (left.size !== right.size) return false;
	for (const [name, skill] of left) {
		const next = right.get(name);
		if (!next || !sameSkillRecords(skill, next)) return false;
	}
	return true;
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

/** True when pi runs with `--no-skills`/`-ns`: skill discovery is disabled. */
export function cliSkillsOnly(argv: string[] = process.argv): boolean {
	return argv.includes("--no-skills") || argv.includes("-ns");
}

// ---------------------------------------------------------------------------
// Glob matching (picomatch)
// ---------------------------------------------------------------------------

/** Returns true if the skill has non-empty globs configured. */
export function hasGlobs(skill: SkillRecord): boolean {
	return Array.isArray(skill.globs) && skill.globs.length > 0;
}

export function hasAutoInjectableGlobs(skill: SkillRecord): boolean {
	return hasGlobs(skill) && !skill.disableModelInvocation;
}

/** Check if a file path matches any of the glob patterns. */
export function matchesGlobs(filePath: string, globs: string[]): boolean {
	if (globs.length === 0) return false;
	const isMatch = picomatch(globs, { dot: true, matchBase: true });
	return isMatch(filePath);
}

// ---------------------------------------------------------------------------
// Skill-resource path resolution (command rewriting and dynamic shell)
// ---------------------------------------------------------------------------

function cleanRelativePath(relPath: string): string | undefined {
	if (isAbsolute(relPath) || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(relPath) || relPath.startsWith("$")) return undefined;
	const clean = relPath.replace(/^\.\//, "");
	if (!clean || clean === "." || clean.startsWith("../")) return undefined;
	return clean;
}

function isInsideDir(path: string, dir: string): boolean {
	const target = resolve(path);
	const root = resolve(dir);
	return target === root || target.startsWith(root + "/");
}

function resolveSkillResource(skill: SkillRecord, relPath: string): string | undefined {
	const clean = cleanRelativePath(relPath);
	if (!clean) return undefined;
	const candidate = resolve(skill.baseDir, clean);
	return isInsideDir(candidate, skill.baseDir) && existsSync(candidate) ? candidate : undefined;
}

export function cwdPathExists(cwd: string, relPath: string): boolean {
	return !isAbsolute(relPath) && existsSync(resolve(cwd, relPath));
}

export function substitutePiPathVars(value: string, cwd: string, skill?: SkillRecord): string {
	let substituted = value.replace(/\$\{PI_WORKSPACE\}|\$PI_WORKSPACE\b/g, cwd);
	if (skill) substituted = substituted.replace(/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/g, skill.baseDir);
	return substituted;
}

// ---------------------------------------------------------------------------
// Catalog instance
// ---------------------------------------------------------------------------

export type SkillCatalog = ReturnType<typeof createSkillCatalog>;

/**
 * Canonical bootstrap: one DefaultPackageManager.resolve (settings, packages,
 * default roots, .agents roots, trust gating — the same resolution pi itself
 * runs) plus one loadSkills over the enabled paths. Runs only at session
 * start or an explicit resources_discover reload, never per turn. onMissing
 * returns "skip": discovery never installs. --no-skills keeps only explicit
 * CLI --skill entries.
 */
export function createSkillCatalog(options: { onCatalogChange?: () => void } = {}) {
	let skills = new Map<string, SkillRecord>();
	let skillList: SkillRecord[] = [];

	function findSkillForPath(path: string): SkillRecord | undefined {
		const targetPath = resolve(path);
		const known = Array.from(skills.values());
		const exact = known.find((skill) => resolve(skill.filePath) === targetPath);
		if (exact) return exact;

		const target = realpathOrResolve(path);
		const matching = known.find((skill) => realpathOrResolve(skill.filePath) === target);
		// Under --no-skills, an arbitrary on-disk SKILL.md must not become an
		// ad-hoc catalog record; only entries pi actually loaded still resolve.
		if (!cliSkillsOnly() && path.endsWith("SKILL.md") && existsSync(path)) {
			const baseDir = dirname(path);
			return { name: matching?.name ?? baseDir.split(/[\\/]/).pop() ?? "skill", filePath: path, baseDir };
		}
		return matching;
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

	/** A skill-resource path, resolved against one preferred skill or the one skill that owns it. */
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

	function skillRecordFromPiSkill(skill: PiSkill): SkillRecord {
		const doc = skillDocument(skill.filePath);
		return {
			name: skill.name,
			filePath: skill.filePath,
			baseDir: skill.baseDir,
			globs: doc?.globs,
			disableModelInvocation: skill.disableModelInvocation || undefined,
		};
	}

	function commitCatalog(next: Map<string, SkillRecord>): void {
		if (sameSkillMaps(skills, next)) return;
		skills = next;
		skillList = Array.from(next.values());
		options.onCatalogChange?.();
	}

	async function bootstrap(cwd: string, trusted: boolean): Promise<void> {
		// getAgentDir honors PI_CODING_AGENT_DIR instead of hardcoding the path.
		const agentDir = getAgentDir();
		const skillPaths: string[] = [];
		if (!cliSkillsOnly()) {
			const settingsManager = SettingsManager.create(cwd, agentDir);
			settingsManager.setProjectTrusted(trusted);
			const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
			const resolved = await packageManager.resolve(async () => "skip");
			for (const resource of resolved.skills) {
				if (resource.enabled) skillPaths.push(resource.path);
			}
		}
		skillPaths.push(...cliSkillPaths());
		const next = new Map<string, SkillRecord>();
		for (const skill of loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false }).skills) {
			next.set(skill.name, skillRecordFromPiSkill(skill));
		}
		commitCatalog(next);
	}

	/**
	 * Per-turn synchronization: merge pi's authoritative loaded set into the
	 * bootstrapped catalog. No filesystem or package work happens here.
	 */
	function mergeLoaded(loaded: unknown[] | undefined): void {
		if (!loaded || loaded.length === 0) return;
		const next = new Map(skills);
		for (const raw of loaded) {
			const normalized = normalizeSkill(raw);
			if (!normalized) continue;
			const existing = next.get(normalized.name);
			if (existing) {
				if ((normalized.globs && !existing.globs) || normalized.disableModelInvocation !== undefined) {
					next.set(normalized.name, {
						...existing,
						globs: existing.globs ?? normalized.globs,
						disableModelInvocation: existing.disableModelInvocation ?? normalized.disableModelInvocation,
					});
				}
			} else {
				next.set(normalized.name, normalized);
			}
		}
		commitCatalog(next);
	}

	return {
		get skills() {
			return skills;
		},
		get skillList() {
			return skillList;
		},
		bootstrap,
		mergeLoaded,
		findSkillForPath,
		findSkillReferencedByCommand,
		resolveRelativeResource,
	};
}
