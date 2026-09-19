import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasAutoInjectableGlobs, hasGlobs, matchesGlobs, skillDocument, type SkillRecord } from "../skill-catalog";

/**
 * Glob matching and frontmatter glob extraction. Extraction goes through
 * skillDocument (pi's YAML parser), so a brace-expansion glob such as
 * the ts-and-tsx pattern stays one pattern instead of splitting on the
 * comma inside the braces.
 */

function skill(name: string, globs?: string[], disableModelInvocation?: boolean): SkillRecord {
	return { name, filePath: "/skills/" + name + "/SKILL.md", baseDir: "/skills/" + name, globs, disableModelInvocation };
}

describe("matchesGlobs", () => {
	it("matches paths against configured globs", () => {
		expect(matchesGlobs("src/Button.tsx", ["**/*.tsx"])).toBe(true);
		expect(matchesGlobs("src/Button.vue", ["**/*.tsx"])).toBe(false);
	});

	it("matches basename patterns and dotfiles", () => {
		expect(matchesGlobs("any/dir/Dockerfile", ["Dockerfile"])).toBe(true);
		expect(matchesGlobs("dir/.env", ["**/.env"])).toBe(true);
	});

	it("returns false for an empty glob list", () => {
		expect(matchesGlobs("src/a.ts", [])).toBe(false);
	});
});

describe("hasGlobs / hasAutoInjectableGlobs", () => {
	it("requires a non-empty glob list", () => {
		expect(hasGlobs(skill("a"))).toBe(false);
		expect(hasGlobs(skill("a", undefined))).toBe(false);
		expect(hasGlobs(skill("a", ["**/*.ts"]))).toBe(true);
	});

	it("auto-injection requires globs and model invocation allowed", () => {
		expect(hasAutoInjectableGlobs(skill("a", ["**/*.ts"], true))).toBe(false);
		expect(hasAutoInjectableGlobs(skill("a", ["**/*.ts"], false))).toBe(true);
		expect(hasAutoInjectableGlobs(skill("a", undefined, false))).toBe(false);
	});
});

describe("skillDocument glob extraction", () => {
	it("keeps a brace-expansion glob as one pattern instead of splitting on the comma", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-globs-"));
		try {
			const skillPath = join(dir, "brace", "SKILL.md");
			mkdirSync(join(dir, "brace"), { recursive: true });
			writeFileSync(
				skillPath,
				["---", "name: brace", "description: Brace globs", 'globs: ["**/*.{ts,tsx}"]', "---", "", "Body.", ""].join("\n"),
			);
			const doc = skillDocument(skillPath);
			expect(doc?.globs).toEqual(["**/*.{ts,tsx}"]);
			expect(matchesGlobs("src/components/Button.tsx", doc?.globs ?? [])).toBe(true);
			expect(matchesGlobs("src/components/Button.vue", doc?.globs ?? [])).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads list-form, quoted single, and disable-model-invocation frontmatter", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-globs-"));
		try {
			const listPath = join(dir, "list", "SKILL.md");
			const singlePath = join(dir, "single", "SKILL.md");
			mkdirSync(join(dir, "list"), { recursive: true });
			mkdirSync(join(dir, "single"), { recursive: true });
			writeFileSync(
				listPath,
				["---", "name: list", "description: List globs", "globs:", '  - "**/*.tsx"', '  - "src/**"', "---", "", "Body.", ""].join("\n"),
			);
			writeFileSync(
				singlePath,
				["---", "name: single", "description: Single glob", "globs: \"*.ts\"", "disable-model-invocation: true", "---", "", "Body.", ""].join("\n"),
			);
			expect(skillDocument(listPath)?.globs).toEqual(["**/*.tsx", "src/**"]);
			const single = skillDocument(singlePath);
			expect(single?.globs).toEqual(["*.ts"]);
			expect(single?.disableModelInvocation).toBe(true);
			expect(hasAutoInjectableGlobs({ ...skill("single"), globs: single?.globs, disableModelInvocation: single?.disableModelInvocation })).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("yields no globs when frontmatter is missing or invalid YAML", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-globs-"));
		try {
			const nonePath = join(dir, "none", "SKILL.md");
			const invalidPath = join(dir, "invalid", "SKILL.md");
			mkdirSync(join(dir, "none"), { recursive: true });
			mkdirSync(join(dir, "invalid"), { recursive: true });
			writeFileSync(nonePath, ["---", "name: none", "description: No globs", "---", "", "Body.", ""].join("\n"));
			writeFileSync(invalidPath, ["---", "name: invalid", "description: Invalid", "globs: *.ts", "---", "", "Body.", ""].join("\n"));
			expect(skillDocument(nonePath)?.globs).toBeUndefined();
			expect(skillDocument(invalidPath)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
