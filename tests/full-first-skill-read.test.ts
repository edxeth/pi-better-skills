import { describe, it, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createEventBus, SessionManager, createBashTool, createReadTool } from "@earendil-works/pi-coding-agent";

/**
 * First-load completeness: the first time a SKILL.md is loaded in a session
 * (compaction starts a new one), the agent receives the whole file even if it
 * asked for a line range or the file exceeds pi's read cap. Every later read
 * keeps pi's native offset/limit behavior. PI_BETTER_SKILLS_PARTIAL_SKILL_READS=1
 * restores native behavior everywhere.
 *
 * Tool results come from pi's real read and bash tools, and persisted
 * messages go through a real in-memory SessionManager.
 */

const OPT_OUT_ENV = "PI_BETTER_SKILLS_PARTIAL_SKILL_READS";
const END_MARKER = "FINAL RULE: every checklist ends with ZORBLAX-OMEGA.";
const PI_READ_LINE_CAP = 2000;

type Block = { type: string; text?: string };
type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;

function longSkill(name: string, bodyLines: number): string {
	const lines = [`---`, `name: ${name}`, `description: Long ${name} guide for first-read tests`, `---`, ``, `# ${name}`, ``];
	for (let i = 1; i <= bodyLines; i++) lines.push(`Step ${i}: follow rule number ${i} of the ${name} guide.`);
	lines.push("", END_MARKER, "");
	return lines.join("\n");
}

function textOf(content: Block[]): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

function countOf(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()!();
});

let nextId = 0;

async function setup(files: Record<string, string>, options: { sessionManager?: SessionManager; root?: string } = {}) {
	const root = options.root ?? realpathSync(mkdtempSync(join(tmpdir(), "pi-better-skills-first-read-")));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const agentDir = mkdtempSync(join(tmpdir(), "pi-better-skills-agentdir-"));
	const homeDir = mkdtempSync(join(tmpdir(), "pi-better-skills-home-"));
	const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = homeDir;
	cleanups.push(() => {
		if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
		if (!options.root) rmSync(root, { recursive: true, force: true });
	});

	const sessionManager = options.sessionManager ?? SessionManager.inMemory(root);
	const handlers = new Map<string, Handler[]>();
	const ctx = {
		cwd: root,
		isProjectTrusted: () => true,
		hasUI: false,
		sessionManager,
		model: { provider: "zai", id: "glm-5.3-flash" },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
		getContextUsage: () => ({ tokens: 100 }),
		getSystemPrompt: () => "",
	};
	const thinkingCalls: string[] = [];
	const pi = {
		events: createEventBus(),
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		setModel: async () => true,
		getThinkingLevel: () => "off",
		setThinkingLevel: (level: string) => thinkingCalls.push(level),
		getCommands: () => [],
	};
	const extension = (await import("../src/index")).default;
	(extension as (pi: unknown) => void)(pi);

	async function emit(event: string, payload: any): Promise<any> {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}

	const tools = { read: createReadTool(root), bash: createBashTool(root) };

	/** Foreign tools (an MCP wrapper, a notebook cell) run `command` through the real bash tool under their own name and input. */
	type RunOptions = { failWith?: string; command?: string };
	type Call = { id: string; toolName: string; original: Record<string, unknown>; args: Record<string, unknown>; blocked: boolean; command?: string };

	/** Pi runs every tool_call hook of a batch (sequentially) before any tool executes. */
	async function prepare(toolName: string, input: Record<string, unknown>, command?: string): Promise<Call> {
		const id = `call-${++nextId}`;
		const args = { ...input };
		const decision = (await emit("tool_call", { type: "tool_call", toolName, toolCallId: id, input: args })) as { block?: boolean } | undefined;
		return { id, toolName, original: input, args, blocked: Boolean(decision?.block), command };
	}

	/** Execute with the real tool, run the tool_result chain, and return the final model-facing content. */
	async function finish(call: Call, options: RunOptions = {}): Promise<{ content: Block[]; details: any; isError: boolean }> {
		let content: Block[];
		let details: any;
		let isError = false;
		if (call.blocked || options.failWith) {
			content = [{ type: "text", text: options.failWith ?? "blocked" }];
			isError = true;
		} else {
			const result =
				call.toolName === "read" || call.toolName === "bash"
					? await (tools[call.toolName] as any).execute(call.id, call.args)
					: await tools.bash.execute(call.id, { command: call.command! });
			content = result.content;
			details = result.details;
		}
		let current = content;
		for (const handler of handlers.get("tool_result") ?? []) {
			const replaced = (await handler(
				{ type: "tool_result", toolName: call.toolName, toolCallId: call.id, input: call.args, content: current, details, isError },
				ctx,
			)) as { content?: Block[]; details?: unknown } | undefined;
			if (replaced?.content) current = replaced.content;
			// Pi applies any replacement details that are not undefined.
			if (replaced?.details !== undefined) details = replaced.details;
		}
		return { content: current, details, isError };
	}

	/** Persist one assistant message with the batch's calls, then each result, then end the turn. */
	async function persist(results: Array<{ call: Call; content: Block[]; isError: boolean }>) {
		sessionManager.appendMessage({
			role: "assistant",
			content: results.map(({ call }) => ({ type: "toolCall", id: call.id, name: call.toolName, arguments: call.original })),
			timestamp: Date.now(),
		} as never);
		for (const { call, content, isError } of results) {
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.toolName,
				content,
				isError,
				timestamp: Date.now(),
			} as never);
		}
		await emit("turn_end", {});
	}

	/** One complete single-call turn. */
	async function run(toolName: string, input: Record<string, unknown>, options: RunOptions = {}) {
		const call = await prepare(toolName, input, options.command);
		const result = await finish(call, options);
		await persist([{ call, ...result }]);
		return { args: call.args, text: textOf(result.content), content: result.content, details: result.details, isError: result.isError };
	}

	await emit("session_start", {});
	/** What the tool itself returns, with no extension involved. */
	async function native(toolName: "read" | "bash", input: Record<string, unknown>): Promise<string> {
		return textOf((await (tools[toolName] as any).execute(`native-${++nextId}`, input)).content);
	}

	return { root, sessionManager, emit, prepare, finish, persist, run, native, thinkingCalls };
}

const SKILL_REL = ".pi/skills/long-guide/SKILL.md";

describe("first SKILL.md read in a session", () => {
	it("drops a requested line range and returns the whole file", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const first = await project.run("read", { path, offset: 1, limit: 200 });

		expect(first.args).toEqual({ path });
		expect(first.text).toContain("Step 1: follow rule number 1");
		expect(first.text).toContain(END_MARKER);
		expect(first.text).not.toContain("Use offset=");
		expect(first.text).toContain("<skill_context>");
	});

	it("returns files past pi's 2000-line read cap in one result", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 2500) });
		const path = join(project.root, SKILL_REL);
		expect(readFileSync(path, "utf-8").split("\n").length).toBeGreaterThan(PI_READ_LINE_CAP);

		const first = await project.run("read", { path });

		expect(first.text).toContain("Step 2500: follow rule number 2500");
		expect(first.text).toContain(END_MARKER);
		expect(first.text).not.toContain("Use offset=");
		// pi's read renderer warns from details.truncation; the result is no longer truncated.
		expect(first.details?.truncation?.truncated).toBeFalsy();
	});

	it("keeps pi's truncation record on a later capped read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 2500) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path });

		const later = await project.run("read", { path });

		expect(later.text).toContain("Use offset=");
		expect(later.details?.truncation?.truncated).toBe(true);
	});

	it("also completes a first read given as a workspace-relative path", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });

		const first = await project.run("read", { path: SKILL_REL, offset: 5, limit: 10 });

		expect(first.args.offset).toBeUndefined();
		expect(first.args.limit).toBeUndefined();
		expect(first.text).toContain(END_MARKER);
	});

	it("leaves every later read of the same SKILL.md native", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path, offset: 1, limit: 200 });

		const second = await project.run("read", { path, offset: 201, limit: 20 });

		expect(second.args).toEqual({ path, offset: 201, limit: 20 });
		expect(second.text).toContain("Step 195: follow rule number 195");
		expect(second.text).not.toContain(END_MARKER);
		expect(second.text).toContain("Use offset=221 to continue.");
	});

	it("completes only the first of parallel reads of one SKILL.md in one batch", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const a = await project.prepare("read", { path, offset: 1, limit: 100 });
		const b = await project.prepare("read", { path, offset: 101, limit: 100 });
		const results = [
			{ call: a, ...(await project.finish(a)) },
			{ call: b, ...(await project.finish(b)) },
		];
		await project.persist(results);

		expect(a.args).toEqual({ path });
		expect(textOf(results[0]!.content)).toContain(END_MARKER);
		expect(b.args).toEqual({ path, offset: 101, limit: 100 });
		expect(textOf(results[1]!.content)).not.toContain(END_MARKER);
	});

	it("tracks each SKILL.md separately", async () => {
		const project = await setup({
			[SKILL_REL]: longSkill("long-guide", 400),
			".pi/skills/other-guide/SKILL.md": longSkill("other-guide", 400),
		});
		await project.run("read", { path: join(project.root, SKILL_REL), offset: 1, limit: 50 });

		const other = await project.run("read", { path: join(project.root, ".pi/skills/other-guide/SKILL.md"), offset: 1, limit: 50 });

		expect(other.args.limit).toBeUndefined();
		expect(other.text).toContain(END_MARKER);
	});

	it("does not touch ranged reads of files other than SKILL.md", async () => {
		const project = await setup({ "notes/long.md": longSkill("notes", 400) });
		const path = join(project.root, "notes/long.md");

		const read = await project.run("read", { path, offset: 1, limit: 20 });

		expect(read.args).toEqual({ path, offset: 1, limit: 20 });
		expect(read.text).not.toContain(END_MARKER);
	});

	it("does not count a failed first read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path, offset: 1, limit: 20 }, { failWith: "EACCES" });

		const retry = await project.run("read", { path, offset: 1, limit: 20 });

		expect(retry.args).toEqual({ path });
		expect(retry.text).toContain(END_MARKER);
	});

	it("does not count a first read that never produced a result", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		// Another extension blocked the call after our hook ran: pi emits no tool_result.
		await project.prepare("read", { path, offset: 1, limit: 20 });
		await project.emit("turn_end", {});

		const retry = await project.run("read", { path, offset: 1, limit: 20 });

		expect(retry.args).toEqual({ path });
		expect(retry.text).toContain(END_MARKER);
	});
});

describe("later loads are exactly native", () => {
	// Dynamic shell placeholders only run for trusted skill roots.
	function trustProjectShell() {
		const previous = process.env.PI_TRUST_PROJECT_SKILL_SHELL;
		process.env.PI_TRUST_PROJECT_SKILL_SHELL = "1";
		cleanups.push(() => {
			if (previous === undefined) delete process.env.PI_TRUST_PROJECT_SKILL_SHELL;
			else process.env.PI_TRUST_PROJECT_SKILL_SHELL = previous;
		});
	}
	const DYNAMIC_LINE = "Build id: !`echo DYN-$((40+2))`";
	const withDynamic = (skill: string) => skill.replace("# long-guide", `# long-guide\n\n${DYNAMIC_LINE}`);

	it("decorates and runs the first load, then returns later reads unchanged", async () => {
		trustProjectShell();
		const project = await setup({ [SKILL_REL]: withDynamic(longSkill("long-guide", 400)) });
		const path = join(project.root, SKILL_REL);

		const first = await project.run("read", { path, offset: 1, limit: 50 });
		expect(first.text).toContain("<skill_context>");
		expect(first.text).toContain("Build id: DYN-42");

		const later = await project.run("read", { path });
		expect(later.text).toBe(await project.native("read", { path }));
		expect(later.text).not.toContain("<skill_context>");
		expect(later.text).toContain(DYNAMIC_LINE);

		const ranged = await project.run("read", { path, offset: 1, limit: 12 });
		expect(ranged.text).toBe(await project.native("read", { path, offset: 1, limit: 12 }));
	});

	it("keeps a parallel second read native even when its result arrives first", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const first = await project.prepare("read", { path, offset: 1, limit: 100 });
		const second = await project.prepare("read", { path, offset: 101, limit: 100 });
		const secondResult = await project.finish(second);
		const firstResult = await project.finish(first);
		await project.persist([
			{ call: first, ...firstResult },
			{ call: second, ...secondResult },
		]);

		expect(textOf(firstResult.content)).toContain("<skill_context>");
		expect(textOf(secondResult.content)).toBe(await project.native("read", { path, offset: 101, limit: 100 }));
	});

	it("returns a later shell load unchanged", async () => {
		trustProjectShell();
		const project = await setup({ [SKILL_REL]: withDynamic(longSkill("long-guide", 400)) });
		await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		for (const command of [`cat ${SKILL_REL}`, `head -n 30 ${SKILL_REL}`]) {
			const later = await project.run("bash", { command });
			expect(later.content.length).toBe(1);
			expect(later.text).toBe(await project.native("bash", { command }));
		}
	});

	it("applies frontmatter overrides only on the first load", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 40).replace("---\n\n#", "thinking: low\n---\n\n#") });
		const path = join(project.root, SKILL_REL);

		await project.run("read", { path });
		await project.emit("agent_end", {});
		expect(project.thinkingCalls).toEqual(["low", "off"]);

		await project.run("read", { path });
		await project.run("bash", { command: `cat ${SKILL_REL}` });
		expect(project.thinkingCalls).toEqual(["low", "off"]);
	});

	it("keeps later loads unchanged when partial reads are opted out", async () => {
		const previous = process.env[OPT_OUT_ENV];
		process.env[OPT_OUT_ENV] = "1";
		cleanups.push(() => {
			if (previous === undefined) delete process.env[OPT_OUT_ENV];
			else process.env[OPT_OUT_ENV] = previous;
		});
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const first = await project.run("read", { path, offset: 1, limit: 30 });
		const later = await project.run("read", { path, offset: 1, limit: 30 });

		expect(first.text).toContain("<skill_context>");
		expect(later.text).toBe(await project.native("read", { path, offset: 1, limit: 30 }));
	});
});

describe("session boundaries", () => {
	it("treats compaction as a new session", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		await project.run("read", { path, offset: 1, limit: 200 });
		// Keep the earlier read in the retained tail: compaction still resets.
		const firstKept = project.sessionManager.getBranch()[0]!.id;
		project.sessionManager.appendCompaction("Summary.", firstKept, 1000);
		await project.emit("session_compact", {});

		const afterCompaction = await project.run("read", { path, offset: 1, limit: 200 });

		expect(afterCompaction.args).toEqual({ path });
		expect(afterCompaction.text).toContain(END_MARKER);
	});

	it("remembers reads from a resumed session branch", async () => {
		const first = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(first.root, SKILL_REL);
		await first.run("read", { path, offset: 1, limit: 200 });

		const resumed = await setup({}, { sessionManager: first.sessionManager, root: first.root });
		const again = await resumed.run("read", { path, offset: 1, limit: 30 });

		expect(again.args).toEqual({ path, offset: 1, limit: 30 });
		expect(again.text).not.toContain(END_MARKER);
	});

	it("forgets reads that only happened before the branch's latest compaction on resume", async () => {
		const first = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(first.root, SKILL_REL);
		await first.run("read", { path, offset: 1, limit: 200 });
		first.sessionManager.appendCompaction("Summary.", first.sessionManager.getBranch()[0]!.id, 1000);

		const resumed = await setup({}, { sessionManager: first.sessionManager, root: first.root });
		const again = await resumed.run("read", { path, offset: 1, limit: 30 });

		expect(again.args).toEqual({ path });
		expect(again.text).toContain(END_MARKER);
	});

	it("follows tree navigation to a branch without the read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		project.sessionManager.appendMessage({ role: "user", content: "start", timestamp: Date.now() } as never);
		const beforeRead = project.sessionManager.getLeafId()!;
		await project.run("read", { path, offset: 1, limit: 200 });

		project.sessionManager.branch(beforeRead);
		await project.emit("session_tree", {});
		const onOtherBranch = await project.run("read", { path, offset: 1, limit: 30 });

		expect(onOtherBranch.args).toEqual({ path });
		expect(onOtherBranch.text).toContain(END_MARKER);
	});
});

describe("bash loads", () => {
	it("appends the whole file to a first partial bash read", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const command = `sed -n '1,60p' ${SKILL_REL}`;

		const first = await project.run("bash", { command });

		expect(first.args).toEqual({ command });
		expect(first.content.length).toBe(2);
		expect(first.content[0]!.text).not.toContain(END_MARKER);
		expect(first.content[1]!.text).toContain(END_MARKER);
		expect(first.content[1]!.text).toContain("<skill_context>");
	});

	it("leaves a later partial bash read native", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		const second = await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		expect(second.content.length).toBe(1);
		expect(second.text).not.toContain(END_MARKER);
	});

	it("does not duplicate a complete bash read, and counts it", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const cat = await project.run("bash", { command: `cat ${SKILL_REL}` });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(countOf(cat.text, END_MARKER)).toBe(1);
		expect(read.args).toEqual({ path, offset: 1, limit: 30 });
		expect(read.text).not.toContain(END_MARKER);
	});

	it("ignores output with fewer than three consecutive skill lines", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const grep = await project.run("bash", { command: `grep -n 'rule number 7 ' ${SKILL_REL}` });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(grep.text).not.toContain(END_MARKER);
		expect(read.args).toEqual({ path });
		expect(read.text).toContain(END_MARKER);
	});

	it("counts a first read tool load, so a later bash read stays native", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		await project.run("read", { path: join(project.root, SKILL_REL), offset: 1, limit: 30 });

		const bash = await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		expect(bash.content.length).toBe(1);
		expect(bash.text).not.toContain(END_MARKER);
	});
});

describe("tool-agnostic loads", () => {
	// A code-mode tool can cut long output from the front and print no notice.
	it("completes a tail-only first load from a code-mode tool with the body only", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);
		const code = `const r = await tools.run({cmd: "cat ${path}", budget: 750}); print(r.output);`;

		const first = await project.run("exec", { code }, { command: `tail -c 3000 ${path}` });

		expect(first.content.length).toBe(2);
		const added = first.content[1]!.text!;
		expect(first.content[0]!.text).not.toContain("# long-guide");
		expect(added).toContain("# long-guide");
		expect(added).toContain("Step 1: follow rule number 1 ");
		expect(added).toContain(END_MARKER);
		// Body only: the frontmatter is named in the note, not repeated.
		expect(added).not.toContain("name: long-guide");
		expect(added).not.toContain("description:");
		// The same skill tag pi and reference expansion use; the path rides as an attribute.
		expect(added.startsWith(`<skill name="long-guide" location="${path}">\n`)).toBe(true);
		expect(added.trimEnd().endsWith("</skill>")).toBe(true);
		// Frontmatter: ---, name, description, --- and a blank line, so the body starts on line 6.
		expect(added).toContain("body line 1 = file line 6");
		expect(countOf(added, "<skill_context>")).toBe(1);
		expect(added.indexOf("<skill_context>")).toBeLessThan(added.indexOf("# long-guide"));
	});

	it("computes the body's file line from each skill's own frontmatter", async () => {
		const settings = "model: zai/glm-5.3\nthinking: low\nglobs:\n  - '*.zorb'\n";
		const skill = longSkill("long-guide", 400).replace("---\n\n#", `${settings}---\n\n\n#`);
		const project = await setup({ [SKILL_REL]: skill });
		const lines = readFileSync(join(project.root, SKILL_REL), "utf-8").split("\n");
		const bodyLine = lines.indexOf("# long-guide") + 1;
		expect(bodyLine).toBe(11);

		const first = await project.run("bash", { command: `tail -n 40 ${SKILL_REL}` });

		expect(first.content[1]!.text).toContain(`body line 1 = file line ${bodyLine}`);
	});

	it("leaves out the frontmatter clause for a SKILL.md without frontmatter", async () => {
		const plain = longSkill("plain", 400).replace(/^---[\s\S]*?---\n/, "");
		const project = await setup({ "notes/plain/SKILL.md": plain });
		const path = join(project.root, "notes/plain/SKILL.md");

		const first = await project.run("bash", { command: `tail -n 40 ${path}` });

		expect(first.content.length).toBe(2);
		expect(first.content[1]!.text).toContain("Step 1: follow rule number 1 ");
		expect(first.content[1]!.text).not.toContain("frontmatter");
		expect(first.content[1]!.text).not.toContain("file line");
	});

	it("marks a tool-agnostic first load as resident, so globs do not inject it again", async () => {
		const skill = longSkill("long-guide", 400).replace("---\n\n#", "globs:\n  - '**/*.zorb'\n---\n\n#");
		const project = await setup({ [SKILL_REL]: skill, "src/a.zorb": "zorb" });
		const path = join(project.root, SKILL_REL);

		await project.run("exec", { code: "cell" }, { command: `tail -c 3000 ${path}` });
		const touch = await project.run("read", { path: join(project.root, "src/a.zorb") });

		expect(countOf(touch.text, "Step 1: follow rule number 1 ")).toBe(0);
	});

	it("completes a first load whose input never names the file", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const dir = join(project.root, ".pi/skills/long-guide");

		const first = await project.run("exec", { code: "print(open(p).read()[:4000])" }, { command: `head -c 4000 ${dir}/SKILL.md` });

		expect(first.content.length).toBe(2);
		expect(first.content[1]!.text).toContain(END_MARKER);
	});

	it("completes a first middle window", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });

		const first = await project.run("bash", { command: `sed -n '201,260p' ${SKILL_REL}` });

		expect(first.content.length).toBe(2);
		expect(first.content[1]!.text).toContain("Step 1: follow rule number 1 ");
		expect(first.content[1]!.text).toContain(END_MARKER);
	});

	it("recognizes line-numbered output, and a complete numbered load needs nothing appended", async () => {
		const partial = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const numberedHead = await partial.run("bash", { command: `cat -n ${SKILL_REL} | head -n 80` });
		expect(numberedHead.content.length).toBe(2);
		expect(numberedHead.content[1]!.text).toContain(END_MARKER);

		const whole = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const numberedAll = await whole.run("bash", { command: `cat -n ${SKILL_REL}` });
		expect(numberedAll.content.length).toBe(1);
		expect(countOf(numberedAll.text, END_MARKER)).toBe(1);
	});

	it("attributes shared boilerplate to the skill actually loaded", async () => {
		const shared = "## Safety\n\nNever push to main without review.\nAlways run the full test suite first.\nAsk before deleting any branch.\n";
		const project = await setup({
			[SKILL_REL]: longSkill("long-guide", 300) + shared,
			".pi/skills/other-guide/SKILL.md": longSkill("other-guide", 300) + shared,
		});
		const otherPath = join(project.root, ".pi/skills/other-guide/SKILL.md");

		const whole = await project.run("bash", { command: `cat ${SKILL_REL}` });
		const other = await project.run("read", { path: otherPath, offset: 1, limit: 20 });

		expect(whole.content.length).toBe(1);
		expect(other.args).toEqual({ path: otherPath });
		expect(other.text).toContain("Step 300: follow rule number 300 of the other-guide");
	});

	it("names no skill when two skills tie on identical text", async () => {
		const body = (name: string) => longSkill("twin", 300).replace("name: twin", `name: ${name}`);
		const project = await setup({ [SKILL_REL]: body("long-guide"), ".pi/skills/other-guide/SKILL.md": body("other-guide") });
		const otherPath = join(project.root, ".pi/skills/other-guide/SKILL.md");

		const window = await project.run("bash", { command: `sed -n '100,140p' ${SKILL_REL}` });
		const other = await project.run("read", { path: otherPath, offset: 1, limit: 20 });

		expect(window.content.length).toBe(1);
		expect(other.args).toEqual({ path: otherPath });
	});

	it("recognizes a tail kept inside a JSON string", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const tail = readFileSync(join(project.root, SKILL_REL), "utf-8").slice(-3000);
		writeFileSync(join(project.root, "out.json"), JSON.stringify({ output: tail, exit_code: 0 }));

		const first = await project.run("exec", { code: "print(JSON.stringify(r))" }, { command: "cat out.json" });

		expect(first.content.length).toBe(2);
		expect(first.content[1]!.text).toContain("Step 1: follow rule number 1 ");
	});

	it("recognizes indented, double-encoded, and single-quoted escaped strings", async () => {
		const tail = longSkill("long-guide", 400).slice(-3000);
		const forms = {
			"pretty.json": JSON.stringify({ result: { output: tail } }, null, 2),
			"double.json": JSON.stringify({ body: JSON.stringify({ output: tail }) }),
			"repr.txt": `{'output': '${tail.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'}`,
		};
		for (const [file, text] of Object.entries(forms)) {
			const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400), [file]: text });
			const first = await project.run("exec", { code: "cell" }, { command: `cat ${file}` });
			expect({ file, blocks: first.content.length }).toEqual({ file, blocks: 2 });
		}
	});

	it("appends nothing when a JSON string already holds the whole file", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const whole = readFileSync(join(project.root, SKILL_REL), "utf-8");
		writeFileSync(join(project.root, "out.json"), JSON.stringify({ output: whole }, null, 2));
		const path = join(project.root, SKILL_REL);

		const first = await project.run("exec", { code: "cell" }, { command: "cat out.json" });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(first.content.length).toBe(1);
		expect(read.args).toEqual({ path, offset: 1, limit: 30 });
	});

	it("does not count unrelated escaped JSON", async () => {
		const project = await setup({
			[SKILL_REL]: longSkill("long-guide", 400),
			"out.json": JSON.stringify({ output: "line one\nline two\nStep 7: follow rule number 7 of the long-guide guide.\nother" }),
		});
		const path = join(project.root, SKILL_REL);

		const first = await project.run("exec", { code: "cell" }, { command: "cat out.json" });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(first.content.length).toBe(1);
		expect(read.args).toEqual({ path });
	});

	it("does not count runs of short structural lines", async () => {
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) + "---\n```\n}\n" });
		const path = join(project.root, SKILL_REL);

		await project.run("bash", { command: "printf -- '---\\n```\\n}\\n'" });
		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(read.args).toEqual({ path });
	});

	it("rebuilds tool-agnostic loads on resume", async () => {
		const first = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(first.root, SKILL_REL);
		await first.run("exec", { code: "cell 1" }, { command: `tail -c 3000 ${path}` });

		const resumed = await setup({}, { sessionManager: first.sessionManager, root: first.root });
		const again = await resumed.run("exec", { code: "cell 2" }, { command: `tail -c 3000 ${path}` });

		expect(again.content.length).toBe(1);
	});
});

describe(`${OPT_OUT_ENV}=1`, () => {
	it("keeps native partial reads for read and bash", async () => {
		const previous = process.env[OPT_OUT_ENV];
		process.env[OPT_OUT_ENV] = "1";
		cleanups.push(() => {
			if (previous === undefined) delete process.env[OPT_OUT_ENV];
			else process.env[OPT_OUT_ENV] = previous;
		});
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const read = await project.run("read", { path, offset: 1, limit: 30 });
		const bash = await project.run("bash", { command: `head -n 60 ${SKILL_REL}` });

		expect(read.args).toEqual({ path, offset: 1, limit: 30 });
		expect(read.text).not.toContain(END_MARKER);
		expect(bash.text).not.toContain(END_MARKER);
	});

	it("treats 0/false/no/off as not opted out", async () => {
		const previous = process.env[OPT_OUT_ENV];
		process.env[OPT_OUT_ENV] = "off";
		cleanups.push(() => {
			if (previous === undefined) delete process.env[OPT_OUT_ENV];
			else process.env[OPT_OUT_ENV] = previous;
		});
		const project = await setup({ [SKILL_REL]: longSkill("long-guide", 400) });
		const path = join(project.root, SKILL_REL);

		const read = await project.run("read", { path, offset: 1, limit: 30 });

		expect(read.text).toContain(END_MARKER);
	});
});
