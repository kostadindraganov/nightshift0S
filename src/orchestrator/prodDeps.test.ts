/**
 * Hermetic tests for the production coder-orchestrator deps factory.
 *
 * NO LIVE SIDE EFFECTS: token resolution is forced down the env path
 * (GITHUB_TOKEN set), so no `gh` subprocess spawns and no HTTP is made. We
 * assert ONLY on the assembled deps shape — that the live forge client, the
 * live CI client, and `defaultPusher` are wired, and that a missing token fails
 * closed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { buildProdCoderDeps } from "./prodDeps.ts";
import { defaultPusher } from "../forge/push.ts";
import { GitHubRestClient } from "../forge/github.ts";
import { GitHubCiClient } from "../gate/githubCiClient.ts";
import type { Spawner, SpawnResult } from "../forge/githubForgeClient.ts";
import type { DbHandle } from "../db/client.ts";
import type { EventLog } from "../events/events.ts";
import type { RepoConfig } from "./coder.ts";

/** Fake spawner that mimics `gh auth token` exiting non-zero (no token). */
const failingSpawner: Spawner = (): SpawnResult => ({
	exited: Promise.resolve(1),
	stdout: new Response("").body!,
	stderr: new Response("not logged in").body!,
});

const ORIGINAL_TOKEN = process.env.GITHUB_TOKEN;

// The factory only reads handle/log by reference; nothing is invoked on them.
const handle = {} as DbHandle;
const log = {} as EventLog;
const resolveRepo = (): RepoConfig => ({
	repoDir: "/repo",
	worktreePath: "/wt",
	remoteUrl: "git@github.com:acme/widget.git",
	owner: "acme",
	repo: "widget",
	defaultBranch: "main",
});

beforeEach(() => {
	process.env.GITHUB_TOKEN = "ghp_test_token";
});

afterEach(() => {
	if (ORIGINAL_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
	else process.env.GITHUB_TOKEN = ORIGINAL_TOKEN;
});

test("assembles live forge client, live CI client, and defaultPusher", async () => {
	const deps = await buildProdCoderDeps({
		handle,
		log,
		resolveRepo,
		owner: "acme",
		repo: "widget",
	});
	expect(deps.forgeClient).toBeInstanceOf(GitHubRestClient);
	expect(deps.ci).toBeInstanceOf(GitHubCiClient);
	expect(deps.pusher).toBe(defaultPusher);
	// git is left undefined so the orchestrator falls back to host-side execGit.
	expect(deps.git).toBeUndefined();
	expect(deps.resolveRepo).toBe(resolveRepo);
});

test("fails closed when no GitHub token is available", async () => {
	delete process.env.GITHUB_TOKEN;
	// GITHUB_TOKEN unset → the injected fake `gh auth token` exits non-zero →
	// the factory throws. No real subprocess and no network: we assert it
	// rejects rather than silently returning a tokenless client.
	await expect(
		buildProdCoderDeps({
			handle,
			log,
			resolveRepo,
			owner: "acme",
			repo: "widget",
			spawner: failingSpawner,
		}),
	).rejects.toThrow();
});
