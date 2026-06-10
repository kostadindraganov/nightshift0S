/**
 * WHY: Submodule and Git LFS pointer changes in an outgoing diff are high-risk
 * operations that require explicit reviewer acknowledgment before the forge
 * service pushes. A compromised worktree could smuggle in submodule URL
 * redirections or LFS pointer swaps that look innocuous in CI but cause
 * unexpected side-effects post-merge (§2.6 / BLUEPRINT §3.12.25 threat model).
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SubmoduleLfsResult {
  needsAck: boolean;
  reasons: string[];
}

/**
 * Inspects both added (+) and context/removed lines of the diff for:
 *   - .gitmodules changes (any modification, add, or removal is flagged)
 *   - "Subproject commit" lines (submodule pointer changes)
 *   - Git-LFS pointer additions: "oid sha256:" / "version https://git-lfs"
 *
 * Returns `needsAck: true` if any of the above are found.
 */
export function detectSubmoduleOrLfs(diff: string): SubmoduleLfsResult {
  const reasons: string[] = [];
  const lines = diff.split("\n");

  let inGitmodules = false;
  let gitmodulesAdded = false;

  for (const line of lines) {
    // Detect diff header for .gitmodules
    if (line.startsWith("diff --git") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      if (line.includes(".gitmodules")) {
        inGitmodules = true;
      } else if (line.startsWith("diff --git")) {
        // Reset when entering a new file section
        inGitmodules = false;
      }
      continue;
    }

    if (inGitmodules && !gitmodulesAdded) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        gitmodulesAdded = true;
        reasons.push("Changes to .gitmodules detected");
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        gitmodulesAdded = true;
        reasons.push("Changes to .gitmodules detected");
      }
    }

    // Submodule pointer: "Subproject commit <sha>" on an added line
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      if (/^Subproject commit\s+[0-9a-f]{40}/i.test(content)) {
        if (!reasons.some((r) => r.startsWith("Submodule pointer"))) {
          reasons.push("Submodule pointer change (Subproject commit) detected");
        }
      }

      // Git-LFS pointer additions
      if (content.startsWith("oid sha256:")) {
        if (!reasons.some((r) => r.startsWith("Git-LFS"))) {
          reasons.push("Git-LFS pointer change (oid sha256:) detected");
        }
      }
      if (content.startsWith("version https://git-lfs")) {
        if (!reasons.some((r) => r.startsWith("Git-LFS"))) {
          reasons.push("Git-LFS pointer change (version https://git-lfs) detected");
        }
      }
    }
  }

  return {
    needsAck: reasons.length > 0,
    reasons,
  };
}
