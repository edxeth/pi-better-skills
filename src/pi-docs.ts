import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContextWithSystemEvent, ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
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

/** Same flag pi core uses; extension skillPaths bypass it, so we honor it ourselves. */
export function hasNoSkillsFlag(argv: readonly string[] = process.argv): boolean {
	for (const arg of argv) {
		if (arg === "--") return false;
		if (arg === "--no-skills" || arg === "-ns") return true;
	}
	return false;
}

/**
 * The pi-docs block carried by a stock prompt when every guard passes: feature
 * enabled, --no-skills absent, anchors matched. Undefined (fail open)
 * otherwise. `argv` is injectable for tests.
 */
function capturePiDocsBlock(systemPrompt: string, argv: readonly string[]): string | undefined {
	if (!piDocsFeatureEnabled()) return undefined;
	if (hasNoSkillsFlag(argv)) return undefined;
	return stripPiDocsBlock(systemPrompt)?.block;
}

/**
 * Discovery callback handed to the extension by registerPiDocsRequestStrip.
 * Call it once from resources_discover with `ctx.getSystemPrompt()`: it captures
 * the block, syncs the generated skill file, and returns the skillPaths
 * registration. Undefined — and this instance's strip disarmed — when the
 * feature is off, --no-skills is set, the anchors drift, or the skill file
 * cannot be written. `argv` is injectable for tests.
 */
export type DiscoverPiDocsSkill = (
	systemPrompt: string,
	argv?: readonly string[],
) => { skillPaths: string[] } | undefined;

// ---------------------------------------------------------------------------
// Per-request strip (context_with_system)
// ---------------------------------------------------------------------------
// The before_agent_start strip is a request-local forced prompt: it never
// reaches idle-triggered turns (sendCustomMessage with triggerTurn runs
// _runAgentPrompt directly) and tool continuations fall back to the base
// prompt, so the docs block returns mid-session. The context_with_system hook
// runs on EVERY model request before provider conversion, on a transcript
// clone, so removing the docs block there is per-request and touches nothing
// persisted.

/** System message content of a request clone, from pi's public ContextWithSystemEvent. */
export type PiDocsRequestMessages = ContextWithSystemEvent["messages"];

/** The slice of pi.getCommands() the loaded check needs (public SlashCommandInfo shape). */
type LoadedCommand = Pick<SlashCommandInfo, "name" | "source" | "sourceInfo">;

/**
 * Whether pi's authoritative loaded skill set currently contains OUR generated
 * pi-docs skill, as projected by pi.getCommands() — the same authority pi core
 * uses for skill resolution (both project resourceLoader.getSkills()).
 * sourceInfo.path is the skill's SKILL.md file path, so a user's own pi-docs
 * skill winning the first-wins collision stands us down.
 */
export function hasLoadedPiDocsCommand(commands: ReadonlyArray<LoadedCommand>, agentDir: string): boolean {
	const ourPath = resolve(piDocsSkillFilePath(agentDir));
	return commands.some(
		(command) =>
			command.source === "skill" &&
			command.name === `skill:${PI_DOCS_SKILL_NAME}` &&
			command.sourceInfo?.path !== undefined &&
			resolve(command.sourceInfo.path) === ourPath,
	);
}

/**
 * Remove the exact captured block from flat or section-shaped prompt text:
 * pi >= 0.87 removes the whole <docs> section so no empty wrapper remains,
 * flat pi drops the blank-line-joined block plus one join. Returns undefined
 * when neither exact shape is present.
 */
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

/**
 * Remove the exact captured docs block from one system message of the request
 * clone: drop an initial `docs` section, or replace a later patch with a
 * removal marker so superseded docs cannot return. Flat pi
 * as blank-line-joined content (excise it). Everything else — other sections,
 * content, toolsAdded/toolsRemoved, timestamp, order — is preserved by only
 * rebuilding the message when a change fires. Returns undefined when the
 * message holds no exact captured block (fail open on drift or foreign docs).
 */
function stripPiDocsFromSystemMessage(
	message: PiDocsRequestMessages[number],
	block: string,
	initial: boolean,
): PiDocsRequestMessages[number] | undefined {
	if (message.role !== "system") return undefined;
	let next = message;
	const section = `${DOCS_SECTION_OPEN}${block}${DOCS_SECTION_CLOSE}`;
	if (next.sections?.docs === section) {
		const { docs: _removed, ...remainingSections } = next.sections;
		// A later patch must still replace any earlier docs, not reveal them again.
		next = { ...next, sections: initial ? remainingSections : { ...remainingSections, docs: null } };
	}
	if (typeof next.content === "string" && next.content.includes(block)) {
		const strippedContent = stripCapturedPiDocsBlock(next.content, block);
		if (strippedContent !== undefined) next = { ...next, content: strippedContent };
	}
	return next === message ? undefined : next;
}

/**
 * Strip the captured docs block from every system message of a request clone.
 * Returns undefined (callers keep the original messages) when no system
 * message changed, so unaffected requests ship their original message list.
 */
export function stripPiDocsFromRequestMessages(
	messages: PiDocsRequestMessages,
	block: string,
): PiDocsRequestMessages | undefined {
	let changed = false;
	const stripped = messages.map((message, index) => {
		if (message.role !== "system") return message;
		const next = stripPiDocsFromSystemMessage(message, block, index === 0);
		if (!next) return message;
		changed = true;
		return next;
	});
	return changed ? stripped : undefined;
}

/**
 * Request-time gate, applied to the full request transcript. Same invariants
 * as the discovery capture — feature enabled, a fresh capture, and the loaded
 * skill at our exact generated path — then exact-text removal, so no
 * re-parsing of a possibly-modified prompt.
 *
 * No read-tool check on purpose: verified live that the event's tool set does
 * not reflect the prompt-build toolset, so that predicate would disable the
 * feature everywhere. Residual: a session whose toolset cannot read files at
 * all AND suppresses the skills section keeps the stock block only if the user
 * exports PI_BETTER_SKILLS_NO_PI_DOCS.
 */
export function applyPiDocsRequestStrip(
	messages: PiDocsRequestMessages,
	capturedBlock: string | undefined,
	commands: ReadonlyArray<LoadedCommand>,
	agentDir: string = getAgentDir(),
): PiDocsRequestMessages | undefined {
	if (!piDocsFeatureEnabled()) return undefined;
	if (!capturedBlock) return undefined;
	if (!hasLoadedPiDocsCommand(commands, agentDir)) {
		piDocsDebug("skill not loaded at our path, staying stock");
		return undefined;
	}
	const stripped = stripPiDocsFromRequestMessages(messages, capturedBlock);
	if (stripped) piDocsDebug("stripped docs from request system messages");
	return stripped;
}

/**
 * Register the per-request docs strip and get this instance's discovery
 * callback. In the extension factory: `const discoverPiDocsSkill =
 * registerPiDocsRequestStrip(pi)`, then the existing resources_discover handler
 * returns `discoverPiDocsSkill(ctx.getSystemPrompt())`. The context_with_system
 * handler then trims the captured block from every model request of the
 * session, including idle-triggered turns and tool continuations.
 *
 * Capture state is per extension instance, not module-global: one session's
 * discovery — successful, drifted, or failed — can never arm, re-arm, or
 * disarm another session's strip.
 *
 * The loaded-skill check goes through the factory `pi` API: an event-handler
 * ctx has no getCommands, while `pi.getCommands()` projects the live resource
 * loader on every call. If the captured API ever goes stale (session
 * replacement), the throw surfaces as an extension error and the request
 * ships unstripped — the replacement session's factory re-registers anyway.
 */
export function registerPiDocsRequestStrip(pi: ExtensionAPI, agentDir: string = getAgentDir()): DiscoverPiDocsSkill {
	// This instance's captured block; only this instance's discovery sets or clears it.
	let capturedBlock: string | undefined;

	pi.on("context_with_system", async (event) => {
		const stripped = applyPiDocsRequestStrip(event.messages, capturedBlock, pi.getCommands(), agentDir);
		return stripped ? { messages: stripped } : undefined;
	});

	return (systemPrompt, argv = process.argv) => {
		capturedBlock = undefined;
		const block = capturePiDocsBlock(systemPrompt, argv);
		if (!block) return undefined;
		try {
			syncPiDocsSkillFile(agentDir, block);
		} catch {
			piDocsDebug("skill sync failed, staying stock", { agentDir });
			return undefined;
		}
		capturedBlock = block;
		piDocsDebug("registered pi-docs skill", { path: piDocsSkillDirPath(agentDir) });
		return { skillPaths: [piDocsSkillDirPath(agentDir)] };
	};
}
