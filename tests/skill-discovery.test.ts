import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { cliSkillPaths, resultConfirmsSkillBody } from "../src/index";

/**
 * Discovery is a canonical bootstrap: DefaultPackageManager.resolve (settings,
 * packages, default roots, .agents roots, trust gating — what pi itself runs)
 * plus one loadSkills over the enabled paths. It runs at session_start and
 * resources_discover only; before_agent_start merges pi's loaded set without
 * touching the filesystem. The bootstrap tests observe the catalog through the
 * tool_result enrichment seam.
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
type FakeContext = { cwd: string; isProjectTrusted: () => boolean; hasUI: boolean; sessionManager: SessionManager };
type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;

function makeFakePi(cwd: string, trusted: boolean) {
	const handlers = new Map<string, Handler[]>();
	const sessionManager = SessionManager.inMemory(cwd);
	const ctx: FakeContext = { cwd, isProjectTrusted: () => trusted, hasUI: false, sessionManager };
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
	};
	return {
		pi,
		emit: async (event: string, payload: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				result = await handler(payload, ctx);
			}
			return result;
		},
	};
}

async function setupProject(files: Record<string, string>, trusted = true) {
	const root = mkdtempSync(join(tmpdir(), "pi-better-skills-discovery-"));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
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
	const { pi, emit } = makeFakePi(root, trusted);
	(extension as (pi: unknown) => void)(pi);
	await emit("session_start", {});
	return {
		root,
		emit,
		readEvent: (skillPath: string, body: string): ToolResultEvent => ({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "read",
			input: { path: skillPath },
			content: [{ type: "text", text: body }],
			isError: false,
		}),
		cleanup: () => {
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

const SKILL = (name: string) => `---
name: ${name}
description: Discovery test skill
---

${name} body marker.
`;

describe("cliSkillPaths", () => {
	it("collects --skill <path> and --skill=<path> forms", () => {
		expect(
			cliSkillPaths(["pi", "-p", "--skill", "/tmp/a", "--skill=/tmp/b", "--skill", "~/c", "prompt"]),
		).toEqual(["/tmp/a", "/tmp/b", join(homedir(), "c")]);
	});

	it("returns empty when no --skill flags are present", () => {
		expect(cliSkillPaths(["pi", "-p", "hello"])).toEqual([]);
	});
});

describe("bootstrap discovery via pi public APIs", () => {
	it("discovers project .pi/skills through the canonical resolution", async () => {
		const project = await setupProject({ ".pi/skills/probe/SKILL.md": SKILL("probe") });
		try {
			const skillPath = join(project.root, ".pi/skills/probe/SKILL.md");
			const result = await project.emit("tool_result", project.readEvent(skillPath, SKILL("probe")));
			const blocks = (result as { content?: TextBlock[] } | undefined)?.content ?? [];
			expect(blocks[0]?.text).toContain("<skill_context>");
		} finally {
			project.cleanup();
		}
	});

	it("discovers project .agents/skills when trusted", async () => {
		const project = await setupProject({ ".agents/skills/agents-probe/SKILL.md": SKILL("agents-probe") });
		try {
			const skillPath = join(project.root, ".agents/skills/agents-probe/SKILL.md");
			const result = await project.emit("tool_result", project.readEvent(skillPath, SKILL("agents-probe")));
			const blocks = (result as { content?: TextBlock[] } | undefined)?.content ?? [];
			expect(blocks[0]?.text).toContain("<skill_context>");
		} finally {
			project.cleanup();
		}
	});

	it("discovers a settings skills array entry from project settings", async () => {
		const project = await setupProject({
			".pi/settings.json": JSON.stringify({ skills: ["extra-skills"] }),
			"extra-skills/settings-probe/SKILL.md": SKILL("settings-probe"),
		});
		try {
			const skillPath = join(project.root, "extra-skills/settings-probe/SKILL.md");
			const result = await project.emit("tool_result", project.readEvent(skillPath, SKILL("settings-probe")));
			const blocks = (result as { content?: TextBlock[] } | undefined)?.content ?? [];
			expect(blocks[0]?.text).toContain("<skill_context>");
		} finally {
			project.cleanup();
		}
	});

	it("keeps project skills out of the catalog until the project is trusted", async () => {
		const project = await setupProject(
			{
				".pi/skills/probe/SKILL.md": `---
name: probe
description: Discovery test skill
globs: ["**/*.probe"]
---

probe body marker.
`,
				"src/thing.probe": "content",
			},
			false,
		);
		try {
			// A glob-matching file read must not inject the untrusted skill body.
			const result = await project.emit("tool_result", {
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: join(project.root, "src/thing.probe") },
				content: [{ type: "text", text: "content" }],
				isError: false,
			});
			const blocks = (result as { content?: TextBlock[] } | undefined)?.content ?? [];
			expect(blocks[0]?.text ?? "content").not.toContain("probe body marker");
		} finally {
			project.cleanup();
		}
	});
});

describe("resultConfirmsSkillBody", () => {
	const body = "# Title\n\nFirst paragraph with plenty of text to span the hundred-character prefix window used for confirmation.";

	it("confirms when the result contains the body (cat/head style output)", () => {
		expect(resultConfirmsSkillBody(`whatever\n\n${body}\ntrailer`, body)).toBe(true);
		// Partial reads confirm when they cover the 80-char prefix.
		expect(resultConfirmsSkillBody(body.slice(0, 90), body)).toBe(true);
		expect(resultConfirmsSkillBody("# Title", body)).toBe(false);
	});

	it("rejects metadata-only or path-echoing results", () => {
		expect(resultConfirmsSkillBody("stat: /skills/x/SKILL.md 1204 bytes", body)).toBe(false);
		expect(resultConfirmsSkillBody("echo /skills/x/SKILL.md", body)).toBe(false);
		expect(resultConfirmsSkillBody("", body)).toBe(false);
	});
});
