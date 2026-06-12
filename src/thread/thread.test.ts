/**
 * WHY: The thread service guards the two invariants that make the append-only
 * audit trail trustworthy — gap-free monotonic `seq` under concurrency, and
 * redact-before-persist so secrets never hit the row — plus idempotent appends
 * and the finding-resolution guard. These tests use a real `:memory:` DbHandle
 * + EventLog (like coder.test.ts) so the writer-queue serialization is exercised
 * for real, not mocked.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type { DbHandle } from "../db/client.ts";
import { openDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { projects, tasks, events, threadEvents } from "../db/schema.ts";
import { EventLog } from "../events/events.ts";
import {
	appendThreadEvent,
	getThread,
	addFinding,
	listFindings,
	updateFindingResolution,
	THREAD_APPENDED,
} from "./thread.ts";

let handle: DbHandle;
let log: EventLog;
let taskId: number;

beforeEach(() => {
	handle = openDatabase(":memory:");
	runMigrations(handle);
	log = new EventLog(handle);

	const now = new Date().toISOString();
	const projectId = handle.db
		.insert(projects)
		.values({ name: "p", repoUrl: "https://github.com/o/r.git", createdAt: now, updatedAt: now })
		.returning()
		.get().id;
	taskId = handle.db
		.insert(tasks)
		.values({ projectId, title: "t", state: "review", priority: 0, createdAt: now, updatedAt: now })
		.returning()
		.get().id;
});

describe("appendThreadEvent", () => {
	test("seq is strictly monotonic + gap-free under concurrent appends", async () => {
		const N = 20;
		await Promise.all(
			Array.from({ length: N }, (_, i) =>
				appendThreadEvent(handle, log, {
					taskId,
					kind: "message",
					actor: "system",
					round: 0,
					payload: { i },
				}),
			),
		);

		const rows = getThread(handle, taskId);
		expect(rows.length).toBe(N);
		// 1..N, gap-free.
		expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: N }, (_, i) => i + 1));
	});

	test("idempotency_key collision returns the SAME row, no 2nd row or event", async () => {
		const first = await appendThreadEvent(handle, log, {
			taskId,
			kind: "verdict",
			actor: "reviewer:codex",
			round: 1,
			idempotencyKey: "verdict:1:1:abc",
			payload: { verdict: "revise" },
		});
		const second = await appendThreadEvent(handle, log, {
			taskId,
			kind: "verdict",
			actor: "reviewer:codex",
			round: 1,
			idempotencyKey: "verdict:1:1:abc",
			payload: { verdict: "approved" }, // different payload, same key
		});

		expect(second.id).toBe(first.id);
		expect(getThread(handle, taskId).length).toBe(1);

		const appended = handle.db
			.select()
			.from(events)
			.all()
			.filter((e) => e.kind === THREAD_APPENDED && e.taskId === taskId);
		expect(appended.length).toBe(1);
	});

	test("planted secrets are redacted before persist; redacted=1; marker present", async () => {
		const ghp = "ghp_" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ012345678";
		const skant = "sk-ant-" + "api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890ABCDE";
		const row = await appendThreadEvent(handle, log, {
			taskId,
			kind: "message",
			actor: "coder:claude-code",
			round: 1,
			payload: { note: `token=${ghp}`, nested: { key: skant } },
		});

		// Read the raw persisted JSON straight from the table.
		const persisted = handle.db
			.select({ payloadJson: threadEvents.payloadJson })
			.from(threadEvents)
			.all()[0]?.payloadJson;
		expect(persisted).toBeDefined();
		expect(persisted).not.toContain(ghp);
		expect(persisted).not.toContain(skant);
		expect(persisted).toContain("[REDACTED:github-pat-classic]");
		expect(persisted).toContain("[REDACTED:anthropic-api-key]");
		expect(row.redacted).toBe(true);
	});
});

describe("findings", () => {
	test("listFindings round filter returns only that round", async () => {
		await addFinding(handle, {
			taskId,
			round: 1,
			severity: "high",
			confidence: 0.9,
			commitSha: "sha1",
			description: "r1 finding",
		});
		await addFinding(handle, {
			taskId,
			round: 2,
			severity: "low",
			confidence: 0.4,
			commitSha: "sha2",
			description: "r2 finding",
		});

		expect(listFindings(handle, taskId).length).toBe(2);
		const r2 = listFindings(handle, taskId, 2);
		expect(r2.length).toBe(1);
		expect(r2[0]?.description).toBe("r2 finding");
	});

	test("updateFindingResolution: guard rejects terminal/open target, allows open→fixed", async () => {
		const f = await addFinding(handle, {
			taskId,
			round: 1,
			severity: "critical",
			confidence: 1,
			commitSha: "sha1",
			description: "f",
		});

		// "open" target rejected (fail-closed: never reopen).
		expect(await updateFindingResolution(handle, log, {
			findingId: f.id,
			resolutionState: "open",
			resolvedRound: 1,
		})).toBeNull();

		// open → fixed succeeds.
		const fixed = await updateFindingResolution(handle, log, {
			findingId: f.id,
			resolutionState: "fixed",
			resolvedRound: 1,
		});
		expect(fixed?.resolutionState).toBe("fixed");
		expect(fixed?.resolvedRound).toBe(1);

		// fixed is terminal → second update guarded out (0 rows).
		expect(await updateFindingResolution(handle, log, {
			findingId: f.id,
			resolutionState: "withdrawn",
			resolvedRound: 2,
		})).toBeNull();
	});
});
