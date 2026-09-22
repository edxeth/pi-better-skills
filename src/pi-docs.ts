import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * pi-docs skill: replaces pi core's built-in "Pi documentation" system-prompt
 * block with a generated skill, so the block's content loads on demand instead
 * of riding in every request. The block is inherited from the live prompt at
 * capture time, keeping the skill body in lockstep with the installed pi.
 */

export const PI_DOCS_SKILL_NAME = "pi-docs";

const BLOCK_HEADER =
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
/** Flat prompts (pi < 0.87) blank-line join the block to the previous section. */
const FLAT_BLOCK_START_ANCHOR = `\n\n${BLOCK_HEADER}`;
/** pi >= 0.87 wraps each prompt section in a <name> tag; the block sits inside <docs>. */
const DOCS_SECTION_OPEN = "<docs>\n";
const DOCS_SECTION_START_ANCHOR = `${DOCS_SECTION_OPEN}${BLOCK_HEADER}`;
const DOCS_SECTION_CLOSE = "\n</docs>";
const FIRST_BULLET_PREFIX = "- Main documentation: ";
/** Positive bound on the bullet run: pi's block has 7; a longer run means the anchors drifted. */
const MAX_BLOCK_BULLETS = 32;

function findPiDocsBulletRunEnd(lines: readonly string[]): number | undefined {
	let index = 1; // lines[0] is the header itself
	if (lines[index] === "") index += 1;
	if (!lines[index]?.startsWith(FIRST_BULLET_PREFIX)) return undefined;

	let bullets = 0;
	while (lines[index]?.startsWith("- ")) {
		if (bullets === MAX_BLOCK_BULLETS) return undefined;
		bullets += 1;
		index += 1;
	}
	return index;
}

/**
 * Detects pi's built-in documentation block and removes it from the prompt.
 * Structural, not verbatim: anchors on the header line and the first bullet
 * label, then consumes the bullet run regardless of wording inside bullets.
 * Handles both prompt shapes: pi < 0.87 blank-line joins the block to the
 * previous section, while pi >= 0.87 wraps it in a <docs> section tag (the
 * whole section is removed so no empty wrapper is left behind).
 * Returns undefined (fail-open) whenever the anchors do not match, so prompt
 * drift degrades to stock pi rather than a mangled prompt.
 */
export function stripPiDocsBlock(systemPrompt: string): { prompt: string; block: string } | undefined {

	const flatStart = systemPrompt.indexOf(FLAT_BLOCK_START_ANCHOR);
	const sectionStart = systemPrompt.indexOf(DOCS_SECTION_START_ANCHOR);
	if (flatStart < 0 && sectionStart < 0) return undefined;

	// A prompt carries only one of the two shapes; prefer whichever matches first.
	const sectionWrapped = sectionStart >= 0 && (flatStart < 0 || sectionStart < flatStart);
	const headerIndex = sectionWrapped
		? sectionStart + DOCS_SECTION_START_ANCHOR.length - BLOCK_HEADER.length
		: flatStart + FLAT_BLOCK_START_ANCHOR.length - BLOCK_HEADER.length;

	const lines = systemPrompt.slice(headerIndex).split("\n");
	const end = findPiDocsBulletRunEnd(lines);
	if (end === undefined) return undefined;

	const consumed = lines.slice(0, end).reduce((length, line) => length + line.length + 1, 0);
	const block = systemPrompt.slice(headerIndex, headerIndex + consumed).replace(/\n$/, "");

	if (!sectionWrapped) {
		const tail = systemPrompt.slice(headerIndex + consumed).replace(/^\n/, "");
		return { prompt: `${systemPrompt.slice(0, headerIndex - 2)}\n\n${tail}`, block };
	}
	// The closing tag must directly follow the bullet run; anything else means
	// the section layout drifted, so fail open.
	const closeIndex = headerIndex + consumed - 1;
	if (!systemPrompt.startsWith(DOCS_SECTION_CLOSE, closeIndex)) return undefined;
	return { prompt: exciseJoinedRange(systemPrompt, sectionStart, closeIndex + DOCS_SECTION_CLOSE.length), block };
}

/** Remove [start, end) plus one adjacent blank-line join, so neighboring prompt sections re-join cleanly. */
function exciseJoinedRange(text: string, start: number, end: number): string {
	if (text.startsWith("\n\n", end)) return text.slice(0, start) + text.slice(end + 2);
	if (text.startsWith("\n\n", start - 2)) return text.slice(0, start - 2) + text.slice(end);
	return text.slice(0, start) + text.slice(end);
}

/** Authored once, deliberately generic: it must not enumerate doc topics that pi may add or remove. */
export const PI_DOCS_SKILL_DESCRIPTION =
	"Absolute paths to the installed pi package README, docs/, and examples/ on this machine, plus guidance on which doc to consult for which pi topic. Use for any question or task about pi itself or pi development, including its SDK, extensions, custom tools, themes, skills, TUI, keybindings, models, or pi internals. Read it before implementing pi-related changes.";

/** The skill body is the captured block verbatim, so it always matches the installed pi's wording. */
export function renderPiDocsSkillMd(block: string): string {
	return `---
name: ${PI_DOCS_SKILL_NAME}
description: ${PI_DOCS_SKILL_DESCRIPTION}
---

# Pi documentation

${block}
`;
}

/** Stored outside pi's natively discovered skill roots; only skillPaths registration exposes it. */
export function piDocsSkillDirPath(agentDir: string): string {
	return join(agentDir, "cache", "pi-better-skills", PI_DOCS_SKILL_NAME);
}

/** Return the generated pi-docs skill file path for an agent directory. */
export function piDocsSkillFilePath(agentDir: string): string {
	return join(piDocsSkillDirPath(agentDir), "SKILL.md");
}

/**
 * Keeps the on-disk skill in lockstep with the captured block. Compare-before-write,
 * so unchanged sessions do not touch the file. Returns whether content was written.
 */
export function syncPiDocsSkillFile(agentDir: string, block: string): { path: string; written: boolean } {
	const dir = piDocsSkillDirPath(agentDir);
	const path = join(dir, "SKILL.md");
	const content = renderPiDocsSkillMd(block);
	if (existsSync(path) && readFileSync(path, "utf8") === content) {
		return { path, written: false };
	}
	mkdirSync(dir, { recursive: true });
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, content, "utf8");
	renameSync(tempPath, path);
	return { path, written: true };
}

const PI_DOCS_OPT_OUT_ENV = "PI_BETTER_SKILLS_NO_PI_DOCS";
const OPT_OUT_OFF_VALUES = new Set(["", "0", "false", "no", "off"]);

/** Maintainer diagnostics: PI_BETTER_SKILLS_DEBUG=1 pi ... — never user-facing. */
function piDocsDebug(message: string, details?: Record<string, unknown>): void {
	if (process.env.PI_BETTER_SKILLS_DEBUG !== "1") return;
	console.error(`[pi-better-skills:pi-docs] ${message}${details ? ` ${JSON.stringify(details)}` : ""}`);
}

/**
 * Default-on. Users who prefer pi's stock prompt can opt out by exporting
 * PI_BETTER_SKILLS_NO_PI_DOCS=1 (or any truthy value; 0/false/no/off keep it on).
 */
export function piDocsFeatureEnabled(env: Record<string, string | undefined> = process.env): boolean {
	const value = env[PI_DOCS_OPT_OUT_ENV];
	if (value === undefined || OPT_OUT_OFF_VALUES.has(value.toLowerCase())) return true;
	return false;
}

/** The block captured during the current discovery pass. */
let lastCapturedPiDocsBlock: string | undefined;

/** Same flag pi core uses; extension skillPaths bypass it, so we honor it ourselves. */
export function hasNoSkillsFlag(argv: readonly string[] = process.argv): boolean {
	for (const arg of argv) {
		if (arg === "--") return false;
		if (arg === "--no-skills" || arg === "-ns") return true;
	}
	return false;
}

/**
 * Capture the current pi-docs block and expose its generated skill directory to pi.
 * When pi's prompt drifts past the anchors, the skill is not registered and the
 * session stays stock pi. `agentDir` is injectable for tests.
 */
export function piDocsSkillRegistration(
	systemPrompt: string,
	agentDir: string = getAgentDir(),
	argv: readonly string[] = process.argv,
): { skillPaths: string[] } | undefined {
	lastCapturedPiDocsBlock = undefined;
	if (!piDocsFeatureEnabled()) return undefined;
	if (hasNoSkillsFlag(argv)) return undefined;
	const stripped = stripPiDocsBlock(systemPrompt);
	if (!stripped) return undefined;
	try {
		syncPiDocsSkillFile(agentDir, stripped.block);
	} catch {
		piDocsDebug("skill sync failed, staying stock", { agentDir });
		return undefined;
	}
	lastCapturedPiDocsBlock = stripped.block;
	piDocsDebug("registered pi-docs skill", { path: piDocsSkillDirPath(agentDir) });
	return { skillPaths: [piDocsSkillDirPath(agentDir)] };
}

/** What before_agent_start can know authoritatively about the loaded skill set. */
export interface PiDocsStripOptions {
	skills?: ReadonlyArray<{ name?: string; filePath?: string }> | undefined;
	selectedTools?: readonly string[] | undefined;
}

/**
 * Strip is a consequence of a visible replacement, never a second opinion:
 * it fires only when this process captured the block at discovery time AND pi's
 * authoritative loaded set contains pi-docs at our exact generated path (a
 * user's own pi-docs skill wins first-wins collisions and stands down the strip).
 * Removes the exact captured text, so no re-parsing of a possibly-modified prompt.
 *
 * No read-tool check on purpose: verified live that event.systemPromptOptions
 * .selectedTools does not reflect the prompt-build toolset (this environment
 * runs exec_command/apply_patch with no "read", pi still renders the skills
 * section after before_agent_start), so that predicate would disable the
 * feature everywhere. Residual: a session whose toolset cannot read files at
 * all AND suppresses the skills section keeps the stock block only if the user
 * exports PI_BETTER_SKILLS_NO_PI_DOCS.
 */
export function applyPiDocsStrip(
	systemPrompt: string,
	options: PiDocsStripOptions = {},
	agentDir: string = getAgentDir(),
): string | undefined {
	debugPiDocsStrip(systemPrompt, options);
	if (!piDocsFeatureEnabled()) return undefined;
	const block = lastCapturedPiDocsBlock;
	if (!block) return undefined;
	if (!systemPrompt.includes(block)) return undefined;
	if (!hasLoadedPiDocsSkill(options, agentDir)) {
		piDocsDebug("skill not loaded at our path, staying stock");
		return undefined;
	}
	return stripCapturedPiDocsBlock(systemPrompt, block);
}

function debugPiDocsStrip(systemPrompt: string, options: PiDocsStripOptions): void {
	if (process.env.PI_BETTER_SKILLS_DEBUG !== "1") return;
	try {
		writeFileSync(`/tmp/pi-better-skills-pidocs-prompt-${process.pid}.txt`, systemPrompt);
		piDocsDebug("dumped strip-time prompt", { skills: options.skills?.length, selectedTools: options.selectedTools });
	} catch {
		// Diagnostics must never break the strip path.
	}
}

function hasLoadedPiDocsSkill(options: PiDocsStripOptions, agentDir: string): boolean {
	const ourPath = piDocsSkillFilePath(agentDir);
	return Boolean(options.skills?.some((skill) => skill.filePath === ourPath));
}

function stripCapturedPiDocsBlock(systemPrompt: string, block: string): string | undefined {
	// pi >= 0.87: remove the whole <docs> section so no empty wrapper remains.
	const section = `${DOCS_SECTION_OPEN}${block}${DOCS_SECTION_CLOSE}`;
	const sectionStart = systemPrompt.indexOf(section);
	if (sectionStart >= 0) {
		return exciseJoinedRange(systemPrompt, sectionStart, sectionStart + section.length);
	}

	// Flat pi: the block is blank-line joined to its neighbors; drop it plus one join.
	const anchor = `\n\n${block}`;
	const start = systemPrompt.indexOf(anchor);
	if (start < 0) return undefined;
	const tail = systemPrompt.slice(start + anchor.length).replace(/^\n+/, "");
	return tail ? `${systemPrompt.slice(0, start)}\n\n${tail}` : systemPrompt.slice(0, start);
}
