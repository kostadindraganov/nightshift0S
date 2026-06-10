/**
 * Warren's run-event fan-out (SPEC §4.3 step 5, §9 "event durability rationale").
 *
 * Two surfaces live here:
 *
 *   `RunEventBroker` — in-memory pub/sub keyed by warren run id. The
 *      bridge in `./stream.ts` writes each event to the `events` table
 *      first, then `publish()`es to the broker so currently-attached
 *      subscribers see live events. Subscribers are async generators;
 *      each has its own bounded queue so a slow consumer cannot block
 *      the bridge or other consumers.
 *
 *   `tailRunEvents` — replay history then live-tail. The HTTP
 *      `/runs/:id/events?follow=1` route serves this generator: history
 *      comes from `EventsRepo.listByRun`, live events come from the
 *      broker subscription. Subscription is opened **before** history
 *      is read so events arriving in the gap aren't dropped; the
 *      handoff dedupes by `burrow_event_seq` so subscribers don't see
 *      the same row twice.
 *
 * The broker is intentionally not durable. Burrow owns the canonical
 * event log; warren's events table is the recovery boundary if warren
 * restarts. The broker holds nothing the events table doesn't already
 * have.
 */

import type { EventsRepo } from "../db/repos/events.ts";
import type { EventRow } from "../db/schema.ts";

/**
 * Per-subscriber bounded buffer with a Promise-based notify primitive.
 * The bridge calls `push` from the stream pump; the subscriber's async
 * generator awaits the promise when the queue drains. AbortSignal
 * cleanly resolves the waiter and ends the generator.
 *
 * Queue cap defaults to 1024 — well above any realistic burst the run
 * loop emits, low enough that a stuck consumer surfaces as a `dropped`
 * counter rather than unbounded memory growth.
 */
interface Subscription {
	push(event: EventRow): void;
	end(): void;
	readonly dropped: () => number;
}

export interface SubscribeOptions {
	readonly signal?: AbortSignal;
	/** Maximum buffered events before the broker starts dropping (FIFO). */
	readonly bufferSize?: number;
}

export const DEFAULT_SUBSCRIPTION_BUFFER = 1024;

export class RunEventBroker {
	private readonly subs = new Map<string, Set<Subscription>>();

	/**
	 * Push an event to every active subscriber for `runId`. Called by the
	 * bridge after the event is durably written. No-op when no one is
	 * listening — the events table is the recovery surface for late
	 * subscribers.
	 */
	publish(runId: string, event: EventRow): void {
		const set = this.subs.get(runId);
		if (!set) return;
		for (const sub of set) sub.push(event);
	}

	/**
	 * Signal end-of-stream to every active subscriber for `runId`. The
	 * bridge calls this when the burrow stream returns (run terminated)
	 * or the bridge is being torn down. Subscribers' generators return
	 * after draining their buffer.
	 */
	close(runId: string): void {
		const set = this.subs.get(runId);
		if (!set) return;
		for (const sub of set) sub.end();
		this.subs.delete(runId);
	}

	/** Test/diagnostic surface — number of currently-attached subscribers. */
	subscriberCount(runId: string): number {
		return this.subs.get(runId)?.size ?? 0;
	}

	/**
	 * Open a live subscription. Yields events the bridge publishes after
	 * the call returns; events that landed before are still in the events
	 * table — combine via `tailRunEvents`. Cancellation via `signal`
	 * cleanly ends the generator after the current buffered event is
	 * yielded; ending the generator (consumer breaks out) detaches the
	 * subscription synchronously.
	 */
	subscribe(runId: string, opts: SubscribeOptions = {}): AsyncGenerator<EventRow, void, void> {
		const bufferSize = opts.bufferSize ?? DEFAULT_SUBSCRIPTION_BUFFER;
		const sub = createSubscription(bufferSize);
		this.attach(runId, sub.controller);
		return this.consume(runId, sub, opts.signal);
	}

	private attach(runId: string, sub: Subscription): void {
		let set = this.subs.get(runId);
		if (!set) {
			set = new Set();
			this.subs.set(runId, set);
		}
		set.add(sub);
	}

	private detach(runId: string, sub: Subscription): void {
		const set = this.subs.get(runId);
		if (!set) return;
		set.delete(sub);
		if (set.size === 0) this.subs.delete(runId);
	}

	private async *consume(
		runId: string,
		sub: { controller: Subscription; iterator: AsyncGenerator<EventRow, void, void> },
		signal: AbortSignal | undefined,
	): AsyncGenerator<EventRow, void, void> {
		const onAbort = (): void => sub.controller.end();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) sub.controller.end();
		try {
			for await (const ev of sub.iterator) yield ev;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.detach(runId, sub.controller);
		}
	}
}

/** Build a subscription pair: a push controller and a consumer generator. */
function createSubscription(bufferSize: number): {
	controller: Subscription;
	iterator: AsyncGenerator<EventRow, void, void>;
} {
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

	const controller: Subscription = {
		push(event) {
			if (ended) return;
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

export interface TailRunEventsInput {
	readonly runId: string;
	readonly repos: { events: EventsRepo };
	readonly broker: RunEventBroker;
	/**
	 * `true`: replay history then keep yielding live events until the
	 * broker closes the run or the signal aborts.
	 * `false`: replay history and return.
	 */
	readonly follow: boolean;
	/** Skip events with `burrow_event_seq <= sinceSeq`. Default: 0 (all). */
	readonly sinceSeq?: number;
	readonly signal?: AbortSignal;
}

/**
 * Replay-then-live tail for `/runs/:id/events?follow=1`. Subscribes to
 * the broker first, snapshots the events table, yields the snapshot,
 * then yields live events while skipping any whose seq is at-or-below
 * the highest seq the snapshot already covered. Without that ordering,
 * an event committed-but-not-yet-published between the listByRun call
 * and the subscribe would either be dropped (subscribe-after-listByRun
 * naive) or duplicated (no dedup).
 */
export async function* tailRunEvents(
	input: TailRunEventsInput,
): AsyncGenerator<EventRow, void, void> {
	const { runId, repos, broker, follow, signal } = input;
	const sinceSeq = input.sinceSeq ?? 0;

	if (!follow) {
		const opts = sinceSeq > 0 ? { sinceSeq } : {};
		for (const row of await repos.events.listByRun(runId, opts)) yield row;
		return;
	}

	const subOpts: SubscribeOptions = signal !== undefined ? { signal } : {};
	const live = broker.subscribe(runId, subOpts);
	let lastYielded = sinceSeq;
	try {
		const opts = sinceSeq > 0 ? { sinceSeq } : {};
		for (const row of await repos.events.listByRun(runId, opts)) {
			yield row;
			lastYielded = Math.max(lastYielded, row.burrowEventSeq);
		}
		for await (const row of live) {
			if (row.burrowEventSeq <= lastYielded) continue;
			yield row;
			lastYielded = row.burrowEventSeq;
		}
	} finally {
		await live.return(undefined).catch(() => {});
	}
}
