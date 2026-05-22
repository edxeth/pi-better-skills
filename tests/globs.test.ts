import { describe, it, expect } from "bun:test";
import { extractGlobs, matchesGlobs, hasGlobs, SkillWithGlobs } from "../globs";

/**
 * Helper to create a minimal skill record for testing.
 */
function skill(name: string, globs?: string[]): SkillWithGlobs {
	return { name, filePath: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, globs };
}

describe("extractGlobs", () => {
	it("extracts a YAML array from frontmatter", () => {
		const content = `---
name: test-skill
description: Test
globs: ["**/*.tsx", "**/*.jsx"]
---
# Skill content
`;
		expect(extractGlobs(content)).toEqual(["**/*.tsx", "**/*.jsx"]);
	});

	it("extracts a YAML list from frontmatter", () => {
		const content = `---
name: test-skill
description: Test
globs:
  - "**/*.tsx"
  - "**/*.jsx"
---
# Skill content
`;
		expect(extractGlobs(content)).toEqual(["**/*.tsx", "**/*.jsx"]);
	});

	it("extracts a single string glob", () => {
		const content = `---
name: test-skill
description: Test
globs: "*.ts"
---
# Skill content
`;
		expect(extractGlobs(content)).toEqual(["*.ts"]);
	});

	it("returns undefined when no globs field", () => {
		const content = `---
name: test-skill
description: Test
---
# Skill content
`;
		expect(extractGlobs(content)).toBeUndefined();
	});

	it("returns undefined when no frontmatter", () => {
		const content = `# Skill without frontmatter`;
		expect(extractGlobs(content)).toBeUndefined();
	});

	it("returns undefined for empty globs array", () => {
		const content = `---
name: test-skill
description: Test
globs: []
---
# Skill content
`;
		expect(extractGlobs(content)).toBeUndefined();
	});
});

describe("hasGlobs", () => {
	it("returns true when globs are present", () => {
		const skill = { name: "test", filePath: "/path/SKILL.md", baseDir: "/path", globs: ["*.ts"] };
		expect(hasGlobs(skill)).toBe(true);
	});

	it("returns false when globs is undefined", () => {
		const skill = { name: "test", filePath: "/path/SKILL.md", baseDir: "/path" };
		expect(hasGlobs(skill)).toBe(false);
	});

	it("returns false when globs is empty array", () => {
		const skill = { name: "test", filePath: "/path/SKILL.md", baseDir: "/path", globs: [] };
		expect(hasGlobs(skill)).toBe(false);
	});
});

describe("matchesGlobs", () => {
	const globs = ["**/*.tsx", "**/*.jsx", "**/*.vue"];

	it("matches a file path against globs", () => {
		expect(matchesGlobs("/project/src/Component.tsx", globs)).toBe(true);
	});

	it("matches .jsx files", () => {
		expect(matchesGlobs("/project/src/Component.jsx", globs)).toBe(true);
	});

	it("matches .vue files", () => {
		expect(matchesGlobs("/project/src/Component.vue", globs)).toBe(true);
	});

	it("does not match .css files", () => {
		expect(matchesGlobs("/project/src/styles.css", globs)).toBe(false);
	});

	it("does not match .ts files without 'x'", () => {
		expect(matchesGlobs("/project/src/utils.ts", globs)).toBe(false);
	});

	it("matches nested paths", () => {
		expect(matchesGlobs("/project/src/components/deep/nested/Button.tsx", globs)).toBe(true);
	});

	it("returns false for empty globs", () => {
		expect(matchesGlobs("/project/src/Component.tsx", [])).toBe(false);
	});

	it("matches using exact file name glob", () => {
		const exactGlobs = ["Dockerfile", "*.env"];
		expect(matchesGlobs("/project/Dockerfile", exactGlobs)).toBe(true);
	});

	it("matches glob without directory prefix", () => {
		const noDirGlobs = ["*.tsx"];
		expect(matchesGlobs("/project/src/Component.tsx", noDirGlobs)).toBe(true);
	});
});

describe("integration: full pipeline", () => {
	const lawsOfUxFrontmatter = `---
name: laws-of-ux
description: UX psychology rules
globs: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.html"]
---
# Laws of UX
`;

	it("extracts globs from a real skill frontmatter", () => {
		const globs = extractGlobs(lawsOfUxFrontmatter);
		expect(globs).toEqual(["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.html"]);
	});

	it("a .tsx file matches the extracted globs", () => {
		const globs = extractGlobs(lawsOfUxFrontmatter)!;
		expect(hasGlobs(skill("laws-of-ux", globs))).toBe(true);
		expect(matchesGlobs("/project/src/components/Button.tsx", globs)).toBe(true);
	});

	it("a .css file does not match the extracted globs", () => {
		const globs = extractGlobs(lawsOfUxFrontmatter)!;
		expect(matchesGlobs("/project/src/styles.css", globs)).toBe(false);
	});

	it("the design-craft skill globs match various file types", () => {
		const frontmatter = `---
name: design-craft
globs: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.css", "**/*.scss"]
---
`;
		const globs = extractGlobs(frontmatter)!;
		expect(matchesGlobs("Component.tsx", globs)).toBe(true);
		expect(matchesGlobs("Component.jsx", globs)).toBe(true);
		expect(matchesGlobs("Component.vue", globs)).toBe(true);
		expect(matchesGlobs("Component.svelte", globs)).toBe(true);
		expect(matchesGlobs("styles.css", globs)).toBe(true);
		expect(matchesGlobs("styles.scss", globs)).toBe(true);
		expect(matchesGlobs("Component.ts", globs)).toBe(false);
		expect(matchesGlobs("types.ts", globs)).toBe(false);
	});
});
