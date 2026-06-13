/**
 * Declarative route table — the single source of truth for the HTTP API
 * (task 1.4). Every endpoint is one entry `{ method, path, auth, summary,
 * handler }`; `routeList()` derives the openapi-ish JSON description from
 * the SAME array and `GET /routes` serves it, so the docs can never drift
 * from the code.
 *
 * Path patterns support simple params: a `:name` segment matches any single
 * path segment and is exposed to the handler via `ctx.params`. Matching is
 * exact-segment otherwise — no wildcards, no trailing-slash tricks.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbHandle } from "../db/client.ts";
import type { TaskState } from "../db/columns.ts";
import type { EventLog } from "../events/events.ts";
import { configRoutes } from "../config/settingsRoutes.ts";
import { settingsRegistryRoutes } from "../config/registryRoutes.ts";
import { runRoutes } from "../runs/runRoutes.ts";
import { transcriptRoutes } from "../runs/transcriptRoutes.ts";
import { authHealthRoutes } from "../providers/authHealthRoutes.ts";
import { triggerRoutes } from "../triggers/triggerRoutes.ts";
import { webhookRoutes } from "../triggers/webhookRoutes.ts";
import { experimentRoutes } from "../experiment/experimentRoutes.ts";
import { makeReviewRoutes, type ReviewRoutesConfig } from "./reviewRoutes.ts";
import { makePlannerRoutes, type PlannerRoutesConfig } from "./plannerRoutes.ts";
import type { ReviewDeps } from "../orchestrator/review.ts";
import { threadApi } from "../thread/thread.ts";
import { runVerdict } from "../review/engine.ts";
import { codeReviewJudge } from "../review/judge.ts";
import {
	makeGetDiff,
	makeRunReviewer,
	makeResumeCoder,
	spawnOneShotCaptured,
	buildOneShotArgv,
} from "../runs/liveSpawn.ts";
import { TmuxLauncher } from "../runs/launcher.ts";
import type { Planner } from "../planner/bootstrap.ts";
import { loadConfig } from "../config/config.ts";
import {
	addDependency,
	recomputeReadiness,
	removeDependency,
} from "../tasks/dependencies.ts";
import { findTransition, transitionTask, type TransitionExtra } from "../tasks/transitions.ts";
import {
	assertTaskState,
	createProject,
	createTask,
	deleteTask,
	getTask,
	listProjects,
	listTasks,
	updateTask,
	ValidationError,
} from "../tasks/tasks.ts";
import { promoteDraft, importMarkdownDrafts } from "../tasks/draftLane.ts";

export interface RouteContext {
	req: Request;
	url: URL;
	/** Captured `:name` path params, URL-decoded. */
	params: Record<string, string>;
	handle: DbHandle;
	/** Global event log — emitters write through it; /events/stream tails it. */
	events: EventLog;
}

export interface Route {
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	path: string;
	auth: boolean;
	summary: string;
	handler: (ctx: RouteContext) => Response | Promise<Response>;
}

/** JSON response helper — every body in the API is JSON. */
export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** The one error envelope: `{ error: { code, message } }`. */
export function jsonError(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

// ---------------------------------------------------------------------------
// Matching

export type RouteMatch =
	| { kind: "match"; route: Route; params: Record<string, string> }
	| { kind: "method_mismatch" }
	| { kind: "no_match" };

function matchPath(pattern: string, pathname: string): Record<string, string> | null {
	const patternSegs = pattern.split("/").filter(Boolean);
	const pathSegs = pathname.split("/").filter(Boolean);
	if (patternSegs.length !== pathSegs.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < patternSegs.length; i++) {
		const p = patternSegs[i]!;
		const s = pathSegs[i]!;
		if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(s);
		else if (p !== s) return null;
	}
	return params;
}

/**
 * Resolve `method pathname` against a route table. Distinguishes "no route
 * at this path" (→ 404) from "path exists but not for this method" (→ 405)
 * so the server can answer correctly.
 */
export function matchRoute(table: Route[], method: string, pathname: string): RouteMatch {
	let pathExists = false;
	for (const route of table) {
		const params = matchPath(route.path, pathname);
		if (params === null) continue;
		pathExists = true;
		if (route.method === method) return { kind: "match", route, params };
	}
	return pathExists ? { kind: "method_mismatch" } : { kind: "no_match" };
}

// ---------------------------------------------------------------------------
// Version info (GET /version)

interface VersionInfo {
	name: string;
	version: string;
	commit?: string;
}

const REPO_ROOT = join(import.meta.dir, "../..");
let cachedVersion: VersionInfo | undefined;

/** Resolve HEAD via plain file reads — no subprocess. Omitted when unknown. */
function gitSha(): string | undefined {
	try {
		const head = readFileSync(join(REPO_ROOT, ".git/HEAD"), "utf8").trim();
		if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
		const sha = readFileSync(join(REPO_ROOT, ".git", head.slice("ref: ".length)), "utf8").trim();
		return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
	} catch {
		return undefined;
	}
}

function versionInfo(): VersionInfo {
	if (!cachedVersion) {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			name: string;
			version: string;
		};
		const commit = gitSha();
		cachedVersion = { name: pkg.name, version: pkg.version, ...(commit ? { commit } : {}) };
	}
	return cachedVersion;
}

// ---------------------------------------------------------------------------
// Request parsing helpers

/** Parse the request body as a JSON object; anything else is a 400. */
async function readBody(req: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new ValidationError("Request body must be valid JSON");
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new ValidationError("Request body must be a JSON object");
	}
	return body as Record<string, unknown>;
}

function parseIntParam(raw: string | undefined, name: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value)) throw new ValidationError(`${name} must be an integer`);
	return value;
}

/** SSE heartbeat interval — a comment line keeps proxies/clients from timing out. */
const SSE_HEARTBEAT_MS = 15_000;

// ---------------------------------------------------------------------------
// Review wiring (Phase 3 / GATE 3)

/**
 * Production `ReviewDeps` builder for the review routes (LIVE-WIRING D1/D2/D6).
 * The pure collaborators are wired directly: `threadApi` (B1), `runVerdict`
 * (B2 engine), and `codeReviewJudge` (B2). The three side-effecting closures
 * come from `src/runs/liveSpawn.ts`:
 *
 *   - `getDiff` — host-side `git diff base..HEAD` of the latest coder worktree.
 *   - `runReviewer` — a captured-stdout reviewer one-shot (provider =
 *     `providers.defaultReviewer`), recorded as a `reviewer` run row.
 *   - `resumeCoder` — resumes the interactive tmux coder via `--resume`.
 *
 * FAIL-CLOSED-ON-INVOKE, not at boot: building the closures is side-effect-free
 * (no spawn, no token, no git, no bwrap). The first real invocation is where a
 * missing provider binary / missing bwrap / missing coder session / missing
 * `baseSha` THROWS, so a review can never silently approve on an unwired host.
 * `runReviewRound` only invokes them for tasks in `state=review`; the
 * thread/findings read routes never touch them. The server test suite injects
 * its OWN ReviewDeps via `makeReviewRoutes({ buildDeps })` and does NOT route
 * through this builder, so these live closures never run under test.
 *
 * `resumeCoder` needs a LOCAL repo path (the project stores only a remote
 * `repoUrl`). The host supplies it via `NIGHTSHIFT_REPO_DIR`; when unset,
 * `makeResumeCoder` fails closed on invocation (it cannot fabricate a path).
 */
const buildReviewDeps: ReviewRoutesConfig["buildDeps"] = (ctx): ReviewDeps => {
	const cfg = loadConfig();
	const repoDir = process.env.NIGHTSHIFT_REPO_DIR;
	return {
		handle: ctx.handle,
		log: ctx.events,
		thread: threadApi,
		engine: runVerdict,
		judge: codeReviewJudge,
		getDiff: makeGetDiff({ handle: ctx.handle, log: ctx.events }),
		runReviewer: makeRunReviewer({
			handle: ctx.handle,
			log: ctx.events,
			reviewerProvider: cfg.providers.defaultReviewer,
		}),
		resumeCoder: makeResumeCoder({
			handle: ctx.handle,
			log: ctx.events,
			launcher: new TmuxLauncher(),
			...(repoDir ? { repoDir } : {}),
		}),
		maxRounds: cfg.review.maxRounds,
	};
};

/**
 * Production wiring for the project-bootstrap planner (§4.3, LIVE-WIRING D1/D6).
 * The planner is a NON-INTERACTIVE captured-stdout one-shot: `bootstrapProject`
 * calls `planner.runOnce({ prompt })` and the live adapter delivers that prompt
 * to the planner provider's CLI (`providers.defaultCoder`) via
 * `spawnOneShotCaptured` — prompt on stdin, per-task HOME (`homeRoot/planner`),
 * GitHub token NEVER in env (HOST-SIDE TOKEN INVARIANT §0).
 *
 * FAIL-CLOSED-ON-INVOKE: building the adapter is inert. The first `runOnce`
 * is where an unknown provider (`buildOneShotArgv` throws `OneShotDisabledError`)
 * or a non-Linux unsandboxed spawn (`OneShotDisabledError`) refuses — so
 * /projects/:id/bootstrap can never fabricate a backlog on an unwired host.
 * `bootstrapProject` itself stays fully exercised by bootstrap.test.ts with a
 * fake planner; the planner route's tests inject their own `buildPlanner`.
 */
const buildPlanner: PlannerRoutesConfig["buildPlanner"] = (): Planner => {
	const cfg = loadConfig();
	const provider = cfg.providers.defaultCoder;
	const home = `${cfg.sandbox.homeRoot}/planner`;
	return {
		runOnce: async ({ prompt }) => {
			const { stdout } = await spawnOneShotCaptured({
				argv: buildOneShotArgv(provider),
				prompt,
				cwd: home,
				home,
				providerAuthDir: provider === "codex" ? `${home}/.codex` : `${home}/.claude`,
			});
			return { stdout };
		},
	};
};

// ---------------------------------------------------------------------------
// The table

export const routes: Route[] = [
	{
		method: "GET",
		path: "/healthz",
		auth: false,
		summary: "Liveness probe — 200 whenever the process is serving",
		handler: () => json({ ok: true }),
	},
	{
		method: "GET",
		path: "/readyz",
		auth: false,
		summary: "Readiness probe — 200 only when the DB is open and migrated",
		handler: (ctx) => {
			try {
				// One query proves both: the connection answers AND the drizzle
				// migrations journal exists with at least one applied entry.
				const row = ctx.handle.sqlite
					.query<{ n: number }, []>("SELECT count(*) AS n FROM __drizzle_migrations")
					.get();
				if (row && row.n > 0) return json({ ok: true });
			} catch {
				// fall through to 503
			}
			return jsonError(503, "not_ready", "database is not open or migrations have not applied");
		},
	},
	{
		method: "GET",
		path: "/version",
		auth: false,
		summary: "Service name, version, and git commit (when resolvable)",
		handler: () => json(versionInfo()),
	},
	{
		method: "GET",
		path: "/routes",
		auth: true,
		summary: "Describe the API: every route's method, path, auth flag, and summary",
		handler: () => json(routeList()),
	},
	// -- projects (minimal — enough surface to parent tasks) ------------------
	{
		method: "POST",
		path: "/projects",
		auth: true,
		summary: "Create a project",
		handler: async (ctx) => {
			const body = await readBody(ctx.req);
			const project = await createProject(ctx.handle, {
				name: body.name,
				repoUrl: body.repo_url,
				defaultBranch: body.default_branch,
			});
			return json(project, 201);
		},
	},
	{
		method: "GET",
		path: "/projects",
		auth: true,
		summary: "List projects",
		handler: (ctx) => json(listProjects(ctx.handle)),
	},
	// -- tasks ---------------------------------------------------------------
	{
		method: "POST",
		path: "/tasks",
		auth: true,
		summary: "Create a task (state draft or backlog)",
		handler: async (ctx) => {
			const body = await readBody(ctx.req);
			if (typeof body.project_id !== "number") {
				throw new ValidationError("project_id must be an integer");
			}
			const task = await createTask(ctx.handle, {
				projectId: body.project_id,
				title: body.title,
				description: body.description,
				acceptanceCriteria: body.acceptance_criteria,
				state: body.state,
				priority: body.priority,
				category: body.category,
				riskTier: body.risk_tier,
			});
			return json(task, 201);
		},
	},
	{
		method: "GET",
		path: "/tasks",
		auth: true,
		summary: "List tasks, filterable by ?project_id= and ?state=",
		handler: (ctx) => {
			const rawProject = ctx.url.searchParams.get("project_id");
			const rawState = ctx.url.searchParams.get("state");
			const filter: { projectId?: number; state?: TaskState } = {};
			if (rawProject !== null) filter.projectId = parseIntParam(rawProject, "project_id");
			if (rawState !== null) filter.state = assertTaskState(rawState, "state");
			return json(listTasks(ctx.handle, filter));
		},
	},
	{
		method: "GET",
		path: "/tasks/:id",
		auth: true,
		summary: "Fetch one task",
		handler: (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const task = getTask(ctx.handle, id);
			if (!task) return jsonError(404, "not_found", `task ${id} not found`);
			return json(task);
		},
	},
	{
		method: "PATCH",
		path: "/tasks/:id",
		auth: true,
		summary: "Update task content fields (state is rejected — use /transition)",
		handler: async (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const body = await readBody(ctx.req);
			if ("state" in body) {
				throw new ValidationError(
					"state cannot be patched — use POST /tasks/:id/transition",
				);
			}
			const task = await updateTask(ctx.handle, id, {
				title: body.title,
				description: body.description,
				acceptanceCriteria: body.acceptance_criteria,
				priority: body.priority,
				category: body.category,
				riskTier: body.risk_tier,
			});
			if (!task) return jsonError(404, "not_found", `task ${id} not found`);
			return json(task);
		},
	},
	{
		method: "DELETE",
		path: "/tasks/:id",
		auth: true,
		summary: "Delete a task (only in draft/backlog/cancelled/done)",
		handler: async (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const deleted = await deleteTask(ctx.handle, id);
			if (!deleted) return jsonError(404, "not_found", `task ${id} not found`);
			return json({ ok: true });
		},
	},
	{
		method: "POST",
		path: "/tasks/:id/transition",
		auth: true,
		summary: "Drive the task state machine: {to, expected_from?, actor?, merge_sha?, …}",
		handler: async (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const body = await readBody(ctx.req);
			const to = assertTaskState(body.to, "to");
			const expectedFrom =
				body.expected_from === undefined
					? undefined
					: assertTaskState(body.expected_from, "expected_from");
			const actor =
				typeof body.actor === "string" && body.actor.length > 0 ? body.actor : "api";

			const current = getTask(ctx.handle, id);
			if (!current) return jsonError(404, "not_found", `task ${id} not found`);
			// backlog→ready is system-driven (readiness recompute) — not invokable here.
			const edge = findTransition(expectedFrom ?? current.state, to);
			if (edge?.systemOnly) {
				throw new ValidationError(
					`${edge.from}→${edge.to} is driven by dependency recompute, not the API`,
				);
			}

			const extra: TransitionExtra = {
				...(typeof body.claimed_by === "number" ? { claimedBy: body.claimed_by } : {}),
				...(typeof body.base_sha === "string" ? { baseSha: body.base_sha } : {}),
				...(typeof body.branch === "string" ? { branch: body.branch } : {}),
				...(typeof body.merge_sha === "string" ? { mergeSha: body.merge_sha } : {}),
			};
			const result = await transitionTask(ctx.handle, ctx.events, {
				taskId: id,
				to,
				expectedFrom,
				actor,
				extra,
			});
			if (!result.ok) {
				if (result.reason === "not_found") {
					return jsonError(404, "not_found", `task ${id} not found`);
				}
				if (result.reason === "illegal") {
					return jsonError(409, "illegal_transition", `cannot transition task ${id} to '${to}'`);
				}
				return jsonError(409, "lost_race", `task ${id} was moved by a concurrent actor`);
			}
			// A confirmed merge (→done is the only writer of merge_sha) can unblock
				// dependents whose dependencies are now all merged (SPEC §6 / GATE 2).
				if (result.task.state === "done") {
					await recomputeReadiness(ctx.handle, ctx.events, result.task.projectId);
				}
				return json({ task: result.task, from: result.from });
		},
	},
	// -- draft lane (§3.10 item 2) ------------------------------------------------
	{
		method: "POST",
		path: "/tasks/:id/promote",
		auth: true,
		summary: "Promote a draft task to backlog, optionally expanding it with the planner: {actor?, expand?}",
		handler: async (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const body = await readBody(ctx.req);
			const actor =
				typeof body.actor === "string" && body.actor.length > 0 ? body.actor : "api";
			// expand=true wires the planner; no planner is registered server-side yet
			// (integration §8.x) so we pass deps.planner=undefined and it no-ops.
			// When the planner ships, wire it here.
			const result = await promoteDraft(
				{ handle: ctx.handle, log: ctx.events },
				id,
				actor,
			);
			if (!result.ok) {
				if (result.reason === "not_found") {
					return jsonError(404, "not_found", result.message);
				}
				if (result.reason === "not_draft") {
					return jsonError(409, "not_draft", result.message);
				}
				if (result.reason === "lost_race") {
					return jsonError(409, "lost_race", result.message);
				}
				return jsonError(500, "planner_error", result.message);
			}
			return json({ task: result.task, expanded: result.expanded });
		},
	},
	{
		method: "POST",
		path: "/tasks/import-drafts",
		auth: true,
		summary: "Bulk-create draft tasks from a markdown bullet list: {project_id, markdown}",
		handler: async (ctx) => {
			const body = await readBody(ctx.req);
			if (typeof body.project_id !== "number") {
				throw new ValidationError("project_id must be an integer");
			}
			if (typeof body.markdown !== "string") {
				throw new ValidationError("markdown must be a string");
			}
			const rows = await importMarkdownDrafts(
				{ handle: ctx.handle },
				body.project_id,
				body.markdown,
			);
			return json(rows, 201);
		},
	},
	// -- dependencies ----------------------------------------------------------
	{
		method: "POST",
		path: "/tasks/:id/dependencies",
		auth: true,
		summary: "Add a dependency edge: {depends_on_task_id}",
		handler: async (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const body = await readBody(ctx.req);
			if (typeof body.depends_on_task_id !== "number") {
				throw new ValidationError("depends_on_task_id must be an integer");
			}
			const edge = await addDependency(ctx.handle, id, body.depends_on_task_id);
			const projectId = getTask(ctx.handle, id)?.projectId;
			await recomputeReadiness(ctx.handle, ctx.events, projectId);
			return json(edge, 201);
		},
	},
	{
		method: "DELETE",
		path: "/tasks/:id/dependencies/:depId",
		auth: true,
		summary: "Remove a dependency edge",
		handler: async (ctx) => {
			const id = parseIntParam(ctx.params.id, "task id");
			const depId = parseIntParam(ctx.params.depId, "dependency task id");
			const removed = await removeDependency(ctx.handle, id, depId);
			if (!removed) {
				return jsonError(404, "not_found", `task ${id} does not depend on task ${depId}`);
			}
			await recomputeReadiness(ctx.handle, ctx.events, getTask(ctx.handle, id)?.projectId);
			return json({ ok: true });
		},
	},
	// -- event stream ----------------------------------------------------------
	{
		method: "GET",
		path: "/events/stream",
		auth: true,
		summary: "SSE stream of the global event log: replay from ?after_seq=, then live tail",
		handler: (ctx) => {
			const rawAfter = ctx.url.searchParams.get("after_seq");
			const afterSeq = rawAfter === null ? 0 : Number(rawAfter);
			if (!Number.isInteger(afterSeq) || afterSeq < 0) {
				throw new ValidationError("after_seq must be a non-negative integer");
			}
			// Client abort propagates via req.signal → subscription ends → the
			// pump's for-await returns → stream closes and the heartbeat stops.
			const sub = ctx.events.subscribe({ afterSeq, signal: ctx.req.signal });
			const encoder = new TextEncoder();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					// Flush headers immediately (Bun holds them until the first chunk)
					// and tell the client it's connected — a standard SSE comment.
					controller.enqueue(encoder.encode(": connected\n\n"));
					const heartbeat = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(": heartbeat\n\n"));
						} catch {
							clearInterval(heartbeat);
							sub.close();
						}
					}, SSE_HEARTBEAT_MS);
					void (async () => {
						try {
							for await (const event of sub) {
								controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
							}
							controller.close();
						} catch {
							// consumer went away mid-enqueue — nothing left to do
						} finally {
							clearInterval(heartbeat);
							sub.close();
						}
					})();
				},
				cancel() {
					sub.close();
				},
			});
			return new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
		},
	},
	// -- config (read-only file/env registry) ----------------------------------
	...configRoutes,
	// -- editable scoped settings registry + audit (5.2, §3.12.19) -------------
	...settingsRegistryRoutes,
	// -- runs ------------------------------------------------------------------
	...runRoutes,
	// -- transcript browser (events-only, 5.8, §3.12.16) -----------------------
	...transcriptRoutes,
	// -- experiment ledger timeline (Phase 6, §3.11) ---------------------------
	...experimentRoutes,
	// -- provider auth health panel (5.8, §3.9) --------------------------------
	...authHealthRoutes,
	// -- routines + manual/cron triggers w/ authz (5.8, §3.2/§3.12.6) ----------
	...triggerRoutes,
	// -- webhook trigger ingress (HMAC-signed, Phase 6, §3.12.6) ---------------
	...webhookRoutes,
	// -- review (thread / findings / review-round / verdict) -------------------
	...makeReviewRoutes({ buildDeps: buildReviewDeps }),
	// -- planner (project bootstrap) -------------------------------------------
	...makePlannerRoutes({ buildPlanner }),
];

/** Openapi-ish description generated FROM the table — never hand-written. */
export function routeList(): Array<Pick<Route, "method" | "path" | "auth" | "summary">> {
	return routes.map(({ method, path, auth, summary }) => ({ method, path, auth, summary }));
}
