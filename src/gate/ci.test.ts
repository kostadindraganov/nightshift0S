/**
 * CI gate tests (task 2.7).
 *
 * ciGate() is pure — no I/O. ciGateForRef() uses a fake CiClient.
 * No network calls are made.
 */

import { describe, it, expect } from "bun:test";
import {
  ciGate,
  ciGateForRef,
  type CheckRun,
  type CiClient,
} from "./ci.ts";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function runs(pairs: [string, CheckRun["status"]][]): CheckRun[] {
  return pairs.map(([name, status]) => ({ name, status }));
}

// ---------------------------------------------------------------------------
// ciGate — pure function tests
// ---------------------------------------------------------------------------

describe("ciGate", () => {
  it("all required checks are success → green", () => {
    const result = ciGate({
      requiredChecks: ["lint", "typecheck", "build"],
      checks: runs([
        ["lint", "success"],
        ["typecheck", "success"],
        ["build", "success"],
      ]),
    });
    expect(result.green).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("one failure → blocking lists it with (failure) suffix", () => {
    const result = ciGate({
      requiredChecks: ["lint", "typecheck"],
      checks: runs([
        ["lint", "failure"],
        ["typecheck", "success"],
      ]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("lint(failure)");
    expect(result.blocking).not.toContain("typecheck");
  });

  it("one pending → blocking lists it with (pending) suffix", () => {
    const result = ciGate({
      requiredChecks: ["build"],
      checks: runs([["build", "pending"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("build(pending)");
  });

  it("one error → blocking", () => {
    const result = ciGate({
      requiredChecks: ["test"],
      checks: runs([["test", "error"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("test(error)");
  });

  it("missing required check → blocking with (missing) suffix", () => {
    const result = ciGate({
      requiredChecks: ["lint", "deploy"],
      checks: runs([["lint", "success"]]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("deploy(missing)");
  });

  it("skipped required check → NOT blocking", () => {
    const result = ciGate({
      requiredChecks: ["optional-perf"],
      checks: runs([["optional-perf", "skipped"]]),
    });
    expect(result.green).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("neutral required check → NOT blocking", () => {
    const result = ciGate({
      requiredChecks: ["coverage"],
      checks: runs([["coverage", "neutral"]]),
    });
    expect(result.green).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("non-required failing check → not in blocking", () => {
    const result = ciGate({
      requiredChecks: ["lint"],
      checks: runs([
        ["lint", "success"],
        ["flaky-optional", "failure"],
      ]),
    });
    expect(result.green).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("empty requiredChecks → always green", () => {
    const result = ciGate({
      requiredChecks: [],
      checks: runs([["lint", "failure"]]),
    });
    expect(result.green).toBe(true);
  });

  it("multiple failures → all listed", () => {
    const result = ciGate({
      requiredChecks: ["a", "b", "c"],
      checks: runs([
        ["a", "failure"],
        ["b", "error"],
        ["c", "success"],
      ]),
    });
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("a(failure)");
    expect(result.blocking).toContain("b(error)");
    expect(result.blocking).not.toContain("c");
  });
});

// ---------------------------------------------------------------------------
// ciGateForRef — async composition with fake CiClient
// ---------------------------------------------------------------------------

describe("ciGateForRef", () => {
  function fakeClient(checks: CheckRun[]): CiClient {
    return {
      async fetchChecks(_ref: string): Promise<CheckRun[]> {
        return checks;
      },
    };
  }

  it("returns same result as ciGate when all checks green", async () => {
    const client = fakeClient(
      runs([
        ["lint", "success"],
        ["build", "success"],
      ]),
    );
    const result = await ciGateForRef(client, "abc123", ["lint", "build"]);
    expect(result.green).toBe(true);
    expect(result.blocking).toEqual([]);
  });

  it("returns blocking when a required check fails", async () => {
    const client = fakeClient(runs([["lint", "failure"]]));
    const result = await ciGateForRef(client, "abc123", ["lint", "typecheck"]);
    expect(result.green).toBe(false);
    expect(result.blocking).toContain("lint(failure)");
    expect(result.blocking).toContain("typecheck(missing)");
  });

  it("passes the ref to the client", async () => {
    let capturedRef = "";
    const client: CiClient = {
      async fetchChecks(ref: string): Promise<CheckRun[]> {
        capturedRef = ref;
        return runs([["lint", "success"]]);
      },
    };
    await ciGateForRef(client, "my-branch-sha", ["lint"]);
    expect(capturedRef).toBe("my-branch-sha");
  });
});
