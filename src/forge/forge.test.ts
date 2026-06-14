/**
 * Tests for the full forge pipeline (§2.6 verify gate):
 *   - buildPushArgs contains distrust flags + core.hooksPath=/dev/null + --no-verify
 *   - pushEnv nulls out GIT_CONFIG_GLOBAL + GIT_CONFIG_SYSTEM
 *   - detectSubmoduleOrLfs flags .gitmodules / Subproject commit / LFS pointers
 *   - prepareAndOpenPR with planted secret: ok:false, pusher NOT called, client NOT called
 *   - prepareAndOpenPR clean run: pusher called with distrust args, client called, ok:true
 *   - validateRefs flags bogus baseSha on a real tmpdir repo
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit } from "../worktree/git.ts";
import { buildPushArgs, pushEnv } from "./push.ts";
import { detectSubmoduleOrLfs } from "./submodule.ts";
import { validateRefs } from "./refValidation.ts";
import { prepareAndOpenPR } from "./forge.ts";
import type { ForgeClient, ForgeClientRequest, ForgeClientResponse } from "./github.ts";
import type { Pusher } from "./push.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ns-forge-"));
}

async function initRepo(dir: string): Promise<string> {
  await execGit(["init"], dir);
  await execGit(["config", "user.email", "test@nightshift.local"], dir);
  await execGit(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  await execGit(["add", "."], dir);
  await execGit(["commit", "-m", "init"], dir);
  const sha = (await execGit(["rev-parse", "HEAD"], dir)).trim();
  return sha;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let repoDir: string;
let baseSha: string;

beforeEach(async () => {
  repoDir = tmpDir();
  baseSha = await initRepo(repoDir);
});

afterEach(() => {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// buildPushArgs
// ---------------------------------------------------------------------------

describe("buildPushArgs", () => {
  test("contains core.hooksPath=/dev/null", () => {
    const args = buildPushArgs({ remoteUrl: "https://github.com/o/r.git", branch: "ns/test" });
    expect(args).toContain("core.hooksPath=/dev/null");
  });

  test("contains --no-verify", () => {
    const args = buildPushArgs({ remoteUrl: "https://github.com/o/r.git", branch: "ns/test" });
    expect(args).toContain("--no-verify");
  });

  test("contains explicit remoteUrl (not a named remote)", () => {
    const url = "https://github.com/owner/repo.git";
    const args = buildPushArgs({ remoteUrl: url, branch: "ns/test" });
    expect(args).toContain(url);
  });

  test("pushes HEAD to the named branch ref", () => {
    const args = buildPushArgs({ remoteUrl: "https://github.com/o/r.git", branch: "ns/my-branch" });
    expect(args).toContain("HEAD:refs/heads/ns/my-branch");
  });

  test("starts with git -c flags", () => {
    const args = buildPushArgs({ remoteUrl: "https://x.com/r.git", branch: "ns/x" });
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe("core.hooksPath=/dev/null");
  });
});

// ---------------------------------------------------------------------------
// pushEnv
// ---------------------------------------------------------------------------

describe("pushEnv", () => {
  test("GIT_CONFIG_GLOBAL is /dev/null", () => {
    const env = pushEnv();
    expect(env["GIT_CONFIG_GLOBAL"]).toBe("/dev/null");
  });

  test("GIT_CONFIG_SYSTEM is /dev/null", () => {
    const env = pushEnv();
    expect(env["GIT_CONFIG_SYSTEM"]).toBe("/dev/null");
  });

  test("GIT_TERMINAL_PROMPT is 0", () => {
    const env = pushEnv();
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// detectSubmoduleOrLfs
// ---------------------------------------------------------------------------

describe("detectSubmoduleOrLfs", () => {
  test("flags .gitmodules change", () => {
    const diff = `diff --git a/.gitmodules b/.gitmodules\n--- a/.gitmodules\n+++ b/.gitmodules\n@@ -0,0 +1,3 @@\n+[submodule "vendor/lib"]\n+\tpath = vendor/lib\n+\turl = https://github.com/example/lib.git\n`;
    const result = detectSubmoduleOrLfs(diff);
    expect(result.needsAck).toBe(true);
    expect(result.reasons.some((r) => r.includes(".gitmodules"))).toBe(true);
  });

  test("flags Subproject commit line", () => {
    const diff = `--- a/vendor/lib\n+++ b/vendor/lib\n@@ -1 +1 @@\n-Subproject commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+Subproject commit bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n`;
    const result = detectSubmoduleOrLfs(diff);
    expect(result.needsAck).toBe(true);
    expect(result.reasons.some((r) => r.includes("Subproject commit"))).toBe(true);
  });

  test("flags Git-LFS oid sha256: pointer", () => {
    const diff = `--- a/large.bin\n+++ b/large.bin\n@@ -1,3 +1,3 @@\n version https://git-lfs.github.com/spec/v1\n-oid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n+oid sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n`;
    const result = detectSubmoduleOrLfs(diff);
    expect(result.needsAck).toBe(true);
    expect(result.reasons.some((r) => r.includes("oid sha256:"))).toBe(true);
  });

  test("flags Git-LFS version line", () => {
    const diff = `--- a/img.png\n+++ b/img.png\n@@ -0,0 +1,3 @@\n+version https://git-lfs.github.com/spec/v1\n+oid sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\n+size 1024\n`;
    const result = detectSubmoduleOrLfs(diff);
    expect(result.needsAck).toBe(true);
  });

  test("clean diff has no needsAck", () => {
    const diff = `--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const y = 2;\n`;
    const result = detectSubmoduleOrLfs(diff);
    expect(result.needsAck).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// validateRefs on real tmpdir repo
// ---------------------------------------------------------------------------

describe("validateRefs", () => {
  test("passes with real baseSha and valid branch", async () => {
    const result = await validateRefs(execGit, repoDir, {
      branch: "ns/my-feature-abc123",
      baseSha,
    });
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
  });

  test("flags bogus baseSha", async () => {
    const result = await validateRefs(execGit, repoDir, {
      branch: "ns/my-feature-abc123",
      baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("baseSha"))).toBe(true);
  });

  test("flags invalid branch name with spaces", async () => {
    const result = await validateRefs(execGit, repoDir, {
      branch: "ns/bad branch name",
      baseSha,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("branch"))).toBe(true);
  });

  test("flags invalid branch name with ..", async () => {
    const result = await validateRefs(execGit, repoDir, {
      branch: "ns/../etc/passwd",
      baseSha,
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("branch"))).toBe(true);
  });

  test("flags bogus headSha when provided", async () => {
    const result = await validateRefs(execGit, repoDir, {
      branch: "ns/ok-branch-abc123",
      baseSha,
      headSha: "0000000000000000000000000000000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => p.includes("headSha"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// prepareAndOpenPR — fake pusher + fake client
// ---------------------------------------------------------------------------

describe("prepareAndOpenPR", () => {
  /** A diff with a planted Anthropic API key on an added line. */
  const secretDiff = `--- a/config.ts\n+++ b/config.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const apiKey = '` + "sk-ant-" + `api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE';\n`;

  /** A clean diff with no secrets. */
  const cleanDiff = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,2 @@\n const x = 1;\n+const y = 2;\n`;

  function makeFakePusher(): { pusher: Pusher; state: { called: boolean; lastArgs: string[] } } {
    const state = { called: false, lastArgs: [] as string[] };
    const pusher: Pusher = async (args, _cwd, _env) => {
      state.called = true;
      state.lastArgs = args;
      return "";
    };
    return { pusher, state };
  }

  function makeFakeClient(prNumber = 42, prUrl = "https://github.com/o/r/pull/42"): {
    client: ForgeClient;
    state: { called: boolean; lastReq: ForgeClientRequest | null };
  } {
    const state = { called: false, lastReq: null as ForgeClientRequest | null };
    const client: ForgeClient = {
      async request(req: ForgeClientRequest): Promise<ForgeClientResponse> {
        state.called = true;
        state.lastReq = req;
        return {
          status: 201,
          json: { number: prNumber, html_url: prUrl },
        };
      },
    };
    return { client, state };
  }

  const baseInput = {
    worktreePath: "/fake/worktree",
    remoteUrl: "https://github.com/owner/repo.git",
    branch: "ns/test-feature-abc123",
    owner: "owner",
    repo: "repo",
    defaultBranch: "main",
    title: "Test PR",
    body: "Test body",
  };

  test("planted secret returns ok:false, pusher NOT called, client NOT called", async () => {
    const { pusher, state: pState } = makeFakePusher();
    const { client, state: cState } = makeFakeClient();

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        ...baseInput,
        repoDir,
        baseSha,
        headSha: baseSha,
        diff: secretDiff,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked.some((b) => b.includes("Secret"))).toBe(true);
    }

    // CRITICAL: pusher and client must NOT have been called
    expect(pState.called).toBe(false);
    expect(cState.called).toBe(false);
  });

  test("clean run calls pusher with distrust args then client with correct PR request", async () => {
    const { pusher, state: pState } = makeFakePusher();
    const { client, state: cState } = makeFakeClient();

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        ...baseInput,
        repoDir,
        baseSha,
        headSha: baseSha,
        diff: cleanDiff,
      },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.pr.number).toBe(42);
      expect(result.pr.url).toBe("https://github.com/o/r/pull/42");
    }

    // Pusher was called with distrust args
    expect(pState.called).toBe(true);
    expect(pState.lastArgs).toContain("core.hooksPath=/dev/null");
    expect(pState.lastArgs).toContain("--no-verify");
    expect(pState.lastArgs).toContain("https://github.com/owner/repo.git");
    expect(pState.lastArgs).toContain("HEAD:refs/heads/ns/test-feature-abc123");

    // Client was called with correct POST request
    expect(cState.called).toBe(true);
    expect(cState.lastReq?.method).toBe("POST");
    expect(cState.lastReq?.path).toBe("/repos/owner/repo/pulls");
    const body = cState.lastReq?.body as Record<string, unknown>;
    expect(body["head"]).toBe("ns/test-feature-abc123");
    expect(body["base"]).toBe("main");
    expect(body["title"]).toBe("Test PR");
  });

  test("submodule change without ack blocks and pusher NOT called", async () => {
    const submoduleDiff = `diff --git a/.gitmodules b/.gitmodules\n--- a/.gitmodules\n+++ b/.gitmodules\n@@ -0,0 +1,3 @@\n+[submodule "lib"]\n+\tpath = lib\n+\turl = https://github.com/example/lib.git\n`;
    const { pusher, state: pState } = makeFakePusher();
    const { client, state: cState } = makeFakeClient();

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        ...baseInput,
        repoDir,
        baseSha,
        headSha: baseSha,
        diff: submoduleDiff,
        submoduleAck: false,
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked.some((b) => b.includes("Submodule"))).toBe(true);
    }
    expect(pState.called).toBe(false);
    expect(cState.called).toBe(false);
  });

  test("submodule change WITH ack and clean diff proceeds", async () => {
    const submoduleDiff = `diff --git a/.gitmodules b/.gitmodules\n--- a/.gitmodules\n+++ b/.gitmodules\n@@ -0,0 +1,3 @@\n+[submodule "lib"]\n+\tpath = lib\n+\turl = https://github.com/example/lib.git\n`;
    const { pusher, state: pState } = makeFakePusher();
    const { client, state: cState } = makeFakeClient();

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        ...baseInput,
        repoDir,
        baseSha,
        headSha: baseSha,
        diff: submoduleDiff,
        submoduleAck: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(pState.called).toBe(true);
    expect(cState.called).toBe(true);
  });

  test("bogus baseSha blocks and pusher NOT called", async () => {
    const { pusher, state: pState } = makeFakePusher();
    const { client, state: cState } = makeFakeClient();

    const result = await prepareAndOpenPR(
      { git: execGit, pusher, client },
      {
        ...baseInput,
        repoDir,
        baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        headSha: baseSha,
        diff: cleanDiff,
      },
    );

    expect(result.ok).toBe(false);
    expect(pState.called).toBe(false);
    expect(cState.called).toBe(false);
  });
});
