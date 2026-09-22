import { describe, it, expect } from "bun:test";
import { stripPiDocsBlock } from "../pi-docs";

/** Mirrors pi core's built-in block (dist/core/system-prompt.js) — independent source of truth. */
const REAL_BLOCK = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /opt/pi/pi-coding-agent/README.md
- Additional docs: /opt/pi/pi-coding-agent/docs
- Examples: /opt/pi/pi-coding-agent/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

function promptWithBlock(block: string): string {
	return `You are an expert coding assistant operating inside pi.\n\nGuidelines:\n- Be concise in your responses\n\n${block}\n\nCurrent working directory: /tmp`;
}

/** pi >= 0.87 renders the prompt as <name>-tagged sections joined by blank lines (dist/core/system-prompt.js). */
function promptWithDocsSection(block: string): string {
	return `<rules>\n- Be concise in your responses\n</rules>\n\n<docs>\n${block}\n</docs>\n\n<project_context>\nUse tools per repo rules.\n</project_context>`;
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
		const { renderPiDocsSkillMd, PI_DOCS_SKILL_NAME } = await import("../pi-docs");
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
		const { syncPiDocsSkillFile, piDocsSkillDirPath } = await import("../pi-docs");
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

	it("registration and before_agent_start strip remove the section end-to-end", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-sec-e2e-"));
		try {
			const stock = promptWithDocsSection(REAL_BLOCK);
			expect(piDocsSkillRegistration(stock, agentDir)).toBeDefined();
			const loaded = [{ name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) }];
			const stripped = applyPiDocsStrip(stock, { skills: loaded }, agentDir);
			expect(stripped).toBeDefined();
			expect(stripped!).not.toContain("<docs>");
			expect(stripped!).not.toContain("Pi documentation (read only");
			expect(stripped!).toContain("<project_context>");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("extension wiring registers the skill and strips the section through both handlers", async () => {
		const { default: registerExtension } = await import("../index");
		const { piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const extension = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
			registerMessageRenderer() {},
		};
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-wiring-sec-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-docs-wiring-sec-cwd-"));
		const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		const stock = promptWithDocsSection(REAL_BLOCK);
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			registerExtension(extension as never);
			const context = {
				cwd,
				isProjectTrusted: () => false,
				getSystemPrompt: () => stock,
			};
			const registration = await handlers.get("resources_discover")?.({}, context);
			expect(registration).toEqual({ skillPaths: [join(agentDir, "cache", "pi-better-skills", "pi-docs")] });
			const result = await handlers.get("before_agent_start")?.(
				{
					systemPrompt: stock,
					systemPromptOptions: { skills: [{ name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) }] },
				},
				context,
			);
			const strippedPrompt = (result as { systemPrompt: string }).systemPrompt;
			expect(strippedPrompt).not.toContain("<docs>");
			expect(strippedPrompt).not.toContain("Pi documentation (read only");
			expect(strippedPrompt).toContain("<agent_skills>");
		} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("piDocsSkillFilePath", () => {
	it("returns the generated SKILL.md path beneath the private cache", async () => {
		const { piDocsSkillFilePath } = await import("../pi-docs");
		const agentDir = "/tmp/pi-docs-path-agent";
		expect(piDocsSkillFilePath(agentDir)).toBe(`${agentDir}/cache/pi-better-skills/pi-docs/SKILL.md`);
	});
});

describe("piDocsFeatureEnabled", () => {
	it("is on by default and opts out via PI_BETTER_SKILLS_NO_PI_DOCS", async () => {
		const { piDocsFeatureEnabled } = await import("../pi-docs");
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

describe("piDocsSkillRegistration", () => {
	it("registers and syncs only when the feature is on and the block is present", async () => {
		const { piDocsSkillRegistration } = await import("../pi-docs");
		const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-reg-"));
		try {
			const withBlock = piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir);
			expect(withBlock?.skillPaths).toEqual([join(agentDir, "cache", "pi-better-skills", "pi-docs")]);
			expect(existsSync(join(withBlock!.skillPaths[0], "SKILL.md"))).toBe(true);

			expect(piDocsSkillRegistration("no block here", agentDir)).toBeUndefined();

			const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
			try {
				expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeUndefined();
			} finally {
				if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
				else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("emits precise debug diagnostics for success, sync failure, and anchor rejection", async () => {
		const { piDocsSkillRegistration, piDocsSkillDirPath } = await import("../pi-docs");
		const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-reg-debug-"));
		const occupied = join(agentDir, "occupied");
		writeFileSync(occupied, "not a directory", "utf8");
		const savedDebug = process.env.PI_BETTER_SKILLS_DEBUG;
		const savedError = console.error;
		const diagnostics: string[] = [];
		try {
			process.env.PI_BETTER_SKILLS_DEBUG = "1";
			console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));

			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeDefined();
			expect(diagnostics).toEqual([
				`[pi-better-skills:pi-docs] registered pi-docs skill {"path":"${piDocsSkillDirPath(agentDir)}"}`,
			]);

			diagnostics.length = 0;
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), occupied)).toBeUndefined();
			expect(diagnostics).toEqual([
				`[pi-better-skills:pi-docs] skill sync failed, staying stock {"agentDir":"${occupied}"}`,
			]);

			diagnostics.length = 0;
			expect(piDocsSkillRegistration("no block here", agentDir)).toBeUndefined();
			expect(diagnostics).toEqual([]);
		} finally {
			console.error = savedError;
			if (savedDebug === undefined) delete process.env.PI_BETTER_SKILLS_DEBUG;
			else process.env.PI_BETTER_SKILLS_DEBUG = savedDebug;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("pi-docs gate integrity (review findings)", () => {
	it("real layout strips: no blank line before Current working directory", async () => {
		const { stripPiDocsBlock } = await import("../pi-docs");
		const realLayout = `Guidelines:\n- Be concise\n\n${REAL_BLOCK}\nCurrent working directory: /tmp`;
		const result = stripPiDocsBlock(realLayout);
		expect(result).toBeDefined();
		expect(result!.block).toBe(REAL_BLOCK);
		expect(result!.prompt).toBe("Guidelines:\n- Be concise\n\nCurrent working directory: /tmp");
	});

	it("returns undefined when the prompt starts with the block (no \\n\\n anchor)", async () => {
		const { stripPiDocsBlock } = await import("../pi-docs");
		expect(stripPiDocsBlock(`${REAL_BLOCK}\n\nNext section`)).toBeUndefined();
	});

	it("registration fails open on unwritable agentDir", async () => {
		const { piDocsSkillRegistration } = await import("../pi-docs");
		const { mkdtempSync, chmodSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-ro-"));
		try {
			chmodSync(agentDir, 0o500);
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeUndefined();
		} finally {
			chmodSync(agentDir, 0o700);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("registration honors --no-skills", async () => {
		const { piDocsSkillRegistration } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-ns-"));
		try {
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir, ["pi", "--no-skills", "-p", "hi"])).toBeUndefined();
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir, ["pi", "-ns"])).toBeUndefined();
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir, ["pi", "--", "--no-skills"])).toBeDefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("applyPiDocsStrip (strip follows the authoritative loaded skill)", () => {
	it("strips only when our skill is the loaded one at our path and read is active", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-strip-"));
		try {
			const stock = promptWithBlock(REAL_BLOCK);
			expect(piDocsSkillRegistration(stock, agentDir)).toBeDefined();

			const ourPath = piDocsSkillFilePath(agentDir);
			const loaded = [
				{ name: "other", filePath: "/home/x/.pi/agent/skills/other/SKILL.md" },
				{ name: "pi-docs", filePath: ourPath },
			];
			const stripped = applyPiDocsStrip(stock, { skills: loaded, selectedTools: ["read", "bash"] }, agentDir);
			expect(stripped).toBeDefined();
			expect(stripped!).not.toContain("Pi documentation (read only");

			// not loaded at our path (user's own pi-docs won the first-wins collision): stock stays
			const colliding = [{ name: "pi-docs", filePath: "/home/x/.pi/agent/skills/pi-docs/SKILL.md" }];
			expect(applyPiDocsStrip(stock, { skills: colliding }, agentDir)).toBeUndefined();

			// selectedTools without "read" still strips: verified live that the event's
			// selectedTools does not reflect the prompt-build toolset (exec_command reads)
			const noReadListed = applyPiDocsStrip(stock, { skills: loaded, selectedTools: ["exec_command"] }, agentDir);
			expect(noReadListed).toBeDefined();

			// no authoritative skill set at all: stock stays
			expect(applyPiDocsStrip(stock, {}, agentDir)).toBeUndefined();

			// Removing a block at the end does not leave a trailing separator.
			const prefix = "Guidelines: active";
			expect(applyPiDocsStrip(`${prefix}\n\n${REAL_BLOCK}`, { skills: loaded }, agentDir)).toBe(prefix);

			// A changed captured block is not stripped: fail open rather than guessing.
			const driftedPrompt = stock.replace("- Examples: ", "- Sample files: ");
			expect(applyPiDocsStrip(driftedPrompt, { skills: loaded }, agentDir)).toBeUndefined();

			// The exact captured block at the start of a prompt has no required anchor.
			expect(applyPiDocsStrip(`${REAL_BLOCK}\n\nNext section`, { skills: loaded }, agentDir)).toBeUndefined();

			const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
			try {
				expect(applyPiDocsStrip(stock, { skills: loaded }, agentDir)).toBeUndefined();
			} finally {
				if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
				else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
			}
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("writes the strip-time prompt diagnostic only in debug mode", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, existsSync, readFileSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-debug-"));
		const promptDump = `/tmp/pi-better-skills-pidocs-prompt-${process.pid}.txt`;
		const stock = promptWithBlock(REAL_BLOCK);
		const savedDebug = process.env.PI_BETTER_SKILLS_DEBUG;
		const savedError = console.error;
		const diagnostics: string[] = [];
		try {
			rmSync(promptDump, { force: true });
			delete process.env.PI_BETTER_SKILLS_DEBUG;
			console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
			expect(piDocsSkillRegistration(stock, agentDir)).toBeDefined();
			const loaded = { name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) };
			expect(applyPiDocsStrip(stock, { skills: [loaded] }, agentDir)).toBeDefined();
			expect(existsSync(promptDump)).toBe(false);
			expect(diagnostics).toEqual([]);

			process.env.PI_BETTER_SKILLS_DEBUG = "1";
			const stripped = applyPiDocsStrip(
				stock,
				{ skills: [loaded] },
				agentDir,
			);
			expect(stripped).toBeDefined();
			expect(readFileSync(promptDump, "utf8")).toBe(stock);
			expect(diagnostics).toEqual(["[pi-better-skills:pi-docs] dumped strip-time prompt {\"skills\":1}"]);
		} finally {
			console.error = savedError;
			if (savedDebug === undefined) delete process.env.PI_BETTER_SKILLS_DEBUG;
			else process.env.PI_BETTER_SKILLS_DEBUG = savedDebug;
			rmSync(promptDump, { force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("stays stock when the generated skill is not loaded, including in debug mode", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-debug-gate-"));
		const savedDebug = process.env.PI_BETTER_SKILLS_DEBUG;
		const savedError = console.error;
		const diagnostics: string[] = [];
		const stock = promptWithBlock(REAL_BLOCK);
		try {
			expect(piDocsSkillRegistration(stock, agentDir)).toBeDefined();
			process.env.PI_BETTER_SKILLS_DEBUG = "1";
			console.error = (...args: unknown[]) => diagnostics.push(args.map(String).join(" "));
			expect(applyPiDocsStrip(stock, {}, agentDir)).toBeUndefined();
			expect(diagnostics).toEqual([
				"[pi-better-skills:pi-docs] dumped strip-time prompt {}",
				"[pi-better-skills:pi-docs] skill not loaded at our path, staying stock",
			]);
		} finally {
			console.error = savedError;
			if (savedDebug === undefined) delete process.env.PI_BETTER_SKILLS_DEBUG;
			else process.env.PI_BETTER_SKILLS_DEBUG = savedDebug;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("requires a current capture and preserves meaningful content around it", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-exact-strip-"));
		const loaded = { name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) };
		try {
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeDefined();

			expect(applyPiDocsStrip(`\n\n${REAL_BLOCK}\nTail`, { skills: [loaded] }, agentDir)).toBe("\n\nTail");
			expect(applyPiDocsStrip(`prefix\n\n${REAL_BLOCK}\n\n\nTail`, { skills: [loaded] }, agentDir)).toBe("prefix\n\nTail");
			expect(applyPiDocsStrip(`prefix\n\n${REAL_BLOCK}Tail\nMore`, { skills: [loaded] }, agentDir)).toBe("prefix\n\nTail\nMore");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not strip a prompt when discovery captured nothing", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const agentDir = "/tmp/pi-docs-no-capture-agent";
		expect(piDocsSkillRegistration("no block here", agentDir)).toBeUndefined();
		expect(
			applyPiDocsStrip("prefix\n\nundefined\nsuffix", {
				skills: [{ name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) }],
			}, agentDir),
		).toBeUndefined();
	});
});

describe("pi-docs extension wiring", () => {
	it("registers the generated skill and strips through pi's two event handlers", async () => {
		const { default: registerExtension } = await import("../index");
		const { piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const extension = {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
			registerMessageRenderer() {},
		};
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-wiring-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "pi-docs-wiring-cwd-"));
		const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		const stock = promptWithBlock(REAL_BLOCK);
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			registerExtension(extension as never);
			const context = {
				cwd,
				isProjectTrusted: () => false,
				getSystemPrompt: () => stock,
			};
			const registrationHandler = handlers.get("resources_discover");
			expect(registrationHandler).toBeDefined();
			const registration = await registrationHandler?.({}, context);
			expect(registration).toEqual({ skillPaths: [join(agentDir, "cache", "pi-better-skills", "pi-docs")] });

			const stripHandler = handlers.get("before_agent_start");
			expect(stripHandler).toBeDefined();
			const result = await stripHandler?.(
				{
					systemPrompt: stock,
					systemPromptOptions: { skills: [{ name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) }] },
				},
					context,
				);
				const strippedPrompt = (result as { systemPrompt: string }).systemPrompt;
				expect(strippedPrompt).not.toContain("Pi documentation (read only");
				expect(strippedPrompt).toContain("<agent_skills>");

				const noOptionsResult = await stripHandler?.({ systemPrompt: stock }, context);
				const stockPrompt = (noOptionsResult as { systemPrompt: string }).systemPrompt;
				expect(stockPrompt).toContain("Pi documentation (read only");
				expect(stockPrompt).toContain("<agent_skills>");
			} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("stale capture cannot outlive a failed discovery pass", () => {
	it("a drifted discovery clears capture so the strip stands down even if the skill stays loaded", async () => {
		const { piDocsSkillRegistration, applyPiDocsStrip, piDocsSkillFilePath } = await import("../pi-docs");
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-stale-"));
		try {
			expect(piDocsSkillRegistration(promptWithBlock(REAL_BLOCK), agentDir)).toBeDefined();
			// next discovery: pi's prompt drifted, no block found
			expect(piDocsSkillRegistration("Guidelines only, no block", agentDir)).toBeUndefined();
			// skill still in the authoritative loaded set, block text still in the prompt:
			// the strip must still stand down — capture is gone
			const stillLoaded = [{ name: "pi-docs", filePath: piDocsSkillFilePath(agentDir) }];
			expect(applyPiDocsStrip(promptWithBlock(REAL_BLOCK), { skills: stillLoaded }, agentDir)).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
