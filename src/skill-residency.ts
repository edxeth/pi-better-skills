import { buildSessionContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { contentText, normalizeSkillText, skillDocument, type SkillCatalog, type SkillDocument, type SkillRecord } from "./skill-catalog";

/**
 * Residency: persisted evidence that a skill body is in the transcript, plus
 * the in-flight reservations that keep parallel deliveries from appending the
 * same body twice. Reconciliation is anchor-first: each anchor resolves to the
 * catalog records it can own, and only those records' cached bodies are
 * validated. Results this extension transformed at delivery carry exact
 * recorded evidence instead (see recordDeliveredResult). Full-context
 * reconstruction stays for session load, compaction, tree navigation, and leaf
 * changes.
 */

export type SkillResidency = ReturnType<typeof createSkillResidency>;

type SessionContextMessage = ReturnType<typeof buildSessionContext>["messages"][number];

type ResidencyAnchor =
	| { kind: "directory"; directory: string; start: number; end: number }
	| { kind: "wrapper"; name: string; location: string; start: number; end: number };

type ResidencyMessage = { text: string; anchors: ResidencyAnchor[]; toolCallId?: string };

function sessionMessageText(message: SessionContextMessage): string {
	if (message.role === "toolResult" && message.isError) return "";
	if ("content" in message) return contentText(message.content);
	if ("summary" in message) return message.summary;
	return "";
}

function residencyMessage(message: SessionContextMessage): ResidencyMessage | undefined {
	const text = normalizeSkillText(sessionMessageText(message));
	if (!text) return undefined;
	const anchors: ResidencyAnchor[] = [];
	for (const match of text.matchAll(/<skill_context> <skill_dir>([^<]+)<\/skill_dir>|<skill\b([^>]*)>/g)) {
		if (match.index === undefined) continue;
		const start = match.index;
		const end = start + match[0].length;
		if (match[1] !== undefined) {
			anchors.push({ kind: "directory", directory: match[1], start, end });
			continue;
		}
		const attributes = match[2] ?? "";
		const nameMatch = attributes.match(/\bname=(?:"([^"]+)"|'([^']+)')/);
		const locationMatch = attributes.match(/\blocation=(?:"([^"]+)"|'([^']+)')/);
		const name = nameMatch?.[1] ?? nameMatch?.[2];
		const location = locationMatch?.[1] ?? locationMatch?.[2];
		if (name !== undefined && location !== undefined) {
			anchors.push({ kind: "wrapper", name, location, start, end });
		}
	}
	return { text, anchors, toolCallId: message.role === "toolResult" ? message.toolCallId : undefined };
}

export function createSkillResidency(catalog: SkillCatalog) {
	let injectedSkillNames = new Set<string>();
	let reservedSkillNames = new Set<string>();
	let queuedSkillNames = new Set<string>();
	// Exact evidence for results this extension transformed at delivery: the
	// complete result text produced for a confirmed complete skill body, keyed
	// by tool call. Credit still requires the persisted non-error result with
	// that id to contain the recorded text and the source body to be unchanged,
	// so replaced or removed results cannot keep a claim alive. Entries survive
	// branch moves within the session and clear only with the session.
	let deliveredResults = new Map<string, { name: string; filePath: string; bodySnapshot: string; text: string }>();
	let reservationsByToolCall = new Map<string, Set<string>>();
	let reconciledSessionId: string | undefined;
	let reconciledLeafId: string | null | undefined;
	let reconciledSkills: Map<string, SkillRecord> | undefined;
	let activeSkill: SkillRecord | undefined;

	function hasKnown(name: string): boolean {
		return injectedSkillNames.has(name) || reservedSkillNames.has(name);
	}

	function reserve(name: string): boolean {
		if (hasKnown(name)) return false;
		reservedSkillNames.add(name);
		return true;
	}

	/**
	 * An API delivery owns its reservation until its skill message persists or
	 * the session is replaced. Turn, run, compaction, and tree resets keep it:
	 * the message can still be waiting in Pi's pending queue at those points.
	 */
	function reserveQueued(name: string): boolean {
		if (!reserve(name)) return false;
		queuedSkillNames.add(name);
		return true;
	}

	function isQueued(name: string): boolean {
		return queuedSkillNames.has(name);
	}

	/** Record what delivery actually produced for one complete skill result. */
	function recordDeliveredResult(toolCallId: string, name: string, doc: SkillDocument, text: string): void {
		deliveredResults.set(toolCallId, { name, filePath: doc.filePath, bodySnapshot: doc.body, text });
	}

	function releaseSkills(names: Iterable<string>): void {
		for (const name of names) reservedSkillNames.delete(name);
	}

	/** Release transient tool-result reservations; API deliveries keep theirs (see reserveQueued). */
	function releaseAll(): void {
		reservationsByToolCall = new Map();
		reservedSkillNames = new Set(queuedSkillNames);
	}

	function releaseToolCall(toolCallId: string): void {
		const names = reservationsByToolCall.get(toolCallId);
		reservationsByToolCall.delete(toolCallId);
		if (names) releaseSkills(names);
	}

	/** Store the reservations a delivered tool result owns until it persists. */
	function persistReservations(toolCallId: string, names: Set<string>): void {
		reservationsByToolCall.set(toolCallId, names);
	}

	/** Catalog changes invalidate the reconciliation fast path. */
	function invalidate(): void {
		reconciledSessionId = undefined;
	}

	function clear(): void {
		queuedSkillNames = new Set();
		deliveredResults = new Map();
		releaseAll();
		injectedSkillNames = new Set();
		activeSkill = undefined;
		invalidate();
	}

	function reconcile(ctx: ExtensionContext, resetTransient = false): void {
		const sessionId = ctx.sessionManager.getSessionId();
		const leafId = ctx.sessionManager.getLeafId();
		const unchanged =
			!resetTransient &&
			reconciledSessionId === sessionId &&
			reconciledLeafId === leafId &&
			reconciledSkills === catalog.skills;
		if (unchanged) return;

		if (resetTransient) {
			releaseAll();
			activeSkill = undefined;
		}

		const context = buildSessionContext(ctx.sessionManager.getBranch(), leafId);
		// Only persisted results end reservations. A message_end handler can await
		// or replace content, so releasing inside that chain reopens a parallel race.
		for (const message of context.messages) {
			if (message.role === "toolResult") releaseToolCall(message.toolCallId);
		}
		// Evidence stays inside one persisted message. This prevents an incomplete
		// anchor from claiming a matching body that appears in a later message.
		const messages = context.messages
			.map(residencyMessage)
			.filter((message): message is ResidencyMessage => message !== undefined);

		// Anchor-first matching: resolve each anchor to the catalog records it
		// can own (wrapper anchors bind name+location to one record; directory
		// anchors bind every skill rooted in that directory, normally one) and
		// validate only those records' cached bodies. Skill-first scanning would
		// re-read and re-normalize every catalog body per reconciliation.
		const byBaseDir = new Map<string, SkillRecord[]>();
		const byWrapper = new Map<string, SkillRecord>();
		for (const skill of catalog.skills.values()) {
			byWrapper.set(skill.name + "|" + skill.filePath, skill);
			const siblings = byBaseDir.get(skill.baseDir);
			if (siblings) siblings.push(skill);
			else byBaseDir.set(skill.baseDir, [skill]);
		}

		const next = new Set<string>();
		for (const message of messages) {
			for (const [index, anchor] of message.anchors.entries()) {
				const anchorSkills =
					anchor.kind === "directory"
						? byBaseDir.get(anchor.directory)
						: [byWrapper.get(anchor.name + "|" + anchor.location)];
				const following = message.anchors[index + 1];
				for (const skill of anchorSkills ?? []) {
					if (!skill || next.has(skill.name)) continue;
					const doc = skillDocument(skill.filePath);
					if (!doc) continue;
					const resident = [doc.normalizedBody, doc.passiveNormalizedBody].some((candidate) => {
						if (!candidate) return false;
						const bodyStart = message.text.indexOf(candidate, anchor.end);
						// A later delivery anchor owns bodies that start after it. An
						// anchor-like literal at or inside this body does not truncate it.
						return bodyStart >= 0 && (!following || bodyStart <= following.start);
					});
					if (resident) next.add(skill.name);
				}
			}
			// Exact delivered-result evidence: a transformed body matches neither
			// cached document candidate, so credit the skill only when this same
			// persisted result still carries the text delivery produced for it and
			// the skill body is unchanged since.
			const delivered = message.toolCallId ? deliveredResults.get(message.toolCallId) : undefined;
			if (delivered && !next.has(delivered.name)) {
				const skill = catalog.skills.get(delivered.name);
				const doc = skill?.filePath === delivered.filePath ? skillDocument(skill.filePath) : undefined;
				if (doc && doc.body === delivered.bodySnapshot && message.text.includes(delivered.text)) next.add(delivered.name);
			}
		}

		injectedSkillNames = next;
		for (const name of next) {
			if (!queuedSkillNames.delete(name)) continue;
			reservedSkillNames.delete(name);
		}
		reconciledSessionId = sessionId;
		reconciledLeafId = leafId;
		reconciledSkills = catalog.skills;
	}

	return {
		hasKnown,
		reserve,
		reserveQueued,
		isQueued,
		recordDeliveredResult,
		releaseSkills,
		releaseAll,
		releaseToolCall,
		persistReservations,
		invalidate,
		clear,
		reconcile,
		get activeSkill() {
			return activeSkill;
		},
		set activeSkill(skill: SkillRecord | undefined) {
			activeSkill = skill;
		},
		/** Names whose bodies are delivered or reserved; staged to dedupe prompt expansion. */
		get stagedNames(): Set<string> {
			return new Set([...injectedSkillNames, ...reservedSkillNames]);
		},
	};
}
