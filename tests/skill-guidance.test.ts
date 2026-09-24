import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type TranscriptContext } from "@earendil-works/pi-ai";
import registerExtension from "../src/index";

// Contract (guidance split): every delivered skill body carries a dirs-only
// <skill_context> (skill_dir + workspace_dir) and NOT the general rules; the
// general path_policy/dynamic_skill_shell guidance rides in the system-level
// <agent_skills> section on every request (pinned end-to-end in
// tests/agent-skills.test.ts). These tests pin the body side at the read and
// /skill:name delivery seams, plus the system-block presence at those seams.

const BODY = "# Fixture skill\nRead references/guide.md before responding.";
const ABSOLUTE_RULE = "Absolute paths are exact and should not be reinterpreted.";
const SHELL_RULE = "Do not run dynamic shell placeholders yourself";
const AGENT_SKILLS_TAG = "<agent_skills>";

async function fixture(body = BODY) {
	const root = mkdtempSync(join(tmpdir(), "skill-guidance-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const skillDir = join(agentDir, "skills", "fixture");
	const skillPath = join(skillDir, "SKILL.md");
	mkdirSync(join(skillDir, "references"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(skillPath, `---\nname: fixture\ndescription: Test fixture\n---\n\n${body}\n`);
	writeFileSync(join(skillDir, "references", "guide.md"), "REFERENCE_OK\n");
	const original = readFileSync(skillPath, "utf8");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOptOut = process.env.PI_BETTER_SKILLS_NO_PI_DOCS;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
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
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, skillsOverride: result => ({ ...result, skills: result.skills.filter(skill => skill.filePath.startsWith(agentDir + "/")) }), extensionFactories: [registerExtension] });
		await loader.reload();
		const manager = SessionManager.inMemory(cwd);
		const { session: activeSession } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["read", "bash"] });
		session = activeSession;
		const errors: unknown[] = [];
		await activeSession.bindExtensions({ onError: error => errors.push(error) });
		const requests: TranscriptContext[] = [];
		const reply = (context: TranscriptContext) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage("OK");
		};
		return {
			session: activeSession, manager, faux, requests, reply, cwd, skillDir, skillPath,
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

function textOf(message: { content: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}

/** The delivered body side of the split: dirs present, general rules absent. */
function expectDirsOnlyBody(text: string, built: ReturnType<typeof fixture> extends Promise<infer T> ? T : never): void {
	expect(text).toContain(BODY);
	expect(text).toContain(`<skill_dir>${built.skillDir}</skill_dir>`);
	expect(text).toContain(`<workspace_dir>${built.cwd}</workspace_dir>`);
	expect(text).not.toContain(ABSOLUTE_RULE);
	expect(text).not.toContain(SHELL_RULE);
}

/** The system side of the split: the general rules ride in <agent_skills>. */
function expectSystemBlock(prompt: string): void {
	expect(prompt.split(AGENT_SKILLS_TAG).length - 1).toBe(1);
	expect(prompt).toContain(ABSOLUTE_RULE);
	expect(prompt).toContain(SHELL_RULE);
}

it("saves directory context with a read skill, without changing its source file", async () => {
	const built = await fixture();
	try {
		built.faux.setResponses([
			(context: TranscriptContext) => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]);
			},
			built.reply,
		]);
		await built.session.prompt("Read the fixture skill.");
		const result = built.session.messages.find(message => message.role === "toolResult");
		expect(result).toBeDefined();
		if (!result) throw new Error("Skill read produced no tool result");
		expectDirsOnlyBody(textOf(result), built);
		// The first request already carries the general rules at system level.
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

it("keeps dirs-only bodies and a byte-stable system block through idle helper and tool turns", async () => {
	const built = await fixture();
	try {
		built.faux.setResponses([
			context => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]);
			},
			built.reply,
			context => {
				built.requests.push(structuredClone(context));
				return fauxAssistantMessage([fauxToolCall("bash", { command: "printf helper-tool-ok" })]);
			},
			built.reply,
			built.reply,
		]);
		await built.session.prompt("Read the fixture skill.");
		await built.session.sendCustomMessage({ customType: "helper", content: "Helper finished.", display: false }, { triggerTurn: true, deliverAs: "steer" });
		await built.session.prompt("Continue using the same skill.");
		expect(built.requests).toHaveLength(5);
		const prompts = built.requests.map(request => getCurrentSystemPrompt(request.messages));
		// One identical system prompt across normal, tool, idle, and next-user
		// requests, always carrying the general block.
		expect(new Set(prompts).size).toBe(1);
		expectSystemBlock(prompts[0]);
		for (const request of built.requests.slice(1)) {
			const bodies = request.messages.map(textOf).filter(text => text.includes(BODY));
			expect(bodies).toHaveLength(1);
			expectDirsOnlyBody(bodies[0], built);
		}
	} finally {
		built.cleanup();
	}
});

it.each(["/skill:fixture", "/skill:fixture Keep this request."])("delivers dirs-only context on a single skill command: %s", async prompt => {
	const built = await fixture();
	try {
		built.faux.setResponses([built.reply]);
		await built.session.prompt(prompt);
		const bodies = built.session.messages.map(textOf).filter(text => text.includes(BODY));
		expect(bodies).toHaveLength(1);
		expectDirsOnlyBody(bodies[0], built);
		if (prompt.includes("Keep this request.")) expect(bodies[0]).toContain("Keep this request.");
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

it("marks unevaluated command placeholders as skipped in a skill command", async () => {
	const built = await fixture("# Fixture skill\nDynamic value: !`printf PLACEHOLDER_EXECUTED`");
	try {
		built.faux.setResponses([built.reply]);
		await built.session.prompt("/skill:fixture");
		const text = built.requests[0].messages.map(textOf).join("\n");
		expect(text).toContain("[dynamic shell skipped: passive reference injection]");
		expect(text).not.toContain("!`printf PLACEHOLDER_EXECUTED`");
		// The shell rule that explains the skipped notice lives at system level.
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});

it.each(["read", "command"])("keeps authored context examples without skipping guidance on %s", async route => {
	const authored = `${BODY}\n\nExample: <skill_context>authored example</skill_context>.`;
	const built = await fixture(authored);
	try {
		built.faux.setResponses(route === "read"
			? [() => fauxAssistantMessage([fauxToolCall("read", { path: built.skillPath })]), built.reply]
			: [built.reply]);
		await built.session.prompt(route === "read" ? "Read the fixture skill." : "/skill:fixture");
		const text = built.requests[0].messages.map(textOf).join("\n");
		// The authored example stays verbatim and does not suppress our block:
		// the message carrying it still gains the dirs-only <skill_context>.
		expect(text).toContain(authored);
		const bodyMessage = built.requests[0].messages.map(textOf).find(text => text.includes(BODY));
		expect(bodyMessage).toBeDefined();
		expectDirsOnlyBody(bodyMessage!, built);
		expectSystemBlock(getCurrentSystemPrompt(built.requests[0].messages));
	} finally {
		built.cleanup();
	}
});
