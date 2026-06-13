/**
 * Tests for risk tier classification (UNIT 5.6a).
 *
 * Hermetic test harness (≤10 meaningful cases per module):
 *   - noiseFilter: drops lockfiles, *.min.*, *.snap; KEEPS drizzle/*.sql.
 *   - securityTouched: matches auth/crypto/secret/token/password/egress/sandbox/forge/credential paths.
 *   - classifyRiskTier: trivial = ≤10 lines ≤2 files; lite = moderate; full = >200 lines OR securityTouched.
 *     declaredTier is a FLOOR (never lower), securityTouched forces "full".
 *   - reviewersForTier: trivial→[correctness,security]; lite→[correctness,security,quality];
 *     full→[security,correctness,performance,quality,docs,agents_md].
 *   - coordinatorForTier: false for trivial, else true.
 *
 * Pure classifier (no IO, no DB, deterministic).
 */

import { describe, expect, test } from "bun:test";
import {
	classifyRiskTier,
	coordinatorForTier,
	noiseFilter,
	reviewersForTier,
	securityTouched,
} from "./riskTier.ts";

// ---------------------------------------------------------------------------
// 1. noiseFilter: drops lockfiles, *.min.*, *.snap; KEEPS migrations
// ---------------------------------------------------------------------------

describe("noiseFilter", () => {
	test("drops bun.lock and bun.lockb", () => {
		const diff = `diff --git a/bun.lock b/bun.lock
index aaa bbb 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,3 +1,4 @@
+generated lock
diff --git a/src/foo.ts b/src/foo.ts
index ccc ddd 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,2 @@
 code
`;
		const { keptFiles, droppedFiles } = noiseFilter(diff);
		expect(droppedFiles).toEqual(["bun.lock"]);
		expect(keptFiles).toEqual(["src/foo.ts"]);
	});

	test("drops package-lock.json, yarn.lock, pnpm-lock.yaml", () => {
		const diff = `diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
diff --git a/yarn.lock b/yarn.lock
--- a/yarn.lock
+++ b/yarn.lock
@@ -1 +1 @@
diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1 +1 @@
`;
		const { keptFiles, droppedFiles } = noiseFilter(diff);
		expect(droppedFiles).toContain("package-lock.json");
		expect(droppedFiles).toContain("yarn.lock");
		expect(droppedFiles).toContain("pnpm-lock.yaml");
		expect(keptFiles).toHaveLength(0);
	});

	test("drops *.min.js and *.min.css", () => {
		const diff = `diff --git a/dist/app.min.js b/dist/app.min.js
--- a/dist/app.min.js
+++ b/dist/app.min.js
@@ -1 +1 @@
diff --git a/styles.min.css b/styles.min.css
--- a/styles.min.css
+++ b/styles.min.css
@@ -1 +1 @@
diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1 +1 @@
`;
		const { keptFiles, droppedFiles } = noiseFilter(diff);
		expect(droppedFiles).toContain("dist/app.min.js");
		expect(droppedFiles).toContain("styles.min.css");
		expect(keptFiles).toEqual(["src/main.ts"]);
	});

	test("drops *.snap", () => {
		const diff = `diff --git a/src/__snapshots__/test.snap b/src/__snapshots__/test.snap
--- a/src/__snapshots__/test.snap
+++ b/src/__snapshots__/test.snap
@@ -1 +1 @@
diff --git a/src/test.ts b/src/test.ts
--- a/src/test.ts
+++ b/src/test.ts
@@ -1 +1 @@
`;
		const { keptFiles, droppedFiles } = noiseFilter(diff);
		expect(droppedFiles).toContain("src/__snapshots__/test.snap");
		expect(keptFiles).toEqual(["src/test.ts"]);
	});

	test("KEEPS drizzle/*.sql migrations (even though they look generated)", () => {
		const diff = `diff --git a/drizzle/0001_add_column.sql b/drizzle/0001_add_column.sql
--- a/drizzle/0001_add_column.sql
+++ b/drizzle/0001_add_column.sql
@@ -0,0 +1,3 @@
+ALTER TABLE foo ADD COLUMN bar TEXT;
diff --git a/drizzle/0002_index.sql b/drizzle/0002_index.sql
--- a/drizzle/0002_index.sql
+++ b/drizzle/0002_index.sql
@@ -0,0 +1,1 @@
+CREATE INDEX idx_foo ON foo(bar);
`;
		const { keptFiles, droppedFiles } = noiseFilter(diff);
		expect(droppedFiles).toHaveLength(0);
		expect(keptFiles).toEqual(["drizzle/0001_add_column.sql", "drizzle/0002_index.sql"]);
	});

	test("dedupes file paths", () => {
		const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
`;
		const { keptFiles } = noiseFilter(diff);
		expect(keptFiles).toEqual(["src/foo.ts"]);
		expect(keptFiles).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// 2. securityTouched: auth/crypto/secret/token/password/egress/sandbox/forge/credential
// ---------------------------------------------------------------------------

describe("securityTouched", () => {
	test("matches 'auth' in path", () => {
		expect(securityTouched(["src/auth/login.ts"])).toBe(true);
		expect(securityTouched(["src/auth.ts"])).toBe(true);
		expect(securityTouched(["AuthHandler.ts"])).toBe(true);
	});

	test("matches 'crypto' in path", () => {
		expect(securityTouched(["src/crypto/aes.ts"])).toBe(true);
		expect(securityTouched(["src/cryptoUtil.ts"])).toBe(true);
	});

	test("matches 'secret' in path", () => {
		expect(securityTouched(["src/secret/store.ts"])).toBe(true);
		expect(securityTouched(["secrets.json"])).toBe(true);
	});

	test("matches 'token' in path", () => {
		expect(securityTouched(["src/token/jwt.ts"])).toBe(true);
		expect(securityTouched(["tokenizer.ts"])).toBe(true);
	});

	test("matches 'password' in path", () => {
		expect(securityTouched(["src/password/hash.ts"])).toBe(true);
		expect(securityTouched(["password-reset.ts"])).toBe(true);
	});

	test("matches 'egress' in path", () => {
		expect(securityTouched(["src/egress/http.ts"])).toBe(true);
		expect(securityTouched(["egress-firewall.ts"])).toBe(true);
	});

	test("matches 'sandbox' in path", () => {
		expect(securityTouched(["src/sandbox/run.ts"])).toBe(true);
		expect(securityTouched(["sandbox-env.ts"])).toBe(true);
	});

	test("matches 'forge' in path", () => {
		expect(securityTouched(["src/forge/github.ts"])).toBe(true);
		expect(securityTouched(["forge-cli.ts"])).toBe(true);
	});

	test("matches 'credential' in path", () => {
		expect(securityTouched(["src/credential/store.ts"])).toBe(true);
		expect(securityTouched(["credentials.ts"])).toBe(true);
	});

	test("case-insensitive match", () => {
		expect(securityTouched(["src/AUTH/login.ts"])).toBe(true);
		expect(securityTouched(["src/CRYPTO/aes.ts"])).toBe(true);
		expect(securityTouched(["SeCrEt.ts"])).toBe(true);
	});

	test("returns false when no security pattern matches", () => {
		expect(securityTouched(["src/foo.ts"])).toBe(false);
		expect(securityTouched(["src/widget.ts", "src/util.ts"])).toBe(false);
		expect(securityTouched([])).toBe(false);
	});

	test("returns true if ANY file matches", () => {
		expect(securityTouched(["src/foo.ts", "src/auth.ts", "src/bar.ts"])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 3. classifyRiskTier: size-based tiers with security override and declared floor
// ---------------------------------------------------------------------------

describe("classifyRiskTier", () => {
	test("trivial: ≤10 lines, ≤2 files, no security", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,3 @@
 old
+new line 1
+new line 2
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,1 +1,2 @@
 old
+new
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("trivial");
		expect(result.securityTouched).toBe(false);
		expect(result.changedFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
		expect(result.reason).toContain("tiny change");
	});

	test("trivial threshold: exactly 10 lines, exactly 2 files", () => {
		const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,6 @@
+1
+2
+3
+4
+5
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,5 @@
+1
+2
+3
+4
+5
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("trivial");
	});

	test("NOT trivial: 11 lines (over threshold)", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,12 @@
+1
+2
+3
+4
+5
+6
+7
+8
+9
+10
+11
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).not.toBe("trivial");
	});

	test("NOT trivial: 3 files (over threshold)", () => {
		const diff = `--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
+1
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1,2 @@
+1
--- a/src/c.ts
+++ b/src/c.ts
@@ -1 +1,2 @@
+1
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).not.toBe("trivial");
	});

	test("lite: moderate size (11-200 lines, non-security)", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,50 @@
${Array(50)
	.fill("+line")
	.join("\n")}
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("lite");
		expect(result.reason).toContain("moderate change");
	});

	test("full: >200 changed lines", () => {
		const lines = Array(201)
			.fill("+changed line")
			.join("\n");
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,${201} @@
${lines}
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("full");
		expect(result.reason).toContain("large change");
	});

	test("full: security-touched (even if tiny)", () => {
		const diff = `--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1 +1,2 @@
 old
+security patch
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("full");
		expect(result.securityTouched).toBe(true);
		expect(result.reason).toContain("security-sensitive");
	});

	test("declaredTier acts as a FLOOR (escalates trivial → lite)", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,3 @@
+1
+2
+3
`;
		const result = classifyRiskTier({ diff, declaredTier: "lite" });
		expect(result.tier).toBe("lite");
		expect(result.reason).toContain("raised to declared floor");
	});

	test("declaredTier floor: escalates lite → full", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,50 @@
${Array(50)
	.fill("+line")
	.join("\n")}
`;
		const result = classifyRiskTier({ diff, declaredTier: "full" });
		expect(result.tier).toBe("full");
		expect(result.reason).toContain("raised to declared floor");
	});

	test("declaredTier does NOT lower: full stays full even if declaredTier=lite", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,${201} @@
${Array(201)
	.fill("+line")
	.join("\n")}
`;
		const result = classifyRiskTier({ diff, declaredTier: "lite" });
		expect(result.tier).toBe("full");
		expect(result.reason).not.toContain("raised to declared floor");
	});

	test("noiseFilter applied: lockfile change does not inflate tier", () => {
		const diff = `diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1 +1,2 @@
+one generated line
diff --git a/src/tiny.ts b/src/tiny.ts
--- a/src/tiny.ts
+++ b/src/tiny.ts
@@ -1 +1,2 @@
+one line
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("trivial");
		expect(result.changedFiles).toEqual(["src/tiny.ts"]);
	});

	test("security + large = full (obviously)", () => {
		const diff = `--- a/src/egress/http.ts
+++ b/src/egress/http.ts
@@ -1 +1,${201} @@
${Array(201)
	.fill("+line")
	.join("\n")}
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("full");
		expect(result.securityTouched).toBe(true);
	});

	test("security override beats a LOWER declared floor: declaredTier='trivial' + security → full", () => {
		// A task author cannot down-scope a security-touching change: security
		// forces full regardless of the declared floor (floor only escalates).
		const diff = `--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -1 +1,2 @@
+patch
`;
		const result = classifyRiskTier({ diff, declaredTier: "trivial" });
		expect(result.tier).toBe("full");
		expect(result.securityTouched).toBe(true);
	});

	test("security in a NON-dropped file flips tier even when a lockfile is the bulk of the diff", () => {
		// noiseFilter drops the lockfile, but the kept security file still forces full.
		const diff = `diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1 +1,2 @@
+generated
diff --git a/src/token/jwt.ts b/src/token/jwt.ts
--- a/src/token/jwt.ts
+++ b/src/token/jwt.ts
@@ -1 +1,2 @@
+rotate
`;
		const result = classifyRiskTier({ diff });
		expect(result.tier).toBe("full");
		expect(result.securityTouched).toBe(true);
		expect(result.changedFiles).toEqual(["src/token/jwt.ts"]);
	});

	test("declaredTier='trivial' on a moderate diff does NOT down-scope it (floor never lowers)", () => {
		const diff = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1,50 @@
${Array(50)
	.fill("+line")
	.join("\n")}
`;
		const result = classifyRiskTier({ diff, declaredTier: "trivial" });
		expect(result.tier).toBe("lite"); // stays at the size-derived tier, not lowered to trivial
	});
});

// ---------------------------------------------------------------------------
// 3b. noiseFilter: diff --git header parsing edge cases (renames, /dev/null)
// ---------------------------------------------------------------------------

describe("noiseFilter: diff --git header edge cases", () => {
	test("renamed file: both old and new paths are captured from the diff --git header", () => {
		const diff = `diff --git a/src/old.ts b/src/new.ts
similarity index 90%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1 +1,2 @@
+moved
`;
		const { keptFiles } = noiseFilter(diff);
		expect(keptFiles).toContain("src/old.ts");
		expect(keptFiles).toContain("src/new.ts");
	});

	test("added file (--- /dev/null): the /dev/null sentinel is ignored, real path kept", () => {
		const diff = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,2 @@
+brand new
`;
		const { keptFiles } = noiseFilter(diff);
		expect(keptFiles).toEqual(["src/added.ts"]);
		expect(keptFiles).not.toContain("/dev/null");
	});

	test("empty diff → no kept and no dropped files (no crash)", () => {
		const { keptFiles, droppedFiles } = noiseFilter("");
		expect(keptFiles).toHaveLength(0);
		expect(droppedFiles).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 4. reviewersForTier
// ---------------------------------------------------------------------------

describe("reviewersForTier", () => {
	test("trivial: [correctness, security]", () => {
		const reviewers = reviewersForTier("trivial");
		expect(reviewers).toEqual(["correctness", "security"]);
	});

	test("lite: [correctness, security, quality]", () => {
		const reviewers = reviewersForTier("lite");
		expect(reviewers).toEqual(["correctness", "security", "quality"]);
	});

	test("full: [security, correctness, performance, quality, docs, agents_md]", () => {
		const reviewers = reviewersForTier("full");
		expect(reviewers).toEqual(["security", "correctness", "performance", "quality", "docs", "agents_md"]);
	});

	test("order is deterministic (for parallel fan-out)", () => {
		const r1 = reviewersForTier("full");
		const r2 = reviewersForTier("full");
		expect(r1).toEqual(r2);
	});
});

// ---------------------------------------------------------------------------
// 5. coordinatorForTier
// ---------------------------------------------------------------------------

describe("coordinatorForTier", () => {
	test("trivial: false (skip coordinator, but still apply rubric)", () => {
		expect(coordinatorForTier("trivial")).toBe(false);
	});

	test("lite: true (run coordinator)", () => {
		expect(coordinatorForTier("lite")).toBe(true);
	});

	test("full: true (run coordinator)", () => {
		expect(coordinatorForTier("full")).toBe(true);
	});
});
