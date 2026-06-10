/**
 * WHY: Orchestrates the worktree-distrusting pre-push pipeline:
 *   1. Validate refs (branch name + sha existence)
 *   2. Secret-scan the diff — BLOCK if blocking secrets found
 *   3. Detect submodule/LFS changes — BLOCK if needs ack and no ack given
 *   4. Push via distrust args/env (injected pusher)
 *   5. Open the pull request (injected ForgeClient)
 *
 * All side-effecting dependencies (git runner, pusher, GitHub client) are
 * injectable so every gate decision is testable on macOS without network or
 * live creds (§2.6 / BLUEPRINT §3.12.25 threat model).
 *
 * DEPLOY-PENDING: live push and live PR open require a real remote + host
 * GitHub token. The construction/decision logic is fully tested here.
 */

import type { GitRunner } from "./refValidation.ts";
import { validateRefs } from "./refValidation.ts";
import { scanDiff, hasBlockingSecrets } from "./secretScan.ts";
import { detectSubmoduleOrLfs } from "./submodule.ts";
import { pushValidated } from "./push.ts";
import type { Pusher } from "./push.ts";
import { openPullRequest } from "./github.ts";
import type { ForgeClient } from "./github.ts";
import { execGit } from "../worktree/git.ts";
import { defaultPusher } from "./push.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgeDeps {
  git?: GitRunner;
  pusher?: Pusher;
  client: ForgeClient;
}

export interface ForgeInput {
  repoDir: string;
  worktreePath: string;
  branch: string;
  baseSha: string;
  headSha: string;
  remoteUrl: string;
  owner: string;
  repo: string;
  diff: string;
  title: string;
  body: string;
  submoduleAck?: boolean;
}

export type ForgeResult =
  | { ok: true; pr: { number: number; url: string } }
  | { ok: false; blocked: string[] };

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Runs the full worktree-distrusting pre-push pipeline.
 * Returns `ok:false` with reasons if any gate fails; never pushes when blocked.
 */
export async function prepareAndOpenPR(
  deps: ForgeDeps,
  input: ForgeInput,
): Promise<ForgeResult> {
  const git: GitRunner = deps.git ?? execGit;
  const pusher: Pusher = deps.pusher ?? defaultPusher;

  const blocked: string[] = [];

  // ── Gate 1: Validate refs ──────────────────────────────────────────────
  const refsResult = await validateRefs(git, input.repoDir, {
    branch: input.branch,
    baseSha: input.baseSha,
    headSha: input.headSha,
  });
  if (!refsResult.ok) {
    blocked.push(...refsResult.problems);
  }

  // ── Gate 2: Secret scan ────────────────────────────────────────────────
  const findings = scanDiff(input.diff);
  if (hasBlockingSecrets(findings)) {
    for (const f of findings) {
      blocked.push(`Secret detected [${f.rule}] at line ${f.line}: ${f.preview}`);
    }
  }

  // ── Gate 3: Submodule / LFS ────────────────────────────────────────────
  const subResult = detectSubmoduleOrLfs(input.diff);
  if (subResult.needsAck && !input.submoduleAck) {
    for (const r of subResult.reasons) {
      blocked.push(`Submodule/LFS change requires explicit reviewer ack: ${r}`);
    }
  }

  // ── BLOCK if any gate failed ───────────────────────────────────────────
  if (blocked.length > 0) {
    return { ok: false, blocked };
  }

  // ── Gate 4: Push ──────────────────────────────────────────────────────
  await pushValidated(pusher, {
    worktreePath: input.worktreePath,
    remoteUrl: input.remoteUrl,
    branch: input.branch,
  });

  // ── Gate 5: Open PR ───────────────────────────────────────────────────
  const pr = await openPullRequest(deps.client, {
    owner: input.owner,
    repo: input.repo,
    head: input.branch,
    base: input.baseSha,
    title: input.title,
    body: input.body,
  });

  return { ok: true, pr };
}
