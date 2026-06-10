/**
 * WHY: End-to-end gate test for §2.6 (forge pipeline) and §2.7 (freshness + CI gates).
 * Uses a real tmpdir git repo (never touches the Nightshift repo), fake injected clients,
 * and no live network calls. Verifies:
 *   (A) Secret scan — planted secrets block push+PR, neither side-effect fires.
 *   (B) Clean path — distrust push args/env verified, PR request built correctly.
 *   (C) Freshness — "rebase" when branch fell behind; "block" when history diverged.
 *   (D) CI gate — green on all-success; blocked with names on failure/pending/missing.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit } from "../worktree/git.ts";
import { prepareAndOpenPR } from "./forge.ts";
import type { ForgeClient, ForgeClientRequest, ForgeClientResponse } from "./github.ts";
import type { Pusher } from "./push.ts";
import { checkBranchFreshness } from "../gate/freshness.ts";
import { ciGate, ciGateForRef, type CheckRun, type CiClient } from "../gate/ci.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ns-fggate-"));
}

/** Init a minimal git repo on "main" and return its first commit SHA. */
async function initRepo(dir: string): Promise<string> {
  await execGit(["init", "-b", "main"], dir);
  await execGit(["config", "user.email", "test@test"], dir);
  await execGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README"), "init");
  await execGit(["add", "."], dir);
  await execGit(
    ["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-m", "init"],
    dir,
  );
  return (await execGit(["rev-parse", "HEAD"], dir)).trim();
}

/** Add a new commit and return the new HEAD SHA. */
async function addCommit(dir: string, file: string, content = "x"): Promise<string> {
  writeFileSync(join(dir, file), content);
  await execGit(["add", "."], dir);
  await execGit(
    ["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-m", `add ${file}`],
    dir,
  );
  return (await execGit(["rev-parse", "HEAD"], dir)).trim();
}

/** Fake pusher factory — records calls. */
function makeFakePusher(): {
  pusher: Pusher;
  calls: { args: string[]; cwd: string; env: Record<string, string> }[];
} {
  const calls: { args: string[]; cwd: string; env: Record<string, string> }[] = [];
  const pusher: Pusher = async (args, cwd, env) => {
    calls.push({ args, cwd, env });
    return "";
  };
  return { pusher, calls };
}

/** Fake ForgeClient factory — records calls and returns a canned PR. */
function makeFakeClient(prNumber = 7, prUrl = "https://github.com/o/r/pull/7"): {
  client: ForgeClient;
  calls: ForgeClientRequest[];
} {
  const calls: ForgeClientRequest[] = [];
  const client: ForgeClient = {
    async request(req: ForgeClientRequest): Promise<ForgeClientResponse> {
      calls.push(req);
      return { status: 201, json: { number: prNumber, html_url: prUrl } };
    },
  };
  return { client, calls };
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let repoDir: string;
let baseSha: string;

beforeEach(async () => {
  repoDir = tmp();
  baseSha = await initRepo(repoDir);
});

afterEach(() => {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ---------------------------------------------------------------------------
// (A) SECRET BLOCKS
// ---------------------------------------------------------------------------

describe("(A) Secret blocks", () => {
  /** Diffs with planted secrets across the four required rule families. */
  const secretDiffs: Array<{ name: string; diff: string }> = [
    {
      name: "ghp_ (GitHub classic PAT)",
      diff: `--- a/cfg.ts\n+++ b/cfg.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const t = '` + "ghp_" + `aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678';\n`,
    },
    {
      name: "sk-ant- (Anthropic)",
      diff: `--- a/cfg.ts\n+++ b/cfg.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const k = '` + "sk-ant-" + `api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE';\n`,
    },
    {
      name: "AKIA (AWS access key)",
      diff: `--- a/cfg.ts\n+++ b/cfg.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const a = '` + "AKIA" + `IOSFODNN7EXAM1234';\n`,
    },
    {
      name: "BEGIN PRIVATE KEY",
      diff: `--- a/key.pem\n+++ b/key.pem\n@@ -0,0 +1,1 @@\n+-----BEGIN PRIVATE KEY-----\n`,
    },
  ];

  for (const { name, diff } of secretDiffs) {
    it(`${name} — ok:false, pusher NOT called, client NOT called`, async () => {
      const { pusher, calls: pCalls } = makeFakePusher();
      const { client, calls: cCalls } = makeFakeClient();

      const result = await prepareAndOpenPR(
        { git: execGit, pusher, client },
        {
          repoDir,
          worktreePath: repoDir,
          branch: "ns/feature-abc123",
          baseSha,
          headSha: baseSha,
          remoteUrl: "https://github.com/owner/repo.git",
          owner: "owner",
          repo: "repo",
          diff,
          title: "PR title",
          body: "PR body",
        },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.blocked.some((b) => b.toLowerCase().includes("secret"))).toBe(true);
      }
      // CRITICAL: neither side effect must fire
      expect(pCalls).toHaveLength(0);
      expect(cCalls).toHaveLength(0);
    });
  }

  it("secret on a REMOVED line does NOT block (ignored by scanner)", async () => {
    const { pusher, calls: pCalls } = makeFakePusher();
    const { client } = makeFakeClient();
    // Secret appears only on a "-" (removed) line — scanner must ignore it.
    const removedSecretDiff = `--- a/old.ts\n+++ b/old.ts\n@@ -1,2 +1,1 @@\n const x = 1;\n-const k = '` + "sk-ant-" + `api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE';\n`;

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        repoDir,
        worktreePath: repoDir,
        branch: "ns/feature-abc123",
        baseSha,
        headSha: baseSha,
        remoteUrl: "https://github.com/owner/repo.git",
        owner: "owner",
        repo: "repo",
        diff: removedSecretDiff,
        title: "PR title",
        body: "PR body",
      },
    );

    // Removed-line secret must NOT block
    expect(result.ok).toBe(true);
    // Pusher was called (clean path)
    expect(pCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (B) CLEAN PATH — distrust flags + PR request shape
// ---------------------------------------------------------------------------

describe("(B) Clean path", () => {
  const cleanDiff = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const y = 2;\n`;

  it("pusher called with core.hooksPath=/dev/null, --no-verify, explicit remote URL", async () => {
    const { pusher, calls: pCalls } = makeFakePusher();
    const { client } = makeFakeClient();

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        repoDir,
        worktreePath: repoDir,
        branch: "ns/clean-abc123",
        baseSha,
        headSha: baseSha,
        remoteUrl: "https://github.com/owner/repo.git",
        owner: "owner",
        repo: "repo",
        diff: cleanDiff,
        title: "Clean PR",
        body: "Body",
      },
    );

    expect(result.ok).toBe(true);
    expect(pCalls).toHaveLength(1);

    const { args, env } = pCalls[0]!;
    // Distrust flags
    expect(args).toContain("core.hooksPath=/dev/null");
    expect(args).toContain("--no-verify");
    // Explicit remote URL (not a named remote like "origin")
    expect(args).toContain("https://github.com/owner/repo.git");
    // HEAD pushed to named branch
    expect(args).toContain("HEAD:refs/heads/ns/clean-abc123");
    // Env nulls out local/global config and disables prompts
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
    expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("ForgeClient called with POST /repos/:owner/:repo/pulls and correct body", async () => {
    const { pusher } = makeFakePusher();
    const { client, calls: cCalls } = makeFakeClient(99, "https://github.com/o/r/pull/99");

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        repoDir,
        worktreePath: repoDir,
        branch: "ns/clean-abc123",
        baseSha,
        headSha: baseSha,
        remoteUrl: "https://github.com/owner/repo.git",
        owner: "owner",
        repo: "repo",
        diff: cleanDiff,
        title: "My PR Title",
        body: "My PR body text",
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pr.number).toBe(99);
      expect(result.pr.url).toBe("https://github.com/o/r/pull/99");
    }

    expect(cCalls).toHaveLength(1);
    const req = cCalls[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/repos/owner/repo/pulls");
    const body = req.body as Record<string, unknown>;
    expect(body["head"]).toBe("ns/clean-abc123");
    expect(body["title"]).toBe("My PR Title");
    expect(body["body"]).toBe("My PR body text");
  });

  it("pusher called BEFORE client (push happens before PR open)", async () => {
    const order: string[] = [];
    const pusher: Pusher = async () => {
      order.push("push");
      return "";
    };
    const client: ForgeClient = {
      async request(): Promise<ForgeClientResponse> {
        order.push("pr");
        return { status: 201, json: { number: 1, html_url: "https://github.com/o/r/pull/1" } };
      },
    };

    await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        repoDir,
        worktreePath: repoDir,
        branch: "ns/order-abc123",
        baseSha,
        headSha: baseSha,
        remoteUrl: "https://github.com/owner/repo.git",
        owner: "owner",
        repo: "repo",
        diff: cleanDiff,
        title: "Order test",
        body: "",
      },
    );

    expect(order).toEqual(["push", "pr"]);
  });
});

// ---------------------------------------------------------------------------
// (C) FRESHNESS
// ---------------------------------------------------------------------------

describe("(C) Freshness gate", () => {
  it("baseSha === defaultBranch HEAD → fresh", async () => {
    const result = await checkBranchFreshness(execGit, {
      repoDir,
      baseSha,
      defaultBranch: "main",
    });
    expect(result.status).toBe("fresh");
    expect(result.baseSha).toBe(baseSha);
  });

  it("default branch advanced after recording baseSha → rebase", async () => {
    // Add a commit to main after recording baseSha
    const newHead = await addCommit(repoDir, "advance.txt", "newer");

    const result = await checkBranchFreshness(execGit, {
      repoDir,
      baseSha, // the SHA recorded at claim time (before the advance)
      defaultBranch: "main",
    });
    expect(result.status).toBe("rebase");
    expect(result.targetSha).toBe(newHead);
    expect(result.reason).toMatch(/ancestor/);
  });

  it("baseSha not an ancestor of defaultBranch (history rewritten) → block", async () => {
    // Create an orphan branch and force main to point there — baseSha is now unreachable.
    await execGit(["checkout", "--orphan", "tmp-orphan"], repoDir);
    writeFileSync(join(repoDir, "orphan"), "diverged");
    await execGit(["add", "."], repoDir);
    await execGit(
      ["-c", "user.name=Test", "-c", "user.email=test@test", "commit", "-m", "orphan"],
      repoDir,
    );
    const orphanSha = (await execGit(["rev-parse", "HEAD"], repoDir)).trim();
    await execGit(["branch", "-f", "main", orphanSha], repoDir);
    await execGit(["checkout", "main"], repoDir);

    const result = await checkBranchFreshness(execGit, {
      repoDir,
      baseSha, // original SHA — now unreachable from main
      defaultBranch: "main",
    });
    expect(result.status).toBe("block");
  });

  it("garbage baseSha → block", async () => {
    const result = await checkBranchFreshness(execGit, {
      repoDir,
      baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      defaultBranch: "main",
    });
    expect(result.status).toBe("block");
    expect(result.reason).toMatch(/not a known git object/);
  });
});

// ---------------------------------------------------------------------------
// (D) CI GATE
// ---------------------------------------------------------------------------

describe("(D) CI gate", () => {
  function runs(pairs: [string, CheckRun["status"]][]): CheckRun[] {
    return pairs.map(([name, status]) => ({ name, status }));
  }

  function fakeClient(checks: CheckRun[]): CiClient {
    return { async fetchChecks(_ref): Promise<CheckRun[]> { return checks; } };
  }

  it("all required checks success → green, no blocking", () => {
    const result = ciGate({
      requiredChecks: ["lint", "typecheck", "build"],
      checks: runs([["lint", "success"], ["typecheck", "success"], ["build", "success"]]),
    });
    expect(result.green).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("one failure → not green, blocking includes name(failure)", () => {
    const result = ciGate({
      requiredChecks: ["lint", "build"],
      checks: runs([["lint", "failure"], ["build", "success"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("lint(failure)");
    expect(result.blocking).not.toContain("build(failure)");
  });

  it("one pending → not green, blocking includes name(pending)", () => {
    const result = ciGate({
      requiredChecks: ["typecheck"],
      checks: runs([["typecheck", "pending"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("typecheck(pending)");
  });

  it("required check missing from runs → not green, blocking includes name(missing)", () => {
    const result = ciGate({
      requiredChecks: ["lint", "deploy"],
      checks: runs([["lint", "success"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("deploy(missing)");
  });

  it("multiple failures + missing → all names listed in blocking", () => {
    const result = ciGate({
      requiredChecks: ["a", "b", "c"],
      checks: runs([["a", "failure"], ["b", "pending"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("a(failure)");
    expect(result.blocking).toContain("b(pending)");
    expect(result.blocking).toContain("c(missing)");
  });

  it("skipped and neutral counts as passing", () => {
    const result = ciGate({
      requiredChecks: ["skip-ok", "neutral-ok"],
      checks: runs([["skip-ok", "skipped"], ["neutral-ok", "neutral"]]),
    });
    expect(result.green).toBe(true);
    expect(result.blocking).toHaveLength(0);
  });

  it("ciGateForRef (async) — success → green", async () => {
    const client = fakeClient(runs([["lint", "success"], ["build", "success"]]));
    const result = await ciGateForRef(client, "HEAD", ["lint", "build"]);
    expect(result.green).toBe(true);
  });

  it("ciGateForRef (async) — failure/pending/missing → blocked with names", async () => {
    const client = fakeClient(runs([["lint", "failure"]]));
    const result = await ciGateForRef(client, "HEAD", ["lint", "typecheck"]);
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("lint(failure)");
    expect(result.blocking).toContain("typecheck(missing)");
  });
});
