/**
 * Config loader for Nightshift (task 1.7).
 *
 * WHY file+env layering: operators need a stable config file they can check
 * in to version control, while deployment secrets (tokens, paths) should come
 * from env vars so they stay out of source control. Deep-merge means file
 * overrides defaults, then env vars win over everything.
 *
 * WHY memoize: the default (no-arg) load is called on every GET /config
 * request. Reading + parsing the file on every request would be wasteful;
 * caching after first load is correct for a server whose config doesn't
 * change at runtime. Tests pass explicit opts to bypass the cache.
 */

import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types

export interface NightshiftConfig {
	server: {
		port: number;
		host: string;
	};
	database: {
		path: string;
	};
	providers: {
		defaultCoder: string;
		defaultReviewer: string;
		claudeCodeEnabled: boolean;
		codexEnabled: boolean;
		// Phase 5C V1.5 driver enable flags — all default OFF (explicit operator act).
		geminiEnabled: boolean;
		opencodeEnabled: boolean;
		antigravityEnabled: boolean;
		openrouterEnabled: boolean;
		localEnabled: boolean;
		// API-driver base URL / model knobs (secrets stay in env — references only).
		// openrouterModel: unset ⇒ runOnce refuses (no silent default model).
		openrouterModel: string;
		// localBaseUrl: OpenAI-compatible local endpoint (ollama / llama.cpp / LM Studio).
		localBaseUrl: string;
		// localModel: unset ⇒ runOnce refuses.
		localModel: string;
		// V3 CMA (Anthropic Managed Agents) provider plugin — api driver, default OFF.
		cmaEnabled: boolean;
		// cmaModel: unset ⇒ the CMA driver's runOnce refuses (no silent default model).
		cmaModel: string;
	};
	concurrency: {
		maxParallelSlots: number;
		perProviderCap: number;
		schedulerIntervalSeconds: number;
		schedulerDebounceMs: number;
	};
	capacity: {
		cooldownSeconds: number;
		overflowToApiKey: boolean;
	};
	budgets: {
		wallClockSecondsPerRun: number;
		advisoryTokensPerRun: number;
		hardCostUsdPerRun: number;
	};
	triage: {
		maxRetries: number;
	};
	timeouts: {
		runStartSeconds: number;
		watchdogSeconds: number;
		reapGraceMs: number;
	};
	review: {
		maxRounds: number;
		autoMergeEnabled: boolean;
	};
	sandbox: {
		homeRoot: string;
		egressAllowlist: string[];
		unattendedUntrustedRepos: boolean;
	};
	forge: {
		/** "github" | "forgejo" | "gitlab" */
		provider: string;
		/** Override the forge API base URL (GitHub Enterprise, self-hosted Forgejo/GitLab). */
		baseUrl?: string;
		/**
		 * Allowlist of GitHub check-run App IDs whose green checks are trusted by
		 * the auto-merge preflight (PHASE5C §3.12.26). EMPTY ⇒ preflight check (b)
		 * BLOCKS (fail-closed): the operator must explicitly trust an app, e.g.
		 * 15368 for GitHub Actions.
		 */
		trustedCheckAppIds: number[];
	};
	logging: {
		level: string;
	};
	tournament: {
		/** When true, each review round spawns TWO reviewer one-shots in parallel and synthesizes the union. */
		enabled: boolean;
		/**
		 * Provider for the second (challenger) review slot.
		 * The primary slot always uses providers.defaultReviewer.
		 * Must differ from defaultReviewer for the tournament to add value.
		 */
		challengerProvider: string;
		/**
		 * V3 three-model tiebreaker: provider consulted ONLY when the two tournament
		 * reviewers disagree on verdict. Empty ⇒ no tiebreaker (fall to stricter verdict).
		 */
		tiebreakerProvider: string;
	};
	/** V3 container isolation per run — opt-in level above worktree-only (network+fs limits). */
	container: {
		enabled: boolean;
		/** Container runtime binary: "docker" | "podman". */
		runtime: string;
		image: string;
		/** "none" | "bridge" — default "none" (fail-closed network isolation). */
		network: string;
		memLimit: string;
		cpuLimit: string;
	};
	/** V3 multi-VM workers — worker daemons register with the single control plane. */
	workers: {
		enabled: boolean;
		heartbeatSeconds: number;
		/** Lease age (seconds) past which a silent worker is considered dead and reclaimed. */
		leaseSeconds: number;
	};
	/** V3 CLI auto-update — factory keeps agent CLIs current (default OFF). */
	cliUpdate: {
		enabled: boolean;
		checkIntervalHours: number;
	};
	/** V3 preview environments — every PR gets run-<id>.<domain>, reaped when idle. */
	preview: {
		enabled: boolean;
		/** Empty ⇒ disabled (fail-closed; no URL can be allocated). */
		domain: string;
		idleReapMinutes: number;
	};
	/** V3 prompt self-optimization (§3.11 variant) — bounded hill-climb over a prompt. */
	selfOptimize: {
		enabled: boolean;
		maxRounds: number;
	};
	coder: {
		/**
		 * Blueprint workflow-skill slugs mounted into each spawned coder's
		 * per-task HOME (`vendor/blueprint-skills/skills/<slug>/SKILL.md`). Empty
		 * disables the mount. Only the implementation-phase skills by default;
		 * spec/plan/branch/commit/pr are owned by the nightshift orchestrator.
		 */
		skillsMount: string[];
	};
}

export interface ConfigEntry {
	section: string;
	key: string;
	value: unknown;
	source: "default" | "file" | "env";
	secret: boolean;
}

// ---------------------------------------------------------------------------
// Defaults

export const DEFAULT_CONFIG: NightshiftConfig = {
	server: {
		port: 3000,
		host: "127.0.0.1",
	},
	database: {
		path: "data/nightshift.db",
	},
	providers: {
		defaultCoder: "claude-code",
		defaultReviewer: "codex",
		claudeCodeEnabled: true,
		codexEnabled: true,
		// V1.5 drivers — OFF until an operator opts in.
		geminiEnabled: false,
		opencodeEnabled: false,
		antigravityEnabled: false,
		openrouterEnabled: false,
		localEnabled: false,
		// Unset model ⇒ the driver's runOnce refuses; no silent default model.
		openrouterModel: "",
		localBaseUrl: "http://127.0.0.1:11434/v1",
		localModel: "",
		cmaEnabled: false,
		cmaModel: "",
	},
	concurrency: {
		maxParallelSlots: 1,
		perProviderCap: 1,
		schedulerIntervalSeconds: 30,
		schedulerDebounceMs: 250,
	},
	capacity: {
		cooldownSeconds: 300,
		// Fail-closed: no silent paid overflow from subscription → api_key.
		overflowToApiKey: false,
	},
	budgets: {
		wallClockSecondsPerRun: 3600,
		advisoryTokensPerRun: 200000,
		hardCostUsdPerRun: 0,
	},
	triage: {
		maxRetries: 2,
	},
	timeouts: {
		runStartSeconds: 60,
		watchdogSeconds: 300,
		reapGraceMs: 5000,
	},
	review: {
		maxRounds: 3,
		autoMergeEnabled: false,
	},
	sandbox: {
		homeRoot: "/tmp/nightshift-sandboxes",
		egressAllowlist: [],
		unattendedUntrustedRepos: false,
	},
	forge: {
		provider: "github",
		// Empty ⇒ auto-merge preflight check (b) blocks (fail-closed). Operators add
		// e.g. 15368 (GitHub Actions) to trust that app's green checks.
		trustedCheckAppIds: [],
	},
	logging: {
		level: "info",
	},
	tournament: {
		enabled: false,
		challengerProvider: "claude-code",
		tiebreakerProvider: "",
	},
	container: {
		enabled: false,
		runtime: "docker",
		image: "nightshift/agent:latest",
		network: "none",
		memLimit: "2g",
		cpuLimit: "2",
	},
	workers: {
		enabled: false,
		heartbeatSeconds: 30,
		leaseSeconds: 90,
	},
	cliUpdate: {
		enabled: false,
		checkIntervalHours: 24,
	},
	preview: {
		enabled: false,
		domain: "",
		idleReapMinutes: 30,
	},
	selfOptimize: {
		enabled: false,
		maxRounds: 5,
	},
	coder: {
		skillsMount: ["implement", "tdd", "debug", "refactor", "review"],
	},
};

// ---------------------------------------------------------------------------
// Deep merge (two levels: section -> leaf)

type SectionKey = keyof NightshiftConfig;
type FileOverride = Partial<{ [K in SectionKey]: Partial<NightshiftConfig[K]> }>;

function deepMerge(base: NightshiftConfig, override: FileOverride): NightshiftConfig {
	const result = { ...base } as NightshiftConfig;
	for (const section of Object.keys(override) as SectionKey[]) {
		const overrideSection = override[section];
		if (overrideSection !== null && typeof overrideSection === "object") {
			(result[section] as unknown) = { ...(base[section] as object), ...overrideSection };
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// File reading

function readConfigFile(filePath: string): FileOverride {
	try {
		if (!existsSync(filePath)) return {};
		const raw = readFileSync(filePath, "utf8");
		return JSON.parse(raw) as FileOverride;
	} catch {
		// Missing file or invalid JSON — silently fall back to defaults
		return {};
	}
}

// ---------------------------------------------------------------------------
// Provenance tracking

type SourceMap = Record<string, "default" | "file" | "env">;

function buildSourceMap(fileOverride: FileOverride, envKeys: string[]): SourceMap {
	const sources: SourceMap = {};

	// Walk every leaf of DEFAULT_CONFIG and mark as "default"
	for (const [section, sectionVal] of Object.entries(DEFAULT_CONFIG)) {
		for (const key of Object.keys(sectionVal as object)) {
			sources[`${section}.${key}`] = "default";
		}
	}

	// Mark keys that came from file
	for (const [section, sectionVal] of Object.entries(fileOverride)) {
		if (sectionVal !== null && typeof sectionVal === "object") {
			for (const key of Object.keys(sectionVal as object)) {
				sources[`${section}.${key}`] = "file";
			}
		}
	}

	// Mark env overrides (they win last)
	for (const dotKey of envKeys) {
		sources[dotKey] = "env";
	}

	return sources;
}

// ---------------------------------------------------------------------------
// Load

export interface LoadedConfig {
	config: NightshiftConfig;
	sources: SourceMap;
}

function load(opts?: { path?: string; env?: Record<string, string | undefined> }): LoadedConfig {
	const envVars = opts?.env ?? process.env;
	const filePath =
		opts?.path ??
		(envVars["NIGHTSHIFT_CONFIG"] as string | undefined) ??
		"nightshift.config.json";

	const fileOverride = readConfigFile(filePath);

	// Apply file override on top of defaults
	let config = deepMerge(DEFAULT_CONFIG, fileOverride);

	// Apply env overrides and track which keys they set
	const envKeys: string[] = [];

	const rawPort = envVars["NIGHTSHIFT_PORT"];
	if (rawPort !== undefined) {
		const port = Number(rawPort);
		if (!Number.isNaN(port)) {
			config = { ...config, server: { ...config.server, port } };
			envKeys.push("server.port");
		}
	}

	const rawHost = envVars["NIGHTSHIFT_HOST"];
	if (rawHost !== undefined) {
		config = { ...config, server: { ...config.server, host: rawHost } };
		envKeys.push("server.host");
	}

	const rawDbPath = envVars["NIGHTSHIFT_DB_PATH"];
	if (rawDbPath !== undefined) {
		config = { ...config, database: { ...config.database, path: rawDbPath } };
		envKeys.push("database.path");
	}

	const rawLogLevel = envVars["NIGHTSHIFT_LOG_LEVEL"];
	if (rawLogLevel !== undefined) {
		config = { ...config, logging: { ...config.logging, level: rawLogLevel } };
		envKeys.push("logging.level");
	}

	const sources = buildSourceMap(fileOverride, envKeys);
	return { config, sources };
}

// Memoized default (no-arg) load
let _cached: LoadedConfig | undefined;

/**
 * Load config with full provenance. Memoized when called with no opts.
 * Pass opts to bypass cache (useful in tests).
 */
export function loadConfigWithSources(opts?: {
	path?: string;
	env?: Record<string, string | undefined>;
}): LoadedConfig {
	if (opts === undefined) {
		if (_cached === undefined) _cached = load();
		return _cached;
	}
	return load(opts);
}

/** Convenience: just the config object. Memoized at the no-arg call site. */
export function loadConfig(opts?: {
	path?: string;
	env?: Record<string, string | undefined>;
}): NightshiftConfig {
	return loadConfigWithSources(opts).config;
}

// ---------------------------------------------------------------------------
// describeConfig

const SECRET_PATTERN = /token|secret|key|password/i;

/**
 * Flatten every leaf knob in `config` into a ConfigEntry array.
 * One entry per leaf: section = group name, key = leaf name.
 * Secret keys (name matches token/secret/key/password) are masked to "********".
 */
export function describeConfig(config: NightshiftConfig, sources?: SourceMap): ConfigEntry[] {
	const entries: ConfigEntry[] = [];
	for (const [section, sectionVal] of Object.entries(config)) {
		if (sectionVal === null || typeof sectionVal !== "object" || Array.isArray(sectionVal)) {
			continue;
		}
		for (const [key, rawValue] of Object.entries(sectionVal as Record<string, unknown>)) {
			const isSecret = SECRET_PATTERN.test(key);
			const value = isSecret ? "********" : rawValue;
			const source: "default" | "file" | "env" = sources?.[`${section}.${key}`] ?? "default";
			entries.push({ section, key, value, source, secret: isSecret });
		}
	}
	return entries;
}
