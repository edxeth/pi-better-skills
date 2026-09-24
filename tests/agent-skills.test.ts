import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type FauxProviderHandle, type TranscriptContext } from "@earendil-works/pi-ai";
import registerExtension, { type ExtensionAPI } from "../src/index";
import { piDocsSkillFilePath } from "../src/pi-docs";

// The general skill guidance must ride in the system prompt of EVERY model
// request (normal prompt, tool continuation, idle-triggered turn, next user
// prompt), exactly once, without entering the persisted transcript. The
// per-skill <skill_context> keeps only the directories; these tests pin the
// system-level side of that split at the provider-facing boundary. Only the
// model is faux; extension loading, skills, tools, and the session manager are
// the real Pi pipeline.

const BODY = "# Fixture skill\nRead references/guide.md before responding.";
const FIRST_PATH_RULE = "Relative file references in this SKILL.md normally resolve from skill_dir when they exist there.";
const ABSOLUTE_RULE = "Absolute paths are exact and should not be reinterpreted.";
const SHELL_RULE = "Do not run dynamic shell placeholders yourself";
const AGENT_SKILLS_TAG = "<agent_skills>";
const DOCS_MARKER = "Pi documentation (read only";

/** A sibling extension that replaces the whole system prompt for normal turns. */
const FORCED_PROMPT = "Overridden full prompt: another extension owns the whole system prompt.";
const forcedPromptExtension = (pi: ExtensionAPI) => {
	pi.on("before_agent_start", async () => ({ systemPrompt: FORCED_PROMPT }));
};

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

interface Fixture {
	session: AgentSession;
	faux: FauxProviderHandle;
	manager: SessionManager;
	requests: TranscriptContext[];
	agentDir: string;
	cwd: string;
	skillDir: string;
	skillPath: string;
	cleanup: () => void;
}

async function fixture(options?: { extensionFactories?: typeof registerExtension[]; piDocsEnabled?: boolean }): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "agent-skills-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const skillDir = join(agentDir, "skills", "fixture");
	const skillPath = join(skillDir, "SKILL.md");
	mkdirSync(join(skillDir, "references"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(skillPath, `---\nname: fixture\ndescription: Test fixture\n---\n\n${BODY}\n`);
	writeFileSync(join(skillDir, "references", "guide.md"), "REFERENCE_OK\n");
	const original = readFileSync(skillPath, "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	if (options?.piDocsEnabled) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
	else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
	let session: AgentSession | undefined;
	const cleanup = () => {
		try {
			session?.dispose();
			rmSync(root, { recursive: true, force: true });
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousOptOut === undefined) delete process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
			else process.env.PI_BETTER_SKILLS_NO_PI_DOCS = previousOptOut;
		}
	};
	try {
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
		const loader = new DefaultResourceLoader({
			cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
			skillsOverride: result => ({ ...result, skills: result.skills.filter(skill => skill.filePath.startsWith(agentDir + "/")) }),
			extensionFactories: options?.extensionFactories ?? [registerExtension],
		});
		await loader.reload();
		const manager = SessionManager.inMemory(cwd);
		const { session: activeSession } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["read", "bash"] });
		session = activeSession;
		const errors: unknown[] = [];
		await activeSession.bindExtensions({ onError: error => errors.push(error) });
		const requests: TranscriptContext[] = [];
		const record = (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage("OK");
		};
		return {
			session: activeSession, faux, manager, requests, agentDir, cwd, skillDir, skillPath,
			cleanup() {
				try {
					expect(readFileSync(skillPath, "utf8")).toBe(original);
					expect(errors).toEqual([]);
				} finally {
					cleanup();
				}
			},
		};
	} catch (error) {
		try { cleanup(); } finally { throw error; }
	}
}

/**
 * Drive one session through: normal prompt (model reads the fixture skill) ->
 * tool continuation -> idle-triggered turn -> next user prompt. Records all
 * four provider-facing requests.
 */
async function driveLifecycle(built: Fixture): Promise<void> {
	const { session, faux, requests, skillPath } = built;
	const record = (context: TranscriptContext) => {
		requests.push(structuredClone(context));
		return fauxAssistantMessage("OK");
	};
	faux.setResponses([
		(context: TranscriptContext) => {
			record(context);
			return fauxAssistantMessage([fauxToolCall("read", { path: skillPath })]);
		},
		record,
		record,
		record,
	]);
	await session.prompt("Read the fixture skill.");
	// Idle-triggered turn: runs without before_agent_start, so only a
	// request-time mechanism can carry the block here.
	await session.sendCustomMessage({ customType: "note", content: "idle ping", display: false }, { triggerTurn: true });
	await session.waitForIdle();
	await session.prompt("Continue.");
}

it("delivers general skill guidance in the system prompt of every request across the lifecycle", async () => {
	const built = await fixture();
	try {
		await driveLifecycle(built);

		expect(built.requests).toHaveLength(4);
		const prompts = built.requests.map(request => getCurrentSystemPrompt(request.messages));
		for (const prompt of prompts) {
			// Exactly once per request, carrying the historical rules verbatim.
			expect(countOccurrences(prompt, AGENT_SKILLS_TAG)).toBe(1);
			expect(countOccurrences(prompt, "</agent_skills>")).toBe(1);
			expect(prompt).toContain(FIRST_PATH_RULE);
			expect(prompt).toContain(ABSOLUTE_RULE);
			expect(prompt).toContain(SHELL_RULE);
			expect(prompt).toContain("<path_policy>");
			expect(prompt).toContain("<dynamic_skill_shell>");
		}
		// Byte-stable across normal, tool-continuation, idle, and next-user requests:
		// one identical system prompt keeps the provider prompt cache warm.
		expect(new Set(prompts).size).toBe(1);
	} finally {
		built.cleanup();
	}
});

it("never persists agent_skills into the session transcript", async () => {
	const built = await fixture();
	try {
		await driveLifecycle(built);
		expect(built.requests.length).toBeGreaterThan(0);

		// The persisted entries and the replayed LLM context stay clean: injection
		// happens on the request clone only. The transcript does carry a real
		// leading system message, so the not-contains check is not vacuous.
		const context = built.manager.buildSessionContext();
		expect(context.messages[0]?.role).toBe("system");
		for (const message of [...built.session.messages, ...context.messages]) {
			expect(textOf(message as { content: unknown })).not.toContain(AGENT_SKILLS_TAG);
		}
	} finally {
		built.cleanup();
	}
});

it("injects exactly once when the extension is registered twice", async () => {
	const built = await fixture({ extensionFactories: [registerExtension, registerExtension] });
	try {
		built.faux.setResponses([
			(context: TranscriptContext) => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage("OK");
			},
		]);
		await built.session.prompt("ping");

		expect(built.requests).toHaveLength(1);
		const prompt = getCurrentSystemPrompt(built.requests[0].messages);
		expect(countOccurrences(prompt, AGENT_SKILLS_TAG)).toBe(1);
		expect(prompt).toContain(ABSOLUTE_RULE);
	} finally {
		built.cleanup();
	}
});

it("composes with the pi-docs request strip at the same seam", async () => {
	const built = await fixture({ piDocsEnabled: true });
	try {
		built.faux.setResponses([
			(context: TranscriptContext) => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage("OK");
			},
		]);
		await built.session.prompt("ping");

		expect(built.requests).toHaveLength(1);
		const prompt = getCurrentSystemPrompt(built.requests[0].messages);
		// Exactly one agent_skills section, docs block removed, nothing else clobbered.
		expect(countOccurrences(prompt, AGENT_SKILLS_TAG)).toBe(1);
		expect(prompt).toContain(ABSOLUTE_RULE);
		expect(prompt).not.toContain(DOCS_MARKER);
		// The strip only armed because the generated skill file exists at our path.
		expect(readFileSync(piDocsSkillFilePath(built.agentDir), "utf8")).toContain("name: pi-docs");
	} finally {
		built.cleanup();
	}
});

it("ships a later forced whole prompt without the block, and still injects on idle turns (known limitation)", async () => {
	const built = await fixture({ extensionFactories: [registerExtension, forcedPromptExtension] });
	try {
		const record = (context: TranscriptContext) => {
			built.requests.push(structuredClone(context));
			return fauxAssistantMessage("OK");
		};
		built.faux.setResponses([record, record]);
		await built.session.prompt("ping");
		// Normal turn: pi applies the forced prompt AFTER context_with_system,
		// so it wins byte-exact and the injected section is gone for this run.
		expect(built.requests).toHaveLength(1);
		expect(getCurrentSystemPrompt(built.requests[0].messages)).toBe(FORCED_PROMPT);

		// Idle-triggered turns skip before_agent_start entirely, so the
		// request-time injection applies to them.
		await built.session.sendCustomMessage({ customType: "note", content: "idle ping", display: false }, { triggerTurn: true });
		await built.session.waitForIdle();
		expect(built.requests).toHaveLength(2);
		const idlePrompt = getCurrentSystemPrompt(built.requests[1].messages);
		expect(idlePrompt.split(AGENT_SKILLS_TAG).length - 1).toBe(1);
		expect(idlePrompt).toContain(ABSOLUTE_RULE);
	} finally {
		built.cleanup();
	}
});

function textOf(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
