import { describe, it, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Globs auto-injection through the registered tool_result handler. Structured
 * paths and bounded filename mentions in arbitrary commands/code participate,
 * without depending on tool identity. The harness persists final chained
 * messages so residency tests follow Pi's real delivery boundary.
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
};
type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;

async function loadExtension() {
	return (await import("../index")).default;
}

function makeFakePi(cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const sessionManager = SessionManager.inMemory(cwd);
	const ctx: FakeContext = {
		cwd,
		isProjectTrusted: () => true,
		hasUI: false,
		sessionManager,
	};
	const pi = {
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerMessageRenderer: () => {},
		sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
			// Idle Pi persists this row directly. It does not run extension message_end
			// handlers, so this deliberately bypasses the harness event dispatcher.
			sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
	return {
		pi,
		ctx,
		setSessionContext: (messages: unknown[]) => {
			sessionManager.newSession();
			for (const message of messages) sessionManager.appendMessage(message as PersistedMessage);
		},
		emit: async (event: string, payload: unknown) => {
			if (event === "tool_result") {
				let current = payload as ToolResultEvent;
				let modified = false;
				for (const handler of handlers.get(event) ?? []) {
					const result = (await handler(current, ctx)) as
						| { content?: TextBlock[]; details?: unknown; isError?: boolean; usage?: unknown }
						| undefined;
					if (!result) continue;
					if (result.content !== undefined) {
						current = { ...current, content: result.content };
						modified = true;
					}
					if (result.details !== undefined) {
						current = { ...current, details: result.details } as ToolResultEvent;
						modified = true;
					}
					if (result.isError !== undefined) {
						current = { ...current, isError: result.isError };
						modified = true;
					}
				}
				return modified
					? { content: current.content, details: (current as ToolResultEvent & { details?: unknown }).details, isError: current.isError }
					: undefined;
			}

			if (event === "message_end") {
				let currentMessage = (payload as { message: PersistedMessage }).message;
				let modified = false;
				for (const handler of handlers.get(event) ?? []) {
					const result = (await handler({ ...(payload as object), message: currentMessage }, ctx)) as
						| { message?: PersistedMessage }
						| undefined;
					if (!result?.message) continue;
					currentMessage = result.message;
					modified = true;
				}
				sessionManager.appendMessage(currentMessage);
				return modified ? { message: currentMessage } : undefined;
			}

			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
			return result;
		},
	};
}

async function setupProject(files: Record<string, string>) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-better-skills-globs-")));
	for (const [relative, content] of Object.entries(files)) {
		const full = join(root, relative);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, content, "utf-8");
	}
	const extension = await loadExtension();
	const { pi, ctx, setSessionContext, emit } = makeFakePi(root);
	(extension as (pi: unknown) => void)(pi);
	await emit("session_start", {});
	return { root, ctx, pi, setSessionContext, emit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

let nextToolCallId = 0;

function toolResult(toolName: string, input: Record<string, unknown>, text = "tool output"): ToolResultEvent {
	return {
		type: "tool_result",
		toolCallId: `call-${++nextToolCallId}`,
		toolName,
		input,
		content: [{ type: "text", text }],
		isError: false,
	};
}

async function deliverToolResult(project: { emit: (event: string, payload: unknown) => Promise<unknown> }, event: ToolResultEvent) {
	const result = await project.emit("tool_result", event);
	const deliveredContent =
		(result as { content?: TextBlock[] } | undefined)?.content ?? event.content;
	const deliveredIsError =
		(result as { isError?: boolean } | undefined)?.isError ?? event.isError;
	await project.emit("message_end", {
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			content: deliveredContent,
			isError: deliveredIsError,
			timestamp: Date.now(),
		},
	});
	return result;
}

function resultText(result: unknown): string {
	if (typeof result !== "object" || result === null || !Array.isArray((result as { content?: unknown }).content)) {
		return "";
	}
	return ((result as { content: TextBlock[] }).content ?? [])
		.map((block) => block.text)
		.join("\n");
}

const WIDGET_SKILL = `---
name: widget-patterns
description: Widget component conventions
globs: ["**/*.widget"]
---

Widget body marker.
`;

describe("globs auto-injection via arbitrary tools", () => {
	it("injects from a structured path key on a foreign tool result", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(project, toolResult("mcp__fs__view", { file_path: "src/Button.widget" }));
			expect(resultText(result)).toContain("Widget body marker.");
			expect(resultText(result)).toContain("tool output");
		} finally {
			project.cleanup();
		}
	});

	it("resolves a structured path key against a workdir base key", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(
				project,
				toolResult("mcp__fs__view", { file: "Button.widget", workdir: join(project.root, "src") }),
			);
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("still injects for the built-in read tool", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("can inject once from a bounded command string path mention", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			// Generic triggers intentionally retain filename mentions in arbitrary tool
			// input. Session residency still prevents later command mentions from
			// paying for the same body again.
			const listing = await deliverToolResult(project, toolResult("bash", { command: "ls -la src/Button.widget" }));
			expect(resultText(listing)).toContain("Widget body marker.");

			const counted = await deliverToolResult(project, toolResult("bash", { command: "grep -c . src/Button.widget" }));
			expect(counted).toBeUndefined();

			const foreign = await deliverToolResult(project, toolResult("exec_command", { command: "cat src/Button.widget" }));
			expect(foreign).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("lets write tool paths participate in globs matching", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(project, toolResult("write", { path: "src/Button.widget", content: "rewritten" }));
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("injects a skill once per session, not once per turn", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
			"src/Icon.widget": "icon content",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(first)).toContain("Widget body marker.");

			const second = await deliverToolResult(project, toolResult("read", { path: "src/Icon.widget" }));
			expect(second).toBeUndefined();

			// A later turn must not pay for the body again: the modified tool result
			// is persisted in session history, so the first copy is still in context.
			await project.emit("agent_end", {});
			const nextTurn = await deliverToolResult(project, toolResult("read", { path: "src/Icon.widget" }));
			expect(nextTurn).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("releases a reservation when a later tool_result handler truncates delivery", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const firstEvent = toolResult("read", { path: "src/Button.widget" });
			project.pi.on("tool_result", async (event) => {
				const current = event as ToolResultEvent;
				if (current.toolCallId !== firstEvent.toolCallId) return;
				return { content: [{ type: "text", text: "replacement output" }] };
			});

			const altered = await deliverToolResult(project, firstEvent);
			expect(resultText(altered)).toBe("replacement output");

			const retry = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(retry)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("reconciles persisted content after a later message_end handler removes the body", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const firstEvent = toolResult("read", { path: "src/Button.widget" });
			project.pi.on("message_end", async (event) => {
				const message = (event as { message: { role: string; toolCallId?: string } }).message;
				if (message.role !== "toolResult" || message.toolCallId !== firstEvent.toolCallId) return;
				return {
					message: {
						...(event as { message: Record<string, unknown> }).message,
						content: [{ type: "text", text: "replacement output" }],
					},
				};
			});

			const altered = await deliverToolResult(project, firstEvent);
			expect(resultText(altered)).toContain("Widget body marker.");

			const retry = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(retry)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("releases an in-flight reservation when the run ends before message delivery", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const first = toolResult("read", { path: "src/Button.widget" });
			const pending = await project.emit("tool_result", first);
			expect(resultText(pending)).toContain("Widget body marker.");

			await project.emit("agent_end", {});
			const retry = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(retry)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("does not commit a reservation when a later handler marks the delivered result as an error", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const firstEvent = toolResult("read", { path: "src/Button.widget" });
			project.pi.on("tool_result", async (event) => {
				const current = event as ToolResultEvent;
				if (current.toolCallId === firstEvent.toolCallId) return { isError: true };
			});

			const failed = await deliverToolResult(project, firstEvent);
			expect(resultText(failed)).toContain("Widget body marker.");

			const retry = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(retry)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("does not mark a truncated SKILL.md read as a complete resident body", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const skillPath = join(project.root, ".pi/skills/widget-patterns/SKILL.md");
			const partial = await deliverToolResult(project, toolResult("read", { path: skillPath, limit: 1 }, "---"));
			expect(resultText(partial)).not.toContain("Widget body marker.");

			const complete = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(complete)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("re-injects after compaction summarizes the body out of context", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(first)).toContain("Widget body marker.");

			// Real compaction: kept messages start after the delivered result.
			const manager = project.ctx.sessionManager;
			manager.appendMessage({ role: "user", content: "next turn", timestamp: Date.now() });
			const cutoff = manager.getEntries().at(-1)?.id;
			if (!cutoff) throw new Error("no entry for compaction cutoff");
			manager.appendCompaction("Summary without the body.", cutoff, 1000);
			await project.emit("session_compact", {});

			const afterCompact = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(afterCompact)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("keeps residency after compaction when the body remains in context", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
			"src/Icon.widget": "icon content",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(first)).toContain("Widget body marker.");

			// Real compaction that keeps the delivered result itself.
			const manager = project.ctx.sessionManager;
			const cutoff = manager
				.getEntries()
				.find((entry) => entry.type === "message" && "message" in entry && entry.message.role === "toolResult")?.id;
			if (!cutoff) throw new Error("no toolResult entry for compaction cutoff");
			manager.appendCompaction("Summary that keeps the delivered result.", cutoff, 1000);
			await project.emit("session_compact", {});

			const second = await deliverToolResult(project, toolResult("read", { path: "src/Icon.widget" }));
			expect(second).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("injects from a list-valued path key", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(
				project,
				toolResult("mcp__fs__read_multiple_files", { paths: ["README.md", "src/Button.widget"] }),
			);
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("does not inject a skill the user already loaded with /skill:name", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			// pi core expands an ordinary leading `/skill:name` itself, so the body is
			// in context even though this extension declines to rewrite the prompt.
			await project.emit("input", { source: "user", text: "/skill:widget-patterns build the button" });
			await project.emit("message_end", {
				type: "message_end",
				message: {
					role: "user",
					content:
						'<skill name="widget-patterns" location="' +
						join(project.root, ".pi/skills/widget-patterns/SKILL.md") +
						'">\nReferences are relative to ' +
						join(project.root, ".pi/skills/widget-patterns") +
						'.\n\nWidget body marker.\n</skill>\n\nbuild the button',
				},
			});

			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("does not mark an intercepted slash-skill command as resident", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			project.pi.on("input", async () => ({ action: "handled" }));
			await project.emit("input", { source: "user", text: "/skill:widget-patterns build the button" });

			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("does not mark an intercepted streaming skill prompt as resident", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			project.pi.on("input", async () => ({ action: "handled" }));
			await project.emit("input", {
				source: "interactive",
				text: "use /skill:widget-patterns",
				streamingBehavior: "steer",
			});

			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(result)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("deduplicates after a streaming skill prompt is actually delivered", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const transformed = (await project.emit("input", {
				source: "interactive",
				text: "use /skill:widget-patterns",
				streamingBehavior: "steer",
			})) as { action?: string; text?: string };
			expect(transformed.action).toBe("transform");
			expect(transformed.text ?? "").toContain("Widget body marker.");

			await project.emit("message_end", {
				type: "message_end",
				message: { role: "user", content: transformed.text ?? "" },
			});

			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("deduplicates an idle sendMessage skill row from persisted context", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const transformed = (await project.emit("input", {
				source: "user",
				text: "use /skill:widget-patterns before building the button",
			})) as { action?: string; text?: string };
			expect(transformed.action).toBe("transform");
			expect(transformed.text ?? "").toContain("widget-patterns");

			// No synthetic extension message_end is emitted here. The fake Pi has
			// already persisted the custom skill row through sendMessage().
			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("reconciles residency from a resumed session context", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			// Realistic resumed history: a persisted /skill expansion carries the
			// skill-name anchor that residency attribution requires.
			project.setSessionContext([
				{
					role: "user",
					content:
						'<skill name="widget-patterns" location="' +
						join(project.root, ".pi/skills/widget-patterns/SKILL.md") +
						'">\nReferences are relative to ' +
						join(project.root, ".pi/skills/widget-patterns") +
						'.\n\nWidget body marker.\n</skill>',
					timestamp: Date.now(),
				},
			]);
			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("restores a body after tree navigation removes it from the active branch", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
			"src/Icon.widget": "icon content",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(resultText(first)).toContain("Widget body marker.");

			// Real navigation to the session root: the delivered result leaves
			// the active branch, exactly like /tree on the first user message.
			const manager = project.ctx.sessionManager;
			manager.resetLeaf();
			await project.emit("session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: null });

			const restored = await deliverToolResult(project, toolResult("read", { path: "src/Icon.widget" }));
			expect(resultText(restored)).toContain("Widget body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("prepends a body once when one matching skill references another", async () => {
		const project = await setupProject({
			".pi/skills/a-parent/SKILL.md": `---
name: a-parent
description: Parent conventions
globs: ["**/*.widget"]
---

Parent body. See \`/b-child\` for details.
`,
			".pi/skills/b-child/SKILL.md": `---
name: b-child
description: Child conventions
globs: ["**/*.widget"]
---

Child body marker.
`,
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			const text = resultText(result);
			expect(text).toContain("Parent body.");
			// The child matches the glob and is also a backticked reference of the
			// parent. It must arrive once, not once per route.
			expect(text.split("Child body marker.").length - 1).toBe(1);
		} finally {
			project.cleanup();
		}
	});

	it("requires candidates to exist on disk", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
		});
		try {
			const result = await deliverToolResult(project, toolResult("mcp__fs__view", { file_path: "src/Missing.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("never injects on error results", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
		});
		try {
			const event = toolResult("mcp__fs__view", { file_path: "src/Button.widget" });
			event.isError = true;
			const result = await deliverToolResult(project, event);
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("skips skills with disable-model-invocation", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL.replace('globs: ["**/*.widget"]', 'globs: ["**/*.widget"]\ndisable-model-invocation: true'),
			"src/Button.widget": "button content",
		});
		try {
			const result = await deliverToolResult(project, toolResult("read", { path: "src/Button.widget" }));
			expect(result).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("trusts bare filename reads through a path key but not through a command string", async () => {
		const project = await setupProject({
			".pi/skills/docker-tips/SKILL.md": `---
name: docker-tips
description: Dockerfile conventions
globs: "Dockerfile*"
---

Docker tips marker.
`,
			"Dockerfile": "FROM node:22",
		});
		try {
			const viaCommand = await deliverToolResult(project, toolResult("exec_command", { command: "cat Dockerfile" }));
			expect(viaCommand).toBeUndefined();

			const viaRead = await deliverToolResult(project, toolResult("read", { path: "Dockerfile" }));
			expect(resultText(viaRead)).toContain("Docker tips marker.");
		} finally {
			project.cleanup();
		}
	});

	it("still enriches a direct SKILL.md read through a foreign tool", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
		});
		try {
			const skillPath = join(project.root, ".pi/skills/widget-patterns/SKILL.md");
			const result = await deliverToolResult(project, toolResult("exec_command", { command: `cat ${skillPath}` }, "Widget body marker."));
			expect(resultText(result)).toContain("<skill_context>");
		} finally {
			project.cleanup();
		}
	});
});

describe("parallel final message delivery", () => {
	it("keeps reservations while a later message-end handler delays persistence", async () => {
		const project = await setupProject({
			".pi/skills/widget-patterns/SKILL.md": WIDGET_SKILL,
			"src/Button.widget": "button content",
			"src/Icon.widget": "icon content",
		});
		const firstEvent = toolResult("read", { path: "src/Button.widget" });
		let unblock = () => {};
		let reached = () => {};
		const blocked = new Promise<void>((resolve) => { unblock = resolve; });
		const handlerReached = new Promise<void>((resolve) => { reached = resolve; });
		project.pi.on("message_end", async (event) => {
			const message = (event as { message: { toolCallId?: string } }).message;
			if (message.toolCallId === firstEvent.toolCallId) {
				reached();
				await blocked;
			}
		});
		const first = deliverToolResult(project, firstEvent);
		try {
			await handlerReached;
			const second = await deliverToolResult(project, toolResult("read", { path: "src/Icon.widget" }));
			expect(resultText(second)).not.toContain("Widget body marker.");
			unblock();
			expect(resultText(await first)).toContain("Widget body marker.");
			const third = await deliverToolResult(project, toolResult("read", { path: "src/Icon.widget" }));
			expect(third).toBeUndefined();
		} finally {
			unblock();
			await first;
			project.cleanup();
		}
	});
});

describe("skill references in multi-block tool results", () => {
	it("appends a shared referenced child only once when a prepend claims it first", async () => {
		const parentBody = "---\nname: parent\ndescription: Parent guidance\n---\nParent marker. See \`/child\`.\n";
		const childBody = "---\nname: child\ndescription: Child guidance\n---\nChild marker.\n";
		const globbyBody = '---\nname: globby\ndescription: Glob guidance\nglobs: ["**/*.md"]\n---\nGlob marker. See \`/child\`.\n';
		const project = await setupProject({
			".pi/skills/parent/SKILL.md": parentBody,
			".pi/skills/child/SKILL.md": childBody,
			".pi/skills/globby/SKILL.md": globbyBody,
		});
		try {
			// The direct read of parent also names a .md path, so globby is
			// prepended in the same plan. Both reference /child: the child
			// body must be delivered exactly once (nested in the prepend).
			const skillPath = join(project.root, ".pi/skills/parent/SKILL.md");
			const result = await deliverToolResult(project, toolResult("read", { path: skillPath }, parentBody));
			const text = resultText(result);
			expect(text.split("Child marker.").length - 1).toBe(1);
			expect(text).toContain("Parent marker.");
			expect(text).toContain("Glob marker.");
		} finally {
			project.cleanup();
		}
	});

	it("loads siblings from the skill body after notebook status blocks and deduplicates later reads", async () => {
		const parentBody = "---\nname: notebook-parent\ndescription: Parent guidance\n---\nParent marker. See `/notebook-child`.\n";
		const childBody = "---\nname: notebook-child\ndescription: Child guidance\n---\nNotebook child marker.\n";
		const project = await setupProject({
			".pi/skills/notebook-parent/SKILL.md": parentBody,
			".pi/skills/notebook-child/SKILL.md": childBody,
		});
		try {
			const skillPath = join(project.root, ".pi/skills/notebook-parent/SKILL.md");
			const first = toolResult("exec", { code: "text(await Deno.readTextFile(" + JSON.stringify(skillPath) + "));" });
			first.content = [
				{ type: "text", text: "Script completed" },
				{ type: "text", text: "Notebook startup information" },
				{ type: "text", text: parentBody },
			];
			const result = await deliverToolResult(project, first);
			expect(resultText(result).split("Notebook child marker.").length - 1).toBe(1);
			// Issue 9: the body-bearing block is the decorated one; status blocks
			// stay verbatim and the context lands after the frontmatter.
			expect(resultText(result)).toContain(
				"---\nname: notebook-parent\ndescription: Parent guidance\n---\n\n<skill_context>",
			);
			expect(resultText(result)).toContain("Parent marker. See `/notebook-child`.");
			expect(resultText(result).startsWith("Script completed")).toBe(true);

			const second = toolResult("exec", first.input);
			second.content = [{ type: "text", text: "Script completed" }, { type: "text", text: parentBody }];
			const repeated = await deliverToolResult(project, second);
			expect(resultText(repeated)).not.toContain("Notebook child marker.");
		} finally {
			project.cleanup();
		}
	});
});

describe("skill-identity residency collisions", () => {
	it("injects a second skill whose body is identical to an already delivered one", async () => {
		const body = "Identical body marker.\nSame text, different skill roots.\n";
		const project = await setupProject({
			".pi/skills/alpha-dup/SKILL.md": `---\nname: alpha-dup\ndescription: Alpha duplicate\nglobs: ["**/*.alpha"]\n---\n\n${body}`,
			".pi/skills/beta-dup/SKILL.md": `---\nname: beta-dup\ndescription: Beta duplicate\nglobs: ["**/*.beta"]\n---\n\n${body}`,
			"src/a.alpha": "alpha content",
			"src/b.beta": "beta content",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/a.alpha" }));
			expect(resultText(first)).toContain("Identical body marker.");

			const second = await deliverToolResult(project, toolResult("read", { path: "src/b.beta" }));
			expect(resultText(second)).toContain("Identical body marker.");
		} finally {
			project.cleanup();
		}
	});

	it("injects a skill whose body is contained in another delivered body", async () => {
		const shortBody = "Shared core marker.\n";
		const longBody = "Shared core marker.\nAlpha-only superset guidance lives here.\n";
		const project = await setupProject({
			".pi/skills/super-set/SKILL.md": `---\nname: super-set\ndescription: Superset skill\nglobs: ["**/*.super"]\n---\n\n${longBody}`,
			".pi/skills/sub-set/SKILL.md": `---\nname: sub-set\ndescription: Subset skill\nglobs: ["**/*.sub"]\n---\n\n${shortBody}`,
			"src/full.super": "super content",
			"src/part.sub": "sub content",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/full.super" }));
			expect(resultText(first)).toContain("Alpha-only superset guidance");

			const second = await deliverToolResult(project, toolResult("read", { path: "src/part.sub" }));
			expect(resultText(second)).toContain("Shared core marker.");
		} finally {
			project.cleanup();
		}
	});

	it("does not let incomplete skill anchors borrow a body from a later message", async () => {
		const body = "Borrowed body marker.\n";
		for (const anchorKind of ["context", "wrapper"] as const) {
			const project = await setupProject({
				".pi/skills/borrow-skill/SKILL.md": `---\nname: borrow-skill\ndescription: Borrow conventions\nglobs: ["**/*.borrow"]\n---\n\n${body}`,
				"src/one.borrow": "borrow content",
			});
			try {
				const skillPath = join(project.root, ".pi/skills/borrow-skill/SKILL.md");
				const anchor =
					anchorKind === "context"
						? `<skill_context>\n  <skill_dir>${dirname(skillPath)}</skill_dir>\n</skill_context>`
						: `<skill name="borrow-skill" location="${skillPath}">\nReferences are relative to ${dirname(skillPath)}.\n\n[truncated]`;
				project.setSessionContext([
					{
						role: "toolResult",
						toolCallId: `${anchorKind}-anchor`,
						toolName: "read",
						content: [{ type: "text", text: anchor }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "assistant", content: [{ type: "text", text: body }], timestamp: Date.now() },
				]);

				const result = await deliverToolResult(project, toolResult("read", { path: "src/one.borrow" }));
				expect(resultText(result)).toContain(body.trim());
			} finally {
				project.cleanup();
			}
		}
	});

	it("keeps residency when a skill body contains anchor-like text", async () => {
		const body = 'Doc marker head.\nExample wrapper: <skill name="ghost" location="/x/SKILL.md">\nDoc marker tail.\n';
		const project = await setupProject({
			".pi/skills/doc-skill/SKILL.md": `---\nname: doc-skill\ndescription: Documents wrapper syntax\nglobs: ["**/*.doc"]\n---\n\n${body}`,
			"src/one.doc": "one",
			"src/two.doc": "two",
		});
		try {
			const first = await deliverToolResult(project, toolResult("read", { path: "src/one.doc" }));
			expect(resultText(first)).toContain("Doc marker tail.");

			const second = await deliverToolResult(project, toolResult("read", { path: "src/two.doc" }));
			expect(second).toBeUndefined();
		} finally {
			project.cleanup();
		}
	});

	it("does not attribute a literal wrapper to a loaded skill at another location", async () => {
		const betaBody = "Beta required body.\n";
		const project = await setupProject({
			".pi/skills/alpha-skill/SKILL.md": `---\nname: alpha-skill\ndescription: Alpha conventions\nglobs: ["**/*.alpha"]\n---\n\nAlpha body.\nExample: <skill name="beta-skill" location="/example/beta/SKILL.md">\n${betaBody}</skill>\n`,
			".pi/skills/beta-skill/SKILL.md": `---\nname: beta-skill\ndescription: Beta conventions\nglobs: ["**/*.beta"]\n---\n\n${betaBody}`,
			"src/one.alpha": "alpha",
			"src/two.beta": "beta",
		});
		try {
			const alpha = await deliverToolResult(project, toolResult("read", { path: "src/one.alpha" }));
			expect(resultText(alpha)).toContain("Alpha body.");

			const beta = await deliverToolResult(project, toolResult("read", { path: "src/two.beta" }));
			expect(resultText(beta)).toContain(join(project.root, ".pi/skills/beta-skill"));
		} finally {
			project.cleanup();
		}
	});

	it("does not count an unanchored persisted body as resident", async () => {
		const body = "Unanchored body marker.\n";
		const project = await setupProject({
			".pi/skills/unanchored-skill/SKILL.md": `---\nname: unanchored-skill\ndescription: Unanchored conventions\nglobs: ["**/*.unanchored"]\n---\n\n${body}`,
			"src/one.unanchored": "content",
		});
		try {
			project.setSessionContext([{ role: "assistant", content: [{ type: "text", text: body }], timestamp: Date.now() }]);

			const result = await deliverToolResult(project, toolResult("read", { path: "src/one.unanchored" }));
			expect(resultText(result)).toContain(body.trim());
		} finally {
			project.cleanup();
		}
	});
});
