import { describe, it, expect, afterEach } from "bun:test";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { EventLog } from "../events/events.ts";
import { makeLiveExperimentDeps } from "./experimentLiveDeps.ts";
import type { GitRunner, EvalExec } from "./experimentLiveDeps.ts";
import type { OneShotSpawner } from "../runs/liveSpawn.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test setup: hermetic deps with fakes
// ─────────────────────────────────────────────────────────────────────────────

interface FakeGitState {
	calls: Array<{ args: string[]; cwd: string }>;
	statusResult?: string;
	revParseResult?: string;
}

function makeFakeGit(state: FakeGitState): GitRunner {
	return async (args: string[], cwd: string): Promise<string> => {
		state.calls.push({ args, cwd });
		const cmd = args[0];

		if (cmd === "status" && args[1] === "--porcelain") {
			return state.statusResult ?? "";
		}
		if (cmd === "rev-parse" && args[1] === "HEAD") {
			return state.revParseResult ?? "abc123";
		}
		if (cmd === "add") {
			return "";
		}
		if (cmd === "commit") {
			return "";
		}
		if (cmd === "reset") {
			return "";
		}
		if (cmd === "clean") {
			return "";
		}
		if (cmd === "worktree" && args[1] === "add") {
			return "";
		}
		if (cmd === "worktree" && args[1] === "remove") {
			return "";
		}
		return "";
	};
}

interface FakeExecState {
	execCalls: Array<{ cmd: string[]; cwd: string }>;
	execResult: { ok: boolean; stdout: string };
}

function makeFakeExec(state: FakeExecState): EvalExec {
	return async (cmd: string[], opts: { cwd: string; timeoutMs: number }) => {
		state.execCalls.push({ cmd, cwd: opts.cwd });
		return state.execResult;
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. produceEdit success
// ─────────────────────────────────────────────────────────────────────────────

describe("experimentLiveDeps", () => {
	let handle = openDatabase(":memory:");
	let log = new EventLog(handle);

	afterEach(() => {
		handle.sqlite.close();
		handle = openDatabase(":memory:");
		log = new EventLog(handle);
	});

	it("produceEdit success", async () => {
		runMigrations(handle);

		let spawnerCalled = false;
		let promptReceived = "";
		const fakeSpawner: OneShotSpawner = async (spec) => {
			spawnerCalled = true;
			promptReceived = spec.prompt;
			return { stdout: "", exitCode: 0 };
		};

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
			provider: "claude-code",
			spawner: fakeSpawner,
		});

		const result = await deps.produceEdit({
			iteration: 1,
			targetPaths: ["src/x"],
			lastMetric: null,
		});

		expect(result.ok).toBe(true);
		expect(spawnerCalled).toBe(true);
		expect(promptReceived).toContain("src/x");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 2. produceEdit fail-closed on spawner error
	// ─────────────────────────────────────────────────────────────────────────

	it("produceEdit fail-closed: spawner throws", async () => {
		runMigrations(handle);

		const fakeSpawner: OneShotSpawner = async () => {
			throw new Error("spawn failed");
		};

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
			spawner: fakeSpawner,
		});

		const result = await deps.produceEdit({
			iteration: 1,
			targetPaths: ["src/y"],
			lastMetric: null,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBeDefined();
		expect(result.reason).toContain("spawn failed");
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 3. commit — nothing to commit
	// ─────────────────────────────────────────────────────────────────────────

	it("commit: nothing to commit returns ok:false", async () => {
		runMigrations(handle);

		const gitState: FakeGitState = {
			calls: [],
			statusResult: "",
			revParseResult: "abc123",
		};
		const fakeGit = makeFakeGit(gitState);

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
			git: fakeGit,
		});

		const result = await deps.commit({
			iteration: 1,
			message: "test commit",
		});

		expect(result.ok).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 4. commit — success with changes
	// ─────────────────────────────────────────────────────────────────────────

	it("commit: success with changes", async () => {
		runMigrations(handle);

		const gitState: FakeGitState = {
			calls: [],
			statusResult: "M src/x",
			revParseResult: "abc123sha",
		};
		const fakeGit = makeFakeGit(gitState);

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
			git: fakeGit,
		});

		const result = await deps.commit({
			iteration: 1,
			message: "test commit",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.commitSha).toBe("abc123sha");

		// Verify git was called with add -A
		const addCall = gitState.calls.find(
			(c) => c.args[0] === "add" && c.args[1] === "-A",
		);
		expect(addCall).toBeDefined();

		// Verify git commit was called
		const commitCall = gitState.calls.find((c) => c.args[0] === "commit");
		expect(commitCall).toBeDefined();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 5. evalRunner §3.12.8 ISOLATION: eval runs on separate worktree
	// ─────────────────────────────────────────────────────────────────────────

	it("evalRunner runs on separate detached worktree", async () => {
		runMigrations(handle);

		const gitState: FakeGitState = {
			calls: [],
			statusResult: "",
			revParseResult: "abc123",
		};
		const fakeGit = makeFakeGit(gitState);

		const execState: FakeExecState = {
			execCalls: [],
			execResult: { ok: true, stdout: '{"score": 42}' },
		};
		const fakeExec = makeFakeExec(execState);

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
			git: fakeGit,
			exec: fakeExec,
			now: () => 1000,
		});

		const result = await deps.evalRunner({
			commitSha: "abc123def456",
			evalCommand: "make eval",
			budgetMs: 1000,
		});

		expect(result.ok).toBe(true);
		expect(result.stdout).toContain("score");

		// (a) Check that git worktree add --detach was called
		const worktreeAddCall = gitState.calls.find(
			(c) => c.args[0] === "worktree" && c.args[1] === "add",
		);
		expect(worktreeAddCall).toBeDefined();
		expect(worktreeAddCall!.args[2]).toBe("--detach");

		// Extract the eval dir from the git call (args[3])
		const evalDirFromGit = worktreeAddCall!.args[3]!;
		expect(evalDirFromGit).toBeDefined();

		// (b) Check that exec was called with that directory as cwd, NOT /repo
		const execCall = execState.execCalls[0];
		expect(execCall).toBeDefined();
		expect(execCall!.cwd).toBe(evalDirFromGit);
		expect(execCall!.cwd).not.toBe("/repo");

		// (c) Check that git worktree remove was called for cleanup
		const worktreeRemoveCall = gitState.calls.find(
			(c) => c.args[0] === "worktree" && c.args[1] === "remove",
		);
		expect(worktreeRemoveCall).toBeDefined();
	});

	// ─────────────────────────────────────────────────────────────────────────
	// 6. parseMetric + reset
	// ─────────────────────────────────────────────────────────────────────────

	it("parseMetric: JSON, regex, and null fallback", async () => {
		runMigrations(handle);

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
		});

		// JSON with metric
		const result1 = deps.parseMetric('{"score": 42}', "score");
		expect(result1).toBe(42);

		// Regex format: "score: 7.5"
		const result2 = deps.parseMetric("score: 7.5", "score");
		expect(result2).toBe(7.5);

		// Garbage → null
		const result3 = deps.parseMetric("garbage", "score");
		expect(result3).toBe(null);
	});

	it("reset: calls git reset --hard and clean -fd", async () => {
		runMigrations(handle);

		const gitState: FakeGitState = {
			calls: [],
			statusResult: "",
			revParseResult: "xyz",
		};
		const fakeGit = makeFakeGit(gitState);

		const deps = makeLiveExperimentDeps({
			handle,
			log,
			repoDir: "/repo",
			homeRoot: "/home",
			git: fakeGit,
		});

		await deps.reset({ toCommitSha: "xyz" });

		const resetCall = gitState.calls.find(
			(c) => c.args[0] === "reset" && c.args[1] === "--hard",
		);
		expect(resetCall).toBeDefined();
		expect(resetCall!.args[2]).toBe("xyz");

		const cleanCall = gitState.calls.find(
			(c) => c.args[0] === "clean" && c.args[1] === "-fd",
		);
		expect(cleanCall).toBeDefined();
	});
});
