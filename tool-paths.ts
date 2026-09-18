import { resolve } from "node:path";

/**
 * Extract path mentions without depending on a tool's name. Structured keys
 * and bounded free-form strings both participate, including shell commands
 * and notebook code. A mention is not proof of a read: callers must check disk
 * existence, and session deduplication limits repeated skill bodies.
 *
 * Hidden/computed paths cannot be inferred without executing input, which
 * this extractor never does.
 */

/** Keys that name a target location. Plural forms carry a list, as in MCP `read_multiple_files`. */
const PATH_KEYS = new Set([
	"path",
	"paths",
	"file",
	"files",
	"filepath",
	"filepaths",
	"file_path",
	"file_paths",
	"notebookpath",
	"notebookpaths",
	"notebook_path",
	"notebook_paths",
]);

/** Keys that name the directory a record's relative paths resolve against. */
const BASE_KEYS = new Set(["workdir", "cwd", "directory", "dir"]);

const MAX_DEPTH = 2;
const MAX_CANDIDATES = 16;
const MAX_STRING_SCAN = 16 * 1024;
const MAX_TOTAL_STRING_SCAN = 64 * 1024;
const MAX_ENTRIES = 512;
const MAX_COMMAND_PREFIX_CHARS = 64;
const LINE_SUFFIX = /:[0-9]+(?:[-,][0-9]+)*$/;
const HAS_SEPARATOR = /[\\/]/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

type ScanBudget = { entries: number; text: number };

type CandidateAdder = (raw: string, base: string) => void;

function cleanValue(raw: string) {
	return raw
		.trim()
		.replace(/^['"`]|['"`]$/g, "")
		.replace(/[,;:]+$/, "")
		.trim();
}

function tokenCandidate(raw: string): string | undefined {
	const cleaned = cleanValue(raw).replace(LINE_SUFFIX, "");
	if (!cleaned || cleaned.startsWith("-") || cleaned.includes("://")) return undefined;
	if (!HAS_SEPARATOR.test(cleaned) && !HAS_EXTENSION.test(cleaned)) return undefined;
	return cleaned;
}

function scanTokens(raw: string, base: string, addCandidate: CandidateAdder, budget: ScanBudget) {
	if (raw.length > MAX_STRING_SCAN || raw.length > budget.text) return;
	budget.text -= raw.length;
	// Keep whole quoted path literals (including spaces), without adding the
	// surrounding notebook syntax as a second candidate. Unquoted punctuation
	// stays intact for real filenames such as Next.js [id] and (group) routes.
	for (const match of raw.matchAll(/"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`]+/g)) {
		const value = cleanValue(match[0]);
		// Recognize command values inside visible notebook/serialized input;
		// otherwise a quoted literal is one path, even when it contains spaces.
		const prefix = raw.slice(Math.max(0, match.index - MAX_COMMAND_PREFIX_CHARS), match.index);
		const commandValue =
			/\b(?:cmd|command)["']?\s*[:=]\s*$/.test(prefix) ||
			/(?:^|\s)(?:-[A-Za-z]*c|--command)\s*$/.test(prefix);
		const candidates = commandValue ? value.split(/\s+/) : [value];
		for (const token of candidates) {
			const candidate = tokenCandidate(token);
			if (candidate) addCandidate(candidate, base);
		}
	}
}

function resolveRecordBase(entries: Array<[string, unknown]>, base: string, addCandidate: CandidateAdder) {
	let recordBase = base;
	for (const [key, child] of entries) {
		const normalizedKey = key.toLowerCase();
		if (typeof child === "string" && child.length <= MAX_STRING_SCAN && BASE_KEYS.has(normalizedKey)) {
			const cleaned = cleanValue(child);
			if (cleaned) {
				recordBase = resolve(base, cleaned);
				addCandidate(recordBase, base);
			}
		}
	}
	return recordBase;
}

function walkEntries(entries: Array<[string, unknown]>, depth: number, recordBase: string, addCandidate: CandidateAdder, budget: ScanBudget) {
	for (const [key, child] of entries) {
		const normalizedKey = key.toLowerCase();
		// Base keys were already added as candidates while resolving recordBase.
		const isPathKey = PATH_KEYS.has(normalizedKey);
		if (typeof child === "string") {
			if (isPathKey) addCandidate(child, recordBase);
			else if (!BASE_KEYS.has(normalizedKey)) scanTokens(child, recordBase, addCandidate, budget);
		} else if (isPathKey && Array.isArray(child)) {
			// A path key may hold a list of locations; its elements are paths, not a record.
			for (const item of child) {
				if (budget.entries <= 0) break;
				budget.entries--;
				if (typeof item === "string") addCandidate(item, recordBase);
			}
		} else {
			walkValue(child, depth + 1, recordBase, addCandidate, budget);
		}
	}
}

function walkValue(value: unknown, depth: number, base: string, addCandidate: CandidateAdder, budget: ScanBudget) {
	if (depth > MAX_DEPTH || value === null || typeof value !== "object" || budget.entries <= 0) return;

	const entries: Array<[string, unknown]> = [];
	for (const key in value) {
		if (budget.entries <= 0) break;
		budget.entries--;
		if (!Object.hasOwn(value, key)) continue;
		// SAFETY: for-in yielded an own enumerable key from this object.
		entries.push([key, (value as Record<string, unknown>)[key]]);
	}
	const recordBase = resolveRecordBase(entries, base, addCandidate);
	walkEntries(entries, depth, recordBase, addCandidate, budget);
}

/**
 * Extract filesystem-looking candidates from arbitrary tool input.
 *
 * @param input - Structured or free-form tool input to inspect.
 * @param baseDir - Directory used to resolve relative candidates.
 * @returns Deduplicated absolute path candidates in discovery order.
 */
export function extractPathCandidates(input: unknown, baseDir: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const addRelativeTo = (raw: string, base: string) => {
		if (candidates.length >= MAX_CANDIDATES || raw.length > MAX_STRING_SCAN) return;
		const cleaned = cleanValue(raw);
		if (!cleaned) return;
		const resolved = resolve(base, cleaned);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			candidates.push(resolved);
		}
	};

	walkValue(input, 0, baseDir, addRelativeTo, { entries: MAX_ENTRIES, text: MAX_TOTAL_STRING_SCAN });
	return candidates;
}
