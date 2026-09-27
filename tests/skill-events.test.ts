import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	createAgentSession, createEventBus, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type EventBus, type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxProviderHandle, type TranscriptContext } from "@earendil-works/pi-ai";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import extension from "../src/index";
import {
	SKILL_API_CHANNEL, type SkillApiDeliverReply, type SkillApiProbeReply, type SkillApiSuggestReply,
} from "../src/skill-events";

const PARENT = `---\nname: parent\ndescription: parent\n---\n\nParent instructions. Read \`/skill:child\`.\n`;
const CHILD = `---\nname: child\ndescription: child\n---\n\nChild instructions.\n`;

function writeSkill(root: string, name: string, text: string): string {
	const path = join(root, ".pi/skills", name, "SKILL.md");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

test("probe detects absence, lists versions, and ignores unsupported versions regardless of load order", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-events-")));
	try {
		const events = createEventBus();
		let reply: unknown;
		const probe = () => events.emit(SKILL_API_CHANNEL, { version: 1, operation: "probe", reply: (value: SkillApiProbeReply) => { reply = value; } });
		probe();
		expect(reply).toBeUndefined();
		const pi = fakePi(root, events);
		extension(pi.api as never);
		probe();
		expect(reply).toEqual({ version: 1, operation: "probe", available: true, versions: [1] });
		reply = undefined;
		events.emit(SKILL_API_CHANNEL, { version: 2, operation: "probe", reply: (value: unknown) => { reply = value; } });
		expect(reply).toBeUndefined();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("extension initialization fails when the required event bus is missing", () => {
	const pi = fakePi(tmpdir());
	// SAFETY: Deliberately violate the host contract to verify fail-fast initialization.
	expect(() => extension({ ...pi.api, events: undefined } as never)).toThrow(TypeError);
});

function fakePi(root: string, events = createEventBus()) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>();
	const sessionManager = SessionManager.inMemory(root);
	let providerFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	let idle = true;
	const ctx = { cwd: root, isProjectTrusted: () => true, isIdle: () => idle, hasUI: true, sessionManager, ui: {
		addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => { providerFactory = factory; },
		getEditorComponent: () => true,
	} };
	const sent: Array<{ content: string; details: { skills: Array<{ name: string }> }; options: unknown }> = [];
	const api = {
		events,
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerMessageRenderer: () => {},
		sendMessage: (message: { content: string; details: { skills: Array<{ name: string }> } }, options: unknown) => {
			sent.push({ ...message, options });
			// Like pi's idle sendCustomMessage path: the entry is appended before sendMessage returns.
			if (idle && options === undefined) sessionManager.appendCustomMessageEntry("skill", message.content, true, message.details);
		},
	};
	const emit = async (name: string, payload: unknown = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(payload, ctx);
		return result;
	};
	return {
		api, events, sent, sessionManager, emit,
		setIdle: (value: boolean) => { idle = value; },
		getProvider: () => providerFactory!({ getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) }),
		start: () => emit("session_start"),
		tree: () => emit("session_tree"),
		turnEnd: () => emit("turn_end"),
		turnStart: () => emit("turn_start"),
		request: (operation: string, fields: object = {}): unknown => {
			let reply: unknown;
			events.emit(SKILL_API_CHANNEL, { version: 1, operation, ...fields, reply: (value: unknown) => { reply = value; } });
			return reply;
		},
	};
}

test("malformed requests get no reply and send nothing", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-malformed-")));
	try {
		writeSkill(root, "child", CHILD);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		expect(pi.request("deliver")).toBeUndefined();
		expect(pi.request("deliver", { names: ["child", 3] })).toBeUndefined();
		expect(pi.request("suggest", { query: 3 })).toBeUndefined();
		expect(pi.request("unknown-operation")).toBeUndefined();
		let replied = false;
		pi.events.emit(SKILL_API_CHANNEL, { version: 1, operation: "probe" });
		pi.events.emit(SKILL_API_CHANNEL, { operation: "probe", reply: () => { replied = true; } });
		expect(replied).toBe(false);
		expect(pi.sent).toHaveLength(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("delivery before session_start reports every name unknown and sends nothing", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-early-")));
	try {
		writeSkill(root, "child", CHILD);
		const pi = fakePi(root);
		extension(pi.api as never);
		expect(pi.request("deliver", { names: ["child", "missing"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "unknown" }, { name: "missing", status: "unknown" }],
		});
		expect(pi.sent).toHaveLength(0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("idle delivery uses inline blocks, references, and persisted session residency", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-delivery-")));
	try {
		writeSkill(root, "parent", PARENT);
		writeSkill(root, "child", CHILD);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		expect(pi.request("deliver", { names: ["missing", "parent", "parent"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [
				{ name: "missing", status: "unknown" },
				{ name: "parent", status: "delivered" },
				{ name: "parent", status: "already-resident" },
			],
		});
		expect(pi.sent).toHaveLength(1);
		// Idle: Pi appends the message at once and starts no turn.
		expect(pi.sent[0].options).toBeUndefined();
		expect(pi.sent[0].details.skills.map((skill) => skill.name)).toEqual(["parent", "child"]);
		expect(pi.sent[0].content).toContain(`<skill_dir>${join(root, ".pi/skills/parent")}</skill_dir>`);
		expect(pi.sent[0].content).toContain(`<workspace_dir>${root}</workspace_dir>`);
		// A new request must detect the persisted message through the public session context APIs.
		expect(pi.request("deliver", { names: ["parent", "child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [
				{ name: "parent", status: "already-resident" },
				{ name: "child", status: "already-resident" },
			],
		});
		expect(pi.sent).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an idle delivery does not stay reserved on a branch without its message", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-idle-tree-")));
	try {
		writeSkill(root, "child", CHILD);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		const before = pi.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		// Navigate to a branch point before the stored skill message.
		pi.sessionManager.branch(before);
		await pi.tree();
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		expect(pi.sent).toHaveLength(2);
		expect(pi.sent[1].content).toContain("Child instructions.");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a streaming delivery is sent at turn_end and stays reserved until Pi persists it", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-pending-")));
	try {
		writeSkill(root, "child", CHILD);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		pi.setIdle(false);
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		expect(pi.sent).toHaveLength(0);
		await pi.turnEnd();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0].options).toEqual({ triggerTurn: false });
		expect(pi.sessionManager.getBranch().some((entry) => entry.type === "custom_message")).toBe(false);
		// Next turn, before Pi stores the message: still reserved.
		await pi.turnStart();
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "already-resident" }],
		});
		expect(pi.sent).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("API suggestions rank exactly like the main editor provider", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-suggest-")));
	// Hermetic discovery: user-level skills must not leak into the result.
	const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	try {
		const cwd = join(root, "workspace");
		for (const name of ["alpha", "alpine", "beta"]) {
			writeSkill(cwd, name, `---\nname: ${name}\ndescription: sample\n---\n\n${name} instructions.\n`);
		}
		const pi = fakePi(cwd);
		extension(pi.api as never);
		await pi.start();
		const provider = pi.getProvider();
		const main = await provider.getSuggestions(["use /skill:al"], 0, 13, { signal: new AbortController().signal });
		const result = pi.request("suggest", { query: "skill:al" }) as SkillApiSuggestReply;
		expect(result).toEqual({ version: 1, operation: "suggest", items: main!.items });
		expect(result.items.map((item) => item.value).sort()).toEqual(["skill:alpha", "skill:alpine"]);
		const all = await provider.getSuggestions(["use /"], 0, "use /".length, { signal: new AbortController().signal });
		const empty = pi.request("suggest", { query: "" }) as SkillApiSuggestReply;
		expect(empty).toEqual({ version: 1, operation: "suggest", items: all!.items });
		expect(empty.items.map((item) => item.value).sort()).toEqual(["skill:alpha", "skill:alpine", "skill:beta"]);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Real Pi session: exactly-once delivery through Pi's own agent loop and queues.
// Only the model is faux; the extension, event bus, session, and tools are real.
// ---------------------------------------------------------------------------

const MARKER = "UNIQUE_API_SKILL_MARKER";

type RealSession = {
	session: AgentSession;
	faux: FauxProviderHandle;
	requests: TranscriptContext[];
	skillPath: string;
	deliver: () => SkillApiDeliverReply | undefined;
	cleanup: () => void;
};

async function realSession(hookEvent?: "turn_end" | "agent_end", hookOutcomes: unknown[] = [], dynamicShell?: "trusted" | "untrusted", leadingPlaceholder?: boolean): Promise<RealSession> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-real-")));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	mkdirSync(cwd, { recursive: true });
	const dynamicBody = dynamicShell
		? leadingPlaceholder
			? `!\`echo leading-dyn\`\n\n${MARKER} instructions.\n\nBuild id: !\`echo dynamic-output\``
			: `${MARKER} instructions.\n\nBuild id: !\`echo dynamic-output\``
		: `${MARKER} instructions.`;
	const skillPath = writeSkill(cwd, "api-skill", `---\nname: api-skill\ndescription: API fixture\n---\n\n${dynamicBody}\n`);
	const previous = {
		HOME: process.env.HOME,
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_BETTER_SKILLS_NO_PI_DOCS: process.env.PI_BETTER_SKILLS_NO_PI_DOCS,
		PI_TRUST_PROJECT_SKILL_SHELL: process.env.PI_TRUST_PROJECT_SKILL_SHELL,
	};
	process.env.HOME = join(root, "home");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_BETTER_SKILLS_NO_PI_DOCS = "1";
	// Project skills are untrusted by default; "0" keeps the untrusted variant explicit.
	if (dynamicShell) process.env.PI_TRUST_PROJECT_SKILL_SHELL = dynamicShell === "trusted" ? "1" : "0";
	let session: AgentSession | undefined;
	const cleanup = () => {
		try {
			session?.dispose();
			rmSync(root, { recursive: true, force: true });
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
	try {
		let events: EventBus | undefined;
		const deliver = () => {
			let reply: SkillApiDeliverReply | undefined;
			events!.emit(SKILL_API_CHANNEL, { version: 1, operation: "deliver", names: ["api-skill"], reply: (value: SkillApiDeliverReply) => { reply = value; } });
			return reply;
		};
		// A consumer extension whose tool asks this extension to deliver the skill.
		const consumer = (pi: ExtensionAPI) => {
			events = pi.events;
			pi.registerTool({
				name: "deliver_skill", label: "deliver_skill", description: "Deliver api-skill", parameters: { type: "object", properties: {} } as never,
				execute: async () => ({ content: [{ type: "text", text: JSON.stringify(deliver()) }], details: {} }),
			});
			// Registered after the provider, so this handler runs after its turn_end flush.
			if (hookEvent) pi.on(hookEvent, async () => { hookOutcomes.push(deliver()?.outcomes); });
		};
		const faux = fauxProvider();
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
		runtime.registerNativeProvider(faux.provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
		const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension, consumer] });
		await loader.reload();
		const { session: created } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), modelRuntime: runtime, model: faux.getModel(), thinkingLevel: "off", tools: ["read", "deliver_skill"] });
		session = created;
		const errors: unknown[] = [];
		await created.bindExtensions({ onError: (error) => errors.push(error) });
		const requests: TranscriptContext[] = [];
		return {
			session: created, faux, requests, skillPath, deliver,
			cleanup: () => {
				try { expect(errors).toEqual([]); } finally { cleanup(); }
			},
		};
	} catch (error) {
		try { cleanup(); } finally { throw error; }
	}
}

/** Model-visible copies of the skill body in one provider request. */
function bodyCopies(context: TranscriptContext): number {
	return JSON.stringify(context.messages).split(`${MARKER} instructions.`).length - 1;
}

test("an API skill requested during an aborted response is delivered exactly once (real Pi loop)", async () => {
	const built = await realSession();
	try {
		built.faux.setResponses([
			() => {
				// Another extension asks for the skill while the response streams; the user then aborts.
				// An explicit abort stops Pi from draining its steering queue in this run.
				expect(built.deliver()?.outcomes).toEqual([{ name: "api-skill", status: "delivered" }]);
				void built.session.abort();
				return fauxAssistantMessage("partial");
			},
			(context) => { built.requests.push(structuredClone(context)); return fauxAssistantMessage("OK"); },
		]);
		await built.session.prompt("first");
		// Idle again: a repeat request must not submit a second copy.
		expect(built.deliver()?.outcomes).toEqual([{ name: "api-skill", status: "already-resident" }]);
		await built.session.prompt("second");
		expect(built.requests).toHaveLength(1);
		expect(bodyCopies(built.requests[0])).toBe(1);
	} finally {
		built.cleanup();
	}
});

test.each([
	{ label: "alone", siblingRead: false, dynamicShell: undefined, leadingPlaceholder: false },
	{ label: "with a parallel sibling read of SKILL.md", siblingRead: true, dynamicShell: undefined, leadingPlaceholder: false },
	{ label: "with a parallel sibling read of a trusted dynamic SKILL.md", siblingRead: true, dynamicShell: "trusted", leadingPlaceholder: false },
	{ label: "with a parallel sibling read of an explicitly untrusted dynamic SKILL.md", siblingRead: true, dynamicShell: "untrusted", leadingPlaceholder: false },
	{ label: "with a parallel sibling read of a trusted dynamic SKILL.md leading with a placeholder", siblingRead: true, dynamicShell: "trusted", leadingPlaceholder: true },
])("a tool-call delivery $label reaches the next response once (real Pi loop)", async ({ siblingRead, dynamicShell, leadingPlaceholder }) => {
	const built = await realSession(undefined, [], dynamicShell, leadingPlaceholder);
	try {
		built.faux.setResponses([
			() => fauxAssistantMessage([
				fauxToolCall("deliver_skill", {}),
				...(siblingRead ? [fauxToolCall("read", { path: built.skillPath })] : []),
			]),
			(context) => { built.requests.push(structuredClone(context)); return fauxAssistantMessage("OK"); },
		]);
		await built.session.prompt("load the skill");
		expect(built.requests).toHaveLength(1);
		expect(bodyCopies(built.requests[0])).toBe(1);
		// The surviving copy is the sibling read's decorated result, not the queued passive copy.
		if (dynamicShell) {
			const requestText = JSON.stringify(built.requests[0]);
			expect(requestText).toContain("Build id:");
			expect(requestText).not.toContain("[dynamic shell skipped: passive reference injection]");
			if (dynamicShell === "trusted") expect(requestText).toContain("Build id: dynamic-output");
			else expect(requestText).toContain("[dynamic shell skipped: untrusted skill root]");
			if (leadingPlaceholder) expect(requestText).toContain("leading-dyn");
		}
		// The skill stays resident for later requests.
		expect(built.deliver()?.outcomes).toEqual([{ name: "api-skill", status: "already-resident" }]);
	} finally {
		built.cleanup();
	}
});

test.each(["turn_end", "agent_end"] as const)("deliver from a later extension's %s handler is rejected as unknown (real Pi loop)", async (hookEvent) => {
	const outcomes: unknown[] = [];
	const built = await realSession(hookEvent, outcomes);
	try {
		built.faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("read", { path: join(built.session.sessionManager.getCwd(), "missing.txt") })]),
			(context) => { built.requests.push(structuredClone(context)); return fauxAssistantMessage("OK"); },
			(context) => { built.requests.push(structuredClone(context)); return fauxAssistantMessage("OK"); },
		]);
		await built.session.prompt("first");
		expect(outcomes.length).toBeGreaterThan(0);
		for (const outcome of outcomes) expect(outcome).toEqual([{ name: "api-skill", status: "unknown" }]);
		// Nothing was sent: no stored skill message, and the next prompt carries no body.
		expect(built.session.sessionManager.getBranch().some((entry) => entry.type === "custom_message")).toBe(false);
		await built.session.prompt("second");
		expect(built.requests.every((request) => bodyCopies(request) === 0)).toBe(true);
		// Idle delivery still works afterwards.
		expect(built.deliver()?.outcomes).toEqual([{ name: "api-skill", status: "delivered" }]);
	} finally {
		built.cleanup();
	}
});

// ---------------------------------------------------------------------------
// Transformed-body residency: a decorated read whose dynamic shell placeholders
// were executed or skipped satisfies the queued API delivery, but only while
// that transformed result persists on the branch.
// ---------------------------------------------------------------------------

function textOf(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

test("a trusted dynamic read satisfies the queued delivery only while its result persists", async () => {
	const previous = process.env.PI_TRUST_PROJECT_SKILL_SHELL;
	process.env.PI_TRUST_PROJECT_SKILL_SHELL = "1";
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-dynamic-residency-")));
	try {
		const path = writeSkill(root, "child", `---\nname: child\ndescription: child\n---\n\nChild instructions.\n\nBuild id: !\`echo dyn-42\`\n`);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		const before = pi.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// Streaming turn: the API delivery queues while a sibling read executes.
		pi.setIdle(false);
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		const callId = "call-read-1";
		pi.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "read", arguments: { path } }],
			timestamp: Date.now(),
		} as never);
		await pi.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: callId, input: { path } });
		const raw = readFileSync(path, "utf-8");
		const replaced = (await pi.emit("tool_result", {
			type: "tool_result", toolCallId: callId, toolName: "read", input: { path },
			content: [{ type: "text", text: raw }], isError: false,
		})) as { content: Array<{ type: string; text?: string }> } | undefined;
		const persisted = replaced?.content ?? [{ type: "text", text: raw }];
		expect(textOf(persisted)).toContain("Build id: dyn-42");
		// Persist exactly what the tool_result chain produced, like pi does.
		pi.sessionManager.appendMessage({
			role: "toolResult", toolCallId: callId, toolName: "read", content: persisted, isError: false, timestamp: Date.now(),
		} as never);
		// The executed body in the persisted result satisfies residency: no queued copy flushes.
		await pi.turnEnd();
		expect(pi.sent).toHaveLength(0);
		pi.setIdle(true);
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "already-resident" }],
		});
		expect(pi.sent).toHaveLength(0);
		// Once the read result leaves the branch, the skill is offered again.
		pi.sessionManager.branch(before);
		await pi.tree();
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0].content).toContain("Child instructions.");
	} finally {
		if (previous === undefined) delete process.env.PI_TRUST_PROJECT_SKILL_SHELL;
		else process.env.PI_TRUST_PROJECT_SKILL_SHELL = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

test.each(["replaced", "incomplete", "error"] as const)("%s transformed results do not suppress the queued delivery", async (resultKind) => {
	const previous = process.env.PI_TRUST_PROJECT_SKILL_SHELL;
	process.env.PI_TRUST_PROJECT_SKILL_SHELL = "1";
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pbs-dynamic-replaced-")));
	try {
		const prefix = "---\nname: child\ndescription: child\n---\n\nChild instructions.\n\nBuild id: !`echo dyn-42`";
		const tail = "Required final instructions.";
		const path = writeSkill(root, "child", prefix + "\n" + tail);
		const pi = fakePi(root);
		extension(pi.api as never);
		await pi.start();
		pi.setIdle(false);
		expect(pi.request("deliver", { names: ["child"] })).toEqual({
			version: 1, operation: "deliver", outcomes: [{ name: "child", status: "delivered" }],
		});
		const callId = "call-read-1";
		// The complete body spans text blocks. A later handler may retain the
		// decorated first block while removing required instructions in the tail.
		const result = await pi.emit("tool_result", {
			type: "tool_result", toolCallId: callId, toolName: "read", input: { path },
			content: [{ type: "text", text: prefix }, { type: "text", text: tail }], isError: false,
		});
		// SAFETY: tool_result is the registered delivery handler, which returns text blocks for this text-only fixture.
		const delivered = result as { content: Array<{ type: "text"; text: string }> };
		expect(textOf(delivered.content)).toContain("Build id: dyn-42");
		expect(textOf(delivered.content)).toContain(tail);
		const persisted = resultKind === "replaced"
			? [{ type: "text" as const, text: "replaced by a later handler: body gone" }]
			: resultKind === "incomplete" ? delivered.content.slice(0, 1) : delivered.content;
		// Persist the final chain output, not the content our handler proposed.
		pi.sessionManager.appendMessage({
			role: "toolResult", toolCallId: callId, toolName: "read", content: persisted,
			isError: resultKind === "error", timestamp: Date.now(),
		});
		await pi.turnEnd();
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0].content).toContain("Child instructions.");
		expect(pi.sent[0].content).toContain(tail);
	} finally {
		if (previous === undefined) delete process.env.PI_TRUST_PROJECT_SKILL_SHELL;
		else process.env.PI_TRUST_PROJECT_SKILL_SHELL = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
