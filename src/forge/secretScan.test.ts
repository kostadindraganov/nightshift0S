/**
 * Tests for secretScan.ts (§2.6 verify gate).
 *
 * Rules verified:
 *   - BLOCKS planted secrets on added lines
 *   - PASSES clean diffs
 *   - IGNORES secrets on removed lines ("-")
 *   - Masks preview correctly
 *   - Placeholders are not flagged by the generic heuristic
 */

import { describe, test, expect } from "bun:test";
import { scanDiff, hasBlockingSecrets } from "./secretScan.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap content as a minimal unified diff added line. */
function addedDiff(content: string): string {
  return `--- a/test.ts\n+++ b/test.ts\n@@ -1,1 +1,2 @@\n context line\n+${content}\n`;
}

/** Wrap content as a removed line. */
function removedDiff(content: string): string {
  return `--- a/test.ts\n+++ b/test.ts\n@@ -1,2 +1,1 @@\n context line\n-${content}\n`;
}

// ---------------------------------------------------------------------------
// GitHub PAT (classic)
// ---------------------------------------------------------------------------

describe("GitHub classic PAT", () => {
  test("blocks ghp_ token in added line", () => {
    const diff = addedDiff("const token = '" + "ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "github-pat-classic")).toBe(true);
  });

  test("blocks gho_ token", () => {
    const diff = addedDiff("const x = 'gho_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
  });

  test("blocks ghs_ token", () => {
    const diff = addedDiff("const x = 'ghs_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
  });

  test("ignores ghp_ token on removed line", () => {
    const diff = removedDiff("const token = '" + "ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GitHub fine-grained PAT
// ---------------------------------------------------------------------------

describe("GitHub fine-grained PAT", () => {
  test("blocks github_pat_ token in added line", () => {
    const diff = addedDiff("const t = '" + "github_pat_" + "11ABCDEF0123456789012345678901234567890'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "github-pat-fine-grained")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Anthropic key
// ---------------------------------------------------------------------------

describe("Anthropic API key", () => {
  test("blocks sk-ant- key in added line", () => {
    const diff = addedDiff("const key = '" + "sk-ant-" + "api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "anthropic-api-key")).toBe(true);
  });

  test("ignores sk-ant- on removed line", () => {
    const diff = removedDiff("const key = '" + "sk-ant-" + "api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AWS Access Key ID
// ---------------------------------------------------------------------------

describe("AWS Access Key ID", () => {
  test("blocks AKIA... key in added line", () => {
    const diff = addedDiff("AWS_ACCESS_KEY_ID = " + "AKIA" + "IOSFODNN7EXAMPLE");
    // Note: EXAMPLE makes this look like a real key — AKIA + 16 uppercase alphanum
    const diff2 = addedDiff("const k = '" + "AKIA" + "IOSFODNN7EXAM1234'");
    const findings = scanDiff(diff2);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "aws-access-key-id")).toBe(true);
  });

  test("ignores AKIA key on removed line", () => {
    const diff = removedDiff("const k = '" + "AKIA" + "IOSFODNN7EXAM1234'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpenAI key
// ---------------------------------------------------------------------------

describe("OpenAI API key", () => {
  test("blocks sk- key in added line", () => {
    const diff = addedDiff("const k = '" + "sk-" + "abcdefghijklmnopqrst1234'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "openai-api-key")).toBe(true);
  });

  test("blocks sk-proj- key in added line", () => {
    const diff = addedDiff("const k = '" + "sk-" + "proj-abcdefghijklmnopqrst1234567890'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Private key block
// ---------------------------------------------------------------------------

describe("Private key block", () => {
  test("blocks RSA private key header in added line", () => {
    const diff = addedDiff("-----BEGIN RSA PRIVATE KEY-----");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "private-key-header")).toBe(true);
  });

  test("blocks OPENSSH private key header in added line", () => {
    const diff = addedDiff("-----BEGIN OPENSSH PRIVATE KEY-----");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
  });

  test("ignores private key header on removed line", () => {
    const diff = removedDiff("-----BEGIN RSA PRIVATE KEY-----");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Google API key
// ---------------------------------------------------------------------------

describe("Google API key", () => {
  test("blocks AIza... key in added line", () => {
    const diff = addedDiff("const gkey = '" + "AIza" + "SyB1234567890abcdefghijklmnopqrstuvw'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "google-api-key")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Slack token
// ---------------------------------------------------------------------------

describe("Slack token", () => {
  test("blocks xoxb- token in added line", () => {
    const diff = addedDiff("const slack = '" + "xoxb-" + "1234567890-abcdefghijklmnopqrst'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "slack-token")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Generic secret assignment heuristic
// ---------------------------------------------------------------------------

describe("Generic secret assignment heuristic", () => {
  test("blocks long quoted value for 'token' assignment", () => {
    const diff = addedDiff("const myToken = 'supersecretvalue123456789012345678'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
    expect(findings.some((f) => f.rule === "generic-secret-assignment")).toBe(true);
  });

  test("blocks long quoted value for 'password' assignment", () => {
    const diff = addedDiff("password = 'myReallyLongPassword123456789'");
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(true);
  });

  test("does NOT block obvious placeholder (xxxx)", () => {
    const diff = addedDiff("const token = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'");
    const findings = scanDiff(diff).filter((f) => f.rule === "generic-secret-assignment");
    expect(findings.length).toBe(0);
  });

  test("does NOT block 'changeme' placeholder", () => {
    const diff = addedDiff("const token = 'changeme_this_is_a_placeholder_12345'");
    const findings = scanDiff(diff).filter((f) => f.rule === "generic-secret-assignment");
    expect(findings.length).toBe(0);
  });

  test("does NOT block 'example' placeholder", () => {
    const diff = addedDiff("const token = 'example-long-placeholder-value-here'");
    const findings = scanDiff(diff).filter((f) => f.rule === "generic-secret-assignment");
    expect(findings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Clean diff passes
// ---------------------------------------------------------------------------

describe("Clean diff passes", () => {
  test("empty diff has no findings", () => {
    expect(scanDiff("")).toHaveLength(0);
    expect(hasBlockingSecrets([])).toBe(false);
  });

  test("diff with only safe added lines has no findings", () => {
    const diff = `--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,3 @@\n context\n+const x = 42;\n+const name = "hello";\n`;
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(false);
  });

  test("secret on removed line does not block", () => {
    const diff = `--- a/old.ts\n+++ b/old.ts\n@@ -1,2 +1,1 @@\n context\n-const key = '` + "sk-ant-" + `api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE';\n`;
    const findings = scanDiff(diff);
    expect(hasBlockingSecrets(findings)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Preview masking
// ---------------------------------------------------------------------------

describe("Preview masking", () => {
  test("preview masks the middle of the secret", () => {
    const diff = addedDiff("const k = '" + "ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678'");
    const findings = scanDiff(diff);
    const f = findings.find((x) => x.rule === "github-pat-classic");
    expect(f).toBeDefined();
    // Preview should contain *** and not expose the full token
    expect(f?.preview).toContain("***");
    // Should NOT contain the full token
    expect(f?.preview).not.toBe("ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678");
  });
});
