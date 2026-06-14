/**
 * WHY: HTTP surface for the AGENTS.md auto-maintenance feature (BLUEPRINT §3
 * "AGENTS.md auto-maintenance"). Exposes a single read-only GET that returns a
 * proposed AGENTS.md for a project using either a live repo scan (when a local
 * checkout can be resolved) or a minimal stub snapshot as a fail-soft fallback.
 *
 * The route accepts an injected `resolveRepoDir` closure (consistent with the
 * pattern used in agentsMdCadence and the host-side scheduler wiring in
 * src/server/main.ts). When the resolver maps the project's repoUrl to a local
 * path, `scanRepoSnapshot` is called for accurate output. When the resolver
 * returns null (unmappable URL, no env config), the stub fallback is used so
 * the route always returns a usable proposal.
 *
 * Route: GET /projects/:id/agents-md/proposal
 *   Returns: { project_id, proposal, changed, sections, note }
 */

import { eq } from "drizzle-orm";
import { projects } from "../db/schema.ts";
import type { Route } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { proposeAgentsMd, type RepoSnapshot } from "./agentsMd.ts";
import { scanRepoSnapshot } from "./repoScan.ts";

// ---------------------------------------------------------------------------
// Stub snapshot used as fail-soft fallback when no repo dir is resolvable
// ---------------------------------------------------------------------------

/**
 * Minimal stub used when the repo dir cannot be resolved (no local checkout
 * available). Kept as a fail-soft fallback so the route always returns a
 * usable proposal even on hosts without a wired checkout.
 */
function stubSnapshot(): RepoSnapshot {
	return {
		rootEntries: [
			"src/",
			"drizzle/",
			"docs/",
			"package.json",
			"tsconfig.json",
			"AGENTS.md",
			"CLAUDE.md",
			"IMPLEMENTATION-PLAN.md",
		],
		scripts: {
			test: "bun test",
			"type-check": "bun tsc --noEmit",
		},
		testDirs: ["src/"],
		topLevelDocs: ["AGENTS.md", "CLAUDE.md", "IMPLEMENTATION-PLAN.md", "docs/"],
		detectedRuntime: "bun",
	};
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentsMdRoutesConfig {
	/**
	 * Maps a project's repoUrl to the local checkout directory path, or null
	 * when the URL cannot be resolved to a local path. Consistent with the
	 * resolveRepoDir closure wired in src/server/main.ts (NIGHTSHIFT_REPO_DIR /
	 * NIGHTSHIFT_CHECKOUT_ROOT env vars).
	 *
	 * When null or not provided, the route falls back to the stub snapshot for
	 * every request. When provided, the live scanRepoSnapshot is used for
	 * projects whose repoUrl resolves successfully.
	 */
	resolveRepoDir?: ((repoUrl: string) => string | null) | null;
}

/**
 * Build the AGENTS.md proposal route with an injected repo-dir resolver.
 * The resolver is called with the project's repoUrl; when it returns a
 * non-null path, scanRepoSnapshot is used for an accurate proposal. When it
 * returns null (or no resolver is provided), stubSnapshot() is the fallback.
 */
export function makeAgentsMdRoutes(config: AgentsMdRoutesConfig = {}): Route[] {
	const { resolveRepoDir = null } = config;

	return [
		{
			method: "GET",
			path: "/projects/:id/agents-md/proposal",
			auth: true,
			summary:
				"Propose an AGENTS.md for the project via a live repo scan when available, with stub fallback. Returns {project_id, proposal, changed, sections, note}.",
			handler: async (ctx) => {
				const rawId = Number(ctx.params.id);
				if (!Number.isInteger(rawId) || rawId <= 0) {
					return jsonError(400, "bad_request", "project id must be a positive integer");
				}

				// Verify the project exists — direct read (WAL; outside writer queue).
				const project = ctx.handle.db
					.select()
					.from(projects)
					.where(eq(projects.id, rawId))
					.get();

				if (project === undefined || project === null) {
					return jsonError(404, "not_found", `project ${rawId} not found`);
				}

				// Resolve the local checkout dir and build snapshot accordingly.
				const repoDir = resolveRepoDir ? resolveRepoDir(project.repoUrl) : null;
				let snapshot: RepoSnapshot;
				let note: string;

				if (repoDir !== null) {
					// Live scan: use the real repo dir for accurate output.
					snapshot = scanRepoSnapshot(repoDir);
					note = "Proposal built from live host-side repo scan.";
				} else {
					// Fail-soft fallback: resolver returned null or was not provided.
					snapshot = stubSnapshot();
					note = "Proposal built from stub snapshot; no host-side repo scan available. For accurate output, ensure a local checkout is resolvable via NIGHTSHIFT_REPO_DIR or NIGHTSHIFT_CHECKOUT_ROOT on the host.";
				}

				const result = await proposeAgentsMd({ current: null, snapshot });

				return json({
					project_id: rawId,
					proposal: result.proposal,
					changed: result.changed,
					sections: result.sections,
					note,
				});
			},
		},
	];
}

// ---------------------------------------------------------------------------
// Default export — routes without a resolver (stub fallback only).
// Consumed by routes.ts via makeAgentsMdRoutes({ resolveRepoDir }) for
// production; this constant is kept for backward-compat with tests that import
// the route array directly.
// ---------------------------------------------------------------------------

export const agentsMdRoutes: Route[] = makeAgentsMdRoutes();
