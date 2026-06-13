/**
 * WHY: Callers (main.ts wiring, route handlers) should not need to know which
 * forge is active — they receive a `ForgeClient` and call `openPr()`. This
 * module dispatches to the right client + PR-creation function based on the
 * `forge.provider` config key, and wraps the result in a single unified seam.
 *
 * Supported providers: "github" | "forgejo" | "gitlab"
 *
 * Token env vars:
 *   github  → GITHUB_TOKEN  (or `gh auth token` CLI fallback)
 *   forgejo → FORGEJO_TOKEN
 *   gitlab  → GITLAB_TOKEN
 *
 * Optional `forge.baseUrl` config key overrides the default API endpoint for
 * self-hosted Forgejo/GitLab or GitHub Enterprise.
 *
 * HOST-SIDE ONLY. Never call from agent sandbox code.
 */

import type { ForgeClient, OpenPrArgs, PrResult } from "./github.ts";
import { openPullRequest } from "./github.ts";
import { createGitHubForgeClient } from "./githubForgeClient.ts";
import { createForgejoForgeClient } from "./forgejoForgeClient.ts";
import { createGitLabForgeClient, openMergeRequest } from "./gitlabForgeClient.ts";

export type ForgeProvider = "github" | "forgejo" | "gitlab";

// ---------------------------------------------------------------------------
// Unified seam
// ---------------------------------------------------------------------------

/**
 * A forge service: a raw HTTP client + a higher-level openPr function that
 * handles provider-specific field mapping.
 */
export interface ForgeService {
	client: ForgeClient;
	openPr(args: OpenPrArgs): Promise<PrResult>;
}

// ---------------------------------------------------------------------------
// Config subset needed by the factory
// ---------------------------------------------------------------------------

export interface ForgeFactoryConfig {
	provider: string;
	baseUrl?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a ForgeService for the configured provider.
 * Throws if the provider is unsupported or the token env var is missing.
 */
export async function createForgeService(cfg: ForgeFactoryConfig): Promise<ForgeService> {
	const provider = cfg.provider as ForgeProvider;

	switch (provider) {
		case "github": {
			const client = await createGitHubForgeClient(
				cfg.baseUrl ?? "https://api.github.com",
			);
			return {
				client,
				openPr: (args) => openPullRequest(client, args),
			};
		}

		case "forgejo": {
			const client = createForgejoForgeClient(
				cfg.baseUrl ?? "https://codeberg.org/api/v1",
			);
			return {
				client,
				// Forgejo API is Gitea-compatible — same path/body as GitHub
				openPr: (args) => openPullRequest(client, args),
			};
		}

		case "gitlab": {
			const client = createGitLabForgeClient(
				cfg.baseUrl ?? "https://gitlab.com",
			);
			return {
				client,
				openPr: (args) => openMergeRequest(client, args),
			};
		}

		default:
			throw new Error(
				`Unsupported forge provider "${cfg.provider}". ` +
				`Supported: github, forgejo, gitlab.`,
			);
	}
}
