/**
 * HTTP API skeleton tests (task 1.4 verify criteria).
 *
 * Each test boots a real Bun server on port 0 with a :memory: DB, so these
 * exercise the full request path: routing → auth → handler → JSON envelope.
 *
 *   (a) routeList() reflects the declared table; GET /routes matches it
 *   (b) /healthz, /readyz, /version are public (200 without a token)
 *   (c) auth: missing/wrong/odd-length token → 401, valid → 200,
 *       unset NIGHTSHIFT_API_TOKEN → 503 (fail closed)
 *   (d) 404 unknown path / 405 wrong method, both in the error envelope
 *   (e) path-param matching (`/tasks/:id`) via matchRoute
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createServer } from "./main.ts";
import { json, matchRoute, routeList, routes, type Route } from "./routes.ts";

const TOKEN = "test-token-correct";
const ORIGINAL_TOKEN = process.env.NIGHTSHIFT_API_TOKEN;

let server: Bun.Server<undefined>;

function get(path: string, token?: string): Promise<Response> {
	const headers: Record<string, string> =
		token === undefined ? {} : { authorization: `Bearer ${token}` };
	return fetch(new URL(path, server.url), { headers });
}

beforeEach(() => {
	process.env.NIGHTSHIFT_API_TOKEN = TOKEN;
	server = createServer({ port: 0, dbPath: ":memory:" });
});

afterEach(() => {
	server.stop(true);
	if (ORIGINAL_TOKEN === undefined) delete process.env.NIGHTSHIFT_API_TOKEN;
	else process.env.NIGHTSHIFT_API_TOKEN = ORIGINAL_TOKEN;
});

// ---------------------------------------------------------------------------
// Route table

test("routeList() is generated from the declared table", () => {
	const list = routeList();
	expect(list).toHaveLength(routes.length);
	for (const [i, route] of routes.entries()) {
		expect(list[i]).toEqual({
			method: route.method,
			path: route.path,
			auth: route.auth,
			summary: route.summary,
		});
	}
	// The skeleton endpoints are all present with the right auth flags.
	expect(list).toContainEqual(expect.objectContaining({ method: "GET", path: "/healthz", auth: false }));
	expect(list).toContainEqual(expect.objectContaining({ method: "GET", path: "/readyz", auth: false }));
	expect(list).toContainEqual(expect.objectContaining({ method: "GET", path: "/version", auth: false }));
	expect(list).toContainEqual(expect.objectContaining({ method: "GET", path: "/routes", auth: true }));
});

test("GET /routes with a valid token returns exactly routeList()", async () => {
	const res = await get("/routes", TOKEN);
	expect(res.status).toBe(200);
	expect(await res.json()).toEqual(routeList());
});

test("matchRoute captures :id params and decodes them", () => {
	const table: Route[] = [
		{ method: "GET", path: "/tasks/:id", auth: true, summary: "stub", handler: () => json({}) },
	];
	const hit = matchRoute(table, "GET", "/tasks/42");
	expect(hit).toEqual({ kind: "match", route: table[0]!, params: { id: "42" } });
	expect(matchRoute(table, "GET", "/tasks/a%20b")).toMatchObject({ params: { id: "a b" } });
	expect(matchRoute(table, "GET", "/tasks")).toEqual({ kind: "no_match" });
	expect(matchRoute(table, "GET", "/tasks/42/extra")).toEqual({ kind: "no_match" });
	expect(matchRoute(table, "POST", "/tasks/42")).toEqual({ kind: "method_mismatch" });
});

// ---------------------------------------------------------------------------
// Public endpoints

test("/healthz, /readyz, /version respond 200 without a token", async () => {
	const healthz = await get("/healthz");
	expect(healthz.status).toBe(200);
	expect(await healthz.json()).toEqual({ ok: true });

	const readyz = await get("/readyz");
	expect(readyz.status).toBe(200);
	expect(await readyz.json()).toEqual({ ok: true });

	const version = await get("/version");
	expect(version.status).toBe(200);
	const body = (await version.json()) as { name: string; version: string };
	expect(body.name).toBe("nightshift");
	expect(typeof body.version).toBe("string");
});

// ---------------------------------------------------------------------------
// Auth

test("missing token on a protected route → 401 envelope", async () => {
	const res = await get("/routes");
	expect(res.status).toBe(401);
	expect(await res.json()).toEqual({
		error: { code: "unauthorized", message: expect.any(String) },
	});
});

test("wrong token of the same length → 401", async () => {
	const wrong = "X".repeat(TOKEN.length);
	const res = await get("/routes", wrong);
	expect(res.status).toBe(401);
});

test("token of a different length → 401, no crash", async () => {
	const res = await get("/routes", "short");
	expect(res.status).toBe(401);
	const long = await get("/routes", TOKEN + TOKEN);
	expect(long.status).toBe(401);
});

test("valid token → 200", async () => {
	const res = await get("/routes", TOKEN);
	expect(res.status).toBe(200);
});

test("unset NIGHTSHIFT_API_TOKEN fails closed: protected routes → 503", async () => {
	delete process.env.NIGHTSHIFT_API_TOKEN;
	const res = await get("/routes", TOKEN);
	expect(res.status).toBe(503);
	expect(await res.json()).toEqual({
		error: { code: "auth_not_configured", message: expect.any(String) },
	});
	// Public routes stay up.
	expect((await get("/healthz")).status).toBe(200);
});

// ---------------------------------------------------------------------------
// Error envelope

test("unknown path → 404 JSON envelope", async () => {
	const res = await get("/nope");
	expect(res.status).toBe(404);
	expect(await res.json()).toEqual({
		error: { code: "not_found", message: expect.stringContaining("/nope") },
	});
});

test("wrong method on a known path → 405 JSON envelope", async () => {
	const res = await fetch(new URL("/healthz", server.url), { method: "POST" });
	expect(res.status).toBe(405);
	expect(await res.json()).toEqual({
		error: { code: "method_not_allowed", message: expect.any(String) },
	});
});
