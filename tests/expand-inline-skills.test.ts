import { describe, it, expect } from "bun:test";
import {
	extractInlineSkillDisplays,
	inlineSkillsIntoText,
	isOrdinarySingleLeadingSkillCommand,
	planInlineSkillDelivery,
	type InlineSkillRef,
} from "../src/index";

/**
 * `extractInlineSkillDisplays` lets one message reference multiple skills without
 * stuffing extra skill bodies into the visible user text. The leading
 * `/skill:<name>` is left for pi core, and every additional resolvable token is
 * removed from the prompt and returned as a separate skill-display record that
 * the extension renders as `[skill] <name>`.
 */

function ref(name: string): InlineSkillRef {
	return { name, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` };
}

function harness(skills: string[], bodies: Record<string, string> = {}) {
	const known = new Set(skills);
	return (text: string) =>
		extractInlineSkillDisplays(
			text,
			(name) => (known.has(name) ? ref(name) : undefined),
			(skill) => bodies[skill.name] ?? `# ${skill.name}`,
		);
}

describe("extractInlineSkillDisplays leading skill", () => {
	it("is a no-op when only a single leading skill is referenced (core owns it)", () => {
		const extract = harness(["code-simplifier"]);
		expect(extract("/skill:code-simplifier do stuff")).toBeUndefined();
	});

	it("is a no-op when there are no skill tokens at all", () => {
		const extract = harness(["code-simplifier"]);
		expect(extract("just a normal message")).toBeUndefined();
	});
});

describe("extractInlineSkillDisplays visible prompt cleanup", () => {
	it("strips the leading declaration when the extension owns a multi-skill prompt", () => {
		const extract = harness(["torpathy", "ask-matt"]);
		const result = extractInlineSkillDisplays(
			"/skill:torpathy what's the best architecture? /skill:ask-matt",
			(name) => (["torpathy", "ask-matt"].includes(name) ? ref(name) : undefined),
			(skill) => `# ${skill.name}`,
			undefined,
			{ includeLeading: true },
		);

		expect(result!.skills.map((skill) => skill.name)).toEqual(["torpathy", "ask-matt"]);
		expect(result!.text).toBe("what's the best architecture? ask-matt");
	});

	it("strips a leading declaration entirely, like pi core's own expansion", () => {
		const extract = harness(["skill-creator"]);
		const result = extractInlineSkillDisplays(
			"/skill:skill-creator create me a skill for agentsmd",
			(name) => (name === "skill-creator" ? ref(name) : undefined),
			(skill) => `# ${skill.name}`,
			undefined,
			{ includeLeading: true },
		);

		expect(result!.skills.map((skill) => skill.name)).toEqual(["skill-creator"]);
		expect(result!.text).toBe("create me a skill for agentsmd");
	});

	it("strips a leading declaration preceded only by whitespace", () => {
		const extract = harness(["a", "b"]);
		const result = extractInlineSkillDisplays(
			"  /skill:a hi /skill:b",
			(name) => (name === "a" || name === "b" ? ref(name) : undefined),
			(skill) => `# ${skill.name}`,
			undefined,
			{ includeLeading: true },
		);

		expect(result!.text).toBe("hi b");
	});

	it("leaves only the skill blocks when a bare leading invocation has no arguments", () => {
		const extract = harness(["composite"]);
		const result = extractInlineSkillDisplays(
			"/skill:composite",
			(name) => (name === "composite" ? ref(name) : undefined),
			(skill) => `# ${skill.name}`,
			undefined,
			{ includeLeading: true },
		);

		expect(result!.text).toBe("");
		expect(result!.skills.map((skill) => skill.name)).toEqual(["composite"]);
	});

	it("keeps the bare name when stripping would expose a leading slash command", () => {
		const extract = harness(["composite", "b"]);
		const result = extractInlineSkillDisplays(
			"/skill:composite /tmp/foo /skill:b",
			(name) => (["composite", "b"].includes(name) ? ref(name) : undefined),
			(skill) => `# ${skill.name}`,
			undefined,
			{ includeLeading: true },
		);

		// Bare-name substitution (not stripping) so the cleaned text does not
		// start with "/": core's prompt-template expansion and the streaming
		// slash-command exception would otherwise fire on an argument that was
		// never at position 0.
		expect(result!.text).toBe("composite /tmp/foo b");
	});

	it("combines leading fallback, whitespace, unknown tokens, and later extraction", () => {
		const result = extractInlineSkillDisplays(
			" \t/skill:lead /tmp/foo /skill:missing /skill:later",
			(name) => (["lead", "later"].includes(name) ? ref(name) : undefined),
			(skill) => `${skill.name} body`,
			undefined,
			{ includeLeading: true },
		);

		expect(result!.text).toBe("lead /tmp/foo /skill:missing later");
		expect(result!.skills.map((skill) => skill.name)).toEqual(["lead", "later"]);
	});

	it("still strips when the only slash in the remainder is a following /skill: token", () => {
		// The following token is rewritten to its bare name, so stripping the
		// leading declaration cannot leave a slash at position 0.
		const result = extractInlineSkillDisplays(
			"/skill:grilling /skill:handoff",
			(name) => (["grilling", "handoff"].includes(name) ? ref(name) : undefined),
			() => "BODY",
			undefined,
			{ includeLeading: true },
		);
		expect(result!.text).toBe("handoff");
	});

	it("removes a non-leading token and keeps the leading skill for core by default", () => {
		const extract = harness(["code-simplifier", "write-a-skill"], {
			"write-a-skill": "Write skills well.",
		});
		const result = extract("/skill:code-simplifier /skill:write-a-skill hi");

		expect(result).not.toBeUndefined();
		expect(result!.text.startsWith("/skill:code-simplifier")).toBe(true);
		expect(result!.text).not.toContain("/skill:write-a-skill");
		expect(result!.text).toContain("hi");
		expect(result!.text).not.toContain("Write skills well.");
		expect(result!.skills.map((skill) => skill.name)).toEqual(["write-a-skill"]);
		expect(result!.skills[0].block).toBe(
			'<skill name="write-a-skill" location="/skills/write-a-skill/SKILL.md">\nReferences are relative to /skills/write-a-skill.\n\nWrite skills well.\n</skill>',
		);
	});

	it("keeps trailing user text in the user prompt instead of moving it into a skill block", () => {
		const extract = harness(["how-to-code", "tdd"]);
		const result = extract("/skill:how-to-code I need you to say `hi` /skill:tdd and nothing else");

		expect(result!.skills.map((skill) => skill.name)).toEqual(["tdd"]);
		expect(result!.text).toContain("I need you to say `hi`");
		expect(result!.text).toContain("and nothing else");
		expect(result!.text).not.toContain('<skill name="tdd"');
		expect(result!.text.startsWith("/skill:how-to-code ")).toBe(true);
	});

	it("extracts multiple additional skills in mention order", () => {
		const extract = harness(["a", "b", "c"]);
		const result = extract("/skill:a /skill:b text /skill:c");

		expect(result!.skills.map((skill) => skill.name)).toEqual(["b", "c"]);
		expect(result!.text.startsWith("/skill:a ")).toBe(true);
		expect(result!.text).toContain("text");
		expect(result!.text).not.toContain("/skill:b");
		expect(result!.text).not.toContain("/skill:c");
	});

	it("extracts all tokens when the message does not start with /skill: (core expands nothing)", () => {
		const extract = harness(["a", "b"]);
		const result = extract("hello /skill:a and /skill:b");

		expect(result!.skills.map((skill) => skill.name)).toEqual(["a", "b"]);
		expect(result!.text.startsWith("hello")).toBe(true);
		expect(result!.text).not.toContain("/skill:");
	});
});

describe("extractInlineSkillDisplays bare-name substitution", () => {
	it("replaces a mid-text token with the bare skill name so the sentence stays whole", () => {
		const extract = harness(["improve-codebase-architecture", "grill-with-docs"]);
		const result = extract(
			"using the /skill:improve-codebase-architecture along with /skill:grill-with-docs let's improve",
		);

		expect(result!.text).toBe(
			"using the improve-codebase-architecture along with grill-with-docs let's improve",
		);
		expect(result!.skills.map((skill) => skill.name)).toEqual([
			"improve-codebase-architecture",
			"grill-with-docs",
		]);
	});

	it("leaves no whitespace gap for a single mid-text reference", () => {
		const extract = harness(["diagnosing-bugs"]);
		const result = extract("I added the skill /skill:diagnosing-bugs inline here");

		expect(result!.text).toBe("I added the skill diagnosing-bugs inline here");
	});

	it("does not treat a one-character prefix as leading whitespace", () => {
		const extract = harness(["a"]);
		const result = extract("x /skill:a");

		expect(result!.text).toBe("x a");
	});
});

describe("extractInlineSkillDisplays decoration (<skill_context>)", () => {
	it("passes the body through decorate before building the skill display block", () => {
		const known = new Set(["tdd"]);
		const result = extractInlineSkillDisplays(
			"/skill:how-to-code /skill:tdd hi",
			(name) => (known.has(name) ? ref(name) : undefined),
			() => "BODY",
			(body) => `<skill_context>CTX</skill_context>\n\n${body}`,
		);
		expect(result!.skills[0].block).toContain(
			'<skill name="tdd" location="/skills/tdd/SKILL.md">\nReferences are relative to /skills/tdd.\n\n<skill_context>CTX</skill_context>\n\nBODY\n</skill>',
		);
	});

	it("omits decoration when no decorate callback is supplied", () => {
		const extract = harness(["tdd"], { tdd: "BODY" });
		const result = extract("/skill:lead /skill:tdd hi");
		expect(result!.skills[0].block).not.toContain("<skill_context>");
		expect(result!.skills[0].block).toContain("\n\nBODY\n</skill>");
	});
});

describe("inlineSkillsIntoText (steer/followUp single-entry delivery)", () => {
	// Regression: during streaming the steering queue drains one entry at a time,
	// so skills must ride inside the same queued message as the user text — never
	// as separate messages that would invoke the skill in its own earlier turn.
	it("prepends every skill block before the user text as one string", () => {
		const result = extractInlineSkillDisplays(
			"do X with /skill:a and /skill:b",
			(name) => (["a", "b"].includes(name) ? ref(name) : undefined),
			(skill) => `${skill.name} body`,
			undefined,
			{ includeLeading: true },
		)!;
		const combined = inlineSkillsIntoText(result.text, result.skills);

		expect(combined).toBe(`${result.skills[0].block}\n\n${result.skills[1].block}\n\n${result.text}`);
		expect(combined).toContain("a body");
		expect(combined).toContain("b body");
		expect(combined.trimEnd().endsWith(result.text)).toBe(true);
	});

	it("returns the text unchanged when there are no skills", () => {
		expect(inlineSkillsIntoText("just text", [])).toBe("just text");
	});

	it("returns the blocks alone when there is no user text", () => {
		const result = extractInlineSkillDisplays(
			"/skill:composite",
			(name) => (name === "composite" ? ref(name) : undefined),
			() => "BODY",
			undefined,
			{ includeLeading: true },
		)!;
		expect(inlineSkillsIntoText(result.text, result.skills)).toBe(result.skills[0].block);
	});
});

describe("planInlineSkillDelivery (the streaming-regression seam)", () => {
	function extractTwo() {
		return extractInlineSkillDisplays(
			"do X with /skill:a and /skill:b",
			(name) => (["a", "b"].includes(name) ? ref(name) : undefined),
			(skill) => `${skill.name} body`,
			undefined,
			{ includeLeading: true },
		)!;
	}

	it("streaming: sends NO separate messages and inlines every block into the text", () => {
		const result = extractTwo();
		const plan = planInlineSkillDelivery(result, true);

		// The bug was separate skill messages splitting across one-at-a-time drains.
		expect(plan.messages).toEqual([]);
		expect(plan.text).toBe(inlineSkillsIntoText(result.text, result.skills));
		expect(plan.text).toContain("a body");
		expect(plan.text).toContain("b body");
		expect(plan.text.trimEnd().endsWith(result.text)).toBe(true);
	});

	it("idle: keeps skills as separate messages and leaves the user text clean", () => {
		const result = extractTwo();
		const plan = planInlineSkillDelivery(result, false);

		expect(plan.messages).toBe(result.skills);
		expect(plan.text).toBe(result.text);
		expect(plan.text).not.toContain("a body");
	});

	it("idle with an empty prompt: inlines the blocks as the user message instead of sending empty text", () => {
		const result = extractInlineSkillDisplays(
			"/skill:composite",
			(name) => (name === "composite" ? ref(name) : undefined),
			() => "BODY",
			undefined,
			{ includeLeading: true },
		)!;
		const plan = planInlineSkillDelivery(result, false);

		expect(plan.messages).toEqual([]);
		expect(plan.text).toBe(result.skills[0].block);
	});

	it("idle with an empty prompt and multiple blocks: earlier skills ride as rows, the last as the user text", () => {
		// A bare composite skill expands to parent + referenced children; one
		// concatenated user message would break core's parseSkillBlock, which
		// parses only a single leading <skill> block per user message.
		const result = extractInlineSkillDisplays(
			"/skill:composite",
			(name) => (["composite", "child"].includes(name) ? ref(name) : undefined),
			() => "BODY",
			undefined,
			{ includeLeading: true },
		)!;
		const batch = [
			result.skills[0],
			{ ...result.skills[0], name: "child", block: "<skill name=\"child\">\nCHILD\n</skill>" },
		];
		const plan = planInlineSkillDelivery({ text: result.text, skills: batch }, false);

		expect(plan.messages).toEqual([batch[0]]);
		expect(plan.text).toBe(batch[1].block);
	});

	it("streaming takes precedence over the empty-prompt fallback", () => {
		const skills = [
			{ ...ref("first"), content: "FIRST", block: "<skill name=\"first\">\nFIRST\n</skill>" },
			{ ...ref("last"), content: "LAST", block: "<skill name=\"last\">\nLAST\n</skill>" },
		];

		const plan = planInlineSkillDelivery({ text: "", skills }, true);

		expect(plan.messages).toEqual([]);
		expect(plan.text).toBe(`${skills[0].block}\n\n${skills[1].block}`);
	});

	it("idle treats whitespace-only text as an empty prompt", () => {
		const skills = [
			{ ...ref("first"), content: "FIRST", block: "FIRST BLOCK" },
			{ ...ref("last"), content: "LAST", block: "LAST BLOCK" },
		];

		const plan = planInlineSkillDelivery({ text: " \t\n", skills }, false);

		expect(plan.messages).toEqual([skills[0]]);
		expect(plan.text).toBe(skills[1].block);
	});

	it("does not synthesize a last block when an empty prompt has no skills", () => {
		const plan = planInlineSkillDelivery({ text: "", skills: [] }, false);

		expect(plan).toEqual({ text: "", messages: [] });
	});

	it("streaming with slash-args exposed by stripping still inlines (bare-name fallback kept text unslashy)", () => {
		const result = extractInlineSkillDisplays(
			"/skill:composite /tmp/foo",
			(name) => (name === "composite" ? ref(name) : undefined),
			() => "BODY",
			undefined,
			{ includeLeading: true },
		)!;
		expect(result.text).toBe("composite /tmp/foo");

		const plan = planInlineSkillDelivery(result, true);
		expect(plan.messages).toEqual([]);
		expect(plan.text).toBe(inlineSkillsIntoText(result.text, result.skills));
	});

	it("streaming with a leading slash-command: does NOT inline, so core can still expand it", () => {
		// e.g. `/tmpl arg /skill:a` -> cleaned text `/tmpl arg a`. Prepending skill XML
		// would move the leading `/tmpl` off position 0 and defeat core's prompt-template
		// expansion (which requires text.startsWith("/")). Fall back to separate messages.
		const result = extractInlineSkillDisplays(
			"/tmpl arg /skill:a",
			(name) => (name === "a" ? ref(name) : undefined),
			(skill) => `${skill.name} body`,
			undefined,
			{ includeLeading: true },
		)!;
		expect(result.text).toBe("/tmpl arg a");

		const plan = planInlineSkillDelivery(result, true);
		expect(plan.text).toBe("/tmpl arg a"); // leading token preserved at position 0
		expect(plan.messages).toBe(result.skills); // skill delivered as a separate message
		expect(plan.text.startsWith("/")).toBe(true);
	});
});

describe("isOrdinarySingleLeadingSkillCommand (deferral grammar mirrors core)", () => {
	const skills = [{ ...ref("a"), content: "c", block: "b" }];

	it("defers the exact forms core expands", () => {
		expect(isOrdinarySingleLeadingSkillCommand("/skill:a hello", skills)).toBe(true);
		expect(isOrdinarySingleLeadingSkillCommand("/skill:a", skills)).toBe(true);
		expect(isOrdinarySingleLeadingSkillCommand("/skill:a  double space", skills)).toBe(true);
	});

	it("never defers forms core passes through verbatim", () => {
		// Core requires strict startsWith + space delimiter; deferring these
		// would leave the declaration in the sent message.
		expect(isOrdinarySingleLeadingSkillCommand("  /skill:a hello", skills)).toBe(false);
		expect(isOrdinarySingleLeadingSkillCommand("/skill:a\nhello", skills)).toBe(false);
		expect(isOrdinarySingleLeadingSkillCommand("/skill:a\thello", skills)).toBe(false);
		expect(isOrdinarySingleLeadingSkillCommand("/skill:ab hello", skills)).toBe(false);
	});

	it("does not defer when the extracted batch is not exactly one skill", () => {
		expect(isOrdinarySingleLeadingSkillCommand("/skill:a", [])).toBe(false);
	});

	it("extension-owned whitespace-prefixed commands strip the declaration", () => {
		const extract = harness(["a"]);
		const result = extractInlineSkillDisplays(
			"  /skill:a hello",
			(name) => (name === "a" ? ref(name) : undefined),
			() => "BODY",
			undefined,
			{ includeLeading: true },
		);
		expect(result!.text).toBe("hello");
	});
});

describe("extractInlineSkillDisplays unknown / unreadable skills", () => {
	it("leaves unknown skill tokens verbatim and extracts nothing", () => {
		const extract = harness(["known"]);
		const result = extract("hi /skill:unknown");
		expect(result).toBeUndefined();
	});

	it("leaves a token whose body read throws verbatim", () => {
		const known = new Set(["good", "bad", "broken"]);
		const result = extractInlineSkillDisplays(
			"/skill:good /skill:bad /skill:broken hi",
			(name) => (known.has(name) ? ref(name) : undefined),
			(skill) => {
				if (skill.name === "broken") throw new Error("boom");
				return `${skill.name} body`;
			},
		);
		expect(result).not.toBeUndefined();
		expect(result!.skills.map((skill) => skill.name)).toEqual(["bad"]);
		expect(result!.text).toContain("/skill:broken");
		expect(result!.text).not.toContain("/skill:bad");
		expect(result!.text.startsWith("/skill:good")).toBe(true);
	});
});

describe("extractInlineSkillDisplays token boundaries", () => {
	it("does not match /skill: embedded in a path or URL", () => {
		const extract = harness(["x"]);
		const result = extract("see foo/skill:x and /skill:x real");
		expect(result).not.toBeUndefined();
		expect(result!.text).toContain("foo/skill:x");
		expect(result!.text).not.toContain("/skill:x real");
	});

	it("returns undefined when every skill marker is embedded", () => {
		const extract = harness(["x"]);
		expect(extract("see foo/skill:x")).toBeUndefined();
	});

	it("trims whitespace from both ends after replacing a token", () => {
		const extract = harness(["x"]);
		const result = extract(" \nhello /skill:x \t\n");

		expect(result!.text).toBe("hello x");
	});
});
