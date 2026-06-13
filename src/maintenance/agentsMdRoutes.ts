/**
 * WHY: HTTP surface for the AGENTS.md auto-maintenance feature (BLUEPRINT §3
 * "AGENTS.md auto-maintenance"). Exposes a single read-only GET that returns a
 * proposed AGENTS.md for a project using a minimal/stub RepoSnapshot.
 *
 * The control plane does NOT hold a local checkout, so live repo scanning is a
 * host/GATE-5 concern. This route documents that boundary clearly and returns a
 * proposal built from a static stub snapshot. A caller that has already scanned
 * the repo locally should use the library functions directly; this endpoint
 * exists for lightweight operator inspection.
 *
 * Route: GET /projects/:id/agents-md/proposal
 *   Returns: { project_id, proposal, changed, sections, note }
 */

import { eq } from "drizzle-orm";
import { projects } from "../db/schema.ts";
import type { Route } from "../server/routes.ts";
import { json, jsonError } from "../server/routes.ts";
import { proposeAgentsMd, type RepoSnapshot } from "./agentsMd.ts";

// ---------------------------------------------------------------------------
// Stub snapshot used when no host-scan result is available
// ---------------------------------------------------------------------------

/**
 * Minimal stub used when the caller has not provided a full snapshot.
 * The proposal will document the stub boundary so consumers know a real
 * host scan is needed for accurate output.
 *
 * TODO(GATE-5): wire the real host-side FS scan via an injected port so the
 *   route can return a live snapshot when running on the factory host.
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
// Routes
// ---------------------------------------------------------------------------

export const agentsMdRoutes: Route[] = [
	{
		method: "GET",
		path: "/projects/:id/agents-md/proposal",
		auth: true,
		summary:
			"Propose an AGENTS.md for the project from a stub snapshot (host-scan is a GATE-5 concern). Returns {project_id, proposal, changed, sections, note}.",
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

			// Build proposal from stub snapshot (live scan is a host/GATE-5 concern).
			const snapshot = stubSnapshot();
			const result = await proposeAgentsMd({ current: null, snapshot });

			return json({
				project_id: rawId,
				proposal: result.proposal,
				changed: result.changed,
				sections: result.sections,
				note: "Proposal built from stub snapshot. For accurate output, supply a live RepoSnapshot from a host-side FS scan (GATE-5 TODO).",
			});
		},
	},
];
