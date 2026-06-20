import { describe, it, expect } from "bun:test";
import { expandInlineSkills, type InlineSkillRef } from "../index";

/**
 * `expandInlineSkills` lets one message reference multiple skills: the leading
 * `/skill:<name>` is left for pi core, and every additional resolvable token is
 * replaced *in place* with a `<skill>` XML block (the same shape core emits).
 * In-place replacement preserves the user's text ordering and keeps the leading
 * `/skill:` at index 0 so core still owns the leading skill. These tests pin
 * that contract with a fake resolver and body reader (no filesystem).
 */

function ref(name: string): InlineSkillRef {
	return { name, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` };
}

function harness(skills: string[], bodies: Record<string, string> = {}) {
	const known = new Set(skills);
	return (text: string) =>
		expandInlineSkills(
			text,
			(name) => (known.has(name) ? ref(name) : undefined),
			(skill) => bodies[skill.name] ?? `# ${skill.name}`,
		);
}

describe("expandInlineSkills leading skill", () => {
	it("is a no-op when only a single leading skill is referenced (core owns it)", () => {
		const expand = harness(["code-simplifier"]);
		expect(expand("/skill:code-simplifier do stuff")).toBeUndefined();
	});

	it("is a no-op when there are no skill tokens at all", () => {
		const expand = harness(["code-simplifier"]);
		expect(expand("just a normal message")).toBeUndefined();
	});
});

describe("expandInlineSkills in-place replacement + ordering", () => {
	it("replaces a non-leading token in place and keeps the leading skill for core", () => {
		const expand = harness(["code-simplifier", "write-a-skill"], {
			"write-a-skill": "Write skills well.",
		});
		const result = expand("/skill:code-simplifier /skill:write-a-skill hi");

		expect(result).not.toBeUndefined();
		expect(result!.text.startsWith("/skill:code-simplifier")).toBe(true); // leading preserved
		expect(result!.text).not.toContain("/skill:write-a-skill"); // token replaced
		expect(result!.text).toContain("hi"); // trailing text preserved
		expect(result!.text).toContain(
			'<skill name="write-a-skill" location="/skills/write-a-skill/SKILL.md">\nReferences are relative to /skills/write-a-skill.\n\nWrite skills well.\n</skill>',
		);
		expect(result!.injected).toEqual(["write-a-skill"]);
	});

	it("preserves text ordering: trailing text stays AFTER an injected skill block", () => {
		// Regression for the append-strategy bug that relocated trailing text.
		const expand = harness(["how-to-code", "tdd"]);
		const result = expand("/skill:how-to-code I need you to say `hi` /skill:tdd and nothing else");

		const tddBlock = result!.text.indexOf('<skill name="tdd"');
		const trailing = result!.text.indexOf("and nothing else");
		expect(tddBlock).toBeGreaterThan(-1);
		expect(trailing).toBeGreaterThan(tddBlock); // trailing text comes AFTER the block
		expect(result!.text).toContain("I need you to say `hi`");
		expect(result!.text.startsWith("/skill:how-to-code ")).toBe(true);
	});

	it("injects multiple additional skills in mention order, preserving interleaved text", () => {
		const expand = harness(["a", "b", "c"]);
		const result = expand("/skill:a /skill:b text /skill:c");

		expect(result!.injected).toEqual(["b", "c"]);
		const bBlock = result!.text.indexOf('<skill name="b"');
		const textWord = result!.text.indexOf("text");
		const cBlock = result!.text.indexOf('<skill name="c"');
		expect(bBlock).toBeGreaterThan(-1);
		expect(textWord).toBeGreaterThan(bBlock); // 'text' after b block
		expect(cBlock).toBeGreaterThan(textWord); // c block after 'text'
		expect(result!.text.startsWith("/skill:a ")).toBe(true);
	});

	it("expands all tokens when the message does not start with /skill: (core expands nothing)", () => {
		const expand = harness(["a", "b"]);
		const result = expand("hello /skill:a and /skill:b");

		expect(result!.injected).toEqual(["a", "b"]);
		expect(result!.text.startsWith("hello")).toBe(true);
		expect(result!.text).not.toContain("/skill:");
	});
});

describe("expandInlineSkills decoration (<skill_context>)", () => {
	it("passes the body through decorate and uses its result as the block inner content", () => {
		const known = new Set(["tdd"]);
		const result = expandInlineSkills(
			"/skill:how-to-code /skill:tdd hi",
			(name) => (known.has(name) ? ref(name) : undefined),
			() => "BODY",
			(body) => `<skill_context>CTX</skill_context>\n\n${body}`,
		);
		expect(result!.text).toContain(
			'<skill name="tdd" location="/skills/tdd/SKILL.md">\nReferences are relative to /skills/tdd.\n\n<skill_context>CTX</skill_context>\n\nBODY\n</skill>',
		);
	});

	it("omits decoration when no decorate callback is supplied", () => {
		const expand = harness(["tdd"], { tdd: "BODY" });
		const result = expand("/skill:lead /skill:tdd hi");
		expect(result!.text).not.toContain("<skill_context>");
		expect(result!.text).toContain("\n\nBODY\n</skill>");
	});
});

describe("expandInlineSkills unknown / unreadable skills", () => {
	it("leaves unknown skill tokens verbatim and injects nothing", () => {
		const expand = harness(["known"]);
		const result = expand("hi /skill:unknown");
		expect(result).toBeUndefined();
	});

	it("leaves a token whose body read throws verbatim", () => {
		const known = new Set(["good", "bad", "broken"]);
		const result = expandInlineSkills(
			"/skill:good /skill:bad /skill:broken hi",
			(name) => (known.has(name) ? ref(name) : undefined),
			(skill) => {
				if (skill.name === "broken") throw new Error("boom");
				return `${skill.name} body`;
			},
		);
		expect(result).not.toBeUndefined();
		expect(result!.injected).toEqual(["bad"]); // good is leading (skipped), broken threw
		expect(result!.text).toContain("/skill:broken"); // verbatim
		expect(result!.text).not.toContain("/skill:bad"); // replaced
		expect(result!.text.startsWith("/skill:good")).toBe(true); // leading preserved
	});
});

describe("expandInlineSkills token boundaries", () => {
	it("does not match /skill: embedded in a path or URL", () => {
		const expand = harness(["x"]);
		const result = expand("see foo/skill:x and /skill:x real");
		expect(result).not.toBeUndefined();
		expect(result!.text).toContain("foo/skill:x"); // embedded left as-is
		expect(result!.text).not.toContain("/skill:x real"); // boundary token replaced
	});
});
