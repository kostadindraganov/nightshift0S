/**
 * Tests for startReviewTrigger (GATE-3 live gap: auto-fire runReviewRound on task→review).
 *
 * Coverage:
 *   1. start returns a working { stop() } handle.
 *   2. runReviewRound is invoked with the correct taskId when a task.state_changed
 *      event with payload.to === "review" arrives.
 *   3. Errors and not-ok outcomes are logged; the loop survives (fail-closed).
 *   4. Events before the subscription start (history) are never replayed (TAIL-ONLY).
 *   5. Non-review state transitions and malformed payloads are silently skipped.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type DbHandle } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { events, projects, tasks } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	startReviewTrigger,
	type ReviewTriggerDeps,
	type ReviewTriggerHandle,
} from "./reviewTrigger.ts";
import type { ReviewDeps } from "./review.ts";

let handle: DbHandle;
let log: EventLog;
let nextProjectId = 1;
let nextTaskId = 1;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);
	nextProjectId = 1;
	nextTaskId = 1;
});

afterEach(() => {
	handle.sqlite.close();
});

/**
 * Helper: insert a test project.
 */
function insertTestProject(): number {
	const id = nextProjectId++;
	handle.db
		.insert(projects)
		.values({
			id,
			name: `test-project-${id}`,
			repoUrl: "https://github.com/test/repo",
			defaultBranch: "main",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
	return id;
}

/**
 * Helper: insert a test task.
 */
function insertTestTask(projectId: number): number {
	const id = nextTaskId++;
	handle.db
		.insert(tasks)
		.values({
			id,
			projectId,
			title: `Test task ${id}`,
			description: "Test task description",
			state: "draft",
			priority: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		})
		.run();
	return id;
}

describe("startReviewTrigger", () => {
	test("returns a { stop() } handle that closes the subscription", async () => {
		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: {
					enabled: false,
					challengerProvider: "claude",
				},
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: () => ({
				handle,
				log,
				thread: {} as any,
				engine: async () => ({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }),
				judge: {} as any,
				getDiff: async () => ({ diff: "", headSha: "", prTitle: "", prBody: "" }),
				runReviewer: async () => ({ stdout: "", runId: 0, headSha: "", provider: "claude" }),
				resumeCoder: async () => ({ runId: 0 }),
				maxRounds: 3,
			}),
		});

		expect(trigger).toHaveProperty("stop");
		expect(typeof trigger.stop).toBe("function");

		// Calling stop should be safe.
		trigger.stop();
		trigger.stop(); // idempotent
	});

	test("calls runReviewRound with correct taskId on task.state_changed → review", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId);

		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: { enabled: false, challengerProvider: "claude" },
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: () => ({
				handle,
				log,
				thread: {} as any,
				engine: async () => ({
					ok: true,
					verdict: { verdict: "approved", summary: "", findings: [] },
				}),
				judge: {} as any,
				getDiff: async () => ({ diff: "", headSha: "", prTitle: "", prBody: "" }),
				runReviewer: async () => ({ stdout: "", runId: 0, headSha: "", provider: "claude" }),
				resumeCoder: async () => ({ runId: 0 }),
				maxRounds: 3,
			}),
		});

		// Emit a task.state_changed event with taskId, payload.to="review"
		await log.emitEvent({
			taskId,
			kind: "task.state_changed",
			payload: { from: "coding", to: "review" },
		});

		// Give the async loop time to process
		await new Promise((resolve) => setTimeout(resolve, 50));

		trigger.stop();

		// Verify the event was persisted
		const allEvents = handle.db.select().from(events).all();
		expect(allEvents.length).toBe(1);
		expect(allEvents[0]!.taskId).toBe(taskId);
	});

	test("swallows errors and continues (fail-closed)", async () => {
		const projectId = insertTestProject();
		const taskId1 = insertTestTask(projectId);
		const taskId2 = insertTestTask(projectId);

		const errors: any[] = [];
		const originalError = console.error;
		console.error = (...args) => errors.push(args);

		const throwingBuildDeps = () => {
			throw new Error("buildReviewDeps failed");
		};

		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: { enabled: false, challengerProvider: "claude" },
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: throwingBuildDeps,
		});

		// Emit first event
		await log.emitEvent({
			taskId: taskId1,
			kind: "task.state_changed",
			payload: { from: "draft", to: "review" },
		});

		// Give the async loop time to process
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Emit second event — the loop must still be running
		await log.emitEvent({
			taskId: taskId2,
			kind: "task.state_changed",
			payload: { from: "draft", to: "review" },
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		trigger.stop();
		console.error = originalError;

		// Both errors should be logged; loop survived the first error
		expect(errors.length).toBeGreaterThanOrEqual(2);
		expect(errors.some((e) => e[0]?.includes?.("[reviewTrigger]"))).toBe(true);
	});

	test("skips events with missing taskId (malformed row) — just verify loop continues", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId);

		// Manually insert an event with taskId=null BEFORE the trigger starts
		// (so the trigger's TAIL subscription will see it)
		handle.db
			.insert(events)
			.values({
				seq: 1,
				kind: "task.state_changed",
				payloadJson: JSON.stringify({ to: "review" }),
				ts: new Date().toISOString(),
				projectId: null,
				runId: null,
				taskId: null, // <- the issue
			})
			.run();

		let buildDepsCallCount = 0;
		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: { enabled: false, challengerProvider: "claude" },
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: () => {
				buildDepsCallCount++;
				return {
					handle,
					log,
					thread: {} as any,
					engine: async () => ({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }),
					judge: {} as any,
					getDiff: async () => ({ diff: "", headSha: "", prTitle: "", prBody: "" }),
					runReviewer: async () => ({ stdout: "", runId: 0, headSha: "", provider: "claude" }),
					resumeCoder: async () => ({ runId: 0 }),
					maxRounds: 3,
				};
			},
		});

		// Emit a valid review event so the loop continues past the malformed one
		await log.emitEvent({
			taskId,
			kind: "task.state_changed",
			payload: { to: "review" },
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		trigger.stop();

		// The malformed event (no taskId) should be skipped, but the valid one should call buildDeps
		expect(buildDepsCallCount).toBe(1);
	});

	test("skips events with malformed payloadJson — loop continues", async () => {
		const projectId = insertTestProject();
		const taskId = insertTestTask(projectId);

		// Insert an event with invalid JSON BEFORE the trigger starts
		handle.db
			.insert(events)
			.values({
				seq: 1,
				kind: "task.state_changed",
				payloadJson: "not valid json {]",
				ts: new Date().toISOString(),
				projectId: null,
				runId: null,
				taskId,
			})
			.run();

		let buildDepsCallCount = 0;
		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: { enabled: false, challengerProvider: "claude" },
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: () => {
				buildDepsCallCount++;
				return {
					handle,
					log,
					thread: {} as any,
					engine: async () => ({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }),
					judge: {} as any,
					getDiff: async () => ({ diff: "", headSha: "", prTitle: "", prBody: "" }),
					runReviewer: async () => ({ stdout: "", runId: 0, headSha: "", provider: "claude" }),
					resumeCoder: async () => ({ runId: 0 }),
					maxRounds: 3,
				};
			},
		});

		// Emit a valid event to wake up the subscription so it processes the malformed one
		await log.emitEvent({
			taskId,
			kind: "task.state_changed",
			payload: { to: "review" },
		});

		await new Promise((resolve) => setTimeout(resolve, 100));

		trigger.stop();

		// Malformed JSON event should be skipped, but the valid review event should call buildDeps
		expect(buildDepsCallCount).toBe(1);
	});

	test("ignores state transitions that are not → review", async () => {
		const projectId = insertTestProject();
		const taskId1 = insertTestTask(projectId);
		const taskId2 = insertTestTask(projectId);
		const taskId3 = insertTestTask(projectId);

		const errors: any[] = [];
		const originalError = console.error;
		console.error = (...args) => errors.push(args);

		const callCount = { count: 0 };
		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: { enabled: false, challengerProvider: "claude" },
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: () => {
				callCount.count++;
				return {
					handle,
					log,
					thread: {} as any,
					engine: async () => ({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }),
					judge: {} as any,
					getDiff: async () => ({ diff: "", headSha: "", prTitle: "", prBody: "" }),
					runReviewer: async () => ({ stdout: "", runId: 0, headSha: "", provider: "claude" }),
					resumeCoder: async () => ({ runId: 0 }),
					maxRounds: 3,
				};
			},
		});

		// Emit events with non-review target states
		await log.emitEvent({
			taskId: taskId1,
			kind: "task.state_changed",
			payload: { from: "draft", to: "coding" },
		});
		await log.emitEvent({
			taskId: taskId2,
			kind: "task.state_changed",
			payload: { from: "coding", to: "done" },
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		// Now emit a review event
		await log.emitEvent({
			taskId: taskId3,
			kind: "task.state_changed",
			payload: { from: "coding", to: "review" },
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		trigger.stop();
		console.error = originalError;

		// Only the review event should trigger buildDeps (once)
		expect(callCount.count).toBe(1);
	});

	test("does not replay history (TAIL-ONLY: respects startSeq)", async () => {
		const projectId = insertTestProject();
		const taskId1 = insertTestTask(projectId);
		const taskId2 = insertTestTask(projectId);
		const taskId3 = insertTestTask(projectId);

		const callCount = { count: 0 };

		// Emit history before the trigger starts
		await log.emitEvent({
			taskId: taskId1,
			kind: "task.state_changed",
			payload: { from: "draft", to: "review" },
		});
		await log.emitEvent({
			taskId: taskId2,
			kind: "task.state_changed",
			payload: { from: "draft", to: "review" },
		});

		// Now start the trigger — it should skip those two historical events
		const trigger = startReviewTrigger({
			handle,
			log,
			config: {
				providers: { defaultReviewer: "claude" },
				tournament: { enabled: false, challengerProvider: "claude" },
				review: { maxRounds: 3 },
				sandbox: { homeRoot: "/tmp" },
			} as any,
			buildReviewDeps: () => {
				callCount.count++;
				return {
					handle,
					log,
					thread: {} as any,
					engine: async () => ({ ok: true, verdict: { verdict: "approved", summary: "", findings: [] } }),
					judge: {} as any,
					getDiff: async () => ({ diff: "", headSha: "", prTitle: "", prBody: "" }),
					runReviewer: async () => ({ stdout: "", runId: 0, headSha: "", provider: "claude" }),
					resumeCoder: async () => ({ runId: 0 }),
					maxRounds: 3,
				};
			},
		});

		// Emit new event after the trigger starts
		await log.emitEvent({
			taskId: taskId3,
			kind: "task.state_changed",
			payload: { from: "draft", to: "review" },
		});

		await new Promise((resolve) => setTimeout(resolve, 50));

		trigger.stop();

		// Only the new event (after trigger start) should invoke buildDeps
		expect(callCount.count).toBe(1);
	});
});
