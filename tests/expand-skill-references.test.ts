import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	collectSkillReferences,
	hasResolvableReference,
	type RefDeps,
	type SkillRefRecord,
} from "../skill-refs";
import { commitRefExpansion, type InlineSkillDisplay } from "../index";

/**
 * Backticked `/name` references inside a SKILL.md body expand transitively:
 * resolved tokens become bare names and referenced bodies are collected for
 * injection. Unknown references, paths, and commands stay verbatim.
 */

function record(name: string): SkillRefRecord {
	return { name, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}` };
}

function deps(
	known: string[],
	bodies: Record<string, string> = {},
	injected: Set<string> = new Set(),
	unreadable: string[] = [],
): RefDeps {
	const set = new Set(known);
	return {
		resolve: (name) => (set.has(name) ? record(name) : undefined),
		readBody: (skill) => (unreadable.includes(skill.name) ? undefined : (bodies[skill.name] ?? `# ${skill.name}`)),
		decorate: (body, skill) => `<ctx dir="${skill.baseDir}">${body}</ctx>`,
		alreadyInjected: (name) => injected.has(name),
	};
}

function display(name: string, content: string): InlineSkillDisplay {
	return {
		name,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		content,
		block: `<skill name="${name}">\n${content}\n</skill>`,
	};
}

describe("collectSkillReferences", () => {
	it("collects the referenced body; the token stays as written", () => {
		const refs = collectSkillReferences(
			"parent",
			"Run a `/grilling` session now.",
			deps(["grilling"], { grilling: "# grilling body" }),
		);
		expect(refs).toHaveLength(1);
		expect(refs[0]?.skill.name).toBe("grilling");
		expect(refs[0]?.decoratedBody).toBe('<ctx dir="/skills/grilling"># grilling body</ctx>');
	});

	it("supports the /skill:name form too", () => {
		const refs = collectSkillReferences("parent", "Use `/skill:prototype` here.", deps(["prototype"]));
		expect(refs.map((ref) => ref.skill.name)).toEqual(["prototype"]);
	});

	it("ignores unknown references", () => {
		const refs = collectSkillReferences("parent", "Try `/nope` please.", deps([]));
		expect(refs).toHaveLength(0);
	});

	it("ignores unreadable skills", () => {
		const refs = collectSkillReferences("parent", "Try `/grilling` please.", deps(["grilling"], {}, new Set(), ["grilling"]));
		expect(refs).toHaveLength(0);
	});

	it("ignores paths, commands, and non-skill tokens", () => {
		const body = "Run `git status`, `./scripts/foo.sh`, `/usr/bin/env`, and `/abs/path/file.md`.";
		const refs = collectSkillReferences("parent", body, deps(["git", "env"]));
		expect(refs).toHaveLength(0);
	});

	it("expands transitively in pre-order", () => {
		const refs = collectSkillReferences(
			"a",
			"See `/b`.",
			deps(["a", "b", "c"], { a: "See `/b`.", b: "Then `/c`.", c: "# c body" }),
		);
		expect(refs.map((ref) => ref.skill.name)).toEqual(["b", "c"]);
		// b's own reference stays as written inside its injected body
		expect(refs[0]?.decoratedBody).toContain("Then `/c`.");
	});

	it("handles cycles without duplicating skills", () => {
		const refs = collectSkillReferences(
			"a",
			"See `/b`.",
			deps(["a", "b"], { a: "See `/b`.", b: "Back to `/a`." }),
		);
		expect(refs.map((ref) => ref.skill.name)).toEqual(["b"]);
		// the cyclic token stays in b's injected body without re-injecting a
		expect(refs[0]?.decoratedBody).toContain("Back to `/a`.");
	});

	it("injects a shared dependency only once (diamond)", () => {
		const refs = collectSkillReferences(
			"a",
			"Use `/b` and `/c`.",
			deps(["a", "b", "c", "d"], {
				a: "Use `/b` and `/c`.",
				b: "Needs `/d`.",
				c: "Also `/d`.",
				d: "# d",
			}),
		);
		expect(refs.map((ref) => ref.skill.name)).toEqual(["b", "d", "c"]);
	});

	it("skips the block for already-injected skills", () => {
		const injected = new Set(["grilling"]);
		const refs = collectSkillReferences("parent", "Run `/grilling` now.", deps(["grilling"], {}, injected));
		expect(refs).toHaveLength(0);
	});

	it("does not traverse into already-injected skills' references", () => {
		const injected = new Set(["b"]);
		const refs = collectSkillReferences(
			"parent",
			"Run `/b`.",
			deps(["b", "c"], { b: "See `/c`.", c: "# c" }, injected),
		);
		expect(refs).toHaveLength(0);
	});

	it("neutralizes dynamic shell placeholders in ref bodies", () => {
		const body = "Branch: !`git branch --show-current`\n\n```!\ngit diff\n```";
		const refs = collectSkillReferences("parent", "Use `/dyn`.", deps(["dyn"], { dyn: body }));
		expect(refs[0]?.decoratedBody).not.toContain("!`git branch");
		expect(refs[0]?.decoratedBody).toContain("[dynamic shell skipped: passive reference injection]");
	});

	it("resolves disable-model-invocation skills (explicit author choice)", () => {
		// resolve() is the caller's policy; DMI skills stay referenceable.
		const refs = collectSkillReferences("parent", "Use `/secret`.", deps(["secret"]));
		expect(refs.map((ref) => ref.skill.name)).toEqual(["secret"]);
	});
});

describe("hasResolvableReference", () => {
	it("detects resolvable references only", () => {
	const d = deps(["grilling"]);
		expect(hasResolvableReference("Run `/grilling`.", d.resolve)).toBe(true);
		expect(hasResolvableReference("Run `/skill:grilling`.", d.resolve)).toBe(true);
		expect(hasResolvableReference("Run `/nope`.", d.resolve)).toBe(false);
		expect(hasResolvableReference("Run `git status`.", d.resolve)).toBe(false);
	});
});

describe("commitRefExpansion", () => {
	it("appends referenced skills as displays and records injected names", () => {
		const injected = new Set<string>();
		const d = deps(["grilling", "prototype"], { grilling: "# grilling", prototype: "# prototype" });
		const out = commitRefExpansion([display("grill-design", "Run `/grilling` with `/prototype`.")], d, injected);

		expect(out.map((skill) => skill.name)).toEqual(["grill-design", "grilling", "prototype"]);
		// parent body stays byte-identical; injection is purely additive
		expect(out[0]?.content).toBe("Run `/grilling` with `/prototype`.");
		expect(out[1]?.block).toContain("# grilling");
		expect(injected).toEqual(new Set(["grill-design", "grilling", "prototype"]));
	});

	it("does not re-inject skills recorded in the injected set", () => {
		const injected = new Set(["grilling"]);
		const d = deps(["grilling"], { grilling: "# grilling" });
		const out = commitRefExpansion([display("other", "Also `/grilling`.")], d, injected);
		expect(out.map((skill) => skill.name)).toEqual(["other"]);
		expect(out[0]?.content).toBe("Also `/grilling`.");
	});

	it("does not duplicate a parent already staged in the batch", () => {
		const injected = new Set<string>();
		const d = deps(["b"], { b: "# b" });
		const out = commitRefExpansion([display("a", "Use `/b`."), display("b", "# b")], d, injected);
		expect(out.filter((skill) => skill.name === "b")).toHaveLength(1);
	});

	it("injects a shared reference once when two parents in one prompt both name it", () => {
		const injected = new Set<string>();
		const d = deps(["shared"], { shared: "# shared" });
		const out = commitRefExpansion(
			[display("parent-a", "Start with `/shared`."), display("parent-b", "End with `/shared`.")],
			d,
			injected,
		);

		// Both parents' bodies stay byte-identical...
		expect(out.find((skill) => skill.name === "parent-a")?.content).toBe("Start with `/shared`.");
		expect(out.find((skill) => skill.name === "parent-b")?.content).toBe("End with `/shared`.");
		// ...but the shared skill is staged exactly once, after the parent batch.
		expect(out.map((skill) => skill.name)).toEqual(["parent-a", "parent-b", "shared"]);
	});
});

describe("collectSkillReferences with real skill files", () => {
	it("mirrors refDeps: frontmatter stripped, placeholders neutralized, siblings injected", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-refs-"));
		try {
			const mkSkill = (name: string, body: string) => {
				const skillDir = join(dir, name);
				mkdirSync(skillDir);
				writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}`);
				return { name, filePath: join(skillDir, "SKILL.md"), baseDir: skillDir };
			};
			const grillDesign = mkSkill("grill-design", "Run a `/grilling` session, using the `/prototype` skill.");
			mkSkill("grilling", "Grill hard.\n\nCurrent branch: !`git branch --show-current`");
			mkSkill("prototype", "# prototype body");

			// Same wiring as the extension's refDeps(), minus cwd decoration.
			const known = new Map([
				["grill-design", grillDesign],
				["grilling", { name: "grilling", filePath: join(dir, "grilling", "SKILL.md"), baseDir: join(dir, "grilling") }],
				["prototype", { name: "prototype", filePath: join(dir, "prototype", "SKILL.md"), baseDir: join(dir, "prototype") }],
			]);
			const injected = new Set<string>();
			const refs = collectSkillReferences(grillDesign.name, stripFrontmatter(readFileSync(grillDesign.filePath, "utf-8")).trim(), {
				resolve: (name) => known.get(name),
				readBody(skill) {
					try {
						return stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
					} catch {
						return undefined;
					}
				},
				decorate: (body) => `<skill_context>${body}</skill_context>`,
				alreadyInjected: (name) => injected.has(name),
			});

			expect(refs.map((ref) => ref.skill.name)).toEqual(["grilling", "prototype"]);
			expect(refs[0]?.decoratedBody).not.toContain("---"); // frontmatter stripped
			expect(refs[0]?.decoratedBody).toContain("[dynamic shell skipped: passive reference injection]");
			expect(refs[0]?.decoratedBody).not.toContain("!`git branch");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
