/**
 * mountSkills / appendSkillsFooter tests.
 *
 *   (a) copies requested SKILL.md files into <homePath>/.nightshift-skills/<slug>/
 *   (b) skips slugs missing from the source dir
 *   (c) empty/all-missing → no footer, no files
 *   (d) footer references each mounted skill's absolute path
 *   (e) appendSkillsFooter is a no-op for the empty footer
 *   (f) the real vendored source dir exposes the canonical skills
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	appendSkillsFooter,
	defaultSkillsSourceDir,
	mountSkills,
	SKILLS_MOUNT_SUBDIR,
} from "./skills.ts";

let tmp: string;
let home: string;
let source: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "ns-skills-test-"));
	home = join(tmp, "home");
	source = join(tmp, "src");
	mkdirSync(home, { recursive: true });
	// Fake source dir with two skills.
	for (const slug of ["spec", "review"]) {
		mkdirSync(join(source, slug), { recursive: true });
		writeFileSync(join(source, slug, "SKILL.md"), `# ${slug}\n`);
	}
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

test("copies requested skills into the per-task HOME and footers them", () => {
	const r = mountSkills({ homePath: home, skills: ["spec", "review"], sourceDir: source });
	expect(r.mounted).toEqual(["spec", "review"]);
	for (const slug of ["spec", "review"]) {
		const dest = join(home, SKILLS_MOUNT_SUBDIR, slug, "SKILL.md");
		expect(existsSync(dest)).toBe(true);
		expect(readFileSync(dest, "utf8")).toContain(`# ${slug}`);
		expect(r.promptFooter).toContain(dest);
	}
	expect(r.promptFooter).toContain("Workflow skills");
});

test("skips slugs missing from the source", () => {
	const r = mountSkills({ homePath: home, skills: ["spec", "nope"], sourceDir: source });
	expect(r.mounted).toEqual(["spec"]);
	expect(existsSync(join(home, SKILLS_MOUNT_SUBDIR, "nope"))).toBe(false);
});

test("empty list mounts nothing and returns an empty footer", () => {
	const r = mountSkills({ homePath: home, skills: [], sourceDir: source });
	expect(r.mounted).toEqual([]);
	expect(r.promptFooter).toBe("");
	expect(existsSync(join(home, SKILLS_MOUNT_SUBDIR))).toBe(false);
});

test("all-missing slugs yield an empty footer", () => {
	const r = mountSkills({ homePath: home, skills: ["ghost"], sourceDir: source });
	expect(r.mounted).toEqual([]);
	expect(r.promptFooter).toBe("");
});

test("appendSkillsFooter is a no-op for the empty footer", () => {
	expect(appendSkillsFooter("base prompt", "")).toBe("base prompt");
	const out = appendSkillsFooter("base prompt", "FOOTER");
	expect(out).toContain("base prompt");
	expect(out).toContain("FOOTER");
});

test("the vendored source dir exposes the canonical blueprint skills", () => {
	const dir = defaultSkillsSourceDir();
	for (const slug of ["spec", "plan", "implement", "review"]) {
		expect(existsSync(join(dir, slug, "SKILL.md"))).toBe(true);
	}
});
