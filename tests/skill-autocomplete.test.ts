import { describe, it, expect } from "bun:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { setupSkillAutocomplete, type SkillAutocompleteSkill } from "../skill-autocomplete";

/**
 * `setupSkillAutocomplete` installs two things on `ctx.ui`:
 *   - an autocomplete provider factory (popup path), and
 *   - a custom editor factory (inline ghost path).
 *
 * These tests drive that registration through a fake `ctx.ui` and a wrapped
 * "current" provider so observable behavior is locked without spinning up a
 * real terminal/editor (the ghost render + cursor poke is deliberately left to
 * live smoke; it is author-marked version-sensitive).
 */

type FakeCtxOptions = { hasExistingEditor?: boolean };

function createFakeCtx(options: FakeCtxOptions = {}) {
	let providerFactory: ((current: AutocompleteProvider) => AutocompleteProvider) | undefined;
	let editorFactory: unknown;
	const ctx = {
		ui: {
			addAutocompleteProvider(factory: (current: AutocompleteProvider) => AutocompleteProvider): void {
				providerFactory = factory;
			},
			getEditorComponent(): unknown {
				return options.hasExistingEditor ? (() => "existing-editor") : undefined;
			},
			setEditorComponent(factory: unknown): void {
				editorFactory = factory;
			},
		},
	} as any;

	return {
		ctx,
		getProviderFactory: () => providerFactory,
		getEditorFactory: () => editorFactory,
	};
}

// Wrapped "current" provider returns sentinels so delegation is observable.
const DELEGATED_SUGGESTIONS = { items: [{ value: "builtin", label: "builtin" }], prefix: "current" };
const DELEGATED_APPLY = { lines: ["DELEGATED"], cursorLine: 0, cursorCol: 9 };

function createWrappedCurrent(): AutocompleteProvider {
	return {
		async getSuggestions() {
			return DELEGATED_SUGGESTIONS;
		},
		applyCompletion() {
			return DELEGATED_APPLY;
		},
		shouldTriggerFileCompletion() {
			return false;
		},
	};
}

function buildProvider(getSkills: () => SkillAutocompleteSkill[]): AutocompleteProvider {
	const env = createFakeCtx();
	setupSkillAutocomplete(env.ctx, getSkills);
	const factory = env.getProviderFactory();
	if (!factory) throw new Error("autocomplete provider was not registered");
	return factory(createWrappedCurrent());
}

async function suggest(provider: AutocompleteProvider, line: string, col: number = line.length, cursorLine = 0) {
	// Build a lines array where index `cursorLine` is the active line.
	const lines = cursorLine === 0 ? [line] : [...Array(cursorLine).fill(""), line];
	return provider.getSuggestions(lines, cursorLine, col, { signal: new AbortController().signal });
}

const skills = (names: string[]): SkillAutocompleteSkill[] => names.map((name) => ({ name }));

describe("setupSkillAutocomplete registration", () => {
	it("registers an autocomplete provider and a ghost editor when no editor is installed", () => {
		const env = createFakeCtx();
		setupSkillAutocomplete(env.ctx, () => []);

		expect(env.getProviderFactory()).toBeDefined();
		expect(env.getEditorFactory()).toBeDefined();
	});

	it("does not clobber an existing custom editor but still registers the popup provider", () => {
		const env = createFakeCtx({ hasExistingEditor: true });
		setupSkillAutocomplete(env.ctx, () => []);

		expect(env.getProviderFactory()).toBeDefined();
		expect(env.getEditorFactory()).toBeUndefined();
	});
});

describe("skill autocomplete suggestions", () => {
	it("returns the single matching skill for a unique mid-text prefix", async () => {
		const provider = buildProvider(() => skills(["smoke-unique", "smoke-alpha"]));
		const result = await suggest(provider, "run /smoke-u");

		expect(result).not.toBeNull();
		expect(result!.items.map((item) => item.value)).toEqual(["skill:smoke-unique"]);
		expect(result!.prefix).toBe("/smoke-u");
	});

	it("surfaces every prefix match for an ambiguous token (popup path)", async () => {
		const provider = buildProvider(() => skills(["smoke-alpha", "smoke-alpine", "smoke-unique"]));
		const result = await suggest(provider, "run /smoke-a");

		expect(result).not.toBeNull();
		expect(result!.items.map((item) => item.value).sort()).toEqual(["skill:smoke-alpha", "skill:smoke-alpine"]);
	});

	it("strips a typed /skill: prefix before matching", async () => {
		const provider = buildProvider(() => skills(["smoke-unique", "smoke-alpha"]));
		const result = await suggest(provider, "run /skill:smoke-u");

		expect(result).not.toBeNull();
		expect(result!.items.map((item) => item.value)).toEqual(["skill:smoke-unique"]);
		expect(result!.prefix).toBe("/skill:smoke-u");
	});

	it("delegates to the wrapped provider when the slash starts the message", async () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const result = await suggest(provider, "/smoke-u");

		expect(result).toEqual(DELEGATED_SUGGESTIONS);
	});

	it("suggests a skill for a bare /skill: at the start of a NON-first line (no built-in menu there)", async () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		// cursorLine 1 (a later line); the line itself starts with the slash
		const result = await suggest(provider, "/smoke-u", "/smoke-u".length, 1);

		expect(result).not.toEqual(DELEGATED_SUGGESTIONS);
		expect(result?.items.map((item) => item.value)).toEqual(["skill:smoke-unique"]);
		expect(result?.prefix).toBe("/smoke-u");
	});

	it("delegates when the slash is inside a URL", async () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const result = await suggest(provider, "see http://smoke-u");

		expect(result).toEqual(DELEGATED_SUGGESTIONS);
	});

	it("delegates when no skill matches the token", async () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const result = await suggest(provider, "run /zzzz");

		expect(result).toEqual(DELEGATED_SUGGESTIONS);
	});

	it("delegates when the cursor is past the end of the token", async () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const result = await suggest(provider, "run /smoke-u tail");

		expect(result).toEqual(DELEGATED_SUGGESTIONS);
	});
});

describe("skill autocomplete applyCompletion", () => {
	it("inserts /skill:<name> with a trailing space and moves the cursor after it", () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const line = "run /smoke-u";
		const result = provider.applyCompletion([line], 0, line.length, { value: "skill:smoke-unique", label: "skill:smoke-unique" }, "/smoke-u");

		expect(result.lines).toEqual(["run /skill:smoke-unique "]);
		expect(result.cursorLine).toBe(0);
		expect(result.cursorCol).toBe("run /skill:smoke-unique ".length);
	});

	it("normalizes a typed /skill: prefix on insertion", () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const line = "run /skill:smoke-u";
		const result = provider.applyCompletion([line], 0, line.length, { value: "skill:smoke-unique", label: "skill:smoke-unique" }, "/skill:smoke-u");

		expect(result.lines).toEqual(["run /skill:smoke-unique "]);
		expect(result.cursorCol).toBe("run /skill:smoke-unique ".length);
	});

	it("delegates non-skill items to the wrapped provider", () => {
		const provider = buildProvider(() => skills(["smoke-unique"]));
		const result = provider.applyCompletion(["run /smoke-u"], 0, "run /smoke-u".length, { value: "builtin", label: "builtin" }, "/smoke-u");

		expect(result).toEqual(DELEGATED_APPLY);
	});
});
