import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	contentText,
	hasAutoInjectableGlobs,
	homePath,
	matchesGlobs,
	realpathOrResolve,
	resultConfirmsSkillBody,
	resultConfirmsFullSkillBody,
	skillDocument,
	type SkillCatalog,
	type SkillDocument,
	type SkillRecord,
} from "./skill-catalog";
import type { SkillResidency } from "./skill-residency";
import {
	DYNAMIC_BLOCK_PATTERN,
	DYNAMIC_INLINE_PATTERN,
	collectSkillReferences,
	neutralizeDynamicPlaceholders,
	type RefDeps,
} from "./skill-refs";
import { extractPathCandidates } from "./tool-paths";

/**
 * Delivery: build a typed plan for one tool result, then apply it with one
 * reservation commit point and one release path. Detection and resolution
 * never mutate state or run shells; only apply does.
 */

const execAsync = promisify(exec);
const MAX_DYNAMIC_OUTPUT_CHARS = 50_000;

export function skillContextBlock(skill: { baseDir: string }, workspace: string): string {
	return [
		"<skill_context>",
		"  <skill_dir>" + skill.baseDir + "</skill_dir>",
		"  <workspace_dir>" + workspace + "</workspace_dir>",
		"",
		"  <path_policy>",
		"    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.",
		"    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.",
		"    Use $PI_SKILL_DIR/path for explicit bundled skill files.",
		"    Use $PI_WORKSPACE/path for explicit workspace/project files.",
		"  </path_policy>",
		"</skill_context>",
	].join("\n");
}

export function insertSkillContext(text: string, skill: { baseDir: string }, workspace: string, body?: string): string {
	if (text.includes("<skill_context>")) return text;
	const context = skillContextBlock(skill, workspace);
	const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	if (!frontmatter) {
		// A wrapped tool can prefix status text before the body; place the
		// context adjacent to the body rather than before the status text.
		const bodyIndex = body ? text.indexOf(body) : -1;
		if (bodyIndex > 0) {
			return text.slice(0, bodyIndex) + context + "\n\n" + text.slice(bodyIndex);
		}
		return context + "\n\n" + text;
	}
	const end = frontmatter[0].length;
	const rest = text.slice(end).replace(/^\r?\n/, "");
	return text.slice(0, end) + "\n" + context + "\n\n" + rest;
}

function isTrustedForDynamicShell(skill: SkillRecord): boolean {
	const base = realpathOrResolve(skill.baseDir);
	const trustedRoots = [realpathOrResolve(homePath("~/.pi/agent/skills")), realpathOrResolve(homePath("~/.agents/skills"))];
	const trusted = trustedRoots.some((root) => base === root || base.startsWith(root + "/"));
	if (trusted) return true;
	return /^(1|true|yes)$/i.test(process.env.PI_TRUST_PROJECT_SKILL_SHELL ?? "");
}

function formatShellOutput(stdout: string, stderr: string): string {
	const parts: string[] = [];
	if (stdout.trim()) parts.push(stdout.trim());
	if (stderr.trim()) parts.push("[stderr]\n" + stderr.trim());
	const output = parts.join("\n");
	return output.length > MAX_DYNAMIC_OUTPUT_CHARS ? output.slice(0, MAX_DYNAMIC_OUTPUT_CHARS) + "\n[output truncated]" : output;
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
		const status = err.killed ? "timed out" + (err.signal ? " (" + err.signal + ")" : "") : "failed" + (typeof err.code === "number" ? " with code " + err.code : "");
		return "[dynamic shell " + status + ": " + command + (output ? "\n" + output : err.message ? "\n" + err.message : "") + "]";
	}
}

async function executeDynamicShell(content: string, skill: SkillRecord, workspace: string): Promise<string> {
	const INLINE_MARK = "!" + String.fromCharCode(96);
	const BLOCK_MARK = String.fromCharCode(96, 96, 96) + "!";
	if (!content.includes(INLINE_MARK) && !content.includes(BLOCK_MARK)) return content;
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
		replacements.push({ match: match[0], replacement: (match[1] ?? "") + (await runDynamicCommand(command, skill, workspace)) });
	}

	for (const { match, replacement } of replacements) {
		transformed = transformed.replace(match, () => replacement);
	}
	return transformed;
}

export type SkillDelivery = ReturnType<typeof createSkillDelivery>;

type DeliveryRef = ReturnType<typeof collectSkillReferences>[number];
/** One glob-matched skill to prepend, with its document and carried references. */
type DeliveryPrepend = { skill: SkillRecord; doc: SkillDocument; refs: DeliveryRef[] };
/** A fully built, not-yet-applied skill delivery for one tool result. */
type SkillDeliveryPlan = {
	directSkill: SkillRecord | undefined;
	directBodyComplete: boolean;
	directDoc: SkillDocument | undefined;
	/** Index into the original content blocks of the block to decorate. */
	decorateIndex: number;
	modelOverride: { model?: string; thinking?: string } | undefined;
	prepends: DeliveryPrepend[];
	appends: DeliveryRef[];
};
export type DeliveryEvent = {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
};

export function createSkillDelivery(deps: {
	catalog: SkillCatalog;
	residency: SkillResidency;
	applyOverrides: (fields: { model?: string; thinking?: string }, ctx: ExtensionContext) => Promise<void>;
}) {
	const { catalog, residency, applyOverrides } = deps;

	function refDeps(cwd: string): RefDeps {
		return {
			// Deliberately unfiltered: skills with disable-model-invocation stay
			// referenceable — referencing a sibling from a loaded skill is an
			// explicit author choice, unlike passive globs auto-injection.
			resolve: (name) => catalog.skills.get(name),
			readBody: (skill) => skillDocument(skill.filePath)?.body,
			decorate: (body, skill) => insertSkillContext(body, skill, cwd),
			alreadyInjected: (name) => residency.hasKnown(name),
		};
	}

	function confirmedCompleteSkillRead(event: { content: Array<{ type: string; text?: string }> }, skill: SkillRecord): boolean {
		const body = skillDocument(skill.filePath)?.body;
		return body ? resultConfirmsFullSkillBody(contentText(event.content), body) : false;
	}

	function confirmedSkillRead(event: { content: Array<{ type: string; text?: string }> }, skill: SkillRecord): boolean {
		const body = skillDocument(skill.filePath)?.body;
		if (!body) return false;
		// Partial output (head/cat prefixes) still counts as a skill read; only
		// the complete-body check gates residency claims.
		return resultConfirmsSkillBody(contentText(event.content), body);
	}

	/** Detection and resolution only: no claims, no mutations, no shell runs. */
	function buildDeliveryPlan(event: DeliveryEvent, ctx: ExtensionContext): SkillDeliveryPlan | undefined {
		// Phase 1: identify the directly targeted skill (SKILL.md read / command
		// referencing SKILL.md).
		let skill: SkillRecord | undefined;
		let skillBodyComplete = false;

		if (event.toolName === "read") {
			const inputPath = typeof event.input.path === "string" ? event.input.path : undefined;
			if (inputPath) skill = catalog.findSkillForPath(inputPath);
			if (skill) skillBodyComplete = confirmedCompleteSkillRead(event, skill);
		} else if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : undefined;
			if (command) skill = catalog.findSkillReferencedByCommand(command, ctx.cwd);
			if (skill && !confirmedSkillRead(event, skill)) return undefined;
			if (skill) skillBodyComplete = confirmedCompleteSkillRead(event, skill);
		} else {
			// Tool-agnostic skill detection: any tool (e.g. an MCP exec wrapper)
			// whose input strings reference a known SKILL.md path counts as a
			// skill read and gets the same enrichment as core read/bash.
			// Writes are excluded here (a write is not a skill read), and the
			// result must actually contain the skill body — commands that merely
			// mention the path (echo/stat/ls) must not mark a skill loaded or
			// receive enrichment. Writes still join every other tool in the
			// globs matching below.
			if (event.toolName !== "edit" && event.toolName !== "write") {
				for (const value of Object.values(event.input ?? {})) {
					if (typeof value !== "string") continue;
					skill = catalog.findSkillReferencedByCommand(value, ctx.cwd);
					if (skill) break;
				}
			}
			if (skill && !confirmedSkillRead(event, skill)) return undefined;
			if (skill) skillBodyComplete = confirmedCompleteSkillRead(event, skill);
		}

		// Phase 2: find skills whose globs match a path named by arbitrary tool
		// input. Bounded extraction keeps this tool-agnostic: structured location
		// keys, lists, bases, and path-looking strings can all trigger a match,
		// so wrapped file tools and shell tools keep the same behavior.
		// Candidates must exist on disk.
		const prepends: DeliveryPrepend[] = [];
		const candidatePaths = extractPathCandidates(event.input, ctx.cwd).filter((candidate) => existsSync(candidate));
		for (const candidate of catalog.skills.values()) {
			if (!hasAutoInjectableGlobs(candidate)) continue;
			if (skill && skillBodyComplete && skill.name === candidate.name) continue;
			// Session-scoped deduplication: the body stays in the transcript, so
			// a skill already in context is never injected a second time.
			if (residency.hasKnown(candidate.name)) continue;
			if (!candidatePaths.some((path) => matchesGlobs(path, candidate.globs!))) continue;
			const doc = skillDocument(candidate.filePath);
			if (!doc) continue; // unreadable skills are skipped without claims
			const refs = collectSkillReferences(candidate.name, doc.raw, refDeps(ctx.cwd));
			prepends.push({ skill: candidate, doc, refs });
		}

		if (!skill && prepends.length === 0) return undefined;

		// Phase 3: resolve the decorated block, the frontmatter override, and
		// the direct skill's appended references. Indices refer to the original
		// content; apply shifts them by the number of prepended blocks.
		const doc = skill && skillBodyComplete ? skillDocument(skill.filePath) : undefined;
		const skillBody = doc?.body ?? "";
		const bodyBlockIndex = skillBody
			? event.content.findIndex(
					(block) =>
						block.type === "text" && typeof block.text === "string" && resultConfirmsFullSkillBody(block.text, skillBody),
				)
			: -1;
		const decorateIndex = bodyBlockIndex >= 0 ? bodyBlockIndex : event.content.findIndex((block) => block.type === "text");
		let modelOverride: { model?: string; thinking?: string } | undefined;
		const appends: DeliveryRef[] = [];
		if (skill && decorateIndex >= 0) {
			const decorated = event.content[decorateIndex];
			if (bodyBlockIndex >= 0) {
				modelOverride = doc && (doc.model || doc.thinking) ? { model: doc.model, thinking: doc.thinking } : undefined;
			} else {
				// Partial reads keep the previous behavior: read the decorated
				// block's own frontmatter, never the whole file.
				const text = typeof decorated?.text === "string" ? decorated.text : "";
				try {
					const fm = parseFrontmatter<Record<string, unknown>>(text).frontmatter;
					const model = typeof fm.model === "string" ? fm.model.trim() : undefined;
					const thinking = typeof fm.thinking === "string" ? fm.thinking.trim() : undefined;
					modelOverride = model || thinking ? { model, thinking } : undefined;
				} catch {
					modelOverride = undefined;
				}
			}
			// Collect references from every original text block, not just the
			// decorated one: wrapped tools can split a body across blocks.
			appends.push(...collectSkillReferences(skill.name, contentText(event.content), refDeps(ctx.cwd)));
		}

		return {
			directSkill: skill,
			directBodyComplete: skillBodyComplete,
			directDoc: doc,
			decorateIndex,
			modelOverride,
			prepends,
			appends,
		};
	}

	/** One commit point for reservations, one release path, one apply order. */
	async function applyDeliveryPlan(
		event: DeliveryEvent,
		plan: SkillDeliveryPlan,
		ctx: ExtensionContext,
	): Promise<{ content: any[] } | undefined> {
		const skill = plan.directSkill;
		const claimedByThisResult = new Set<string>();
		let reservationsStored = false;

		try {
			let changed = false;
			const allBlocks: any[] = [...event.content];
			const completedByThisResult = new Set<string>();
			const claimForResult = (name: string): boolean => {
				if (!residency.reserve(name)) return false;
				claimedByThisResult.add(name);
				return true;
			};

			if (skill) residency.activeSkill = skill;

			if (skill && plan.directBodyComplete && claimForResult(skill.name)) {
				completedByThisResult.add(skill.name);
			}

			// Prepend glob-matched skills. Passive injection: collect backticked
			// references, add path context, and neutralize (never execute)
			// dynamic shell placeholders. The skill's own text is never rewritten.
			for (const prepend of plan.prepends) {
				if (!claimForResult(prepend.skill.name)) continue;
				const injectionClaims = new Set([prepend.skill.name]);
				try {
					let injectedText = neutralizeDynamicPlaceholders(insertSkillContext(prepend.doc.raw, prepend.skill, ctx.cwd));
					for (const ref of prepend.refs) {
						if (!claimForResult(ref.skill.name)) continue;
						injectionClaims.add(ref.skill.name);
						completedByThisResult.add(ref.skill.name);
						injectedText +=
							'\n\n<skill name="' + ref.skill.name + '" location="' + ref.skill.filePath + '">\n' + ref.decoratedBody + '\n</skill>';
					}
					allBlocks.unshift({ type: "text", text: injectedText });
					completedByThisResult.add(prepend.skill.name);
					changed = true;
				} catch {
					residency.releaseSkills(injectionClaims);
					for (const name of injectionClaims) completedByThisResult.delete(name);
					// Silently skip skills whose injection failed.
				}
			}

			// Claim the direct skill's references before the first await;
			// parallel tool results must not append the same child, and a
			// prepend in this same plan may have claimed a shared child
			// already (nested in its injected text). Only references whose
			// claim succeeded are appended as trailing blocks.
			const claimedAppends: DeliveryRef[] = [];
			for (const ref of plan.appends) {
				if (claimForResult(ref.skill.name)) {
					completedByThisResult.add(ref.skill.name);
					claimedAppends.push(ref);
				}
			}

			const prependCount = allBlocks.length - event.content.length;
			const decorateIndex = plan.decorateIndex >= 0 ? plan.decorateIndex + prependCount : -1;

			const content = await Promise.all(
				allBlocks.map(async (block, index) => {
					if (block.type !== "text") return block;
					// Only process blocks from the original result, not injected skill blocks.
					if (!skill || !event.content.includes(block)) return block;
					let text = block.text;
					if (index === decorateIndex) {
						text = insertSkillContext(text, skill, ctx.cwd, plan.directDoc?.body);
					}
					text = await executeDynamicShell(text, skill, ctx.cwd);
					if (text !== block.text) changed = true;
					return { ...block, text };
				}),
			);

			if (claimedAppends.length > 0) {
				for (const ref of claimedAppends) {
					content.push({
						type: "text",
						text: '<skill name="' + ref.skill.name + '" location="' + ref.skill.filePath + '">\n' + ref.decoratedBody + '\n</skill>',
					});
				}
				changed = true;
			}

			// Apply model/thinking overrides from frontmatter. Awaiting keeps
			// this handler's completion ordered before any agent_end
			// restoration, and the override is active for the next LLM call.
			if (plan.modelOverride) {
				await applyOverrides(plan.modelOverride, ctx);
			}

			if (completedByThisResult.size > 0 && event.toolCallId) {
				residency.persistReservations(event.toolCallId, completedByThisResult);
				reservationsStored = true;
			}

			if (changed) return { content: content as any[] };
		} finally {
			if (!reservationsStored) residency.releaseSkills(claimedByThisResult);
		}
		return undefined;
	}

	return { refDeps, buildDeliveryPlan, applyDeliveryPlan };
}
