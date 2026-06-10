/**
 * Freshness gate tests (task 2.7).
 *
 * Uses a real `git init` in a Bun tmpdir so the git plumbing is exercised
 * without touching the Nightshift repo. No network calls are made.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit } from "../worktree/git.ts";
import { checkBranchFreshness } from "./freshness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nightshift-freshness-"));
}

/** Minimal git identity for commits inside the temp repo. */
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@test",
};

async function git(args: string[], cwd: string): Promise<string> {
  return execGit(args, cwd);
}

/** Initialise a bare-minimum git repo with one commit on `main`. */
async function initRepo(dir: string): Promise<string> {
  await git(["init", "-b", "main"], dir);
  await git(["config", "user.email", "test@test"], dir);
  await git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README"), "hello");
  await git(["add", "."], dir);
  await git(
    [
      "-c",
      `user.name=Test`,
      "-c",
      `user.email=test@test`,
      "commit",
      "--allow-empty",
      "-m",
      "init",
    ],
    dir,
  );
  return (await git(["rev-parse", "HEAD"], dir)).trim();
}

/** Add a new commit to the repo and return the new HEAD sha. */
async function addCommit(dir: string, msg: string): Promise<string> {
  writeFileSync(join(dir, msg.replace(/\s+/g, "_")), msg);
  await git(["add", "."], dir);
  await git(
    [
      "-c",
      `user.name=Test`,
      "-c",
      `user.email=test@test`,
      "commit",
      "-m",
      msg,
    ],
    dir,
  );
  return (await git(["rev-parse", "HEAD"], dir)).trim();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkBranchFreshness", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmp();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("(a) baseSha === HEAD → fresh", async () => {
    const baseSha = await initRepo(dir);
    const result = await checkBranchFreshness(execGit, {
      repoDir: dir,
      baseSha,
      defaultBranch: "main",
    });
    expect(result.status).toBe("fresh");
    expect(result.baseSha).toBe(baseSha);
    expect(result.targetSha).toBe(baseSha);
  });

  it("(b) defaultBranch advanced after recording baseSha → rebase", async () => {
    const baseSha = await initRepo(dir);
    // Advance defaultBranch with a new commit.
    const newHead = await addCommit(dir, "second commit");

    const result = await checkBranchFreshness(execGit, {
      repoDir: dir,
      baseSha,
      defaultBranch: "main",
    });
    expect(result.status).toBe("rebase");
    expect(result.baseSha).toBe(baseSha);
    expect(result.targetSha).toBe(newHead);
    expect(result.reason).toMatch(/ancestor/);
  });

  it("(c) history diverged → block", async () => {
    const baseSha = await initRepo(dir);

    // Create an orphan branch (diverged history — no common ancestor path
    // from main HEAD back to baseSha after we reset main to a new root).
    // Simpler: amend the commit so baseSha is no longer reachable from HEAD.
    // We'll create a new orphan commit and force-update the branch.
    await git(["checkout", "--orphan", "orphan-tmp"], dir);
    writeFileSync(join(dir, "orphan"), "diverged");
    await git(["add", "."], dir);
    await git(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@test",
        "commit",
        "-m",
        "orphan root",
      ],
      dir,
    );
    // Point main at the orphan commit (history rewritten — baseSha is gone).
    const orphanSha = (await git(["rev-parse", "HEAD"], dir)).trim();
    await git(["branch", "-f", "main", orphanSha], dir);
    await git(["checkout", "main"], dir);

    const result = await checkBranchFreshness(execGit, {
      repoDir: dir,
      baseSha, // old sha, not in main's ancestry
      defaultBranch: "main",
    });
    expect(result.status).toBe("block");
  });

  it("(d) garbage baseSha → block", async () => {
    await initRepo(dir);
    const result = await checkBranchFreshness(execGit, {
      repoDir: dir,
      baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      defaultBranch: "main",
    });
    expect(result.status).toBe("block");
    expect(result.reason).toMatch(/not a known git object/);
  });
});
