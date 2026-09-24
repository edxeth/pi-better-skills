import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { registerAgentSkillsPrompt } from "./agent-skills-prompt";
import { registerPiDocsRequestStrip } from "./pi-docs";
import { createSkillCatalog, cwdPathExists, skillDocument, substitutePiPathVars } from "./skill-catalog";
import { createSkillResidency } from "./skill-residency";
import { createSkillDelivery, insertSkillContext, type DeliveryEvent } from "./skill-delivery";
import { collectSkillReferences, hasResolvableReference, neutralizeDynamicPlaceholders, type RefDeps } from "./skill-refs";
import { setupSkillAutocomplete } from "./skill-autocomplete";

export { cliSkillPaths, cliSkillsOnly, resultConfirmsSkillBody } from "./skill-catalog";



const VALID_THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);



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
		// The component renders the skill block only; pi renders the user message
		// separately, so the block carries no user message of its own.
		userMessage: undefined,
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
	if (!blocks) return text;
	return text ? `${blocks}\n\n${text}` : blocks;
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
 * With two or more blocks this concatenated shape is what it costs: core's
 * parser renders only the first block as a skill row, the rest as user text.
 * Accepted because splitting the message would reintroduce the regression.
 *
 * Exception: if the cleaned prompt still starts with a slash-command (e.g. a
 * leading prompt-template `/tmpl ...`), it must stay at position 0 so pi core's
 * prompt-template expansion (which requires `text.startsWith("/")` and replaces
 * the whole message) still fires. Prepending skill XML would bury it. In that
 * rare template+skill combo we fall back to separate skill messages: the
 * template keeps expanding, and the skills may split across one-at-a-time drains
 * as they did before this fix.
 *
 * An empty prompt (a bare leading `/skill:name` invocation whose declaration was
 * stripped) sends the earlier skills as `[skill]` rows and carries the last
 * block as the user text itself: the message is never empty, and core's
 * `parseSkillBlock` only parses one leading `<skill>` block per user message,
 * so a single concatenated multi-block message would render the rest as raw
 * XML user text.
 */
export function planInlineSkillDelivery(
	result: { text: string; skills: InlineSkillDisplay[] },
	streaming: boolean,
): { text: string; messages: InlineSkillDisplay[] } {
	if (!result.text.startsWith("/") && streaming) {
		return { text: inlineSkillsIntoText(result.text, result.skills), messages: [] };
	}
	if (!result.text.trim() && result.skills.length > 0) {
		const [last] = result.skills.slice(-1);
		return { text: last.block, messages: result.skills.slice(0, -1) };
	}
	return { text: result.text, messages: result.skills };
}

/**
 * Return whether a prompt uses pi core's single-leading-skill grammar.
 *
 * @param text - The original user prompt.
 * @param skills - The resolvable skills extracted from the prompt.
 * @returns `true` only for core's exact single-leading-skill grammar.
 */
export function isOrdinarySingleLeadingSkillCommand(text: string, skills: InlineSkillDisplay[]): boolean {
	if (skills.length !== 1) return false;
	const token = `/skill:${skills[0].name}`;
	// Mirror core's `_expandSkillCommand` grammar exactly: it only expands text
	// that literally starts with the token and ends there or continues with a
	// space. Leading whitespace or any other prefix makes core pass the message
	// through verbatim, so the extension must own those itself instead of
	// deferring and letting the declaration reach the model.
	return text === token || (text.startsWith(token) && text[token.length] === " ");
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

type InlineSkillMatch = {
	match: RegExpMatchArray;
	start: number;
};

type InlineSkillReplacement = {
	start: number;
	end: number;
	name: string;
};

type ResolvedInlineSkillMatch = {
	display: InlineSkillDisplay;
	replacement: InlineSkillReplacement;
};

function findInlineSkillMatches(text: string): InlineSkillMatch[] {
	return [...text.matchAll(INLINE_SKILL_TOKEN)]
		.map((match) => ({ match, start: match.index ?? 0 }))
		.filter(({ start }) => start === 0 || /\s/.test(text[start - 1] ?? ""));
}

/** Decide whether one resolved token is stripped or rendered as a bare name. */
function makeInlineSkillReplacement(
	text: string,
	match: RegExpMatchArray,
	start: number,
	name: string,
): InlineSkillReplacement {
	const leading = text.slice(0, start).trim() === "";
	const restTrimmed = text.slice(start + match[0].length).trimStart();
	const keepBareName = restTrimmed.startsWith("/") && !restTrimmed.startsWith("/skill:");
	return {
		start,
		end: start + match[0].length,
		name: leading && !keepBareName ? "" : name,
	};
}

function resolveInlineSkillMatch(
	candidate: InlineSkillMatch,
	resolve: (name: string) => InlineSkillRef | undefined,
	readBody: (skill: InlineSkillRef) => string,
	decorate: ((body: string, skill: InlineSkillRef) => string) | undefined,
	includeLeading: boolean | undefined,
	text: string,
): ResolvedInlineSkillMatch | undefined {
	const { match, start } = candidate;
	if (start === 0 && !includeLeading) return undefined; // leading skill -> pi core expands ordinary single-skill prompts
	const skill = resolve(match[1]);
	if (!skill) return undefined; // unknown skill: leave token verbatim

	let body: string;
	try {
		body = readBody(skill);
	} catch {
		return undefined; // unreadable SKILL.md: leave token verbatim
	}

	const inner = decorate ? decorate(body, skill) : body;
	return {
		display: formatInlineSkillDisplay(skill, inner),
		replacement: makeInlineSkillReplacement(text, match, start, skill.name),
	};
}

function replaceInlineSkillTokens(text: string, replacements: InlineSkillReplacement[]): string {
	replacements.sort((a, b) => a.start - b.start);
	let out = "";
	let cursor = 0;
	for (const { start, end, name } of replacements) {
		out += text.slice(cursor, start) + name;
		cursor = end;
	}
	return out + text.slice(cursor);
}

/**
 * Replace resolvable `/skill:<name>` tokens in user text and return the
 * referenced skills as separate skill-display records. A leading declaration is
 * stripped entirely, matching pi core's own `/skill:name args` expansion (the
 * skill rides in its own block, never in the sent text); every other token
 * becomes the bare skill `name`, keeping the user's sentence readable (no gap)
 * while the skill body is rendered as its own `[skill]` row above the prompt.
 * Removing the `/skill:` sigil also stops pi core from double-expanding a
 * leading token, since the text no longer starts with it.
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

	const matches = findInlineSkillMatches(text);
	if (matches.length === 0) return undefined;

	const resolved = matches.flatMap((candidate) => {
		const result = resolveInlineSkillMatch(candidate, resolve, readBody, decorate, options?.includeLeading, text);
		return result ? [result] : [];
	});
	if (resolved.length === 0) return undefined;

	return {
		text: replaceInlineSkillTokens(
			text,
			resolved.map(({ replacement }) => replacement),
		).trim(),
		skills: resolved.map(({ display }) => display),
	};
}

function shellQuote(path: string): string {
	return `'${path.replace(/'/g, `'"'"'`)}'`;
}

function maybeQuote(path: string, original: string): string {
	// If the original occurrence was already inside quotes, avoid adding nested quotes.
	return /\s/.test(path) && !/^["']/.test(original) ? shellQuote(path) : path;
}

export default function skillRelativePaths(pi: ExtensionAPI) {
		// Catalog, residency, and delivery instances. The catalog change hook
	// invalidates residency's reconciliation fast path; it is late-bound so
	// both instances can be created here.
	const catalog = createSkillCatalog({ onCatalogChange: () => residency.invalidate() });
	const residency = createSkillResidency(catalog);
	const delivery = createSkillDelivery({ catalog, residency, applyOverrides: applySkillOverrides });
	let sessionInitialized = false;

		

	// ---------------------------------------------------------------------------
	// Model/thinking override state
	// ---------------------------------------------------------------------------
	// Tracks temporary model/thinking switches from SKILL.md frontmatter.
	// Originals are captured before the first override and restored on agent_end.
	// One explicit state flag: the tool_result handler awaits every override
	// before returning, so agent_end can never restore while an override is
	// still in flight, and sequential reads never recapture originals.

	let overrideActive = false;
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

		// Capture originals on the first override within the current agent loop
		if (!overrideActive) {
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

		if (applied) overrideActive = true;
	}

	async function restoreOriginalState(ctx: ExtensionContext): Promise<void> {
		if (!overrideActive) return;
		overrideActive = false;

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

	function rewriteCommand(command: string, cwd: string): string {
		let rewritten = substitutePiPathVars(command, cwd, residency.activeSkill);

		// Fix sibling-skill references commonly used by composite skills, e.g.
		// ../exa/scripts/exa.sh from deep-research.
		rewritten = rewritten.replace(/(^|[\s"'(=;|&])\.\.\/([a-z0-9-]+)\/([^\s"'`;|&<>)]*)/g, (match, prefix: string, skillName: string, rest: string) => {
			const originalRelPath = `../${skillName}/${rest}`;
			if (cwdPathExists(cwd, originalRelPath)) return match;
			const skill = catalog.skills.get(skillName);
			if (!skill) return match;
			const candidate = join(skill.baseDir, rest);
			return existsSync(candidate) ? `${prefix}${maybeQuote(candidate, match)}` : match;
		});

		// Fix relative path tokens against the active skill root when that file
		// exists inside the skill. Tool cwd stays the workspace, and bare commands
		// like git/bun/rg are untouched because they contain no slash.
		const relativePathRegex = /(^|[\s\"'(=;|&])((?:\.\/)?[^\s\"'`;|&<>)]*\/[^\s\"'`;|&<>)]*)/g;
		rewritten = rewritten.replace(relativePathRegex, (match, prefix: string, relPath: string) => {
			const absolute = catalog.resolveRelativeResource(relPath, residency.activeSkill);
			if (absolute) return `${prefix}${maybeQuote(absolute, match)}`;
			if (residency.activeSkill || cwdPathExists(cwd, relPath)) return match;
			const uniqueSkillResource = catalog.resolveRelativeResource(relPath);
			return uniqueSkillResource ? `${prefix}${maybeQuote(uniqueSkillResource, match)}` : match;
		});

		return rewritten;
	}

		// ---------------------------------------------------------------------------
	// Event handlers
	// ---------------------------------------------------------------------------

	pi.registerMessageRenderer("skill", renderInlineSkillBatch as any);

	pi.on("session_start", async (_event, ctx) => {
		sessionInitialized = true;
		residency.clear();
		await catalog.bootstrap(ctx.cwd, ctx.isProjectTrusted());
		residency.reconcile(ctx);
		if (ctx.hasUI) setupSkillAutocomplete(ctx, () => catalog.skillList);
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Rebuild from the active branch: retained recent messages may still contain
		// a body, while summarized messages no longer do.
		residency.reconcile(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		// Tree navigation can move away from a tool result that supplied a body.
		residency.reconcile(ctx, true);
	});

	pi.on("session_shutdown", async () => {
		sessionInitialized = false;
		residency.clear();
	});


	pi.on("turn_end", async (_event, ctx) => {
		if (!sessionInitialized) return;
		residency.reconcile(ctx);
		residency.releaseAll();
	});

	// Multi-skill prompts are handled entirely by the extension so both the TUI
	// and the LLM see: skill rows first, cleaned user prompt second. Ordinary
	// single leading `/skill:name` commands retain core's single-block layout,
	// but include the same saved guidance as tool reads. Composite skills use
	// the shared delivery plan so parents and referenced skills travel together.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return; // don't rewrite extension-injected text
		const result = extractInlineSkillDisplays(
			event.text,
			(name) => catalog.skills.get(name),
			(skill) => {
				// Throw on unreadable/invalid-YAML skills: the extractor leaves
				// such tokens verbatim instead of injecting an empty block.
				const body = skillDocument(skill.filePath)?.body;
				if (body === undefined) throw new Error("unreadable skill body");
				// Commands load instructions without executing skill-authored shell code.
				return neutralizeDynamicPlaceholders(body);
			},
			// Wrap the body with the same <skill_context> block the extension injects
			// when a SKILL.md is read, so relative-path resolution applies to these
			// multi-skill invocations too (core's own leading-skill block lacks it).
			(body, skill) => insertSkillContext(body, skill, ctx.cwd),
			{ includeLeading: true },
		);
		if (!result) return;
		if (isOrdinarySingleLeadingSkillCommand(event.text, result.skills)) {
			// Keep core's layout without letting its expansion bypass the guidance.
			if (!hasResolvableReference(result.skills[0].content, (name) => catalog.skills.get(name))) {
				return { action: "transform" as const, text: inlineSkillsIntoText(result.text, result.skills) };
			}
		}

		// This local set prevents duplicate references within the transformed
		// prompt without claiming that the prompt was actually delivered.
		const stagedSkillNames = residency.stagedNames;
		const batch = commitRefExpansion(result.skills, delivery.refDeps(ctx.cwd), stagedSkillNames);

		const { text, messages } = planInlineSkillDelivery({ text: result.text, skills: batch }, Boolean(event.streamingBehavior));
		const options = event.streamingBehavior ? { deliverAs: event.streamingBehavior } : undefined;
		for (const skill of messages) {
			pi.sendMessage(inlineSkillMessage(skill), options);
		}

		return { action: "transform" as const, text };
	});

	const discoverPiDocsSkill = registerPiDocsRequestStrip(pi);
	// General skill guidance rides in the system prompt of every request; the
	// per-skill blocks stay dirs-only (skill-delivery.ts skillContextBlock).
	registerAgentSkillsPrompt(pi);
	pi.on("resources_discover", async (_event, ctx) => {
		await catalog.bootstrap(ctx.cwd, ctx.isProjectTrusted());
		return discoverPiDocsSkill(ctx.getSystemPrompt());
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const loaded = Array.isArray(event.systemPromptOptions?.skills) ? event.systemPromptOptions.skills : undefined;
		catalog.mergeLoaded(loaded);
		if (sessionInitialized) residency.reconcile(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;

		if (event.toolName === "bash" && typeof input.command === "string") {
			const original = input.command;
			process.env.PI_WORKSPACE = ctx.cwd;
			if (residency.activeSkill) process.env.PI_SKILL_DIR = residency.activeSkill.baseDir;
			else delete process.env.PI_SKILL_DIR;
			if (/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(original) && !residency.activeSkill) {
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
			if (/\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(input.path) && !residency.activeSkill) {
				return {
					block: true,
					reason: "Blocked PI_SKILL_DIR use because no active skill is known yet. Read the relevant SKILL.md first, or use an absolute skill path.",
				};
			}
			if (/\$\{PI_WORKSPACE\}|\$PI_WORKSPACE\b|\$\{PI_SKILL_DIR\}|\$PI_SKILL_DIR\b/.test(input.path)) {
				const resolved = substitutePiPathVars(input.path, ctx.cwd, residency.activeSkill);
				return {
					block: true,
					reason: `Blocked unresolved PI path variable. Retry read with the resolved path: ${resolved}`,
				};
			}
			if (!isAbsolute(input.path)) {
				const absolute = catalog.resolveRelativeResource(input.path, residency.activeSkill);
				if (absolute) input.path = absolute;
				else if (!residency.activeSkill && !cwdPathExists(ctx.cwd, input.path)) {
					const uniqueSkillResource = catalog.resolveRelativeResource(input.path);
					if (uniqueSkillResource) input.path = uniqueSkillResource;
				}
			}
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (sessionInitialized) residency.reconcile(ctx);
		if (event.isError) {
			residency.releaseToolCall(event.toolCallId);
			return;
		}
		// v1 explicit ownership: the producing tool owns raw reads and skill loading (see README).
		const owner = (event as { details?: { piBetterSkills?: { version?: unknown; handling?: unknown } } }).details?.piBetterSkills;
		if (owner?.version === 1 && owner.handling === "explicit") return;
		const toolEvent = event as unknown as DeliveryEvent;
		const plan = delivery.buildDeliveryPlan(toolEvent, ctx);
		if (!plan) return undefined;
		return delivery.applyDeliveryPlan(toolEvent, plan, ctx);
	});

	// Restore original model/thinking when the agent finishes processing a user request.
	// Sequential skill reads within one agent loop keep the override active until
	// this single restoration point; overrides always complete before the next
	// tool_result handler returns, so nothing can switch models after this.
	pi.on("agent_end", async (_event, ctx) => {
		if (sessionInitialized) residency.reconcile(ctx);
		residency.releaseAll();
		await restoreOriginalState(ctx);
	});
}
