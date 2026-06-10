/**
 * Tests for the egress allowlist generator and refuse-unattended gate.
 *
 * All tests are pure / macOS-runnable — no nft binary required, no network.
 * Live nftables enforcement is Linux-runtime-pending.
 */

import { describe, expect, test } from "bun:test";
import {
  buildNftablesRuleset,
  buildProxyAllowlist,
  defaultAllowedHosts,
  type EgressConfig,
} from "./allowlist.ts";
import { assertEgressOrRefuse, EgressInactiveError } from "./guard.ts";

// ---------------------------------------------------------------------------
// buildNftablesRuleset
// ---------------------------------------------------------------------------

describe("buildNftablesRuleset", () => {
  const cfg: EgressConfig = {
    uid: 1234,
    allowedHosts: ["api.anthropic.com", "api.openai.com", "github.com", "api.github.com"],
  };

  test("includes a comment or rule naming each allowed host", () => {
    const ruleset = buildNftablesRuleset(cfg);
    for (const host of cfg.allowedHosts) {
      expect(ruleset).toContain(host);
    }
  });

  test("includes a DNS allow rule (udp port 53)", () => {
    const ruleset = buildNftablesRuleset(cfg);
    expect(ruleset).toContain("udp dport 53 accept");
  });

  test("includes a DNS allow rule (tcp port 53)", () => {
    const ruleset = buildNftablesRuleset(cfg);
    expect(ruleset).toContain("tcp dport 53 accept");
  });

  test("includes an established/related allow rule", () => {
    const ruleset = buildNftablesRuleset(cfg);
    expect(ruleset).toContain("ct state established,related accept");
  });

  test("scopes rules to the correct skuid", () => {
    const ruleset = buildNftablesRuleset(cfg);
    expect(ruleset).toContain(`skuid ${cfg.uid}`);
  });

  test("does NOT accidentally scope to a different uid", () => {
    const ruleset = buildNftablesRuleset(cfg);
    // uid 9999 must not appear anywhere
    expect(ruleset).not.toContain("skuid 9999");
  });

  test("ends with a default drop rule — the security-critical property", () => {
    const ruleset = buildNftablesRuleset(cfg);
    // The default drop must appear after the allow rules.
    const dropIndex = ruleset.lastIndexOf("drop");
    expect(dropIndex).toBeGreaterThan(-1);

    // Verify the drop is the LAST substantive rule (nothing allows traffic after it).
    const afterDrop = ruleset.slice(dropIndex + "drop".length);
    // Only closing braces and whitespace are allowed after the drop line.
    expect(afterDrop.trim().replace(/[}\n\r\s]/g, "")).toBe("");
  });

  test("default drop is associated with the correct uid", () => {
    const ruleset = buildNftablesRuleset(cfg);
    // Find the line containing the drop and verify it mentions the uid.
    const lines = ruleset.split("\n");
    const dropLine = lines.find((l) => l.includes("drop") && !l.startsWith("#"));
    expect(dropLine).toBeDefined();
    expect(dropLine).toContain(`skuid ${cfg.uid}`);
  });

  test("each allowed host is assigned a named set placeholder", () => {
    const ruleset = buildNftablesRuleset(cfg);
    for (let i = 0; i < cfg.allowedHosts.length; i++) {
      expect(ruleset).toContain(`allowed_ips_${i}`);
    }
  });

  test("documents that name->IP resolution happens at apply time", () => {
    const ruleset = buildNftablesRuleset(cfg);
    expect(ruleset.toLowerCase()).toContain("apply time");
  });

  test("different uids produce different rulesets", () => {
    const r1 = buildNftablesRuleset({ ...cfg, uid: 1000 });
    const r2 = buildNftablesRuleset({ ...cfg, uid: 2000 });
    expect(r1).not.toBe(r2);
    expect(r1).toContain("skuid 1000");
    expect(r2).toContain("skuid 2000");
  });
});

// ---------------------------------------------------------------------------
// defaultAllowedHosts
// ---------------------------------------------------------------------------

describe("defaultAllowedHosts", () => {
  test("always includes github.com", () => {
    expect(defaultAllowedHosts([])).toContain("github.com");
  });

  test("always includes api.github.com", () => {
    expect(defaultAllowedHosts([])).toContain("api.github.com");
  });

  test("includes all given provider endpoints", () => {
    const providers = ["api.anthropic.com", "api.openai.com"];
    const result = defaultAllowedHosts(providers);
    for (const p of providers) {
      expect(result).toContain(p);
    }
  });

  test("deduplicates entries", () => {
    const result = defaultAllowedHosts(["github.com", "api.anthropic.com"]);
    const githubCount = result.filter((h) => h === "github.com").length;
    expect(githubCount).toBe(1);
  });

  test("returns an array (not a set or other structure)", () => {
    expect(Array.isArray(defaultAllowedHosts([]))).toBe(true);
  });

  test("empty provider list still returns GitHub hosts", () => {
    const result = defaultAllowedHosts([]);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// buildProxyAllowlist
// ---------------------------------------------------------------------------

describe("buildProxyAllowlist", () => {
  test("returns the allowed hosts list", () => {
    const cfg: EgressConfig = { uid: 1, allowedHosts: ["api.anthropic.com", "github.com"] };
    const result = buildProxyAllowlist(cfg);
    expect(result.allow).toEqual(cfg.allowedHosts);
  });

  test("does not mutate the original config", () => {
    const hosts = ["api.anthropic.com"];
    const cfg: EgressConfig = { uid: 1, allowedHosts: hosts };
    const result = buildProxyAllowlist(cfg);
    result.allow.push("injected.com");
    expect(cfg.allowedHosts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// assertEgressOrRefuse — fail-closed gate
// ---------------------------------------------------------------------------

describe("assertEgressOrRefuse", () => {
  test("THROWS when unattended + untrusted + egress inactive", () => {
    expect(() =>
      assertEgressOrRefuse({ unattended: true, trustedRepo: false, egressActive: false }),
    ).toThrow(EgressInactiveError);
  });

  test("thrown error contains the required message text", () => {
    expect(() =>
      assertEgressOrRefuse({ unattended: true, trustedRepo: false, egressActive: false }),
    ).toThrow("unattended runs on untrusted repos are disabled until egress control is active");
  });

  test("does NOT throw when egress is active (even if unattended + untrusted)", () => {
    expect(() =>
      assertEgressOrRefuse({ unattended: true, trustedRepo: false, egressActive: true }),
    ).not.toThrow();
  });

  test("does NOT throw when repo is trusted (even if unattended + egress inactive)", () => {
    expect(() =>
      assertEgressOrRefuse({ unattended: true, trustedRepo: true, egressActive: false }),
    ).not.toThrow();
  });

  test("does NOT throw for attended runs (even if untrusted + egress inactive)", () => {
    expect(() =>
      assertEgressOrRefuse({ unattended: false, trustedRepo: false, egressActive: false }),
    ).not.toThrow();
  });

  test("does NOT throw when all permissive (attended + trusted + active)", () => {
    expect(() =>
      assertEgressOrRefuse({ unattended: false, trustedRepo: true, egressActive: true }),
    ).not.toThrow();
  });

  test("EgressInactiveError has correct name", () => {
    let caught: unknown;
    try {
      assertEgressOrRefuse({ unattended: true, trustedRepo: false, egressActive: false });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EgressInactiveError);
    expect((caught as EgressInactiveError).name).toBe("EgressInactiveError");
  });
});
