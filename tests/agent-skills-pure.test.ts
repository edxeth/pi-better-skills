import { describe, expect, it } from "bun:test";
import { AGENT_SKILLS_SECTION, injectAgentSkillsSection, type RequestMessages } from "../src/agent-skills-prompt";

// Historical rule lines, pinned verbatim: the system block must keep the exact
// general wording the per-skill block used before the guidance split.
const PATH_RULES = [
	"Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.",
	"Plain workspace commands like git status and bun test usually run in the workspace unless instructed otherwise.",
	"Use $PI_SKILL_DIR/path for explicit bundled skill files.",
	"Use $PI_WORKSPACE/path for explicit workspace/project files.",
	"Absolute paths are exact and should not be reinterpreted.",
];
const SHELL_RULES = [
	"Dynamic SKILL.md shell placeholders receive PI_SKILL_DIR and PI_WORKSPACE.",
	"Do not run dynamic shell placeholders yourself or rerun their commands unless the user asks. The skill loader supplies their output or a skipped notice.",
];

function head(messages: RequestMessages): { sections?: Record<string, string | null>; content: unknown } {
	const first = messages[0];
	if (!first || first.role !== "system") throw new Error("no leading system message");
	return first as unknown as { sections?: Record<string, string | null>; content: unknown };
}

describe("AGENT_SKILLS_SECTION wording (historical, verbatim)", () => {
	it("wraps the path_policy and dynamic_skill_shell rules in <agent_skills>", () => {
		expect(AGENT_SKILLS_SECTION.startsWith("<agent_skills>\n")).toBe(true);
		expect(AGENT_SKILLS_SECTION.endsWith("\n</agent_skills>")).toBe(true);
		expect(AGENT_SKILLS_SECTION).toContain("<path_policy>");
		expect(AGENT_SKILLS_SECTION).toContain("<dynamic_skill_shell>");
		for (const rule of [...PATH_RULES, ...SHELL_RULES]) {
			expect(AGENT_SKILLS_SECTION).toContain(rule);
		}
	});

	it("carries no per-skill fields", () => {
		expect(AGENT_SKILLS_SECTION).not.toContain("<skill_dir>");
		expect(AGENT_SKILLS_SECTION).not.toContain("<workspace_dir>");
	});
});

describe("injectAgentSkillsSection (pure, request clone)", () => {
	it("sets an agent_skills section on a structured head exactly once", () => {
		const messages: RequestMessages = [
			{ role: "system", content: "BASE PROMPT", sections: { cwd: "<cwd>/w</cwd>", skills: "<skills>list</skills>" }, timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		];
		const injected = injectAgentSkillsSection(messages);
		expect(injected).toBeDefined();
		expect(head(injected!).sections!.agent_skills).toBe(AGENT_SKILLS_SECTION);
		// Existing sections and their order survive; the section renders once.
		expect(Object.keys(head(injected!).sections!)).toEqual(["cwd", "skills", "agent_skills"]);
		expect(head(injected!).content).toBe("BASE PROMPT");
		expect(injected![1]).toEqual(messages[1]);
		// Second application is a no-op: callers ship the original messages.
		expect(injectAgentSkillsSection(injected!)).toBeUndefined();
	});

	it("appends once to a flat whole-prompt head and is a no-op when the tag is already present", () => {
		const messages: RequestMessages = [
			{ role: "system", content: "Forced whole prompt.", timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		];
		const injected = injectAgentSkillsSection(messages);
		expect(injected).toBeDefined();
		expect(head(injected!).content).toBe(`Forced whole prompt.\n\n${AGENT_SKILLS_SECTION}`);
		expect(head(injected!).sections).toBeUndefined();
		// Repeat application and a foreign <agent_skills> text both add nothing.
		expect(injectAgentSkillsSection(injected!)).toBeUndefined();
		const foreign: RequestMessages = [{ role: "system", content: "mine\n\n<agent_skills>\n  <path_policy>keep</path_policy>\n</agent_skills>", timestamp: 3 }];
		expect(injectAgentSkillsSection(foreign)).toBeUndefined();
	});

	it("skips requests without a leading system message and unshaped heads", () => {
		expect(injectAgentSkillsSection([])).toBeUndefined();
		const userFirst: RequestMessages = [{ role: "user", content: "hi", timestamp: 1 }];
		expect(injectAgentSkillsSection(userFirst)).toBeUndefined();
		// Text-block content with no sections: fail open, never mangle the head.
		const blockContent: RequestMessages = [
			{ role: "system", content: [{ type: "text", text: "blocks only" }], timestamp: 1 } as unknown as RequestMessages[number],
		];
		expect(injectAgentSkillsSection(blockContent)).toBeUndefined();
	});
});
