/**
 * Backticked skill references inside a SKILL.md body, e.g. `` `/grilling` `` or
 * `` `/skill:grilling` ``. When a skill body enters context, referenced
 * skills' bodies are injected alongside it (transitively, cycle-safe) — even
 * when the referenced skill sets `disable-model-invocation: true`, since
 * referencing a sibling from a loaded skill is an explicit author choice.
 * Body text is never rewritten: injection is purely additive.
 */

export const SKILL_REF_PATTERN = /`\/(?:skill:)?([A-Za-z0-9][A-Za-z0-9._-]*)`/g;
export const DYNAMIC_BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
export const DYNAMIC_INLINE_PATTERN = /(^|\s)!`([^`]+)`/gm;

export type SkillRefRecord = {
	name: string;
	filePath: string;
	baseDir: string;
};

export type ExpandedSkillRef = {
	skill: SkillRefRecord;
	/** Referenced skill body (frontmatter stripped, placeholders neutralized, decorated). */
	decoratedBody: string;
};

export type RefDeps = {
	resolve(name: string): SkillRefRecord | undefined;
	/** Stripped frontmatter body, or undefined when unreadable. */
	readBody(skill: SkillRefRecord): string | undefined;
	decorate(body: string, skill: SkillRefRecord): string;
	/** True when the skill's full body is already in context (session dedup). */
	alreadyInjected(name: string): boolean;
};

const NEUTRALIZED = "[dynamic shell skipped: passive reference injection]";

/**
 * Referenced skill bodies are injected passively: their dynamic shell
 * placeholders are never executed, so neutralize the syntax to keep the
 * system-prompt promise that loaded content already contains command output.
 */
export function neutralizeDynamicPlaceholders(content: string): string {
	return content.replace(DYNAMIC_BLOCK_PATTERN, NEUTRALIZED).replace(DYNAMIC_INLINE_PATTERN, `$1${NEUTRALIZED}`);
}

/** True when the body contains at least one reference resolving to a known skill. */
export function hasResolvableReference(body: string, resolve: (name: string) => unknown): boolean {
	for (const match of body.matchAll(SKILL_REF_PATTERN)) {
		if (resolve(match[1] ?? "")) return true;
	}
	return false;
}

/**
 * Collect backticked skill references inside a skill body for injection.
 *
 * Expansion is transitive (references of references) and cycle-safe via a
 * visited set. Skills already injected this session produce no new block
 * (their own references were injected alongside them originally). Unknown or
 * unreadable references inject nothing and stay in the body exactly as the
 * author wrote them.
 *
 * Refs are collected pre-order: a skill is listed before its own references,
 * so direct dependencies land closest to the referencing body.
 */
export function collectSkillReferences(rootName: string, body: string, deps: RefDeps): ExpandedSkillRef[] {
	const refs: ExpandedSkillRef[] = [];
	const visited = new Set<string>([rootName]);

	const visit = (text: string): void => {
		for (const match of text.matchAll(SKILL_REF_PATTERN)) {
			const skill = deps.resolve(match[1] ?? "");
			if (!skill) continue; // unknown reference: leave token verbatim
			const refBody = deps.readBody(skill);
			if (refBody === undefined) continue; // unreadable: leave token verbatim
			if (visited.has(skill.name)) continue;
			visited.add(skill.name);
			if (deps.alreadyInjected(skill.name)) continue; // body already in context

			const entry: ExpandedSkillRef = { skill, decoratedBody: "" };
			refs.push(entry);
			visit(refBody);
			entry.decoratedBody = deps.decorate(neutralizeDynamicPlaceholders(refBody), skill);
		}
	};

	visit(body);
	return refs;
}
