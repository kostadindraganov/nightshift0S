/**
 * Hermetic tests for the worktree service (§2.2 verify gate + ADRs 0003/0004/0007/0018).
 *
 * Each test suite creates a fresh temporary git repository; all operations
 * target that tmp repo, never the nightshift repo itself.
 *
 * Ported from sandcastle WorktreeManager (ADR-0003/0004/0007/0018);
 * native plain-Promise reimplementation.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
  pruneStale,
  generateBranchName,
  sanitizeName,
  findCollidingWorktree,
  isManagedWorktreePath,
  WorktreeLockError,
  WorktreeError,
} from "./worktree.ts";
import { execGit } from "./git.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ns-wt-"));
}

/** Create a minimal git repo with one commit so worktree ops work. */
async function initRepo(dir: string): Promise<void> {
  await execGit(["init"], dir);
  await execGit(["config", "user.email", "test@nightshift.local"], dir);
  await execGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  await execGit(["add", "."], dir);
  await execGit(["commit", "-m", "init"], dir);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let repoDir: string;

beforeEach(async () => {
  repoDir = tmpDir();
  await initRepo(repoDir);
});

afterEach(() => {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// (a) Basic createWorktree
// ---------------------------------------------------------------------------

describe("(a) createWorktree: basic creation", () => {
  test("creates worktree dir and checks out branch", async () => {
    const result = await createWorktree({
      repoDir,
      taskId: 1,
      slug: "my task",
    });

    // Branch follows ns/<id>-<slug>-<rand16> pattern
    expect(result.branch).toMatch(/^ns\/1-my-task-[0-9a-f]{16}$/);
    expect(result.reused).toBe(false);

    // Directory must exist
    expect(existsSync(result.path)).toBe(true);

    // Directory is inside .nightshift/worktrees
    expect(result.path).toContain(".nightshift/worktrees");

    // The worktree has the branch checked out
    const branch = (await execGit(["rev-parse", "--abbrev-ref", "HEAD"], result.path)).trim();
    expect(branch).toBe(result.branch);
  });

  test("creates worktree with explicit branch name", async () => {
    const result = await createWorktree({
      repoDir,
      branch: "ns/explicit-branch",
    });

    expect(result.branch).toBe("ns/explicit-branch");
    expect(existsSync(result.path)).toBe(true);
    expect(result.reused).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) PARALLEL-CLAIM: distinct taskIds -> no collisions
// ---------------------------------------------------------------------------

describe("(b) PARALLEL-CLAIM: ~10 concurrent creates with distinct taskIds", () => {
  test("all succeed with distinct branches and dirs", async () => {
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        createWorktree({ repoDir, taskId: i + 100, slug: `task${i}` }),
      ),
    );

    // All succeeded
    expect(results.length).toBe(N);

    // All branches distinct
    const branches = results.map((r) => r.branch);
    expect(new Set(branches).size).toBe(N);

    // All dirs distinct
    const paths = results.map((r) => r.path);
    expect(new Set(paths).size).toBe(N);

    // All dirs exist
    for (const r of results) {
      expect(existsSync(r.path)).toBe(true);
    }

    // None were reused
    for (const r of results) {
      expect(r.reused).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) LOCK CONTENTION: same explicit branch -> exactly one wins, other throws fast
// ---------------------------------------------------------------------------

describe("(c) LOCK CONTENTION: two concurrent creates for the same branch", () => {
  test("exactly one wins, the other throws WorktreeLockError fast (no hang)", async () => {
    const branch = "ns/contention-test-aabbcc";

    // Introduce a tiny artificial delay in one call to ensure overlap.
    // We race two creates for identical explicit branch.
    const start = Date.now();
    const results = await Promise.allSettled([
      createWorktree({ repoDir, branch }),
      createWorktree({ repoDir, branch }),
    ]);
    const elapsed = Date.now() - start;

    // Must finish quickly (no hang / infinite retry)
    expect(elapsed).toBeLessThan(10_000);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    // Exactly one winner
    expect(fulfilled.length).toBe(1);
    // Exactly one loser
    expect(rejected.length).toBe(1);

    // The loser must throw WorktreeLockError
    const failure = rejected[0];
    expect(failure?.status).toBe("rejected");
    if (failure?.status === "rejected") {
      expect(failure.reason).toBeInstanceOf(WorktreeLockError);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) crypto-random suffix: many calls in the same second yield unique names
// ---------------------------------------------------------------------------

describe("(d) generateBranchName: crypto-random uniqueness", () => {
  test("1000 calls within the same second yield unique names", () => {
    const names = Array.from({ length: 1000 }, () =>
      generateBranchName({ taskId: 42, slug: "test" }),
    );
    expect(new Set(names).size).toBe(1000);
  });

  test("names without taskId/slug are still unique", () => {
    const names = Array.from({ length: 500 }, () => generateBranchName());
    expect(new Set(names).size).toBe(500);
  });

  test("branch name matches expected pattern", () => {
    const name = generateBranchName({ taskId: 7, slug: "hello world" });
    expect(name).toMatch(/^ns\/7-hello-world-[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// (e) REUSE clean: second create on same branch -> reused:true, no error
// ---------------------------------------------------------------------------

describe("(e) REUSE: second createWorktree on same branch returns reused:true", () => {
  test("returns reused:true on second call with same explicit branch", async () => {
    const branch = "ns/reuse-test-112233";

    const first = await createWorktree({ repoDir, branch });
    expect(first.reused).toBe(false);
    expect(existsSync(first.path)).toBe(true);

    const second = await createWorktree({ repoDir, branch });
    expect(second.reused).toBe(true);
    expect(second.branch).toBe(branch);
    expect(second.path).toBe(first.path);
  });
});

// ---------------------------------------------------------------------------
// (f) DIRTY PRESERVED: uncommitted changes survive reuse (NEVER reset --hard)
// ---------------------------------------------------------------------------

describe("(f) dirty worktree: uncommitted changes are preserved on reuse", () => {
  test("file written in worktree survives second createWorktree call", async () => {
    const branch = "ns/dirty-test-aabbcc";

    const first = await createWorktree({ repoDir, branch });

    // Write an uncommitted file in the worktree
    const dirtyFile = join(first.path, "dirty.txt");
    writeFileSync(dirtyFile, "dirty content\n");

    // Reuse the worktree
    const second = await createWorktree({ repoDir, branch });
    expect(second.reused).toBe(true);

    // The dirty file must still be there
    expect(existsSync(dirtyFile)).toBe(true);
    const content = await Bun.file(dirtyFile).text();
    expect(content).toBe("dirty content\n");
  });
});

// ---------------------------------------------------------------------------
// (g) pruneStale: removes orphan dirs, keeps active worktrees
// ---------------------------------------------------------------------------

describe("(g) pruneStale", () => {
  test("removes orphan dir under .nightshift/worktrees, keeps active worktree", async () => {
    // Create a real worktree
    const result = await createWorktree({ repoDir, taskId: 99, slug: "prune-test" });
    expect(existsSync(result.path)).toBe(true);

    // Create a fake orphan directory (not registered with git)
    const { mkdirSync } = await import("node:fs");
    const orphanPath = join(repoDir, ".nightshift", "worktrees", "orphan-fake");
    mkdirSync(orphanPath, { recursive: true });
    expect(existsSync(orphanPath)).toBe(true);

    // Prune
    await pruneStale(repoDir);

    // Orphan is gone
    expect(existsSync(orphanPath)).toBe(false);

    // Active worktree still exists
    expect(existsSync(result.path)).toBe(true);
  });

  test("pruneStale is a no-op when .nightshift/worktrees does not exist", async () => {
    // No worktrees created → directory doesn't exist
    await expect(pruneStale(repoDir)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (h) collision with main working tree throws
// ---------------------------------------------------------------------------

describe("(h) collision with main working tree", () => {
  test("throws WorktreeError when branch is checked out in main tree", async () => {
    // Get the current branch of the main working tree
    const mainBranch = (
      await execGit(["rev-parse", "--abbrev-ref", "HEAD"], repoDir)
    ).trim();

    // Attempting to create a worktree for the main branch should throw
    await expect(
      createWorktree({ repoDir, branch: mainBranch }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });
});

// ---------------------------------------------------------------------------
// Utility unit tests
// ---------------------------------------------------------------------------

describe("sanitizeName", () => {
  test("lowercases and replaces non-alnum with -", () => {
    expect(sanitizeName("Hello World!")).toBe("hello-world-");
    expect(sanitizeName("feat/add-thing")).toBe("feat-add-thing");
    expect(sanitizeName("abc123")).toBe("abc123");
  });
});

describe("findCollidingWorktree", () => {
  test("finds by branch", () => {
    const existing = [
      { path: "/a/b/c", branch: "main" },
      { path: "/a/b/d", branch: "feature" },
    ];
    const result = findCollidingWorktree(existing, "feature", "/a/b/x");
    expect(result?.path).toBe("/a/b/d");
  });

  test("finds by path when branch is null (detached HEAD)", () => {
    const existing = [
      { path: "/a/b/c", branch: null },
    ];
    const result = findCollidingWorktree(existing, "some-branch", "/a/b/c");
    expect(result?.path).toBe("/a/b/c");
  });

  test("returns undefined when no collision", () => {
    const existing = [{ path: "/a/b/c", branch: "main" }];
    const result = findCollidingWorktree(existing, "feature", "/a/b/d");
    expect(result).toBeUndefined();
  });
});

describe("isManagedWorktreePath", () => {
  test("returns true for path under worktreesDir", () => {
    expect(
      isManagedWorktreePath("/repo/.nightshift/worktrees/ns-1-foo", "/repo/.nightshift/worktrees"),
    ).toBe(true);
  });

  test("returns false for main working tree path", () => {
    expect(
      isManagedWorktreePath("/repo", "/repo/.nightshift/worktrees"),
    ).toBe(false);
  });
});
