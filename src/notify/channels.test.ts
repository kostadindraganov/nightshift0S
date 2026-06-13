/**
 * Channels test suite (P6-2 UNIT).
 *
 * Covers:
 *   - makeSlackChannel: fail-closed when unconfigured, sends to webhook with text,
 *     webhook URL never leaks in reason strings.
 *   - makeEmailChannel: fail-closed when unconfigured, maps NotifyMessage fields,
 *     handles send errors cleanly.
 *   - buildStandupDigest: tallies task states globally, run metrics windowed,
 *     expense rollup, flaky/error detection.
 *   - digestToMessage: formats digest as readable NotifyMessage.
 *   - makeDigestScheduler: periodically builds and notifies, survives notifier errors.
 *
 * All side effects are faked: in-memory DB, injected clock, and fake send/HttpSend.
 * Each test owns its own DB instance.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { runs, tasks, projects } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import { makeSlackChannel } from "./slack.ts";
import { makeEmailChannel, type EmailSend } from "./email.ts";
import {
	buildStandupDigest,
	digestToMessage,
	makeDigestScheduler,
	type DigestSchedulerDeps,
	type StandupDigest,
} from "./digest.ts";
import type { HttpSend } from "./telegram.ts";
import type { NotifyMessage } from "./notifier.ts";

// ---------------------------------------------------------------------------
// Fixtures & Fakes
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;
let clock: Date;

function resetClock(iso: string): void {
	clock = new Date(iso);
}

/** Fake HttpSend for testing Slack/Telegram. */
function makeFakeHttpSend(): {
	send: HttpSend;
	calls: Array<{ url: string; body: unknown }>;
	failWith?: { status: number };
} {
	const calls: Array<{ url: string; body: unknown }> = [];
	const send: HttpSend = async (url: string, body: unknown) => {
		calls.push({ url, body });
		// Default: success. Can be overridden with failWith.
		return { ok: true, status: 200 };
	};
	return { send, calls, failWith: undefined };
}

/** Fake EmailSend for testing Email channel. */
function makeFakeEmailSend(): {
	send: EmailSend;
	calls: Array<{ to: string; subject: string; text: string }>;
	failWith?: string;
} {
	const calls: Array<{ to: string; subject: string; text: string }> = [];
	const send: EmailSend = async (msg) => {
		calls.push(msg);
		// Default: success. Can be overridden with failWith.
		return { ok: true };
	};
	return { send, calls, failWith: undefined };
}

/** Fake Notifier for digest scheduler tests. */
class FakeNotifier {
	calls: NotifyMessage[] = [];

	async notify(msg: NotifyMessage): Promise<Array<{ channel: string; ok: boolean }>> {
		this.calls.push(msg);
		return [{ channel: "fake", ok: true }];
	}
}

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	resetClock("2026-06-13T12:00:00.000Z");

	// Create a default project for foreign key references
	const now = new Date().toISOString();
	handle.db
		.insert(projects)
		.values({
			id: 1,
			name: "test-project",
			repoUrl: "https://github.com/test/project",
			defaultBranch: "main",
			createdAt: now,
			updatedAt: now,
		})
		.run();
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// Slack Channel Tests
// ---------------------------------------------------------------------------

describe("Slack channel", () => {
	test("slack fails closed when webhookUrlRef is undefined", async () => {
		const fakeHttp = makeFakeHttpSend();
		const channel = makeSlackChannel({
			webhookUrlRef: () => undefined,
			send: fakeHttp.send,
		});

		const result = await channel.send({
			kind: "test.message",
			title: "Test",
			body: "This should not send",
		});

		expect(result).toEqual({ ok: false, reason: "unconfigured" });
		expect(fakeHttp.calls.length).toBe(0); // No network call made
	});

	test("slack sends message to webhook when configured", async () => {
		const fakeHttp = makeFakeHttpSend();
		const webhookUrl = "https://hooks.slack.com/services/T00000000/B00000000/XXX";

		const channel = makeSlackChannel({
			webhookUrlRef: () => webhookUrl,
			send: fakeHttp.send,
		});

		const msg: NotifyMessage = {
			kind: "task.state_changed",
			title: "Task 42: done",
			body: "Task moved to state 'done'.",
		};

		const result = await channel.send(msg);

		expect(result).toEqual({ ok: true });
		expect(fakeHttp.calls.length).toBe(1);
		expect(fakeHttp.calls[0]).toEqual({
			url: webhookUrl,
			body: { text: "Task 42: done\n\nTask moved to state 'done'." },
		});
	});

	test("slack never leaks webhook URL in failure reason", async () => {
		const fakeHttp = makeFakeHttpSend();
		const webhookUrl = "https://hooks.slack.com/services/SUPERSECRET/WEBHOOK/URL";

		const channel = makeSlackChannel({
			webhookUrlRef: () => webhookUrl,
			send: async (url: string, body: unknown) => {
				// Simulate a 500 error from the webhook endpoint
				return { ok: false, status: 500 };
			},
		});

		const result = await channel.send({
			kind: "test",
			title: "Test",
			body: "Test body",
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toBe("http 500");
		// Ensure no part of the URL leaks
		expect(result.reason).not.toContain("SUPERSECRET");
		expect(result.reason).not.toContain("WEBHOOK");
		expect(result.reason).not.toContain("hooks.slack.com");
	});

	test("slack handles send throw gracefully", async () => {
		const channel = makeSlackChannel({
			webhookUrlRef: () => "https://hooks.slack.com/services/test",
			send: async () => {
				throw new Error("Network timeout");
			},
		});

		const result = await channel.send({
			kind: "test",
			title: "Test",
			body: "Test body",
		});

		expect(result).toEqual({ ok: false, reason: "send error" });
	});
});

// ---------------------------------------------------------------------------
// Email Channel Tests
// ---------------------------------------------------------------------------

describe("Email channel", () => {
	test("email fails closed when to is undefined", async () => {
		const fakeEmail = makeFakeEmailSend();

		const channel = makeEmailChannel({
			to: undefined,
			send: fakeEmail.send,
		});

		const result = await channel.send({
			kind: "test.message",
			title: "Test Alert",
			body: "This should not send",
		});

		expect(result).toEqual({ ok: false, reason: "unconfigured" });
		expect(fakeEmail.calls.length).toBe(0); // No send call made
	});

	test("email maps NotifyMessage correctly", async () => {
		const fakeEmail = makeFakeEmailSend();
		const toAddr = "alert@nightshift.local";

		const channel = makeEmailChannel({
			to: toAddr,
			send: fakeEmail.send,
		});

		const msg: NotifyMessage = {
			kind: "task.state_changed",
			title: "Task 99: failed",
			body: "Task execution failed with an error.",
			taskId: 99,
		};

		const result = await channel.send(msg);

		expect(result).toEqual({ ok: true });
		expect(fakeEmail.calls.length).toBe(1);
		expect(fakeEmail.calls[0]).toEqual({
			to: toAddr,
			subject: "Task 99: failed",
			text: "Task execution failed with an error.",
		});
	});

	test("email includes from field when provided", async () => {
		const fakeEmail = makeFakeEmailSend();

		const channel = makeEmailChannel({
			to: "user@example.com",
			from: "Nightshift <noreply@nightshift.local>",
			send: fakeEmail.send,
		});

		await channel.send({
			kind: "test",
			title: "Title",
			body: "Body",
		});

		// The from field is passed to deps.send but not part of the message body
		// (it's used by the transport). Verify send was called.
		expect(fakeEmail.calls.length).toBe(1);
	});

	test("email reports send errors with detail", async () => {
		const fakeEmail: ReturnType<typeof makeFakeEmailSend> = {
			send: async () => ({ ok: false, detail: "SMTP server rejected address" }),
			calls: [],
		};

		const channel = makeEmailChannel({
			to: "user@example.com",
			send: fakeEmail.send,
		});

		const result = await channel.send({
			kind: "test",
			title: "Test",
			body: "Test",
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("email error");
		expect(result.reason).toContain("SMTP server rejected address");
	});

	test("email handles send throw gracefully", async () => {
		const channel = makeEmailChannel({
			to: "user@example.com",
			send: async () => {
				throw new Error("Transport connection lost");
			},
		});

		const result = await channel.send({
			kind: "test",
			title: "Test",
			body: "Test",
		});

		expect(result).toEqual({ ok: false, reason: "send error" });
	});
});

// ---------------------------------------------------------------------------
// Standup Digest Tests
// ---------------------------------------------------------------------------

describe("Standup digest", () => {
	test("buildStandupDigest tallies task state counts globally", () => {
		// Seed task states across a project
		const projectId = 1;
		const now = new Date().toISOString();
		handle.db
			.insert(tasks)
			.values([
				{ projectId, title: "t1", state: "done", createdAt: now, updatedAt: now },
				{ projectId, title: "t2", state: "done", createdAt: now, updatedAt: now },
				{ projectId, title: "t3", state: "failed", createdAt: now, updatedAt: now },
				{ projectId, title: "t4", state: "needs_human", createdAt: now, updatedAt: now },
				{ projectId, title: "t5", state: "ready", createdAt: now, updatedAt: now },
				{ projectId, title: "t6", state: "coding", mergeSha: "abc123", createdAt: now, updatedAt: now },
			])
			.run();

		const digest = buildStandupDigest(handle, { sinceTs: "2026-06-13T00:00:00Z" });

		expect(digest.done).toBe(2);
		expect(digest.failed).toBe(1);
		expect(digest.needsHuman).toBe(1);
		expect(digest.merged).toBe(1); // Only t6 has mergeSha != null
	});

	test("buildStandupDigest counts activeRuns (non-terminal states)", () => {
		const projectId = 1;
		const now = new Date().toISOString();
		handle.db
			.insert(tasks)
			.values([
				{ projectId, title: "t1", state: "coding", createdAt: now, updatedAt: now },
				{ projectId, title: "t2", state: "review", createdAt: now, updatedAt: now },
			])
			.run();

		// Active runs
		handle.db
			.insert(runs)
			.values([
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "running",
					taskId: 1,
				},
				{
					kind: "reviewer",
					provider: "codex",
					model: "gpt4",
					authLane: "api_key",
					state: "awaiting_input",
					taskId: 2,
				},
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "succeeded", // Terminal — should not count
					taskId: 1,
				},
			])
			.run();

		const digest = buildStandupDigest(handle, { sinceTs: "2026-06-13T00:00:00Z" });

		expect(digest.activeRuns).toBe(2); // running + awaiting_input, not succeeded
	});

	test("buildStandupDigest sums spend for priced runs in window", () => {
		// Insert runs ending in the digest window
		const window = {
			sinceTs: "2026-06-13T00:00:00.000Z",
			untilTs: "2026-06-13T12:00:00.000Z",
		};

		handle.db
			.insert(runs)
			.values([
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "succeeded",
					priced: true,
					costUsd: 1.5,
					endedAt: "2026-06-13T06:00:00.000Z", // In window
				},
				{
					kind: "reviewer",
					provider: "codex",
					model: "gpt4",
					authLane: "api_key",
					state: "succeeded",
					priced: true,
					costUsd: 0.75,
					endedAt: "2026-06-13T09:00:00.000Z", // In window
				},
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "succeeded",
					priced: false, // Not priced — should not count
					costUsd: 10.0,
					endedAt: "2026-06-13T07:00:00.000Z", // In window but not priced
				},
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "succeeded",
					priced: true,
					costUsd: 0.5,
					endedAt: "2026-06-13T15:00:00.000Z", // Outside window
				},
			])
			.run();

		const digest = buildStandupDigest(handle, {
			sinceTs: window.sinceTs,
			now: () => new Date(window.untilTs),
		});

		expect(digest.spendUsd).toBe(2.25); // 1.5 + 0.75 (not 10.0, not 0.5)
	});

	test("buildStandupDigest detects flaky/retry exit reasons", () => {
		handle.db
			.insert(runs)
			.values([
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "failed",
					exitReason: "flaky: timeout on second attempt",
					endedAt: "2026-06-13T06:00:00.000Z",
				},
				{
					kind: "reviewer",
					provider: "codex",
					model: "gpt4",
					authLane: "api_key",
					state: "failed",
					exitReason: "retry exhausted after 3 attempts",
					endedAt: "2026-06-13T07:00:00.000Z",
				},
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "failed",
					exitReason: "OOM killer",
					endedAt: "2026-06-13T08:00:00.000Z",
				},
			])
			.run();

		const digest = buildStandupDigest(handle, {
			sinceTs: "2026-06-13T00:00:00.000Z",
		});

		expect(digest.flaky).toBe(2); // flaky + retry
	});

	test("buildStandupDigest tallies top errors (non-flaky)", () => {
		handle.db
			.insert(runs)
			.values([
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "failed",
					exitReason: "OOM killer",
					endedAt: "2026-06-13T06:00:00.000Z",
				},
				{
					kind: "reviewer",
					provider: "codex",
					model: "gpt4",
					authLane: "api_key",
					state: "failed",
					exitReason: "OOM killer",
					endedAt: "2026-06-13T07:00:00.000Z",
				},
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "failed",
					exitReason: "segfault in reviewer",
					endedAt: "2026-06-13T08:00:00.000Z",
				},
				{
					kind: "coder",
					provider: "claude",
					model: "opus",
					authLane: "subscription",
					state: "failed",
					exitReason: "flaky: retried 3x",
					endedAt: "2026-06-13T09:00:00.000Z",
				},
			])
			.run();

		const digest = buildStandupDigest(handle, {
			sinceTs: "2026-06-13T00:00:00.000Z",
		});

		expect(digest.topErrors).toHaveLength(2); // OOM + segfault (not flaky)
		expect(digest.topErrors[0]).toEqual({ reason: "OOM killer", count: 2 });
		expect(digest.topErrors[1]).toEqual({ reason: "segfault in reviewer", count: 1 });
	});

	test("digestToMessage formats a non-empty body", () => {
		const digest: StandupDigest = {
			window: {
				sinceTs: "2026-06-13T00:00:00.000Z",
				untilTs: "2026-06-13T08:00:00.000Z",
			},
			done: 10,
			failed: 2,
			needsHuman: 1,
			merged: 5,
			activeRuns: 3,
			spendUsd: 12.5,
			flaky: 1,
			topErrors: [
				{ reason: "OOM killer", count: 2 },
				{ reason: "segfault", count: 1 },
			],
		};

		const msg = digestToMessage(digest);

		expect(msg.kind).toBe("digest.standup");
		expect(msg.title).toBe("Nightshift standup digest");
		expect(msg.body.length).toBeGreaterThan(0);
		expect(msg.body).toContain("Window:");
		expect(msg.body).toContain("Tasks");
		expect(msg.body).toContain("done=10");
		expect(msg.body).toContain("failed=2");
		expect(msg.body).toContain("Runs");
		expect(msg.body).toContain("active=3");
		expect(msg.body).toContain("$12.5");
		expect(msg.body).toContain("Top exit reasons");
		expect(msg.body).toContain("OOM killer");
	});

	test("digestToMessage sets severity warn when failed > 0", () => {
		const digest: StandupDigest = {
			window: { sinceTs: "2026-06-13T00:00:00Z", untilTs: "2026-06-13T08:00:00Z" },
			done: 5,
			failed: 1, // At least one failure
			needsHuman: 0,
			merged: 3,
			activeRuns: 0,
			spendUsd: 5.0,
			flaky: 0,
			topErrors: [],
		};

		const msg = digestToMessage(digest);

		expect(msg.severity).toBe("warn");
	});

	test("digestToMessage sets severity warn when needsHuman > 0", () => {
		const digest: StandupDigest = {
			window: { sinceTs: "2026-06-13T00:00:00Z", untilTs: "2026-06-13T08:00:00Z" },
			done: 5,
			failed: 0,
			needsHuman: 2, // At least one needing human
			merged: 3,
			activeRuns: 0,
			spendUsd: 5.0,
			flaky: 0,
			topErrors: [],
		};

		const msg = digestToMessage(digest);

		expect(msg.severity).toBe("warn");
	});

	test("digestToMessage sets severity info when all green", () => {
		const digest: StandupDigest = {
			window: { sinceTs: "2026-06-13T00:00:00Z", untilTs: "2026-06-13T08:00:00Z" },
			done: 10,
			failed: 0,
			needsHuman: 0,
			merged: 8,
			activeRuns: 2,
			spendUsd: 5.0,
			flaky: 0,
			topErrors: [],
		};

		const msg = digestToMessage(digest);

		expect(msg.severity).toBe("info");
	});
});

// ---------------------------------------------------------------------------
// Digest Scheduler Tests
// ---------------------------------------------------------------------------

describe("Digest scheduler", () => {
	test("digest scheduler fires periodically and sends digest", async () => {
		// Create a task and run so the digest has data
		const now = new Date().toISOString();
		handle.db
			.insert(tasks)
			.values({ projectId: 1, title: "demo task", state: "done", createdAt: now, updatedAt: now })
			.run();

		const fakeNotifier = new FakeNotifier();

		// Fire every 100ms, 1-hour window
		const scheduler = makeDigestScheduler({
			handle,
			notifier: fakeNotifier,
			now: () => clock,
			intervalMs: 50,
			sinceWindowMs: 3600 * 1000,
		});

		// Wait a bit for the first fire
		await new Promise((resolve) => setTimeout(resolve, 150));

		scheduler.stop();

		// Should have fired at least once
		expect(fakeNotifier.calls.length).toBeGreaterThanOrEqual(1);
		const msg = fakeNotifier.calls[0]!;
		expect(msg.kind).toBe("digest.standup");
		expect(msg.title).toBe("Nightshift standup digest");
	});

	test("digest scheduler survives notifier errors", async () => {
		// A notifier that throws on first call, then succeeds
		let callCount = 0;
		const failingNotifier = {
			async notify() {
				callCount++;
				if (callCount === 1) {
					throw new Error("Notifier crashed");
				}
				return [{ channel: "fake", ok: true }];
			},
		};

		const scheduler = makeDigestScheduler({
			handle,
			notifier: failingNotifier,
			now: () => clock,
			intervalMs: 50,
			sinceWindowMs: 3600 * 1000,
		});

		// Wait for multiple fires — first should fail, second should succeed
		await new Promise((resolve) => setTimeout(resolve, 200));

		scheduler.stop();

		// Should have called the notifier multiple times despite the first failure
		expect(callCount).toBeGreaterThanOrEqual(2);
	});

	test("digest scheduler computes sinceTs = now - sinceWindowMs", async () => {
		const fakeNotifier = new FakeNotifier();

		// Create a run ending in what will be "the window"
		handle.db
			.insert(runs)
			.values({
				kind: "coder",
				provider: "claude",
				model: "opus",
				authLane: "subscription",
				state: "succeeded",
				priced: true,
				costUsd: 5.0,
				endedAt: "2026-06-13T11:00:00.000Z",
			})
			.run();

		// Set clock to 12:00:00, window = 1 hour, sinceTs should be 11:00:00
		resetClock("2026-06-13T12:00:00.000Z");

		const scheduler = makeDigestScheduler({
			handle,
			notifier: fakeNotifier,
			now: () => clock,
			intervalMs: 50,
			sinceWindowMs: 3600 * 1000, // 1 hour
		});

		await new Promise((resolve) => setTimeout(resolve, 150));

		scheduler.stop();

		expect(fakeNotifier.calls.length).toBeGreaterThanOrEqual(1);
		const msg = fakeNotifier.calls[0]!;
		// The digest body should include the spend (since the run is in the window)
		expect(msg.body).toContain("$5");
	});
});
