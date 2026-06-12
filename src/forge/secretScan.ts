/**
 * WHY: The forge service must secret-scan outgoing diffs BEFORE pushing to
 * prevent accidental credential exposure. Only added lines ("+") are scanned —
 * removed lines are already out of scope once they're gone. Findings must be
 * actionable: rule name, line number, masked preview. A single blocking finding
 * halts the push pipeline (§2.6 / BLUEPRINT §3.12.25 threat model).
 */

export interface SecretFinding {
  rule: string;
  line: number;
  preview: string;
}

// ---------------------------------------------------------------------------
// Mask helpers
// ---------------------------------------------------------------------------

/** Show first 4 and last 4 chars; mask everything in between. */
function mask(value: string): string {
  if (value.length <= 8) return "***";
  return value.slice(0, 4) + "***" + value.slice(-4);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface SecretRule {
  name: string;
  /** Pattern to test the added-line content. */
  pattern: RegExp;
  /** Optional: extract the secret value for masking. If omitted, uses full match. */
  extract?: (match: RegExpMatchArray) => string;
}

/**
 * The canonical secret rule set, exported so other modules (thread redaction,
 * §3.2) can reuse the exact same patterns. Do NOT change any pattern here —
 * scanDiff/hasBlockingSecrets behaviour is locked by secretScan.test.ts.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // GitHub classic PATs (ghp_ / gho_ / ghu_ / ghs_ / ghr_ + ~36 base62)
  // Real tokens are AKIA+36 chars; use 35+ to handle slight variations in test tokens.
  {
    name: "github-pat-classic",
    pattern: /\b(gh[pours]_[A-Za-z0-9]{35,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // GitHub fine-grained PAT
  {
    name: "github-pat-fine-grained",
    pattern: /\b(github_pat_[A-Za-z0-9_]{35,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // OpenAI standard key
  {
    name: "openai-api-key",
    pattern: /\b(sk-[A-Za-z0-9]{20,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // OpenAI project key (sk-proj-)
  {
    name: "openai-project-key",
    pattern: /\b(sk-proj-[A-Za-z0-9_\-]{20,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // Anthropic API key
  {
    name: "anthropic-api-key",
    pattern: /\b(sk-ant-[A-Za-z0-9_\-]{20,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // AWS Access Key ID — real keys are AKIA+16 uppercase alphanum; use 16+ to be safe
  {
    name: "aws-access-key-id",
    pattern: /\b(AKIA[0-9A-Z]{16,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // AWS secret assignments (aws_secret_access_key = "...")
  {
    name: "aws-secret-assignment",
    pattern: /aws[_\-]?secret[_\-]?access[_\-]?key\s*[=:]\s*["']?([A-Za-z0-9/+]{40})["']?/i,
    extract: (m) => m[1] ?? m[0],
  },
  // Google API key — AIza + 35 chars (common format is AIza + 35 alphanum/_/-)
  {
    name: "google-api-key",
    pattern: /\b(AIza[0-9A-Za-z_\-]{35,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // Slack tokens
  {
    name: "slack-token",
    pattern: /\b(xox[baprs]-[A-Za-z0-9\-]{10,})\b/,
    extract: (m) => m[1] ?? m[0],
  },
  // Private key blocks
  {
    name: "private-key-header",
    pattern: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/,
    extract: (m) => m[0],
  },
  // Generic high-signal assignment: identifier with token/secret/api_key/password/passwd
  // assigned a quoted string >= 16 chars that is NOT an obvious placeholder.
  {
    name: "generic-secret-assignment",
    pattern:
      /(?:token|secret|api[-_]?key|password|passwd)\s*[=:]\s*["']([^"']{16,})["']/i,
    extract: (m) => {
      const val = m[1] ?? "";
      // Filter out obvious placeholders
      const lower = val.toLowerCase();
      if (
        lower.includes("xxxx") ||
        lower.includes("changeme") ||
        lower.includes("example") ||
        lower.includes("your_") ||
        lower.includes("<your") ||
        lower.includes("placeholder") ||
        lower.includes("replace") ||
        lower.includes("todo")
      ) {
        return "";
      }
      return val;
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scans only added lines (lines starting with "+", excluding "+++" headers)
 * of a unified diff for secrets. Returns all findings with masked previews.
 */
export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = diff.split("\n");

  // Track the actual source line number from diff hunk headers
  // Format: @@ -old_start,old_count +new_start,new_count @@
  let newLineNum = 0;

  for (const rawLine of lines) {
    // Parse hunk header to track line numbers
    if (rawLine.startsWith("@@")) {
      const m = rawLine.match(/@@ [^+]*\+(\d+)/);
      if (m?.[1]) {
        newLineNum = parseInt(m[1], 10) - 1;
      }
      continue;
    }

    // Track context lines (space-prefix or no prefix in some diff formats)
    if (rawLine.startsWith(" ") || rawLine === "") {
      newLineNum++;
      continue;
    }

    // Removed lines — skip scanning
    if (rawLine.startsWith("-")) {
      continue;
    }

    // Added lines
    if (rawLine.startsWith("+")) {
      newLineNum++;

      // Skip the "+++ b/file" diff header lines
      if (rawLine.startsWith("+++")) {
        continue;
      }

      const content = rawLine.slice(1); // Strip the leading "+"

      for (const rule of SECRET_RULES) {
        const m = content.match(rule.pattern);
        if (!m) continue;

        const secretValue = rule.extract ? rule.extract(m) : (m[0] ?? "");
        // Skip if the extractor filtered it out (placeholder logic)
        if (!secretValue) continue;

        findings.push({
          rule: rule.name,
          line: newLineNum,
          preview: mask(secretValue),
        });
      }
    }
  }

  return findings;
}

/**
 * Returns true if any finding should block the push.
 * Currently all findings are blocking — a finding on a removed line would not
 * reach here because scanDiff already ignores removed lines.
 */
export function hasBlockingSecrets(findings: SecretFinding[]): boolean {
  return findings.length > 0;
}
