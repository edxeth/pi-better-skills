import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillSuggestions, type SkillAutocompleteSkill } from "./skill-autocomplete";

/** API for other extensions: emit `{ version: 1, operation, ..., reply }` here; no probe reply means absent. */
export const SKILL_API_CHANNEL = "pi-better-skills:request";
export const SKILL_API_VERSION = 1;
/** Every payload version this provider answers; the probe reply lists them. */
export const SKILL_API_VERSIONS: readonly number[] = [SKILL_API_VERSION];

export type SkillDeliveryStatus = "delivered" | "already-resident" | "unknown";
export type SkillDeliveryOutcome = { name: string; status: SkillDeliveryStatus };
export type SkillSuggestion = { value: string; label: string };

export type SkillApiProbeReply = { version: 1; operation: "probe"; available: true; versions: number[] };
export type SkillApiSuggestReply = { version: 1; operation: "suggest"; items: SkillSuggestion[] };
export type SkillApiDeliverReply = { version: 1; operation: "deliver"; outcomes: SkillDeliveryOutcome[] };

export type SkillApiProbeRequest = { version: 1; operation: "probe"; reply: (result: SkillApiProbeReply) => void };
export type SkillApiSuggestRequest = { version: 1; operation: "suggest"; query: string; reply: (result: SkillApiSuggestReply) => void };
export type SkillApiDeliverRequest = { version: 1; operation: "deliver"; names: string[]; reply: (result: SkillApiDeliverReply) => void };
export type SkillApiRequest = SkillApiProbeRequest | SkillApiSuggestRequest | SkillApiDeliverRequest;

function isRequest(value: unknown): value is SkillApiRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Record<string, unknown>;
	if (request.version !== SKILL_API_VERSION || typeof request.reply !== "function") return false;
	switch (request.operation) {
		case "probe": return true;
		case "suggest": return typeof request.query === "string";
		case "deliver": return Array.isArray(request.names) && request.names.every((name: unknown) => typeof name === "string");
		default: return false;
	}
}

/** EventBus callbacks run synchronously until their first await; probe is an immediate capability check. */
export function registerSkillApi(
	pi: ExtensionAPI,
	getSkills: () => SkillAutocompleteSkill[],
	deliver: (names: string[]) => SkillDeliveryOutcome[],
): void {
	pi.events.on(SKILL_API_CHANNEL, (value: unknown) => {
		if (!isRequest(value)) return;
		switch (value.operation) {
			case "probe":
				value.reply({ version: 1, operation: "probe", available: true, versions: [...SKILL_API_VERSIONS] });
				break;
			case "suggest":
				value.reply({ version: 1, operation: "suggest", items: skillSuggestions(value.query, getSkills()) });
				break;
			case "deliver":
				value.reply({ version: 1, operation: "deliver", outcomes: deliver(value.names) });
				break;
		}
	});
}
