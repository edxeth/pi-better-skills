import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	createAgentSession,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type FauxProviderHandle,
} from "@earendil-works/pi-ai";
import { piDocsSkillFilePath, piDocsSkillDirPath } from "../src/pi-docs";

/**
 * Real-Pi lifecycle tests for the pi-docs skill. Docs trimming must hold for
 * EVERY model request of a real session: the normal prompt, an idle-triggered
 * turn (which never fires before_agent_start), that turn's tool continuation,
 * and the next normal prompt. Only the model is mocked (pi fauxProvider);
 * extension loading, skill registration, the resource loader, the session
 * manager, and tool execution are the real Pi pipeline.
 *
 * The main enabled/opt-out/collision/no-skills/override paths load the ACTUAL
 * shipped extension (src/index.ts) through pi's real jiti loader. Two tests
 * use synthetic wiring on purpose: the no-capture stand-down (the real
 * extension always captures, so strip-only wiring is only reachable with a
 * misconfigured extension) and the two-session capture-isolation regression
 * (it pins src/pi-docs.ts per-instance state, independent of src/index.ts).
 */

const SRC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const DOCS_MARKER = "Pi documentation (read only";
const DOCS_HEADER_LINE = "Pi documentation (read only when the user asks about pi itself";
const DEFAULT_TOOL_NAMES = ["read", "bash", "edit", "write"];

/** Load the actual shipped extension (src/index.ts) through pi's real jiti pipeline. */
const REAL_EXTENSION_LOADER = `export { default } from "${SRC_DIR}/index.ts";\n`;

/**
 * The shipped wiring shape, standalone: the factory registers the per-request
 * strip once and routes resources_discover through its returned discover
 * callback. Used where the test must not depend on src/index.ts.
 */
const CALLBACK_WIRING_EXTENSION = `
import { registerPiDocsRequestStrip } from "${SRC_DIR}/pi-docs.ts";
export default function (pi) {
	const discoverPiDocsSkill = registerPiDocsRequestStrip(pi);
	pi.on("resources_discover", async (_event, ctx) => discoverPiDocsSkill(ctx.getSystemPrompt()));
}
`;

/** Misconfigured wiring: request strip without a discovery capture in this instance. */
const STRIP_ONLY_EXTENSION = `
import { registerPiDocsRequestStrip } from "${SRC_DIR}/pi-docs.ts";
export default function (pi) {
	registerPiDocsRequestStrip(pi);
}
`;

/** A sibling extension that overrides the whole system prompt from before_agent_start. */
const OVERRIDE_SYSTEM_PROMPT = [
	"Overridden full prompt: another extension owns the whole system prompt for this session.",
	"",
	"<docs>",
	"Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):",
	"- Main documentation: /opt/pi/README.md",
	"</docs>",
].join("\n");

const FULL_PROMPT_OVERRIDE_EXTENSION = `
export default function (pi) {
	pi.on("before_agent_start", async () => ({ systemPrompt: ${JSON.stringify(OVERRIDE_SYSTEM_PROMPT)} }));
}
`;

/** The user's own pi-docs skill that wins pi's first-wins name collision. */
const USER_PI_DOCS_SKILL = `---
name: pi-docs
description: The user's own pi-docs skill, authored before the generated one existed.
---

# User pi-docs

User-authored pi notes.
`;

interface CapturedRequest {
	systemPrompt: string;
	/** Provider-facing messages (deep copy), leading system message included. */
	messages: TranscriptContext["messages"];
}

interface SessionHarness {
	session: AgentSession;
	faux: FauxProviderHandle;
	requests: CapturedRequest[];
}

interface CapturedBuild extends SessionHarness {
	agentDir: string;
	cwd: string;
	sessionDir: string;
	cleanup: () => void;
}

/** One real session bound to real extension instances; only the model is faux. */
async function startSession(
	agentDir: string,
	cwd: string,
	sessionDir: string,
	sessionManager?: SessionManager,
): Promise<SessionHarness> {
	const faux = fauxProvider();
	const requests: CapturedRequest[] = [];

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noContextFiles: true, noPromptTemplates: true, noThemes: true,
		skillsOverride: result => ({ ...result, skills: result.skills.filter(skill => skill.filePath.startsWith(agentDir + "/")) }),
	});
	await resourceLoader.reload();
	const manager = sessionManager ?? SessionManager.create(cwd, sessionDir);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager: manager,
		model: faux.models[0],
	});
	// SDK sessions do not run session_start/resources_discover until bindings attach.
	try {
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: error => errors.push(error) });
		expect(errors).toEqual([]);
		return { session, faux, requests };
	} catch (error) {
		session.dispose();
		throw error;
	}
}

async function buildSession(
	extensionCode: string,
	prepareAgentDir?: (agentDir: string) => void,
): Promise<CapturedBuild> {
	const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-docs-life-agent-"));
	const cwd = mkdtempSync(join(tmpdir(), "pi-docs-life-cwd-"));
	const sessionDir = join(agentDir, "sessions");
	let harness: SessionHarness | undefined;
	const cleanup = () => {
		try {
			harness?.session.dispose();
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		} finally {
			if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		}
	};
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(agentDir, "extensions", "pi-docs-fix.ts"), extensionCode, "utf8");
		prepareAgentDir?.(agentDir);
		harness = await startSession(agentDir, cwd, sessionDir);
		return { ...harness, agentDir, cwd, sessionDir, cleanup };
	} catch (error) {
		try { cleanup(); } finally { throw error; }
	}
}

/** A fresh session instance over the same session file: new extension instances, same agent dir. */
async function resumeSession(built: CapturedBuild): Promise<SessionHarness> {
	const sessionFile = built.session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("session was not persisted; cannot resume");
	return startSession(built.agentDir, built.cwd, built.sessionDir, SessionManager.open(sessionFile));
}

/** Drive one session through: normal prompt -> idle-triggered turn -> its tool continuation -> next normal prompt. */
async function driveFourRequests(harness: SessionHarness): Promise<void> {
	const { session, faux, requests } = harness;
	const record = (context: TranscriptContext) => {
		requests.push({
			systemPrompt: getCurrentSystemPrompt(context.messages),
			messages: structuredClone(context.messages),
		});
	};
	faux.setResponses([
		(context) => {
			record(context);
			return fauxAssistantMessage("first reply");
		},
		(context) => {
			record(context);
			return fauxAssistantMessage([fauxToolCall("bash", { command: "echo idle-ping" })]);
		},
		(context) => {
			record(context);
			return fauxAssistantMessage("idle reply");
		},
		(context) => {
			record(context);
			return fauxAssistantMessage("second reply");
		},
	]);

	await session.prompt("normal one");
	// Idle-triggered turn: sendCustomMessage with triggerTurn while idle runs
	// _runAgentPrompt directly, so before_agent_start never fires for requests 2+3.
	await session.sendCustomMessage({ customType: "note", content: "idle ping", display: false }, { triggerTurn: true });
	await session.waitForIdle();
	await session.prompt("normal two");
}

/** Drive exactly one normal-prompt request through a session. */
async function singleRequest(harness: SessionHarness): Promise<void> {
	const { session, faux, requests } = harness;
	faux.setResponses([
		(context) => {
			requests.push({
				systemPrompt: getCurrentSystemPrompt(context.messages),
				messages: structuredClone(context.messages),
			});
			return fauxAssistantMessage("reply");
		},
	]);
	await session.prompt("ping");
	await session.waitForIdle();
}

function headOf(request: CapturedRequest): { sections: Record<string, string>; [key: string]: unknown } {
	const head = request.messages[0];
	if (!head || (head as { role?: string }).role !== "system") {
		throw new Error(`request has no leading system message: ${JSON.stringify(request.messages[0])}`);
	}
	return head as unknown as { sections: Record<string, string>; [key: string]: unknown };
}

/** Docs trimming must not cost any other prompt content, structure, or tool state. */
function expectRequestIntactBeyondDocs(request: CapturedRequest, cwd: string): void {
	const head = headOf(request);
	// Unrelated sections and their order survive; docs is the only removal.
	const sectionNames = Object.keys(head.sections ?? {});
	expect(sectionNames).toContain("preamble");
	expect(sectionNames).toContain("tools");
	expect(sectionNames).toContain("rules");
	expect(sectionNames).toContain("cwd");
	expect(sectionNames).toContain("skills");
	expect(sectionNames).not.toContain("docs");
	// Unrelated text survives verbatim.
	expect(request.systemPrompt).toContain("expert coding assistant");
	expect(request.systemPrompt).toContain(`<cwd>\n${cwd.replace(/\\/g, "/")}\n</cwd>`);
	expect(request.systemPrompt).not.toContain(DOCS_MARKER);
	// Tool declarations survive the strip.
	expect(getCurrentTools(request.messages as never).map((tool) => tool.name)).toEqual(DEFAULT_TOOL_NAMES);
}

describe("pi-docs request lifecycle (real Pi session)", () => {
	it("does not revive superseded documentation when a later update restores Pi docs", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const built = await buildSession(REAL_EXTENSION_LOADER, agentDir => {
			writeFileSync(join(agentDir, "extensions", "00-doc-update.ts"), `
export default function (pi) {
	pi.on("context_with_system", event => {
		const [head, ...rest] = event.messages;
		const originalDocs = head.sections.docs;
		return { messages: [
			{ ...head, sections: { ...head.sections, docs: "SUPERSEDED_FOREIGN_DOCS" } },
			...rest,
			{ role: "system", content: "", sections: { docs: originalDocs, update_note: "KEEP_UNRELATED_UPDATE" }, timestamp: Date.now() },
		] };
	});
}
`);
		});
		try {
			await singleRequest(built);
			expect(built.requests[0].systemPrompt).not.toContain("SUPERSEDED_FOREIGN_DOCS");
			expect(built.requests[0].systemPrompt).not.toContain(DOCS_MARKER);
			expect(built.requests[0].systemPrompt).toContain("KEEP_UNRELATED_UPDATE");
			expect(getCurrentTools(built.requests[0].messages).map(tool => tool.name)).toEqual(DEFAULT_TOOL_NAMES);
		} finally {
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("keeps docs trimmed across normal, idle, and tool-continuation requests", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const built = await buildSession(REAL_EXTENSION_LOADER);
		try {
			await driveFourRequests(built);

			expect(built.requests).toHaveLength(4);
			for (const request of built.requests) {
				expect(request.systemPrompt).not.toContain(DOCS_MARKER);
				expectRequestIntactBeyondDocs(request, built.cwd);
			}
			// Byte-stable: the request head is identical across normal, idle, and
			// continuation requests, so the provider prompt cache never churns.
			expect(new Set(built.requests.map((request) => request.systemPrompt)).size).toBe(1);

			// The replacement skill is loaded at exactly our generated path.
			const loaded = built.session.resourceLoader
				.getSkills()
				.skills.filter((skill) => skill.name === "pi-docs");
			expect(loaded).toHaveLength(1);
			expect(loaded[0].filePath).toBe(piDocsSkillFilePath(built.agentDir));

			// The generated skill body is the captured block, so it reads in lockstep with pi.
			const skillFile = piDocsSkillFilePath(built.agentDir);
			expect(existsSync(skillFile)).toBe(true);
			const skillMd = readFileSync(skillFile, "utf8");
			expect(skillMd).toContain("name: pi-docs");
			expect(skillMd).toContain(DOCS_HEADER_LINE);
			expect(skillMd).toContain("- Main documentation: ");
		} finally {
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("stays stock when PI_BETTER_SKILLS_NO_PI_DOCS opts out", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
		const built = await buildSession(REAL_EXTENSION_LOADER);
		try {
			await driveFourRequests(built);

			expect(built.requests).toHaveLength(4);
			for (const request of built.requests) {
				// Stock pi behavior: the docs block rides in every request.
				expect(request.systemPrompt).toContain(DOCS_MARKER);
				expect(Object.keys(headOf(request).sections ?? {})).toContain("docs");
			}
			// No replacement skill is registered or written.
			expect(built.session.resourceLoader.getSkills().skills.some((skill) => skill.name === "pi-docs")).toBe(false);
			expect(existsSync(piDocsSkillFilePath(built.agentDir))).toBe(false);
		} finally {
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("stands down when --no-skills is set", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const savedArgv = process.argv;
		process.argv = ["pi", "--no-skills", "-p", "hello"];
		let built: CapturedBuild | undefined;
		try {
			built = await buildSession(REAL_EXTENSION_LOADER);
			await driveFourRequests(built);

			// Extension skillPaths bypass pi's --no-skills, so the feature honors
			// the flag itself: no generated skill, stock docs in every request.
			expect(built.requests).toHaveLength(4);
			for (const request of built.requests) {
				expect(request.systemPrompt).toContain(DOCS_MARKER);
			}
			expect(built.session.resourceLoader.getSkills().skills.some((skill) => skill.name === "pi-docs")).toBe(false);
			expect(existsSync(piDocsSkillFilePath(built.agentDir))).toBe(false);
		} finally {
			process.argv = savedArgv;
			built?.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("stands down when the user's own pi-docs skill wins the name collision", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const built = await buildSession(REAL_EXTENSION_LOADER, (agentDir) => {
			// Registered as a user skill before the session starts, so pi's
			// first-wins skill resolution keeps the user's copy and drops ours.
			mkdirSync(join(agentDir, "skills", "pi-docs"), { recursive: true });
			writeFileSync(join(agentDir, "skills", "pi-docs", "SKILL.md"), USER_PI_DOCS_SKILL, "utf8");
		});
		try {
			await driveFourRequests(built);

			const loaded = built.session.resourceLoader
				.getSkills()
				.skills.filter((skill) => skill.name === "pi-docs");
			expect(loaded).toHaveLength(1);
			expect(loaded[0].filePath).toBe(join(built.agentDir, "skills", "pi-docs", "SKILL.md"));

			// Our exact generated path is not the loaded one, so the strip never fires.
			for (const request of built.requests) {
				expect(request.systemPrompt).toContain(DOCS_MARKER);
			}
		} finally {
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("stands down when discovery never captured a block in this instance", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const built = await buildSession(STRIP_ONLY_EXTENSION);
		try {
			await driveFourRequests(built);

			expect(built.requests).toHaveLength(4);
			for (const request of built.requests) {
				expect(request.systemPrompt).toContain(DOCS_MARKER);
			}
			// Nothing was generated or registered.
			expect(existsSync(piDocsSkillDirPath(built.agentDir))).toBe(false);
			expect(built.session.resourceLoader.getSkills().skills.some((skill) => skill.name === "pi-docs")).toBe(false);
		} finally {
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("a sibling session's failed discovery cannot disarm this session's capture (sequential sessions)", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const first = await buildSession(CALLBACK_WIRING_EXTENSION);
		try {
			await singleRequest(first);
			expect(first.requests[0].systemPrompt).not.toContain(DOCS_MARKER);

			// A second session in the same process whose discovery fails (its cache
			// path is blocked by a regular file) must not touch the first session's
			// captured state; capture is per extension instance.
			const second = await buildSession(CALLBACK_WIRING_EXTENSION, (agentDir) => {
				writeFileSync(join(agentDir, "cache"), "occupied by a file, not a directory");
			});
			try {
				await singleRequest(second);
				// The failing session itself stays stock (fail open).
				expect(second.requests[0].systemPrompt).toContain(DOCS_MARKER);

				await singleRequest(first);
				expect(first.requests[1].systemPrompt).not.toContain(DOCS_MARKER);
				expectRequestIntactBeyondDocs(first.requests[1], first.cwd);
			} finally {
				second.cleanup();
			}
		} finally {
			first.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("ships a later full-prompt override verbatim (known limitation)", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		const built = await buildSession(REAL_EXTENSION_LOADER, (agentDir) => {
			// A second extension whose before_agent_start returns a whole system
			// prompt. pi applies that forced projection AFTER context_with_system,
			// but only on requests whose turn fires before_agent_start (normal
			// prompts). The strip must neither fight the override (no private-state
			// hacks) nor mangle it; on idle turns and continuations, which skip
			// before_agent_start, the per-request strip still applies.
			writeFileSync(join(agentDir, "extensions", "override.ts"), FULL_PROMPT_OVERRIDE_EXTENSION);
		});
		try {
			await driveFourRequests(built);

			expect(built.requests).toHaveLength(4);
			// Normal prompts: the override wins and ships byte-exact, docs included.
			expect(built.requests[0].systemPrompt).toBe(OVERRIDE_SYSTEM_PROMPT);
			expect(built.requests[3].systemPrompt).toBe(OVERRIDE_SYSTEM_PROMPT);
			// Idle turn and its tool continuation: no before_agent_start fired, so
			// pi's own prompt state is shipped and the strip removes the docs block.
			expect(built.requests[1].systemPrompt).not.toContain(DOCS_MARKER);
			expect(built.requests[2].systemPrompt).not.toContain(DOCS_MARKER);
		} finally {
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});

	it("keeps docs trimmed for an idle-first turn after resume, and after compaction", async () => {
		const savedOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
		// keepRecentTokens: 1 lets manual compaction run on this tiny session.
		const built = await buildSession(REAL_EXTENSION_LOADER, (agentDir) => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
		});
		let resumed: SessionHarness | undefined;
		try {
			// Establish prompt state pre-resume. (An idle-triggered turn as the very
			// first request of a brand-new session ships an EMPTY system head; pi
			// builds prompt state on the normal-prompt path only — verified with a
			// no-extension control.) The realistic idle-first scenario is a resumed
			// session whose queued message fires an idle turn before any prompt.
			await singleRequest(built);
			expect(built.requests[0].systemPrompt).not.toContain(DOCS_MARKER);
			expectRequestIntactBeyondDocs(built.requests[0], built.cwd);

			// Resume: a fresh session instance over the same session file, with
			// freshly loaded extension instances that re-capture at discovery.
			resumed = await resumeSession(built);
			// Idle-first after resume: the first post-resume model request is an
			// idle-triggered turn, which never fires before_agent_start.
			resumed.faux.setResponses([
				(context) => {
					resumed.requests.push({
						systemPrompt: getCurrentSystemPrompt(context.messages),
						messages: structuredClone(context.messages),
					});
					return fauxAssistantMessage("idle-first reply");
				},
				(context) => {
					resumed.requests.push({
						systemPrompt: getCurrentSystemPrompt(context.messages),
						messages: structuredClone(context.messages),
					});
					return fauxAssistantMessage("post-resume reply");
				},
				(context) => {
					resumed.requests.push({
						systemPrompt: getCurrentSystemPrompt(context.messages),
						messages: structuredClone(context.messages),
					});
					return fauxAssistantMessage("compaction summary");
				},
				(context) => {
					resumed.requests.push({
						systemPrompt: getCurrentSystemPrompt(context.messages),
						messages: structuredClone(context.messages),
					});
					return fauxAssistantMessage("compaction summary two");
				},
				(context) => {
					resumed.requests.push({
						systemPrompt: getCurrentSystemPrompt(context.messages),
						messages: structuredClone(context.messages),
					});
					return fauxAssistantMessage("post-compact reply");
				},
			]);
			await resumed.session.sendCustomMessage(
				{ customType: "note", content: "idle ping", display: false },
				{ triggerTurn: true },
			);
			await resumed.session.waitForIdle();
			await resumed.session.prompt("post-resume prompt");
			await resumed.session.waitForIdle();

			// Idle turn and normal prompt after resume: prompt state is replayed,
			// docs are stripped, and the head matches the pre-resume request.
			expect(resumed.requests[0].systemPrompt).not.toContain(DOCS_MARKER);
			expectRequestIntactBeyondDocs(resumed.requests[0], built.cwd);
			expect(resumed.requests[1].systemPrompt).not.toContain(DOCS_MARKER);
			expectRequestIntactBeyondDocs(resumed.requests[1], built.cwd);
			expect(resumed.requests[0].systemPrompt).toBe(built.requests[0].systemPrompt);
			expect(resumed.requests[1].systemPrompt).toBe(built.requests[0].systemPrompt);

			// Compaction: two pi summarizer calls carry pi's own summarization
			// prompt (never the session prompt, so no docs block by construction);
			// the next normal request is still trimmed and byte-stable.
			await resumed.session.compact();
			await resumed.session.prompt("post-compact prompt");
			await resumed.session.waitForIdle();

			expect(resumed.requests).toHaveLength(5);
			for (const index of [2, 3]) {
				const summarizer = resumed.requests[index];
				expect(summarizer.systemPrompt).not.toContain(DOCS_MARKER);
				expect(Object.keys(headOf(summarizer).sections ?? {})).toEqual([]);
			}
			expect(resumed.requests[4].systemPrompt).not.toContain(DOCS_MARKER);
			expectRequestIntactBeyondDocs(resumed.requests[4], built.cwd);
			expect(resumed.requests[4].systemPrompt).toBe(built.requests[0].systemPrompt);
		} finally {
			resumed?.session.dispose();
			built.cleanup();
			if (savedOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = savedOptOut;
		}
	});
});
