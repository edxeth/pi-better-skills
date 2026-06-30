import { describe, it, expect } from "bun:test";
import { extractInlineSkillDisplays, type InlineSkillRef } from "../index";

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
	it("replaces leading tokens with bare names when the extension owns a multi-skill prompt", () => {
		const extract = harness(["torpathy", "ask-matt"]);
		const result = extractInlineSkillDisplays(
			"/skill:torpathy what's the best architecture? /skill:ask-matt",
			(name) => (["torpathy", "ask-matt"].includes(name) ? ref(name) : undefined),
			(skill) => `# ${skill.name}`,
			undefined,
			{ includeLeading: true },
		);

		expect(result!.skills.map((skill) => skill.name)).toEqual(["torpathy", "ask-matt"]);
		expect(result!.text).toBe("torpathy what's the best architecture? ask-matt");
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
});
