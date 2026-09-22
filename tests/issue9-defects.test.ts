import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cliSkillsOnly } from "../src/index";

/**
 * Issue #9 regressions: three confirmed defects.
 *
 * 1. --no-skills policy leak: non-CLI discovery and ad-hoc SKILL.md
 *    resolution must stop when pi runs with --no-skills; explicit CLI
 *    --skill entries stay available.
 * 2. Wrong block receives direct-read context: the block that carries the
 *    complete skill body gets the <skill_context> decoration and the
 *    frontmatter override, not the first text block.
 * 3. Model override race: the override must complete before the
 *    tool_result handler returns, so agent_end cannot restore first.
 */

type TextBlock = { type: "text"; text: string };
type ToolResultEvent = {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: TextBlock[];
	isError: boolean;
};
type PersistedMessage = Parameters<SessionManager["appendMessage"]>[0];
type FakeContext = {
	cwd: string;
	isProjectTrusted: () => boolean;
	hasUI: boolean;
	sessionManager: SessionManager;
	model: { provider: string; id: string };
	modelRegistry: {
		find: (provider: string, id: string) => { id: string; provider: string; contextWindow: number };
		hasConfiguredAuth: (model: unknown) => boolean;
	};
	getContextUsage: () => { tokens: number };
};
type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;

const OVERRIDE_SKILL = `---
name: override-skill
description: Test override skill for issue 9 regressions
model: zai/glm-5.3
thinking: low
---

Override skill body marker.
`;

const QUOTED_OVERRIDE_SKILL = `---
name: override-skill
description: Test override skill for issue 9 regressions
model: "zai/glm-5.3" # inline comment after a quoted value
thinking: "low"
---

Override skill body marker.
`;

function makeFakePi(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const sessionManager = SessionManager.inMemory(cwd);
	const ctx: FakeContext = {
		cwd,
		isProjectTrusted: () => true,
		hasUI: false,
		sessionManager,
		model: { provider: "zai", id: "glm-5.3-flash" },
		modelRegistry: {
			find: (provider, id) => ({ id, provider, contextWindow: 1_000_000 }),
			hasConfiguredAuth: () => true,
		},
		getContextUsage: () => ({ tokens: 100 }),
	};
	const calls: string[] = [];
	const pi: Record<string, unknown> = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerMessageRenderer: () => {},
		sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
		setModel: async (model: { id: string }) => {
			calls.push(`setModel:${model.id}`);
			return true;
		},
		getThinkingLevel: () => "off",
		setThinkingLevel: (level: string) => {
			calls.push(`thinking:${level}`);
		},
	};
	return {
		pi,
		ctx,
		calls,
		setSessionContext: (messages: unknown[]) => {
			sessionManager.newSession();
			for (const message of messages) sessionManager.appendMessage(message as PersistedMessage);
		},
		emit: async (event: string, payload: unknown) => {
			if (event === "tool_result") {
				let current = payload as ToolResultEvent;
				let modified = false;
				for (const handler of handlers.get(event) ?? []) {
					const result = (await handler(current, ctx)) as { content?: TextBlock[] } | undefined;
					if (!result?.content) continue;
					current = { ...current, content: result.content };
					modified = true;
				}
				return modified ? { content: current.content } : undefined;
			}
			if (event === "message_end") {
				let currentMessage = (payload as { message: PersistedMessage }).message;
				for (const handler of handlers.get(event) ?? []) {
					const result = (await handler({ ...(payload as object), message: currentMessage }, ctx)) as
						| { message?: PersistedMessage }
						| undefined;
					if (result?.message) currentMessage = result.message;
				}
				sessionManager.appendMessage(currentMessage);
				return;
			}
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
			return result;
		},
	};
}

async function setupProject(files: Record<string, string>, { argv }: { argv?: string[] } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-skills-issue9-")));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	// argv stays swapped for the whole test: discovery and ad-hoc skill
	// resolution read process.argv per event, not only at startup.
	const originalArgv = process.argv;
	if (argv) process.argv = argv;
	// Hermetic bootstrap: PI_CODING_AGENT_DIR isolates pi's agent dir
	// (~/.pi/agent) and HOME isolates the cross-agent ~/.agents/skills dir
	// the package manager also scans, so discovery never reads the
	// developer's real global skills, packages, or settings during tests.
	const agentDir = mkdtempSync(join(tmpdir(), "pi-better-skills-agentdir-"));
	const homeDir = mkdtempSync(join(tmpdir(), "pi-better-skills-home-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousHome = process.env.HOME;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.HOME = homeDir;
	const extension = (await import("../src/index")).default;
	const { pi, ctx, calls, emit } = makeFakePi(root);
	(extension as (pi: unknown) => void)(pi);
	await emit("session_start", {});
	return {
		root,
		ctx,
		pi,
		calls,
		emit,
		cleanup: () => {
			if (argv) process.argv = originalArgv;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(homeDir, { recursive: true, force: true });
		},
	};
}

let nextToolCallId = 0;

function toolResult(toolName: string, input: Record<string, unknown>, content: TextBlock[]): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: `call-${++nextToolCallId}`,
		toolName,
		input,
		content,
		isError: false,
	};
}

function readSkillEvent(skillPath: string): ToolResultEvent {
	return toolResult("read", { path: skillPath }, [{ type: "text", text: OVERRIDE_SKILL }]);
}

function deliveredBlocks(result: unknown): TextBlock[] {
	return (result as { content?: TextBlock[] } | undefined)?.content ?? [];
}

describe("defect 3: model override completes before the tool_result handler returns", () => {
	it("awaits the override, so agent_end cannot restore before it applies", async () => {
		const project = await setupProject({ ".pi/skills/override-skill/SKILL.md": OVERRIDE_SKILL });
		try {
			const order: string[] = [];
			let release!: (value: boolean) => void;
			const gate = new Promise<boolean>((resolve) => (release = resolve));
			(project.pi as Record<string, unknown>).setModel = async (model: { id: string }) => {
				order.push(`setModel:${model.id}`);
				const ok = await gate;
				order.push("setModel-done");
				return ok;
			};
			const skillPath = join(project.root, ".pi/skills/override-skill/SKILL.md");
			const emitPromise = project.emit("tool_result", readSkillEvent(skillPath));
			emitPromise.then(() => order.push("handler-done"));
			await new Promise((resolve) => setTimeout(resolve, 25));
			release(true);
			await emitPromise;
			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(order).toContain("setModel:glm-5.3");
			expect(order).toContain("setModel-done");
			expect(order.indexOf("handler-done")).toBeGreaterThan(order.indexOf("setModel-done"));
		} finally {
			project.cleanup();
		}
	});
});

describe("defect 2: the body-bearing block receives the direct-read context", () => {
	it("still enriches a partial bash read whose output covers the body prefix", async () => {
		const longBodySkill =
			"---\nname: override-skill\ndescription: Test override skill for issue 9 regressions\nmodel: zai/glm-5.3\nthinking: low\n---\n\nOverride skill body marker with a body long enough that a partial read can cover its eighty-character confirmation prefix without covering the complete body.";
		const project = await setupProject({ ".pi/skills/override-skill/SKILL.md": longBodySkill });
		try {
			const skillPath = join(project.root, ".pi/skills/override-skill/SKILL.md");
			const bodyStart = longBodySkill.indexOf("Override skill body marker");
			const partial = "STATUS: partial read\n" + longBodySkill.slice(0, bodyStart + 90);
			const event = toolResult("bash", { command: "head -c 400 " + skillPath }, [{ type: "text", text: partial }]);
			const blocks = deliveredBlocks(await project.emit("tool_result", event));
			const text = blocks[0]?.text ?? "";

			// A prefix read counts as a skill read: it is enriched. The body is
			// incomplete, so the context is prepended to the first block (the
			// pre-issue-9 partial-read behavior) and no residency claim is made.
			expect(text).toContain("<skill_context>");
			expect(text.startsWith("<skill_context>")).toBe(true);
			expect(text).toContain("STATUS: partial read");
		} finally {
			project.cleanup();
		}
	});

	it("parses quoted frontmatter values with inline comments via YAML", async () => {
		const project = await setupProject({ ".pi/skills/override-skill/SKILL.md": QUOTED_OVERRIDE_SKILL });
		try {
			const skillPath = join(project.root, ".pi/skills/override-skill/SKILL.md");
			await project.emit("tool_result", readSkillEvent(skillPath));
			expect(project.calls).toContain("setModel:glm-5.3");
			expect(project.calls).toContain("thinking:low");
		} finally {
			project.cleanup();
		}
	});

	it("decorates the block carrying the complete body in a multi-block result and keeps the override", async () => {
		const project = await setupProject({ ".pi/skills/override-skill/SKILL.md": OVERRIDE_SKILL });
		try {
			const skillPath = join(project.root, ".pi/skills/override-skill/SKILL.md");
			const event = toolResult(
				"mcp__exec__run",
				{ cmd: `cat ${skillPath}` },
				[
					{ type: "text", text: "Script completed" },
					{ type: "text", text: "Notebook example foo/bar available" },
					{ type: "text", text: OVERRIDE_SKILL },
				],
			);
			const blocks = deliveredBlocks(await project.emit("tool_result", event));

			expect(blocks[0]!.text).toBe("Script completed");
			expect(blocks[1]!.text).toBe("Notebook example foo/bar available");
			expect(blocks[2]!.text.startsWith("---")).toBe(true);
			expect(blocks[2]!.text).toContain("<skill_context>");
			expect(project.calls).toContain("setModel:glm-5.3");
			expect(project.calls).toContain("thinking:low");
		} finally {
			project.cleanup();
		}
	});

	it("applies the override and decorates at the body when a single block carries status text first", async () => {
		const project = await setupProject({ ".pi/skills/override-skill/SKILL.md": OVERRIDE_SKILL });
		try {
			const skillPath = join(project.root, ".pi/skills/override-skill/SKILL.md");
			const event = toolResult(
				"bash",
				{ command: `echo STATUS:loading && cat ${skillPath}` },
				[{ type: "text", text: `STATUS:loading\n${OVERRIDE_SKILL}` }],
			);
			const blocks = deliveredBlocks(await project.emit("tool_result", event));
			const text = blocks[0]!.text;

			expect(text.startsWith("STATUS:loading")).toBe(true);
			expect(text).toContain("<skill_context>");
			expect(text.indexOf("<skill_context>")).toBeGreaterThan(text.indexOf("name: override-skill"));
			expect(project.calls).toContain("setModel:glm-5.3");
		} finally {
			project.cleanup();
		}
	});
});

describe("defect 1: --no-skills stops non-CLI skills", () => {
	it("recognizes both --no-skills and the -ns alias, like pi's parser", () => {
		expect(cliSkillsOnly(["pi", "--no-skills"])).toBe(true);
		expect(cliSkillsOnly(["pi", "-ns"])).toBe(true);
		expect(cliSkillsOnly(["pi", "--skill", "/tmp/x/SKILL.md"])).toBe(false);
		expect(cliSkillsOnly(["pi"])).toBe(false);
	});

	it("does not enrich a project skill read under --no-skills", async () => {
		const project = await setupProject(
			{ ".pi/skills/override-skill/SKILL.md": OVERRIDE_SKILL },
			{ argv: ["pi", "--no-skills"] },
		);
		try {
			const skillPath = join(project.root, ".pi/skills/override-skill/SKILL.md");
			const blocks = deliveredBlocks(await project.emit("tool_result", readSkillEvent(skillPath)));
			const text = blocks[0]?.text ?? OVERRIDE_SKILL;

			expect(text.startsWith("---")).toBe(true);
			expect(text).not.toContain("<skill_context>");
			expect(project.calls).not.toContain("setModel:glm-5.3");
		} finally {
			project.cleanup();
		}
	});

	it("keeps an explicit CLI --skill entry available under --no-skills", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-skills-issue9-cli-")));
		const skillPath = join(root, "override-skill", "SKILL.md");
		mkdirSync(dirname(skillPath), { recursive: true });
		writeFileSync(skillPath, OVERRIDE_SKILL, "utf-8");
		const originalArgv = process.argv;
		process.argv = ["pi", "--no-skills", "--skill", skillPath];
		const agentDir = mkdtempSync(join(tmpdir(), "pi-better-skills-agentdir-"));
		const homeDir = mkdtempSync(join(tmpdir(), "pi-better-skills-home-"));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousHome = process.env.HOME;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.HOME = homeDir;
		try {
			const extension = (await import("../src/index")).default;
			const { pi, calls, emit } = makeFakePi(root);
			(extension as (pi: unknown) => void)(pi);
			await emit("session_start", {});
			const blocks = deliveredBlocks(await emit("tool_result", readSkillEvent(skillPath)));
			const text = blocks[0]?.text ?? "";

			expect(text).toContain("<skill_context>");
			expect(calls).toContain("setModel:glm-5.3");
		} finally {
			process.argv = originalArgv;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			rmSync(root, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
