/**
 * Global event log + in-memory broker (SPEC-SCHEMA "events", BLUEPRINT §3.12;
 * adapted from warren's RunEventBroker — see `reference/warren/events.ts`).
 *
 * Two surfaces live here:
 *
 *   `EventLog.emitEvent` — write-through emit. The next global `seq` is
 *      allocated with `coalesce(max(seq),0)+1` INSIDE the serialized write
 *      (`enqueueWrite`), in the same chain link as the INSERT, so seq is
 *      gap-free and strictly monotonic even under concurrent emitters and
 *      across process restarts (the DB itself is the counter — no JS counter
 *      that can drift from the table after a crash). The broker publish also
 *      happens inside that link, AFTER the insert: durability first, and
 *      publish order provably matches seq order.
 *
 *   `EventLog.subscribe` — replay history then live-tail. The broker
 *      subscription is attached **before** history is read so events arriving
 *      in the gap aren't dropped; the handoff dedupes by `seq` so an event
 *      that lands in both the replay snapshot and the tail buffer is
 *      delivered exactly once, in seq order.
 *
 * The broker is intentionally not durable. The events table is the canonical
 * log and the recovery surface for late subscribers; the broker holds nothing
 * the table doesn't already have. Each subscriber owns a bounded queue
 * (1024, drop-oldest + per-subscriber dropped counter) so a slow consumer
 * cannot block emitters or other consumers — a stuck consumer surfaces as a
 * `dropped()` count rather than unbounded memory growth.
 */

import { asc, gt, sql } from "drizzle-orm";
import type { DbHandle } from "../db/client.ts";
import { events, type EventRow } from "../db/schema.ts";
import { enqueueWrite } from "../db/writer.ts";

export const DEFAULT_SUBSCRIPTION_BUFFER = 1024;

export interface EmitEventInput {
	readonly projectId?: number | null;
	readonly runId?: number | null;
	readonly taskId?: number | null;
	readonly kind: string;
	/** Serialized to `payload_json` here; pass `null` for empty payloads. */
	readonly payload: unknown;
}

export interface SubscribeOptions {
	/** Replay only rows with `seq > afterSeq`. Default 0 (full history). */
	readonly afterSeq?: number;
	/**
	 * Subscriber-side predicate (e.g. by taskId/runId/projectId). Applied to
	 * both replay and tail; non-matching live events never consume buffer
	 * space, so a narrow filter can't be starved by unrelated traffic.
	 */
	readonly filter?: (event: EventRow) => boolean;
	readonly signal?: AbortSignal;
	/** Maximum buffered tail events before drop-oldest kicks in. */
	readonly bufferSize?: number;
}

export interface EventSubscription extends AsyncIterable<EventRow, void, void> {
	/** Detach from the broker; the iterator drains its buffer then returns. */
	close(): void;
	/** Events discarded because this subscriber's buffer overflowed. */
	dropped(): number;
}

/**
 * Per-subscriber bounded buffer with a Promise-based notify primitive
 * (warren's `createSubscription` shape). `push` is called from inside the
 * serialized write; the consumer's async generator awaits the promise when
 * the queue drains.
 */
interface SubscriptionController {
	push(event: EventRow): void;
	end(): void;
	readonly dropped: () => number;
}

function createSubscription(
	bufferSize: number,
	filter: (event: EventRow) => boolean,
): { controller: SubscriptionController; iterator: AsyncGenerator<EventRow, void, void> } {
	const queue: EventRow[] = [];
	let waiter: (() => void) | null = null;
	let ended = false;
	let dropped = 0;

	const wake = (): void => {
		if (waiter) {
			const fn = waiter;
			waiter = null;
			fn();
		}
	};

	const controller: SubscriptionController = {
		push(event) {
			if (ended || !filter(event)) return;
			if (queue.length >= bufferSize) {
				queue.shift();
				dropped += 1;
			}
			queue.push(event);
			wake();
		},
		end() {
			ended = true;
			wake();
		},
		dropped: () => dropped,
	};

	async function* iterator(): AsyncGenerator<EventRow, void, void> {
		while (true) {
			const next = queue.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			if (ended) return;
			await new Promise<void>((resolve) => {
				waiter = resolve;
			});
		}
	}

	return { controller, iterator: iterator() };
}

export class EventLog {
	private readonly handle: DbHandle;
	private readonly subs = new Set<SubscriptionController>();

	constructor(handle: DbHandle) {
		this.handle = handle;
	}

	/**
	 * Allocate the next global seq, INSERT the row, and publish to live
	 * subscribers — all inside one serialized write-queue link. Resolves with
	 * the persisted row once it is durably written.
	 */
	emitEvent(input: EmitEventInput): Promise<EventRow> {
		return enqueueWrite(() => {
			// The DB is the counter: max(seq)+1 inside the serialized write is
			// gap-free under concurrency and survives restarts for free.
			const next =
				(this.handle.db
					.select({ max: sql<number>`coalesce(max(${events.seq}), 0)` })
					.from(events)
					.get()?.max ?? 0) + 1;
			const row = this.handle.db
				.insert(events)
				.values({
					projectId: input.projectId ?? null,
					runId: input.runId ?? null,
					taskId: input.taskId ?? null,
					seq: next,
					kind: input.kind,
					payloadJson: JSON.stringify(input.payload ?? null),
					ts: new Date().toISOString(),
				})
				.returning()
				.get();
			// Write-through first, publish second; publishing inside the same
			// (synchronous) link guarantees publish order == seq order.
			for (const sub of this.subs) sub.push(row);
			return row;
		});
	}

	/** Test/diagnostic surface — number of currently-attached subscribers. */
	subscriberCount(): number {
		return this.subs.size;
	}

	/**
	 * Replay-then-live tail. Attaches the broker subscription FIRST, then
	 * snapshots the events table (seq > afterSeq), yields the snapshot, then
	 * yields live events while skipping any whose seq is at-or-below the
	 * highest seq already yielded. Without that ordering, an event committed
	 * between the snapshot and a later subscribe would be dropped; without
	 * the dedup it would be duplicated.
	 */
	subscribe(opts: SubscribeOptions = {}): EventSubscription {
		const afterSeq = opts.afterSeq ?? 0;
		const filter = opts.filter ?? (() => true);
		const bufferSize = opts.bufferSize ?? DEFAULT_SUBSCRIPTION_BUFFER;
		const sub = createSubscription(bufferSize, filter);
		this.subs.add(sub.controller);

		const onAbort = (): void => sub.controller.end();
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.signal?.aborted) sub.controller.end();

		const subs = this.subs;
		const db = this.handle.db;
		async function* iterate(): AsyncGenerator<EventRow, void, void> {
			let lastYielded = afterSeq;
			try {
				// Snapshot reads are synchronous (bun:sqlite) and unrestricted
				// under WAL — no enqueueWrite needed. Anything inserted before
				// this line is in the snapshot; anything published before it is
				// in the buffer; the seq dedup below resolves the overlap.
				const history = db
					.select()
					.from(events)
					.where(gt(events.seq, afterSeq))
					.orderBy(asc(events.seq))
					.all();
				for (const row of history) {
					if (!filter(row)) continue;
					yield row;
					lastYielded = Math.max(lastYielded, row.seq);
				}
				for await (const row of sub.iterator) {
					if (row.seq <= lastYielded) continue;
					yield row;
					lastYielded = row.seq;
				}
			} finally {
				subs.delete(sub.controller);
				opts.signal?.removeEventListener("abort", onAbort);
			}
		}
		const iterator = iterate();

		return {
			[Symbol.asyncIterator]: () => iterator,
			close: () => {
				sub.controller.end();
				this.subs.delete(sub.controller);
			},
			dropped: sub.controller.dropped,
		};
	}
}
