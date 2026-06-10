/**
 * Serialized write queue (SPEC-SCHEMA "SQLite discipline" §3.12.11).
 *
 * SQLite (even in WAL mode) allows exactly one writer at a time. Rather than
 * letting concurrent async contexts race into SQLITE_BUSY, ALL writes go
 * through one module-level promise chain: `enqueueWrite` appends the write
 * function to the tail of the chain, so writes execute strictly one after
 * another and never interleave. Reads are unrestricted — WAL gives readers
 * snapshot isolation alongside the writer.
 *
 * SQLITE_BUSY can still surface (e.g. an external process like `sqlite3` CLI
 * holding the write lock), so each write gets a bounded retry with jitter
 * (5 attempts, 50ms base + random jitter, doubling); after that the error is
 * surfaced to the caller.
 *
 * TRANSACTION DISCIPLINE: transactions must be SHORT and SYNCHRONOUS. A write
 * fn may be async overall, but a transaction inside it must NEVER span an
 * await on external I/O (agent output, network, subprocess) — that would hold
 * the write lock (and this queue) hostage for the duration of the I/O.
 * Gather inputs first, then transact synchronously.
 */

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 50;

/** Tail of the single write chain. Every enqueueWrite appends to this. */
let chain: Promise<unknown> = Promise.resolve();

function isSqliteBusy(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const code = (err as Error & { code?: string }).code;
	return code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || /SQLITE_BUSY|database is locked/i.test(err.message);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withBusyRetry<T>(fn: () => T | Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			if (!isSqliteBusy(err) || attempt >= MAX_ATTEMPTS) throw err;
			const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
			await sleep(delay + Math.random() * delay);
		}
	}
}

/**
 * Run `fn` on the serialized write queue. Resolves/rejects with `fn`'s
 * result once its turn completes. A rejected write never breaks the chain —
 * the next queued write still runs.
 */
export function enqueueWrite<T>(fn: () => T | Promise<T>): Promise<T> {
	const result = chain.then(() => withBusyRetry(fn));
	// Swallow rejection on the chain link only; callers still see it via `result`.
	chain = result.catch(() => undefined);
	return result;
}
