import { resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { extractPathCandidates } from "../src/tool-paths";

describe("extractPathCandidates (structured keys)", () => {
	it("resolves a relative path key against the base dir", () => {
		expect(extractPathCandidates({ path: "src/components/Button.widget" }, "/repo")).toEqual([
			resolve("/repo/src/components/Button.widget"),
		]);
	});

	it("keeps absolute paths and dedupes repeated candidates", () => {
		expect(extractPathCandidates({ path: "/repo/a.ts", file_path: "/repo/a.ts" }, "/repo")).toEqual(["/repo/a.ts"]);
	});

	it("ignores non-string and empty values", () => {
		expect(extractPathCandidates({ path: 7, filePath: "", nested: { path: null } }, "/repo")).toEqual([]);
	});

	it("reads every entry of a list-valued path key", () => {
		// MCP read_multiple_files and friends pass a list, not a single string.
		expect(extractPathCandidates({ paths: ["src/App.tsx", "src/Other.tsx"] }, "/repo")).toEqual([
			resolve("/repo/src/App.tsx"),
			resolve("/repo/src/Other.tsx"),
		]);
		expect(extractPathCandidates({ files: ["a.css"], file_paths: ["b.css"] }, "/repo")).toEqual([
			resolve("/repo/a.css"),
			resolve("/repo/b.css"),
		]);
	});

	it("resolves a list-valued path key against a workdir base key", () => {
		expect(extractPathCandidates({ workdir: "src", paths: ["App.tsx"] }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/App.tsx"),
		]);
	});

	it("skips non-string entries inside a list-valued path key", () => {
		expect(extractPathCandidates({ paths: [7, null, "src/App.tsx", { path: "nested.tsx" }] }, "/repo")).toEqual([
			resolve("/repo/src/App.tsx"),
		]);
	});

	it("scans path-looking strings in arbitrary lists without trusting bare words", () => {
		expect(extractPathCandidates({ args: ["src/App.tsx", "Dockerfile"] }, "/repo")).toEqual([
			resolve("/repo/src/App.tsx"),
		]);
	});
});

describe("extractPathCandidates (free-form strings)", () => {
	it("preserves v1.3.2 path mentions in arbitrary command strings", () => {
		expect(extractPathCandidates({ command: "cat src/components/Button.widget" }, "/repo")).toEqual([
			resolve("/repo/src/components/Button.widget"),
		]);
		expect(extractPathCandidates({ cmd: "ls -la src/App.tsx" }, "/repo")).toEqual([
			resolve("/repo/src/App.tsx"),
		]);
	});

	it("still resolves a structured path key against a workdir in the same record", () => {
		expect(extractPathCandidates({ cmd: "sed -n 1,5p tests/helper.ts", workdir: "/repo/src", file: "tests/helper.ts" }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/tests/helper.ts"),
		]);
	});

	it("ignores blank base keys", () => {
		expect(extractPathCandidates({ command: "   ", workdir: "  " }, "/repo")).toEqual([]);
	});

	it("does not re-emit a relative workdir as its own child path", () => {
		expect(extractPathCandidates({ workdir: "src", path: "helper.ts" }, "/repo")).toEqual([
			resolve("/repo/src"),
			resolve("/repo/src/helper.ts"),
		]);
	});
});

describe("extractPathCandidates (nesting and budgets)", () => {
	it("walks nested records with their base and stops at the depth limit", () => {
		expect(
			extractPathCandidates(
				{
					details: {
						cwd: "/repo/src",
						path: "helper.ts",
						deeper: { ignored: { path: "not-reached.ts" } },
					},
				},
				"/repo",
			),
		).toEqual([resolve("/repo/src"), resolve("/repo/src/helper.ts")]);
	});

	it("includes candidates at the maximum nested-record depth", () => {
		expect(extractPathCandidates({ level1: { level2: { path: "files/depth-two.ts" } } }, "/repo")).toEqual([
			resolve("/repo/files/depth-two.ts"),
		]);
	});

	it("enforces the candidate budget", () => {
		const input = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [`nested${index}`, { path: `files/${index}.ts` }]),
		);
		expect(extractPathCandidates(input, "/repo")).toHaveLength(16);
	});
});

describe("extractPathCandidates (notebook and bounded compatibility)", () => {
	it("preserves v1.3.2 unquoted path tokens containing route punctuation", () => {
		for (const path of ["src/app/[id]/page.tsx", "src/app/(group)/page.tsx", "src/a,b.ts"]) {
			expect(extractPathCandidates({ cmd: "cat " + path }, "/repo")).toContain(resolve("/repo", path));
		}
	});

	it("finds quoted file literals inside notebook expressions", () => {
		expect(extractPathCandidates({ code: 'text(await Deno.readTextFile("src/App.tsx"));' }, "/repo")).toEqual([resolve("/repo/src/App.tsx")]);
		expect(extractPathCandidates({ code: "text(await tools.exec_command({cmd:'cat src/App.tsx'}));" }, "/repo")).toEqual([resolve("/repo/src/App.tsx")]);
	});

	it("keeps quoted paths with spaces as candidates", () => {
		expect(extractPathCandidates({ code: 'text(await Deno.readTextFile("/repo/my app/Button.tsx"));' }, "/repo")).toEqual(["/repo/my app/Button.tsx"]);
	});

	it("ignores flags, URLs and bare command words and strips line suffixes", () => {
		expect(extractPathCandidates({ cmd: "rg -n --hidden plain tests/a.ts:10-20 https://example.com/x.md Dockerfile" }, "/repo")).toEqual([
			resolve("/repo/tests/a.ts"),
		]);
	});

	it("does not scan beyond the per-string size limit", () => {
		expect(extractPathCandidates({ code: "x".repeat(16 * 1024) + " src/late.ts" }, "/repo")).toEqual([]);
		const path = "src/boundary.ts";
		const atLimit = " ".repeat(16 * 1024 - path.length) + path;
		expect(extractPathCandidates({ code: atLimit }, "/repo")).toEqual([resolve("/repo", path)]);
	});

	it("limits total free-form text scanned across a single input", () => {
		const input = { a: "x".repeat(16 * 1024), b: "x".repeat(16 * 1024), c: "x".repeat(16 * 1024), d: "x".repeat(16 * 1024), late: "src/late.ts" };
		expect(extractPathCandidates(input, "/repo")).toEqual([]);
	});

	it("limits visited entries even when none produces a candidate", () => {
		const input = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [String(index), null]));
		input.path = "src/late.ts";
		expect(extractPathCandidates(input, "/repo")).toEqual([]);
	});

	it("terminates on cyclic records and ignores inherited path fields", () => {
		const input: { self?: unknown; path: string } = { path: "src/App.tsx" };
		input.self = input;
		expect(extractPathCandidates(input, "/repo")).toEqual([resolve("/repo/src/App.tsx")]);
		expect(extractPathCandidates(Object.create({ path: "src/inherited.ts" }), "/repo")).toEqual([]);
	});
});

describe("extractPathCandidates (candidate admission)", () => {
	it("does not let notebook syntax displace later legacy path mentions", () => {
		const input = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
			"code" + index, 'Deno.readTextFile("quoted/' + index + '.ts")',
		]));
		input.cmd = "cat legacy/target.ts";
		expect(extractPathCandidates(input, "/repo")).toEqual([
			...Array.from({ length: 8 }, (_, index) => resolve("/repo/quoted/" + index + ".ts")),
			resolve("/repo/legacy/target.ts"),
		]);
	});

	it("charges inherited enumeration to the visit budget", () => {
		let descriptors = 0;
		const prototype = new Proxy(Object.fromEntries(Array.from({ length: 1000 }, (_, index) => ["field" + index, null])), {
			getOwnPropertyDescriptor(target, key) {
				descriptors++;
				return Object.getOwnPropertyDescriptor(target, key);
			},
		});
		expect(extractPathCandidates(Object.create(prototype), "/repo")).toEqual([]);
		expect(descriptors).toBeLessThan(1000);
	});
});

describe("extractPathCandidates (quoted literals and command values)", () => {
	it("keeps relative quoted paths with spaces intact", () => {
		for (const path of ["my app/Button.tsx", "my file.ts"]) {
			expect(extractPathCandidates({ code: 'Deno.readTextFile("' + path + '")' }, "/repo")).toEqual([
				resolve("/repo", path),
			]);
		}
	});

	it("scans nested command values even when the executable is path-qualified", () => {
		expect(extractPathCandidates({ code: "text(await tools.exec_command({cmd:'./reader src/App.tsx'}));" }, "/repo")).toEqual([
			resolve("/repo/reader"),
			resolve("/repo/src/App.tsx"),
		]);
	});
});

describe("extractPathCandidates (nested shell commands)", () => {
	it("preserves quoted shell command arguments from v1.3.2", () => {
		for (const command of ['bash -lc "cat src/App.tsx"', "sh -c './reader src/App.tsx'"]) {
			const candidates = extractPathCandidates({ command }, "/repo");
			expect(candidates).toContain(resolve("/repo/src/App.tsx"));
			expect(candidates).not.toContain(resolve("/repo/cat src/App.tsx"));
		}
	});
});
