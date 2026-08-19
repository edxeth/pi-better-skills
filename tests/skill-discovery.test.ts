import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cliSkillPaths, projectAgentsSkillRoots, projectSkillRoots, resultConfirmsSkillBody, settingsSkillPaths, skillRecordForFile } from "../index";

/**
 * Fresh-session discovery: the input event fires before before_agent_start
 * merges pi's authoritative loaded set, so the extension's own scan must cover
 * CLI --skill paths, settings `skills` arrays, and project .agents/skills
 * ancestors on its own.
 */

describe("cliSkillPaths", () => {
	it("collects --skill <path> and --skill=<path> forms", () => {
		expect(
			cliSkillPaths(["pi", "-p", "--skill", "/tmp/a", "--skill=/tmp/b", "--skill", "~/c", "prompt"]),
		).toEqual(["/tmp/a", "/tmp/b", join(homedir(), "c")]);
	});

	it("returns empty when no --skill flags are present", () => {
		expect(cliSkillPaths(["pi", "-p", "hello"])).toEqual([]);
	});
});

describe("settingsSkillPaths", () => {
	it("resolves relative entries against cwd, matching pi's loader", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-settings-"));
		try {
			mkdirSync(join(dir, ".pi"));
			writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ skills: ["/abs/claude-skills", "sub/skills"] }));
			const paths = settingsSkillPaths(dir, true);
			expect(paths).toContain("/abs/claude-skills");
			expect(paths).toContain(join(dir, "sub/skills"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips project settings until the project is trusted", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-settings-"));
		try {
			mkdirSync(join(dir, ".pi"));
			writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ skills: ["sub/skills"] }));
			expect(settingsSkillPaths(dir, false)).toEqual([]);
			expect(settingsSkillPaths(dir, true)).toEqual([join(dir, "sub/skills")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores missing settings files", () => {
		expect(settingsSkillPaths(join(tmpdir(), "definitely-missing-dir"), true)).toEqual([]);
	});
});

describe("projectAgentsSkillRoots", () => {
	it("walks ancestors up to the git root", () => {
		const roots = projectAgentsSkillRoots(
			"/repo/a/b",
			(gitPath) => gitPath === "/repo/.git", // pretend /repo is the git root
		);
		expect(roots).toEqual(["/repo/a/b/.agents/skills", "/repo/a/.agents/skills", "/repo/.agents/skills"]);
	});

	it("walks to the filesystem root when there is no repo", () => {
		const roots = projectAgentsSkillRoots("/tmp/x/y", () => false);
		expect(roots[0]).toBe("/tmp/x/y/.agents/skills");
		expect(roots).toContain("/.agents/skills");
		expect(roots).toHaveLength(4); // /tmp/x/y, /tmp/x, /tmp, /
	});
});

describe("projectSkillRoots", () => {
	it("is empty until the project is trusted", () => {
	expect(projectSkillRoots("/repo", false)).toEqual([]);
	});

	it("includes .pi/skills plus .agents/skills ancestors when trusted", () => {
		const roots = projectSkillRoots("/repo/a", true);
		expect(roots[0]).toBe("/repo/a/.pi/skills");
		expect(roots).toContain("/repo/a/.agents/skills");
	});
});

describe("resultConfirmsSkillBody", () => {
	const body = "# Title\n\nFirst paragraph with plenty of text to span the hundred-character prefix window used for confirmation.";

	it("confirms when the result contains the body (cat/head style output)", () => {
		expect(resultConfirmsSkillBody(`whatever\n\n${body}\ntrailer`, body)).toBe(true);
		// Partial reads confirm when they cover the 80-char prefix.
		expect(resultConfirmsSkillBody(body.slice(0, 90), body)).toBe(true);
		expect(resultConfirmsSkillBody("# Title", body)).toBe(false);
	});

	it("rejects metadata-only or path-echoing results", () => {
		expect(resultConfirmsSkillBody("stat: /skills/x/SKILL.md 1204 bytes", body)).toBe(false);
		expect(resultConfirmsSkillBody("echo /skills/x/SKILL.md", body)).toBe(false);
		expect(resultConfirmsSkillBody("", body)).toBe(false);
	});
});

describe("skillRecordForFile", () => {
	it("requires a description like pi's loader", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-better-skills-file-"));
		try {
			const withDesc = join(dir, "with-desc.md");
			const withoutDesc = join(dir, "no-desc.md");
			writeFileSync(withDesc, "---\nname: has-desc\ndescription: yes\n---\nbody");
			writeFileSync(withoutDesc, "---\nname: no-desc\n---\nbody");
			expect(skillRecordForFile(withDesc)?.name).toBe("has-desc");
			expect(skillRecordForFile(withoutDesc)).toBeUndefined();
			expect(skillRecordForFile(join(dir, "missing.md"))).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
