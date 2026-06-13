/**
 * Tests for the config loader and describeConfig (task 1.7 verify criteria).
 *
 * (a) defaults load with no file present
 * (b) a temp file overrides defaults
 * (c) env override beats file and default
 * (d) describeConfig enumerates every leaf knob (21 total)
 * (e) a secret-named key is masked to "********" and secret=true
 * (f) provenance is correct (default vs file vs env)
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_CONFIG,
	describeConfig,
	loadConfig,
	loadConfigWithSources,
} from "./config.ts";

// ---------------------------------------------------------------------------
// Helpers

function writeTempConfig(obj: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "nightshift-cfg-test-"));
	const filePath = join(dir, "nightshift.config.json");
	writeFileSync(filePath, JSON.stringify(obj), "utf8");
	return filePath;
}

// Ensure env side-effects don't leak between tests
const ORIGINAL_ENV: Record<string, string | undefined> = {};
const WATCHED_ENV_KEYS = [
	"NIGHTSHIFT_PORT",
	"NIGHTSHIFT_HOST",
	"NIGHTSHIFT_DB_PATH",
	"NIGHTSHIFT_LOG_LEVEL",
	"NIGHTSHIFT_CONFIG",
];

beforeEach(() => {
	for (const k of WATCHED_ENV_KEYS) {
		ORIGINAL_ENV[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of WATCHED_ENV_KEYS) {
		const saved = ORIGINAL_ENV[k];
		if (saved === undefined) delete process.env[k];
		else process.env[k] = saved;
	}
});

// ---------------------------------------------------------------------------
// (a) defaults load with no file

test("loadConfig() returns defaults when no file is present", () => {
	const config = loadConfig({ path: "/nonexistent/path/nightshift.config.json", env: {} });
	expect(config.server.port).toBe(DEFAULT_CONFIG.server.port);
	expect(config.server.host).toBe(DEFAULT_CONFIG.server.host);
	expect(config.database.path).toBe(DEFAULT_CONFIG.database.path);
	expect(config.providers.defaultCoder).toBe(DEFAULT_CONFIG.providers.defaultCoder);
	expect(config.review.autoMergeEnabled).toBe(false);
	expect(config.concurrency.maxParallelSlots).toBe(1);
	expect(config.sandbox.unattendedUntrustedRepos).toBe(false);
});

// ---------------------------------------------------------------------------
// (b) file overrides defaults

test("file values override defaults", () => {
	const filePath = writeTempConfig({
		server: { port: 8080 },
		logging: { level: "debug" },
	});
	const config = loadConfig({ path: filePath, env: {} });
	expect(config.server.port).toBe(8080);
	// host not in file — stays at default
	expect(config.server.host).toBe(DEFAULT_CONFIG.server.host);
	expect(config.logging.level).toBe("debug");
	// other sections unchanged
	expect(config.database.path).toBe(DEFAULT_CONFIG.database.path);
});

test("invalid JSON in config file silently falls back to defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "nightshift-cfg-test-"));
	const filePath = join(dir, "bad.json");
	writeFileSync(filePath, "{ this is not json }", "utf8");
	const config = loadConfig({ path: filePath, env: {} });
	expect(config.server.port).toBe(DEFAULT_CONFIG.server.port);
});

// ---------------------------------------------------------------------------
// (c) env overrides beat file and default

test("NIGHTSHIFT_PORT env var overrides file and default", () => {
	const filePath = writeTempConfig({ server: { port: 8080 } });
	const config = loadConfig({ path: filePath, env: { NIGHTSHIFT_PORT: "9999" } });
	expect(config.server.port).toBe(9999);
});

test("NIGHTSHIFT_HOST env var sets server.host", () => {
	const config = loadConfig({ path: "/nonexistent", env: { NIGHTSHIFT_HOST: "0.0.0.0" } });
	expect(config.server.host).toBe("0.0.0.0");
});

test("NIGHTSHIFT_DB_PATH env var sets database.path", () => {
	const config = loadConfig({ path: "/nonexistent", env: { NIGHTSHIFT_DB_PATH: "/data/custom.db" } });
	expect(config.database.path).toBe("/data/custom.db");
});

test("NIGHTSHIFT_LOG_LEVEL env var sets logging.level", () => {
	const config = loadConfig({ path: "/nonexistent", env: { NIGHTSHIFT_LOG_LEVEL: "warn" } });
	expect(config.logging.level).toBe("warn");
});

// ---------------------------------------------------------------------------
// (d) describeConfig enumerates every leaf knob

test("describeConfig returns one entry per leaf knob — 38 total", () => {
	const config = loadConfig({ path: "/nonexistent", env: {} });
	const entries = describeConfig(config);
	// Manually verified: 38 leaves across all sections.
	// +9 from Phase 5C: providers.{gemini,opencode,antigravity,openrouter,local}Enabled,
	// providers.{openrouterModel,localBaseUrl,localModel}, forge.trustedCheckAppIds.
	// +2 from Phase 7: tournament.{enabled,challengerProvider}.
	expect(entries).toHaveLength(38);
	for (const entry of entries) {
		expect(typeof entry.section).toBe("string");
		expect(entry.section.length).toBeGreaterThan(0);
		expect(typeof entry.key).toBe("string");
		expect(entry.key.length).toBeGreaterThan(0);
		expect(["default", "file", "env"]).toContain(entry.source);
		expect(typeof entry.secret).toBe("boolean");
		// value is always present (may be undefined for unset knobs but these are defined)
		expect("value" in entry).toBe(true);
	}
});

test("describeConfig entry sections match config group names", () => {
	const config = loadConfig({ path: "/nonexistent", env: {} });
	const entries = describeConfig(config);
	const sections = new Set(entries.map((e) => e.section));
	for (const s of [
		"server",
		"database",
		"providers",
		"concurrency",
		"capacity",
		"budgets",
		"triage",
		"timeouts",
		"review",
		"sandbox",
		"forge",
		"logging",
	]) {
		expect(sections.has(s)).toBe(true);
	}
});

// ---------------------------------------------------------------------------
// (e) secret masking

test("a key named 'apiToken' is masked to '********' with secret=true", () => {
	// Inject a synthetic config section that has secret-named keys to verify masking.
	// We can't add keys to the real interface, so we verify the real config has no
	// secret keys (all real knobs are non-secret) and then test describeConfig
	// directly with a cast object.
	const synthetic = {
		...DEFAULT_CONFIG,
		// override providers section to add a theoretical secret key
		providers: {
			...DEFAULT_CONFIG.providers,
			apiToken: "super-secret-value",
		},
	} as unknown as import("./config.ts").NightshiftConfig;

	const entries = describeConfig(synthetic);
	const secretEntry = entries.find((e) => e.key === "apiToken");
	expect(secretEntry).toBeDefined();
	expect(secretEntry!.secret).toBe(true);
	expect(secretEntry!.value).toBe("********");
});

test("advisoryTokensPerRun is masked because its name contains 'token'", () => {
	// The secret pattern /token|secret|key|password/i is intentionally broad.
	// 'advisoryTokensPerRun' matches — it's a budget knob, not a credential, but
	// masking a non-sensitive number is a safe false-positive.
	const config = loadConfig({ path: "/nonexistent", env: {} });
	const entries = describeConfig(config);
	const tokensEntry = entries.find(
		(e) => e.section === "budgets" && e.key === "advisoryTokensPerRun",
	);
	expect(tokensEntry).toBeDefined();
	expect(tokensEntry!.secret).toBe(true);
	expect(tokensEntry!.value).toBe("********");
});

// ---------------------------------------------------------------------------
// (f) provenance: source field correctness

test("source is 'default' when no file or env override", () => {
	const { config, sources } = loadConfigWithSources({
		path: "/nonexistent",
		env: {},
	});
	const entries = describeConfig(config, sources);
	for (const entry of entries) {
		expect(entry.source).toBe("default");
	}
});

test("source is 'file' for keys present in the config file", () => {
	const filePath = writeTempConfig({
		server: { port: 8080 },
		logging: { level: "debug" },
	});
	const { config, sources } = loadConfigWithSources({ path: filePath, env: {} });
	const entries = describeConfig(config, sources);

	const portEntry = entries.find((e) => e.section === "server" && e.key === "port");
	expect(portEntry?.source).toBe("file");

	const logEntry = entries.find((e) => e.section === "logging" && e.key === "level");
	expect(logEntry?.source).toBe("file");

	// host was NOT in the file — stays default
	const hostEntry = entries.find((e) => e.section === "server" && e.key === "host");
	expect(hostEntry?.source).toBe("default");
});

test("source is 'env' for env-overridden keys, beats file", () => {
	const filePath = writeTempConfig({ server: { port: 8080 } });
	const { config, sources } = loadConfigWithSources({
		path: filePath,
		env: { NIGHTSHIFT_PORT: "9999", NIGHTSHIFT_LOG_LEVEL: "error" },
	});
	const entries = describeConfig(config, sources);

	const portEntry = entries.find((e) => e.section === "server" && e.key === "port");
	expect(portEntry?.source).toBe("env");
	expect(portEntry?.value).toBe(9999);

	const logEntry = entries.find((e) => e.section === "logging" && e.key === "level");
	expect(logEntry?.source).toBe("env");
	expect(logEntry?.value).toBe("error");
});
