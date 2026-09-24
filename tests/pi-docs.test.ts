import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piDocsSkillFilePath, registerPiDocsRequestStrip, stripPiDocsBlock } from "../src/pi-docs";

/** Mirrors pi core's built-in block (dist/core/system-prompt.js) — independent source of truth. */
const REAL_BLOCK = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/pi-coding-agent/README.md
- Additional docs: /opt/pi/pi-coding-agent/docs
- Examples: /opt/pi/pi-coding-agent/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

/** A legitimately evolved block, as a pi update would produce; a second instance may capture it. */
const EVOLVED_BLOCK = `${REAL_BLOCK.replace("- When working on pi topics", "- When building anything pi-related")}\n- Brand new bullet about docs/widgets.md`;

function promptWithBlock(block: string): string {
	return `You are an expert coding assistant operating inside pi.\n\nGuidelines:\n- Be concise in your responses\n\n${block}\n\nCurrent working directory: /tmp`;
}

/** pi >= 0.87 renders the prompt as <name>-tagged sections joined by blank lines (dist/core/system-prompt.js). */
function promptWithDocsSection(block: string): string {
	return `<rules>\n- Be concise in your responses\n</rules>\n\n<docs>\n${block}\n</docs>\n\n<project_context>\nUse tools per repo rules.\n</project_context>`;
}

function tempAgentDir(prefix: string): { agentDir: string; cleanup: () => void } {
	const agentDir = mkdtempSync(join(tmpdir(), prefix));
	return { agentDir, cleanup: () => rmSync(agentDir, { recursive: true, force: true }) };
}

describe("stripPiDocsBlock", () => {
	it("returns undefined when the prompt has no pi-docs block", () => {
		expect(stripPiDocsBlock("Guidelines:\n- Be concise\n\nCurrent working directory: /tmp")).toBeUndefined();
	});

	it("strips the block and returns it captured", () => {
		const result = stripPiDocsBlock(promptWithBlock(REAL_BLOCK));
		expect(result).toBeDefined();
		expect(result!.block).toBe(REAL_BLOCK);
		expect(result!.prompt).not.toContain("Pi documentation (read only");
		expect(result!.prompt).toContain("Guidelines:");
		expect(result!.prompt).toContain("Current working directory: /tmp");
	});
});

describe("stripPiDocsBlock drift tolerance", () => {
	it("still strips when pi rewords bullets or appends new ones", () => {
		const evolved = REAL_BLOCK
			.replace("- When working on pi topics", "- When building anything pi-related")
			+ "\n- Brand new bullet about docs/widgets.md and its cross-references";
		const result = stripPiDocsBlock(promptWithBlock(evolved));
		expect(result).toBeDefined();
		expect(result!.block).toBe(evolved);
		expect(result!.prompt).not.toContain("Pi documentation (read only");
	});

	it("fails open when the header line is renamed", () => {
		const renamed = REAL_BLOCK.replace(
			"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
			"Pi manual (consult for pi internals):",
		);
		expect(stripPiDocsBlock(promptWithBlock(renamed))).toBeUndefined();
	});

	it("fails open when the first bullet label changes", () => {
		const reordered = REAL_BLOCK.replace("- Main documentation: ", "- Primary manual: ");
		expect(stripPiDocsBlock(promptWithBlock(reordered))).toBeUndefined();
	});

	it("fails open when the anchored header has no following line", () => {
		const header = REAL_BLOCK.slice(0, REAL_BLOCK.indexOf("\n"));
		expect(stripPiDocsBlock(`\n\n${header}`)).toBeUndefined();
	});

	it("accepts a single first bullet when the block ends at the prompt boundary", () => {
		const firstBullet = REAL_BLOCK.split("\n").slice(0, 2).join("\n");
		const result = stripPiDocsBlock(`\n\n${firstBullet}`);
		expect(result?.block).toBe(firstBullet);
	});

	it("strips a block whose anchor starts at offset zero", () => {
		const result = stripPiDocsBlock(`\n\n${REAL_BLOCK}\nTail`);
		expect(result).toEqual({ prompt: "\n\nTail", block: REAL_BLOCK });
	});

	it("preserves newlines inside the first non-bullet tail line", () => {
		const result = stripPiDocsBlock(`prefix\n\n${REAL_BLOCK}\nTail\nMore`);
		expect(result).toEqual({ prompt: "prefix\n\nTail\nMore", block: REAL_BLOCK });
	});

	it("accepts an optional blank line after the header", () => {
		const withGap = REAL_BLOCK.replace(
			"):\n- Main documentation:",
			"):\n\n- Main documentation:",
		);
		const result = stripPiDocsBlock(promptWithBlock(withGap));
		expect(result?.block).toBe(withGap);
		expect(result?.prompt).toBe("You are an expert coding assistant operating inside pi.\n\nGuidelines:\n- Be concise in your responses\n\nCurrent working directory: /tmp");
	});

	it("fails open when the bullet run exceeds its safety bound", () => {
		const tooManyBullets = `${REAL_BLOCK}\n${Array.from({ length: 26 }, (_, index) => `- Extra bullet ${index}`).join("\n")}`;
		expect(stripPiDocsBlock(promptWithBlock(tooManyBullets))).toBeUndefined();
	});
});

describe("renderPiDocsSkillMd", () => {
	it("wraps the captured block in valid frontmatter with the inherited body", async () => {
		const { renderPiDocsSkillMd, PI_DOCS_SKILL_NAME } = await import("../src/pi-docs");
		const md = renderPiDocsSkillMd(REAL_BLOCK);
		expect(md.startsWith("---\n")).toBe(true);
		expect(md).toContain(`name: ${PI_DOCS_SKILL_NAME}`);
		const description = md.match(/description: (.+)/)?.[1];
		expect(description).toBeDefined();
		expect(description!).toMatch(/[Pp]i/);
		expect(description!).not.toContain(": "); // plain YAML scalar, no nested colons
		expect(md).toContain(`# Pi documentation`);
		expect(md).toContain(REAL_BLOCK);
		expect(md.endsWith("\n")).toBe(true);
	});
});

describe("syncPiDocsSkillFile", () => {
	it("writes the skill on first call, then skips identical content, then updates on change", async () => {
		const { syncPiDocsSkillFile, piDocsSkillDirPath } = await import("../src/pi-docs");
		const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-sync-"));
		try {
			const first = syncPiDocsSkillFile(agentDir, REAL_BLOCK);
			const path = join(piDocsSkillDirPath(agentDir), "SKILL.md");
			expect(first.written).toBe(true);
			expect(first.path).toBe(path);
			expect(readFileSync(path, "utf8")).toContain(REAL_BLOCK);

			expect(syncPiDocsSkillFile(agentDir, REAL_BLOCK).written).toBe(false);

			const evolved = `${REAL_BLOCK}\n- New bullet appended by a pi update`;
			const third = syncPiDocsSkillFile(agentDir, evolved);
			expect(third.written).toBe(true);
			expect(readFileSync(path, "utf8")).toContain("New bullet appended by a pi update");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("pi >= 0.87 section-wrapped prompts", () => {
	it("captures the block and removes the whole <docs> section, re-joining neighbors", () => {
		const result = stripPiDocsBlock(promptWithDocsSection(REAL_BLOCK));
		expect(result).toBeDefined();
		expect(result!.block).toBe(REAL_BLOCK);
		expect(result!.prompt).toBe(
			"<rules>\n- Be concise in your responses\n</rules>\n\n<project_context>\nUse tools per repo rules.\n</project_context>",
		);
	});

	it("removes the preceding blank line when <docs> is the final section", () => {
		const prompt = `<rules>\n- Be concise\n</rules>\n\n<docs>\n${REAL_BLOCK}\n</docs>`;
		const result = stripPiDocsBlock(prompt);
		expect(result?.block).toBe(REAL_BLOCK);
		expect(result?.prompt).toBe("<rules>\n- Be concise\n</rules>");
	});

	it("fails open when the close tag does not directly follow the bullet run", () => {
		const drifted = promptWithDocsSection(REAL_BLOCK).replace("</docs>", "\n</docs>");
		expect(stripPiDocsBlock(drifted)).toBeUndefined();
	});

	it("still strips when pi rewords or appends bullets inside the section", () => {
		const evolved = REAL_BLOCK.replace("- When working on pi topics", "- When building pi things") +
			"\n- New bullet about docs/widgets.md and its cross-references";
		const result = stripPiDocsBlock(promptWithDocsSection(evolved));
		expect(result?.block).toBe(evolved);
		expect(result?.prompt).not.toContain("<docs>");
	});
});

describe("piDocsSkillFilePath", () => {
	it("returns the generated SKILL.md path beneath the private cache", async () => {
		const { piDocsSkillFilePath } = await import("../src/pi-docs");
		const agentDir = "/tmp/pi-docs-path-agent";
		expect(piDocsSkillFilePath(agentDir)).toBe(`${agentDir}/cache/pi-better-skills/pi-docs/SKILL.md`);
	});
});

describe("piDocsFeatureEnabled", () => {
	it("is on by default and opts out via PI_BETTER_SKILLS_NO_PI_DOCS", async () => {
		const { piDocsFeatureEnabled } = await import("../src/pi-docs");
		expect(piDocsFeatureEnabled({})).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "0" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "false" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "NO" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "OFF" })).toBe(true);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "1" })).toBe(false);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "TRUE" })).toBe(false);
		expect(piDocsFeatureEnabled({ PI_BETTER_SKILLS_NO_PI_DOCS: "yes" })).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Registration seam: one registerPiDocsRequestStrip call per extension instance
// returns the discover callback the extension's resources_discover handler uses.
// ---------------------------------------------------------------------------

type FakeCommand = { name: string; source: string; sourceInfo?: { path: string } };

/**
 * One extension instance's wiring, at the same seam the extension factory uses:
 * registerPiDocsRequestStrip(pi, agentDir) -> discover callback + request handler.
 */
function registeredStripFixture(agentDir: string) {
	const contextHandlers: Array<(...args: unknown[]) => unknown> = [];
	let loaded: FakeCommand[] = [];
	const discover = registerPiDocsRequestStrip(
		{
			on(event: string, handler: (...args: unknown[]) => unknown) {
				if (event === "context_with_system") contextHandlers.push(handler);
				return () => {};
			},
			getCommands: () => loaded,
		} as never,
		agentDir,
	);
	return {
		discover,
		/** Fire the context_with_system handler the registration installed. */
		strippedRequest: async (messages: unknown) =>
			(await contextHandlers[0]?.({ type: "context_with_system", messages }, {})) as
				| { messages: unknown[] }
				| undefined,
		load: () => {
			loaded = [{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: piDocsSkillFilePath(agentDir) } }];
		},
		setLoaded: (commands: FakeCommand[]) => {
			loaded = commands;
		},
	};
}

describe("registerPiDocsRequestStrip discover callback", () => {
	it("registers and syncs only when the feature is on and the block is present", async () => {
		const { piDocsSkillDirPath } = await import("../src/pi-docs");
		const { existsSync } = await import("node:fs");
		const { agentDir, cleanup } = tempAgentDir("pi-docs-discover-");
		try {
			const fixture = registeredStripFixture(agentDir);
			const withBlock = fixture.discover(promptWithBlock(REAL_BLOCK));
			expect(withBlock?.skillPaths).toEqual([piDocsSkillDirPath(agentDir)]);
			expect(existsSync(join(withBlock!.skillPaths[0], "SKILL.md"))).toBe(true);

			// No block: no registration, and the strip is disarmed for this instance.
			expect(fixture.discover("no block here")).toBeUndefined();

			const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
			try {
				expect(fixture.discover(promptWithBlock(REAL_BLOCK))).toBeUndefined();
			} finally {
				if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
				else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
			}
		} finally {
			cleanup();
		}
	});

	it("emits precise debug diagnostics for success, sync failure, and anchor rejection", async () => {
		const { piDocsSkillDirPath } = await import("../src/pi-docs");
		const { writeFileSync } = await import("node:fs");
		const { agentDir, cleanup } = tempAgentDir("pi-docs-reg-debug-");
		const occupied = join(agentDir, "occupied");
		writeFileSync(occupied, "not a directory", "utf8");
		const savedDebug = process.env.PI_BETTER_SKILLS_DEBUG;
		const savedError = console.error;
		const diagnostics: string[] = [];
		try {
			process.env.PI_BETTER_SKILLS_DEBUG = "1";
			console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));

			const fixture = registeredStripFixture(agentDir);
			expect(fixture.discover(promptWithBlock(REAL_BLOCK))).toBeDefined();
			expect(diagnostics).toEqual([
				`[pi-better-skills:pi-docs] registered pi-docs skill {"path":"${piDocsSkillDirPath(agentDir)}"}`,
			]);

			diagnostics.length = 0;
			// The occupied file IS the agentDir, so the skill sync's mkdir fails.
			const blocked = registeredStripFixture(occupied);
			expect(blocked.discover(promptWithBlock(REAL_BLOCK))).toBeUndefined();
			expect(diagnostics).toEqual([
				`[pi-better-skills:pi-docs] skill sync failed, staying stock {"agentDir":"${occupied}"}`,
			]);

			diagnostics.length = 0;
			expect(fixture.discover("no block here")).toBeUndefined();
			expect(diagnostics).toEqual([]);
		} finally {
			console.error = savedError;
			if (savedDebug === undefined) delete process.env.PI_BETTER_SKILLS_DEBUG;
			else process.env.PI_BETTER_SKILLS_DEBUG = savedDebug;
			cleanup();
		}
	});

	it("fails open on unwritable agentDir", async () => {
		const { chmodSync } = await import("node:fs");
		const { agentDir, cleanup } = tempAgentDir("pi-docs-ro-");
		try {
			chmodSync(agentDir, 0o500);
			expect(registeredStripFixture(agentDir).discover(promptWithBlock(REAL_BLOCK))).toBeUndefined();
		} finally {
			chmodSync(agentDir, 0o700);
			cleanup();
		}
	});

	it("honors --no-skills from the passed argv", async () => {
		const { agentDir, cleanup } = tempAgentDir("pi-docs-ns-");
		try {
			const fixture = registeredStripFixture(agentDir);
			expect(fixture.discover(promptWithBlock(REAL_BLOCK), ["pi", "--no-skills", "-p", "hi"])).toBeUndefined();
			expect(fixture.discover(promptWithBlock(REAL_BLOCK), ["pi", "-ns"])).toBeUndefined();
			expect(fixture.discover(promptWithBlock(REAL_BLOCK), ["pi", "--", "--no-skills"])).toBeDefined();
		} finally {
			cleanup();
		}
	});
});

describe("pi-docs gate integrity (review findings)", () => {
	it("real layout strips: no blank line before Current working directory", async () => {
		const { stripPiDocsBlock } = await import("../src/pi-docs");
		const realLayout = `Guidelines:\n- Be concise\n\n${REAL_BLOCK}\nCurrent working directory: /tmp`;
		const result = stripPiDocsBlock(realLayout);
		expect(result).toBeDefined();
		expect(result!.block).toBe(REAL_BLOCK);
		expect(result!.prompt).toBe("Guidelines:\n- Be concise\n\nCurrent working directory: /tmp");
	});

	it("returns undefined when the prompt starts with the block (no \\n\\n anchor)", async () => {
		const { stripPiDocsBlock } = await import("../src/pi-docs");
		expect(stripPiDocsBlock(`${REAL_BLOCK}\n\nNext section`)).toBeUndefined();
	});
});

describe("hasLoadedPiDocsCommand (authoritative getCommands projection)", () => {
	it("accepts only our exact skill name, source kind, and SKILL.md path", async () => {
		const { hasLoadedPiDocsCommand } = await import("../src/pi-docs");
		const agentDir = "/tmp/pi-docs-cmd-agent";
		const ourPath = piDocsSkillFilePath(agentDir);
		const loadedAtOurPath = [{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: ourPath } }];
		expect(hasLoadedPiDocsCommand(loadedAtOurPath, agentDir)).toBe(true);

		// Name-only or path-only matches are not enough; a user's own pi-docs
		// winning the first-wins collision stands us down.
		expect(hasLoadedPiDocsCommand([{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: "/home/x/.pi/agent/skills/pi-docs/SKILL.md" } }], agentDir)).toBe(false);
		expect(hasLoadedPiDocsCommand([{ name: "skill:other", source: "skill", sourceInfo: { path: ourPath } }], agentDir)).toBe(false);
		expect(hasLoadedPiDocsCommand([{ name: "skill:pi-docs", source: "extension", sourceInfo: { path: ourPath } }], agentDir)).toBe(false);
		expect(hasLoadedPiDocsCommand([{ name: "skill:pi-docs", source: "skill" }], agentDir)).toBe(false);

		// Equivalent paths resolve to the same SKILL.md (relative agentDir spellings).
		expect(hasLoadedPiDocsCommand([{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: `${agentDir}/cache/../cache/pi-better-skills/pi-docs/SKILL.md` } }], agentDir)).toBe(true);
	});
});

/** The toolsAdded payload only rides along; its shape is irrelevant to the strip. */
function toolDeclaration(): Record<string, unknown> {
	return { name: "read", description: "Read file contents", parameters: { type: "object" } };
}

function sectionedDocsMessage(block: string): Record<string, unknown> {
	return {
		role: "system",
		content: "",
		sections: { preamble: "You are pi.", docs: `<docs>\n${block}\n</docs>`, cwd: "/tmp" },
		toolsAdded: [toolDeclaration()],
		toolsRemoved: [{ name: "grep", description: "old", parameters: {} }],
		timestamp: 1,
	};
}

describe("stripPiDocsFromRequestMessages", () => {
	it("drops only the docs section and preserves every other system-message field", async () => {
		const { stripPiDocsFromRequestMessages } = await import("../src/pi-docs");
		const request = [
			sectionedDocsMessage(REAL_BLOCK),
			{ role: "user", content: "hello", timestamp: 2 },
		];
		const stripped = stripPiDocsFromRequestMessages(request as never, REAL_BLOCK);
		expect(stripped).toBeDefined();
		expect(stripped).toHaveLength(2);
		// Non-system messages pass through unchanged.
		expect(stripped![1]).toEqual(request[1]);
		const head = stripped![0] as { sections: Record<string, string>; toolsAdded: unknown[]; toolsRemoved: unknown[]; timestamp: number };
		expect(head.sections).toEqual({ preamble: "You are pi.", cwd: "/tmp" });
		expect(head.toolsAdded).toEqual([toolDeclaration()]);
		expect(head.toolsRemoved).toEqual([{ name: "grep", description: "old", parameters: {} }]);
		expect(head.timestamp).toBe(1);
	});

	it("excises the captured block from flat system content without touching neighbors", async () => {
		const { stripPiDocsFromRequestMessages } = await import("../src/pi-docs");
		const head = {
			role: "system",
			content: `Guidelines:\n- Be concise\n\n${REAL_BLOCK}\nCurrent working directory: /tmp`,
			timestamp: 1,
		};
		const stripped = stripPiDocsFromRequestMessages([head, { role: "assistant", content: "ok" }] as never, REAL_BLOCK);
		expect((stripped![0] as { content: string }).content).toBe("Guidelines:\n- Be concise\n\nCurrent working directory: /tmp");
	});

	it("preserves neighbors at every flat position (start, middle, end)", async () => {
		const { stripPiDocsFromRequestMessages } = await import("../src/pi-docs");
		const strip = (content: string) =>
			(stripPiDocsFromRequestMessages([{ role: "system", content, timestamp: 1 }] as never, REAL_BLOCK)! [0] as { content: string }).content;
		// Block at the very end: no trailing separator left behind.
		expect(strip(`Guidelines: active\n\n${REAL_BLOCK}`)).toBe("Guidelines: active");
		// Block at the start: the join to the next section survives.
		expect(strip(`\n\n${REAL_BLOCK}\nTail`)).toBe("\n\nTail");
		// Block glued to following text: the text survives intact.
		expect(strip(`prefix\n\n${REAL_BLOCK}Tail\nMore`)).toBe("prefix\n\nTail\nMore");
		// Redundant blank lines after the block collapse to one join.
		expect(strip(`prefix\n\n${REAL_BLOCK}\n\n\nTail`)).toBe("prefix\n\nTail");
	});

	it("cleans a mid-conversation docs patch while other section updates survive", async () => {
		const { stripPiDocsFromRequestMessages } = await import("../src/pi-docs");
		const patch = {
			role: "system",
			content: "",
			sections: { docs: `<docs>\n${REAL_BLOCK}\n</docs>`, rules: "- New rule" },
			timestamp: 2,
		};
		const stripped = stripPiDocsFromRequestMessages([{ role: "user", content: "hi", timestamp: 1 }, patch] as never, REAL_BLOCK);
		expect(stripped).toBeDefined();
		expect((stripped![1] as { sections: Record<string, string | null> }).sections).toEqual({ rules: "- New rule", docs: null });
		// A removal marker (null) is not ours to touch.
		const removal = { role: "system", content: "", sections: { docs: null }, timestamp: 3 };
		expect(stripPiDocsFromRequestMessages([removal] as never, REAL_BLOCK)).toBeUndefined();
	});

	it("returns undefined when no system message carries the exact captured block", async () => {
		const { stripPiDocsFromRequestMessages } = await import("../src/pi-docs");
		const drifted = sectionedDocsMessage(REAL_BLOCK) as { sections: Record<string, string> };
		drifted.sections.docs = "<docs>\nSome other extension's docs\n</docs>";
		const request = [drifted, { role: "user", content: "hello", timestamp: 2 }];
		expect(stripPiDocsFromRequestMessages(request as never, REAL_BLOCK)).toBeUndefined();

		// A docs section that merely CONTAINS the block plus extra text is not ours to remove.
		const superset = sectionedDocsMessage(REAL_BLOCK) as { sections: Record<string, string> };
		superset.sections.docs = `<docs>\n${REAL_BLOCK}\n- extra\n</docs>`;
		expect(stripPiDocsFromRequestMessages([superset] as never, REAL_BLOCK)).toBeUndefined();
	});
});

describe("applyPiDocsRequestStrip (per-request gate)", () => {
	it("strips only when the feature is on, the block is captured, and our skill is loaded", async () => {
		const { applyPiDocsRequestStrip } = await import("../src/pi-docs");
		const request = [sectionedDocsMessage(REAL_BLOCK), { role: "user", content: "hi", timestamp: 2 }];
		const agentDir = "/tmp/pi-docs-req-strip-agent";
		const loadedAtOurPath = [{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: piDocsSkillFilePath(agentDir) } }];
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		try {
			// No captured block: stand down even with the skill "loaded".
			expect(applyPiDocsRequestStrip(request as never, undefined, loadedAtOurPath, agentDir)).toBeUndefined();

			const stripped = applyPiDocsRequestStrip(request as never, REAL_BLOCK, loadedAtOurPath, agentDir);
			expect((stripped![0] as { sections: Record<string, string> }).sections).toEqual({ preamble: "You are pi.", cwd: "/tmp" });

			// Loaded-set missing or collided: stand down.
			expect(applyPiDocsRequestStrip(request as never, REAL_BLOCK, [], agentDir)).toBeUndefined();
			expect(
				applyPiDocsRequestStrip(request as never, REAL_BLOCK, [{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: "/home/x/.pi/agent/skills/pi-docs/SKILL.md" } }], agentDir),
			).toBeUndefined();

			// Env opt-out beats everything.
			process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
			expect(applyPiDocsRequestStrip(request as never, REAL_BLOCK, loadedAtOurPath, agentDir)).toBeUndefined();
		} finally {
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});
});

describe("registerPiDocsRequestStrip", () => {
	it("consults the live command projection on every request, so a later collision stands down", async () => {
		const { stripPiDocsFromRequestMessages } = await import("../src/pi-docs");
		const { agentDir, cleanup } = tempAgentDir("pi-docs-reg-strip-");
		try {
			const fixture = registeredStripFixture(agentDir);
			const request = [sectionedDocsMessage(REAL_BLOCK), { role: "user", content: "hi", timestamp: 2 }];

			// Not loaded: handler keeps the messages untouched.
			fixture.discover(promptWithBlock(REAL_BLOCK));
			expect(await fixture.strippedRequest(request)).toBeUndefined();

			// Loaded at our path: handler returns the stripped messages.
			fixture.load();
			const result = await fixture.strippedRequest(request);
			expect(result?.messages).toEqual(stripPiDocsFromRequestMessages(request as never, REAL_BLOCK));
			expect((result!.messages[0] as { sections: Record<string, string> }).sections).not.toHaveProperty("docs");

			// The projection is consulted per request, so a mid-session collision
			// (user's pi-docs wins) flips the handler back to stock without re-registration.
			fixture.setLoaded([{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: "/home/x/.pi/agent/skills/pi-docs/SKILL.md" } }]);
			expect(await fixture.strippedRequest(request)).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	it("a drifted re-discovery disarms this instance even while the skill stays loaded", async () => {
		const { agentDir, cleanup } = tempAgentDir("pi-docs-stale-");
		try {
			const fixture = registeredStripFixture(agentDir);
			const request = [sectionedDocsMessage(REAL_BLOCK)];
			fixture.discover(promptWithBlock(REAL_BLOCK));
			fixture.load();
			expect((await fixture.strippedRequest(request))?.messages).toBeDefined();

			// Next discovery pass drifts: this instance's capture clears, the strip
			// stands down even though the registered skill is still in the loaded set.
			expect(fixture.discover("Guidelines only, no block")).toBeUndefined();
			expect(await fixture.strippedRequest(request)).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("registerPiDocsRequestStrip capture isolation (per extension instance)", () => {
	it("one instance's drifted discovery cannot disarm another instance's capture", async () => {
		const first = tempAgentDir("pi-docs-iso-a-");
		const second = tempAgentDir("pi-docs-iso-b-");
		try {
			const instanceA = registeredStripFixture(first.agentDir);
			const instanceB = registeredStripFixture(second.agentDir);
			const request = [sectionedDocsMessage(REAL_BLOCK)];

			instanceA.discover(promptWithBlock(REAL_BLOCK));
			instanceA.load();
			// Sibling instance discovers a drifted prompt (or opts out, or fails its
			// sync): only ITS OWN capture state may change.
			expect(instanceB.discover("Guidelines only, no block")).toBeUndefined();

			expect((await instanceA.strippedRequest(request))?.messages).toBeDefined();
		} finally {
			first.cleanup();
			second.cleanup();
		}
	});

	it("simultaneous instances strip with their own captured blocks and agent dirs", async () => {
		const first = tempAgentDir("pi-docs-iso-c-");
		const second = tempAgentDir("pi-docs-iso-d-");
		try {
			const instanceA = registeredStripFixture(first.agentDir);
			const instanceB = registeredStripFixture(second.agentDir);
			instanceA.discover(promptWithBlock(REAL_BLOCK));
			instanceB.discover(promptWithBlock(EVOLVED_BLOCK));
			instanceA.load();
			instanceB.load();

			const withRealBlock = [sectionedDocsMessage(REAL_BLOCK)];
			const withEvolvedBlock = [sectionedDocsMessage(EVOLVED_BLOCK)];

			// Each instance removes exactly its own captured block.
			expect(
				((await instanceA.strippedRequest(withRealBlock))!.messages[0] as { sections: Record<string, string> }).sections,
			).toEqual({ preamble: "You are pi.", cwd: "/tmp" });
			expect(
				((await instanceB.strippedRequest(withEvolvedBlock))!.messages[0] as { sections: Record<string, string> }).sections,
			).toEqual({ preamble: "You are pi.", cwd: "/tmp" });

			// A's strip does not fire on a request carrying B's block (exact match only).
			expect(await instanceA.strippedRequest(withEvolvedBlock)).toBeUndefined();
			expect(await instanceB.strippedRequest(withRealBlock)).toBeUndefined();
		} finally {
			first.cleanup();
			second.cleanup();
		}
	});
});

describe("pi-docs extension wiring (src/index.ts)", () => {
	it("factory wires discovery through the returned callback; the per-request strip owns docs removal", async () => {
		const { default: registerExtension } = await import("../src/index");
		const { piDocsSkillDirPath } = await import("../src/pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		let loaded: Array<{ name: string; source: string; sourceInfo: { path: string } }> = [];
		const extension = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
				return () => {};
			},
			registerMessageRenderer() {},
			getCommands: () => loaded,
		};
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-wiring-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-docs-wiring-cwd-"));
		const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		const context = {
			cwd,
			isProjectTrusted: () => false,
			getSystemPrompt: () => promptWithDocsSection(REAL_BLOCK),
		};
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			registerExtension(extension as never);

			// The factory registered the per-request strip at construction time and
			// routes resources_discover through its returned discover callback.
			const discoverHandler = handlers.get("resources_discover")?.[0];
			expect(discoverHandler).toBeDefined();
			expect(handlers.get("context_with_system")?.[0]).toBeDefined();

			const registration = await discoverHandler?.({}, context);
			expect(registration).toEqual({ skillPaths: [piDocsSkillDirPath(agentDir)] });

			loaded = [{ name: "skill:pi-docs", source: "skill", sourceInfo: { path: piDocsSkillFilePath(agentDir) } }];
			const stripHandler = handlers.get("context_with_system")![0];
			const request = [
				{ role: "system", content: "", sections: { docs: `<docs>\n${REAL_BLOCK}\n</docs>`, cwd: "/tmp" }, timestamp: 1 },
				{ role: "user", content: "hi", timestamp: 2 },
			];
			const result = (await stripHandler({ type: "context_with_system", messages: request }, context)) as
				| { messages: Array<Record<string, unknown>> }
				| undefined;
			expect(result?.messages?.[0]?.sections).toEqual({ cwd: "/tmp" });

			// A drifted re-discovery through the same handler disarms the strip.
			await discoverHandler?.({}, { ...context, getSystemPrompt: () => "Guidelines only, no block" });
			expect(await stripHandler({ type: "context_with_system", messages: request }, context)).toBeUndefined();
		} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
