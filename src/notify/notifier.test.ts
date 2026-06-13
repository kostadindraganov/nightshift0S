/**
 * Tests for notifier + EventBridge + Telegram channel (UNIT 5.8b).
 *
 * Hermetic test harness:
 *   - Notifier happy path: message routed through channel.
 *   - Notifier route predicate: kind filtering.
 *   - Channel isolation: one channel throw does not block others.
 *   - Telegram: happy path, unconfigured (fail-closed), HTTP errors.
 *   - EventBridge: construction, stop, fail-closed.
 *   - defaultMapEvent: event mapping for task state changes and budget kills.
 *
 * All side-effects faked: in-memory SQLite, EventLog, and a fake HttpSend.
 * No network, no global fetch.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { type EventRow } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	type Channel,
	DEFAULT_INTERESTING_KINDS,
	Notifier,
	defaultMapEvent,
	makeEventBridge,
	type NotifyMessage,
} from "./notifier.ts";
import { makeTelegramChannel, type HttpSend } from "./telegram.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let handle: DbHandle;
let log: EventLog;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
});

afterEach(() => {
	handle.sqlite.close();
});

// ---------------------------------------------------------------------------
// 1. Notifier happy path: message routed through channels
// ---------------------------------------------------------------------------

test("Notifier routes message to all channels (happy path)", async () => {
	const ch1Calls: NotifyMessage[] = [];
	const ch2Calls: NotifyMessage[] = [];

	const ch1: Channel = {
		name: "channel1",
		async send(msg) {
			ch1Calls.push(msg);
			return { ok: true };
		},
	};

	const ch2: Channel = {
		name: "channel2",
		async send(msg) {
			ch2Calls.push(msg);
			return { ok: true };
		},
	};

	const notifier = new Notifier({ channels: [ch1, ch2] });

	const msg: NotifyMessage = {
		kind: "test.event",
		title: "Test Title",
		body: "Test Body",
		severity: "info",
		taskId: 1,
		runId: 2,
		projectId: 3,
	};

	const results = await notifier.notify(msg);

	expect(ch1Calls).toHaveLength(1);
	expect(ch1Calls[0]).toEqual(msg);
	expect(ch2Calls).toHaveLength(1);
	expect(ch2Calls[0]).toEqual(msg);

	// Results show both succeeded.
	expect(results).toHaveLength(2);
	expect(results[0]).toEqual({ channel: "channel1", ok: true });
	expect(results[1]).toEqual({ channel: "channel2", ok: true });
});

// ---------------------------------------------------------------------------
// 2. Notifier route predicate: kind filtering
// ---------------------------------------------------------------------------

test("Notifier respects route predicate", async () => {
	const chCalls: NotifyMessage[] = [];
	const ch: Channel = {
		name: "test",
		async send(msg) {
			chCalls.push(msg);
			return { ok: true };
		},
	};

	const notifier = new Notifier({
		channels: [ch],
		route: (kind) => kind === "task.state_changed",
	});

	// Message with filtered-out kind → route returns false, no channel contacted.
	const ignored: NotifyMessage = {
		kind: "other.event",
		title: "Ignored",
		body: "This should not be sent",
	};
	const r1 = await notifier.notify(ignored);
	expect(r1).toHaveLength(0);
	expect(chCalls).toHaveLength(0);

	// Message with allowed kind → channel contacted.
	const allowed: NotifyMessage = {
		kind: "task.state_changed",
		title: "Task Changed",
		body: "Task moved to done",
	};
	const r2 = await notifier.notify(allowed);
	expect(r2).toHaveLength(1);
	expect(chCalls).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// 3. Channel isolation: one channel failure does not block others
// ---------------------------------------------------------------------------

test("Channel isolation: throw in one channel does not block others", async () => {
	const ch1Calls: NotifyMessage[] = [];
	const ch2Calls: NotifyMessage[] = [];
	const ch3Calls: NotifyMessage[] = [];

	const ch1: Channel = {
		name: "bad",
		async send() {
			throw new Error("Network timeout");
		},
	};

	const ch2: Channel = {
		name: "good1",
		async send(msg) {
			ch2Calls.push(msg);
			return { ok: true };
		},
	};

	const ch3: Channel = {
		name: "bad2",
		async send() {
			throw new Error("Uncaught exception");
		},
	};

	const notifier = new Notifier({ channels: [ch1, ch2, ch3] });

	const msg: NotifyMessage = {
		kind: "test",
		title: "Test",
		body: "Message",
	};

	const results = await notifier.notify(msg);

	// ch2 was contacted and succeeded.
	expect(ch2Calls).toHaveLength(1);

	// Results show both bad channels failed with reason, good channel succeeded.
	expect(results).toHaveLength(3);
	expect(results[0]).toEqual({
		channel: "bad",
		ok: false,
		reason: "Network timeout",
	});
	expect(results[1]).toEqual({ channel: "good1", ok: true });
	expect(results[2]).toEqual({
		channel: "bad2",
		ok: false,
		reason: "Uncaught exception",
	});
});

// ---------------------------------------------------------------------------
// 4. Telegram happy path: message sent with title\n\nbody format
// ---------------------------------------------------------------------------

test("Telegram channel sends formatted message to Telegram API", async () => {
	const httpCalls: Array<{ url: string; body: unknown }> = [];
	const send: HttpSend = async (url, body) => {
		httpCalls.push({ url, body });
		return { ok: true, status: 200 };
	};

	const ch = makeTelegramChannel({
		botTokenRef: () => "test-bot-token-xyz",
		chatId: "123456",
		send,
	});

	const msg: NotifyMessage = {
		kind: "task.state_changed",
		title: "Task 42: done",
		body: "Task moved to state 'done' (id=42).",
		severity: "info",
	};

	const result = await ch.send(msg);

	expect(result).toEqual({ ok: true });
	expect(httpCalls).toHaveLength(1);

	const call = httpCalls[0]!;
	expect(call.url).toBe("https://api.telegram.org/bottest-bot-token-xyz/sendMessage");
	expect(call.body).toEqual({
		chat_id: "123456",
		text: "Task 42: done\n\nTask moved to state 'done' (id=42).",
	});
});

// ---------------------------------------------------------------------------
// 5. Telegram fail-closed: unconfigured (no token)
// ---------------------------------------------------------------------------

test("Telegram returns unconfigured when botTokenRef returns undefined", async () => {
	const send: HttpSend = async () => {
		throw new Error("Should not be called");
	};

	const ch = makeTelegramChannel({
		botTokenRef: () => undefined,
		chatId: "123456",
		send,
	});

	const msg: NotifyMessage = {
		kind: "test",
		title: "Title",
		body: "Body",
	};

	const result = await ch.send(msg);

	expect(result).toEqual({ ok: false, reason: "unconfigured" });
});

// ---------------------------------------------------------------------------
// 6. Telegram fail-closed: unconfigured (no chat_id)
// ---------------------------------------------------------------------------

test("Telegram returns unconfigured when chatId is undefined", async () => {
	const send: HttpSend = async () => {
		throw new Error("Should not be called");
	};

	const ch = makeTelegramChannel({
		botTokenRef: () => "token",
		chatId: undefined,
		send,
	});

	const msg: NotifyMessage = {
		kind: "test",
		title: "Title",
		body: "Body",
	};

	const result = await ch.send(msg);

	expect(result).toEqual({ ok: false, reason: "unconfigured" });
});

// ---------------------------------------------------------------------------
// 7. Telegram HTTP error: token in URL only, not in reason
// ---------------------------------------------------------------------------

test("Telegram returns http status code (not token) on failed HTTP response", async () => {
	const httpCalls: string[] = [];
	const send: HttpSend = async (url) => {
		httpCalls.push(url);
		return { ok: false, status: 429 };
	};

	const ch = makeTelegramChannel({
		botTokenRef: () => "super-secret-token",
		chatId: "123456",
		send,
	});

	const msg: NotifyMessage = {
		kind: "test",
		title: "Test",
		body: "Message",
	};

	const result = await ch.send(msg);

	expect(result).toEqual({ ok: false, reason: "http 429" });
	// Token appears in the URL (which we see in our test fake), but NOT in the reason.
	expect(httpCalls[0]).toContain("super-secret-token");
});

// ---------------------------------------------------------------------------
// 8. Telegram send error: no token in reason
// ---------------------------------------------------------------------------

test("Telegram catches send error and returns 'send error' (no token leaked)", async () => {
	const send: HttpSend = async () => {
		throw new Error("Connection refused");
	};

	const ch = makeTelegramChannel({
		botTokenRef: () => "secret-token",
		chatId: "123456",
		send,
	});

	const msg: NotifyMessage = {
		kind: "test",
		title: "Test",
		body: "Message",
	};

	const result = await ch.send(msg);

	expect(result).toEqual({ ok: false, reason: "send error" });
});

// ---------------------------------------------------------------------------
// 9. defaultMapEvent: task.state_changed to terminal states
// ---------------------------------------------------------------------------

test("defaultMapEvent maps task.state_changed (done) to NotifyMessage", () => {
	const event: EventRow = {
		id: 1,
		seq: 1,
		kind: "task.state_changed",
		payloadJson: JSON.stringify({ to: "done", from: "review" }),
		ts: "2026-06-13T00:00:00Z",
		taskId: 42,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg).not.toBeNull();
	expect(msg?.kind).toBe("task.state_changed");
	expect(msg?.title).toBe("Task 42: done");
	expect(msg?.taskId).toBe(42);
	expect(msg?.severity).toBe("info");
});

test("defaultMapEvent maps task.state_changed (failed) with error severity", () => {
	const event: EventRow = {
		id: 2,
		seq: 2,
		kind: "task.state_changed",
		payloadJson: JSON.stringify({ to: "failed", from: "coding" }),
		ts: "2026-06-13T00:01:00Z",
		taskId: 43,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg?.severity).toBe("error");
	expect(msg?.title).toBe("Task 43: failed");
});

test("defaultMapEvent returns null for non-terminal task.state_changed", () => {
	const event: EventRow = {
		id: 3,
		seq: 3,
		kind: "task.state_changed",
		payloadJson: JSON.stringify({ to: "coding", from: "ready" }),
		ts: "2026-06-13T00:02:00Z",
		taskId: 44,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg).toBeNull();
});

test("defaultMapEvent maps run.budget_kill to error message", () => {
	const event: EventRow = {
		id: 4,
		seq: 4,
		kind: "run.budget_kill",
		payloadJson: JSON.stringify({}),
		ts: "2026-06-13T00:03:00Z",
		taskId: null,
		runId: 99,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg).not.toBeNull();
	expect(msg?.kind).toBe("run.budget_kill");
	expect(msg?.severity).toBe("error");
	expect(msg?.runId).toBe(99);
});

test("defaultMapEvent returns null for uninteresting event kinds", () => {
	const event: EventRow = {
		id: 5,
		seq: 5,
		kind: "some.other.event",
		payloadJson: JSON.stringify({}),
		ts: "2026-06-13T00:04:00Z",
		taskId: null,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg).toBeNull();
});

test("defaultMapEvent handles malformed payload gracefully", () => {
	const event: EventRow = {
		id: 6,
		seq: 6,
		kind: "task.state_changed",
		payloadJson: "not valid json",
		ts: "2026-06-13T00:05:00Z",
		taskId: 45,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	// Malformed payload treated as non-actionable.
	expect(msg).toBeNull();
});

// ---------------------------------------------------------------------------
// 10. EventBridge: can be constructed and stopped
// ---------------------------------------------------------------------------

test("EventBridge constructs and can be stopped", () => {
	const ch: Channel = {
		name: "test",
		async send() {
			return { ok: true };
		},
	};

	const notifier = new Notifier({ channels: [ch] });

	// Create bridge: should construct without error.
	const bridge = makeEventBridge({
		handle,
		log,
		notifier,
		interestingKinds: DEFAULT_INTERESTING_KINDS,
		mapEvent: defaultMapEvent,
	});

	// Bridge.stop() should not throw.
	bridge.stop();
});

// ---------------------------------------------------------------------------
// 11. EventBridge: error in loop does not crash construction
// ---------------------------------------------------------------------------

test("EventBridge construction completes with bad mapEvent", () => {
	const ch: Channel = {
		name: "test",
		async send() {
			return { ok: true };
		},
	};

	const notifier = new Notifier({ channels: [ch] });

	const badMapEvent = (e: EventRow): NotifyMessage | null => {
		if (e.kind === "crash.event") {
			throw new Error("mapEvent crashed");
		}
		return defaultMapEvent(e);
	};

	const bridge = makeEventBridge({
		handle,
		log,
		notifier,
		interestingKinds: new Set(["task.state_changed", "crash.event"]),
		mapEvent: badMapEvent,
	});

	// Should construct without throwing.
	expect(bridge).toBeTruthy();

	bridge.stop();
});

// ---------------------------------------------------------------------------
// 12. EventBridge: multiple bridges can coexist
// ---------------------------------------------------------------------------

test("Multiple EventBridge instances can coexist", () => {
	const ch1: Channel = {
		name: "ch1",
		async send() {
			return { ok: true };
		},
	};
	const ch2: Channel = {
		name: "ch2",
		async send() {
			return { ok: true };
		},
	};

	const notifier1 = new Notifier({ channels: [ch1] });
	const notifier2 = new Notifier({ channels: [ch2] });

	const bridge1 = makeEventBridge({
		handle,
		log,
		notifier: notifier1,
		interestingKinds: new Set(["kind1"]),
		mapEvent: defaultMapEvent,
	});

	const bridge2 = makeEventBridge({
		handle,
		log,
		notifier: notifier2,
		interestingKinds: new Set(["kind2"]),
		mapEvent: defaultMapEvent,
	});

	bridge1.stop();
	bridge2.stop();
});

// ---------------------------------------------------------------------------
// 13. defaultMapEvent: needs_human and awaiting_input have warn severity
// ---------------------------------------------------------------------------

test("defaultMapEvent maps task.state_changed (needs_human) with warn severity", () => {
	const event: EventRow = {
		id: 7,
		seq: 7,
		kind: "task.state_changed",
		payloadJson: JSON.stringify({ to: "needs_human", from: "review" }),
		ts: "2026-06-13T01:00:00Z",
		taskId: 50,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg).not.toBeNull();
	expect(msg?.severity).toBe("warn");
	expect(msg?.title).toBe("Task 50: needs_human");
	expect(msg?.taskId).toBe(50);
});

test("defaultMapEvent maps task.state_changed (awaiting_input) with warn severity", () => {
	const event: EventRow = {
		id: 8,
		seq: 8,
		kind: "task.state_changed",
		payloadJson: JSON.stringify({ to: "awaiting_input", from: "coding" }),
		ts: "2026-06-13T01:01:00Z",
		taskId: 51,
		runId: null,
		projectId: 100,
	};

	const msg = defaultMapEvent(event);

	expect(msg).not.toBeNull();
	expect(msg?.severity).toBe("warn");
	expect(msg?.title).toBe("Task 51: awaiting_input");
});

// ---------------------------------------------------------------------------
// 14. SECURITY: Telegram reason never contains the bot token
// ---------------------------------------------------------------------------

test("Telegram HTTP error reason never contains the bot token", async () => {
	const TOKEN = "very-secret-bot-token-12345";
	const send: HttpSend = async () => ({ ok: false, status: 500 });

	const ch = makeTelegramChannel({
		botTokenRef: () => TOKEN,
		chatId: "999",
		send,
	});

	const result = await ch.send({ kind: "x", title: "T", body: "B" });

	expect(result.ok).toBe(false);
	// Token must NEVER appear in the reason string.
	expect(result.reason).not.toContain(TOKEN);
});

test("Telegram send-error reason never contains the bot token", async () => {
	const TOKEN = "leaked-token-should-not-appear";
	const send: HttpSend = async (url) => {
		// Simulate an error that incorporates the URL (token) in the message.
		throw new Error(`Failed to POST to ${url}`);
	};

	const ch = makeTelegramChannel({
		botTokenRef: () => TOKEN,
		chatId: "999",
		send,
	});

	const result = await ch.send({ kind: "x", title: "T", body: "B" });

	expect(result.ok).toBe(false);
	// The reason must be the generic sentinel, not the thrown message (which has URL + token).
	expect(result.reason).toBe("send error");
	expect(result.reason).not.toContain(TOKEN);
});

// ---------------------------------------------------------------------------
// 15. EventBridge tail-only: events emitted BEFORE bridge construction are
//     NOT re-delivered (BLUEPRINT §3.10 — no historical re-delivery on restart)
// ---------------------------------------------------------------------------

test("EventBridge tail-only: pre-existing events are not delivered", async () => {
	// Emit an event BEFORE constructing the bridge.
	// Use null FKs to avoid FK constraint failures on the in-memory DB.
	await log.emitEvent({
		kind: "task.state_changed",
		payload: { to: "done", from: "review" },
		taskId: null,
		runId: null,
		projectId: null,
	});

	const received: NotifyMessage[] = [];
	const ch: Channel = {
		name: "recorder",
		async send(msg) {
			received.push(msg);
			return { ok: true };
		},
	};
	const notifier = new Notifier({ channels: [ch] });

	// Bridge constructed AFTER the event is in the DB.
	const bridge = makeEventBridge({
		handle,
		log,
		notifier,
		interestingKinds: DEFAULT_INTERESTING_KINDS,
		mapEvent: defaultMapEvent,
	});

	// Allow the async loop a tick to process pending events (there should be none).
	await new Promise((r) => setTimeout(r, 20));

	bridge.stop();

	// The pre-existing event must NOT have been delivered.
	expect(received).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 16. EventBridge: interestingKinds filter — unregistered kinds are dropped
// ---------------------------------------------------------------------------

test("EventBridge filters out events not in interestingKinds", async () => {
	const received: NotifyMessage[] = [];
	const ch: Channel = {
		name: "recorder",
		async send(msg) {
			received.push(msg);
			return { ok: true };
		},
	};
	const notifier = new Notifier({ channels: [ch] });

	// Bridge interested only in run.budget_kill, not task.state_changed.
	const bridge = makeEventBridge({
		handle,
		log,
		notifier,
		interestingKinds: new Set(["run.budget_kill"]),
		mapEvent: defaultMapEvent,
	});

	// Emit a task.state_changed event after construction (null FKs to avoid FK violations).
	await log.emitEvent({
		kind: "task.state_changed",
		payload: { to: "done", from: "review" },
		taskId: null,
		runId: null,
		projectId: null,
	});

	await new Promise((r) => setTimeout(r, 20));
	bridge.stop();

	// Must not have been forwarded (filtered by interestingKinds).
	expect(received).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// 17. EventBridge: events emitted AFTER construction are delivered
// ---------------------------------------------------------------------------

test("EventBridge forwards events emitted after construction", async () => {
	const received: NotifyMessage[] = [];
	const ch: Channel = {
		name: "recorder",
		async send(msg) {
			received.push(msg);
			return { ok: true };
		},
	};
	const notifier = new Notifier({ channels: [ch] });

	const bridge = makeEventBridge({
		handle,
		log,
		notifier,
		interestingKinds: DEFAULT_INTERESTING_KINDS,
		mapEvent: defaultMapEvent,
	});

	// Emit AFTER construction — should be forwarded (null FKs to avoid FK violations).
	await log.emitEvent({
		kind: "run.budget_kill",
		payload: {},
		taskId: null,
		runId: null,
		projectId: null,
	});

	// Wait for async loop to process.
	await new Promise((r) => setTimeout(r, 30));
	bridge.stop();

	expect(received).toHaveLength(1);
	expect(received[0]!.kind).toBe("run.budget_kill");
	// runId is null (no FK) but the message should still have kind and severity.
	expect(received[0]!.severity).toBe("error");
});
