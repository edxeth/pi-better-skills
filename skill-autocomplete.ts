import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	CURSOR_MARKER,
	fuzzyFilter,
	getKeybindings,
} from "@earendil-works/pi-tui";

export type SkillAutocompleteSkill = {
	name: string;
};

const GHOST_STYLE = "\x1b[2;38;5;244m";
const RESET = "\x1b[0m";
const CURSOR_BLOCK = "\x1b[7m \x1b[0m";

type SlashToken = {
	prefix: string;
	query: string;
	start: number;
	end: number;
};

type SkillAutocompleteHit = {
	ghostText: string;
	slashIndex: number;
	replacement: string;
	ci: number;
};

function slashTokenAtCursor(line: string, col: number): SlashToken | undefined {
	const slashIndex = line.lastIndexOf("/", col - 1);
	if (slashIndex === -1) return undefined;
	const beforeSlash = line.slice(0, slashIndex);
	if (beforeSlash.length > 0 && !/\s$/.test(beforeSlash)) return undefined;
	if (beforeSlash.trim() === "") return undefined;
	const token = line.slice(slashIndex).match(/^\/\S*/)?.[0];
	if (!token) return undefined;
	const end = slashIndex + token.length;
	if (col > end) return undefined;
	const rawQuery = line.slice(slashIndex + 1, col);
	return {
		prefix: line.slice(slashIndex, col),
		query: rawQuery.startsWith("skill:") ? rawQuery.slice("skill:".length) : rawQuery,
		start: slashIndex,
		end,
	};
}

function computeSkillAutocompleteHit(
	lines: string[],
	ci: number,
	col: number,
	getSkills: () => SkillAutocompleteSkill[],
): SkillAutocompleteHit | null {
	const line = lines[ci] ?? "";
	if (col !== line.length) return null;
	const hit = slashTokenAtCursor(line, col);
	if (!hit || hit.query.length === 0 || hit.end !== line.length) return null;
	const query = hit.query.toLowerCase();
	let best: SkillAutocompleteSkill | undefined;
	for (const skill of getSkills()) {
		const name = skill.name.toLowerCase();
		if (!name.startsWith(query)) continue;
		if (name === query) return null; // already complete
		if (best) return null; // >1 prefix match -> ambiguous -> popup
		best = skill;
	}
	if (!best) return null;
	return {
		ghostText: best.name.slice(hit.query.length),
		slashIndex: hit.start,
		replacement: `/skill:${best.name} `,
		ci,
	};
}

function skillAutocompleteItem(skill: SkillAutocompleteSkill): AutocompleteItem {
	return {
		value: `skill:${skill.name}`,
		label: `skill:${skill.name}`,
	};
}

function restorePrivateEditorCursor(editor: CustomEditor, cursorLine: number, cursorCol: number): void {
	// ponytail: pi's Editor has no public setCursor(line, col) yet; poke the
	// private state field. Upgrade to the public setter when pi-tui adds one.
	const state = (editor as unknown as { state: { cursorLine: number; cursorCol: number } }).state;
	state.cursorLine = cursorLine;
	state.cursorCol = cursorCol;
	editor.invalidate();
}

class SkillGhostEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private readonly getSkills: () => SkillAutocompleteSkill[],
	) {
		super(tui, theme, keybindings);
	}

	private currentHit(): SkillAutocompleteHit | null {
		if (!this.focused || this.isShowingAutocomplete()) return null;
		const { line, col } = this.getCursor();
		return computeSkillAutocompleteHit(this.getLines(), line, col, this.getSkills);
	}

	render(width: number): string[] {
		const result = super.render(width);
		const hit = this.currentHit();
		if (!hit || hit.ghostText.length === 0) return result;

		// ponytail: splices ghost text into pi's end-of-line cursor block
		// (CURSOR_MARKER + highlighted space). Coupled to pi-tui's render format;
		// any mismatch fails safe (no ghost, editor stays correct).
		const cursorLineIdx = result.findIndex((line) => line.includes(CURSOR_MARKER));
		if (cursorLineIdx === -1) return result;
		const line = result[cursorLineIdx];
		const blockIdx = line.indexOf(CURSOR_BLOCK, line.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length);
		if (blockIdx === -1) return result;
		const afterBlock = blockIdx + CURSOR_BLOCK.length;
		let trailing = 0;
		for (let i = line.length - 1; i >= afterBlock && line[i] === " "; i--) trailing++;
		// ghostText is an ASCII skill slug: 1 char = 1 column, no width utils needed.
		const shown = hit.ghostText.slice(0, 1 + trailing);
		if (!shown) return result;
		const first = shown[0];
		const rest = shown.slice(1);
		result[cursorLineIdx] =
			line.slice(0, blockIdx) +
			`\x1b[7m${first}\x1b[0m` +
			(rest ? `${GHOST_STYLE}${rest}${RESET}` : "") +
			" ".repeat(trailing - rest.length);
		return result;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (
			(kb.matches(data, "tui.input.tab") || kb.matches(data, "tui.editor.cursorRight")) &&
			!this.isShowingAutocomplete()
		) {
			const hit = this.currentHit();
			if (hit) {
				this.acceptHit(hit);
				return;
			}
		}
		super.handleInput(data);
	}

	private acceptHit(hit: SkillAutocompleteHit): void {
		const lines = this.getLines();
		const line = lines[hit.ci] ?? "";
		const newLines = [...lines];
		newLines[hit.ci] = line.slice(0, hit.slashIndex) + hit.replacement;
		this.setText(newLines.join("\n"));
		restorePrivateEditorCursor(this, hit.ci, hit.slashIndex + hit.replacement.length);
	}
}

export function setupSkillAutocomplete(ctx: ExtensionContext, getSkills: () => SkillAutocompleteSkill[]): void {
	ctx.ui.addAutocompleteProvider((current): AutocompleteProvider => ({
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const hit = slashTokenAtCursor(currentLine, cursorCol);
			if (!hit) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const items = fuzzyFilter(getSkills(), hit.query, (skill) => skill.name).map(skillAutocompleteItem);
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { items, prefix: hit.prefix };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const currentLine = lines[cursorLine] ?? "";
			const token = slashTokenAtCursor(currentLine, cursorCol);
			const start = token?.start ?? cursorCol - prefix.length;
			const end = token?.end ?? cursorCol;
			const insertion = `/${item.value} `;
			const newLines = [...lines];
			newLines[cursorLine] = currentLine.slice(0, start) + insertion + currentLine.slice(end);
			return { lines: newLines, cursorLine, cursorCol: start + insertion.length };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	}));

	ctx.ui.setEditorComponent(
		(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent =>
			new SkillGhostEditor(tui, theme, keybindings, getSkills),
	);
}
