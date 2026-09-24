import type { ContextWithSystemEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * General skill guidance at system-prompt level, injected on EVERY model
 * request through the public context_with_system hook (the same seam the
 * pi-docs strip uses in pi-docs.ts). The wording is the historical per-skill
 * block's <path_policy> and <dynamic_skill_shell> text, verbatim. Per-skill
 * <skill_context> blocks keep only <skill_dir>/<workspace_dir>
 * (skill-delivery.ts), so the general rules exist exactly once per request
 * instead of once per delivered body.
 *
 * pi hands the hook a structuredClone of the transcript and uses the handler
 * result as returned, so injection is request-time only and never touches the
 * persisted session.
 */

export const AGENT_SKILLS_SECTION = [
	"<agent_skills>",
	"  <path_policy>",
	"    Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.",
	"    Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.",
	"    Use $PI_SKILL_DIR/path for explicit bundled skill files.",
	"    Use $PI_WORKSPACE/path for explicit workspace/project files.",
	"    Absolute paths are exact and should not be reinterpreted.",
	"  </path_policy>",
	"  <dynamic_skill_shell>",
	"    Dynamic SKILL.md shell placeholders receive PI_SKILL_DIR and PI_WORKSPACE.",
	"    Do not run dynamic shell placeholders yourself or rerun their commands unless the user asks. The skill loader supplies their output or a skipped notice.",
	"  </dynamic_skill_shell>",
	"</agent_skills>",
].join("\n");

/** System message list of a request clone (same shape pi-docs.ts operates on). */
export type RequestMessages = ContextWithSystemEvent["messages"];

/**
 * Add the general guidance once to the LEADING system message of a request
 * clone. Returns undefined (callers ship the original messages) when nothing
 * changed, the head is missing, or the block is already present — so repeated
 * handler runs and chained registrations stay exactly-once.
 *
 * Two head shapes:
 * - structured prompt (`sections` present, pi's normal shape): inject as the
 *   named `agent_skills` section. pi renders each named section exactly once
 *   (getSystemMessageText) and later system messages can replace or remove it
 *   by name, so the block participates in pi's prompt-update semantics instead
 *   of bypassing them. A foreign `agent_skills` value is overwritten: this
 *   extension owns that name and pi core never creates it.
 * - flat whole-prompt head (plain string content): append with a tag presence
 *   check. A forced whole prompt replaces the head after this hook anyway, so
 *   the append mainly serves flat pi prompts.
 *
 * A head with neither sections nor string content is skipped fail-open: no
 * injection is better than a mangled prompt.
 */
export function injectAgentSkillsSection(messages: RequestMessages): RequestMessages | undefined {
	const head = messages[0];
	if (!head || head.role !== "system") return undefined;

	if (head.sections) {
		if (head.sections.agent_skills === AGENT_SKILLS_SECTION) return undefined;
		const injected = messages.slice();
		injected[0] = { ...head, sections: { ...head.sections, agent_skills: AGENT_SKILLS_SECTION } };
		return injected;
	}

	if (typeof head.content === "string") {
		if (head.content.includes("<agent_skills>")) return undefined;
		const content = head.content ? `${head.content}\n\n${AGENT_SKILLS_SECTION}` : AGENT_SKILLS_SECTION;
		const injected = messages.slice();
		injected[0] = { ...head, content };
		return injected;
	}

	return undefined;
}

/**
 * Register the per-request injection on one extension instance. Composition
 * with the pi-docs strip or any other context_with_system handler is plain
 * handler chaining: each handler sees the previous handler's messages, and
 * this one changes nothing when the section is already present.
 */
export function registerAgentSkillsPrompt(pi: ExtensionAPI): void {
	pi.on("context_with_system", async (event) => {
		const injected = injectAgentSkillsSection(event.messages);
		return injected ? { messages: injected } : undefined;
	});
}
