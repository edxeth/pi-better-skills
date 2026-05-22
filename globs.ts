import picomatch from "picomatch";

export interface SkillWithGlobs {
	name: string;
	filePath: string;
	baseDir: string;
	globs?: string[];
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * Extract YAML value for a given key from frontmatter.
 * Handles arrays `["a", "b"]`, list format `- "a"\n- "b"`, and single strings.
 */
function extractFrontmatterKey(yamlBlock: string, key: string): string[] | undefined {
	const lines = yamlBlock.split(/\r?\n/);

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Match: key: value  or  key: ["item1", "item2"]
		const inlineMatch = line.match(new RegExp(`^${key}:\\s*(.*)$`));
		if (!inlineMatch) continue;

		const value = inlineMatch[1].trim();

		// Empty value (key:)
		if (!value) {
			// Check if next lines are list entries
			const items = collectListItems(lines, i + 1);
			return items.length > 0 ? items : undefined;
		}

		// YAML array format: key: ["a", "b"]
		if (value.startsWith("[")) {
			const items = parseYamlArray(value);
			return items.length > 0 ? items : undefined;
		}

		// Single string: key: "*.ts"  or  key: *.ts
		const cleaned = value.replace(/^["']|["']$/g, "");
		return [cleaned];
	}

	return undefined;
}

/**
 * Parse a YAML inline array: ["a", "b"] or ["a", "b", "c"]
 */
function parseYamlArray(value: string): string[] {
	const inner = value.slice(1, value.lastIndexOf("]"));
	const items: string[] = [];
	for (const item of inner.split(",")) {
		const trimmed = item.trim().replace(/^["']|["']$/g, "").trim();
		if (trimmed) items.push(trimmed);
	}
	return items;
}

/**
 * Collect list items from YAML list format (lines starting with ` - ` or `- `).
 */
function collectListItems(lines: string[], startIndex: number): string[] {
	const items: string[] = [];
	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(/^\s*-\s+(.*)$/);
		if (!match) break;
		const value = match[1].trim().replace(/^["']|["']$/g, "");
		if (value) items.push(value);
	}
	return items;
}

/**
 * Extract the `globs` field from SKILL.md frontmatter.
 * Returns undefined if the field is missing, empty, or unparseable.
 */
export function extractGlobs(content: string): string[] | undefined {
	const fmMatch = content.match(FRONTMATTER_PATTERN);
	if (!fmMatch) return undefined;

	const yamlBlock = fmMatch[1];
	const globs = extractFrontmatterKey(yamlBlock, "globs");

	// Treat empty array as "no globs"
	if (globs !== undefined && globs.length === 0) return undefined;
	return globs;
}

/**
 * Returns true if the skill has non-empty globs configured.
 */
export function hasGlobs(skill: SkillWithGlobs): boolean {
	return Array.isArray(skill.globs) && skill.globs.length > 0;
}

/**
 * Check if a file path matches any of the glob patterns.
 * Uses picomatch for glob matching.
 */
export function matchesGlobs(filePath: string, globs: string[]): boolean {
	if (globs.length === 0) return false;
	const isMatch = picomatch(globs, { dot: true, matchBase: true });
	return isMatch(filePath);
}
