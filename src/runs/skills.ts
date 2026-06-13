/**
 * Workflow-skill mount seam (blueprint integration).
 *
 * Spawned coding agents (Claude Code / Codex / Gemini) otherwise improvise
 * their process. This seam copies a configured subset of the vendored
 * blueprint skills (`vendor/blueprint-skills/skills/<slug>/SKILL.md`) into the
 * agent's per-task HOME at `<homePath>/.nightshift-skills/<slug>/SKILL.md` and
 * returns a short prompt footer that points the agent at them.
 *
 * WHY per-task HOME (not the worktree): the worktree is a git checkout — files
 * dropped there risk being committed — and the provider auth dir
 * (`HOME/.claude`) is ro-bound in the sandbox. The per-task HOME is rw-bound
 * and outside the git tree, so it is the safe, provider-agnostic mount point.
 *
 * Dormant by default: callers pass the skill slugs (from config); an empty list
 * is a no-op so existing spawns are unaffected until the seam is wired.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Subdir under the per-task HOME the skills are copied into. */
export const SKILLS_MOUNT_SUBDIR = ".nightshift-skills";

/** Absolute path to the vendored blueprint skills directory. */
export function defaultSkillsSourceDir(): string {
	// src/runs/skills.ts → repo root → vendor/blueprint-skills/skills
	return join(import.meta.dir, "..", "..", "vendor", "blueprint-skills", "skills");
}

export interface MountSkillsInput {
	/** Per-task HOME directory (must already exist). */
	homePath: string;
	/** Skill slugs to mount, e.g. ["spec","plan","implement","review"]. */
	skills: string[];
	/** Override the source dir (tests). Defaults to the vendored skills dir. */
	sourceDir?: string;
}

export interface MountSkillsResult {
	/** Absolute dir the skills were copied into. */
	mountDir: string;
	/** Slugs actually mounted (a slug missing from the source is skipped). */
	mounted: string[];
	/** Prompt footer referencing the mounted skills, or "" when none mounted. */
	promptFooter: string;
}

/**
 * Copy the requested skill files into the per-task HOME and build a prompt
 * footer. Missing slugs are skipped silently (the source is the canonical set).
 */
export function mountSkills(input: MountSkillsInput): MountSkillsResult {
	const sourceDir = input.sourceDir ?? defaultSkillsSourceDir();
	const mountDir = join(input.homePath, SKILLS_MOUNT_SUBDIR);
	const mounted: string[] = [];

	for (const slug of input.skills) {
		const src = join(sourceDir, slug, "SKILL.md");
		if (!existsSync(src)) continue;
		const destDir = join(mountDir, slug);
		mkdirSync(destDir, { recursive: true });
		cpSync(src, join(destDir, "SKILL.md"));
		mounted.push(slug);
	}

	if (mounted.length === 0) {
		return { mountDir, mounted, promptFooter: "" };
	}

	return { mountDir, mounted, promptFooter: buildFooter(mountDir, mounted) };
}

/**
 * Append the mount footer to an agent prompt. No-op when the footer is empty,
 * so callers can thread this unconditionally.
 */
export function appendSkillsFooter(prompt: string, footer: string): string {
	return footer === "" ? prompt : `${prompt}\n${footer}\n`;
}

function buildFooter(mountDir: string, mounted: string[]): string {
	const list = mounted.map((slug) => `  - ${slug}: ${join(mountDir, slug, "SKILL.md")}`).join("\n");
	return [
		"",
		"---",
		"## Workflow skills (read before you start)",
		"",
		"Follow the disciplined engineering workflow encoded in these skill files.",
		"Each is a short Markdown playbook — read the relevant one and follow it:",
		"",
		list,
		"",
		"Default flow: spec (when decisions matter) → plan (when work needs",
		"splitting) → implement (with tests) → review. Do not skip the tests or the",
		"review.",
	].join("\n");
}
